//! Host-owned Scene timers.
//!
//! The authoritative timer state lives in each runtime's snapshot (remaining
//! time, never an absolute process time), so it is saved, restored and cleared
//! together with the Scene that owns it.  This module only *feeds elapsed time*:
//! a host thread measures a monotonic clock, and every step is one ordinary
//! atomic pair transaction under the session gate.  A late task can therefore
//! never act on a newer session — it simply finds whatever state is current.
//! While the player has a panel open, or both windows are hidden, or the title
//! screen is showing, no time is credited at all (nothing is replayed on resume).

use std::sync::mpsc;

use vectspace_core::interaction::WindowRole;

use super::pair::{Pair, MAX_HOST_STEPS};
use super::*;

/// Upper bound of one scheduler sleep while a timer is active, so the stored
/// remaining time stays fresh for saves and a pause is noticed promptly.
const TIMER_TICK_CAP_MS: u64 = 100;
/// A single credited slice never exceeds this, so a suspended machine does not
/// burst every timer the moment it wakes up.
const MAX_TICK_ELAPSED_MS: u64 = 1_000;
/// Callback rounds one step may run before leaving the rest to the next step.
const MAX_TICK_ROUNDS: usize = 16;
const MAX_FAILURE_BACKOFF: Duration = Duration::from_secs(5);

impl EngineState {
    /// Wake the scheduler because timers or the pause state may have changed.
    pub(crate) fn wake_timers(&self) {
        if let Ok(guard) = self.timer_wake.lock() {
            if let Some(sender) = guard.as_ref() {
                let _ = sender.send(());
            }
        }
    }

    /// The smallest remaining time of any runnable timer of the active pair, or
    /// `None` when nothing needs the scheduler (no timers, paused, or every
    /// timer's runtime is waiting for an acknowledgement).
    pub(crate) fn next_timer_wait(&self) -> Option<Duration> {
        if self.timers_paused() {
            return None;
        }
        let mut minimum: Option<u64> = None;
        let mut consider = |runtime: &RuntimeEngine| {
            // A runtime that waits for an acknowledgement still lets its timers
            // run down (a due callback is deferred, not lost), but a timer that is
            // already due cannot do anything until the gate is released.
            let gated = runtime.pending_runtime_update().is_some();
            for timer in runtime.snapshot().interaction.timers.values() {
                if gated && timer.remaining_ms == 0 {
                    continue;
                }
                minimum = Some(minimum.map_or(timer.remaining_ms, |current| {
                    current.min(timer.remaining_ms)
                }));
            }
        };
        // Locks are taken one at a time and never nested with the gate-holding
        // transactions' orders.
        let replay_active = match self.replay.lock() {
            Ok(replay) => match replay.as_ref() {
                Some(session) => {
                    consider(&session.runtime);
                    true
                }
                None => false,
            },
            Err(_) => return None,
        };
        if !replay_active {
            match self.runtime.lock() {
                Ok(main) => consider(&main),
                Err(_) => return None,
            }
        }
        if let Ok(slot) = self.secondary.lock() {
            if let Some(session) = slot.as_ref() {
                consider(&session.runtime);
            }
        }
        minimum.map(|remaining| Duration::from_millis(remaining.clamp(1, TIMER_TICK_CAP_MS)))
    }

    /// Credit `elapsed_ms` of story time to the active window pair.
    pub(crate) fn timer_step(&self, elapsed_ms: u64) -> Result<(), WireCommandError> {
        let _gate = self.session_gate()?;
        if self.timers_paused() {
            return Ok(());
        }
        let replay_active = self.replay()?.is_some();
        if !self.timer_due(elapsed_ms, replay_active)? {
            return self.tick_in_place(elapsed_ms, replay_active);
        }
        match self.run_due_timers(elapsed_ms, replay_active) {
            Ok(()) => Ok(()),
            Err(error) => {
                // The failed round was rolled back, so every due timer is still
                // due and would fail again on the next tick.  Stop them instead
                // of producing a background error storm, and say so.
                self.stop_failed_timers(elapsed_ms, replay_active, &error);
                Err(error)
            }
        }
    }

