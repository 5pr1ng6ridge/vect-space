use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::variables::{ConditionExpression, VariableMap};

/// A room-sized chapter selector.  Coordinates are design pixels and are
/// deliberately kept independent from the story graph so authors can compose
/// a spatial map without changing story control flow.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChapterMapDefinition {
    pub schema_version: u32,
    #[serde(default = "default_chapter_map_width")]
    pub width: u32,
    #[serde(default = "default_chapter_map_height")]
    pub height: u32,
    #[serde(default = "default_chapter_map_view_x")]
    pub view_x: i32,
    #[serde(default = "default_chapter_map_view_y")]
    pub view_y: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(default)]
    pub decorations: Vec<ChapterMapDecoration>,
    #[serde(default)]
    pub hotspots: Vec<ChapterMapHotspot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChapterMapDecoration {
    pub id: String,
    pub asset: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub z: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChapterMapHotspot {
    pub id: String,
    pub scene_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hover_text: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub z: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<String>,
    #[serde(default)]
    pub reveal: ChapterMapReveal,
    /// Replay policy for this chapter.  Kept separate from `reveal` on
    /// purpose: visibility and enterability are different questions, so a
    /// hotspot may be shown but locked (default) or shown and enterable.
    #[serde(default)]
    pub replay: ChapterMapReplay,
    #[serde(default)]
    pub variable_overrides: VariableMap,
}

fn default_chapter_map_width() -> u32 {
    1920
}

fn default_chapter_map_height() -> u32 {
    1080
}

fn default_chapter_map_view_x() -> i32 {
    960
}

fn default_chapter_map_view_y() -> i32 {
    540
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChapterMapSnapshot {
    pub width: u32,
    pub height: u32,
    pub view_x: i32,
    pub view_y: i32,
    pub background: Option<String>,
    pub decorations: Vec<ChapterMapDecorationSnapshot>,
    pub hotspots: Vec<ChapterMapHotspotSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChapterMapDecorationSnapshot {
    pub id: String,
    pub asset: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub z: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChapterMapHotspotSnapshot {
    pub id: String,
    pub scene_id: String,
    pub title: String,
    pub hover_text: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub z: i32,
    pub asset: Option<String>,
    pub completed: bool,
    /// True when the hotspot may be entered right now.
    ///
    /// The room page must not report a hotspot as unreached while the author
    /// configured it as always replayable, so the resolved policy is sent to
    /// the WebView instead of letting it re-derive the rule.
    pub replayable: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChapterMapReveal {
    #[default]
    Completed,
    Always,
    Condition {
        condition: ConditionExpression,
    },
}

/// When the chapter may be entered from the room map.
///
/// `completed` is the historical behaviour: a chapter becomes replayable only
/// after the player finished it once.  `always` opens the hotspot before the
/// story ever reaches it, which is what makes an unreached chapter (a
/// showcase, an appendix, a debugging scene) enterable on purpose.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChapterMapReplay {
    #[default]
    Completed,
    Always,
}
