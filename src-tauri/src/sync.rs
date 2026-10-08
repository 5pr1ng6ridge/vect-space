//! Reliable per-window update delivery.
//!
//! Every update a transaction produces is stamped with a per-window, per-session
//! sequence number and kept in a bounded outbox *after* the transaction has
//! committed (profile write and native window work included).  A command
//! response, a `vectspace://runtime-updated` notification and the incremental
//! `sync_updates` command all speak the same sequence, so a frontend applies
//! updates strictly in order, drops duplicates and recovers from a lost event
//! or a lost response without ever re-running a command.  The notification
//! itself carries no data and no control cue.

use std::{collections::VecDeque, sync::MutexGuard};

use vectspace_core::{
    interaction::{UpdateKind, WindowRole},
    model::{BootstrapPayload, CueGate, RuntimeUpdate},
    runtime::RuntimeEngine,
};
use vectspace_protocol::{
    WireCommandError, WireCommandErrorCode, WirePauseAck, WirePauseReason, WireRuntimeUpdate,
    WireSessionMode, WireSyncBatch, WireU64, WireUpdateNotice,
};

use crate::{
    pair::{Committed, Produced},
    secondary::secondary_missing,
    state::EngineState,
};

/// Per-window bound of the committed-update buffer.
pub(crate) const OUTBOX_CAPACITY: usize = 32;
pub(crate) const UPDATED_EVENT: &str = "vectspace://runtime-updated";

#[derive(Debug, Clone)]
pub(crate) struct OutboxEntry {
    pub seq: u64,
    pub mode: WireSessionMode,
    pub update: RuntimeUpdate,
}

#[derive(Debug, Default)]
pub(crate) struct WindowOutbox {
    /// The session (main: host session id, secondary: token) the buffer belongs to.
    session: u64,
    seq: u64,
    entries: VecDeque<OutboxEntry>,
    /// The latest story update that asked for an acknowledgement.  It is only
    /// handed out again while the runtime is still waiting for exactly it.
    pending: Option<RuntimeUpdate>,
}

impl WindowOutbox {
    /// A new session starts a new sequence.  The update the runtime may still be
    /// waiting on is kept: a session switch that keeps the runtime (leaving a
    /// replay, the title screen) must not lose the cues of an unacknowledged
    /// presentation.  It is only ever handed out while its id still matches the
    /// runtime's pending one.
    fn align(&mut self, session: u64) {
        if self.session != session {
            let pending = self.pending.take();
            *self = Self {
                session,
                pending,
                ..Self::default()
            };
        }
    }

    fn push(&mut self, mode: WireSessionMode, update: RuntimeUpdate) -> u64 {
        self.seq += 1;
        if update.kind == UpdateKind::Story {
            self.pending = update.requires_ack.then(|| update.clone());
        }
        self.entries.push_back(OutboxEntry {
            seq: self.seq,
            mode,
            update,
        });
        while self.entries.len() > OUTBOX_CAPACITY {
            self.entries.pop_front();
        }
        self.seq
    }

    pub(crate) fn seq(&self) -> u64 {
        self.seq
    }

    /// The buffered entries after `after`, or `None` when the buffer no longer
    /// reaches back that far (or the caller claims to be ahead of the host).
    fn since(&self, after: u64) -> Option<Vec<OutboxEntry>> {
        if after > self.seq {
            return None;
        }
        if after == self.seq {
            return Some(Vec::new());
        }
        let oldest = self.entries.front().map(|entry| entry.seq)?;
        if after + 1 < oldest {
            return None;
        }
        Some(
            self.entries
                .iter()
                .filter(|entry| entry.seq > after)
                .cloned()
                .collect(),
        )
    }
}

#[derive(Debug, Default)]
pub(crate) struct Outboxes {
    main: WindowOutbox,
    secondary: WindowOutbox,
}

impl Outboxes {
    fn window(&mut self, role: WindowRole) -> &mut WindowOutbox {
        match role {
            WindowRole::Main => &mut self.main,
            WindowRole::Secondary => &mut self.secondary,
        }
    }
}

