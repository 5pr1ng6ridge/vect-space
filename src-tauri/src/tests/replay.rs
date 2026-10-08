//! Isolated Scene replays: the window they own, their isolation from the story
//! and the profile, and the rollback of failed native steps.

use super::*;
use crate::secondary::SecondaryOwner;
use vectspace_core::model::DialogueHistoryEntry;

/// A replay fixture built entirely in memory: `replay_lab` opens the single
/// secondary window, re-points it, then ends; `replay_cross` leaves its own Scene
/// through a jump.
fn replay_test_content() -> ContentCatalog {
    let mut content = secondary_test_catalog();
    let sandbox_entry = content.scenes["sandbox"].entry.clone();
    content.scenes.insert(
        "replay_lab".to_owned(),
        scene(
            WindowRole::Main,
            "replay_lab",
            "open_child",
            vec![
                ("open_child", open_side("line")),
                ("line", say("replay line", "open_again")),
                (
                    "open_again",
                    SceneNode::OpenWindow {
                        scene: "surface_parity".to_owned(),
                        next: "rest".to_owned(),
                    },
                ),
                ("rest", say("replay rest", "end")),
                ("end", SceneNode::End),
            ],
        ),
    );
    content.scenes.insert(
        "replay_cross".to_owned(),
        scene(
            WindowRole::Main,
            "replay_cross",
            "open_child",
            vec![
                ("open_child", open_side("line")),
                ("line", say("cross line", "jump")),
                (
                    "jump",
                    SceneNode::Jump {
                        scene: Some("sandbox".to_owned()),
                        target: sandbox_entry,
                    },
                ),
                ("end", SceneNode::End),
            ],
        ),
    );
    with_replays(content, &["replay_lab", "replay_cross"])
}

#[test]
fn a_queued_native_destroy_is_never_adopted_and_is_retried_once_after_the_grace_period() {
    let (_directory, ops, state) = state_with(replay_test_content());
    enter_replay(&state, "replay_lab").unwrap();
    assert_eq!(ops.create_calls.get(), 1);

    // The replay exits and the runtime accepts the destroy but never completes
    // it: the label stays registered and queued for destruction.
    ops.defer_destroy.set(true);
    exit_replay(&state).unwrap();
    assert!(ops.queued_destroy.get());

    // Before the grace period a queued label is never adopted and nothing is
    // re-attempted: the entry is rolled back instead of handing the new replay a
    // window that is about to die.
    let error = enter_replay(&state, "replay_lab").unwrap_err();
    assert_eq!(error.code, WireCommandErrorCode::Runtime);
    assert_eq!(ops.destroy_retry_calls.get(), 0);
    assert!(state.replay().unwrap().is_none());
    assert!(state.secondary().unwrap().is_none());
    assert_eq!(ops.create_calls.get(), 1);

    // After the grace period exactly one bounded retry runs on the next
    // transition.  It fails natively here, so the window survives and is no
    // longer pending: the transition adopts and refreshes it instead of being
    // refused forever.
    ops.advance_pending_destroy(Duration::from_secs(3));
    ops.destroy_fails_asynchronously.set(true);
    enter_replay(&state, "replay_lab").unwrap();
    assert_eq!(ops.destroy_retry_calls.get(), 1);
    assert!(!ops.queued_destroy.get());
    assert!(state.secondary().unwrap().is_some());

    // A retry that is accepted again leaves the label queued and still not
    // adopted: one attempt per transition, a whole grace period between attempts.
    ops.destroy_fails_asynchronously.set(false);
    exit_replay(&state).unwrap();
    ops.advance_pending_destroy(Duration::from_secs(3));
    assert!(enter_replay(&state, "replay_lab").is_err());
    assert_eq!(ops.destroy_retry_calls.get(), 2);
    assert!(ops.queued_destroy.get());
    assert!(state.replay().unwrap().is_none());
    assert!(state.secondary().unwrap().is_none());

    // Once the runtime really processes the destroy the label is free again.
    ops.finish_queued_destroy();
    ops.defer_destroy.set(false);
    enter_replay(&state, "replay_lab").unwrap();
    assert!(state.secondary().unwrap().is_some());
    assert_eq!(ops.create_calls.get(), 2);
}

