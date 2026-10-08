//! Isolated Scene replays.
//!
//! A replay is a second story runtime that is kept apart from the player's: it
//! borrows a cloned profile at start and is never persisted.  Everything it
//! produces is published to the replay runtime only, so a save, the profile file
//! or the official dialogue ledger can never observe replayed play.

use std::sync::atomic::Ordering;

use vectspace_core::{
    interaction::WindowRole,
    model::RuntimeUpdate,
    runtime::{self, RuntimeEngine},
};
use vectspace_protocol::{WireCommandError, WireCommandErrorCode};

use crate::{
    native_plan::{aggregate_transition_failure, SecondaryBaseline, SecondaryPlan},
    pair::{Authority, Committed, Pair},
    secondary::SecondaryOwner,
    state::EngineState,
};

/// Replay session ids live above this stride, disjoint from the main story's
/// small range, so delayed cue acknowledgements cannot be applied to another
/// session after the user returns to the map.
const REPLAY_ID_STRIDE: u64 = 1 << 32;

/// A replay is deliberately kept separate from the player's runtime.  It
/// borrows a cloned profile/default state at start and is never persisted.
/// `ending` prevents a cross-scene jump from evaluating its destination;
/// `generation` identifies this replay for as long as it lives, so a
/// secondary slot and a delayed secondary command can always be attributed to
/// the exact replay that owns them.
#[derive(Debug, Clone)]
pub(crate) struct ReplaySession {
    pub(crate) runtime: RuntimeEngine,
    pub(crate) scene_id: String,
    pub(crate) ending: bool,
    pub(crate) generation: u64,
    /// Whether the host was on the title screen (the chapter map) when the
    /// replay started; leaving the replay goes back there.
    pub(crate) was_title: bool,
}

/// A committed replay transaction.  The replay runtime, the secondary slot and
/// the native window plan move together: the native step happens after the
/// in-memory commit (window work can re-enter the platform event loop), and
/// `previous_*` keeps the rollback data for the one case where that step fails,
/// so a replay can never be reported as running with a missing or foreign
/// window.
#[derive(Debug)]
pub(crate) struct ReplayTransition {
    committed: Committed,
    plan: SecondaryPlan,
    previous_replay: Option<ReplaySession>,
    previous_secondary: SecondaryBaseline,
}

