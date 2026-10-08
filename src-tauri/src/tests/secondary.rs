//! The `open_window` control cue, the single secondary slot, shared state between
//! the windows, and the rollback of failed transactions.

use super::*;
use crate::{pair::take_open_window_request, secondary::SecondaryOwner};
use vectspace_core::model::DialogueHistoryEntry;

fn history_entry(entry_id: u64, prompt_id: &str) -> DialogueHistoryEntry {
    DialogueHistoryEntry {
        entry_id,
        prompt_id: prompt_id.to_owned(),
        speaker_id: None,
        speaker: None,
        name_color: None,
        text_color: None,
        text: format!("line {prompt_id}"),
    }
}

fn prompt_ids(history: &[DialogueHistoryEntry]) -> Vec<String> {
    history
        .iter()
        .map(|entry| entry.prompt_id.clone())
        .collect()
}

fn cue(cue_id: u64, gate: CueGate, kind: PresentationCueKind) -> PresentationCue {
    PresentationCue { cue_id, gate, kind }
}

fn open_cue(cue_id: u64, scene: &str) -> PresentationCue {
    cue(
        cue_id,
        CueGate::None,
        PresentationCueKind::OpenWindow {
            scene: scene.to_owned(),
        },
    )
}

fn delay_cue(cue_id: u64, gate: CueGate) -> PresentationCue {
    cue(cue_id, gate, PresentationCueKind::Delay { duration_ms: 10 })
}

fn update_with(cues: Vec<PresentationCue>, requires_ack: bool) -> RuntimeUpdate {
    let snapshot = RuntimeEngine::new(&secondary_test_catalog())
        .unwrap()
        .snapshot()
        .clone();
    RuntimeUpdate {
        kind: Default::default(),
        effect_timer: None,
        update_id: 1,
        snapshot,
        cues,
        requires_ack,
    }
}

#[test]
fn open_window_cues_are_consumed_once_and_the_last_target_wins() {
    // The runtime keeps going past every `open_window` node on the way to one
    // update, and a repeated `open_window` replaces the single slot: the last
    // request decides what the window shows.
    let mut update = update_with(
        vec![
            open_cue(1, "ambience_lab"),
            open_cue(2, "surface_parity"),
            delay_cue(3, CueGate::Runtime),
        ],
        true,
    );
    assert_eq!(
        take_open_window_request(&mut update).as_deref(),
        Some("surface_parity")
    );
    // Only the ordinary presentation cue is left for the WebView, and it keeps
    // the acknowledgement it needs.
    assert_eq!(update.cues.len(), 1);
    assert_eq!(update.cues[0].gate, CueGate::Runtime);
    assert!(update.requires_ack);
    // A retry cannot re-trigger the native side effect.
    assert_eq!(take_open_window_request(&mut update), None);

    // With nothing runtime-gated left, no acknowledgement is required.
    let mut plain = update_with(vec![open_cue(1, "ambience_lab")], false);
    assert_eq!(
        take_open_window_request(&mut plain).as_deref(),
        Some("ambience_lab")
    );
    assert!(!plain.requires_ack);
    assert!(plain.cues.is_empty());
}

/// The story entry rewritten to open the secondary window and then park on a
/// runtime-gated `wait`.
fn open_window_then_wait_content() -> ContentCatalog {
    let mut content = secondary_test_catalog();
    let scene = content.scenes.get_mut("prologue").unwrap();
    let original_entry = scene.entry.clone();
    scene.entry = "open_secondary".to_owned();
    scene
        .nodes
        .insert("open_secondary".to_owned(), open_side("hold"));
    scene.nodes.insert(
        "hold".to_owned(),
        SceneNode::Wait {
            duration_ms: 10,
            next: original_entry,
        },
    );
    content
}

