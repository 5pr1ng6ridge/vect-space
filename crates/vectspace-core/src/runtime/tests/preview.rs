use super::{ack, engine, has_cue};
use crate::content::ContentCatalog;
use crate::model::{
    PresentationCueKind, PromptSnapshot, RuntimeSnapshot, ScalarValue, StoryLocation,
};
use crate::runtime::{PreviewChoiceDecision, PreviewRunResult, RuntimeEngine};
use crate::test_support::{catalog_with_scenes, fixture_catalog};

fn location(scene: &str, node: &str) -> StoryLocation {
    StoryLocation {
        scene_id: scene.to_owned(),
        node_id: node.to_owned(),
    }
}

fn decision(scene: &str, node: &str, choice: &str) -> PreviewChoiceDecision {
    PreviewChoiceDecision {
        scene_id: scene.to_owned(),
        node_id: node.to_owned(),
        visit: 1,
        choice_id: choice.to_owned(),
    }
}

/// A `preview_live` scene made of the given flow-style YAML node lines.
fn live(entry: &str, nodes: &str) -> ContentCatalog {
    catalog_with_scenes(&[&format!(
        "schema_version: 2\nid: preview_live\nentry: {entry}\nnodes:\n{nodes}"
    )])
}

const BG: &str = "  bg: {type: background, background: bg.nvctsp, transition: {type: cut}, duration_ms: 0, easing: linear, next: pre}\n";
const SET: &str = "  pre: {type: set, variable: score, op: add, value: 1, next: line}\n";
const LINE: &str = "  line: {type: say, speaker: test, text: 对白, next: end}\n";
const PICK: &str = "  pick: {type: choice, choices: [{id: left, label: left, next: end}, {id: right, label: right, next: end}]}\n";
const END: &str = "  end: {type: end}\n";

/// Reconstructs `node` of `preview_live` from the scene entry.
fn reach(content: &ContentCatalog, node: &str, decisions: &[PreviewChoiceDecision]) -> (RuntimeEngine, PreviewRunResult) {
    let mut runtime = engine(content);
    let result = runtime
        .preview_to_from_scene_entry(content, "preview_live", &location("preview_live", node), decisions)
        .unwrap();
    (runtime, result)
}

fn prompt_id(snapshot: &RuntimeSnapshot) -> String {
    match &snapshot.prompt {
        PromptSnapshot::Dialogue { prompt_id, .. }
        | PromptSnapshot::LongText { prompt_id, .. }
        | PromptSnapshot::Choice { prompt_id, .. } => prompt_id.clone(),
        other => format!("<{other:?}>"),
    }
}

fn score(runtime: &RuntimeEngine) -> Option<&ScalarValue> {
    runtime.snapshot().variables.get("score")
}

#[test]
fn preview_replays_choices_to_the_target_within_one_scene() {
    let content = fixture_catalog();
    let mut runtime = engine(&content);
    let target = location("prologue", "timeline_showcase");
    let decisions = [decision("prologue", "route_choice", "algebra")];
    let PreviewRunResult::Ready { snapshot, trace } = runtime
        .preview_to_from_scene_entry(&content, "prologue", &target, &decisions)
        .unwrap()
    else {
        panic!("the default demo path should reach the timeline");
    };
    assert_eq!(snapshot.location, target);
    assert!(trace.iter().any(|location| location.node_id == "route_choice"));
    let update = runtime.preview_execute_current_node(&content).unwrap();
    assert!(has_cue(&update, |kind| matches!(kind, PresentationCueKind::Timeline { .. })));

    // Only the choices of the previewed Scene are needed.
    let target = location("test_scene", "move_jelly_copy");
    let decisions = [decision("test_scene", "choice_background_start", "option_1")];
    let PreviewRunResult::Ready { snapshot, trace } = engine(&content)
        .preview_to_from_scene_entry(&content, "test_scene", &target, &decisions)
        .unwrap()
    else {
        panic!("the Scene-local choice should reach the target");
    };
    assert_eq!(snapshot.location, target);
    assert!(trace.iter().all(|location| location.scene_id == "test_scene"));
}

