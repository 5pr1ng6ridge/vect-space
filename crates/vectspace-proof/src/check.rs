//! Checking graphs with one persistent Lean server.
use crate::{
    feedback::*,
    graph::*,
    library::ProofLibrary,
    model::ProofNodeKind,
    server::{Server, ServerError},
    validation,
};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
/// Whether dangling nodes participate in elaboration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckMode {
    /// Probe dangling nodes for live board feedback.
    Feedback,
    /// Verify only the goal proof; every error prevents completion.
    Verify,
}
/// Locations and request timeout for the pinned Lean installation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeanConfig {
    /// Toolchain root containing Lean runtime libraries.
    pub sysroot: PathBuf,
    /// Built vectproofd executable.
    pub server: PathBuf,
    /// Directory containing the VectProof oleans.
    pub lean_path: PathBuf,
    /// Wall-clock deadline per proof request, after the server is ready.
    pub timeout: Duration,
}
/// Owns one persistent child; callers serialize checks through a host mutex.
pub struct ProofChecker {
    config: Option<LeanConfig>,
    server: Option<Server>,
    startup_error: Option<String>,
}
impl ProofChecker {
    /// A missing configuration preserves validation feedback but reports unavailable.
    pub fn new(config: Option<LeanConfig>) -> Self {
        Self {
            config,
            server: None,
            startup_error: None,
        }
    }
    /// Spawn the child and reader threads without waiting for Lean imports.
    pub fn warm_up(&mut self) {
        if self.server.is_none() {
            if let Some(config) = &self.config {
                match Server::spawn(config) {
                    Ok(server) => {
                        self.server = Some(server);
                        self.startup_error = None;
                    }
                    Err(e) => self.startup_error = Some(format!("{e:?}")),
                }
            }
        }
    }
    /// Checks trusted authored declarations too (used for cards not enabled in any puzzle).
    pub fn check_card_source(&mut self, source: &str) -> Result<serde_json::Value, String> {
        self.request(source).map_err(|e| format!("{e:?}"))
    }
    fn request(&mut self, source: &str) -> Result<serde_json::Value, ServerError> {
        let timeout = self
            .config
            .as_ref()
            .ok_or_else(|| ServerError::Crash("未找到 Lean".into()))?
            .timeout;
        for attempt in 0..2 {
            self.warm_up();
            let answer = if let Some(server) = &mut self.server {
                server.request(source, timeout)
            } else {
                Err(ServerError::Crash(
                    self.startup_error.clone().unwrap_or_default(),
                ))
            };
            match answer {
                Ok(value) => return Ok(value),
                Err(ServerError::Timeout) => {
                    self.server = None;
                    self.warm_up();
                    return Err(ServerError::Timeout);
                }
                Err(error) => {
                    self.server = None;
                    if attempt == 1 {
                        return Err(error);
                    }
                }
            }
        }
        unreachable!()
    }
    /// Validate, compile and check one graph against its puzzle.
    pub fn check(
        &mut self,
        library: &ProofLibrary,
        puzzle: &str,
        graph: &ProofGraph,
        mode: CheckMode,
    ) -> ProofCheckResult {
        let Some(puzzle) = library.puzzle(puzzle) else {
            let mut r = validation::empty_result();
            r.diagnostics
                .push(validation::diagnostic("graph", "题目不存在", None));
            return r;
        };
        let compiled = crate::compile::compile(library, puzzle, graph, mode);
        let started = Instant::now();
        match self.request(&compiled.source) {
            Ok(response) => {
                let mut result = crate::output::map_output(compiled, &response, mode);
                result.elapsed_ms = started.elapsed().as_millis() as u64;
                result
            }
            Err(error) => {
                let mut result = compiled.result;
                result.status = ProofStatus::Unavailable;
                let (code, message, detail) = match error {
                    ServerError::Timeout => ("timeout", "证明检查超时，请重试".to_owned(), None),
                    ServerError::Crash(detail) => (
                        "unavailable",
                        "无法启动 Lean 证明检查；请运行 npm run lean:build".into(),
                        Some(detail),
                    ),
                };
                let mut d = validation::diagnostic(code, message, None);
                d.detail = detail;
                result.diagnostics.push(d);
                result.elapsed_ms = started.elapsed().as_millis() as u64;
                result
            }
        }
    }
}
fn displayed(text: &str, type_position: bool) -> ProofFormula {
    let latex = crate::formula::parse_formula(text, &|_| true)
        .ok()
        .map(|f| {
            if type_position {
                f.to_latex_type()
            } else {
                f.to_latex()
            }
        });
    ProofFormula {
        text: text.into(),
        latex,
    }
}
fn named(n: &crate::model::NamedType) -> BoardNamedFormula {
    BoardNamedFormula {
        name: n.name.clone(),
        r#type: displayed(&n.ty, true),
    }
}
/// Build the palette and initial given/goal layout for a known puzzle.
pub fn board_spec(library: &ProofLibrary, puzzle: &str) -> Option<ProofBoardSpec> {
    let p = library.puzzle(puzzle)?;
    let mut nodes = Vec::new();
    for (i, h) in p.hypotheses.iter().enumerate() {
        nodes.push(ProofGraphNode {
            id: format!("given-{i}"),
            kind: ProofNodeKind::Given,
            x: 80.,
            y: 80. + i as f64 * 200.,
            hypothesis: Some(h.name.clone()),
            card: None,
            args: None,
            statement: None,
            term: None,
            tactic: None,
            binders: None,
        });
    }
    nodes.push(ProofGraphNode {
        id: "goal".into(),
        kind: ProofNodeKind::Goal,
        // Keeps the goal inside the visible canvas at 100% zoom.
        x: 960.,
        y: 220.,
        hypothesis: None,
        card: None,
        args: None,
        statement: None,
        term: None,
        tactic: None,
        binders: None,
    });
    Some(ProofBoardSpec {
        puzzle: BoardPuzzle {
            id: p.id.clone(),
            title: p.title.clone(),
            description: p.description.clone(),
            variables: p.variables.iter().map(named).collect(),
            hypotheses: p
                .hypotheses
                .iter()
                .map(|h| BoardHypothesis {
                    name: h.name.clone(),
                    label: h.label.clone(),
                    statement: displayed(&h.statement, false),
                })
                .collect(),
            goal: displayed(&p.goal, false),
        },
        cards: p
            .cards
            .iter()
            .filter_map(|id| library.card(id))
            .map(|c| BoardCard {
                id: c.id.clone(),
                name: c.name.clone(),
                description: c.description.clone(),
                params: c.params.iter().map(named).collect(),
                premises: c.premises.iter().map(|s| displayed(s, false)).collect(),
                conclusion: displayed(&c.conclusion, false),
            })
            .collect(),
        node_kinds: p.allowed_kinds(),
        tactics: p
            .tactics
            .iter()
            .map(|t| BoardTactic {
                id: *t,
                name: t.label().into(),
            })
            .collect(),
        initial_graph: ProofGraph {
            nodes,
            edges: vec![],
        },
    })
}
