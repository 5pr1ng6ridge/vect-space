//! Pure window geometry: frames, work areas and the placement rules of the
//! `window_geometry` node.
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
//!   up outside every monitor.  The frame center agrees with the monitor of the
//!   reference point whenever the window fits, and behaves better when the docked
//!   window overhangs the partner's monitor.
//! * A window that is being animated is used by `Current`, by `Window` references
//!   and by "keep my size/position" with its **target** frame, never with an
//!   intermediate frame, so chained effects do not depend on timing.

use vectspace_core::interaction::{
    WindowPlacement, WindowReference, WindowRole, WindowSize, WindowSizeUnit,
};

/// Minimum client size (logical pixels) of the main window; mirrors
/// `minWidth`/`minHeight` of `tauri.conf.json` (checked by a test).
pub(crate) const MAIN_MIN_CLIENT: (f64, f64) = (960.0, 540.0);
/// Minimum client size of the secondary window (`ensure_secondary_window`).
pub(crate) const SECONDARY_MIN_CLIENT: (f64, f64) = (480.0, 270.0);

pub(crate) fn min_client(role: WindowRole) -> (f64, f64) {
    match role {
        WindowRole::Main => MAIN_MIN_CLIENT,
        WindowRole::Secondary => SECONDARY_MIN_CLIENT,
    }
}

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
    fn the_main_minimum_matches_the_window_configuration() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
            .expect("tauri.conf.json parses");
        let window = &config["app"]["windows"][0];
        assert_eq!(window["minWidth"].as_f64(), Some(MAIN_MIN_CLIENT.0));
        assert_eq!(window["minHeight"].as_f64(), Some(MAIN_MIN_CLIENT.1));
    }
}
