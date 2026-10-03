//! Public-API contract tests for the scene-owned interaction state: window
//! titles and controls, refreshable prompts, scene timers and advance blocks.
//!
//! Like `choice_contract.rs`, every scene here is authored as YAML and loaded
//! through the real content validator, so the tests also pin the authoring
//! rules (main -> secondary window roles, timer targets, reserved variables)
//! instead of poking the runtime with unvalidated content.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use vectspace_core::content::{ContentCatalog, ContentError};
use vectspace_core::interaction::{
    InteractionSnapshot, SceneTimer, TimerAction, UpdateKind, WindowControlAction, WindowRequest,
    WindowRole, WindowTitles, DEFAULT_MAIN_TITLE, MAIN_TITLE_VARIABLE, MAX_SCENE_TIMERS,
    MIN_TIMER_INTERVAL_MS, SECONDARY_TITLE_VARIABLE,
};
use vectspace_core::model::{
    AdvanceSource, ContentManifest, CueGate, PresentationCueKind, PresentationOutcome,
    PromptSnapshot, RuntimeSnapshot, RuntimeUpdate, SceneDefinition, ScalarValue, StoryLocation,
    VariableDefinition, VariableScope, VariableType,
};
use vectspace_core::runtime::{RuntimeEngine, RuntimeError};

// ---------------------------------------------------------------------------
// Fixture catalog
// ---------------------------------------------------------------------------

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/game")
}

fn fixture_catalog() -> ContentCatalog {
    ContentCatalog::from_root(fixture_root()).expect("fixture content must be valid")
}

fn yaml_options() -> serde_saphyr::Options {
    serde_saphyr::options! { strict_booleans: true }
}

fn scene_from_yaml(yaml: &str) -> SceneDefinition {
    serde_saphyr::from_str_with_options(yaml, yaml_options())
        .unwrap_or_else(|error| panic!("scene YAML must parse: {error}\n{yaml}"))
}

fn read_yaml<T: serde::de::DeserializeOwned>(path: &Path) -> T {
    let text = std::fs::read_to_string(path).expect("fixture file must be readable");
    serde_saphyr::from_str_with_options(&text, yaml_options()).expect("fixture YAML must parse")
}

/// Runs the complete validating constructor, exactly like loading a project.
fn try_build(
    manifest: ContentManifest,
    scenes: BTreeMap<String, SceneDefinition>,
) -> Result<ContentCatalog, ContentError> {
    let root = fixture_root();
    let ui_motions = manifest
        .ui_motions
        .iter()
        .map(|path| (path.clone(), read_yaml(&root.join(path))))
        .collect();
    ContentCatalog::from_documents_with_all_documents(
        root,
        manifest,
        scenes,
        ui_motions,
        None,
        &BTreeMap::new(),
        None,
        None,
        None,
    )
}

// ---------------------------------------------------------------------------
// Authored scenes
// ---------------------------------------------------------------------------

/// Main scene: say -> window_title -> say reading the title back.
const TITLE_SCENE: &str = r#"
schema_version: 2
id: ix_title
entry: intro
nodes:
  intro:
    type: say
    speaker: test
    text: 开场
    next: retitle
  retitle:
    type: window_title
    target: main
    title: "第[var=score]幕"
    next: after
  after:
    type: say
    speaker: test
    text: "当前标题[var=window.main.title]"
    next: done
  done:
    type: end
"#;

/// Secondary-window scene: holds the main window, retitles itself, releases
/// the hold and finally asks the main window to advance.
const SECONDARY_SCENE: &str = r#"
schema_version: 2
window_role: secondary
id: ix_secondary
entry: hold
nodes:
  hold:
    type: window_control
    target: main
    action: block
    id: hold
    message: 副窗口占用中
    next: retitle
  retitle:
    type: window_title
    target: secondary
    title: "副窗口[var=score]"
    next: release
  release:
    type: window_control
    target: main
    action: unblock
    id: hold
    next: nudge
  nudge:
    type: window_control
    target: main
    action: advance
    next: finish
  finish:
    type: end
"#;

/// Main scene that opens the secondary one without blocking.
const OPEN_SCENE: &str = r#"
schema_version: 2
id: ix_open
entry: open
nodes:
  open:
    type: open_window
    scene: ix_secondary
    next: line
  line:
    type: say
    speaker: test
    text: 副窗口已请求
    next: done
  done:
    type: end
"#;

/// A refreshable say line.
const SAY_SCENE: &str = r#"
schema_version: 2
id: ix_say
entry: line
nodes:
  line:
    type: say
    speaker: test
    text: "分数[var=score]"
    next: done
  done:
    type: end
"#;

/// Only option is hidden at score 0: a zero-option waiting prompt.
const WAITING_SCENE: &str = r#"
schema_version: 2
id: ix_waiting
entry: gate
nodes:
  gate:
    type: choice
    choices:
    - id: open
      label: 开门
      next: done
      visible_if:
        op: eq
        left:
          variable: score
        right:
          value: 1
  done:
    type: end
"#;

/// A choice that can re-enter itself: a new prompt occurrence per visit.
const LOOP_SCENE: &str = r#"
schema_version: 2
id: ix_loop
entry: ask
nodes:
  ask:
    type: choice
    choices:
    - id: again
      label: 再来
      next: ask
    - id: exit
      label: 离开
      next: done
  done:
    type: end
"#;

/// Two dialogue lines, then a choice: the advance/block playground.
const BLOCK_SCENE: &str = r#"
schema_version: 2
id: ix_block
entry: first
nodes:
  first:
    type: say
    speaker: test
    text: 一
    next: second
  second:
    type: say
    speaker: test
    text: 二
    next: ask
  ask:
    type: choice
    choices:
    - id: pick
      label: 选择
      next: done
  done:
    type: end
"#;

const BIG_TITLE_SCENE: &str = r#"
schema_version: 2
id: ix_big_title
entry: retitle
nodes:
  retitle:
    type: window_title
    target: main
    title: "[var=route]"
    next: done
  done:
    type: end
"#;

const TITLES_READ_SCENE: &str = r#"
schema_version: 2
id: ix_titles_read
entry: line
nodes:
  line:
    type: say
    speaker: test
    text: "[var=window.main.title]/[var=window.secondary.title]"
    next: done
  done:
    type: end
"#;

const FORCED_SCENE: &str = r#"
schema_version: 2
id: ix_forced
entry: force
nodes:
  force:
    type: playback
    auto: forced
    ctrl_fast_forward: allow
    next: line
  line:
    type: say
    speaker: test
    text: 强制
    next: after
  after:
    type: say
    speaker: test
    text: 之后
    next: done
  done:
    type: end
"#;

/// Shared tail of every timer scene: effect targets and a score-driven choice.
const EFFECT_NODES: &str = r#"
  bump:
    type: set
    variable: score
    op: add
    value: 1
    next: ask
  mark:
    type: set
    variable: route
    op: append
    value: x
    next: ask
  fade:
    type: background
    background: bg.nvctsp
    duration_ms: 400
    next: ask
  retitle:
    type: window_title
    target: main
    title: "计时[var=score]"
    next: ask
  echo_title:
    type: window_title
    target: secondary
    title: "回显[var=window.main.title]"
    next: ask
  ask:
    type: choice
    choices:
    - id: always
      label: 常驻
      next: done
    - id: odd
      label: 解锁[var=score]
      next: done
      visible_if:
        op: eq
        left:
          variable: score
        right:
          value: 1
    - id: early
      label: 早期
      next: done
      enabled_if:
        op: eq
        left:
          variable: score
        right:
          value: 0
  done:
    type: end
"#;

fn effect_scene(scene_id: &str, entry: &str, nodes: &str) -> SceneDefinition {
    scene_from_yaml(&format!(
        "schema_version: 2\nid: {scene_id}\nentry: {entry}\nnodes:\n{nodes}{EFFECT_NODES}"
    ))
}

fn arm_timer(node: &str, id: &str, interval_ms: Option<u64>, target: &str, next: &str) -> String {
    let interval = interval_ms
        .map(|value| format!("    interval_ms: {value}\n"))
        .unwrap_or_default();
    format!(
        "  {node}:\n    type: timer\n    id: {id}\n    action: start\n    delay_ms: 100\n{interval}    target: {target}\n    next: {next}\n"
    )
}

/// Every authored scene of this suite, keyed by scene id.
fn interaction_scenes() -> Vec<SceneDefinition> {
    let mut scenes: Vec<SceneDefinition> = [
        TITLE_SCENE,
        SECONDARY_SCENE,
        OPEN_SCENE,
        SAY_SCENE,
        WAITING_SCENE,
        LOOP_SCENE,
        BLOCK_SCENE,
        FORCED_SCENE,
        BIG_TITLE_SCENE,
        TITLES_READ_SCENE,
    ]
    .into_iter()
    .map(scene_from_yaml)
    .collect();

    // The plain score-driven choice, no timers.
    scenes.push(effect_scene("ix_choice", "ask", ""));
    // One-shot and repeating timers on the same choice.
    scenes.push(effect_scene("ix_once", "arm", &arm_timer("arm", "bump_timer", None, "bump", "ask")));
    scenes.push(effect_scene(
        "ix_repeat",
        "arm",
        &arm_timer("arm", "bump_timer", Some(200), "bump", "ask"),
    ));
    // The repeated effect lasts longer (400ms) than its interval (200ms).
    scenes.push(effect_scene(
        "ix_slow",
        "arm",
        &arm_timer("arm", "fade_timer", Some(200), "fade", "ask"),
    ));
    // Armed, then stopped by the story before it is due.
    scenes.push(effect_scene(
        "ix_stop",
        "arm",
        &format!(
            "{}  pause:\n    type: say\n    speaker: test\n    text: 先说\n    next: disarm\n  disarm:\n    type: timer\n    id: bump_timer\n    action: stop\n    next: ask\n",
            arm_timer("arm", "bump_timer", None, "bump", "pause")
        ),
    ));
    // Two healthy timers around one that overflows an integer.
    scenes.push(effect_scene(
        "ix_two",
        "arm_a",
        &format!(
            "{}{}{}",
            arm_timer("arm_a", "a_good", None, "mark", "arm_b"),
            arm_timer("arm_b", "b_bad", None, "bump", "arm_c"),
            arm_timer("arm_c", "c_good", None, "mark", "ask"),
        ),
    ));
    // Timer armed, then the story waits on an awaited presentation.
    scenes.push(effect_scene(
        "ix_gate",
        "arm",
        &format!(
            "{}  hold:\n    type: wait\n    duration_ms: 500\n    next: line\n  line:\n    type: say\n    speaker: test\n    text: 后\n    next: done\n",
            arm_timer("arm", "bump_timer", None, "bump", "hold")
        ),
    ));
    // Timer armed, then the story stops at a host boundary (window title).
    scenes.push(effect_scene(
        "ix_boundary_timer",
        "arm",
        &format!(
            "{}  host:\n    type: window_title\n    target: main\n    title: 边界\n    next: line\n  line:\n    type: say\n    speaker: test\n    text: 边界后\n    next: done\n",
            arm_timer("arm", "bump_timer", None, "bump", "host")
        ),
    ));
    // A timer whose effect is a window title request.
    scenes.push(effect_scene(
        "ix_timer_title",
        "arm",
        &arm_timer("arm", "title_timer", None, "retitle", "ask"),
    ));
    // Timer armed, then the story leaves for another Scene.
    scenes.push(effect_scene(
        "ix_leave",
        "arm",
        &format!(
            "{}  hold:\n    type: say\n    speaker: test\n    text: 先说\n    next: leave\n  leave:\n    type: jump\n    scene: ix_choice\n    target: ask\n",
            arm_timer("arm", "bump_timer", None, "bump", "hold")
        ),
    ));
    // Two due timers where the second reads what the first one changed.
    scenes.push(effect_scene(
        "ix_order",
        "arm_a",
        &format!(
            "{}{}",
            arm_timer("arm_a", "a_title", None, "retitle", "arm_b"),
            arm_timer("arm_b", "b_echo", None, "echo_title", "ask"),
        ),
    ));
    scenes
}

