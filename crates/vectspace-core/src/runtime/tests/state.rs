use std::cmp::Ordering;
use std::collections::BTreeMap;

use super::{ack, advance, engine, is_dialogue, prologue};
use crate::content::ContentCatalog;
use crate::model::{
    AdvanceSource, ChapterMapDefinition, ConditionExpression, DialogueHistoryEntry, MutationValue,
    PresentationCue, PresentationCueKind, PresentationOutcome, PromptSnapshot, RuntimeSnapshot,
    ScalarValue, TimelineEasing, TimelineEasingPreset, VariableOperation, VariableType, CueGate,
};
use crate::runtime::variables::{apply_variable_operation, compare_numeric};
use crate::runtime::{RuntimeError, MAX_DIALOGUE_HISTORY_ENTRIES};
use crate::test_support::{catalog_with_scenes, fixture_catalog, fixture_root, from_yaml};
use crate::text_template::MAX_VARIABLE_STRING_BYTES;

fn text(value: &str) -> ScalarValue {
    ScalarValue::Text(value.to_owned())
}

#[test]
fn every_variable_operation_is_supported_and_failures_are_explicit() {
    use ScalarValue::{Boolean, Integer, Number};
    use VariableOperation::{Add, Append, Assign, Mod, Mul, Sub, Toggle};
    use VariableType as T;
    let mutate = apply_variable_operation;

    let supported = [
        (Assign, T::Number, Number(0.0), Some(Integer(4)), Number(4.0)),
        (Add, T::Integer, Integer(4), Some(Integer(3)), Integer(7)),
        (Sub, T::Number, Number(4.5), Some(Integer(2)), Number(2.5)),
        (Mul, T::Integer, Integer(6), Some(Integer(7)), Integer(42)),
        (Mod, T::Integer, Integer(17), Some(Integer(5)), Integer(2)),
        (Append, T::String, text("向量"), Some(text("空间")), text("向量空间")),
        (Toggle, T::Boolean, Boolean(false), None, Boolean(true)),
    ];
    for (operation, target, current, operand, expected) in supported {
        assert_eq!(mutate(operation, target, current, operand).unwrap(), expected, "{operation:?}");
    }

    let failures = [
        (Add, T::Integer, Integer(i64::MAX), Some(Integer(1)), "溢出"),
        (Mod, T::Integer, Integer(2), Some(Integer(0)), "零"),
        (Mul, T::Number, Number(f64::MAX), Some(Number(2.0)), "有限"),
        (Append, T::String, text(&"a".repeat(MAX_VARIABLE_STRING_BYTES)), Some(text("b")), "上限"),
        (Toggle, T::Boolean, Boolean(false), Some(Boolean(true)), "toggle"),
    ];
    for (operation, target, current, operand, expected) in failures {
        let error = mutate(operation, target, current, operand).unwrap_err();
        assert!(error.contains(expected), "{operation:?}: {error}");
    }

    // A variable operand resolves to the variable's current value.
    let content = fixture_catalog();
    let operand: MutationValue = from_yaml("{variable: score}");
    assert_eq!(
        engine(&content).resolve_mutation_value(&content, &operand).unwrap(),
        Integer(0)
    );
}

#[test]
fn every_comparison_and_boolean_operator_is_evaluated() {
    let content = fixture_catalog();
    let mut runtime = engine(&content);
    runtime.snapshot.variables.insert("score".to_owned(), ScalarValue::Integer(10));
    runtime.snapshot.variables.insert("route".to_owned(), text("algebra"));
    let holds = |yaml: &str| {
        let condition: ConditionExpression = from_yaml(yaml);
        runtime.evaluate_condition(&content, &condition)
    };
    for yaml in [
        "{op: eq, left: {variable: score}, right: {value: 10.0}}",
        "{op: ne, left: {variable: route}, right: {value: geometry}}",
        "{op: lt, left: {value: 9}, right: {variable: score}}",
        "{op: le, left: {variable: score}, right: {value: 10}}",
        "{op: gt, left: {variable: score}, right: {value: 1}}",
        "{op: ge, left: {variable: score}, right: {value: 10.0}}",
        "{op: and, conditions: [{op: or, conditions: [{op: eq, left: {variable: score}, right: {value: 0}}, {op: eq, left: {variable: score}, right: {value: 10}}]}, {op: not, condition: {op: eq, left: {variable: route}, right: {value: geometry}}}]}",
    ] {
        assert!(holds(yaml).unwrap(), "{yaml}");
    }

    // Boolean operators stop at the first deciding operand, so an invalid tail
    // is never evaluated.
    let invalid_tail = "{op: eq, left: {variable: missing}, right: {value: true}}";
    assert!(!holds(&format!("{{op: and, conditions: [{{op: eq, left: {{value: 1}}, right: {{value: 2}}}}, {invalid_tail}]}}")).unwrap());
    assert!(holds(&format!("{{op: or, conditions: [{{op: eq, left: {{value: 1}}, right: {{value: 1}}}}, {invalid_tail}]}}")).unwrap());
    assert!(holds(invalid_tail).is_err());
}

