//! Graph validation and formula feedback, independent of Lean availability.
use crate::{feedback::*, formula, graph::*, library::ProofLibrary, model::*};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) fn diagnostic(
    code: &str,
    message: impl Into<String>,
    node: Option<&str>,
) -> ProofDiagnostic {
    ProofDiagnostic {
        severity: DiagnosticSeverity::Error,
        code: code.into(),
        message: message.into(),
        detail: None,
        node: node.map(str::to_owned),
        port: None,
        field: None,
        edge: None,
    }
}
pub(crate) fn empty_result() -> ProofCheckResult {
    ProofCheckResult {
        status: ProofStatus::Incomplete,
        nodes: BTreeMap::new(),
        ports: BTreeMap::new(),
        locals: BTreeMap::new(),
        fields: BTreeMap::new(),
        diagnostics: Vec::new(),
        elapsed_ms: 0,
    }
}
pub(crate) fn ports(library: &ProofLibrary, node: &ProofGraphNode) -> NodePorts {
    node_ports(
        node,
        node.card
            .as_deref()
            .and_then(|id| library.card(id))
            .map_or(0, |c| c.premises.len()),
    )
}
pub(crate) fn valid_node_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id.as_bytes()[0].is_ascii_alphabetic()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
/// Nodes upstream of an input, following value edges only. Local edges are binders, not dependencies.
pub(crate) fn upstream(graph: &ProofGraph, node: &str, port: Option<&str>) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    let mut stack: Vec<String> = graph
        .edges
        .iter()
        .filter(|e| e.to == node && port.is_none_or(|p| e.to_port == p) && e.from_port == "out")
        .map(|e| e.from.clone())
        .collect();
    while let Some(id) = stack.pop() {
        if seen.insert(id.clone()) {
            stack.extend(
                graph
                    .edges
                    .iter()
                    .filter(|e| e.to == id && e.from_port == "out")
                    .map(|e| e.from.clone()),
            );
        }
    }
    seen
}
/// Nodes upstream of the scoped input (local edges do not create dependencies).
pub(crate) fn scope_nodes(graph: &ProofGraph, owner: &str, scope: &str) -> BTreeSet<String> {
    upstream(graph, owner, Some(scope))
}

/// Every value-use path must stay in the branch or end at a dangling probe.
/// Checking all paths prevents a shared node from leaking a local to another branch.
pub(crate) fn local_allowed(graph: &ProofGraph, owner: &str, scope: &str, node: &str) -> bool {
    fn visit(
        graph: &ProofGraph,
        owner: &str,
        scope: &str,
        node: &str,
        seen: &mut BTreeSet<String>,
    ) -> bool {
        if !seen.insert(node.to_owned()) {
            return true;
        }
        if graph
            .nodes
            .iter()
            .any(|n| n.id == node && n.kind == ProofNodeKind::Goal)
        {
            return false;
        }
        graph
            .edges
            .iter()
            .filter(|e| e.from == node && e.from_port == "out")
            .all(|e| {
                if e.to == owner {
                    e.to_port == scope
                } else {
                    visit(graph, owner, scope, &e.to, seen)
                }
            })
    }
    visit(graph, owner, scope, node, &mut BTreeSet::new())
}

