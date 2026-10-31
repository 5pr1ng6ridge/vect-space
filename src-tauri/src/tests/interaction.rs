//! The atomic two-window transactions: shared state and derived-state refresh,
//! ordered window-control nodes, titles, scene timers, pause, delivery sequence
//! numbers and save/restore.

use super::*;
use crate::{
    pair::Produced,
    save::{LoadedSlot, SecondaryState, SlotDocument},
};
use vectspace_core::{
    interaction::{TimerAction, UpdateKind},
    model::{ChoiceDefinition, ConditionExpression, LiteralOperand, ValueOperand, VariableOperand},
};
use vectspace_protocol::WirePauseReason;

fn choice_ids(prompt: &PromptSnapshot) -> Vec<String> {
    match prompt {
        PromptSnapshot::Choice { choices, .. } => {
            choices.iter().map(|choice| choice.id.clone()).collect()
        }
        other => panic!("expected a choice prompt, got {other:?}"),
    }
}

fn pick_choice() -> SceneNode {
    SceneNode::Choice {
        presentation: None,
        choices: vec![
            ChoiceDefinition {
                id: "always".to_owned(),
                label: "Always".to_owned(),
                next: "done".to_owned(),
                visible_if: None,
                enabled_if: None,
                template: None,
                icon: None,
            },
            ChoiceDefinition {
                id: "gated".to_owned(),
                label: "Gated [var=score]".to_owned(),
                next: "done".to_owned(),
                visible_if: Some(ConditionExpression::Eq {
                    left: ValueOperand::Variable(VariableOperand {
                        variable: "score".to_owned(),
                    }),
                    right: ValueOperand::Literal(LiteralOperand {
                        value: ScalarValue::Integer(1),
                    }),
                }),
                enabled_if: None,
                template: None,
                icon: None,
            },
        ],
    }
}

#[test]
fn a_title_node_takes_effect_before_the_next_line_and_on_the_native_windows() {
    let (_directory, ops, state) = state_with(content_with(
        (
            "open",
            vec![
                ("open", open_side("rename")),
                (
                    "rename",
                    title(WindowRole::Secondary, "S-[var=window.main.title]", "say"),
                ),
                ("say", say("main:[var=window.secondary.title]", "end")),
                ("end", SceneNode::End),
            ],
        ),
        (
            "s_say",
            vec![("s_say", say("side", "s_end")), ("s_end", SceneNode::End)],
        ),
    ));
    let first = start_game(&state);
    // The line right after the title node already sees the new title.
    assert_eq!(dialogue_text(&first.snapshot.prompt), "main:S-VECTSPACE");
    assert_eq!(
        main_snapshot(&state).interaction.titles.secondary,
        "S-VECTSPACE"
    );
    assert_eq!(
        secondary_snapshot(&state).interaction.titles.secondary,
        "S-VECTSPACE"
    );
    assert_eq!(
        ops.last_title(WindowRole::Secondary).as_deref(),
        Some("S-VECTSPACE")
    );
    // The secondary window's opening node could already read the main title.
    assert_eq!(dialogue_text(&secondary_snapshot(&state).prompt), "side");
}

#[test]
fn a_failed_native_title_rolls_back_the_whole_command_and_publishes_nothing() {
    let (_directory, ops, state) = state_with(content_with(
        (
            "s1",
            vec![
                ("s1", say("one", "t")),
                ("t", title(WindowRole::Main, "Renamed", "s2")),
                ("s2", say("two [var=window.main.title]", "end")),
                ("end", SceneNode::End),
            ],
        ),
        ("x", vec![("x", SceneNode::End)]),
    ));
    start_game(&state);
    let before = main_snapshot(&state);
    let seq_before = state.latest_seq(WindowRole::Main).unwrap();
    ops.fail_title.set(true);
    let error = main_advance(&state).unwrap_err();
    assert!(error.message.contains("标题"), "{}", error.message);
    // Memory, the outbox and the notifications all stay where they were.
    assert_eq!(main_snapshot(&state), before);
    assert_eq!(state.latest_seq(WindowRole::Main).unwrap(), seq_before);
    assert!(ops
        .notices
        .lock()
        .unwrap()
        .iter()
        .all(|(_, seq)| seq.parse::<u64>().unwrap() <= seq_before));
    // The retry succeeds and drives the native title.
    ops.fail_title.set(false);
    let update = main_advance(&state).unwrap();
    assert_eq!(dialogue_text(&update.snapshot.prompt), "two Renamed");
    assert_eq!(ops.last_title(WindowRole::Main).as_deref(), Some("Renamed"));
}

