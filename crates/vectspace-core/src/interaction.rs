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

#[derive(Debug, Clone, PartialEq)]
pub enum WindowRequest {
    Title { target: WindowRole, title: String },
    Control {
        target: WindowRole,
        action: WindowControlAction,
        id: String,
        message: String,
    },
}

/// Timer callbacks run effects, not a second story thread. In particular they
/// cannot create an acknowledgement boundary or change the active prompt.
pub fn timer_target_allowed(node: &SceneNode) -> bool {
    match node {
        SceneNode::Set { .. } | SceneNode::Sfx { .. }
        | SceneNode::WindowTitle { .. } | SceneNode::WindowControl { .. } => true,
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