#[test]
fn mixed_integer_number_comparison_preserves_i64_precision() {
    // Both values round to the same f64; comparing through `as f64` would
    // report equality for the exact integer pair.
    let compare = |integer: i64, number: f64| {
        compare_numeric(&ScalarValue::Integer(integer), &ScalarValue::Number(number)).unwrap()
    };
    assert_eq!(compare(9_007_199_254_740_993, 9_007_199_254_740_992.0), Ordering::Greater);
    assert_eq!(compare(i64::MAX, 9_223_372_036_854_775_808.0), Ordering::Less);
    assert_eq!(compare(0, -0.0), Ordering::Equal);
}

#[test]
fn a_runtime_gate_blocks_story_commands_until_exact_ack_and_stale_revisions_are_refused() {
    let content = fixture_catalog();
    let mut runtime = engine(&content);
    let update = runtime.start_new_game(&content).unwrap();
    assert!(update.requires_ack);
    assert!(matches!(
        runtime.advance(&content, update.snapshot.revision, AdvanceSource::Manual),
        Err(RuntimeError::PresentationPending(_))
    ));
    assert!(matches!(
        runtime.presentation_complete(&content, update.update_id + 1, PresentationOutcome::Completed),
        Err(RuntimeError::InvalidAcknowledgement { .. })
    ));
    let next = ack(&mut runtime, &content, &update);
    assert!(is_dialogue(&next));
    assert!(matches!(
        runtime.advance(&content, update.snapshot.revision, AdvanceSource::Manual),
        Err(RuntimeError::StaleRevision { .. })
    ));
}

#[test]
fn snapshots_round_trip_and_loading_never_replays_cues() {
    let content = fixture_catalog();
    let mut runtime = engine(&content);
    assert!(runtime.bootstrap(&content).update.cues.is_empty());

    runtime.snapshot.location.node_id = "introduction".to_owned();
    runtime.run_until_boundary(&content).unwrap();
    let json = serde_json::to_string(runtime.snapshot()).unwrap();
    let decoded: RuntimeSnapshot = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded, *runtime.snapshot());

    let started = runtime.start_new_game(&content).unwrap();
    let loaded = runtime.load_snapshot(&content, started.snapshot).unwrap();
    assert!(loaded.cues.is_empty());
    assert!(!loaded.requires_ack);
}

#[test]
fn cue_wire_format_is_flat_and_explicit() {
    let cue = |speed_cps| PresentationCue {
        cue_id: 9,
        gate: CueGate::PlayerAdvance,
        kind: PresentationCueKind::DialogueReveal {
            prompt_id: "scene/line".to_owned(),
            speed_cps,
            reveal_animation: None,
        },
    };
    let value = serde_json::to_value(cue(Some(30.0))).unwrap();
    assert_eq!(value["type"], "dialogue_reveal");
    assert_eq!(value["gate"], "player_advance");
    assert_eq!(value["cue_id"], 9);
    assert!(value.get("kind").is_none());
    // `None` is sent explicitly: it delegates the speed to the player's settings.
    assert!(serde_json::to_value(cue(None)).unwrap()["speed_cps"].is_null());
}

#[test]
fn new_game_keeps_profile_state_and_clears_scene_dialogue_history() {
    let content = fixture_catalog();
    let mut runtime = engine(&content);
    runtime.profile_variables.insert("ending_seen".to_owned(), ScalarValue::Boolean(true));
    let old_slot = runtime.snapshot.clone();
    runtime.snapshot.location.node_id = "introduction".to_owned();
    runtime.run_until_boundary(&content).unwrap();
    assert_eq!(runtime.dialogue_history().len(), 1);
    assert_eq!(runtime.dialogue_history()[0].prompt_id, "prologue/introduction");

    runtime.completed_scenes.insert("prologue".to_owned());
    runtime.start_new_game(&content).unwrap();
    assert!(runtime.dialogue_history().is_empty());
    assert!(runtime.completed_scenes.contains("prologue"));
    assert_eq!(runtime.profile_variables.get("ending_seen"), Some(&ScalarValue::Boolean(true)));
    runtime.load_snapshot(&content, old_slot).unwrap();
    assert_eq!(runtime.profile_variables.get("ending_seen"), Some(&ScalarValue::Boolean(true)));
}

