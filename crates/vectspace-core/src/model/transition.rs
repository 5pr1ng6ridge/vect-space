use schemars::JsonSchema;
use serde::{de, Deserialize, Deserializer, Serialize};

/// Background transition of a `background` node and its cue.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
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

impl Easing {
    /// Progress at `t` in `0..=1`, with the same quadratic curves as the
    /// timeline presets.
    pub fn sample(self, t: f32) -> f32 {
        let t = t.clamp(0.0, 1.0);
        match self {
            Self::Linear => t,
            Self::EaseIn => t * t,
            Self::EaseOut => 1.0 - (1.0 - t).powi(2),
            Self::EaseInOut if t < 0.5 => 2.0 * t * t,
            Self::EaseInOut => 1.0 - (-2.0 * t + 2.0).powi(2) / 2.0,
        }
    }
}
