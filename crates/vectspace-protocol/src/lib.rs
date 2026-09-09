//! Explicit wire contracts shared by the Tauri hosts and generated TypeScript.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize, Serializer};
use thiserror::Error;
use ts_rs::TS;
use vectspace_core::model::{
    AudioSnapshot, BootstrapPayload, DialogueHistoryEntry, DialoguePageSnapshot,
    LongTextPageSnapshot, PlaybackSnapshot, PresentationCue, PromptSnapshot, RuntimeSnapshot,
    RuntimeUpdate, ScalarValue, StoryLocation, WorldSnapshot,
};
use vectspace_core::runtime::RuntimeError;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
#[ts(export, export_to = "../../../shared/generated/WireScalarValue.ts")]
pub enum WireScalarValue {
    Boolean(bool),
    Integer(String),
    Number(f64),
    String(String),
}

/// An unsigned integer which is not guaranteed to fit in JavaScript's safe
/// integer range.  Keeping the wire representation textual prevents a
/// WebView JSON round-trip from silently changing revisions or event IDs.
#[derive(Debug, Clone, PartialEq, Eq, TS)]
#[ts(
    type = "string",
    export,
    export_to = "../../../shared/generated/WireU64.ts"
)]
pub struct WireU64(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../shared/generated/WireSessionMode.ts")]
#[serde(rename_all = "snake_case")]
pub enum WireSessionMode {
    Story,
    Replay,
}

impl Serialize for WireU64 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for WireU64 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        parse_u64(&value).map_err(serde::de::Error::custom)?;
        Ok(Self(value))
    }
}

impl WireU64 {
    pub fn parse(&self) -> Result<u64, ProtocolError> {
        parse_u64(&self.0)
    }
}

impl From<u64> for WireU64 {
    fn from(value: u64) -> Self {
        Self(value.to_string())
    }
}

pub type WireVariableMap = BTreeMap<String, WireScalarValue>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../shared/generated/WireAssetKind.ts")]
#[serde(rename_all = "snake_case")]
pub enum WireAssetKind {
    Background,
    Sprite,
    Gui,
    Bgm,
    Sfx,
    Video,
    Font,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../shared/generated/WireAssetMetadata.ts")]
pub struct WireAssetMetadata {
    pub format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Media durations are not bounded by the IPC contract.  Keep them in
    /// the same canonical decimal wire form as other u64 values so a very
    /// long container can never be rounded by WebView JSON parsing.
    pub duration_ms: Option<WireU64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channels: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_style: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../shared/generated/WireAssetDiagnostic.ts")]
pub struct WireAssetDiagnostic {
    pub severity: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(
    export,
    export_to = "../../../shared/generated/WireAssetReuseCandidate.ts"
)]
pub struct WireAssetReuseCandidate {
    pub id: String,
    pub kind: WireAssetKind,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../shared/generated/WireAssetInspection.ts")]
pub struct WireAssetInspection {
    pub inspection_id: String,
    pub source_name: String,
    pub detected_format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_kind: Option<WireAssetKind>,
    pub size_bytes: WireU64,
    pub sha256: String,
    pub metadata: WireAssetMetadata,
    pub reuse_candidates: Vec<WireAssetReuseCandidate>,
    pub diagnostics: Vec<WireAssetDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(
    export,
    export_to = "../../../shared/generated/WireInspectAssetImportsRequest.ts"
)]
pub struct WireInspectAssetImportsRequest {
    pub source_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(
    export,
    export_to = "../../../shared/generated/WireImportAssetRequest.ts"
)]
pub struct WireImportAssetRequest {
    pub id: String,
    pub kind: WireAssetKind,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub inspection_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(
    export,
    export_to = "../../../shared/generated/WireStageAssetImportsRequest.ts"
)]
pub struct WireStageAssetImportsRequest {
    #[serde(default)]
    pub requests: Vec<WireImportAssetRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../shared/generated/WireImportedAsset.ts")]
pub struct WireImportedAsset {
    pub id: String,
    pub kind: WireAssetKind,
    pub path: String,
    pub absolute_path: String,
    pub size_bytes: WireU64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reused_from: Option<String>,
}

/// Stable error envelope returned by every Tauri command.  Keeping the code
/// separate from the localized message lets the UI decide whether to focus
/// the problems panel, ask the user to reload, or merely show a toast without
/// parsing human-readable text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../shared/generated/WireCommandError.ts")]
pub struct WireCommandError {
    pub code: WireCommandErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<Box<WireStoryLocation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(
    export,
    export_to = "../../../shared/generated/WireCommandErrorCode.ts"
)]
#[serde(rename_all = "snake_case")]
pub enum WireCommandErrorCode {
    Validation,
    StaleProject,
    StaleSession,
    Io,
    Asset,
    PreviewUnreachable,
    Runtime,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../shared/generated/WireStoryLocation.ts")]
pub struct WireStoryLocation {
    pub scene_id: String,
    pub node_id: String,
}

impl From<StoryLocation> for WireStoryLocation {
    fn from(location: StoryLocation) -> Self {
        Self {
            scene_id: location.scene_id,
            node_id: location.node_id,
        }
    }
}

impl WireCommandError {
    pub fn new(code: WireCommandErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            path: None,
            location: None,
            element_id: None,
        }
    }

