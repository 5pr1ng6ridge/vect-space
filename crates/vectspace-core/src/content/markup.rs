use std::collections::BTreeMap;

use crate::model::{VariableDefinition, VariableType};
use crate::text_template;
use super::ContentError;
use super::common::node_error;

pub(super) fn validate_text_markup(
    text: &str,
    variables: &BTreeMap<String, VariableDefinition>,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    for forbidden in ["<script", "javascript:", "[html", "[/html]"] {
        if text.to_ascii_lowercase().contains(forbidden) {
            return node_error(scene_id, node_id, "文本中包含禁止的 HTML 或脚本标记");
        }
    }
    if let Err(message) = scan_text_markup(text) {
        return node_error(scene_id, node_id, &message);
    }
    let references = text_template::references(text)
        .map_err(|error| ContentError::Validation(format!("{scene_id}/{node_id}: {error}")))?;
    for reference in references {
        if crate::interaction::is_window_variable(&reference.id) {
            text_template::validate_reference_type(&reference, VariableType::String)
                .map_err(|error| ContentError::Validation(error.to_string()))?;
            continue;
        }
        let definition = variables.get(&reference.id).ok_or_else(|| {
            ContentError::Validation(format!(
                "{scene_id}/{node_id}: 插值引用了未声明变量 {}",
                reference.id
            ))
        })?;
        text_template::validate_reference_type(&reference, definition.value_type)
            .map_err(|error| ContentError::Validation(format!("{scene_id}/{node_id}: {error}")))?;
    }
    Ok(())
}

