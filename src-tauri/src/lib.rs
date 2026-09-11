mod save;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard,
    },
};

use save::{ProfileManager, SaveError, SaveManager};
use tauri::{path::BaseDirectory, Manager, State};
use vectspace_core::{
    content::ContentCatalog,
    model::{
        AdvanceSource, ChapterMapSnapshot, PresentationOutcome, ResolvedAsset, RuntimeUpdate,
        SaveSlotRequest, SaveSlotSummary, SceneNode, Settings,
    },
    runtime::{self, RuntimeEngine},
};
use vectspace_protocol::{
    WireBootstrapPayload, WireCommandError, WireCommandErrorCode, WireDialogueHistoryEntry,
    WireRuntimeSnapshot, WireRuntimeUpdate, WireSessionMode, WireU64,
};

struct EngineState {
    content: ContentCatalog,
    runtime: Mutex<RuntimeEngine>,
    replay: Mutex<Option<ReplaySession>>,
    /// Serializes the check-and-act boundary when switching between the main
    /// story runtime and an isolated replay.  Without this lock, an advance
    /// could observe “no replay”, yield, and then mutate the main runtime just
    /// after another command had entered replay mode.
    session_gate: Mutex<()>,
    /// Monotonic namespace for isolated sessions.  Main-story IDs stay in
    /// their normal small range while every replay receives a disjoint high
    /// range, so delayed cue acknowledgements cannot be applied to another
    /// session after the user returns to the map.
    replay_generation: AtomicU64,
    /// Monotonic host-session generation.  It changes whenever the active
    /// story/replay runtime changes so delayed IPC responses can never be
    /// applied to a newer session.
    session_id: AtomicU64,
    saves: SaveManager,
    profile: ProfileManager,
}

/// A replay is deliberately kept separate from the player's runtime.  It
/// borrows a cloned profile/default state at start and is never persisted.
/// `ending` prevents a cross-scene jump from evaluating its destination.
struct ReplaySession {
    runtime: RuntimeEngine,
    scene_id: String,
    ending: bool,
}

const REPLAY_ID_STRIDE: u64 = 1 << 32;

