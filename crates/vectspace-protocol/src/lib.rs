//! Explicit wire contracts shared by the Tauri hosts and generated TypeScript.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize, Serializer};
use thiserror::Error;
use ts_rs::TS;
use vectspace_core::model::{
    AmbienceSnapshot as CoreAmbienceSnapshot, AudioSnapshot as CoreAudioSnapshot, BootstrapPayload,
    DialogueHistoryEntry, DialoguePageSnapshot, LongTextPageSnapshot,
    LoopingAudioSnapshot as CoreLoopingAudioSnapshot, MutationValue, PlaybackSnapshot,
    PresentationCue, PromptSnapshot, RuntimeSnapshot, RuntimeUpdate, ScalarValue, StoryLocation,
    WorldSnapshot,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(
    export,
    export_to = "../../../shared/generated/WireLoopingAudioSnapshot.ts"
)]
#[serde(deny_unknown_fields)]
pub struct WireLoopingAudioSnapshot {
    pub asset: String,
    pub volume: f32,
    #[serde(default)]
    #[ts(type = "number")]
    pub start_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null", optional)]
    pub loop_start_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null", optional)]
    pub loop_end_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(
    export,
    export_to = "../../../shared/generated/WireAmbienceSnapshot.ts"
)]
#[serde(deny_unknown_fields)]
pub struct WireAmbienceSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub slot_1: Option<WireLoopingAudioSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub slot_2: Option<WireLoopingAudioSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub slot_3: Option<WireLoopingAudioSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub slot_4: Option<WireLoopingAudioSnapshot>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../shared/generated/WireAudioSnapshot.ts")]
#[serde(deny_unknown_fields)]
pub struct WireAudioSnapshot {
    pub bgm: Option<WireLoopingAudioSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub ambience: Option<WireAmbienceSnapshot>,
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
    Ambience,
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
    #[serde(serialize_with = "serialize_world_snapshot")]
    pub world: WorldSnapshot,
    pub audio: WireAudioSnapshot,
    pub playback: PlaybackSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dialogue_page: Option<DialoguePageSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_text_page: Option<LongTextPageSnapshot>,
    pub prompt: PromptSnapshot,
}

/// Button click actions can carry i64 literals.  Runtime variables already
/// use the tagged wire scalar representation, so apply the same lossless
/// encoding to the nested action values before they cross into a WebView.
fn serialize_world_snapshot<S>(world: &WorldSnapshot, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    let mut value = serde_json::to_value(world).map_err(serde::ser::Error::custom)?;
    let Some(buttons) = value
        .get_mut("buttons")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return value.serialize(serializer);
    };
    for (id, button) in &world.buttons {
        let Some(serialized_button) = buttons
            .get_mut(id)
            .and_then(serde_json::Value::as_object_mut)
        else {
            continue;
        };
        let Some(serialized_sets) = serialized_button
            .get_mut("action")
            .and_then(serde_json::Value::as_object_mut)
            .and_then(|action| action.get_mut("sets"))
            .and_then(serde_json::Value::as_array_mut)
        else {
            continue;
        };
        for (set, source) in serialized_sets.iter_mut().zip(&button.action.sets) {
            let Some(MutationValue::Literal(ScalarValue::Integer(integer))) = source.value.as_ref()
            else {
                continue;
            };
            let Some(set_object) = set.as_object_mut() else {
                continue;
            };
            set_object.insert(
                "value".to_owned(),
                serde_json::json!({
                    "kind": "integer",
                    "value": integer.to_string(),
                }),
            );
        }
    }
    value.serialize(serializer)
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

impl From<CoreLoopingAudioSnapshot> for WireLoopingAudioSnapshot {
    fn from(snapshot: CoreLoopingAudioSnapshot) -> Self {
        Self {
            asset: snapshot.asset,
            volume: snapshot.volume,
            start_ms: snapshot.start_ms,
            loop_start_ms: snapshot.loop_start_ms,
            loop_end_ms: snapshot.loop_end_ms,
        }
    }
}

impl From<CoreAmbienceSnapshot> for WireAmbienceSnapshot {
    fn from(snapshot: CoreAmbienceSnapshot) -> Self {
        Self {
            slot_1: snapshot.slot_1.map(Into::into),
            slot_2: snapshot.slot_2.map(Into::into),
            slot_3: snapshot.slot_3.map(Into::into),
            slot_4: snapshot.slot_4.map(Into::into),
        }
    }
}