fn scene_map() -> BTreeMap<String, SceneDefinition> {
    let mut scenes = fixture_catalog().scenes.clone();
    for scene in interaction_scenes() {
        scenes.insert(scene.id.clone(), scene);
    }
    scenes
}

fn interaction_catalog() -> ContentCatalog {
    try_build(fixture_catalog().manifest.clone(), scene_map())
        .expect("interaction fixture content must validate")
}

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

fn begin(content: &ContentCatalog, scene_id: &str) -> (RuntimeEngine, RuntimeUpdate) {
    let mut runtime = RuntimeEngine::new(content).expect("engine");
    let update = runtime
        .start_scene_preview(content, scene_id)
        .unwrap_or_else(|error| panic!("{scene_id} must start: {error}"));
    (runtime, update)
}

fn begin_with_score(
    content: &ContentCatalog,
    scene_id: &str,
    score: i64,
) -> (RuntimeEngine, RuntimeUpdate) {
    let overrides = BTreeMap::from([("score".to_owned(), ScalarValue::Integer(score))]);
    let mut runtime = RuntimeEngine::with_preview_overrides(content, &overrides).expect("engine");
    let update = runtime
        .start_scene_preview(content, scene_id)
        .unwrap_or_else(|error| panic!("{scene_id} must start: {error}"));
    (runtime, update)
}

/// A host replacing the authoritative Save variables behind a prompt's back.
fn set_score(runtime: &mut RuntimeEngine, score: i64) {
    let mut variables = runtime.snapshot().variables.clone();
    variables.insert("score".to_owned(), ScalarValue::Integer(score));
    runtime.set_save_variables(variables);
}

fn score(runtime: &RuntimeEngine) -> ScalarValue {
    runtime.snapshot().variables["score"].clone()
}

fn location(scene_id: &str, node_id: &str) -> StoryLocation {
    StoryLocation { scene_id: scene_id.to_owned(), node_id: node_id.to_owned() }
}

fn choice_view(snapshot: &RuntimeSnapshot) -> Vec<(&str, bool)> {
    match &snapshot.prompt {
        PromptSnapshot::Choice { choices, .. } => {
            choices.iter().map(|choice| (choice.id.as_str(), choice.enabled)).collect()
        }
        other => panic!("expected a choice prompt, got {other:?}"),
    }
}

fn choice_label<'a>(snapshot: &'a RuntimeSnapshot, id: &str) -> &'a str {
    match &snapshot.prompt {
        PromptSnapshot::Choice { choices, .. } => choices
            .iter()
            .find(|choice| choice.id == id)
            .unwrap_or_else(|| panic!("no choice {id}"))
            .label
            .as_str(),
        other => panic!("expected a choice prompt, got {other:?}"),
    }
}

fn dialogue_text(snapshot: &RuntimeSnapshot) -> &str {
    match &snapshot.prompt {
        PromptSnapshot::Dialogue { text, .. } => text,
        other => panic!("expected a dialogue prompt, got {other:?}"),
    }
}

fn prompt_id(snapshot: &RuntimeSnapshot) -> &str {
    match &snapshot.prompt {
        PromptSnapshot::Dialogue { prompt_id, .. }
        | PromptSnapshot::Choice { prompt_id, .. }
        | PromptSnapshot::End { prompt_id } => prompt_id,
        other => panic!("prompt has no id: {other:?}"),
    }
}

/// A snapshot a runtime produced must always be restorable by a fresh runtime.
fn assert_loadable(content: &ContentCatalog, snapshot: &RuntimeSnapshot) {
    let mut fresh = RuntimeEngine::new(content).expect("engine");
    fresh
        .load_snapshot(content, snapshot.clone())
        .expect("a runtime-produced snapshot must load back");
}

fn advance(
    runtime: &mut RuntimeEngine,
    content: &ContentCatalog,
    source: AdvanceSource,
) -> Result<RuntimeUpdate, RuntimeError> {
    let revision = runtime.snapshot().revision;
    runtime.advance(content, revision, source)
}

fn choose(
    runtime: &mut RuntimeEngine,
    content: &ContentCatalog,
    id: &str,
) -> Result<RuntimeUpdate, RuntimeError> {
    let revision = runtime.snapshot().revision;
    runtime.choose(content, id, revision)
}

fn assert_advance_refused(runtime: &mut RuntimeEngine, content: &ContentCatalog, source: AdvanceSource) {
    let before = runtime.snapshot().clone();
    match advance(runtime, content, source) {
        Err(RuntimeError::AdvanceNotAllowed) => {}
        other => panic!("{source:?} advance must be refused, got {other:?}"),
    }
    assert_eq!(runtime.snapshot(), &before, "a refused advance must not touch the state");
}

// ---------------------------------------------------------------------------
// Window titles and host boundary
// ---------------------------------------------------------------------------

#[test]
fn title_request_stops_at_the_host_boundary_until_the_host_resumes() {
    let content = interaction_catalog();
    let (mut runtime, start) = begin(&content, "ix_title");
    assert_eq!(dialogue_text(&start.snapshot), "开场");
    assert!(!runtime.at_host_boundary());
    assert!(runtime.take_window_requests().is_empty());
    assert!(
        matches!(runtime.resume_after_host(&content), Err(RuntimeError::AdvanceNotAllowed)),
        "there is no boundary to resume yet"
    );

    let update = advance(&mut runtime, &content, AdvanceSource::Manual).expect("advance");
    assert!(runtime.at_host_boundary(), "a window_title node is a host boundary");
    assert_eq!(update.kind, UpdateKind::Story);
    assert!(!update.requires_ack, "a host boundary is not a presentation ack");
    assert_eq!(update.snapshot.prompt, PromptSnapshot::None);
    assert_eq!(update.snapshot.location, location("ix_title", "after"));
    assert_eq!(
        runtime.take_window_requests(),
        vec![WindowRequest::Title { target: WindowRole::Main, title: "第0幕".to_owned() }],
        "the request carries the interpolated title"
    );
    assert!(runtime.take_window_requests().is_empty(), "requests are drained exactly once");
    assert_eq!(
        update.snapshot.interaction.titles.main, DEFAULT_MAIN_TITLE,
        "only the host applies a title; the request alone changes nothing"
    );

    // No player input is accepted while the host owns the boundary.
    assert_advance_refused(&mut runtime, &content, AdvanceSource::Manual);
    assert_advance_refused(&mut runtime, &content, AdvanceSource::Script);
    assert!(matches!(
        choose(&mut runtime, &content, "anything"),
        Err(RuntimeError::AdvanceNotAllowed)
    ));
    assert!(!runtime.can_script_advance());
    assert!(runtime.at_host_boundary());

    runtime.set_window_titles(WindowTitles { main: "第0幕".to_owned(), secondary: "副".to_owned() });
    let resumed = runtime.resume_after_host(&content).expect("resume");
    assert!(!runtime.at_host_boundary());
    assert!(resumed.snapshot.revision > update.snapshot.revision);
    assert_eq!(
        dialogue_text(&resumed.snapshot),
        "当前标题第0幕",
        "the story after the boundary reads the title the host applied"
    );
    assert_eq!(resumed.snapshot.interaction.titles.main, "第0幕");
    assert_eq!(resumed.snapshot.interaction.titles.secondary, "副");
    assert!(
        matches!(runtime.resume_after_host(&content), Err(RuntimeError::AdvanceNotAllowed)),
        "a boundary can be resumed only once"
    );
}

#[test]
fn default_titles_and_window_variable_names_are_the_documented_contract() {
    assert_eq!(MAIN_TITLE_VARIABLE, "window.main.title");
    assert_eq!(SECONDARY_TITLE_VARIABLE, "window.secondary.title");
    let defaults = WindowTitles::default();
    assert_eq!(defaults.main, DEFAULT_MAIN_TITLE);
    let variables = WindowTitles { main: "甲".to_owned(), secondary: "乙".to_owned() }.variables();
    assert_eq!(variables[MAIN_TITLE_VARIABLE], ScalarValue::Text("甲".to_owned()));
    assert_eq!(variables[SECONDARY_TITLE_VARIABLE], ScalarValue::Text("乙".to_owned()));

    let content = interaction_catalog();
    let mut runtime = RuntimeEngine::new(&content).expect("engine");
    assert_eq!(
        runtime.resolve_preview_text(&content, "[var=window.main.title]").unwrap(),
        DEFAULT_MAIN_TITLE
    );
    runtime.set_window_titles(WindowTitles { main: "甲".to_owned(), secondary: "乙".to_owned() });
    assert_eq!(
        runtime
            .resolve_preview_text(&content, "[var=window.main.title]/[var=window.secondary.title]")
            .unwrap(),
        "甲/乙"
    );
    assert_eq!(runtime.snapshot().interaction.titles.main, "甲");
}

