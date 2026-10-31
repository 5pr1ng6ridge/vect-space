//! Authored proof content: theorem cards and puzzles (`game/proofs/*.yaml`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::graph::ProofGraph;

/// One `proofs/*.yaml` document. Card and puzzle ids are unique across all
/// proof documents of a project; a puzzle may use cards from any document.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProofDocument {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cards: Vec<CardDefinition>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub puzzles: Vec<PuzzleDefinition>,
}

/// A declared name and its type, both in the formula language.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NamedType {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CardDefinition {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Explicit parameters, in order. The player may fill each one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<NamedType>,
    /// Formulas over `params`; premise `i` is input port `p{i}`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub premises: Vec<String>,
    pub conclusion: String,
    /// Trusted Lean term proving `conclusion`, with params and premises
    /// `p0, p1, …` in scope. The only Lean text not generated from an AST.
    pub lean: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HypothesisDefinition {
    pub name: String,
    pub statement: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PuzzleDefinition {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variables: Vec<NamedType>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hypotheses: Vec<HypothesisDefinition>,
    pub goal: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cards: Vec<String>,
    /// Allowed node kinds besides `given`/`goal`; `None` = every kind except
    /// `auto` (see [`PuzzleDefinition::allowed_kinds`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nodes: Option<Vec<ProofNodeKind>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tactics: Vec<AutoTactic>,
    /// Reference solution, verified by `npm run proofs:check`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solution: Option<ProofGraph>,
}

impl PuzzleDefinition {
    /// Node kinds the player may place (never `given`/`goal`).
    pub fn allowed_kinds(&self) -> Vec<ProofNodeKind> {
        match &self.nodes {
            Some(kinds) => ProofNodeKind::PLACEABLE
                .into_iter()
                .filter(|kind| kinds.contains(kind))
                .collect(),
            None => ProofNodeKind::PLACEABLE
                .into_iter()
                .filter(|kind| *kind != ProofNodeKind::Auto)
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProofNodeKind {
    Given,
    Goal,
    Card,
    Mp,
    Inst,
    Intro,
    Cases,
    ExistsIntro,
    ExistsElim,
    Induction,
    Claim,
    Auto,
}

impl ProofNodeKind {
    /// Kinds a puzzle can allow and the player can place, in palette order.
    pub const PLACEABLE: [ProofNodeKind; 10] = [
        ProofNodeKind::Card,
        ProofNodeKind::Mp,
        ProofNodeKind::Inst,
        ProofNodeKind::Intro,
        ProofNodeKind::Cases,
        ProofNodeKind::ExistsIntro,
        ProofNodeKind::ExistsElim,
        ProofNodeKind::Induction,
        ProofNodeKind::Claim,
        ProofNodeKind::Auto,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ProofNodeKind::Given => "given",
            ProofNodeKind::Goal => "goal",
            ProofNodeKind::Card => "card",
            ProofNodeKind::Mp => "mp",
            ProofNodeKind::Inst => "inst",
            ProofNodeKind::Intro => "intro",
            ProofNodeKind::Cases => "cases",
            ProofNodeKind::ExistsIntro => "exists_intro",
            ProofNodeKind::ExistsElim => "exists_elim",
            ProofNodeKind::Induction => "induction",
            ProofNodeKind::Claim => "claim",
            ProofNodeKind::Auto => "auto",
        }
    }

    /// Whether the node only elaborates against an expected type unless the
    /// player states one (`statement`).
    pub fn needs_expected_type(self) -> bool {
        matches!(
            self,
            ProofNodeKind::Intro
                | ProofNodeKind::Cases
                | ProofNodeKind::ExistsIntro
                | ProofNodeKind::ExistsElim
                | ProofNodeKind::Induction
                | ProofNodeKind::Auto
        )
    }
}

/// Automation recipes an `auto` node may run (`docs/proof-system.md` §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutoTactic {
    Omega,
    Decide,
    Rfl,
    Simp,
    Exact,
    Contradiction,
}

impl AutoTactic {
    pub const ALL: [AutoTactic; 6] = [
        AutoTactic::Omega,
        AutoTactic::Decide,
        AutoTactic::Rfl,
        AutoTactic::Simp,
        AutoTactic::Exact,
        AutoTactic::Contradiction,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            AutoTactic::Omega => "omega",
            AutoTactic::Decide => "decide",
            AutoTactic::Rfl => "rfl",
            AutoTactic::Simp => "simp",
            AutoTactic::Exact => "exact",
            AutoTactic::Contradiction => "contradiction",
        }
    }

    /// The Lean tactic run after the facts are introduced and `vs_only`.
    pub fn recipe(self) -> &'static str {
        match self {
            AutoTactic::Omega => "omega",
            AutoTactic::Decide => "decide",
            AutoTactic::Rfl => "rfl",
            AutoTactic::Simp => "simp_all",
            AutoTactic::Exact => "assumption",
            AutoTactic::Contradiction => "contradiction",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            AutoTactic::Omega => "线性算术",
            AutoTactic::Decide => "判定",
            AutoTactic::Rfl => "按定义相等",
            AutoTactic::Simp => "化简",
            AutoTactic::Exact => "由已知",
            AutoTactic::Contradiction => "矛盾",
        }
    }
}