/// The same entry plus a secondary Scene whose opening nodes consume and write
/// the shared Save/Profile maps before showing their first line.
fn shared_state_secondary_content() -> ContentCatalog {
    let mut content = open_window_then_wait_content();
    // The main command itself writes a shared value before opening the window,
    // so the secondary must be seeded from the *candidate* runtime.
    let prologue = content.scenes.get_mut("prologue").unwrap();
    prologue.entry = "seed_score".to_owned();
    prologue.nodes.insert(
        "seed_score".to_owned(),
        set_score(VariableOperation::Assign, 5, "open_secondary"),
    );
    let scene = content.scenes.get_mut("ambience_lab").unwrap();
    let original_entry = scene.entry.clone();
    scene.entry = "seed_profile".to_owned();
    scene.nodes.insert(
        "seed_profile".to_owned(),
        SceneNode::Set {
            variable: "ending_seen".to_owned(),
            op: VariableOperation::Assign,
            value: Some(MutationValue::Literal(ScalarValue::Boolean(true))),
            next: "seed_add".to_owned(),
        },
    );
    scene.nodes.insert(
        "seed_add".to_owned(),
        set_score(VariableOperation::Add, 1, "seed_say"),
    );
    scene
        .nodes
        .insert("seed_say".to_owned(), say("[var=score]", &original_entry));
    content
}

/// Give the secondary Scene a runtime-gated entry so staging it leaves a pending
/// presentation behind.
fn gated_secondary_entry(mut content: ContentCatalog) -> ContentCatalog {
    let scene = content.scenes.get_mut("ambience_lab").unwrap();
    let original_entry = scene.entry.clone();
    scene.entry = "gated_entry".to_owned();
    scene.nodes.insert(
        "gated_entry".to_owned(),
        SceneNode::Wait {
            duration_ms: 10,
            next: original_entry,
        },
    );
    content
}

#[test]
fn an_entry_that_opens_windows_ends_with_one_secondary_window() {
    // A new game forces the previous secondary down, but a window request in the
    // entry's own update takes precedence.
    let start = |content: ContentCatalog| {
        let (directory, ops, state) = state_with(content);
        let update = state
            .transact_runtime_forced(|runtime| runtime.start_new_game(&state.content), true)
            .unwrap();
        assert!(!has_open_window_cue(&update));
        (directory, ops, state, update)
    };

    // `open_window` followed by a runtime-gated node: the window opens and the
    // node keeps its acknowledgement.
    let (_directory, ops, state, update) = start(open_window_then_wait_content());
    assert!(update.requires_ack);
    let slot = state.secondary().unwrap();
    let session = slot.as_ref().expect("the entry opened the window");
    assert_eq!(session.scene_id, "ambience_lab");
    assert!(matches!(session.owner, SecondaryOwner::Story { .. }));
    assert_eq!(ops.create_calls.get(), 1);
    drop(slot);

    // `open_window` then a jump out of the Scene: the Scene the update landed in
    // owns the window it asked for.
    let mut content = open_window_then_wait_content();
    let sandbox_entry = content.scenes["sandbox"].entry.clone();
    let scene = content.scenes.get_mut("prologue").unwrap();
    scene.nodes.insert(
        "hold".to_owned(),
        SceneNode::Jump {
            scene: Some("sandbox".to_owned()),
            target: sandbox_entry,
        },
    );
    let (_directory, ops, state, update) = start(content);
    assert_eq!(update.snapshot.location.scene_id, "sandbox");
    let slot = state.secondary().unwrap();
    let session = slot
        .as_ref()
        .expect("the request wins over the Scene change");
    assert_eq!(session.scene_id, "ambience_lab");
    assert_eq!(
        session.owner,
        SecondaryOwner::Story {
            scene_id: "sandbox".to_owned()
        }
    );
    assert_eq!(ops.create_calls.get(), 1);
    drop(slot);

    // Two consecutive `open_window` nodes: only the last target is ever shown.
    let mut content = open_window_then_wait_content();
    let scene = content.scenes.get_mut("prologue").unwrap();
    let original_entry = match &scene.nodes["hold"] {
        SceneNode::Wait { next, .. } => next.clone(),
        other => panic!("unexpected node {other:?}"),
    };
    scene.nodes.insert(
        "open_secondary".to_owned(),
        SceneNode::OpenWindow {
            scene: "ambience_lab".to_owned(),
            next: "open_second".to_owned(),
        },
    );
    scene.nodes.insert(
        "open_second".to_owned(),
        SceneNode::OpenWindow {
            scene: "surface_parity".to_owned(),
            next: original_entry,
        },
    );
    let (_directory, ops, state, _) = start(content);
    assert_eq!(
        state.secondary().unwrap().as_ref().unwrap().scene_id,
        "surface_parity"
    );
    assert_eq!(ops.show_calls.get(), 1);
    assert_eq!(ops.create_calls.get(), 1);
}

