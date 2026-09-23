mod save;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};

use save::{LoadedSlot, ProfileManager, SaveError, SaveManager, SecondaryState, SlotDocument};
use tauri::{path::BaseDirectory, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use vectspace_core::{
    content::ContentCatalog,
    model::{
        AdvanceSource, ChapterMapSnapshot, CueGate, DialogueHistoryEntry, PresentationCueKind,
        PresentationOutcome, ProfileState, ResolvedAsset, RuntimeUpdate, SaveSlotRequest,
        SaveSlotSummary, SceneNode, Settings, VariableMap,
    },
    runtime::{self, RuntimeEngine},
};
use vectspace_protocol::{
    WireBootstrapPayload, WireCommandError, WireCommandErrorCode, WireDialogueHistoryEntry,
    WireRuntimeSnapshot, WireRuntimeUpdate, WireSessionMode, WireU64,
};

struct EngineState {
    content: ContentCatalog,
    runtime: Mutex<RuntimeEngine>,
    replay: Mutex<Option<ReplaySession>>,
    /// The single secondary game window's runtime.  `None` means no secondary is
    /// open.  The slot is only created, re-pointed or destroyed from a gated
    /// transition — a main-story one or a replay one — never from a frontend
    /// request.
    secondary: Mutex<Option<SecondarySession>>,
    /// Serializes the check-and-act boundary when switching between the main
    /// story runtime and an isolated replay.  Without this lock, an advance
    /// could observe “no replay”, yield, and then mutate the main runtime just
    /// after another command had entered replay mode.
    session_gate: Mutex<()>,
    /// Monotonic namespace for isolated sessions.  Main-story IDs stay in
    /// their normal small range while every replay receives a disjoint high
    /// range, so delayed cue acknowledgements cannot be applied to another
    /// session after the user returns to the map.
    replay_generation: AtomicU64,
    /// Monotonic host-session generation.  It changes whenever the active
    /// story/replay runtime changes so delayed IPC responses can never be
    /// applied to a newer session.
    session_id: AtomicU64,
    /// Monotonic secondary generation.  It supplies both the wire token handed
    /// to the secondary WebView and its isolated revision/update/cue namespace,
    /// so a delayed acknowledgement from a replaced secondary instance fails
    /// with `stale_session` instead of mutating the new one.
    secondary_generation: AtomicU64,
    /// The host's native window operations.  Keeping them behind a seam makes
    /// the failure paths (a window that cannot be created or destroyed)
    /// reachable from host tests without a real WebView.
    windows: Arc<dyn NativeWindowOps>,
    saves: SaveManager,
    profile: ProfileManager,
}

/// Who currently owns the single secondary window.  The owner answers two
/// questions the host must never conflate:
///
/// * **lifecycle** — a story-owned window belongs to one main-story Scene and is
///   closed when that Scene is left (or on a new game/load/title/shutdown); a
///   replay-owned window belongs to one live replay and is closed when that
///   replay leaves its own Scene, ends, fails or is exited.
/// * **publishing** — a story-owned session publishes its shared maps and its
///   dialogue occurrences to the main runtime and the profile file; a
///   replay-owned session publishes them to the *replay* runtime only, so a
///   save, a profile file or the official ledger can never observe replayed
///   play.
///
/// The replay arm carries the replay generation so a delayed command from an
/// ended replay can never mutate the slot of a newer owner.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SecondaryOwner {
    /// The main story owns the window.
    Story { scene_id: String },
    /// One live replay owns the window, identified by its generation.
    Replay { generation: u64 },
}

impl SecondaryOwner {
    /// The main-story Scene that owns the window, if the main story owns it.
    fn story_scene(&self) -> Option<&str> {
        match self {
            SecondaryOwner::Story { scene_id } => Some(scene_id),
            SecondaryOwner::Replay { .. } => None,
        }
    }
}

/// The secondary window is deliberately a single, bounded slot: exactly one
/// secondary may exist, and repeating `open_window` re-points this runtime in
/// the same native window with a fresh token.
#[derive(Debug, Clone)]
struct SecondarySession {
    runtime: RuntimeEngine,
    /// Scene currently shown by the secondary runtime.
    scene_id: String,
    /// Story or replay that owns the window; see [`SecondaryOwner`].
    owner: SecondaryOwner,
    /// Wire token identifying this secondary instance.
    token: u64,
    /// A runtime-gated presentation produced while this session was being
    /// staged.  The frontend has not seen it yet, so the first bootstrap
    /// delivers this exact update (same update id) instead of a cue-less one:
    /// the runtime is otherwise waiting for an acknowledgement nothing would
    /// ever send, which would block the secondary's gameplay forever.
    initial_update: Option<RuntimeUpdate>,
}

/// Native window work for the secondary window.  The host never performs it
/// while a runtime mutex is held (window creation/destruction can re-enter the
/// window event handler), and it is fallible: a transition that cannot make the
/// native window match the new state is rolled back instead of being reported
/// as a success with a missing or orphaned window.
trait NativeWindowOps: Send + Sync {
    /// Make the native secondary window exist and tell its frontend to
    /// re-bootstrap under the host's current session token.  `replaced` is the
    /// host's *logical* view (the slot already carried a session); a native
    /// window that survived anyway — a partially created window whose cleanup
    /// failed, or a window reused by a retry — must be refreshed even when that
    /// flag is false, because it may still be running an older session.
    fn show_secondary(&self, replaced: bool) -> Result<(), WireCommandError>;
    fn hide_secondary(&self) -> Result<(), WireCommandError>;
    /// Reconcile the native window with the host's **logical slot** without
    /// waiting for the event loop, and report whether the native state changed.
    ///
    /// Creation and destruction only enqueue a message when they run off the
    /// event-loop thread (see [`TauriWindowOps`]), so native state and the slot
    /// can drift apart in a way the host cannot observe from the call itself.
    /// This is the host's recovery path for that asymmetry: a live slot whose
    /// window is missing is rebuilt, and a window whose slot is gone is removed
    /// again.  It never blocks on the event loop, and a label that is queued for
    /// destruction is never adopted.
    fn reconcile_secondary(&self, expected_live: bool) -> Result<bool, WireCommandError> {
        let _ = expected_live;
        Ok(false)
    }
    /// True while the host itself is destroying the secondary, so the close
    /// guard can tell a host-initiated destruction from a user/native close
    /// request, which is always prevented.
    fn is_closing_secondary(&self) -> bool {
        false
    }
}

/// Production implementation over the real Tauri window APIs.
///
/// Every native call is made from an `async` command, i.e. off the IPC /
/// event-loop callback thread.  On Windows a WebView2 creation pumps Windows
/// messages and deadlocks the host when it runs inside a synchronous command
/// (Tauri documents this on `WebviewWindowBuilder::build`).  Off the event-loop
/// thread the very same call is *enqueue-only*: the runtime posts a
/// `Message::CreateWindow`/destroy message and returns a handle immediately, so
/// a native failure is logged by the runtime and cannot be reported here.
/// [`NativeWindowOps::reconcile_secondary`] plus [`Self::closing_secondary`]
/// are the host's answer to that asymmetry: the label stays registered between
/// an enqueued `destroy` and the runtime processing it, and a label in that
/// state is never handed to a new owner.
struct TauriWindowOps {
    app: tauri::AppHandle,
    /// True from the moment a host destroy has been enqueued until the runtime
    /// has really processed it (observed as the label disappearing) or the
    /// destroy call itself failed.
    closing_secondary: AtomicBool,
    /// Monotonic stamp of the destroy enqueue that set `closing_secondary`, or
    /// `None` while none is pending.  Read only by
    /// [`TauriWindowOps::retry_pending_destroy_once`].  A stale stamp is
    /// harmless: it is only ever read while `closing_secondary` is set, and every
    /// new enqueue restamps it.
    pending_destroy_since: Mutex<Option<Instant>>,
    /// The monotonic clock.  Injected so the pending-destroy grace period is
    /// testable without any real timer or sleep.
    clock: fn() -> Instant,
}

impl NativeWindowOps for TauriWindowOps {
    fn show_secondary(&self, replaced: bool) -> Result<(), WireCommandError> {
        // A label that is queued for destruction is never adopted, but a destroy
        // the runtime never completed must not block every future window either:
        // a later transition gets exactly one bounded re-attempt.
        if self.closing_secondary.load(Ordering::Acquire) {
            self.retry_pending_destroy_once();
        }
        // `ensure_secondary_window` reuses any window the label already owns, so
        // the logical `replaced` flag is not enough to decide whether the
        // frontend needs refreshing: a window left behind by a failed cleanup
        // (or a retry after one) is already alive and still holds its old
        // session token.
        let reused = self
            .app
            .get_webview_window(SECONDARY_WINDOW_LABEL)
            .is_some();
        let window = ensure_secondary_window(&self.app, &self.closing_secondary)?;
        if needs_session_refresh(replaced, reused) {
            // Tell the frontend to cancel the old presentation and re-bootstrap
            // under the new token.  A notification that is missed anyway is
            // recovered by the frontend's own stale-session handling, so this
            // cannot strand it.
            window.emit(SECONDARY_REPLACED_EVENT, ()).map_err(|error| {
                WireCommandError::new(
                    WireCommandErrorCode::Internal,
                    format!("无法通知副窗口会话已替换: {error}"),
                )
            })?;
        }
        Ok(())
    }

    fn hide_secondary(&self) -> Result<(), WireCommandError> {
        let result = destroy_secondary_window(&self.app, &self.closing_secondary);
        // Stamp the pending destroy so the bounded retry knows when the label was
        // handed to the runtime; a failed destroy is not pending at all.
        let stamp = (result.is_ok() && self.closing_secondary.load(Ordering::Acquire))
            .then(|| (self.clock)());
        if let Ok(mut since) = self.pending_destroy_since.lock() {
            *since = stamp;
        }
        result
    }

    fn is_closing_secondary(&self) -> bool {
        // Also true while a host destroy is still queued: the window is on its
        // way out, so a user close request does not have to be prevented.
        self.closing_secondary.load(Ordering::Acquire)
    }

    fn reconcile_secondary(&self, expected_live: bool) -> Result<bool, WireCommandError> {
        let present = self
            .app
            .get_webview_window(SECONDARY_WINDOW_LABEL)
            .is_some();
        if present {
            if self.closing_secondary.load(Ordering::Acquire) {
                // Queued for destruction: never adopt it, and make at most one
                // bounded re-attempt so a destroy the runtime never completed
                // cannot leave every future open refused.
                return Ok(self.retry_pending_destroy_once());
            }
            if expected_live {
                // The window exists and belongs to the live slot; a healthy
                // secondary must keep playing, so only a *missing* window is
                // re-created by this path.
                return Ok(false);
            }
            // The slot is gone while the window is not, so the window is an
            // orphan of a failed cleanup.  A label that is queued for
            // destruction is left alone: the runtime is already removing it.
            // `hide_secondary` also stamps the pending destroy for the bounded
            // retry, exactly like every other accepted destroy.
            self.hide_secondary()?;
            return Ok(true);
        }
        // The label is free again, so any queued destroy has been processed and
        // a missing window can be rebuilt without duplicating a label.
        self.closing_secondary.store(false, Ordering::Release);
        if !expected_live {
            return Ok(false);
        }
        ensure_secondary_window(&self.app, &self.closing_secondary)?;
        Ok(true)
    }
}

impl TauriWindowOps {
    /// The bounded, non-blocking liveness net for a destroy the runtime accepted
    /// but never completed: at most one re-attempt per later transition, and only
    /// after [`SECONDARY_PENDING_DESTROY_GRACE`].  It never waits, loops, spawns a
    /// thread or talks to the event loop, and it never fails the caller — a
    /// destroy that fails here leaves a window that the next show adopts with a
    /// refresh.  Returns whether a destroy is still pending.
    ///
    /// This is **not** native-liveness recovery: a creation that fails *after*
    /// the runtime registered the label stays indistinguishable from success (see
    /// [`NativeWindowOps::reconcile_secondary`]).
    fn retry_pending_destroy_once(&self) -> bool {
        let now = (self.clock)();
        let due = self
            .pending_destroy_since
            .lock()
            .ok()
            .and_then(|since| *since)
            .is_some_and(|since| pending_destroy_retry_due(now.saturating_duration_since(since)));
        if !due {
            return self.closing_secondary.load(Ordering::Acquire);
        }
        // Restamp before the attempt, so this is the only attempt for this grace
        // window even when the destroy is accepted again.
        if let Ok(mut since) = self.pending_destroy_since.lock() {
            *since = Some(now);
        }
        if let Err(error) = destroy_secondary_window(&self.app, &self.closing_secondary) {
            // The window survives and is no longer queued, so a later show can
            // adopt and refresh it again.
            eprintln!("副窗口待关闭状态重试失败: {}", error.message);
        }
        self.closing_secondary.load(Ordering::Acquire)
    }
}

const SECONDARY_WINDOW_LABEL: &str = "secondary";
const MAIN_WINDOW_LABEL: &str = "main";
const REPLAY_ID_STRIDE: u64 = 1 << 32;
/// Kept disjoint from [`REPLAY_ID_STRIDE`] so an isolated secondary session can
/// never share a revision/update namespace with a replay session.
const SECONDARY_ID_STRIDE: u64 = 1 << 40;
const SECONDARY_REPLACED_EVENT: &str = "vectspace://secondary-session";

/// Which window a command was invoked from.  This is derived from the WebView
/// label the host itself assigned, never from a JS-supplied value, so a crafted
/// payload cannot impersonate the main window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowRole {
    Main,
    Secondary,
}

fn window_role(window: &tauri::WebviewWindow) -> Option<WindowRole> {
    role_for_label(window.label())
}

fn role_for_label(label: &str) -> Option<WindowRole> {
    match label {
        MAIN_WINDOW_LABEL => Some(WindowRole::Main),
        SECONDARY_WINDOW_LABEL => Some(WindowRole::Secondary),
        _ => None,
    }
}

/// Every main-only command denies all non-main labels, including an unknown
/// label, so a future window can never inherit main authority by accident.
fn require_main(window: &tauri::WebviewWindow) -> Result<(), WireCommandError> {
    if window_role(window) == Some(WindowRole::Main) {
        return Ok(());
    }
    Err(WireCommandError::new(
        WireCommandErrorCode::Validation,
        "该操作只能由主窗口执行",
    ))
}

/// Secondary gameplay commands require the exact secondary label.
fn require_secondary(window: &tauri::WebviewWindow) -> Result<(), WireCommandError> {
    if window_role(window) == Some(WindowRole::Secondary) {
        return Ok(());
    }
    Err(WireCommandError::new(
        WireCommandErrorCode::Validation,
        "该操作只能由副窗口执行",
    ))
}

/// Shared, read-only commands accept either known window but never an unknown
/// label.
fn require_known_window(window: &tauri::WebviewWindow) -> Result<(), WireCommandError> {
    if window_role(window).is_some() {
        return Ok(());
    }
    Err(WireCommandError::new(
        WireCommandErrorCode::Validation,
        "未知窗口来源，已拒绝该请求",
    ))
}

/// Native work the host must perform *after* all runtime locks are released.
/// WebView creation/destruction can re-enter the window-event handler, so it is
/// staged here and executed with only the session gate held.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SecondaryPlan {
    None,
    /// Create the window if needed, then tell its frontend to re-bootstrap
    /// under the new token.
    Show { replaced: bool },
    /// Destroy the window and clear the slot.
    Hide,
}

/// The secondary-window work a main transition implies, built off to the side.
/// Staging never touches the live slot: the session only exists in this
/// candidate until the profile write and the native window step have both
/// succeeded.
struct StagedSecondary {
    /// The session that should replace the live slot, if any.
    session: Option<SecondarySession>,
    plan: SecondaryPlan,
    /// Shared-map effects produced while the staged session evaluated its
    /// opening Scene.  They are published to the main candidate in the same
    /// transaction, so a secondary startup can never mutate a copy of the
    /// shared state that the main runtime then overwrites.
    save_variables: Option<VariableMap>,
    profile_variables: Option<VariableMap>,
    /// Occurrences produced by the staged session's opening evaluation, in
    /// order, which join the merged ledger as part of the same transaction.
    appended_history: Vec<DialogueHistoryEntry>,
}

impl StagedSecondary {
    fn none(plan: SecondaryPlan) -> Self {
        Self {
            session: None,
            plan,
            save_variables: None,
            profile_variables: None,
            appended_history: Vec::new(),
        }
    }
}

/// A committed main-story transaction.  The native window step happens after
/// the in-memory commit because window creation/destruction can re-enter the
/// platform event loop; `previous_*` keeps the rollback data for the one case
/// where that step fails, so the host can never report success while the native
/// window and the runtime disagree.
#[derive(Debug)]
struct MainTransition {
    update: RuntimeUpdate,
    plan: SecondaryPlan,
    previous_runtime: RuntimeEngine,
    previous_secondary: SecondaryBaseline,
    previous_profile: ProfileState,
    /// Whether the commit itself wrote the profile, which is what decides
    /// whether a rollback has to restore it.
    profile_written: bool,
}

/// A committed replay transaction.  The replay runtime, the secondary slot and
/// the native window plan move together: the native step happens after the
/// in-memory commit (window work can re-enter the platform event loop), and
/// `previous_*` keeps the rollback data for the one case where that step fails,
/// so a replay can never be reported as running with a missing or foreign
/// window.
#[derive(Debug)]
struct ReplayTransition {
    update: RuntimeUpdate,
    plan: SecondaryPlan,
    previous_replay: Option<ReplaySession>,
    previous_secondary: SecondaryBaseline,
}

/// How the secondary slot looked before a transition, kept for rollback.
#[derive(Debug)]
enum SecondaryBaseline {
    /// The transition did not touch the slot at all, so a rollback must leave
    /// the live session exactly where it is.
    Untouched,
    /// The transition replaced or cleared the slot; the previous contents are
    /// restored on rollback.
    Restore(Box<Option<SecondarySession>>),
}

impl SecondaryBaseline {
    /// The previous session a rollback has to restore, if the transition touched
    /// the slot at all.
    fn restored_session(&self) -> Option<&Option<SecondarySession>> {
        match self {
            SecondaryBaseline::Restore(previous) => Some(previous),
            SecondaryBaseline::Untouched => None,
        }
    }

    /// Whether there was no live secondary before the transition, which is what
    /// decides whether a failed show needs a native cleanup.
    fn restored_without_secondary(&self) -> bool {
        matches!(self.restored_session(), Some(previous) if previous.is_none())
    }
}

/// A replay is deliberately kept separate from the player's runtime.  It
/// borrows a cloned profile/default state at start and is never persisted.
/// `ending` prevents a cross-scene jump from evaluating its destination;
/// `generation` identifies this replay for as long as it lives, so a
/// secondary slot and a delayed secondary command can always be attributed to
/// the exact replay that owns them.
#[derive(Debug, Clone)]
struct ReplaySession {
    runtime: RuntimeEngine,
    scene_id: String,
    ending: bool,
    generation: u64,
}