impl EngineState {
    fn runtime(&self) -> Result<MutexGuard<'_, RuntimeEngine>, WireCommandError> {
        self.runtime.lock().map_err(|_| {
            WireCommandError::new(WireCommandErrorCode::Internal, "运行时互斥锁已损坏")
        })
    }

    fn replay(&self) -> Result<MutexGuard<'_, Option<ReplaySession>>, WireCommandError> {
        self.replay.lock().map_err(|_| {
            WireCommandError::new(WireCommandErrorCode::Internal, "重演运行时互斥锁已损坏")
        })
    }

    fn session_gate(&self) -> Result<MutexGuard<'_, ()>, WireCommandError> {
        self.session_gate
            .lock()
            .map_err(|_| WireCommandError::new(WireCommandErrorCode::Internal, "会话互斥锁已损坏"))
    }

    fn transact_runtime(
        &self,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<RuntimeUpdate, WireCommandError> {
        let mut runtime = self.runtime()?;
        let mut candidate = runtime.clone();
        let update = operation(&mut candidate).map_err(WireCommandError::from)?;
        let candidate_profile = candidate.profile_state(&self.content);
        if candidate_profile != runtime.profile_state(&self.content) {
            self.profile.save(&candidate_profile).map_err(save_error)?;
        }
        *runtime = candidate;
        Ok(update)
    }

    fn transact_replay(
        &self,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<RuntimeUpdate, WireCommandError> {
        let mut replay = self.replay()?;
        let session = replay.as_mut().ok_or_else(|| {
            WireCommandError::new(
                WireCommandErrorCode::Runtime,
                "当前没有正在进行的 Scene 重演",
            )
        })?;
        let mut candidate = session.runtime.clone();
        let update = operation(&mut candidate).map_err(WireCommandError::from)?;
        if candidate.snapshot().location.scene_id != session.scene_id
            || matches!(
                candidate.snapshot().prompt,
                vectspace_core::model::PromptSnapshot::End { .. }
            )
        {
            session.ending = true;
        }
        session.runtime = candidate;
        Ok(update)
    }

    fn transact_active_runtime(
        &self,
        expected_session_id: Option<&WireU64>,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<(RuntimeUpdate, u64, WireSessionMode), WireCommandError> {
        let _gate = self.session_gate()?;
        // The session check must happen while holding the same gate as the
        // runtime mutation.  Checking before acquiring it leaves a race in
        // which a replay can be entered between the check and the operation,
        // allowing a stale story request to mutate the new session.
        self.check_session(expected_session_id)?;
        let (update, mode) = if self.replay()?.is_some() {
            (self.transact_replay(operation)?, WireSessionMode::Replay)
        } else {
            (self.transact_runtime(operation)?, WireSessionMode::Story)
        };
        Ok((update, self.current_session_id(), mode))
    }

    fn current_session_id(&self) -> u64 {
        self.session_id.load(Ordering::Acquire)
    }

    fn bump_session_id(&self) -> Result<u64, WireCommandError> {
        let previous = self
            .session_id
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(1)
            });
        previous
            .map(|value| value + 1)
            .map_err(|_| WireCommandError::new(WireCommandErrorCode::Internal, "会话编号耗尽"))
    }

    fn check_session(&self, expected: Option<&WireU64>) -> Result<(), WireCommandError> {
        let Some(expected) = expected else {
            return Err(WireCommandError::new(
                WireCommandErrorCode::StaleSession,
                "请求缺少会话编号，请重新连接运行时",
            ));
        };
        let expected = expected.parse().map_err(WireCommandError::from)?;
        let actual = self.current_session_id();
        if expected != actual {
            return Err(WireCommandError::new(
                WireCommandErrorCode::StaleSession,
                format!("会话已切换，当前会话为 {actual}，请求来自 {expected}"),
            ));
        }
        Ok(())
    }
}

fn wire_update(
    state: &EngineState,
    update: RuntimeUpdate,
    mode: WireSessionMode,
) -> WireRuntimeUpdate {
    WireRuntimeUpdate::with_session(update, WireU64::from(state.current_session_id()), mode)
}

fn wire_snapshot(
    state: &EngineState,
    snapshot: vectspace_core::model::RuntimeSnapshot,
    mode: WireSessionMode,
) -> WireRuntimeSnapshot {
    WireRuntimeSnapshot::with_session(snapshot, WireU64::from(state.current_session_id()), mode)
}

#[tauri::command]
fn bootstrap(state: State<'_, EngineState>) -> Result<WireBootstrapPayload, WireCommandError> {
    let _gate = state.session_gate()?;
    let payload = state.runtime()?.bootstrap(&state.content);
    Ok(WireBootstrapPayload {
        update: wire_update(&state, payload.update, WireSessionMode::Story),
        asset_ids: payload.asset_ids,
        content_version: payload.content_version,
        chapter_map_available: payload.chapter_map_available,
        default_font: payload.default_font,
    })
}

#[tauri::command]
fn start_new_game(
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    if state.replay()?.is_some() {
        return Err(WireCommandError::new(
            WireCommandErrorCode::Runtime,
            "重演期间不能开始新游戏",
        ));
    }
    let update = state.transact_runtime(|runtime| runtime.start_new_game(&state.content))?;
    state.bump_session_id()?;
    Ok(wire_update(&state, update, WireSessionMode::Story))
}

#[tauri::command]
fn advance(
    expected_revision: WireU64,
    source: AdvanceSource,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    let expected_revision = expected_revision.parse().map_err(WireCommandError::from)?;
    let (update, session_id, mode) = state
        .transact_active_runtime(expected_session_id.as_ref(), |runtime| {
            runtime.advance(&state.content, expected_revision, source)
        })?;
    Ok(WireRuntimeUpdate::with_session(
        update,
        session_id.into(),
        mode,
    ))
}

