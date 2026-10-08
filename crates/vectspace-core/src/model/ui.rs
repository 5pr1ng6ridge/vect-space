use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::default_true;
use super::timeline::TimelineChannels;
use super::variables::{MutationValue, VariableOperation};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ButtonAssetMode {
    #[default]
    Separate,
    Overlay,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ButtonAssetFit {
    Contain,
    Cover,
    #[default]
    Stretch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ButtonAnimation {
    #[serde(default = "default_button_animation_duration")]
    pub duration_ms: u64,
    #[serde(default)]
    pub channels: TimelineChannels,
}

fn default_button_animation_duration() -> u64 {
    160
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ButtonAnimations {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normal: Option<ButtonAnimation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hover: Option<ButtonAnimation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pressed: Option<ButtonAnimation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ButtonTemplate {
    pub schema_version: u32,
    pub id: String,
    #[serde(default = "default_button_width")]
    pub width: f32,
    #[serde(default = "default_button_height")]
    pub height: f32,
    #[serde(default)]
    pub asset_mode: ButtonAssetMode,
    #[serde(default)]
    pub fit: ButtonAssetFit,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hover: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pressed: Option<String>,
    #[serde(default)]
    pub animations: ButtonAnimations,
}

fn default_button_width() -> f32 {
    200.0
}

fn default_button_height() -> f32 {
    80.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ButtonSetAction {
    pub variable: String,
    #[serde(default)]
    pub op: VariableOperation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<MutationValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ButtonPostAction {
    Advance,
    Jump {
        #[serde(default)]
        scene: Option<String>,
        target: String,
    },
    OpenPanel {
        panel: ButtonPanel,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ButtonPanel {
    Saves,
    Settings,
    History,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ButtonClickAction {
    #[serde(default)]
    pub sets: Vec<ButtonSetAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<ButtonPostAction>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ButtonSnapshot {
    pub id: String,
    pub template: String,
    #[serde(default)]
    pub asset_mode: ButtonAssetMode,
    #[serde(default)]
    pub fit: ButtonAssetFit,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hover: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pressed: Option<String>,
    #[serde(default)]
    pub animations: ButtonAnimations,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    #[serde(default)]
    pub rotation_deg: f32,
    #[serde(default = "default_button_scale")]
    pub scale_x: f32,
    #[serde(default = "default_button_scale")]
    pub scale_y: f32,
    #[serde(default = "default_button_opacity")]
    pub opacity: f32,
    #[serde(default)]
    pub z: i32,
    #[serde(default = "default_true")]
    pub visible: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub action: ButtonClickAction,
}

/// Numeric button transform captured at a timeline boundary.  Keeping the
/// base separate from the full snapshot avoids copying click actions into a
/// presentation cue and gives the renderer exactly the values it evaluates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ButtonTimelineBase {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    #[serde(default)]
    pub rotation_deg: f32,
    #[serde(default = "default_button_scale")]
    pub scale_x: f32,
    #[serde(default = "default_button_scale")]
    pub scale_y: f32,
    #[serde(default = "default_button_opacity")]
    pub opacity: f32,
    #[serde(default)]
    pub z: i32,
}

fn default_button_scale() -> f32 {
    1.0
}

fn default_button_opacity() -> f32 {
    1.0
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UiMotionBindings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialogue_show: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialogue_hide: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UiMotionPreset {
    pub schema_version: u32,
    pub id: String,
    pub duration_ms: u64,
    #[serde(default)]
    pub tracks: Vec<UiMotionTrack>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UiMotionTrack {
    pub target: UiMotionTarget,
    #[serde(default)]
    pub channels: TimelineChannels,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
#[allow(clippy::enum_variant_names)]
pub enum UiMotionTarget {
    DialogueRoot,
    DialogueFrame,
    DialogueNameplate,
    DialogueText,
    DialogueAdvanceIndicator,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UiMotionSlot {
    DialogueShow,
    DialogueHide,
}
