//! The native half of a transition.
//!
//! A transaction first commits in memory, then asks the native windows to match
//! (open or destroy the secondary window, show the new titles, apply window
//! effects).  This module holds that step and the rollback bookkeeping shared by
//! the story and replay transactions.

use vectspace_core::interaction::{WindowRole, DEFAULT_MAIN_TITLE, DEFAULT_SECONDARY_TITLE};
use vectspace_protocol::{WireCommandError, WireCommandErrorCode};

use crate::{secondary::SecondarySession, state::EngineState, window_fx::WindowEffect};

/// What the native windows currently show.  `None` means unknown, which forces
/// the next sync to set it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeTitles {
    pub(crate) main: Option<String>,
    pub(crate) secondary: Option<String>,
}

/// Native work the host must perform *after* all runtime locks are released.
/// WebView creation/destruction can re-enter the window-event handler, so it is
/// staged here and executed with only the session gate held.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SecondaryPlan {
    None,
    /// Create the window if needed, then tell its frontend to re-bootstrap
    /// under the new token.
    Show {
        replaced: bool,
    },
    /// Destroy the window and clear the slot.
    Hide,
}

/// How the secondary slot looked before a transition, kept for rollback.
#[derive(Debug)]
pub(crate) enum SecondaryBaseline {
    /// The transition did not touch the slot at all, so a rollback must leave
    /// the live session exactly where it is.
    Untouched,
    /// The transition replaced, advanced or cleared the slot; the previous
    /// contents are restored on rollback.
    Restore(Box<Option<SecondarySession>>),
}

impl SecondaryBaseline {
    /// Install `staged` as the slot's new content, remembering what it replaces.
    /// A transition that neither had nor staged a secondary leaves the slot alone.
    pub(crate) fn install(
        slot: &mut Option<SecondarySession>,
        staged: Option<SecondarySession>,
        live_before: bool,
    ) -> Self {
        if live_before || staged.is_some() {
            SecondaryBaseline::Restore(Box::new(std::mem::replace(slot, staged)))
        } else {
            SecondaryBaseline::Untouched
        }
    }

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

impl EngineState {
    /// The native half of every transition: the window plan, the best-effort
    /// reconciliation of a window the runtime never created, the native titles
    /// and — only once all of those succeeded, so a rolled-back transition never
    /// leaves one behind — the window effects (geometry, layers) the story asked
    /// for.  The native step only enqueues its work (see [`TauriWindowOps`]), so
    /// the reconciliation is where a missing window or an orphaned one is
    /// corrected.  An effect that fails natively is a diagnostic, not a failure
    /// of the transition.
    pub(crate) fn apply_native_plan(
        &self,
        plan: &SecondaryPlan,
        effects: &[WindowEffect],
    ) -> Result<(), WireCommandError> {
        self.apply_secondary_plan(plan.clone())?;
        self.reconcile_secondary_window(plan);
        self.sync_native_titles()?;
        self.apply_window_effects(effects);
        Ok(())
    }

    /// Perform the staged native work.  Called with every runtime mutex released:
    /// window creation/destruction can re-enter the window event handler, and
    /// holding either runtime across it would risk a deadlock or let another
    /// command observe half-committed state.
    fn apply_secondary_plan(&self, plan: SecondaryPlan) -> Result<(), WireCommandError> {
        match plan {
            SecondaryPlan::None => Ok(()),
            SecondaryPlan::Show { replaced } => {
                self.windows.show_secondary(replaced)?;
                // A shown window starts from the default title (a surviving
                // window is reset by the seam).
                self.note_native_secondary_title(Some(DEFAULT_SECONDARY_TITLE));
                // ... and from the normal layer, with no animation running.
                self.reset_secondary_window_fx();
                Ok(())
            }
            SecondaryPlan::Hide => self.hide_native_secondary(),
        }
    }

    /// Destroy the native secondary window; whatever title it showed is gone,
    /// and so is whatever the host tracked about its geometry and layer.
    pub(crate) fn hide_native_secondary(&self) -> Result<(), WireCommandError> {
        self.windows.hide_secondary()?;
        self.note_native_secondary_title(None);
        self.fx.forget_window(WindowRole::Secondary);
        Ok(())
    }

    fn note_native_secondary_title(&self, title: Option<&str>) {
        if let Ok(mut applied) = self.native_titles.lock() {
            applied.secondary = title.map(str::to_owned);
        }
    }