/// Validate author-facing text markup using the same boundary rules as the
/// renderer: escaped controls are literals and formulas are opaque units.
/// An unmatched `$` remains ordinary text for backwards compatibility.
pub(super) fn scan_text_markup(text: &str) -> Result<(), String> {
    let mut cursor = 0;
    let mut effect_stack: Vec<(&str, usize)> = Vec::new();
    let mut auto_markers = Vec::new();

    while cursor < text.len() {
        if text[cursor..].starts_with('\\') {
            let next = cursor + 1;
            if next < text.len()
                && text[next..]
                    .chars()
                    .next()
                    .is_some_and(|character| matches!(character, '$' | '[' | '\\'))
            {
                cursor = next_char_boundary(text, next);
                continue;
            }
        }

        // Display formulas take precedence over inline formulas. Controls in
        // a formula body are TeX text and must not affect the markup stack.
        if text[cursor..].starts_with("$$") {
            if let Some(end) = find_unescaped_markup_delimiter(text, "$$", cursor + 2) {
                cursor = end + 2;
                continue;
            }
            cursor += 2;
            continue;
        }
        if text[cursor..].starts_with('$') {
            if let Some(end) = find_unescaped_markup_delimiter(text, "$", cursor + 1) {
                cursor = end + 1;
                continue;
            }
            cursor += 1;
            continue;
        }

        if text[cursor..].starts_with('[') {
            let remainder = &text[cursor..];
            if remainder.starts_with("[/fx]") {
                if effect_stack.pop().is_none() {
                    return Err(markup_error(cursor, "[/fx] 没有对应的 [fx=...]"));
                }
                cursor += "[/fx]".len();
                continue;
            }

            if remainder.starts_with("[fx")
                && remainder
                    .as_bytes()
                    .get(3)
                    .is_none_or(|byte| *byte == b'=' || *byte == b']')
            {
                let end = control_end(remainder, cursor, "[fx=...]")?;
                let token = &remainder[..=end];
                let Some(effect) = token
                    .strip_prefix("[fx=")
                    .and_then(|value| value.strip_suffix(']'))
                else {
                    return Err(markup_error(
                        cursor,
                        "特效标记必须使用 [fx=shake|wave|glow]",
                    ));
                };
                if !matches!(effect, "shake" | "wave" | "glow") {
                    return Err(markup_error(cursor, &format!("未知文本特效: {effect}")));
                }
                effect_stack.push((effect, cursor));
                cursor += end + 1;
                continue;
            }

            if remainder.starts_with("[pause")
                && remainder
                    .as_bytes()
                    .get(6)
                    .is_none_or(|byte| *byte == b'=' || *byte == b']')
            {
                let end = control_end(remainder, cursor, "[pause=数字ms]")?;
                let token = &remainder[..=end];
                let value = token
                    .strip_prefix("[pause=")
                    .and_then(|value| value.strip_suffix("ms]"))
                    .filter(|value| {
                        !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
                    })
                    .ok_or_else(|| markup_error(cursor, "暂停标记必须是 [pause=数字ms]"))?;
                value
                    .parse::<u64>()
                    .map_err(|_| markup_error(cursor, "暂停时长超出范围"))?;
                cursor += end + 1;
                continue;
            }

            if remainder.starts_with("[speed")
                && remainder
                    .as_bytes()
                    .get(6)
                    .is_none_or(|byte| *byte == b'=' || *byte == b']')
            {
                let end = control_end(remainder, cursor, "[speed=default|数字cps]")?;
                let token = &remainder[..=end];
                let value = token
                    .strip_prefix("[speed=")
                    .and_then(|value| value.strip_suffix(']'))
                    .ok_or_else(|| {
                        markup_error(cursor, "速度标记必须是 [speed=default] 或 [speed=数字cps]")
                    })?;
                if value != "default" {
                    let numeric = value
                        .strip_suffix("cps")
                        .ok_or_else(|| markup_error(cursor, "速度标记必须以 cps 结尾"))?;
                    if numeric.is_empty()
                        || numeric.matches('.').count() > 1
                        || !numeric
                            .chars()
                            .all(|character| character.is_ascii_digit() || character == '.')
                    {
                        return Err(markup_error(cursor, "速度必须是正的有限数字"));
                    }
                    let cps = numeric
                        .parse::<f64>()
                        .map_err(|_| markup_error(cursor, "速度必须是正的有限数字"))?;
                    if !cps.is_finite() || cps <= 0.0 {
                        return Err(markup_error(cursor, "速度必须是正的有限数字"));
                    }
                }
                cursor += end + 1;
                continue;
            }

            if remainder.starts_with("[auto")
                && remainder
                    .as_bytes()
                    .get(5)
                    .is_none_or(|byte| *byte == b']' || byte.is_ascii_whitespace())
            {
                if !remainder.starts_with("[auto]") {
                    return Err(markup_error(cursor, "自动推进标记只能写成 [auto]"));
                }
                auto_markers.push(cursor);
                cursor += "[auto]".len();
                continue;
            }

            // The template validator checks the variable ID and scope. Here
            // we only ensure a malformed known prefix cannot become prose.
            if remainder.starts_with("[var")
                && remainder
                    .as_bytes()
                    .get(4)
                    .is_none_or(|byte| *byte == b'=' || *byte == b']')
            {
                let end = control_end(remainder, cursor, "[var=id]")?;
                let token = &remainder[..=end];
                if !token.starts_with("[var=") || !token.ends_with(']') {
                    return Err(markup_error(cursor, "变量插值必须写成 [var=id]"));
                }
                cursor += end + 1;
                continue;
            }

            if remainder.starts_with("[/fx") {
                return Err(markup_error(cursor, "特效结束标记必须写成 [/fx]"));
            }
        }

        cursor = next_char_boundary(text, cursor);
    }

    if let Some((effect, position)) = effect_stack.last() {
        return Err(markup_error(
            *position,
            &format!("[fx={effect}] 缺少对应的 [/fx]"),
        ));
    }
    if auto_markers.len() > 1 {
        return Err(markup_error(
            auto_markers[1],
            "[auto] 只能出现一次且必须位于对话末尾",
        ));
    }
    if let Some(position) = auto_markers.first().copied() {
        if !text[position + "[auto]".len()..].trim().is_empty() {
            return Err(markup_error(
                position,
                "[auto] 只能出现一次且必须位于对话末尾",
            ));
        }
    }
    Ok(())
}

fn control_end(remainder: &str, position: usize, syntax: &str) -> Result<usize, String> {
    remainder
        .find(']')
        .ok_or_else(|| markup_error(position, &format!("{syntax} 缺少右方括号")))
}

fn markup_error(position: usize, message: &str) -> String {
    format!("文本标记错误（字节 {position}）：{message}")
}

fn find_unescaped_markup_delimiter(text: &str, delimiter: &str, from: usize) -> Option<usize> {
    text[from..]
        .match_indices(delimiter)
        .map(|(offset, _)| from + offset)
        .find(|index| {
            let slash_count = text[..*index]
                .bytes()
                .rev()
                .take_while(|byte| *byte == b'\\')
                .count();
            slash_count % 2 == 0
        })
}

fn next_char_boundary(text: &str, cursor: usize) -> usize {
    cursor
        + text[cursor..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1)
}