    pub fn with_path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    pub fn with_location(mut self, location: StoryLocation) -> Self {
        self.location = Some(Box::new(location.into()));
        self
    }
}

impl From<String> for WireCommandError {
    fn from(message: String) -> Self {
        Self::new(WireCommandErrorCode::Internal, message)
    }
}

impl From<&str> for WireCommandError {
    fn from(message: &str) -> Self {
        Self::new(WireCommandErrorCode::Internal, message)
    }
}

impl From<ProtocolError> for WireCommandError {
    fn from(error: ProtocolError) -> Self {
        Self::new(WireCommandErrorCode::Validation, error.to_string())
    }
}

impl From<RuntimeError> for WireCommandError {
    fn from(error: RuntimeError) -> Self {
        let code = match &error {
            RuntimeError::Content(_) | RuntimeError::InvalidSnapshot(_) => {
                WireCommandErrorCode::Validation
            }
            RuntimeError::StaleRevision { .. } => WireCommandErrorCode::Runtime,
            _ => WireCommandErrorCode::Runtime,
        };
        Self::new(code, error.to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct WireRuntimeSnapshot {
    pub session_id: WireU64,
    pub mode: WireSessionMode,
    pub revision: WireU64,
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
    pub session_id: WireU64,
    pub mode: WireSessionMode,
    pub update_id: WireU64,
    pub snapshot: WireRuntimeSnapshot,
    #[serde(serialize_with = "serialize_cues")]
    pub cues: Vec<PresentationCue>,
    pub requires_ack: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(
    export,
    export_to = "../../../shared/generated/WireDialogueHistoryEntry.ts"
)]
pub struct WireDialogueHistoryEntry {
    pub entry_id: WireU64,
    pub prompt_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker_id: Option<String>,
    pub speaker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WireBootstrapPayload {
    pub update: WireRuntimeUpdate,
    pub asset_ids: Vec<String>,
    pub content_version: String,
    pub story_flow_available: bool,
    #[serde(default)]
    pub chapter_map_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_font: Option<String>,
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
        Self::with_session(snapshot, WireU64::from(0), WireSessionMode::Story)
    }
}

impl WireRuntimeSnapshot {
    pub fn with_session(
        snapshot: RuntimeSnapshot,
        session_id: WireU64,
        mode: WireSessionMode,
    ) -> Self {
        Self {
            session_id,
            mode,
            revision: snapshot.revision.into(),
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
        Self::with_session(update, WireU64::from(0), WireSessionMode::Story)
    }
}

impl WireRuntimeUpdate {
    pub fn with_session(update: RuntimeUpdate, session_id: WireU64, mode: WireSessionMode) -> Self {
        Self {
            session_id: session_id.clone(),
            mode,
            update_id: update.update_id.into(),
            snapshot: WireRuntimeSnapshot::with_session(update.snapshot, session_id, mode),
            cues: update.cues,
            requires_ack: update.requires_ack,
        }
    }
}

impl From<DialogueHistoryEntry> for WireDialogueHistoryEntry {
    fn from(entry: DialogueHistoryEntry) -> Self {
        Self {
            entry_id: entry.entry_id.into(),
            prompt_id: entry.prompt_id,
            speaker_id: entry.speaker_id,
            speaker: entry.speaker,
            name_color: entry.name_color,
            text_color: entry.text_color,
            text: entry.text,
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
            chapter_map_available: payload.chapter_map_available,
            default_font: payload.default_font,
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

fn parse_u64(value: &str) -> Result<u64, ProtocolError> {
    if value.is_empty()
        || (value.starts_with('+'))
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ProtocolError::InvalidInteger(value.to_owned()));
    }
    value
        .parse::<u64>()
        .map_err(|_| ProtocolError::InvalidInteger(value.to_owned()))
}

/// Presentation cues still use the native core model internally.  Their
/// `cue_id` fields are converted to strings at the serialization boundary so
/// every occurrence (including the nested UI-motion cue variant) is safe.
fn serialize_cues<S>(cues: &[PresentationCue], serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    let mut value = serde_json::to_value(cues).map_err(serde::ser::Error::custom)?;
    stringify_id_fields(&mut value);
    value.serialize(serializer)
}

fn stringify_id_fields(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(values) => values.iter_mut().for_each(stringify_id_fields),
        serde_json::Value::Object(object) => {
            for (key, child) in object.iter_mut() {
                if key == "cue_id" {
                    if let Some(number) = child.as_u64() {
                        *child = serde_json::Value::String(number.to_string());
                    }
                } else {
                    stringify_id_fields(child);
                }
            }
        }
        _ => {}
    }
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

    #[test]
    fn u64_wire_ids_are_canonical_strings() {
        assert_eq!(WireU64::from(u64::MAX).parse(), Ok(u64::MAX));
        for value in ["+1", "01", "-1", "", "18446744073709551616"] {
            assert!(matches!(
                WireU64(value.to_owned()).parse(),
                Err(ProtocolError::InvalidInteger(_))
            ));
        }
    }
}