#[tauri::command]
fn choose(
    choice_id: String,
    expected_revision: WireU64,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    let expected_revision = expected_revision.parse().map_err(WireCommandError::from)?;
    let (update, session_id, mode) = state
        .transact_active_runtime(expected_session_id.as_ref(), |runtime| {
            runtime.choose(&state.content, &choice_id, expected_revision)
        })?;
    Ok(WireRuntimeUpdate::with_session(
        update,
        session_id.into(),
        mode,
    ))
}

#[tauri::command]
fn click_button(
    instance_id: String,
    expected_revision: WireU64,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    let expected_revision = expected_revision.parse().map_err(WireCommandError::from)?;
    let (update, session_id, mode) = state
        .transact_active_runtime(expected_session_id.as_ref(), |runtime| {
            runtime.click_button(&state.content, &instance_id, expected_revision)
        })?;
    Ok(WireRuntimeUpdate::with_session(
        update,
        session_id.into(),
        mode,
    ))
}

#[tauri::command]
fn presentation_complete(
    update_id: WireU64,
    outcome: PresentationOutcome,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    let update_id = update_id.parse().map_err(WireCommandError::from)?;
    let has_replay = state.replay()?.is_some();
    if has_replay {
        let ending = state
            .replay()?
            .as_ref()
            .is_some_and(|session| session.ending);
        if ending {
            let mut sessions = state.replay()?;
            let session = sessions.as_mut().ok_or_else(|| {
                WireCommandError::new(WireCommandErrorCode::Runtime, "重演会话已结束")
            })?;
            let update = session
                .runtime
                .finish_replay_boundary(update_id)
                .map_err(WireCommandError::from)?;
            session.ending = true;
            return Ok(wire_update(&state, update, WireSessionMode::Replay));
        }
        let update = state.transact_replay(|runtime| {
            runtime.presentation_complete(&state.content, update_id, outcome)
        })?;
        return Ok(wire_update(&state, update, WireSessionMode::Replay));
    }
    let update = state.transact_runtime(|runtime| {
        runtime.presentation_complete(&state.content, update_id, outcome)
    })?;
    Ok(wire_update(&state, update, WireSessionMode::Story))
}

#[tauri::command]
fn get_snapshot(state: State<'_, EngineState>) -> Result<WireRuntimeSnapshot, WireCommandError> {
    let _gate = state.session_gate()?;
    if let Some(replay) = state.replay()?.as_ref() {
        return Ok(wire_snapshot(
            &state,
            replay.runtime.snapshot().clone(),
            WireSessionMode::Replay,
        ));
    }
    Ok(wire_snapshot(
        &state,
        state.runtime()?.snapshot().clone(),
        WireSessionMode::Story,
    ))
}

#[tauri::command]
fn get_dialogue_history(
    state: State<'_, EngineState>,
) -> Result<Vec<WireDialogueHistoryEntry>, WireCommandError> {
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
    Ok(state
        .runtime()?
        .dialogue_history()
        .iter()
        .cloned()
        .map(Into::into)
        .collect())
}