#[test]
fn an_oversized_interpolated_title_is_a_content_error_and_emits_no_request() {
    let content = interaction_catalog();
    // The title interpolates a string variable; variables may be larger than
    // the 4096-byte title limit, so this can only be caught at runtime.
    let overrides = BTreeMap::from([("route".to_owned(), ScalarValue::Text("字".repeat(2000)))]);
    let mut runtime = RuntimeEngine::with_preview_overrides(&content, &overrides).expect("engine");
    let error = runtime
        .start_scene_preview(&content, "ix_big_title")
        .expect_err("a 6000-byte title must be refused at runtime");
    assert!(matches!(error, RuntimeError::Content(_)), "{error:?}");
    assert!(runtime.take_window_requests().is_empty(), "no request for an invalid title");
    assert!(!runtime.at_host_boundary());
}

#[test]
fn a_restarted_session_drops_stale_boundary_state_and_titles() {
    let content = interaction_catalog();
    let (mut runtime, _) = begin(&content, "ix_title");
    advance(&mut runtime, &content, AdvanceSource::Manual).expect("advance");
    runtime.set_window_titles(WindowTitles { main: "旧主".to_owned(), secondary: "旧副".to_owned() });
    assert!(runtime.at_host_boundary());

    // The host abandons the boundary (new game / new preview) without resuming.
    let restarted = runtime.start_scene_preview(&content, "ix_choice").expect("restart");
    assert!(!runtime.at_host_boundary(), "a fresh session is never at a stale boundary");
    assert!(
        runtime.take_window_requests().is_empty(),
        "a title request of the abandoned session must not leak into the new one"
    );
    assert_eq!(restarted.snapshot.location, location("ix_choice", "ask"));
    assert_eq!(restarted.snapshot.interaction.titles, WindowTitles::default());
    assert_eq!(
        runtime.resolve_preview_text(&content, "[var=window.main.title]").unwrap(),
        DEFAULT_MAIN_TITLE,
        "the readable title variable stays in sync with the snapshot"
    );
}

#[test]
fn prepared_window_titles_seed_exactly_the_next_session_before_its_first_node() {
    let content = interaction_catalog();
    let seeded = WindowTitles { main: "预设主".to_owned(), secondary: "预设副".to_owned() };
    let mut runtime = RuntimeEngine::new(&content).expect("engine");

    // The very first authored node already reads the seeded titles.
    runtime.prepare_window_titles(seeded.clone());
    let update = runtime.start_scene_preview(&content, "ix_titles_read").expect("start");
    assert_eq!(dialogue_text(&update.snapshot), "预设主/预设副");
    assert_eq!(update.snapshot.interaction.titles, seeded);

    // One-shot: the next start of any kind falls back to the defaults.
    let again = runtime.start_scene_preview(&content, "ix_titles_read").expect("start");
    let defaults = WindowTitles::default();
    assert_eq!(again.snapshot.interaction.titles, defaults);
    assert_eq!(dialogue_text(&again.snapshot), format!("{}/{}", defaults.main, defaults.secondary));

    // All three start kinds honour the seed.
    runtime.prepare_window_titles(seeded.clone());
    let node = runtime.start_node_preview(&content, "ix_title", "after").expect("node preview");
    assert_eq!(dialogue_text(&node.snapshot), "当前标题预设主");
    runtime.prepare_window_titles(seeded.clone());
    let game = runtime.start_new_game(&content).expect("new game");
    assert_eq!(game.snapshot.interaction.titles, seeded);

    // Loading a save discards an unused seed: the save owns its titles.
    runtime.prepare_window_titles(seeded);
    let loaded = runtime.load_snapshot(&content, again.snapshot.clone()).expect("load");
    assert_eq!(loaded.snapshot.interaction.titles, defaults);
    let after_load = runtime.start_scene_preview(&content, "ix_choice").expect("start");
    assert_eq!(after_load.snapshot.interaction.titles, defaults, "the seed died with the load");
}

// ---------------------------------------------------------------------------
// Secondary window: control requests and advance blocks
// ---------------------------------------------------------------------------

#[test]
fn secondary_scene_holds_releases_and_nudges_the_main_window_through_the_host() {
    let content = interaction_catalog();
    let (mut main, main_start) = begin(&content, "ix_block");
    assert_eq!(dialogue_text(&main_start.snapshot), "一");
    let (mut secondary, secondary_start) = begin(&content, "ix_secondary");

    // Step 1: the secondary scene asks to hold the main window.
    assert!(secondary.at_host_boundary());
    assert_eq!(secondary_start.snapshot.prompt, PromptSnapshot::None);
    let requests = secondary.take_window_requests();
    assert_eq!(
        requests,
        vec![WindowRequest::Control {
            target: WindowRole::Main,
            action: WindowControlAction::Block,
            id: "hold".to_owned(),
            message: "副窗口占用中".to_owned(),
        }]
    );
    main.control_block(WindowRole::Secondary, "ix_secondary", WindowControlAction::Block, "hold", "副窗口占用中");
    assert_advance_refused(&mut main, &content, AdvanceSource::Manual);
    assert_advance_refused(&mut main, &content, AdvanceSource::Script);

    // Step 2: its own title request; the hold stays in force.
    secondary.resume_after_host(&content).expect("resume");
    assert_eq!(
        secondary.take_window_requests(),
        vec![WindowRequest::Title { target: WindowRole::Secondary, title: "副窗口0".to_owned() }]
    );
    assert!(!main.can_script_advance());

    // Step 3: release.
    secondary.resume_after_host(&content).expect("resume");
    let requests = secondary.take_window_requests();
    assert_eq!(
        requests,
        vec![WindowRequest::Control {
            target: WindowRole::Main,
            action: WindowControlAction::Unblock,
            id: "hold".to_owned(),
            message: String::new(),
        }]
    );
    main.control_block(WindowRole::Secondary, "ix_secondary", WindowControlAction::Unblock, "hold", "");
    assert!(main.snapshot().interaction.blocks.is_empty());
    assert!(main.can_script_advance());

    // Step 4: the script advance request moves the main window on.
    secondary.resume_after_host(&content).expect("resume");
    let requests = secondary.take_window_requests();
    assert_eq!(
        requests,
        vec![WindowRequest::Control {
            target: WindowRole::Main,
            action: WindowControlAction::Advance,
            id: String::new(),
            message: String::new(),
        }]
    );
    let advanced = advance(&mut main, &content, AdvanceSource::Script).expect("script advance");
    assert_eq!(dialogue_text(&advanced.snapshot), "二");

    // Step 5: the secondary scene finishes.
    let finished = secondary.resume_after_host(&content).expect("resume");
    assert!(!secondary.at_host_boundary());
    assert!(matches!(finished.snapshot.prompt, PromptSnapshot::End { .. }));
}

#[test]
fn blocks_stop_every_advance_source_including_script_but_never_choose_for_the_player() {
    let content = interaction_catalog();
    let (mut runtime, start) = begin(&content, "ix_block");
    assert!(runtime.can_script_advance());
    assert!(
        matches!(choose(&mut runtime, &content, "pick"), Err(RuntimeError::ChoiceNotAllowed)),
        "a dialogue is not a choice"
    );

    runtime.control_block(WindowRole::Secondary, "ix_secondary", WindowControlAction::Block, "hold", "占用");
    runtime.control_block(WindowRole::Secondary, "ix_other", WindowControlAction::Block, "hold", "另一个");
    // Same (source, scene, id) replaces; a different scene is independent.
    runtime.control_block(WindowRole::Secondary, "ix_secondary", WindowControlAction::Block, "hold", "更新后");
    let blocks = runtime.snapshot().interaction.blocks.clone();
    assert_eq!(blocks.len(), 2);
    let updated = blocks.iter().find(|block| block.source_scene == "ix_secondary").expect("block");
    assert_eq!((updated.id.as_str(), updated.source, updated.message.as_str()), ("hold", WindowRole::Secondary, "更新后"));
    assert!(!runtime.can_script_advance());

    for source in [
        AdvanceSource::Manual,
        AdvanceSource::Auto,
        AdvanceSource::FastForward,
        AdvanceSource::Script,
    ] {
        assert_advance_refused(&mut runtime, &content, source);
    }
    // Blocks do not freeze the runtime: a refresh still publishes them.
    let refreshed = runtime.refresh_update(&content).expect("refresh");
    assert_eq!(refreshed.snapshot.interaction.blocks.len(), 2);
    assert_eq!(refreshed.snapshot.location, start.snapshot.location);

    // Removing one source scene's holds leaves the other in force.
    runtime.clear_blocks_from(WindowRole::Secondary, "ix_other");
    assert_eq!(runtime.snapshot().interaction.blocks.len(), 1);
    assert_advance_refused(&mut runtime, &content, AdvanceSource::Script);
    runtime.control_block(WindowRole::Secondary, "ix_secondary", WindowControlAction::Unblock, "hold", "");
    assert!(runtime.snapshot().interaction.blocks.is_empty());
    assert!(runtime.can_script_advance());

    let second = advance(&mut runtime, &content, AdvanceSource::Script).expect("script advance");
    assert_eq!(dialogue_text(&second.snapshot), "二");
    advance(&mut runtime, &content, AdvanceSource::Manual).expect("manual advance");
    assert!(matches!(runtime.snapshot().prompt, PromptSnapshot::Choice { .. }));

    // A script can never pick for the player, blocked or not.
    assert!(!runtime.can_script_advance());
    assert_advance_refused(&mut runtime, &content, AdvanceSource::Script);
    assert_eq!(runtime.snapshot().location, location("ix_block", "ask"));

    // Blocks gate advancing only: the player's own choice still works.
    runtime.control_block(WindowRole::Secondary, "ix_secondary", WindowControlAction::Block, "hold", "占用");
    let picked = choose(&mut runtime, &content, "pick").expect("choose is not gated by blocks");
    assert!(matches!(picked.snapshot.prompt, PromptSnapshot::End { .. }));
    assert_eq!(picked.snapshot.interaction.blocks.len(), 1, "the hold itself is untouched");
}

#[test]
fn script_advance_ignores_the_playback_policy_that_refuses_manual_advance() {
    let content = interaction_catalog();
    let (mut runtime, start) = begin(&content, "ix_forced");
    assert_eq!(dialogue_text(&start.snapshot), "强制");
    assert_advance_refused(&mut runtime, &content, AdvanceSource::Manual);
    let update = advance(&mut runtime, &content, AdvanceSource::Script).expect("script advance");
    assert_eq!(dialogue_text(&update.snapshot), "之后");
}