#[test]
fn scene_preview_does_not_follow_cross_scene_paths() {
    let content = catalog_with_scenes(&["schema_version: 2\nid: preview_boundary\nentry: leave\nnodes:\n  leave: {type: jump, scene: prologue, target: establish}\n  target: {type: end}\n"]);
    let target = location("preview_boundary", "target");
    let PreviewRunResult::Unreachable { message, trace } = engine(&content)
        .preview_to_from_scene_entry(&content, "preview_boundary", &target, &[])
        .unwrap()
    else {
        panic!("a Scene preview must stop at its ownership boundary");
    };
    assert!(message.contains("路径已离开"));
    assert!(trace.iter().all(|location| location.scene_id == "preview_boundary"));
}

#[test]
fn node_preview_resets_to_scene_defaults_and_validates_before_mutating() {
    let content = fixture_catalog();
    let mut runtime = engine(&content);
    let before = runtime.snapshot().location.clone();
    assert!(runtime.start_node_preview(&content, "missing_scene", "x").is_err());
    assert!(runtime.start_node_preview(&content, "prologue", "missing_node").is_err());
    assert_eq!(runtime.snapshot().location, before);

    // Reaching route_choice normally needs its ancestors (sprites, conditions).
    // A direct start uses the scene's declared defaults instead, and does not
    // guess a branch: the runtime stays on the choice prompt itself.
    runtime.start_node_preview(&content, "prologue", "route_choice").unwrap();
    assert_eq!(runtime.snapshot().location, location("prologue", "route_choice"));
    assert!(runtime.snapshot().world.sprites.is_empty());
    assert!(matches!(runtime.snapshot().prompt, PromptSnapshot::Choice { .. }));
}

#[test]
fn selected_dialogue_lands_untouched_and_keeps_the_state_of_its_predecessors() {
    let content = live(
        "bg",
        &[
            BG,
            "  pre: {type: set, variable: score, op: add, value: 3, next: ui}\n",
            "  ui: {type: dialogue_ui, visible: true, next: line}\n",
            LINE,
            END,
        ]
        .concat(),
    );
    let (mut runtime, result) = reach(&content, "line", &[]);
    let PreviewRunResult::Ready { snapshot, .. } = result else {
        panic!("a selected dialogue must reconstruct");
    };
    assert_eq!(snapshot.location, location("preview_live", "line"));
    assert!(matches!(snapshot.prompt, PromptSnapshot::None));

    // The live continuation executes the selected node once and lands on its
    // real prompt.  A `say` node moves `location` to its successor while
    // `prompt` carries the line, so the target is identified by the prompt id.
    let update = runtime.preview_enter_current_node(&content).unwrap();
    assert!(matches!(runtime.snapshot().prompt, PromptSnapshot::Dialogue { .. }));
    assert_eq!(prompt_id(&update.snapshot), "preview_live/line");
    assert!(!update.requires_ack);
    assert_eq!(score(&runtime), Some(&ScalarValue::Integer(3)));
    assert_eq!(runtime.snapshot().world.background_asset(), Some("bg.nvctsp"));
    assert!(runtime.snapshot().world.dialogue_ui_visible);

    // A dialogue that is itself the scene entry reconstructs without any step.
    let entry = live("line", &[LINE, END].concat());
    let (mut runtime, result) = reach(&entry, "line", &[]);
    assert!(matches!(result, PreviewRunResult::Ready { .. }));
    runtime.preview_enter_current_node(&entry).unwrap();
    assert_eq!(prompt_id(runtime.snapshot()), "preview_live/line");
}

