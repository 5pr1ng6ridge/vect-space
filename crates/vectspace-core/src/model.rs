//! Stable content, runtime and persistence models shared by both desktop hosts.

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

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
    Sfx,
    Font,
    Video,
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
        transition: BackgroundTransition,
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
        effect: ScreenEffectKind,
        #[serde(default = "default_short_duration")]
        duration_ms: u64,
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundTransition {
    Cut,
    #[default]
    CrossFade,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScreenEffectKind {
    Shake,
    Flash,
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
        effect: ScreenEffectKind,
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
        }
    }
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
        choices: Vec<ChoiceSnapshot>,
    },
    End {
        prompt_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChoiceSnapshot {
    pub id: String,
    pub label: String,
    pub enabled: bool,
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
#[serde(deny_unknown_fields)]
pub struct PresentationCue {
    pub cue_id: u64,
    pub gate: CueGate,
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
        transition: BackgroundTransition,
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
        effect: ScreenEffectKind,
        duration_ms: u64,
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
