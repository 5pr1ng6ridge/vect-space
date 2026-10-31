//! The Tauri commands the frontends invoke.
//!
//! Each command first checks which window it came from, then delegates to a
//! transaction on [`EngineState`].  Every command that takes the session gate is
//! an `async fn`: Tauri runs a synchronous command inline in the WebView IPC
//! callback (the event-loop thread on Windows), where creating a WebView
//! deadlocks the host and any command that blocks the event loop while another
//! holds the session gate stalls the whole app.

use tauri::State;
use vectspace_core::{
    interaction::WindowRole,
    model::{
        AdvanceSource, ChapterMapSnapshot, PresentationOutcome, ResolvedAsset, SaveSlotRequest,
        SaveSlotSummary, Settings,
    },
};
use vectspace_protocol::{
    WireBootstrapPayload, WireCommandError, WireCommandErrorCode, WireDialogueHistoryEntry,
    WirePauseAck, WirePauseReason, WireRuntimeUpdate, WireSyncBatch, WireU64,
};

use crate::{
    native_window::role_for_label, pair::debug_assert_no_window_cue, save::SecondaryState,
    save::SlotDocument, state::EngineState,
};

/// Which window a command was invoked from.  This is derived from the WebView
/// label the host itself assigned, never from a JS-supplied value, so a crafted
/// payload cannot impersonate the main window.
fn window_role(window: &tauri::WebviewWindow) -> Option<WindowRole> {
    role_for_label(window.label())
}

/// Every main-only command denies all non-main labels, including an unknown
/// label, so a future window can never inherit main authority by accident.
pub(crate) fn require_main(window: &tauri::WebviewWindow) -> Result<(), WireCommandError> {
    if window_role(window) == Some(WindowRole::Main) {
        return Ok(());
    }
    Err(WireCommandError::new(
        WireCommandErrorCode::Validation,
        "该操作只能由主窗口执行",
    ))
}

/// Secondary gameplay commands require the exact secondary label.
fn require_secondary(window: &tauri::WebviewWindow) -> Result<(), WireCommandError> {
    if window_role(window) == Some(WindowRole::Secondary) {
        return Ok(());
    }
    Err(WireCommandError::new(
        WireCommandErrorCode::Validation,
        "该操作只能由副窗口执行",
    ))
}

/// Shared, read-only commands accept either known window but never an unknown
/// label.
fn require_known_window(window: &tauri::WebviewWindow) -> Result<(), WireCommandError> {
    if window_role(window).is_some() {
        return Ok(());
    }
    Err(WireCommandError::new(
        WireCommandErrorCode::Validation,
        "未知窗口来源，已拒绝该请求",
    ))
}

#[tauri::command]
pub(crate) async fn bootstrap(
    window: tauri::WebviewWindow,
    state: State<'_, EngineState>,
) -> Result<WireBootstrapPayload, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    // `RuntimeEngine::bootstrap` returns the cue-less snapshot by construction
    // (`update_without_cues`), so there is never a host-only window cue on this
    // path to consume or stage.  A story whose *entry* node opens a window is
    // reached through `start_new_game`, not through the bootstrap.  The update
    // carries the window's latest delivery sequence as the frontend's baseline.
    let (update, payload) = state.bootstrap_update(WindowRole::Main)?;
    debug_assert_no_window_cue(&payload.update);
    // The window starts over: whatever it reported about itself is void.
    state.clear_pause_reports(WindowRole::Main);
    Ok(WireBootstrapPayload {
        update,
        asset_ids: payload.asset_ids,
        content_version: payload.content_version,
        chapter_map_available: payload.chapter_map_available,
        default_font: payload.default_font,
        text_blocks: payload.text_blocks,
        particles: payload.particles,
    })
}

/// The secondary window's own bootstrap.  It never loads settings, save slots,
/// chapter maps or history: the secondary has normal gameplay and nothing else.
#[tauri::command]
pub(crate) async fn secondary_bootstrap(
    window: tauri::WebviewWindow,
    state: State<'_, EngineState>,
) -> Result<WireBootstrapPayload, WireCommandError> {
    require_secondary(&window)?;
    let _gate = state.session_gate()?;
    state.secondary_bootstrap_payload()
}

