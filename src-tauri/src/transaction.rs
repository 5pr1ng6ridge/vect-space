//! Main-story transactions.
//!
//! Every story command runs against a clone of **both** windows' runtimes (see
//! `pair.rs`).  Only when the whole pair is consistent, the profile write has
//! succeeded and the native window step has succeeded is it published; any
//! failure rolls memory and disk back to where they were.
//!
//! Lock order: `session_gate` (held by the caller) -> `runtime`/`secondary`
//! -> released -> native window calls.  Native calls are never made while a
//! runtime mutex is held because window creation/destruction can re-enter the
//! window event handler; the session gate is still held, so no other command can
//! observe the gap.

use vectspace_core::{
    interaction::{WindowRole, DEFAULT_SECONDARY_TITLE},
    model::{ProfileState, RuntimeUpdate},
    runtime::{self, RuntimeEngine},
};
use vectspace_protocol::{WireCommandError, WireCommandErrorCode, WireRuntimeUpdate, WireU64};

use crate::{
    native_plan::{aggregate_transition_failure, SecondaryBaseline, SecondaryPlan},
    pair::{Authority, Committed, Pair},
    save::LoadedSlot,
    state::EngineState,
};

/// A committed main-story transaction.  The native window step happens after
/// the in-memory commit because window creation/destruction can re-enter the
/// platform event loop; `previous_*` keeps the rollback data for the one case
/// where that step fails, so the host can never report success while the native
/// window and the runtime disagree.  Nothing in `committed` is published to a
/// WebView before that step (and the profile write) has succeeded.
#[derive(Debug)]
pub(crate) struct MainTransition {
    pub(crate) committed: Committed,
    pub(crate) plan: SecondaryPlan,
    pub(crate) previous_runtime: RuntimeEngine,
    pub(crate) previous_secondary: SecondaryBaseline,
    pub(crate) previous_profile: ProfileState,
    /// Whether the commit itself wrote the profile, which is what decides
    /// whether a rollback has to restore it.
    pub(crate) profile_written: bool,
}

impl EngineState {
    /// Replace the main runtime with `candidate`, persisting the derived profile
    /// state first.  The profile write is the only fallible step, so it always
    /// happens before the in-memory commit: a failed write leaves memory and
    /// disk agreeing.  Returns whether the profile actually changed.
    pub(crate) fn commit_runtime(
        &self,
        committed: &RuntimeEngine,
        candidate: &RuntimeEngine,
    ) -> Result<bool, WireCommandError> {
        let candidate_profile = candidate.profile_state(&self.content);
        if candidate_profile == committed.profile_state(&self.content) {
            return Ok(false);
        }
        self.profile.save(&candidate_profile)?;
        Ok(true)
    }

