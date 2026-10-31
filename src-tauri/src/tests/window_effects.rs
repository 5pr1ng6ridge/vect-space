//! The `window_geometry` / `window_layer` nodes: effects are recorded on the
//! candidate pair, applied only after a successful commit and in node order,
//! animated by an injected step instead of a clock, and undone when the player
//! returns to the title or leaves a replay.  Everything runs against the
//! recording native seam with a fake desktop (a 1920x1040 work area; the main
//! window at (100, 100) with a 1280x720 client area and a 16x40 frame).

use super::*;
use crate::{
    save::SlotDocument,
    window_fx::{Frame, LayerState},
};
use vectspace_core::{
    interaction::{
        TimerAction, WindowLayerAction, WindowPlacement, WindowReference, WindowSize,
        WindowSizeUnit,
    },
    model::Easing,
};

const MAIN: WindowRole = WindowRole::Main;
const SIDE: WindowRole = WindowRole::Secondary;

fn center() -> WindowPlacement {
    WindowPlacement {
        relative_to: WindowReference::WorkArea,
        x: 0.5,
        y: 0.5,
        anchor_x: 0.5,
        anchor_y: 0.5,
        offset_x: 0.0,
        offset_y: 0.0,
    }
}

fn top_left() -> WindowPlacement {
    WindowPlacement {
        x: 0.0,
        y: 0.0,
        anchor_x: 0.0,
        anchor_y: 0.0,
        ..center()
    }
}

/// Move by a logical offset from where the window is.
fn nudge(dx: f32, dy: f32) -> WindowPlacement {
    WindowPlacement {
        relative_to: WindowReference::Current,
        offset_x: dx,
        offset_y: dy,
        ..top_left()
    }
}

/// Dock the window to the right of the other game window, vertically centered.
fn dock_right() -> WindowPlacement {
    WindowPlacement {
        relative_to: WindowReference::Window,
        x: 1.0,
        y: 0.5,
        anchor_x: 0.0,
        anchor_y: 0.5,
        offset_x: 16.0,
        offset_y: 0.0,
    }
}

fn logical(width: f32, height: f32) -> WindowSize {
    WindowSize {
        unit: WindowSizeUnit::Logical,
        width,
        height,
    }
}

fn geometry(
    target: WindowRole,
    position: Option<WindowPlacement>,
    size: Option<WindowSize>,
    duration_ms: u64,
    next: &str,
) -> SceneNode {
    SceneNode::WindowGeometry {
        target,
        position,
        size,
        duration_ms,
        easing: Easing::Linear,
        await_completion: false,
        next: next.to_owned(),
    }
}

fn layer(target: WindowRole, action: WindowLayerAction, next: &str) -> SceneNode {
    SceneNode::WindowLayer {
        target,
        action,
        next: next.to_owned(),
    }
}

fn start_timer(id: &str, target: &str, next: &str) -> SceneNode {
    SceneNode::Timer {
        id: id.to_owned(),
        action: TimerAction::Start,
        delay_ms: 100,
        interval_ms: None,
        target: Some(target.to_owned()),
        next: next.to_owned(),
    }
}

/// A story that starts on a line and then runs `nodes`; the secondary Scene is a
/// plain line.
fn story(entry: &'static str, nodes: Vec<(&'static str, SceneNode)>) -> ContentCatalog {
    content_with(
        (entry, nodes),
        (
            "s_say",
            vec![("s_say", say("side", "s_end")), ("s_end", SceneNode::End)],
        ),
    )
}

/// A story that reads a line, runs `node` (which must continue to `s2`), then
/// reads another line.
fn after_line(node: SceneNode) -> ContentCatalog {
    story(
        "s1",
        vec![
            ("s1", say("one", "g")),
            ("g", node),
            ("s2", say("two", "end")),
            ("end", SceneNode::End),
        ],
    )
}

fn call_count(ops: &RecordingWindowOps) -> usize {
    ops.native_calls().len()
}

/// Step an animation by hand, in `step_ms` slices.
fn run_for(state: &EngineState, total_ms: u64, step_ms: u64) {
    let mut left = total_ms;
    while left > 0 {
        let slice = left.min(step_ms);
        state.fx_step(Duration::from_millis(slice));
        left -= slice;
    }
}