#[test]
fn replay_entry_open_window_opens_the_window_and_never_leaks_the_cue() {
    let (_directory, ops, state) = state_with(replay_test_content());
    let update = enter_replay(&state, "replay_lab").unwrap();
    assert!(!has_open_window_cue(&update));

    let slot = state.secondary().unwrap();
    let session = slot.as_ref().expect("the entry opened the window");
    assert_eq!(session.scene_id, "ambience_lab");
    assert!(matches!(session.owner, SecondaryOwner::Replay { .. }));
    let token = session.token;
    drop(slot);
    assert_eq!(ops.create_calls.get(), 1);
    assert!(ops.window_alive.get());

    // The window bootstraps under the replay-owned token.
    let payload = state.secondary_bootstrap_payload().unwrap();
    assert_eq!(payload.update.session_id, WireU64::from(token));
    assert_eq!(payload.update.snapshot.location.scene_id, "ambience_lab");
}

#[test]
fn repeated_open_window_inside_a_replay_repoints_one_slot_with_a_fresh_token() {
    let (_directory, ops, state) = state_with(replay_test_content());
    enter_replay(&state, "replay_lab").unwrap();
    let first = secondary_token(&state);

    let update = replay_advance(&state).unwrap();
    assert!(!has_open_window_cue(&update));
    let slot = state.secondary().unwrap();
    let session = slot.as_ref().expect("the re-point kept the one slot");
    assert_eq!(session.scene_id, "surface_parity");
    assert!(matches!(session.owner, SecondaryOwner::Replay { .. }));
    assert_eq!(session.token, first + 1, "a replacement gets a fresh token");
    drop(slot);
    // One native window was re-pointed, not replaced by a second one.
    assert_eq!(ops.create_calls.get(), 1);
    assert_eq!(ops.reused_calls.get(), 1);
    assert_eq!(ops.replaced_calls.get(), 1);

    // The replaced token is stale and cannot mutate the new session.
    let stale = state
        .transact_secondary(Some(&WireU64::from(first)), |runtime| {
            let revision = runtime.snapshot().revision;
            runtime.advance(&state.content, revision, AdvanceSource::Manual)
        })
        .unwrap_err();
    assert_eq!(stale.code, WireCommandErrorCode::StaleSession);

    // A command carrying the current token but an ended replay generation is
    // refused before it can touch the new owner.
    let wrong_generation = state
        .transact_secondary_against_replay(first + 1, first + 999, |runtime| {
            Ok(runtime.bootstrap(&state.content).update)
        })
        .unwrap_err();
    assert_eq!(wrong_generation.code, WireCommandErrorCode::StaleSession);
}

#[test]
fn replay_owned_secondary_never_touches_the_main_runtime_or_the_profile() {
    let (directory, _ops, state) = state_with(replay_test_content());
    enter_replay(&state, "replay_lab").unwrap();
    let token = secondary_token(&state);
    let before_main = main_snapshot(&state);
    let before_main_history = state.runtime().unwrap().dialogue_history().to_vec();
    let before_profile_file = profile_file(&directory);

    let (_, returned) = state
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
            runtime.advance(&state.content, revision, AdvanceSource::Manual)
        })
        .unwrap();
    assert_eq!(returned, token);

    // Replay play is ephemeral: the main runtime, the official ledger and the
    // profile file are untouched.
    assert_eq!(main_snapshot(&state), before_main);
    assert_eq!(
        state.runtime().unwrap().dialogue_history(),
        before_main_history.as_slice()
    );
    assert_eq!(profile_file(&directory), before_profile_file);

    // ... while the replay runtime really did receive the write and the
    // secondary's occurrence, so the in-replay history panel sees it.
    let replay = state.replay().unwrap();
    let session = replay.as_ref().unwrap();
    assert_eq!(
        session.runtime.snapshot().variables.get("score"),
        Some(&ScalarValue::Integer(9))
    );
    assert_eq!(
        session.runtime.profile_variables_map().get("ending_seen"),
        Some(&ScalarValue::Boolean(true))
    );
    assert!(session
        .runtime
        .dialogue_history()
        .iter()
        .any(|entry| entry.prompt_id.starts_with("ambience_lab/")));
}

#[test]
fn replay_cross_scene_and_end_transitions_close_the_replay_window() {
    let (_directory, ops, state) = state_with(replay_test_content());

    // Leaving the Scene that owns the window closes it, like a main story
    // transition does.
    enter_replay(&state, "replay_cross").unwrap();
    assert!(state.secondary().unwrap().is_some());
    let crossed = replay_advance(&state).unwrap();
    assert_ne!(crossed.snapshot.location.scene_id, "replay_cross");
    assert!(state.secondary().unwrap().is_none());
    assert!(!ops.window_alive.get());
    assert!(state.replay().unwrap().as_ref().unwrap().ending);
    exit_replay(&state).unwrap();

    // Reaching the end of the replay closes it too.
    enter_replay(&state, "replay_lab").unwrap();
    replay_advance(&state).unwrap();
    assert!(state.secondary().unwrap().is_some());
    let ended = replay_advance(&state).unwrap();
    assert!(matches!(ended.snapshot.prompt, PromptSnapshot::End { .. }));
    assert!(state.secondary().unwrap().is_none());
    assert!(state.replay().unwrap().as_ref().unwrap().ending);
}

