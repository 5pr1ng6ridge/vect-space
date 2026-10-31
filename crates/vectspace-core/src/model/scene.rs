use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::visual::{CoordinateSpace, ParticleAction, SpriteKind, SpriteLayout, SpriteSource};
use super::{default_scale_component, default_short_duration, default_true, default_volume};
use super::animation::SpriteActionEnd;
use super::audio::{AmbienceSlot, AudioAction, default_ambience_volume};
use super::choice::{ChoiceDefinition, ChoicePresentation};
use super::effects::ScreenEffectSpec;
use super::snapshot::{CtrlFastForwardMode, PlaybackAutoMode};
use super::text::{DialogueMode, LongTextControlAction, LongTextExit, LongTextLayout, LongTextMode, LongTextPagination, LongTextStep, TextRevealAnimation};
use super::timeline::{TimelineEvent, TimelineTrack};
use super::transition::{BackgroundTransitionSpec, CurtainAction, CurtainFill, CurtainTransitionSpec, Easing};
use super::ui::{ButtonClickAction, UiMotionSlot};
use super::variables::{ConditionExpression, MutationValue, VariableOperation};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SceneDefinition {
    pub schema_version: u32,
    pub id: String,
    #[serde(default, skip_serializing_if = "crate::interaction::WindowRole::is_main")]
    pub window_role: crate::interaction::WindowRole,
    pub entry: String,
    pub nodes: BTreeMap<String, SceneNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum SceneNode {
    Proof {
        puzzle: String,
        next: String,
        #[serde(default)]
        abandon: Option<String>,
    },
    Background {
        background: Option<String>,
        #[serde(default)]
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
        source: Option<SpriteSource>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sprite_kind: Option<SpriteKind>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        space: Option<CoordinateSpace>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        layout: Option<SpriteLayout>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scale_x: Option<f32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scale_y: Option<f32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rotation_deg: Option<f32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        anchor_x: Option<f32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        anchor_y: Option<f32>,
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
    Particle {
        emitter_id: String,
        action: ParticleAction,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        particle: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seed: Option<u32>,
        #[serde(default)]
        space: CoordinateSpace,
        #[serde(default)]
        x: f32,
        #[serde(default)]
        y: f32,
        #[serde(default = "default_scale_component")]
        scale: f32,
        #[serde(default)]
        rotation_deg: f32,
        #[serde(default = "default_scale_component")]
        opacity: f32,
        #[serde(default)]
        z: i32,
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
    WindowTitle {
        target: crate::interaction::WindowRole,
        title: String,
        next: String,
    },
    WindowControl {
        target: crate::interaction::WindowRole,
        action: crate::interaction::WindowControlAction,
        #[serde(default)]
        id: String,
        #[serde(default)]
        message: String,
        next: String,
    },
    Timer {
        id: String,
        action: crate::interaction::TimerAction,
        #[serde(default)]
        delay_ms: u64,
        #[serde(default)]
        interval_ms: Option<u64>,
        #[serde(default)]
        target: Option<String>,
        next: String,
    },
    /// Move and/or resize a game window, optionally animated.
    WindowGeometry {
        target: crate::interaction::WindowRole,
        #[serde(default)]
        position: Option<crate::interaction::WindowPlacement>,
        #[serde(default)]
        size: Option<crate::interaction::WindowSize>,
        #[serde(default)]
        duration_ms: u64,
        #[serde(default)]
        easing: Easing,
        #[serde(default, rename = "await")]
        await_completion: bool,
        next: String,
    },
    WindowLayer {
        target: crate::interaction::WindowRole,
        action: crate::interaction::WindowLayerAction,
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

fn default_medium_duration() -> u64 {
    500
}

fn default_clear_await() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpriteAction {
    Show,
    Move,
    Hide,
}
