//! The native window seam.
//!
//! [`NativeWindowOps`] is everything the host asks of the real windows: the
//! secondary window's lifecycle, titles, geometry and layers.  Keeping it behind
//! a trait makes the failure paths (a window that cannot be created or
//! destroyed) reachable from host tests without a WebView; [`TauriWindowOps`]
//! is the production implementation.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use vectspace_core::interaction::{WindowRole, DEFAULT_SECONDARY_TITLE};
use vectspace_protocol::{WireCommandError, WireCommandErrorCode, WireUpdateNotice};

use crate::{
    sync,
    window_fx::{self, Insets, MonitorInfo, Rect, WindowMetrics},
};

pub(crate) const MAIN_WINDOW_LABEL: &str = "main";
pub(crate) const SECONDARY_WINDOW_LABEL: &str = "secondary";
const SECONDARY_REPLACED_EVENT: &str = "vectspace://secondary-session";
const HOST_DIAGNOSTIC_EVENT: &str = "vectspace://host-diagnostic";

pub(crate) fn role_for_label(label: &str) -> Option<WindowRole> {
    match label {
        MAIN_WINDOW_LABEL => Some(WindowRole::Main),
        SECONDARY_WINDOW_LABEL => Some(WindowRole::Secondary),
        _ => None,
    }
}

fn label_for(role: WindowRole) -> &'static str {
    match role {
        WindowRole::Main => MAIN_WINDOW_LABEL,
        WindowRole::Secondary => SECONDARY_WINDOW_LABEL,
    }
}

/// Native window work for the secondary window.  The host never performs it
/// while a runtime mutex is held (window creation/destruction can re-enter the
/// window event handler), and it is fallible: a transition that cannot make the
/// native window match the new state is rolled back instead of being reported
/// as a success with a missing or orphaned window.
pub(crate) trait NativeWindowOps: Send + Sync {
    /// Make the native secondary window exist and tell its frontend to
    /// re-bootstrap under the host's current session token.  `replaced` is the
    /// host's *logical* view (the slot already carried a session); a native
    /// window that survived anyway — a partially created window whose cleanup
    /// failed, or a window reused by a retry — must be refreshed even when that
    /// flag is false, because it may still be running an older session.
    fn show_secondary(&self, replaced: bool) -> Result<(), WireCommandError>;
    fn hide_secondary(&self) -> Result<(), WireCommandError>;
    /// Reconcile the native window with the host's **logical slot** without
    /// waiting for the event loop, and report whether the native state changed.
    ///
    /// Creation and destruction only enqueue a message when they run off the
    /// event-loop thread (see [`TauriWindowOps`]), so native state and the slot
    /// can drift apart in a way the host cannot observe from the call itself.
    /// This is the host's recovery path for that asymmetry: a live slot whose
    /// window is missing is rebuilt, and a window whose slot is gone is removed
    /// again.  It never blocks on the event loop, and a label that is queued for
    /// destruction is never adopted.
    fn reconcile_secondary(&self, expected_live: bool) -> Result<bool, WireCommandError> {
        let _ = expected_live;
        Ok(false)
    }
    /// True while the host itself is destroying the secondary, so the close
    /// guard can tell a host-initiated destruction from a user/native close
    /// request, which is always prevented.
    fn is_closing_secondary(&self) -> bool {
        false
    }
    /// Show `title` as the native title of the given window.  Like every native
    /// operation it is fallible, never called while a runtime mutex is held, and
    /// a failure rolls the whole transaction back.
    fn set_title(&self, role: WindowRole, title: &str) -> Result<(), WireCommandError> {
        let _ = (role, title);
        Ok(())
    }
    /// Announce that a window has new committed updates.  Best effort: a lost
    /// notification is recovered by the frontend's own incremental sync.
    fn notify_updated(&self, role: WindowRole, notice: &WireUpdateNotice) {
        let _ = (role, notice);
    }
    /// Surface a diagnostic that has no command to fail (a stopped timer...).
    fn report_diagnostic(&self, message: &str) {
        eprintln!("{message}");
    }
    /// Read the native geometry and state of a live window, in physical pixels.
    /// Window effects only; a failure is a diagnostic, never a rollback.
    fn window_metrics(&self, role: WindowRole) -> Result<WindowMetrics, WireCommandError>;
    /// The work area and scale of every monitor.
    fn monitors(&self) -> Result<Vec<MonitorInfo>, WireCommandError>;
    /// Move the window's outer frame (physical pixels).
    fn set_window_position(&self, role: WindowRole, x: i32, y: i32)
        -> Result<(), WireCommandError>;
    /// Resize the window's **client** area (physical pixels).
    fn set_window_size(
        &self,
        role: WindowRole,
        width: i32,
        height: i32,
    ) -> Result<(), WireCommandError>;
    fn set_always_on_top(&self, role: WindowRole, on: bool) -> Result<(), WireCommandError>;
    fn set_always_on_bottom(&self, role: WindowRole, on: bool) -> Result<(), WireCommandError>;
    /// Restore the window if it is minimized and take keyboard focus.
    fn focus_window(&self, role: WindowRole) -> Result<(), WireCommandError>;
}

