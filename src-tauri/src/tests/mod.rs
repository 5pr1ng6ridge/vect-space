//! Host-level tests.  Every test runs against in-memory content and a recording
//! native seam over a fake desktop; nothing needs a WebView.
//!
//! This module holds the shared fixtures; the submodules group the tests by
//! topic and reach the fixtures through `use super::*`.

mod commands;
mod proof;
mod interaction;
mod replay;
mod secondary;
mod window_effects;

use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use tempfile::{tempdir, TempDir};
use vectspace_core::{
    content::ContentCatalog,
    interaction::{WindowControlAction, WindowRole},
    model::{
        AdvanceSource, ChapterMapDefinition, ChapterMapHotspot, ChapterMapReplay, ChapterMapReveal,
        CueGate, DialogueMode, MutationValue, PresentationCue, PresentationCueKind,
        PresentationOutcome, PromptSnapshot, RuntimeSnapshot, RuntimeUpdate, ScalarValue,
        SceneDefinition, SceneNode, VariableMap, VariableOperation,
    },
    runtime::{self, RuntimeEngine},
};
use vectspace_protocol::{
    WireCommandError, WireCommandErrorCode, WireRuntimeUpdate, WireU64, WireUpdateNotice,
};

use crate::{
    native_plan::SecondaryPlan,
    native_window::{
        native_show_action, needs_session_refresh, pending_destroy_retry_due, NativeShowAction,
        NativeWindowOps,
    },
    pair::Committed,
    save::{ProfileManager, SaveManager},
    state::EngineState,
    transaction::MainTransition,
    window_fx::{Insets, MonitorInfo, Rect, WindowMetrics},
};

// ---------------------------------------------------------------------------
// Recording native seam
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Flag(AtomicBool);

impl Flag {
    fn set(&self, on: bool) {
        self.0.store(on, Ordering::Release);
    }

    fn get(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Default)]
struct Counter(AtomicU64);

impl Counter {
    fn bump(&self) {
        self.0.fetch_add(1, Ordering::AcqRel);
    }

    fn get(&self) -> u64 {
        self.0.load(Ordering::Acquire)
    }
}

/// A native geometry or layer call made on behalf of a window effect.
#[derive(Debug, Clone, PartialEq, Eq)]
enum NativeCall {
    Position(WindowRole, i32, i32),
    Size(WindowRole, i32, i32),
    AlwaysOnTop(WindowRole, bool),
    AlwaysOnBottom(WindowRole, bool),
    Focus(WindowRole),
}

/// One fake native window.  Its frame is 16x40 physical pixels thicker than its
/// client area, like a framed window.
#[derive(Debug, Clone, Copy)]
struct FakeWindow {
    position: (i32, i32),
    client: (i32, i32),
    border: (i32, i32),
    insets: Insets,
    scale: f64,
    fullscreen: bool,
    maximized: bool,
    minimized: bool,
}

impl FakeWindow {
    fn at(x: i32, y: i32, width: i32, height: i32) -> Self {
        Self {
            position: (x, y),
            client: (width, height),
            border: (16, 40),
            insets: Insets::default(),
            scale: 1.0,
            fullscreen: false,
            maximized: false,
            minimized: false,
        }
    }

    fn outer(&self) -> Rect {
        Rect::new(
            self.position.0,
            self.position.1,
            self.client.0 + self.border.0,
            self.client.1 + self.border.1,
        )
    }
}

/// A 1920x1040 work area with the main window at (100, 100), 1280x720 client.
#[derive(Debug, Clone)]
struct FakeDesktop {
    main: FakeWindow,
    secondary: FakeWindow,
    monitors: Vec<MonitorInfo>,
}

impl FakeDesktop {
    fn secondary_default() -> FakeWindow {
        FakeWindow::at(300, 200, 960, 540)
    }

    fn window(&mut self, role: WindowRole) -> &mut FakeWindow {
        match role {
            WindowRole::Main => &mut self.main,
            WindowRole::Secondary => &mut self.secondary,
        }
    }
}