#[tauri::command]
pub(crate) async fn start_new_game(
    window: tauri::WebviewWindow,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    if state.replay()?.is_some() {
        return Err(WireCommandError::new(
            WireCommandErrorCode::Runtime,
            "重演期间不能开始新游戏",
        ));
    }
    // A new game is a hard ownership boundary: any secondary window (and the
    // merged ledger, which the runtime just reset) must not outlive it, even
    // when the new game happens to start in the Scene that owns the window.
    let was_title = state.set_title_screen(false);
    let committed = match state
        .transact_runtime_forced(|runtime| runtime.start_new_game(&state.content), true)
    {
        Ok(committed) => committed,
        Err(error) => {
            state.restore_title_screen(was_title);
            return Err(error);
        }
    };
    // The new session is adopted before anything is published, so the
    // response carries the new session's first sequence number.
    state.bump_session_id()?;
    state.deliver(committed, WindowRole::Main)
}

#[tauri::command]
pub(crate) async fn advance(
    window: tauri::WebviewWindow,
    expected_revision: WireU64,
    source: AdvanceSource,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_main(&window)?;
    let expected_revision = expected_revision.parse().map_err(WireCommandError::from)?;
    state.transact_active_runtime(expected_session_id.as_ref(), |runtime| {
        runtime.advance(&state.content, expected_revision, source)
    })
}

#[tauri::command]
pub(crate) async fn choose(
    window: tauri::WebviewWindow,
    choice_id: String,
    expected_revision: WireU64,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_main(&window)?;
    let expected_revision = expected_revision.parse().map_err(WireCommandError::from)?;
    state.transact_active_runtime(expected_session_id.as_ref(), |runtime| {
        runtime.choose(&state.content, &choice_id, expected_revision)
    })
}

#[tauri::command]
pub(crate) async fn click_button(
    window: tauri::WebviewWindow,
    instance_id: String,
    expected_revision: WireU64,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_main(&window)?;
    let expected_revision = expected_revision.parse().map_err(WireCommandError::from)?;
    state.transact_active_runtime(expected_session_id.as_ref(), |runtime| {
        runtime.click_button(&state.content, &instance_id, expected_revision)
    })
}

#[tauri::command]
pub(crate) async fn presentation_complete(
    window: tauri::WebviewWindow,
    update_id: WireU64,
    outcome: PresentationOutcome,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    let update_id = update_id.parse().map_err(WireCommandError::from)?;
    let has_replay = state.replay()?.is_some();
    if has_replay {
        // Every replay acknowledgement path goes through the replay transaction,
        // which consumes the host-only cue and stages the window work the new
        // replay state implies — including the ending path, whose boundary
        // update is subject to the same host invariant.
        let ending = state
            .replay()?
            .as_ref()
            .is_some_and(|session| session.ending);
        let committed = if ending {
            state.transact_replay(|runtime| runtime.finish_replay_boundary(update_id))?
        } else {
            state.transact_replay(|runtime| {
                runtime.presentation_complete(&state.content, update_id, outcome)
            })?
        };
        return state.deliver(committed, WindowRole::Main);
    }
    let committed = state.transact_runtime(|runtime| {
        runtime.presentation_complete(&state.content, update_id, outcome)
    })?;
    state.deliver(committed, WindowRole::Main)
}

#[tauri::command]
pub(crate) async fn get_dialogue_history(
    window: tauri::WebviewWindow,
    state: State<'_, EngineState>,
) -> Result<Vec<WireDialogueHistoryEntry>, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    if let Some(replay) = state.replay()?.as_ref() {
        return Ok(replay
            .runtime
            .dialogue_history()
            .iter()
            .cloned()
            .map(Into::into)
            .collect());
    }
    // The main runtime's ledger is the single ordered main+secondary ledger.
    Ok(state
        .runtime()?
        .dialogue_history()
        .iter()
        .cloned()
        .map(Into::into)
        .collect())
}

#[tauri::command]
pub(crate) async fn get_chapter_map(
    window: tauri::WebviewWindow,
    state: State<'_, EngineState>,
) -> Result<Option<ChapterMapSnapshot>, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state
        .runtime()?
        .chapter_map(&state.content)
        .map_err(WireCommandError::from)
}

#[tauri::command]
pub(crate) async fn start_scene_replay(
    window: tauri::WebviewWindow,
    scene_id: String,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    // Entry is one transaction over the replay runtime, the secondary slot and
    // the native window plan, so a replay can really own the window its own
    // `open_window` node opens or re-points without ever leaving an orphan.
    let committed = state.enter_replay(&scene_id)?;
    state.deliver(committed, WindowRole::Main)
}

#[tauri::command]
pub(crate) async fn exit_scene_replay(
    window: tauri::WebviewWindow,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireU64, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    state.exit_replay()?;
    Ok(state.current_session_id().into())
}