/// Production implementation over the real Tauri window APIs.
///
/// Every native call is made from an `async` command, i.e. off the IPC /
/// event-loop callback thread.  On Windows a WebView2 creation pumps Windows
/// messages and deadlocks the host when it runs inside a synchronous command
/// (Tauri documents this on `WebviewWindowBuilder::build`).  Off the event-loop
/// thread the very same call is *enqueue-only*: the runtime posts a
/// `Message::CreateWindow`/destroy message and returns a handle immediately, so
/// a native failure is logged by the runtime and cannot be reported here.
/// [`NativeWindowOps::reconcile_secondary`] plus [`Self::closing_secondary`]
/// are the host's answer to that asymmetry: the label stays registered between
/// an enqueued `destroy` and the runtime processing it, and a label in that
/// state is never handed to a new owner.
pub(crate) struct TauriWindowOps {
    pub(crate) app: tauri::AppHandle,
    /// True from the moment a host destroy has been enqueued until the runtime
    /// has really processed it (observed as the label disappearing) or the
    /// destroy call itself failed.
    pub(crate) closing_secondary: AtomicBool,
    /// Monotonic stamp of the destroy enqueue that set `closing_secondary`, or
    /// `None` while none is pending.  Read only by
    /// [`TauriWindowOps::retry_pending_destroy_once`].  A stale stamp is
    /// harmless: it is only ever read while `closing_secondary` is set, and every
    /// new enqueue restamps it.
    pub(crate) pending_destroy_since: Mutex<Option<Instant>>,
    /// The monotonic clock.  Injected so the pending-destroy grace period is
    /// testable without any real timer or sleep.
    pub(crate) clock: fn() -> Instant,
}

impl NativeWindowOps for TauriWindowOps {
    fn show_secondary(&self, replaced: bool) -> Result<(), WireCommandError> {
        // A label that is queued for destruction is never adopted, but a destroy
        // the runtime never completed must not block every future window either:
        // a later transition gets exactly one bounded re-attempt.
        if self.closing_secondary.load(Ordering::Acquire) {
            self.retry_pending_destroy_once();
        }
        // `ensure_secondary_window` reuses any window the label already owns, so
        // the logical `replaced` flag is not enough to decide whether the
        // frontend needs refreshing: a window left behind by a failed cleanup
        // (or a retry after one) is already alive and still holds its old
        // session token.
        let reused = self
            .app
            .get_webview_window(SECONDARY_WINDOW_LABEL)
            .is_some();
        let window = ensure_secondary_window(&self.app, &self.closing_secondary)?;
        if reused {
            // A surviving window may still carry the title of its previous
            // session; the new session starts from the default title.
            window.set_title(DEFAULT_SECONDARY_TITLE).map_err(|error| {
                WireCommandError::new(
                    WireCommandErrorCode::Internal,
                    format!("无法重置副窗口标题: {error}"),
                )
            })?;
        }
        if needs_session_refresh(replaced, reused) {
            // Tell the frontend to cancel the old presentation and re-bootstrap
            // under the new token.  A notification that is missed anyway is
            // recovered by the frontend's own stale-session handling, so this
            // cannot strand it.
            window.emit(SECONDARY_REPLACED_EVENT, ()).map_err(|error| {
                WireCommandError::new(
                    WireCommandErrorCode::Internal,
                    format!("无法通知副窗口会话已替换: {error}"),
                )
            })?;
        }
        Ok(())
    }

    fn hide_secondary(&self) -> Result<(), WireCommandError> {
        let result = destroy_secondary_window(&self.app, &self.closing_secondary);
        // Stamp the pending destroy so the bounded retry knows when the label was
        // handed to the runtime; a failed destroy is not pending at all.
        let stamp = (result.is_ok() && self.closing_secondary.load(Ordering::Acquire))
            .then(|| (self.clock)());
        if let Ok(mut since) = self.pending_destroy_since.lock() {
            *since = stamp;
        }
        result
    }