impl Default for FakeDesktop {
    fn default() -> Self {
        Self {
            main: FakeWindow::at(100, 100, 1280, 720),
            secondary: Self::secondary_default(),
            monitors: vec![MonitorInfo {
                work_area: Rect::new(0, 0, 1920, 1040),
                scale: 1.0,
            }],
        }
    }
}

fn injected_failure(message: &str) -> WireCommandError {
    WireCommandError::new(WireCommandErrorCode::Internal, message)
}

/// An injectable native seam: the window-failure paths must be reachable in host
/// tests without a real WebView.
#[derive(Default)]
struct RecordingWindowOps {
    /// The window cannot be created at all.
    fail_show: Flag,
    /// The window *is* created and then the show fails, exactly like a
    /// `WebviewWindowBuilder` that builds the native window before the WebView
    /// fails: the failure leaves a window behind.
    fail_show_after_create: Flag,
    /// Destruction fails, so a window that exists survives.
    fail_hide: Flag,
    /// A destroy that the runtime has accepted but not processed yet.  The label
    /// stays registered, so a new owner must not adopt it.
    queued_destroy: Flag,
    /// Make `hide_secondary` model the real enqueue: the call succeeds and the
    /// label survives until the test releases it.
    defer_destroy: Flag,
    /// A queued destroy that the runtime never completes: a retried destroy
    /// fails natively, so the window survives and stops being pending.
    destroy_fails_asynchronously: Flag,
    /// Injected elapsed time since the pending destroy was enqueued, so the
    /// bounded retry is testable without any real timer or sleep.
    pending_destroy_elapsed_ms: AtomicU64,
    /// Whether a secondary window exists natively right now.  Deliberately
    /// independent of the host's logical slot, which is what makes the
    /// partial-create/cleanup-failure combination reproducible.
    window_alive: Flag,
    show_calls: Counter,
    replaced_calls: Counter,
    /// Shows that had to refresh a native window that already existed.
    refresh_calls: Counter,
    /// Shows that reused a surviving native window instead of creating one.
    reused_calls: Counter,
    create_calls: Counter,
    hide_calls: Counter,
    /// Recovery attempts for a live logical slot whose window is missing.
    recover_calls: Counter,
    /// Bounded re-attempts of a destroy the runtime never completed.
    destroy_retry_calls: Counter,
    /// Native titles applied, in order.
    titles: Mutex<Vec<(WindowRole, String)>>,
    fail_title: Flag,
    /// `runtime-updated` notifications as (window, latest sequence).
    notices: Mutex<Vec<(WindowRole, String)>>,
    /// Diagnostics that had no command to fail.
    diagnostics: Mutex<Vec<String>>,
    desktop: Mutex<FakeDesktop>,
    /// Every native geometry / layer call, in order.
    calls: Mutex<Vec<NativeCall>>,
    /// Reading or changing window geometry and layers fails.
    fail_window_effects: Flag,
}

impl RecordingWindowOps {
    /// A freshly created native secondary window starts with the default
    /// geometry and no layer flags.
    fn recreate_secondary_fake(&self) {
        self.desktop.lock().unwrap().secondary = FakeDesktop::secondary_default();
    }

    fn fake_window(&self, role: WindowRole) -> FakeWindow {
        *self.desktop.lock().unwrap().window(role)
    }

    /// Outer position and client size of a fake window.
    fn frame_of(&self, role: WindowRole) -> ((i32, i32), (i32, i32)) {
        let window = self.fake_window(role);
        (window.position, window.client)
    }

    fn edit_window(&self, role: WindowRole, edit: impl FnOnce(&mut FakeWindow)) {
        edit(self.desktop.lock().unwrap().window(role));
    }

    fn native_calls(&self) -> Vec<NativeCall> {
        self.calls.lock().unwrap().clone()
    }

    fn clear_native_calls(&self) {
        self.calls.lock().unwrap().clear();
    }

    fn diagnostics(&self) -> Vec<String> {
        self.diagnostics.lock().unwrap().clone()
    }

