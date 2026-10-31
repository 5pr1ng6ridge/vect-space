use super::*;
use vectspace_proof::{library::ProofLibrary, model::ProofDocument};

fn proof_content() -> ContentCatalog {
    let mut content = secondary_test_catalog();
    let story = scene(WindowRole::Main, "prologue", "puzzle", vec![
        ("puzzle", SceneNode::Proof { puzzle: "identity".into(), next: "done".into(), abandon: Some("done".into()) }),
        ("done", SceneNode::End),
    ]);
    content.scenes.insert(story.id.clone(), story);
    let document: ProofDocument = serde_json::from_value(serde_json::json!({
        "puzzles": [{"id": "identity", "title": "Identity", "goal": "True"}]
    })).unwrap();
    content.proofs = ProofLibrary::from_documents([("proofs/test.yaml".into(), document)]).unwrap();
    content
}

#[test]
fn proof_completion_uses_profile_transaction_and_rolls_back_on_write_failure() {
    let (directory, _, state) = state_with(proof_content());
    start_game(&state);
    let baseline = main_snapshot(&state);
    let session = WireU64::from(state.current_session_id());
    let profile_path = directory.path().join("profile.json");
    fs::remove_file(&profile_path).unwrap();
    fs::create_dir(&profile_path).unwrap();
    let result = state.transact_active_runtime(Some(&session), |runtime| {
        runtime.complete_proof(&state.content, baseline.revision)
    });
    assert!(result.is_err());
    assert_eq!(main_snapshot(&state), baseline);
    assert!(state.runtime().unwrap().profile_state(&state.content).solved_proofs.is_empty());
    fs::remove_dir(&profile_path).unwrap();
    state.transact_active_runtime(Some(&session), |runtime| {
        runtime.complete_proof(&state.content, baseline.revision)
    }).unwrap();
    let profile: serde_json::Value = serde_json::from_slice(&fs::read(profile_path).unwrap()).unwrap();
    assert_eq!(profile["solved_proofs"], serde_json::json!(["identity"]));
}

#[test]
fn proof_draft_survives_host_slot_round_trip() {
    let (_directory, _, state) = state_with(proof_content());
    start_game(&state);
    state.runtime().unwrap().update_proof_draft(Default::default()).unwrap();
    let saved = main_snapshot(&state);
    state.saves.save("1", crate::save::SlotDocument { snapshot: &saved, history: &[], secondary: None }, None).unwrap();
    let loaded = state.saves.load("1").unwrap();
    assert_eq!(loaded.snapshot.prompt, saved.prompt);
    let _gate = state.session_gate().unwrap();
    state.apply_loaded_slot(loaded).unwrap();
    assert_eq!(main_snapshot(&state).prompt, saved.prompt);
    assert_eq!(state.saves.list().into_iter().find(|slot| slot.slot == "1").unwrap().prompt_preview.as_deref(), Some("identity"));
}

#[test]
fn proof_draft_is_rejected_for_a_prompt_that_is_no_longer_current() {
    let (_directory, _, state) = state_with(proof_content());
    start_game(&state);
    let PromptSnapshot::Proof { prompt_id, .. } = main_snapshot(&state).prompt else { panic!("expected a proof prompt") };
    let mut runtime = state.runtime().unwrap();
    assert!(crate::proof::save_draft_to(&mut runtime, "stale-prompt", Default::default()).is_err());
    assert!(matches!(&runtime.snapshot().prompt, PromptSnapshot::Proof { draft: None, .. }));
    crate::proof::save_draft_to(&mut runtime, &prompt_id, Default::default()).unwrap();
    assert!(matches!(&runtime.snapshot().prompt, PromptSnapshot::Proof { draft: Some(_), .. }));
}

#[test]
fn verified_proof_commit_rechecks_session_revision_and_prompt_instance() {
    let (_directory, _, state) = state_with(proof_content());
    start_game(&state);
    let captured = main_snapshot(&state);
    let session = WireU64::from(state.current_session_id());
    let stale_session = WireU64::from(state.current_session_id() + 1);
    let error = state.commit_verified_proof(Some(&stale_session), &captured, captured.revision).unwrap_err();
    assert_eq!(error.code, WireCommandErrorCode::StaleSession);
    assert!(state.commit_verified_proof(Some(&session), &captured, captured.revision + 1).is_err());
    let mut different_prompt = captured.clone();
    different_prompt.interaction.prompt_instance = "99999".into();
    assert!(state.commit_verified_proof(Some(&session), &different_prompt, captured.revision).is_err());
    assert_eq!(main_snapshot(&state), captured);
    state.commit_verified_proof(Some(&session), &captured, captured.revision).unwrap();
    assert!(state.commit_verified_proof(Some(&session), &captured, captured.revision).is_err());
}