    /// Run one main-story command against a clone of **both** windows, then
    /// perform its staged native window work.  A failed native step rolls the
    /// whole transaction back instead of reporting success with a missing or
    /// orphaned window, and nothing is published before it has succeeded.
    pub(crate) fn transact_runtime(
        &self,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<Committed, WireCommandError> {
        self.finish_transition(self.commit_main_runtime(operation)?)
    }

    /// [`Self::transact_runtime`] with an explicit host decision to tear the
    /// secondary window down even when the command itself does not leave the
    /// Scene that owns it (new game, load, title, replay).
    pub(crate) fn transact_runtime_forced(
        &self,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
        force_hide: bool,
    ) -> Result<Committed, WireCommandError> {
        self.finish_transition(self.commit_main_runtime_forced(operation, force_hide)?)
    }

    /// The pure, testable half of a main-story transaction: clone both
    /// runtimes, run the command, settle the pair (host-control nodes, shared
    /// state, derived prompts), persist the profile and commit both runtimes in
    /// memory.  No native API is touched, so host tests can exercise it without a
    /// window.
    pub(crate) fn commit_main_runtime(
        &self,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<MainTransition, WireCommandError> {
        self.commit_main_runtime_forced(operation, false)
    }

    pub(crate) fn commit_main_runtime_forced(
        &self,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
        force_hide: bool,
    ) -> Result<MainTransition, WireCommandError> {
        self.commit_story_pair(
            force_hide,
            |pair| {
                let update = operation(&mut pair.primary).map_err(WireCommandError::from)?;
                pair.push(WindowRole::Main, update);
                Ok(())
            },
            Some(WindowRole::Main),
        )
    }

    /// The common story-owned transaction over the pair.  `run` produces the
    /// command's updates on the candidate pair; `origin` names the window whose
    /// first update is the command's response.
    pub(crate) fn commit_story_pair(
        &self,
        force_hide: bool,
        run: impl FnOnce(&mut Pair) -> Result<(), WireCommandError>,
        origin: Option<WindowRole>,
    ) -> Result<MainTransition, WireCommandError> {
        let mut runtime = self.runtime()?;
        let live = self.secondary()?.clone();
        let live_before = live.is_some();
        let mut pair = Pair::new(Authority::Story, runtime.clone(), live, live_before);
        if force_hide {
            // A hard ownership boundary (new game, load): the previous window is
            // gone before any node runs, so no authored request can address it.
            pair.hide_secondary();
        }
        pair.seed_secondary();
        // Everything below works on the candidate: a failure anywhere leaves the
        // previous valid pair completely untouched.
        run(&mut pair)?;
        self.settle(&mut pair)?;
        self.finish_pair(&mut pair, force_hide)?;
        let plan = self.plan_for(&pair);
        let committed = Committed::from_pair(&mut pair, origin);
        let (candidate, staged) = (pair.primary, pair.secondary);
        let previous_profile = runtime.profile_state(&self.content);
        let profile_written = self.commit_runtime(&runtime, &candidate)?;
        let previous_runtime = std::mem::replace(&mut *runtime, candidate);
        drop(runtime);
        // The secondary advances with every command (shared state, derived
        // prompt), so its slot is always part of the rollback baseline.
        let previous_secondary =
            SecondaryBaseline::install(&mut *self.secondary()?, staged, live_before);
        Ok(MainTransition {
            committed,
            plan,
            previous_runtime,
            previous_secondary,
            previous_profile,
            profile_written,
        })
    }

    /// Perform the staged native work for a committed transition, rolling the
    /// whole transition back if the native window or its title cannot be made to
    /// match the new state.
    pub(crate) fn finish_transition(
        &self,
        transition: MainTransition,
    ) -> Result<Committed, WireCommandError> {
        if let Err(error) = self.apply_native_plan(&transition.plan, &transition.committed.effects)
        {
            // Every rollback action is attempted, and every failure is reported:
            // a cleanup failure must never hide the fact that memory and the
            // profile were restored, and the caller must never be told only half
            // of what went wrong.
            let cleanup_failures = self.rollback_main_transition(&transition);
            return Err(aggregate_transition_failure(error, cleanup_failures));
        }
        Ok(transition.committed)
    }

    /// Undo a committed transition whose native window step failed, so the host
    /// never keeps a runtime that disagrees with the window that actually
    /// exists.  Returns every cleanup failure instead of stopping at the first
    /// one: restoring the in-memory state and the profile must not be skipped
    /// because a native rollback action failed (and vice versa), so the caller
    /// can report the whole picture from [`aggregate_transition_failure`].
    fn rollback_main_transition(&self, transition: &MainTransition) -> Vec<WireCommandError> {
        let mut failures = Vec::new();
        self.restore_secondary_slot(&transition.previous_secondary, &mut failures);
        match self.runtime() {
            Ok(mut runtime) => *runtime = transition.previous_runtime.clone(),
            Err(error) => failures.push(error),
        }
        if transition.profile_written {
            if let Err(error) = self.profile.save(&transition.previous_profile) {
                failures.push(error.into());
            }
        }
        self.rollback_native_state(
            &transition.previous_secondary,
            &transition.plan,
            &mut failures,
        );
        failures
    }

    /// Run one command of the main window against the active runtime (the
    /// replay's while one runs), publish everything it produced and return the
    /// update the main window receives as its response.
    pub(crate) fn transact_active_runtime(
        &self,
        expected_session_id: Option<&WireU64>,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<WireRuntimeUpdate, WireCommandError> {
        let _gate = self.session_gate()?;
        // The session check must happen while holding the same gate as the
        // runtime mutation.  Checking before acquiring it leaves a race in
        // which a replay can be entered between the check and the operation,
        // allowing a stale story request to mutate the new session.
        self.check_session(expected_session_id)?;
        let committed = if self.replay()?.is_some() {
            // Every replay path consumes the host-only window cue and stages the
            // window work it implies, so the cue can never reach the main window
            // and a replay can really own the secondary.
            self.transact_replay(operation)?
        } else {
            self.transact_runtime(operation)?
        };
        self.deliver(committed, WindowRole::Main)
    }

    /// Leave the story for the title screen (the session gate and the session
    /// check are the caller's).  Returns the new session generation.
    pub(crate) fn leave_story_for_title(&self) -> Result<u64, WireCommandError> {
        // Returning to the title is an ownership boundary: the title screen shows
        // no secondary window and must not leave one running behind it.  The
        // window is destroyed before the session generation is bumped, so a
        // failed destroy leaves the story session exactly as it was.
        self.close_secondary()?;
        let next = self.bump_session_id()?;
        // The title screen has no running story: timers stand still and the
        // native titles go back to the default.  A cosmetic title failure must
        // not strand the player on a story they left.
        self.set_title_screen(true);
        if let Err(error) = self.sync_native_titles() {
            eprintln!("返回标题后恢复窗口标题失败: {}", error.message);
        }
        // The title is not part of the story: the main window gets back the
        // position, size and layer it had before the story changed them.
        self.restore_main_window();
        Ok(next)
    }

    /// Restore one slot.  Both runtimes and the merged ledger are validated and
    /// staged before anything is persisted or committed, so a malformed slot
    /// leaves the previous session — including its live secondary window —
    /// completely intact.  The native window step is part of the same
    /// transaction and rolls everything back when it fails.
    pub(crate) fn apply_loaded_slot(
        &self,
        loaded: LoadedSlot,
    ) -> Result<Committed, WireCommandError> {
        let LoadedSlot {
            snapshot,
            history,
            secondary: stored,
        } = loaded;
        let transition = self.commit_story_pair(
            false,
            |pair| {
                if self
                    .content
                    .scenes
                    .get(&snapshot.location.scene_id)
                    .is_some_and(|scene| scene.window_role != WindowRole::Main)
                {
                    return Err(WireCommandError::new(
                        WireCommandErrorCode::Validation,
                        "存档的主窗口位置位于副窗口专用 Scene，已拒绝读取",
                    ));
                }
                // The previous window belongs to the previous session; it is gone
                // (with its blocks and title) before the saved state is read, so
                // nothing it left behind can be mistaken for restored state.
                pair.hide_secondary();
                let update = pair
                    .primary
                    .load_snapshot(&self.content, snapshot)
                    .map_err(WireCommandError::from)?;
                // Restore the merged ordered ledger stored with the slot.
                pair.primary.replace_dialogue_history(history);
                // Stage the restored secondary before the profile write so a bad
                // scene id or snapshot aborts the load with no partial
                // replacement.
                if let Some(stored) = stored {
                    let session = self.build_secondary_from_slot(&pair.primary, &stored)?;
                    pair.secondary = Some(session);
                    pair.staged = true;
                    pair.keep_owner = true;
                }
                let mut titles = pair.titles();
                if pair.secondary.is_none() {
                    titles.secondary.clear();
                } else if titles.secondary.is_empty() {
                    titles.secondary = DEFAULT_SECONDARY_TITLE.to_owned();
                }
                pair.set_titles(titles);
                pair.validate_restored_interaction()?;
                // The restored prompt follows the restored shared state (current
                // choices, interpolated text) without executing any node.
                pair.primary
                    .refresh_prompt(&self.content)
                    .map_err(WireCommandError::from)?;
                let mut update = update;
                update.snapshot = pair.primary.snapshot().clone();
                pair.push(WindowRole::Main, update);
                Ok(())
            },
            Some(WindowRole::Main),
        )?;
        self.finish_transition(transition)
    }
}