    /// A window effect can only reach a live native window.
    fn live_window(&self, role: WindowRole) -> Result<(), WireCommandError> {
        if self.fail_window_effects.get() {
            return Err(injected_failure("测试: 窗口原生调用失败"));
        }
        if role == WindowRole::Secondary && !self.window_alive.get() {
            return Err(injected_failure("测试: 窗口 secondary 不存在"));
        }
        Ok(())
    }

    fn record(&self, call: NativeCall) {
        self.calls.lock().unwrap().push(call);
    }

    /// The title a window was last given.
    fn last_title(&self, role: WindowRole) -> Option<String> {
        self.titles
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|(candidate, _)| *candidate == role)
            .map(|(_, title)| title.clone())
    }

    /// Let the runtime process a destroy that was only queued.
    fn finish_queued_destroy(&self) {
        self.queued_destroy.set(false);
        self.window_alive.set(false);
    }

    /// Advance the injected monotonic clock of a pending destroy.
    fn advance_pending_destroy(&self, elapsed: Duration) {
        self.pending_destroy_elapsed_ms
            .store(elapsed.as_millis() as u64, Ordering::Release);
    }

    /// Mirror of the production bounded retry: at most one re-attempt per call,
    /// and only after the grace period.  Returns whether the destroy is still
    /// pending afterwards.
    fn retry_pending_destroy_once(&self) -> bool {
        if !self.queued_destroy.get() {
            return false;
        }
        let elapsed =
            Duration::from_millis(self.pending_destroy_elapsed_ms.load(Ordering::Acquire));
        if !pending_destroy_retry_due(elapsed) {
            return true;
        }
        self.destroy_retry_calls.bump();
        self.advance_pending_destroy(Duration::ZERO);
        if self.destroy_fails_asynchronously.get() {
            // The retried destroy fails natively: the window survives and is no
            // longer queued, so a later show adopts and refreshes it.
            self.queued_destroy.set(false);
            return false;
        }
        true
    }
}

impl NativeWindowOps for RecordingWindowOps {
    fn set_title(&self, role: WindowRole, title: &str) -> Result<(), WireCommandError> {
        if self.fail_title.get() {
            return Err(injected_failure("测试: 无法设置窗口标题"));
        }
        self.titles.lock().unwrap().push((role, title.to_owned()));
        Ok(())
    }

    fn notify_updated(&self, role: WindowRole, notice: &WireUpdateNotice) {
        self.notices
            .lock()
            .unwrap()
            .push((role, notice.latest_seq.0.clone()));
    }

    fn report_diagnostic(&self, message: &str) {
        self.diagnostics.lock().unwrap().push(message.to_owned());
    }

    fn window_metrics(&self, role: WindowRole) -> Result<WindowMetrics, WireCommandError> {
        self.live_window(role)?;
        let mut desktop = self.desktop.lock().unwrap();
        let window = *desktop.window(role);
        let outer = window.outer();
        let center = (
            f64::from(outer.x) + f64::from(outer.w) / 2.0,
            f64::from(outer.y) + f64::from(outer.h) / 2.0,
        );
        let monitor = desktop
            .monitors
            .iter()
            .find(|monitor| {
                let area = monitor.work_area;
                center.0 >= f64::from(area.x)
                    && center.0 < f64::from(area.x + area.w)
                    && center.1 >= f64::from(area.y)
                    && center.1 < f64::from(area.y + area.h)
            })
            .or_else(|| desktop.monitors.first())
            .copied()
            .expect("a fake monitor exists");
        Ok(WindowMetrics {
            outer,
            client: window.client,
            insets: window.insets,
            scale: window.scale,
            monitor,
            fullscreen: window.fullscreen,
            maximized: window.maximized,
            minimized: window.minimized,
        })
    }

    fn monitors(&self) -> Result<Vec<MonitorInfo>, WireCommandError> {
        if self.fail_window_effects.get() {
            return Err(injected_failure("测试: 无法列出显示器"));
        }
        Ok(self.desktop.lock().unwrap().monitors.clone())
    }