#[test]
fn selected_choice_and_end_targets_are_real_boundaries() {
    let content = live("line", &[LINE.replace("next: end", "next: pick").as_str(), PICK, END].concat());
    let (mut runtime, result) = reach(&content, "pick", &[]);
    assert!(matches!(result, PreviewRunResult::Ready { .. }));
    runtime.preview_enter_current_node(&content).unwrap();
    assert_eq!(runtime.snapshot().location, location("preview_live", "pick"));
    assert!(matches!(runtime.snapshot().prompt, PromptSnapshot::Choice { .. }));

    // An end target needs a decision for the choice on the path, then lands on
    // the end prompt.
    let (_, result) = reach(&content, "end", &[]);
    let PreviewRunResult::NeedsChoice { location: asked, .. } = result else {
        panic!("the path choice must be offered, not guessed");
    };
    assert_eq!(asked, location("preview_live", "pick"));
    let (mut runtime, result) = reach(&content, "end", &[decision("preview_live", "pick", "left")]);
    assert!(matches!(result, PreviewRunResult::Ready { .. }));
    runtime.preview_enter_current_node(&content).unwrap();
    assert!(matches!(runtime.snapshot().prompt, PromptSnapshot::End { .. }));
}

#[test]
fn selected_long_text_lands_on_its_prompt() {
    let content = fixture_catalog();
    let target = location("feature_lab", "lecture");
    let mut runtime = engine(&content);
    let result = runtime
        .preview_to_from_scene_entry(&content, "feature_lab", &target, &[])
        .unwrap();
    assert!(matches!(result, PreviewRunResult::Ready { .. }), "{result:?}");
    runtime.preview_enter_current_node(&content).unwrap();
    assert_eq!(runtime.snapshot().location, target);
    assert!(matches!(runtime.snapshot().prompt, PromptSnapshot::LongText { .. }));
}

#[test]
fn live_continuation_runs_the_selected_node_once_and_static_preview_stops_at_its_successor() {
    let content = live("bg", &[BG, SET, LINE, END].concat());

    let (mut runtime, _) = reach(&content, "pre", &[]);
    let update = runtime.preview_enter_current_node(&content).unwrap();
    assert!(matches!(runtime.snapshot().prompt, PromptSnapshot::Dialogue { .. }));
    assert_eq!(prompt_id(runtime.snapshot()), "preview_live/line");
    assert_eq!(score(&runtime), Some(&ScalarValue::Integer(1)), "executed exactly once");
    assert!(!update.requires_ack);

    // The one-shot static preview keeps its exact breakpoint: it does not fold
    // the successor's prompt, and continuing afterwards does not re-run `pre`.
    let (mut runtime, _) = reach(&content, "pre", &[]);
    let static_update = runtime.preview_execute_current_node(&content).unwrap();
    assert!(matches!(static_update.snapshot.prompt, PromptSnapshot::None));
    assert_eq!(score(&runtime), Some(&ScalarValue::Integer(1)));
    runtime.preview_enter_current_node(&content).unwrap();
    assert_eq!(score(&runtime), Some(&ScalarValue::Integer(1)));
}

#[test]
fn live_continuation_passes_immediate_nodes_and_resumes_after_awaited_gates() {
    let content = live("bg", &[BG.replace("next: pre", "next: line").as_str(), LINE, END].concat());
    let (mut runtime, _) = reach(&content, "bg", &[]);
    let update = runtime.preview_enter_current_node(&content).unwrap();
    assert!(matches!(runtime.snapshot().prompt, PromptSnapshot::Dialogue { .. }));
    assert!(has_cue(&update, |kind| matches!(kind, PresentationCueKind::BackgroundTransition { .. })));

    let awaited = live("bg", &[BG.replace("next: pre", "await: true, next: line").as_str(), LINE, END].concat());
    let (mut runtime, _) = reach(&awaited, "bg", &[]);
    let gated = runtime.preview_enter_current_node(&awaited).unwrap();
    assert!(gated.requires_ack);
    assert!(matches!(gated.snapshot.prompt, PromptSnapshot::None));
    let resumed = ack(&mut runtime, &awaited, &gated);
    assert!(matches!(runtime.snapshot().prompt, PromptSnapshot::Dialogue { .. }));
    assert!(!resumed.requires_ack);
}