#[test]
fn a_secondary_command_refreshes_the_main_choice_without_replaying_the_prompt() {
    let (_directory, ops, state) = state_with(content_with(
        (
            "open",
            vec![
                ("open", open_side("say")),
                ("say", say("main", "pick")),
                ("pick", pick_choice()),
                ("done", SceneNode::End),
            ],
        ),
        (
            "s_say",
            vec![
                ("s_say", say("side", "bump")),
                ("bump", set_score(VariableOperation::Assign, 1, "s_end")),
                ("s_end", SceneNode::End),
            ],
        ),
    ));
    start_game(&state);
    let at_choice = main_advance(&state).unwrap();
    assert_eq!(choice_ids(&at_choice.snapshot.prompt), vec!["always"]);
    let instance = at_choice.snapshot.interaction.prompt_instance.clone();
    let seq = state.latest_seq(WindowRole::Main).unwrap();

    // The secondary window changes a shared variable; the main window's
    // visible options follow immediately, with no click on the main window.
    secondary_advance(&state).unwrap();
    assert_eq!(
        choice_ids(&main_snapshot(&state).prompt),
        vec!["always", "gated"]
    );
    let batch = state.sync_batch(WindowRole::Main, seq).unwrap();
    assert!(!batch.gap);
    let refresh = batch
        .updates
        .iter()
        .find(|update| update.kind == UpdateKind::StateRefresh)
        .expect("a state refresh reaches the main window");
    // Same prompt occurrence: the frontend keeps its focus and animation.
    assert_eq!(refresh.snapshot.interaction.prompt_instance, instance);
    assert!(refresh.cues.is_empty());
    assert!(ops
        .notices
        .lock()
        .unwrap()
        .iter()
        .any(|(role, _)| *role == WindowRole::Main));
}

#[test]
fn a_state_refresh_keeps_the_pending_acknowledgement_valid() {
    let (_directory, _ops, state) = state_with(content_with(
        (
            "open",
            vec![
                ("open", open_side("hold")),
                (
                    "hold",
                    SceneNode::Wait {
                        duration_ms: 100,
                        next: "say".to_owned(),
                    },
                ),
                ("say", say("main", "end")),
                ("end", SceneNode::End),
            ],
        ),
        (
            "s_say",
            vec![
                ("s_say", say("side", "bump")),
                ("bump", set_score(VariableOperation::Assign, 7, "s_end")),
                ("s_end", SceneNode::End),
            ],
        ),
    ));
    let first = start_game(&state);
    assert!(first.requires_ack);
    let pending = state.runtime().unwrap().pending_runtime_update();
    assert_eq!(pending, Some(first.update_id.parse().unwrap()));
    let seq = state.latest_seq(WindowRole::Main).unwrap();

    secondary_advance(&state).unwrap();
    // The refresh is a separate update; the main window's gate is untouched.
    let batch = state.sync_batch(WindowRole::Main, seq).unwrap();
    assert!(batch
        .updates
        .iter()
        .any(|update| update.kind == UpdateKind::StateRefresh));
    assert_eq!(state.runtime().unwrap().pending_runtime_update(), pending);
    let session = WireU64::from(state.current_session_id());
    let update = state
        .transact_active_runtime(Some(&session), |runtime| {
            runtime.presentation_complete(
                &state.content,
                pending.unwrap(),
                PresentationOutcome::Completed,
            )
        })
        .unwrap();
    assert_eq!(dialogue_text(&update.snapshot.prompt), "main");
}