fn main_frame() -> ((i32, i32), (i32, i32)) {
    ((100, 100), (1280, 720))
}

/// Leave the story for the title screen, as the `invalidate_session` command does.
fn leave_for_title(state: &EngineState) {
    let _gate = state.session_gate().unwrap();
    state.leave_story_for_title().unwrap();
}

#[test]
fn effects_are_applied_after_the_commit_in_node_order() {
    let (_directory, ops, state) = state_with(story(
        "s1",
        vec![
            ("s1", say("one", "g1")),
            ("g1", geometry(MAIN, Some(center()), None, 0, "l1")),
            ("l1", layer(MAIN, WindowLayerAction::Top, "g2")),
            (
                "g2",
                geometry(MAIN, Some(nudge(40.0, -20.0)), None, 0, "s2"),
            ),
            ("s2", say("two", "end")),
            ("end", SceneNode::End),
        ],
    ));
    start_game(&state);
    assert_eq!(call_count(&ops), 0, "reaching a line moves nothing");

    // The pure half commits the runtime and records the effects, but the native
    // windows are untouched until the native stage runs.
    let revision = main_snapshot(&state).revision;
    let transition = state
        .commit_main_runtime(|runtime| {
            runtime.advance(&state.content, revision, AdvanceSource::Manual)
        })
        .unwrap();
    assert_eq!(transition.committed.effects.len(), 3);
    assert_eq!(
        call_count(&ops),
        0,
        "nothing happens before the native stage"
    );
    state.finish_transition(transition).unwrap();

    // Centered 1296x760 frame: (960-648, 520-380); the nudge is relative to where
    // the first effect left the window, not to where it started.
    assert_eq!(
        ops.native_calls(),
        vec![
            NativeCall::Position(MAIN, 312, 140),
            NativeCall::AlwaysOnTop(MAIN, true),
            NativeCall::Position(MAIN, 352, 120),
        ]
    );
}

#[test]
fn a_secondary_window_docks_to_the_main_window_and_respects_its_minimum_size() {
    let (_directory, ops, state) = state_with(story(
        "open",
        vec![
            ("open", open_side("g1")),
            ("g1", geometry(SIDE, Some(dock_right()), None, 0, "g2")),
            (
                "g2",
                geometry(SIDE, None, Some(logical(100.0, 100.0)), 0, "s1"),
            ),
            ("s1", say("one", "end")),
            ("end", SceneNode::End),
        ],
    ));
    ops.edit_window(MAIN, |window| {
        window.position = (50, 100);
        window.client = (600, 400);
    });
    start_game(&state);
    // Main frame (50, 100, 616, 440): its right edge plus the 16px gap is 682, and
    // the 976x580 secondary frame is centered on its vertical middle (320).
    assert_eq!(
        ops.native_calls(),
        vec![
            NativeCall::Position(SIDE, 682, 30),
            // 100x100 is below the secondary's 480x270 minimum.
            NativeCall::Size(SIDE, 480, 270),
        ]
    );
    assert_eq!(ops.frame_of(SIDE), ((682, 30), (480, 270)));
}

#[test]
fn a_window_that_is_animating_is_referenced_by_its_target_frame() {
    let (_directory, ops, state) = state_with(story(
        "open",
        vec![
            ("open", open_side("gm")),
            (
                "gm",
                geometry(
                    MAIN,
                    Some(top_left()),
                    Some(logical(960.0, 540.0)),
                    1_000,
                    "gs",
                ),
            ),
            (
                "gs",
                geometry(
                    SIDE,
                    Some(dock_right()),
                    Some(logical(480.0, 270.0)),
                    0,
                    "s1",
                ),
            ),
            ("s1", say("one", "end")),
            ("end", SceneNode::End),
        ],
    ));
    start_game(&state);
    // The main window's target frame is (0, 0, 976, 580); docking to its right
    // edge plus the gap gives x = 992, centered on its middle (290).  Docking to
    // the frame that is on screen right now (100..1396) would give 1412.
    assert_eq!(
        ops.native_calls(),
        vec![
            NativeCall::Position(SIDE, 992, 135),
            NativeCall::Size(SIDE, 480, 270),
        ]
    );
    assert!(state.fx.is_window_animating(MAIN));
}

