//! Wire encoding of scalar values.  JSON numbers cannot carry a full `i64`, so
//! scalars cross the IPC boundary as `{ kind, value }` objects (integers as
//! canonical decimal strings); the host encodes them in the project it sends
//! and decodes them in every request it receives.

use std::collections::BTreeMap;

use vectspace_core::model::{VariableDefinition, VariableType};

pub(crate) fn encode_project_scalars(
    project: &mut serde_json::Value,
    variables: &BTreeMap<String, VariableDefinition>,
) {
    let Some(object) = project.as_object_mut() else {
        return;
    };
    if let Some(manifest) = object
        .get_mut("manifest")
        .and_then(|value| value.as_object_mut())
    {
        if let Some(variable_values) = manifest
            .get_mut("variables")
            .and_then(|value| value.as_object_mut())
        {
            for (id, definition) in variables {
                if let Some(default) = variable_values
                    .get_mut(id)
                    .and_then(|value| value.as_object_mut())
                    .and_then(|value| value.get_mut("default"))
                {
                    let raw = std::mem::take(default);
                    *default = encode_scalar_json(raw, Some(definition.value_type));
                }
            }
        }
    }
    if let Some(scenes) = object
        .get_mut("scenes")
        .and_then(|value| value.as_array_mut())
    {
        for scene in scenes {
            if let Some(nodes) = scene
                .as_object_mut()
                .and_then(|value| value.get_mut("definition"))
                .and_then(|value| value.as_object_mut())
                .and_then(|value| value.get_mut("nodes"))
                .and_then(|value| value.as_object_mut())
            {
                for node in nodes.values_mut() {
                    encode_node_scalars(node);
                }
            }
        }
    }
    if let Some(chapter_map) = object
        .get_mut("chapter_map")
        .and_then(|value| value.as_object_mut())
        .and_then(|value| value.get_mut("definition"))
    {
        if let Some(hotspots) = chapter_map
            .as_object_mut()
            .and_then(|value| value.get_mut("hotspots"))
            .and_then(|value| value.as_array_mut())
        {
            for hotspot in hotspots {
                if let Some(condition) = hotspot
                    .as_object_mut()
                    .and_then(|value| value.get_mut("reveal"))
                    .and_then(|value| value.as_object_mut())
                    .and_then(|value| value.get_mut("condition"))
                {
                    encode_condition_scalars(condition);
                }
                if let Some(overrides) = hotspot
                    .as_object_mut()
                    .and_then(|value| value.get_mut("variable_overrides"))
                    .and_then(|value| value.as_object_mut())
                {
                    for value in overrides.values_mut() {
                        let raw = std::mem::take(value);
                        *value = encode_scalar_json(raw, None);
                    }
                }
            }
        }
    }
    if let Some(layout) = object
        .get_mut("layout")
        .and_then(|value| value.as_object_mut())
    {
        if let Some(previews) = layout
            .get_mut("timeline_previews")
            .and_then(|value| value.as_object_mut())
        {
            for settings in previews.values_mut() {
                if let Some(overrides) = settings
                    .as_object_mut()
                    .and_then(|value| value.get_mut("variable_overrides"))
                    .and_then(|value| value.as_object_mut())
                {
                    for (id, value) in overrides.iter_mut() {
                        let raw = std::mem::take(value);
                        let expected = variables.get(id).map(|definition| definition.value_type);
                        *value = encode_scalar_json(raw, expected);
                    }
                }
            }
        }
    }
}

fn encode_node_scalars(node: &mut serde_json::Value) {
    let Some(object) = node.as_object_mut() else {
        return;
    };
    match object.get("type").and_then(|value| value.as_str()) {
        Some("set") => {
            if let Some(value) = object.get_mut("value") {
                if !value.is_object() || value.get("variable").is_none() {
                    let raw = std::mem::take(value);
                    *value = encode_scalar_json(raw, None);
                }
            }
        }
        Some("condition") => {
            if let Some(condition) = object.get_mut("condition") {
                encode_condition_scalars(condition);
            }
        }
        Some("choice") => {
            if let Some(choices) = object
                .get_mut("choices")
                .and_then(|value| value.as_array_mut())
            {
                for choice in choices {
                    for key in ["visible_if", "enabled_if"] {
                        if let Some(condition) =
                            choice.as_object_mut().and_then(|value| value.get_mut(key))
                        {
                            encode_condition_scalars(condition);
                        }
                    }
                }
            }
        }
        Some("button_create") | Some("button_update") => {
            if let Some(action) = object
                .get_mut("action")
                .and_then(|value| value.as_object_mut())
            {
                if let Some(sets) = action
                    .get_mut("sets")
                    .and_then(|value| value.as_array_mut())
                {
                    for set in sets {
                        let Some(value) =
                            set.as_object_mut().and_then(|value| value.get_mut("value"))
                        else {
                            continue;
                        };
                        if value
                            .as_object()
                            .is_some_and(|object| object.get("variable").is_some())
                        {
                            continue;
                        }
                        let raw = std::mem::take(value);
                        *value = encode_scalar_json(raw, None);
                    }
                }
            }
        }
        _ => {}
    }
}

