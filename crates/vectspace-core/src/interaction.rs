//! Scene-owned interaction state shared by desktop hosts and editor previews.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::model::{ScalarValue, SceneNode, StoryLocation, VariableMap};

pub const MAIN_TITLE_VARIABLE: &str = "window.main.title";
pub const SECONDARY_TITLE_VARIABLE: &str = "window.secondary.title";
pub const DEFAULT_MAIN_TITLE: &str = "VECTSPACE";
pub const DEFAULT_SECONDARY_TITLE: &str = "VECTSPACE — 副窗口";
pub const MIN_TIMER_INTERVAL_MS: u64 = 50;
pub const MAX_SCENE_TIMERS: usize = 64;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WindowRole {
    #[default]
    Main,
    Secondary,
}

impl WindowRole {
    pub fn is_main(value: &Self) -> bool {
        *value == Self::Main
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WindowControlAction {
    Block,
    Unblock,
    Advance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TimerAction {
    Start,
    Stop,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UpdateKind {
    #[default]
    Story,
    StateRefresh,
    Effect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WindowTitles {
    pub main: String,
    pub secondary: String,
}

impl Default for WindowTitles {
    fn default() -> Self {
        Self { main: DEFAULT_MAIN_TITLE.to_owned(), secondary: String::new() }
    }
}

impl WindowTitles {
    pub fn variables(&self) -> VariableMap {
        BTreeMap::from([
            (MAIN_TITLE_VARIABLE.to_owned(), ScalarValue::Text(self.main.clone())),
            (SECONDARY_TITLE_VARIABLE.to_owned(), ScalarValue::Text(self.secondary.clone())),
        ])
    }

    pub fn set(&mut self, target: WindowRole, title: String) {
        match target {
            WindowRole::Main => self.main = title,
            WindowRole::Secondary => self.secondary = title,
        }
    }
}

pub fn is_window_variable(id: &str) -> bool {
    matches!(id, MAIN_TITLE_VARIABLE | SECONDARY_TITLE_VARIABLE)
}

pub fn validate_title(title: &str) -> Result<(), String> {
    if title.len() > 4096 || title.chars().any(char::is_control) {
        return Err("窗口标题不能超过 4096 字节或包含控制字符".to_owned());
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AdvanceBlock {
    pub id: String,
    pub source: WindowRole,
    pub source_scene: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_template: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SceneTimer {
    pub target: String,
    pub remaining_ms: u64,
    pub interval_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct InteractionSnapshot {
    pub titles: WindowTitles,
    pub blocks: Vec<AdvanceBlock>,
    pub timers: BTreeMap<String, SceneTimer>,
    /// Changes only when a new prompt occurrence is entered, never on refresh.
    pub prompt_instance: String,
    pub prompt_source: Option<StoryLocation>,
}

/// What a [`WindowPlacement`] is measured against.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WindowReference {
    /// The work area (screen minus taskbar) of the target window's monitor.
    #[default]
    WorkArea,
    /// The other game window's frame.
    Window,
    /// The target window's own current frame (a relative nudge).
    Current,
}

/// Puts the window's anchor point (fractions of the window frame) on a point
/// of the reference rect (fractions of that rect), plus an offset in logical
/// pixels.  `x: 1, y: 0.5, anchor_x: 0, anchor_y: 0.5, offset_x: 16` with the
/// other window as reference docks the target to its right with a 16px gap.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WindowPlacement {
    #[serde(default)]
    pub relative_to: WindowReference,
    pub x: f32,
    pub y: f32,
    pub anchor_x: f32,
    pub anchor_y: f32,
    #[serde(default)]
    pub offset_x: f32,
    #[serde(default)]
    pub offset_y: f32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WindowSizeUnit {
    /// Client-area size in logical pixels.
    #[default]
    Logical,
    /// Fractions of the monitor work area, frame included.
    WorkArea,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WindowSize {
    #[serde(default)]
    pub unit: WindowSizeUnit,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WindowLayerAction {
    /// Above the other windows, without taking keyboard focus.
    Raise,
    /// Activate the window and take keyboard focus.
    Focus,
    /// Always above other applications until `normal`.
    Top,
    /// Always below other applications until `normal`.
    Bottom,
    Normal,
}

pub const MAX_WINDOW_OFFSET: f32 = 10_000.0;
pub const MAX_WINDOW_LOGICAL_SIZE: f32 = 10_000.0;

/// Content-level bounds of a geometry node; the host additionally clamps the
/// result to the monitor and the window's minimum size.
pub fn validate_window_geometry(
    position: Option<&WindowPlacement>,
    size: Option<&WindowSize>,
) -> Result<(), String> {
    if position.is_none() && size.is_none() {
        return Err("window_geometry 至少要设置位置或大小".to_owned());
    }
    if let Some(placement) = position {
        let points = [placement.x, placement.y];
        let anchors = [placement.anchor_x, placement.anchor_y];
        let offsets = [placement.offset_x, placement.offset_y];
        if points.iter().any(|value| !value.is_finite() || value.abs() > 4.0)
            || anchors.iter().any(|value| !(0.0..=1.0).contains(value))
            || offsets
                .iter()
                .any(|value| !value.is_finite() || value.abs() > MAX_WINDOW_OFFSET)
        {
            return Err(
                "窗口位置无效：x/y 在 -4..4，锚点在 0..1，偏移不超过 ±10000".to_owned(),
            );
        }
    }
    if let Some(size) = size {
        let valid = match size.unit {
            WindowSizeUnit::Logical => [size.width, size.height]
                .iter()
                .all(|value| (1.0..=MAX_WINDOW_LOGICAL_SIZE).contains(value)),
            WindowSizeUnit::WorkArea => [size.width, size.height]
                .iter()
                .all(|value| *value > 0.0 && *value <= 1.0),
        };
        if !valid {
            return Err(
                "窗口大小无效：逻辑像素在 1..10000，工作区比例在 0..1（不含 0）".to_owned(),
            );
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
pub enum WindowRequest {
    Title { target: WindowRole, title: String },
    Control {
        target: WindowRole,
        action: WindowControlAction,
        id: String,
        message: String,
    },
    Geometry {
        target: WindowRole,
        position: Option<WindowPlacement>,
        size: Option<WindowSize>,
        duration_ms: u64,
        easing: crate::model::Easing,
    },
    Layer {
        target: WindowRole,
        action: WindowLayerAction,
    },
}

/// Timer callbacks run effects, not a second story thread. In particular they
/// cannot create an acknowledgement boundary or change the active prompt.
pub fn timer_target_allowed(node: &SceneNode) -> bool {
    match node {
        SceneNode::Set { .. } | SceneNode::Sfx { .. } | SceneNode::Particle { .. }
        | SceneNode::WindowTitle { .. } | SceneNode::WindowControl { .. }
        | SceneNode::WindowLayer { .. } => true,
        SceneNode::WindowGeometry { await_completion, .. } => !await_completion,
        SceneNode::Background { await_completion, .. }
        | SceneNode::Sprite { await_completion, .. }
        | SceneNode::Action { await_completion, .. }
        | SceneNode::Timeline { await_completion, .. }
        | SceneNode::Bgm { await_completion, .. }
        | SceneNode::Ambience { await_completion, .. }
        | SceneNode::Camera { await_completion, .. }
        | SceneNode::ScreenEffect { await_completion, .. }
        | SceneNode::Curtain { await_completion, .. }
        | SceneNode::UiMotionPlay { await_completion, .. } => !await_completion,
        _ => false,
    }
}