#[test]
fn replay_entry_uses_author_defaults_and_overrides_before_interpolation() {
    let content = prologue(
        "schema_version: 2\nid: prologue\nentry: line\nnodes:\n  line: {type: say, text: '[var=score]/[var=route]/[var=ending_seen]', next: done}\n  done: {type: end}\n",
    );
    let mut profile = engine(&content).profile_state(&content);
    profile.variables.insert("ending_seen".to_owned(), ScalarValue::Boolean(true));
    profile.read_dialogues.insert("prologue/line".to_owned());
    profile.seen_presentations.insert("prologue/movie".to_owned());
    profile.completed_scenes.insert("prologue".to_owned());
    let overrides = BTreeMap::from([
        ("score".to_owned(), ScalarValue::Integer(i64::MAX)),
        ("route".to_owned(), text("author")),
    ]);
    for scene_origin in [false, true] {
        let mut replay =
            crate::runtime::RuntimeEngine::with_replay_overrides(&content, profile.clone(), &overrides).unwrap();
        let update = if scene_origin {
            replay.start_scene_preview(&content, "prologue").unwrap()
        } else {
            replay.start_new_game(&content).unwrap()
        };
        let PromptSnapshot::Dialogue { text, is_read, .. } = update.snapshot.prompt else {
            panic!("expected dialogue")
        };
        // Profile values reset to author defaults, read/seen flags carry over.
        assert_eq!(text, "9223372036854775807/author/false");
        assert!(is_read);
        assert!(replay.seen_presentations.contains("prologue/movie"));
        assert!(replay.completed_scenes.is_empty());
        assert_eq!(profile.variables["ending_seen"], ScalarValue::Boolean(true));
        assert_eq!(
            replay.start_new_game(&content).unwrap().snapshot.variables["score"],
            ScalarValue::Integer(0),
            "overrides apply to the first session only"
        );
    }
    let mut explicit = overrides;
    explicit.insert("ending_seen".to_owned(), ScalarValue::Boolean(true));
    let mut replay =
        crate::runtime::RuntimeEngine::with_replay_overrides(&content, profile, &explicit).unwrap();
    let update = replay.start_scene_preview(&content, "prologue").unwrap();
    let PromptSnapshot::Dialogue { text, .. } = update.snapshot.prompt else {
        panic!("expected dialogue")
    };
    assert_eq!(text, "9223372036854775807/author/true");
}

fn catalog_with_chapter_map() -> ContentCatalog {
    let base = fixture_catalog();
    let mut manifest = base.manifest.clone();
    manifest.chapter_map = Some("chapter-map.yaml".to_owned());
    let map: ChapterMapDefinition = from_yaml(
        "schema_version: 1\nhotspots:\n- {id: hidden, scene_id: prologue, title: 隐藏章节, hover_text: 完成后说明, x: 200, y: 400, width: 280, height: 160, z: 1}\n- {id: always, scene_id: test_scene, title: 始终显示, hover_text: 始终章节的说明, x: 600, y: 400, width: 280, height: 160, z: 1, reveal: {mode: always}}\n",
    );
    ContentCatalog::from_documents_with_chapter_map(
        fixture_root(),
        manifest,
        base.scenes.clone(),
        base.manifest.ui_motions.iter().cloned().zip(base.ui_motions.values().cloned()).collect(),
        Some(map),
    )
    .expect("fixture map should be valid")
}