#[test]
fn replay_exit_closes_the_window_and_a_failed_destroy_preserves_the_replay() {
    let (_directory, ops, state) = state_with(replay_test_content());
    enter_replay(&state, "replay_lab").unwrap();

    ops.fail_hide.set(true);
    assert_eq!(
        exit_replay(&state).unwrap_err().code,
        WireCommandErrorCode::Internal
    );
    // The exit can be retried instead of orphaning the window.
    assert!(state.replay().unwrap().is_some());
    assert!(state.secondary().unwrap().is_some());

    ops.fail_hide.set(false);
    exit_replay(&state).unwrap();
    assert!(state.replay().unwrap().is_none());
    assert!(state.secondary().unwrap().is_none());
    assert!(!ops.window_alive.get());
    assert_eq!(ops.hide_calls.get(), 2);
}

/// Everything a rolled-back replay transaction must leave exactly as it was: the
/// live replay (generation and full snapshot), its ledger, the secondary slot
/// (token, owner and shared maps/ledger) and the untouched main runtime with its
/// persisted profile.
#[derive(Debug, PartialEq)]
struct RollbackSnapshot {
    generation: u64,
    replay_scene: String,
    replay_ending: bool,
    replay_snapshot: RuntimeSnapshot,
    replay_history: Vec<DialogueHistoryEntry>,
    secondary_token: u64,
    secondary_scene: String,
    secondary_owner: SecondaryOwner,
    secondary_variables: VariableMap,
    secondary_history: Vec<DialogueHistoryEntry>,
    variables: VariableMap,
    main_history: Vec<DialogueHistoryEntry>,
    profile_file: Vec<u8>,
}

impl RollbackSnapshot {
    fn capture(state: &EngineState, directory: &TempDir) -> Self {
        let replay = state.replay().unwrap();
        let session = replay.as_ref().expect("a live replay");
        let secondary = state.secondary().unwrap();
        let secondary = secondary.as_ref().expect("a live secondary slot");
        let main = state.runtime().unwrap();
        Self {
            generation: session.generation,
            replay_scene: session.scene_id.clone(),
            replay_ending: session.ending,
            replay_snapshot: session.runtime.snapshot().clone(),
            replay_history: session.runtime.dialogue_history().to_vec(),
            secondary_token: secondary.token,
            secondary_scene: secondary.scene_id.clone(),
            secondary_owner: secondary.owner.clone(),
            secondary_variables: secondary.runtime.snapshot().variables.clone(),
            secondary_history: secondary.runtime.dialogue_history().to_vec(),
            variables: main.snapshot().variables.clone(),
            main_history: main.dialogue_history().to_vec(),
            profile_file: profile_file(directory),
        }
    }
}

#[test]
fn failed_repeated_replay_open_restores_the_live_replay_and_its_previous_slot() {
    let (directory, ops, state) = state_with(replay_test_content());
    enter_replay(&state, "replay_lab").unwrap();
    let before = RollbackSnapshot::capture(&state, &directory);

    // The re-point builds the native window and then the show fails: the
    // partial native failure the seam cannot report a completion for.
    ops.fail_show_after_create.set(true);
    let error = replay_advance(&state).unwrap_err();
    assert_eq!(error.code, WireCommandErrorCode::Internal);
    assert_eq!(RollbackSnapshot::capture(&state, &directory), before);

    // The retry runs the same transition from the restored revision and finally
    // re-points the one slot with a fresh token.
    ops.fail_show_after_create.set(false);
    replay_advance(&state).unwrap();
    let slot = state.secondary().unwrap();
    let session = slot.as_ref().expect("the retry kept the one slot");
    assert_eq!(session.scene_id, "surface_parity");
    // The failed attempt also consumed a token, which is what keeps a stale
    // acknowledgement from ever colliding with a later instance.
    assert!(session.token > before.secondary_token);
    assert_eq!(
        session.owner,
        SecondaryOwner::Replay {
            generation: before.generation
        }
    );
}

