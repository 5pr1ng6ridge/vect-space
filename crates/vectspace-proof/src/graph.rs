//! The player's proof graph (wire + save format) and the port layout of each
//! node kind. `packages/presentation-core/src/proof.ts` mirrors [`node_ports`].

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::model::{AutoTactic, ProofNodeKind};

pub const MAX_NODES: usize = 200;
pub const MAX_EDGES: usize = 400;
pub const MAX_FORMULA_CHARS: usize = 200;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProofGraph {
    #[serde(default)]
    pub nodes: Vec<ProofGraphNode>,
    #[serde(default)]
    pub edges: Vec<ProofGraphEdge>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProofGraphNode {
    pub id: String,
    pub kind: ProofNodeKind,
    /// Board position; UI only, ignored by verification.
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    /// `given`: the puzzle hypothesis this node stands for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hypothesis: Option<String>,
    /// `card`: the card id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<String>,
    /// `card`: one formula per card parameter; empty = let Lean infer it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// Proposition the node proves (required for `claim`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub statement: Option<String>,
    /// `inst` / `exists_intro`: the term to substitute or the witness.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub term: Option<String>,
    /// `auto`: the recipe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tactic: Option<AutoTactic>,
    /// `intro`: introduced names (≥ 1); `exists_elim`: `[x]`; `induction`: `[k]`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binders: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProofGraphEdge {
    pub from: String,
    /// `out`, or a local `l0`, `l1`, … of the source node.
    pub from_port: String,
    pub to: String,
    pub to_port: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputPort {
    pub id: String,
    /// Accepts any number of edges (`auto`'s `facts`); not type-checked.
    pub multi: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalPort {
    pub id: String,
    /// The input port of the same node inside which this binder is visible.
    pub scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodePorts {
    pub inputs: Vec<InputPort>,
    pub has_output: bool,
    pub locals: Vec<LocalPort>,
}

impl NodePorts {
    pub fn input(&self, id: &str) -> Option<&InputPort> {
        self.inputs.iter().find(|port| port.id == id)
    }

    pub fn local(&self, id: &str) -> Option<&LocalPort> {
        self.locals.iter().find(|port| port.id == id)
    }

    /// Whether `id` names something an edge may start from.
    pub fn is_source(&self, id: &str) -> bool {
        (self.has_output && id == "out") || self.local(id).is_some()
    }
}

/// Port layout of a node. `card_premises` is the premise count of the node's
/// card (0 when unknown); intro locals follow its binder count (at least 1).
pub fn node_ports(node: &ProofGraphNode, card_premises: usize) -> NodePorts {
    fn single(ids: &[&str]) -> Vec<InputPort> {
        ids.iter().map(|id| InputPort { id: (*id).to_owned(), multi: false }).collect()
    }
    fn locals(scopes: &[&str]) -> Vec<LocalPort> {
        scopes
            .iter()
            .enumerate()
            .map(|(index, scope)| LocalPort { id: format!("l{index}"), scope: (*scope).to_owned() })
            .collect()
    }
    let (inputs, locals) = match node.kind {
        ProofNodeKind::Given => (Vec::new(), Vec::new()),
        ProofNodeKind::Goal => (single(&["in"]), Vec::new()),
        ProofNodeKind::Card => (
            (0..card_premises)
                .map(|index| InputPort { id: format!("p{index}"), multi: false })
                .collect(),
            Vec::new(),
        ),
        ProofNodeKind::Mp => (single(&["imp", "arg"]), Vec::new()),
        ProofNodeKind::Inst => (single(&["all"]), Vec::new()),
        ProofNodeKind::Intro => {
            let count = node.binders.as_ref().map_or(1, |binders| binders.len().max(1));
            (single(&["body"]), locals(&vec!["body"; count]))
        }
        ProofNodeKind::Cases => (single(&["or", "left", "right"]), locals(&["left", "right"])),
        ProofNodeKind::ExistsIntro => (single(&["proof"]), Vec::new()),
        ProofNodeKind::ExistsElim => (single(&["exists", "body"]), locals(&["body", "body"])),
        ProofNodeKind::Induction => (single(&["base", "step"]), locals(&["step", "step"])),
        ProofNodeKind::Claim => (single(&["in"]), Vec::new()),
        ProofNodeKind::Auto => (vec![InputPort { id: "facts".to_owned(), multi: true }], Vec::new()),
    };
    NodePorts { inputs, has_output: node.kind != ProofNodeKind::Goal, locals }
}
