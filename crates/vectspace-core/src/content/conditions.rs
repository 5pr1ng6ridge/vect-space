use std::collections::BTreeMap;

use crate::model::{
    ConditionExpression, MutationValue, ScalarValue, ValueOperand, VariableDefinition,
    VariableOperation, VariableType,
};
use crate::text_template::MAX_VARIABLE_STRING_BYTES;
use super::ContentError;
use super::common::{node_error, validate_identifier};

pub(super) const MAX_CONDITION_DEPTH: usize = 32;
const MAX_CONDITION_NODES: usize = 256;

pub(super) fn validate_condition(
    condition: &ConditionExpression,
    variables: &BTreeMap<String, VariableDefinition>,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    let mut nodes = 0;
    validate_condition_inner(condition, variables, scene_id, node_id, 1, &mut nodes)
}

fn validate_condition_inner(
    condition: &ConditionExpression,
    variables: &BTreeMap<String, VariableDefinition>,
    scene_id: &str,
    node_id: &str,
    depth: usize,
    nodes: &mut usize,
) -> Result<(), ContentError> {
    *nodes += 1;
    if depth > MAX_CONDITION_DEPTH {
        return node_error(scene_id, node_id, "条件表达式嵌套过深");
    }
    if *nodes > MAX_CONDITION_NODES {
        return node_error(scene_id, node_id, "条件表达式节点过多");
    }

    match condition {
        ConditionExpression::Eq { left, right } | ConditionExpression::Ne { left, right } => {
            let left_type = operand_type(left, variables, scene_id, node_id)?;
            let right_type = operand_type(right, variables, scene_id, node_id)?;
            if !types_comparable_for_equality(left_type, right_type) {
                return node_error(scene_id, node_id, "Eq/Ne 两侧类型不兼容");
            }
        }
        ConditionExpression::Lt { left, right }
        | ConditionExpression::Le { left, right }
        | ConditionExpression::Gt { left, right }
        | ConditionExpression::Ge { left, right } => {
            let left_type = operand_type(left, variables, scene_id, node_id)?;
            let right_type = operand_type(right, variables, scene_id, node_id)?;
            if !is_numeric_type(left_type) || !is_numeric_type(right_type) {
                return node_error(scene_id, node_id, "Lt/Le/Gt/Ge 只允许比较数值");
            }
        }
        ConditionExpression::And { conditions } | ConditionExpression::Or { conditions } => {
            if conditions.is_empty() {
                return node_error(scene_id, node_id, "And/Or 至少需要一个子条件");
            }
            for child in conditions {
                validate_condition_inner(child, variables, scene_id, node_id, depth + 1, nodes)?;
            }
        }
        ConditionExpression::Not { condition } => {
            validate_condition_inner(condition, variables, scene_id, node_id, depth + 1, nodes)?
        }
    }
    Ok(())
}

fn operand_type(
    operand: &ValueOperand,
    variables: &BTreeMap<String, VariableDefinition>,
    scene_id: &str,
    node_id: &str,
) -> Result<VariableType, ContentError> {
    match operand {
        ValueOperand::Variable(reference) => {
            validate_identifier("variable", &reference.variable)?;
            if crate::interaction::is_window_variable(&reference.variable) { return Ok(VariableType::String); }
            variables
                .get(&reference.variable)
                .map(|definition| definition.value_type)
                .ok_or_else(|| {
                    ContentError::Validation(format!(
                        "{scene_id}/{node_id}: 条件引用了未声明变量 {}",
                        reference.variable
                    ))
                })
        }
        ValueOperand::Literal(literal) => {
            let value_type = scalar_type(&literal.value);
            validate_value_for_type(&literal.value, value_type).map_err(|message| {
                ContentError::Validation(format!("{scene_id}/{node_id}: 条件字面量无效: {message}"))
            })?;
            Ok(value_type)
        }
    }
}

