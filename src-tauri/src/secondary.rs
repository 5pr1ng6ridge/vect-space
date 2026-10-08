//! The secondary game window's session and its commands.
//!
//! The secondary window is a single, bounded slot: exactly one may exist, and
//! repeating `open_window` re-points the same native window with a fresh token.
//! This module builds and restores those sessions, validates their tokens and
//! runs the commands the secondary window sends.

use std::sync::atomic::Ordering;

use vectspace_core::{
    interaction::{WindowRole, WindowTitles},
    model::RuntimeUpdate,
    runtime::{self, RuntimeEngine},
};
use vectspace_protocol::{WireBootstrapPayload, WireCommandError, WireCommandErrorCode, WireU64};

use crate::{
    pair::{Committed, Pair},
    save::SecondaryState,
    state::EngineState,
};

/// Kept disjoint from the replay namespace so an isolated secondary session can
/// never share a revision/update namespace with a replay session.
pub(crate) const SECONDARY_ID_STRIDE: u64 = 1 << 40;

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
pub(crate) enum SecondaryOwner {
    /// The main story owns the window.
    Story { scene_id: String },
    /// One live replay owns the window, identified by its generation.
    Replay { generation: u64 },
}

impl SecondaryOwner {
    /// The main-story Scene that owns the window, if the main story owns it.
    pub(crate) fn story_scene(&self) -> Option<&str> {
        match self {
            SecondaryOwner::Story { scene_id } => Some(scene_id),
            SecondaryOwner::Replay { .. } => None,
        }
    }
}

/// The session held in the single secondary slot.
#[derive(Debug, Clone)]
pub(crate) struct SecondarySession {
    pub(crate) runtime: RuntimeEngine,
    /// Scene currently shown by the secondary runtime.
    pub(crate) scene_id: String,
    /// Story or replay that owns the window; see [`SecondaryOwner`].
    pub(crate) owner: SecondaryOwner,
    /// Wire token identifying this secondary instance.
    pub(crate) token: u64,
}

impl EngineState {
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
    /// seeded from `main` — which is the candidate this transaction is about to
    /// commit — before any node of the opening Scene evaluates.  Returns the
    /// session and the update of its opening run, which the caller records on
    /// the pair like any other step.
    pub(crate) fn build_secondary_session(
        &self,
        main: &RuntimeEngine,
        scene_id: &str,
        owner: SecondaryOwner,
        token: u64,
        id_base: u64,
        titles: WindowTitles,
    ) -> Result<(SecondarySession, RuntimeUpdate), WireCommandError> {
        let mut runtime = self.seed_secondary_runtime(main)?;
        runtime.prepare_session_ids(id_base, id_base, id_base);
        // The secondary shares the host-authoritative variable maps, so its own
        // Scene boundaries must preserve them.
        runtime.set_shared_save_variables(true);
        // The opening nodes already see the live window titles.
        runtime.prepare_window_titles(titles);
        let first = runtime
            .start_scene_preview(&self.content, scene_id)
            .map_err(WireCommandError::from)?;
        Ok((
            SecondarySession {
                runtime,
                scene_id: scene_id.to_owned(),
                owner,
                token,
            },
            first,
        ))
    }