impl EngineState {
    /// Run one isolated-replay command and perform its staged native work.
    pub(crate) fn transact_replay(
        &self,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<Committed, WireCommandError> {
        self.finish_replay_transition(self.commit_replay(operation)?)
    }

    /// The pure half of a replay transaction: clone the replay runtime and the
    /// secondary it owns, run the command, settle the pair and commit both.  No
    /// native API is touched here, so host tests can drive every replay path
    /// without a window.
    ///
    /// A replay stays isolated from the player's runtime: it borrows a cloned
    /// profile/default state at start and is never persisted, so everything the
    /// pair produces is published to the *replay* runtime only — never to
    /// `runtime`, [`Self::commit_runtime`] or the profile file.
    fn commit_replay(
        &self,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<ReplayTransition, WireCommandError> {
        self.commit_replay_pair_for(
            None,
            |pair| {
                let update = operation(&mut pair.primary).map_err(WireCommandError::from)?;
                pair.push(WindowRole::Main, update);
                Ok(())
            },
            Some(WindowRole::Main),
        )
    }

    pub(crate) fn commit_replay_pair(
        &self,
        run: impl FnOnce(&mut Pair) -> Result<(), WireCommandError>,
        origin: Option<WindowRole>,
    ) -> Result<ReplayTransition, WireCommandError> {
        self.commit_replay_pair_for(None, run, origin)
    }

    /// `expected_generation` pins the transaction to one replay: a delayed
    /// command from an ended replay is refused instead of mutating a newer one.
    pub(crate) fn commit_replay_pair_for(
        &self,
        expected_generation: Option<u64>,
        run: impl FnOnce(&mut Pair) -> Result<(), WireCommandError>,
        origin: Option<WindowRole>,
    ) -> Result<ReplayTransition, WireCommandError> {
        let mut slot = self.replay()?;
        let session = slot.take().ok_or_else(replay_missing)?;
        let generation = session.generation;
        let candidate = (|| {
            if expected_generation.is_some_and(|expected| expected != generation) {
                return Err(WireCommandError::new(
                    WireCommandErrorCode::StaleSession,
                    "重演会话已结束，请重新连接运行时",
                ));
            }
            let live = self
                .secondary()?
                .as_ref()
                .filter(|candidate| candidate.owner == SecondaryOwner::Replay { generation })
                .cloned();
            let live_before = live.is_some();
            let mut pair = Pair::new(
                Authority::Replay { generation },
                session.runtime.clone(),
                live,
                live_before,
            );
            pair.replay_ending_before = session.ending;
            pair.set_scene_baseline(&session.scene_id);
            pair.seed_secondary();
            run(&mut pair)?;
            self.settle(&mut pair)?;
            self.finish_pair(&mut pair, false)?;
            Ok(pair)
        })();
        let mut pair = match candidate {
            Ok(pair) => pair,
            Err(error) => {
                // An invalid acknowledgement or a rejected operation leaves the
                // live replay exactly where it was.
                *slot = Some(session);
                return Err(error);
            }
        };
        let plan = self.plan_for(&pair);
        let live_before = pair.live_before;
        let committed = Committed::from_pair(&mut pair, origin);
        let closing = pair.closing;
        let (runtime, staged) = (pair.primary, pair.secondary);
        // Keep the *exact* previous session for rollback: the slot was taken at
        // the top of this transaction, so replacing into it would report `None`
        // and a failed native step would clear a replay that is still live.
        *slot = Some(ReplaySession {
            runtime,
            scene_id: session.scene_id.clone(),
            ending: closing,
            generation,
            was_title: session.was_title,
        });
        let previous_replay = Some(session);
        drop(slot);
        let previous_secondary =
            SecondaryBaseline::install(&mut *self.secondary()?, staged, live_before);
        Ok(ReplayTransition {
            committed,
            plan,
            previous_replay,
            previous_secondary,
        })
    }

    /// Perform the staged native work for a committed replay transition,
    /// restoring the replay *and* the secondary slot when it fails, so a replay
    /// can never keep running with a window that belongs to someone else.
    pub(crate) fn finish_replay_transition(
        &self,
        transition: ReplayTransition,
    ) -> Result<Committed, WireCommandError> {
        if let Err(error) = self.apply_native_plan(&transition.plan, &transition.committed.effects)
        {
            let cleanup_failures = self.rollback_replay_state(
                transition.previous_replay.clone(),
                &transition.previous_secondary,
                &transition.plan,
            );
            return Err(aggregate_transition_failure(error, cleanup_failures));
        }
        Ok(transition.committed)
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
        self.restore_secondary_slot(previous_secondary, &mut failures);
        match self.replay() {
            Ok(mut slot) => *slot = previous_replay,
            Err(error) => failures.push(error),
        }
        self.rollback_native_state(previous_secondary, plan, &mut failures);
        failures
    }

    /// A replay is a running story: it leaves the title screen (the chapter
    /// map), so its native titles and timers are live.  A failed entry puts the
    /// previous title-screen state back.
    pub(crate) fn enter_replay(&self, scene_id: &str) -> Result<Committed, WireCommandError> {
        let was_title = self.set_title_screen(false);
        let entered = self.enter_replay_session(scene_id, was_title);
        if entered.is_err() {
            self.restore_title_screen(was_title);
        }
        entered
    }

    fn enter_replay_session(
        &self,
        scene_id: &str,
        was_title: bool,
    ) -> Result<Committed, WireCommandError> {
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
        if self
            .content
            .scenes
            .get(scene_id)
            .is_some_and(|scene| scene.window_role != WindowRole::Main)
        {
            return Err(WireCommandError::new(
                WireCommandErrorCode::Validation,
                "副窗口专用 Scene 不能作为章节重演入口",
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
        let id_base = generation.checked_mul(REPLAY_ID_STRIDE).ok_or_else(|| {
            WireCommandError::new(WireCommandErrorCode::Internal, "重演会话编号耗尽")
        })?;
        replay_runtime.prepare_session_ids(id_base, id_base, id_base);
        // Entry is an ownership boundary: the main story is suspended behind the
        // replay, so a story-owned window cannot outlive it — unless the replay's
        // own entry opens a window, in which case the very same native window is
        // re-pointed to the replay instead of being destroyed and rebuilt (a
        // destroy is only queued, and the label it leaves behind must never be
        // adopted by a new owner).  The pair therefore starts without a
        // secondary while the live one only counts as `live_before`.
        let live_before = self.secondary()?.is_some();
        // The story-owned window is destroyed by this entry, so the advance
        // blocks it placed on the suspended story and its title go with it.
        let detached_story = if live_before {
            let mut story = self.runtime()?.clone();
            detach_secondary_effects(&mut story);
            Some(story)
        } else {
            None
        };
        let mut pair = Pair::new(
            Authority::Replay { generation },
            replay_runtime,
            None,
            live_before,
        );
        pair.set_scene_baseline(scene_id);
        let first = pair
            .primary
            .start_scene_preview(&self.content, scene_id)
            .map_err(WireCommandError::from)?;
        pair.push(WindowRole::Main, first);
        self.settle(&mut pair)?;
        self.finish_pair(&mut pair, false)?;
        let plan = self.plan_for(&pair);
        let committed = Committed::from_pair(&mut pair, Some(WindowRole::Main));
        let ending = pair.closing;
        let (runtime, staged) = (pair.primary, pair.secondary);
        let previous_replay = (*self.replay()?).replace(ReplaySession {
            runtime,
            scene_id: scene_id.to_owned(),
            ending,
            generation,
            was_title,
        });
        let previous_story = match detached_story {
            Some(story) => Some(std::mem::replace(&mut *self.runtime()?, story)),
            None => None,
        };
        let previous_secondary =
            SecondaryBaseline::install(&mut *self.secondary()?, staged, live_before);
        if let Err(error) = self.apply_native_plan(&plan, &committed.effects) {
            let mut cleanup_failures =
                self.rollback_replay_state(previous_replay, &previous_secondary, &plan);
            if let Some(story) = previous_story {
                match self.runtime() {
                    Ok(mut runtime) => *runtime = story,
                    Err(error) => cleanup_failures.push(error),
                }
            }
            return Err(aggregate_transition_failure(error, cleanup_failures));
        }
        // The generation only changes once the entry really committed, so a
        // failed entry leaves the previous session id valid for the frontend.
        self.bump_session_id()?;
        Ok(committed)
    }

    /// Leave the live replay.  A replay-owned secondary is closed *before* the
    /// replay slot is cleared: a failed destroy keeps both, so the exit can be
    /// retried instead of orphaning a window that no session owns any more.
    pub(crate) fn exit_replay(&self) -> Result<(), WireCommandError> {
        let Some((generation, was_title)) = self
            .replay()?
            .as_ref()
            .map(|session| (session.generation, session.was_title))
        else {
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
            self.hide_native_secondary()?;
            *self.secondary()? = None;
        }
        *self.replay()? = None;
        self.bump_session_id()?;
        // Back on the chapter map the suspended story's timers stand still
        // again, and the real story's (or the default) titles come back.  A
        // failure here is only a stale native title: the next transition
        // retries it.
        self.set_title_screen(was_title);
        if let Err(error) = self.sync_native_titles() {
            eprintln!("退出重演后恢复窗口标题失败: {}", error.message);
        }
        // The replay may have moved, resized or re-layered the main window; it
        // goes back to what it was before the story touched it.
        self.restore_main_window();
        Ok(())
    }
}

/// Drop what a closed secondary window left on the story runtime: the advance
/// blocks it placed and its title.
fn detach_secondary_effects(runtime: &mut RuntimeEngine) {
    let scenes: Vec<String> = runtime
        .snapshot()
        .interaction
        .blocks
        .iter()
        .filter(|block| block.source == WindowRole::Secondary)
        .map(|block| block.source_scene.clone())
        .collect();
    for scene in scenes {
        runtime.clear_blocks_from(WindowRole::Secondary, &scene);
    }
    let mut titles = runtime.snapshot().interaction.titles.clone();
    titles.secondary.clear();
    runtime.set_window_titles(titles);
}

/// The error reported when a replay command arrives without a live replay.  Kept
/// in one place so the entry, advance and acknowledgement paths agree.
fn replay_missing() -> WireCommandError {
    WireCommandError::new(
        WireCommandErrorCode::Runtime,
        "当前没有正在进行的 Scene 重演",
    )
}
