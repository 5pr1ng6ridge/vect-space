//! Native window effects of the `window_geometry` and `window_layer` nodes.
//!
//! The story only *requests* these effects: core queues a
//! `WindowRequest::Geometry`/`Layer`, `pair.rs` checks that the windows it names
//! exist and records the effect, in node order, on the candidate pair.  Nothing
//! in this module runs before the whole transaction is committed, and a rolled
//! back or discarded transaction never produces an effect.  After the commit,
//! the window plan (open/hide) and the titles, the host applies the effects with
//! every runtime mutex released (see `EngineState::apply_native_plan`).  A native
//! failure here is only a diagnostic: animations are asynchronous, so there is
//! nothing the story could be rolled back to.  The pure frame arithmetic lives in
//! [`geometry`].
//!
//! # Animation
//!
//! One animation per window.  A new effect replaces the old animation and starts
//! from the frame that is on screen right now.  The scheduler thread measures a
//! monotonic clock and feeds elapsed time to [`EngineState::fx_step`] at about
//! 60 Hz — exactly like the timers, so tests step it by hand.  Pausing the story
//! (a panel, a hidden window) does not stop it.  Every ~250 ms of animation the
//! window is checked, and a window that became full screen or maximized aborts
//! its animation.
//!
//! # Layers
//!
//! The host tracks each window's layer (normal, always-on-top, always-on-bottom).
//! `raise` is "above the other windows without taking focus": on Windows
//! switching always-on-top on and off again puts the window on top of the normal
//! windows with `SWP_NOACTIVATE`.  While always-on-bottom is set tao rewrites
//! every z-order change of the window to `HWND_BOTTOM`, so not even activating
//! it raises it: `raise` and `focus` therefore lift the bottom pin first (the
//! window ends up normal) and `normal` after `bottom` merely unpins the window,
//! which stays where it is until something raises it.  Always-on-top is a
//! property rather than a position, so `raise` leaves it and `focus` keeps it.
//!
//! # Restoring
//!
//! Saves never record window geometry.  The first time a story effect actually
//! moves or resizes the main window in a session, its previous frame is
//! remembered; going back to the title or leaving a replay restores that frame
//! (unless the window is full screen, maximized or minimized by then), puts the
//! layer back to normal and forgets the record.  The secondary window is never
//! restored: it is closed, and a window that is created again starts normal.

mod geometry;

use std::{
    sync::{mpsc, Mutex, MutexGuard},
    time::Duration,
};

use tauri::Manager;
use vectspace_core::{
    interaction::{WindowLayerAction, WindowPlacement, WindowReference, WindowRole, WindowSize},
    model::Easing,
};
use vectspace_protocol::{WireCommandError, WireCommandErrorCode};

use geometry::{interpolate, resolve_frame, ResolveInput};
pub(crate) use geometry::{
    min_client, Frame, Insets, MonitorInfo, Rect, WindowMetrics, SECONDARY_MIN_CLIENT,
};

use crate::state::EngineState;

/// One animation frame at about 60 Hz.
const FX_TICK: Duration = Duration::from_millis(16);
/// How often a running animation looks at the window's state.
const STATE_CHECK_INTERVAL: Duration = Duration::from_millis(250);

fn other_role(role: WindowRole) -> WindowRole {
    match role {
        WindowRole::Main => WindowRole::Secondary,
        WindowRole::Secondary => WindowRole::Main,
    }
}

// ---------------------------------------------------------------------------
// Effects recorded on the pair
// ---------------------------------------------------------------------------

/// One native window effect of a committed transaction, in node order.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum WindowEffect {
    Geometry {
        target: WindowRole,
        position: Option<WindowPlacement>,
        size: Option<WindowSize>,
        duration_ms: u64,
        easing: Easing,
    },
    Layer {
        target: WindowRole,
        action: WindowLayerAction,
    },
}

impl WindowEffect {
    pub(crate) fn target(&self) -> WindowRole {
        match self {
            WindowEffect::Geometry { target, .. } | WindowEffect::Layer { target, .. } => *target,
        }
    }
}

// ---------------------------------------------------------------------------
// Host state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum LayerState {
    #[default]
    Normal,
    Top,
    Bottom,
}