#[tauri::command]
fn clear_dialogue_history(
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<(), WireCommandError> {
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    if let Some(replay) = state.replay()?.as_mut() {
        replay.runtime.clear_dialogue_history();
    } else {
        // History is profile data.  Apply the clear through the same cloned
        // runtime transaction as story commands so a failed profile write
        // cannot leave memory and disk disagreeing.
        let mut runtime = state.runtime()?;
        let mut candidate = runtime.clone();
        candidate.clear_dialogue_history();
        let candidate_profile = candidate.profile_state(&state.content);
        if candidate_profile != runtime.profile_state(&state.content) {
            state.profile.save(&candidate_profile).map_err(save_error)?;
        }
        *runtime = candidate;
    }
    Ok(())
}

#[tauri::command]
fn get_chapter_map(
    state: State<'_, EngineState>,
) -> Result<Option<ChapterMapSnapshot>, WireCommandError> {
    let _gate = state.session_gate()?;
    state
        .runtime()?
        .chapter_map(&state.content)
        .map_err(WireCommandError::from)
}

#[tauri::command]
fn start_scene_replay(
    scene_id: String,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    if state.replay()?.is_some() {
        return Err(WireCommandError::new(
            WireCommandErrorCode::Runtime,
            "已经存在正在进行的 Scene 重演",
        ));
    }
    if state.content.chapter_map.is_none() {
        return Err(WireCommandError::new(
            WireCommandErrorCode::Validation,
            "当前内容未配置章节地图",
        ));
    }
    let main = state.runtime()?;
    let map = main
        .chapter_map(&state.content)
        .map_err(WireCommandError::from)?;
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
    if !hotspot.completed {
        return Err(WireCommandError::new(
            WireCommandErrorCode::Validation,
            "该 Scene 尚未完成，不能重演",
        ));
    }
    let profile = main.profile_state(&state.content);
    let map_definition = state
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
        &state.content,
        profile,
        &definition_hotspot.variable_overrides,
    )
    .map_err(WireCommandError::from)?;
    let generation = state
        .replay_generation
        .fetch_add(1, Ordering::Relaxed)
        .checked_add(1)
        .ok_or_else(|| WireCommandError::new(WireCommandErrorCode::Internal, "重演会话编号耗尽"))?;
    let id_base = generation
        .checked_mul(REPLAY_ID_STRIDE)
        .ok_or_else(|| WireCommandError::new(WireCommandErrorCode::Internal, "重演会话编号耗尽"))?;
    replay_runtime.prepare_session_ids(id_base, id_base, id_base);
    let first = replay_runtime
        .start_scene_preview(&state.content, &scene_id)
        .map_err(WireCommandError::from)?;
    drop(main);
    *state.replay()? = Some(ReplaySession {
        runtime: replay_runtime,
        scene_id,
        ending: matches!(
            first.snapshot.prompt,
            vectspace_core::model::PromptSnapshot::End { .. }
        ),
    });
    state.bump_session_id()?;
    Ok(wire_update(&state, first, WireSessionMode::Replay))
}