fn encode_condition_scalars(condition: &mut serde_json::Value) {
    let Some(object) = condition.as_object_mut() else {
        return;
    };
    match object.get("op").and_then(|value| value.as_str()) {
        Some("eq") | Some("ne") | Some("lt") | Some("le") | Some("gt") | Some("ge") => {
            for key in ["left", "right"] {
                if let Some(operand) = object.get_mut(key) {
                    if let Some(value) = operand
                        .as_object_mut()
                        .and_then(|value| value.get_mut("value"))
                    {
                        let raw = std::mem::take(value);
                        *value = encode_scalar_json(raw, None);
                    }
                }
            }
        }
        Some("and") | Some("or") => {
            if let Some(children) = object
                .get_mut("conditions")
                .and_then(|value| value.as_array_mut())
            {
                for child in children {
                    encode_condition_scalars(child);
                }
            }
        }
        Some("not") => {
            if let Some(child) = object.get_mut("condition") {
                encode_condition_scalars(child);
            }
        }
        _ => {}
    }
}

fn encode_scalar_json(
    value: serde_json::Value,
    expected: Option<VariableType>,
) -> serde_json::Value {
    if value
        .as_object()
        .is_some_and(|object| object.get("kind").is_some() && object.get("value").is_some())
    {
        return value;
    }
    let (kind, value) = match value {
        serde_json::Value::Bool(value) => ("boolean", serde_json::Value::Bool(value)),
        serde_json::Value::Number(value)
            if expected == Some(VariableType::Number) && value.as_f64().is_some() =>
        {
            ("number", serde_json::Value::Number(value))
        }
        serde_json::Value::Number(value) => {
            if let Some(integer) = value.as_i64() {
                ("integer", serde_json::Value::String(integer.to_string()))
            } else if let Some(number) = value.as_f64() {
                ("number", serde_json::json!(number))
            } else {
                return serde_json::Value::Null;
            }
        }
        serde_json::Value::String(value) => ("string", serde_json::Value::String(value)),
        other => return other,
    };
    serde_json::json!({ "kind": kind, "value": value })
}

pub(crate) fn decode_wire_scalars(value: &mut serde_json::Value) -> Result<(), String> {
    if let Some(object) = value.as_object_mut() {
        if let (Some(kind), Some(payload)) = (object.get("kind"), object.get("value")) {
            if object.len() == 2 {
                let decoded = match kind.as_str() {
                    Some("boolean") if payload.is_boolean() => payload.clone(),
                    Some("string") if payload.is_string() => payload.clone(),
                    Some("number") => {
                        let number = payload
                            .as_f64()
                            .ok_or_else(|| "wire number 必须是有限数字".to_owned())?;
                        if !number.is_finite() {
                            return Err("wire number 必须是有限数字".to_owned());
                        }
                        serde_json::json!(number)
                    }
                    Some("integer") => {
                        let text = payload
                            .as_str()
                            .ok_or_else(|| "wire integer 必须是字符串".to_owned())?;
                        let parsed = text
                            .parse::<i64>()
                            .map_err(|_| format!("非法或越界整数: {text}"))?;
                        if parsed.to_string() != text {
                            return Err(format!("非规范整数: {text}"));
                        }
                        serde_json::json!(parsed)
                    }
                    Some(other) => return Err(format!("未知 wire 标量类型: {other}")),
                    None => return Err("wire 标量 kind 必须是字符串".to_owned()),
                };
                *value = decoded;
                return Ok(());
            }
        }
        for child in object.values_mut() {
            decode_wire_scalars(child)?;
        }
        return Ok(());
    }
    if let Some(array) = value.as_array_mut() {
        for child in array {
            decode_wire_scalars(child)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn button_action_integers_encode_losslessly_and_variable_references_stay() {
        let mut node = serde_json::json!({
            "type": "button_create",
            "action": { "sets": [{ "variable": "score", "op": "assign", "value": i64::MAX }] }
        });
        encode_node_scalars(&mut node);
        assert_eq!(
            node["action"]["sets"][0]["value"],
            serde_json::json!({ "kind": "integer", "value": i64::MAX.to_string() })
        );

        let mut reference = serde_json::json!({
            "type": "button_create",
            "action": {
                "sets": [{ "variable": "score", "op": "assign", "value": { "variable": "other" } }]
            }
        });
        encode_node_scalars(&mut reference);
        assert_eq!(
            reference["action"]["sets"][0]["value"],
            serde_json::json!({ "variable": "other" })
        );
    }
}
