use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::visual::{CoordinateSpace, SpriteKind, SpriteLayout, SpriteSource};
use super::{default_short_duration, default_true, default_volume};
use super::audio::AmbienceSlot;
use super::effects::ScreenEffectSpec;

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
    Emitter {
        emitter_id: String,
        #[serde(default)]
        remove_at_end: bool,
        #[serde(default)]
        channels: TimelineChannels,
    },
    Sprite {
        sprite_id: String,
        #[serde(default)]
        asset: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<SpriteSource>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sprite_kind: Option<SpriteKind>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        space: Option<CoordinateSpace>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        layout: Option<SpriteLayout>,
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
        effect: ScreenEffectSpec,
        #[serde(default = "default_short_duration")]
        duration_ms: u64,
    },
}