#[test]
fn a_missing_target_window_is_a_clear_error_and_nothing_happens() {
    for (name, node) in [
        ("window_title", title(SIDE, "x", "s2")),
        (
            "window_geometry",
            geometry(SIDE, Some(center()), None, 0, "s2"),
        ),
        (
            "window_geometry",
            geometry(MAIN, Some(dock_right()), None, 0, "s2"),
        ),
        ("window_layer", layer(SIDE, WindowLayerAction::Raise, "s2")),
    ] {
        let (_directory, ops, state) = state_with(after_line(node));
        start_game(&state);
        let before = main_snapshot(&state);
        let seq = state.latest_seq(MAIN).unwrap();
        let error = main_advance(&state).unwrap_err();
        assert!(error.message.contains("副窗口不存在"), "{}", error.message);
        assert!(error.message.contains(name), "{}", error.message);
        assert_eq!(main_snapshot(&state), before);
        assert_eq!(state.latest_seq(MAIN).unwrap(), seq, "nothing is published");
        assert_eq!(call_count(&ops), 0);
        assert!(ops.diagnostics().is_empty());
    }
}

#[test]
fn a_rolled_back_transaction_produces_no_effect_and_the_retry_produces_one() {
    let (_directory, ops, state) = state_with(story(
        "s1",
        vec![
            ("s1", say("one", "g")),
            ("g", geometry(MAIN, Some(center()), None, 0, "t")),
            ("t", title(MAIN, "Renamed", "s2")),
            ("s2", say("two", "end")),
            ("end", SceneNode::End),
        ],
    ));
    start_game(&state);
    let before = main_snapshot(&state);
    ops.fail_title.set(true);
    main_advance(&state).unwrap_err();
    assert_eq!(main_snapshot(&state), before, "the story rolled back");
    assert_eq!(
        call_count(&ops),
        0,
        "a rolled-back transaction moves nothing"
    );

    ops.fail_title.set(false);
    main_advance(&state).unwrap();
    assert_eq!(
        ops.native_calls(),
        vec![NativeCall::Position(MAIN, 312, 140)]
    );
}

#[test]
fn a_timer_callback_can_move_a_window() {
    let (_directory, ops, state) = state_with(story(
        "ta",
        vec![
            ("ta", start_timer("a", "move", "w")),
            ("move", geometry(MAIN, Some(nudge(60.0, 0.0)), None, 0, "w")),
            ("w", say("w", "end")),
            ("end", SceneNode::End),
        ],
    ));
    start_game(&state);
    state.timer_step(60).unwrap();
    assert_eq!(call_count(&ops), 0, "the timer is not due yet");
    state.timer_step(60).unwrap();
    assert_eq!(
        ops.native_calls(),
        vec![NativeCall::Position(MAIN, 160, 100)]
    );
    // A one-shot timer ends: nothing moves again.
    state.timer_step(1_000).unwrap();
    assert_eq!(call_count(&ops), 1);
}

#[test]
fn a_failing_timer_round_is_rolled_back_without_touching_the_effects_of_earlier_rounds() {
    // Timer `a` moves the window; timer `b`, due at the same time, names a title
    // for a window that does not exist.  Its round is rolled back and it is
    // stopped; the move of the round before is neither lost nor repeated.
    let (_directory, ops, state) = state_with(story(
        "ta",
        vec![
            ("ta", start_timer("a", "move", "tb")),
            ("tb", start_timer("b", "bad", "w")),
            ("move", geometry(MAIN, Some(nudge(60.0, 0.0)), None, 0, "w")),
            ("bad", title(SIDE, "x", "w")),
            ("w", say("w", "end")),
            ("end", SceneNode::End),
        ],
    ));
    start_game(&state);
    state.timer_step(150).unwrap();
    assert_eq!(
        ops.native_calls(),
        vec![NativeCall::Position(MAIN, 160, 100)]
    );
    assert!(main_snapshot(&state).interaction.timers.is_empty());
    assert!(ops
        .diagnostics()
        .iter()
        .any(|message| message.contains("计时器 b 已停止")));
}

