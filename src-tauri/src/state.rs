//! The host's shared state.
//!
//! [`EngineState`] owns the story runtime, the replay and secondary slots and the
//! bookkeeping around them.  What changes it lives in sibling modules, each as an
//! `impl EngineState` block: `transaction` (story commands), `replay`,
//! `secondary`, `native_plan` (the native window step of a transition), `sync`
//! (delivery and pause), `timers` and `window_fx`.

use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc, Arc, Mutex, MutexGuard,
};

use vectspace_core::{
    content::ContentCatalog, interaction::DEFAULT_MAIN_TITLE, runtime::RuntimeEngine,
};
use vectspace_protocol::{WireCommandError, WireCommandErrorCode, WireU64};

use crate::{
    native_plan::NativeTitles,
    native_window::NativeWindowOps,
    replay::ReplaySession,
    save::{ProfileManager, SaveManager},
    secondary::SecondarySession,
    sync::{Outboxes, PauseState},
    window_fx::WindowFx,
};

pub(crate) struct EngineState {
    pub(crate) content: ContentCatalog,
    pub(crate) proof_checker: Arc<Mutex<vectspace_proof::check::ProofChecker>>,
    pub(crate) runtime: Mutex<RuntimeEngine>,
    pub(crate) replay: Mutex<Option<ReplaySession>>,
    /// The single secondary game window's runtime.  `None` means no secondary is
    /// open.  The slot is only created, re-pointed or destroyed from a gated
    /// transition — a main-story one or a replay one — never from a frontend
    /// request.
    pub(crate) secondary: Mutex<Option<SecondarySession>>,
    /// Serializes the check-and-act boundary when switching between the main
    /// story runtime and an isolated replay.  Without this lock, an advance
    /// could observe “no replay”, yield, and then mutate the main runtime just
    /// after another command had entered replay mode.
    pub(crate) session_gate: Mutex<()>,
    /// Monotonic namespace for isolated sessions.  Main-story IDs stay in
    /// their normal small range while every replay receives a disjoint high
    /// range, so delayed cue acknowledgements cannot be applied to another
    /// session after the user returns to the map.
    pub(crate) replay_generation: AtomicU64,
    /// Monotonic host-session generation.  It changes whenever the active
    /// story/replay runtime changes so delayed IPC responses can never be
    /// applied to a newer session.
    pub(crate) session_id: AtomicU64,
    /// Monotonic secondary generation.  It supplies both the wire token handed
    /// to the secondary WebView and its isolated revision/update/cue namespace,
    /// so a delayed acknowledgement from a replaced secondary instance fails
    /// with `stale_session` instead of mutating the new one.
    pub(crate) secondary_generation: AtomicU64,
    /// The host's native window operations.  Keeping them behind a seam makes
    /// the failure paths (a window that cannot be created or destroyed)
    /// reachable from host tests without a real WebView.
    pub(crate) windows: Arc<dyn NativeWindowOps>,
    pub(crate) saves: SaveManager,
    pub(crate) profile: ProfileManager,
    /// Bounded committed-update buffers, one per window, in the order the
    /// frontends must apply them (see `sync.rs`).  Always locked last.
    pub(crate) outbox: Mutex<Outboxes>,
    /// Why story timers are paused right now (see `sync.rs`).
    pub(crate) pause: Mutex<PauseState>,
    /// The window titles the native windows currently show, so a transition only
    /// issues native calls for titles that really changed and a failed one is
    /// retried by the next transition.
    pub(crate) native_titles: Mutex<NativeTitles>,
    /// Wakes the timer scheduler thread; `None` when no scheduler runs (tests).
    pub(crate) timer_wake: Mutex<Option<mpsc::Sender<()>>>,
    /// Native window effects: animations, layers and the main window's
    /// restore record (see `window_fx.rs`).
    pub(crate) fx: WindowFx,
}

impl EngineState {
    pub(crate) fn new(
        content: ContentCatalog,
        runtime: RuntimeEngine,
        windows: Arc<dyn NativeWindowOps>,
        saves: SaveManager,
        profile: ProfileManager,
    ) -> Self {
        Self {
            proof_checker: Arc::new(Mutex::new(vectspace_proof::check::ProofChecker::new(None))),
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
            outbox: Mutex::new(Outboxes::default()),
            pause: Mutex::new(PauseState::default()),
            native_titles: Mutex::new(NativeTitles {
                main: Some(DEFAULT_MAIN_TITLE.to_owned()),
                secondary: None,
            }),
            timer_wake: Mutex::new(None),
            fx: WindowFx::default(),
        }
    }

    pub(crate) fn runtime(&self) -> Result<MutexGuard<'_, RuntimeEngine>, WireCommandError> {
        self.runtime.lock().map_err(|_| {
            WireCommandError::new(WireCommandErrorCode::Internal, "运行时互斥锁已损坏")
        })
    }

    pub(crate) fn secondary(
        &self,
    ) -> Result<MutexGuard<'_, Option<SecondarySession>>, WireCommandError> {
        self.secondary.lock().map_err(|_| {
            WireCommandError::new(WireCommandErrorCode::Internal, "副窗口互斥锁已损坏")
        })
    }

    pub(crate) fn replay(&self) -> Result<MutexGuard<'_, Option<ReplaySession>>, WireCommandError> {
        self.replay.lock().map_err(|_| {
            WireCommandError::new(WireCommandErrorCode::Internal, "重演运行时互斥锁已损坏")
        })
    }

    pub(crate) fn session_gate(&self) -> Result<MutexGuard<'_, ()>, WireCommandError> {
        self.session_gate
            .lock()
            .map_err(|_| WireCommandError::new(WireCommandErrorCode::Internal, "会话互斥锁已损坏"))
    }

    pub(crate) fn current_session_id(&self) -> u64 {
        self.session_id.load(Ordering::Acquire)
    }

    pub(crate) fn bump_session_id(&self) -> Result<u64, WireCommandError> {
        let previous = self
            .session_id
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(1)
            });
        let next = previous
            .map(|value| value + 1)
            .map_err(|_| WireCommandError::new(WireCommandErrorCode::Internal, "会话编号耗尽"))?;
        // Whatever the windows reported about themselves belongs to the old
        // session; the frontends re-report what still applies.
        self.reset_pause_reports();
        self.wake_timers();
        Ok(next)
    }

    pub(crate) fn check_session(&self, expected: Option<&WireU64>) -> Result<(), WireCommandError> {
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