#[test]
fn one_secondary_slot_is_reused_on_replace_and_cleared_on_scene_change() {
    let (_directory, _ops, state) = state_with(secondary_test_catalog());
    let first = stage_test_secondary(&state, "ambience_lab");
    assert_eq!(secondary_snapshot(&state).location.scene_id, "ambience_lab");

    // Repeating open_window re-points the same slot with a fresh token instead of
    // creating a second secondary.
    let transition = open_secondary_transition(&state, "ambience_lab").unwrap();
    assert_eq!(transition.plan, SecondaryPlan::Show { replaced: true });
    let replaced = secondary_token(&state);
    assert_eq!(replaced, first + 1);

    // An undeclared Scene and a Scene that is not a secondary-window Scene are
    // rejected and leave the live session intact.
    assert!(open_secondary_transition(&state, "does_not_exist").is_err());
    assert!(open_secondary_transition(&state, "prologue")
        .unwrap_err()
        .message
        .contains("副窗口专用"));
    assert_eq!(secondary_token(&state), replaced);

    // A hard ownership boundary tears the secondary down.
    let transition = state
        .commit_main_runtime_forced(|runtime| Ok(runtime.bootstrap(&state.content).update), true)
        .unwrap();
    assert_eq!(transition.plan, SecondaryPlan::Hide);
    assert!(state.secondary().unwrap().is_none());
}

#[test]
fn secondary_commands_require_the_current_token() {
    let (_directory, _ops, state) = state_with(secondary_test_catalog());
    let catalog = &state.content;
    let token = stage_test_secondary(&state, "ambience_lab");

    let missing = state
        .transact_secondary(None, |runtime| Ok(runtime.bootstrap(catalog).update))
        .unwrap_err();
    assert_eq!(missing.code, WireCommandErrorCode::StaleSession);

    let stale = state
        .transact_secondary(Some(&WireU64::from(token + 7)), |runtime| {
            Ok(runtime.bootstrap(catalog).update)
        })
        .unwrap_err();
    assert_eq!(stale.code, WireCommandErrorCode::StaleSession);

    // The gate and the session are still usable after a rejected request.
    let ok = state
        .transact_secondary(Some(&WireU64::from(token)), |runtime| {
            let revision = runtime.snapshot().revision;
            runtime.advance(catalog, revision, AdvanceSource::Manual)
        })
        .unwrap();
    assert_eq!(ok.1, token);
}

