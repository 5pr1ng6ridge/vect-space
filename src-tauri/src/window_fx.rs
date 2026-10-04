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
//! nothing the story could be rolled back to.
//!
//! # Coordinates
//!
//! Everything is computed in **physical pixels** on the *visible frame* of a
//! window: the rectangle a player sees, i.e. the Win32 window rect minus the
//! invisible resize borders that Windows 10/11 add around a framed window
//! ([`Insets`], read through DWM on Windows and zero elsewhere).  The native
//! seam works with the raw outer position plus the **client** size, which is what
//! `set_position`/`set_size` of Tauri take, so [`WindowMetrics::frame_for_visible`]
//! converts back at the very end.
//!
//! * Size: `Logical` is the client area in logical pixels (times the window's
//!   scale factor); `WorkArea` is the visible frame as a fraction of the work
//!   area.  A client area is never smaller than the window's minimum size and a
//!   frame is never larger than the work area (the minimum wins on a tiny screen).
//! * Position: the point of the reference rectangle `(x, y)` receives the point of
//!   the window frame `(anchor_x, anchor_y)`, plus the offset in logical pixels.
//!   The reference is the work area of the target's monitor, the other game
//!   window's visible frame, or the target's own current frame.  Finally the
//!   frame is clamped into a work area so it can never be lost off screen.
//!   `WorkArea` clamps to the target's own monitor.  `Window` and `Current` clamp
//!   to the monitor under the *center of the resulting frame* (nearest monitor
//!   when it lies in a gap): that lets a window dock next to a partner on the
//!   neighbouring display or be nudged across displays, while it still never ends
//!   up outside every monitor.  (The task description suggests the monitor of the
//!   reference point; the frame center agrees with it whenever the window fits,
//!   and behaves better when the docked window overhangs the partner's monitor.)
//! * A window that is being animated is used by `Current`, by `Window` references
//!   and by "keep my size/position" with its **target** frame, never with an
//!   intermediate frame, so chained effects do not depend on timing.
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

use std::{
    sync::{mpsc, Mutex, MutexGuard},
    time::Duration,
};

use vectspace_core::{
    interaction::{
        WindowLayerAction, WindowPlacement, WindowReference, WindowRole, WindowSize, WindowSizeUnit,
    },
    model::Easing,
};

use super::*;

/// Minimum client size (logical pixels) of the main window; mirrors
/// `minWidth`/`minHeight` of `tauri.conf.json` (checked by a test).
pub(crate) const MAIN_MIN_CLIENT: (f64, f64) = (960.0, 540.0);
/// Minimum client size of the secondary window (`ensure_secondary_window`).
pub(crate) const SECONDARY_MIN_CLIENT: (f64, f64) = (480.0, 270.0);

/// One animation frame at about 60 Hz.
const FX_TICK: Duration = Duration::from_millis(16);
/// How often a running animation looks at the window's state.
const STATE_CHECK_INTERVAL: Duration = Duration::from_millis(250);
/// Invisible borders beyond this are not real resize borders; ignore them.
const MAX_PLAUSIBLE_INSET: i32 = 128;

fn other_role(role: WindowRole) -> WindowRole {
    match role {
        WindowRole::Main => WindowRole::Secondary,
        WindowRole::Secondary => WindowRole::Main,
    }
}

pub(crate) fn min_client(role: WindowRole) -> (f64, f64) {
    match role {
        WindowRole::Main => MAIN_MIN_CLIENT,
        WindowRole::Secondary => SECONDARY_MIN_CLIENT,
    }
}

// ---------------------------------------------------------------------------
// Pure geometry
// ---------------------------------------------------------------------------

