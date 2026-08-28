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
    #[serde(default)]
    pub variables: BTreeMap<String, VariableDefinition>,
    #[serde(default)]
    pub characters: BTreeMap<String, CharacterDefinition>,
    pub assets: BTreeMap<String, AssetDefinition>,
    pub scenes: Vec<String>,
}

fn default_locale() -> String {
    "zh-CN".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AssetDefinition {
    pub kind: AssetKind,
    pub path: String,
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
        asset: Option<String>,
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
    Say {
        speaker: Option<String>,
        text: String,
        #[serde(default)]
        speed_cps: Option<f32>,
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
        #[serde(default = "default_short_duration")]
        duration_ms: u64,
        #[serde(default, rename = "await")]
        await_completion: bool,
        next: String,
    },
    End,
}

fn default_short_duration() -> u64 {
    200
}

fn default_medium_duration() -> u64 {
    500
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
    pub value: f32,
    #[serde(default)]
    pub easing: TimelineEasing,
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
        asset: String,
        #[serde(default)]
        remove_at_end: bool,
        #[serde(default)]
        channels: TimelineChannels,
    },
    Camera {
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
    pub prompt: PromptSnapshot,
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
    pub camera: CameraSnapshot,
    pub dialogue_ui_visible: bool,
    pub persistent_effects: Vec<String>,
}

impl Default for WorldSnapshot {
    fn default() -> Self {
        Self {
            background: None,
            sprites: BTreeMap::new(),
            camera: CameraSnapshot::default(),
            dialogue_ui_visible: true,
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
    pub opacity: f32,
    pub z: i32,
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
        speed_cps: f32,
    },
    DialogueUiTransition {
        visible: bool,
        duration_ms: u64,
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
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResolvedAsset {
    pub id: String,
    pub kind: AssetKind,
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