#[test]
fn secondary_command_publishes_shared_variables_and_merged_history_to_main() {
    let (directory, _ops, state) = state_with(secondary_test_catalog());
    let catalog = &state.content;

    // The main story produced its own occurrences first, so ordering is visible
    // in the merged ledger.
    state
        .commit_main_runtime(|runtime| runtime.start_new_game(catalog))
        .unwrap();
    state
        .commit_main_runtime(|runtime| {
            runtime.extend_dialogue_history(vec![history_entry(0, "prologue/host_merged")]);
            Ok(runtime.bootstrap(catalog).update)
        })
        .unwrap();
    let main_prompts = prompt_ids(state.runtime().unwrap().dialogue_history());
    assert!(main_prompts.contains(&"prologue/host_merged".to_owned()));

    // The secondary opens after the main story is already running, then a command
    // of its writes shared Save/Profile variables and advances its own story.
    let token = stage_test_secondary(&state, "ambience_lab");
    let (update, returned) = state
        .transact_secondary(Some(&WireU64::from(token)), |runtime| {
            runtime.set_save_variables(VariableMap::from([(
                "score".to_owned(),
                ScalarValue::Integer(9),
            )]));
            runtime.set_profile_variables(VariableMap::from([(
                "ending_seen".to_owned(),
                ScalarValue::Boolean(true),
            )]));
            let revision = runtime.snapshot().revision;
            runtime.advance(catalog, revision, AdvanceSource::Manual)
        })
        .unwrap();
    assert_eq!(returned, token);
    // The secondary advanced under its own revision namespace.
    assert_eq!(
        secondary_snapshot(&state).revision,
        update.snapshot.revision
    );

    // The variables are published back to the main runtime, which stays the
    // authority for the shared maps.
    let main = state.runtime().unwrap();
    assert_eq!(
        main.snapshot().variables.get("score"),
        Some(&ScalarValue::Integer(9))
    );
    assert_eq!(
        main.profile_variables_map().get("ending_seen"),
        Some(&ScalarValue::Boolean(true))
    );

    // The secondary occurrences are appended after the main prefix, in occurrence
    // order, and the whole ledger is what gets persisted.
    let ledger = main.dialogue_history().to_vec();
    let prompts = prompt_ids(&ledger);
    assert_eq!(prompts[..main_prompts.len()], main_prompts[..]);
    assert!(prompts[main_prompts.len()..]
        .iter()
        .all(|prompt| prompt.starts_with("ambience_lab/")));
    assert!(prompts.contains(&"ambience_lab/intro".to_owned()));
    assert_eq!(
        ledger
            .iter()
            .map(|entry| entry.entry_id)
            .collect::<Vec<_>>(),
        (1..=ledger.len() as u64).collect::<Vec<_>>(),
        "the merged ledger stays canonically numbered"
    );
    assert_eq!(main.profile_state(catalog).dialogue_history, ledger);
    let on_disk: serde_json::Value = serde_json::from_slice(&profile_file(&directory)).unwrap();
    assert_eq!(
        on_disk["dialogue_history"].as_array().map(Vec::len),
        Some(ledger.len())
    );
}

#[test]
fn each_secondary_command_starts_from_the_main_authoritative_maps() {
    let (_directory, _ops, state) = state_with(secondary_test_catalog());
    let catalog = &state.content;
    let token = stage_test_secondary(&state, "ambience_lab");
    state
        .commit_main_runtime(|runtime| runtime.start_new_game(catalog))
        .unwrap();
    state
        .commit_main_runtime(|runtime| {
            runtime.set_save_variables(VariableMap::from([(
                "score".to_owned(),
                ScalarValue::Integer(5),
            )]));
            runtime.set_profile_variables(VariableMap::from([(
                "ending_seen".to_owned(),
                ScalarValue::Boolean(true),
            )]));
            Ok(runtime.bootstrap(catalog).update)
        })
        .unwrap();

    state
        .transact_secondary(Some(&WireU64::from(token)), |runtime| {
            assert_eq!(
                runtime.snapshot().variables.get("score"),
                Some(&ScalarValue::Integer(5)),
                "a secondary command must observe the main Save map"
            );
            assert_eq!(
                runtime.profile_variables_map().get("ending_seen"),
                Some(&ScalarValue::Boolean(true)),
                "a secondary command must observe the main Profile map"
            );
            Ok(runtime.bootstrap(catalog).update)
        })
        .unwrap();
}

#[test]
fn secondary_startup_uses_and_publishes_the_candidate_shared_state() {
    let (directory, _ops, state) = state_with(shared_state_secondary_content());
    // The main command itself writes `score` before it reaches `open_window`, so
    // the value the secondary must start from only exists on the command's
    // candidate runtime.
    let transition = state
        .commit_main_runtime(|runtime| runtime.start_new_game(&state.content))
        .unwrap();
    assert_eq!(transition.plan, SecondaryPlan::Show { replaced: false });

    // The secondary's opening nodes ran on the candidate's maps: `seed_add` added
    // 1 to the main story's 5 instead of to the declared default.
    let slot = state.secondary().unwrap();
    let session = slot.as_ref().unwrap();
    assert_eq!(
        session.runtime.snapshot().variables.get("score"),
        Some(&ScalarValue::Integer(6))
    );
    assert_eq!(
        session.runtime.profile_variables_map().get("ending_seen"),
        Some(&ScalarValue::Boolean(true))
    );
    let opening = session
        .runtime
        .dialogue_history()
        .iter()
        .find(|entry| entry.prompt_id == "ambience_lab/seed_say")
        .expect("the secondary's opening line is part of its own ledger")
        .text
        .clone();
    drop(slot);
    assert_eq!(opening, "6");

    // The startup mutations were published to the main runtime in the same
    // transaction, including the merged ledger and the persisted profile.
    let main = state.runtime().unwrap();
    assert_eq!(
        main.snapshot().variables.get("score"),
        Some(&ScalarValue::Integer(6))
    );
    assert_eq!(
        main.profile_variables_map().get("ending_seen"),
        Some(&ScalarValue::Boolean(true))
    );
    assert!(main
        .dialogue_history()
        .iter()
        .any(|entry| entry.prompt_id == "ambience_lab/seed_say"));
    assert_eq!(
        main.profile_state(&state.content).dialogue_history,
        main.dialogue_history().to_vec()
    );
    let on_disk: serde_json::Value = serde_json::from_slice(&profile_file(&directory)).unwrap();
    assert_eq!(on_disk["variables"]["ending_seen"], serde_json::json!(true));
}