impl EngineState {
    fn runtime(&self) -> Result<MutexGuard<'_, RuntimeEngine>, WireCommandError> {
        self.runtime.lock().map_err(|_| {
            WireCommandError::new(WireCommandErrorCode::Internal, "运行时互斥锁已损坏")
        })
    }

    fn secondary(&self) -> Result<MutexGuard<'_, Option<SecondarySession>>, WireCommandError> {
        self.secondary.lock().map_err(|_| {
            WireCommandError::new(WireCommandErrorCode::Internal, "副窗口互斥锁已损坏")
        })
    }

    fn replay(&self) -> Result<MutexGuard<'_, Option<ReplaySession>>, WireCommandError> {
        self.replay.lock().map_err(|_| {
            WireCommandError::new(WireCommandErrorCode::Internal, "重演运行时互斥锁已损坏")
        })
    }

    fn session_gate(&self) -> Result<MutexGuard<'_, ()>, WireCommandError> {
        self.session_gate
            .lock()
            .map_err(|_| WireCommandError::new(WireCommandErrorCode::Internal, "会话互斥锁已损坏"))
    }

    /// Replace the main runtime with `candidate`, persisting the derived profile
    /// state first.  The profile write is the only fallible step, so it always
    /// happens before the in-memory commit: a failed write leaves memory and
    /// disk agreeing.  Returns whether the profile actually changed.
    fn commit_runtime(
        &self,
        committed: &RuntimeEngine,
        candidate: &RuntimeEngine,
    ) -> Result<bool, WireCommandError> {
        let candidate_profile = candidate.profile_state(&self.content);
        if candidate_profile == committed.profile_state(&self.content) {
            return Ok(false);
        }
        self.profile.save(&candidate_profile).map_err(save_error)?;
        Ok(true)
    }

    /// Run one main-story command against a clone, then perform its staged
    /// native window step.
    ///
    /// Lock order: `session_gate` (held by the caller) -> `runtime`/`secondary`
    /// -> released -> native window calls.  Native calls are never made while a
    /// runtime mutex is held because window creation/destruction can re-enter
    /// the window event handler; the session gate is still held, so no other
    /// command can observe the gap.  A failed native step rolls the whole
    /// transaction back instead of reporting success with a missing or orphaned
    /// window.
    fn transact_runtime(
        &self,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<RuntimeUpdate, WireCommandError> {
        self.finish_transition(self.commit_main_runtime(operation)?)
    }

    /// [`Self::transact_runtime`] with an explicit host decision to tear the
    /// secondary window down even when the command itself does not leave the
    /// Scene that owns it (new game, load, title, replay).
    fn transact_runtime_forced(
        &self,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
        force_hide: bool,
    ) -> Result<RuntimeUpdate, WireCommandError> {
        self.finish_transition(self.commit_main_runtime_forced(operation, force_hide)?)
    }

    /// The pure, testable half of a main-story transaction: clone, mutate, stage
    /// the secondary transition, publish the staged session's startup effects to
    /// the candidate, persist the profile and commit both runtimes in memory.
    /// No native API is touched, so host tests can exercise it without a window.
    fn commit_main_runtime(
        &self,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<MainTransition, WireCommandError> {
        self.commit_main_runtime_forced(operation, false)
    }

    fn commit_main_runtime_forced(
        &self,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
        force_hide: bool,
    ) -> Result<MainTransition, WireCommandError> {
        let mut runtime = self.runtime()?;
        let mut candidate = runtime.clone();
        let mut update = operation(&mut candidate).map_err(WireCommandError::from)?;
        let previous_scene = runtime.snapshot().location.scene_id.clone();
        let opened = take_open_window_request(&mut update);
        let scene_changed = candidate.snapshot().location.scene_id != previous_scene;
        // Staging happens before the profile write and the in-memory commit so a
        // failure here — or a rejected Scene id — leaves the previous valid
        // session completely untouched.
        let staged = self.stage_main_transition(&candidate, opened, scene_changed, force_hide)?;
        if let Some(variables) = &staged.save_variables {
            candidate.set_save_variables(variables.clone());
        }
        if let Some(variables) = &staged.profile_variables {
            candidate.set_profile_variables(variables.clone());
        }
        if !staged.appended_history.is_empty() {
            // The Scene the secondary window opens on may already produce its
            // own opening line. That line is a real occurrence the player sees
            // in the secondary window, so it joins the merged ledger with the
            // very command that opened the window (after this command's own
            // main-story occurrences).
            candidate.extend_dialogue_history(staged.appended_history.clone());
        }
        let previous_profile = runtime.profile_state(&self.content);
        let profile_written = self.commit_runtime(&runtime, &candidate)?;
        let previous_runtime = std::mem::replace(&mut *runtime, candidate);
        drop(runtime);
        // Only the plans that actually change the secondary touch its slot: a
        // command that neither opens a window nor leaves its owning Scene must
        // not disturb the live session.
        let mut slot = self.secondary()?;
        let previous_secondary = match staged.plan {
            SecondaryPlan::None => SecondaryBaseline::Untouched,
            SecondaryPlan::Show { .. } => {
                SecondaryBaseline::Restore(Box::new(std::mem::replace(
                    &mut *slot,
                    staged.session,
                )))
            }
            SecondaryPlan::Hide => SecondaryBaseline::Restore(Box::new(slot.take())),
        };
        drop(slot);
        Ok(MainTransition {
            update,
            plan: staged.plan,
            previous_runtime,
            previous_secondary,
            previous_profile,
            profile_written,
        })
    }

    /// Perform the staged native work for a committed transition, rolling the
    /// whole transition back if the native window cannot be made to match the
    /// new state.
    fn finish_transition(
        &self,
        transition: MainTransition,
    ) -> Result<RuntimeUpdate, WireCommandError> {
        if let Err(error) = self.apply_secondary_plan(transition.plan.clone()) {
            // Every rollback action is attempted, and every failure is reported:
            // a cleanup failure must never hide the fact that memory and the
            // profile were restored, and the caller must never be told only half
            // of what went wrong.
            let cleanup_failures = self.rollback_main_transition(&transition);
            return Err(aggregate_transition_failure(error, cleanup_failures));
        }
        // The native step only enqueued its work (see [`TauriWindowOps`]), so
        // this is where a missing window or an orphaned one is corrected.
        debug_assert_no_window_cue(&transition.update);
        self.reconcile_secondary_window(&transition.plan);
        Ok(transition.update)
    }

    /// Perform the staged native work.  Called with every runtime mutex released:
    /// window creation/destruction can re-enter the window event handler, and
    /// holding either runtime across it would risk a deadlock or let another
    /// command observe half-committed state.
    fn apply_secondary_plan(&self, plan: SecondaryPlan) -> Result<(), WireCommandError> {
        match plan {
            SecondaryPlan::None => Ok(()),
            SecondaryPlan::Show { replaced } => self.windows.show_secondary(replaced),
            SecondaryPlan::Hide => self.windows.hide_secondary(),
        }
    }

    /// Undo a committed transition whose native window step failed, so the host
    /// never keeps a runtime that disagrees with the window that actually
    /// exists.  Returns every cleanup failure instead of stopping at the first
    /// one: restoring the in-memory state and the profile must not be skipped
    /// because a native rollback action failed (and vice versa), so the caller
    /// can report the whole picture from [`aggregate_transition_failure`].
    fn rollback_main_transition(&self, transition: &MainTransition) -> Vec<WireCommandError> {
        let mut failures = Vec::new();
        if let Some(previous) = transition.previous_secondary.restored_session() {
            match self.secondary() {
                Ok(mut slot) => *slot = previous.clone(),
                Err(error) => failures.push(error),
            }
        }
        match self.runtime() {
            Ok(mut runtime) => *runtime = transition.previous_runtime.clone(),
            Err(error) => failures.push(error),
        }
        if transition.profile_written {
            if let Err(error) = self.profile.save(&transition.previous_profile) {
                failures.push(save_error(error));
            }
        }
        // A failed creation may have produced a window that never received a
        // session.  Make the native state match the restored memory again
        // instead of leaving an orphaned window behind; if that cleanup fails
        // too, the surviving window is reported rather than swallowed, and the
        // retry path refreshes it because it is a reused native window.
        let restored_without_secondary = transition.previous_secondary.restored_without_secondary();
        if restored_without_secondary && matches!(transition.plan, SecondaryPlan::Show { .. }) {
            if let Err(error) = self.windows.hide_secondary() {
                failures.push(WireCommandError::new(
                    WireCommandErrorCode::Internal,
                    format!("副窗口回滚清理失败，可能残留未受管理的原生窗口: {}", error.message),
                ));
            }
        }
        failures
    }

    /// Compute the secondary-window work a committed main transition implies and
    /// build the session it needs, without touching the live slot.  `candidate`
    /// is the main runtime that is about to be committed, so the secondary is
    /// seeded from the state the main story is entering — never from the state it
    /// is leaving behind.  Staging happens *before* the profile write and the
    /// in-memory commit so a failure here leaves the previous valid session
    /// completely untouched.
    fn stage_main_transition(
        &self,
        candidate: &RuntimeEngine,
        opened: Option<String>,
        scene_changed: bool,
        force_hide: bool,
    ) -> Result<StagedSecondary, WireCommandError> {
        let live = self.secondary()?.is_some();
        // A window request in this same update takes precedence over tearing the
        // previous owner down: the Scene the update lands in owns the window it
        // asks for, exactly like a repeated `open_window` inside one Scene.  This
        // is what makes an entry path work — the new game's first update, or an
        // update that opens a window and leaves the Scene in the same immediate
        // chain — instead of silently dropping the request.
        //
        // Only when the update carries no request does leaving the owning Scene
        // tear the secondary down, exactly like a new game, a load or a return to
        // the title.
        let Some(scene_id) = opened else {
            return Ok(StagedSecondary::none(if (force_hide || scene_changed) && live {
                SecondaryPlan::Hide
            } else {
                SecondaryPlan::None
            }));
        };
        if !self.content.scenes.contains_key(&scene_id) {
            return Err(WireCommandError::new(
                WireCommandErrorCode::Validation,
                format!("open_window 指向未声明的场景 {scene_id}"),
            ));
        }
        let owning_scene = candidate.snapshot().location.scene_id.clone();
        let token = self.bump_secondary_generation()?;
        let id_base = token
            .checked_mul(SECONDARY_ID_STRIDE)
            .ok_or_else(|| WireCommandError::new(WireCommandErrorCode::Internal, "副窗口编号耗尽"))?;
        let mut session = self.build_secondary_session(
            candidate,
            &scene_id,
            SecondaryOwner::Story {
                scene_id: owning_scene,
            },
            token,
            id_base,
        )?;
        // The staged session keeps its own copy of the shared maps; the effects
        // of its opening evaluation are handed back so the caller can publish
        // them to the main candidate in the same transaction.
        let save_variables = session.runtime.snapshot().variables.clone();
        let profile_variables = session.runtime.profile_variables_map().clone();
        let appended_history = session.runtime.take_appended_history();
        Ok(StagedSecondary {
            session: Some(session),
            plan: SecondaryPlan::Show { replaced: live },
            save_variables: Some(save_variables),
            profile_variables: Some(profile_variables),
            appended_history,
        })
    }

    /// A fresh runtime pre-seeded with the main runtime's shared state.
    ///
    /// The Save map is seeded through `initial_save_overrides` because
    /// `start_scene_preview` rebuilds the snapshot from content defaults before
    /// it evaluates the first node; seeding the map any other way would let the
    /// opening nodes read defaults instead of the values the main story is
    /// actually running with.  The Profile map needs no such trick because
    /// starting a Scene never resets it.
    fn seed_secondary_runtime(
        &self,
        main: &RuntimeEngine,
    ) -> Result<RuntimeEngine, WireCommandError> {
        let mut runtime = RuntimeEngine::with_profile_overrides(
            &self.content,
            main.profile_state(&self.content),
            &main.snapshot().variables,
        )
        .map_err(WireCommandError::from)?;
        runtime.set_profile_variables(main.profile_variables_map().clone());
        Ok(runtime)
    }

    /// Build the secondary runtime for `scene_id` in an isolated ID namespace,
    /// seeded from `main` — which is the main runtime this command is about to
    /// commit — before any node of the opening Scene evaluates.
    fn build_secondary_session(
        &self,
        main: &RuntimeEngine,
        scene_id: &str,
        owner: SecondaryOwner,
        token: u64,
        id_base: u64,
    ) -> Result<SecondarySession, WireCommandError> {
        let mut runtime = self.seed_secondary_runtime(main)?;
        runtime.prepare_session_ids(id_base, id_base, id_base);
        // The secondary shares the host-authoritative variable maps, so its own
        // Scene boundaries must preserve them.
        runtime.set_shared_save_variables(true);
        let mut first = runtime
            .start_scene_preview(&self.content, scene_id)
            .map_err(WireCommandError::from)?;
        // A control cue is a host instruction and must never reach a WebView,
        // not even the one that just opened; this also recomputes the
        // acknowledgement requirement from the presentation that is actually
        // delivered.
        take_open_window_request(&mut first);
        debug_assert_eq!(first.snapshot.location.scene_id, scene_id);
        Ok(SecondarySession {
            runtime,
            scene_id: scene_id.to_owned(),
            owner,
            token,
            // Only a runtime-gated opening presentation has to survive into the
            // first bootstrap: without it the secondary's gate could never be
            // acknowledged and gameplay would be blocked forever.
            initial_update: first.requires_ack.then_some(first),
        })
    }

    /// The native window work an *in-replay* transition implies.  A replay only
    /// ever touches the window it owns: a story-owned slot cannot be live while a
    /// replay is running, and `closing` (the replay left the Scene that owns the
    /// window, or is over) hides the slot that carries this replay's generation.
    fn stage_replay_secondary(
        &self,
        candidate: &RuntimeEngine,
        opened: Option<String>,
        closing: bool,
        generation: u64,
    ) -> Result<StagedSecondary, WireCommandError> {
        let (any_live, owned) = {
            let slot = self.secondary()?;
            (
                slot.is_some(),
                slot.as_ref().is_some_and(|session| {
                    session.owner == SecondaryOwner::Replay { generation }
                }),
            )
        };
        if closing {
            return Ok(StagedSecondary::none(if owned {
                SecondaryPlan::Hide
            } else {
                SecondaryPlan::None
            }));
        }
        let Some(scene_id) = opened else {
            return Ok(StagedSecondary::none(SecondaryPlan::None));
        };
        self.stage_replay_open_window(candidate, &scene_id, generation, any_live)
    }

    /// The native window work a replay *entry* implies.  Entry is an ownership
    /// boundary: the main story is suspended behind the replay, so a story-owned
    /// window cannot outlive it — unless the replay's own entry opens a window,
    /// in which case the very same native window is re-pointed to the replay
    /// instead of being destroyed and rebuilt (a destroy is only queued, and the
    /// label it leaves behind must never be adopted by a new owner).
    fn stage_replay_entry_secondary(
        &self,
        candidate: &RuntimeEngine,
        opened: Option<String>,
        ending: bool,
        generation: u64,
    ) -> Result<StagedSecondary, WireCommandError> {
        let any_live = self.secondary()?.is_some();
        let Some(scene_id) = opened.filter(|_| !ending) else {
            return Ok(StagedSecondary::none(if any_live {
                SecondaryPlan::Hide
            } else {
                SecondaryPlan::None
            }));
        };
        self.stage_replay_open_window(candidate, &scene_id, generation, any_live)
    }

    /// Stage a fresh-token re-point of the single secondary slot onto `scene_id`,
    /// seeded from `candidate` — the replay runtime this command is about to
    /// commit — and owned by the replay `generation`.  The staged session keeps
    /// its own copy of the shared maps; the effects of its opening evaluation are
    /// handed back so the caller can publish them into the replay runtime in the
    /// same transaction.
    fn stage_replay_open_window(
        &self,
        candidate: &RuntimeEngine,
        scene_id: &str,
        generation: u64,
        any_live: bool,
    ) -> Result<StagedSecondary, WireCommandError> {
        if !self.content.scenes.contains_key(scene_id) {
            return Err(WireCommandError::new(
                WireCommandErrorCode::Validation,
                format!("open_window 指向未声明的场景 {scene_id}"),
            ));
        }
        let token = self.bump_secondary_generation()?;
        let id_base = token
            .checked_mul(SECONDARY_ID_STRIDE)
            .ok_or_else(|| WireCommandError::new(WireCommandErrorCode::Internal, "副窗口编号耗尽"))?;
        let mut session = self.build_secondary_session(
            candidate,
            scene_id,
            SecondaryOwner::Replay { generation },
            token,
            id_base,
        )?;
        let save_variables = session.runtime.snapshot().variables.clone();
        let profile_variables = session.runtime.profile_variables_map().clone();
        let appended_history = session.runtime.take_appended_history();
        Ok(StagedSecondary {
            session: Some(session),
            // Re-pointing the one native window is what keeps the single-slot
            // contract: a replay never creates a second window.
            plan: SecondaryPlan::Show { replaced: any_live },
            save_variables: Some(save_variables),
            profile_variables: Some(profile_variables),
            appended_history,
        })
    }

    fn bump_secondary_generation(&self) -> Result<u64, WireCommandError> {
        self.secondary_generation
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(1)
            })
            .map(|value| value + 1)
            .map_err(|_| WireCommandError::new(WireCommandErrorCode::Internal, "副窗口编号耗尽"))
    }

    /// Run one isolated-replay command and perform its staged native work.
    fn transact_replay(
        &self,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<RuntimeUpdate, WireCommandError> {
        self.finish_replay_transition(self.commit_replay(operation)?)
    }

    /// The pure half of a replay transaction: clone the replay runtime, run the
    /// operation, consume the host-only window cue, stage the secondary work the
    /// replay's new state implies and commit the replay runtime together with the
    /// secondary slot.  No native API is touched here, so host tests can drive
    /// every replay path without a window.
    ///
    /// A replay stays isolated from the player's runtime: it borrows a cloned
    /// profile/default state at start and is never persisted, so the staged
    /// session's startup effects are published to the *replay* runtime only —
    /// never to `runtime`, [`Self::commit_runtime`] or the profile file.
    fn commit_replay(
        &self,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<ReplayTransition, WireCommandError> {
        let mut slot = self.replay()?;
        let session = slot.take().ok_or_else(replay_missing)?;
        let generation = session.generation;
        let mut runtime = session.runtime.clone();
        let mut update = match operation(&mut runtime).map_err(WireCommandError::from) {
            Ok(update) => update,
            Err(error) => {
                // An invalid acknowledgement or a rejected operation leaves the
                // live replay exactly where it was.
                *slot = Some(session);
                return Err(error);
            }
        };
        let opened = take_open_window_request(&mut update);
        debug_assert_no_window_cue(&update);
        let crossed = runtime.snapshot().location.scene_id != session.scene_id;
        let ended = matches!(
            runtime.snapshot().prompt,
            vectspace_core::model::PromptSnapshot::End { .. }
        );
        // A replay closes its window exactly like the main story closes its own:
        // when it leaves the Scene that owns the window, or when it is over.  It
        // only ever closes the slot that carries its own generation.
        let closing = session.ending || crossed || ended;
        let staged = match self.stage_replay_secondary(&runtime, opened, closing, generation) {
            Ok(staged) => staged,
            Err(error) => {
                *slot = Some(session);
                return Err(error);
            }
        };
        if let Some(variables) = &staged.save_variables {
            runtime.set_save_variables(variables.clone());
        }
        if let Some(variables) = &staged.profile_variables {
            runtime.set_profile_variables(variables.clone());
        }
        if !staged.appended_history.is_empty() {
            runtime.extend_dialogue_history(staged.appended_history.clone());
        }
        let committed = ReplaySession {
            runtime,
            scene_id: session.scene_id.clone(),
            ending: closing,
            generation,
        };
        // Keep the *exact* previous session for rollback: the slot was taken at
        // the top of this transaction, so replacing into it would report `None`
        // and a failed native step would clear a replay that is still live.
        *slot = Some(committed);
        let previous_replay = Some(session);
        drop(slot);
        let mut secondary = self.secondary()?;
        let previous_secondary = match staged.plan {
            SecondaryPlan::None => SecondaryBaseline::Untouched,
            SecondaryPlan::Show { .. } => {
                SecondaryBaseline::Restore(Box::new(std::mem::replace(
                    &mut *secondary,
                    staged.session,
                )))
            }
            SecondaryPlan::Hide => SecondaryBaseline::Restore(Box::new(secondary.take())),
        };
        drop(secondary);
        Ok(ReplayTransition {
            update,
            plan: staged.plan,
            previous_replay,
            previous_secondary,
        })
    }

    /// Perform the staged native work for a committed replay transition,
    /// restoring the replay *and* the secondary slot when it fails, so a replay
    /// can never keep running with a window that belongs to someone else.
    fn finish_replay_transition(
        &self,
        transition: ReplayTransition,
    ) -> Result<RuntimeUpdate, WireCommandError> {
        if let Err(error) = self.apply_secondary_plan(transition.plan.clone()) {
            let cleanup_failures = self.rollback_replay_state(
                transition.previous_replay.clone(),
                &transition.previous_secondary,
                &transition.plan,
            );
            return Err(aggregate_transition_failure(error, cleanup_failures));
        }
        self.reconcile_secondary_window(&transition.plan);
        Ok(transition.update)
    }

    /// Restore the replay slot and the secondary slot after a rolled-back replay
    /// transaction.  Returns every cleanup failure instead of stopping at the
    /// first one, so the caller can report the whole picture.
    fn rollback_replay_state(
        &self,
        previous_replay: Option<ReplaySession>,
        previous_secondary: &SecondaryBaseline,
        plan: &SecondaryPlan,
    ) -> Vec<WireCommandError> {
        let mut failures = Vec::new();
        if let Some(previous) = previous_secondary.restored_session() {
            match self.secondary() {
                Ok(mut slot) => *slot = previous.clone(),
                Err(error) => failures.push(error),
            }
        }
        match self.replay() {
            Ok(mut slot) => *slot = previous_replay,
            Err(error) => failures.push(error),
        }
        // A failed creation may have produced a window that never received a
        // session; the restored memory has no secondary, so the native state has
        // to be cleaned up again.  If that fails too, the surviving window is
        // reported instead of swallowed.
        let restored_without_secondary = previous_secondary.restored_without_secondary();
        if restored_without_secondary && matches!(plan, SecondaryPlan::Show { .. }) {
            if let Err(error) = self.windows.hide_secondary() {
                failures.push(WireCommandError::new(
                    WireCommandErrorCode::Internal,
                    format!(
                        "副窗口回滚清理失败，可能残留未受管理的原生窗口: {}",
                        error.message
                    ),
                ));
            }
        }
        failures
    }

    /// Best-effort recovery for the enqueue-only native contract.  A transition
    /// that performed no native work asks the seam to reconcile the native window
    /// with the slot that really exists, so a creation the runtime never
    /// performed is retried and an orphan of a failed cleanup is removed.  It
    /// never waits for the event loop and never fails the command (the logical
    /// state is already consistent), so a failure is reported as a diagnostic
    /// only.
    fn reconcile_secondary_window(&self, plan: &SecondaryPlan) {
        if !matches!(plan, SecondaryPlan::None) {
            return;
        }
        let expected_live = matches!(self.secondary().map(|slot| slot.is_some()), Ok(true));
        if let Err(error) = self.windows.reconcile_secondary(expected_live) {
            eprintln!("副窗口原生窗口状态校正失败: {}", error.message);
        }
    }

    fn check_secondary_session(
        &self,
        expected: Option<&WireU64>,
    ) -> Result<u64, WireCommandError> {
        let Some(expected) = expected else {
            return Err(WireCommandError::new(
                WireCommandErrorCode::StaleSession,
                "请求缺少副窗口会话编号，请重新连接运行时",
            ));
        };
        let expected = expected.parse().map_err(WireCommandError::from)?;
        let slot = self.secondary()?;
        let session = slot.as_ref().ok_or_else(|| {
            WireCommandError::new(WireCommandErrorCode::Runtime, "当前没有正在运行的副窗口会话")
        })?;
        if session.token != expected {
            return Err(WireCommandError::new(
                WireCommandErrorCode::StaleSession,
                format!(
                    "副窗口会话已切换，当前为 {}，请求来自 {expected}",
                    session.token
                ),
            ));
        }
        Ok(session.token)
    }

    /// Run one secondary-window command.  Where the session's shared effects go
    /// is decided by its [`SecondaryOwner`]:
    ///
    /// * a **story-owned** session follows the main runtime: the main maps are
    ///   published into the candidate *before* the operation is evaluated, the
    ///   candidate's maps and its new dialogue occurrences are published back,
    ///   and the profile is persisted from the main candidate (a failed write
    ///   aborts the whole command);
    /// * a **replay-owned** session follows its replay instead: the replay
    ///   runtime's maps are the authority, everything is published back to the
    ///   *replay* runtime only, and nothing reaches the main runtime, the profile
    ///   file or the official ledger.
    ///
    /// Both branches keep the session's own progression metadata (read/seen/
    /// completed) and never let its Scene boundary reset the shared Save map.
    fn transact_secondary(
        &self,
        expected_session_id: Option<&WireU64>,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<(RuntimeUpdate, u64), WireCommandError> {
        let token = self.check_secondary_session(expected_session_id)?;
        let owner = {
            let slot = self.secondary()?;
            slot.as_ref()
                .map(|session| session.owner.clone())
                .ok_or_else(secondary_missing)?
        };
        match owner {
            SecondaryOwner::Story { .. } => self.transact_secondary_against_story(token, operation),
            SecondaryOwner::Replay { generation } => {
                self.transact_secondary_against_replay(token, generation, operation)
            }
        }
    }

    /// A story-owned secondary command: publish into the main runtime and
    /// persist the resulting profile, exactly like the single-window host.
    fn transact_secondary_against_story(
        &self,
        token: u64,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<(RuntimeUpdate, u64), WireCommandError> {
        let mut main = self.runtime()?;
        let mut slot = self.secondary()?;
        let session = slot.as_mut().ok_or_else(secondary_missing)?;
        if session.token != token {
            return Err(WireCommandError::new(
                WireCommandErrorCode::StaleSession,
                "副窗口会话已切换，请重新连接运行时",
            ));
        }
        let mut main_candidate = main.clone();
        let mut candidate = session.runtime.clone();
        candidate.set_save_variables(main_candidate.snapshot().variables.clone());
        candidate.set_profile_variables(main_candidate.profile_variables_map().clone());
        let mut update = operation(&mut candidate).map_err(WireCommandError::from)?;
        // A secondary update can never carry a window control cue to any
        // WebView, even if authored content reached this node in this runtime.
        take_open_window_request(&mut update);
        debug_assert_no_window_cue(&update);
        main_candidate.set_save_variables(candidate.snapshot().variables.clone());
        main_candidate.set_profile_variables(candidate.profile_variables_map().clone());
        main_candidate.extend_dialogue_history(candidate.take_appended_history());
        self.commit_runtime(&main, &main_candidate)?;
        *main = main_candidate;
        session.runtime = candidate;
        session.scene_id = update.snapshot.location.scene_id.clone();
        Ok((update, token))
    }

    /// A replay-owned secondary command: the replay runtime is the only
    /// authority.  The command is refused when the owning replay is gone, so a
    /// delayed request from an ended replay can never mutate a newer owner.
    fn transact_secondary_against_replay(
        &self,
        token: u64,
        generation: u64,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<(RuntimeUpdate, u64), WireCommandError> {
        let mut replay = self.replay()?;
        let session = replay
            .as_mut()
            .filter(|session| session.generation == generation)
            .ok_or_else(|| {
                WireCommandError::new(
                    WireCommandErrorCode::StaleSession,
                    "重演会话已结束，请重新连接运行时",
                )
            })?;
        let mut slot = self.secondary()?;
        let secondary = slot.as_mut().ok_or_else(secondary_missing)?;
        if secondary.token != token {
            return Err(WireCommandError::new(
                WireCommandErrorCode::StaleSession,
                "副窗口会话已切换，请重新连接运行时",
            ));
        }
        let mut candidate = secondary.runtime.clone();
        candidate.set_save_variables(session.runtime.snapshot().variables.clone());
        candidate.set_profile_variables(session.runtime.profile_variables_map().clone());
        let mut update = operation(&mut candidate).map_err(WireCommandError::from)?;
        take_open_window_request(&mut update);
        debug_assert_no_window_cue(&update);
        // Replay play stays ephemeral: the shared maps and the new occurrences
        // are published to the replay runtime only.  Nothing is persisted, so a
        // replayed line can never appear in a save, the profile file or the
        // official ledger.
        session
            .runtime
            .set_save_variables(candidate.snapshot().variables.clone());
        session
            .runtime
            .set_profile_variables(candidate.profile_variables_map().clone());
        let appended_history = candidate.take_appended_history();
        session.runtime.extend_dialogue_history(appended_history);
        secondary.runtime = candidate;
        secondary.scene_id = update.snapshot.location.scene_id.clone();
        Ok((update, token))
    }

    fn transact_active_runtime(
        &self,
        expected_session_id: Option<&WireU64>,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<(RuntimeUpdate, u64, WireSessionMode), WireCommandError> {
        let _gate = self.session_gate()?;
        // The session check must happen while holding the same gate as the
        // runtime mutation.  Checking before acquiring it leaves a race in
        // which a replay can be entered between the check and the operation,
        // allowing a stale story request to mutate the new session.
        self.check_session(expected_session_id)?;
        if self.replay()?.is_some() {
            // Every replay path consumes the host-only window cue and stages the
            // window work it implies, so the cue can never reach the main window
            // and a replay can really own the secondary.
            let update = self.transact_replay(operation)?;
            return Ok((update, self.current_session_id(), WireSessionMode::Replay));
        }
        let update = self.transact_runtime(operation)?;
        Ok((update, self.current_session_id(), WireSessionMode::Story))
    }

    fn enter_replay(&self, scene_id: &str) -> Result<RuntimeUpdate, WireCommandError> {
        if self.replay()?.is_some() {
            return Err(WireCommandError::new(
                WireCommandErrorCode::Runtime,
                "已经存在正在进行的 Scene 重演",
            ));
        }
        if self.content.chapter_map.is_none() {
            return Err(WireCommandError::new(
                WireCommandErrorCode::Validation,
                "当前内容未配置章节地图",
            ));
        }
        let (profile, map) = {
            let main = self.runtime()?;
            (
                main.profile_state(&self.content),
                main.chapter_map(&self.content)
                    .map_err(WireCommandError::from)?,
            )
        };
        let hotspot = map
            .as_ref()
            .and_then(|snapshot| {
                snapshot
                    .hotspots
                    .iter()
                    .find(|hotspot| hotspot.scene_id == scene_id)
            })
            .ok_or_else(|| {
                WireCommandError::new(
                    WireCommandErrorCode::Validation,
                    "该 Scene 尚未揭示，不能重演",
                )
            })?;
        if !hotspot.replayable {
            return Err(WireCommandError::new(
                WireCommandErrorCode::Validation,
                "该 Scene 尚未完成，不能重演",
            ));
        }
        let map_definition = self
            .content
            .chapter_map
            .as_ref()
            .expect("chapter_map checked above");
        let definition_hotspot = map_definition
            .hotspots
            .iter()
            .find(|candidate| candidate.scene_id == scene_id)
            .expect("validated hotspot exists");
        let mut replay_runtime = RuntimeEngine::with_replay_overrides(
            &self.content,
            profile,
            &definition_hotspot.variable_overrides,
        )
        .map_err(WireCommandError::from)?;
        let generation = self
            .replay_generation
            .fetch_add(1, Ordering::Relaxed)
            .checked_add(1)
            .ok_or_else(|| {
                WireCommandError::new(WireCommandErrorCode::Internal, "重演会话编号耗尽")
            })?;
        let id_base = generation
            .checked_mul(REPLAY_ID_STRIDE)
            .ok_or_else(|| {
                WireCommandError::new(WireCommandErrorCode::Internal, "重演会话编号耗尽")
            })?;
        replay_runtime.prepare_session_ids(id_base, id_base, id_base);
        let mut first = replay_runtime
            .start_scene_preview(&self.content, scene_id)
            .map_err(WireCommandError::from)?;
        // The replay's entry is an entry path like the main story's: the
        // host-only cue is consumed here (and the acknowledgement requirement is
        // recomputed) instead of leaking to the main window, where the wire type
        // could not even represent it.
        let opened = take_open_window_request(&mut first);
        debug_assert_no_window_cue(&first);
        let ending = matches!(
            first.snapshot.prompt,
            vectspace_core::model::PromptSnapshot::End { .. }
        );
        let staged = self.stage_replay_entry_secondary(&replay_runtime, opened, ending, generation)?;
        if let Some(variables) = &staged.save_variables {
            replay_runtime.set_save_variables(variables.clone());
        }
        if let Some(variables) = &staged.profile_variables {
            replay_runtime.set_profile_variables(variables.clone());
        }
        if !staged.appended_history.is_empty() {
            replay_runtime.extend_dialogue_history(staged.appended_history.clone());
        }
        let previous_replay = (*self.replay()?).replace(ReplaySession {
            runtime: replay_runtime,
            scene_id: scene_id.to_owned(),
            ending,
            generation,
        });
        let mut secondary = self.secondary()?;
        let previous_secondary = match staged.plan {
            SecondaryPlan::None => SecondaryBaseline::Untouched,
            SecondaryPlan::Show { .. } => {
                SecondaryBaseline::Restore(Box::new(std::mem::replace(
                    &mut *secondary,
                    staged.session,
                )))
            }
            SecondaryPlan::Hide => SecondaryBaseline::Restore(Box::new(secondary.take())),
        };
        drop(secondary);
        if let Err(error) = self.apply_secondary_plan(staged.plan.clone()) {
            let cleanup_failures =
                self.rollback_replay_state(previous_replay, &previous_secondary, &staged.plan);
            return Err(aggregate_transition_failure(error, cleanup_failures));
        }
        self.reconcile_secondary_window(&staged.plan);
        // The generation only changes once the entry really committed, so a
        // failed entry leaves the previous session id valid for the frontend.
        self.bump_session_id()?;
        Ok(first)
    }

    /// Leave the live replay.  A replay-owned secondary is closed *before* the
    /// replay slot is cleared: a failed destroy keeps both, so the exit can be
    /// retried instead of orphaning a window that no session owns any more.
    fn exit_replay(&self) -> Result<(), WireCommandError> {
        let Some(generation) = self.replay()?.as_ref().map(|session| session.generation) else {
            return Ok(());
        };
        let owned = {
            let slot = self.secondary()?;
            slot.as_ref()
                .is_some_and(|session| session.owner == SecondaryOwner::Replay { generation })
        };
        if owned {
            // Native work with no runtime mutex held; the session gate is still
            // held, so no other command can observe the gap.
            self.windows.hide_secondary()?;
            *self.secondary()? = None;
        }
        *self.replay()? = None;
        self.bump_session_id()?;
        Ok(())
    }

    /// Tear the secondary slot down outside a story transaction (returning to
    /// the title).  The native window is destroyed *before* the slot is cleared,
    /// so a failed destroy leaves a live window that still owns its session
    /// instead of a session whose window no longer exists.
    fn close_secondary(&self) -> Result<(), WireCommandError> {
        let live = self.secondary()?.is_some();
        if !live {
            return Ok(());
        }
        self.windows.hide_secondary()?;
        *self.secondary()? = None;
        Ok(())
    }

    /// Restore one slot.  Both runtimes and the merged ledger are validated and
    /// staged before anything is persisted or committed, so a malformed slot
    /// leaves the previous session — including its live secondary window —
    /// completely intact.  The native window step is part of the same
    /// transaction and rolls everything back when it fails.
    fn apply_loaded_slot(&self, loaded: LoadedSlot) -> Result<RuntimeUpdate, WireCommandError> {
        let LoadedSlot {
            snapshot,
            history,
            secondary,
        } = loaded;
        let mut runtime = self.runtime()?;
        let mut candidate = runtime.clone();
        let update = candidate
            .load_snapshot(&self.content, snapshot)
            .map_err(WireCommandError::from)?;
        // Schema v3 restores the merged ordered ledger.  A legacy v2 slot has no
        // stored ledger, which keeps the historical "load clears history"
        // behaviour for slots written before multiwindow support.
        if !history.is_empty() {
            candidate.replace_dialogue_history(history);
        }
        // Stage the restored secondary before the profile write so a bad scene
        // id or snapshot aborts the load with no partial replacement.
        let staged = match secondary {
            Some(stored) => Some(self.build_secondary_from_slot(&candidate, &stored)?),
            None => None,
        };
        let had_secondary = self.secondary()?.is_some();
        let plan = if staged.is_some() {
            SecondaryPlan::Show {
                replaced: had_secondary,
            }
        } else if had_secondary {
            SecondaryPlan::Hide
        } else {
            SecondaryPlan::None
        };
        let previous_profile = runtime.profile_state(&self.content);
        let profile_written = self.commit_runtime(&runtime, &candidate)?;
        let previous_secondary =
            SecondaryBaseline::Restore(Box::new(std::mem::replace(&mut *self.secondary()?, staged)));
        let previous_runtime = std::mem::replace(&mut *runtime, candidate);
        drop(runtime);
        self.finish_transition(MainTransition {
            update,
            plan,
            previous_runtime,
            previous_secondary,
            previous_profile,
            profile_written,
        })
    }

    /// Rebuild a secondary runtime from persisted state.  Shared variables come
    /// from the freshly loaded main runtime, never from the slot's secondary
    /// copy, so the main snapshot stays the single authority.
    fn build_secondary_from_slot(
        &self,
        main: &RuntimeEngine,
        stored: &SecondaryState,
    ) -> Result<SecondarySession, WireCommandError> {
        if !self.content.scenes.contains_key(&stored.scene_id) {
            return Err(WireCommandError::new(
                WireCommandErrorCode::Validation,
                format!("存档中的副窗口场景不存在: {}", stored.scene_id),
            ));
        }
        let token = self.bump_secondary_generation()?;
        let id_base = token
            .checked_mul(SECONDARY_ID_STRIDE)
            .ok_or_else(|| WireCommandError::new(WireCommandErrorCode::Internal, "副窗口编号耗尽"))?;
        let mut runtime = RuntimeEngine::with_profile(&self.content, stored.profile.clone())
            .map_err(WireCommandError::from)?;
        runtime.prepare_session_ids(id_base, id_base, id_base);
        runtime.set_shared_save_variables(true);
        runtime
            .load_snapshot(&self.content, stored.snapshot.clone())
            .map_err(WireCommandError::from)?;
        runtime.set_save_variables(main.snapshot().variables.clone());
        runtime.set_profile_variables(main.profile_variables_map().clone());
        runtime.take_appended_history();
        Ok(SecondarySession {
            runtime,
            scene_id: stored.scene_id.clone(),
            owner: SecondaryOwner::Story {
                scene_id: stored.owning_scene.clone(),
            },
            token,
            // Loading never evaluates the secondary's Scene, so no pending
            // presentation can be left behind by the restore.
            initial_update: None,
        })
    }

    /// The secondary window's bootstrap payload.  It never loads settings, save
    /// slots, chapter maps or history: the secondary has normal gameplay and
    /// nothing else.  A runtime-gated presentation produced while the session
    /// was staged is delivered verbatim, with its original update id: the
    /// runtime is waiting for exactly that acknowledgement, and a cue-less
    /// bootstrap would leave the secondary permanently locked.  Once it has
    /// been acknowledged the ordinary bootstrap is authoritative again.
    fn secondary_bootstrap_payload(&self) -> Result<WireBootstrapPayload, WireCommandError> {
        let slot = self.secondary()?;
        let session = slot.as_ref().ok_or_else(|| {
            WireCommandError::new(WireCommandErrorCode::Runtime, "当前没有正在运行的副窗口会话")
        })?;
        let token = session.token;
        let pending_initial = session
            .initial_update
            .as_ref()
            .filter(|update| {
                update.requires_ack
                    && session.runtime.pending_runtime_update() == Some(update.update_id)
            })
            .cloned();
        let mut runtime = session.runtime.clone();
        drop(slot);
        let mut payload = runtime.bootstrap(&self.content);
        if let Some(update) = pending_initial {
            payload.update = update;
        }
        Ok(WireBootstrapPayload {
            update: wire_secondary_update(token, payload.update),
            asset_ids: payload.asset_ids,
            content_version: payload.content_version,
            chapter_map_available: false,
            default_font: payload.default_font,
        })
    }

    fn current_session_id(&self) -> u64 {
        self.session_id.load(Ordering::Acquire)
    }

    fn bump_session_id(&self) -> Result<u64, WireCommandError> {
        let previous = self
            .session_id
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(1)
            });
        previous
            .map(|value| value + 1)
            .map_err(|_| WireCommandError::new(WireCommandErrorCode::Internal, "会话编号耗尽"))
    }

    fn check_session(&self, expected: Option<&WireU64>) -> Result<(), WireCommandError> {
        let Some(expected) = expected else {
            return Err(WireCommandError::new(
                WireCommandErrorCode::StaleSession,
                "请求缺少会话编号，请重新连接运行时",
            ));
        };
        let expected = expected.parse().map_err(WireCommandError::from)?;
        let actual = self.current_session_id();
        if expected != actual {
            return Err(WireCommandError::new(
                WireCommandErrorCode::StaleSession,
                format!("会话已切换，当前会话为 {actual}，请求来自 {expected}"),
            ));
        }
        Ok(())
    }
}

/// Whether showing the secondary window must tell the current native window to
/// re-bootstrap its frontend.
///
/// The host's logical `replaced` flag only describes the *slot*: a native window
/// that already exists — one left behind by a partially successful creation whose
/// cleanup failed, or one reused by a retry — still holds an older session token
/// and must be refreshed even when that flag is false.  Keeping the rule in one
/// place is what makes the retry path deterministic for the real window and for
/// the injected test seam.
fn needs_session_refresh(replaced: bool, reused: bool) -> bool {
    replaced || reused
}

/// The error reported when a secondary command arrives without a live secondary
/// session.  Kept in one place so every secondary path agrees.
fn secondary_missing() -> WireCommandError {
    WireCommandError::new(WireCommandErrorCode::Runtime, "当前没有正在运行的副窗口会话")
}

/// The error reported when a replay command arrives without a live replay.  Kept
/// in one place so the entry, advance and acknowledgement paths agree.
fn replay_missing() -> WireCommandError {
    WireCommandError::new(
        WireCommandErrorCode::Runtime,
        "当前没有正在进行的 Scene 重演",
    )
}

/// Report the native failure that forced a rollback together with every cleanup
/// failure the rollback itself hit.  The first error keeps its code (callers
/// branch on it) and its message stays first, so a caller that only reads the
/// beginning still sees the original cause while the full picture is available.
fn aggregate_transition_failure(
    error: WireCommandError,
    cleanup_failures: Vec<WireCommandError>,
) -> WireCommandError {
    if cleanup_failures.is_empty() {
        return error;
    }
    let details = cleanup_failures
        .iter()
        .map(|failure| failure.message.as_str())
        .collect::<Vec<_>>()
        .join("；");
    WireCommandError::new(
        error.code,
        format!("{}；回滚清理失败: {details}", error.message),
    )
}

fn wire_update(
    state: &EngineState,
    update: RuntimeUpdate,
    mode: WireSessionMode,
) -> WireRuntimeUpdate {
    WireRuntimeUpdate::with_session(update, WireU64::from(state.current_session_id()), mode)
}

fn wire_secondary_update(token: u64, update: RuntimeUpdate) -> WireRuntimeUpdate {
    WireRuntimeUpdate::with_session(update, WireU64::from(token), WireSessionMode::Secondary)
}

/// Consume the host control cues from an update.  The cue is a host instruction,
/// not a presentation instruction: it must never reach a WebView, and it must be
/// consumed exactly once so a frontend retry cannot re-trigger the side effect.
///
/// One update can carry several requests because the runtime keeps going past
/// every `open_window` node, and a repeated `open_window` replaces the single
/// slot: the **last** request in the update is therefore the one that decides
/// what the window shows.  The intermediate requests are deliberately not
/// played — no intermediate secondary runtime is ever created.
///
/// The acknowledgement requirement is recomputed from the cues that remain,
/// because the runtime derives it from its own (pre-strip) cue list: an
/// `open_window` followed by a runtime-gated node such as `wait` is a valid
/// authored combination, and it must keep exactly the acknowledgement its
/// remaining presentation still needs.
fn take_open_window_request(update: &mut RuntimeUpdate) -> Option<String> {
    let mut requested = None;
    let requires_ack_before = update.requires_ack;
    update.cues.retain(|cue| {
        if let PresentationCueKind::OpenWindow { scene } = &cue.kind {
            requested = Some(scene.clone());
            false
        } else {
            true
        }
    });
    let requires_ack = update.cues.iter().any(|cue| cue.gate == CueGate::Runtime);
    debug_assert!(
        !requires_ack_before || requires_ack || requested.is_none(),
        "stripping a control cue must not drop the acknowledgement a remaining presentation needs"
    );
    update.requires_ack = requires_ack;
    requested
}

/// The host-only window cue must never survive into an update that a WebView
/// receives.  Every host path that returns an update asserts this in debug
/// builds, so a new producer that forgets to consume the cue fails loudly in
/// tests instead of silently turning the node into a no-op at the wire boundary.
fn debug_assert_no_window_cue(update: &RuntimeUpdate) {
    debug_assert!(
        !update
            .cues
            .iter()
            .any(|cue| matches!(cue.kind, PresentationCueKind::OpenWindow { .. })),
        "宿主控制提示必须在下发到 WebView 之前被消费"
    );
}

/// How the native seam must treat the secondary label it observes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeShowAction {
    /// The label is free: create the window.
    Create,
    /// The label is alive: reuse it, refreshing the frontend when the session
    /// really changed.
    Reuse,
    /// The label is queued for destruction: refuse instead of adopting it, so a
    /// new owner never receives a window the runtime is about to tear down.
    RefusePendingDestroy,
}

/// Decide the native action from the observed label state.  Kept in one place so
/// the real seam and the injected test seam cannot drift apart.
fn native_show_action(label_present: bool, label_closing: bool) -> NativeShowAction {
    if !label_present {
        NativeShowAction::Create
    } else if label_closing {
        NativeShowAction::RefusePendingDestroy
    } else {
        NativeShowAction::Reuse
    }
}

/// That is the host's bounded liveness net: a label that is queued for
/// destruction is never adopted, but a destroy the runtime never completed is
/// re-attempted **once** per later transition after this grace period.  It is a
/// bound, never a wait: nothing sleeps, loops, spawns or blocks on the event
/// loop.
const SECONDARY_PENDING_DESTROY_GRACE: Duration = Duration::from_secs(2);

/// Whether a destroy that has been queued for `elapsed` may be re-attempted.
/// Kept in one place so the real seam and the injected test seam cannot drift
/// apart, and so the bound is testable without any real time passing.
fn pending_destroy_retry_due(elapsed: Duration) -> bool {
    elapsed >= SECONDARY_PENDING_DESTROY_GRACE
}

const SECONDARY_CLOSING_MESSAGE: &str = "副窗口正在关闭，请稍后重试";

/// Create the secondary window if it does not exist yet.  A failure is reported
/// to the caller, which rolls the whole transition back instead of committing a
/// session whose window is missing.
///
/// A label that is queued for destruction is refused instead of adopted: the
/// runtime keeps resolving a label until it processes the enqueued destroy, so
/// adopting it would hand the new owner a window that is about to disappear.
fn ensure_secondary_window(
    app: &tauri::AppHandle,
    closing_secondary: &AtomicBool,
) -> Result<tauri::WebviewWindow, WireCommandError> {
    let present = app.get_webview_window(SECONDARY_WINDOW_LABEL);
    match native_show_action(
        present.is_some(),
        closing_secondary.load(Ordering::Acquire),
    ) {
        NativeShowAction::Reuse => {
            return Ok(present.expect("checked present"));
        }
        NativeShowAction::RefusePendingDestroy => {
            return Err(WireCommandError::new(
                WireCommandErrorCode::Runtime,
                SECONDARY_CLOSING_MESSAGE,
            ))
        }
        NativeShowAction::Create => {}
    }
    // The label is free again, so any queued destroy has been processed.
    closing_secondary.store(false, Ordering::Release);
    let window = WebviewWindowBuilder::new(
        app,
        SECONDARY_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("VECTSPACE — 副窗口")
    .inner_size(960.0, 540.0)
    .min_inner_size(480.0, 270.0)
    .build()
    .map_err(|error| {
        WireCommandError::new(
            WireCommandErrorCode::Internal,
            format!("无法创建副窗口: {error}"),
        )
    })?;
    // Hide the same browser affordances the main window does.  Best effort: a
    // failure here degrades hardening, and it deliberately does not fail the
    // transition that already created the window.
    #[cfg(windows)]
    if let Err(error) = disable_browser_features(&window) {
        eprintln!("副窗口浏览器特性关闭失败: {error}");
    }
    Ok(window)
}

/// Destroy the secondary window if it exists.  `destroy` is used instead of
/// `close` because a user/native close request is always prevented; only a host
/// transition may remove the window.  A failed destroy is reported to the
/// caller, which rolls the transition back rather than dropping the session and
/// leaving the window behind.
///
/// On success the call only *queues* the destroy (off the event-loop thread),
/// so `closing_secondary` stays set until the label is observed gone: that is
/// what stops a rapidly re-opened window from adopting a label the runtime is
/// about to tear down.
fn destroy_secondary_window(
    app: &tauri::AppHandle,
    closing_secondary: &AtomicBool,
) -> Result<(), WireCommandError> {
    let Some(window) = app.get_webview_window(SECONDARY_WINDOW_LABEL) else {
        // The label is free: a queued destroy finished, or nothing was created.
        closing_secondary.store(false, Ordering::Release);
        return Ok(());
    };
    closing_secondary.store(true, Ordering::Release);
    let result = window.destroy();
    if result.is_err() {
        // The window survives, so it is not queued for destruction after all.
        closing_secondary.store(false, Ordering::Release);
    }
    result.map_err(|error| {
        WireCommandError::new(
            WireCommandErrorCode::Internal,
            format!("副窗口关闭失败: {error}"),
        )
    })
}

fn wire_snapshot(
    state: &EngineState,
    snapshot: vectspace_core::model::RuntimeSnapshot,
    mode: WireSessionMode,
) -> WireRuntimeSnapshot {
    WireRuntimeSnapshot::with_session(snapshot, WireU64::from(state.current_session_id()), mode)
}

#[tauri::command]
async fn bootstrap(
    window: tauri::WebviewWindow,
    state: State<'_, EngineState>,
) -> Result<WireBootstrapPayload, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    let payload = state.runtime()?.bootstrap(&state.content);
    // `RuntimeEngine::bootstrap` returns the cue-less snapshot by construction
    // (`update_without_cues`), so there is never a host-only window cue on this
    // path to consume or stage — the assertion keeps that contract explicit.  A
    // story whose *entry* node opens a window is reached through
    // `start_new_game`, not through the bootstrap.
    debug_assert_no_window_cue(&payload.update);
    Ok(WireBootstrapPayload {
        update: wire_update(&state, payload.update, WireSessionMode::Story),
        asset_ids: payload.asset_ids,
        content_version: payload.content_version,
        chapter_map_available: payload.chapter_map_available,
        default_font: payload.default_font,
    })
}

/// The secondary window's own bootstrap.  It never loads settings, save slots,
/// chapter maps or history: the secondary has normal gameplay and nothing else.
#[tauri::command]
async fn secondary_bootstrap(
    window: tauri::WebviewWindow,
    state: State<'_, EngineState>,
) -> Result<WireBootstrapPayload, WireCommandError> {
    require_secondary(&window)?;
    let _gate = state.session_gate()?;
    state.secondary_bootstrap_payload()
}

#[tauri::command]
async fn start_new_game(
    window: tauri::WebviewWindow,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    if state.replay()?.is_some() {
        return Err(WireCommandError::new(
            WireCommandErrorCode::Runtime,
            "重演期间不能开始新游戏",
        ));
    }
    // A new game is a hard ownership boundary: any secondary window (and the
    // merged ledger, which the runtime just reset) must not outlive it, even
    // when the new game happens to start in the Scene that owns the window.
    let update = state.transact_runtime_forced(
        |runtime| runtime.start_new_game(&state.content),
        true,
    )?;
    state.bump_session_id()?;
    Ok(wire_update(&state, update, WireSessionMode::Story))
}

#[tauri::command]
async fn advance(
    window: tauri::WebviewWindow,
    expected_revision: WireU64,
    source: AdvanceSource,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_main(&window)?;
    let expected_revision = expected_revision.parse().map_err(WireCommandError::from)?;
    let (update, session_id, mode) = state.transact_active_runtime(
        expected_session_id.as_ref(),
        |runtime| runtime.advance(&state.content, expected_revision, source),
    )?;
    Ok(WireRuntimeUpdate::with_session(
        update,
        session_id.into(),
        mode,
    ))
}

#[tauri::command]
async fn choose(
    window: tauri::WebviewWindow,
    choice_id: String,
    expected_revision: WireU64,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_main(&window)?;
    let expected_revision = expected_revision.parse().map_err(WireCommandError::from)?;
    let (update, session_id, mode) = state.transact_active_runtime(
        expected_session_id.as_ref(),
        |runtime| runtime.choose(&state.content, &choice_id, expected_revision),
    )?;
    Ok(WireRuntimeUpdate::with_session(
        update,
        session_id.into(),
        mode,
    ))
}

#[tauri::command]
async fn click_button(
    window: tauri::WebviewWindow,
    instance_id: String,
    expected_revision: WireU64,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_main(&window)?;
    let expected_revision = expected_revision.parse().map_err(WireCommandError::from)?;
    let (update, session_id, mode) = state.transact_active_runtime(
        expected_session_id.as_ref(),
        |runtime| runtime.click_button(&state.content, &instance_id, expected_revision),
    )?;
    Ok(WireRuntimeUpdate::with_session(
        update,
        session_id.into(),
        mode,
    ))
}

#[tauri::command]
async fn presentation_complete(
    window: tauri::WebviewWindow,
    update_id: WireU64,
    outcome: PresentationOutcome,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    let update_id = update_id.parse().map_err(WireCommandError::from)?;
    let has_replay = state.replay()?.is_some();
    if has_replay {
        // Every replay acknowledgement path goes through the replay transaction,
        // which consumes the host-only cue and stages the window work the new
        // replay state implies — including the ending path, whose boundary
        // update is subject to the same host invariant.
        let ending = state
            .replay()?
            .as_ref()
            .is_some_and(|session| session.ending);
        let update = if ending {
            state.transact_replay(|runtime| runtime.finish_replay_boundary(update_id))?
        } else {
            state.transact_replay(|runtime| {
                runtime.presentation_complete(&state.content, update_id, outcome)
            })?
        };
        return Ok(wire_update(&state, update, WireSessionMode::Replay));
    }
    let update = state.transact_runtime(|runtime| {
        runtime.presentation_complete(&state.content, update_id, outcome)
    })?;
    Ok(wire_update(&state, update, WireSessionMode::Story))
}

#[tauri::command]
async fn get_snapshot(
    window: tauri::WebviewWindow,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeSnapshot, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    if let Some(replay) = state.replay()?.as_ref() {
        return Ok(wire_snapshot(
            &state,
            replay.runtime.snapshot().clone(),
            WireSessionMode::Replay,
        ));
    }
    Ok(wire_snapshot(
        &state,
        state.runtime()?.snapshot().clone(),
        WireSessionMode::Story,
    ))
}

#[tauri::command]
async fn secondary_snapshot(
    window: tauri::WebviewWindow,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeSnapshot, WireCommandError> {
    require_secondary(&window)?;
    let _gate = state.session_gate()?;
    let slot = state.secondary()?;
    let session = slot.as_ref().ok_or_else(|| {
        WireCommandError::new(WireCommandErrorCode::Runtime, "当前没有正在运行的副窗口会话")
    })?;
    Ok(WireRuntimeSnapshot::with_session(
        session.runtime.snapshot().clone(),
        session.token.into(),
        WireSessionMode::Secondary,
    ))
}

#[tauri::command]
async fn get_dialogue_history(
    window: tauri::WebviewWindow,
    state: State<'_, EngineState>,
) -> Result<Vec<WireDialogueHistoryEntry>, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    if let Some(replay) = state.replay()?.as_ref() {
        return Ok(replay
            .runtime
            .dialogue_history()
            .iter()
            .cloned()
            .map(Into::into)
            .collect());
    }
    // The main runtime's ledger is the single ordered main+secondary ledger.
    Ok(state
        .runtime()?
        .dialogue_history()
        .iter()
        .cloned()
        .map(Into::into)
        .collect())
}

#[tauri::command]
async fn clear_dialogue_history(
    window: tauri::WebviewWindow,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<(), WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    if let Some(replay) = state.replay()?.as_mut() {
        replay.runtime.clear_dialogue_history();
    } else {
        // History is profile data.  Apply the clear through the same cloned
        // runtime transaction as story commands so a failed profile write
        // cannot leave memory and disk disagreeing.  Clearing also drops the
        // pending append queue, so a later secondary drain cannot resurrect an
        // already-cleared occurrence.
        let mut runtime = state.runtime()?;
        let mut candidate = runtime.clone();
        candidate.clear_dialogue_history();
        state.commit_runtime(&runtime, &candidate)?;
        *runtime = candidate;
    }
    Ok(())
}

#[tauri::command]
async fn get_chapter_map(
    window: tauri::WebviewWindow,
    state: State<'_, EngineState>,
) -> Result<Option<ChapterMapSnapshot>, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state
        .runtime()?
        .chapter_map(&state.content)
        .map_err(WireCommandError::from)
}

#[tauri::command]
async fn start_scene_replay(
    window: tauri::WebviewWindow,
    scene_id: String,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    // Entry is one transaction over the replay runtime, the secondary slot and
    // the native window plan, so a replay can really own the window its own
    // `open_window` node opens or re-points without ever leaving an orphan.
    let update = state.enter_replay(&scene_id)?;
    Ok(wire_update(&state, update, WireSessionMode::Replay))
}

#[tauri::command]
async fn exit_scene_replay(
    window: tauri::WebviewWindow,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireU64, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    state.exit_replay()?;
    Ok(state.current_session_id().into())
}

/// Invalidate outstanding story-side IPC and presentation callbacks when the
/// player leaves the story for the title screen.  The authoritative runtime
/// is intentionally kept intact so "开始" can still start a fresh game, but
/// the host generation makes late acknowledgements fail with
/// `stale_session` instead of mutating that hidden runtime.
#[tauri::command]
async fn invalidate_session(
    window: tauri::WebviewWindow,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireU64, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    // Returning to the title is an ownership boundary: the title screen shows no
    // secondary window and must not leave one running behind it.  The window is
    // destroyed before the session generation is bumped, so a failed destroy
    // leaves the story session exactly as it was.
    state.close_secondary()?;
    let next = state.bump_session_id()?;
    Ok(next.into())
}

#[tauri::command]
fn resolve_assets(
    window: tauri::WebviewWindow,
    asset_ids: Vec<String>,
    state: State<'_, EngineState>,
) -> Result<Vec<ResolvedAsset>, WireCommandError> {
    // Asset resolution is read-only and shared by both windows, but it still
    // requires a host-issued label.
    require_known_window(&window)?;
    state
        .content
        .resolve_assets(&asset_ids)
        .map_err(|error| WireCommandError::new(WireCommandErrorCode::Asset, error.to_string()))
}

#[tauri::command]
fn list_save_slots(
    window: tauri::WebviewWindow,
    state: State<'_, EngineState>,
) -> Result<Vec<SaveSlotSummary>, WireCommandError> {
    require_main(&window)?;
    Ok(state.saves.list())
}

#[tauri::command]
async fn save_slot(
    window: tauri::WebviewWindow,
    request: SaveSlotRequest,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<SaveSlotSummary, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    if state.replay()?.is_some() {
        return Err(WireCommandError::new(
            WireCommandErrorCode::Runtime,
            "重演期间不能存档",
        ));
    }
    let runtime = state.runtime()?;
    if let Some(update_id) = runtime.pending_runtime_update() {
        return Err(WireCommandError::new(
            WireCommandErrorCode::Runtime,
            format!("表现层仍在执行 update {update_id}，暂时不能存档"),
        ));
    }
    // A save captures both sessions atomically, so neither may be mid-ack.
    let secondary_slot = state.secondary()?;
    let secondary_state = match secondary_slot.as_ref() {
        Some(session) => {
            if let Some(update_id) = session.runtime.pending_runtime_update() {
                return Err(WireCommandError::new(
                    WireCommandErrorCode::Runtime,
                    format!("副窗口仍在执行 update {update_id}，暂时不能存档"),
                ));
            }
            // Only a story-owned session is real progress.  Replay play is
            // ephemeral by design, so a replay-owned secondary never reaches a
            // slot (saving is already refused while a replay is live).
            let Some(owning_scene) = session.owner.story_scene() else {
                return Err(WireCommandError::new(
                    WireCommandErrorCode::Runtime,
                    "重演期间不能存档",
                ));
            };
            Some(SecondaryState {
                scene_id: session.scene_id.clone(),
                owning_scene: owning_scene.to_owned(),
                snapshot: session.runtime.snapshot().clone(),
                profile: session.runtime.profile_state(&state.content),
            })
        }
        None => None,
    };
    let history = runtime.dialogue_history().to_vec();
    state
        .saves
        .save(
            &request.slot,
            SlotDocument {
                snapshot: runtime.snapshot(),
                history: &history,
                secondary: secondary_state.as_ref(),
            },
            request.thumbnail_data_url,
        )
        .map_err(save_error)
}

#[tauri::command]
async fn load_slot(
    window: tauri::WebviewWindow,
    slot: String,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    if state.replay()?.is_some() {
        return Err(WireCommandError::new(
            WireCommandErrorCode::Runtime,
            "重演期间不能读档",
        ));
    }
    let loaded = state.saves.load(&slot).map_err(save_error)?;
    let update = state.apply_loaded_slot(loaded)?;
    state.bump_session_id()?;
    Ok(wire_update(&state, update, WireSessionMode::Story))
}

#[tauri::command]
fn load_settings(
    window: tauri::WebviewWindow,
    state: State<'_, EngineState>,
) -> Result<Settings, WireCommandError> {
    require_main(&window)?;
    Ok(state.saves.load_settings())
}

#[tauri::command]
fn save_settings(
    window: tauri::WebviewWindow,
    settings: Settings,
    state: State<'_, EngineState>,
) -> Result<Settings, WireCommandError> {
    require_main(&window)?;
    state.saves.save_settings(settings).map_err(save_error)
}

#[tauri::command]
async fn secondary_advance(
    window: tauri::WebviewWindow,
    expected_revision: WireU64,
    source: AdvanceSource,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_secondary(&window)?;
    let expected_revision = expected_revision.parse().map_err(WireCommandError::from)?;
    let _gate = state.session_gate()?;
    let (update, token) = state.transact_secondary(expected_session_id.as_ref(), |runtime| {
        runtime.advance(&state.content, expected_revision, source)
    })?;
    Ok(wire_secondary_update(token, update))
}

#[tauri::command]
async fn secondary_choose(
    window: tauri::WebviewWindow,
    choice_id: String,
    expected_revision: WireU64,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_secondary(&window)?;
    let expected_revision = expected_revision.parse().map_err(WireCommandError::from)?;
    let _gate = state.session_gate()?;
    let (update, token) = state.transact_secondary(expected_session_id.as_ref(), |runtime| {
        runtime.choose(&state.content, &choice_id, expected_revision)
    })?;
    Ok(wire_secondary_update(token, update))
}

#[tauri::command]
async fn secondary_click_button(
    window: tauri::WebviewWindow,
    instance_id: String,
    expected_revision: WireU64,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_secondary(&window)?;
    let expected_revision = expected_revision.parse().map_err(WireCommandError::from)?;
    let _gate = state.session_gate()?;
    let (update, token) = state.transact_secondary(expected_session_id.as_ref(), |runtime| {
        runtime.click_button(&state.content, &instance_id, expected_revision)
    })?;
    Ok(wire_secondary_update(token, update))
}

#[tauri::command]
async fn secondary_presentation_complete(
    window: tauri::WebviewWindow,
    update_id: WireU64,
    outcome: PresentationOutcome,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_secondary(&window)?;
    let update_id = update_id.parse().map_err(WireCommandError::from)?;
    let _gate = state.session_gate()?;
    let (update, token) = state.transact_secondary(expected_session_id.as_ref(), |runtime| {
        runtime.presentation_complete(&state.content, update_id, outcome)
    })?;
    Ok(wire_secondary_update(token, update))
}

fn save_error(error: SaveError) -> WireCommandError {
    match error {
        SaveError::InvalidSlot(message)
        | SaveError::MissingSlot(message)
        | SaveError::InvalidData(message) => {
            WireCommandError::new(WireCommandErrorCode::Validation, message)
        }
        SaveError::ContentVersion { expected, actual } => WireCommandError::new(
            WireCommandErrorCode::Validation,
            format!("存档内容版本不兼容: 需要 {expected}，实际 {actual}"),
        ),
        SaveError::Io { path, source } => {
            WireCommandError::new(WireCommandErrorCode::Io, source.to_string())
                .with_path(path.to_string_lossy())
        }
    }
}

#[cfg(windows)]
fn disable_browser_features<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> tauri::Result<()> {
    use windows::core::Interface;

    window.with_webview(|webview| unsafe {
        let controller = webview.controller();
        // Best effort: this callback runs in a place the host cannot report back
        // through `show_secondary`, and a panic here would abort the whole
        // process, so a missing interface only degrades hardening.
        let Ok(core) = controller.CoreWebView2() else {
            eprintln!("副窗口 WebView2 CoreWebView2 接口不可用，跳过浏览器特性关闭");
            return;
        };
        let Ok(settings) = core.Settings() else {
            eprintln!("副窗口 WebView2 设置不可用，跳过浏览器特性关闭");
            return;
        };
        let _ = settings.SetAreDefaultContextMenusEnabled(false);
        let _ = settings.SetAreDevToolsEnabled(false);
        let _ = settings.SetIsZoomControlEnabled(false);
        if let Ok(settings3) =
            settings.cast::<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3>()
        {
            let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
        }
    })?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(windows)]
            {
                let window = app
                    .get_webview_window("main")
                    .expect("main WebView window is missing");
                disable_browser_features(&window)?;
            }
            let content_root = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../game")
            } else {
                app.path().resolve("game", BaseDirectory::Resource)?
            };
            let content = ContentCatalog::from_root(content_root)?;
            app.asset_protocol_scope()
                .allow_directory(content.assets_root(), true)?;
            let app_data_root = app.path().app_data_dir()?;
            let saves = SaveManager::new(
                app_data_root.join("saves"),
                content.manifest.content_version.clone(),
            )?;
            let valid_scenes = content.scenes.keys().cloned().collect();
            let valid_locations = content
                .scenes
                .iter()
                .flat_map(|(scene_id, scene)| {
                    scene.nodes.iter().flat_map(move |(node_id, node)| {
                        let node_location = format!("{scene_id}/{node_id}");
                        let mut locations = vec![node_location.clone()];
                        if let SceneNode::LongText {
                            document, steps, ..
                        } = node
                        {
                            let document_id = document.as_deref().unwrap_or(node_id);
                            locations.extend(
                                steps
                                    .iter()
                                    .map(|step| format!("{scene_id}/{document_id}/{}", step.id)),
                            );
                        }
                        locations
                    })
                })
                .collect();
            let (profile, profile_state) = ProfileManager::new_with_content(
                app_data_root,
                &content.manifest.variables,
                content.manifest.content_version.clone(),
                Some(valid_scenes),
                Some(valid_locations),
            )?;
            let runtime = RuntimeEngine::with_profile(&content, profile_state)?;
            app.manage(EngineState {
                content,
                runtime: Mutex::new(runtime),
                replay: Mutex::new(None),
                secondary: Mutex::new(None),
                session_gate: Mutex::new(()),
                replay_generation: AtomicU64::new(0),
                session_id: AtomicU64::new(1),
                secondary_generation: AtomicU64::new(0),
                windows: Arc::new(TauriWindowOps {
                    app: app.handle().clone(),
                    closing_secondary: AtomicBool::new(false),
                    pending_destroy_since: Mutex::new(None),
                    clock: Instant::now,
                }),
                saves,
                profile,
            });
            Ok(())
        })
        // The secondary window may only be destroyed by a host transition. A
        // user/native close request is always prevented so the secondary cannot
        // be closed out from under the story that owns it.
        .on_window_event(|window, event| {
            if window.label() != SECONDARY_WINDOW_LABEL {
                // Closing the main window must not leave the prevented secondary
                // behind. The same host destruction path is used so the close
                // guard can tell it apart from a user close request.
                if window.label() == MAIN_WINDOW_LABEL {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        if let Some(state) = window.app_handle().try_state::<EngineState>() {
                            let _ = state.windows.hide_secondary();
                        }
                    }
                }
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let controlled = window
                    .app_handle()
                    .try_state::<EngineState>()
                    .map(|state| state.windows.is_closing_secondary())
                    .unwrap_or(false);
                if !controlled {
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            secondary_bootstrap,
            start_new_game,
            advance,
            choose,
            click_button,
            presentation_complete,
            secondary_advance,
            secondary_choose,
            secondary_click_button,
            secondary_presentation_complete,
            get_snapshot,
            secondary_snapshot,
            get_dialogue_history,
            clear_dialogue_history,
            get_chapter_map,
            start_scene_replay,
            exit_scene_replay,
            invalidate_session,
            resolve_assets,
            list_save_slots,
            save_slot,
            load_slot,
            load_settings,
            save_settings,
        ])
        .build(tauri::generate_context!())
        .expect("VECTSPACE failed to build")
        .run(|app, event| {
            // Application shutdown must never leave a prevented secondary
            // window orphaned behind an exiting main window.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<EngineState>() {
                    let _ = state.windows.hide_secondary();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, fs, path::PathBuf};

    use tempfile::tempdir;

    use super::*;
    use vectspace_core::model::{
        AdvanceSource, ChapterMapDefinition, ChapterMapHotspot, ChapterMapReplay, ChapterMapReveal,
        CueGate, DialogueHistoryEntry, MutationValue, PresentationCue, PresentationCueKind,
        ScalarValue, SceneDefinition, SceneNode, VariableMap, VariableOperation,
    };

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

    fn secondary_test_catalog() -> ContentCatalog {
        ContentCatalog::from_root(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../game"))
            .unwrap()
    }

    /// An injectable native seam: the window-failure paths must be reachable in
    /// host tests without a real WebView.
    #[derive(Default)]
    struct RecordingWindowOps {
        /// The window cannot be created at all.
        fail_show: AtomicBool,
        /// The window *is* created and then the show fails, exactly like a
        /// `WebviewWindowBuilder` that builds the native window before the
        /// WebView fails: the failure leaves a window behind.
        fail_show_after_create: AtomicBool,
        /// Destruction fails, so a window that exists survives.
        fail_hide: AtomicBool,
        /// Mirror of the production seam: a destroy that the runtime has accepted
        /// but not processed yet.  The label stays registered, so a new owner
        /// must not adopt it.
        queued_destroy: AtomicBool,
        /// Make `hide_secondary` model the real enqueue: the call succeeds and the
        /// label survives until the test releases it.
        defer_destroy: AtomicBool,
        /// Model a queued destroy that the runtime never completes: a retried
        /// destroy fails natively, so the window survives and stops being pending.
        destroy_fails_asynchronously: AtomicBool,
        /// Injected elapsed time since the pending destroy was enqueued, so the
        /// bounded retry is testable without any real timer or sleep.
        pending_destroy_elapsed_ms: AtomicU64,
        /// Native state: whether a secondary window exists right now.  This is
        /// deliberately independent of the host's logical slot, which is what
        /// makes the partial-create/cleanup-failure combination reproducible.
        window_alive: AtomicBool,
        show_calls: AtomicU64,
        replaced_calls: AtomicU64,
        /// Shows that had to refresh a native window that already existed.
        refresh_calls: AtomicU64,
        /// Shows that reused a surviving native window instead of creating one.
        reused_calls: AtomicU64,
        create_calls: AtomicU64,
        hide_calls: AtomicU64,
        /// Recovery attempts for a live logical slot whose window is missing.
        recover_calls: AtomicU64,
        /// Bounded re-attempts of a destroy the runtime never completed.
        destroy_retry_calls: AtomicU64,
    }

    impl RecordingWindowOps {
        /// Let the runtime process a destroy that was only queued.
        fn finish_queued_destroy(&self) {
            self.queued_destroy.store(false, Ordering::Release);
            self.window_alive.store(false, Ordering::Release);
        }

        /// Advance the injected monotonic clock of a pending destroy.
        fn advance_pending_destroy(&self, elapsed: Duration) {
            self.pending_destroy_elapsed_ms
                .store(elapsed.as_millis() as u64, Ordering::Release);
        }

        /// Mirror of the production bounded retry: at most one re-attempt per
        /// call, and only after the grace period.  Returns whether the destroy is
        /// still pending afterwards.
        fn retry_pending_destroy_once(&self) -> bool {
            if !self.queued_destroy.load(Ordering::Acquire) {
                return false;
            }
            let elapsed =
                Duration::from_millis(self.pending_destroy_elapsed_ms.load(Ordering::Acquire));
            if !pending_destroy_retry_due(elapsed) {
                return true;
            }
            self.destroy_retry_calls.fetch_add(1, Ordering::AcqRel);
            self.advance_pending_destroy(Duration::ZERO);
            if self.destroy_fails_asynchronously.load(Ordering::Acquire) {
                // The retried destroy fails natively: the window survives and is
                // no longer queued, so a later show adopts and refreshes it.
                self.queued_destroy.store(false, Ordering::Release);
                return false;
            }
            true
        }
    }

    impl NativeWindowOps for RecordingWindowOps {
        fn show_secondary(&self, replaced: bool) -> Result<(), WireCommandError> {
            self.show_calls.fetch_add(1, Ordering::AcqRel);
            if replaced {
                self.replaced_calls.fetch_add(1, Ordering::AcqRel);
            }
            if self.queued_destroy.load(Ordering::Acquire) {
                self.retry_pending_destroy_once();
            }
            if self.fail_show.load(Ordering::Acquire) {
                return Err(WireCommandError::new(
                    WireCommandErrorCode::Internal,
                    "测试: 无法创建副窗口",
                ));
            }
            if self.fail_show_after_create.load(Ordering::Acquire) {
                self.window_alive.store(true, Ordering::Release);
                return Err(WireCommandError::new(
                    WireCommandErrorCode::Internal,
                    "测试: 副窗口创建失败（已残留原生窗口）",
                ));
            }
            let reused = self.window_alive.load(Ordering::Acquire);
            // The same decision the production seam makes, so the injected
            // failure paths cannot drift away from the real one.
            match native_show_action(reused, self.queued_destroy.load(Ordering::Acquire)) {
                NativeShowAction::RefusePendingDestroy => {
                    return Err(WireCommandError::new(
                        WireCommandErrorCode::Runtime,
                        "测试: 副窗口正在关闭，拒绝复用待销毁的窗口",
                    ));
                }
                NativeShowAction::Create => {
                    self.create_calls.fetch_add(1, Ordering::AcqRel);
                }
                NativeShowAction::Reuse => {
                    self.reused_calls.fetch_add(1, Ordering::AcqRel);
                }
            }
            self.window_alive.store(true, Ordering::Release);
            // Mirrors the production rule: a window that already existed is
            // refreshed even when the logical `replaced` flag is false.
            if needs_session_refresh(replaced, reused) {
                self.refresh_calls.fetch_add(1, Ordering::AcqRel);
            }
            Ok(())
        }

        fn hide_secondary(&self) -> Result<(), WireCommandError> {
            self.hide_calls.fetch_add(1, Ordering::AcqRel);
            if self.fail_hide.load(Ordering::Acquire) {
                return Err(WireCommandError::new(
                    WireCommandErrorCode::Internal,
                    "测试: 无法关闭副窗口",
                ));
            }
            if self.defer_destroy.load(Ordering::Acquire) {
                // The destroy was accepted but not processed: the label is still
                // registered and must not be adopted by a new owner.
                self.queued_destroy.store(true, Ordering::Release);
                self.advance_pending_destroy(Duration::ZERO);
                return Ok(());
            }
            self.queued_destroy.store(false, Ordering::Release);
            self.window_alive.store(false, Ordering::Release);
            Ok(())
        }

        fn reconcile_secondary(&self, expected_live: bool) -> Result<bool, WireCommandError> {
            self.recover_calls.fetch_add(1, Ordering::AcqRel);
            let alive = self.window_alive.load(Ordering::Acquire);
            if alive && self.queued_destroy.load(Ordering::Acquire) {
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
            self.create_calls.fetch_add(1, Ordering::AcqRel);
            self.window_alive.store(true, Ordering::Release);
            Ok(true)
        }
    }

    /// Build a host state over `content` with the given native seam.  The
    /// content is read-only here: no project file is ever written.
    fn secondary_state_with_content(
        directory: &tempfile::TempDir,
        content: ContentCatalog,
        windows: Arc<dyn NativeWindowOps>,
    ) -> EngineState {
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
        EngineState {
            content,
            runtime: Mutex::new(runtime),
            replay: Mutex::new(None),
            secondary: Mutex::new(None),
            session_gate: Mutex::new(()),
            replay_generation: AtomicU64::new(0),
            session_id: AtomicU64::new(1),
            secondary_generation: AtomicU64::new(0),
            windows,
            saves,
            profile,
        }
    }

    /// Build a host state over the real game content with no secondary.
    fn secondary_test_state(directory: &tempfile::TempDir) -> EngineState {
        secondary_state_with_content(
            directory,
            secondary_test_catalog(),
            Arc::new(RecordingWindowOps::default()),
        )
    }

    /// Put one live secondary session in the slot, exactly like the host does
    /// when the main story reaches `open_window`: the transition runs through the
    /// real commit path, which strips the control cue, publishes the staged
    /// session's opening effects and installs the slot.
    fn stage_test_secondary(state: &EngineState, scene_id: &str) -> u64 {
        open_secondary_transition(state, scene_id).unwrap();
        state.secondary().unwrap().as_ref().unwrap().token
    }

    /// Drive a main-story transition whose update carries one `open_window`
    /// control cue, which is what the real content would emit.  The cue is
    /// appended by hand so this fixture never depends on authored content (the
    /// working tree's chapter 0 does contain `open_window` nodes; the test stays
    /// independent of that in-flight content edit).
    fn open_secondary_transition(
        state: &EngineState,
        scene_id: &str,
    ) -> Result<MainTransition, WireCommandError> {
        state.commit_main_runtime(open_window_operation(state, scene_id))
    }

    /// The same transition including its native window step, i.e. the exact path
    /// a real `open_window` command takes.
    fn show_test_secondary(
        state: &EngineState,
        scene_id: &str,
    ) -> Result<RuntimeUpdate, WireCommandError> {
        state.transact_runtime(open_window_operation(state, scene_id))
    }

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

    /// The real content's story entry rewritten to open the secondary window and
    /// then park on a runtime-gated `wait`, which is exactly the authored
    /// combination that used to trip the host's cue assertion.
    fn open_window_then_wait_content() -> ContentCatalog {
        let mut content = secondary_test_catalog();
        let scene = content.scenes.get_mut("prologue").unwrap();
        let original_entry = scene.entry.clone();
        scene.entry = "open_secondary".to_owned();
        scene.nodes.insert(
            "open_secondary".to_owned(),
            SceneNode::OpenWindow {
                scene: "ambience_lab".to_owned(),
                next: "hold".to_owned(),
            },
        );
        scene.nodes.insert(
            "hold".to_owned(),
            SceneNode::Wait {
                duration_ms: 10,
                next: original_entry,
            },
        );
        content
    }

    /// The story entry rewritten to a chain that opens the window and then leaves
    /// the Scene, so a window request and a Scene change arrive in the same
    /// update: the request must win over tearing the previous owner down.
    fn open_window_then_jump_content() -> ContentCatalog {
        let mut content = secondary_test_catalog();
        let sandbox_entry = content
            .scenes
            .get("sandbox")
            .expect("the sandbox scene exists")
            .entry
            .clone();
        let scene = content.scenes.get_mut("prologue").unwrap();
        scene.entry = "open_secondary".to_owned();
        scene.nodes.insert(
            "open_secondary".to_owned(),
            SceneNode::OpenWindow {
                scene: "ambience_lab".to_owned(),
                next: "leave_scene".to_owned(),
            },
        );
        scene.nodes.insert(
            "leave_scene".to_owned(),
            SceneNode::Jump {
                scene: Some("sandbox".to_owned()),
                target: sandbox_entry,
            },
        );
        content
    }

    /// The story entry rewritten to two consecutive `open_window` nodes, which
    /// the runtime reports in one update because it keeps going past both.
    fn open_window_chain_content() -> ContentCatalog {
        let mut content = secondary_test_catalog();
        let scene = content.scenes.get_mut("prologue").unwrap();
        let original_entry = scene.entry.clone();
        scene.entry = "open_first".to_owned();
        scene.nodes.insert(
            "open_first".to_owned(),
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
        content
    }

    /// The same entry plus a secondary Scene whose opening nodes consume and
    /// write the shared Save/Profile maps before showing their first line.
    fn shared_state_secondary_content() -> ContentCatalog {
        let mut content = open_window_then_wait_content();
        // The main command itself writes a shared value before opening the
        // window, so the secondary must be seeded from the *candidate* runtime.
        let prologue = content.scenes.get_mut("prologue").unwrap();
        prologue.entry = "seed_score".to_owned();
        prologue.nodes.insert(
            "seed_score".to_owned(),
            SceneNode::Set {
                variable: "score".to_owned(),
                op: VariableOperation::Assign,
                value: Some(MutationValue::Literal(ScalarValue::Integer(5))),
                next: "open_secondary".to_owned(),
            },
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
            SceneNode::Set {
                variable: "score".to_owned(),
                op: VariableOperation::Add,
                value: Some(MutationValue::Literal(ScalarValue::Integer(1))),
                next: "seed_say".to_owned(),
            },
        );
        scene.nodes.insert(
            "seed_say".to_owned(),
            SceneNode::Say {
                speaker: None,
                text: "[var=score]".to_owned(),
                mode: vectspace_core::model::DialogueMode::Start,
                page_id: None,
                speed_cps: None,
                reveal_animation: None,
                next: original_entry,
            },
        );
        content
    }

    /// Give the secondary Scene a runtime-gated entry so staging it leaves a
    /// pending presentation behind.
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

    /// One hotspot that is visible and enterable without finishing the Scene, so
    /// a replay can be started in a host test.
    fn replay_hotspot(scene_id: &str) -> ChapterMapHotspot {
        ChapterMapHotspot {
            id: format!("hotspot_{scene_id}"),
            scene_id: scene_id.to_owned(),
            title: scene_id.to_owned(),
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
        }
    }

    fn replay_say(text: &str, next: &str) -> SceneNode {
        SceneNode::Say {
            speaker: None,
            text: text.to_owned(),
            mode: vectspace_core::model::DialogueMode::Start,
            page_id: None,
            speed_cps: None,
            reveal_animation: None,
            next: next.to_owned(),
        }
    }

    /// A replay fixture built entirely in memory: its entry opens the single
    /// secondary window, a second node re-points it, a third ends the replay,
    /// and a second fixture Scene leaves its own Scene through a jump.  Nothing
    /// here depends on the authored content of the working tree.
    fn replay_test_content() -> ContentCatalog {
        let mut content = secondary_test_catalog();
        let sandbox_entry = content
            .scenes
            .get("sandbox")
            .expect("the sandbox scene exists")
            .entry
            .clone();
        let cross_entry = content
            .scenes
            .get("ambience_lab")
            .expect("the ambience scene exists")
            .entry
            .clone();
        content.scenes.insert(
            "replay_lab".to_owned(),
            SceneDefinition {
                schema_version: 1,
                id: "replay_lab".to_owned(),
                entry: "open_child".to_owned(),
                nodes: BTreeMap::from([
                    (
                        "open_child".to_owned(),
                        SceneNode::OpenWindow {
                            scene: "ambience_lab".to_owned(),
                            next: "line".to_owned(),
                        },
                    ),
                    ("line".to_owned(), replay_say("replay line", "open_again")),
                    (
                        "open_again".to_owned(),
                        SceneNode::OpenWindow {
                            scene: "surface_parity".to_owned(),
                            next: "rest".to_owned(),
                        },
                    ),
                    ("rest".to_owned(), replay_say("replay rest", "end")),
                    ("end".to_owned(), SceneNode::End),
                ]),
            },
        );
        content.scenes.insert(
            "replay_cross".to_owned(),
            SceneDefinition {
                schema_version: 1,
                id: "replay_cross".to_owned(),
                entry: "open_child".to_owned(),
                nodes: BTreeMap::from([
                    (
                        "open_child".to_owned(),
                        SceneNode::OpenWindow {
                            scene: "ambience_lab".to_owned(),
                            next: "line".to_owned(),
                        },
                    ),
                    ("line".to_owned(), replay_say("cross line", "jump")),
                    (
                        "jump".to_owned(),
                        SceneNode::Jump {
                            scene: Some("sandbox".to_owned()),
                            target: sandbox_entry,
                        },
                    ),
                    ("end".to_owned(), SceneNode::End),
                ]),
            },
        );
        // Keep a scene whose entry is a dialogue reachable for the secondary
        // scene, so every fixture replay opens the same authored window target.
        let ambience = content.scenes.get_mut("ambience_lab").unwrap();
        assert_eq!(ambience.entry, cross_entry);
        content.chapter_map = Some(ChapterMapDefinition {
            schema_version: 1,
            width: 1920,
            height: 1080,
            view_x: 0,
            view_y: 0,
            background: None,
            decorations: Vec::new(),
            hotspots: vec![replay_hotspot("replay_lab"), replay_hotspot("replay_cross")],
        });
        content
    }

    /// The replay entry rewritten so the window it opens is followed by a
    /// runtime-gated node: the authored combination whose acknowledgement must
    /// survive the control-cue strip.
    fn replay_gated_entry(mut content: ContentCatalog) -> ContentCatalog {
        let scene = content.scenes.get_mut("replay_lab").unwrap();
        scene.nodes.insert(
            "open_child".to_owned(),
            SceneNode::OpenWindow {
                scene: "ambience_lab".to_owned(),
                next: "hold".to_owned(),
            },
        );
        scene.nodes.insert(
            "hold".to_owned(),
            SceneNode::Wait {
                duration_ms: 10,
                next: "line".to_owned(),
            },
        );
        content
    }

    fn replay_state(
        directory: &tempfile::TempDir,
        content: ContentCatalog,
        ops: &Arc<RecordingWindowOps>,
    ) -> EngineState {
        secondary_state_with_content(directory, content, ops.clone())
    }

    fn has_open_window_cue(update: &RuntimeUpdate) -> bool {
        update
            .cues
            .iter()
            .any(|cue| matches!(cue.kind, PresentationCueKind::OpenWindow { .. }))
    }

    #[test]
    fn window_routing_is_label_based_and_rejects_unknown_labels() {
        assert_eq!(role_for_label("main"), Some(WindowRole::Main));
        assert_eq!(role_for_label("secondary"), Some(WindowRole::Secondary));
        // Anything the host did not create is denied, so a future window cannot
        // inherit main authority by accident.
        for label in ["", "Main", "secondary ", "main-window", "evil"] {
            assert_eq!(role_for_label(label), None, "{label} must not route");
        }
    }

    #[test]
    fn open_window_cue_is_consumed_once_and_never_reaches_a_webview() {
        let catalog = secondary_test_catalog();
        let snapshot = RuntimeEngine::new(&catalog).unwrap().snapshot().clone();
        let mut update = RuntimeUpdate {
            update_id: 1,
            snapshot,
            cues: vec![
                PresentationCue {
                    cue_id: 1,
                    gate: CueGate::None,
                    kind: PresentationCueKind::OpenWindow {
                        scene: "ambience_lab".to_owned(),
                    },
                },
                PresentationCue {
                    cue_id: 2,
                    gate: CueGate::None,
                    kind: PresentationCueKind::Delay { duration_ms: 10 },
                },
            ],
            requires_ack: false,
        };
        assert_eq!(
            take_open_window_request(&mut update).as_deref(),
            Some("ambience_lab")
        );
        // Stripped: only the ordinary presentation cue is left for the WebView.
        assert_eq!(update.cues.len(), 1);
        assert!(matches!(
            update.cues[0].kind,
            PresentationCueKind::Delay { .. }
        ));
        // A retry cannot re-trigger the native side effect.
        assert_eq!(take_open_window_request(&mut update), None);
    }

    #[test]
    fn open_window_followed_by_a_runtime_gated_node_keeps_its_acknowledgement() {
        let catalog = secondary_test_catalog();
        let snapshot = RuntimeEngine::new(&catalog).unwrap().snapshot().clone();
        let mut update = RuntimeUpdate {
            update_id: 4,
            snapshot: snapshot.clone(),
            cues: vec![
                PresentationCue {
                    cue_id: 1,
                    gate: CueGate::None,
                    kind: PresentationCueKind::OpenWindow {
                        scene: "ambience_lab".to_owned(),
                    },
                },
                PresentationCue {
                    cue_id: 2,
                    gate: CueGate::Runtime,
                    kind: PresentationCueKind::Delay { duration_ms: 250 },
                },
            ],
            requires_ack: true,
        };
        assert_eq!(
            take_open_window_request(&mut update).as_deref(),
            Some("ambience_lab")
        );
        // The remaining presentation still needs exactly its own
        // acknowledgement, so a valid `open_window` + `wait` combination never
        // trips the host's invariant assertion.
        assert!(update.requires_ack);
        assert_eq!(update.cues.len(), 1);
        assert_eq!(update.cues[0].gate, CueGate::Runtime);

        // The mirror case: a control cue that is *not* accompanied by any
        // runtime-gated presentation must not keep requiring an ack the runtime
        // is not waiting for.
        let mut plain = RuntimeUpdate {
            update_id: 5,
            snapshot,
            cues: vec![PresentationCue {
                cue_id: 3,
                gate: CueGate::None,
                kind: PresentationCueKind::OpenWindow {
                    scene: "ambience_lab".to_owned(),
                },
            }],
            requires_ack: false,
        };
        assert_eq!(
            take_open_window_request(&mut plain).as_deref(),
            Some("ambience_lab")
        );
        assert!(!plain.requires_ack);
        assert!(plain.cues.is_empty());
    }

    #[test]
    fn multiple_open_window_cues_in_one_update_keep_the_last_target() {
        let catalog = secondary_test_catalog();
        let snapshot = RuntimeEngine::new(&catalog).unwrap().snapshot().clone();
        let mut update = RuntimeUpdate {
            update_id: 7,
            snapshot,
            cues: vec![
                PresentationCue {
                    cue_id: 1,
                    gate: CueGate::None,
                    kind: PresentationCueKind::OpenWindow {
                        scene: "ambience_lab".to_owned(),
                    },
                },
                PresentationCue {
                    cue_id: 2,
                    gate: CueGate::None,
                    kind: PresentationCueKind::OpenWindow {
                        scene: "surface_parity".to_owned(),
                    },
                },
                PresentationCue {
                    cue_id: 3,
                    gate: CueGate::Runtime,
                    kind: PresentationCueKind::Delay { duration_ms: 10 },
                },
            ],
            requires_ack: true,
        };
        // The runtime keeps going past every `open_window` node on the way to this
        // update, and a repeated `open_window` replaces the one slot: the last
        // request is the one that decides what the window shows.
        assert_eq!(
            take_open_window_request(&mut update).as_deref(),
            Some("surface_parity")
        );
        assert!(update.cues.len() == 1);
        assert_eq!(update.cues[0].gate, CueGate::Runtime);
        assert!(update.requires_ack);
    }

    #[test]
    fn a_new_game_entry_open_window_opens_the_window_instead_of_dropping_it() {
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = secondary_state_with_content(
            &directory,
            open_window_then_wait_content(),
            ops.clone(),
        );
        // `start_new_game` is the story's real entry, and it forces the previous
        // secondary down: a window request in that same update takes precedence.
        let update = state
            .transact_runtime_forced(
                |runtime| runtime.start_new_game(&state.content),
                true,
            )
            .unwrap();
        assert!(!has_open_window_cue(&update));
        assert!(update.requires_ack, "the following `wait` keeps its ack");
        let slot = state.secondary().unwrap();
        let session = slot
            .as_ref()
            .expect("the entry's open_window must open the window");
        assert_eq!(session.scene_id, "ambience_lab");
        assert!(matches!(session.owner, SecondaryOwner::Story { .. }));
        assert_eq!(ops.create_calls.load(Ordering::Acquire), 1);
    }

    #[test]
    fn an_entry_chain_that_opens_a_window_then_leaves_the_scene_keeps_the_request() {
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = secondary_state_with_content(
            &directory,
            open_window_then_jump_content(),
            ops.clone(),
        );
        let update = state
            .transact_runtime_forced(
                |runtime| runtime.start_new_game(&state.content),
                true,
            )
            .unwrap();
        assert!(!has_open_window_cue(&update));
        assert_eq!(update.snapshot.location.scene_id, "sandbox");
        // The Scene the update landed in owns the window it asked for.
        let slot = state.secondary().unwrap();
        let session = slot
            .as_ref()
            .expect("the request wins over the Scene change in the same update");
        assert_eq!(session.scene_id, "ambience_lab");
        assert_eq!(
            session.owner,
            SecondaryOwner::Story {
                scene_id: "sandbox".to_owned()
            }
        );
        assert_eq!(ops.create_calls.load(Ordering::Acquire), 1);
    }

    #[test]
    fn a_chain_of_open_window_nodes_shows_only_the_last_target() {
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = secondary_state_with_content(
            &directory,
            open_window_chain_content(),
            ops.clone(),
        );
        let update = state
            .transact_runtime(|runtime| runtime.start_new_game(&state.content))
            .unwrap();
        assert!(!has_open_window_cue(&update));
        let slot = state.secondary().unwrap();
        let session = slot
            .as_ref()
            .expect("the chain opens the one window");
        // The last request wins and no intermediate secondary was ever created.
        assert_eq!(session.scene_id, "surface_parity");
        assert_eq!(ops.show_calls.load(Ordering::Acquire), 1);
        assert_eq!(ops.create_calls.load(Ordering::Acquire), 1);
    }

    #[test]
    fn the_pending_destroy_retry_is_a_bounded_grace_not_a_wait() {
        assert!(!pending_destroy_retry_due(Duration::ZERO));
        assert!(!pending_destroy_retry_due(Duration::from_millis(1999)));
        assert!(pending_destroy_retry_due(SECONDARY_PENDING_DESTROY_GRACE));
    }

    #[test]
    fn a_pending_destroy_is_retried_once_after_the_grace_period() {
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = replay_state(&directory, replay_test_content(), &ops);
        state.enter_replay("replay_lab").unwrap();

        // The replay exits and the runtime accepts the destroy but never
        // completes it: the label stays registered and queued for destruction.
        ops.defer_destroy.store(true, Ordering::Release);
        state.exit_replay().unwrap();
        assert!(ops.queued_destroy.load(Ordering::Acquire));

        // Before the grace period a queued label is never adopted and nothing is
        // re-attempted.
        assert!(state.enter_replay("replay_lab").is_err());
        assert_eq!(ops.destroy_retry_calls.load(Ordering::Acquire), 0);

        // After the grace period exactly one bounded retry runs on the next
        // transition.  It fails natively here, so the window survives and is no
        // longer pending: the transition adopts and refreshes it instead of being
        // refused forever.
        ops.advance_pending_destroy(Duration::from_secs(3));
        ops.destroy_fails_asynchronously.store(true, Ordering::Release);
        state.enter_replay("replay_lab").unwrap();
        assert_eq!(ops.destroy_retry_calls.load(Ordering::Acquire), 1);
        assert!(!ops.queued_destroy.load(Ordering::Acquire));
        assert!(state.secondary().unwrap().is_some());

        // A retry that is accepted again leaves the label queued and still not
        // adopted: one attempt per transition, and one whole grace period between
        // attempts.
        ops.destroy_fails_asynchronously.store(false, Ordering::Release);
        ops.defer_destroy.store(true, Ordering::Release);
        state.exit_replay().unwrap();
        ops.advance_pending_destroy(Duration::from_secs(3));
        assert!(state.enter_replay("replay_lab").is_err());
        assert_eq!(ops.destroy_retry_calls.load(Ordering::Acquire), 2);
        assert!(ops.queued_destroy.load(Ordering::Acquire));
        // Nothing adopted the pending-close label and no replay was installed.
        assert!(state.replay().unwrap().is_none());
        assert!(state.secondary().unwrap().is_none());

        // Once the runtime really processes the destroy the label is free again.
        ops.finish_queued_destroy();
        ops.defer_destroy.store(false, Ordering::Release);
        state.enter_replay("replay_lab").unwrap();
        assert!(state.secondary().unwrap().is_some());
    }

    #[test]
    fn one_secondary_slot_is_reused_on_replace_and_cleared_on_scene_change() {
        let directory = tempdir().unwrap();
        let state = secondary_test_state(&directory);
        let committed = state.runtime().unwrap().clone();

        let first = stage_test_secondary(&state, "ambience_lab");
        assert_eq!(
            state
                .secondary()
                .unwrap()
                .as_ref()
                .map(|slot| slot.scene_id.clone()),
            Some("ambience_lab".to_owned())
        );

        // Repeating open_window stages a re-point of the same slot with a fresh
        // token instead of creating a second secondary.
        let staged = state
            .stage_main_transition(&committed, Some("ambience_lab".to_owned()), false, false)
            .unwrap();
        assert_eq!(staged.plan, SecondaryPlan::Show { replaced: true });
        let replaced = staged.session.as_ref().unwrap().token;
        assert_eq!(replaced, first + 1);
        // Staging is only a candidate: the live slot is untouched until the
        // transition commits its profile write and native step.
        assert_eq!(
            state.secondary().unwrap().as_ref().map(|slot| slot.token),
            Some(first)
        );
        *state.secondary().unwrap() = staged.session;

        // An undeclared Scene is rejected and leaves the live session intact.
        assert!(state
            .stage_main_transition(&committed, Some("does_not_exist".to_owned()), false, false)
            .is_err());
        assert_eq!(
            state.secondary().unwrap().as_ref().map(|slot| slot.token),
            Some(replaced)
        );

        // Leaving the owning main Scene tears the secondary down.
        let staged = state
            .stage_main_transition(&committed, None, true, false)
            .unwrap();
        assert_eq!(staged.plan, SecondaryPlan::Hide);
        assert!(staged.session.is_none());
        *state.secondary().unwrap() = staged.session;
        assert!(state.secondary().unwrap().is_none());
    }

    #[test]
    fn secondary_commands_require_the_current_token() {
        let directory = tempdir().unwrap();
        let state = secondary_test_state(&directory);
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
        let directory = tempdir().unwrap();
        let state = secondary_test_state(&directory);
        let catalog = &state.content;

        // The main story produced its own occurrences first, so ordering is
        // visible in the merged ledger.
        state
            .commit_main_runtime(|runtime| runtime.start_new_game(catalog))
            .unwrap();
        state
            .commit_main_runtime(|runtime| {
                runtime.extend_dialogue_history(vec![history_entry(0, "prologue/host_merged")]);
                Ok(runtime.bootstrap(catalog).update)
            })
            .unwrap();
        let main_prompts = state
            .runtime()
            .unwrap()
            .dialogue_history()
            .iter()
            .map(|entry| entry.prompt_id.clone())
            .collect::<Vec<_>>();
        assert!(main_prompts.contains(&"prologue/host_merged".to_owned()));

        // The secondary opens after the main story is already running.
        let token = stage_test_secondary(&state, "ambience_lab");

        let (update, returned) = state
            .transact_secondary(Some(&WireU64::from(token)), |runtime| {
                // A secondary command that writes shared Save/Profile variables
                // and then advances its own story.
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
        // The secondary runtime really advanced under its own revision
        // namespace, independent of the main story's revision.
        assert_eq!(
            state
                .secondary()
                .unwrap()
                .as_ref()
                .unwrap()
                .runtime
                .snapshot()
                .revision,
            update.snapshot.revision
        );

        // Local variables are published back to the main runtime, which stays
        // the authority for the shared maps.
        let main = state.runtime().unwrap();
        assert_eq!(
            main.snapshot().variables.get("score"),
            Some(&ScalarValue::Integer(9))
        );
        assert_eq!(
            main.profile_variables_map().get("ending_seen"),
            Some(&ScalarValue::Boolean(true))
        );

        // The secondary occurrence is appended to the end of the merged ledger
        // in occurrence order, and the whole ledger is what gets persisted.
        let ledger = main.dialogue_history().to_vec();
        assert!(ledger.len() > main_prompts.len());
        assert_eq!(
            ledger[..main_prompts.len()]
                .iter()
                .map(|entry| entry.prompt_id.clone())
                .collect::<Vec<_>>(),
            main_prompts
        );
        assert!(
            ledger[
                main_prompts.len()..
            ]
            .iter()
            .all(|entry| entry.prompt_id.starts_with("ambience_lab/")),
            "every merged occurrence after the main prefix belongs to the secondary scene"
        );
        assert!(
            ledger
                .iter()
                .any(|entry| entry.prompt_id == "ambience_lab/intro"),
            "the secondary window's opening line joins the merged ledger"
        );
        assert_eq!(
            ledger.iter().map(|entry| entry.entry_id).collect::<Vec<_>>(),
            (1..=ledger.len() as u64).collect::<Vec<_>>(),
            "the merged ledger stays canonically numbered"
        );
        assert_eq!(main.profile_state(catalog).dialogue_history, ledger);
        let on_disk: serde_json::Value = serde_json::from_slice(
            &fs::read(directory.path().join("profile.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            on_disk["dialogue_history"].as_array().map(Vec::len),
            Some(ledger.len()),
            "the merged ledger reaches the profile file"
        );
    }

    #[test]
    fn each_secondary_command_starts_from_the_main_authoritative_maps() {
        let directory = tempdir().unwrap();
        let state = secondary_test_state(&directory);
        let catalog = &state.content;
        let token = stage_test_secondary(&state, "ambience_lab");
        state
            .commit_main_runtime(|runtime| runtime.start_new_game(catalog))
            .unwrap();
        // The main runtime is the single authority for the shared maps.
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
    fn failed_profile_write_rolls_back_the_secondary_command() {
        let directory = tempdir().unwrap();
        let state = secondary_test_state(&directory);
        let catalog = &state.content;
        let token = stage_test_secondary(&state, "ambience_lab");
        let before_main = state.runtime().unwrap().snapshot().clone();
        let before_secondary = state
            .secondary()
            .unwrap()
            .as_ref()
            .unwrap()
            .runtime
            .snapshot()
            .clone();
        // Make the profile unwritable so the commit must abort.
        fs::remove_dir_all(directory.path()).unwrap();

        let result = state.transact_secondary(Some(&WireU64::from(token)), |runtime| {
            runtime.set_save_variables(VariableMap::from([(
                "score".to_owned(),
                ScalarValue::Integer(3),
            )]));
            // A shared Profile-scope write is part of the persisted profile
            // state, so the commit must attempt the (now unwritable) save.
            runtime.set_profile_variables(VariableMap::from([(
                "ending_seen".to_owned(),
                ScalarValue::Boolean(true),
            )]));
            let revision = runtime.snapshot().revision;
            runtime.advance(catalog, revision, AdvanceSource::Manual)
        });
        assert!(result.is_err());
        assert_eq!(state.runtime().unwrap().snapshot(), &before_main);
        assert_eq!(
            state
                .secondary()
                .unwrap()
                .as_ref()
                .unwrap()
                .runtime
                .snapshot(),
            &before_secondary
        );
    }

    #[test]
    fn failed_profile_persistence_rolls_back_the_entire_runtime_command() {
        let mut content =
            ContentCatalog::from_root(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../game"))
                .unwrap();
        let scene = content.scenes.get_mut("prologue").unwrap();
        let original_entry = scene.entry.clone();
        scene.entry = "set_profile_transaction".to_owned();
        scene.nodes.insert(
            scene.entry.clone(),
            SceneNode::Set {
                variable: "ending_seen".to_owned(),
                op: VariableOperation::Assign,
                value: Some(MutationValue::Literal(ScalarValue::Boolean(true))),
                next: original_entry,
            },
        );

        let directory = tempdir().unwrap();
        let saves = SaveManager::new(
            directory.path().join("saves"),
            content.manifest.content_version.clone(),
        )
        .unwrap();
        let (profile, profile_state) = ProfileManager::new(
            directory.path().to_path_buf(),
            &content.manifest.variables,
            content.manifest.content_version.clone(),
        )
        .unwrap();
        let runtime = RuntimeEngine::with_profile(&content, profile_state).unwrap();
        let state = EngineState {
            content,
            runtime: Mutex::new(runtime),
            replay: Mutex::new(None),
            secondary: Mutex::new(None),
            session_gate: Mutex::new(()),
            replay_generation: AtomicU64::new(0),
            session_id: AtomicU64::new(1),
            secondary_generation: AtomicU64::new(0),
            windows: Arc::new(RecordingWindowOps::default()),
            saves,
            profile,
        };
        let before = state.runtime().unwrap().snapshot().clone();
        assert!(state.check_session(Some(&WireU64::from(1))).is_ok());
        assert!(matches!(
            state.check_session(None).unwrap_err().code,
            WireCommandErrorCode::StaleSession
        ));
        state.bump_session_id().unwrap();
        assert!(matches!(
            state
                .check_session(Some(&WireU64::from(1)))
                .unwrap_err()
                .code,
            WireCommandErrorCode::StaleSession
        ));
        assert!(state.check_session(Some(&WireU64::from(2))).is_ok());
        fs::remove_dir_all(directory.path()).unwrap();

        let result = state.commit_main_runtime(|runtime| runtime.start_new_game(&state.content));
        assert!(result.is_err());
        let runtime = state.runtime().unwrap();
        assert_eq!(runtime.snapshot(), &before);
        assert_eq!(
            runtime
                .profile_state(&state.content)
                .variables
                .get("ending_seen"),
            Some(&ScalarValue::Boolean(false))
        );
    }

    #[test]
    fn failed_variable_operation_rolls_back_the_entire_runtime_command() {
        let mut content =
            ContentCatalog::from_root(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../game"))
                .unwrap();
        let scene = content.scenes.get_mut("prologue").unwrap();
        let original_entry = scene.entry.clone();
        scene.entry = "prepare_overflow".to_owned();
        scene.nodes.insert(
            "prepare_overflow".to_owned(),
            SceneNode::Set {
                variable: "score".to_owned(),
                op: VariableOperation::Assign,
                value: Some(MutationValue::Literal(ScalarValue::Integer(i64::MAX))),
                next: "overflow".to_owned(),
            },
        );
        scene.nodes.insert(
            "overflow".to_owned(),
            SceneNode::Set {
                variable: "score".to_owned(),
                op: VariableOperation::Add,
                value: Some(MutationValue::Literal(ScalarValue::Integer(1))),
                next: original_entry,
            },
        );

        let directory = tempdir().unwrap();
        let saves = SaveManager::new(
            directory.path().join("saves"),
            content.manifest.content_version.clone(),
        )
        .unwrap();
        let (profile, profile_state) = ProfileManager::new(
            directory.path().to_path_buf(),
            &content.manifest.variables,
            content.manifest.content_version.clone(),
        )
        .unwrap();
        let runtime = RuntimeEngine::with_profile(&content, profile_state).unwrap();
        let state = EngineState {
            content,
            runtime: Mutex::new(runtime),
            replay: Mutex::new(None),
            secondary: Mutex::new(None),
            session_gate: Mutex::new(()),
            replay_generation: AtomicU64::new(0),
            session_id: AtomicU64::new(1),
            secondary_generation: AtomicU64::new(0),
            windows: Arc::new(RecordingWindowOps::default()),
            saves,
            profile,
        };
        let before = state.runtime().unwrap().snapshot().clone();
        let result = state.commit_main_runtime(|runtime| runtime.start_new_game(&state.content));
        assert!(result.unwrap_err().message.contains("溢出"));
        assert_eq!(state.runtime().unwrap().snapshot(), &before);
    }

    #[test]
    fn failed_read_history_persistence_rolls_back_location_revision_and_read_set() {
        let content =
            ContentCatalog::from_root(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../game"))
                .unwrap();
        let directory = tempdir().unwrap();
        let saves = SaveManager::new(
            directory.path().join("saves"),
            content.manifest.content_version.clone(),
        )
        .unwrap();
        let (profile, profile_state) = ProfileManager::new(
            directory.path().to_path_buf(),
            &content.manifest.variables,
            content.manifest.content_version.clone(),
        )
        .unwrap();
        let runtime = RuntimeEngine::with_profile(&content, profile_state).unwrap();
        let state = EngineState {
            content,
            runtime: Mutex::new(runtime),
            replay: Mutex::new(None),
            secondary: Mutex::new(None),
            session_gate: Mutex::new(()),
            replay_generation: AtomicU64::new(0),
            session_id: AtomicU64::new(1),
            secondary_generation: AtomicU64::new(0),
            windows: Arc::new(RecordingWindowOps::default()),
            saves,
            profile,
        };
        let first = state
            .commit_main_runtime(|runtime| runtime.start_new_game(&state.content))
            .unwrap()
            .update;
        let dialogue = state
            .commit_main_runtime(|runtime| {
                runtime.presentation_complete(
                    &state.content,
                    first.update_id,
                    PresentationOutcome::Completed,
                )
            })
            .unwrap()
            .update;
        assert!(matches!(
            dialogue.snapshot.prompt,
            vectspace_core::model::PromptSnapshot::Dialogue { .. }
        ));
        let before_snapshot = state.runtime().unwrap().snapshot().clone();
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
    fn sandbox_scene_loads_and_supports_scene_entry_preview() {
        let content =
            ContentCatalog::from_root(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../game"))
                .unwrap();
        assert!(content.scenes.contains_key("sandbox"));
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let first = runtime.start_scene_preview(&content, "sandbox").unwrap();
        assert!(matches!(
            first.snapshot.prompt,
            vectspace_core::model::PromptSnapshot::Dialogue { .. }
        ));
        let lecture = runtime
            .advance(&content, first.snapshot.revision, AdvanceSource::Manual)
            .unwrap();
        assert!(matches!(
            lecture.snapshot.prompt,
            vectspace_core::model::PromptSnapshot::LongText { .. }
        ));
        assert_eq!(
            lecture
                .snapshot
                .long_text_page
                .as_ref()
                .unwrap()
                .document_id,
            "sandbox/sandbox_proof"
        );
        let observation = runtime
            .advance(&content, lecture.snapshot.revision, AdvanceSource::Manual)
            .unwrap();
        let interlude = runtime
            .advance(
                &content,
                observation.snapshot.revision,
                AdvanceSource::Manual,
            )
            .unwrap();
        let timeline = runtime
            .advance(&content, interlude.snapshot.revision, AdvanceSource::Manual)
            .unwrap();
        assert!(timeline.requires_ack);
        let continuation = runtime
            .presentation_complete(
                &content,
                timeline.update_id,
                vectspace_core::model::PresentationOutcome::Completed,
            )
            .unwrap();
        assert!(matches!(
            continuation.snapshot.prompt,
            vectspace_core::model::PromptSnapshot::LongText { .. }
        ));
    }

    #[test]
    fn secondary_startup_uses_and_publishes_the_candidate_shared_state() {
        let directory = tempdir().unwrap();
        let state = secondary_state_with_content(
            &directory,
            shared_state_secondary_content(),
            Arc::new(RecordingWindowOps::default()),
        );
        // The main command itself writes `score` before it reaches
        // `open_window`, so the value the secondary must start from only exists
        // on the command's candidate runtime.
        let transition = state
            .commit_main_runtime(|runtime| runtime.start_new_game(&state.content))
            .unwrap();
        assert_eq!(transition.plan, SecondaryPlan::Show { replaced: false });

        // The secondary's opening nodes ran on the candidate's Save/Profile
        // maps: `seed_add` added 1 to the main story's 5 instead of to the
        // declared default.
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

        // The startup mutations were published to the main runtime — which is
        // the single authority for the shared maps — in the same transaction.
        let main = state.runtime().unwrap();
        assert_eq!(
            main.snapshot().variables.get("score"),
            Some(&ScalarValue::Integer(6))
        );
        assert_eq!(
            main.profile_variables_map().get("ending_seen"),
            Some(&ScalarValue::Boolean(true))
        );
        // ... including the merged ledger and the persisted profile.
        assert!(main
            .dialogue_history()
            .iter()
            .any(|entry| entry.prompt_id == "ambience_lab/seed_say"));
        assert_eq!(
            main.profile_state(&state.content).dialogue_history,
            main.dialogue_history().to_vec()
        );
        let on_disk: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.path().join("profile.json")).unwrap())
                .unwrap();
        assert_eq!(
            on_disk["variables"]["ending_seen"],
            serde_json::Value::Bool(true)
        );
    }

    #[test]
    fn initial_runtime_gated_secondary_presentation_survives_the_bootstrap() {
        let directory = tempdir().unwrap();
        let state = secondary_state_with_content(
            &directory,
            gated_secondary_entry(open_window_then_wait_content()),
            Arc::new(RecordingWindowOps::default()),
        );
        let transition = state
            .commit_main_runtime(|runtime| runtime.start_new_game(&state.content))
            .unwrap();
        // Defect 1: the control cue is stripped, but the acknowledgement the
        // remaining `wait` needs is still required of the main window.
        assert!(transition.update.requires_ack);
        assert!(!transition
            .update
            .cues
            .iter()
            .any(|cue| matches!(cue.kind, PresentationCueKind::OpenWindow { .. })));
        assert!(transition
            .update
            .cues
            .iter()
            .any(|cue| cue.gate == CueGate::Runtime));

        // Defect 3: the secondary's own pending opening presentation is
        // delivered by its bootstrap with the exact update id the runtime is
        // waiting for.
        let token = state.secondary().unwrap().as_ref().unwrap().token;
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

        // Acknowledging that exact gate unblocks ordinary gameplay.
        state
            .transact_secondary(Some(&WireU64::from(token)), |runtime| {
                runtime.presentation_complete(
                    &state.content,
                    pending,
                    PresentationOutcome::Completed,
                )
            })
            .unwrap();
        let revision = state
            .secondary()
            .unwrap()
            .as_ref()
            .unwrap()
            .runtime
            .snapshot()
            .revision;
        let advanced = state.transact_secondary(Some(&WireU64::from(token)), |runtime| {
            runtime.advance(&state.content, revision, AdvanceSource::Manual)
        });
        assert!(
            advanced.is_ok(),
            "an acked bootstrap gate must not leave the secondary locked: {:?}",
            advanced.err()
        );
        // Once the gate is acknowledged the bootstrap is cue-less again.
        let settled = state.secondary_bootstrap_payload().unwrap();
        assert!(!settled.update.requires_ack);
    }

    #[test]
    fn failed_native_window_creation_rolls_back_the_whole_transition() {
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = secondary_state_with_content(
            &directory,
            shared_state_secondary_content(),
            ops.clone(),
        );
        let before_runtime = state.runtime().unwrap().snapshot().clone();
        let before_profile = fs::read(directory.path().join("profile.json")).unwrap();
        ops.fail_show.store(true, Ordering::Release);

        let error = state
            .transact_runtime(|runtime| runtime.start_new_game(&state.content))
            .unwrap_err();
        assert_eq!(error.code, WireCommandErrorCode::Internal);
        // No silent success: the transition is rolled back in memory *and* on
        // disk instead of reporting a window that does not exist.
        assert!(state.secondary().unwrap().is_none());
        assert_eq!(state.runtime().unwrap().snapshot(), &before_runtime);
        assert_eq!(
            fs::read(directory.path().join("profile.json")).unwrap(),
            before_profile
        );
        assert_eq!(ops.show_calls.load(Ordering::Acquire), 1);
    }

    #[test]
    fn partial_native_creation_with_failed_cleanup_reports_both_and_recovers() {
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = secondary_state_with_content(
            &directory,
            shared_state_secondary_content(),
            ops.clone(),
        );
        let before_runtime = state.runtime().unwrap().snapshot().clone();
        let before_profile = fs::read(directory.path().join("profile.json")).unwrap();
        // Creation builds the native window and then fails, and the rollback's
        // cleanup cannot destroy it either.
        ops.fail_show_after_create.store(true, Ordering::Release);
        ops.fail_hide.store(true, Ordering::Release);

        let error = show_test_secondary(&state, "ambience_lab").unwrap_err();
        // Both failures are reported, not just the first one.
        assert!(
            error.message.contains("测试: 副窗口创建失败"),
            "the native failure must be reported: {}",
            error.message
        );
        assert!(
            error.message.contains("测试: 无法关闭副窗口"),
            "the cleanup failure must not be swallowed: {}",
            error.message
        );
        assert_eq!(error.code, WireCommandErrorCode::Internal);
        // The logical state is restored even though the cleanup failed: memory,
        // the secondary slot and the persisted profile.
        assert!(state.secondary().unwrap().is_none());
        assert_eq!(state.runtime().unwrap().snapshot(), &before_runtime);
        assert_eq!(
            fs::read(directory.path().join("profile.json")).unwrap(),
            before_profile
        );
        assert_eq!(ops.hide_calls.load(Ordering::Acquire), 1);
        // ... while the native window really did survive this attempt.
        assert!(ops.window_alive.load(Ordering::Acquire));

        // The production rule that decides the refresh (shared by the real and
        // the injected seam) ignores the logical flag when a window survived.
        assert!(!needs_session_refresh(false, false));
        assert!(needs_session_refresh(false, true));
        assert!(needs_session_refresh(true, false));
        assert!(needs_session_refresh(true, true));

        // A retry is deterministic: the host's logical state has no secondary, so
        // `replaced` is false, but the surviving native window must still be
        // refreshed because it is still running the old (failed) frontend.
        ops.fail_show_after_create.store(false, Ordering::Release);
        ops.fail_hide.store(false, Ordering::Release);
        show_test_secondary(&state, "ambience_lab").unwrap();
        assert_eq!(ops.replaced_calls.load(Ordering::Acquire), 0);
        assert_eq!(ops.reused_calls.load(Ordering::Acquire), 1);
        assert_eq!(ops.refresh_calls.load(Ordering::Acquire), 1);
        // No second window was created: the surviving one was adopted.
        assert_eq!(ops.create_calls.load(Ordering::Acquire), 0);
        assert_eq!(ops.show_calls.load(Ordering::Acquire), 2);
        assert!(ops.window_alive.load(Ordering::Acquire));
        let slot = state.secondary().unwrap();
        let session = slot.as_ref().unwrap();
        assert_eq!(session.scene_id, "ambience_lab");
        let token = session.token;
        drop(slot);
        // The recovered session is fully usable, including its bootstrap, which
        // now serves the refreshed token to the surviving window.
        let payload = state.secondary_bootstrap_payload().unwrap();
        assert_eq!(payload.update.session_id, WireU64::from(token));
        assert_eq!(
            payload.update.snapshot.location.scene_id,
            "ambience_lab".to_owned()
        );
    }

    #[test]
    fn failed_native_window_destruction_never_reports_a_cleared_secondary() {
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = secondary_state_with_content(
            &directory,
            secondary_test_catalog(),
            ops.clone(),
        );
        let token = stage_test_secondary(&state, "ambience_lab");
        let before_runtime = state.runtime().unwrap().snapshot().clone();
        ops.fail_hide.store(true, Ordering::Release);

        // A new game / title boundary must abort instead of succeeding while
        // the window is still on screen.
        let error = state
            .transact_runtime_forced(
                |runtime| runtime.start_new_game(&state.content),
                true,
            )
            .unwrap_err();
        assert_eq!(error.code, WireCommandErrorCode::Internal);
        assert_eq!(
            state.secondary().unwrap().as_ref().map(|session| session.token),
            Some(token)
        );
        assert_eq!(state.runtime().unwrap().snapshot(), &before_runtime);

        // The same holds for the non-story boundaries (replay entry, title).
        assert!(state.close_secondary().is_err());
        assert_eq!(
            state.secondary().unwrap().as_ref().map(|session| session.token),
            Some(token)
        );

        // Once the native window can be destroyed the boundary completes.
        ops.fail_hide.store(false, Ordering::Release);
        state.close_secondary().unwrap();
        assert!(state.secondary().unwrap().is_none());
    }

    #[test]
    fn every_gate_taking_ipc_command_runs_off_the_ipc_thread() {
        // Tauri executes a synchronous `#[tauri::command]` inline in the WebView
        // IPC callback — the event-loop thread on Windows — and only an
        // `async fn` command on the async runtime.  Creating a WebView there
        // deadlocks the host, and any command that blocks the event loop while
        // another command holds the session gate stalls the whole app, so every
        // command that takes the gate must be an async command.
        let source = include_str!("lib.rs");
        let source = source
            .split("#[cfg(test)]")
            .next()
            .expect("the command section precedes the tests");
        let mut async_commands = Vec::new();
        let mut blocking_gate_commands = Vec::new();
        for chunk in source.split("#[tauri::command]").skip(1) {
            let signature = chunk.split('{').next().unwrap_or_default();
            let name = signature
                .split("fn ")
                .nth(1)
                .and_then(|rest| rest.split('(').next())
                .expect("every command has a name")
                .trim()
                .to_owned();
            if signature.contains("async fn ") {
                async_commands.push(name);
            } else if chunk.contains("session_gate()") {
                blocking_gate_commands.push(name);
            }
        }
        assert!(
            blocking_gate_commands.is_empty(),
            "这些命令会阻塞事件循环，必须改为 async: {blocking_gate_commands:?}"
        );
        // The commands that can reach the native window seam, and therefore the
        // documented Windows WebView2 deadlock, are listed explicitly so a new
        // one cannot be added as a synchronous command by accident.
        for name in [
            "bootstrap",
            "secondary_bootstrap",
            "start_new_game",
            "advance",
            "choose",
            "click_button",
            "presentation_complete",
            "get_snapshot",
            "secondary_snapshot",
            "get_dialogue_history",
            "clear_dialogue_history",
            "get_chapter_map",
            "start_scene_replay",
            "exit_scene_replay",
            "invalidate_session",
            "save_slot",
            "load_slot",
            "secondary_advance",
            "secondary_choose",
            "secondary_click_button",
            "secondary_presentation_complete",
        ] {
            assert!(
                async_commands.iter().any(|command| command == name),
                "{name} 必须在异步运行时不阻塞事件循环"
            );
        }
        assert!(!async_commands.is_empty());
    }

    #[test]
    fn native_show_action_refuses_a_label_queued_for_destruction() {
        assert_eq!(native_show_action(false, false), NativeShowAction::Create);
        assert_eq!(native_show_action(false, true), NativeShowAction::Create);
        assert_eq!(native_show_action(true, false), NativeShowAction::Reuse);
        assert_eq!(
            native_show_action(true, true),
            NativeShowAction::RefusePendingDestroy
        );
    }

    #[test]
    fn a_queued_native_destroy_cannot_be_adopted_by_a_new_owner() {
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = replay_state(&directory, replay_test_content(), &ops);
        state.enter_replay("replay_lab").unwrap();
        assert_eq!(ops.create_calls.load(Ordering::Acquire), 1);

        // The replay ends and closes its window, but the runtime has not
        // processed the queued destroy yet: the label is still registered.
        ops.defer_destroy.store(true, Ordering::Release);
        state.exit_replay().unwrap();
        assert!(ops.queued_destroy.load(Ordering::Acquire));

        // A new owner must not adopt it: the entry fails and is rolled back
        // instead of handing the new replay a window that is about to die.
        let error = state.enter_replay("replay_lab").unwrap_err();
        assert_eq!(error.code, WireCommandErrorCode::Runtime);
        assert!(state.replay().unwrap().is_none());
        assert!(state.secondary().unwrap().is_none());
        assert_eq!(ops.create_calls.load(Ordering::Acquire), 1);

        // Once the runtime has processed the destroy the label is free again.
        ops.finish_queued_destroy();
        state.enter_replay("replay_lab").unwrap();
        assert_eq!(ops.create_calls.load(Ordering::Acquire), 2);
        assert!(state.secondary().unwrap().is_some());
    }

    #[test]
    fn a_live_slot_without_a_native_window_is_recovered_by_the_next_transition() {
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = secondary_state_with_content(
            &directory,
            shared_state_secondary_content(),
            ops.clone(),
        );
        state
            .transact_runtime(|runtime| runtime.start_new_game(&state.content))
            .unwrap();
        assert!(state.secondary().unwrap().is_some());
        assert_eq!(ops.create_calls.load(Ordering::Acquire), 1);

        // The runtime accepted the creation but never performed it, which the
        // enqueue-only native contract cannot report back to the host.
        ops.window_alive.store(false, Ordering::Release);

        // The next transition performs no native show, so it re-ensures the
        // window instead of leaving the live slot without one.
        state
            .transact_runtime(|runtime| Ok(runtime.bootstrap(&state.content).update))
            .unwrap();
        assert_eq!(ops.recover_calls.load(Ordering::Acquire), 1);
        assert_eq!(ops.create_calls.load(Ordering::Acquire), 2);
        assert!(ops.window_alive.load(Ordering::Acquire));
    }

    #[test]
    fn an_orphaned_native_window_is_cleaned_up_by_the_next_transition() {
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = secondary_state_with_content(
            &directory,
            shared_state_secondary_content(),
            ops.clone(),
        );
        // Creation builds the window and then fails, and the rollback cannot
        // destroy it either: the native window survives with no slot.
        ops.fail_show_after_create.store(true, Ordering::Release);
        ops.fail_hide.store(true, Ordering::Release);
        assert!(state
            .transact_runtime(|runtime| runtime.start_new_game(&state.content))
            .is_err());
        assert!(ops.window_alive.load(Ordering::Acquire));
        assert!(state.secondary().unwrap().is_none());

        // The next transition performs no native show, so it removes the orphan
        // instead of leaving a window no session owns any more.
        ops.fail_show_after_create.store(false, Ordering::Release);
        ops.fail_hide.store(false, Ordering::Release);
        state
            .transact_runtime(|runtime| Ok(runtime.bootstrap(&state.content).update))
            .unwrap();
        assert_eq!(ops.recover_calls.load(Ordering::Acquire), 1);
        assert!(!ops.window_alive.load(Ordering::Acquire));
    }

    #[test]
    fn replay_entry_open_window_opens_the_window_and_never_leaks_the_cue() {
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = replay_state(&directory, replay_test_content(), &ops);
        let update = state.enter_replay("replay_lab").unwrap();
        // Defect: the entry update used to be returned with its control cue still
        // attached, which the wire type cannot even represent.
        assert!(!has_open_window_cue(&update));
        assert!(update
            .cues
            .iter()
            .all(|cue| !matches!(cue.kind, PresentationCueKind::OpenWindow { .. })));

        let slot = state.secondary().unwrap();
        let session = slot.as_ref().expect("the entry opened the window");
        assert_eq!(session.scene_id, "ambience_lab");
        assert!(matches!(session.owner, SecondaryOwner::Replay { .. }));
        let token = session.token;
        drop(slot);
        assert_eq!(ops.create_calls.load(Ordering::Acquire), 1);
        assert!(ops.window_alive.load(Ordering::Acquire));

        // The replay's own runtime started the window's Scene in its isolated ID
        // namespace, and the window bootstraps under the replay-owned token.
        let payload = state.secondary_bootstrap_payload().unwrap();
        assert_eq!(payload.update.session_id, WireU64::from(token));
        assert_eq!(payload.update.snapshot.location.scene_id, "ambience_lab");
    }

    #[test]
    fn repeated_open_window_inside_a_replay_repoints_one_slot_with_a_fresh_token() {
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = replay_state(&directory, replay_test_content(), &ops);
        state.enter_replay("replay_lab").unwrap();
        let first = state
            .secondary()
            .unwrap()
            .as_ref()
            .expect("the entry opened the window")
            .token;

        let revision = state
            .replay()
            .unwrap()
            .as_ref()
            .unwrap()
            .runtime
            .snapshot()
            .revision;
        let update = state
            .transact_replay(|runtime| runtime.advance(&state.content, revision, AdvanceSource::Manual))
            .unwrap();
        assert!(!has_open_window_cue(&update));

        let slot = state.secondary().unwrap();
        let session = slot.as_ref().expect("the re-point kept the one slot");
        assert_eq!(session.scene_id, "surface_parity");
        assert!(matches!(session.owner, SecondaryOwner::Replay { .. }));
        assert_eq!(session.token, first + 1, "a replacement gets a fresh token");
        drop(slot);
        // One native window was re-pointed, not replaced by a second one.
        assert_eq!(ops.create_calls.load(Ordering::Acquire), 1);
        assert_eq!(ops.reused_calls.load(Ordering::Acquire), 1);
        assert_eq!(ops.replaced_calls.load(Ordering::Acquire), 1);

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
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = replay_state(&directory, replay_test_content(), &ops);
        state.enter_replay("replay_lab").unwrap();
        let token = state
            .secondary()
            .unwrap()
            .as_ref()
            .unwrap()
            .token;
        let before_main = state.runtime().unwrap().snapshot().clone();
        let before_main_history = state.runtime().unwrap().dialogue_history().to_vec();
        let before_profile_file = fs::read(directory.path().join("profile.json")).unwrap();

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

        // Replay play is ephemeral: the main runtime, the official ledger and
        // the profile file are untouched.
        assert_eq!(state.runtime().unwrap().snapshot(), &before_main);
        assert_eq!(
            state.runtime().unwrap().dialogue_history(),
            before_main_history.as_slice()
        );
        assert_eq!(
            fs::read(directory.path().join("profile.json")).unwrap(),
            before_profile_file
        );
        assert_ne!(
            state
                .runtime()
                .unwrap()
                .snapshot()
                .variables
                .get("score"),
            Some(&ScalarValue::Integer(9)),
            "a replay-owned secondary write must never reach the main Save map"
        );

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
        let replay_history = session.runtime.dialogue_history();
        assert!(replay_history
            .iter()
            .any(|entry| entry.prompt_id.starts_with("ambience_lab/")));
        // ... while the official ledger never sees a replayed occurrence.
        assert!(!state
            .runtime()
            .unwrap()
            .dialogue_history()
            .iter()
            .any(|entry| entry.prompt_id.starts_with("ambience_lab/")));
    }

    #[test]
    fn replay_cross_scene_and_end_transitions_close_the_replay_window() {
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = replay_state(&directory, replay_test_content(), &ops);

        // Leaving the Scene that owns the window closes it, exactly like a main
        // story transition does.
        state.enter_replay("replay_cross").unwrap();
        assert!(state.secondary().unwrap().is_some());
        let revision = state
            .replay()
            .unwrap()
            .as_ref()
            .unwrap()
            .runtime
            .snapshot()
            .revision;
        let crossed = state
            .transact_replay(|runtime| runtime.advance(&state.content, revision, AdvanceSource::Manual))
            .unwrap();
        assert_ne!(crossed.snapshot.location.scene_id, "replay_cross");
        assert!(state.secondary().unwrap().is_none());
        assert!(!ops.window_alive.load(Ordering::Acquire));
        assert!(state
            .replay()
            .unwrap()
            .as_ref()
            .unwrap()
            .ending);
        state.exit_replay().unwrap();

        // Reaching the end of the replay closes it too.
        state.enter_replay("replay_lab").unwrap();
        let revision = state
            .replay()
            .unwrap()
            .as_ref()
            .unwrap()
            .runtime
            .snapshot()
            .revision;
        state
            .transact_replay(|runtime| runtime.advance(&state.content, revision, AdvanceSource::Manual))
            .unwrap();
        assert!(state.secondary().unwrap().is_some());
        let revision = state
            .replay()
            .unwrap()
            .as_ref()
            .unwrap()
            .runtime
            .snapshot()
            .revision;
        let ended = state
            .transact_replay(|runtime| runtime.advance(&state.content, revision, AdvanceSource::Manual))
            .unwrap();
        assert!(matches!(
            ended.snapshot.prompt,
            vectspace_core::model::PromptSnapshot::End { .. }
        ));
        assert!(state.secondary().unwrap().is_none());
        assert!(state
            .replay()
            .unwrap()
            .as_ref()
            .unwrap()
            .ending);
    }

    #[test]
    fn replay_exit_closes_the_window_and_a_failed_destroy_preserves_the_replay() {
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = replay_state(&directory, replay_test_content(), &ops);
        state.enter_replay("replay_lab").unwrap();

        ops.fail_hide.store(true, Ordering::Release);
        assert_eq!(state.exit_replay().unwrap_err().code, WireCommandErrorCode::Internal);
        // The exit can be retried instead of orphaning the window.
        assert!(state.replay().unwrap().is_some());
        assert!(state.secondary().unwrap().is_some());

        ops.fail_hide.store(false, Ordering::Release);
        state.exit_replay().unwrap();
        assert!(state.replay().unwrap().is_none());
        assert!(state.secondary().unwrap().is_none());
        assert!(!ops.window_alive.load(Ordering::Acquire));
        assert_eq!(ops.hide_calls.load(Ordering::Acquire), 2);
    }

    /// Everything a rolled-back replay transaction must leave exactly as it was:
    /// the live replay (generation and full snapshot), its ledger, the secondary
    /// slot (token, owner and shared maps/ledger) and the untouched main runtime
    /// with its persisted profile.
    struct RollbackSnapshot {
        generation: u64,
        replay_scene: String,
        replay_ending: bool,
        replay_snapshot: vectspace_core::model::RuntimeSnapshot,
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
        fn capture(state: &EngineState, directory: &tempfile::TempDir) -> Self {
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
                profile_file: fs::read(directory.path().join("profile.json")).unwrap(),
            }
        }

        /// Assert that the failed transition left replay, secondary and official
        /// state byte-for-byte where they were.
        fn assert_restored(&self, state: &EngineState, directory: &tempfile::TempDir) {
            let replay = state.replay().unwrap();
            let session = replay
                .as_ref()
                .expect("a failed native step must not clear the live replay");
            assert_eq!(session.generation, self.generation);
            assert_eq!(session.scene_id, self.replay_scene);
            assert_eq!(session.ending, self.replay_ending);
            assert_eq!(session.runtime.snapshot(), &self.replay_snapshot);
            assert_eq!(session.runtime.dialogue_history(), self.replay_history.as_slice());

            let secondary = state.secondary().unwrap();
            let secondary = secondary.as_ref().expect("the previous slot is restored");
            assert_eq!(secondary.token, self.secondary_token);
            assert_eq!(secondary.scene_id, self.secondary_scene);
            assert_eq!(secondary.owner, self.secondary_owner);
            assert_eq!(
                secondary.runtime.snapshot().variables,
                self.secondary_variables
            );
            assert_eq!(
                secondary.runtime.dialogue_history(),
                self.secondary_history.as_slice()
            );

            let main = state.runtime().unwrap();
            assert_eq!(main.snapshot().variables, self.variables);
            assert_eq!(main.dialogue_history(), self.main_history.as_slice());
            drop(main);
            assert_eq!(
                fs::read(directory.path().join("profile.json")).unwrap(),
                self.profile_file
            );
        }
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

    #[test]
    fn failed_repeated_replay_open_restores_the_live_replay_and_its_previous_slot() {
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = replay_state(&directory, replay_test_content(), &ops);
        state.enter_replay("replay_lab").unwrap();
        let before = RollbackSnapshot::capture(&state, &directory);
        let generation = before.generation;

        // The re-point builds the native window and then the show fails: the
        // partial native failure the seam cannot report a completion for.
        ops.fail_show_after_create.store(true, Ordering::Release);
        let revision = replay_revision(&state);
        let error = state
            .transact_replay(|runtime| runtime.advance(&state.content, revision, AdvanceSource::Manual))
            .unwrap_err();
        assert_eq!(error.code, WireCommandErrorCode::Internal);
        before.assert_restored(&state, &directory);
        assert_eq!(
            state.replay().unwrap().as_ref().unwrap().generation,
            generation
        );

        // The retry runs the same transition from the restored revision and
        // finally re-points the one slot with a fresh token.
        ops.fail_show_after_create.store(false, Ordering::Release);
        let revision = replay_revision(&state);
        state
            .transact_replay(|runtime| runtime.advance(&state.content, revision, AdvanceSource::Manual))
            .unwrap();
        let slot = state.secondary().unwrap();
        let session = slot.as_ref().expect("the retry kept the one slot");
        assert_eq!(session.scene_id, "surface_parity");
        // A replacement always carries a fresh token; the failed attempt also
        // consumed one, which is what keeps a stale acknowledgement from ever
        // colliding with a later instance.
        assert!(session.token > before.secondary_token);
        assert_eq!(session.owner, SecondaryOwner::Replay { generation });
    }

    #[test]
    fn failed_cross_scene_and_end_hides_restore_the_live_replay() {
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = replay_state(&directory, replay_test_content(), &ops);

        // Leaving the owning Scene stages a Hide; when it fails the replay must
        // keep running exactly where it was.
        state.enter_replay("replay_cross").unwrap();
        let before = RollbackSnapshot::capture(&state, &directory);
        ops.fail_hide.store(true, Ordering::Release);
        let revision = replay_revision(&state);
        let error = state
            .transact_replay(|runtime| runtime.advance(&state.content, revision, AdvanceSource::Manual))
            .unwrap_err();
        assert_eq!(error.code, WireCommandErrorCode::Internal);
        before.assert_restored(&state, &directory);
        assert!(!state.replay().unwrap().as_ref().unwrap().ending);
        assert!(ops.window_alive.load(Ordering::Acquire));

        ops.fail_hide.store(false, Ordering::Release);
        let revision = replay_revision(&state);
        state
            .transact_replay(|runtime| runtime.advance(&state.content, revision, AdvanceSource::Manual))
            .unwrap();
        assert!(state.secondary().unwrap().is_none());
        assert!(state.replay().unwrap().as_ref().unwrap().ending);
        state.exit_replay().unwrap();

        // The same for the ending Hide: the replay is not over until the window
        // really closed.
        state.enter_replay("replay_lab").unwrap();
        let revision = replay_revision(&state);
        state
            .transact_replay(|runtime| runtime.advance(&state.content, revision, AdvanceSource::Manual))
            .unwrap();
        let before = RollbackSnapshot::capture(&state, &directory);
        ops.fail_hide.store(true, Ordering::Release);
        let revision = replay_revision(&state);
        let error = state
            .transact_replay(|runtime| runtime.advance(&state.content, revision, AdvanceSource::Manual))
            .unwrap_err();
        assert_eq!(error.code, WireCommandErrorCode::Internal);
        before.assert_restored(&state, &directory);

        ops.fail_hide.store(false, Ordering::Release);
        let revision = replay_revision(&state);
        let ended = state
            .transact_replay(|runtime| runtime.advance(&state.content, revision, AdvanceSource::Manual))
            .unwrap();
        assert!(matches!(
            ended.snapshot.prompt,
            vectspace_core::model::PromptSnapshot::End { .. }
        ));
        assert!(state.secondary().unwrap().is_none());
    }

    #[test]
    fn failed_replay_entry_restores_the_story_owned_window() {
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = secondary_state_with_content(
            &directory,
            replay_test_content(),
            ops.clone(),
        );
        // The story owns the window first: entry is an ownership handoff.
        show_test_secondary(&state, "ambience_lab").unwrap();
        let slot = state.secondary().unwrap();
        let session = slot.as_ref().expect("the story opened the window");
        let story_token = session.token;
        let story_scene = session.scene_id.clone();
        let owner = session.owner.clone();
        assert!(matches!(owner, SecondaryOwner::Story { .. }));
        drop(slot);
        let before_main = state.runtime().unwrap().snapshot().clone();
        let before_history = state.runtime().unwrap().dialogue_history().to_vec();
        let before_profile_file = fs::read(directory.path().join("profile.json")).unwrap();
        let before_secondary_history = state
            .secondary()
            .unwrap()
            .as_ref()
            .unwrap()
            .runtime
            .dialogue_history()
            .to_vec();

        // The handoff's native show fails after creating the window, so the
        // replay must not become the owner and the story's session must survive.
        ops.fail_show_after_create.store(true, Ordering::Release);
        assert_eq!(state.enter_replay("replay_lab").unwrap_err().code, WireCommandErrorCode::Internal);
        assert!(state.replay().unwrap().is_none());
        let slot = state.secondary().unwrap();
        let session = slot
            .as_ref()
            .expect("the previous story owner must be restored");
        assert_eq!(session.token, story_token);
        assert_eq!(session.scene_id, story_scene);
        assert_eq!(session.owner, owner);
        assert_eq!(
            session.runtime.dialogue_history(),
            before_secondary_history.as_slice()
        );
        drop(slot);
        assert_eq!(state.runtime().unwrap().snapshot(), &before_main);
        assert_eq!(
            state.runtime().unwrap().dialogue_history(),
            before_history.as_slice()
        );
        assert_eq!(
            fs::read(directory.path().join("profile.json")).unwrap(),
            before_profile_file
        );

        // Once the native step works the entry really hands the same window to
        // the replay, with a fresh identity.
        ops.fail_show_after_create.store(false, Ordering::Release);
        state.enter_replay("replay_lab").unwrap();
        let slot = state.secondary().unwrap();
        let session = slot.as_ref().expect("the replay now owns the window");
        assert_eq!(session.scene_id, "ambience_lab");
        assert_ne!(session.token, story_token);
        assert!(matches!(session.owner, SecondaryOwner::Replay { .. }));
    }

    #[test]
    fn a_replay_open_window_followed_by_a_gated_node_keeps_its_acknowledgement() {
        let directory = tempdir().unwrap();
        let ops = Arc::new(RecordingWindowOps::default());
        let state = replay_state(
            &directory,
            replay_gated_entry(replay_test_content()),
            &ops,
        );
        let first = state.enter_replay("replay_lab").unwrap();
        // The control cue is gone, but the runtime-gated node that followed it
        // still needs exactly its own acknowledgement.
        assert!(!has_open_window_cue(&first));
        assert!(first.requires_ack);
        assert!(first
            .cues
            .iter()
            .any(|cue| cue.gate == CueGate::Runtime));
        assert_eq!(state.secondary().unwrap().as_ref().unwrap().scene_id, "ambience_lab");

        // Acknowledging that exact update unblocks the replay, and the
        // acknowledgement path also consumes the control cue.
        let acknowledged = state
            .transact_replay(|runtime| {
                runtime.presentation_complete(
                    &state.content,
                    first.update_id,
                    vectspace_core::model::PresentationOutcome::Completed,
                )
            })
            .unwrap();
        assert!(!has_open_window_cue(&acknowledged));
        assert!(!acknowledged.requires_ack);
    }

    #[test]
    fn secondary_capability_is_scoped_to_the_secondary_window_only() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let read = |name: &str| -> serde_json::Value {
            serde_json::from_slice(&fs::read(root.join(name)).unwrap()).unwrap()
        };
        let default = read("default.json");
        assert_eq!(default["windows"], serde_json::json!(["main"]));
        // Without its own capability the secondary window could not even
        // subscribe to the host's session event.
        let secondary = read("secondary.json");
        assert_eq!(secondary["windows"], serde_json::json!(["secondary"]));
        let permissions: Vec<String> = secondary["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect();
        assert!(permissions.contains(&"core:event:allow-listen".to_owned()));
        assert!(permissions.contains(&"core:event:allow-unlisten".to_owned()));
        for forbidden in [
            "core:default",
            "core:window:allow-create",
            "core:webview:allow-create-webview-window",
            "core:window:allow-get-all-windows",
            "core:window:allow-fullscreen",
            "core:app:allow-register-listener",
        ] {
            assert!(
                !permissions.iter().any(|granted| granted == forbidden),
                "{forbidden} must not be granted to the secondary window"
            );
        }
        // Every capability targets a label the host actually creates, so no
        // unknown window can inherit a permission set by accident.
        for entry in fs::read_dir(&root).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let value: serde_json::Value =
                serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            for label in value["windows"].as_array().into_iter().flatten() {
                let label = label.as_str().unwrap();
                assert!(
                    role_for_label(label).is_some(),
                    "capability targets unknown window label {label}"
                );
            }
        }
    }
}
