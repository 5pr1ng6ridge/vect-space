//! Explicit wire contracts shared by the Tauri hosts and generated TypeScript.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;
use vectspace_core::model::{
    AudioSnapshot, BootstrapPayload, DialoguePageSnapshot, LongTextPageSnapshot, PlaybackSnapshot,
    PresentationCue, PromptSnapshot, RuntimeSnapshot, RuntimeUpdate, ScalarValue, StoryLocation,
    WorldSnapshot,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
#[ts(export, export_to = "../../../shared/generated/WireScalarValue.ts")]
pub enum WireScalarValue {
    Boolean(bool),
    Integer(String),
    Number(f64),
    String(String),
}

pub type WireVariableMap = BTreeMap<String, WireScalarValue>;

#[derive(Debug, Clone, Serialize)]
pub struct WireRuntimeSnapshot {
    pub revision: u64,
    pub location: StoryLocation,
    pub variables: WireVariableMap,
    pub world: WorldSnapshot,
    pub audio: AudioSnapshot,
    pub playback: PlaybackSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dialogue_page: Option<DialoguePageSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_text_page: Option<LongTextPageSnapshot>,
    pub prompt: PromptSnapshot,
}

#[derive(Debug, Clone, Serialize)]
pub struct WireRuntimeUpdate {
    pub update_id: u64,
    pub snapshot: WireRuntimeSnapshot,
    pub cues: Vec<PresentationCue>,
    pub requires_ack: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WireBootstrapPayload {
    pub update: WireRuntimeUpdate,
    pub asset_ids: Vec<String>,
    pub content_version: String,
    pub story_flow_available: bool,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("integer 必须使用规范十进制格式: {0}")]
    InvalidInteger(String),
    #[error("number 必须是有限值")]
    NonFiniteNumber,
}

impl TryFrom<WireScalarValue> for ScalarValue {
    type Error = ProtocolError;

    fn try_from(value: WireScalarValue) -> Result<Self, Self::Error> {
        match value {
            WireScalarValue::Boolean(value) => Ok(Self::Boolean(value)),
            WireScalarValue::Integer(value) => parse_integer(&value).map(Self::Integer),
            WireScalarValue::Number(value) if value.is_finite() => Ok(Self::Number(value)),
            WireScalarValue::Number(_) => Err(ProtocolError::NonFiniteNumber),
            WireScalarValue::String(value) => Ok(Self::Text(value)),
        }
    }
}

impl From<ScalarValue> for WireScalarValue {
    fn from(value: ScalarValue) -> Self {
        match value {
            ScalarValue::Boolean(value) => Self::Boolean(value),
            ScalarValue::Integer(value) => Self::Integer(value.to_string()),
            ScalarValue::Number(value) => Self::Number(value),
            ScalarValue::Text(value) => Self::String(value),
        }
    }
}

impl From<RuntimeSnapshot> for WireRuntimeSnapshot {
    fn from(snapshot: RuntimeSnapshot) -> Self {
        Self {
            revision: snapshot.revision,
            location: snapshot.location,
            variables: snapshot
                .variables
                .into_iter()
                .map(|(id, value)| (id, value.into()))
                .collect(),
            world: snapshot.world,
            audio: snapshot.audio,
            playback: snapshot.playback,
            dialogue_page: snapshot.dialogue_page,
            long_text_page: snapshot.long_text_page,
            prompt: snapshot.prompt,
        }
    }
}

impl From<RuntimeUpdate> for WireRuntimeUpdate {
    fn from(update: RuntimeUpdate) -> Self {
        Self {
            update_id: update.update_id,
            snapshot: update.snapshot.into(),
            cues: update.cues,
            requires_ack: update.requires_ack,
        }
    }
}

impl From<BootstrapPayload> for WireBootstrapPayload {
    fn from(payload: BootstrapPayload) -> Self {
        Self {
            update: payload.update.into(),
            asset_ids: payload.asset_ids,
            content_version: payload.content_version,
            story_flow_available: payload.story_flow_available,
        }
    }
}

pub fn variable_map_from_wire(
    values: WireVariableMap,
) -> Result<BTreeMap<String, ScalarValue>, ProtocolError> {
    values
        .into_iter()
        .map(|(id, value)| ScalarValue::try_from(value).map(|value| (id, value)))
        .collect()
}

fn parse_integer(value: &str) -> Result<i64, ProtocolError> {
    let parsed = value
        .parse::<i64>()
        .map_err(|_| ProtocolError::InvalidInteger(value.to_owned()))?;
    if parsed.to_string() != value {
        return Err(ProtocolError::InvalidInteger(value.to_owned()));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_i64_range_round_trips_without_javascript_numbers() {
        for value in [i64::MIN, -1, 0, 1, i64::MAX] {
            let wire = WireScalarValue::from(ScalarValue::Integer(value));
            assert_eq!(ScalarValue::try_from(wire), Ok(ScalarValue::Integer(value)));
        }
    }

    #[test]
    fn non_canonical_and_out_of_range_integers_are_rejected() {
        for value in ["+1", "01", "-0", "9223372036854775808", "1.0", ""] {
            assert!(matches!(
                ScalarValue::try_from(WireScalarValue::Integer(value.to_owned())),
                Err(ProtocolError::InvalidInteger(_))
            ));
        }
    }
}