/// Why the host's story timers may be paused.  Window focus never pauses.
#[derive(Debug, Clone, Copy)]
pub(crate) struct PauseState {
    /// A save/settings/history panel is open in the main window.
    pub panel: bool,
    pub main_hidden: bool,
    pub secondary_hidden: bool,
    /// The player is on the title screen, so there is no running story.
    pub title: bool,
}

impl Default for PauseState {
    fn default() -> Self {
        Self {
            panel: false,
            main_hidden: false,
            secondary_hidden: false,
            title: true,
        }
    }
}

/// Keep only the cues the runtime is actually waiting on, so a redelivered
/// pending update never replays a one-shot side effect (a sound effect...).
fn gated_cues_only(mut update: RuntimeUpdate) -> RuntimeUpdate {
    update.cues.retain(|cue| cue.gate == CueGate::Runtime);
    update
}

impl EngineState {
    pub(crate) fn outbox(&self) -> Result<MutexGuard<'_, Outboxes>, WireCommandError> {
        self.outbox.lock().map_err(|_| {
            WireCommandError::new(WireCommandErrorCode::Internal, "更新缓冲互斥锁已损坏")
        })
    }

    pub(crate) fn pause_state(&self) -> Result<MutexGuard<'_, PauseState>, WireCommandError> {
        self.pause.lock().map_err(|_| {
            WireCommandError::new(WireCommandErrorCode::Internal, "暂停状态互斥锁已损坏")
        })
    }

    /// Stamp, buffer and announce the updates of a committed transaction.
    /// Called with the session gate held and only after every fallible step
    /// (profile write, native window work) has succeeded, so a failed
    /// transaction can never be observed by a frontend.
    pub(crate) fn publish(
        &self,
        produced: Vec<Produced>,
        diagnostics: Vec<String>,
    ) -> Result<Vec<(WindowRole, WireRuntimeUpdate)>, WireCommandError> {
        for message in diagnostics {
            self.windows.report_diagnostic(&message);
        }
        if produced.is_empty() {
            return Ok(Vec::new());
        }
        let session = self.current_session_id();
        let main_mode = if self.replay()?.is_some() {
            WireSessionMode::Replay
        } else {
            WireSessionMode::Story
        };
        let secondary_token = self.secondary()?.as_ref().map(|session| session.token);
        let mut notices: Vec<(WindowRole, WireUpdateNotice)> = Vec::new();
        let mut published = Vec::with_capacity(produced.len());
        {
            let mut boxes = self.outbox()?;
            boxes.main.align(session);
            boxes.secondary.align(secondary_token.unwrap_or(0));
            for item in produced {
                let (outbox, session_id, mode) = match item.role {
                    WindowRole::Main => (&mut boxes.main, session, main_mode),
                    WindowRole::Secondary => {
                        let Some(token) = secondary_token else {
                            // The window closed in the same transaction.
                            continue;
                        };
                        (&mut boxes.secondary, token, WireSessionMode::Secondary)
                    }
                };
                let seq = outbox.push(mode, item.update.clone());
                published.push((
                    item.role,
                    WireRuntimeUpdate::with_session(item.update, WireU64::from(session_id), mode)
                        .with_seq(seq),
                ));
                let notice = WireUpdateNotice {
                    session_id: WireU64::from(session_id),
                    latest_seq: WireU64::from(seq),
                };
                match notices.iter_mut().find(|(role, _)| *role == item.role) {
                    Some(entry) => entry.1 = notice,
                    None => notices.push((item.role, notice)),
                }
            }
        }
        // Event delivery is best effort: a lost notification never undoes the
        // committed story, the frontend recovers through `sync_updates`.
        for (role, notice) in notices {
            self.windows.notify_updated(role, &notice);
        }
        self.wake_timers();
        Ok(published)
    }

    /// Publish a committed transaction and return the update the command's own
    /// window receives as its response.  The transaction is committed before
    /// this is called, so a missing response (the origin window closed in the
    /// same transaction) is reported *after* everything else was published.
    pub(crate) fn deliver(
        &self,
        committed: Committed,
        origin: WindowRole,
    ) -> Result<WireRuntimeUpdate, WireCommandError> {
        let own_update = committed
            .own
            .map(|index| committed.produced[index].update.update_id);
        let published = self.publish(committed.produced, committed.diagnostics)?;
        own_update
            .and_then(|own| {
                published
                    .into_iter()
                    .find(|(role, update)| {
                        *role == origin && update.update_id == WireU64::from(own)
                    })
                    .map(|(_, update)| update)
            })
            .ok_or_else(|| {
                WireCommandError::new(
                    WireCommandErrorCode::StaleSession,
                    "发起命令的窗口已在同一事务中关闭，请重新连接运行时",
                )
            })
    }

    /// The latest delivery sequence of a window.
    #[cfg(test)]
    pub(crate) fn latest_seq(&self, role: WindowRole) -> Result<u64, WireCommandError> {
        let session = match role {
            WindowRole::Main => self.current_session_id(),
            WindowRole::Secondary => self.secondary()?.as_ref().map_or(0, |s| s.token),
        };
        let mut boxes = self.outbox()?;
        let outbox = boxes.window(role);
        outbox.align(session);
        Ok(outbox.seq())
    }

    /// Run `f` on a window's live runtime and report its session id and mode.
    /// The *live* runtime (not a clone) is used on purpose: `bootstrap` advances
    /// the runtime's update counter, so an update id handed out here can never be
    /// reused by the next real update.
    fn with_window_runtime<T>(
        &self,
        role: WindowRole,
        f: impl FnOnce(&mut RuntimeEngine) -> T,
    ) -> Result<(u64, WireSessionMode, T), WireCommandError> {
        match role {
            WindowRole::Main => {
                let session = self.current_session_id();
                if let Some(replay) = self.replay()?.as_mut() {
                    return Ok((session, WireSessionMode::Replay, f(&mut replay.runtime)));
                }
                Ok((session, WireSessionMode::Story, f(&mut *self.runtime()?)))
            }
            WindowRole::Secondary => {
                let mut slot = self.secondary()?;
                let session = slot.as_mut().ok_or_else(secondary_missing)?;
                let token = session.token;
                Ok((token, WireSessionMode::Secondary, f(&mut session.runtime)))
            }
        }
    }

    /// Incremental synchronisation for one window.  Caller holds the session gate
    /// and has validated the session.
    pub(crate) fn sync_batch(
        &self,
        role: WindowRole,
        after_seq: u64,
    ) -> Result<WireSyncBatch, WireCommandError> {
        let (session, mode, (pending_id, mut refresh)) =
            self.with_window_runtime(role, |runtime| {
                let pending = runtime.pending_runtime_update();
                let mut refresh = runtime.bootstrap(&self.content).update;
                refresh.kind = UpdateKind::StateRefresh;
                (pending, refresh)
            })?;
        let mut boxes = self.outbox()?;
        let outbox = boxes.window(role);
        outbox.align(session);
        let latest = outbox.seq();
        let session_id = WireU64::from(session);
        if let Some(entries) = outbox.since(after_seq) {
            return Ok(WireSyncBatch {
                session_id: session_id.clone(),
                mode,
                latest_seq: WireU64::from(latest),
                updates: entries
                    .into_iter()
                    .map(|entry| {
                        WireRuntimeUpdate::with_session(
                            entry.update,
                            session_id.clone(),
                            entry.mode,
                        )
                        .with_seq(entry.seq)
                    })
                    .collect(),
                gap: false,
            });
        }
        // The buffer no longer reaches `after_seq`: hand out the update the
        // runtime is still waiting on (gated cues only) and the latest state.
        let waiting = outbox
            .pending
            .clone()
            .filter(|pending| pending_id == Some(pending.update_id));
        drop(boxes);
        let mut updates = Vec::new();
        if let Some(pending) = waiting {
            updates.push(
                WireRuntimeUpdate::with_session(gated_cues_only(pending), session_id.clone(), mode)
                    .with_seq(latest),
            );
        }
        refresh.cues.clear();
        refresh.requires_ack = false;
        updates.push(
            WireRuntimeUpdate::with_session(refresh, session_id.clone(), mode).with_seq(latest),
        );
        Ok(WireSyncBatch {
            session_id,
            mode,
            latest_seq: WireU64::from(latest),
            updates,
            gap: true,
        })
    }

    /// The window's bootstrap update: its current state, plus the update the
    /// runtime is still waiting on (if any) with its original id.
    pub(crate) fn bootstrap_update(
        &self,
        role: WindowRole,
    ) -> Result<(WireRuntimeUpdate, BootstrapPayload), WireCommandError> {
        let (session, mode, (pending_id, mut payload)) =
            self.with_window_runtime(role, |runtime| {
                (
                    runtime.pending_runtime_update(),
                    runtime.bootstrap(&self.content),
                )
            })?;
        let (waiting, seq) = {
            let mut boxes = self.outbox()?;
            let outbox = boxes.window(role);
            outbox.align(session);
            let waiting = outbox
                .pending
                .clone()
                .filter(|pending| pending_id == Some(pending.update_id));
            (waiting, outbox.seq())
        };
        if let Some(pending) = waiting {
            let pending = gated_cues_only(pending);
            payload.update.update_id = pending.update_id;
            payload.update.cues = pending.cues;
            payload.update.requires_ack = true;
        }
        let wire =
            WireRuntimeUpdate::with_session(payload.update.clone(), WireU64::from(session), mode)
                .with_seq(seq);
        Ok((wire, payload))
    }

    /// Record one window's pause report.  Window focus never pauses; the main
    /// window's panels and a fully hidden window pair do.
    pub(crate) fn set_pause(
        &self,
        role: WindowRole,
        reason: WirePauseReason,
        active: bool,
    ) -> Result<WirePauseAck, WireCommandError> {
        let has_secondary = self.secondary()?.is_some();
        let mut state = self.pause_state()?;
        match (role, reason) {
            (WindowRole::Main, WirePauseReason::Panel) => state.panel = active,
            (WindowRole::Main, WirePauseReason::Hidden) => state.main_hidden = active,
            (WindowRole::Secondary, WirePauseReason::Hidden) => state.secondary_hidden = active,
            (WindowRole::Secondary, WirePauseReason::Panel) => {
                return Err(WireCommandError::new(
                    WireCommandErrorCode::Validation,
                    "副窗口没有面板，不能上报面板暂停",
                ))
            }
        }
        let paused = Self::paused_by(&state, has_secondary);
        drop(state);
        self.wake_timers();
        Ok(WirePauseAck { ok: true, paused })
    }

    fn paused_by(state: &PauseState, has_secondary: bool) -> bool {
        state.title
            || state.panel
            || (state.main_hidden && (!has_secondary || state.secondary_hidden))
    }

    pub(crate) fn timers_paused(&self) -> bool {
        let has_secondary = self.secondary().map(|slot| slot.is_some()).unwrap_or(false);
        self.pause_state()
            .map(|state| Self::paused_by(&state, has_secondary))
            .unwrap_or(true)
    }

    /// A window (re)bootstrapped: whatever it reported before is void.
    pub(crate) fn clear_pause_reports(&self, role: WindowRole) {
        if let Ok(mut state) = self.pause_state() {
            match role {
                WindowRole::Main => {
                    state.panel = false;
                    state.main_hidden = false;
                }
                WindowRole::Secondary => state.secondary_hidden = false,
            }
        }
    }

    /// A new session starts with no pause reports; the title-screen flag is
    /// owned by the story entry points.
    pub(crate) fn reset_pause_reports(&self) {
        if let Ok(mut state) = self.pause_state() {
            state.panel = false;
            state.main_hidden = false;
            state.secondary_hidden = false;
        }
    }

    /// Undo [`Self::set_title_screen`] after a failed entry transaction and put
    /// the native titles back in line with it.
    pub(crate) fn restore_title_screen(&self, was_title: bool) {
        self.set_title_screen(was_title);
        if let Err(error) = self.sync_native_titles() {
            eprintln!("恢复窗口标题失败: {}", error.message);
        }
    }

    /// Mark whether the player is on the title screen.  Returns the previous value.
    pub(crate) fn set_title_screen(&self, on: bool) -> bool {
        match self.pause_state() {
            Ok(mut state) => std::mem::replace(&mut state.title, on),
            Err(_) => on,
        }
    }
}