    fn set_window_position(
        &self,
        role: WindowRole,
        x: i32,
        y: i32,
    ) -> Result<(), WireCommandError> {
        self.live_window(role)?;
        self.record(NativeCall::Position(role, x, y));
        self.edit_window(role, |window| window.position = (x, y));
        Ok(())
    }

    fn set_window_size(
        &self,
        role: WindowRole,
        width: i32,
        height: i32,
    ) -> Result<(), WireCommandError> {
        self.live_window(role)?;
        self.record(NativeCall::Size(role, width, height));
        self.edit_window(role, |window| window.client = (width, height));
        Ok(())
    }

    fn set_always_on_top(&self, role: WindowRole, on: bool) -> Result<(), WireCommandError> {
        self.live_window(role)?;
        self.record(NativeCall::AlwaysOnTop(role, on));
        Ok(())
    }

    fn set_always_on_bottom(&self, role: WindowRole, on: bool) -> Result<(), WireCommandError> {
        self.live_window(role)?;
        self.record(NativeCall::AlwaysOnBottom(role, on));
        Ok(())
    }

    fn focus_window(&self, role: WindowRole) -> Result<(), WireCommandError> {
        self.live_window(role)?;
        self.record(NativeCall::Focus(role));
        self.edit_window(role, |window| window.minimized = false);
        Ok(())
    }

    fn show_secondary(&self, replaced: bool) -> Result<(), WireCommandError> {
        self.show_calls.bump();
        if replaced {
            self.replaced_calls.bump();
        }
        if self.queued_destroy.get() {
            self.retry_pending_destroy_once();
        }
        if self.fail_show.get() {
            return Err(injected_failure("测试: 无法创建副窗口"));
        }
        if self.fail_show_after_create.get() {
            self.window_alive.set(true);
            return Err(injected_failure("测试: 副窗口创建失败（已残留原生窗口）"));
        }
        let reused = self.window_alive.get();
        // The same decision the production seam makes, so the injected failure
        // paths cannot drift away from the real one.
        match native_show_action(reused, self.queued_destroy.get()) {
            NativeShowAction::RefusePendingDestroy => {
                return Err(WireCommandError::new(
                    WireCommandErrorCode::Runtime,
                    "测试: 副窗口正在关闭，拒绝复用待销毁的窗口",
                ));
            }
            NativeShowAction::Create => {
                self.create_calls.bump();
                self.recreate_secondary_fake();
            }
            NativeShowAction::Reuse => self.reused_calls.bump(),
        }
        self.window_alive.set(true);
        // A window that already existed is refreshed even when the logical
        // `replaced` flag is false.
        if needs_session_refresh(replaced, reused) {
            self.refresh_calls.bump();
        }
        Ok(())
    }

    fn hide_secondary(&self) -> Result<(), WireCommandError> {
        self.hide_calls.bump();
        if self.fail_hide.get() {
            return Err(injected_failure("测试: 无法关闭副窗口"));
        }
        if self.defer_destroy.get() {
            // The destroy was accepted but not processed: the label is still
            // registered and must not be adopted by a new owner.
            self.queued_destroy.set(true);
            self.advance_pending_destroy(Duration::ZERO);
            return Ok(());
        }
        self.queued_destroy.set(false);
        self.window_alive.set(false);
        Ok(())
    }

    fn reconcile_secondary(&self, expected_live: bool) -> Result<bool, WireCommandError> {
        self.recover_calls.bump();
        let alive = self.window_alive.get();
        if alive && self.queued_destroy.get() {
            // Queued for destruction: never adopted, and at most one bounded
            // re-attempt per call.
            return Ok(self.retry_pending_destroy_once());
        }
        if alive == expected_live {
            return Ok(false);
        }
        if alive {
            return self.hide_secondary().map(|()| true);
        }
        self.create_calls.bump();
        self.recreate_secondary_fake();
        self.window_alive.set(true);
        Ok(true)
    }
}

// ---------------------------------------------------------------------------
// Host state and content builders
// ---------------------------------------------------------------------------