#[test]
fn initial_runtime_gated_secondary_presentation_survives_the_bootstrap() {
    let (_directory, _ops, state) =
        state_with(gated_secondary_entry(open_window_then_wait_content()));
    let transition = state
        .commit_main_runtime(|runtime| runtime.start_new_game(&state.content))
        .unwrap();
    // The control cue is stripped, but the acknowledgement the remaining `wait`
    // needs is still required of the main window.
    assert!(transition.committed.requires_ack);
    assert!(!has_open_window_cue(&transition.committed));
    assert!(transition
        .committed
        .cues
        .iter()
        .any(|cue| cue.gate == CueGate::Runtime));

    // The secondary's own pending opening presentation is delivered by its
    // bootstrap with the exact update id the runtime is waiting for.  The update
    // only becomes deliverable once the transaction has been published.
    let committed = transition.committed.clone();
    let published = state
        .publish(committed.produced, committed.diagnostics)
        .unwrap();
    let secondary_update = published
        .iter()
        .find(|(role, _)| *role == WindowRole::Secondary)
        .map(|(_, update)| update.clone())
        .expect("the secondary's opening update is published");
    assert_eq!(secondary_update.seq, WireU64::from(1));
    let token = secondary_token(&state);
    let pending = state
        .secondary()
        .unwrap()
        .as_ref()
        .unwrap()
        .runtime
        .pending_runtime_update()
        .expect("a runtime-gated opening leaves a pending presentation");
    let payload = state.secondary_bootstrap_payload().unwrap();
    assert!(payload.update.requires_ack);
    assert_eq!(payload.update.update_id, WireU64::from(pending));
    assert_eq!(payload.update.session_id, WireU64::from(token));
    // The bootstrap's sequence is the window's latest, so the frontend only syncs
    // for notifications that are really newer.
    assert_eq!(payload.update.seq, WireU64::from(1));

    // Acknowledging that exact gate unblocks ordinary gameplay.
    state
        .transact_secondary(Some(&WireU64::from(token)), |runtime| {
            runtime.presentation_complete(&state.content, pending, PresentationOutcome::Completed)
        })
        .unwrap();
    let revision = secondary_snapshot(&state).revision;
    state
        .transact_secondary(Some(&WireU64::from(token)), |runtime| {
            runtime.advance(&state.content, revision, AdvanceSource::Manual)
        })
        .expect("an acked bootstrap gate must not leave the secondary locked");
    // Once the gate is acknowledged the bootstrap is cue-less again.
    assert!(
        !state
            .secondary_bootstrap_payload()
            .unwrap()
            .update
            .requires_ack
    );
}

#[test]
fn failed_profile_write_rolls_back_the_secondary_command() {
    let (directory, _ops, state) = state_with(secondary_test_catalog());
    let catalog = &state.content;
    let token = stage_test_secondary(&state, "ambience_lab");
    let before_main = main_snapshot(&state);
    let before_secondary = secondary_snapshot(&state);
    // Make the profile unwritable so the commit must abort.
    fs::remove_dir_all(directory.path()).unwrap();

    let result = state.transact_secondary(Some(&WireU64::from(token)), |runtime| {
        runtime.set_save_variables(VariableMap::from([(
            "score".to_owned(),
            ScalarValue::Integer(3),
        )]));
        // A shared Profile-scope write is part of the persisted profile state,
        // so the commit must attempt the (now unwritable) save.
        runtime.set_profile_variables(VariableMap::from([(
            "ending_seen".to_owned(),
            ScalarValue::Boolean(true),
        )]));
        let revision = runtime.snapshot().revision;
        runtime.advance(catalog, revision, AdvanceSource::Manual)
    });
    assert!(result.is_err());
    assert_eq!(main_snapshot(&state), before_main);
    assert_eq!(secondary_snapshot(&state), before_secondary);
}