#[tauri::command]
fn exit_scene_replay(
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireU64, WireCommandError> {
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    let had_replay = state.replay()?.is_some();
    *state.replay()? = None;
    if had_replay {
        state.bump_session_id()?;
    }
    Ok(state.current_session_id().into())
}

/// Invalidate outstanding story-side IPC and presentation callbacks when the
/// player leaves the story for the title screen.  The authoritative runtime
/// is intentionally kept intact so "开始" can still start a fresh game, but
/// the host generation makes late acknowledgements fail with
/// `stale_session` instead of mutating that hidden runtime.
#[tauri::command]
fn invalidate_session(
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireU64, WireCommandError> {
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    Ok(state.bump_session_id()?.into())
}

#[tauri::command]
fn resolve_assets(
    asset_ids: Vec<String>,
    state: State<'_, EngineState>,
) -> Result<Vec<ResolvedAsset>, WireCommandError> {
    state
        .content
        .resolve_assets(&asset_ids)
        .map_err(|error| WireCommandError::new(WireCommandErrorCode::Asset, error.to_string()))
}

#[tauri::command]
fn list_save_slots(state: State<'_, EngineState>) -> Vec<SaveSlotSummary> {
    state.saves.list()
}

#[tauri::command]
fn save_slot(
    request: SaveSlotRequest,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<SaveSlotSummary, WireCommandError> {
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
    state
        .saves
        .save(
            &request.slot,
            runtime.snapshot(),
            request.thumbnail_data_url,
        )
        .map_err(save_error)
}

#[tauri::command]
fn load_slot(
    slot: String,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    if state.replay()?.is_some() {
        return Err(WireCommandError::new(
            WireCommandErrorCode::Runtime,
            "重演期间不能读档",
        ));
    }
    let snapshot = state.saves.load(&slot).map_err(save_error)?;
    let update =
        state.transact_runtime(|runtime| runtime.load_snapshot(&state.content, snapshot))?;
    state.bump_session_id()?;
    Ok(wire_update(&state, update, WireSessionMode::Story))
}

#[tauri::command]
fn load_settings(state: State<'_, EngineState>) -> Settings {
    state.saves.load_settings()
}

#[tauri::command]
fn save_settings(
    settings: Settings,
    state: State<'_, EngineState>,
) -> Result<Settings, WireCommandError> {
    state.saves.save_settings(settings).map_err(save_error)
}

fn save_error(error: SaveError) -> WireCommandError {
    match error {
        SaveError::InvalidSlot(message)
        | SaveError::MissingSlot(message)
        | SaveError::InvalidData(message) => {
            WireCommandError::new(WireCommandErrorCode::Validation, message)
        }
        SaveError::ContentVersion { expected, actual } => WireCommandError::new(
            WireCommandErrorCode::Validation,
            format!("存档内容版本不兼容: 需要 {expected}，实际 {actual}"),
        ),
        SaveError::Io { path, source } => {
            WireCommandError::new(WireCommandErrorCode::Io, source.to_string())
                .with_path(path.to_string_lossy())
        }
    }
}

#[cfg(windows)]
fn disable_browser_features<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> tauri::Result<()> {
    use windows::core::Interface;

    window.with_webview(|webview| unsafe {
        let controller = webview.controller();
        let core = controller
            .CoreWebView2()
            .expect("WebView2 CoreWebView2 interface is unavailable");
        let settings = core.Settings().expect("WebView2 settings are unavailable");
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(windows)]
            {
                let window = app
                    .get_webview_window("main")
                    .expect("main WebView window is missing");
                disable_browser_features(&window)?;
            }
            let content_root = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../game")
            } else {
                app.path().resolve("game", BaseDirectory::Resource)?
            };
            let content = ContentCatalog::from_root(content_root)?;
            app.asset_protocol_scope()
                .allow_directory(content.assets_root(), true)?;
            let app_data_root = app.path().app_data_dir()?;
            let saves = SaveManager::new(
                app_data_root.join("saves"),
                content.manifest.content_version.clone(),
            )?;
            let valid_scenes = content.scenes.keys().cloned().collect();
            let valid_locations = content
                .scenes
                .iter()
                .flat_map(|(scene_id, scene)| {
                    scene.nodes.iter().flat_map(move |(node_id, node)| {
                        let node_location = format!("{scene_id}/{node_id}");
                        let mut locations = vec![node_location.clone()];
                        if let SceneNode::LongText {
                            document, steps, ..
                        } = node
                        {
                            let document_id = document.as_deref().unwrap_or(node_id);
                            locations.extend(
                                steps
                                    .iter()
                                    .map(|step| format!("{scene_id}/{document_id}/{}", step.id)),
                            );
                        }
                        locations
                    })
                })
                .collect();
            let (profile, profile_state) = ProfileManager::new_with_content(
                app_data_root,
                &content.manifest.variables,
                content.manifest.content_version.clone(),
                Some(valid_scenes),
                Some(valid_locations),
            )?;
            let runtime = RuntimeEngine::with_profile(&content, profile_state)?;
            app.manage(EngineState {
                content,
                runtime: Mutex::new(runtime),
                replay: Mutex::new(None),
                session_gate: Mutex::new(()),
                replay_generation: AtomicU64::new(0),
                session_id: AtomicU64::new(1),
                saves,
                profile,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            start_new_game,
            advance,
            choose,
            click_button,
            presentation_complete,
            get_snapshot,
            get_dialogue_history,
            clear_dialogue_history,
            get_chapter_map,
            start_scene_replay,
            exit_scene_replay,
            invalidate_session,
            resolve_assets,
            list_save_slots,
            save_slot,
            load_slot,
            load_settings,
            save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("VECTSPACE failed to start");
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use tempfile::tempdir;

    use super::*;
    use vectspace_core::model::{
        AdvanceSource, MutationValue, ScalarValue, SceneNode, VariableOperation,
    };

    #[test]
    fn failed_profile_persistence_rolls_back_the_entire_runtime_command() {
        let mut content =
            ContentCatalog::from_root(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../game"))
                .unwrap();
        let scene = content.scenes.get_mut("prologue").unwrap();
        let original_entry = scene.entry.clone();
        scene.entry = "set_profile_transaction".to_owned();
        scene.nodes.insert(
            scene.entry.clone(),
            SceneNode::Set {
                variable: "ending_seen".to_owned(),
                op: VariableOperation::Assign,
                value: Some(MutationValue::Literal(ScalarValue::Boolean(true))),
                next: original_entry,
            },
        );

        let directory = tempdir().unwrap();
        let saves = SaveManager::new(
            directory.path().join("saves"),
            content.manifest.content_version.clone(),
        )
        .unwrap();
        let (profile, profile_state) = ProfileManager::new(
            directory.path().to_path_buf(),
            &content.manifest.variables,
            content.manifest.content_version.clone(),
        )
        .unwrap();
        let runtime = RuntimeEngine::with_profile(&content, profile_state).unwrap();
        let state = EngineState {
            content,
            runtime: Mutex::new(runtime),
            replay: Mutex::new(None),
            session_gate: Mutex::new(()),
            replay_generation: AtomicU64::new(0),
            session_id: AtomicU64::new(1),
            saves,
            profile,
        };
        let before = state.runtime().unwrap().snapshot().clone();
        assert!(state.check_session(Some(&WireU64::from(1))).is_ok());
        assert!(matches!(
            state.check_session(None).unwrap_err().code,
            WireCommandErrorCode::StaleSession
        ));
        state.bump_session_id().unwrap();
        assert!(matches!(
            state
                .check_session(Some(&WireU64::from(1)))
                .unwrap_err()
                .code,
            WireCommandErrorCode::StaleSession
        ));
        assert!(state.check_session(Some(&WireU64::from(2))).is_ok());
        fs::remove_dir_all(directory.path()).unwrap();

        let result = state.transact_runtime(|runtime| runtime.start_new_game(&state.content));
        assert!(result.is_err());
        let runtime = state.runtime().unwrap();
        assert_eq!(runtime.snapshot(), &before);
        assert_eq!(
            runtime
                .profile_state(&state.content)
                .variables
                .get("ending_seen"),
            Some(&ScalarValue::Boolean(false))
        );
    }

    #[test]
    fn failed_variable_operation_rolls_back_the_entire_runtime_command() {
        let mut content =
            ContentCatalog::from_root(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../game"))
                .unwrap();
        let scene = content.scenes.get_mut("prologue").unwrap();
        let original_entry = scene.entry.clone();
        scene.entry = "prepare_overflow".to_owned();
        scene.nodes.insert(
            "prepare_overflow".to_owned(),
            SceneNode::Set {
                variable: "score".to_owned(),
                op: VariableOperation::Assign,
                value: Some(MutationValue::Literal(ScalarValue::Integer(i64::MAX))),
                next: "overflow".to_owned(),
            },
        );
        scene.nodes.insert(
            "overflow".to_owned(),
            SceneNode::Set {
                variable: "score".to_owned(),
                op: VariableOperation::Add,
                value: Some(MutationValue::Literal(ScalarValue::Integer(1))),
                next: original_entry,
            },
        );

        let directory = tempdir().unwrap();
        let saves = SaveManager::new(
            directory.path().join("saves"),
            content.manifest.content_version.clone(),
        )
        .unwrap();
        let (profile, profile_state) = ProfileManager::new(
            directory.path().to_path_buf(),
            &content.manifest.variables,
            content.manifest.content_version.clone(),
        )
        .unwrap();
        let runtime = RuntimeEngine::with_profile(&content, profile_state).unwrap();
        let state = EngineState {
            content,
            runtime: Mutex::new(runtime),
            replay: Mutex::new(None),
            session_gate: Mutex::new(()),
            replay_generation: AtomicU64::new(0),
            session_id: AtomicU64::new(1),
            saves,
            profile,
        };
        let before = state.runtime().unwrap().snapshot().clone();
        let result = state.transact_runtime(|runtime| runtime.start_new_game(&state.content));
        assert!(result.unwrap_err().message.contains("溢出"));
        assert_eq!(state.runtime().unwrap().snapshot(), &before);
    }

    #[test]
    fn failed_read_history_persistence_rolls_back_location_revision_and_read_set() {
        let content =
            ContentCatalog::from_root(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../game"))
                .unwrap();
        let directory = tempdir().unwrap();
        let saves = SaveManager::new(
            directory.path().join("saves"),
            content.manifest.content_version.clone(),
        )
        .unwrap();
        let (profile, profile_state) = ProfileManager::new(
            directory.path().to_path_buf(),
            &content.manifest.variables,
            content.manifest.content_version.clone(),
        )
        .unwrap();
        let runtime = RuntimeEngine::with_profile(&content, profile_state).unwrap();
        let state = EngineState {
            content,
            runtime: Mutex::new(runtime),
            replay: Mutex::new(None),
            session_gate: Mutex::new(()),
            replay_generation: AtomicU64::new(0),
            session_id: AtomicU64::new(1),
            saves,
            profile,
        };
        let first = state
            .transact_runtime(|runtime| runtime.start_new_game(&state.content))
            .unwrap();
        let dialogue = state
            .transact_runtime(|runtime| {
                runtime.presentation_complete(
                    &state.content,
                    first.update_id,
                    PresentationOutcome::Completed,
                )
            })
            .unwrap();
        assert!(matches!(
            dialogue.snapshot.prompt,
            vectspace_core::model::PromptSnapshot::Dialogue { .. }
        ));
        let before_snapshot = state.runtime().unwrap().snapshot().clone();
        let before_profile = state.runtime().unwrap().profile_state(&state.content);
        fs::remove_dir_all(directory.path()).unwrap();

        let result = state.transact_runtime(|runtime| {
            runtime.advance(
                &state.content,
                dialogue.snapshot.revision,
                AdvanceSource::ForcedAuto,
            )
        });
        assert!(result.is_err());
        let runtime = state.runtime().unwrap();
        assert_eq!(runtime.snapshot(), &before_snapshot);
        assert_eq!(runtime.profile_state(&state.content), before_profile);
    }

    #[test]
    fn sandbox_scene_loads_and_supports_scene_entry_preview() {
        let content =
            ContentCatalog::from_root(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../game"))
                .unwrap();
        assert!(content.scenes.contains_key("sandbox"));
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let first = runtime.start_scene_preview(&content, "sandbox").unwrap();
        assert!(matches!(
            first.snapshot.prompt,
            vectspace_core::model::PromptSnapshot::Dialogue { .. }
        ));
        let lecture = runtime
            .advance(&content, first.snapshot.revision, AdvanceSource::Manual)
            .unwrap();
        assert!(matches!(
            lecture.snapshot.prompt,
            vectspace_core::model::PromptSnapshot::LongText { .. }
        ));
        assert_eq!(
            lecture
                .snapshot
                .long_text_page
                .as_ref()
                .unwrap()
                .document_id,
            "sandbox/sandbox_proof"
        );
        let observation = runtime
            .advance(&content, lecture.snapshot.revision, AdvanceSource::Manual)
            .unwrap();
        let interlude = runtime
            .advance(
                &content,
                observation.snapshot.revision,
                AdvanceSource::Manual,
            )
            .unwrap();
        let timeline = runtime
            .advance(&content, interlude.snapshot.revision, AdvanceSource::Manual)
            .unwrap();
        assert!(timeline.requires_ack);
        let continuation = runtime
            .presentation_complete(
                &content,
                timeline.update_id,
                vectspace_core::model::PresentationOutcome::Completed,
            )
            .unwrap();
        assert!(matches!(
            continuation.snapshot.prompt,
            vectspace_core::model::PromptSnapshot::LongText { .. }
        ));
    }
}
