use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::ui::ButtonSnapshot;
use super::variables::ConditionExpression;

/// Fixed 1920x1080 design space every resolved choice layout is expressed in.
/// Hosts scale the stage, they never re-flow the buttons themselves.
pub const CHOICE_STAGE_WIDTH: f32 = 1920.0;
pub const CHOICE_STAGE_HEIGHT: f32 = 1080.0;

/// Documented built-in fallback for a choice button that resolves to no
/// reusable template.  The dimensions mirror the shipped CSS choice panel
/// (full 980px panel width, 92px button min-height, 20px gap), so a legacy
/// authoring path and a template-less node render the same layout.
pub const CHOICE_FALLBACK_BUTTON_WIDTH: f32 = 980.0;
pub const CHOICE_FALLBACK_BUTTON_HEIGHT: f32 = 92.0;
/// Shipped CSS choice panel origin (`src/App.css`: `left: 470px; top: 360px`).
///
/// A node without `presentation` keeps exactly this top-left placement for
/// every option count, so existing content does not need a migration; the
/// resolved layout reports the equivalent group-centre anchor instead.
pub const CHOICE_FALLBACK_PANEL_X: f32 = 470.0;
pub const CHOICE_FALLBACK_PANEL_Y: f32 = 360.0;
/// Default centre of an explicitly presented group, in design pixels.
/// `960` is the horizontal centre of the 1920px stage and `540` the vertical
/// centre of the 1080px stage, so an opted-in node is centred by default.
pub const CHOICE_DEFAULT_ANCHOR_X: f32 = 960.0;
pub const CHOICE_DEFAULT_ANCHOR_Y: f32 = 540.0;
pub const CHOICE_DEFAULT_GAP: f32 = 20.0;

/// Direction of the resolved choice button flow around the anchor.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChoiceFlowDirection {
    #[default]
    Vertical,
    Horizontal,
}

/// Optional template-driven presentation for a `choice` node.
///
/// Every field has a documented default, so a node may opt in with only the
/// parts it wants to change.  Template and icon references are resolved by
/// the runtime, not the loader: a missing or wrong-kind reference becomes a
/// structured [`ChoiceDiagnostic`] on the snapshot and the item falls back to
/// the node template or to the built-in CSS button instead of locking the
/// story.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChoicePresentation {
    /// Reusable button template id (see [`ButtonTemplate`]).  Used by every
    /// visible option that does not name its own template.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// Horizontal centre of the resolved button group in design pixels.
    /// Valid range: `0..=1920` (see [`CHOICE_STAGE_WIDTH`]).
    #[serde(default = "default_choice_anchor_x")]
    pub anchor_x: f32,
    /// Vertical centre of the resolved button group in design pixels.
    /// Valid range: `0..=1080` (see [`CHOICE_STAGE_HEIGHT`]).
    #[serde(default = "default_choice_anchor_y")]
    pub anchor_y: f32,
    #[serde(default)]
    pub direction: ChoiceFlowDirection,
    #[serde(default = "default_choice_gap")]
    pub gap: f32,
    /// Node-wide width/height override for every resolved button.  When a
    /// side is omitted the resolved template's own dimension is used, or the
    /// built-in fallback when no template resolves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button_width: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button_height: Option<f32>,
}

fn default_choice_anchor_x() -> f32 {
    CHOICE_DEFAULT_ANCHOR_X
}

fn default_choice_anchor_y() -> f32 {
    CHOICE_DEFAULT_ANCHOR_Y
}

fn default_choice_gap() -> f32 {
    CHOICE_DEFAULT_GAP
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChoiceDefinition {
    pub id: String,
    pub label: String,
    pub next: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_if: Option<ConditionExpression>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled_if: Option<ConditionExpression>,
    /// Optional per-option template that wins over the node's default
    /// template before the built-in CSS fallback is used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// Optional `gui` asset id shown alongside the option label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// One structured problem found while resolving a choice prompt's
/// presentation.  Diagnostics never abort a story: the runtime falls back to
/// documented defaults and keeps the prompt usable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChoiceDiagnosticCode {
    MissingTemplate,
    MissingIcon,
    InvalidIconKind,
    InvalidDimension,
    InvalidGap,
    InvalidAnchor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChoiceDiagnostic {
    pub code: ChoiceDiagnosticCode,
    pub message: String,
    pub scene_id: String,
    pub node_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice_id: Option<String>,
}

/// Resolved template identity for one choice item.
///
/// `Fallback` is the built-in CSS choice button.  `Button` reuses the same
/// normalized state model as a story button instance, so hosts never need a
/// second skin format and choice skins stay in sync with `ButtonTemplate`.
/// The embedded snapshot's `id` mirrors the choice id and its
/// `x`/`y`/`width`/`height` mirror the item rect, so a host can render it
/// exactly like a story button without recomputing anything.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", content = "button", rename_all = "snake_case")]
pub enum ChoiceTemplateSnapshot {
    #[default]
    Fallback,
    Button(Box<ButtonSnapshot>),
}

/// Resolved choice flow in the fixed 1920x1080 design space.
///
/// `x`/`y`/`width`/`height` bound the whole visible group; each item carries
/// its own rect in [`ChoiceSnapshot`].  `anchor_x`/`anchor_y` are the
/// effective centre in design pixels: an explicitly presented node uses its
/// authored anchor, while a node without `presentation` reports the centre
/// equivalent to the shipped top-left CSS panel placement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChoiceLayoutSnapshot {
    pub stage_width: f32,
    pub stage_height: f32,
    pub anchor_x: f32,
    pub anchor_y: f32,
    pub direction: ChoiceFlowDirection,
    pub gap: f32,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Default for ChoiceLayoutSnapshot {
    fn default() -> Self {
        Self {
            stage_width: CHOICE_STAGE_WIDTH,
            stage_height: CHOICE_STAGE_HEIGHT,
            anchor_x: CHOICE_DEFAULT_ANCHOR_X,
            anchor_y: CHOICE_DEFAULT_ANCHOR_Y,
            direction: ChoiceFlowDirection::Vertical,
            gap: CHOICE_DEFAULT_GAP,
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChoiceSnapshot {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub template: ChoiceTemplateSnapshot,
    /// Effective item rect in the design space, re-resolved from the current
    /// content whenever the runtime loads a snapshot.
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}