#[test]
fn an_animation_runs_from_the_current_frame_to_the_target_and_ends_exactly_there() {
    let (_directory, ops, state) = state_with(after_line(geometry(
        MAIN,
        Some(center()),
        Some(logical(960.0, 540.0)),
        1_000,
        "s2",
    )));
    start_game(&state);
    main_advance(&state).unwrap();
    // The animation is scheduled, nothing has moved yet, and the story went on.
    assert_eq!(call_count(&ops), 0);
    assert!(state.fx.is_window_animating(MAIN));
    assert_eq!(ops.frame_of(MAIN), main_frame());

    // Target: client 960x540, frame 976x580 centered on (960, 520).
    run_for(&state, 100, 100);
    assert_eq!(ops.frame_of(MAIN), ((137, 113), (1248, 702)));
    run_for(&state, 400, 100);
    assert_eq!(ops.frame_of(MAIN), ((286, 165), (1120, 630)));
    let mut previous_x = 286;
    for _ in 0..5 {
        run_for(&state, 100, 100);
        let ((x, _), _) = ops.frame_of(MAIN);
        assert!(x >= previous_x, "linear motion never goes backwards");
        previous_x = x;
    }
    assert_eq!(ops.frame_of(MAIN), ((472, 230), (960, 540)));
    assert!(!state.fx.is_window_animating(MAIN));
    let calls = call_count(&ops);
    run_for(&state, 500, 16);
    assert_eq!(
        call_count(&ops),
        calls,
        "a finished animation moves nothing"
    );
}

#[test]
fn a_new_effect_replaces_the_animation_and_starts_from_the_frame_on_screen() {
    let (_directory, ops, state) = state_with(story(
        "s1",
        vec![
            ("s1", say("one", "g1")),
            (
                "g1",
                geometry(
                    MAIN,
                    Some(center()),
                    Some(logical(960.0, 540.0)),
                    1_000,
                    "s2",
                ),
            ),
            ("s2", say("two", "g2")),
            (
                "g2",
                geometry(MAIN, Some(nudge(100.0, 0.0)), None, 1_000, "s3"),
            ),
            ("s3", say("three", "end")),
            ("end", SceneNode::End),
        ],
    ));
    start_game(&state);
    main_advance(&state).unwrap();
    run_for(&state, 500, 100);
    assert_eq!(ops.frame_of(MAIN), ((286, 165), (1120, 630)));

    main_advance(&state).unwrap();
    // The nudge is relative to the first animation's *target* (472, 230), and
    // keeps its target size; the animation itself starts at the frame on screen.
    run_for(&state, 200, 100);
    assert_eq!(ops.frame_of(MAIN), ((343, 178), (1088, 612)));
    run_for(&state, 800, 100);
    assert_eq!(ops.frame_of(MAIN), ((572, 230), (960, 540)));
    assert!(!state.fx.is_window_animating(MAIN));
}

#[test]
fn an_animation_stops_when_the_window_becomes_full_screen() {
    let (_directory, ops, state) = state_with(after_line(geometry(
        MAIN,
        Some(center()),
        None,
        1_000,
        "s2",
    )));
    start_game(&state);
    main_advance(&state).unwrap();
    run_for(&state, 100, 100);
    let calls = call_count(&ops);
    ops.edit_window(MAIN, |window| window.fullscreen = true);
    // The window is looked at every ~250 ms of animation: 100 + 150 is due.
    run_for(&state, 150, 150);
    assert!(!state.fx.is_window_animating(MAIN));
    assert_eq!(
        call_count(&ops),
        calls,
        "a full-screen window is left alone"
    );
    run_for(&state, 2_000, 16);
    assert_eq!(call_count(&ops), calls);
}

#[test]
fn a_native_failure_under_an_animation_stops_it_with_a_diagnostic() {
    let (_directory, ops, state) = state_with(after_line(geometry(
        MAIN,
        Some(center()),
        None,
        1_000,
        "s2",
    )));
    start_game(&state);
    main_advance(&state).unwrap();
    ops.fail_window_effects.set(true);
    run_for(&state, 100, 100);
    assert!(!state.fx.is_window_animating(MAIN));
    assert!(ops
        .diagnostics()
        .iter()
        .any(|message| message.contains("窗口动画已中止")));
}

