//! Safe graph-to-Lean generation and code-point source spans.
use crate::{
    check::CheckMode,
    feedback::*,
    formula,
    graph::*,
    library::ProofLibrary,
    model::*,
    validation::{self, Validation},
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
/// Lean position: one-based line and zero-based Unicode code-point column.
pub struct Position {
    pub line: usize,
    pub column: usize,
}
#[derive(Debug, Clone, Default, PartialEq, Eq)]
/// Graph element responsible for a generated source span.
pub struct Target {
    pub node: Option<String>,
    pub port: Option<String>,
    pub field: Option<String>,
    pub edge: Option<usize>,
}
#[derive(Debug, Clone)]
/// Half-open generated source range with its graph target.
pub struct SourceSpan {
    pub start: Position,
    pub end: Position,
    pub target: Target,
}
#[derive(Debug)]
/// Generated request, source attribution and pre-Lean validation feedback.
pub struct CompiledProof {
    pub source: String,
    pub spans: Vec<SourceSpan>,
    pub result: ProofCheckResult,
    pub reachable: BTreeSet<String>,
}
impl CompiledProof {
    /// Find the innermost span containing the complete Lean message range.
    pub fn target(&self, start: Position, end: Position) -> Option<&Target> {
        self.spans
            .iter()
            .filter(|s| s.start <= start && end <= s.end)
            .min_by_key(|s| {
                (
                    s.end.line - s.start.line,
                    s.end.column.saturating_sub(s.start.column),
                )
            })
            .map(|s| &s.target)
    }
}
#[derive(Default)]
struct Term {
    text: String,
    spans: Vec<(usize, usize, Target)>,
}
impl Term {
    fn text(s: impl Into<String>) -> Self {
        Self {
            text: s.into(),
            spans: Vec::new(),
        }
    }
    fn push(&mut self, other: Self) {
        let offset = self.text.chars().count();
        self.text.push_str(&other.text);
        self.spans.extend(
            other
                .spans
                .into_iter()
                .map(|(a, b, t)| (a + offset, b + offset, t)),
        );
    }
    fn raw(&mut self, s: &str) {
        self.text.push_str(s);
    }
    fn marked(mut self, target: Target) -> Self {
        self.spans.push((0, self.text.chars().count(), target));
        self
    }
    fn wrap(self, prefix: &str, suffix: &str) -> Self {
        let mut out = Self::text(prefix);
        out.push(self);
        out.raw(suffix);
        out
    }
}
fn target(node: &str) -> Target {
    Target {
        node: Some(node.into()),
        ..Target::default()
    }
}
fn hole(key: &str) -> Term {
    Term::text(format!(
        "(vs_hole% {})",
        serde_json::to_string(key).unwrap()
    ))
}
fn parse(text: &str) -> String {
    formula::parse_formula(text, &|_| true)
        .expect("validated authored formula")
        .to_lean()
}
/// Emit one validated authored theorem declaration.
pub fn card_source(card: &CardDefinition) -> String {
    let mut s = format!("theorem card.{}", card.id);
    for p in &card.params {
        s.push_str(&format!(" ({} : {})", p.name, parse(&p.ty)));
    }
    for (i, p) in card.premises.iter().enumerate() {
        s.push_str(&format!(" (p{i} : {})", parse(p)));
    }
    s.push_str(&format!(
        " : {} := {}\n",
        parse(&card.conclusion),
        card.lean
    ));
    s
}
/// Options shared by graph checks and authored-card validation.
pub const HEADER:&str="set_option autoImplicit false\nset_option Elab.async false\nset_option maxHeartbeats 200000\nset_option pp.fieldNotation false\nset_option pp.mvars false\n";

struct Generator<'a> {
    library: &'a ProofLibrary,
    puzzle: &'a PuzzleDefinition,
    graph: &'a ProofGraph,
    v: Validation,
    mode: CheckMode,
    probes: BTreeMap<String, Vec<usize>>,
    active: BTreeSet<String>,
}
impl Generator<'_> {
    fn field(&self, n: &ProofGraphNode, field: &str) -> Term {
        let key = format!("{}/{field}", n.id);
        self.v
            .parsed
            .get(&key)
            .map(|f| {
                Term::text(format!("({})", f.to_lean())).marked(Target {
                    field: Some(field.into()),
                    ..target(&n.id)
                })
            })
            .unwrap_or_else(|| hole(&n.id))
    }
    fn local_name(&self, index: usize, local: usize) -> String {
        let n = &self.graph.nodes[index];
        if n.kind == ProofNodeKind::Intro
            || (matches!(n.kind, ProofNodeKind::ExistsElim | ProofNodeKind::Induction)
                && local == 0)
        {
            n.binders
                .as_ref()
                .and_then(|b| b.get(local))
                .cloned()
                .unwrap_or_else(|| format!("vsL{index}_{local}"))
        } else {
            format!("vsL{index}_{local}")
        }
    }
    fn edge(&mut self, index: usize, env: &BTreeMap<String, String>) -> Term {
        let e = &self.graph.edges[index];
        let from = e.from.clone();
        let fp = e.from_port.clone();
        if self.v.bad_edges.contains(&index) {
            return hole(&format!("{}/{}", e.to, e.to_port));
        }
        let Some(ni) = self.graph.nodes.iter().position(|n| n.id == from) else {
            return hole(&from);
        };
        if fp == "out" {
            self.node(ni, env)
        } else {
            let key = format!("{from}/{fp}");
            if let Some(name) = env.get(&key) {
                Term::text(name.clone()).marked(Target {
                    edge: Some(index),
                    ..target(&e.to)
                })
            } else {
                if !self
                    .v
                    .result
                    .diagnostics
                    .iter()
                    .any(|d| d.edge == Some(index))
                {
                    let mut d = validation::diagnostic(
                        "scope",
                        "局部变量只能在所属分支内使用",
                        Some(&e.to),
                    );
                    d.edge = Some(index);
                    d.port = Some(e.to_port.clone());
                    self.v.result.diagnostics.push(d);
                }
                hole(&format!("{}/{}", e.to, e.to_port))
            }
        }
    }
    fn input(&mut self, n: &ProofGraphNode, port: &str, env: &BTreeMap<String, String>) -> Term {
        let key = format!("{}/{port}", n.id);
        let edge = self
            .graph
            .edges
            .iter()
            .position(|e| e.to == n.id && e.to_port == port);
        let child = edge
            .map(|i| self.edge(i, env))
            .unwrap_or_else(|| hole(&key));
        child
            .wrap(
                &format!("(vs_port% {} ", serde_json::to_string(&key).unwrap()),
                ")",
            )
            .marked(Target {
                port: Some(port.into()),
                ..target(&n.id)
            })
    }
    fn scoped(
        &mut self,
        index: usize,
        port: &str,
        locals: &[usize],
        env: &BTreeMap<String, String>,
    ) -> Term {
        let n = self.graph.nodes[index].clone();
        let mut env = env.clone();
        for &i in locals {
            env.insert(format!("{}/l{i}", n.id), self.local_name(index, i));
        }
        let body = self.input(&n, port, &env);
        let mut body = self.probe(&format!("{}/{port}", n.id), body, &env);
        for &i in locals.iter().rev() {
            body = body.wrap(
                &format!(
                    "(vs_local% \"{}/l{i}\" {} ",
                    n.id,
                    self.local_name(index, i)
                ),
                ")",
            );
        }
        body
    }
    fn probe(&mut self, key: &str, body: Term, env: &BTreeMap<String, String>) -> Term {
        if self.mode == CheckMode::Verify {
            return body;
        }
        let roots = self.probes.get(key).cloned().unwrap_or_default();
        if roots.is_empty() {
            return body;
        }
        let mut t = Term::text("(vs_probe% [");
        for (j, index) in roots.into_iter().enumerate() {
            if j > 0 {
                t.raw(", ");
            }
            t.push(self.node(index, env));
        }
        t.raw("] ");
        t.push(body);
        t.raw(")");
        t
    }
    fn node(&mut self, index: usize, env: &BTreeMap<String, String>) -> Term {
        let n = self.graph.nodes[index].clone();
        if self.v.broken.contains(&n.id) || !self.active.insert(n.id.clone()) {
            return hole(&n.id).marked(target(&n.id));
        }
        let mut term = match n.kind {
            ProofNodeKind::Given => Term::text(format!(
                "vsH{}",
                self.puzzle
                    .hypotheses
                    .iter()
                    .position(|h| Some(&h.name) == n.hypothesis.as_ref())
                    .unwrap_or(0)
            )),
            ProofNodeKind::Goal => self.input(&n, "in", env),
            ProofNodeKind::Card => {
                let c = self
                    .library
                    .card(n.card.as_deref().unwrap_or_default())
                    .unwrap();
                let params = c.params.len();
                let premises = c.premises.len();
                let mut t = Term::text(format!("(VS.card.{}", c.id));
                for i in 0..params {
                    t.raw(" ");
                    if n.args
                        .as_ref()
                        .and_then(|a| a.get(i))
                        .is_none_or(|s| s.trim().is_empty())
                    {
                        t.raw("_");
                    } else {
                        t.push(self.field(&n, &format!("args.{i}")));
                    }
                }
                for i in 0..premises {
                    t.raw(" ");
                    t.push(self.input(&n, &format!("p{i}"), env));
                }
                t.raw(")");
                t
            }
            ProofNodeKind::Mp | ProofNodeKind::Inst => {
                let mut t = self
                    .input(
                        &n,
                        if n.kind == ProofNodeKind::Mp {
                            "imp"
                        } else {
                            "all"
                        },
                        env,
                    )
                    .wrap("(", " ");
                t.push(if n.kind == ProofNodeKind::Mp {
                    self.input(&n, "arg", env)
                } else {
                    self.field(&n, "term")
                });
                t.raw(")");
                t
            }
            ProofNodeKind::Intro => {
                let count = n.binders.as_ref().unwrap().len();
                let mut t = Term::text(format!(
                    "(fun {} => ",
                    n.binders.as_ref().unwrap().join(" ")
                ));
                t.push(self.scoped(index, "body", &(0..count).collect::<Vec<_>>(), env));
                t.raw(")");
                t
            }
            ProofNodeKind::Cases => {
                let mut t = Term::text("(Or.elim ");
                t.push(self.input(&n, "or", env));
                for (i, port) in ["left", "right"].into_iter().enumerate() {
                    t.raw(&format!(" (fun {} => ", self.local_name(index, i)));
                    t.push(self.scoped(index, port, &[i], env));
                    t.raw(")");
                }
                t.raw(")");
                t
            }
            ProofNodeKind::ExistsIntro => {
                let mut t = Term::text("(Exists.intro ");
                t.push(self.field(&n, "term"));
                t.raw(" ");
                t.push(self.input(&n, "proof", env));
                t.raw(")");
                t
            }
            ProofNodeKind::ExistsElim => {
                let mut t = Term::text("(Exists.elim ");
                t.push(self.input(&n, "exists", env));
                t.raw(&format!(
                    " (fun {} {} => ",
                    self.local_name(index, 0),
                    self.local_name(index, 1)
                ));
                t.push(self.scoped(index, "body", &[0, 1], env));
                t.raw("))");
                t
            }
            ProofNodeKind::Induction => {
                let k = self.local_name(index, 0);
                let ih = self.local_name(index, 1);
                let mut t = Term::text(format!(
                    "(fun {k} => by induction {k} with | zero => exact "
                ));
                t.push(self.input(&n, "base", env));
                t.raw(&format!(" | succ {k} {ih} => exact "));
                t.push(self.scoped(index, "step", &[0, 1], env));
                t.raw(")");
                t
            }
            ProofNodeKind::Claim => self.input(&n, "in", env),
            ProofNodeKind::Auto => {
                let edges: Vec<_> = self
                    .graph
                    .edges
                    .iter()
                    .enumerate()
                    .filter(|(_, e)| e.to == n.id && e.to_port == "facts")
                    .map(|(i, _)| i)
                    .collect();
                let mut t = Term::text("(by ");
                for (i, e) in edges.iter().enumerate() {
                    t.raw(&format!("have vsF{i} := "));
                    t.push(self.edge(*e, env));
                    t.raw("; ");
                }
                t.raw(&format!(
                    "vs_only [{}]; ",
                    (0..edges.len())
                        .map(|i| format!("vsF{i}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
                t.push(Term::text(n.tactic.unwrap().recipe()).marked(Target {
                    field: Some("tactic".into()),
                    ..target(&n.id)
                }));
                t.raw(")");
                t
            }
        };
        if n.statement.is_some() {
            let mut t = Term::text("(show ");
            t.push(self.field(&n, "statement"));
            t.raw(" from ");
            t.push(term);
            t.raw(")");
            term = t;
        }
        self.active.remove(&n.id);
        term.wrap(&format!("(vs_node% \"{}\" ", n.id), ")")
            .marked(target(&n.id))
    }
}

/// Compile a validated library puzzle and an untrusted player graph.
pub fn compile(
    library: &ProofLibrary,
    puzzle: &PuzzleDefinition,
    graph: &ProofGraph,
    mode: CheckMode,
) -> CompiledProof {
    let v = validation::validate(library, puzzle, graph);
    let mut g = Generator {
        library,
        puzzle,
        graph,
        v,
        mode,
        probes: BTreeMap::new(),
        active: BTreeSet::new(),
    };
    let goal = graph
        .nodes
        .iter()
        .position(|n| n.kind == ProofNodeKind::Goal);
    let mut reachable = goal
        .map(|i| validation::upstream(graph, &graph.nodes[i].id, None))
        .unwrap_or_default();
    if let Some(i) = goal {
        reachable.insert(graph.nodes[i].id.clone());
    }
    if mode == CheckMode::Feedback {
        for (i, n) in graph.nodes.iter().enumerate() {
            if matches!(n.kind, ProofNodeKind::Goal | ProofNodeKind::Given)
                || graph
                    .edges
                    .iter()
                    .any(|e| e.from == n.id && e.from_port == "out")
            {
                continue;
            }
            if n.kind.needs_expected_type() && n.statement.is_none() {
                let mut d = validation::diagnostic(
                    "not_connected",
                    "连接此节点或填写要证明的命题后才能检查",
                    Some(&n.id),
                );
                d.severity = DiagnosticSeverity::Info;
                g.v.result.diagnostics.push(d);
                continue;
            }
            let deps = validation::upstream(graph, &n.id, None);
            let mut uses = deps;
            uses.insert(n.id.clone());
            let mut scopes = Vec::new();
            for owner in &graph.nodes {
                for local in validation::ports(library, owner).locals {
                    let key = format!("{}/{}", owner.id, local.id);
                    let by_edge = graph.edges.iter().any(|e| {
                        e.from == owner.id && e.from_port == local.id && uses.contains(&e.to)
                    });
                    let by_name = owner.binders.iter().flatten().any(|b| {
                        g.v.parsed.iter().any(|(k, f)| {
                            uses.iter().any(|id| k.starts_with(&format!("{id}/")))
                                && f.free_names().contains(b)
                        })
                    });
                    if by_edge || by_name {
                        scopes.push((key, format!("{}/{}", owner.id, local.scope)));
                    }
                }
            }
            // A nested scope's owner belongs to all its outer scopes; choose the deepest.
            scopes.sort_by_key(|(_, s)| {
                let (id, p) = s.split_once('/').unwrap();
                std::cmp::Reverse(validation::scope_nodes(graph, id, p).len())
            });
            let key = scopes.last().map(|(_, s)| s.clone()).unwrap_or_default();
            g.probes.entry(key).or_default().push(i);
        }
    }
    let mut source = HEADER.to_owned();
    source.push_str("namespace VS\n");
    for id in &puzzle.cards {
        if let Some(card) = library.card(id) {
            source.push_str(&card_source(card));
        }
    }
    source.push_str("end VS\n");
    let mut declaration = "theorem VS.puzzle".to_owned();
    for p in &puzzle.variables {
        declaration.push_str(&format!(" ({} : {})", p.name, parse(&p.ty)));
    }
    for (i, h) in puzzle.hypotheses.iter().enumerate() {
        declaration.push_str(&format!(" (vsH{i} : {})", parse(&h.statement)));
    }
    declaration.push_str(&format!(" : {} := vs_proof% ", parse(&puzzle.goal)));
    let body = if let Some(i) = goal {
        g.input(&graph.nodes[i], "in", &BTreeMap::new())
    } else {
        hole("goal/in")
    };
    let body = g.probe("", body, &BTreeMap::new());
    let line = source.lines().count() + 1;
    let offset = declaration.chars().count();
    let spans = body
        .spans
        .iter()
        .map(|(a, b, t)| SourceSpan {
            start: Position {
                line,
                column: a + offset,
            },
            end: Position {
                line,
                column: b + offset,
            },
            target: t.clone(),
        })
        .collect();
    source.push_str(&declaration);
    source.push_str(&body.text);
    source.push_str("\n#vs_verdict VS.puzzle\n");
    CompiledProof {
        source,
        spans,
        result: g.v.result,
        reachable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn innermost_unicode_span() {
        let mut t = Term::text("α ");
        t.push(Term::text("ω").marked(Target {
            field: Some("term".into()),
            ..target("a")
        }));
        let t = t.marked(target("a"));
        let c = CompiledProof {
            source: t.text,
            spans: t
                .spans
                .into_iter()
                .map(|(a, b, t)| SourceSpan {
                    start: Position { line: 1, column: a },
                    end: Position { line: 1, column: b },
                    target: t,
                })
                .collect(),
            result: validation::empty_result(),
            reachable: BTreeSet::new(),
        };
        assert_eq!(
            c.target(
                Position { line: 1, column: 2 },
                Position { line: 1, column: 3 }
            )
            .unwrap()
            .field
            .as_deref(),
            Some("term")
        );
    }
}