/// Invalidate outstanding story-side IPC and presentation callbacks when the
/// player leaves the story for the title screen.  The authoritative runtime
/// is intentionally kept intact so "开始" can still start a fresh game, but
/// the host generation makes late acknowledgements fail with
/// `stale_session` instead of mutating that hidden runtime.
#[tauri::command]
pub(crate) async fn invalidate_session(
    window: tauri::WebviewWindow,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireU64, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    Ok(state.leave_story_for_title()?.into())
}

/// Incremental, ordered update synchronisation for the main window.  Events only
/// announce that something is new (`vectspace://runtime-updated`); this is where
/// the updates themselves are fetched, so a lost event or a lost command response
/// never loses a story advance or a presentation cue.
#[tauri::command]
pub(crate) async fn sync_updates(
    window: tauri::WebviewWindow,
    expected_session_id: Option<WireU64>,
    after_seq: WireU64,
    state: State<'_, EngineState>,
) -> Result<WireSyncBatch, WireCommandError> {
    require_main(&window)?;
    let after_seq = after_seq.parse().map_err(WireCommandError::from)?;
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    state.sync_batch(WindowRole::Main, after_seq)
}

#[tauri::command]
pub(crate) async fn secondary_sync_updates(
    window: tauri::WebviewWindow,
    expected_session_id: Option<WireU64>,
    after_seq: WireU64,
    state: State<'_, EngineState>,
) -> Result<WireSyncBatch, WireCommandError> {
    require_secondary(&window)?;
    let after_seq = after_seq.parse().map_err(WireCommandError::from)?;
    let _gate = state.session_gate()?;
    state.check_secondary_session(expected_session_id.as_ref())?;
    state.sync_batch(WindowRole::Secondary, after_seq)
}

/// The main window reports panel visibility (save/settings/history) and
/// `document.hidden`.  Window focus is deliberately not a pause reason.
#[tauri::command]
pub(crate) async fn set_story_pause(
    window: tauri::WebviewWindow,
    expected_session_id: Option<WireU64>,
    reason: WirePauseReason,
    active: bool,
    state: State<'_, EngineState>,
) -> Result<WirePauseAck, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    state.set_pause(WindowRole::Main, reason, active)
}

#[tauri::command]
pub(crate) async fn secondary_set_story_pause(
    window: tauri::WebviewWindow,
    expected_session_id: Option<WireU64>,
    reason: WirePauseReason,
    active: bool,
    state: State<'_, EngineState>,
) -> Result<WirePauseAck, WireCommandError> {
    require_secondary(&window)?;
    let _gate = state.session_gate()?;
    state.check_secondary_session(expected_session_id.as_ref())?;
    state.set_pause(WindowRole::Secondary, reason, active)
}

#[tauri::command]
pub(crate) fn resolve_assets(
    window: tauri::WebviewWindow,
    asset_ids: Vec<String>,
    state: State<'_, EngineState>,
) -> Result<Vec<ResolvedAsset>, WireCommandError> {
    // Asset resolution is read-only and shared by both windows, but it still
    // requires a host-issued label.
    require_known_window(&window)?;
    state
        .content
        .resolve_assets(&asset_ids)
        .map_err(|error| WireCommandError::new(WireCommandErrorCode::Asset, error.to_string()))
}

#[tauri::command]
pub(crate) fn list_save_slots(
    window: tauri::WebviewWindow,
    state: State<'_, EngineState>,
) -> Result<Vec<SaveSlotSummary>, WireCommandError> {
    require_main(&window)?;
    Ok(state.saves.list())
}