#[test]
fn open_window_is_non_blocking_and_only_emits_a_cue_for_the_host() {
    let content = interaction_catalog();
    let (runtime, start) = begin(&content, "ix_open");
    assert!(!runtime.at_host_boundary(), "open_window is not a host boundary");
    assert_eq!(dialogue_text(&start.snapshot), "副窗口已请求");
    let cue = start
        .cues
        .iter()
        .find(|cue| matches!(&cue.kind, PresentationCueKind::OpenWindow { scene } if scene == "ix_secondary"))
        .expect("an open-window cue for the secondary scene");
    assert_eq!(cue.gate, CueGate::None);
    assert!(!start.requires_ack);
}

// ---------------------------------------------------------------------------
// Refreshable prompts
// ---------------------------------------------------------------------------

#[test]
fn refreshing_a_choice_adds_removes_and_disables_options_but_keeps_the_prompt_instance() {
    let content = interaction_catalog();
    let (mut runtime, start) = begin(&content, "ix_choice");
    let instance = start.snapshot.interaction.prompt_instance.clone();
    assert!(!instance.is_empty(), "an entered prompt has an occurrence id");
    assert_eq!(start.snapshot.interaction.prompt_source, Some(location("ix_choice", "ask")));
    assert_eq!(choice_view(&start.snapshot), [("always", true), ("early", true)]);
    let id = prompt_id(&start.snapshot).to_owned();
    assert_eq!(id, "ix_choice/ask");

    // A new option appears and another one is disabled.
    set_score(&mut runtime, 1);
    let appeared = runtime.refresh_update(&content).expect("refresh");
    assert_eq!(appeared.kind, UpdateKind::StateRefresh);
    assert!(!appeared.requires_ack);
    assert!(appeared.cues.is_empty());
    assert!(appeared.update_id > start.update_id);
    assert!(appeared.snapshot.revision > start.snapshot.revision);
    assert_eq!(
        choice_view(&appeared.snapshot),
        [("always", true), ("odd", true), ("early", false)]
    );
    assert_eq!(choice_label(&appeared.snapshot, "odd"), "解锁1", "labels are re-interpolated");
    assert_eq!(appeared.snapshot.interaction.prompt_instance, instance);
    assert_eq!(appeared.snapshot.interaction.prompt_source, start.snapshot.interaction.prompt_source);
    assert_eq!(prompt_id(&appeared.snapshot), id);
    assert_eq!(appeared.snapshot.location, start.snapshot.location);
    assert_loadable(&content, &appeared.snapshot);

    // The added option disappears again; the disabled one stays disabled.
    set_score(&mut runtime, 2);
    let removed = runtime.refresh_update(&content).expect("refresh");
    assert_eq!(choice_view(&removed.snapshot), [("always", true), ("early", false)]);
    assert_eq!(removed.snapshot.interaction.prompt_instance, instance);
    assert_loadable(&content, &removed.snapshot);

    // And everything comes back when the state does.
    set_score(&mut runtime, 0);
    let restored = runtime.refresh_update(&content).expect("refresh");
    assert_eq!(choice_view(&restored.snapshot), [("always", true), ("early", true)]);
    assert_eq!(restored.snapshot.interaction.prompt_instance, instance);
    assert!(restored.snapshot.revision > removed.snapshot.revision);
}

#[test]
fn a_refresh_makes_older_revisions_stale() {
    let content = interaction_catalog();
    let (mut runtime, start) = begin(&content, "ix_choice");
    set_score(&mut runtime, 1);
    let refreshed = runtime.refresh_update(&content).expect("refresh");
    match runtime.choose(&content, "always", start.snapshot.revision) {
        Err(RuntimeError::StaleRevision { expected, actual }) => {
            assert_eq!(expected, start.snapshot.revision);
            assert_eq!(actual, refreshed.snapshot.revision);
        }
        other => panic!("a pre-refresh revision must be stale, got {other:?}"),
    }
    runtime.choose(&content, "always", refreshed.snapshot.revision).expect("current revision");
}

#[test]
fn zero_visible_options_are_a_waiting_prompt_that_recovers_on_refresh() {
    let content = interaction_catalog();
    let (mut runtime, start) = begin(&content, "ix_waiting");
    assert!(choice_view(&start.snapshot).is_empty(), "the prompt is entered with no option at all");
    let instance = start.snapshot.interaction.prompt_instance.clone();
    assert!(!instance.is_empty());
    assert_loadable(&content, &start.snapshot);

    // Nothing can be chosen or advanced while waiting.
    assert!(matches!(
        choose(&mut runtime, &content, "open"),
        Err(RuntimeError::UnknownChoice(id)) if id == "open"
    ));
    assert_advance_refused(&mut runtime, &content, AdvanceSource::Manual);
    assert_advance_refused(&mut runtime, &content, AdvanceSource::Script);
    assert!(!runtime.can_script_advance());

    set_score(&mut runtime, 1);
    let open = runtime.refresh_update(&content).expect("refresh");
    assert_eq!(choice_view(&open.snapshot), [("open", true)]);
    assert_eq!(open.snapshot.interaction.prompt_instance, instance, "same occurrence");
    assert_loadable(&content, &open.snapshot);

    // Back to zero options: still the same prompt, not an error.
    set_score(&mut runtime, 0);
    let closed = runtime.refresh_update(&content).expect("refresh");
    assert!(choice_view(&closed.snapshot).is_empty());
    assert_eq!(closed.snapshot.interaction.prompt_instance, instance);
    assert_loadable(&content, &closed.snapshot);

    set_score(&mut runtime, 1);
    runtime.refresh_update(&content).expect("refresh");
    let done = choose(&mut runtime, &content, "open").expect("choose after recovery");
    assert!(matches!(done.snapshot.prompt, PromptSnapshot::End { .. }));
}

#[test]
fn choose_revalidates_the_option_against_the_current_state() {
    let content = interaction_catalog();
    let (mut runtime, start) = begin(&content, "ix_choice");
    let instance = start.snapshot.interaction.prompt_instance.clone();

    // The UI still shows "early" enabled, but the authoritative state moved on.
    set_score(&mut runtime, 1);
    let revision = runtime.snapshot().revision;
    assert!(matches!(
        runtime.choose(&content, "early", revision),
        Err(RuntimeError::UnknownChoice(id)) if id == "early"
    ));
    assert_eq!(runtime.snapshot().location, start.snapshot.location, "a refused choice never moves");
    assert_eq!(runtime.snapshot().interaction.prompt_instance, instance);

    // An option that has since been removed is refused as well, as is a ghost.
    set_score(&mut runtime, 2);
    let revision = runtime.snapshot().revision;
    for id in ["odd", "does_not_exist"] {
        assert!(matches!(
            runtime.choose(&content, id, revision),
            Err(RuntimeError::UnknownChoice(rejected)) if rejected == id
        ));
    }
    assert_eq!(runtime.snapshot().location, start.snapshot.location);

    // Still-valid options choose normally.
    let done = choose(&mut runtime, &content, "always").expect("always is still available");
    assert_eq!(done.snapshot.location, location("ix_choice", "done"));
    assert!(matches!(done.snapshot.prompt, PromptSnapshot::End { .. }));
}

#[test]
fn only_entering_a_new_prompt_occurrence_changes_the_prompt_instance() {
    let content = interaction_catalog();
    let (mut runtime, first) = begin(&content, "ix_loop");
    let first_instance = first.snapshot.interaction.prompt_instance.clone();
    assert!(!first_instance.is_empty());

    let refreshed = runtime.refresh_update(&content).expect("refresh");
    assert_eq!(refreshed.snapshot.interaction.prompt_instance, first_instance);

    // Choosing "again" re-enters the very same choice node: the prompt id is
    // identical, the occurrence is new.
    let second = choose(&mut runtime, &content, "again").expect("again");
    assert_eq!(prompt_id(&second.snapshot), prompt_id(&first.snapshot));
    let second_instance = second.snapshot.interaction.prompt_instance.clone();
    assert_ne!(second_instance, first_instance);
    assert_eq!(second.snapshot.interaction.prompt_source, Some(location("ix_loop", "ask")));

    let third = choose(&mut runtime, &content, "again").expect("again");
    let third_instance = third.snapshot.interaction.prompt_instance.clone();
    assert_ne!(third_instance, second_instance);
    assert_ne!(third_instance, first_instance);
    assert_eq!(
        runtime.refresh_update(&content).unwrap().snapshot.interaction.prompt_instance,
        third_instance
    );

    // Dialogue lines are occurrences too.
    let (mut runtime, line_one) = begin(&content, "ix_block");
    let line_two = advance(&mut runtime, &content, AdvanceSource::Manual).expect("advance");
    assert_ne!(
        line_one.snapshot.interaction.prompt_instance,
        line_two.snapshot.interaction.prompt_instance
    );
}

#[test]
fn refreshing_a_dialogue_updates_its_text_and_stable_page_in_place() {
    let content = interaction_catalog();
    let (mut runtime, start) = begin(&content, "ix_say");
    assert_eq!(dialogue_text(&start.snapshot), "分数0");
    let instance = start.snapshot.interaction.prompt_instance.clone();

    set_score(&mut runtime, 7);
    let refreshed = runtime.refresh_update(&content).expect("refresh");
    assert_eq!(refreshed.kind, UpdateKind::StateRefresh);
    assert_eq!(dialogue_text(&refreshed.snapshot), "分数7");
    assert_eq!(
        refreshed.snapshot.dialogue_page.as_ref().and_then(|page| page.segments.last()).map(String::as_str),
        Some("分数7"),
        "the stable page keeps agreeing with the prompt"
    );
    assert_eq!(refreshed.snapshot.interaction.prompt_instance, instance);
    assert_eq!(refreshed.snapshot.location, start.snapshot.location);
    assert_loadable(&content, &refreshed.snapshot);
}

// ---------------------------------------------------------------------------
// Pending acknowledgements
// ---------------------------------------------------------------------------