    fn is_closing_secondary(&self) -> bool {
        // Also true while a host destroy is still queued: the window is on its
        // way out, so a user close request does not have to be prevented.
        self.closing_secondary.load(Ordering::Acquire)
    }

    fn reconcile_secondary(&self, expected_live: bool) -> Result<bool, WireCommandError> {
        let present = self
            .app
            .get_webview_window(SECONDARY_WINDOW_LABEL)
            .is_some();
        if present {
            if self.closing_secondary.load(Ordering::Acquire) {
                // Queued for destruction: never adopt it, and make at most one
                // bounded re-attempt so a destroy the runtime never completed
                // cannot leave every future open refused.
                return Ok(self.retry_pending_destroy_once());
            }
            if expected_live {
                // The window exists and belongs to the live slot; a healthy
                // secondary must keep playing, so only a *missing* window is
                // re-created by this path.
                return Ok(false);
            }
            // The slot is gone while the window is not, so the window is an
            // orphan of a failed cleanup.  A label that is queued for
            // destruction is left alone: the runtime is already removing it.
            // `hide_secondary` also stamps the pending destroy for the bounded
            // retry, exactly like every other accepted destroy.
            self.hide_secondary()?;
            return Ok(true);
        }
        // The label is free again, so any queued destroy has been processed and
        // a missing window can be rebuilt without duplicating a label.
        self.closing_secondary.store(false, Ordering::Release);
        if !expected_live {
            return Ok(false);
        }
        ensure_secondary_window(&self.app, &self.closing_secondary)?;
        Ok(true)
    }

    fn set_title(&self, role: WindowRole, title: &str) -> Result<(), WireCommandError> {
        let label = label_for(role);
        let window = self.app.get_webview_window(label).ok_or_else(|| {
            WireCommandError::new(
                WireCommandErrorCode::Internal,
                format!("无法设置窗口标题: 窗口 {label} 不存在"),
            )
        })?;
        window.set_title(title).map_err(|error| {
            WireCommandError::new(
                WireCommandErrorCode::Internal,
                format!("无法设置窗口标题: {error}"),
            )
        })
    }

    fn notify_updated(&self, role: WindowRole, notice: &WireUpdateNotice) {
        let label = label_for(role);
        if let Err(error) = self.app.emit_to(label, sync::UPDATED_EVENT, notice) {
            eprintln!("更新通知投递失败（前端会通过增量同步恢复）: {error}");
        }
    }

    fn report_diagnostic(&self, message: &str) {
        eprintln!("{message}");
        let _ = self
            .app
            .emit_to(MAIN_WINDOW_LABEL, HOST_DIAGNOSTIC_EVENT, message);
    }

    fn window_metrics(&self, role: WindowRole) -> Result<WindowMetrics, WireCommandError> {
        self.read_window_metrics(role)
    }

    fn monitors(&self) -> Result<Vec<MonitorInfo>, WireCommandError> {
        self.read_monitors()
    }

    fn set_window_position(
        &self,
        role: WindowRole,
        x: i32,
        y: i32,
    ) -> Result<(), WireCommandError> {
        self.native_window(role)?
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|error| native_failure("无法移动窗口", error))
    }

    fn set_window_size(
        &self,
        role: WindowRole,
        width: i32,
        height: i32,
    ) -> Result<(), WireCommandError> {
        self.native_window(role)?
            .set_size(tauri::PhysicalSize::new(
                width.max(1) as u32,
                height.max(1) as u32,
            ))
            .map_err(|error| native_failure("无法调整窗口大小", error))
    }

    fn set_always_on_top(&self, role: WindowRole, on: bool) -> Result<(), WireCommandError> {
        self.native_window(role)?
            .set_always_on_top(on)
            .map_err(|error| native_failure("无法设置窗口置顶", error))
    }

    fn set_always_on_bottom(&self, role: WindowRole, on: bool) -> Result<(), WireCommandError> {
        self.native_window(role)?
            .set_always_on_bottom(on)
            .map_err(|error| native_failure("无法设置窗口置底", error))
    }

    fn focus_window(&self, role: WindowRole) -> Result<(), WireCommandError> {
        let window = self.native_window(role)?;
        window
            .unminimize()
            .map_err(|error| native_failure("无法还原窗口", error))?;
        window
            .set_focus()
            .map_err(|error| native_failure("无法聚焦窗口", error))
    }
}

