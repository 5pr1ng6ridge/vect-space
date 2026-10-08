use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{de, Deserialize, Deserializer, Serialize};

use crate::visual::{CoordinateSpace, EmitterSnapshot, LEGACY_BACKGROUND_ID, SpriteKind, SpriteLayout, SpriteSource};
use super::default_scale_component;
use super::audio::AudioSnapshot;
use super::choice::{ChoiceDiagnostic, ChoiceLayoutSnapshot, ChoiceSnapshot};
use super::text::{LongTextLayout, LongTextPagination, default_long_text_color, default_long_text_font_size};
use super::transition::CurtainFill;
use super::ui::{ButtonSnapshot, UiMotionBindings};
use super::variables::VariableMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RuntimeSnapshot {
    #[serde(default)]
    pub interaction: crate::interaction::InteractionSnapshot,
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
    Script,
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

#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorldSnapshot {
    pub sprites: BTreeMap<String, SpriteSnapshot>,
    #[serde(default)]
    pub emitters: BTreeMap<String, EmitterSnapshot>,
    #[serde(default)]
    pub buttons: BTreeMap<String, ButtonSnapshot>,
    pub camera: CameraSnapshot,
    pub dialogue_ui_visible: bool,
    #[serde(default)]
    pub ui_motion_bindings: UiMotionBindings,
    pub persistent_effects: Vec<String>,
    /// Stable curtain state.
    pub curtain: CurtainSnapshot,
}

impl Default for WorldSnapshot {
    fn default() -> Self {
        Self {
            sprites: BTreeMap::new(),
            emitters: BTreeMap::new(),
            buttons: BTreeMap::new(),
            camera: CameraSnapshot::default(),
            dialogue_ui_visible: true,
            ui_motion_bindings: UiMotionBindings::default(),
            persistent_effects: Vec::new(),
            curtain: CurtainSnapshot::default(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorldSnapshotInput {
    #[serde(default)]
    background: Option<String>,
    #[serde(default)]
    sprites: BTreeMap<String, SpriteSnapshot>,
    #[serde(default)]
    emitters: BTreeMap<String, EmitterSnapshot>,
    #[serde(default)]
    buttons: BTreeMap<String, ButtonSnapshot>,
    camera: CameraSnapshot,
    dialogue_ui_visible: bool,
    #[serde(default)]
    ui_motion_bindings: UiMotionBindings,
    persistent_effects: Vec<String>,
    #[serde(default)]
    curtain: CurtainSnapshot,
}

impl WorldSnapshot {
    pub fn background_asset(&self) -> Option<&str> {
        self.sprites.get(LEGACY_BACKGROUND_ID).and_then(|sprite| sprite.source.image_asset())
    }
    pub fn set_legacy_background(&mut self, background: Option<String>) {
        if let Some(asset) = background {
            self.sprites.insert(LEGACY_BACKGROUND_ID.to_owned(), SpriteKind::Background.preset(SpriteSource::Image { asset }));
        } else {
            self.sprites.remove(LEGACY_BACKGROUND_ID);
        }
    }
}

impl<'de> Deserialize<'de> for WorldSnapshot {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let input = WorldSnapshotInput::deserialize(deserializer)?;
        let mut world = Self {
            sprites: input.sprites, emitters: input.emitters, buttons: input.buttons,
            camera: input.camera, dialogue_ui_visible: input.dialogue_ui_visible,
            ui_motion_bindings: input.ui_motion_bindings,
            persistent_effects: input.persistent_effects, curtain: input.curtain,
        };
        if input.background.is_some() {
            if world.sprites.contains_key(LEGACY_BACKGROUND_ID) {
                return Err(de::Error::custom("旧 background 与 Sprite __background__ 冲突"));
            }
            world.set_legacy_background(input.background);
        }
        Ok(world)
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

#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpriteSnapshot {
    pub source: SpriteSource,
    #[serde(default)]
    pub sprite_kind: SpriteKind,
    #[serde(default)]
    pub space: CoordinateSpace,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<SpriteLayout>,
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
    /// Normalized texture anchor.
    pub anchor_x: f32,
    pub anchor_y: f32,
    pub opacity: f32,
    pub z: i32,
}

impl Default for SpriteSnapshot {
    fn default() -> Self {
        Self {
            source: SpriteSource::Image { asset: String::new() },
            sprite_kind: SpriteKind::Character,
            space: CoordinateSpace::World,
            layout: None,
            x: 960.0, y: 1080.0, scale: 1.0, scale_x: 1.0, scale_y: 1.0,
            rotation_deg: 0.0, flip_x: false, anchor_x: 0.5, anchor_y: 1.0,
            opacity: 1.0, z: 0,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SpriteSnapshotInput {
    #[serde(default)]
    source: Option<SpriteSource>,
    #[serde(default)]
    asset: Option<String>,
    #[serde(default)]
    sprite_kind: SpriteKind,
    #[serde(default)]
    space: CoordinateSpace,
    #[serde(default)]
    layout: Option<SpriteLayout>,
    x: f32,
    y: f32,
    scale: f32,
    #[serde(default = "default_scale_component")]
    scale_x: f32,
    #[serde(default = "default_scale_component")]
    scale_y: f32,
    #[serde(default)]
    rotation_deg: f32,
    #[serde(default)]
    flip_x: bool,
    anchor_x: f32,
    anchor_y: f32,
    opacity: f32,
    z: i32,
}

impl<'de> Deserialize<'de> for SpriteSnapshot {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let input = SpriteSnapshotInput::deserialize(deserializer)?;
        let source = match (input.source, input.asset) {
            (Some(source), None) => source,
            (None, Some(asset)) => SpriteSource::Image { asset },
            _ => return Err(de::Error::custom("Sprite 必须且只能指定 source 或旧 asset")),
        };
        Ok(Self {
            source, sprite_kind: input.sprite_kind, space: input.space, layout: input.layout,
            x: input.x, y: input.y, scale: input.scale, scale_x: input.scale_x,
            scale_y: input.scale_y, rotation_deg: input.rotation_deg, flip_x: input.flip_x,
            anchor_x: input.anchor_x, anchor_y: input.anchor_y, opacity: input.opacity, z: input.z,
        })
    }
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
        layout: ChoiceLayoutSnapshot,
        diagnostics: Vec<ChoiceDiagnostic>,
        choices: Vec<ChoiceSnapshot>,
    },
    End {
        prompt_id: String,
    },
}