fn block_content() -> ContentCatalog {
    content_with(
        (
            "open",
            vec![
                ("open", open_side("lock")),
                (
                    "lock",
                    control(
                        WindowRole::Secondary,
                        WindowControlAction::Block,
                        "lock",
                        "say_a",
                    ),
                ),
                ("say_a", say("A", "unlock")),
                (
                    "unlock",
                    control(
                        WindowRole::Secondary,
                        WindowControlAction::Unblock,
                        "lock",
                        "adv",
                    ),
                ),
                (
                    "adv",
                    control(
                        WindowRole::Secondary,
                        WindowControlAction::Advance,
                        "",
                        "say_b",
                    ),
                ),
                ("say_b", say("B", "end")),
                ("end", SceneNode::End),
            ],
        ),
        (
            "s1",
            vec![
                ("s1", say("side1", "s2")),
                ("s2", say("side2", "s_end")),
                ("s_end", SceneNode::End),
            ],
        ),
    )
}

#[test]
fn unblock_then_scripted_advance_is_one_atomic_page_turn() {
    let (_directory, _ops, state) = state_with(block_content());
    start_game(&state);
    // The main story's block is visible on the secondary and stops its paging.
    let blocks = secondary_snapshot(&state).interaction.blocks;
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].id, "lock");
    assert_eq!(blocks[0].source, WindowRole::Main);
    assert_eq!(blocks[0].source_scene, "prologue");
    let before = secondary_snapshot(&state);
    assert!(secondary_advance(&state).is_err());
    assert_eq!(
        secondary_snapshot(&state),
        before,
        "a refused advance changes nothing"
    );

    // One main-window page turn runs unblock and the scripted advance in node
    // order: the secondary pages exactly once, and nothing stays blocked.
    let update = main_advance(&state).unwrap();
    assert_eq!(dialogue_text(&update.snapshot.prompt), "B");
    let side = secondary_snapshot(&state);
    assert_eq!(dialogue_text(&side.prompt), "side2");
    assert!(side.interaction.blocks.is_empty());
    assert!(main_snapshot(&state).interaction.blocks.is_empty());
}

#[test]
fn a_scripted_advance_does_not_wait_for_a_future_page_or_pick_a_choice() {
    // The secondary is at a Choice: a scripted advance neither picks nor queues.
    let (_directory, _ops, state) = state_with(content_with(
        (
            "open",
            vec![
                ("open", open_side("say")),
                ("say", say("A", "adv")),
                (
                    "adv",
                    control(
                        WindowRole::Secondary,
                        WindowControlAction::Advance,
                        "",
                        "say_b",
                    ),
                ),
                ("say_b", say("B", "end")),
                ("end", SceneNode::End),
            ],
        ),
        (
            "pick",
            vec![("pick", pick_choice()), ("done", SceneNode::End)],
        ),
    ));
    start_game(&state);
    let before = secondary_snapshot(&state);
    let update = main_advance(&state).unwrap();
    assert_eq!(dialogue_text(&update.snapshot.prompt), "B");
    assert_eq!(
        choice_ids(&secondary_snapshot(&state).prompt),
        choice_ids(&before.prompt)
    );
}

pub(super) fn timer_content() -> ContentCatalog {
    content_with(
        (
            "tstart",
            vec![
                (
                    "tstart",
                    SceneNode::Timer {
                        id: "t".to_owned(),
                        action: TimerAction::Start,
                        delay_ms: 100,
                        interval_ms: None,
                        target: Some("bump".to_owned()),
                        next: "wait_say".to_owned(),
                    },
                ),
                ("bump", set_score(VariableOperation::Add, 1, "wait_say")),
                ("wait_say", say("w", "end")),
                ("end", SceneNode::End),
            ],
        ),
        ("x", vec![("x", SceneNode::End)]),
    )
}

#[test]
fn a_timer_effect_runs_without_moving_the_story_and_is_published_as_an_effect() {
    let (_directory, _ops, state) = state_with(timer_content());
    start_game(&state);
    let location = main_snapshot(&state).location;
    assert_eq!(
        main_snapshot(&state).interaction.timers["t"].remaining_ms,
        100
    );
    let seq = state.latest_seq(WindowRole::Main).unwrap();

    // Not due yet: the stored remaining time moves, nothing is published.
    state.timer_step(60).unwrap();
    assert_eq!(
        main_snapshot(&state).interaction.timers["t"].remaining_ms,
        40
    );
    assert_eq!(state.latest_seq(WindowRole::Main).unwrap(), seq);

    state.timer_step(50).unwrap();
    let snapshot = main_snapshot(&state);
    assert_eq!(snapshot.location, location, "a timer never moves the story");
    assert_eq!(snapshot.variables["score"], ScalarValue::Integer(1));
    assert!(
        snapshot.interaction.timers.is_empty(),
        "a one-shot timer ends"
    );
    let batch = state.sync_batch(WindowRole::Main, seq).unwrap();
    let effect = batch
        .updates
        .iter()
        .find(|update| update.kind == UpdateKind::Effect)
        .expect("the callback is an effect update");
    assert_eq!(effect.effect_timer.as_deref(), Some("t"));
    assert!(!effect.requires_ack);
}

