//! Host-level tests of the atomic two-window transactions: shared state and
//! derived-state refresh, ordered window-control nodes, titles, scene timers,
//! pause, delivery sequence numbers and save/restore.  Every test runs against
//! in-memory content and the recording native seam; nothing needs a WebView.

use super::pair::Produced;
use super::*;
use vectspace_core::{
    interaction::{TimerAction, UpdateKind, WindowControlAction},
    model::{
        ChoiceDefinition, ConditionExpression, LiteralOperand, PromptSnapshot, ValueOperand,
        VariableOperand,
    },
};

pub(super) fn say(text: &str, next: &str) -> SceneNode {
    replay_say(text, next)
}

pub(super) fn scene(
    role: WindowRole,
    id: &str,
    entry: &str,
    nodes: Vec<(&str, SceneNode)>,
) -> SceneDefinition {
    SceneDefinition {
        window_role: role,
        schema_version: 1,
        id: id.to_owned(),
        entry: entry.to_owned(),
        nodes: nodes
            .into_iter()
            .map(|(id, node)| (id.to_owned(), node))
            .collect(),
    }
}

pub(super) fn open_side(next: &str) -> SceneNode {
    SceneNode::OpenWindow {
        scene: "ambience_lab".to_owned(),
        next: next.to_owned(),
    }
}

pub(super) fn set_score(op: VariableOperation, value: i64, next: &str) -> SceneNode {
    SceneNode::Set {
        variable: "score".to_owned(),
        op,
        value: Some(MutationValue::Literal(ScalarValue::Integer(value))),
        next: next.to_owned(),
    }
}

pub(super) fn title(target: WindowRole, text: &str, next: &str) -> SceneNode {
    SceneNode::WindowTitle {
        target,
        title: text.to_owned(),
        next: next.to_owned(),
    }
}

fn control(target: WindowRole, action: WindowControlAction, id: &str, next: &str) -> SceneNode {
    SceneNode::WindowControl {
        target,
        action,
        id: id.to_owned(),
        message: if action == WindowControlAction::Block {
            "locked".to_owned()
        } else {
            String::new()
        },
        next: next.to_owned(),
    }
}

/// Replace the entry Scene (`prologue`, Main) and the secondary Scene
/// (`ambience_lab`) with the given nodes.
pub(super) fn content_with(
    main: (&str, Vec<(&str, SceneNode)>),
    side: (&str, Vec<(&str, SceneNode)>),
) -> ContentCatalog {
    let mut content = secondary_test_catalog();
    content.scenes.insert(
        "prologue".to_owned(),
        scene(WindowRole::Main, "prologue", main.0, main.1),
    );
    content.scenes.insert(
        "ambience_lab".to_owned(),
        scene(WindowRole::Secondary, "ambience_lab", side.0, side.1),
    );
    content
}

pub(super) fn state_with(
    content: ContentCatalog,
) -> (tempfile::TempDir, Arc<RecordingWindowOps>, EngineState) {
    let directory = tempdir().unwrap();
    let ops = Arc::new(RecordingWindowOps::default());
    let state = secondary_state_with_content(&directory, content, ops.clone());
    (directory, ops, state)
}

/// What the `start_new_game` command does.
pub(super) fn start_game(state: &EngineState) -> WireRuntimeUpdate {
    let _gate = state.session_gate().unwrap();
    state.set_title_screen(false);
    let committed = state
        .transact_runtime_forced(|runtime| runtime.start_new_game(&state.content), true)
        .unwrap();
    state.bump_session_id().unwrap();
    state.deliver(committed, WindowRole::Main).unwrap()
}

pub(super) fn main_advance(state: &EngineState) -> Result<WireRuntimeUpdate, WireCommandError> {
    let revision = state.runtime().unwrap().snapshot().revision;
    let session = WireU64::from(state.current_session_id());
    state.transact_active_runtime(Some(&session), |runtime| {
        runtime.advance(&state.content, revision, AdvanceSource::Manual)
    })
}

pub(super) fn secondary_advance(state: &EngineState) -> Result<WireRuntimeUpdate, WireCommandError> {
    let _gate = state.session_gate().unwrap();
    let token = state.secondary().unwrap().as_ref().unwrap().token;
    let (committed, _) = state.transact_secondary(Some(&WireU64::from(token)), |runtime| {
        let revision = runtime.snapshot().revision;
        runtime.advance(&state.content, revision, AdvanceSource::Manual)
    })?;
    state.deliver(committed, WindowRole::Secondary)
}

pub(super) fn dialogue_text(prompt: &PromptSnapshot) -> String {
    match prompt {
        PromptSnapshot::Dialogue { text, .. } | PromptSnapshot::LongText { text, .. } => {
            text.clone()
        }
        other => panic!("expected a dialogue prompt, got {other:?}"),
    }
}

pub(super) fn secondary_snapshot(state: &EngineState) -> vectspace_core::model::RuntimeSnapshot {
    state
        .secondary()
        .unwrap()
        .as_ref()
        .expect("a live secondary")
        .runtime
        .snapshot()
        .clone()
}

