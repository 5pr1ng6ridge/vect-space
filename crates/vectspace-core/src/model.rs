//! Stable content, runtime and persistence models shared by both desktop hosts.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use schemars::JsonSchema;
use serde::de::value::MapAccessDeserializer;
use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

pub type VariableMap = BTreeMap<String, ScalarValue>;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProfileState {
    pub variables: VariableMap,
    pub read_content_version: String,
    pub read_dialogues: BTreeSet<String>,
    #[serde(default)]
    pub seen_presentations: BTreeSet<String>,
    #[serde(default)]
    pub completed_scenes: BTreeSet<String>,
    /// Persisted storage for the active Scene's dialogue history. The runtime
    /// clears it whenever a new Scene/session becomes the owner.
    #[serde(default)]
    pub dialogue_history: Vec<DialogueHistoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DialogueHistoryEntry {
    pub entry_id: u64,
    pub prompt_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker_id: Option<String>,
    #[serde(default)]
    pub speaker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ScalarValue {
    Boolean(bool),
    Integer(i64),
    Number(f64),
    Text(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VariableScope {
    Save,
    Profile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VariableType {
    Boolean,
    Integer,
    Number,
    String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct VariableDefinition {
    pub scope: VariableScope,
    #[serde(rename = "type")]
    pub value_type: VariableType,
    pub default: ScalarValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CharacterDefinition {
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    /// Optional semantic portrait variants. A missing table preserves the
    /// legacy generic-sprite authoring path.
    #[serde(default)]
    pub expressions: BTreeMap<String, CharacterExpression>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_expression: Option<String>,
    #[serde(default = "default_character_scale")]
    pub default_scale: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CharacterExpression {
    pub asset: String,
    #[serde(default = "default_character_anchor_x")]
    pub anchor_x: f32,
    #[serde(default = "default_character_anchor_y")]
    pub anchor_y: f32,
    #[serde(default)]
    pub offset_x: f32,
    #[serde(default)]
    pub offset_y: f32,
    #[serde(default = "default_character_scale")]
    pub scale: f32,
}

fn default_character_scale() -> f32 {
    1.0
}

fn default_character_anchor_x() -> f32 {
    0.5
}

fn default_character_anchor_y() -> f32 {
    1.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ValueOperand {
    Variable(VariableOperand),
    Literal(LiteralOperand),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct VariableOperand {
    pub variable: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LiteralOperand {
    pub value: ScalarValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum MutationValue {
    Variable(VariableOperand),
    Literal(ScalarValue),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VariableOperation {
    #[default]
    Assign,
    Add,
    Sub,
    Mul,
    Mod,
    Append,
    Toggle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum ConditionExpression {
    Eq {
        left: ValueOperand,
        right: ValueOperand,
    },
    Ne {
        left: ValueOperand,
        right: ValueOperand,
    },
    Lt {
        left: ValueOperand,
        right: ValueOperand,
    },
    Le {
        left: ValueOperand,
        right: ValueOperand,
    },
    Gt {
        left: ValueOperand,
        right: ValueOperand,
    },
    Ge {
        left: ValueOperand,
        right: ValueOperand,
    },
    And {
        conditions: Vec<ConditionExpression>,
    },
    Or {
        conditions: Vec<ConditionExpression>,
    },
    Not {
        condition: Box<ConditionExpression>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ContentManifest {
    pub schema_version: u32,
    pub content_version: String,
    pub entry_scene: String,
    #[serde(default = "default_locale")]
    pub default_locale: String,
    /// Optional shared font asset used by game and editor previews.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_font: Option<String>,
    #[serde(default)]
    pub variables: BTreeMap<String, VariableDefinition>,
    #[serde(default)]
    pub characters: BTreeMap<String, CharacterDefinition>,
    pub assets: BTreeMap<String, AssetDefinition>,
    pub scenes: Vec<String>,
    #[serde(default)]
    pub ui_motions: Vec<String>,
    /// Optional reusable button template documents.  Empty keeps legacy
    /// projects fully compatible.
    #[serde(default)]
    pub buttons: Vec<String>,
    #[serde(default)]
    pub ui_motion_defaults: UiMotionBindings,
    /// Optional standalone image animation documents.  Empty keeps legacy
    /// projects fully compatible.
    #[serde(default)]
    pub animations: Vec<String>,
    /// Optional reusable single-sprite action documents.  Empty preserves
    /// existing projects and keeps the action system opt-in.
    #[serde(default)]
    pub actions: Vec<String>,
    /// Optional author-authored room map used as the chapter selector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chapter_map: Option<String>,
}

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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ButtonState {
    #[default]
    Normal,
    Hover,
    Pressed,
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

/// A room-sized chapter selector.  Coordinates are design pixels and are
/// deliberately kept independent from the story graph so authors can compose
/// a spatial map without changing story control flow.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChapterMapDefinition {
    pub schema_version: u32,
    #[serde(default = "default_chapter_map_width")]
    pub width: u32,
    #[serde(default = "default_chapter_map_height")]
    pub height: u32,
    #[serde(default = "default_chapter_map_view_x")]
    pub view_x: i32,
    #[serde(default = "default_chapter_map_view_y")]
    pub view_y: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(default)]
    pub decorations: Vec<ChapterMapDecoration>,
    #[serde(default)]
    pub hotspots: Vec<ChapterMapHotspot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChapterMapDecoration {
    pub id: String,
    pub asset: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub z: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChapterMapHotspot {
    pub id: String,
    pub scene_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hover_text: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub z: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<String>,
    #[serde(default)]
    pub reveal: ChapterMapReveal,
    /// Replay policy for this chapter.  Kept separate from `reveal` on
    /// purpose: visibility and enterability are different questions, so a
    /// hotspot may be shown but locked (default) or shown and enterable.
    #[serde(default)]
    pub replay: ChapterMapReplay,
    #[serde(default)]
    pub variable_overrides: VariableMap,
}

fn default_chapter_map_width() -> u32 {
    1920
}

fn default_chapter_map_height() -> u32 {
    1080
}

fn default_chapter_map_view_x() -> i32 {
    960
}

fn default_chapter_map_view_y() -> i32 {
    540
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChapterMapSnapshot {
    pub width: u32,
    pub height: u32,
    pub view_x: i32,
    pub view_y: i32,
    pub background: Option<String>,
    pub decorations: Vec<ChapterMapDecorationSnapshot>,
    pub hotspots: Vec<ChapterMapHotspotSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChapterMapDecorationSnapshot {
    pub id: String,
    pub asset: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub z: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChapterMapHotspotSnapshot {
    pub id: String,
    pub scene_id: String,
    pub title: String,
    pub hover_text: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub z: i32,
    pub asset: Option<String>,
    pub completed: bool,
    /// True when the hotspot may be entered right now.
    ///
    /// The room page must not report a hotspot as unreached while the author
    /// configured it as always replayable, so the resolved policy is sent to
    /// the WebView instead of letting it re-derive the rule.
    pub replayable: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChapterMapReveal {
    #[default]
    Completed,
    Always,
    Condition {
        condition: ConditionExpression,
    },
}

/// When the chapter may be entered from the room map.
///
/// `completed` is the historical behaviour: a chapter becomes replayable only
/// after the player finished it once.  `always` opens the hotspot before the
/// story ever reaches it, which is what makes an unreached chapter (a
/// showcase, an appendix, a debugging scene) enterable on purpose.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChapterMapReplay {
    #[default]
    Completed,
    Always,
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

fn default_locale() -> String {
    "zh-CN".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AssetDefinition {
    pub kind: AssetKind,
    /// Static image path.  Mutually exclusive with `animation`; exactly one of
    /// the two describes the pixels this logical asset resolves to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Loop animation document id.  The asset keeps its `kind`, so every
    /// existing image position accepts an animated asset without a new field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animation: Option<String>,
}

/// Schema version of a standalone image animation document.
pub const IMAGE_ANIMATION_SCHEMA_VERSION: u32 = 1;
/// Upper bound on the ordered frame list of one animation.
pub const IMAGE_ANIMATION_MAX_FRAMES: usize = 512;
/// A frame must be visible for at least one millisecond.
pub const IMAGE_ANIMATION_MIN_FRAME_MS: u64 = 1;
/// Longest allowed single frame duration.  Anything slower is an authoring
/// mistake rather than a loop.
pub const IMAGE_ANIMATION_MAX_FRAME_MS: u64 = 60_000;
/// Decoded RGBA budget for the unique frames of one animation.
pub const IMAGE_ANIMATION_MAX_DECODED_BYTES: u64 = 256 * 1024 * 1024;
/// Longest allowed edge of one animation frame, in pixels.
pub const IMAGE_ANIMATION_MAX_EDGE: u32 = 8192;

/// Standalone `image animation` document (Schema v1).
///
/// The plan deliberately keeps animation out of the asset *kind* namespace:
/// an asset says what it is used for (background, sprite, GUI) and separately
/// says whether its pixels are one static image or an ordered frame sequence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ImageAnimationDefinition {
    pub schema_version: u32,
    pub id: String,
    /// Frames play in list order and loop forever.  A ping-pong animation is
    /// authored by repeating frames rather than by a direction flag.
    #[serde(default)]
    pub frames: Vec<ImageAnimationFrame>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ImageAnimationFrame {
    /// Static image asset id.  Animation frames may not reference another
    /// animation, so the frame graph is always one level deep.
    pub asset: String,
    pub duration_ms: u64,
}

/// Schema version of a reusable sprite action document.
pub const SPRITE_ACTION_SCHEMA_VERSION: u32 = 1;

/// A reusable, single-sprite transform animation.  Position and rotation
/// values are offsets from the instance's starting pose; scale and opacity
/// values are multipliers.  The runtime expands these relative keyframes into
/// an ordinary absolute Timeline cue, so the presentation layer stays small.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpriteActionDefinition {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub duration_ms: u64,
    #[serde(default)]
    pub channels: BTreeMap<String, Vec<SpriteActionKeyframe>>,
    #[serde(default)]
    pub parameters: BTreeMap<String, SpriteActionParameter>,
    #[serde(default)]
    pub end: SpriteActionEnd,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpriteActionKeyframe {
    pub at_ms: u64,
    pub value: f32,
    #[serde(default)]
    pub easing: TimelineEasing,
    /// Optional named parameter. When present, `value` is the fallback
    /// default and the action invocation may override it safely.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameter: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpriteActionParameter {
    pub default: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpriteActionEnd {
    #[default]
    Hold,
    Restore,
}

/// Stable identity for diagnostics and reference statistics.
impl ImageAnimationDefinition {
    pub fn frame_assets(&self) -> BTreeSet<&str> {
        self.frames
            .iter()
            .map(|frame| frame.asset.as_str())
            .collect()
    }

    pub fn total_duration_ms(&self) -> u64 {
        self.frames.iter().fold(0_u64, |total, frame| {
            total.saturating_add(frame.duration_ms)
        })
    }

    pub fn unique_frame_assets(&self) -> BTreeSet<String> {
        self.frames
            .iter()
            .map(|frame| frame.asset.clone())
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    Background,
    Sprite,
    Gui,
    Bgm,
    Ambience,
    Sfx,
    Font,
    Video,
}

/// Fixed ambience channel identity shared by authored nodes, snapshots and
/// timeline tracks. Explicit serde names are required because
/// `rename_all = "snake_case"` would serialize `Slot1` as `slot1`, not the
/// contract's `slot_1`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum AmbienceSlot {
    #[serde(rename = "slot_1")]
    Slot1,
    #[serde(rename = "slot_2")]
    Slot2,
    #[serde(rename = "slot_3")]
    Slot3,
    #[serde(rename = "slot_4")]
    Slot4,
}

impl AmbienceSlot {
    pub const ALL: [Self; 4] = [Self::Slot1, Self::Slot2, Self::Slot3, Self::Slot4];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Slot1 => "slot_1",
            Self::Slot2 => "slot_2",
            Self::Slot3 => "slot_3",
            Self::Slot4 => "slot_4",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AmbienceSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_1: Option<LoopingAudioSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_2: Option<LoopingAudioSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_3: Option<LoopingAudioSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_4: Option<LoopingAudioSnapshot>,
}

impl AmbienceSnapshot {
    pub const fn is_empty(&self) -> bool {
        self.slot_1.is_none()
            && self.slot_2.is_none()
            && self.slot_3.is_none()
            && self.slot_4.is_none()
    }

    pub fn get(&self, slot: AmbienceSlot) -> Option<&LoopingAudioSnapshot> {
        match slot {
            AmbienceSlot::Slot1 => self.slot_1.as_ref(),
            AmbienceSlot::Slot2 => self.slot_2.as_ref(),
            AmbienceSlot::Slot3 => self.slot_3.as_ref(),
            AmbienceSlot::Slot4 => self.slot_4.as_ref(),
        }
    }

    pub fn get_mut(&mut self, slot: AmbienceSlot) -> Option<&mut LoopingAudioSnapshot> {
        match slot {
            AmbienceSlot::Slot1 => self.slot_1.as_mut(),
            AmbienceSlot::Slot2 => self.slot_2.as_mut(),
            AmbienceSlot::Slot3 => self.slot_3.as_mut(),
            AmbienceSlot::Slot4 => self.slot_4.as_mut(),
        }
    }

    pub fn set(&mut self, slot: AmbienceSlot, state: Option<LoopingAudioSnapshot>) {
        match slot {
            AmbienceSlot::Slot1 => self.slot_1 = state,
            AmbienceSlot::Slot2 => self.slot_2 = state,
            AmbienceSlot::Slot3 => self.slot_3 = state,
            AmbienceSlot::Slot4 => self.slot_4 = state,
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (AmbienceSlot, &LoopingAudioSnapshot)> {
        AmbienceSlot::ALL
            .into_iter()
            .filter_map(|slot| self.get(slot).map(|state| (slot, state)))
    }

    pub fn iter_mut(&mut self) -> impl Iterator<Item = (AmbienceSlot, &mut LoopingAudioSnapshot)> {
        // A fixed array of mutable optional references avoids exposing the
        // representation as a map while still making validation exhaustive.
        let slots = [
            (AmbienceSlot::Slot1, &mut self.slot_1),
            (AmbienceSlot::Slot2, &mut self.slot_2),
            (AmbienceSlot::Slot3, &mut self.slot_3),
            (AmbienceSlot::Slot4, &mut self.slot_4),
        ];
        slots
            .into_iter()
            .filter_map(|(slot, state)| state.as_mut().map(|state| (slot, state)))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SceneDefinition {
    pub schema_version: u32,
    pub id: String,
    pub entry: String,
    pub nodes: BTreeMap<String, SceneNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum SceneNode {
    Background {
        background: Option<String>,
        #[serde(default)]
        #[schemars(with = "BackgroundTransitionSchema")]
        transition: BackgroundTransitionSpec,
        #[serde(default = "default_medium_duration")]
        duration_ms: u64,
        #[serde(default)]
        easing: Easing,
        #[serde(default, rename = "await")]
        await_completion: bool,
        next: String,
    },
    Sprite {
        sprite_id: String,
        action: SpriteAction,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        asset: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        character: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expression: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        flip_x: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        crossfade_ms: Option<u64>,
        x: Option<f32>,
        y: Option<f32>,
        scale: Option<f32>,
        opacity: Option<f32>,
        z: Option<i32>,
        #[serde(default = "default_medium_duration")]
        duration_ms: u64,
        #[serde(default)]
        easing: Easing,
        #[serde(default, rename = "await")]
        await_completion: bool,
        next: String,
    },
    /// Fade the current scene's visual world to an empty state. Audio and the
    /// dialogue UI are deliberately left alone so a scene transition can keep
    /// its BGM and common UI chrome.
    Clear {
        #[serde(default = "default_medium_duration")]
        duration_ms: u64,
        #[serde(default)]
        easing: Easing,
        #[serde(default = "default_clear_await", rename = "await")]
        await_completion: bool,
        next: String,
    },
    Say {
        speaker: Option<String>,
        text: String,
        #[serde(default)]
        mode: DialogueMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        page_id: Option<String>,
        #[serde(default)]
        speed_cps: Option<f32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reveal_animation: Option<TextRevealAnimation>,
        next: String,
    },
    /// A sequence of explanatory text blocks rendered on a vertically flowing
    /// paper surface. Unlike `say`, the runtime stays on this node until its
    /// final step has been advanced, so every step is revision-safe and can be
    /// saved independently.
    LongText {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        document: Option<String>,
        #[serde(default, skip_serializing_if = "LongTextMode::is_start")]
        mode: LongTextMode,
        #[serde(default, skip_serializing_if = "LongTextExit::is_close")]
        on_exit: LongTextExit,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        paper: Option<String>,
        /// Presentation fields are optional in the content model so a
        /// continuation can inherit the values declared by its start node.
        /// Runtime snapshots always contain the resolved concrete values.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pagination: Option<LongTextPagination>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        font_size: Option<f32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text_color: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        layout: Option<LongTextLayout>,
        steps: Vec<LongTextStep>,
        #[serde(default)]
        speed_cps: Option<f32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reveal_animation: Option<TextRevealAnimation>,
        next: String,
    },
    LongTextControl {
        document: String,
        action: LongTextControlAction,
        next: String,
    },
    Choice {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        presentation: Option<ChoicePresentation>,
        choices: Vec<ChoiceDefinition>,
    },
    Set {
        variable: String,
        #[serde(default)]
        op: VariableOperation,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<MutationValue>,
        next: String,
    },
    Condition {
        condition: ConditionExpression,
        then: String,
        otherwise: String,
    },
    Playback {
        auto: PlaybackAutoMode,
        ctrl_fast_forward: CtrlFastForwardMode,
        next: String,
    },
    /// Invoke a reusable relative transform action on an existing sprite.
    /// The action document is resolved by the runtime against the instance's
    /// current pose, then emitted as an ordinary Timeline cue.
    Action {
        sprite_id: String,
        action: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, rename = "await")]
        await_completion: bool,
        #[serde(default)]
        parameters: BTreeMap<String, f32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        end: Option<SpriteActionEnd>,
        next: String,
    },
    Jump {
        #[serde(default)]
        scene: Option<String>,
        target: String,
    },
    /// Ask the desktop host to show another Scene in the single secondary game
    /// window.  The node is deliberately non-blocking: the engine advances to
    /// `next` in the same update and only emits a window cue.  The host consumes
    /// that cue for the committed runtime the cue belongs to — the main story,
    /// or the chapter-map replay that is driving it — while the secondary engine
    /// itself can never open or re-point a window.
    OpenWindow {
        scene: String,
        next: String,
    },
    Wait {
        duration_ms: u64,
        next: String,
    },
    Bgm {
        action: AudioAction,
        asset: Option<String>,
        #[serde(default = "default_volume")]
        volume: f32,
        #[serde(default)]
        start_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        loop_start_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        loop_end_ms: Option<u64>,
        #[serde(default = "default_medium_duration")]
        duration_ms: u64,
        #[serde(default, rename = "await")]
        await_completion: bool,
        next: String,
    },
    /// Start or stop one of the four independent ambience channels.
    ///
    /// Ambience deliberately mirrors the BGM node's loop parameters so the
    /// runtime can describe one canonical looping state to every host. The
    /// slot is fixed rather than an arbitrary string, which keeps authored
    /// content and the wire protocol exhaustive.
    Ambience {
        slot: AmbienceSlot,
        action: AudioAction,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        asset: Option<String>,
        #[serde(default = "default_ambience_volume")]
        volume: f32,
        #[serde(default)]
        start_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        loop_start_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        loop_end_ms: Option<u64>,
        #[serde(default = "default_medium_duration")]
        duration_ms: u64,
        #[serde(default, rename = "await")]
        await_completion: bool,
        next: String,
    },
    Timeline {
        duration_ms: u64,
        #[serde(rename = "await")]
        await_completion: bool,
        skippable: bool,
        #[serde(default)]
        tracks: Vec<TimelineTrack>,
        #[serde(default)]
        events: Vec<TimelineEvent>,
        next: String,
    },
    Sfx {
        asset: String,
        #[serde(default = "default_volume")]
        volume: f32,
        next: String,
    },
    Camera {
        x: f32,
        y: f32,
        zoom: f32,
        #[serde(default = "default_medium_duration")]
        duration_ms: u64,
        #[serde(default)]
        easing: Easing,
        #[serde(default, rename = "await")]
        await_completion: bool,
        next: String,
    },
    ScreenEffect {
        #[schemars(with = "ScreenEffectSchema")]
        effect: ScreenEffectSpec,
        #[serde(default = "default_short_duration")]
        duration_ms: u64,
        #[serde(default, rename = "await")]
        await_completion: bool,
        next: String,
    },
    /// A persistent curtain layer drawn above the world and below screen
    /// effects.  `cover` requires a fill; `reveal` closes the current curtain.
    /// Only the stable cover/fill land in the snapshot, the transition
    /// parameters travel exclusively in the emitted cue.
    Curtain {
        action: CurtainAction,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fill: Option<CurtainFill>,
        transition: CurtainTransitionSpec,
        #[serde(default = "default_medium_duration")]
        duration_ms: u64,
        #[serde(default)]
        easing: Easing,
        #[serde(default, rename = "await")]
        await_completion: bool,
        next: String,
    },
    DialogueUi {
        visible: bool,
        #[serde(default)]
        motion: Option<String>,
        #[serde(default)]
        duration_ms: Option<u64>,
        #[serde(default, rename = "await")]
        await_completion: bool,
        next: String,
    },
    UiMotionSet {
        slot: UiMotionSlot,
        motion: Option<String>,
        next: String,
    },
    UiMotionPlay {
        motion: String,
        #[serde(default)]
        duration_ms: Option<u64>,
        #[serde(default, rename = "await")]
        await_completion: bool,
        next: String,
    },
    ButtonCreate {
        instance_id: String,
        template: String,
        #[serde(default)]
        x: Option<f32>,
        #[serde(default)]
        y: Option<f32>,
        #[serde(default)]
        width: Option<f32>,
        #[serde(default)]
        height: Option<f32>,
        #[serde(default)]
        rotation_deg: Option<f32>,
        #[serde(default)]
        scale_x: Option<f32>,
        #[serde(default)]
        scale_y: Option<f32>,
        #[serde(default)]
        opacity: Option<f32>,
        #[serde(default)]
        z: Option<i32>,
        #[serde(default = "default_true")]
        visible: bool,
        #[serde(default = "default_true")]
        enabled: bool,
        #[serde(default)]
        action: ButtonClickAction,
        next: String,
    },
    ButtonUpdate {
        instance_id: String,
        #[serde(default)]
        template: Option<String>,
        #[serde(default)]
        x: Option<f32>,
        #[serde(default)]
        y: Option<f32>,
        #[serde(default)]
        width: Option<f32>,
        #[serde(default)]
        height: Option<f32>,
        #[serde(default)]
        rotation_deg: Option<f32>,
        #[serde(default)]
        scale_x: Option<f32>,
        #[serde(default)]
        scale_y: Option<f32>,
        #[serde(default)]
        opacity: Option<f32>,
        #[serde(default)]
        z: Option<i32>,
        #[serde(default)]
        visible: Option<bool>,
        #[serde(default)]
        enabled: Option<bool>,
        #[serde(default)]
        action: Option<ButtonClickAction>,
        next: String,
    },
    ButtonRemove {
        instance_id: String,
        next: String,
    },
    End,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DialogueMode {
    #[default]
    Start,
    Append,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LongTextMode {
    #[default]
    Start,
    Continue,
}

impl LongTextMode {
    fn is_start(value: &Self) -> bool {
        *value == Self::Start
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LongTextExit {
    #[default]
    Close,
    Hide,
    KeepVisible,
}

impl LongTextExit {
    fn is_close(value: &Self) -> bool {
        *value == Self::Close
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LongTextControlAction {
    Show,
    Hide,
    Close,
}

/// Player-selectable reveal styles. A story node may optionally override the
/// current player setting for a specific prompt.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TextRevealAnimation {
    LineSweep,
    #[default]
    Typewriter,
    DropFade,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LongTextPagination {
    Continuous,
    #[default]
    Auto,
    Manual,
}

pub const LONG_TEXT_FONT_SIZE_DEFAULT: f32 = 32.0;
pub const LONG_TEXT_FONT_SIZE_MIN: f32 = 16.0;
pub const LONG_TEXT_FONT_SIZE_MAX: f32 = 72.0;
pub const LONG_TEXT_COLOR_DEFAULT: &str = "#212533";
pub const LONG_TEXT_LAYOUT_X_DEFAULT: f32 = 340.0;
pub const LONG_TEXT_LAYOUT_Y_DEFAULT: f32 = 0.0;
pub const LONG_TEXT_LAYOUT_WIDTH_DEFAULT: f32 = 1240.0;
pub const LONG_TEXT_LAYOUT_HEIGHT_DEFAULT: f32 = 1080.0;
pub const LONG_TEXT_LAYOUT_PADDING_X_DEFAULT: f32 = 118.0;
pub const LONG_TEXT_LAYOUT_PADDING_Y_DEFAULT: f32 = 112.0;
pub const LONG_TEXT_LAYOUT_PAGE_HEIGHT_DEFAULT: f32 = 1340.0;
pub const LONG_TEXT_LAYOUT_PAGE_GAP_DEFAULT: f32 = 92.0;

fn default_long_text_font_size() -> f32 {
    LONG_TEXT_FONT_SIZE_DEFAULT
}

fn default_long_text_color() -> String {
    LONG_TEXT_COLOR_DEFAULT.to_owned()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LongTextLayout {
    #[serde(default = "default_long_text_layout_x")]
    pub x: f32,
    #[serde(default = "default_long_text_layout_y")]
    pub y: f32,
    #[serde(default = "default_long_text_layout_width")]
    pub width: f32,
    #[serde(default = "default_long_text_layout_height")]
    pub height: f32,
    #[serde(default = "default_long_text_layout_padding_x")]
    pub padding_x: f32,
    #[serde(default = "default_long_text_layout_padding_y")]
    pub padding_y: f32,
    #[serde(default = "default_long_text_layout_page_height")]
    pub page_height: f32,
    #[serde(default = "default_long_text_layout_page_gap")]
    pub page_gap: f32,
}

impl Default for LongTextLayout {
    fn default() -> Self {
        Self {
            x: LONG_TEXT_LAYOUT_X_DEFAULT,
            y: LONG_TEXT_LAYOUT_Y_DEFAULT,
            width: LONG_TEXT_LAYOUT_WIDTH_DEFAULT,
            height: LONG_TEXT_LAYOUT_HEIGHT_DEFAULT,
            padding_x: LONG_TEXT_LAYOUT_PADDING_X_DEFAULT,
            padding_y: LONG_TEXT_LAYOUT_PADDING_Y_DEFAULT,
            page_height: LONG_TEXT_LAYOUT_PAGE_HEIGHT_DEFAULT,
            page_gap: LONG_TEXT_LAYOUT_PAGE_GAP_DEFAULT,
        }
    }
}

fn default_long_text_layout_x() -> f32 {
    LONG_TEXT_LAYOUT_X_DEFAULT
}
fn default_long_text_layout_y() -> f32 {
    LONG_TEXT_LAYOUT_Y_DEFAULT
}
fn default_long_text_layout_width() -> f32 {
    LONG_TEXT_LAYOUT_WIDTH_DEFAULT
}
fn default_long_text_layout_height() -> f32 {
    LONG_TEXT_LAYOUT_HEIGHT_DEFAULT
}
fn default_long_text_layout_padding_x() -> f32 {
    LONG_TEXT_LAYOUT_PADDING_X_DEFAULT
}
fn default_long_text_layout_padding_y() -> f32 {
    LONG_TEXT_LAYOUT_PADDING_Y_DEFAULT
}
fn default_long_text_layout_page_height() -> f32 {
    LONG_TEXT_LAYOUT_PAGE_HEIGHT_DEFAULT
}
fn default_long_text_layout_page_gap() -> f32 {
    LONG_TEXT_LAYOUT_PAGE_GAP_DEFAULT
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LongTextStep {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub page_break_before: bool,
}

fn default_short_duration() -> u64 {
    200
}

fn default_medium_duration() -> u64 {
    500
}

fn default_clear_await() -> bool {
    true
}

fn default_volume() -> f32 {
    1.0
}

/// Player-facing default for authored ambience nodes and the corresponding
/// settings control. BGM/SFX defaults remain unchanged.
pub const AMBIENCE_VOLUME_DEFAULT: f32 = 0.8;

fn default_ambience_volume() -> f32 {
    AMBIENCE_VOLUME_DEFAULT
}

/// Fixed 1920x1080 design space every resolved choice layout is expressed in.
/// Hosts scale the stage, they never re-flow the buttons themselves.
pub const CHOICE_STAGE_WIDTH: f32 = 1920.0;
pub const CHOICE_STAGE_HEIGHT: f32 = 1080.0;

/// Documented built-in fallback for a choice button that resolves to no
/// reusable template.  The dimensions mirror the shipped CSS choice panel
/// (full 980px panel width, 92px button min-height, 20px gap), so a legacy
/// authoring path and a template-less node render the same layout.
pub const CHOICE_FALLBACK_BUTTON_WIDTH: f32 = 980.0;
pub const CHOICE_FALLBACK_BUTTON_HEIGHT: f32 = 92.0;
/// Shipped CSS choice panel origin (`src/App.css`: `left: 470px; top: 360px`).
///
/// A node without `presentation` keeps exactly this top-left placement for
/// every option count, so existing content does not need a migration; the
/// resolved layout reports the equivalent group-centre anchor instead.
pub const CHOICE_FALLBACK_PANEL_X: f32 = 470.0;
pub const CHOICE_FALLBACK_PANEL_Y: f32 = 360.0;
/// Default centre of an explicitly presented group, in design pixels.
/// `960` is the horizontal centre of the 1920px stage and `540` the vertical
/// centre of the 1080px stage, so an opted-in node is centred by default.
pub const CHOICE_DEFAULT_ANCHOR_X: f32 = 960.0;
pub const CHOICE_DEFAULT_ANCHOR_Y: f32 = 540.0;
pub const CHOICE_DEFAULT_GAP: f32 = 20.0;

/// Direction of the resolved choice button flow around the anchor.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChoiceFlowDirection {
    #[default]
    Vertical,
    Horizontal,
}

/// Optional template-driven presentation for a `choice` node.
///
/// Every field has a documented default, so a node may opt in with only the
/// parts it wants to change.  Template and icon references are resolved by
/// the runtime, not the loader: a missing or wrong-kind reference becomes a
/// structured [`ChoiceDiagnostic`] on the snapshot and the item falls back to
/// the node template or to the built-in CSS button instead of locking the
/// story.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChoicePresentation {
    /// Reusable button template id (see [`ButtonTemplate`]).  Used by every
    /// visible option that does not name its own template.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// Horizontal centre of the resolved button group in design pixels.
    /// Valid range: `0..=1920` (see [`CHOICE_STAGE_WIDTH`]).
    #[serde(default = "default_choice_anchor_x")]
    pub anchor_x: f32,
    /// Vertical centre of the resolved button group in design pixels.
    /// Valid range: `0..=1080` (see [`CHOICE_STAGE_HEIGHT`]).
    #[serde(default = "default_choice_anchor_y")]
    pub anchor_y: f32,
    #[serde(default)]
    pub direction: ChoiceFlowDirection,
    #[serde(default = "default_choice_gap")]
    pub gap: f32,
    /// Node-wide width/height override for every resolved button.  When a
    /// side is omitted the resolved template's own dimension is used, or the
    /// built-in fallback when no template resolves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button_width: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button_height: Option<f32>,
}

fn default_choice_anchor_x() -> f32 {
    CHOICE_DEFAULT_ANCHOR_X
}

fn default_choice_anchor_y() -> f32 {
    CHOICE_DEFAULT_ANCHOR_Y
}

fn default_choice_gap() -> f32 {
    CHOICE_DEFAULT_GAP
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChoiceDefinition {
    pub id: String,
    pub label: String,
    pub next: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_if: Option<ConditionExpression>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled_if: Option<ConditionExpression>,
    /// Optional per-option template that wins over the node's default
    /// template before the built-in CSS fallback is used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// Optional `gui` asset id shown alongside the option label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpriteAction {
    Show,
    Move,
    Hide,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AudioAction {
    Start,
    Stop,
}

/// Canonical background transition.
///
/// Legacy one-word transitions keep working: the loader accepts
/// `transition: cut` / `transition: cross_fade` and normalises them into this
/// shape, so cues, hosts and generated schemas only ever observe the canonical
/// form and never need a compatibility branch.
#[derive(Debug, Clone, Default, PartialEq, Serialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum BackgroundTransitionSpec {
    Cut,
    #[default]
    CrossFade,
    FadeThroughColor {
        /// `#RRGGBB` or `#RRGGBBAA`.
        color: String,
    },
    Wipe {
        direction: TransitionDirection,
        #[serde(default = "default_transition_softness")]
        softness: f32,
    },
    Push {
        direction: TransitionDirection,
        #[serde(default = "default_transition_softness")]
        softness: f32,
    },
}

/// Object-only mirror used by the custom deserializer.
///
/// Keeping a mirror means an invalid object reports serde's precise message
/// ("missing field `direction`", "unknown variant `foo`") instead of the
/// opaque one an `untagged` enum would produce, while the public type stays the
/// single canonical shape.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum BackgroundTransitionObject {
    Cut,
    CrossFade,
    FadeThroughColor {
        color: String,
    },
    Wipe {
        direction: TransitionDirection,
        #[serde(default = "default_transition_softness")]
        softness: f32,
    },
    Push {
        direction: TransitionDirection,
        #[serde(default = "default_transition_softness")]
        softness: f32,
    },
}

impl BackgroundTransitionObject {
    fn into_spec(self) -> BackgroundTransitionSpec {
        match self {
            Self::Cut => BackgroundTransitionSpec::Cut,
            Self::CrossFade => BackgroundTransitionSpec::CrossFade,
            Self::FadeThroughColor { color } => {
                BackgroundTransitionSpec::FadeThroughColor { color }
            }
            Self::Wipe {
                direction,
                softness,
            } => BackgroundTransitionSpec::Wipe {
                direction,
                softness,
            },
            Self::Push {
                direction,
                softness,
            } => BackgroundTransitionSpec::Push {
                direction,
                softness,
            },
        }
    }
}

struct BackgroundTransitionVisitor;

impl<'de> Visitor<'de> for BackgroundTransitionVisitor {
    type Value = BackgroundTransitionSpec;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(
            "a background transition name (`cut` or `cross_fade`) or a `{ type, ... }` object",
        )
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        match value {
            "cut" => Ok(BackgroundTransitionSpec::Cut),
            "cross_fade" => Ok(BackgroundTransitionSpec::CrossFade),
            other => Err(E::unknown_variant(other, &["cut", "cross_fade"])),
        }
    }

    fn visit_map<A>(self, map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        BackgroundTransitionObject::deserialize(MapAccessDeserializer::new(map))
            .map(BackgroundTransitionObject::into_spec)
    }
}

impl<'de> Deserialize<'de> for BackgroundTransitionSpec {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(BackgroundTransitionVisitor)
    }
}

/// Schema-only view used on fields so the generated JSON Schema accepts both
/// the already-authored one-word form and the canonical object.
#[allow(dead_code)]
#[derive(JsonSchema)]
#[serde(untagged)]
enum BackgroundTransitionSchema {
    Legacy(LegacyBackgroundTransitionName),
    Canonical(BackgroundTransitionSpec),
}

#[allow(dead_code)]
#[derive(JsonSchema)]
#[serde(rename_all = "snake_case")]
enum LegacyBackgroundTransitionName {
    Cut,
    CrossFade,
}

/// One of the four edge directions shared by `wipe` and `push` transitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TransitionDirection {
    LeftToRight,
    RightToLeft,
    TopToBottom,
    BottomToTop,
}

/// Normalised fraction of the screen used to feather a `wipe`/`push` edge.
pub const TRANSITION_SOFTNESS_DEFAULT: f32 = 0.0;
pub const TRANSITION_SOFTNESS_MAX: f32 = 1.0;

fn default_transition_softness() -> f32 {
    TRANSITION_SOFTNESS_DEFAULT
}

/// Presentation action of a persistent curtain layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CurtainAction {
    Cover,
    Reveal,
}

/// Fill of a curtain: either a solid colour or a `gui` asset.
///
/// The custom deserializer rejects an object that names both fills (ambiguous)
/// or neither, instead of silently accepting the first untagged variant.  The
/// schema mirrors that rule through `deny_unknown_fields`, so a schema-only
/// validator rejects `{color, asset}` exactly like the loader does.
#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema)]
#[serde(untagged)]
#[schemars(deny_unknown_fields)]
pub enum CurtainFill {
    Color { color: String },
    Asset { asset: String },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CurtainFillObject {
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    asset: Option<String>,
}

impl<'de> Deserialize<'de> for CurtainFill {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let object = CurtainFillObject::deserialize(deserializer)?;
        match (object.color, object.asset) {
            (Some(color), None) => Ok(Self::Color { color }),
            (None, Some(asset)) => Ok(Self::Asset { asset }),
            (Some(_), Some(_)) => Err(de::Error::custom(
                "curtain fill 只能指定 color 或 asset 之一",
            )),
            (None, None) => Err(de::Error::custom("curtain fill 必须指定 color 或 asset")),
        }
    }
}

/// Open/close animation of a curtain.  These parameters only ever travel in a
/// presentation cue; the saved curtain state stores the stable cover/fill.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum CurtainTransitionSpec {
    Fade,
    Wipe { direction: TransitionDirection },
    SplitHorizontal,
    SplitVertical,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Easing {
    Linear,
    EaseIn,
    EaseOut,
    #[default]
    EaseInOut,
}

/// Canonical, parameterised screen effect shared by `screen_effect` nodes and
/// timeline events.  Legacy one-word effects (`effect: flash` / `effect: shake`)
/// are normalised into this shape with the shipped defaults.
pub const FLASH_COLOR_DEFAULT: &str = "#FFFFFF";
pub const FLASH_PEAK_ALPHA_DEFAULT: f32 = 0.88;
pub const FLASH_PEAK_ALPHA_MIN: f32 = 0.0;
pub const FLASH_PEAK_ALPHA_MAX: f32 = 1.0;
/// Peak horizontal amplitude in design pixels of the shipped shake.
pub const SHAKE_AMPLITUDE_X_DEFAULT: f32 = 16.0;
/// Peak vertical amplitude of the shipped shake (`0.6 * x`).
pub const SHAKE_AMPLITUDE_Y_DEFAULT: f32 = 9.6;
pub const SHAKE_AMPLITUDE_MAX: f32 = 256.0;
pub const SHAKE_FREQUENCY_HZ_DEFAULT: f32 = 18.0;
pub const SHAKE_FREQUENCY_HZ_MIN: f32 = 0.1;
pub const SHAKE_FREQUENCY_HZ_MAX: f32 = 60.0;
/// `1.0` reproduces the shipped linear fade-out; `0.0` never decays.
pub const SHAKE_DECAY_DEFAULT: f32 = 1.0;
pub const SHAKE_DECAY_MIN: f32 = 0.0;
pub const SHAKE_DECAY_MAX: f32 = 1.0;
/// Stable seed carried by the spec.  The evaluator converts it into a stable
/// per-axis phase offset, so an old `effect: shake` (normalised to `0`) stays a
/// valid deterministic seed instead of inventing randomness.
///
/// The seed crosses the WebView IPC boundary as a JSON number, so it stays well
/// inside the JavaScript safe integer range (`<= 2^53 - 1`); `u32` keeps that
/// guarantee in the type and in the generated schema.
pub const SHAKE_SEED_DEFAULT: u32 = 0;
pub const SHAKE_SEED_MAX: u32 = u32::MAX;

#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScreenEffectSpec {
    Flash {
        #[serde(default = "default_flash_color")]
        color: String,
        #[serde(default = "default_flash_peak_alpha")]
        peak_alpha: f32,
    },
    Shake {
        #[serde(default = "default_shake_amplitude_x")]
        amplitude_x: f32,
        #[serde(default = "default_shake_amplitude_y")]
        amplitude_y: f32,
        #[serde(default = "default_shake_frequency_hz")]
        frequency_hz: f32,
        #[serde(default = "default_shake_decay")]
        decay: f32,
        #[serde(default = "default_shake_seed")]
        seed: u32,
    },
}

impl ScreenEffectSpec {
    /// The shipped flash, used when content only wrote `effect: flash`.
    pub fn legacy_flash() -> Self {
        Self::Flash {
            color: FLASH_COLOR_DEFAULT.to_owned(),
            peak_alpha: FLASH_PEAK_ALPHA_DEFAULT,
        }
    }

    /// The shipped shake, used when content only wrote `effect: shake`.
    pub fn legacy_shake() -> Self {
        Self::Shake {
            amplitude_x: SHAKE_AMPLITUDE_X_DEFAULT,
            amplitude_y: SHAKE_AMPLITUDE_Y_DEFAULT,
            frequency_hz: SHAKE_FREQUENCY_HZ_DEFAULT,
            decay: SHAKE_DECAY_DEFAULT,
            seed: SHAKE_SEED_DEFAULT,
        }
    }
}

fn default_flash_color() -> String {
    FLASH_COLOR_DEFAULT.to_owned()
}

fn default_flash_peak_alpha() -> f32 {
    FLASH_PEAK_ALPHA_DEFAULT
}

fn default_shake_amplitude_x() -> f32 {
    SHAKE_AMPLITUDE_X_DEFAULT
}

fn default_shake_amplitude_y() -> f32 {
    SHAKE_AMPLITUDE_Y_DEFAULT
}

fn default_shake_frequency_hz() -> f32 {
    SHAKE_FREQUENCY_HZ_DEFAULT
}

fn default_shake_decay() -> f32 {
    SHAKE_DECAY_DEFAULT
}

fn default_shake_seed() -> u32 {
    SHAKE_SEED_DEFAULT
}

/// Object-only mirror used by the custom effect deserializer; see
/// [`BackgroundTransitionObject`] for why the mirror exists.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum ScreenEffectObject {
    Flash {
        #[serde(default = "default_flash_color")]
        color: String,
        #[serde(default = "default_flash_peak_alpha")]
        peak_alpha: f32,
    },
    Shake {
        #[serde(default = "default_shake_amplitude_x")]
        amplitude_x: f32,
        #[serde(default = "default_shake_amplitude_y")]
        amplitude_y: f32,
        #[serde(default = "default_shake_frequency_hz")]
        frequency_hz: f32,
        #[serde(default = "default_shake_decay")]
        decay: f32,
        #[serde(default = "default_shake_seed")]
        seed: u32,
    },
}

impl ScreenEffectObject {
    fn into_spec(self) -> ScreenEffectSpec {
        match self {
            Self::Flash { color, peak_alpha } => ScreenEffectSpec::Flash { color, peak_alpha },
            Self::Shake {
                amplitude_x,
                amplitude_y,
                frequency_hz,
                decay,
                seed,
            } => ScreenEffectSpec::Shake {
                amplitude_x,
                amplitude_y,
                frequency_hz,
                decay,
                seed,
            },
        }
    }
}

struct ScreenEffectVisitor;

impl<'de> Visitor<'de> for ScreenEffectVisitor {
    type Value = ScreenEffectSpec;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a screen effect name (`flash` or `shake`) or a `{ type, ... }` object")
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        match value {
            "flash" => Ok(ScreenEffectSpec::legacy_flash()),
            "shake" => Ok(ScreenEffectSpec::legacy_shake()),
            other => Err(E::unknown_variant(other, &["flash", "shake"])),
        }
    }

    fn visit_map<A>(self, map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        ScreenEffectObject::deserialize(MapAccessDeserializer::new(map))
            .map(ScreenEffectObject::into_spec)
    }
}

impl<'de> Deserialize<'de> for ScreenEffectSpec {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(ScreenEffectVisitor)
    }
}

/// Schema-only view used on fields so the generated JSON Schema accepts both
/// the already-authored one-word effect and the canonical object.
#[allow(dead_code)]
#[derive(JsonSchema)]
#[serde(untagged)]
enum ScreenEffectSchema {
    Legacy(LegacyScreenEffectName),
    Canonical(ScreenEffectSpec),
}

#[allow(dead_code)]
#[derive(JsonSchema)]
#[serde(rename_all = "snake_case")]
enum LegacyScreenEffectName {
    Flash,
    Shake,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TimelineEasingPreset {
    Step,
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum TimelineEasing {
    Preset(TimelineEasingPreset),
    CubicBezier { cubic_bezier: [f32; 4] },
}

impl Default for TimelineEasing {
    fn default() -> Self {
        Self::Preset(TimelineEasingPreset::Linear)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TimelineKeyframe {
    pub at_ms: u64,
    pub value: TimelineKeyframeValue,
    #[serde(default)]
    pub easing: TimelineEasing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum TimelineKeyframeValue {
    Number(f32),
    Keyword(TimelineKeyframeKeyword),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TimelineKeyframeKeyword {
    Inherit,
}

impl TimelineKeyframeValue {
    pub fn number(&self) -> Option<f32> {
        match self {
            Self::Number(value) => Some(*value),
            Self::Keyword(TimelineKeyframeKeyword::Inherit) => None,
        }
    }

    pub fn is_inherit(&self) -> bool {
        matches!(self, Self::Keyword(TimelineKeyframeKeyword::Inherit))
    }
}

pub type TimelineChannels = BTreeMap<String, Vec<TimelineKeyframe>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VideoFit {
    Contain,
    Cover,
    Stretch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum TimelineTrack {
    Sprite {
        sprite_id: String,
        #[serde(default)]
        asset: Option<String>,
        #[serde(default)]
        remove_at_end: bool,
        #[serde(default)]
        channels: TimelineChannels,
    },
    Camera {
        #[serde(default)]
        channels: TimelineChannels,
    },
    Button {
        instance_id: String,
        #[serde(default)]
        channels: TimelineChannels,
    },
    Video {
        asset: String,
        #[serde(default)]
        clip_start_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        clip_end_ms: Option<u64>,
        #[serde(default, rename = "loop")]
        loop_playback: bool,
        #[serde(default = "default_video_fit")]
        fit: VideoFit,
        #[serde(default = "default_true")]
        audio_enabled: bool,
        #[serde(default)]
        channels: TimelineChannels,
    },
    Bgm {
        #[serde(default)]
        channels: TimelineChannels,
    },
    /// Transient volume automation for one fixed ambience slot. The runtime
    /// restores the authoritative snapshot volume after this cue completes.
    Ambience {
        slot: AmbienceSlot,
        #[serde(default)]
        channels: TimelineChannels,
    },
}

fn default_video_fit() -> VideoFit {
    VideoFit::Contain
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum TimelineEvent {
    Sfx {
        id: String,
        at_ms: u64,
        asset: String,
        #[serde(default = "default_volume")]
        volume: f32,
    },
    ScreenEffect {
        id: String,
        at_ms: u64,
        #[schemars(with = "ScreenEffectSchema")]
        effect: ScreenEffectSpec,
        #[serde(default = "default_short_duration")]
        duration_ms: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RuntimeSnapshot {
    pub revision: u64,
    pub location: StoryLocation,
    pub variables: VariableMap,
    pub world: WorldSnapshot,
    pub audio: AudioSnapshot,
    #[serde(default)]
    pub playback: PlaybackSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialogue_page: Option<DialoguePageSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub long_text_page: Option<LongTextPageSnapshot>,
    pub prompt: PromptSnapshot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DialoguePageSnapshot {
    pub page_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker_id: Option<String>,
    pub speaker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    pub segments: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LongTextPageSnapshot {
    pub document_id: String,
    /// Whether the retained document is currently drawn by the presentation
    /// layer. The accumulated, already-resolved steps remain in the snapshot
    /// while this is false.
    #[serde(default = "default_long_text_visible")]
    pub visible: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paper: Option<String>,
    #[serde(default)]
    pub pagination: LongTextPagination,
    #[serde(default = "default_long_text_font_size")]
    pub font_size: f32,
    #[serde(default = "default_long_text_color")]
    pub text_color: String,
    #[serde(default)]
    pub layout: LongTextLayout,
    pub steps: Vec<LongTextStepSnapshot>,
    pub active_step_index: u32,
}

fn default_long_text_visible() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LongTextStepSnapshot {
    pub step_id: String,
    pub text: String,
    #[serde(default)]
    pub page_break_before: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackAutoMode {
    #[default]
    Normal,
    Forced,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CtrlFastForwardMode {
    #[default]
    Allow,
    Block,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PlaybackSnapshot {
    pub auto: PlaybackAutoMode,
    pub ctrl_fast_forward: CtrlFastForwardMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AdvanceSource {
    Manual,
    Auto,
    FastForward,
    ForcedAuto,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StoryLocation {
    pub scene_id: String,
    pub node_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorldSnapshot {
    pub background: Option<String>,
    pub sprites: BTreeMap<String, SpriteSnapshot>,
    #[serde(default)]
    pub buttons: BTreeMap<String, ButtonSnapshot>,
    pub camera: CameraSnapshot,
    pub dialogue_ui_visible: bool,
    #[serde(default)]
    pub ui_motion_bindings: UiMotionBindings,
    pub persistent_effects: Vec<String>,
    /// Stable curtain state.  Defaulted so every save written before the
    /// curtain existed still deserialises as "no curtain".
    #[serde(default)]
    pub curtain: CurtainSnapshot,
}

impl Default for WorldSnapshot {
    fn default() -> Self {
        Self {
            background: None,
            sprites: BTreeMap::new(),
            buttons: BTreeMap::new(),
            camera: CameraSnapshot::default(),
            dialogue_ui_visible: true,
            ui_motion_bindings: UiMotionBindings::default(),
            persistent_effects: Vec::new(),
            curtain: CurtainSnapshot::default(),
        }
    }
}

/// Persisted curtain: whether a curtain currently covers the world and with
/// which fill.  Transition/duration/easing are deliberately absent because
/// they are one-shot cue parameters, not saved state.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CurtainSnapshot {
    #[serde(default)]
    pub covered: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<CurtainFill>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpriteSnapshot {
    pub asset: String,
    pub x: f32,
    pub y: f32,
    pub scale: f32,
    #[serde(default = "default_scale_component")]
    pub scale_x: f32,
    #[serde(default = "default_scale_component")]
    pub scale_y: f32,
    #[serde(default)]
    pub rotation_deg: f32,
    #[serde(default)]
    pub flip_x: bool,
    /// Normalized texture anchor.  Legacy snapshots used the VN default of
    /// bottom-centre, so both fields remain serde-defaulted for old saves.
    #[serde(default = "default_sprite_anchor_x")]
    pub anchor_x: f32,
    #[serde(default = "default_sprite_anchor_y")]
    pub anchor_y: f32,
    pub opacity: f32,
    pub z: i32,
}

fn default_sprite_anchor_x() -> f32 {
    0.5
}

fn default_sprite_anchor_y() -> f32 {
    1.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CameraSnapshot {
    pub x: f32,
    pub y: f32,
    pub zoom: f32,
    #[serde(default)]
    pub rotation_deg: f32,
}

fn default_scale_component() -> f32 {
    1.0
}

impl Default for CameraSnapshot {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
            rotation_deg: 0.0,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AudioSnapshot {
    pub bgm: Option<LoopingAudioSnapshot>,
    /// Four fixed optional slots. The whole object is omitted when empty so
    /// pre-ambience snapshots and idle audio keep their compact legacy shape.
    #[serde(
        default,
        deserialize_with = "deserialize_ambience_snapshot_compat",
        skip_serializing_if = "AmbienceSnapshot::is_empty"
    )]
    pub ambience: AmbienceSnapshot,
}

/// Older hosts represented an empty ambience state as `null`; accept that
/// spelling while keeping the canonical Rust model as four optional fields.
fn deserialize_ambience_snapshot_compat<'de, D>(
    deserializer: D,
) -> Result<AmbienceSnapshot, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<AmbienceSnapshot>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LoopingAudioSnapshot {
    pub asset: String,
    pub volume: f32,
    #[serde(default)]
    pub start_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_start_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_end_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PromptSnapshot {
    #[default]
    None,
    Dialogue {
        prompt_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        speaker_id: Option<String>,
        speaker: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name_color: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text_color: Option<String>,
        text: String,
        #[serde(default)]
        is_read: bool,
    },
    LongText {
        prompt_id: String,
        document_id: String,
        step_id: String,
        step_index: u32,
        text: String,
        #[serde(default)]
        is_read: bool,
    },
    Choice {
        prompt_id: String,
        #[serde(default)]
        layout: ChoiceLayoutSnapshot,
        #[serde(default)]
        diagnostics: Vec<ChoiceDiagnostic>,
        choices: Vec<ChoiceSnapshot>,
    },
    End {
        prompt_id: String,
    },
}

/// One structured problem found while resolving a choice prompt's
/// presentation.  Diagnostics never abort a story: the runtime falls back to
/// documented defaults and keeps the prompt usable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChoiceDiagnosticCode {
    MissingTemplate,
    MissingIcon,
    InvalidIconKind,
    InvalidDimension,
    InvalidGap,
    InvalidAnchor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChoiceDiagnostic {
    pub code: ChoiceDiagnosticCode,
    pub message: String,
    pub scene_id: String,
    pub node_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice_id: Option<String>,
}

/// Resolved template identity for one choice item.
///
/// `Fallback` is the built-in CSS choice button.  `Button` reuses the same
/// normalized state model as a story button instance, so hosts never need a
/// second skin format and choice skins stay in sync with `ButtonTemplate`.
/// The embedded snapshot's `id` mirrors the choice id and its
/// `x`/`y`/`width`/`height` mirror the item rect, so a host can render it
/// exactly like a story button without recomputing anything.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", content = "button", rename_all = "snake_case")]
pub enum ChoiceTemplateSnapshot {
    #[default]
    Fallback,
    Button(Box<ButtonSnapshot>),
}

/// Resolved choice flow in the fixed 1920x1080 design space.
///
/// `x`/`y`/`width`/`height` bound the whole visible group; each item carries
/// its own rect in [`ChoiceSnapshot`].  `anchor_x`/`anchor_y` are the
/// effective centre in design pixels: an explicitly presented node uses its
/// authored anchor, while a node without `presentation` reports the centre
/// equivalent to the shipped top-left CSS panel placement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChoiceLayoutSnapshot {
    pub stage_width: f32,
    pub stage_height: f32,
    pub anchor_x: f32,
    pub anchor_y: f32,
    pub direction: ChoiceFlowDirection,
    pub gap: f32,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Default for ChoiceLayoutSnapshot {
    fn default() -> Self {
        Self {
            stage_width: CHOICE_STAGE_WIDTH,
            stage_height: CHOICE_STAGE_HEIGHT,
            anchor_x: CHOICE_DEFAULT_ANCHOR_X,
            anchor_y: CHOICE_DEFAULT_ANCHOR_Y,
            direction: ChoiceFlowDirection::Vertical,
            gap: CHOICE_DEFAULT_GAP,
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChoiceSnapshot {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub template: ChoiceTemplateSnapshot,
    /// Effective item rect in the design space.  A snapshot written before
    /// Choice presentation existed defaults to zero and is re-resolved from
    /// the current content when the runtime loads it.
    #[serde(default)]
    pub x: f32,
    #[serde(default)]
    pub y: f32,
    #[serde(default)]
    pub width: f32,
    #[serde(default)]
    pub height: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RuntimeUpdate {
    pub update_id: u64,
    pub snapshot: RuntimeSnapshot,
    pub cues: Vec<PresentationCue>,
    pub requires_ack: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PresentationCue {
    pub cue_id: u64,
    pub gate: CueGate,
    /// Flattened tagged kind.  `deny_unknown_fields` is deliberately absent:
    /// serde does not support it together with a flattened field, and without
    /// this the whole cue (including the legacy-string round-trip) could not be
    /// deserialized at all.
    #[serde(flatten)]
    pub kind: PresentationCueKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CueGate {
    None,
    PlayerAdvance,
    Runtime,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum PresentationCueKind {
    BackgroundTransition {
        background: Option<String>,
        #[serde(default)]
        transition: BackgroundTransitionSpec,
        duration_ms: u64,
        easing: Easing,
    },
    SpriteTween {
        sprite_id: String,
        from: Option<SpriteSnapshot>,
        to: Option<SpriteSnapshot>,
        duration_ms: u64,
        easing: Easing,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        crossfade_ms: Option<u64>,
    },
    /// Clears backgrounds, sprites and persistent visual state as one
    /// coordinated fade. The resulting world always comes from the snapshot.
    ClearScene {
        duration_ms: u64,
        easing: Easing,
    },
    CameraTween {
        from: CameraSnapshot,
        to: CameraSnapshot,
        duration_ms: u64,
        easing: Easing,
    },
    ScreenEffect {
        effect: ScreenEffectSpec,
        duration_ms: u64,
    },
    /// Cover or reveal the persistent curtain layer.  `fill` is the fill being
    /// animated (the new fill on cover, the current fill on reveal) and is the
    /// only part of a curtain cue the host needs to rebuild the layer.
    CurtainTransition {
        action: CurtainAction,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fill: Option<CurtainFill>,
        transition: CurtainTransitionSpec,
        duration_ms: u64,
        easing: Easing,
    },
    DialogueReveal {
        prompt_id: String,
        /// `None` delegates the base reveal speed to the player's settings.
        speed_cps: Option<f32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reveal_animation: Option<TextRevealAnimation>,
    },
    LongTextReveal {
        prompt_id: String,
        /// `None` delegates the base reveal speed to the player's settings.
        speed_cps: Option<f32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reveal_animation: Option<TextRevealAnimation>,
    },
    DialogueUiTransition {
        visible: bool,
        duration_ms: u64,
        motion: Option<UiMotionPreset>,
    },
    UiMotion {
        duration_ms: u64,
        motion: UiMotionPreset,
    },
    ButtonSystemAction {
        panel: ButtonPanel,
    },
    PlaySfx {
        asset: String,
        volume: f32,
    },
    BgmTransition {
        from: Option<LoopingAudioSnapshot>,
        to: Option<LoopingAudioSnapshot>,
        duration_ms: u64,
    },
    /// Starts, stops or replaces one ambience slot. Hosts may treat a
    /// same-slot/same-asset replacement as a volume/loop-state update and
    /// preserve the existing playback head.
    AmbienceTransition {
        slot: AmbienceSlot,
        from: Option<LoopingAudioSnapshot>,
        to: Option<LoopingAudioSnapshot>,
        duration_ms: u64,
    },
    /// A host control cue, never a presentation cue: the desktop host consumes
    /// it while committing the main story update to open or re-point the single
    /// secondary window, and strips it before the update reaches any WebView.
    /// It is therefore absent from the hand-maintained TypeScript wire mirror in
    /// `packages/presentation-core/src/types.ts`.
    OpenWindow {
        scene: String,
    },
    Delay {
        duration_ms: u64,
    },
    Timeline {
        presentation_id: String,
        duration_ms: u64,
        skippable: bool,
        is_seen: bool,
        /// Button transforms immediately before this timeline starts.  The
        /// runtime commits the final transform to the snapshot before it
        /// emits the cue, so the host needs this base to evaluate `inherit`
        /// keyframes on the first frame when a button was created earlier in
        /// the same immediate node chain.
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        button_bases: BTreeMap<String, ButtonTimelineBase>,
        tracks: Vec<TimelineTrack>,
        events: Vec<TimelineEvent>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PresentationOutcome {
    Completed,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BootstrapPayload {
    pub update: RuntimeUpdate,
    pub asset_ids: Vec<String>,
    pub content_version: String,
    /// True when an author-authored chapter map is available.
    #[serde(default)]
    pub chapter_map_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_font: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResolvedAsset {
    pub id: String,
    pub kind: AssetKind,
    /// Absolute path of the static image, or of the first frame when this
    /// asset resolves to a loop animation.
    pub absolute_path: String,
    /// Present only for animated assets.  The host turns every frame path into
    /// an asset-protocol URL; the resulting frame list is what the shared
    /// image resolver hands to Pixi and to the React image components.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animation: Option<ResolvedAnimation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResolvedAnimation {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub total_duration_ms: u64,
    pub frames: Vec<ResolvedAnimationFrame>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResolvedAnimationFrame {
    pub asset: String,
    pub duration_ms: u64,
    pub absolute_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SaveSlotSummary {
    pub slot: String,
    pub exists: bool,
    pub saved_at_unix_ms: Option<u64>,
    pub scene_id: Option<String>,
    pub prompt_preview: Option<String>,
    pub thumbnail_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub master_volume: f32,
    pub bgm_volume: f32,
    pub sfx_volume: f32,
    #[serde(default = "default_volume")]
    pub video_volume: f32,
    #[serde(default = "default_ambience_volume")]
    pub ambience_volume: f32,
    pub text_speed_cps: f32,
    #[serde(default)]
    pub text_reveal_animation: TextRevealAnimation,
    #[serde(default)]
    pub skip_mode: SkipMode,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkipMode {
    Disabled,
    #[default]
    ReadOnly,
    All,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            master_volume: 1.0,
            bgm_volume: 0.7,
            sfx_volume: 0.8,
            video_volume: 1.0,
            ambience_volume: AMBIENCE_VOLUME_DEFAULT,
            text_speed_cps: 30.0,
            text_reveal_animation: TextRevealAnimation::Typewriter,
            skip_mode: SkipMode::ReadOnly,
        }
    }
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SaveSlotRequest {
    pub slot: String,
    pub thumbnail_data_url: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_scene_node(yaml: &str) -> SceneNode {
        let options = serde_saphyr::options! { strict_booleans: true };
        serde_saphyr::from_str_with_options(yaml, options).expect("scene node must parse")
    }

    fn parse_timeline_event(yaml: &str) -> TimelineEvent {
        let options = serde_saphyr::options! { strict_booleans: true };
        serde_saphyr::from_str_with_options(yaml, options).expect("timeline event must parse")
    }

    #[test]
    fn ambience_nodes_and_snapshots_use_the_fixed_four_slot_contract() {
        let node = parse_scene_node(
            "type: ambience\nslot: slot_3\naction: start\nasset: ambience.forest\nnext: end\n",
        );
        assert!(matches!(
            node,
            SceneNode::Ambience {
                slot: AmbienceSlot::Slot3,
                action: AudioAction::Start,
                asset: Some(asset),
                volume,
                ..
            } if asset == "ambience.forest" && volume == AMBIENCE_VOLUME_DEFAULT
        ));

        let state = LoopingAudioSnapshot {
            asset: "ambience.forest".to_owned(),
            volume: 0.35,
            start_ms: 120,
            loop_start_ms: Some(400),
            loop_end_ms: Some(1800),
        };
        let mut ambience = AmbienceSnapshot::default();
        ambience.set(AmbienceSlot::Slot2, Some(state.clone()));
        assert_eq!(ambience.get(AmbienceSlot::Slot2), Some(&state));
        assert!(ambience.get(AmbienceSlot::Slot1).is_none());

        let empty = serde_json::to_value(AudioSnapshot::default()).unwrap();
        assert_eq!(empty, serde_json::json!({"bgm": null}));
        let populated = serde_json::to_value(AudioSnapshot {
            bgm: None,
            ambience,
        })
        .unwrap();
        assert_eq!(populated["ambience"]["slot_2"]["asset"], "ambience.forest");
        assert!(populated["ambience"].get("slot_1").is_none());

        let legacy: AudioSnapshot = serde_json::from_value(serde_json::json!({
            "bgm": null
        }))
        .unwrap();
        assert!(legacy.ambience.is_empty());

        let explicit_null: AudioSnapshot = serde_json::from_value(serde_json::json!({
            "bgm": null,
            "ambience": null
        }))
        .unwrap();
        assert!(explicit_null.ambience.is_empty());
        assert_eq!(
            serde_json::to_value(explicit_null).unwrap(),
            serde_json::json!({"bgm": null}),
        );
    }

    #[test]
    fn ambience_slots_serialize_to_the_four_wire_names() {
        let names: Vec<String> = AmbienceSlot::ALL
            .into_iter()
            .map(|slot| serde_json::to_string(&slot).expect("slot must serialize"))
            .collect();
        assert_eq!(
            names,
            vec!["\"slot_1\"", "\"slot_2\"", "\"slot_3\"", "\"slot_4\""]
        );
        for (name, slot) in [
            ("slot_1", AmbienceSlot::Slot1),
            ("slot_2", AmbienceSlot::Slot2),
            ("slot_3", AmbienceSlot::Slot3),
            ("slot_4", AmbienceSlot::Slot4),
        ] {
            let parsed: AmbienceSlot =
                serde_json::from_str(&format!("\"{name}\"")).expect("slot name must deserialize");
            assert_eq!(parsed, slot);
        }
    }

    #[test]
    fn ambience_stop_with_an_asset_remains_parseable_for_content_validation() {
        let node = parse_scene_node(
            "type: ambience\nslot: slot_1\naction: stop\nasset: ambience.forest\nnext: end\n",
        );
        assert!(matches!(
            node,
            SceneNode::Ambience {
                action: AudioAction::Stop,
                asset: Some(asset),
                ..
            } if asset == "ambience.forest"
        ));
    }

    #[test]
    fn legacy_background_transitions_normalise_to_the_canonical_spec() {
        let default = parse_scene_node("type: background\nnext: end\n");
        assert!(matches!(
            default,
            SceneNode::Background {
                transition: BackgroundTransitionSpec::CrossFade,
                ..
            }
        ));

        let cut = parse_scene_node("type: background\ntransition: cut\nnext: end\n");
        assert!(matches!(
            cut,
            SceneNode::Background {
                transition: BackgroundTransitionSpec::Cut,
                ..
            }
        ));

        let cross_fade = parse_scene_node("type: background\ntransition: cross_fade\nnext: end\n");
        assert!(matches!(
            cross_fade,
            SceneNode::Background {
                transition: BackgroundTransitionSpec::CrossFade,
                ..
            }
        ));
    }

    #[test]
    fn canonical_background_transition_objects_parse_with_defaults() {
        let wipe = parse_scene_node(
            "type: background\ntransition:\n  type: wipe\n  direction: left_to_right\nnext: end\n",
        );
        assert!(matches!(
            wipe,
            SceneNode::Background {
                transition: BackgroundTransitionSpec::Wipe {
                    direction: TransitionDirection::LeftToRight,
                    softness,
                },
                ..
            } if softness == TRANSITION_SOFTNESS_DEFAULT
        ));

        let push = parse_scene_node(
            "type: background\ntransition: {type: push, direction: bottom_to_top, softness: 0.25}\nnext: end\n",
        );
        assert!(matches!(
            push,
            SceneNode::Background {
                transition: BackgroundTransitionSpec::Push {
                    direction: TransitionDirection::BottomToTop,
                    softness,
                },
                ..
            } if softness == 0.25
        ));

        let fade = parse_scene_node(
            "type: background\ntransition: {type: fade_through_color, color: \"#11223344\"}\nnext: end\n",
        );
        assert!(matches!(
            fade,
            SceneNode::Background {
                transition: BackgroundTransitionSpec::FadeThroughColor { color },
                ..
            } if color == "#11223344"
        ));
    }

    #[test]
    fn legacy_screen_effects_normalise_to_the_shipped_defaults() {
        let flash = parse_scene_node("type: screen_effect\neffect: flash\nnext: end\n");
        assert!(matches!(
            flash,
            SceneNode::ScreenEffect {
                effect: ScreenEffectSpec::Flash { color, peak_alpha },
                ..
            } if color == FLASH_COLOR_DEFAULT && peak_alpha == FLASH_PEAK_ALPHA_DEFAULT
        ));

        let shake = parse_scene_node("type: screen_effect\neffect: shake\nnext: end\n");
        assert!(matches!(
            shake,
            SceneNode::ScreenEffect {
                effect: ScreenEffectSpec::Shake {
                    amplitude_x,
                    amplitude_y,
                    frequency_hz,
                    decay,
                    seed,
                },
                ..
            } if amplitude_x == SHAKE_AMPLITUDE_X_DEFAULT
                && amplitude_y == SHAKE_AMPLITUDE_Y_DEFAULT
                && frequency_hz == SHAKE_FREQUENCY_HZ_DEFAULT
                && decay == SHAKE_DECAY_DEFAULT
                && seed == SHAKE_SEED_DEFAULT
        ));
    }

    #[test]
    fn canonical_screen_effect_objects_parse_with_defaults() {
        let flash = parse_scene_node(
            "type: screen_effect\neffect: {type: flash, color: \"#FF0000\"}\nnext: end\n",
        );
        assert!(matches!(
            flash,
            SceneNode::ScreenEffect {
                effect: ScreenEffectSpec::Flash { color, peak_alpha },
                ..
            } if color == "#FF0000" && peak_alpha == FLASH_PEAK_ALPHA_DEFAULT
        ));

        let shake = parse_scene_node(
            "type: screen_effect\neffect: {type: shake, amplitude_x: 18.0, amplitude_y: 8.0, frequency_hz: 22.0, decay: 0.75, seed: 42}\nnext: end\n",
        );
        assert!(matches!(
            shake,
            SceneNode::ScreenEffect {
                effect: ScreenEffectSpec::Shake {
                    amplitude_x,
                    amplitude_y,
                    frequency_hz,
                    decay,
                    seed,
                },
                ..
            } if amplitude_x == 18.0
                && amplitude_y == 8.0
                && frequency_hz == 22.0
                && decay == 0.75
                && seed == 42
        ));
    }

    #[test]
    fn timeline_events_share_the_canonical_screen_effect_spec() {
        let legacy = parse_timeline_event(
            "type: screen_effect\nid: parity_flash\nat_ms: 320\neffect: flash\nduration_ms: 120\n",
        );
        assert!(matches!(
            legacy,
            TimelineEvent::ScreenEffect {
                at_ms: 320,
                effect: ScreenEffectSpec::Flash { color, peak_alpha },
                duration_ms: 120,
                ..
            } if color == FLASH_COLOR_DEFAULT && peak_alpha == FLASH_PEAK_ALPHA_DEFAULT
        ));

        let canonical = parse_timeline_event(
            "type: screen_effect\nid: parity_shake\nat_ms: 320\neffect: {type: shake, seed: 42}\nduration_ms: 200\n",
        );
        assert!(matches!(
            canonical,
            TimelineEvent::ScreenEffect {
                effect: ScreenEffectSpec::Shake { amplitude_x, seed, .. },
                ..
            } if amplitude_x == SHAKE_AMPLITUDE_X_DEFAULT && seed == 42
        ));
    }

    #[test]
    fn legacy_world_snapshots_default_to_no_curtain() {
        let yaml = "background: null\nsprites: {}\ncamera: {x: 0.0, y: 0.0, zoom: 1.0}\ndialogue_ui_visible: true\npersistent_effects: []\n";
        let options = serde_saphyr::options! { strict_booleans: true };
        let world: WorldSnapshot =
            serde_saphyr::from_str_with_options(yaml, options).expect("legacy world must load");
        assert!(!world.curtain.covered);
        assert_eq!(world.curtain.fill, None);
        assert_eq!(world.curtain, CurtainSnapshot::default());
    }

    #[test]
    fn curtain_snapshots_keep_only_stable_state() {
        let snapshot = CurtainSnapshot {
            covered: true,
            fill: Some(CurtainFill::Color {
                color: "#000000".to_owned(),
            }),
        };
        let json = serde_json::to_string(&snapshot).unwrap();
        assert_eq!(json, r##"{"covered":true,"fill":{"color":"#000000"}}"##);
        assert_eq!(
            serde_json::from_str::<CurtainSnapshot>(&json).unwrap(),
            snapshot
        );

        let asset = CurtainSnapshot {
            covered: true,
            fill: Some(CurtainFill::Asset {
                asset: "gui.dialogue_box".to_owned(),
            }),
        };
        let json = serde_json::to_string(&asset).unwrap();
        assert_eq!(
            json,
            r#"{"covered":true,"fill":{"asset":"gui.dialogue_box"}}"#
        );
    }

    #[test]
    fn curtain_fill_rejects_ambiguous_and_empty_objects() {
        let options = serde_saphyr::options! { strict_booleans: true };
        let both: Result<SceneNode, _> = serde_saphyr::from_str_with_options(
            "type: curtain\naction: cover\nfill: {color: \"#000000\", asset: gui.dialogue_box}\ntransition: {type: fade}\nnext: end\n",
            options,
        );
        assert!(both.unwrap_err().to_string().contains("只能"));

        let options = serde_saphyr::options! { strict_booleans: true };
        let empty: Result<SceneNode, _> = serde_saphyr::from_str_with_options(
            "type: curtain\naction: cover\nfill: {}\ntransition: {type: fade}\nnext: end\n",
            options,
        );
        assert!(empty.unwrap_err().to_string().contains("必须"));

        let options = serde_saphyr::options! { strict_booleans: true };
        let unknown: Result<SceneNode, _> = serde_saphyr::from_str_with_options(
            "type: curtain\naction: cover\nfill: {tint: \"#000000\"}\ntransition: {type: fade}\nnext: end\n",
            options,
        );
        assert!(unknown.unwrap_err().to_string().contains("color"));

        let options = serde_saphyr::options! { strict_booleans: true };
        let asset: SceneNode = serde_saphyr::from_str_with_options(
            "type: curtain\naction: cover\nfill: {asset: gui.dialogue_box}\ntransition: {type: split_vertical}\nnext: end\n",
            options,
        )
        .unwrap();
        assert!(matches!(
            asset,
            SceneNode::Curtain {
                fill: Some(CurtainFill::Asset { .. }),
                transition: CurtainTransitionSpec::SplitVertical,
                ..
            }
        ));
    }

    #[test]
    fn shake_seed_stays_in_the_javascript_safe_integer_range() {
        // Number.MAX_SAFE_INTEGER; the wire is JSON, so the seed must never
        // exceed what a WebView can represent exactly.
        assert!(u64::from(SHAKE_SEED_MAX) < 9_007_199_254_740_991);

        let options = serde_saphyr::options! { strict_booleans: true };
        let max: SceneNode = serde_saphyr::from_str_with_options(
            "type: screen_effect\neffect: {type: shake, seed: 4294967295}\nnext: end\n",
            options,
        )
        .unwrap();
        assert!(matches!(
            max,
            SceneNode::ScreenEffect {
                effect: ScreenEffectSpec::Shake { seed, .. },
                ..
            } if seed == SHAKE_SEED_MAX
        ));

        let options = serde_saphyr::options! { strict_booleans: true };
        let overflow: Result<SceneNode, _> = serde_saphyr::from_str_with_options(
            "type: screen_effect\neffect: {type: shake, seed: 4294967296}\nnext: end\n",
            options,
        );
        assert!(overflow.is_err());
    }

    #[test]
    fn legacy_choice_nodes_parse_without_presentation() {
        let node = parse_scene_node("type: choice\nchoices:\n- id: a\n  label: A\n  next: end\n");
        let SceneNode::Choice {
            presentation,
            choices,
        } = node
        else {
            panic!("expected choice node")
        };
        assert!(presentation.is_none());
        assert_eq!(choices.len(), 1);
        assert!(choices[0].template.is_none());
        assert!(choices[0].icon.is_none());
    }

    #[test]
    fn choice_presentation_parses_defaults_and_overrides() {
        let node = parse_scene_node(
            "type: choice\npresentation:\n  template: choice.primary\nchoices:\n- id: a\n  label: A\n  next: end\n",
        );
        let SceneNode::Choice {
            presentation: Some(presentation),
            ..
        } = node
        else {
            panic!("expected presentation")
        };
        assert_eq!(presentation.template.as_deref(), Some("choice.primary"));
        assert_eq!(presentation.anchor_x, CHOICE_DEFAULT_ANCHOR_X);
        assert_eq!(presentation.anchor_y, CHOICE_DEFAULT_ANCHOR_Y);
        assert_eq!(presentation.direction, ChoiceFlowDirection::Vertical);
        assert_eq!(presentation.gap, CHOICE_DEFAULT_GAP);
        assert_eq!(presentation.button_width, None);
        assert_eq!(presentation.button_height, None);

        let node = parse_scene_node(
            "type: choice\npresentation:\n  template: choice.primary\n  anchor_x: 480\n  anchor_y: 810\n  direction: horizontal\n  gap: 12\n  button_width: 300\n  button_height: 72\nchoices:\n- id: a\n  label: A\n  template: choice.secondary\n  icon: gui.dialogue_box\n  next: end\n",
        );
        let SceneNode::Choice {
            presentation: Some(presentation),
            choices,
        } = node
        else {
            panic!("expected presentation")
        };
        assert_eq!(presentation.anchor_x, 480.0);
        assert_eq!(presentation.anchor_y, 810.0);
        assert_eq!(presentation.direction, ChoiceFlowDirection::Horizontal);
        assert_eq!(presentation.gap, 12.0);
        assert_eq!(presentation.button_width, Some(300.0));
        assert_eq!(presentation.button_height, Some(72.0));
        assert_eq!(choices[0].template.as_deref(), Some("choice.secondary"));
        assert_eq!(choices[0].icon.as_deref(), Some("gui.dialogue_box"));
    }

    #[test]
    fn choice_direction_typos_report_the_canonical_variants() {
        let options = serde_saphyr::options! { strict_booleans: true };
        let error = serde_saphyr::from_str_with_options::<SceneNode>(
            "type: choice\npresentation: {direction: sideways}\nchoices: []\n",
            options,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("sideways"), "{error}");
        assert!(error.contains("vertical"), "{error}");
        assert!(error.contains("horizontal"), "{error}");
    }

    #[test]
    fn choice_presentation_rejects_unknown_fields() {
        let options = serde_saphyr::options! { strict_booleans: true };
        let error = serde_saphyr::from_str_with_options::<SceneNode>(
            "type: choice\npresentation: {spacing: 4}\nchoices: []\n",
            options,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("spacing"), "{error}");
    }
}