#[test]
fn failed_cross_scene_and_end_hides_restore_the_live_replay() {
    let (directory, ops, state) = state_with(replay_test_content());

    // Leaving the owning Scene stages a Hide; when it fails the replay must keep
    // running exactly where it was.
    enter_replay(&state, "replay_cross").unwrap();
    let before = RollbackSnapshot::capture(&state, &directory);
    ops.fail_hide.set(true);
    assert_eq!(
        replay_advance(&state).unwrap_err().code,
        WireCommandErrorCode::Internal
    );
    assert_eq!(RollbackSnapshot::capture(&state, &directory), before);
    assert!(ops.window_alive.get());

    ops.fail_hide.set(false);
    replay_advance(&state).unwrap();
    assert!(state.secondary().unwrap().is_none());
    assert!(state.replay().unwrap().as_ref().unwrap().ending);
    exit_replay(&state).unwrap();

    // The same for the ending Hide: the replay is not over until the window
    // really closed.
    enter_replay(&state, "replay_lab").unwrap();
    replay_advance(&state).unwrap();
    let before = RollbackSnapshot::capture(&state, &directory);
    ops.fail_hide.set(true);
    assert_eq!(
        replay_advance(&state).unwrap_err().code,
        WireCommandErrorCode::Internal
    );
    assert_eq!(RollbackSnapshot::capture(&state, &directory), before);

    ops.fail_hide.set(false);
    let ended = replay_advance(&state).unwrap();
    assert!(matches!(ended.snapshot.prompt, PromptSnapshot::End { .. }));
    assert!(state.secondary().unwrap().is_none());
}

#[test]
fn failed_replay_entry_restores_the_story_owned_window() {
    let (directory, ops, state) = state_with(replay_test_content());
    // The story owns the window first: entry is an ownership handoff.
    show_test_secondary(&state, "ambience_lab").unwrap();
    let story_session = state
        .secondary()
        .unwrap()
        .clone()
        .expect("the story's window");
    assert!(matches!(story_session.owner, SecondaryOwner::Story { .. }));
    let before_main = main_snapshot(&state);
    let before_history = state.runtime().unwrap().dialogue_history().to_vec();
    let before_profile_file = profile_file(&directory);

    // The handoff's native show fails after creating the window, so the replay
    // must not become the owner and the story's session must survive.
    ops.fail_show_after_create.set(true);
    assert_eq!(
        enter_replay(&state, "replay_lab").unwrap_err().code,
        WireCommandErrorCode::Internal
    );
    assert!(state.replay().unwrap().is_none());
    let slot = state.secondary().unwrap();
    let session = slot
        .as_ref()
        .expect("the previous story owner must be restored");
    assert_eq!(session.token, story_session.token);
    assert_eq!(session.scene_id, story_session.scene_id);
    assert_eq!(session.owner, story_session.owner);
    assert_eq!(
        session.runtime.dialogue_history(),
        story_session.runtime.dialogue_history()
    );
    drop(slot);
    assert_eq!(main_snapshot(&state), before_main);
    assert_eq!(
        state.runtime().unwrap().dialogue_history(),
        before_history.as_slice()
    );
    assert_eq!(profile_file(&directory), before_profile_file);

    // Once the native step works the entry really hands the same window to the
    // replay, with a fresh identity.
    ops.fail_show_after_create.set(false);
    enter_replay(&state, "replay_lab").unwrap();
    let slot = state.secondary().unwrap();
    let session = slot.as_ref().expect("the replay now owns the window");
    assert_eq!(session.scene_id, "ambience_lab");
    assert_ne!(session.token, story_session.token);
    assert!(matches!(session.owner, SecondaryOwner::Replay { .. }));
}

#[test]
fn a_replay_open_window_followed_by_a_gated_node_keeps_its_acknowledgement() {
    let mut content = replay_test_content();
    let scene = content.scenes.get_mut("replay_lab").unwrap();
    scene
        .nodes
        .insert("open_child".to_owned(), open_side("hold"));
    scene.nodes.insert(
        "hold".to_owned(),
        SceneNode::Wait {
            duration_ms: 10,
            next: "line".to_owned(),
        },
    );
    let (_directory, _ops, state) = state_with(content);
    let first = enter_replay(&state, "replay_lab").unwrap();
    // The control cue is gone, but the runtime-gated node that followed it still
    // needs exactly its own acknowledgement.
    assert!(!has_open_window_cue(&first));
    assert!(first.requires_ack);
    assert!(first.cues.iter().any(|cue| cue.gate == CueGate::Runtime));
    assert_eq!(secondary_snapshot(&state).location.scene_id, "ambience_lab");

    // Acknowledging that exact update unblocks the replay, and the
    // acknowledgement path also consumes the control cue.
    let acknowledged = state
        .transact_replay(|runtime| {
            runtime.presentation_complete(
                &state.content,
                first.update_id,
                PresentationOutcome::Completed,
            )
        })
        .unwrap();
    assert!(!has_open_window_cue(&acknowledged));
    assert!(!acknowledged.requires_ack);
}

