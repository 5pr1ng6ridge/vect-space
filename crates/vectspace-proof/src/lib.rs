//! Proof-board activity: content model, the player's proof graph, its
//! compilation to Lean 4 and the mapping of Lean's answer back onto the graph.
//!
//! Tauri-independent. The design and every wire contract are in
//! `docs/proof-system.md`; the Lean side lives in `lean/`.

pub mod check;
pub mod compile;
mod output;
mod server;
mod validation;
pub mod feedback;
pub mod formula;
pub mod graph;
pub mod library;
pub mod model;

pub use check::{board_spec, CheckMode, LeanConfig, ProofChecker};
pub use feedback::*;
pub use graph::*;
pub use library::{validate_draft_shape, ProofContentIssue, ProofLibrary};
pub use model::*;