#[test]
fn chapter_map_reveals_hotspots_by_policy_and_reports_completion_and_replayability() {
    let mut content = catalog_with_chapter_map();
    let mut runtime = engine(&content);
    let map = runtime.chapter_map(&content).unwrap().unwrap();
    assert_eq!(map.hotspots.len(), 1, "the completed-only hotspot stays hidden");
    let always = &map.hotspots[0];
    assert_eq!(always.scene_id, "test_scene");
    assert_eq!(always.hover_text.as_deref(), Some("始终章节的说明"));
    assert!(!always.completed);
    assert!(!always.replayable, "a completed-only replay policy keeps it locked");

    runtime.completed_scenes.insert("prologue".to_owned());
    let map = runtime.chapter_map(&content).unwrap().unwrap();
    assert_eq!(map.hotspots.len(), 2);
    let revealed = map.hotspots.iter().find(|item| item.scene_id == "prologue").unwrap();
    assert!(revealed.completed);
    assert_eq!(revealed.hover_text.as_deref(), Some("完成后说明"));

    // Switching the authored policy opens a chapter without any story progress.
    let runtime = engine(&content);
    let hotspot = content
        .chapter_map
        .as_mut()
        .unwrap()
        .hotspots
        .iter_mut()
        .find(|item| item.scene_id == "test_scene")
        .unwrap();
    hotspot.replay = crate::model::ChapterMapReplay::Always;
    hotspot.hover_text = Some(String::new());
    let map = runtime.chapter_map(&content).unwrap().unwrap();
    let opened = &map.hotspots[0];
    assert!(!opened.completed && opened.replayable);
    assert_eq!(opened.hover_text.as_deref(), Some(""));
}

#[test]
fn same_scene_jump_keeps_dialogue_history() {
    let content = prologue(
        "schema_version: 2\nid: prologue\nentry: first\nnodes:\n  first: {type: say, text: 第一句, next: jump}\n  jump: {type: jump, target: second}\n  second: {type: say, text: 第二句, next: end}\n  end: {type: end}\n",
    );
    let mut runtime = engine(&content);
    let first = runtime.start_new_game(&content).unwrap();
    assert_eq!(runtime.dialogue_history().len(), 1);
    let second = advance(&mut runtime, &content, &first);
    assert_eq!(second.snapshot.location.node_id, "end");
    assert_eq!(runtime.dialogue_history().len(), 2);
}

const SAY_THEN_LEAVE: &str = "schema_version: 2\nid: origin\nentry: line\nnodes:\n  line: {type: say, text: 离开前的一行, next: hop}\n  hop: {type: jump, scene: destination, target: end}\n";
const SET_THEN_LEAVE: &str = "schema_version: 2\nid: origin\nentry: set\nnodes:\n  set: {type: set, variable: score, op: assign, value: 7, next: hop}\n  hop: {type: jump, scene: destination, target: end}\n";
const DESTINATION: &str = "schema_version: 2\nid: destination\nentry: end\nnodes:\n  end: {type: end}\n";

fn leaving(origin: &str) -> ContentCatalog {
    let mut content = catalog_with_scenes(&[origin, DESTINATION]);
    content.manifest.entry_scene = "origin".to_owned();
    content
}

#[test]
fn shared_save_variables_survive_a_secondary_scene_boundary_only_when_shared() {
    let content = leaving(SET_THEN_LEAVE);
    let mut secondary = engine(&content);
    secondary.set_shared_save_variables(true);
    let update = secondary.start_new_game(&content).unwrap();
    assert_eq!(update.snapshot.location.scene_id, "destination");
    assert_eq!(
        secondary.snapshot().variables.get("score"),
        Some(&ScalarValue::Integer(7)),
        "a shared (secondary) runtime must preserve the authoritative map"
    );

    let mut main = engine(&content);
    let update = main.start_new_game(&content).unwrap();
    assert_eq!(update.snapshot.location.scene_id, "destination");
    assert_eq!(
        main.snapshot().variables.get("score"),
        Some(&ScalarValue::Integer(0)),
        "the main runtime still resets Save scope when it leaves a Scene"
    );
}

#[test]
fn appended_history_survives_an_undrained_scene_boundary_and_clears_explicitly() {
    let content = leaving(SAY_THEN_LEAVE);
    let mut runtime = engine(&content);
    let first = runtime.start_new_game(&content).unwrap();
    assert!(is_dialogue(&first));
    // A host that has not drained yet: the occurrence is still pending when the
    // next command crosses a Scene boundary.
    assert_eq!(runtime.appended_history.len(), 1);
    let second = advance(&mut runtime, &content, &first);
    assert!(second.requires_ack);
    assert_eq!(runtime.snapshot().location.scene_id, "destination");
    assert!(runtime.dialogue_history().is_empty(), "the boundary resets the local ledger");
    let appended = runtime.take_appended_history();
    assert_eq!(appended.len(), 1, "an undrained occurrence must not be lost");
    assert_eq!(appended[0].prompt_id, "origin/line");
    assert!(runtime.take_appended_history().is_empty());
}