#[test]
fn replay_isolates_the_window_pair_and_the_story_returns_without_the_closed_windows_effects() {
    let content = with_replays(
        content_with(
            (
                "open",
                vec![
                    ("open", open_side("say")),
                    ("say", say("A", "end")),
                    ("end", SceneNode::End),
                ],
            ),
            (
                "lock",
                vec![
                    (
                        "lock",
                        control(
                            WindowRole::Main,
                            WindowControlAction::Block,
                            "side_lock",
                            "rename",
                        ),
                    ),
                    ("rename", title(WindowRole::Secondary, "Mine", "s1")),
                    ("s1", say("side1", "s_end")),
                    ("s_end", SceneNode::End),
                ],
            ),
        ),
        &["prologue"],
    );
    let (_directory, ops, state) = state_with(content);
    start_game(&state);
    // The story's secondary blocked the main window and renamed itself.
    let story_before = main_snapshot(&state);
    assert_eq!(story_before.interaction.blocks.len(), 1);
    assert_eq!(story_before.interaction.titles.secondary, "Mine");
    assert_eq!(
        ops.last_title(WindowRole::Secondary).as_deref(),
        Some("Mine")
    );

    enter_replay(&state, "prologue").unwrap();
    // The replay re-points the one window; the story-owned window is closed, so
    // its block and title no longer apply to the suspended story.
    assert!(matches!(
        state.secondary().unwrap().as_ref().unwrap().owner,
        SecondaryOwner::Replay { .. }
    ));
    let story_during = main_snapshot(&state);
    assert!(story_during.interaction.blocks.is_empty());
    assert_eq!(story_during.interaction.titles.secondary, "");
    assert_eq!(story_during.location, story_before.location);

    exit_replay(&state).unwrap();
    assert!(state.secondary().unwrap().is_none());
    assert_eq!(
        state.desired_titles().unwrap(),
        ("VECTSPACE".to_owned(), None)
    );
    assert_eq!(main_snapshot(&state).location, story_before.location);
}

#[test]
fn a_replay_entered_from_the_chapter_map_runs_its_titles_and_timers_until_it_exits() {
    let mut content = interaction::timer_content();
    let prologue = content.scenes.get_mut("prologue").unwrap();
    prologue.entry = "rename".to_owned();
    prologue.nodes.insert(
        "rename".to_owned(),
        title(WindowRole::Main, "Replay", "tstart"),
    );
    // The chapter map is part of the title screen: no story was started.
    let (_directory, ops, state) = state_with(with_replays(content, &["prologue"]));
    assert!(state.pause_state().unwrap().title);
    enter_replay(&state, "prologue").unwrap();
    assert_eq!(ops.last_title(WindowRole::Main).as_deref(), Some("Replay"));
    assert!(
        state.next_timer_wait().is_some(),
        "the replay's timer is live"
    );
    state.timer_step(150).unwrap();
    assert_eq!(
        state
            .replay()
            .unwrap()
            .as_ref()
            .unwrap()
            .runtime
            .snapshot()
            .variables["score"],
        ScalarValue::Integer(1)
    );

    exit_replay(&state).unwrap();
    assert!(
        state.pause_state().unwrap().title,
        "back on the chapter map"
    );
    assert_eq!(
        ops.last_title(WindowRole::Main).as_deref(),
        Some("VECTSPACE")
    );
    assert!(state.next_timer_wait().is_none());
}

#[test]
fn a_secondary_scene_is_never_a_valid_replay_entry() {
    let content = with_replays(secondary_test_catalog(), &["ambience_lab"]);
    let (_directory, _ops, state) = state_with(content);
    let error = enter_replay(&state, "ambience_lab").unwrap_err();
    assert!(error.message.contains("副窗口专用"), "{}", error.message);
    assert!(state.replay().unwrap().is_none());
    assert!(
        state.pause_state().unwrap().title,
        "a failed entry stays on the chapter map"
    );
}
