//! End-to-end contract checks against the pinned Lean server.
use std::{path::PathBuf, sync::Mutex};
use vectspace_proof::*;
// Serialize native server startup within this binary; the timeout test deliberately restarts it.
static LEAN_TEST: Mutex<()> = Mutex::new(());
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}
fn library() -> ProofLibrary {
    let doc =
        serde_saphyr::from_str::<ProofDocument>(include_str!("../../../game/proofs/basics.yaml"))
            .unwrap();
    ProofLibrary::from_documents([("proofs/basics.yaml".into(), doc)]).unwrap()
}
fn graph(yaml: &str) -> ProofGraph {
    serde_saphyr::from_str(yaml).unwrap()
}
fn assert_complete(result: &ProofCheckResult) {
    assert_eq!(result.status, ProofStatus::Complete, "{result:#?}");
}
#[test]
fn real_server_complete_holes_mismatch_scope_and_tactics() {
    let _guard = LEAN_TEST.lock().unwrap();
    let mut config = match LeanConfig::discover(&root().join("lean")) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Skipping real Lean integration test: {e}");
            return;
        }
    };
    config.timeout = std::time::Duration::from_secs(30);
    let mut checker = ProofChecker::new(Some(config));
    checker.warm_up();
    let lib = library();
    for puzzle in lib.puzzles() {
        assert_complete(&checker.check(
            &lib,
            &puzzle.id,
            puzzle.solution.as_ref().unwrap(),
            CheckMode::Verify,
        ));
    }
    let base = lib.puzzle("and_comm").unwrap().solution.as_ref().unwrap();
    let mut hole = base.clone();
    hole.edges
        .retain(|e| !(e.to == "pair" && e.to_port == "p1"));
    let result = checker.check(&lib, "and_comm", &hole, CheckMode::Feedback);
    assert_eq!(result.status, ProofStatus::Incomplete);
    assert!(result.ports["pair/p1"].open, "{result:#?}");
    assert_eq!(result.ports["pair/p1"].expected.as_ref().unwrap().text, "p");
    let mut mismatch = base.clone();
    mismatch
        .edges
        .iter_mut()
        .find(|e| e.to == "pair" && e.to_port == "p0")
        .unwrap()
        .from = "left".into();
    let result = checker.check(&lib, "and_comm", &mismatch, CheckMode::Verify);
    assert_eq!(result.status, ProofStatus::Incomplete);
    assert!(result.ports["pair/p0"].mismatch.is_some(), "{result:#?}");
    let mut unknown = base.clone();
    unknown
        .nodes
        .iter_mut()
        .find(|n| n.id == "pair")
        .unwrap()
        .args = Some(vec!["unknown".into(), "p".into()]);
    let result = checker.check(&lib, "and_comm", &unknown, CheckMode::Feedback);
    assert_eq!(result.status, ProofStatus::Incomplete);
    assert!(result.fields["pair/args.0"].error.is_some());
    let mut scope = lib.puzzle("or_comm").unwrap().solution.clone().unwrap();
    scope
        .edges
        .iter_mut()
        .find(|e| e.to == "right" && e.to_port == "p0")
        .unwrap()
        .from_port = "l0".into();
    let result = checker.check(&lib, "or_comm", &scope, CheckMode::Verify);
    assert_eq!(result.status, ProofStatus::Incomplete);
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.code == "scope" && d.edge.is_some()),
        "{result:#?}"
    );
    // Local -> child -> scoped body is legal; it is not a value-dependency cycle.
    let result = checker.check(
        &lib,
        "or_comm",
        lib.puzzle("or_comm").unwrap().solution.as_ref().unwrap(),
        CheckMode::Feedback,
    );
    assert_complete(&result);
    assert!(result.locals.contains_key("split/l0"));
    assert!(!result.diagnostics.iter().any(|d| d.code == "graph"));
    let mut shared = lib.puzzle("or_comm").unwrap().solution.clone().unwrap();
    shared
        .edges
        .iter_mut()
        .find(|e| e.to == "split" && e.to_port == "right")
        .unwrap()
        .from = "left".into();
    let result = checker.check(&lib, "or_comm", &shared, CheckMode::Verify);
    assert!(
        result.diagnostics.iter().any(|d| d.code == "scope"),
        "{result:#?}"
    );
    // Dangling nodes referencing a local are probed within that binder's body.
    let mut scoped_probe = lib.puzzle("or_comm").unwrap().solution.clone().unwrap();
    scoped_probe.nodes.push(
        serde_saphyr::from_str("{id: extra, kind: card, card: or_inr, args: [q, p]}").unwrap(),
    );
    scoped_probe.edges.push(ProofGraphEdge {
        from: "split".into(),
        from_port: "l0".into(),
        to: "extra".into(),
        to_port: "p0".into(),
    });
    let result = checker.check(&lib, "or_comm", &scoped_probe, CheckMode::Feedback);
    assert_complete(&result);
    assert!(result.nodes.contains_key("extra"), "{result:#?}");
    assert!(
        !result
            .diagnostics
            .iter()
            .any(|d| d.code == "unknown_name" || d.code == "scope"),
        "{result:#?}"
    );
    // A dangling malformed node must not invalidate a complete goal in feedback mode.
    let mut dangling = base.clone();
    dangling
        .nodes
        .push(serde_saphyr::from_str("{id: extra, kind: claim, statement: unknown}").unwrap());
    assert_complete(&checker.check(&lib, "and_comm", &dangling, CheckMode::Feedback));
    assert_eq!(
        checker
            .check(&lib, "and_comm", &dangling, CheckMode::Verify)
            .status,
        ProofStatus::Incomplete
    );
    let auto_doc:ProofDocument=serde_saphyr::from_str("puzzles:\n- id: arithmetic\n  title: Arithmetic\n  variables: [{name: a, type: Nat}, {name: b, type: Nat}]\n  hypotheses: [{name: h, statement: a <= b}]\n  goal: a <= b + 1\n  nodes: [auto]\n  tactics: [omega]\n").unwrap();
    let arithmetic = ProofLibrary::from_documents([("auto.yaml".into(), auto_doc)]).unwrap();
    let mut auto=graph("nodes: [{id: given, kind: given, hypothesis: h}, {id: auto, kind: auto, tactic: omega}, {id: goal, kind: goal}]\nedges: [{from: auto, from_port: out, to: goal, to_port: in}]");
    let result = checker.check(&arithmetic, "arithmetic", &auto, CheckMode::Verify);
    assert_eq!(result.status, ProofStatus::Incomplete);
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.code == "tactic_failed" && d.node.as_deref() == Some("auto")),
        "{result:#?}"
    );
    auto.edges.push(ProofGraphEdge {
        from: "given".into(),
        from_port: "out".into(),
        to: "auto".into(),
        to_port: "facts".into(),
    });
    assert_complete(&checker.check(&arithmetic, "arithmetic", &auto, CheckMode::Verify));
    // Scope violations through formula names are rejected before Lean sees the name.
    let mut induction = lib.puzzle("zero_add").unwrap().solution.clone().unwrap();
    induction
        .nodes
        .iter_mut()
        .find(|n| n.id == "base")
        .unwrap()
        .args = Some(vec!["k".into()]);
    let result = checker.check(&lib, "zero_add", &induction, CheckMode::Verify);
    assert_eq!(result.status, ProofStatus::Incomplete);
    assert!(result.fields["base/args.0"].error.is_some());
}
#[test]
fn compile_contract_and_unavailable_feedback() {
    let lib = library();
    let puzzle = lib.puzzle("zero_add").unwrap();
    let graph = puzzle.solution.as_ref().unwrap();
    let source = vectspace_proof::compile::compile(&lib, puzzle, graph, CheckMode::Verify);
    assert!(source.source.starts_with("set_option autoImplicit false\n"));
    assert!(source.source.contains("| zero => exact"));
    assert!(source.source.contains("| succ k vsL0_1 => exact"));
    assert!(source.source.contains("vs_local% \"induction/l1\" vsL0_1"));
    assert!(!source.source.contains("vs_probe%"));
    assert!(!source.source.contains("card.and_intro"));
    assert_eq!(
        source
            .source
            .lines()
            .filter(|l| l.starts_with("theorem VS.puzzle"))
            .count(),
        1
    );
    assert!(source
        .spans
        .iter()
        .any(|s| s.target.field.as_deref() == Some("args.0")));
    assert!(source.spans.iter().any(|s| s.target.edge.is_some()));
    let mut checker = ProofChecker::new(None);
    let result = checker.check(&lib, "zero_add", graph, CheckMode::Feedback);
    assert_eq!(result.status, ProofStatus::Unavailable);
    assert!(result.fields["step/args.0"].latex.is_some());
}
#[test]
fn timeout_restarts_server() {
    let _guard = LEAN_TEST.lock().unwrap();
    let mut config = match LeanConfig::discover(&root().join("lean")) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Skipping timeout test: {e}");
            return;
        }
    };
    config.timeout = std::time::Duration::from_nanos(1);
    let lib = library();
    let mut checker = ProofChecker::new(Some(config));
    for _ in 0..2 {
        let result = checker.check(
            &lib,
            "and_comm",
            lib.puzzle("and_comm").unwrap().solution.as_ref().unwrap(),
            CheckMode::Verify,
        );
        assert_eq!(result.status, ProofStatus::Unavailable);
        assert!(result.diagnostics.iter().any(|d| d.code == "timeout"));
    }
}
#[test]
fn write_typescript_contract_fixtures() {
    let lib = library();
    let board = board_spec(&lib, "and_comm").unwrap();
    let result:ProofCheckResult=serde_json::from_value(serde_json::json!({"status":"complete","nodes":{"pair":{"type":{"text":"q ∧ p","latex":"q \\land p"}}},"ports":{"goal/in":{"expected":{"text":"q ∧ p","latex":"q \\land p"}}},"locals":{},"fields":{"pair/args.0":{"latex":"q"}},"diagnostics":[],"elapsed_ms":0})).unwrap();
    let dir = root().join("fixtures/proof");
    std::fs::create_dir_all(&dir).unwrap();
    for (name, value) in [
        (
            "board-spec.sample.json",
            serde_json::to_value(board).unwrap(),
        ),
        (
            "check-result.sample.json",
            serde_json::to_value(result).unwrap(),
        ),
    ] {
        std::fs::write(
            dir.join(name),
            format!("{}\n", serde_json::to_string_pretty(&value).unwrap()),
        )
        .unwrap();
    }
}
