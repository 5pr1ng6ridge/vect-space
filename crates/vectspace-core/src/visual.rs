//! Shared visual sources and reusable fixed-text / particle documents.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use crate::model::SpriteSnapshot;

pub const LEGACY_BACKGROUND_ID: &str = "__background__";
pub const TEXT_BLOCK_MAX_PIXELS: u64 = 4_194_304;
pub const PARTICLE_MAX_LIVE: u32 = 5_000;
pub const PARTICLE_SURFACE_MAX_LIVE: u32 = 10_000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpriteKind {
    Background,
    #[default]
    Character,
    Item,
    Ui,
    Text,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CoordinateSpace {
    #[default]
    World,
    Screen,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum SpriteSource {
    Image { asset: String },
    Text { text_block: String },
}

impl SpriteSource {
    pub fn image_asset(&self) -> Option<&str> {
        match self { Self::Image { asset } => Some(asset), Self::Text { .. } => None }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ImageFit {
    #[default]
    Contain,
    Cover,
    Stretch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpriteLayout {
    pub width: f32,
    pub height: f32,
    #[serde(default)]
    pub fit: ImageFit,
}

impl SpriteKind {
    pub fn preset(self, source: SpriteSource) -> SpriteSnapshot {
        let centered = self != Self::Character;
        SpriteSnapshot {
            source,
            sprite_kind: self,
            space: if self == Self::Ui { CoordinateSpace::Screen } else { CoordinateSpace::World },
            layout: if self == Self::Background { Some(SpriteLayout { width: 1920.0, height: 1080.0, fit: ImageFit::Cover }) } else { None },
            x: 960.0,
            y: if centered { 540.0 } else { 1080.0 },
            anchor_y: if centered { 0.5 } else { 1.0 },
            z: if self == Self::Background { -10_000 } else { 0 },
            ..SpriteSnapshot::default()
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TextAlign { #[default] Left, Center, Right }
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VerticalAlign { #[default] Top, Center, Bottom }

fn default_font_size() -> f32 { 32.0 }
fn default_line_height() -> f32 { 1.4 }
fn default_color() -> String { "#FFFFFF".to_owned() }
fn one() -> f32 { 1.0 }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TextBlockDefinition {
    pub schema_version: u32,
    pub id: String,
    pub content: String,
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(default = "default_font_size")]
    pub font_size: f32,
    #[serde(default = "default_line_height")]
    pub line_height: f32,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default)]
    pub align: TextAlign,
    #[serde(default)]
    pub vertical_align: VerticalAlign,
    #[serde(default)]
    pub padding: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ParticleRange { pub min: f32, pub max: f32 }
impl Default for ParticleRange { fn default() -> Self { Self { min: 0.0, max: 0.0 } } }
fn default_lifetime() -> ParticleRange { ParticleRange { min: 1000.0, max: 2000.0 } }
fn default_size() -> ParticleRange { ParticleRange { min: 1.0, max: 1.0 } }
fn default_max_particles() -> u32 { 500 }

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum EmissionArea {
    #[default]
    Point,
    Rectangle { width: f32, height: f32 },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ParticleBlend { #[default] Normal, Add }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ParticleDefinition {
    pub schema_version: u32,
    pub id: String,
    pub image: String,
    #[serde(default)]
    pub area: EmissionArea,
    #[serde(default)]
    pub rate: f32,
    #[serde(default)]
    pub burst_count: u32,
    #[serde(default = "default_max_particles")]
    pub max_particles: u32,
    #[serde(default = "default_lifetime")]
    pub lifetime_ms: ParticleRange,
    #[serde(default)]
    pub velocity_x: ParticleRange,
    #[serde(default)]
    pub velocity_y: ParticleRange,
    #[serde(default)]
    pub gravity_x: f32,
    #[serde(default)]
    pub gravity_y: f32,
    #[serde(default = "default_size")]
    pub size: ParticleRange,
    #[serde(default)]
    pub rotation_deg: ParticleRange,
    #[serde(default)]
    pub angular_velocity_deg: ParticleRange,
    #[serde(default = "one")]
    pub alpha_start: f32,
    #[serde(default)]
    pub alpha_end: f32,
    #[serde(default)]
    pub blend: ParticleBlend,
    #[serde(default)]
    pub seed: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ParticleAction { Start, Stop, Burst }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EmitterSnapshot {
    pub particle: String,
    pub seed: u32,
    /// Runtime-owned restart identity; never a per-particle simulation state.
    pub generation: u32,
    #[serde(default)]
    pub space: CoordinateSpace,
    pub x: f32,
    pub y: f32,
    #[serde(default = "one")]
    pub scale: f32,
    #[serde(default)]
    pub rotation_deg: f32,
    #[serde(default = "one")]
    pub opacity: f32,
    #[serde(default)]
    pub z: i32,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn categories_only_choose_creation_defaults() {
        let image = SpriteSource::Image { asset: "image".into() };
        let background = SpriteKind::Background.preset(image.clone());
        assert_eq!(background.anchor_y, 0.5);
        assert_eq!(background.layout.unwrap().fit, ImageFit::Cover);
        assert_eq!(SpriteKind::Ui.preset(image.clone()).space, CoordinateSpace::Screen);
        assert_eq!(SpriteKind::Character.preset(image).anchor_y, 1.0);
    }
    #[test]
    fn source_is_exclusive() {
        assert!(serde_json::from_str::<SpriteSource>(r#"{"type":"image","asset":"a","text_block":"b"}"#).is_err());
    }
}