#[test]
fn failed_variable_operation_rolls_back_the_entire_runtime_command() {
    let mut content = secondary_test_catalog();
    let scene = content.scenes.get_mut("prologue").unwrap();
    let original_entry = scene.entry.clone();
    scene.entry = "prepare_overflow".to_owned();
    scene.nodes.insert(
        "prepare_overflow".to_owned(),
        set_score(VariableOperation::Assign, i64::MAX, "overflow"),
    );
    scene.nodes.insert(
        "overflow".to_owned(),
        set_score(VariableOperation::Add, 1, &original_entry),
    );
    let (_directory, _ops, state) = state_with(content);
    let before = main_snapshot(&state);

    let result = state.commit_main_runtime(|runtime| runtime.start_new_game(&state.content));
    assert!(result.unwrap_err().message.contains("溢出"));
    assert_eq!(main_snapshot(&state), before);
}

#[test]
fn failed_read_history_persistence_rolls_back_location_revision_and_read_set() {
    let (directory, _ops, state) = state_with(secondary_test_catalog());
    let first = state
        .commit_main_runtime(|runtime| runtime.start_new_game(&state.content))
        .unwrap()
        .committed;
    let dialogue = state
        .commit_main_runtime(|runtime| {
            runtime.presentation_complete(
                &state.content,
                first.update_id,
                PresentationOutcome::Completed,
            )
        })
        .unwrap()
        .committed;
    assert!(matches!(
        dialogue.snapshot.prompt,
        PromptSnapshot::Dialogue { .. }
    ));
    let before_snapshot = main_snapshot(&state);
    let before_profile = state.runtime().unwrap().profile_state(&state.content);
    fs::remove_dir_all(directory.path()).unwrap();

    let result = state.commit_main_runtime(|runtime| {
        runtime.advance(
            &state.content,
            dialogue.snapshot.revision,
            AdvanceSource::ForcedAuto,
        )
    });
    assert!(result.is_err());
    let runtime = state.runtime().unwrap();
    assert_eq!(runtime.snapshot(), &before_snapshot);
    assert_eq!(runtime.profile_state(&state.content), before_profile);
}

#[test]
fn failed_native_window_creation_rolls_back_the_whole_transition() {
    let (directory, ops, state) = state_with(shared_state_secondary_content());
    let before_runtime = main_snapshot(&state);
    let before_profile = profile_file(&directory);
    ops.fail_show.set(true);

    let error = state
        .transact_runtime(|runtime| runtime.start_new_game(&state.content))
        .unwrap_err();
    assert_eq!(error.code, WireCommandErrorCode::Internal);
    // No silent success: the transition is rolled back in memory *and* on disk
    // instead of reporting a window that does not exist.
    assert!(state.secondary().unwrap().is_none());
    assert_eq!(main_snapshot(&state), before_runtime);
    assert_eq!(profile_file(&directory), before_profile);
    assert_eq!(ops.show_calls.get(), 1);
}

