//! Safe variable interpolation for dialogue and choice text.

use std::{fmt, ops::Range};

use crate::model::{ScalarValue, VariableType};

pub const MAX_VARIABLE_STRING_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemplateContext {
    Text,
    Math,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateReference {
    pub id: String,
    pub context: TemplateContext,
    range: Range<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateError(pub String);

impl fmt::Display for TemplateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

pub fn references(source: &str) -> Result<Vec<TemplateReference>, TemplateError> {
    let mut result = Vec::new();
    let mut cursor = 0;
    while cursor < source.len() {
        if is_unescaped_at(source, cursor, "$$") {
            if let Some(end) = find_unescaped(source, "$$", cursor + 2) {
                scan_range(source, cursor + 2..end, TemplateContext::Math, &mut result)?;
                cursor = end + 2;
                continue;
            }
        }
        if is_unescaped_at(source, cursor, "$") {
            if let Some(end) = find_unescaped(source, "$", cursor + 1) {
                scan_range(source, cursor + 1..end, TemplateContext::Math, &mut result)?;
                cursor = end + 1;
                continue;
            }
        }

        let next_math = next_unescaped_dollar(source, cursor).unwrap_or(source.len());
        scan_range(
            source,
            cursor..next_math,
            TemplateContext::Text,
            &mut result,
        )?;
        cursor = if next_math == cursor {
            next_char_boundary(source, cursor)
        } else {
            next_math
        };
    }
    result.sort_by_key(|reference| reference.range.start);
    Ok(result)
}

pub fn interpolate(
    source: &str,
    mut resolve: impl FnMut(&str) -> Result<ScalarValue, TemplateError>,
) -> Result<String, TemplateError> {
    let references = references(source)?;
    if references.is_empty() {
        return Ok(source.to_owned());
    }
    let mut output = String::with_capacity(source.len());
    let mut cursor = 0;
    for reference in references {
        output.push_str(&source[cursor..reference.range.start]);
        let value = resolve(&reference.id)?;
        match reference.context {
            TemplateContext::Text => output.push_str(&escape_plain_value(&value)),
            TemplateContext::Math => output.push_str(&format_math_value(&value)?),
        }
        cursor = reference.range.end;
    }
    output.push_str(&source[cursor..]);
    Ok(output)
}

pub fn validate_reference_type(
    reference: &TemplateReference,
    value_type: VariableType,
) -> Result<(), TemplateError> {
    if reference.context == TemplateContext::Math
        && !matches!(value_type, VariableType::Integer | VariableType::Number)
    {
        return Err(TemplateError(format!(
            "公式中的插值变量 {} 必须是 integer 或 number",
            reference.id
        )));
    }
    Ok(())
}

fn scan_range(
    source: &str,
    range: Range<usize>,
    context: TemplateContext,
    output: &mut Vec<TemplateReference>,
) -> Result<(), TemplateError> {
    let mut cursor = range.start;
    while cursor < range.end {
        if source[cursor..].starts_with("[var=") && !is_escaped(source, cursor) {
            let relative_end = source[cursor + 5..range.end]
                .find(']')
                .ok_or_else(|| TemplateError("变量插值缺少右方括号".to_owned()))?;
            let end = cursor + 5 + relative_end;
            let id = &source[cursor + 5..end];
            if !valid_identifier(id) {
                return Err(TemplateError(format!("变量插值 ID 非法: {id}")));
            }
            output.push(TemplateReference {
                id: id.to_owned(),
                context,
                range: cursor..end + 1,
            });
            cursor = end + 1;
            continue;
        }
        cursor = next_char_boundary(source, cursor);
    }
    Ok(())
}

fn next_unescaped_dollar(source: &str, from: usize) -> Option<usize> {
    source[from..]
        .match_indices('$')
        .map(|(offset, _)| from + offset)
        .find(|index| !is_escaped(source, *index))
}

fn find_unescaped(source: &str, marker: &str, from: usize) -> Option<usize> {
    source[from..]
        .match_indices(marker)
        .map(|(offset, _)| from + offset)
        .find(|index| !is_escaped(source, *index))
}

fn is_unescaped_at(source: &str, index: usize, marker: &str) -> bool {
    source[index..].starts_with(marker) && !is_escaped(source, index)
}

fn is_escaped(source: &str, index: usize) -> bool {
    let slash_count = source[..index]
        .chars()
        .rev()
        .take_while(|character| *character == '\\')
        .count();
    slash_count % 2 == 1
}

fn next_char_boundary(source: &str, index: usize) -> usize {
    index
        + source[index..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
}

fn escape_plain_value(value: &ScalarValue) -> String {
    scalar_text(value)
        .replace('\\', "\\\\")
        .replace('$', "\\$")
        .replace('[', "\\[")
}

fn scalar_text(value: &ScalarValue) -> String {
    match value {
        ScalarValue::Boolean(value) => value.to_string(),
        ScalarValue::Integer(value) => value.to_string(),
        ScalarValue::Number(value) => value.to_string(),
        ScalarValue::Text(value) => value.clone(),
    }
}

fn format_math_value(value: &ScalarValue) -> Result<String, TemplateError> {
    let text = match value {
        ScalarValue::Integer(value) => return Ok(value.to_string()),
        ScalarValue::Number(value) if value.is_finite() => {
            let magnitude = value.abs();
            if magnitude != 0.0 && !(1.0e-6..1.0e21).contains(&magnitude) {
                format!("{value:e}")
            } else {
                value.to_string()
            }
        }
        ScalarValue::Number(_) => return Err(TemplateError("公式插值数值必须有限".to_owned())),
        _ => return Err(TemplateError("公式插值只接受 integer 或 number".to_owned())),
    };
    let Some((mantissa, exponent)) = text.split_once(['e', 'E']) else {
        return Ok(text);
    };
    let exponent = exponent.strip_prefix('+').unwrap_or(exponent);
    Ok(format!("{mantissa}\\times 10^{{{exponent}}}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[derive(serde::Deserialize)]
    struct ConformanceCase {
        name: String,
        source: String,
        variables: BTreeMap<String, ScalarValue>,
        expected: String,
    }

    #[test]
    fn shared_conformance_corpus_matches() {
        let fixtures: Vec<ConformanceCase> =
            serde_json::from_str(include_str!("../../../fixtures/text-template-cases.json"))
                .unwrap();
        for fixture in fixtures {
            let rendered = interpolate(&fixture.source, |id| {
                fixture
                    .variables
                    .get(id)
                    .cloned()
                    .ok_or_else(|| TemplateError(format!("unknown variable {id}")))
            })
            .unwrap();
            assert_eq!(rendered, fixture.expected, "{}", fixture.name);
        }
    }

    #[test]
    fn finds_plain_and_math_references_but_not_escaped_literals() {
        let found = references(r"A [var=name], $x=[var=score]$, \[var=literal]").unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].context, TemplateContext::Text);
        assert_eq!(found[1].context, TemplateContext::Math);
    }

    #[test]
    fn plain_values_cannot_inject_markup() {
        let rendered = interpolate("[var=value]", |_| {
            Ok(ScalarValue::Text("$x$[pause=1ms]\\".to_owned()))
        })
        .unwrap();
        assert_eq!(rendered, r"\$x\$\[pause=1ms]\\");
    }

    #[test]
    fn scientific_numbers_become_fixed_latex() {
        let rendered = interpolate("$[var=value]$", |_| Ok(ScalarValue::Number(1.2e30))).unwrap();
        assert_eq!(rendered, r"$1.2\times 10^{30}$");
    }
}
