use super::*;
use crate::test_support::{fixture_catalog, from_yaml, node, scene};
use vectspace_proof::{library::ProofLibrary, model::ProofDocument};

fn proof_catalog() -> ContentCatalog {
    let mut content = fixture_catalog();
    let document: ProofDocument = from_yaml("puzzles: [{id: identity, title: Identity, goal: True}]");
    content.proofs = ProofLibrary::from_documents([("proofs/test.yaml".into(), document)]).unwrap();
    content.scenes.insert("prologue".into(), scene("schema_version: 2
id: prologue
entry: puzzle
nodes:
  puzzle: {type: proof, puzzle: identity, next: solved, abandon: left}
  solved: {type: end}
  left: {type: end}
"));
    content
}

#[test]
fn proof_nodes_validate_puzzle_destinations_and_window_role() {
    let content = proof_catalog();
    let validate = |content: &ContentCatalog| crate::content::scenes::validate_scenes(
        &content.scenes, &content.manifest.assets, &content.manifest.variables,
        &content.manifest.characters, &content.ui_motions, &content.buttons, &content.actions, &content.proofs,
    );
    validate(&content).unwrap();
    for yaml in [
        "{type: proof, puzzle: unknown, next: solved}",
        "{type: proof, puzzle: identity, next: missing}",
        "{type: proof, puzzle: identity, next: solved, abandon: missing}",
    ] {
        let mut candidate = proof_catalog();
        candidate.scenes.get_mut("prologue").unwrap().nodes.insert("puzzle".into(), node(yaml));
        assert!(validate(&candidate).is_err(), "{yaml}");
    }
    let mut secondary = proof_catalog();
    secondary.scenes.get_mut("prologue").unwrap().window_role = crate::interaction::WindowRole::Secondary;
    assert!(validate(&secondary).unwrap_err().to_string().contains("main-window"));
}


#[test]
fn proof_documents_use_managed_paths_and_report_content_issue_locations() {
    use crate::content::{manifest::validate_manifest_paths, proofs::load};
    let mut manifest = fixture_catalog().manifest;
    for path in ["../escape.yaml", "assets/proof.yaml", ".vectspace/proof.yaml", "manifest.yaml"] {
        manifest.proofs = vec![path.into()];
        assert!(validate_manifest_paths(&manifest).is_err(), "{path}");
    }
    manifest.proofs = vec![manifest.scenes[0].to_uppercase()];
    assert!(validate_manifest_paths(&manifest).is_err());
    manifest.proofs = vec!["proofs/test.yaml".into(), "proofs/TEST.yaml".into()];
    assert!(validate_manifest_paths(&manifest).is_err());
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("proof.yaml"), "puzzles: [{id: duplicate, title: First, goal: True}, {id: duplicate, title: Second, goal: True}]").unwrap();
    let canonical_root = root.path().canonicalize().unwrap();
    let error = load(&canonical_root, &["proof.yaml".into()]).unwrap_err().to_string();
    assert!(error.contains("proof.yaml"));
    assert!(error.contains("puzzles"), "{error}");
    assert!(load(&canonical_root, &["missing.yaml".into()]).is_err());
}
