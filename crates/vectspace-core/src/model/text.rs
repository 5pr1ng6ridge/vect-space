use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DialogueMode {
    #[default]
    Start,
    Append,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LongTextMode {
    #[default]
    Start,
    Continue,
}

impl LongTextMode {
    pub(super) fn is_start(value: &Self) -> bool {
        *value == Self::Start
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LongTextExit {
    #[default]
    Close,
    Hide,
    KeepVisible,
}

impl LongTextExit {
    pub(super) fn is_close(value: &Self) -> bool {
        *value == Self::Close
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LongTextControlAction {
    Show,
    Hide,
    Close,
}

/// Player-selectable reveal styles. A story node may optionally override the
/// current player setting for a specific prompt.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TextRevealAnimation {
    LineSweep,
    #[default]
    Typewriter,
    DropFade,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LongTextPagination {
    Continuous,
    #[default]
    Auto,
    Manual,
}

pub const LONG_TEXT_FONT_SIZE_DEFAULT: f32 = 32.0;
pub const LONG_TEXT_FONT_SIZE_MIN: f32 = 16.0;
pub const LONG_TEXT_FONT_SIZE_MAX: f32 = 72.0;
pub const LONG_TEXT_COLOR_DEFAULT: &str = "#212533";
pub const LONG_TEXT_LAYOUT_X_DEFAULT: f32 = 340.0;
pub const LONG_TEXT_LAYOUT_Y_DEFAULT: f32 = 0.0;
pub const LONG_TEXT_LAYOUT_WIDTH_DEFAULT: f32 = 1240.0;
pub const LONG_TEXT_LAYOUT_HEIGHT_DEFAULT: f32 = 1080.0;
pub const LONG_TEXT_LAYOUT_PADDING_X_DEFAULT: f32 = 118.0;
pub const LONG_TEXT_LAYOUT_PADDING_Y_DEFAULT: f32 = 112.0;
pub const LONG_TEXT_LAYOUT_PAGE_HEIGHT_DEFAULT: f32 = 1340.0;
pub const LONG_TEXT_LAYOUT_PAGE_GAP_DEFAULT: f32 = 92.0;

pub(super) fn default_long_text_font_size() -> f32 {
    LONG_TEXT_FONT_SIZE_DEFAULT
}

pub(super) fn default_long_text_color() -> String {
    LONG_TEXT_COLOR_DEFAULT.to_owned()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LongTextLayout {
    #[serde(default = "default_long_text_layout_x")]
    pub x: f32,
    #[serde(default = "default_long_text_layout_y")]
    pub y: f32,
    #[serde(default = "default_long_text_layout_width")]
    pub width: f32,
    #[serde(default = "default_long_text_layout_height")]
    pub height: f32,
    #[serde(default = "default_long_text_layout_padding_x")]
    pub padding_x: f32,
    #[serde(default = "default_long_text_layout_padding_y")]
    pub padding_y: f32,
    #[serde(default = "default_long_text_layout_page_height")]
    pub page_height: f32,
    #[serde(default = "default_long_text_layout_page_gap")]
    pub page_gap: f32,
}

impl Default for LongTextLayout {
    fn default() -> Self {
        Self {
            x: LONG_TEXT_LAYOUT_X_DEFAULT,
            y: LONG_TEXT_LAYOUT_Y_DEFAULT,
            width: LONG_TEXT_LAYOUT_WIDTH_DEFAULT,
            height: LONG_TEXT_LAYOUT_HEIGHT_DEFAULT,
            padding_x: LONG_TEXT_LAYOUT_PADDING_X_DEFAULT,
            padding_y: LONG_TEXT_LAYOUT_PADDING_Y_DEFAULT,
            page_height: LONG_TEXT_LAYOUT_PAGE_HEIGHT_DEFAULT,
            page_gap: LONG_TEXT_LAYOUT_PAGE_GAP_DEFAULT,
        }
    }
}

fn default_long_text_layout_x() -> f32 {
    LONG_TEXT_LAYOUT_X_DEFAULT
}
fn default_long_text_layout_y() -> f32 {
    LONG_TEXT_LAYOUT_Y_DEFAULT
}
fn default_long_text_layout_width() -> f32 {
    LONG_TEXT_LAYOUT_WIDTH_DEFAULT
}
fn default_long_text_layout_height() -> f32 {
    LONG_TEXT_LAYOUT_HEIGHT_DEFAULT
}
fn default_long_text_layout_padding_x() -> f32 {
    LONG_TEXT_LAYOUT_PADDING_X_DEFAULT
}
fn default_long_text_layout_padding_y() -> f32 {
    LONG_TEXT_LAYOUT_PADDING_Y_DEFAULT
}
fn default_long_text_layout_page_height() -> f32 {
    LONG_TEXT_LAYOUT_PAGE_HEIGHT_DEFAULT
}
fn default_long_text_layout_page_gap() -> f32 {
    LONG_TEXT_LAYOUT_PAGE_GAP_DEFAULT
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LongTextStep {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub page_break_before: bool,
}