    /// The titles the native windows should show right now.  The authority is
    /// the active story's (or replay's) runtime; the title screen shows the
    /// default title and no secondary exists.
    pub(crate) fn desired_titles(&self) -> Result<(String, Option<String>), WireCommandError> {
        if self.pause_state()?.title {
            return Ok((DEFAULT_MAIN_TITLE.to_owned(), None));
        }
        let titles = match self.replay()?.as_ref() {
            Some(replay) => replay.runtime.snapshot().interaction.titles.clone(),
            None => self.runtime()?.snapshot().interaction.titles.clone(),
        };
        let secondary = self.secondary()?.as_ref().map(|_| titles.secondary.clone());
        Ok((titles.main, secondary))
    }

    /// Make the native titles match the committed state.  Only titles that
    /// differ from what the windows show are touched; a failure leaves the
    /// applied record untouched so the next transition retries it.
    pub(crate) fn sync_native_titles(&self) -> Result<(), WireCommandError> {
        let (main, secondary) = self.desired_titles()?;
        let applied = self
            .native_titles
            .lock()
            .map_err(|_| {
                WireCommandError::new(WireCommandErrorCode::Internal, "窗口标题互斥锁已损坏")
            })?
            .clone();
        let set = |role: WindowRole, title: &str| -> Result<(), WireCommandError> {
            self.windows.set_title(role, title)?;
            if let Ok(mut applied) = self.native_titles.lock() {
                match role {
                    WindowRole::Main => applied.main = Some(title.to_owned()),
                    WindowRole::Secondary => applied.secondary = Some(title.to_owned()),
                }
            }
            Ok(())
        };
        if applied.main.as_deref() != Some(main.as_str()) {
            set(WindowRole::Main, &main)?;
        }
        if let Some(secondary) = secondary {
            if applied.secondary.as_deref() != Some(secondary.as_str()) {
                set(WindowRole::Secondary, &secondary)?;
            }
        }
        Ok(())
    }

    /// Put the secondary slot back the way a rolled-back transition found it.
    pub(crate) fn restore_secondary_slot(
        &self,
        baseline: &SecondaryBaseline,
        failures: &mut Vec<WireCommandError>,
    ) {
        if let Some(previous) = baseline.restored_session() {
            match self.secondary() {
                Ok(mut slot) => *slot = previous.clone(),
                Err(error) => failures.push(error),
            }
        }
    }

    /// Make the native windows follow the restored memory after a rollback.  A
    /// failed creation may have produced a window that never received a session;
    /// when the restored slot has no secondary it is destroyed again instead of
    /// being left behind, and if that cleanup fails too the surviving window is
    /// reported rather than swallowed (the retry path refreshes it, because it is
    /// a reused native window).
    pub(crate) fn rollback_native_state(
        &self,
        baseline: &SecondaryBaseline,
        plan: &SecondaryPlan,
        failures: &mut Vec<WireCommandError>,
    ) {
        if baseline.restored_without_secondary() && matches!(plan, SecondaryPlan::Show { .. }) {
            if let Err(error) = self.hide_native_secondary() {
                failures.push(WireCommandError::new(
                    WireCommandErrorCode::Internal,
                    format!(
                        "副窗口回滚清理失败，可能残留未受管理的原生窗口: {}",
                        error.message
                    ),
                ));
            }
        }
        if let Err(error) = self.sync_native_titles() {
            failures.push(WireCommandError::new(
                WireCommandErrorCode::Internal,
                format!("窗口标题回滚失败: {}", error.message),
            ));
        }
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
        match self.windows.reconcile_secondary(expected_live) {
            // A rebuilt window carries the default title again; a removed one no
            // title at all.
            Ok(true) => {
                self.note_native_secondary_title(expected_live.then_some(DEFAULT_SECONDARY_TITLE))
            }
            Ok(false) => {}
            Err(error) => eprintln!("副窗口原生窗口状态校正失败: {}", error.message),
        }
    }
}

/// Report the native failure that forced a rollback together with every cleanup
/// failure the rollback itself hit.  The first error keeps its code (callers
/// branch on it) and its message stays first, so a caller that only reads the
/// beginning still sees the original cause while the full picture is available.
pub(crate) fn aggregate_transition_failure(
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