#[test]
fn refresh_never_drops_or_replaces_a_pending_acknowledgement() {
    let content = interaction_catalog();
    let (mut runtime, start) = begin(&content, "ix_gate");
    assert!(start.requires_ack, "the awaited wait needs an acknowledgement");
    let pending = start.update_id;
    assert_eq!(runtime.pending_runtime_update(), Some(pending));
    assert!(!runtime.can_script_advance());
    assert!(matches!(
        advance(&mut runtime, &content, AdvanceSource::Script),
        Err(RuntimeError::PresentationPending(id)) if id == pending
    ));

    // Refreshes interleave with the pending presentation, twice.
    let first = runtime.refresh_update(&content).expect("refresh");
    let second = runtime.refresh_update(&content).expect("refresh");
    for refresh in [&first, &second] {
        assert_eq!(refresh.kind, UpdateKind::StateRefresh);
        assert!(!refresh.requires_ack, "a refresh never asks for an acknowledgement");
        assert!(refresh.cues.is_empty());
    }
    assert_eq!(runtime.pending_runtime_update(), Some(pending), "the original ack survives");

    // A refresh update id is not the awaited acknowledgement.
    match runtime.presentation_complete(&content, first.update_id, PresentationOutcome::Completed) {
        Err(RuntimeError::InvalidAcknowledgement { expected, actual }) => {
            assert_eq!(expected, pending);
            assert_eq!(actual, first.update_id);
        }
        other => panic!("a refresh id must not acknowledge the presentation: {other:?}"),
    }
    assert_eq!(runtime.pending_runtime_update(), Some(pending));

    let resumed = runtime
        .presentation_complete(&content, pending, PresentationOutcome::Completed)
        .expect("the original acknowledgement still works");
    assert_eq!(runtime.pending_runtime_update(), None);
    assert_eq!(dialogue_text(&resumed.snapshot), "后");
}

#[test]
fn timers_wait_for_a_pending_acknowledgement_and_fire_once_after_it() {
    let content = interaction_catalog();
    let (mut runtime, start) = begin(&content, "ix_gate");
    assert_eq!(runtime.snapshot().interaction.timers.len(), 1);

    let (updates, diagnostics) = runtime.tick_timers(&content, 1_000);
    assert!(updates.is_empty() && diagnostics.is_empty(), "a gated timer neither fires nor errors");
    let timer = &runtime.snapshot().interaction.timers["bump_timer"];
    assert_eq!(timer.remaining_ms, 0, "the due timer is kept, not dropped");
    assert_eq!(score(&runtime), ScalarValue::Integer(0));
    assert_eq!(runtime.pending_runtime_update(), Some(start.update_id));

    let resumed = runtime
        .presentation_complete(&content, start.update_id, PresentationOutcome::Completed)
        .expect("ack");
    assert_eq!(dialogue_text(&resumed.snapshot), "后");
    let instance = resumed.snapshot.interaction.prompt_instance.clone();

    let (updates, diagnostics) = runtime.tick_timers(&content, 0);
    assert!(diagnostics.is_empty());
    assert_eq!(updates.len(), 1, "the postponed callback fires exactly once");
    assert_eq!(updates[0].kind, UpdateKind::Effect);
    assert_eq!(score(&runtime), ScalarValue::Integer(1));
    assert!(runtime.snapshot().interaction.timers.is_empty());
    assert_eq!(updates[0].snapshot.interaction.prompt_instance, instance);
    assert_eq!(dialogue_text(&updates[0].snapshot), "后");
    assert!(runtime.tick_timers(&content, 10_000).0.is_empty());
}

#[test]
fn timers_wait_for_the_host_boundary_to_be_resumed() {
    let content = interaction_catalog();
    let (mut runtime, start) = begin(&content, "ix_boundary_timer");
    assert!(runtime.at_host_boundary());
    assert_eq!(start.snapshot.prompt, PromptSnapshot::None);
    assert_eq!(
        runtime.take_window_requests(),
        vec![WindowRequest::Title { target: WindowRole::Main, title: "边界".to_owned() }]
    );

    let (updates, diagnostics) = runtime.tick_timers(&content, 1_000);
    assert!(updates.is_empty() && diagnostics.is_empty());
    assert_eq!(runtime.snapshot().interaction.timers["bump_timer"].remaining_ms, 0);

    let resumed = runtime.resume_after_host(&content).expect("resume");
    assert_eq!(dialogue_text(&resumed.snapshot), "边界后");
    let (updates, _) = runtime.tick_timers(&content, 0);
    assert_eq!(updates.len(), 1);
    assert_eq!(score(&runtime), ScalarValue::Integer(1));
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

#[test]
fn a_one_shot_timer_fires_once_as_an_effect_and_never_moves_the_cursor() {
    let content = interaction_catalog();
    let (mut runtime, start) = begin(&content, "ix_once");
    assert_eq!(
        runtime.snapshot().interaction.timers,
        BTreeMap::from([(
            "bump_timer".to_owned(),
            SceneTimer { target: "bump".to_owned(), remaining_ms: 100, interval_ms: None }
        )])
    );
    assert_eq!(choice_view(&start.snapshot), [("always", true), ("early", true)]);

    let (updates, diagnostics) = runtime.tick_timers(&content, 99);
    assert!(updates.is_empty() && diagnostics.is_empty());
    assert_eq!(runtime.snapshot().interaction.timers["bump_timer"].remaining_ms, 1);
    assert_eq!(score(&runtime), ScalarValue::Integer(0));

    let (updates, diagnostics) = runtime.tick_timers(&content, 1);
    assert!(diagnostics.is_empty());
    assert_eq!(updates.len(), 1);
    let update = &updates[0];
    assert_eq!(update.kind, UpdateKind::Effect);
    assert!(!update.requires_ack, "a timer never creates an acknowledgement boundary");
    assert_eq!(update.snapshot.location, start.snapshot.location, "the story cursor does not move");
    assert_eq!(update.snapshot.interaction.prompt_instance, start.snapshot.interaction.prompt_instance);
    assert_eq!(update.snapshot.interaction.prompt_source, start.snapshot.interaction.prompt_source);
    assert!(update.snapshot.interaction.timers.is_empty(), "a one-shot timer is spent");
    assert_eq!(update.snapshot.variables["score"], ScalarValue::Integer(1));
    assert!(update.snapshot.revision > start.snapshot.revision, "the visible prompt changed");
    assert_eq!(
        choice_view(&update.snapshot),
        [("always", true), ("odd", true), ("early", false)],
        "the effect refreshes the active prompt"
    );
    assert_loadable(&content, &update.snapshot);

    // Never again, however much time passes.
    let (updates, diagnostics) = runtime.tick_timers(&content, 60_000);
    assert!(updates.is_empty() && diagnostics.is_empty());
    assert_eq!(score(&runtime), ScalarValue::Integer(1));

    // The player's own choice works against the refreshed revision.
    let done = runtime
        .choose(&content, "always", update.snapshot.revision)
        .expect("choose after a timer effect");
    assert_eq!(done.snapshot.location, location("ix_once", "done"));
}

#[test]
fn a_repeating_timer_never_catches_up_missed_periods() {
    let content = interaction_catalog();
    let (mut runtime, _) = begin(&content, "ix_repeat");

    // One huge elapsed time is a single callback, not five.
    let (updates, diagnostics) = runtime.tick_timers(&content, 1_000);
    assert!(diagnostics.is_empty());
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].kind, UpdateKind::Effect);
    assert_eq!(score(&runtime), ScalarValue::Integer(1));
    assert_eq!(
        runtime.snapshot().interaction.timers["bump_timer"],
        SceneTimer { target: "bump".to_owned(), remaining_ms: 200, interval_ms: Some(200) },
        "the next period is a full interval from now"
    );

    let (updates, _) = runtime.tick_timers(&content, 199);
    assert!(updates.is_empty());
    let (updates, _) = runtime.tick_timers(&content, 1);
    assert_eq!(updates.len(), 1);
    assert_eq!(score(&runtime), ScalarValue::Integer(2));

    let (updates, _) = runtime.tick_timers(&content, 5_000);
    assert_eq!(updates.len(), 1, "a long stall still yields one callback");
    assert_eq!(score(&runtime), ScalarValue::Integer(3));
    assert_eq!(runtime.snapshot().location, location("ix_repeat", "ask"));
    assert_eq!(runtime.snapshot().interaction.timers.len(), 1, "a repeating timer stays armed");
}

#[test]
fn a_repeated_effect_finishes_before_its_next_occurrence() {
    let content = interaction_catalog();
    let (mut runtime, _) = begin(&content, "ix_slow");
    let (updates, diagnostics) = runtime.tick_timers(&content, 100);
    assert!(diagnostics.is_empty());
    assert_eq!(updates.len(), 1);
    assert!(
        updates[0].cues.iter().any(|cue| matches!(
            &cue.kind,
            PresentationCueKind::BackgroundTransition { duration_ms: 400, .. }
        ) && cue.gate == CueGate::None),
        "the effect is presented without gating the story"
    );
    assert!(!updates[0].requires_ack);
    assert_eq!(runtime.snapshot().world.background.as_deref(), Some("bg.nvctsp"));
    assert_eq!(
        runtime.snapshot().interaction.timers["fade_timer"].remaining_ms,
        400,
        "the 400ms effect outlasts the 200ms interval, so the interval stretches"
    );
    assert!(runtime.tick_timers(&content, 399).0.is_empty());
    assert_eq!(runtime.tick_timers(&content, 1).0.len(), 1);
}

#[test]
fn a_timer_stop_node_cancels_a_timer_that_was_not_yet_due() {
    let content = interaction_catalog();
    let (mut runtime, start) = begin(&content, "ix_stop");
    assert_eq!(dialogue_text(&start.snapshot), "先说");
    assert!(runtime.snapshot().interaction.timers.contains_key("bump_timer"));
    assert!(runtime.tick_timers(&content, 50).0.is_empty());

    let update = advance(&mut runtime, &content, AdvanceSource::Manual).expect("advance");
    assert!(update.snapshot.interaction.timers.is_empty(), "the stop node removed the timer");
    assert!(matches!(update.snapshot.prompt, PromptSnapshot::Choice { .. }));
    let (updates, diagnostics) = runtime.tick_timers(&content, 60_000);
    assert!(updates.is_empty() && diagnostics.is_empty());
    assert_eq!(score(&runtime), ScalarValue::Integer(0));
}

#[test]
fn leaving_a_scene_cancels_its_timers() {
    let content = interaction_catalog();
    let (mut runtime, start) = begin(&content, "ix_leave");
    assert!(runtime.snapshot().interaction.timers.contains_key("bump_timer"));
    let leaving = advance(&mut runtime, &content, AdvanceSource::Manual).expect("advance");
    assert!(leaving.snapshot.interaction.timers.is_empty(), "timers are scene-owned");
    assert!(leaving.requires_ack, "a cross-scene jump clears the stage first");
    let (updates, diagnostics) = runtime.tick_timers(&content, 60_000);
    assert!(updates.is_empty() && diagnostics.is_empty());

    let arrived = runtime
        .presentation_complete(&content, leaving.update_id, PresentationOutcome::Completed)
        .expect("ack");
    assert_eq!(arrived.snapshot.location, location("ix_choice", "ask"));
    assert_eq!(arrived.snapshot.interaction.prompt_source, Some(location("ix_choice", "ask")));
    assert_ne!(
        arrived.snapshot.interaction.prompt_instance,
        start.snapshot.interaction.prompt_instance
    );
    assert_eq!(score(&runtime), ScalarValue::Integer(0), "the old scene's timer never ran");
}