pub(crate) struct Validation {
    pub result: ProofCheckResult,
    pub broken: BTreeSet<String>,
    pub bad_edges: BTreeSet<usize>,
    pub parsed: BTreeMap<String, formula::Formula>,
}
pub(crate) fn validate(
    library: &ProofLibrary,
    puzzle: &PuzzleDefinition,
    graph: &ProofGraph,
) -> Validation {
    let mut v = Validation {
        result: empty_result(),
        broken: BTreeSet::new(),
        bad_edges: BTreeSet::new(),
        parsed: BTreeMap::new(),
    };
    if let Err(message) = crate::library::validate_draft_shape(graph) {
        v.result
            .diagnostics
            .push(diagnostic("graph", format!("证明图无效：{message}"), None));
        v.broken.extend(graph.nodes.iter().map(|n| n.id.clone()));
    }
    if graph
        .nodes
        .iter()
        .filter(|n| n.kind == ProofNodeKind::Goal)
        .count()
        != 1
    {
        v.result
            .diagnostics
            .push(diagnostic("graph", "证明图必须恰好有一个目标节点", None));
    }
    let mut ids = BTreeSet::new();
    let mut binder_names: BTreeSet<String> =
        puzzle.variables.iter().map(|n| n.name.clone()).collect();
    for node in &graph.nodes {
        let mut errors = Vec::new();
        if !valid_node_id(&node.id) || !ids.insert(node.id.clone()) {
            errors.push("节点标识无效或重复");
        }
        if !matches!(node.kind, ProofNodeKind::Given | ProofNodeKind::Goal)
            && !puzzle.allowed_kinds().contains(&node.kind)
        {
            errors.push("本题不允许此类节点");
        }
        match node.kind {
            ProofNodeKind::Given
                if !puzzle
                    .hypotheses
                    .iter()
                    .any(|h| Some(&h.name) == node.hypothesis.as_ref()) =>
            {
                errors.push("已知条件不存在")
            }
            ProofNodeKind::Card => match node.card.as_deref().and_then(|id| library.card(id)) {
                Some(card) if puzzle.cards.contains(&card.id) => {
                    if node
                        .args
                        .as_ref()
                        .is_some_and(|a| a.len() != card.params.len())
                    {
                        errors.push("定理卡参数数量不正确");
                    }
                }
                _ => errors.push("本题不允许此定理卡"),
            },
            ProofNodeKind::Auto if node.tactic.is_none_or(|t| !puzzle.tactics.contains(&t)) => {
                errors.push("本题不允许此自动推导方法")
            }
            ProofNodeKind::Claim if node.statement.as_ref().is_none_or(|s| s.trim().is_empty()) => {
                errors.push("请填写断言")
            }
            ProofNodeKind::Inst | ProofNodeKind::ExistsIntro
                if node.term.as_ref().is_none_or(|s| s.trim().is_empty()) =>
            {
                errors.push("请填写代入项或见证")
            }
            ProofNodeKind::Intro if node.binders.as_ref().is_none_or(Vec::is_empty) => {
                errors.push("请填写至少一个引入名称")
            }
            ProofNodeKind::ExistsElim | ProofNodeKind::Induction
                if node.binders.as_ref().is_none_or(|b| b.len() != 1) =>
            {
                errors.push("请填写一个变量名称")
            }
            _ => {}
        }
        for (i, name) in node.binders.iter().flatten().enumerate() {
            if !formula::is_valid_name(name) || !binder_names.insert(name.clone()) {
                let mut d = diagnostic(
                    "scope",
                    "变量名称无效、重复或与题目变量冲突",
                    Some(&node.id),
                );
                d.field = Some(format!("binders.{i}"));
                v.result.fields.insert(
                    format!("{}/binders.{i}", node.id),
                    FieldFeedback {
                        latex: None,
                        error: Some(d.message.clone()),
                    },
                );
                v.result.diagnostics.push(d);
                v.broken.insert(node.id.clone());
            }
        }
        for message in errors {
            v.result
                .diagnostics
                .push(diagnostic("graph", message, Some(&node.id)));
            v.broken.insert(node.id.clone());
        }
    }
    let by_id: BTreeMap<_, _> = graph.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut inputs = BTreeSet::new();
    for (i, edge) in graph.edges.iter().enumerate() {
        let problem = if edge.from == edge.to {
            Some(("graph", "节点不能连接自身"))
        } else {
            match (by_id.get(edge.from.as_str()), by_id.get(edge.to.as_str())) {
                (Some(from), Some(to)) => {
                    let fp = ports(library, from);
                    let tp = ports(library, to);
                    if !fp.is_source(&edge.from_port) || tp.input(&edge.to_port).is_none() {
                        Some(("graph", "连线端口不存在"))
                    } else if !tp.input(&edge.to_port).unwrap().multi
                        && !inputs.insert((edge.to.clone(), edge.to_port.clone()))
                    {
                        Some(("graph", "此输入端口只能连接一条线"))
                    } else if let Some(local) = fp.local(&edge.from_port) {
                        if !local_allowed(graph, &from.id, &local.scope, &to.id) {
                            Some(("scope", "局部变量只能在所属分支内使用"))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
                _ => Some(("graph", "连线节点不存在")),
            }
        };
        if let Some((code, message)) = problem {
            let mut d = diagnostic(code, message, Some(&edge.to));
            d.port = Some(edge.to_port.clone());
            d.edge = Some(i);
            v.result.diagnostics.push(d);
            v.bad_edges.insert(i);
        }
    }
    // Kahn's algorithm excludes local references (a binder feeding its own body is legal).
    let mut remaining: BTreeSet<_> = graph.nodes.iter().map(|n| n.id.clone()).collect();
    loop {
        let ready: Vec<_> = remaining
            .iter()
            .filter(|id| {
                !graph
                    .edges
                    .iter()
                    .any(|e| e.from_port == "out" && &e.to == *id && remaining.contains(&e.from))
            })
            .cloned()
            .collect();
        if ready.is_empty() {
            break;
        }
        for id in ready {
            remaining.remove(&id);
        }
    }
    for id in remaining {
        v.result
            .diagnostics
            .push(diagnostic("graph", "证明图不能有循环依赖", Some(&id)));
        v.broken.insert(id);
    }
    for node in &graph.nodes {
        let mut names: BTreeSet<_> = puzzle.variables.iter().map(|n| n.name.clone()).collect();
        for owner in &graph.nodes {
            for local in ports(library, owner).locals {
                if node.id != owner.id && local_allowed(graph, &owner.id, &local.scope, &node.id) {
                    names.extend(owner.binders.iter().flatten().cloned());
                }
            }
        }
        let fields = node
            .args
            .iter()
            .flatten()
            .enumerate()
            .filter(|(_, s)| !s.trim().is_empty())
            .map(|(i, s)| (format!("args.{i}"), s))
            .chain(node.statement.iter().map(|s| ("statement".into(), s)))
            .chain(node.term.iter().map(|s| ("term".into(), s)));
        for (field, text) in fields {
            let key = format!("{}/{field}", node.id);
            match formula::parse_formula(text, &|name| names.contains(name)) {
                Ok(ast) => {
                    v.result.fields.insert(
                        key.clone(),
                        FieldFeedback {
                            latex: Some(ast.to_latex()),
                            error: None,
                        },
                    );
                    v.parsed.insert(key, ast);
                }
                Err(error) => {
                    let code = if error.message.contains("名称")
                        || error.message.contains("声明")
                        || error.message.contains("变量")
                    {
                        "scope"
                    } else {
                        "syntax"
                    };
                    let mut d = diagnostic(code, error.message.clone(), Some(&node.id));
                    d.field = Some(field);
                    v.result.fields.insert(
                        key,
                        FieldFeedback {
                            latex: None,
                            error: Some(error.message),
                        },
                    );
                    v.result.diagnostics.push(d);
                    v.broken.insert(node.id.clone());
                }
            }
        }
    }
    v
}
