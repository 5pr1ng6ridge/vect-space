use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

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