#[test]
fn a_timer_effect_can_request_a_title_without_creating_a_host_boundary() {
    let content = interaction_catalog();
    let (mut runtime, start) = begin(&content, "ix_timer_title");
    assert!(!runtime.at_host_boundary());
    assert!(runtime.take_window_requests().is_empty());

    let (updates, diagnostics) = runtime.tick_timers(&content, 100);
    assert!(diagnostics.is_empty());
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].kind, UpdateKind::Effect);
    assert_eq!(updates[0].snapshot.location, start.snapshot.location);
    assert!(!runtime.at_host_boundary(), "a timer callback is not a story boundary");
    assert_eq!(
        runtime.take_window_requests(),
        vec![WindowRequest::Title { target: WindowRole::Main, title: "计时0".to_owned() }]
    );
}

#[test]
fn a_failing_timer_stops_with_a_diagnostic_and_leaves_everything_else_untouched() {
    let content = interaction_catalog();
    // `bump` adds 1 to `score`: it overflows. The healthy timers around it
    // (ordered by id: a_good, b_bad, c_good) must neither be lost nor undone.
    let (mut runtime, start) = begin_with_score(&content, "ix_two", i64::MAX);
    assert_eq!(runtime.snapshot().interaction.timers.len(), 3);
    assert_eq!(start.snapshot.variables["score"], ScalarValue::Integer(i64::MAX));

    let (updates, diagnostics) = runtime.tick_timers(&content, 100);
    assert_eq!(updates.len(), 2, "both healthy timers fired");
    assert!(updates.iter().all(|update| update.kind == UpdateKind::Effect));
    assert_eq!(diagnostics.len(), 1);
    assert!(diagnostics[0].contains("b_bad"), "{diagnostics:?}");
    assert_eq!(
        runtime.snapshot().variables["route"],
        ScalarValue::Text("xx".to_owned()),
        "the failing timer did not roll back its healthy neighbours"
    );
    assert_eq!(score(&runtime), ScalarValue::Integer(i64::MAX), "the failed effect left no trace");
    assert!(runtime.snapshot().interaction.timers.is_empty(), "the failed timer is stopped for good");
    assert_eq!(runtime.snapshot().location, start.snapshot.location);
    assert_eq!(runtime.snapshot().interaction.prompt_instance, start.snapshot.interaction.prompt_instance);
    assert!(!runtime.at_host_boundary());
    assert!(runtime.take_window_requests().is_empty());
}

#[test]
fn a_tick_pauses_after_a_window_request_so_the_next_callback_sees_the_applied_title() {
    let content = interaction_catalog();
    let (mut runtime, _) = begin(&content, "ix_order");
    assert_eq!(runtime.snapshot().interaction.timers.len(), 2);

    // Both timers are due, but the first one requests a title.
    let (updates, diagnostics) = runtime.tick_timers(&content, 100);
    assert!(diagnostics.is_empty());
    assert_eq!(updates.len(), 1, "the round stops at the first window request");
    assert_eq!(updates[0].kind, UpdateKind::Effect);
    assert_eq!(runtime.last_fired_timer(), Some("a_title"));
    assert_eq!(
        runtime.take_window_requests(),
        vec![WindowRequest::Title { target: WindowRole::Main, title: "计时0".to_owned() }]
    );
    assert!(!runtime.at_host_boundary());
    assert_eq!(
        runtime.snapshot().interaction.timers["b_echo"].remaining_ms,
        0,
        "the second callback stays due"
    );
    assert_eq!(runtime.snapshot().variables["route"], ScalarValue::Text(String::new()));

    // The host commits the title, then continues the same due set.
    runtime.set_window_titles(WindowTitles { main: "计时0".to_owned(), secondary: String::new() });
    let (updates, diagnostics) = runtime.tick_timers(&content, 0);
    assert!(diagnostics.is_empty());
    assert_eq!(updates.len(), 1);
    assert_eq!(runtime.last_fired_timer(), Some("b_echo"));
    assert_eq!(
        runtime.take_window_requests(),
        vec![WindowRequest::Title { target: WindowRole::Secondary, title: "回显计时0".to_owned() }],
        "the later callback read the title the host just applied"
    );
    assert!(runtime.snapshot().interaction.timers.is_empty());
}

#[test]
fn last_fired_timer_names_the_latest_callback_of_the_latest_tick_even_when_it_failed() {
    let content = interaction_catalog();
    let (mut runtime, _) = begin(&content, "ix_once");
    assert_eq!(runtime.last_fired_timer(), None);
    runtime.tick_timers(&content, 10);
    assert_eq!(runtime.last_fired_timer(), None, "nothing was due");
    runtime.tick_timers(&content, 90);
    assert_eq!(runtime.last_fired_timer(), Some("bump_timer"));
    runtime.tick_timers(&content, 10);
    assert_eq!(runtime.last_fired_timer(), None, "every tick starts from a clean slate");

    // A failing callback is still attributed, so a host can name the culprit.
    let (mut failing, _) = begin_with_score(&content, "ix_repeat", i64::MAX);
    let (updates, diagnostics) = failing.tick_timers(&content, 100);
    assert!(updates.is_empty());
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(failing.last_fired_timer(), Some("bump_timer"));
}

#[test]
fn stop_timer_removes_only_the_named_timer_and_reports_whether_it_existed() {
    let content = interaction_catalog();
    // `b_bad` would overflow and produce a diagnostic if it ever ran.
    let (mut runtime, _) = begin_with_score(&content, "ix_two", i64::MAX);
    assert!(runtime.stop_timer("b_bad"));
    assert!(!runtime.stop_timer("b_bad"), "already stopped");
    assert!(!runtime.stop_timer("no_such_timer"));
    assert_eq!(
        runtime.snapshot().interaction.timers.keys().map(String::as_str).collect::<Vec<_>>(),
        ["a_good", "c_good"]
    );
    let (updates, diagnostics) = runtime.tick_timers(&content, 100);
    assert_eq!(updates.len(), 2);
    assert!(diagnostics.is_empty(), "the stopped timer never ran: {diagnostics:?}");
    assert_eq!(runtime.snapshot().variables["route"], ScalarValue::Text("xx".to_owned()));
}

#[test]
fn a_failing_repeating_timer_is_stopped_and_stays_stopped() {
    let content = interaction_catalog();
    let (mut runtime, start) = begin_with_score(&content, "ix_repeat", i64::MAX);
    let mut expected = runtime.snapshot().clone();

    let (updates, diagnostics) = runtime.tick_timers(&content, 100);
    assert!(updates.is_empty(), "the failed callback produces no update");
    assert_eq!(diagnostics.len(), 1);
    assert!(diagnostics[0].contains("bump_timer"), "{diagnostics:?}");
    expected.interaction.timers.clear();
    assert_eq!(runtime.snapshot(), &expected, "only the timer was removed");

    for _ in 0..3 {
        let (updates, diagnostics) = runtime.tick_timers(&content, 10_000);
        assert!(updates.is_empty() && diagnostics.is_empty(), "no retry loop");
    }
    // The story itself is unaffected.
    let done = choose(&mut runtime, &content, "always").expect("story continues");
    assert_eq!(done.snapshot.location, location("ix_repeat", "done"));
    let _ = start;
}

// ---------------------------------------------------------------------------
// Save compatibility and invalid saved state
// ---------------------------------------------------------------------------

fn without_interaction(snapshot: &RuntimeSnapshot) -> RuntimeSnapshot {
    let mut value = serde_json::to_value(snapshot).expect("snapshot to value");
    assert!(
        value.as_object_mut().expect("object").remove("interaction").is_some(),
        "new snapshots serialize their interaction state"
    );
    serde_json::from_value(value).expect("a save written before interaction state must deserialize")
}

#[test]
fn saves_written_before_interaction_state_still_load_and_refresh() {
    let content = interaction_catalog();

    // Legacy choice save.
    let (_, start) = begin(&content, "ix_choice");
    let legacy = without_interaction(&start.snapshot);
    assert_eq!(legacy.interaction, InteractionSnapshot::default());
    assert!(legacy.interaction.prompt_instance.is_empty());
    let mut restored = RuntimeEngine::new(&content).expect("engine");
    let loaded = restored.load_snapshot(&content, legacy).expect("legacy choice save loads");
    assert_eq!(choice_view(&loaded.snapshot), [("always", true), ("early", true)]);
    assert!(loaded.snapshot.interaction.timers.is_empty());
    assert!(loaded.snapshot.interaction.blocks.is_empty());
    let instance = loaded.snapshot.interaction.prompt_instance.clone();
    assert!(!instance.is_empty(), "a legacy prompt is given an occurrence id on load");
    assert!(instance.parse::<u64>().is_ok(), "{instance}");
    set_score(&mut restored, 1);
    let refreshed = restored.refresh_update(&content).expect("refresh a legacy prompt");
    assert_eq!(
        choice_view(&refreshed.snapshot),
        [("always", true), ("odd", true), ("early", false)],
        "a legacy save without prompt_source refreshes from its location"
    );
    assert_eq!(refreshed.snapshot.interaction.prompt_instance, instance, "the backfilled id is stable");
    let done = restored
        .choose(&content, "always", refreshed.snapshot.revision)
        .expect("legacy save is playable");
    assert_eq!(done.snapshot.location, location("ix_choice", "done"));

    // Legacy dialogue save: the source is derived from the prompt id.
    let (_, start) = begin(&content, "ix_say");
    let legacy = without_interaction(&start.snapshot);
    let mut restored = RuntimeEngine::new(&content).expect("engine");
    restored.load_snapshot(&content, legacy).expect("legacy dialogue save loads");
    set_score(&mut restored, 5);
    let refreshed = restored.refresh_update(&content).expect("refresh a legacy dialogue");
    assert_eq!(dialogue_text(&refreshed.snapshot), "分数5");
}

#[test]
fn updates_written_before_update_kinds_default_to_story() {
    let content = interaction_catalog();
    let (_, start) = begin(&content, "ix_choice");
    let mut value = serde_json::to_value(&start).expect("update to value");
    assert!(value.as_object_mut().expect("object").remove("kind").is_some());
    let decoded: RuntimeUpdate = serde_json::from_value(value).expect("legacy update decodes");
    assert_eq!(decoded.kind, UpdateKind::Story);
    assert_eq!(decoded.snapshot, start.snapshot);
}

