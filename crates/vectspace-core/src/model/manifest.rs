use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::assets::AssetDefinition;
use super::ui::UiMotionBindings;
use super::variables::VariableDefinition;

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
    #[serde(default)]
    pub text_blocks: Vec<String>,
    #[serde(default)]
    pub particles: Vec<String>,
    #[serde(default)]
    pub proofs: Vec<String>,
    /// Optional author-authored room map used as the chapter selector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chapter_map: Option<String>,
}

fn default_locale() -> String {
    "zh-CN".to_owned()
}