#[tauri::command]
pub(crate) async fn save_slot(
    window: tauri::WebviewWindow,
    request: SaveSlotRequest,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<SaveSlotSummary, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    if state.replay()?.is_some() {
        return Err(WireCommandError::new(
            WireCommandErrorCode::Runtime,
            "重演期间不能存档",
        ));
    }
    let runtime = state.runtime()?;
    if let Some(update_id) = runtime.pending_runtime_update() {
        return Err(WireCommandError::new(
            WireCommandErrorCode::Runtime,
            format!("表现层仍在执行 update {update_id}，暂时不能存档"),
        ));
    }
    // A save captures both sessions atomically, so neither may be mid-ack.
    let secondary_slot = state.secondary()?;
    let secondary_state = match secondary_slot.as_ref() {
        Some(session) => {
            if let Some(update_id) = session.runtime.pending_runtime_update() {
                return Err(WireCommandError::new(
                    WireCommandErrorCode::Runtime,
                    format!("副窗口仍在执行 update {update_id}，暂时不能存档"),
                ));
            }
            // Only a story-owned session is real progress.  Replay play is
            // ephemeral by design, so a replay-owned secondary never reaches a
            // slot (saving is already refused while a replay is live).
            let Some(owning_scene) = session.owner.story_scene() else {
                return Err(WireCommandError::new(
                    WireCommandErrorCode::Runtime,
                    "重演期间不能存档",
                ));
            };
            Some(SecondaryState {
                scene_id: session.scene_id.clone(),
                owning_scene: owning_scene.to_owned(),
                snapshot: session.runtime.snapshot().clone(),
                profile: session.runtime.profile_state(&state.content),
            })
        }
        None => None,
    };
    let history = runtime.dialogue_history().to_vec();
    state
        .saves
        .save(
            &request.slot,
            SlotDocument {
                snapshot: runtime.snapshot(),
                history: &history,
                secondary: secondary_state.as_ref(),
            },
            request.thumbnail_data_url,
        )
        .map_err(WireCommandError::from)
}

#[tauri::command]
pub(crate) async fn load_slot(
    window: tauri::WebviewWindow,
    slot: String,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    if state.replay()?.is_some() {
        return Err(WireCommandError::new(
            WireCommandErrorCode::Runtime,
            "重演期间不能读档",
        ));
    }
    let loaded = state.saves.load(&slot)?;
    let was_title = state.set_title_screen(false);
    let committed = match state.apply_loaded_slot(loaded) {
        Ok(committed) => committed,
        Err(error) => {
            state.restore_title_screen(was_title);
            return Err(error);
        }
    };
    state.bump_session_id()?;
    state.deliver(committed, WindowRole::Main)
}

#[tauri::command]
pub(crate) fn load_settings(
    window: tauri::WebviewWindow,
    state: State<'_, EngineState>,
) -> Result<Settings, WireCommandError> {
    require_main(&window)?;
    Ok(state.saves.load_settings())
}

#[tauri::command]
pub(crate) fn save_settings(
    window: tauri::WebviewWindow,
    settings: Settings,
    state: State<'_, EngineState>,
) -> Result<Settings, WireCommandError> {
    require_main(&window)?;
    state
        .saves
        .save_settings(settings)
        .map_err(WireCommandError::from)
}

#[tauri::command]
pub(crate) async fn secondary_advance(
    window: tauri::WebviewWindow,
    expected_revision: WireU64,
    source: AdvanceSource,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_secondary(&window)?;
    let expected_revision = expected_revision.parse().map_err(WireCommandError::from)?;
    let _gate = state.session_gate()?;
    let (committed, _token) = state
        .transact_secondary(expected_session_id.as_ref(), |runtime| {
            runtime.advance(&state.content, expected_revision, source)
        })?;
    state.deliver(committed, WindowRole::Secondary)
}

#[tauri::command]
pub(crate) async fn secondary_choose(
    window: tauri::WebviewWindow,
    choice_id: String,
    expected_revision: WireU64,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_secondary(&window)?;
    let expected_revision = expected_revision.parse().map_err(WireCommandError::from)?;
    let _gate = state.session_gate()?;
    let (committed, _token) = state
        .transact_secondary(expected_session_id.as_ref(), |runtime| {
            runtime.choose(&state.content, &choice_id, expected_revision)
        })?;
    state.deliver(committed, WindowRole::Secondary)
}

#[tauri::command]
pub(crate) async fn secondary_click_button(
    window: tauri::WebviewWindow,
    instance_id: String,
    expected_revision: WireU64,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_secondary(&window)?;
    let expected_revision = expected_revision.parse().map_err(WireCommandError::from)?;
    let _gate = state.session_gate()?;
    let (committed, _token) = state
        .transact_secondary(expected_session_id.as_ref(), |runtime| {
            runtime.click_button(&state.content, &instance_id, expected_revision)
        })?;
    state.deliver(committed, WindowRole::Secondary)
}

#[tauri::command]
pub(crate) async fn secondary_presentation_complete(
    window: tauri::WebviewWindow,
    update_id: WireU64,
    outcome: PresentationOutcome,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_secondary(&window)?;
    let update_id = update_id.parse().map_err(WireCommandError::from)?;
    let _gate = state.session_gate()?;
    let (committed, _token) = state
        .transact_secondary(expected_session_id.as_ref(), |runtime| {
            runtime.presentation_complete(&state.content, update_id, outcome)
        })?;
    state.deliver(committed, WindowRole::Secondary)
}