#[derive(Debug, Default)]
struct PerWindow<T> {
    main: T,
    secondary: T,
}

impl<T> PerWindow<T> {
    fn get(&self, role: WindowRole) -> &T {
        match role {
            WindowRole::Main => &self.main,
            WindowRole::Secondary => &self.secondary,
        }
    }

    fn get_mut(&mut self, role: WindowRole) -> &mut T {
        match role {
            WindowRole::Main => &mut self.main,
            WindowRole::Secondary => &mut self.secondary,
        }
    }
}

#[derive(Debug, Clone)]
struct Animation {
    id: u64,
    from: Frame,
    to: Frame,
    duration: Duration,
    easing: Easing,
    elapsed: Duration,
    since_check: Duration,
    /// The last frame this animation put on screen.
    applied: Frame,
}

#[derive(Debug, Default)]
struct FxState {
    animations: PerWindow<Option<Animation>>,
    layers: PerWindow<LayerState>,
    /// The main window's frame before the story first changed it.
    main_baseline: Option<Frame>,
    next_animation: u64,
}

/// Window effect state of the host.  Lock order: `io` -> `state`; `state` is
/// only ever held for short, native-free sections, so the window event handler
/// (which runs on the event loop) can take it without risking a deadlock with a
/// thread that waits for the event loop while holding `io`.
#[derive(Default)]
pub(crate) struct WindowFx {
    /// Serializes everything that talks to the native windows on behalf of
    /// effects: committed effects, animation frames and restores.
    io: Mutex<()>,
    state: Mutex<FxState>,
    wake: Mutex<Option<mpsc::Sender<()>>>,
}

impl WindowFx {
    fn io(&self) -> MutexGuard<'_, ()> {
        self.io
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn state(&self) -> MutexGuard<'_, FxState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn set_wake(&self, sender: mpsc::Sender<()>) {
        if let Ok(mut wake) = self.wake.lock() {
            *wake = Some(sender);
        }
    }

    fn wake(&self) {
        if let Ok(wake) = self.wake.lock() {
            if let Some(sender) = wake.as_ref() {
                let _ = sender.send(());
            }
        }
    }

    pub(crate) fn is_animating(&self) -> bool {
        let state = self.state();
        state.animations.main.is_some() || state.animations.secondary.is_some()
    }

    #[cfg(test)]
    pub(crate) fn is_window_animating(&self, role: WindowRole) -> bool {
        self.state().animations.get(role).is_some()
    }

    pub(crate) fn layer(&self, role: WindowRole) -> LayerState {
        *self.state().layers.get(role)
    }

    #[cfg(test)]
    pub(crate) fn main_baseline(&self) -> Option<Frame> {
        self.state().main_baseline
    }

    /// Stop animating `role`; the window stays where it is.
    pub(crate) fn cancel_animation(&self, role: WindowRole) {
        *self.state().animations.get_mut(role) = None;
    }

    /// The window is gone (or about to be replaced): drop everything the host
    /// tracks about it.  Takes only the state lock, so it is safe to call from
    /// the window event handler.
    pub(crate) fn forget_window(&self, role: WindowRole) {
        let mut state = self.state();
        *state.animations.get_mut(role) = None;
        *state.layers.get_mut(role) = LayerState::Normal;
    }

    fn set_layer(&self, role: WindowRole, layer: LayerState) {
        *self.state().layers.get_mut(role) = layer;
    }

    fn animation_target(&self, role: WindowRole) -> Option<Frame> {
        self.state()
            .animations
            .get(role)
            .as_ref()
            .map(|animation| animation.to)
    }

    fn remember_main_baseline(&self, frame: Frame) {
        let mut state = self.state();
        if state.main_baseline.is_none() {
            state.main_baseline = Some(frame);
        }
    }

    fn take_main_baseline(&self) -> Option<Frame> {
        self.state().main_baseline.take()
    }

    fn start_animation(
        &self,
        role: WindowRole,
        from: Frame,
        to: Frame,
        duration: Duration,
        easing: Easing,
    ) {
        let mut state = self.state();
        state.next_animation += 1;
        let id = state.next_animation;
        *state.animations.get_mut(role) = Some(Animation {
            id,
            from,
            to,
            duration,
            easing,
            elapsed: Duration::ZERO,
            since_check: Duration::ZERO,
            applied: from,
        });
    }
}

