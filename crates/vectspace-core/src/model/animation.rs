use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::timeline::TimelineEasing;

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
/// Animation is deliberately kept out of the asset *kind* namespace:
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
}