#[test]
fn interaction_state_survives_a_json_save_round_trip() {
    let content = interaction_catalog();
    let (mut runtime, _) = begin(&content, "ix_repeat");
    runtime.set_window_titles(WindowTitles { main: "存档标题".to_owned(), secondary: "副窗口标题".to_owned() });
    runtime.control_block(WindowRole::Secondary, "ix_secondary", WindowControlAction::Block, "hold", "占用");
    let saved = runtime.refresh_update(&content).expect("refresh").snapshot;
    assert_eq!(saved.interaction.timers.len(), 1);
    assert_eq!(saved.interaction.blocks.len(), 1);

    let json = serde_json::to_string(&saved).expect("snapshot serializes");
    let decoded: RuntimeSnapshot = serde_json::from_str(&json).expect("snapshot deserializes");
    assert_eq!(decoded, saved);

    let mut restored = RuntimeEngine::new(&content).expect("engine");
    let update = restored.load_snapshot(&content, decoded).expect("load");
    assert_eq!(update.snapshot.interaction, saved.interaction);
    assert_eq!(
        restored
            .resolve_preview_text(&content, "[var=window.main.title]|[var=window.secondary.title]")
            .unwrap(),
        "存档标题|副窗口标题",
        "loading restores the titles that interpolation reads"
    );
    assert!(!restored.at_host_boundary());
    assert!(restored.take_window_requests().is_empty());

    // The saved timer keeps counting after the load.
    let (updates, diagnostics) = restored.tick_timers(&content, 100);
    assert!(diagnostics.is_empty());
    assert_eq!(updates.len(), 1);
    assert_eq!(score(&restored), ScalarValue::Integer(1));
}

#[test]
fn loading_a_snapshot_discards_the_previous_sessions_boundary_and_requests() {
    let content = interaction_catalog();
    let (mut runtime, start) = begin(&content, "ix_title");
    let saved = start.snapshot.clone();
    advance(&mut runtime, &content, AdvanceSource::Manual).expect("advance");
    assert!(runtime.at_host_boundary());

    runtime.load_snapshot(&content, saved).expect("load");
    assert!(!runtime.at_host_boundary());
    assert!(runtime.take_window_requests().is_empty());
}

#[test]
fn load_rejects_forged_timers() {
    let content = interaction_catalog();
    let (_, start) = begin(&content, "ix_choice");
    let timer = |target: &str, remaining_ms: u64, interval_ms: Option<u64>| SceneTimer {
        target: target.to_owned(),
        remaining_ms,
        interval_ms,
    };
    let forge = |id: &str, timer: SceneTimer| {
        let mut forged = start.snapshot.clone();
        forged.interaction.timers.insert(id.to_owned(), timer);
        forged
    };
    let load = |snapshot: RuntimeSnapshot| {
        RuntimeEngine::new(&content).expect("engine").load_snapshot(&content, snapshot)
    };

    // Positive control: a real effect target of this scene is accepted.
    load(forge("ok", timer("bump", 100, Some(200)))).expect("a valid timer loads");

    for (what, forged) in [
        ("missing target", forge("ghost", timer("no_such_node", 0, None))),
        ("a choice is not an effect", forge("flow", timer("ask", 0, None))),
        ("an end node is not an effect", forge("end", timer("done", 0, None))),
        ("a node of another scene", forge("other", timer("arm", 0, None))),
        ("interval below the minimum", forge("fast", timer("bump", 0, Some(MIN_TIMER_INTERVAL_MS - 1)))),
        ("absurd delay", forge("slow", timer("bump", u64::MAX, None))),
        ("illegal id", forge("bad id!", timer("bump", 0, None))),
    ] {
        match load(forged) {
            Err(RuntimeError::InvalidSnapshot(_)) => {}
            other => panic!("{what}: expected InvalidSnapshot, got {other:?}"),
        }
    }

    let mut flood = start.snapshot.clone();
    for index in 0..=MAX_SCENE_TIMERS {
        flood.interaction.timers.insert(format!("t{index:03}"), timer("bump", 100, None));
    }
    assert!(matches!(load(flood), Err(RuntimeError::InvalidSnapshot(_))), "too many timers");
}

#[test]
fn load_rejects_forged_blocks_titles_and_prompt_state() {
    let content = interaction_catalog();
    let (mut source, _) = begin(&content, "ix_choice");
    source.control_block(
        WindowRole::Secondary,
        "ix_secondary",
        WindowControlAction::Block,
        "hold",
        "分数[var=score]",
    );
    let valid = source.refresh_update(&content).expect("refresh").snapshot;
    RuntimeEngine::new(&content)
        .expect("engine")
        .load_snapshot(&content, valid.clone())
        .expect("positive control: runtime-produced state loads");

    type Forge = Box<dyn Fn(&mut RuntimeSnapshot)>;
    let cases: Vec<(&str, Forge)> = vec![
        ("block from an unknown scene", Box::new(|s| s.interaction.blocks[0].source_scene = "ghost_scene".to_owned())),
        ("block whose role contradicts its scene", Box::new(|s| s.interaction.blocks[0].source = WindowRole::Main)),
        ("block with an illegal id", Box::new(|s| s.interaction.blocks[0].id = "bad id!".to_owned())),
        (
            "duplicate block key",
            Box::new(|s| {
                let duplicate = s.interaction.blocks[0].clone();
                s.interaction.blocks.push(duplicate);
            }),
        ),
        (
            "block hint referencing an unknown variable",
            Box::new(|s| s.interaction.blocks[0].message_template = Some("[var=nope]".to_owned())),
        ),
        ("title with a control character", Box::new(|s| s.interaction.titles.main = "a\u{7}b".to_owned())),
        ("oversized title", Box::new(|s| s.interaction.titles.secondary = "x".repeat(4097))),
        ("non-numeric prompt instance", Box::new(|s| s.interaction.prompt_instance = "abc".to_owned())),
        (
            "prompt source in another scene",
            Box::new(|s| s.interaction.prompt_source = Some(location("ix_block", "first"))),
        ),
        (
            "prompt source of the wrong node type",
            Box::new(|s| s.interaction.prompt_source = Some(location("ix_choice", "bump"))),
        ),
        (
            "prompt source node missing",
            Box::new(|s| s.interaction.prompt_source = Some(location("ix_choice", "ghost"))),
        ),
    ];
    for (what, forge) in cases {
        let mut forged = valid.clone();
        forge(&mut forged);
        match RuntimeEngine::new(&content).expect("engine").load_snapshot(&content, forged) {
            Err(RuntimeError::InvalidSnapshot(_)) => {}
            other => panic!("{what}: expected InvalidSnapshot, got {other:?}"),
        }
    }
}

#[test]
fn a_save_cannot_override_the_host_owned_window_titles() {
    let content = interaction_catalog();
    let (_, start) = begin(&content, "ix_choice");
    let mut forged = start.snapshot.clone();
    forged.variables.insert(MAIN_TITLE_VARIABLE.to_owned(), ScalarValue::Text("伪造".to_owned()));
    let mut runtime = RuntimeEngine::new(&content).expect("engine");
    if runtime.load_snapshot(&content, forged).is_ok() {
        assert_eq!(
            runtime.resolve_preview_text(&content, "[var=window.main.title]").unwrap(),
            DEFAULT_MAIN_TITLE,
            "titles come from the host, never from a saved variable"
        );
    }
}

#[test]
fn block_hints_are_templates_that_follow_the_live_state() {
    let content = interaction_catalog();
    let hint = "占用，分数[var=score]，标题[var=window.main.title]";
    let (mut runtime, _) = begin(&content, "ix_block");
    runtime.control_block(WindowRole::Secondary, "ix_secondary", WindowControlAction::Block, "hold", hint);

    let first = runtime.refresh_update(&content).expect("refresh");
    let block = &first.snapshot.interaction.blocks[0];
    assert_eq!(block.message, "占用，分数0，标题VECTSPACE");
    assert_eq!(block.message_template.as_deref(), Some(hint), "the template is what is kept");

    set_score(&mut runtime, 3);
    runtime.set_window_titles(WindowTitles { main: "新".to_owned(), secondary: String::new() });
    let second = runtime.refresh_update(&content).expect("refresh");
    assert_eq!(second.snapshot.interaction.blocks[0].message, "占用，分数3，标题新");

    // A save keeps following the state after it is loaded.
    let json = serde_json::to_string(&second.snapshot).expect("serialize");
    let decoded: RuntimeSnapshot = serde_json::from_str(&json).expect("deserialize");
    let mut restored = RuntimeEngine::new(&content).expect("engine");
    restored.load_snapshot(&content, decoded).expect("load");
    set_score(&mut restored, 9);
    let third = restored.refresh_update(&content).expect("refresh");
    assert_eq!(third.snapshot.interaction.blocks[0].message, "占用，分数9，标题新");

    // A block saved without a template keeps its fixed message.
    let mut legacy = second.snapshot.clone();
    legacy.interaction.blocks[0].message_template = None;
    legacy.interaction.blocks[0].message = "固定提示".to_owned();
    let mut restored = RuntimeEngine::new(&content).expect("engine");
    restored.load_snapshot(&content, legacy).expect("load");
    set_score(&mut restored, 5);
    let fixed = restored.refresh_update(&content).expect("refresh");
    assert_eq!(fixed.snapshot.interaction.blocks[0].message, "固定提示");
}

// ---------------------------------------------------------------------------
// Serialized names and defaults
// ---------------------------------------------------------------------------

#[test]
fn interaction_enums_use_stable_snake_case_names() {
    use serde_json::json;
    assert_eq!(serde_json::to_value(UpdateKind::Story).unwrap(), json!("story"));
    assert_eq!(serde_json::to_value(UpdateKind::StateRefresh).unwrap(), json!("state_refresh"));
    assert_eq!(serde_json::to_value(UpdateKind::Effect).unwrap(), json!("effect"));
    assert_eq!(serde_json::to_value(AdvanceSource::Script).unwrap(), json!("script"));
    assert_eq!(serde_json::to_value(WindowRole::Main).unwrap(), json!("main"));
    assert_eq!(serde_json::to_value(WindowRole::Secondary).unwrap(), json!("secondary"));
    assert_eq!(serde_json::to_value(WindowControlAction::Unblock).unwrap(), json!("unblock"));
    assert_eq!(serde_json::to_value(TimerAction::Start).unwrap(), json!("start"));
    assert_eq!(UpdateKind::default(), UpdateKind::Story);
    assert_eq!(WindowRole::default(), WindowRole::Main);
}

