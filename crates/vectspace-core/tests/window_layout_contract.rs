//! Contract of the `window_geometry` / `window_layer` nodes: authored YAML
//! goes through the real validator, and the runtime only hands the host
//! ordered requests (native windows are never touched by core).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use vectspace_core::content::{ContentCatalog, ContentError};
use vectspace_core::interaction::{
    WindowLayerAction, WindowPlacement, WindowReference, WindowRequest, WindowRole, WindowSize,
    WindowSizeUnit,
};
use vectspace_core::model::{
    ContentManifest, CueGate, Easing, PresentationCueKind, PresentationOutcome, PromptSnapshot,
    SceneDefinition,
};
use vectspace_core::runtime::RuntimeEngine;

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/game")
}

fn yaml_options() -> serde_saphyr::Options {
    serde_saphyr::options! { strict_booleans: true }
}

fn read_yaml<T: serde::de::DeserializeOwned>(path: &Path) -> T {
    let text = std::fs::read_to_string(path).expect("fixture file must be readable");
    serde_saphyr::from_str_with_options(&text, yaml_options()).expect("fixture YAML must parse")
}

fn scene(id: &str, entry: &str, nodes: &str) -> SceneDefinition {
    let yaml = format!("schema_version: 2\nid: {id}\nentry: {entry}\nnodes:\n{nodes}");
    serde_saphyr::from_str_with_options(&yaml, yaml_options())
        .unwrap_or_else(|error| panic!("scene YAML must parse: {error}\n{yaml}"))
}

/// The fixture project plus `scenes`, through the validating constructor.
fn build(scenes: Vec<SceneDefinition>) -> Result<ContentCatalog, ContentError> {
    let root = fixture_root();
    let catalog = ContentCatalog::from_root(root.clone()).expect("fixture content must be valid");
    let manifest: ContentManifest = catalog.manifest.clone();
    let ui_motions = manifest
        .ui_motions
        .iter()
        .map(|path| (path.clone(), read_yaml(&root.join(path))))
        .collect();
    let mut all = catalog.scenes.clone();
    for scene in scenes {
        all.insert(scene.id.clone(), scene);
    }
    ContentCatalog::from_documents_with_all_documents(
        root,
        manifest,
        all,
        ui_motions,
        None,
        &BTreeMap::new(),
        None,
        None,
        None,
    )
}

const SAY_DONE: &str = "  say:\n    type: say\n    speaker: null\n    text: 之后\n    next: done\n  done:\n    type: end\n";

fn geometry(node: &str, extra: &str, next: &str) -> String {
    format!(
        "  {node}:\n    type: window_geometry\n    target: main\n{extra}    next: {next}\n"
    )
}

const DOCK_RIGHT: &str = "    position:\n      relative_to: window\n      x: 1\n      y: 0.5\n      anchor_x: 0\n      anchor_y: 0.5\n      offset_x: 16\n";

#[test]
fn geometry_and_layer_nodes_queue_ordered_host_requests_without_a_host_boundary() {
    let nodes = format!(
        "{}  raise:\n    type: window_layer\n    target: secondary\n    action: raise\n    next: say\n{SAY_DONE}",
        geometry(
            "move",
            &format!("{DOCK_RIGHT}    size:\n      unit: work_area\n      width: 0.5\n      height: 0.25\n    duration_ms: 400\n    easing: ease_out\n"),
            "raise",
        )
    );
    let content = build(vec![scene("wl_order", "move", &nodes)]).unwrap();
    let mut runtime = RuntimeEngine::new(&content).unwrap();
    let update = runtime.start_scene_preview(&content, "wl_order").unwrap();

    // Not awaited: the story runs on to the line in the same update.
    assert!(matches!(update.snapshot.prompt, PromptSnapshot::Dialogue { .. }));
    assert!(!update.requires_ack);
    assert!(!runtime.at_host_boundary());
    assert_eq!(
        runtime.take_window_requests(),
        vec![
            WindowRequest::Geometry {
                target: WindowRole::Main,
                position: Some(WindowPlacement {
                    relative_to: WindowReference::Window,
                    x: 1.0,
                    y: 0.5,
                    anchor_x: 0.0,
                    anchor_y: 0.5,
                    offset_x: 16.0,
                    offset_y: 0.0,
                }),
                size: Some(WindowSize {
                    unit: WindowSizeUnit::WorkArea,
                    width: 0.5,
                    height: 0.25,
                }),
                duration_ms: 400,
                easing: Easing::EaseOut,
            },
            WindowRequest::Layer {
                target: WindowRole::Secondary,
                action: WindowLayerAction::Raise,
            },
        ]
    );
}

#[test]
fn an_awaited_timed_geometry_change_holds_the_story_for_its_duration() {
    let nodes = format!(
        "{}{SAY_DONE}",
        geometry("move", &format!("{DOCK_RIGHT}    duration_ms: 500\n    await: true\n"), "say")
    );
    let content = build(vec![scene("wl_await", "move", &nodes)]).unwrap();
    let mut runtime = RuntimeEngine::new(&content).unwrap();
    let update = runtime.start_scene_preview(&content, "wl_await").unwrap();

    assert!(update.requires_ack);
    assert!(matches!(update.snapshot.prompt, PromptSnapshot::None));
    assert!(update.cues.iter().any(|cue| cue.gate == CueGate::Runtime
        && matches!(cue.kind, PresentationCueKind::Delay { duration_ms: 500 })));
    assert_eq!(runtime.take_window_requests().len(), 1, "the host starts the move right away");

    let next = runtime
        .presentation_complete(&content, update.update_id, PresentationOutcome::Completed)
        .unwrap();
    assert!(matches!(next.snapshot.prompt, PromptSnapshot::Dialogue { .. }));
}