#[test]
fn partial_native_creation_with_failed_cleanup_reports_both_and_recovers() {
    let (directory, ops, state) = state_with(shared_state_secondary_content());
    let before_runtime = main_snapshot(&state);
    let before_profile = profile_file(&directory);
    // Creation builds the native window and then fails, and the rollback's
    // cleanup cannot destroy it either.
    ops.fail_show_after_create.set(true);
    ops.fail_hide.set(true);

    let error = show_test_secondary(&state, "ambience_lab").unwrap_err();
    // Both failures are reported, not just the first one.
    assert_eq!(error.code, WireCommandErrorCode::Internal);
    assert!(
        error.message.contains("测试: 副窗口创建失败"),
        "{}",
        error.message
    );
    assert!(
        error.message.contains("测试: 无法关闭副窗口"),
        "{}",
        error.message
    );
    // The logical state is restored even though the cleanup failed, while the
    // native window really did survive this attempt.
    assert!(state.secondary().unwrap().is_none());
    assert_eq!(main_snapshot(&state), before_runtime);
    assert_eq!(profile_file(&directory), before_profile);
    assert_eq!(ops.hide_calls.get(), 1);
    assert!(ops.window_alive.get());

    // The retry is deterministic: the logical state has no secondary, so
    // `replaced` is false, but the surviving native window still runs the old
    // frontend and must be adopted and refreshed rather than duplicated.
    ops.fail_show_after_create.set(false);
    ops.fail_hide.set(false);
    show_test_secondary(&state, "ambience_lab").unwrap();
    assert_eq!(ops.replaced_calls.get(), 0);
    assert_eq!(ops.reused_calls.get(), 1);
    assert_eq!(ops.refresh_calls.get(), 1);
    assert_eq!(ops.create_calls.get(), 0);
    assert_eq!(ops.show_calls.get(), 2);
    let token = secondary_token(&state);
    // The recovered session is fully usable: its bootstrap serves the refreshed
    // token to the surviving window.
    let payload = state.secondary_bootstrap_payload().unwrap();
    assert_eq!(payload.update.session_id, WireU64::from(token));
    assert_eq!(payload.update.snapshot.location.scene_id, "ambience_lab");
}

#[test]
fn failed_native_window_destruction_never_reports_a_cleared_secondary() {
    let (_directory, ops, state) = state_with(secondary_test_catalog());
    let token = stage_test_secondary(&state, "ambience_lab");
    let before_runtime = main_snapshot(&state);
    ops.fail_hide.set(true);

    // A new game / title boundary must abort instead of succeeding while the
    // window is still on screen.
    let error = state
        .transact_runtime_forced(|runtime| runtime.start_new_game(&state.content), true)
        .unwrap_err();
    assert_eq!(error.code, WireCommandErrorCode::Internal);
    assert_eq!(secondary_token(&state), token);
    assert_eq!(main_snapshot(&state), before_runtime);

    // The same holds for the non-story boundaries (replay entry, title).
    assert!(state.close_secondary().is_err());
    assert_eq!(secondary_token(&state), token);

    // Once the native window can be destroyed the boundary completes.
    ops.fail_hide.set(false);
    state.close_secondary().unwrap();
    assert!(state.secondary().unwrap().is_none());
}

#[test]
fn the_next_transition_reconciles_the_native_window_with_the_slot() {
    // A live slot whose native window never appeared (the runtime accepted the
    // creation but did not perform it) is rebuilt by the next transition.
    let (_directory, ops, state) = state_with(shared_state_secondary_content());
    state
        .transact_runtime(|runtime| runtime.start_new_game(&state.content))
        .unwrap();
    assert!(state.secondary().unwrap().is_some());
    assert_eq!(ops.create_calls.get(), 1);
    ops.window_alive.set(false);
    state
        .transact_runtime(|runtime| Ok(runtime.bootstrap(&state.content).update))
        .unwrap();
    assert_eq!(ops.recover_calls.get(), 1);
    assert_eq!(ops.create_calls.get(), 2);
    assert!(ops.window_alive.get());

    // A native window with no slot (a creation that built the window, then
    // failed, with a cleanup that failed too) is removed by the next transition.
    let (_directory, ops, state) = state_with(shared_state_secondary_content());
    ops.fail_show_after_create.set(true);
    ops.fail_hide.set(true);
    assert!(state
        .transact_runtime(|runtime| runtime.start_new_game(&state.content))
        .is_err());
    assert!(ops.window_alive.get());
    assert!(state.secondary().unwrap().is_none());
    ops.fail_show_after_create.set(false);
    ops.fail_hide.set(false);
    state
        .transact_runtime(|runtime| Ok(runtime.bootstrap(&state.content).update))
        .unwrap();
    assert_eq!(ops.recover_calls.get(), 1);
    assert!(!ops.window_alive.get());
}