#[test]
fn timers_stand_still_while_paused_or_on_the_title_screen_and_never_replay_the_paused_time() {
    let (_directory, _ops, state) = state_with(timer_content());
    start_game(&state);
    assert!(state.next_timer_wait().is_some());
    let ack = state
        .set_pause(WindowRole::Main, WirePauseReason::Panel, true)
        .unwrap();
    assert!(ack.paused);
    assert!(state.next_timer_wait().is_none());
    state.timer_step(1_000).unwrap();
    assert_eq!(
        main_snapshot(&state).interaction.timers["t"].remaining_ms,
        100
    );
    // Closing the panel resumes with the full remaining time.
    assert!(
        !state
            .set_pause(WindowRole::Main, WirePauseReason::Panel, false)
            .unwrap()
            .paused
    );
    assert_eq!(
        main_snapshot(&state).interaction.timers["t"].remaining_ms,
        100
    );
    assert!(state.next_timer_wait().is_some());

    // The title screen has no running story: nothing is credited at all.
    {
        let _gate = state.session_gate().unwrap();
        state.close_secondary().unwrap();
        state.bump_session_id().unwrap();
        state.set_title_screen(true);
    }
    let seq = state.latest_seq(WindowRole::Main).unwrap();
    state.timer_step(10_000).unwrap();
    assert_eq!(
        main_snapshot(&state).variables["score"],
        ScalarValue::Integer(0)
    );
    assert_eq!(state.latest_seq(WindowRole::Main).unwrap(), seq);
    assert!(state.next_timer_wait().is_none());
}

#[test]
fn only_a_fully_hidden_window_pair_or_an_open_panel_pauses() {
    let (_directory, _ops, state) = state_with(content_with(
        (
            "open",
            vec![
                ("open", open_side("say")),
                ("say", say("m", "end")),
                ("end", SceneNode::End),
            ],
        ),
        ("s", vec![("s", say("s", "e")), ("e", SceneNode::End)]),
    ));
    start_game(&state);
    assert!(state.secondary().unwrap().is_some());
    let hidden = |role, active| {
        state
            .set_pause(role, WirePauseReason::Hidden, active)
            .unwrap()
    };
    // The main window alone being hidden (focus moved to the secondary) is fine.
    assert!(!hidden(WindowRole::Main, true).paused);
    assert!(hidden(WindowRole::Secondary, true).paused);
    assert!(!hidden(WindowRole::Secondary, false).paused);
    assert!(!hidden(WindowRole::Main, false).paused);
    // A panel pauses on its own.
    assert!(
        state
            .set_pause(WindowRole::Main, WirePauseReason::Panel, true)
            .unwrap()
            .paused
    );
    // The secondary has no panels.
    assert!(state
        .set_pause(WindowRole::Secondary, WirePauseReason::Panel, true)
        .is_err());
    // A new session voids every report.
    state.bump_session_id().unwrap();
    assert!(!state.timers_paused());
}

#[test]
fn a_timer_whose_host_request_fails_is_stopped_with_a_diagnostic() {
    let (_directory, ops, state) = state_with(content_with(
        (
            "tstart",
            vec![
                (
                    "tstart",
                    SceneNode::Timer {
                        id: "t".to_owned(),
                        action: TimerAction::Start,
                        delay_ms: 10,
                        interval_ms: Some(100),
                        target: Some("ttl".to_owned()),
                        next: "wait_say".to_owned(),
                    },
                ),
                ("ttl", title(WindowRole::Secondary, "x", "wait_say")),
                ("wait_say", say("w", "end")),
                ("end", SceneNode::End),
            ],
        ),
        ("x", vec![("x", SceneNode::End)]),
    ));
    start_game(&state);
    state.timer_step(20).unwrap();
    assert!(main_snapshot(&state).interaction.timers.is_empty());
    let diagnostics = ops.diagnostics();
    assert!(
        diagnostics
            .iter()
            .any(|message| message.contains("计时器 t 已停止")),
        "{diagnostics:?}"
    );
    // No error storm: nothing is left to fail again.
    let count = diagnostics.len();
    state.timer_step(1_000).unwrap();
    assert_eq!(ops.diagnostics().len(), count);
}