impl From<CoreAudioSnapshot> for WireAudioSnapshot {
    fn from(snapshot: CoreAudioSnapshot) -> Self {
        let ambience = (!snapshot.ambience.is_empty()).then(|| snapshot.ambience.into());
        Self {
            bgm: snapshot.bgm.map(Into::into),
            ambience,
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
            audio: snapshot.audio.into(),
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
    use ts_rs::Config;
    use vectspace_core::model::{
        AmbienceSlot, AmbienceSnapshot, AudioSnapshot, ButtonAssetFit, ButtonAssetMode,
        ButtonClickAction, ButtonSetAction, ButtonSnapshot, CueGate, LoopingAudioSnapshot,
        MutationValue, PresentationCue, PresentationCueKind, VariableOperation,
    };

    #[test]
    fn export_bindings() {
        let config = Config::from_env();
        WireScalarValue::export(&config).unwrap();
        WireU64::export(&config).unwrap();
        WireSessionMode::export(&config).unwrap();
        WireAssetKind::export(&config).unwrap();
        WireAssetMetadata::export(&config).unwrap();
        WireAssetDiagnostic::export(&config).unwrap();
        WireAssetReuseCandidate::export(&config).unwrap();
        WireAssetInspection::export(&config).unwrap();
        WireInspectAssetImportsRequest::export(&config).unwrap();
        WireImportAssetRequest::export(&config).unwrap();
        WireStageAssetImportsRequest::export(&config).unwrap();
        WireImportedAsset::export(&config).unwrap();
        WireCommandError::export(&config).unwrap();
        WireCommandErrorCode::export(&config).unwrap();
        WireStoryLocation::export(&config).unwrap();
        WireDialogueHistoryEntry::export(&config).unwrap();
        WireLoopingAudioSnapshot::export(&config).unwrap();
        WireAmbienceSnapshot::export(&config).unwrap();
        WireAudioSnapshot::export(&config).unwrap();
    }

    #[test]
    fn wire_audio_empty_omits_ambience_but_keeps_null_bgm() {
        let value =
            serde_json::to_value(WireAudioSnapshot::from(AudioSnapshot::default())).unwrap();
        assert_eq!(value, serde_json::json!({"bgm": null}));
    }

    #[test]
    fn wire_audio_has_exactly_four_fixed_slots_and_isolated_conversion() {
        let source = AudioSnapshot {
            bgm: Some(LoopingAudioSnapshot {
                asset: "bgm.test".to_owned(),
                volume: 0.25,
                start_ms: 17,
                loop_start_ms: Some(100),
                loop_end_ms: Some(900),
            }),
            ambience: AmbienceSnapshot {
                slot_1: Some(LoopingAudioSnapshot {
                    asset: "ambience.one".to_owned(),
                    volume: 0.5,
                    start_ms: 12,
                    loop_start_ms: Some(200),
                    loop_end_ms: Some(800),
                }),
                slot_2: Some(LoopingAudioSnapshot {
                    asset: "ambience.two".to_owned(),
                    volume: 0.4,
                    start_ms: 0,
                    loop_start_ms: None,
                    loop_end_ms: None,
                }),
                slot_3: Some(LoopingAudioSnapshot {
                    asset: "ambience.three".to_owned(),
                    volume: 0.3,
                    start_ms: 0,
                    loop_start_ms: None,
                    loop_end_ms: None,
                }),
                slot_4: Some(LoopingAudioSnapshot {
                    asset: "ambience.four".to_owned(),
                    volume: 0.2,
                    start_ms: 0,
                    loop_start_ms: None,
                    loop_end_ms: None,
                }),
            },
        };
        let wire = WireAudioSnapshot::from(source.clone());
        let value = serde_json::to_value(&wire).unwrap();
        let slots = value["ambience"].as_object().unwrap();
        assert_eq!(
            slots.keys().collect::<Vec<_>>(),
            vec!["slot_1", "slot_2", "slot_3", "slot_4"]
        );
        assert_eq!(value["bgm"]["start_ms"], 17);
        assert_eq!(value["ambience"]["slot_1"]["loop_start_ms"], 200);
        assert_eq!(value["ambience"]["slot_2"]["start_ms"], 0);
        assert!(value["ambience"]["slot_2"].get("loop_start_ms").is_none());

        let mut changed = source;
        changed.bgm.as_mut().unwrap().asset = "bgm.changed".to_owned();
        changed.ambience.slot_1.as_mut().unwrap().asset = "ambience.changed".to_owned();
        assert_eq!(wire.bgm.as_ref().unwrap().asset, "bgm.test");
        assert_eq!(
            wire.ambience
                .as_ref()
                .unwrap()
                .slot_1
                .as_ref()
                .unwrap()
                .asset,
            "ambience.one"
        );
        assert_eq!(
            wire.ambience
                .as_ref()
                .unwrap()
                .slot_2
                .as_ref()
                .unwrap()
                .asset,
            "ambience.two"
        );
    }

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

    #[test]
    fn nested_button_integer_actions_use_lossless_wire_scalars() {
        let mut world = WorldSnapshot::default();
        world.buttons.insert(
            "large".to_owned(),
            ButtonSnapshot {
                id: "large".to_owned(),
                template: "button.large".to_owned(),
                asset_mode: ButtonAssetMode::Separate,
                fit: ButtonAssetFit::Stretch,
                normal: None,
                hover: None,
                pressed: None,
                animations: Default::default(),
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 80.0,
                rotation_deg: 0.0,
                scale_x: 1.0,
                scale_y: 1.0,
                opacity: 1.0,
                z: 0,
                visible: true,
                enabled: true,
                action: ButtonClickAction {
                    sets: vec![ButtonSetAction {
                        variable: "score".to_owned(),
                        op: VariableOperation::Assign,
                        value: Some(MutationValue::Literal(ScalarValue::Integer(i64::MAX))),
                    }],
                    next: None,
                },
            },
        );
        let wire = WireRuntimeSnapshot {
            session_id: WireU64::from(1),
            mode: WireSessionMode::Story,
            revision: WireU64::from(2),
            location: StoryLocation {
                scene_id: "scene".to_owned(),
                node_id: "node".to_owned(),
            },
            variables: BTreeMap::new(),
            world,
            audio: WireAudioSnapshot::default(),
            playback: PlaybackSnapshot::default(),
            dialogue_page: None,
            long_text_page: None,
            prompt: PromptSnapshot::None,
        };
        let value = serde_json::to_value(wire).unwrap();
        assert_eq!(
            value["world"]["buttons"]["large"]["action"]["sets"][0]["value"],
            serde_json::json!({"kind": "integer", "value": i64::MAX.to_string()}),
        );
    }

    #[test]
    fn ambience_runtime_state_and_cues_use_fixed_wire_contract() {
        let ambience_state = LoopingAudioSnapshot {
            asset: "ambience.forest".to_owned(),
            volume: 0.45,
            start_ms: 120,
            loop_start_ms: Some(400),
            loop_end_ms: Some(1800),
        };
        let mut ambience = AmbienceSnapshot::default();
        ambience.set(AmbienceSlot::Slot1, Some(ambience_state.clone()));
        let update = RuntimeUpdate {
            update_id: 3,
            snapshot: RuntimeSnapshot {
                revision: 2,
                location: StoryLocation {
                    scene_id: "scene".to_owned(),
                    node_id: "node".to_owned(),
                },
                variables: BTreeMap::new(),
                world: WorldSnapshot::default(),
                audio: AudioSnapshot {
                    bgm: None,
                    ambience,
                },
                playback: PlaybackSnapshot::default(),
                dialogue_page: None,
                long_text_page: None,
                prompt: PromptSnapshot::None,
            },
            cues: vec![PresentationCue {
                cue_id: 7,
                gate: CueGate::Runtime,
                kind: PresentationCueKind::AmbienceTransition {
                    slot: AmbienceSlot::Slot1,
                    from: None,
                    to: Some(ambience_state),
                    duration_ms: 500,
                },
            }],
            requires_ack: true,
        };
        let value = serde_json::to_value(WireRuntimeUpdate::from(update)).unwrap();
        assert_eq!(
            value["snapshot"]["audio"]["ambience"]["slot_1"]["asset"],
            "ambience.forest"
        );
        assert_eq!(value["cues"][0]["type"], "ambience_transition");
        assert_eq!(value["cues"][0]["slot"], "slot_1");
        assert_eq!(value["cues"][0]["cue_id"], "7");
    }
}