#[test]
fn an_instant_awaited_change_does_not_wait() {
    let nodes = format!(
        "{}{SAY_DONE}",
        geometry("move", &format!("{DOCK_RIGHT}    await: true\n"), "say")
    );
    let content = build(vec![scene("wl_instant", "move", &nodes)]).unwrap();
    let mut runtime = RuntimeEngine::new(&content).unwrap();
    let update = runtime.start_scene_preview(&content, "wl_instant").unwrap();
    assert!(!update.requires_ack);
    assert!(matches!(update.snapshot.prompt, PromptSnapshot::Dialogue { .. }));
}

#[test]
fn geometry_bounds_are_content_errors() {
    let cases = [
        ("", "至少要设置位置或大小"),
        (
            "    position:\n      x: 0.5\n      y: 0.5\n      anchor_x: 1.5\n      anchor_y: 0.5\n",
            "窗口位置无效",
        ),
        (
            "    position:\n      x: 9\n      y: 0.5\n      anchor_x: 0.5\n      anchor_y: 0.5\n",
            "窗口位置无效",
        ),
        ("    size:\n      unit: work_area\n      width: 0\n      height: 0.5\n", "窗口大小无效"),
        ("    size:\n      width: 20000\n      height: 300\n", "窗口大小无效"),
        (&format!("{DOCK_RIGHT}    duration_ms: 70000\n"), "60 秒"),
    ];
    for (extra, expected) in cases {
        let nodes = format!("{}{SAY_DONE}", geometry("move", extra, "say"));
        let error = build(vec![scene("wl_bad", "move", &nodes)]).unwrap_err();
        assert!(error.to_string().contains(expected), "{extra:?}: {error}");
    }
}

#[test]
fn timers_may_fire_non_awaited_window_changes_but_never_an_awaited_one() {
    let arm = |target: &str| {
        format!("  arm:\n    type: timer\n    id: drift\n    action: start\n    delay_ms: 100\n    interval_ms: 1000\n    target: {target}\n    next: say\n")
    };
    let effects = format!(
        "{}{}  layer:\n    type: window_layer\n    target: main\n    action: top\n    next: say\n",
        geometry(
            "nudge",
            "    position:\n      relative_to: current\n      x: 0\n      y: 0\n      anchor_x: 0\n      anchor_y: 0\n      offset_x: 8\n",
            "say"
        ),
        geometry("awaited", &format!("{DOCK_RIGHT}    duration_ms: 300\n    await: true\n"), "say"),
    );

    for allowed in ["nudge", "layer"] {
        let nodes = format!("{}{effects}{SAY_DONE}", arm(allowed));
        let content = build(vec![scene("wl_timer", "arm", &nodes)]).unwrap();
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let start = runtime.start_scene_preview(&content, "wl_timer").unwrap();
        let (updates, diagnostics) = runtime.tick_timers(&content, 100);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].snapshot.location, start.snapshot.location);
        assert_eq!(runtime.take_window_requests().len(), 1, "{allowed}");
    }

    let nodes = format!("{}{effects}{SAY_DONE}", arm("awaited"));
    let error = build(vec![scene("wl_timer", "arm", &nodes)]).unwrap_err();
    assert!(error.to_string().contains("计时器"), "{error}");
}

#[test]
fn a_single_window_preview_reports_window_changes_instead_of_moving_the_editor() {
    let nodes = format!(
        "{}  layer:\n    type: window_layer\n    target: main\n    action: focus\n    next: say\n{SAY_DONE}",
        geometry("move", DOCK_RIGHT, "layer")
    );
    let content = build(vec![scene("wl_preview", "move", &nodes)]).unwrap();
    let mut runtime = RuntimeEngine::new(&content).unwrap();
    runtime.start_scene_preview(&content, "wl_preview").unwrap();
    let mut notes = Vec::new();
    let updates = runtime
        .settle_local_requests(&content, WindowRole::Main, &mut notes)
        .unwrap();
    assert!(updates.is_empty());
    assert_eq!(notes.len(), 2, "{notes:?}");
    assert!(notes[0].contains("位置/大小") && notes[1].contains("层级"), "{notes:?}");
    assert!(runtime.take_window_requests().is_empty());
}

#[test]
fn settling_a_preview_step_reports_boundary_free_window_requests_immediately() {
    let nodes = format!("{}{SAY_DONE}", geometry("move", DOCK_RIGHT, "say"));
    let content = build(vec![scene("wl_settle", "move", &nodes)]).unwrap();
    let mut runtime = RuntimeEngine::new(&content).unwrap();
    let update = runtime.start_scene_preview(&content, "wl_settle").unwrap();
    let mut notes = Vec::new();
    let settled = runtime
        .settle_local_host(&content, WindowRole::Main, update, &mut notes)
        .unwrap();
    assert!(matches!(settled.snapshot.prompt, PromptSnapshot::Dialogue { .. }));
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(runtime.take_window_requests().is_empty());
}

#[test]
fn easing_samples_hit_both_ends_and_stay_monotonic() {
    for easing in [Easing::Linear, Easing::EaseIn, Easing::EaseOut, Easing::EaseInOut] {
        assert_eq!(easing.sample(0.0), 0.0);
        assert_eq!(easing.sample(1.0), 1.0);
        assert_eq!(easing.sample(-1.0), 0.0);
        assert_eq!(easing.sample(2.0), 1.0);
        let samples: Vec<f32> = (0..=20).map(|step| easing.sample(step as f32 / 20.0)).collect();
        assert!(samples.windows(2).all(|pair| pair[0] <= pair[1]), "{easing:?}");
    }
}
