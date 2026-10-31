//! The live gameplay preview.
//!
//! The editor can run one real gameplay preview at a time.  The session owns an
//! isolated `RuntimeEngine` built from the current draft with
//! `with_preview_overrides`, which never touches the player's profile or save.
//! Every mutating request carries the session id (generation) so a late reply or
//! a stop/ack from a replaced session is rejected instead of acting on the new
//! world.  The lock is only held for synchronous runtime work, never across a
//! presentation await.

pub(crate) mod proof;

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;
use vectspace_core::content::ContentCatalog;
use vectspace_core::interaction::{AdvanceBlock, WindowRole, WindowTitles};
use vectspace_core::model::{
    AdvanceSource, ChoiceSnapshot, PresentationCueKind, PresentationOutcome, RuntimeSnapshot,
    RuntimeUpdate, StoryLocation,
};
use vectspace_core::runtime::{PreviewRunResult, RuntimeEngine, RuntimeError};
use vectspace_protocol::{
    variable_map_from_wire, WireCommandError, WireRuntimeUpdate, WireU64, WireVariableMap,
};

use crate::error::{internal_command_error, runtime_command_error, validation_command_error};
use crate::layout::PreviewChoiceDecision;
use crate::model::SaveProjectRequest;
use crate::preview::{
    build_preview_catalog, core_choice_decisions, prepare_preview_titles, preview_local_role,
    preview_resources, PreviewResources,
};
use crate::state::{require_project, EditorState};

/// Editor-owned gameplay preview session.
///
/// Kept alongside the catalog that produced the runtime because every
/// `RuntimeEngine` call takes `&ContentCatalog` and the draft (including staged
/// imports) is validated once at start.
pub(crate) struct LivePreviewSession {
    session_id: u64,
    catalog: ContentCatalog,
    runtime: RuntimeEngine,
    /// The window the previewed Scene is written for.  A single-window preview
    /// applies only the title/blocks/advance requests that target it.
    local: WindowRole,
    /// Author-facing explanations (for example a request for the other window
    /// that a single-window preview cannot honour) not yet shown.
    notes: Vec<String>,
    /// Monotonic clock of the previous timer tick; elapsed time is computed
    /// here so the WebView never owns an authoritative timer.
    last_tick: Instant,
}

impl LivePreviewSession {
    fn push_notes(&mut self, notes: Vec<String>) {
        for note in notes {
            if !self.notes.contains(&note) {
                self.notes.push(note);
            }
        }
    }
}

/// Longest span one tick may advance the preview timers.  A stalled or hidden
/// WebView therefore never makes timers fire in a burst when it wakes up.
const PREVIEW_MAX_TICK: Duration = Duration::from_millis(1_000);

/// A single-window preview cannot open the secondary window.  The cue is a host
/// instruction, not a presentation one, so it never reaches the surface; the
/// author is told instead of the node silently doing nothing.
fn strip_open_window_cues(update: &mut RuntimeUpdate, notes: &mut Vec<String>) {
    update.cues.retain(|cue| match &cue.kind {
        PresentationCueKind::OpenWindow { scene } => {
            notes.push(format!(
                "预览是单窗口：「打开副窗口」（{scene}）不会真的打开窗口，请在桌面双窗口运行验证"
            ));
            false
        }
        _ => true,
    });
}

/// Width of the per-session id window reserved for a live preview.
///
/// Each preview session owns a disjoint `[base, base + PREVIEW_ID_STRIDE)`
/// range for its revision, update and cue ids.  A restarted session can then
/// never reuse an id the presentation controller still remembers, so the
/// controller's per-update-id de-duplication cannot confuse a new presentation
/// with a still-settling old one.  A live preview emits far fewer than 2^20
/// updates/cues.
const PREVIEW_ID_STRIDE: u64 = 1 << 20;