/// What one animation step has to do, decided under the state lock.
struct StepPlan {
    id: u64,
    previous: Frame,
    frame: Frame,
    done: bool,
    check_state: bool,
}

impl EngineState {
    /// Apply the effects of a committed transaction, in node order.  Called by
    /// `apply_native_plan` after every fallible step succeeded and with no
    /// runtime mutex held.  Failures are diagnostics only.
    pub(crate) fn apply_window_effects(&self, effects: &[WindowEffect]) {
        if effects.is_empty() {
            return;
        }
        let _io = self.fx.io();
        for effect in effects {
            let result = match effect {
                WindowEffect::Geometry {
                    target,
                    position,
                    size,
                    duration_ms,
                    easing,
                } => self.apply_geometry(
                    *target,
                    position.as_ref(),
                    size.as_ref(),
                    Duration::from_millis(*duration_ms),
                    *easing,
                ),
                WindowEffect::Layer { target, action } => self.apply_layer(*target, *action),
            };
            if let Err(error) = result {
                self.windows
                    .report_diagnostic(&format!("窗口效果未能应用：{}", error.message));
            }
        }
        if self.fx.is_animating() {
            self.fx.wake();
        }
    }

    /// The frame `role` effectively has: its animation's target while it is
    /// animated, what is on screen otherwise.
    fn effective_frame(&self, role: WindowRole, metrics: &WindowMetrics) -> Frame {
        self.fx
            .animation_target(role)
            .unwrap_or_else(|| metrics.frame())
    }

    /// The visible frame of `role` as a reference for another window.
    fn reference_rect(&self, role: WindowRole) -> Result<Rect, WireCommandError> {
        let metrics = self.windows.window_metrics(role)?;
        if metrics.minimized {
            return Err(WireCommandError::new(
                WireCommandErrorCode::Runtime,
                "参照窗口已最小化，无法作为定位参照",
            ));
        }
        let frame = self.effective_frame(role, &metrics);
        Ok(metrics.visible_of(frame))
    }

    fn apply_geometry(
        &self,
        target: WindowRole,
        position: Option<&WindowPlacement>,
        size: Option<&WindowSize>,
        duration: Duration,
        easing: Easing,
    ) -> Result<(), WireCommandError> {
        let metrics = self.windows.window_metrics(target)?;
        if metrics.blocks_geometry() {
            // The story never takes a window out of full screen / maximized /
            // minimized; whatever was animating stops where it is.
            self.fx.cancel_animation(target);
            return Ok(());
        }
        let current = self.effective_frame(target, &metrics);
        let other = match position {
            Some(placement) if placement.relative_to == WindowReference::Window => {
                Some(self.reference_rect(other_role(target))?)
            }
            _ => None,
        };
        let monitors = match position {
            Some(placement) if placement.relative_to != WindowReference::WorkArea => {
                self.windows.monitors()?
            }
            _ => Vec::new(),
        };
        let frame = resolve_frame(
            &ResolveInput {
                metrics: &metrics,
                current,
                other,
                monitors: &monitors,
                min_client: min_client(target),
            },
            position,
            size,
        )
        .map_err(|message| WireCommandError::new(WireCommandErrorCode::Runtime, message))?;
        if target == WindowRole::Main {
            self.fx.remember_main_baseline(metrics.frame());
        }
        // The animation starts from what is on screen, not from a stale target.
        let from = metrics.frame();
        if duration.is_zero() || frame == from {
            self.fx.cancel_animation(target);
            return self.set_frame(target, from, frame);
        }
        self.fx
            .start_animation(target, from, frame, duration, easing);
        Ok(())
    }

    /// Change only what differs: every native call is a round trip.
    fn set_frame(&self, role: WindowRole, from: Frame, to: Frame) -> Result<(), WireCommandError> {
        if (to.x, to.y) != (from.x, from.y) {
            self.windows.set_window_position(role, to.x, to.y)?;
        }
        if (to.client_w, to.client_h) != (from.client_w, from.client_h) {
            self.windows
                .set_window_size(role, to.client_w, to.client_h)?;
        }
        Ok(())
    }