impl TauriWindowOps {
    /// The bounded, non-blocking liveness net for a destroy the runtime accepted
    /// but never completed: at most one re-attempt per later transition, and only
    /// after [`SECONDARY_PENDING_DESTROY_GRACE`].  It never waits, loops, spawns a
    /// thread or talks to the event loop, and it never fails the caller — a
    /// destroy that fails here leaves a window that the next show adopts with a
    /// refresh.  Returns whether a destroy is still pending.
    ///
    /// This is **not** native-liveness recovery: a creation that fails *after*
    /// the runtime registered the label stays indistinguishable from success (see
    /// [`NativeWindowOps::reconcile_secondary`]).
    fn retry_pending_destroy_once(&self) -> bool {
        let now = (self.clock)();
        let due = self
            .pending_destroy_since
            .lock()
            .ok()
            .and_then(|since| *since)
            .is_some_and(|since| pending_destroy_retry_due(now.saturating_duration_since(since)));
        if !due {
            return self.closing_secondary.load(Ordering::Acquire);
        }
        // Restamp before the attempt, so this is the only attempt for this grace
        // window even when the destroy is accepted again.
        if let Ok(mut since) = self.pending_destroy_since.lock() {
            *since = Some(now);
        }
        if let Err(error) = destroy_secondary_window(&self.app, &self.closing_secondary) {
            // The window survives and is no longer queued, so a later show can
            // adopt and refresh it again.
            eprintln!("副窗口待关闭状态重试失败: {}", error.message);
        }
        self.closing_secondary.load(Ordering::Acquire)
    }

    fn native_window(&self, role: WindowRole) -> Result<tauri::WebviewWindow, WireCommandError> {
        let label = label_for(role);
        self.app.get_webview_window(label).ok_or_else(|| {
            WireCommandError::new(
                WireCommandErrorCode::Internal,
                format!("窗口 {label} 不存在"),
            )
        })
    }