#[test]
fn full_screen_maximized_and_minimized_windows_are_not_moved_but_layers_still_apply() {
    for state_name in ["fullscreen", "maximized", "minimized"] {
        let (_directory, ops, state) = state_with(story(
            "s1",
            vec![
                ("s1", say("one", "g")),
                (
                    "g",
                    geometry(MAIN, Some(center()), Some(logical(960.0, 540.0)), 500, "l"),
                ),
                ("l", layer(MAIN, WindowLayerAction::Top, "s2")),
                ("s2", say("two", "end")),
                ("end", SceneNode::End),
            ],
        ));
        start_game(&state);
        ops.edit_window(MAIN, |window| match state_name {
            "fullscreen" => window.fullscreen = true,
            "maximized" => window.maximized = true,
            _ => window.minimized = true,
        });
        main_advance(&state).unwrap();
        assert_eq!(
            ops.native_calls(),
            vec![NativeCall::AlwaysOnTop(MAIN, true)],
            "{state_name}"
        );
        assert!(!state.fx.is_window_animating(MAIN), "{state_name}");
        assert_eq!(state.fx.main_baseline(), None, "{state_name}");
        assert_eq!(ops.frame_of(MAIN), main_frame(), "{state_name}");
    }
}

#[test]
fn an_effect_that_changes_nothing_makes_no_native_call() {
    let (_directory, ops, state) = state_with(after_line(geometry(
        MAIN,
        Some(nudge(0.0, 0.0)),
        None,
        0,
        "s2",
    )));
    start_game(&state);
    main_advance(&state).unwrap();
    assert_eq!(call_count(&ops), 0);
}

#[test]
fn layer_actions_call_the_native_flags_in_a_consistent_order() {
    let (_directory, ops, state) = state_with(story(
        "s1",
        vec![
            ("s1", say("one", "l1")),
            ("l1", layer(MAIN, WindowLayerAction::Top, "l2")),
            ("l2", layer(MAIN, WindowLayerAction::Raise, "l3")),
            ("l3", layer(MAIN, WindowLayerAction::Bottom, "l4")),
            ("l4", layer(MAIN, WindowLayerAction::Raise, "l5")),
            ("l5", layer(MAIN, WindowLayerAction::Bottom, "l6")),
            ("l6", layer(MAIN, WindowLayerAction::Focus, "l7")),
            ("l7", layer(MAIN, WindowLayerAction::Normal, "s2")),
            ("s2", say("two", "end")),
            ("end", SceneNode::End),
        ],
    ));
    start_game(&state);
    ops.edit_window(MAIN, |window| window.minimized = true);
    main_advance(&state).unwrap();
    assert_eq!(
        ops.native_calls(),
        vec![
            // top
            NativeCall::AlwaysOnTop(MAIN, true),
            // raise while on top: already above everything, nothing to do
            // bottom: leaves top first
            NativeCall::AlwaysOnTop(MAIN, false),
            NativeCall::AlwaysOnBottom(MAIN, true),
            // raise while at the bottom: unpin, then the on/off toggle that
            // raises without activating
            NativeCall::AlwaysOnBottom(MAIN, false),
            NativeCall::AlwaysOnTop(MAIN, true),
            NativeCall::AlwaysOnTop(MAIN, false),
            // bottom again, then focus lifts the pin and takes focus
            NativeCall::AlwaysOnBottom(MAIN, true),
            NativeCall::AlwaysOnBottom(MAIN, false),
            NativeCall::Focus(MAIN),
            // normal when already normal: nothing
        ]
    );
    assert!(
        !ops.fake_window(MAIN).minimized,
        "focus restores a minimized window"
    );
    assert_eq!(state.fx.layer(MAIN), LayerState::Normal);
}

