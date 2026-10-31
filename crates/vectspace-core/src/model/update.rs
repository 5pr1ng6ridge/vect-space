use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::visual::EmitterSnapshot;
use super::audio::{AmbienceSlot, LoopingAudioSnapshot};
use super::effects::ScreenEffectSpec;
use super::snapshot::{CameraSnapshot, RuntimeSnapshot, SpriteSnapshot};
use super::text::TextRevealAnimation;
use super::timeline::{TimelineEvent, TimelineTrack};
use super::transition::{BackgroundTransitionSpec, CurtainAction, CurtainFill, CurtainTransitionSpec, Easing};
use super::ui::{ButtonPanel, ButtonTimelineBase, UiMotionPreset};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RuntimeUpdate {
    #[serde(default)]
    pub kind: crate::interaction::UpdateKind,
    /// Scene timer that produced an `effect` update, so a stopped repeating
    /// timer can cancel its own in-flight presentation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect_timer: Option<String>,
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
    /// serde does not support it together with a flattened field.
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
    ParticleState {
        emitter_id: String,
        emitter: Option<EmitterSnapshot>,
        #[serde(default)]
        burst: bool,
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
    #[serde(default)]
    pub text_blocks: BTreeMap<String, crate::visual::TextBlockDefinition>,
    #[serde(default)]
    pub particles: BTreeMap<String, crate::visual::ParticleDefinition>,
    pub asset_ids: Vec<String>,
    pub content_version: String,
    /// True when an author-authored chapter map is available.
    #[serde(default)]
    pub chapter_map_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_font: Option<String>,
}
