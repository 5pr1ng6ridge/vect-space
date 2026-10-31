//! Validated authored proof documents.
use crate::{
    formula,
    graph::ProofGraph,
    model::{CardDefinition, NamedType, ProofDocument, ProofNodeKind, PuzzleDefinition},
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq)]
/// Content-author error at a precise document location.
pub struct ProofContentIssue {
    pub path: String,
    pub location: String,
    pub message: String,
}
#[derive(Debug, Clone, Default, PartialEq)]
/// All validated cards and puzzles across a project.
pub struct ProofLibrary {
    cards: BTreeMap<String, CardDefinition>,
    puzzles: BTreeMap<String, PuzzleDefinition>,
}
fn content_graph_message(code: &str, field: Option<&str>) -> &'static str {
    match (code, field) {
        ("syntax", _) => "formula failed strict parsing",
        ("scope", Some(f)) if f.starts_with("binders.") => {
            "invalid, duplicate or clashing binder name"
        }
        ("scope", Some(_)) => "formula uses a name outside its scope",
        ("scope", None) => "local edge escapes its binder scope",
        _ => "invalid node, port, whitelist, dependency or required field",
    }
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.as_bytes()[0].is_ascii_lowercase()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}
fn issue(
    issues: &mut Vec<ProofContentIssue>,
    path: &str,
    location: impl Into<String>,
    message: impl Into<String>,
) {
    issues.push(ProofContentIssue {
        path: path.into(),
        location: location.into(),
        message: message.into(),
    });
}
fn formula_issue(
    issues: &mut Vec<ProofContentIssue>,
    path: &str,
    location: String,
    text: &str,
    names: &BTreeSet<String>,
) {
    if let Err(e) = formula::parse_formula(text, &|n| names.contains(n)) {
        issue(
            issues,
            path,
            location,
            format!("formula failed strict parsing at character {}", e.offset),
        );
    }
}
fn declarations(
    issues: &mut Vec<ProofContentIssue>,
    path: &str,
    location: &str,
    declarations: &[NamedType],
    reserved: &BTreeSet<String>,
) -> BTreeSet<String> {
    let mut names = reserved.clone();
    for (i, declaration) in declarations.iter().enumerate() {
        formula_issue(
            issues,
            path,
            format!("{location}[{i}].type"),
            &declaration.ty,
            &names,
        );
        if !formula::is_valid_name(&declaration.name) || !names.insert(declaration.name.clone()) {
            issue(
                issues,
                path,
                format!("{location}[{i}].name"),
                format!("invalid or duplicate name `{}`", declaration.name),
            );
        }
    }
    names
}
impl ProofLibrary {
    /// Collect documents and validate names, formulas, whitelists and reference graphs.
    pub fn from_documents(
        documents: impl IntoIterator<Item = (String, ProofDocument)>,
    ) -> Result<Self, Vec<ProofContentIssue>> {
        let mut library = Self::default();
        let mut issues = Vec::new();
        let mut card_paths = BTreeMap::new();
        let mut puzzle_paths = BTreeMap::new();
        for (path, document) in documents {
            for card in document.cards {
                let loc = format!("cards[{}]", card.id);
                if !valid_id(&card.id) {
                    issue(&mut issues, &path, &loc, "id must match [a-z][a-z0-9_]*");
                }
                if library.cards.contains_key(&card.id) {
                    issue(
                        &mut issues,
                        &path,
                        loc,
                        format!("duplicate card id `{}`", card.id),
                    );
                    continue;
                }
                card_paths.insert(card.id.clone(), path.clone());
                library.cards.insert(card.id.clone(), card);
            }
            for puzzle in document.puzzles {
                let loc = format!("puzzles[{}]", puzzle.id);
                if !valid_id(&puzzle.id) {
                    issue(&mut issues, &path, &loc, "id must match [a-z][a-z0-9_]*");
                }
                if library.puzzles.contains_key(&puzzle.id) {
                    issue(
                        &mut issues,
                        &path,
                        loc,
                        format!("duplicate puzzle id `{}`", puzzle.id),
                    );
                    continue;
                }
                puzzle_paths.insert(puzzle.id.clone(), path.clone());
                library.puzzles.insert(puzzle.id.clone(), puzzle);
            }
        }
        for card in library.cards() {
            let path = &card_paths[&card.id];
            let loc = format!("cards[{}]", card.id);
            let reserved = (0..card.premises.len()).map(|i| format!("p{i}")).collect();
            let names = declarations(
                &mut issues,
                path,
                &format!("{loc}.params"),
                &card.params,
                &reserved,
            );
            // Premise names are Lean-only; authored formulas are over explicit parameters.
            let names = names.difference(&reserved).cloned().collect();
            for (i, s) in card.premises.iter().enumerate() {
                formula_issue(&mut issues, path, format!("{loc}.premises[{i}]"), s, &names);
            }
            formula_issue(
                &mut issues,
                path,
                format!("{loc}.conclusion"),
                &card.conclusion,
                &names,
            );
            if card.lean.trim().is_empty() {
                issue(
                    &mut issues,
                    path,
                    format!("{loc}.lean"),
                    "card proof must not be empty",
                );
            }
        }
        for puzzle in library.puzzles() {
            let path = &puzzle_paths[&puzzle.id];
            let loc = format!("puzzles[{}]", puzzle.id);
            let names = declarations(
                &mut issues,
                path,
                &format!("{loc}.variables"),
                &puzzle.variables,
                &BTreeSet::new(),
            );
            let mut all_names = names.clone();
            for (i, h) in puzzle.hypotheses.iter().enumerate() {
                if !formula::is_valid_name(&h.name) || !all_names.insert(h.name.clone()) {
                    issue(
                        &mut issues,
                        path,
                        format!("{loc}.hypotheses[{i}].name"),
                        format!("invalid or duplicate name `{}`", h.name),
                    );
                }
                formula_issue(
                    &mut issues,
                    path,
                    format!("{loc}.hypotheses[{i}].statement"),
                    &h.statement,
                    &names,
                );
            }
            formula_issue(
                &mut issues,
                path,
                format!("{loc}.goal"),
                &puzzle.goal,
                &names,
            );
            let mut seen = BTreeSet::new();
            for (i, id) in puzzle.cards.iter().enumerate() {
                if !library.cards.contains_key(id) {
                    issue(
                        &mut issues,
                        path,
                        format!("{loc}.cards[{i}]"),
                        format!("unknown card `{id}`"),
                    );
                }
                if !seen.insert(id) {
                    issue(
                        &mut issues,
                        path,
                        format!("{loc}.cards[{i}]"),
                        format!("duplicate card reference `{id}`"),
                    );
                }
            }
            if let Some(kinds) = &puzzle.nodes {
                let mut seen = BTreeSet::new();
                for (i, kind) in kinds.iter().enumerate() {
                    if !ProofNodeKind::PLACEABLE.contains(kind) || !seen.insert(kind) {
                        issue(
                            &mut issues,
                            path,
                            format!("{loc}.nodes[{i}]"),
                            "node kind must be placeable and unique",
                        );
                    }
                }
                if kinds.contains(&ProofNodeKind::Auto) && puzzle.tactics.is_empty() {
                    issue(
                        &mut issues,
                        path,
                        format!("{loc}.tactics"),
                        "auto nodes require at least one tactic",
                    );
                }
            }
            if puzzle.tactics.iter().collect::<BTreeSet<_>>().len() != puzzle.tactics.len() {
                issue(
                    &mut issues,
                    path,
                    format!("{loc}.tactics"),
                    "duplicate tactic",
                );
            }
            // Avoid invoking graph formula checks on invalid declarations.
            if let Some(graph) = &puzzle.solution {
                for d in crate::validation::validate(&library, puzzle, graph)
                    .result
                    .diagnostics
                {
                    let target = if let Some(i) = d.edge {
                        format!("edges[{i}]")
                    } else if let Some(n) = d.node {
                        format!(
                            "nodes[{n}]{}",
                            d.field
                                .as_ref()
                                .map(|f| format!(".{f}"))
                                .unwrap_or_default()
                        )
                    } else {
                        String::new()
                    };
                    issue(
                        &mut issues,
                        path,
                        format!("{loc}.solution.{target}"),
                        format!(
                            "invalid solution graph: {}",
                            content_graph_message(&d.code, d.field.as_deref())
                        ),
                    );
                }
            }
        }
        if issues.is_empty() {
            Ok(library)
        } else {
            Err(issues)
        }
    }
    /// Look up a theorem card by its project-wide id.
    pub fn card(&self, id: &str) -> Option<&CardDefinition> {
        self.cards.get(id)
    }
    /// Look up a puzzle by its project-wide id.
    pub fn puzzle(&self, id: &str) -> Option<&PuzzleDefinition> {
        self.puzzles.get(id)
    }
    /// Iterate cards in deterministic id order.
    pub fn cards(&self) -> impl Iterator<Item = &CardDefinition> {
        self.cards.values()
    }
    /// Iterate puzzles in deterministic id order.
    pub fn puzzles(&self) -> impl Iterator<Item = &PuzzleDefinition> {
        self.puzzles.values()
    }
}
/// Basic shape required for stored drafts, without puzzle-specific knowledge.
pub fn validate_draft_shape(graph: &ProofGraph) -> Result<(), String> {
    use crate::graph::{MAX_EDGES, MAX_FORMULA_CHARS, MAX_NODES};
    if graph.nodes.len() > MAX_NODES {
        return Err(format!("proof graph has more than {MAX_NODES} nodes"));
    }
    if graph.edges.len() > MAX_EDGES {
        return Err(format!("proof graph has more than {MAX_EDGES} edges"));
    }
    let mut ids = BTreeSet::new();
    for n in &graph.nodes {
        if !crate::validation::valid_node_id(&n.id) || !ids.insert(&n.id) {
            return Err(format!("invalid or duplicate node id `{}`", n.id));
        }
        if !n.x.is_finite() || !n.y.is_finite() {
            return Err(format!("node `{}` has a non-finite position", n.id));
        }
        for s in n
            .args
            .iter()
            .flatten()
            .chain(n.statement.iter())
            .chain(n.term.iter())
            .chain(n.binders.iter().flatten())
        {
            if s.chars().count() > MAX_FORMULA_CHARS {
                return Err(format!(
                    "node `{}` has a field longer than {MAX_FORMULA_CHARS} characters",
                    n.id
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_content_at_precise_location() {
        let doc:ProofDocument=serde_saphyr::from_str("puzzles:\n- id: bad\n  title: Bad\n  variables: [{name: a, type: Nat}, {name: a, type: Nat}]\n  goal: z = a\n  cards: [missing]\n  nodes: [auto]\n").unwrap();
        let errors = ProofLibrary::from_documents([("test.yaml".into(), doc)]).unwrap_err();
        for location in [
            "puzzles[bad].variables[1].name",
            "puzzles[bad].goal",
            "puzzles[bad].cards[0]",
            "puzzles[bad].tactics",
        ] {
            assert!(
                errors
                    .iter()
                    .any(|e| e.path == "test.yaml" && e.location == location),
                "{errors:?}"
            );
        }
    }
}