#[test]
fn history_ledger_is_canonical_bounded_and_is_what_the_profile_persists() {
    let content = fixture_catalog();
    let entries = |count: usize, prefix: &str, start: u64| {
        (0..count)
            .map(|index| DialogueHistoryEntry {
                entry_id: start + index as u64 * 3,
                prompt_id: format!("prologue/{prefix}{index}"),
                speaker_id: None,
                speaker: None,
                name_color: None,
                text_color: None,
                text: format!("{prefix} {index}"),
            })
            .collect::<Vec<_>>()
    };

    // Appending to a full ledger drops the oldest entry and renumbers.
    let mut runtime = engine(&content);
    runtime.replace_dialogue_history(entries(MAX_DIALOGUE_HISTORY_ENTRIES, "old", 1));
    runtime.append_history("prologue/new".to_owned(), None, None, None, None, "newest".to_owned());
    assert_eq!(runtime.dialogue_history().len(), MAX_DIALOGUE_HISTORY_ENTRIES);
    assert_eq!(runtime.dialogue_history()[0].entry_id, 1);
    assert_eq!(runtime.dialogue_history().last().unwrap().text, "newest");
    assert_eq!(runtime.dialogue_history().last().unwrap().entry_id, MAX_DIALOGUE_HISTORY_ENTRIES as u64);

    // Entries merged from another window are renumbered canonically.
    let mut runtime = engine(&content);
    runtime.extend_dialogue_history(entries(3, "main", 41));
    let ids: Vec<u64> = runtime.dialogue_history().iter().map(|entry| entry.entry_id).collect();
    assert_eq!(ids, [1, 2, 3]);

    runtime.extend_dialogue_history(entries(600, "secondary", 900));
    assert_eq!(runtime.dialogue_history().len(), MAX_DIALOGUE_HISTORY_ENTRIES);
    assert_eq!(runtime.dialogue_history().last().unwrap().text, "secondary 599");
    // The profile state carries the merged ledger, or a command commit would overwrite it.
    assert_eq!(
        runtime.profile_state(&content).dialogue_history,
        runtime.dialogue_history().to_vec()
    );

    runtime.replace_dialogue_history(entries(2, "restored", 77));
    assert_eq!(runtime.dialogue_history().len(), 2);
    assert_eq!(runtime.dialogue_history()[1].entry_id, 2);
    assert_eq!(runtime.dialogue_history()[0].text, "restored 0");
}

#[derive(serde::Deserialize)]
struct TimelineConformanceSample {
    name: String,
    easing: TimelineEasing,
    time: f32,
    expected: f32,
}

/// Reference evaluator for the shared easing corpus the frontends also run.
fn timeline_ease(value: f32, easing: &TimelineEasing) -> f32 {
    let value = value.clamp(0.0, 1.0);
    match easing {
        TimelineEasing::Preset(TimelineEasingPreset::Step) => {
            if value < 1.0 {
                0.0
            } else {
                1.0
            }
        }
        TimelineEasing::Preset(TimelineEasingPreset::Linear) => value,
        TimelineEasing::Preset(TimelineEasingPreset::EaseIn) => value * value,
        TimelineEasing::Preset(TimelineEasingPreset::EaseOut) => 1.0 - (1.0 - value).powi(2),
        TimelineEasing::Preset(TimelineEasingPreset::EaseInOut) => {
            if value < 0.5 {
                2.0 * value * value
            } else {
                1.0 - (-2.0 * value + 2.0).powi(2) / 2.0
            }
        }
        TimelineEasing::CubicBezier { cubic_bezier } => {
            let sample = |time: f32, first: f32, second: f32| {
                3.0 * (1.0 - time).powi(2) * time * first
                    + 3.0 * (1.0 - time) * time.powi(2) * second
                    + time.powi(3)
            };
            let (mut low, mut high, mut time) = (0.0, 1.0, value);
            for _ in 0..14 {
                if sample(time, cubic_bezier[0], cubic_bezier[2]) < value {
                    low = time;
                } else {
                    high = time;
                }
                time = (low + high) / 2.0;
            }
            sample(time, cubic_bezier[1], cubic_bezier[3])
        }
    }
}

#[test]
fn timeline_easing_matches_the_shared_frontend_corpus() {
    let samples: Vec<TimelineConformanceSample> =
        serde_json::from_str(include_str!("../../../../../shared/timeline-conformance.json")).unwrap();
    for sample in samples {
        let value = 10.0 * timeline_ease(sample.time / 1000.0, &sample.easing);
        assert!(
            (value - sample.expected).abs() < 0.001,
            "{}: expected {}, got {}",
            sample.name,
            sample.expected,
            value
        );
    }
}