#[test]
fn returning_to_the_title_restores_the_main_window_and_forgets_the_record() {
    let (_directory, ops, state) = state_with(story(
        "s1",
        vec![
            ("s1", say("one", "g1")),
            (
                "g1",
                geometry(MAIN, Some(center()), Some(logical(960.0, 540.0)), 0, "l"),
            ),
            ("l", layer(MAIN, WindowLayerAction::Top, "g2")),
            ("g2", geometry(MAIN, Some(nudge(30.0, 30.0)), None, 0, "s2")),
            ("s2", say("two", "end")),
            ("end", SceneNode::End),
        ],
    ));
    start_game(&state);
    main_advance(&state).unwrap();
    assert_ne!(ops.frame_of(MAIN), main_frame());
    // The record is the frame before the *first* change.
    assert_eq!(
        state.fx.main_baseline(),
        Some(Frame {
            x: 100,
            y: 100,
            client_w: 1280,
            client_h: 720
        })
    );
    ops.clear_native_calls();
    leave_for_title(&state);
    assert_eq!(
        ops.native_calls(),
        vec![
            NativeCall::Position(MAIN, 100, 100),
            NativeCall::Size(MAIN, 1280, 720),
            NativeCall::AlwaysOnTop(MAIN, false),
        ]
    );
    assert_eq!(ops.frame_of(MAIN), main_frame());
    assert_eq!(state.fx.main_baseline(), None);
    // Nothing is left to restore the second time.
    ops.clear_native_calls();
    leave_for_title(&state);
    assert_eq!(call_count(&ops), 0);
}

#[test]
fn returning_to_the_title_does_not_pull_a_full_screen_window_out_of_it() {
    let (_directory, ops, state) = state_with(story(
        "s1",
        vec![
            ("s1", say("one", "g")),
            ("g", geometry(MAIN, Some(center()), None, 0, "l")),
            ("l", layer(MAIN, WindowLayerAction::Top, "s2")),
            ("s2", say("two", "end")),
            ("end", SceneNode::End),
        ],
    ));
    start_game(&state);
    main_advance(&state).unwrap();
    ops.edit_window(MAIN, |window| window.fullscreen = true);
    ops.clear_native_calls();
    leave_for_title(&state);
    // Only the layer goes back; the geometry stays as the player left it.
    assert_eq!(
        ops.native_calls(),
        vec![NativeCall::AlwaysOnTop(MAIN, false)]
    );
    assert_eq!(state.fx.main_baseline(), None);
}

#[test]
fn returning_to_the_title_cancels_a_running_animation() {
    let (_directory, ops, state) = state_with(after_line(geometry(
        MAIN,
        Some(center()),
        None,
        5_000,
        "s2",
    )));
    start_game(&state);
    main_advance(&state).unwrap();
    run_for(&state, 1_000, 100);
    assert_ne!(ops.frame_of(MAIN), main_frame());
    leave_for_title(&state);
    assert!(!state.fx.is_animating());
    assert_eq!(ops.frame_of(MAIN), main_frame());
    run_for(&state, 10_000, 100);
    assert_eq!(
        ops.frame_of(MAIN),
        main_frame(),
        "the stale animation is gone"
    );
}

#[test]
fn loading_a_save_does_not_restore_the_window() {
    let (_directory, ops, state) =
        state_with(after_line(geometry(MAIN, Some(center()), None, 0, "s2")));
    start_game(&state);
    let snapshot = main_snapshot(&state);
    let history = state.runtime().unwrap().dialogue_history().to_vec();
    state
        .saves
        .save(
            "1",
            SlotDocument {
                snapshot: &snapshot,
                history: &history,
                secondary: None,
            },
            None,
        )
        .unwrap();
    main_advance(&state).unwrap();
    let moved = ops.frame_of(MAIN);
    assert_ne!(moved, main_frame());
    ops.clear_native_calls();
    {
        let _gate = state.session_gate().unwrap();
        let loaded = state.saves.load("1").unwrap();
        let committed = state.apply_loaded_slot(loaded).unwrap();
        state.bump_session_id().unwrap();
        state.deliver(committed, MAIN).unwrap();
    }
    assert_eq!(call_count(&ops), 0, "saves carry no window geometry");
    assert_eq!(ops.frame_of(MAIN), moved);
    // The session's record survives the load and still brings the window back.
    assert!(state.fx.main_baseline().is_some());
}