    fn apply_layer(
        &self,
        target: WindowRole,
        action: WindowLayerAction,
    ) -> Result<(), WireCommandError> {
        match action {
            WindowLayerAction::Top => {
                self.clear_bottom(target)?;
                if self.fx.layer(target) != LayerState::Top {
                    self.windows.set_always_on_top(target, true)?;
                    self.fx.set_layer(target, LayerState::Top);
                }
            }
            WindowLayerAction::Bottom => {
                self.clear_top(target)?;
                if self.fx.layer(target) != LayerState::Bottom {
                    self.windows.set_always_on_bottom(target, true)?;
                    self.fx.set_layer(target, LayerState::Bottom);
                }
            }
            WindowLayerAction::Normal => self.reset_layer(target)?,
            WindowLayerAction::Raise => {
                // A window that is always on top is above everything already.
                // A bottom-pinned window is no longer "at the bottom" once it is
                // raised, so the pin goes first.  Toggling always-on-top on and
                // off again leaves the window on top of the normal windows
                // without activating it (tao uses `SWP_NOACTIVATE`).
                self.clear_bottom(target)?;
                if self.fx.layer(target) != LayerState::Top {
                    self.windows.set_always_on_top(target, true)?;
                    self.fx.set_layer(target, LayerState::Top);
                    self.windows.set_always_on_top(target, false)?;
                    self.fx.set_layer(target, LayerState::Normal);
                }
            }
            WindowLayerAction::Focus => {
                // Taking focus raises the window, so a bottom pin is lifted.
                // Always-on-top stays: it is a property, not a position.
                self.clear_bottom(target)?;
                self.windows.focus_window(target)?;
            }
        }
        Ok(())
    }

    fn clear_bottom(&self, role: WindowRole) -> Result<(), WireCommandError> {
        if self.fx.layer(role) == LayerState::Bottom {
            self.windows.set_always_on_bottom(role, false)?;
            self.fx.set_layer(role, LayerState::Normal);
        }
        Ok(())
    }

    fn clear_top(&self, role: WindowRole) -> Result<(), WireCommandError> {
        if self.fx.layer(role) == LayerState::Top {
            self.windows.set_always_on_top(role, false)?;
            self.fx.set_layer(role, LayerState::Normal);
        }
        Ok(())
    }

    fn reset_layer(&self, role: WindowRole) -> Result<(), WireCommandError> {
        self.clear_top(role)?;
        self.clear_bottom(role)
    }

    /// Advance every running animation by `elapsed`.  The scheduler thread calls
    /// this at about 60 Hz with the time it measured; tests call it by hand.
    pub(crate) fn fx_step(&self, elapsed: Duration) {
        if !self.fx.is_animating() {
            return;
        }
        let _io = self.fx.io();
        for role in [WindowRole::Main, WindowRole::Secondary] {
            self.step_animation(role, elapsed);
        }
    }

    fn step_animation(&self, role: WindowRole, elapsed: Duration) {
        let plan = {
            let mut state = self.fx.state();
            let Some(animation) = state.animations.get_mut(role).as_mut() else {
                return;
            };
            animation.elapsed = animation.elapsed.saturating_add(elapsed);
            animation.since_check = animation.since_check.saturating_add(elapsed);
            let done = animation.elapsed >= animation.duration;
            let frame = if done {
                animation.to
            } else {
                let t = animation.elapsed.as_secs_f64() / animation.duration.as_secs_f64();
                let progress = f64::from(animation.easing.sample(t as f32));
                interpolate(animation.from, animation.to, progress)
            };
            let check_state = animation.since_check >= STATE_CHECK_INTERVAL;
            if check_state {
                animation.since_check = Duration::ZERO;
            }
            StepPlan {
                id: animation.id,
                previous: animation.applied,
                frame,
                done,
                check_state,
            }
        };
        if plan.check_state {
            match self.windows.window_metrics(role) {
                Ok(metrics) if metrics.blocks_geometry() => {
                    // The window went full screen / maximized / minimized under
                    // the animation: leave it alone.
                    self.end_animation(role, plan.id);
                    return;
                }
                Ok(_) => {}
                Err(error) => {
                    self.abort_animation(role, plan.id, &error);
                    return;
                }
            }
        }
        if let Err(error) = self.set_frame(role, plan.previous, plan.frame) {
            self.abort_animation(role, plan.id, &error);
            return;
        }
        let mut state = self.fx.state();
        let slot = state.animations.get_mut(role);
        if let Some(animation) = slot.as_mut().filter(|animation| animation.id == plan.id) {
            if plan.done {
                *slot = None;
            } else {
                animation.applied = plan.frame;
            }
        }
    }

