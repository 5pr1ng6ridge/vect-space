use crate::content::ContentCatalog;
use crate::model::{
    ConditionExpression, MutationValue, ScalarValue, ValueOperand, VariableMap, VariableOperation,
    VariableScope, VariableType,
};
use crate::text_template::MAX_VARIABLE_STRING_BYTES;
use crate::text_template;
use super::{RuntimeEngine, RuntimeError};

impl RuntimeEngine {
    pub(super) fn evaluate_condition(
        &self,
        content: &ContentCatalog,
        condition: &ConditionExpression,
    ) -> Result<bool, RuntimeError> {
        match condition {
            ConditionExpression::Eq { left, right } => compare_values(
                self.resolve_operand(content, left)?,
                self.resolve_operand(content, right)?,
            )
            .map(|ordering| ordering == std::cmp::Ordering::Equal),
            ConditionExpression::Ne { left, right } => compare_values(
                self.resolve_operand(content, left)?,
                self.resolve_operand(content, right)?,
            )
            .map(|ordering| ordering != std::cmp::Ordering::Equal),
            ConditionExpression::Lt { left, right } => compare_numeric(
                self.resolve_operand(content, left)?,
                self.resolve_operand(content, right)?,
            )
            .map(|ordering| ordering == std::cmp::Ordering::Less),
            ConditionExpression::Le { left, right } => compare_numeric(
                self.resolve_operand(content, left)?,
                self.resolve_operand(content, right)?,
            )
            .map(|ordering| ordering != std::cmp::Ordering::Greater),
            ConditionExpression::Gt { left, right } => compare_numeric(
                self.resolve_operand(content, left)?,
                self.resolve_operand(content, right)?,
            )
            .map(|ordering| ordering == std::cmp::Ordering::Greater),
            ConditionExpression::Ge { left, right } => compare_numeric(
                self.resolve_operand(content, left)?,
                self.resolve_operand(content, right)?,
            )
            .map(|ordering| ordering != std::cmp::Ordering::Less),
            ConditionExpression::And { conditions } => {
                for child in conditions {
                    if !self.evaluate_condition(content, child)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            ConditionExpression::Or { conditions } => {
                for child in conditions {
                    if self.evaluate_condition(content, child)? {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            ConditionExpression::Not { condition } => {
                Ok(!self.evaluate_condition(content, condition)?)
            }
        }
    }

    fn resolve_operand<'a>(
        &'a self,
        content: &'a ContentCatalog,
        operand: &'a ValueOperand,
    ) -> Result<&'a ScalarValue, RuntimeError> {
        match operand {
            ValueOperand::Literal(literal) => Ok(&literal.value),
            ValueOperand::Variable(reference) => self.variable_value(content, &reference.variable),
        }
    }

    pub(super) fn resolve_mutation_value(
        &self,
        content: &ContentCatalog,
        value: &MutationValue,
    ) -> Result<ScalarValue, RuntimeError> {
        match value {
            MutationValue::Literal(value) => Ok(value.clone()),
            MutationValue::Variable(reference) => {
                self.variable_value(content, &reference.variable).cloned()
            }
        }
    }

    pub(super) fn variable_value<'a>(
        &'a self,
        content: &'a ContentCatalog,
        id: &str,
    ) -> Result<&'a ScalarValue, RuntimeError> {
        if let Some(value) = self.window_variables.get(id) { return Ok(value); }
        let definition = content
            .manifest
            .variables
            .get(id)
            .ok_or_else(|| RuntimeError::Content(format!("引用了未声明变量 {id}")))?;
        let variables = match definition.scope {
            VariableScope::Save => &self.snapshot.variables,
            VariableScope::Profile => &self.profile_variables,
        };
        variables
            .get(id)
            .ok_or_else(|| RuntimeError::Content(format!("变量 {id} 尚未初始化")))
    }

    pub(super) fn interpolate_text(
        &self,
        content: &ContentCatalog,
        source: &str,
    ) -> Result<String, RuntimeError> {
        text_template::interpolate(source, |id| {
            self.variable_value(content, id)
                .cloned()
                .map_err(|error| text_template::TemplateError(error.to_string()))
        })
        .map_err(|error| RuntimeError::Content(error.to_string()))
    }
}

pub(super) fn apply_variable_operation(
    operation: VariableOperation,
    target_type: VariableType,
    current: ScalarValue,
    operand: Option<ScalarValue>,
) -> Result<ScalarValue, String> {
    if operation == VariableOperation::Toggle {
        return match (target_type, current, operand) {
            (VariableType::Boolean, ScalarValue::Boolean(value), None) => {
                Ok(ScalarValue::Boolean(!value))
            }
            (_, _, Some(_)) => Err("toggle 不接受 value".to_owned()),
            _ => Err("toggle 只能用于 boolean 变量".to_owned()),
        };
    }

    let operand = operand.ok_or_else(|| format!("{operation:?} 操作缺少 value"))?;
    match operation {
        VariableOperation::Assign => {
            normalize_value(operand, target_type).map_err(|error| error.to_string())
        }
        VariableOperation::Add | VariableOperation::Sub | VariableOperation::Mul => {
            match target_type {
                VariableType::Integer => {
                    let (ScalarValue::Integer(left), ScalarValue::Integer(right)) =
                        (current, operand)
                    else {
                        return Err("integer 运算只接受 integer 操作数".to_owned());
                    };
                    let result = match operation {
                        VariableOperation::Add => left.checked_add(right),
                        VariableOperation::Sub => left.checked_sub(right),
                        VariableOperation::Mul => left.checked_mul(right),
                        _ => unreachable!(),
                    }
                    .ok_or_else(|| "integer 运算溢出".to_owned())?;
                    Ok(ScalarValue::Integer(result))
                }
                VariableType::Number => {
                    let left = scalar_to_f64(&current)?;
                    let right = scalar_to_f64(&operand)?;
                    let result = match operation {
                        VariableOperation::Add => left + right,
                        VariableOperation::Sub => left - right,
                        VariableOperation::Mul => left * right,
                        _ => unreachable!(),
                    };
                    if !result.is_finite() {
                        return Err("number 运算结果必须是有限数".to_owned());
                    }
                    Ok(ScalarValue::Number(result))
                }
                _ => Err("add/sub/mul 只能用于数值变量".to_owned()),
            }
        }
        VariableOperation::Mod => {
            let (ScalarValue::Integer(left), ScalarValue::Integer(right)) = (current, operand)
            else {
                return Err("mod 只能用于 integer 变量和操作数".to_owned());
            };
            let result = left.checked_rem(right).ok_or_else(|| {
                if right == 0 {
                    "mod 除数不能为零".to_owned()
                } else {
                    "integer mod 运算溢出".to_owned()
                }
            })?;
            Ok(ScalarValue::Integer(result))
        }
        VariableOperation::Append => {
            let (ScalarValue::Text(mut left), ScalarValue::Text(right)) = (current, operand) else {
                return Err("append 只能用于 string 变量和操作数".to_owned());
            };
            if left.len().saturating_add(right.len()) > MAX_VARIABLE_STRING_BYTES {
                return Err(format!(
                    "append 结果超过 {} 字节上限",
                    MAX_VARIABLE_STRING_BYTES
                ));
            }
            left.push_str(&right);
            Ok(ScalarValue::Text(left))
        }
        VariableOperation::Toggle => unreachable!(),
    }
}

fn scalar_to_f64(value: &ScalarValue) -> Result<f64, String> {
    match value {
        ScalarValue::Integer(value) => Ok(*value as f64),
        ScalarValue::Number(value) if value.is_finite() => Ok(*value),
        ScalarValue::Number(_) => Err("数值必须有限".to_owned()),
        _ => Err("number 运算只接受数值操作数".to_owned()),
    }
}

pub(super) fn profile_defaults(content: &ContentCatalog) -> Result<VariableMap, RuntimeError> {
    defaults_for_scope(content, VariableScope::Profile)
}

pub(super) fn defaults_for_scope(
    content: &ContentCatalog,
    scope: VariableScope,
) -> Result<VariableMap, RuntimeError> {
    content
        .manifest
        .variables
        .iter()
        .filter(|(_, definition)| definition.scope == scope)
        .map(|(id, definition)| {
            normalize_value(definition.default.clone(), definition.value_type)
                .map(|value| (id.clone(), value))
        })
        .collect()
}

pub(super) fn normalize_value(
    value: ScalarValue,
    expected: VariableType,
) -> Result<ScalarValue, RuntimeError> {
    match (expected, value) {
        (VariableType::Boolean, value @ ScalarValue::Boolean(_))
        | (VariableType::Integer, value @ ScalarValue::Integer(_)) => Ok(value),
        (VariableType::String, ScalarValue::Text(value))
            if value.len() <= MAX_VARIABLE_STRING_BYTES =>
        {
            Ok(ScalarValue::Text(value))
        }
        (VariableType::String, ScalarValue::Text(_)) => Err(RuntimeError::Content(format!(
            "字符串超过 {} 字节上限",
            MAX_VARIABLE_STRING_BYTES
        ))),
        (VariableType::Number, ScalarValue::Integer(value)) => {
            Ok(ScalarValue::Number(value as f64))
        }
        (VariableType::Number, ScalarValue::Number(value)) if value.is_finite() => {
            Ok(ScalarValue::Number(value))
        }
        (_, ScalarValue::Number(value)) if !value.is_finite() => {
            Err(RuntimeError::Content("变量数值必须是有限数".to_owned()))
        }
        (expected, actual) => Err(RuntimeError::Content(format!(
            "变量类型不匹配：期望 {expected:?}，实际 {actual:?}"
        ))),
    }
}

pub(super) fn validate_profile_variables(
    content: &ContentCatalog,
    variables: &VariableMap,
) -> Result<(), RuntimeError> {
    validate_variables_for_scope(content, variables, VariableScope::Profile)
}

pub(super) fn validate_variables_for_scope(
    content: &ContentCatalog,
    variables: &VariableMap,
    scope: VariableScope,
) -> Result<(), RuntimeError> {
    let expected_count = content
        .manifest
        .variables
        .values()
        .filter(|definition| definition.scope == scope)
        .count();
    if variables.len() != expected_count {
        return Err(RuntimeError::InvalidSnapshot(format!(
            "{scope:?} 变量数量不匹配"
        )));
    }
    for (id, definition) in &content.manifest.variables {
        if definition.scope != scope {
            continue;
        }
        let value = variables
            .get(id)
            .ok_or_else(|| RuntimeError::InvalidSnapshot(format!("缺少 {scope:?} 变量 {id}")))?;
        normalize_value(value.clone(), definition.value_type).map_err(|error| {
            RuntimeError::InvalidSnapshot(format!("变量 {id} 类型错误: {error}"))
        })?;
    }
    for id in variables.keys() {
        if content
            .manifest
            .variables
            .get(id)
            .is_none_or(|definition| definition.scope != scope)
        {
            return Err(RuntimeError::InvalidSnapshot(format!(
                "包含未知或错误作用域的变量 {id}"
            )));
        }
    }
    Ok(())
}

fn compare_values(
    left: &ScalarValue,
    right: &ScalarValue,
) -> Result<std::cmp::Ordering, RuntimeError> {
    match (left, right) {
        (ScalarValue::Boolean(left), ScalarValue::Boolean(right)) => Ok(left.cmp(right)),
        (ScalarValue::Text(left), ScalarValue::Text(right)) => Ok(left.cmp(right)),
        _ => compare_numeric(left, right),
    }
}

pub(super) fn compare_numeric(
    left: &ScalarValue,
    right: &ScalarValue,
) -> Result<std::cmp::Ordering, RuntimeError> {
    match (left, right) {
        (ScalarValue::Integer(left), ScalarValue::Integer(right)) => Ok(left.cmp(right)),
        (ScalarValue::Integer(left), ScalarValue::Number(right)) => {
            compare_integer_number(*left, *right)
        }
        (ScalarValue::Number(left), ScalarValue::Integer(right)) => {
            compare_integer_number(*right, *left).map(std::cmp::Ordering::reverse)
        }
        (ScalarValue::Number(left), ScalarValue::Number(right)) => left
            .partial_cmp(right)
            .ok_or_else(|| RuntimeError::Content("无法比较非有限数值".to_owned())),
        _ => Err(RuntimeError::Content(
            "Lt/Le/Gt/Ge 只允许比较数值".to_owned(),
        )),
    }
}

/// Compare an exact i64 with an f64 without first rounding the integer to a
/// floating-point value.  A direct `i64 as f64` cast collapses neighbouring
/// values above 2^53 and can make an equality condition unexpectedly true.
fn compare_integer_number(integer: i64, number: f64) -> Result<std::cmp::Ordering, RuntimeError> {
    if !number.is_finite() {
        return Err(RuntimeError::Content("无法比较非有限数值".to_owned()));
    }
    // 2^63 is the first value outside the signed i64 range.  Keep the
    // constants explicit so the boundary remains exact in f64.
    const I64_MIN_F64: f64 = -9_223_372_036_854_775_808.0;
    const I64_MAX_EXCLUSIVE_F64: f64 = 9_223_372_036_854_775_808.0;
    if number < I64_MIN_F64 {
        return Ok(std::cmp::Ordering::Greater);
    }
    if number >= I64_MAX_EXCLUSIVE_F64 {
        return Ok(std::cmp::Ordering::Less);
    }

    // Within the range above, the truncated f64 value is safe to convert to
    // i128.  Compare integer parts exactly, then account for a fractional
    // remainder when the integer parts match.
    let truncated = number.trunc() as i128;
    let ordering = i128::from(integer).cmp(&truncated);
    if ordering != std::cmp::Ordering::Equal {
        return Ok(ordering);
    }
    let fraction = number.fract();
    Ok(if fraction > 0.0 {
        std::cmp::Ordering::Less
    } else if fraction < 0.0 {
        std::cmp::Ordering::Greater
    } else {
        std::cmp::Ordering::Equal
    })
}