/// The shipped game with its two lab Scenes declared as secondary-window
/// Scenes, which is what the host fixtures open as secondary windows.
fn secondary_test_catalog() -> ContentCatalog {
    let mut content =
        ContentCatalog::from_root(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../game"))
            .unwrap();
    for id in ["ambience_lab", "surface_parity"] {
        content.scenes.get_mut(id).unwrap().window_role = WindowRole::Secondary;
    }
    content
}

/// A host state over `content` with a fresh recording seam.  The content is
/// read-only: no project file is ever written.
fn state_with(content: ContentCatalog) -> (TempDir, Arc<RecordingWindowOps>, EngineState) {
    let directory = tempdir().unwrap();
    let ops = Arc::new(RecordingWindowOps::default());
    let saves = SaveManager::new(
        directory.path().join("saves"),
        content.manifest.content_version.clone(),
    )
    .unwrap();
    let (profile, profile_state) = ProfileManager::new_with_content(
        directory.path().to_path_buf(),
        &content.manifest.variables,
        content.manifest.content_version.clone(),
        Some(content.scenes.keys().cloned().collect()),
        None,
    )
    .unwrap();
    let runtime = RuntimeEngine::with_profile(&content, profile_state).unwrap();
    let state = EngineState::new(content, runtime, ops.clone(), saves, profile);
    (directory, ops, state)
}

fn profile_file(directory: &TempDir) -> Vec<u8> {
    fs::read(directory.path().join("profile.json")).unwrap()
}

fn main_snapshot(state: &EngineState) -> RuntimeSnapshot {
    state.runtime().unwrap().snapshot().clone()
}

fn secondary_snapshot(state: &EngineState) -> RuntimeSnapshot {
    state
        .secondary()
        .unwrap()
        .as_ref()
        .expect("a live secondary")
        .runtime
        .snapshot()
        .clone()
}

fn secondary_token(state: &EngineState) -> u64 {
    state
        .secondary()
        .unwrap()
        .as_ref()
        .expect("a live secondary")
        .token
}

fn replay_revision(state: &EngineState) -> u64 {
    state
        .replay()
        .unwrap()
        .as_ref()
        .expect("a live replay")
        .runtime
        .snapshot()
        .revision
}

fn dialogue_text(prompt: &PromptSnapshot) -> String {
    match prompt {
        PromptSnapshot::Dialogue { text, .. } | PromptSnapshot::LongText { text, .. } => {
            text.clone()
        }
        other => panic!("expected a dialogue prompt, got {other:?}"),
    }
}

fn has_open_window_cue(update: &RuntimeUpdate) -> bool {
    update
        .cues
        .iter()
        .any(|cue| matches!(cue.kind, PresentationCueKind::OpenWindow { .. }))
}

fn say(text: &str, next: &str) -> SceneNode {
    SceneNode::Say {
        speaker: None,
        text: text.to_owned(),
        mode: DialogueMode::Start,
        page_id: None,
        speed_cps: None,
        reveal_animation: None,
        next: next.to_owned(),
    }
}

fn scene(
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

fn open_side(next: &str) -> SceneNode {
    SceneNode::OpenWindow {
        scene: "ambience_lab".to_owned(),
        next: next.to_owned(),
    }
}

fn set_score(op: VariableOperation, value: i64, next: &str) -> SceneNode {
    SceneNode::Set {
        variable: "score".to_owned(),
        op,
        value: Some(MutationValue::Literal(ScalarValue::Integer(value))),
        next: next.to_owned(),
    }
}

fn title(target: WindowRole, text: &str, next: &str) -> SceneNode {
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
fn content_with(
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

/// A chapter map with one always-replayable hotspot per Scene in `scenes`.
fn with_replays(mut content: ContentCatalog, scenes: &[&str]) -> ContentCatalog {
    content.chapter_map = Some(ChapterMapDefinition {
        schema_version: 1,
        width: 1920,
        height: 1080,
        view_x: 0,
        view_y: 0,
        background: None,
        decorations: Vec::new(),
        hotspots: scenes
            .iter()
            .map(|scene_id| ChapterMapHotspot {
                id: format!("hotspot_{scene_id}"),
                scene_id: (*scene_id).to_owned(),
                title: (*scene_id).to_owned(),
                hover_text: None,
                x: 0,
                y: 0,
                width: 10,
                height: 10,
                z: 0,
                asset: None,
                reveal: ChapterMapReveal::Always,
                replay: ChapterMapReplay::Always,
                variable_overrides: VariableMap::default(),
            })
            .collect(),
    });
    content
}

// ---------------------------------------------------------------------------
// Driving the host
// ---------------------------------------------------------------------------

/// What the `start_new_game` command does.
fn start_game(state: &EngineState) -> WireRuntimeUpdate {
    let _gate = state.session_gate().unwrap();
    state.set_title_screen(false);
    let committed = state
        .transact_runtime_forced(|runtime| runtime.start_new_game(&state.content), true)
        .unwrap();
    state.bump_session_id().unwrap();
    state.deliver(committed, WindowRole::Main).unwrap()
}

/// A manual page turn of the main window.
fn main_advance(state: &EngineState) -> Result<WireRuntimeUpdate, WireCommandError> {
    let revision = state.runtime().unwrap().snapshot().revision;
    let session = WireU64::from(state.current_session_id());
    state.transact_active_runtime(Some(&session), |runtime| {
        runtime.advance(&state.content, revision, AdvanceSource::Manual)
    })
}

/// A manual page turn of the secondary window, with its current token.
fn secondary_advance(state: &EngineState) -> Result<WireRuntimeUpdate, WireCommandError> {
    let _gate = state.session_gate().unwrap();
    let token = secondary_token(state);
    let (committed, _) = state.transact_secondary(Some(&WireU64::from(token)), |runtime| {
        let revision = runtime.snapshot().revision;
        runtime.advance(&state.content, revision, AdvanceSource::Manual)
    })?;
    state.deliver(committed, WindowRole::Secondary)
}

/// A manual page turn of the live replay.
fn replay_advance(state: &EngineState) -> Result<Committed, WireCommandError> {
    let revision = replay_revision(state);
    state
        .transact_replay(|runtime| runtime.advance(&state.content, revision, AdvanceSource::Manual))
}

/// `enter_replay` as the `start_scene_replay` command calls it.
fn enter_replay(state: &EngineState, scene_id: &str) -> Result<Committed, WireCommandError> {
    let _gate = state.session_gate().unwrap();
    state.enter_replay(scene_id)
}

/// `exit_replay` as the `exit_scene_replay` command calls it.
fn exit_replay(state: &EngineState) -> Result<(), WireCommandError> {
    let _gate = state.session_gate().unwrap();
    state.exit_replay()
}

/// Drive a main-story transition whose update carries one `open_window` control
/// cue, which is what the real content would emit.  The cue is appended by hand
/// so this fixture never depends on authored content.
fn open_window_operation<'a>(
    state: &'a EngineState,
    scene_id: &'a str,
) -> impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError> + 'a {
    let scene = scene_id.to_owned();
    move |runtime| {
        let mut update = runtime.bootstrap(&state.content).update;
        update.cues.push(PresentationCue {
            cue_id: 0,
            gate: CueGate::None,
            kind: PresentationCueKind::OpenWindow {
                scene: scene.clone(),
            },
        });
        Ok(update)
    }
}

/// The in-memory half of an `open_window` transition.
fn open_secondary_transition(
    state: &EngineState,
    scene_id: &str,
) -> Result<MainTransition, WireCommandError> {
    state.commit_main_runtime(open_window_operation(state, scene_id))
}

/// The same transition including its native window step, i.e. the exact path a
/// real `open_window` takes.
fn show_test_secondary(state: &EngineState, scene_id: &str) -> Result<Committed, WireCommandError> {
    state.transact_runtime(open_window_operation(state, scene_id))
}

/// Put one live secondary session in the slot and return its token.
fn stage_test_secondary(state: &EngineState, scene_id: &str) -> u64 {
    open_secondary_transition(state, scene_id).unwrap();
    secondary_token(state)
}