pub(super) fn validate_mutation(
    operation: VariableOperation,
    value: Option<&MutationValue>,
    target_type: VariableType,
    variables: &BTreeMap<String, VariableDefinition>,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    if operation == VariableOperation::Toggle {
        if target_type != VariableType::Boolean {
            return node_error(scene_id, node_id, "toggle 只能用于 boolean 变量");
        }
        if value.is_some() {
            return node_error(scene_id, node_id, "toggle 不接受 value");
        }
        return Ok(());
    }

    let value = value.ok_or_else(|| {
        ContentError::Validation(format!(
            "{scene_id}/{node_id}: {operation:?} 操作缺少 value"
        ))
    })?;
    let source_type = mutation_value_type(value, variables, scene_id, node_id)?;
    let valid = match operation {
        VariableOperation::Assign => {
            target_type == source_type
                || (target_type == VariableType::Number && source_type == VariableType::Integer)
        }
        VariableOperation::Add | VariableOperation::Sub | VariableOperation::Mul => {
            match target_type {
                VariableType::Integer => source_type == VariableType::Integer,
                VariableType::Number => is_numeric_type(source_type),
                _ => false,
            }
        }
        VariableOperation::Mod => {
            target_type == VariableType::Integer && source_type == VariableType::Integer
        }
        VariableOperation::Append => {
            target_type == VariableType::String && source_type == VariableType::String
        }
        VariableOperation::Toggle => unreachable!(),
    };
    if !valid {
        return node_error(
            scene_id,
            node_id,
            &format!("{operation:?} 不支持 {target_type:?} 目标与 {source_type:?} 操作数"),
        );
    }
    Ok(())
}

fn mutation_value_type(
    value: &MutationValue,
    variables: &BTreeMap<String, VariableDefinition>,
    scene_id: &str,
    node_id: &str,
) -> Result<VariableType, ContentError> {
    match value {
        MutationValue::Variable(reference) => {
            validate_identifier("variable", &reference.variable)?;
            variables
                .get(&reference.variable)
                .map(|definition| definition.value_type)
                .ok_or_else(|| {
                    ContentError::Validation(format!(
                        "{scene_id}/{node_id}: set 引用了未声明变量 {}",
                        reference.variable
                    ))
                })
        }
        MutationValue::Literal(value) => {
            let value_type = scalar_type(value);
            validate_value_for_type(value, value_type).map_err(|message| {
                ContentError::Validation(format!("{scene_id}/{node_id}: set 字面量无效: {message}"))
            })?;
            Ok(value_type)
        }
    }
}

pub(super) fn validate_value_for_type(value: &ScalarValue, expected: VariableType) -> Result<(), String> {
    if let ScalarValue::Text(value) = value {
        if value.len() > MAX_VARIABLE_STRING_BYTES {
            return Err(format!("字符串超过 {} 字节上限", MAX_VARIABLE_STRING_BYTES));
        }
    }
    let valid = match (expected, value) {
        (VariableType::Boolean, ScalarValue::Boolean(_))
        | (VariableType::Integer, ScalarValue::Integer(_))
        | (VariableType::String, ScalarValue::Text(_)) => true,
        (VariableType::Number, ScalarValue::Integer(_)) => true,
        (VariableType::Number, ScalarValue::Number(value)) => value.is_finite(),
        (_, ScalarValue::Number(value)) if !value.is_finite() => {
            return Err("数值必须是有限数".to_owned());
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!("期望 {expected:?}，实际 {:?}", scalar_type(value)))
    }
}

fn scalar_type(value: &ScalarValue) -> VariableType {
    match value {
        ScalarValue::Boolean(_) => VariableType::Boolean,
        ScalarValue::Integer(_) => VariableType::Integer,
        ScalarValue::Number(_) => VariableType::Number,
        ScalarValue::Text(_) => VariableType::String,
    }
}

fn is_numeric_type(value_type: VariableType) -> bool {
    matches!(value_type, VariableType::Integer | VariableType::Number)
}

fn types_comparable_for_equality(left: VariableType, right: VariableType) -> bool {
    left == right || (is_numeric_type(left) && is_numeric_type(right))
}