#[test]
fn interaction_snapshot_defaults_and_rejects_unknown_fields() {
    let empty: InteractionSnapshot = serde_json::from_str("{}").expect("all fields default");
    assert_eq!(empty, InteractionSnapshot::default());
    assert!(empty.blocks.is_empty() && empty.timers.is_empty());
    assert!(empty.prompt_instance.is_empty() && empty.prompt_source.is_none());
    assert!(serde_json::from_str::<InteractionSnapshot>(r#"{"bogus":1}"#).is_err());
    assert!(serde_json::from_str::<WindowTitles>(r#"{"main":"x"}"#).is_err(), "both titles are required");
}

#[test]
fn scene_role_defaults_to_main_and_rejects_unknown_roles() {
    let legacy = scene_from_yaml("schema_version: 2\nid: legacy\nentry: n\nnodes:\n  n:\n    type: end\n");
    assert_eq!(legacy.window_role, WindowRole::Main);
    let secondary = scene_from_yaml(SECONDARY_SCENE);
    assert_eq!(secondary.window_role, WindowRole::Secondary);
    let bad: Result<SceneDefinition, _> = serde_saphyr::from_str_with_options(
        "schema_version: 2\nwindow_role: tertiary\nid: x\nentry: n\nnodes:\n  n:\n    type: end\n",
        yaml_options(),
    );
    assert!(bad.is_err());
}

// ---------------------------------------------------------------------------
// Authoring rules enforced by the content validator
// ---------------------------------------------------------------------------

fn expect_valid_then_invalid(valid: BTreeMap<String, SceneDefinition>, invalid: BTreeMap<String, SceneDefinition>, what: &str) {
    let manifest = fixture_catalog().manifest.clone();
    try_build(manifest.clone(), valid)
        .unwrap_or_else(|error| panic!("{what}: the valid variant must pass: {error}"));
    assert!(try_build(manifest, invalid).is_err(), "{what}: the invalid variant must be rejected");
}

fn with_scene(yaml: &str) -> BTreeMap<String, SceneDefinition> {
    let mut scenes = scene_map();
    let scene = scene_from_yaml(yaml);
    scenes.insert(scene.id.clone(), scene);
    scenes
}

fn single_node_scene(role: &str, node: &str, extra_nodes: &str) -> String {
    format!(
        "schema_version: 2\nwindow_role: {role}\nid: ix_probe\nentry: n\nnodes:\n  n:\n{node}  t:\n    type: end\n{extra_nodes}"
    )
}

#[test]
fn open_window_must_go_from_a_main_scene_to_a_secondary_scene() {
    let open = |role: &str, scene: &str| {
        with_scene(&single_node_scene(
            role,
            &format!("    type: open_window\n    scene: {scene}\n    next: t\n"),
            "",
        ))
    };
    expect_valid_then_invalid(open("main", "ix_secondary"), open("main", "prologue"), "main -> main");
    expect_valid_then_invalid(open("main", "ix_secondary"), open("secondary", "ix_secondary"), "secondary opener");
}

#[test]
fn jumps_cannot_cross_window_roles() {
    let jump = |role: &str, scene: &str, target: &str| {
        with_scene(&single_node_scene(
            role,
            &format!("    type: jump\n    scene: {scene}\n    target: {target}\n"),
            "",
        ))
    };
    expect_valid_then_invalid(
        jump("main", "ix_choice", "ask"),
        jump("main", "ix_secondary", "hold"),
        "main -> secondary jump",
    );
    expect_valid_then_invalid(
        jump("secondary", "ix_secondary", "hold"),
        jump("secondary", "ix_choice", "ask"),
        "secondary -> main jump",
    );
}

#[test]
fn the_project_entry_scene_must_be_a_main_scene() {
    let mut manifest = fixture_catalog().manifest.clone();
    try_build(manifest.clone(), scene_map()).expect("baseline");
    manifest.entry_scene = "ix_secondary".to_owned();
    assert!(try_build(manifest, scene_map()).is_err());
}

#[test]
fn window_title_variables_are_reserved() {
    let base = fixture_catalog().manifest.clone();
    try_build(base.clone(), scene_map()).expect("baseline");
    for reserved in [MAIN_TITLE_VARIABLE, SECONDARY_TITLE_VARIABLE] {
        let mut manifest = base.clone();
        manifest.variables.insert(
            reserved.to_owned(),
            VariableDefinition {
                scope: VariableScope::Save,
                value_type: VariableType::String,
                default: ScalarValue::Text("x".to_owned()),
            },
        );
        assert!(try_build(manifest, scene_map()).is_err(), "{reserved} must not be declarable");
    }
}

#[test]
fn window_title_variables_are_read_only_for_set_nodes() {
    let set = |variable: &str| {
        with_scene(&single_node_scene(
            "main",
            &format!("    type: set\n    variable: {variable}\n    op: assign\n    value: x\n    next: t\n"),
            "",
        ))
    };
    expect_valid_then_invalid(set("route"), set(MAIN_TITLE_VARIABLE), "set main title");
    expect_valid_then_invalid(set("route"), set(SECONDARY_TITLE_VARIABLE), "set secondary title");
}

#[test]
fn window_title_text_is_validated_like_other_authored_text() {
    let title = |text: &str| {
        with_scene(&single_node_scene(
            "main",
            &format!("    type: window_title\n    target: main\n    title: {text}\n    next: t\n"),
            "",
        ))
    };
    let ok = title("\"当前[var=window.secondary.title]/[var=score]\"");
    expect_valid_then_invalid(ok.clone(), title("\"[var=no_such_variable]\""), "undeclared variable");
    expect_valid_then_invalid(ok.clone(), title("\"bell\\x07\""), "control character");
    expect_valid_then_invalid(ok, title(&format!("\"{}\"", "a".repeat(4097))), "oversized title");
}

#[test]
fn window_control_block_needs_an_id_but_advance_does_not() {
    let control = |action: &str, id: &str| {
        with_scene(&single_node_scene(
            "secondary",
            &format!("    type: window_control\n    target: main\n    action: {action}\n    id: \"{id}\"\n    next: t\n"),
            "",
        ))
    };
    expect_valid_then_invalid(control("block", "hold"), control("block", ""), "block id");
    control_must_build(control("advance", ""));
    control_must_build(control("unblock", "hold"));
}

fn control_must_build(scenes: BTreeMap<String, SceneDefinition>) {
    try_build(fixture_catalog().manifest.clone(), scenes).expect("window_control must validate");
}

fn timer_probe(fields: &str, target_node: Option<&str>) -> BTreeMap<String, SceneDefinition> {
    let target_line = if target_node.is_some() { "    target: tgt\n" } else { "" };
    let extra = target_node.map(|node| format!("  tgt:\n{node}")).unwrap_or_default();
    with_scene(&single_node_scene(
        "main",
        &format!("    type: timer\n    id: probe\n    action: start\n    delay_ms: 10\n{fields}{target_line}    next: t\n"),
        &extra,
    ))
}

const SET_EFFECT: &str = "    type: set\n    variable: score\n    op: add\n    value: 1\n    next: t\n";

#[test]
fn timers_may_only_target_non_blocking_effect_nodes_of_the_same_scene() {
    let valid = timer_probe("", Some(SET_EFFECT));
    try_build(fixture_catalog().manifest.clone(), valid.clone()).expect("a set effect is a valid target");
    for (what, node) in [
        ("sfx", "    type: sfx\n    asset: sfx.typing\n    next: t\n"),
        ("background without await", "    type: background\n    background: bg.nvctsp\n    next: t\n"),
        ("window title", "    type: window_title\n    target: main\n    title: x\n    next: t\n"),
    ] {
        try_build(fixture_catalog().manifest.clone(), timer_probe("", Some(node)))
            .unwrap_or_else(|error| panic!("{what} is an allowed effect: {error}"));
    }
    for (what, node) in [
        ("say", "    type: say\n    speaker: test\n    text: x\n    next: t\n"),
        ("wait", "    type: wait\n    duration_ms: 10\n    next: t\n"),
        ("end", "    type: end\n"),
        ("choice", "    type: choice\n    choices:\n    - id: a\n      label: a\n      next: t\n"),
        ("awaited background", "    type: background\n    background: bg.nvctsp\n    await: true\n    next: t\n"),
        ("another timer", "    type: timer\n    id: other\n    action: stop\n    next: t\n"),
    ] {
        assert!(
            try_build(fixture_catalog().manifest.clone(), timer_probe("", Some(node))).is_err(),
            "{what} must not be a timer target"
        );
    }
    // A start without a target, and a target that is not in the scene.
    assert!(try_build(fixture_catalog().manifest.clone(), timer_probe("", None)).is_err());
    let dangling = with_scene(&single_node_scene(
        "main",
        "    type: timer\n    id: probe\n    action: start\n    delay_ms: 10\n    target: nowhere\n    next: t\n",
        "",
    ));
    assert!(try_build(fixture_catalog().manifest.clone(), dangling).is_err());
}

#[test]
fn repeating_timers_have_a_minimum_interval_and_the_scene_a_maximum_count() {
    let manifest = fixture_catalog().manifest.clone();
    let at_minimum = timer_probe(&format!("    interval_ms: {MIN_TIMER_INTERVAL_MS}\n"), Some(SET_EFFECT));
    try_build(manifest.clone(), at_minimum).expect("the minimum interval is allowed");
    let too_fast = timer_probe(&format!("    interval_ms: {}\n", MIN_TIMER_INTERVAL_MS - 1), Some(SET_EFFECT));
    assert!(try_build(manifest.clone(), too_fast).is_err());

    // The count cap is a runtime guard: arm MAX_SCENE_TIMERS + 1 distinct timers.
    let mut nodes = String::new();
    for index in 0..=MAX_SCENE_TIMERS {
        let next = if index == MAX_SCENE_TIMERS { "ask".to_owned() } else { format!("arm_{}", index + 1) };
        nodes.push_str(&arm_timer(&format!("arm_{index}"), &format!("t{index:03}"), None, "bump", &next));
    }
    let mut scenes = scene_map();
    let flood = effect_scene("ix_flood", "arm_0", &nodes);
    scenes.insert(flood.id.clone(), flood);
    let content = try_build(manifest, scenes).expect("the validator does not count timers");
    let mut runtime = RuntimeEngine::new(&content).expect("engine");
    let error = runtime
        .start_scene_preview(&content, "ix_flood")
        .expect_err("the 65th concurrent timer must be refused at runtime");
    assert!(matches!(error, RuntimeError::Content(_)), "{error:?}");
}