/// Base id of a session's id window, overflow checked.
fn preview_id_namespace(session_id: u64) -> Result<u64, WireCommandError> {
    session_id
        .checked_mul(PREVIEW_ID_STRIDE)
        .ok_or_else(|| internal_command_error("预览编号空间耗尽，请重启编辑器"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PreviewStartMode {
    /// Start at the scene's declared entry.
    Scene,
    /// Reconstruct the target by replaying the scene path from its entry,
    /// returning `NeedsChoice` instead of guessing a branch.
    Node,
    /// Explicit fallback: reset to the scene's declared defaults and start
    /// directly at the target node without executing any predecessor.
    ResetNode,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PreviewSessionStartRequest {
    project: SaveProjectRequest,
    mode: PreviewStartMode,
    scene_id: String,
    #[serde(default)]
    node_id: Option<String>,
    #[serde(default)]
    variable_overrides: WireVariableMap,
    #[serde(default)]
    choices: Vec<PreviewChoiceDecision>,
}

#[derive(Debug, Serialize)]
#[allow(clippy::large_enum_variant)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum PreviewSessionStartResult {
    Started {
        session_id: WireU64,
        update: WireRuntimeUpdate,
        #[serde(flatten)]
        resources: PreviewResources,
        /// Things a single-window preview could not do (see `LivePreviewSession::notes`).
        notes: Vec<String>,
    },
    NeedsChoice {
        location: StoryLocation,
        visit: usize,
        choices: Vec<ChoiceSnapshot>,
        trace: Vec<StoryLocation>,
    },
    Unreachable {
        message: String,
        trace: Vec<StoryLocation>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PreviewSessionAdvanceRequest {
    session_id: WireU64,
    expected_revision: WireU64,
    source: AdvanceSource,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PreviewSessionChooseRequest {
    session_id: WireU64,
    expected_revision: WireU64,
    choice_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PreviewSessionClickButtonRequest {
    session_id: WireU64,
    expected_revision: WireU64,
    instance_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PreviewSessionAckRequest {
    session_id: WireU64,
    update_id: WireU64,
    outcome: PresentationOutcome,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PreviewSessionStopRequest {
    session_id: WireU64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PreviewSessionTickRequest {
    session_id: WireU64,
}

/// What one timer tick produced, in presentation order.
#[derive(Debug, Serialize)]
pub(crate) struct PreviewSessionTickResult {
    /// `effect` updates of fired timers, then any `story` update a local
    /// script advance caused, then a `state_refresh` when titles or blocks
    /// changed without another update to carry them.
    updates: Vec<WireRuntimeUpdate>,
    /// Single-window limitations and other author-facing explanations.
    notes: Vec<String>,
    /// Timers the runtime stopped because their effect failed.
    diagnostics: Vec<String>,
}

/// Run one runtime command on the live preview, settle the window requests it
/// left behind, and roll the whole command back if either step fails so a
/// preview never ends up half-applied.
fn run_preview_command(
    session: &mut LivePreviewSession,
    command: impl FnOnce(&mut RuntimeEngine, &ContentCatalog) -> Result<RuntimeUpdate, RuntimeError>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    let backup = session.runtime.clone();
    let mut notes = Vec::new();
    let result = command(&mut session.runtime, &session.catalog).and_then(|update| {
        session
            .runtime
            .settle_local_host(&session.catalog, session.local, update, &mut notes)
    });
    match result {
        Ok(mut update) => {
            strip_open_window_cues(&mut update, &mut notes);
            session.push_notes(notes);
            Ok(update.into())
        }
        Err(error) => {
            session.runtime = backup;
            Err(runtime_command_error(error))
        }
    }
}

/// Lock the live preview and reject a request that does not belong to it.
fn with_preview_session<T>(
    state: &EditorState,
    session_id: &WireU64,
    run: impl FnOnce(&mut LivePreviewSession) -> Result<T, WireCommandError>,
) -> Result<T, WireCommandError> {
    let expected = session_id
        .parse()
        .map_err(|_| validation_command_error("无效的预览会话编号"))?;
    let mut guard = state.lock_preview()?;
    let session = guard
        .as_mut()
        .ok_or_else(|| validation_command_error("预览会话不存在"))?;
    if session.session_id != expected {
        return Err(validation_command_error("预览会话已过期，请重新开始预览"));
    }
    run(session)
}

fn parse_revision(value: &WireU64) -> Result<u64, WireCommandError> {
    value
        .parse()
        .map_err(|_| validation_command_error("无效的修订号"))
}

#[tauri::command]
pub(crate) fn preview_session_start(
    request: PreviewSessionStartRequest,
    state: State<'_, EditorState>,
) -> Result<PreviewSessionStartResult, WireCommandError> {
    preview_session_start_command(request, &state)
}

fn preview_session_start_command(
    request: PreviewSessionStartRequest,
    state: &EditorState,
) -> Result<PreviewSessionStartResult, WireCommandError> {
    if request.mode != PreviewStartMode::Scene && request.node_id.is_none() {
        return Err(validation_command_error("未选择起始节点"));
    }
    // Allocate the session id and its id window *before* any reconstruction so
    // the runtime's update/cue/revision namespaces are unique for this session
    // and can never collide with a still-settling previous session.
    let session_id = state
        .preview_ids
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1)
        .max(1);
    let namespace = preview_id_namespace(session_id)?;
    // Build the draft catalog first, then drop the project lock before touching
    // the live-preview slot.  An invalid draft therefore fails here and cannot
    // replace or half-install a running preview.
    let catalog = {
        let guard = state.lock_session()?;
        build_preview_catalog(state, require_project(&guard)?, &request.project)?
    };
    let variable_overrides = variable_map_from_wire(request.variable_overrides.clone())
        .map_err(validation_command_error)?;
    let mut runtime = RuntimeEngine::with_preview_overrides(&catalog, &variable_overrides)
        .map_err(validation_command_error)?;
    runtime.prepare_session_ids(namespace, namespace, namespace);
    let local = preview_local_role(&catalog, &request.scene_id);
    prepare_preview_titles(&mut runtime, local);
    let decisions = core_choice_decisions(&request.choices, &request.scene_id);
    let update = match request.mode {
        PreviewStartMode::Scene => runtime
            .start_scene_preview(&catalog, &request.scene_id)
            .map_err(validation_command_error)?,
        PreviewStartMode::Node => {
            let target = StoryLocation {
                scene_id: request.scene_id.clone(),
                node_id: request.node_id.clone().unwrap_or_default(),
            };
            match runtime.preview_to_from_scene_entry(
                &catalog,
                &request.scene_id,
                &target,
                &decisions,
            ) {
                Ok(PreviewRunResult::Ready { .. }) => runtime
                    .preview_enter_current_node(&catalog)
                    .map_err(validation_command_error)?,
                Ok(PreviewRunResult::NeedsChoice {
                    location,
                    visit,
                    choices,
                    trace,
                }) => {
                    return Ok(PreviewSessionStartResult::NeedsChoice {
                        location,
                        visit,
                        choices,
                        trace,
                    });
                }
                Ok(PreviewRunResult::Unreachable { message, trace }) => {
                    return Ok(PreviewSessionStartResult::Unreachable { message, trace });
                }
                Err(error) => {
                    return Ok(PreviewSessionStartResult::Unreachable {
                        message: error.to_string(),
                        trace: Vec::new(),
                    });
                }
            }
        }
        PreviewStartMode::ResetNode => runtime
            .start_node_preview(
                &catalog,
                &request.scene_id,
                &request.node_id.clone().unwrap_or_default(),
            )
            .map_err(validation_command_error)?,
    };
    // Window requests reached on the way (a `window_title` / `window_control`
    // node) are applied to this single window before the first presentation.
    let mut notes = Vec::new();
    let mut update = runtime
        .settle_local_host(&catalog, local, update, &mut notes)
        .map_err(validation_command_error)?;
    strip_open_window_cues(&mut update, &mut notes);
    let resources = preview_resources(&catalog)?;
    let mut guard = state.lock_preview()?;
    let mut session = LivePreviewSession {
        session_id,
        catalog,
        runtime,
        local,
        notes: Vec::new(),
        last_tick: Instant::now(),
    };
    session.push_notes(notes);
    let notes = std::mem::take(&mut session.notes);
    *guard = Some(session);
    Ok(PreviewSessionStartResult::Started {
        session_id: WireU64::from(session_id),
        update: update.into(),
        resources,
        notes,
    })
}

#[tauri::command]
pub(crate) fn preview_session_advance(
    request: PreviewSessionAdvanceRequest,
    state: State<'_, EditorState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    preview_session_advance_command(request, &state)
}

fn preview_session_advance_command(
    request: PreviewSessionAdvanceRequest,
    state: &EditorState,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    let revision = parse_revision(&request.expected_revision)?;
    with_preview_session(state, &request.session_id, |session| {
        run_preview_command(session, |runtime, catalog| {
            runtime.advance(catalog, revision, request.source)
        })
    })
}

#[tauri::command]
pub(crate) fn preview_session_choose(
    request: PreviewSessionChooseRequest,
    state: State<'_, EditorState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    preview_session_choose_command(request, &state)
}

fn preview_session_choose_command(
    request: PreviewSessionChooseRequest,
    state: &EditorState,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    let revision = parse_revision(&request.expected_revision)?;
    with_preview_session(state, &request.session_id, |session| {
        run_preview_command(session, |runtime, catalog| {
            runtime.choose(catalog, &request.choice_id, revision)
        })
    })
}

#[tauri::command]
pub(crate) fn preview_session_click_button(
    request: PreviewSessionClickButtonRequest,
    state: State<'_, EditorState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    preview_session_click_button_command(request, &state)
}

fn preview_session_click_button_command(
    request: PreviewSessionClickButtonRequest,
    state: &EditorState,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    let revision = parse_revision(&request.expected_revision)?;
    with_preview_session(state, &request.session_id, |session| {
        run_preview_command(session, |runtime, catalog| {
            runtime.click_button(catalog, &request.instance_id, revision)
        })
    })
}

#[tauri::command]
pub(crate) fn preview_session_presentation_complete(
    request: PreviewSessionAckRequest,
    state: State<'_, EditorState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    preview_session_presentation_complete_command(request, &state)
}

fn preview_session_presentation_complete_command(
    request: PreviewSessionAckRequest,
    state: &EditorState,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    let update_id = request
        .update_id
        .parse()
        .map_err(|_| validation_command_error("无效的 update 编号"))?;
    with_preview_session(state, &request.session_id, |session| {
        run_preview_command(session, |runtime, catalog| {
            runtime.presentation_complete(catalog, update_id, request.outcome)
        })
    })
}

/// Titles and blocks: the window state a request can change.  Timer countdowns
/// change every tick and are deliberately not part of it.
fn shared_window_state(snapshot: &RuntimeSnapshot) -> (WindowTitles, Vec<AdvanceBlock>) {
    (
        snapshot.interaction.titles.clone(),
        snapshot.interaction.blocks.clone(),
    )
}

/// Advance the preview's Scene timers by the time since the previous tick.
///
/// The elapsed time is measured here on a monotonic clock (and capped), never
/// reported by the WebView, so a throttled or hidden preview cannot fire
/// timers in a burst.  Only the previewed window's own requests are applied;
/// everything aimed at the other window is reported in `notes`.
#[tauri::command]
pub(crate) fn preview_session_tick(
    request: PreviewSessionTickRequest,
    state: State<'_, EditorState>,
) -> Result<PreviewSessionTickResult, WireCommandError> {
    preview_session_tick_command(request, &state, Instant::now())
}

fn preview_session_tick_command(
    request: PreviewSessionTickRequest,
    state: &EditorState,
    now: Instant,
) -> Result<PreviewSessionTickResult, WireCommandError> {
    with_preview_session(state, &request.session_id, |session| {
        let elapsed = now
            .saturating_duration_since(session.last_tick)
            .min(PREVIEW_MAX_TICK);
        session.last_tick = now;
        let elapsed_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX);
        let backup = session.runtime.clone();
        let shared_before = shared_window_state(session.runtime.snapshot());
        let mut notes = Vec::new();
        let (mut updates, diagnostics) = session.runtime.tick_timers(&session.catalog, elapsed_ms);
        let settled =
            session
                .runtime
                .settle_local_requests(&session.catalog, session.local, &mut notes);
        match settled {
            Ok(story) => updates.extend(story),
            Err(error) => {
                session.runtime = backup;
                return Err(runtime_command_error(error));
            }
        }
        // A request applied to this window (title, block) changed shared state
        // after the effect update's snapshot was taken: publish it once.
        let current = shared_window_state(session.runtime.snapshot());
        let last_is_current = updates
            .last()
            .is_some_and(|update| shared_window_state(&update.snapshot) == current);
        if !last_is_current && current != shared_before {
            match session.runtime.refresh_update(&session.catalog) {
                Ok(refresh) => updates.push(refresh),
                Err(error) => {
                    session.runtime = backup;
                    return Err(runtime_command_error(error));
                }
            }
        }
        for update in &mut updates {
            strip_open_window_cues(update, &mut notes);
        }
        session.push_notes(notes);
        Ok(PreviewSessionTickResult {
            updates: updates.into_iter().map(Into::into).collect(),
            notes: std::mem::take(&mut session.notes),
            diagnostics,
        })
    })
}

/// Stop the live preview and release its runtime.
///
/// A stop from a replaced session is a no-op that never tears down the newer
/// preview: only the matching session id may clear the slot.
#[tauri::command]
pub(crate) fn preview_session_stop(
    request: PreviewSessionStopRequest,
    state: State<'_, EditorState>,
) -> Result<bool, WireCommandError> {
    preview_session_stop_command(request, &state)
}

fn preview_session_stop_command(
    request: PreviewSessionStopRequest,
    state: &EditorState,
) -> Result<bool, WireCommandError> {
    let expected = request
        .session_id
        .parse()
        .map_err(|_| validation_command_error("无效的预览会话编号"))?;
    let mut guard = state.lock_preview()?;
    if guard
        .as_ref()
        .is_some_and(|session| session.session_id == expected)
    {
        *guard = None;
        return Ok(true);
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use vectspace_core::interaction::DEFAULT_MAIN_TITLE;
    use vectspace_core::model::SceneDefinition;
    use vectspace_protocol::WireCommandErrorCode;

    use super::*;
    use crate::documents::read_yaml;
    use crate::test_support::{demo_root, demo_state, demo_wire_project};

    fn to_json<T: Serialize>(value: T) -> Value {
        serde_json::to_value(value).unwrap()
    }

    pub(super) fn request<T: serde::de::DeserializeOwned>(value: Value) -> T {
        serde_json::from_value(value).unwrap()
    }

    fn start_request(
        project: &Value,
        scene_id: &str,
        mode: &str,
        node: Option<&str>,
        overrides: Value,
    ) -> PreviewSessionStartRequest {
        request(json!({
            "project": project,
            "mode": mode,
            "scene_id": scene_id,
            "node_id": node,
            "choices": [],
            "variable_overrides": overrides
        }))
    }

    pub(super) fn start_preview(
        state: &EditorState,
        project: &Value,
        scene_id: &str,
        mode: &str,
        node: Option<&str>,
    ) -> Value {
        start_preview_with(state, project, scene_id, mode, node, json!({}))
    }

    fn start_preview_with(
        state: &EditorState,
        project: &Value,
        scene_id: &str,
        mode: &str,
        node: Option<&str>,
        overrides: Value,
    ) -> Value {
        let start = start_request(project, scene_id, mode, node, overrides);
        to_json(preview_session_start_command(start, state).unwrap())
    }

    /// Advance the live session's monotonic clock by `millis` and tick it.
    fn tick(state: &EditorState, session_id: &str, millis: u64) -> Value {
        let tick_request: PreviewSessionTickRequest = request(json!({ "session_id": session_id }));
        let now = state.preview.lock().unwrap().as_ref().unwrap().last_tick
            + Duration::from_millis(millis);
        to_json(preview_session_tick_command(tick_request, state, now).unwrap())
    }

    fn advance(state: &EditorState, session_id: &str, revision: &Value) -> Value {
        let advance_request: PreviewSessionAdvanceRequest = request(json!({
            "session_id": session_id, "expected_revision": revision, "source": "manual"
        }));
        to_json(preview_session_advance_command(advance_request, state).unwrap())
    }

    fn strings(value: &Value) -> Vec<&str> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|note| note.as_str().unwrap())
            .collect()
    }

    /// The demo project's save request with extra Scenes (and manifest
    /// variables) appended unless the manifest already declares them.
    fn demo_project_with_scenes(scenes: &[Value], variables: Value) -> (EditorState, Value) {
        let mut project = demo_wire_project();
        let object = project.as_object_mut().unwrap();
        for scene in scenes {
            let path = format!("scenes/{}.yaml", scene["id"].as_str().unwrap());
            let declared = object["manifest"]["scenes"].as_array_mut().unwrap();
            if declared.contains(&json!(path)) {
                continue;
            }
            declared.push(json!(path));
            object["scenes"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "path": path, "definition": scene }));
        }
        for (id, definition) in variables.as_object().unwrap() {
            object["manifest"]["variables"]
                .as_object_mut()
                .unwrap()
                .entry(id.clone())
                .or_insert_with(|| definition.clone());
        }
        (demo_state(), project)
    }

    pub(super) fn demo_project_with_scene(scene: Value) -> (EditorState, Value) {
        demo_project_with_scenes(&[scene], json!({}))
    }

    fn timer_scene(role: &str) -> Value {
        json!({
            "window_role": role,
            "schema_version": 2,
            "id": "tick_demo",
            "entry": "start",
            "nodes": {
                "start": {
                    "type": "window_title", "target": role,
                    "title": "Ready", "next": "arm"
                },
                "arm": {
                    "type": "timer", "id": "pulse", "action": "start",
                    "delay_ms": 100, "interval_ms": null, "target": "rename",
                    "next": "other"
                },
                "other": {
                    "type": "window_title",
                    "target": if role == "main" { "secondary" } else { "main" },
                    "title": "Elsewhere", "next": "say"
                },
                "say": {
                    "type": "say", "speaker": null,
                    "text": "Title: [var=window.main.title][var=window.secondary.title]",
                    "next": "finish"
                },
                "rename": {
                    "type": "window_title", "target": role,
                    "title": "Fired", "next": "finish"
                },
                "finish": { "type": "end" }
            }
        })
    }

    fn layout_scene() -> Value {
        json!({
            "schema_version": 2,
            "id": "layout_demo",
            "entry": "move",
            "nodes": {
                "move": {
                    "type": "window_geometry", "target": "secondary",
                    "position": {
                        "relative_to": "window", "x": 1, "y": 0.5,
                        "anchor_x": 0, "anchor_y": 0.5, "offset_x": 16
                    },
                    "duration_ms": 600, "easing": "ease_in_out", "await": false,
                    "next": "raise"
                },
                "raise": {
                    "type": "window_layer", "target": "main",
                    "action": "raise", "next": "arm"
                },
                "arm": {
                    "type": "timer", "id": "pin", "action": "start",
                    "delay_ms": 100, "interval_ms": null, "target": "pin_layer",
                    "next": "say"
                },
                "pin_layer": {
                    "type": "window_layer", "target": "main",
                    "action": "top", "next": "finish"
                },
                "say": {
                    "type": "say", "speaker": null,
                    "text": "Waiting", "next": "finish"
                },
                "finish": { "type": "end" }
            }
        })
    }

    #[test]
    fn live_session_runs_a_draft_and_rejects_stale_generations() {
        let state = demo_state();
        let project = demo_wire_project();
        let started = start_preview(&state, &project, "prologue", "node", Some("route_choice"));
        assert_eq!(started["status"], "started");
        assert_eq!(started["update"]["snapshot"]["prompt"]["kind"], "choice");
        // The start response carries the resolved assets the surface needs.
        assert!(!started["assets"].as_array().unwrap().is_empty());
        let session_id = started["session_id"].as_str().unwrap().to_owned();
        let revision = started["update"]["snapshot"]["revision"].clone();

        // A stale session id can never act on the replacement session.
        let stale: PreviewSessionAdvanceRequest = request(json!({
            "session_id": "999999", "expected_revision": revision, "source": "manual"
        }));
        let error = preview_session_advance_command(stale, &state).unwrap_err();
        assert_eq!(error.code, WireCommandErrorCode::Validation);

        // A stale stop is a no-op that leaves the live session running.
        let stale_stop: PreviewSessionStopRequest = request(json!({ "session_id": "999999" }));
        assert!(!preview_session_stop_command(stale_stop, &state).unwrap());

        // The matching command advances the same world.
        let choice_id = started["update"]["snapshot"]["prompt"]["choices"][0]["id"].clone();
        let choose: PreviewSessionChooseRequest = request(json!({
            "session_id": session_id, "expected_revision": revision, "choice_id": choice_id
        }));
        let update = preview_session_choose_command(choose, &state).unwrap();
        let previous: u64 = revision.as_str().unwrap().parse().unwrap();
        assert!(update.snapshot.revision.parse().unwrap() > previous);

        // The matching stop releases the runtime; there is no leaked session.
        let stop: PreviewSessionStopRequest = request(json!({ "session_id": session_id }));
        assert!(preview_session_stop_command(stop, &state).unwrap());
        assert!(state.preview.lock().unwrap().is_none());
    }

    #[test]
    fn an_invalid_draft_installs_no_session() {
        let state = demo_state();
        // An unknown node makes the scene validator fail before any runtime is
        // built, so no partially installed session can exist.
        let start = start_request(
            &demo_wire_project(),
            "prologue",
            "reset_node",
            Some("does_not_exist"),
            json!({}),
        );
        let error = preview_session_start_command(start, &state).unwrap_err();
        assert_ne!(error.code, WireCommandErrorCode::StaleSession);
        assert!(state.preview.lock().unwrap().is_none());
    }

    #[test]
    fn each_start_gets_a_disjoint_id_namespace() {
        assert_eq!(preview_id_namespace(1).unwrap(), PREVIEW_ID_STRIDE);
        assert!(preview_id_namespace(u64::MAX).is_err());

        let state = demo_state();
        let project = demo_wire_project();
        let parse = |value: &Value, path: &[&str]| -> u64 {
            path.iter()
                .fold(value, |current, key| &current[*key])
                .as_str()
                .unwrap()
                .parse()
                .unwrap()
        };

        let first = start_preview(&state, &project, "prologue", "scene", None);
        let first_session = parse(&first, &["session_id"]);
        let first_update = parse(&first, &["update", "update_id"]);
        let first_revision = parse(&first, &["update", "snapshot", "revision"]);
        let base = preview_id_namespace(first_session).unwrap();
        assert_eq!(first_update, base);
        assert!(first_revision >= base && first_revision < base + PREVIEW_ID_STRIDE);

        let second = start_preview(&state, &project, "prologue", "scene", None);
        let second_session = parse(&second, &["session_id"]);
        let second_update = parse(&second, &["update", "update_id"]);
        assert_ne!(second_session, first_session);
        assert_ne!(second_update, first_update);
        // The windows are disjoint, so a restarted session can never reuse an
        // update id the presentation controller still remembers.
        let second_base = preview_id_namespace(second_session).unwrap();
        assert!(second_update >= second_base);
        assert!(second_base >= base + PREVIEW_ID_STRIDE);
    }

    #[test]
    fn own_window_requests_apply_and_timers_run_on_a_monotonic_tick() {
        let (state, project) = demo_project_with_scene(timer_scene("main"));
        let started = start_preview(&state, &project, "tick_demo", "scene", None);
        assert_eq!(started["status"], "started", "{started}");
        let snapshot = &started["update"]["snapshot"];
        // The title was set before the dialogue and the other window's title
        // request was reported instead of silently applied.
        assert_eq!(snapshot["interaction"]["titles"]["main"], "Ready");
        assert_eq!(snapshot["interaction"]["titles"]["secondary"], "");
        assert_eq!(snapshot["prompt"]["text"], "Title: Ready");
        assert!(snapshot["interaction"]["timers"]["pulse"].is_object());
        let notes = strings(&started["notes"]);
        assert!(
            notes.iter().any(|note| note.contains("另一窗口")),
            "{notes:?}"
        );
        let session_id = started["session_id"].as_str().unwrap().to_owned();

        // Not due yet: nothing fires and the dialogue is untouched.
        let early = tick(&state, &session_id, 40);
        assert!(early["updates"].as_array().unwrap().is_empty(), "{early}");

        // Due: the effect runs beside the story (kind effect), the title
        // changed, and the live dialogue text was re-derived without a new
        // story occurrence.
        let fired = tick(&state, &session_id, 80);
        let updates = fired["updates"].as_array().unwrap();
        assert_eq!(updates[0]["kind"], "effect", "{fired}");
        let last = updates.last().unwrap();
        assert_eq!(last["snapshot"]["interaction"]["titles"]["main"], "Fired");
        assert_eq!(last["snapshot"]["prompt"]["text"], "Title: Fired");
        assert_eq!(
            last["snapshot"]["interaction"]["prompt_instance"],
            snapshot["interaction"]["prompt_instance"],
        );
        // A one-shot timer removes itself.
        assert!(last["snapshot"]["interaction"]["timers"]["pulse"].is_null());

        // A huge gap (stalled WebView) is capped and cannot burst anything.
        let idle = tick(&state, &session_id, 3_600_000);
        assert!(idle["updates"].as_array().unwrap().is_empty());

        // A command after ticks uses the latest revision and still works.
        let next = advance(&state, &session_id, &last["snapshot"]["revision"]);
        assert_eq!(next["snapshot"]["prompt"]["kind"], "end");
        let stale: PreviewSessionTickRequest = request(json!({ "session_id": "999999" }));
        assert!(preview_session_tick_command(stale, &state, Instant::now()).is_err());
    }

    #[test]
    fn secondary_scene_preview_starts_with_a_fresh_secondary_title() {
        let (state, project) = demo_project_with_scene(timer_scene("secondary"));
        let started = start_preview(&state, &project, "tick_demo", "scene", None);
        assert_eq!(started["status"], "started", "{started}");
        // `start` renames the secondary window itself; the main-window title
        // request is explained rather than applied.
        let titles = &started["update"]["snapshot"]["interaction"]["titles"];
        assert_eq!(titles["secondary"], "Ready");
        assert_eq!(titles["main"], DEFAULT_MAIN_TITLE);
        assert!(strings(&started["notes"])
            .iter()
            .any(|note| note.contains("另一窗口")));
    }

    #[test]
    fn static_node_preview_reconstructs_through_window_nodes_and_timers() {
        let (state, project) = demo_project_with_scene(timer_scene("main"));
        let started = start_preview(&state, &project, "tick_demo", "node", Some("say"));
        assert_eq!(started["status"], "started", "{started}");
        assert_eq!(started["update"]["snapshot"]["prompt"]["kind"], "dialogue");
        assert_eq!(
            started["update"]["snapshot"]["interaction"]["titles"]["main"],
            "Ready"
        );
    }

    #[test]
    fn window_layout_requests_are_explained_without_moving_the_editor() {
        let (state, project) = demo_project_with_scene(layout_scene());
        let started = start_preview(&state, &project, "layout_demo", "scene", None);
        assert_eq!(started["status"], "started", "{started}");
        // Neither request holds the story: it runs straight on to the line.
        assert_eq!(started["update"]["snapshot"]["prompt"]["kind"], "dialogue");
        assert_eq!(started["update"]["requires_ack"], false);
        let notes = strings(&started["notes"]);
        assert!(
            notes
                .iter()
                .any(|note| note.contains("预览不会移动或缩放真实窗口")),
            "{notes:?}"
        );
        assert!(
            notes
                .iter()
                .any(|note| note.contains("预览不会改变真实窗口层级")),
            "{notes:?}"
        );

        // A timer firing a layer node is explained the same way, never applied.
        let session_id = started["session_id"].as_str().unwrap();
        let fired = tick(&state, session_id, 150);
        let notes = strings(&fired["notes"]);
        assert!(
            notes
                .iter()
                .any(|note| note.contains("预览不会改变真实窗口层级")),
            "{fired}"
        );
        assert!(
            fired["diagnostics"].as_array().unwrap().is_empty(),
            "{fired}"
        );
        let guard = state.preview.lock().unwrap();
        assert!(guard
            .as_ref()
            .unwrap()
            .runtime
            .snapshot()
            .interaction
            .timers
            .is_empty());
    }

    #[test]
    fn bundled_two_window_demo_runs_in_a_single_window_preview() {
        let root = demo_root();
        let load = |name: &str| {
            to_json(read_yaml::<SceneDefinition>(&root.join("scenes").join(name)).unwrap())
        };
        let (state, project) = demo_project_with_scenes(
            &[load("window_pair_main.yaml"), load("window_pair_side.yaml")],
            json!({
                "pair_ready": {
                    "scope": "save",
                    "type": "boolean",
                    "default": { "kind": "boolean", "value": false }
                }
            }),
        );

        // The secondary half: its own title is set, the main window it blocks
        // is explained, and the Choice option waits for pair_ready.
        let side = start_preview(&state, &project, "window_pair_side", "scene", None);
        assert_eq!(side["status"], "started", "{side}");
        let snapshot = &side["update"]["snapshot"];
        assert_eq!(
            snapshot["interaction"]["titles"]["secondary"],
            "副窗口 · 做个选择（主窗口：VECTSPACE）"
        );
        assert_eq!(snapshot["prompt"]["kind"], "dialogue");
        assert!(strings(&side["notes"])
            .iter()
            .any(|note| note.contains("另一窗口") && note.contains("阻挡")));
        let pick = advance(
            &state,
            side["session_id"].as_str().unwrap(),
            &snapshot["revision"],
        );
        let open = pick["snapshot"]["prompt"]["choices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|choice| choice["id"] == "open")
            .unwrap();
        assert_eq!(open["enabled"], false);
        let ready = start_preview_with(
            &state,
            &project,
            "window_pair_side",
            "node",
            Some("pick"),
            json!({ "pair_ready": { "kind": "boolean", "value": true } }),
        );
        assert!(ready["update"]["snapshot"]["prompt"]["choices"]
            .as_array()
            .unwrap()
            .iter()
            .any(|choice| choice["id"] == "open" && choice["enabled"] == true));

        // The main half: both timers are armed, the 3 s timer flips the
        // variable beside the story, and window requests aimed at the other
        // window are explained instead of applied.
        let main = start_preview(&state, &project, "window_pair_main", "scene", None);
        assert_eq!(main["status"], "started", "{main}");
        let snapshot = &main["update"]["snapshot"];
        assert_eq!(
            snapshot["interaction"]["titles"]["main"],
            "主窗口 · 等候副窗口"
        );
        let timers = snapshot["interaction"]["timers"].as_object().unwrap();
        assert!(timers.contains_key("ready_timer") && timers.contains_key("idle_bounce"));
        let notes = strings(&main["notes"]);
        assert!(notes.iter().any(|note| note.contains("打开副窗口")));
        // The open_window host cue never reaches the surface.
        let cues = main["update"]["cues"].as_array().unwrap();
        assert!(cues.iter().all(|cue| cue["type"] != "open_window"));
        // Moving the main window is awaited, so the story holds on a 600 ms
        // delay (the timers were armed before it); the single-window preview
        // says it cannot move the real window instead of pretending to.
        assert_eq!(main["update"]["requires_ack"], true);
        assert!(cues
            .iter()
            .any(|cue| cue["type"] == "delay" && cue["duration_ms"] == 600));
        assert!(notes
            .iter()
            .any(|note| note.contains("预览不会移动或缩放真实窗口")));
        let session_id = main["session_id"].as_str().unwrap();

        // Once the delay has played the unawaited docking move passes straight
        // through to the waiting line.
        let ack: PreviewSessionAckRequest = request(json!({
            "session_id": session_id,
            "update_id": main["update"]["update_id"],
            "outcome": "completed",
        }));
        let after_move =
            to_json(preview_session_presentation_complete_command(ack, &state).unwrap());
        assert_eq!(
            after_move["snapshot"]["prompt"]["kind"], "dialogue",
            "{after_move}"
        );
        let mut kinds = Vec::new();
        let mut ready_seen = false;
        for _ in 0..4 {
            let result = tick(&state, session_id, 1_000);
            for update in result["updates"].as_array().unwrap() {
                kinds.push(update["kind"].as_str().unwrap().to_owned());
                ready_seen |= update["snapshot"]["variables"]["pair_ready"]["value"] == true;
            }
        }
        assert!(ready_seen, "{kinds:?}");
        assert!(kinds.iter().any(|kind| kind == "effect"));
        let guard = state.preview.lock().unwrap();
        let live = guard.as_ref().unwrap().runtime.snapshot();
        assert!(live.interaction.timers.contains_key("idle_bounce"));
        assert!(!live.interaction.timers.contains_key("ready_timer"));
    }
}