/// A rectangle in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub(crate) const fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Self { x, y, w, h }
    }

    fn center(&self) -> (f64, f64) {
        (
            self.x as f64 + self.w as f64 / 2.0,
            self.y as f64 + self.h as f64 / 2.0,
        )
    }

    /// Squared distance from a point to the rectangle; zero inside it.
    fn distance_sq(&self, point: (f64, f64)) -> f64 {
        let dx = (self.x as f64 - point.0)
            .max(point.0 - (self.x as f64 + self.w as f64))
            .max(0.0);
        let dy = (self.y as f64 - point.1)
            .max(point.1 - (self.y as f64 + self.h as f64))
            .max(0.0);
        dx * dx + dy * dy
    }
}

/// Invisible extent of a window rect beyond what the player sees.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct Insets {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct MonitorInfo {
    pub work_area: Rect,
    pub scale: f64,
}

/// What the native seam is told: the outer position and the client size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Frame {
    pub x: i32,
    pub y: i32,
    pub client_w: i32,
    pub client_h: i32,
}

/// Everything the host reads from one native window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct WindowMetrics {
    /// The raw outer rect (position is what `set_position` takes).
    pub outer: Rect,
    pub client: (i32, i32),
    pub insets: Insets,
    pub scale: f64,
    /// The work area of the monitor the window is on.
    pub monitor: MonitorInfo,
    pub fullscreen: bool,
    pub maximized: bool,
    pub minimized: bool,
}

impl WindowMetrics {
    pub(crate) fn frame(&self) -> Frame {
        Frame {
            x: self.outer.x,
            y: self.outer.y,
            client_w: self.client.0,
            client_h: self.client.1,
        }
    }

    /// Difference between the visible frame and the client area.
    fn visible_border(&self) -> (i32, i32) {
        (
            self.outer.w - self.client.0 - self.insets.left - self.insets.right,
            self.outer.h - self.client.1 - self.insets.top - self.insets.bottom,
        )
    }

    /// The rectangle the player sees when the window has `frame`.
    pub(crate) fn visible_of(&self, frame: Frame) -> Rect {
        let (border_w, border_h) = self.visible_border();
        Rect {
            x: frame.x + self.insets.left,
            y: frame.y + self.insets.top,
            w: frame.client_w + border_w,
            h: frame.client_h + border_h,
        }
    }

    fn frame_for_visible(&self, visible: Rect) -> Frame {
        let (border_w, border_h) = self.visible_border();
        Frame {
            x: visible.x - self.insets.left,
            y: visible.y - self.insets.top,
            client_w: (visible.w - border_w).max(1),
            client_h: (visible.h - border_h).max(1),
        }
    }

    /// A window in one of these states keeps it: the story never forces a
    /// window out of full screen, un-maximizes it or positions an icon.
    pub(crate) fn blocks_geometry(&self) -> bool {
        self.fullscreen || self.maximized || self.minimized
    }
}

/// Everything [`resolve_frame`] needs besides the node's own parameters.
pub(crate) struct ResolveInput<'a> {
    pub metrics: &'a WindowMetrics,
    /// The frame this window effectively has: its animation's target while it
    /// is animated, otherwise what is on screen.
    pub current: Frame,
    /// The other game window's visible frame (effective, see above); needed for
    /// `WindowReference::Window`.
    pub other: Option<Rect>,
    /// Every monitor's work area, for placements that may cross displays.
    pub monitors: &'a [MonitorInfo],
    /// The window's minimum client size in logical pixels.
    pub min_client: (f64, f64),
}

fn clamp_axis(start: i32, area_start: i32, area_len: i32, len: i32) -> i32 {
    if len >= area_len {
        area_start
    } else {
        start.clamp(area_start, area_start + area_len - len)
    }
}

/// The work area nearest to `point` (the one containing it, when there is one).
fn pick_work_area(monitors: &[MonitorInfo], point: (f64, f64), fallback: Rect) -> Rect {
    monitors
        .iter()
        .map(|monitor| monitor.work_area)
        .filter(|area| area.w > 0 && area.h > 0)
        .min_by(|a, b| a.distance_sq(point).total_cmp(&b.distance_sq(point)))
        .unwrap_or(fallback)
}