    fn read_window_metrics(&self, role: WindowRole) -> Result<WindowMetrics, WireCommandError> {
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

    fn read_monitors(&self) -> Result<Vec<MonitorInfo>, WireCommandError> {
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

/// Whether showing the secondary window must tell the current native window to
/// re-bootstrap its frontend.
///
/// The host's logical `replaced` flag only describes the *slot*: a native window
/// that already exists — one left behind by a partially successful creation whose
/// cleanup failed, or one reused by a retry — still holds an older session token
/// and must be refreshed even when that flag is false.  Keeping the rule in one
/// place is what makes the retry path deterministic for the real window and for
/// the injected test seam.
pub(crate) fn needs_session_refresh(replaced: bool, reused: bool) -> bool {
    replaced || reused
}

/// How the native seam must treat the secondary label it observes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeShowAction {
    /// The label is free: create the window.
    Create,
    /// The label is alive: reuse it, refreshing the frontend when the session
    /// really changed.
    Reuse,
    /// The label is queued for destruction: refuse instead of adopting it, so a
    /// new owner never receives a window the runtime is about to tear down.
    RefusePendingDestroy,
}

/// Decide the native action from the observed label state.  Kept in one place so
/// the real seam and the injected test seam cannot drift apart.
pub(crate) fn native_show_action(label_present: bool, label_closing: bool) -> NativeShowAction {
    if !label_present {
        NativeShowAction::Create
    } else if label_closing {
        NativeShowAction::RefusePendingDestroy
    } else {
        NativeShowAction::Reuse
    }
}

/// That is the host's bounded liveness net: a label that is queued for
/// destruction is never adopted, but a destroy the runtime never completed is
/// re-attempted **once** per later transition after this grace period.  It is a
/// bound, never a wait: nothing sleeps, loops, spawns or blocks on the event
/// loop.
const SECONDARY_PENDING_DESTROY_GRACE: Duration = Duration::from_secs(2);

/// Whether a destroy that has been queued for `elapsed` may be re-attempted.
/// Kept in one place so the real seam and the injected test seam cannot drift
/// apart, and so the bound is testable without any real time passing.
pub(crate) fn pending_destroy_retry_due(elapsed: Duration) -> bool {
    elapsed >= SECONDARY_PENDING_DESTROY_GRACE
}

const SECONDARY_CLOSING_MESSAGE: &str = "副窗口正在关闭，请稍后重试";

/// Create the secondary window if it does not exist yet.  A failure is reported
/// to the caller, which rolls the whole transition back instead of committing a
/// session whose window is missing.
///
/// A label that is queued for destruction is refused instead of adopted: the
/// runtime keeps resolving a label until it processes the enqueued destroy, so
/// adopting it would hand the new owner a window that is about to disappear.
fn ensure_secondary_window(
    app: &tauri::AppHandle,
    closing_secondary: &AtomicBool,
) -> Result<tauri::WebviewWindow, WireCommandError> {
    let present = app.get_webview_window(SECONDARY_WINDOW_LABEL);
    match native_show_action(present.is_some(), closing_secondary.load(Ordering::Acquire)) {
        NativeShowAction::Reuse => {
            return Ok(present.expect("checked present"));
        }
        NativeShowAction::RefusePendingDestroy => {
            return Err(WireCommandError::new(
                WireCommandErrorCode::Runtime,
                SECONDARY_CLOSING_MESSAGE,
            ))
        }
        NativeShowAction::Create => {}
    }
    // The label is free again, so any queued destroy has been processed.
    closing_secondary.store(false, Ordering::Release);
    let window = WebviewWindowBuilder::new(
        app,
        SECONDARY_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title(DEFAULT_SECONDARY_TITLE)
    .inner_size(960.0, 540.0)
    .min_inner_size(
        window_fx::SECONDARY_MIN_CLIENT.0,
        window_fx::SECONDARY_MIN_CLIENT.1,
    )
    .build()
    .map_err(|error| {
        WireCommandError::new(
            WireCommandErrorCode::Internal,
            format!("无法创建副窗口: {error}"),
        )
    })?;
    // Hide the same browser affordances the main window does.  Best effort: a
    // failure here degrades hardening, and it deliberately does not fail the
    // transition that already created the window.
    #[cfg(windows)]
    if let Err(error) = disable_browser_features(&window) {
        eprintln!("副窗口浏览器特性关闭失败: {error}");
    }
    Ok(window)
}

/// Destroy the secondary window if it exists.  `destroy` is used instead of
/// `close` because a user/native close request is always prevented; only a host
/// transition may remove the window.  A failed destroy is reported to the
/// caller, which rolls the transition back rather than dropping the session and
/// leaving the window behind.
///
/// On success the call only *queues* the destroy (off the event-loop thread),
/// so `closing_secondary` stays set until the label is observed gone: that is
/// what stops a rapidly re-opened window from adopting a label the runtime is
/// about to tear down.
fn destroy_secondary_window(
    app: &tauri::AppHandle,
    closing_secondary: &AtomicBool,
) -> Result<(), WireCommandError> {
    let Some(window) = app.get_webview_window(SECONDARY_WINDOW_LABEL) else {
        // The label is free: a queued destroy finished, or nothing was created.
        closing_secondary.store(false, Ordering::Release);
        return Ok(());
    };
    closing_secondary.store(true, Ordering::Release);
    let result = window.destroy();
    if result.is_err() {
        // The window survives, so it is not queued for destruction after all.
        closing_secondary.store(false, Ordering::Release);
    }
    result.map_err(|error| {
        WireCommandError::new(
            WireCommandErrorCode::Internal,
            format!("副窗口关闭失败: {error}"),
        )
    })
}

fn native_failure(what: &str, error: impl std::fmt::Display) -> WireCommandError {
    WireCommandError::new(WireCommandErrorCode::Internal, format!("{what}: {error}"))
}

fn read_error(what: &'static str) -> impl FnOnce(tauri::Error) -> WireCommandError {
    move |error| native_failure(what, error)
}

/// Invisible borders beyond this are not real resize borders; ignore them.
#[cfg(windows)]
const MAX_PLAUSIBLE_INSET: i32 = 128;

/// The invisible part of a framed Windows window, from DWM.  Zero when the
/// information is unavailable (or implausible), which only costs precision.
#[cfg(windows)]
fn frame_insets(window: &tauri::WebviewWindow, outer: Rect) -> Insets {
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

#[cfg(windows)]
pub(crate) fn disable_browser_features<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> tauri::Result<()> {
    use windows::core::Interface;

    window.with_webview(|webview| unsafe {
        let controller = webview.controller();
        // Best effort: this callback runs in a place the host cannot report back
        // through `show_secondary`, and a panic here would abort the whole
        // process, so a missing interface only degrades hardening.
        let Ok(core) = controller.CoreWebView2() else {
            eprintln!("副窗口 WebView2 CoreWebView2 接口不可用，跳过浏览器特性关闭");
            return;
        };
        let Ok(settings) = core.Settings() else {
            eprintln!("副窗口 WebView2 设置不可用，跳过浏览器特性关闭");
            return;
        };
        let _ = settings.SetAreDefaultContextMenusEnabled(false);
        let _ = settings.SetAreDevToolsEnabled(false);
        let _ = settings.SetIsZoomControlEnabled(false);
        if let Ok(settings3) =
            settings.cast::<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3>()
        {
            let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
        }
    })?;
    Ok(())
}