#[test]
fn a_replay_applies_its_effects_on_entry_and_restores_the_window_on_exit() {
    let content = with_replays(
        story(
            "g",
            vec![
                ("g", geometry(MAIN, Some(center()), None, 0, "l")),
                ("l", layer(MAIN, WindowLayerAction::Top, "s1")),
                ("s1", say("one", "end")),
                ("end", SceneNode::End),
            ],
        ),
        &["prologue"],
    );
    let (_directory, ops, state) = state_with(content);
    enter_replay(&state, "prologue").unwrap();
    assert_eq!(
        ops.native_calls(),
        vec![
            NativeCall::Position(MAIN, 312, 140),
            NativeCall::AlwaysOnTop(MAIN, true),
        ]
    );
    ops.clear_native_calls();
    exit_replay(&state).unwrap();
    assert_eq!(
        ops.native_calls(),
        vec![
            NativeCall::Position(MAIN, 100, 100),
            NativeCall::AlwaysOnTop(MAIN, false),
        ]
    );
    assert_eq!(ops.frame_of(MAIN), main_frame());
    assert_eq!(state.fx.main_baseline(), None);
}

#[test]
fn closing_the_secondary_window_cancels_its_animation_and_forgets_its_layer() {
    let jump_target = secondary_test_catalog().scenes["sandbox"].entry.clone();
    let (_directory, ops, state) = state_with(story(
        "open",
        vec![
            ("open", open_side("l")),
            ("l", layer(SIDE, WindowLayerAction::Top, "g")),
            ("g", geometry(SIDE, Some(center()), None, 2_000, "s1")),
            ("s1", say("one", "leave")),
            (
                "leave",
                SceneNode::Jump {
                    scene: Some("sandbox".to_owned()),
                    target: jump_target,
                },
            ),
        ],
    ));
    start_game(&state);
    assert!(state.fx.is_window_animating(SIDE));
    run_for(&state, 300, 100);
    assert_ne!(ops.frame_of(SIDE), ((300, 200), (960, 540)));

    // Leaving the Scene that owns the window closes it.
    main_advance(&state).unwrap();
    assert!(state.secondary().unwrap().is_none());
    assert!(!state.fx.is_window_animating(SIDE));
    assert_eq!(state.fx.layer(SIDE), LayerState::Normal);
    let calls = call_count(&ops);
    run_for(&state, 3_000, 100);
    assert_eq!(
        call_count(&ops),
        calls,
        "a closed window is never touched again"
    );
    assert!(ops.diagnostics().is_empty(), "{:?}", ops.diagnostics());
}

#[test]
fn a_re_pointed_secondary_window_starts_over_on_the_normal_layer() {
    let (_directory, ops, state) = state_with(story(
        "open",
        vec![
            ("open", open_side("l")),
            ("l", layer(SIDE, WindowLayerAction::Top, "s1")),
            ("s1", say("one", "again")),
            ("again", open_side("s2")),
            ("s2", say("two", "end")),
            ("end", SceneNode::End),
        ],
    ));
    start_game(&state);
    assert_eq!(
        ops.native_calls(),
        vec![NativeCall::AlwaysOnTop(SIDE, true)]
    );
    main_advance(&state).unwrap();
    assert_eq!(
        ops.native_calls(),
        vec![
            NativeCall::AlwaysOnTop(SIDE, true),
            NativeCall::AlwaysOnTop(SIDE, false),
        ],
        "the replacement session does not inherit the old window's layer"
    );
    assert_eq!(state.fx.layer(SIDE), LayerState::Normal);
}

#[test]
fn a_native_window_failure_is_a_diagnostic_and_never_rolls_the_story_back() {
    let (_directory, ops, state) =
        state_with(after_line(geometry(MAIN, Some(center()), None, 0, "s2")));
    start_game(&state);
    ops.fail_window_effects.set(true);
    let update = main_advance(&state).unwrap();
    assert_eq!(dialogue_text(&update.snapshot.prompt), "two");
    assert!(ops
        .diagnostics()
        .iter()
        .any(|message| message.contains("窗口效果未能应用")));
    assert_eq!(ops.frame_of(MAIN), main_frame());
}