/// Resolve a `window_geometry` node to the frame the native window must get.
/// See the module documentation for the exact rules.
pub(crate) fn resolve_frame(
    input: &ResolveInput<'_>,
    position: Option<&WindowPlacement>,
    size: Option<&WindowSize>,
) -> Result<Frame, String> {
    let metrics = input.metrics;
    let scale = if metrics.scale.is_finite() && metrics.scale > 0.0 {
        metrics.scale
    } else {
        1.0
    };
    let current = metrics.visible_of(input.current);
    let (border_w, border_h) = metrics.visible_border();
    let min_w = (input.min_client.0 * scale).round() as i32 + border_w;
    let min_h = (input.min_client.1 * scale).round() as i32 + border_h;
    // The frame never exceeds the work area, but the minimum size wins.
    let fit = |w: i32, h: i32, work: Rect| (w.min(work.w).max(min_w), h.min(work.h).max(min_h));
    let own_work = metrics.monitor.work_area;

    let (mut w, mut h) = match size {
        None => (current.w, current.h),
        Some(size) => {
            let (w, h) = match size.unit {
                WindowSizeUnit::Logical => (
                    (size.width as f64 * scale).round() as i32 + border_w,
                    (size.height as f64 * scale).round() as i32 + border_h,
                ),
                WindowSizeUnit::WorkArea => (
                    (size.width as f64 * own_work.w as f64).round() as i32,
                    (size.height as f64 * own_work.h as f64).round() as i32,
                ),
            };
            fit(w, h, own_work)
        }
    };

    let (mut x, mut y) = match position {
        None => (current.x, current.y),
        Some(placement) => {
            let reference = match placement.relative_to {
                WindowReference::WorkArea => own_work,
                WindowReference::Window => {
                    input.other.ok_or_else(|| "参照窗口的位置未知".to_owned())?
                }
                WindowReference::Current => current,
            };
            let px = reference.x as f64 + placement.x as f64 * reference.w as f64;
            let py = reference.y as f64 + placement.y as f64 * reference.h as f64;
            (
                (px - placement.anchor_x as f64 * w as f64 + placement.offset_x as f64 * scale)
                    .round() as i32,
                (py - placement.anchor_y as f64 * h as f64 + placement.offset_y as f64 * scale)
                    .round() as i32,
            )
        }
    };

    let work = match position {
        Some(placement) if placement.relative_to != WindowReference::WorkArea => {
            pick_work_area(input.monitors, Rect::new(x, y, w, h).center(), own_work)
        }
        _ => own_work,
    };
    if work != own_work && size.is_some() {
        (w, h) = fit(w, h, work);
    }
    x = clamp_axis(x, work.x, work.w, w);
    y = clamp_axis(y, work.y, work.h, h);
    Ok(metrics.frame_for_visible(Rect::new(x, y, w, h)))
}

/// The frame at `progress` (0..=1) of the way from `from` to `to`.
pub(crate) fn interpolate(from: Frame, to: Frame, progress: f64) -> Frame {
    let progress = progress.clamp(0.0, 1.0);
    let lerp = |a: i32, b: i32| (a as f64 + (b as f64 - a as f64) * progress).round() as i32;
    Frame {
        x: lerp(from.x, to.x),
        y: lerp(from.y, to.y),
        client_w: lerp(from.client_w, to.client_w).max(1),
        client_h: lerp(from.client_h, to.client_h).max(1),
    }
}