    fn run_due_timers(&self, elapsed_ms: u64, replay_active: bool) -> Result<(), WireCommandError> {
        let committed = if replay_active {
            let transition =
                self.commit_replay_pair(|pair| self.run_timers(pair, elapsed_ms), None)?;
            self.finish_replay_transition(transition)?
        } else {
            let transition =
                self.commit_story_pair(false, |pair| self.run_timers(pair, elapsed_ms), None)?;
            self.finish_transition(transition)?
        };
        self.publish(committed.produced, committed.diagnostics)?;
        Ok(())
    }

    /// Stop every timer that was due in a round that could not be committed.
    /// Best effort: if even this fails, the scheduler's backoff bounds the
    /// retries.
    fn stop_failed_timers(&self, elapsed_ms: u64, replay_active: bool, error: &WireCommandError) {
        let stop = |pair: &mut Pair| -> Result<(), WireCommandError> {
            let mut stopped = Vec::new();
            for role in [WindowRole::Main, WindowRole::Secondary] {
                let Some(runtime) = pair.runtime_mut(role) else {
                    continue;
                };
                let due: Vec<String> = runtime
                    .snapshot()
                    .interaction
                    .timers
                    .iter()
                    .filter(|(_, timer)| timer.remaining_ms <= elapsed_ms)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in due {
                    runtime.stop_timer(&id);
                    stopped.push(format!("计时器 {id} 已停止：{}", error.message));
                }
            }
            pair.diagnostics.extend(stopped);
            Ok(())
        };
        let result = if replay_active {
            self.commit_replay_pair(stop, None)
                .and_then(|transition| self.finish_replay_transition(transition))
        } else {
            self.commit_story_pair(false, stop, None)
                .and_then(|transition| self.finish_transition(transition))
        };
        match result {
            Ok(committed) => {
                if let Err(publish_error) = self.publish(committed.produced, committed.diagnostics)
                {
                    self.windows.report_diagnostic(&format!(
                        "计时器停止后发布状态失败：{}",
                        publish_error.message
                    ));
                }
            }
            Err(stop_error) => self.windows.report_diagnostic(&format!(
                "计时器失败后无法停止（{}）：{}",
                error.message, stop_error.message
            )),
        }
    }

    fn timer_due(&self, elapsed_ms: u64, replay_active: bool) -> Result<bool, WireCommandError> {
        let due = |runtime: &RuntimeEngine| {
            runtime.pending_runtime_update().is_none()
                && runtime
                    .snapshot()
                    .interaction
                    .timers
                    .values()
                    .any(|timer| timer.remaining_ms <= elapsed_ms)
        };
        let primary_due = if replay_active {
            self.replay()?
                .as_ref()
                .is_some_and(|session| due(&session.runtime))
        } else {
            due(&*self.runtime()?)
        };
        Ok(primary_due
            || self
                .secondary()?
                .as_ref()
                .is_some_and(|session| due(&session.runtime)))
    }

    /// Nothing is due: only the stored remaining time moves.  No candidate, no
    /// revision bump, no update.
    fn tick_in_place(&self, elapsed_ms: u64, replay_active: bool) -> Result<(), WireCommandError> {
        if elapsed_ms == 0 {
            return Ok(());
        }
        let (updates, _) = if replay_active {
            match self.replay()?.as_mut() {
                Some(session) => session.runtime.tick_timers(&self.content, elapsed_ms),
                None => (Vec::new(), Vec::new()),
            }
        } else {
            self.runtime()?.tick_timers(&self.content, elapsed_ms)
        };
        debug_assert!(
            updates.is_empty(),
            "an in-place tick must not run a callback"
        );
        if let Some(session) = self.secondary()?.as_mut() {
            let (updates, _) = session.runtime.tick_timers(&self.content, elapsed_ms);
            debug_assert!(
                updates.is_empty(),
                "an in-place tick must not run a callback"
            );
        }
        Ok(())
    }