    /// Remove animation `id` of `role` if it is still the registered one.
    /// Returns whether it was.
    fn end_animation(&self, role: WindowRole, id: u64) -> bool {
        let mut state = self.fx.state();
        let slot = state.animations.get_mut(role);
        if slot.as_ref().is_some_and(|animation| animation.id == id) {
            *slot = None;
            true
        } else {
            false
        }
    }

    /// A native failure under a running animation.  If the animation was
    /// cancelled in the meantime (the window was destroyed or replaced) the
    /// failure is expected and silent.
    fn abort_animation(&self, role: WindowRole, id: u64, error: &WireCommandError) {
        if self.end_animation(role, id) {
            self.windows
                .report_diagnostic(&format!("窗口动画已中止：{}", error.message));
        }
    }

    /// Put the main window back the way it was before the story touched it:
    /// the frame it had, unless it is full screen / maximized / minimized now,
    /// and the normal layer.  Called when the player returns to the title and
    /// when a replay ends; failures are diagnostics.
    pub(crate) fn restore_main_window(&self) {
        let _io = self.fx.io();
        self.fx.cancel_animation(WindowRole::Main);
        if let Some(frame) = self.fx.take_main_baseline() {
            match self.windows.window_metrics(WindowRole::Main) {
                Ok(metrics) if metrics.blocks_geometry() => {}
                Ok(metrics) => {
                    if let Err(error) = self.set_frame(WindowRole::Main, metrics.frame(), frame) {
                        self.windows.report_diagnostic(&format!(
                            "无法恢复主窗口位置和大小：{}",
                            error.message
                        ));
                    }
                }
                Err(error) => self
                    .windows
                    .report_diagnostic(&format!("无法恢复主窗口位置和大小：{}", error.message)),
            }
        }
        if let Err(error) = self.reset_layer(WindowRole::Main) {
            self.windows
                .report_diagnostic(&format!("无法恢复主窗口层级：{}", error.message));
        }
    }

    /// A secondary window was (re)shown.  A window that is created fresh starts
    /// normal with nothing to do; a surviving one that is re-pointed to a new
    /// session loses its animation and layer like the window it replaces.
    pub(crate) fn reset_secondary_window_fx(&self) {
        let _io = self.fx.io();
        self.fx.cancel_animation(WindowRole::Secondary);
        if let Err(error) = self.reset_layer(WindowRole::Secondary) {
            self.windows
                .report_diagnostic(&format!("无法重置副窗口层级：{}", error.message));
        }
    }
}

/// Start the animation scheduler thread and return the sender that wakes it.
/// It sleeps while nothing animates and ticks at about 60 Hz otherwise.
pub(crate) fn spawn_fx_scheduler(app: tauri::AppHandle) -> mpsc::Sender<()> {
    let (sender, receiver) = mpsc::channel::<()>();
    let spawned = std::thread::Builder::new()
        .name("vectspace-window-fx".to_owned())
        .spawn(move || {
            let mut last = std::time::Instant::now();
            loop {
                let Some(state) = app.try_state::<EngineState>() else {
                    match receiver.recv_timeout(Duration::from_millis(200)) {
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                        _ => continue,
                    }
                };
                if !state.fx.is_animating() {
                    if receiver.recv().is_err() {
                        return;
                    }
                    // Woken from idle: nothing animated before, nothing elapsed.
                    last = std::time::Instant::now();
                    continue;
                }
                if let Err(mpsc::RecvTimeoutError::Disconnected) = receiver.recv_timeout(FX_TICK) {
                    return;
                }
                let now = std::time::Instant::now();
                let elapsed = now.saturating_duration_since(last);
                last = now;
                state.fx_step(elapsed);
            }
        });
    if let Err(error) = spawned {
        eprintln!("无法启动窗口动画线程: {error}");
    }
    sender
}
