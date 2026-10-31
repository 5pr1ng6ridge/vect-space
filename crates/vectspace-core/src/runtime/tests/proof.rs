use super::*;
use crate::{model::{SceneNode, RuntimeSnapshot}, runtime::RuntimeError, test_support::from_yaml};
use vectspace_proof::{graph::{ProofGraph, ProofGraphNode, MAX_NODES}, library::ProofLibrary, model::{ProofDocument, ProofNodeKind}};

fn proof_catalog(abandon: bool) -> ContentCatalog {
    let mut content = prologue("schema_version: 2\nid: prologue\nentry: puzzle\nnodes:\n  puzzle: {type: proof, puzzle: identity, next: solved, abandon: left}\n  solved: {type: end}\n  left: {type: say, text: Left, next: solved}\n");
    if !abandon {
        if let SceneNode::Proof { abandon, .. } = content.scenes.get_mut("prologue").unwrap().nodes.get_mut("puzzle").unwrap() { *abandon = None; }
    }
    let document: ProofDocument = from_yaml("puzzles:\n  - id: identity\n    title: Identity\n    variables: [{name: p, type: Prop}]\n    hypotheses: [{name: h, statement: p}]\n    goal: p\n");
    content.proofs = ProofLibrary::from_documents([("proofs/test.yaml".into(), document)]).unwrap();
    content
}

fn draft() -> ProofGraph {
    ProofGraph { nodes: vec![ProofGraphNode {
        id: "goal".into(), kind: ProofNodeKind::Goal, x: 175.0, y: 230.0,
        hypothesis: None, card: None, args: None, statement: None,
        term: None, tactic: None, binders: None,
    }], edges: vec![] }
}

#[test]
fn proof_entry_blocks_advance_and_completion_records_progress() {
    let content = proof_catalog(true);
    let mut runtime = engine(&content);
    let update = runtime.start_new_game(&content).unwrap();
    assert!(update.cues.is_empty());
    assert!(!update.requires_ack);
    assert!(matches!(&update.snapshot.prompt, PromptSnapshot::Proof { prompt_id, puzzle, draft: None, can_abandon: true }
        if prompt_id == "prologue/puzzle" && puzzle == "identity"));
    assert_eq!(update.snapshot.interaction.prompt_source, Some(update.snapshot.location.clone()));
    assert!(!update.snapshot.interaction.prompt_instance.is_empty());
    for source in [AdvanceSource::Manual, AdvanceSource::Auto, AdvanceSource::ForcedAuto, AdvanceSource::FastForward] {
        assert!(runtime.advance(&content, update.snapshot.revision, source).is_err());
    }
    assert!(runtime.choose(&content, "anything", update.snapshot.revision).is_err());
    let complete = runtime.complete_proof(&content, update.snapshot.revision).unwrap();
    assert!(matches!(complete.snapshot.prompt, PromptSnapshot::End { .. }));
    assert_eq!(complete.snapshot.location.node_id, "solved");
    assert!(runtime.profile_state(&content).solved_proofs.contains("identity"));
    assert!(matches!(runtime.complete_proof(&content, update.snapshot.revision), Err(RuntimeError::StaleRevision { .. })));
}

#[test]
fn proof_abandon_obeys_revision_and_optional_destination() {
    for allowed in [true, false] {
        let content = proof_catalog(allowed);
        let mut runtime = engine(&content);
        let update = runtime.start_new_game(&content).unwrap();
        assert!(matches!(runtime.abandon_proof(&content, update.snapshot.revision + 1), Err(RuntimeError::StaleRevision { .. })));
        let result = runtime.abandon_proof(&content, update.snapshot.revision);
        if allowed {
            assert!(matches!(result.unwrap().snapshot.prompt, PromptSnapshot::Dialogue { .. }));
        } else { assert!(matches!(result, Err(RuntimeError::ProofAbandonNotAllowed))); }
        assert!(runtime.profile_state(&content).solved_proofs.is_empty());
    }
}

#[test]
fn proof_draft_sync_and_snapshot_round_trip_keep_graph_without_revision_bump() {
    let content = proof_catalog(true);
    let mut runtime = engine(&content);
    assert!(matches!(runtime.update_proof_draft(draft()), Err(RuntimeError::ProofNotAllowed)));
    let started = runtime.start_new_game(&content).unwrap();
    runtime.update_proof_draft(draft()).unwrap();
    assert_eq!(runtime.snapshot().revision, started.snapshot.revision);
    assert_eq!(runtime.snapshot().interaction.prompt_instance, started.snapshot.interaction.prompt_instance);
    assert!(runtime.pending_runtime_update().is_none());
    let serialized = serde_json::to_string(runtime.snapshot()).unwrap();
    let saved: RuntimeSnapshot = serde_json::from_str(&serialized).unwrap();
    let mut restored = engine(&content);
    let update = restored.load_snapshot(&content, saved).unwrap();
    assert!(update.cues.is_empty());
    assert!(matches!(&update.snapshot.prompt, PromptSnapshot::Proof { draft: Some(graph), .. } if graph == &draft()));
    restored.complete_proof(&content, update.snapshot.revision).unwrap();
}

#[test]
fn proof_drafts_and_forged_snapshots_are_rejected() {
    let content = proof_catalog(true);
    let mut runtime = engine(&content);
    runtime.start_new_game(&content).unwrap();
    let mut oversized = draft();
    oversized.nodes = vec![oversized.nodes[0].clone(); MAX_NODES + 1];
    assert!(matches!(runtime.update_proof_draft(oversized.clone()), Err(RuntimeError::InvalidProofDraft(_))));
    let original = runtime.snapshot().clone();
    for field in ["puzzle", "prompt_id", "can_abandon", "draft", "location"] {
        let mut saved = original.clone();
        if let PromptSnapshot::Proof { puzzle, prompt_id, can_abandon, draft, .. } = &mut saved.prompt {
            match field {
                "puzzle" => *puzzle = "unknown".into(),
                "prompt_id" => *prompt_id = "other/location".into(),
                "can_abandon" => *can_abandon = false,
                "draft" => *draft = Some(oversized.clone()),
                _ => saved.location.node_id = "left".into(),
            }
        }
        assert!(matches!(runtime.load_snapshot(&content, saved), Err(RuntimeError::InvalidSnapshot(_))), "{field}");
        assert_eq!(runtime.snapshot(), &original);
    }
}

#[test]
fn proof_preview_stops_at_board_instead_of_solving_it() {
    let content = proof_catalog(true);
    let mut runtime = engine(&content);
    let target = crate::model::StoryLocation { scene_id: "prologue".into(), node_id: "solved".into() };
    let result = runtime.preview_to_from_scene_entry(&content, "prologue", &target, &[]).unwrap();
    assert!(matches!(result, super::super::PreviewRunResult::Unreachable { .. }));
    assert!(runtime.profile_state(&content).solved_proofs.is_empty());
}