pub(super) fn main_snapshot(state: &EngineState) -> vectspace_core::model::RuntimeSnapshot {
    state.runtime().unwrap().snapshot().clone()
}

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
    ops.fail_title.store(true, Ordering::Release);
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
    ops.fail_title.store(false, Ordering::Release);
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

#[test]
fn a_title_for_a_window_that_does_not_exist_is_a_clear_error_and_changes_nothing() {
    let (_directory, _ops, state) = state_with(content_with(
        (
            "s1",
            vec![
                ("s1", say("one", "t")),
                ("t", title(WindowRole::Secondary, "x", "s2")),
                ("s2", say("two", "end")),
                ("end", SceneNode::End),
            ],
        ),
        ("x", vec![("x", SceneNode::End)]),
    ));
    start_game(&state);
    let before = main_snapshot(&state);
    let error = main_advance(&state).unwrap_err();
    assert!(error.message.contains("副窗口不存在"), "{}", error.message);
    assert_eq!(main_snapshot(&state), before);
}

fn timer_content() -> ContentCatalog {
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
fn timers_stand_still_while_paused_and_never_replay_the_paused_time() {
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
    let diagnostics = ops.diagnostics.lock().unwrap().clone();
    assert!(
        diagnostics
            .iter()
            .any(|message| message.contains("计时器 t 已停止")),
        "{diagnostics:?}"
    );
    // No error storm: nothing is left to fail again.
    let count = diagnostics.len();
    state.timer_step(1_000).unwrap();
    assert_eq!(ops.diagnostics.lock().unwrap().len(), count);
}

#[test]
fn the_title_screen_has_no_running_timers() {
    let (_directory, _ops, state) = state_with(timer_content());
    start_game(&state);
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
fn replay_isolates_the_window_pair_and_the_story_returns_without_the_closed_windows_effects() {
    let mut content = content_with(
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
    );
    content.chapter_map = Some(ChapterMapDefinition {
        schema_version: 1,
        width: 1920,
        height: 1080,
        view_x: 0,
        view_y: 0,
        background: None,
        decorations: Vec::new(),
        hotspots: vec![replay_hotspot("prologue")],
    });
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
    {
        let _gate = state.session_gate().unwrap();
        state.enter_replay("prologue").unwrap();
    }
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
    {
        let _gate = state.session_gate().unwrap();
        state.exit_replay().unwrap();
    }
    assert!(state.secondary().unwrap().is_none());
    assert_eq!(
        state.desired_titles().unwrap(),
        ("VECTSPACE".to_owned(), None)
    );
    assert_eq!(main_snapshot(&state).location, story_before.location);
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
fn a_secondary_scene_is_never_a_valid_story_or_replay_entry_in_the_host() {
    let mut content = block_content();
    content.chapter_map = Some(ChapterMapDefinition {
        schema_version: 1,
        width: 1920,
        height: 1080,
        view_x: 0,
        view_y: 0,
        background: None,
        decorations: Vec::new(),
        hotspots: vec![replay_hotspot("ambience_lab")],
    });
    let (_directory, _ops, state) = state_with(content);
    let _gate = state.session_gate().unwrap();
    let error = state.enter_replay("ambience_lab").unwrap_err();
    assert!(error.message.contains("副窗口专用"), "{}", error.message);
    assert!(state.replay().unwrap().is_none());
    assert!(state.pause_state().unwrap().title, "a failed entry stays on the chapter map");
}

#[test]
fn a_replay_entered_from_the_chapter_map_runs_its_titles_and_timers_until_it_exits() {
    let mut content = timer_content();
    let prologue = content.scenes.get_mut("prologue").unwrap();
    prologue.entry = "rename".to_owned();
    prologue
        .nodes
        .insert("rename".to_owned(), title(WindowRole::Main, "Replay", "tstart"));
    content.chapter_map = Some(ChapterMapDefinition {
        schema_version: 1,
        width: 1920,
        height: 1080,
        view_x: 0,
        view_y: 0,
        background: None,
        decorations: Vec::new(),
        hotspots: vec![replay_hotspot("prologue")],
    });
    // The chapter map is part of the title screen: no story was started.
    let (_directory, ops, state) = state_with(content);
    assert!(state.pause_state().unwrap().title);
    {
        let _gate = state.session_gate().unwrap();
        state.enter_replay("prologue").unwrap();
    }
    assert_eq!(ops.last_title(WindowRole::Main).as_deref(), Some("Replay"));
    assert!(state.next_timer_wait().is_some(), "the replay's timer is live");
    state.timer_step(150).unwrap();
    let replay_score = state.replay().unwrap().as_ref().unwrap().runtime.snapshot().variables
        ["score"]
        .clone();
    assert_eq!(replay_score, ScalarValue::Integer(1));

    {
        let _gate = state.session_gate().unwrap();
        state.exit_replay().unwrap();
    }
    assert!(state.pause_state().unwrap().title, "back on the chapter map");
    assert_eq!(ops.last_title(WindowRole::Main).as_deref(), Some("VECTSPACE"));
    assert!(state.next_timer_wait().is_none());
}