#[test]
fn a_buffer_gap_returns_the_pending_story_update_and_the_latest_state() {
    let (_directory, _ops, state) = state_with(content_with(
        (
            "hold",
            vec![
                (
                    "hold",
                    SceneNode::Wait {
                        duration_ms: 100,
                        next: "say".to_owned(),
                    },
                ),
                ("say", say("main", "end")),
                ("end", SceneNode::End),
            ],
        ),
        ("x", vec![("x", SceneNode::End)]),
    ));
    let first = start_game(&state);
    for _ in 0..40 {
        let mut update = state
            .runtime()
            .unwrap()
            .clone()
            .bootstrap(&state.content)
            .update;
        update.kind = UpdateKind::StateRefresh;
        state
            .publish(
                vec![Produced {
                    role: WindowRole::Main,
                    update,
                }],
                Vec::new(),
            )
            .unwrap();
    }
    let latest = state.latest_seq(WindowRole::Main).unwrap();
    assert!(latest > 32);
    let batch = state.sync_batch(WindowRole::Main, 1).unwrap();
    assert!(batch.gap);
    assert_eq!(batch.latest_seq, WireU64::from(latest));
    // The update the runtime still waits on keeps its id; only gated cues stay.
    let pending = &batch.updates[0];
    assert_eq!(pending.update_id, first.update_id);
    assert!(pending.requires_ack);
    assert!(pending.cues.iter().all(|cue| cue.gate == CueGate::Runtime));
    let refresh = batch.updates.last().unwrap();
    assert_eq!(refresh.kind, UpdateKind::StateRefresh);
    assert!(refresh.cues.is_empty());
    // A caller that is ahead of the host is also a gap, never an empty success.
    assert!(state.sync_batch(WindowRole::Main, latest + 5).unwrap().gap);
    // Up to date: nothing to deliver.
    let none = state.sync_batch(WindowRole::Main, latest).unwrap();
    assert!(!none.gap && none.updates.is_empty());
}

#[test]
fn a_bootstrap_never_reuses_an_update_id_of_the_next_real_update() {
    let (_directory, _ops, state) = state_with(content_with(
        (
            "s1",
            vec![
                ("s1", say("one", "s2")),
                ("s2", say("two", "end")),
                ("end", SceneNode::End),
            ],
        ),
        ("x", vec![("x", SceneNode::End)]),
    ));
    start_game(&state);
    let (boot, _) = state.bootstrap_update(WindowRole::Main).unwrap();
    let next = main_advance(&state).unwrap();
    assert_ne!(boot.update_id, next.update_id);
    assert_eq!(boot.seq, WireU64::from(1));
    assert_eq!(next.seq, WireU64::from(2));
}