    /// Run the callbacks of every due timer of both windows.  A timer whose host
    /// requests cannot be applied (for example a title for a window that no
    /// longer exists) is stopped with a diagnostic instead of failing again on
    /// every following tick.
    pub(crate) fn run_timers(
        &self,
        pair: &mut Pair,
        elapsed_ms: u64,
    ) -> Result<(), WireCommandError> {
        let mut elapsed = elapsed_ms;
        let mut failures = 0usize;
        let mut rounds = 0usize;
        while rounds < MAX_TICK_ROUNDS && failures < MAX_HOST_STEPS {
            rounds += 1;
            let backup = pair.clone();
            let mut fired = false;
            let mut requesting: Vec<(WindowRole, String)> = Vec::new();
            for role in [WindowRole::Main, WindowRole::Secondary] {
                let queued_before = pair.queued_requests(role);
                let Some(runtime) = pair.runtime_mut(role) else {
                    continue;
                };
                let (updates, diagnostics) = runtime.tick_timers(&self.content, elapsed);
                let last = runtime.last_fired_timer().map(str::to_owned);
                fired |= !updates.is_empty() || !diagnostics.is_empty();
                pair.diagnostics.extend(diagnostics);
                for update in updates {
                    pair.push(role, update);
                }
                if pair.queued_requests(role) > queued_before {
                    if let Some(id) = last {
                        requesting.push((role, id));
                    }
                }
            }
            match self.settle(pair) {
                Ok(()) => {
                    elapsed = 0;
                    if !fired {
                        break;
                    }
                }
                Err(error) if !requesting.is_empty() => {
                    *pair = backup;
                    for (role, id) in requesting {
                        if let Some(runtime) = pair.runtime_mut(role) {
                            runtime.stop_timer(&id);
                        }
                        pair.diagnostics
                            .push(format!("计时器 {id} 已停止：{}", error.message));
                    }
                    failures += 1;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}

/// Start the scheduler thread and return the sender that wakes it.
pub(crate) fn spawn_timer_scheduler(app: tauri::AppHandle) -> mpsc::Sender<()> {
    let (sender, receiver) = mpsc::channel::<()>();
    let spawned = std::thread::Builder::new()
        .name("vectspace-timers".to_owned())
        .spawn(move || {
            let mut last = Instant::now();
            let mut failures: u32 = 0;
            loop {
                let Some(state) = app.try_state::<EngineState>() else {
                    match receiver.recv_timeout(Duration::from_millis(200)) {
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                        _ => continue,
                    }
                };
                let wait = if failures > 0 {
                    Some(
                        (Duration::from_millis(100) * 2u32.saturating_pow(failures.min(6)))
                            .min(MAX_FAILURE_BACKOFF),
                    )
                } else {
                    state.next_timer_wait()
                };
                match wait {
                    None => {
                        if receiver.recv().is_err() {
                            return;
                        }
                    }
                    Some(duration) => {
                        if let Err(mpsc::RecvTimeoutError::Disconnected) =
                            receiver.recv_timeout(duration)
                        {
                            return;
                        }
                    }
                }
                let now = Instant::now();
                if wait.is_none() {
                    // Woken from idle: no timer existed before, nothing elapsed.
                    last = now;
                    continue;
                }
                let elapsed = now.saturating_duration_since(last);
                last = now;
                if state.timers_paused() {
                    continue;
                }
                let elapsed_ms = (elapsed.as_millis() as u64).min(MAX_TICK_ELAPSED_MS);
                match state.timer_step(elapsed_ms) {
                    Ok(()) => failures = 0,
                    Err(error) => {
                        failures = failures.saturating_add(1);
                        if failures == 1 || failures.is_power_of_two() {
                            state.windows.report_diagnostic(&format!(
                                "定时器步骤失败，已退避重试：{}",
                                error.message
                            ));
                        }
                    }
                }
            }
        });
    if let Err(error) = spawned {
        eprintln!("无法启动定时器线程: {error}");
    }
    sender
}