    pub(crate) fn bump_secondary_generation(&self) -> Result<u64, WireCommandError> {
        self.secondary_generation
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(1)
            })
            .map(|value| value + 1)
            .map_err(|_| WireCommandError::new(WireCommandErrorCode::Internal, "副窗口编号耗尽"))
    }

    pub(crate) fn check_secondary_session(
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
            WireCommandError::new(
                WireCommandErrorCode::Runtime,
                "当前没有正在运行的副窗口会话",
            )
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
    /// completed), never let its Scene boundary reset the shared Save map, and
    /// re-derive the *main* window's prompt from whatever the command changed.
    pub(crate) fn transact_secondary(
        &self,
        expected_session_id: Option<&WireU64>,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<(Committed, u64), WireCommandError> {
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

    /// The step of one secondary command: validate the token, run the operation
    /// on the secondary candidate and record its update.
    fn secondary_step(
        pair: &mut Pair,
        token: u64,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<(), WireCommandError> {
        let session = pair.secondary.as_mut().ok_or_else(secondary_missing)?;
        if session.token != token {
            return Err(WireCommandError::new(
                WireCommandErrorCode::StaleSession,
                "副窗口会话已切换，请重新连接运行时",
            ));
        }
        let update = operation(&mut session.runtime).map_err(WireCommandError::from)?;
        pair.push(WindowRole::Secondary, update);
        Ok(())
    }

    /// A story-owned secondary command: publish into the main runtime and
    /// persist the resulting profile, exactly like the single-window host.
    fn transact_secondary_against_story(
        &self,
        token: u64,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<(Committed, u64), WireCommandError> {
        let transition = self.commit_story_pair(
            false,
            |pair| Self::secondary_step(pair, token, operation),
            Some(WindowRole::Secondary),
        )?;
        Ok((self.finish_transition(transition)?, token))
    }

    /// A replay-owned secondary command: the replay runtime is the only
    /// authority.  The command is refused when the owning replay is gone, so a
    /// delayed request from an ended replay can never mutate a newer owner.
    pub(crate) fn transact_secondary_against_replay(
        &self,
        token: u64,
        generation: u64,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<(Committed, u64), WireCommandError> {
        let transition = self.commit_replay_pair_for(
            Some(generation),
            |pair| Self::secondary_step(pair, token, operation),
            Some(WindowRole::Secondary),
        )?;
        Ok((self.finish_replay_transition(transition)?, token))
    }

    /// Tear the secondary slot down outside a story transaction (returning to
    /// the title).  The native window is destroyed *before* the slot is cleared,
    /// so a failed destroy leaves a live window that still owns its session
    /// instead of a session whose window no longer exists.
    pub(crate) fn close_secondary(&self) -> Result<(), WireCommandError> {
        let live = self.secondary()?.is_some();
        if !live {
            return Ok(());
        }
        self.hide_native_secondary()?;
        *self.secondary()? = None;
        Ok(())
    }

    /// Rebuild a secondary runtime from persisted state.  Shared variables come
    /// from the freshly loaded main runtime, never from the slot's secondary
    /// copy, so the main snapshot stays the single authority.
    pub(crate) fn build_secondary_from_slot(
        &self,
        main: &RuntimeEngine,
        stored: &SecondaryState,
    ) -> Result<SecondarySession, WireCommandError> {
        let Some(scene) = self.content.scenes.get(&stored.scene_id) else {
            return Err(WireCommandError::new(
                WireCommandErrorCode::Validation,
                format!("存档中的副窗口场景不存在: {}", stored.scene_id),
            ));
        };
        if scene.window_role != WindowRole::Secondary {
            return Err(WireCommandError::new(
                WireCommandErrorCode::Validation,
                format!(
                    "存档中的副窗口场景 {} 不是副窗口专用 Scene",
                    stored.scene_id
                ),
            ));
        }
        if stored.owning_scene != main.snapshot().location.scene_id {
            return Err(WireCommandError::new(
                WireCommandErrorCode::Validation,
                format!(
                    "存档中的副窗口属于场景 {}，与主窗口当前场景 {} 不一致",
                    stored.owning_scene,
                    main.snapshot().location.scene_id
                ),
            ));
        }
        let token = self.bump_secondary_generation()?;
        let id_base = token.checked_mul(SECONDARY_ID_STRIDE).ok_or_else(|| {
            WireCommandError::new(WireCommandErrorCode::Internal, "副窗口编号耗尽")
        })?;
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
        })
    }

    /// The secondary window's bootstrap payload.  It never loads settings, save
    /// slots, chapter maps or history: the secondary has normal gameplay and
    /// nothing else.  A runtime-gated presentation produced while the session
    /// was staged is delivered with its original update id: the runtime is
    /// waiting for exactly that acknowledgement, and a cue-less bootstrap would
    /// leave the secondary permanently locked.  Once it has been acknowledged
    /// the ordinary bootstrap is authoritative again.
    pub(crate) fn secondary_bootstrap_payload(
        &self,
    ) -> Result<WireBootstrapPayload, WireCommandError> {
        let (update, payload) = self.bootstrap_update(WindowRole::Secondary)?;
        // The window starts over: whatever it reported about itself is void.
        self.clear_pause_reports(WindowRole::Secondary);
        Ok(WireBootstrapPayload {
            update,
            asset_ids: payload.asset_ids,
            content_version: payload.content_version,
            chapter_map_available: false,
            default_font: payload.default_font,
            text_blocks: payload.text_blocks,
            particles: payload.particles,
        })
    }
}

/// The error reported when a secondary command arrives without a live secondary
/// session.  Kept in one place so every secondary path agrees.
pub(crate) fn secondary_missing() -> WireCommandError {
    WireCommandError::new(
        WireCommandErrorCode::Runtime,
        "当前没有正在运行的副窗口会话",
    )
}