#[test]
fn saving_and_loading_restore_titles_blocks_and_timer_remaining_time() {
    let (_directory, ops, state) = state_with(content_with(
        (
            "open",
            vec![
                ("open", open_side("rename")),
                ("rename", title(WindowRole::Secondary, "Side", "lock")),
                (
                    "lock",
                    control(
                        WindowRole::Secondary,
                        WindowControlAction::Block,
                        "lock",
                        "tstart",
                    ),
                ),
                (
                    "tstart",
                    SceneNode::Timer {
                        id: "t".to_owned(),
                        action: TimerAction::Start,
                        delay_ms: 500,
                        interval_ms: None,
                        target: Some("bump".to_owned()),
                        next: "say_a".to_owned(),
                    },
                ),
                ("bump", set_score(VariableOperation::Add, 1, "say_a")),
                ("say_a", say("A", "retitle")),
                ("retitle", title(WindowRole::Main, "Changed", "say_b")),
                ("say_b", say("B", "end")),
                ("end", SceneNode::End),
            ],
        ),
        (
            "s1",
            vec![("s1", say("side1", "s_end")), ("s_end", SceneNode::End)],
        ),
    ));
    start_game(&state);
    // Save exactly like the `save_slot` command does.
    let snapshot = main_snapshot(&state);
    let secondary = {
        let slot = state.secondary().unwrap();
        let session = slot.as_ref().unwrap();
        SecondaryState {
            scene_id: session.scene_id.clone(),
            owning_scene: session.owner.story_scene().unwrap().to_owned(),
            snapshot: session.runtime.snapshot().clone(),
            profile: session.runtime.profile_state(&state.content),
        }
    };
    let history = state.runtime().unwrap().dialogue_history().to_vec();
    state
        .saves
        .save(
            "1",
            SlotDocument {
                snapshot: &snapshot,
                history: &history,
                secondary: Some(&secondary),
            },
            None,
        )
        .unwrap();
    assert_eq!(snapshot.interaction.titles.secondary, "Side");
    assert_eq!(snapshot.interaction.timers["t"].remaining_ms, 500);

    // Play on: the main title changes and part of the timer elapses.
    state.timer_step(200).unwrap();
    main_advance(&state).unwrap();
    assert_eq!(main_snapshot(&state).interaction.titles.main, "Changed");
    assert_eq!(ops.last_title(WindowRole::Main).as_deref(), Some("Changed"));

    // Loading restores titles, the block and the remaining time — not the
    // process time — and re-binds everything to a new session.
    let session_before = state.current_session_id();
    {
        let _gate = state.session_gate().unwrap();
        let loaded = state.saves.load("1").unwrap();
        let committed = state.apply_loaded_slot(loaded).unwrap();
        state.bump_session_id().unwrap();
        state.deliver(committed, WindowRole::Main).unwrap();
    }
    assert!(state.current_session_id() > session_before);
    let restored = main_snapshot(&state);
    assert_eq!(restored.interaction.titles.main, "VECTSPACE");
    assert_eq!(restored.interaction.titles.secondary, "Side");
    assert_eq!(restored.interaction.timers["t"].remaining_ms, 500);
    assert_eq!(
        ops.last_title(WindowRole::Main).as_deref(),
        Some("VECTSPACE")
    );
    assert_eq!(
        ops.last_title(WindowRole::Secondary).as_deref(),
        Some("Side")
    );
    let side = secondary_snapshot(&state);
    assert_eq!(side.interaction.blocks.len(), 1);
    assert_eq!(side.interaction.titles.secondary, "Side");
}

#[test]
fn loading_a_slot_whose_block_source_does_not_exist_is_refused_as_a_whole() {
    let (_directory, _ops, state) = state_with(block_content());
    start_game(&state);
    let mut snapshot = main_snapshot(&state);
    // A block that claims the (absent) secondary window as its source.
    snapshot
        .interaction
        .blocks
        .push(vectspace_core::interaction::AdvanceBlock {
            id: "ghost".to_owned(),
            source: WindowRole::Secondary,
            source_scene: "ambience_lab".to_owned(),
            message: String::new(),
            message_template: None,
        });
    let before = main_snapshot(&state);
    let secondary_before = secondary_snapshot(&state);
    let _gate = state.session_gate().unwrap();
    let error = state
        .apply_loaded_slot(LoadedSlot {
            snapshot,
            history: Vec::new(),
            secondary: None,
        })
        .unwrap_err();
    assert_eq!(error.code, WireCommandErrorCode::Validation);
    drop(_gate);
    assert_eq!(main_snapshot(&state), before);
    assert_eq!(secondary_snapshot(&state), secondary_before);
}

#[test]
fn a_request_from_an_older_session_is_stale() {
    let (_directory, _ops, state) = state_with(secondary_test_catalog());
    let stale = |request: Option<u64>| {
        state
            .check_session(request.map(WireU64::from).as_ref())
            .map_err(|error| error.code)
    };
    assert_eq!(stale(Some(1)), Ok(()));
    assert_eq!(stale(None), Err(WireCommandErrorCode::StaleSession));
    state.bump_session_id().unwrap();
    assert_eq!(stale(Some(1)), Err(WireCommandErrorCode::StaleSession));
    assert_eq!(stale(Some(2)), Ok(()));
}