/// The invisible part of a framed Windows window, from DWM.  Zero when the
/// information is unavailable (or implausible), which only costs precision.
#[cfg(windows)]
pub(crate) fn frame_insets(window: &tauri::WebviewWindow, outer: Rect) -> Insets {
    use windows::Win32::{
        Foundation::RECT,
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
    };
    let Ok(hwnd) = window.hwnd() else {
        return Insets::default();
    };
    let mut visible = RECT::default();
    let read = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut visible as *mut RECT as *mut core::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )
    };
    if read.is_err() {
        return Insets::default();
    }
    let insets = Insets {
        left: visible.left - outer.x,
        top: visible.top - outer.y,
        right: outer.x + outer.w - visible.right,
        bottom: outer.y + outer.h - visible.bottom,
    };
    let plausible = [insets.left, insets.top, insets.right, insets.bottom]
        .iter()
        .all(|inset| (0..=MAX_PLAUSIBLE_INSET).contains(inset));
    if plausible {
        insets
    } else {
        Insets::default()
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

pub(crate) fn native_failure(what: &str, error: impl std::fmt::Display) -> WireCommandError {
    WireCommandError::new(WireCommandErrorCode::Internal, format!("{what}: {error}"))
}

fn read_error(what: &'static str) -> impl FnOnce(tauri::Error) -> WireCommandError {
    move |error| native_failure(what, error)
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

/// The production seam over `tauri::WebviewWindow`.
impl TauriWindowOps {
    pub(crate) fn native_window(
        &self,
        role: WindowRole,
    ) -> Result<tauri::WebviewWindow, WireCommandError> {
        let label = match role {
            WindowRole::Main => MAIN_WINDOW_LABEL,
            WindowRole::Secondary => SECONDARY_WINDOW_LABEL,
        };
        self.app.get_webview_window(label).ok_or_else(|| {
            WireCommandError::new(
                WireCommandErrorCode::Internal,
                format!("窗口 {label} 不存在"),
            )
        })
    }

    pub(crate) fn read_window_metrics(
        &self,
        role: WindowRole,
    ) -> Result<WindowMetrics, WireCommandError> {
        let window = self.native_window(role)?;
        let position = window
            .outer_position()
            .map_err(read_error("无法读取窗口位置"))?;
        let outer_size = window
            .outer_size()
            .map_err(read_error("无法读取窗口外框大小"))?;
        let inner_size = window
            .inner_size()
            .map_err(read_error("无法读取窗口客户区大小"))?;
        let scale = window
            .scale_factor()
            .map_err(read_error("无法读取窗口缩放"))?;
        let monitor = match window
            .current_monitor()
            .map_err(read_error("无法读取窗口所在显示器"))?
        {
            Some(monitor) => monitor,
            None => window
                .primary_monitor()
                .map_err(read_error("无法读取主显示器"))?
                .ok_or_else(|| {
                    WireCommandError::new(WireCommandErrorCode::Internal, "找不到窗口所在的显示器")
                })?,
        };
        let outer = Rect::new(
            position.x,
            position.y,
            outer_size.width as i32,
            outer_size.height as i32,
        );
        #[cfg(windows)]
        let insets = frame_insets(&window, outer);
        #[cfg(not(windows))]
        let insets = Insets::default();
        Ok(WindowMetrics {
            outer,
            client: (inner_size.width as i32, inner_size.height as i32),
            insets,
            scale,
            monitor: monitor_info(&monitor),
            fullscreen: window
                .is_fullscreen()
                .map_err(read_error("无法读取全屏状态"))?,
            maximized: window
                .is_maximized()
                .map_err(read_error("无法读取最大化状态"))?,
            minimized: window
                .is_minimized()
                .map_err(read_error("无法读取最小化状态"))?,
        })
    }

    pub(crate) fn read_monitors(&self) -> Result<Vec<MonitorInfo>, WireCommandError> {
        let window = self.native_window(WindowRole::Main)?;
        let monitors = window
            .available_monitors()
            .map_err(|error| native_failure("无法列出显示器", error))?;
        Ok(monitors.iter().map(monitor_info).collect())
    }
}

fn monitor_info(monitor: &tauri::Monitor) -> MonitorInfo {
    let area = monitor.work_area();
    MonitorInfo {
        work_area: Rect::new(
            area.position.x,
            area.position.y,
            area.size.width as i32,
            area.size.height as i32,
        ),
        scale: monitor.scale_factor(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn placement(x: f32, y: f32, anchor_x: f32, anchor_y: f32) -> WindowPlacement {
        WindowPlacement {
            relative_to: WindowReference::WorkArea,
            x,
            y,
            anchor_x,
            anchor_y,
            offset_x: 0.0,
            offset_y: 0.0,
        }
    }

    fn logical(width: f32, height: f32) -> WindowSize {
        WindowSize {
            unit: WindowSizeUnit::Logical,
            width,
            height,
        }
    }

    /// A 1280x720 client window with a 16x40 frame at (100, 100) on a
    /// 1920x1040 work area, scale 1.
    fn metrics() -> WindowMetrics {
        WindowMetrics {
            outer: Rect::new(100, 100, 1296, 760),
            client: (1280, 720),
            insets: Insets::default(),
            scale: 1.0,
            monitor: MonitorInfo {
                work_area: Rect::new(0, 0, 1920, 1040),
                scale: 1.0,
            },
            fullscreen: false,
            maximized: false,
            minimized: false,
        }
    }

    fn resolve(
        metrics: &WindowMetrics,
        other: Option<Rect>,
        monitors: &[MonitorInfo],
        position: Option<WindowPlacement>,
        size: Option<WindowSize>,
    ) -> Frame {
        resolve_frame(
            &ResolveInput {
                metrics,
                current: metrics.frame(),
                other,
                monitors,
                min_client: MAIN_MIN_CLIENT,
            },
            position.as_ref(),
            size.as_ref(),
        )
        .unwrap()
    }

    #[test]
    fn a_placement_centers_the_window_in_the_work_area() {
        let metrics = metrics();
        let frame = resolve(
            &metrics,
            None,
            &[],
            Some(placement(0.5, 0.5, 0.5, 0.5)),
            None,
        );
        // Center (960, 520) minus half of the 1296x760 frame.
        assert_eq!((frame.x, frame.y), (312, 140));
        // Only a position was given: the size stays.
        assert_eq!((frame.client_w, frame.client_h), (1280, 720));
    }

    #[test]
    fn a_window_reference_docks_to_the_right_of_the_other_window_with_a_gap() {
        let metrics = metrics();
        let other = Rect::new(100, 200, 800, 600);
        let mut dock = placement(1.0, 0.5, 0.0, 0.5);
        dock.relative_to = WindowReference::Window;
        dock.offset_x = 16.0;
        let frame = resolve(
            &metrics,
            Some(other),
            &[],
            Some(dock),
            Some(logical(960.0, 540.0)),
        );
        // 900 + 16 on the right, vertically centered on the other window.
        assert_eq!(frame.x, 916);
        assert_eq!((frame.client_w, frame.client_h), (960, 540));
        assert_eq!(frame.y, 500 - (540 + 40) / 2);
    }

    #[test]
    fn a_current_reference_nudges_the_window_by_a_logical_offset() {
        let mut metrics = metrics();
        metrics.scale = 1.5;
        metrics.monitor.scale = 1.5;
        let mut nudge = placement(0.0, 0.0, 0.0, 0.0);
        nudge.relative_to = WindowReference::Current;
        nudge.offset_x = 40.0;
        nudge.offset_y = -20.0;
        let frame = resolve(&metrics, None, &[], Some(nudge), None);
        assert_eq!((frame.x, frame.y), (100 + 60, 100 - 30));
        assert_eq!((frame.client_w, frame.client_h), (1280, 720));
    }

    #[test]
    fn work_area_sizes_include_the_frame_and_logical_sizes_follow_the_scale() {
        let metrics = metrics();
        let share = WindowSize {
            unit: WindowSizeUnit::WorkArea,
            width: 0.75,
            height: 0.75,
        };
        let frame = resolve(&metrics, None, &[], None, Some(share));
        // The frame is 75% of the work area; the client loses the 16x40 border.
        assert_eq!((frame.client_w, frame.client_h), (1440 - 16, 780 - 40));
        // Only a size was given: the position stays.
        assert_eq!((frame.x, frame.y), (100, 100));
        // Half of the work area is below the minimum client size: it wins.
        let half = WindowSize {
            unit: WindowSizeUnit::WorkArea,
            width: 0.5,
            height: 0.5,
        };
        let frame = resolve(&metrics, None, &[], None, Some(half));
        assert_eq!((frame.client_w, frame.client_h), (960, 540));

        let mut scaled = metrics;
        scaled.scale = 1.25;
        scaled.monitor.scale = 1.25;
        let frame = resolve(&scaled, None, &[], None, Some(logical(1000.0, 600.0)));
        assert_eq!((frame.client_w, frame.client_h), (1250, 750));
    }

    #[test]
    fn sizes_are_clamped_to_the_minimum_and_to_the_work_area() {
        let metrics = metrics();
        let small = resolve(&metrics, None, &[], None, Some(logical(100.0, 100.0)));
        assert_eq!((small.client_w, small.client_h), (960, 540));
        let huge = resolve(&metrics, None, &[], None, Some(logical(9000.0, 9000.0)));
        // The frame fills the work area, the client is what is left.
        assert_eq!((huge.client_w, huge.client_h), (1920 - 16, 1040 - 40));
        assert_eq!((huge.x, huge.y), (0, 0));
    }

    #[test]
    fn a_position_outside_the_screen_is_clamped_into_the_work_area() {
        let metrics = metrics();
        let far = resolve(
            &metrics,
            None,
            &[],
            Some(placement(3.0, -2.0, 0.0, 0.0)),
            None,
        );
        // The 1296x760 frame fits: fully visible against the top-right corner.
        assert_eq!((far.x, far.y), (1920 - 1296, 0));
        let low = resolve(
            &metrics,
            None,
            &[],
            Some(placement(0.0, 4.0, 0.0, 1.0)),
            None,
        );
        assert_eq!((low.x, low.y), (0, 1040 - 760));
    }

    #[test]
    fn a_window_larger_than_the_work_area_is_aligned_to_its_origin() {
        let mut metrics = metrics();
        metrics.monitor.work_area = Rect::new(50, 30, 1000, 600);
        let frame = resolve(
            &metrics,
            None,
            &[],
            Some(placement(0.9, 0.9, 0.5, 0.5)),
            None,
        );
        assert_eq!((frame.x, frame.y), (50, 30));
    }

    #[test]
    fn invisible_borders_are_excluded_from_references_and_sizes() {
        // A framed Windows window: 8px invisible border left/right/bottom.
        let mut metrics = metrics();
        metrics.insets = Insets {
            left: 8,
            top: 0,
            right: 8,
            bottom: 8,
        };
        // Visible frame: x 108..1388 (1280 + 0 visible border), y 100..852.
        let visible = metrics.visible_of(metrics.frame());
        assert_eq!(visible, Rect::new(108, 100, 1280, 752));
        // Dock to the right of a partner whose visible frame ends at x=400.
        let mut dock = placement(1.0, 0.0, 0.0, 0.0);
        dock.relative_to = WindowReference::Window;
        dock.offset_x = 16.0;
        let frame = resolve(
            &metrics,
            Some(Rect::new(100, 100, 300, 600)),
            &[],
            Some(dock),
            None,
        );
        // The *visible* edge lands at 400 + 16, so the raw outer x is 8 less.
        assert_eq!(frame.x, 416 - 8);
        // The visible frame fills the work area exactly when asked to.
        let full = WindowSize {
            unit: WindowSizeUnit::WorkArea,
            width: 1.0,
            height: 1.0,
        };
        let frame = resolve(
            &metrics,
            None,
            &[],
            Some(placement(0.0, 0.0, 0.0, 0.0)),
            Some(full),
        );
        assert_eq!(frame.x, -8, "the invisible border hangs outside the screen");
        assert_eq!(metrics.visible_of(frame), Rect::new(0, 0, 1920, 1040));
    }

    #[test]
    fn a_window_reference_clamps_to_the_monitor_the_window_lands_on() {
        let metrics = metrics();
        let left = MonitorInfo {
            work_area: Rect::new(0, 0, 1920, 1040),
            scale: 1.0,
        };
        let right = MonitorInfo {
            work_area: Rect::new(1920, 0, 1920, 1040),
            scale: 1.0,
        };
        // The partner sits at the right edge of the left monitor; docking to
        // its right puts the window on the right monitor.
        let other = Rect::new(1100, 100, 800, 600);
        let mut dock = placement(1.0, 0.0, 0.0, 0.0);
        dock.relative_to = WindowReference::Window;
        dock.offset_x = 100.0;
        let frame = resolve(&metrics, Some(other), &[left, right], Some(dock), None);
        assert_eq!(frame.x, 2000);
        // A single monitor keeps it fully inside instead.
        let frame = resolve(&metrics, Some(other), &[left], Some(dock), None);
        assert_eq!(frame.x, 1920 - 1296);
    }

    #[test]
    fn a_window_reference_without_a_partner_is_an_error() {
        let metrics = metrics();
        let mut dock = placement(1.0, 0.0, 0.0, 0.0);
        dock.relative_to = WindowReference::Window;
        let result = resolve_frame(
            &ResolveInput {
                metrics: &metrics,
                current: metrics.frame(),
                other: None,
                monitors: &[],
                min_client: MAIN_MIN_CLIENT,
            },
            Some(&dock),
            None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn the_nearest_monitor_is_used_when_the_window_lands_in_a_gap() {
        let monitors = [
            MonitorInfo {
                work_area: Rect::new(0, 0, 1000, 800),
                scale: 1.0,
            },
            MonitorInfo {
                work_area: Rect::new(1200, 0, 1000, 800),
                scale: 1.0,
            },
        ];
        let fallback = Rect::new(0, 0, 10, 10);
        assert_eq!(
            pick_work_area(&monitors, (1050.0, 400.0), fallback),
            monitors[0].work_area
        );
        assert_eq!(
            pick_work_area(&monitors, (1150.0, 400.0), fallback),
            monitors[1].work_area
        );
        assert_eq!(pick_work_area(&[], (0.0, 0.0), fallback), fallback);
    }

    #[test]
    fn interpolation_hits_both_ends_exactly() {
        let from = Frame {
            x: 0,
            y: 100,
            client_w: 960,
            client_h: 540,
        };
        let to = Frame {
            x: 300,
            y: -50,
            client_w: 1280,
            client_h: 720,
        };
        assert_eq!(interpolate(from, to, 0.0), from);
        assert_eq!(interpolate(from, to, 1.0), to);
        assert_eq!(
            interpolate(from, to, 0.5),
            Frame {
                x: 150,
                y: 25,
                client_w: 1120,
                client_h: 630,
            }
        );
        assert_eq!(interpolate(from, to, 7.0), to, "progress is clamped");
    }

    #[test]
    fn the_secondary_minimum_matches_the_native_window_builder() {
        // `ensure_secondary_window` builds the window from these constants.
        assert_eq!(SECONDARY_MIN_CLIENT, (480.0, 270.0));
    }

    #[test]
    fn the_main_minimum_matches_the_window_configuration() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json parses");
        let window = &config["app"]["windows"][0];
        assert_eq!(window["minWidth"].as_f64(), Some(MAIN_MIN_CLIENT.0));
        assert_eq!(window["minHeight"].as_f64(), Some(MAIN_MIN_CLIENT.1));
    }
}
