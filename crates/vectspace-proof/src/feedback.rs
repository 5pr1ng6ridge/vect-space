//! What the board gets back: the board spec when a puzzle opens, and the
//! result of every check (`docs/proof-system.md` §6).

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::graph::ProofGraph;
use crate::model::{AutoTactic, ProofNodeKind};

/// A proposition or type for display: Lean/formula text plus LaTeX when the
/// display parser understood it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProofFormula {
    pub text: String,
    pub latex: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProofStatus {
    /// Lean accepted the goal-reachable proof without `sorry`.
    Complete,
    Incomplete,
    /// Lean could not run; structural and formula feedback is still filled.
    Unavailable,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NodeFeedback {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<ProofFormula>,
    /// The node's value still depends on a hole or an error.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sorry: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PortMismatch {
    pub expected: ProofFormula,
    pub actual: ProofFormula,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PortFeedback {
    /// What the port needs, as Lean elaborated it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<ProofFormula>,
    /// Unconnected port that Lean reached (a hole to fill).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub open: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mismatch: Option<PortMismatch>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LocalFeedback {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<ProofFormula>,
}

/// A player-typed formula field (`ID/statement`, `ID/term`, `ID/args.0`, …).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FieldFeedback {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProofDiagnostic {
    pub severity: DiagnosticSeverity,
    /// `graph`, `syntax`, `scope`, `not_connected`, `open_port`, `mismatch`,
    /// `unknown_name`, `tactic_failed`, `lean`, `unavailable`, `timeout`.
    pub code: String,
    /// Chinese, for the player.
    pub message: String,
    /// Raw Lean text, shown collapsed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    /// Index into `ProofGraph::edges`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProofCheckResult {
    pub status: ProofStatus,
    /// Keyed by node id.
    pub nodes: BTreeMap<String, NodeFeedback>,
    /// Keyed by `ID/PORT` (`goal/in` for the goal).
    pub ports: BTreeMap<String, PortFeedback>,
    /// Keyed by `ID/lI`.
    pub locals: BTreeMap<String, LocalFeedback>,
    /// Keyed by `ID/statement`, `ID/term`, `ID/args.I`, `ID/binders.I`.
    pub fields: BTreeMap<String, FieldFeedback>,
    pub diagnostics: Vec<ProofDiagnostic>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BoardNamedFormula {
    pub name: String,
    pub r#type: ProofFormula,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BoardHypothesis {
    pub name: String,
    pub label: Option<String>,
    pub statement: ProofFormula,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BoardPuzzle {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub variables: Vec<BoardNamedFormula>,
    pub hypotheses: Vec<BoardHypothesis>,
    pub goal: ProofFormula,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BoardCard {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub params: Vec<BoardNamedFormula>,
    pub premises: Vec<ProofFormula>,
    pub conclusion: ProofFormula,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BoardTactic {
    pub id: AutoTactic,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ProofBoardSpec {
    pub puzzle: BoardPuzzle,
    pub cards: Vec<BoardCard>,
    /// Placeable kinds, palette order; never `given`/`goal`.
    pub node_kinds: Vec<ProofNodeKind>,
    pub tactics: Vec<BoardTactic>,
    /// `given` nodes and the goal, laid out; the host substitutes a saved
    /// draft when there is one.
    pub initial_graph: ProofGraph,
}
