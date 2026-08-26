mod content;
mod model;
mod runtime;
mod save;
mod text_template;

use std::sync::{Mutex, MutexGuard};

use content::ContentCatalog;
use model::{
    AdvanceSource, BootstrapPayload, ResolvedAsset, RuntimeSnapshot, RuntimeUpdate,
    SaveSlotRequest, SaveSlotSummary, Settings,
};
use runtime::RuntimeEngine;
use save::{ProfileManager, SaveManager};
use tauri::{Manager, State};

struct EngineState {
    content: ContentCatalog,
    runtime: Mutex<RuntimeEngine>,
    saves: SaveManager,
    profile: ProfileManager,
}

impl EngineState {
    fn runtime(&self) -> Result<MutexGuard<'_, RuntimeEngine>, String> {
        self.runtime
            .lock()
            .map_err(|_| "运行时互斥锁已损坏".to_owned())
    }

    fn transact_runtime(
        &self,
        operation: impl FnOnce(&mut RuntimeEngine) -> Result<RuntimeUpdate, runtime::RuntimeError>,
    ) -> Result<RuntimeUpdate, String> {
        let mut runtime = self.runtime()?;
        let mut candidate = runtime.clone();
        let update = operation(&mut candidate).map_err(|error| error.to_string())?;
        let candidate_profile = candidate.profile_state(&self.content);
        if candidate_profile != runtime.profile_state(&self.content) {
            self.profile
                .save(&candidate_profile)
                .map_err(|error| error.to_string())?;
        }
        *runtime = candidate;
        Ok(update)
    }
}

#[tauri::command]
fn bootstrap(state: State<'_, EngineState>) -> Result<BootstrapPayload, String> {
    Ok(state.runtime()?.bootstrap(&state.content))
}

#[tauri::command]
fn start_new_game(state: State<'_, EngineState>) -> Result<RuntimeUpdate, String> {
    state.transact_runtime(|runtime| runtime.start_new_game(&state.content))
}

#[tauri::command]
fn advance(
    expected_revision: u64,
    source: AdvanceSource,
    state: State<'_, EngineState>,
) -> Result<RuntimeUpdate, String> {
    state.transact_runtime(|runtime| runtime.advance(&state.content, expected_revision, source))
}

#[tauri::command]
fn choose(
    choice_id: String,
    expected_revision: u64,
    state: State<'_, EngineState>,
) -> Result<RuntimeUpdate, String> {
    state.transact_runtime(|runtime| runtime.choose(&state.content, &choice_id, expected_revision))
}

#[tauri::command]
fn presentation_complete(
    update_id: u64,
    state: State<'_, EngineState>,
) -> Result<RuntimeUpdate, String> {
    state.transact_runtime(|runtime| runtime.presentation_complete(&state.content, update_id))
}

#[tauri::command]
fn get_snapshot(state: State<'_, EngineState>) -> Result<RuntimeSnapshot, String> {
    Ok(state.runtime()?.snapshot().clone())
}

#[tauri::command]
fn resolve_assets(
    asset_ids: Vec<String>,
    state: State<'_, EngineState>,
) -> Result<Vec<ResolvedAsset>, String> {
    state
        .content
        .resolve_assets(&asset_ids)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_save_slots(state: State<'_, EngineState>) -> Vec<SaveSlotSummary> {
    state.saves.list()
}

#[tauri::command]
fn save_slot(
    request: SaveSlotRequest,
    state: State<'_, EngineState>,
) -> Result<SaveSlotSummary, String> {
    let runtime = state.runtime()?;
    if let Some(update_id) = runtime.pending_runtime_update() {
        return Err(format!("表现层仍在执行 update {update_id}，暂时不能存档"));
    }
    state
        .saves
        .save(
            &request.slot,
            runtime.snapshot(),
            request.thumbnail_data_url,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn load_slot(slot: String, state: State<'_, EngineState>) -> Result<RuntimeUpdate, String> {
    let snapshot = state.saves.load(&slot).map_err(|error| error.to_string())?;
    state.transact_runtime(|runtime| runtime.load_snapshot(&state.content, snapshot))
}

#[tauri::command]
fn load_settings(state: State<'_, EngineState>) -> Settings {
    state.saves.load_settings()
}

#[tauri::command]
fn save_settings(settings: Settings, state: State<'_, EngineState>) -> Result<Settings, String> {
    state
        .saves
        .save_settings(settings)
        .map_err(|error| error.to_string())
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
            let content = ContentCatalog::load_for_app(app)?;
            content.write_development_schemas()?;
            app.asset_protocol_scope()
                .allow_directory(content.assets_root(), true)?;
            let app_data_root = app.path().app_data_dir()?;
            let saves = SaveManager::new(
                app_data_root.join("saves"),
                content.manifest.content_version.clone(),
            )?;
            let (profile, profile_state) = ProfileManager::new(
                app_data_root,
                &content.manifest.variables,
                content.manifest.content_version.clone(),
            )?;
            let runtime = RuntimeEngine::with_profile(&content, profile_state)?;
            app.manage(EngineState {
                content,
                runtime: Mutex::new(runtime),
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
            presentation_complete,
            get_snapshot,
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
    use crate::model::{AdvanceSource, MutationValue, ScalarValue, SceneNode, VariableOperation};

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
            saves,
            profile,
        };
        let before = state.runtime().unwrap().snapshot().clone();
        fs::remove_dir_all(directory.path()).unwrap();

        let result = state.transact_runtime(|runtime| runtime.start_new_game(&state.content));
        assert!(result.is_err());
        let runtime = state.runtime().unwrap();
        assert_eq!(runtime.snapshot(), &before);
        assert_eq!(
            runtime.profile_variables().get("ending_seen"),
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
            saves,
            profile,
        };
        let before = state.runtime().unwrap().snapshot().clone();
        let result = state.transact_runtime(|runtime| runtime.start_new_game(&state.content));
        assert!(result.unwrap_err().contains("溢出"));
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
            saves,
            profile,
        };
        let first = state
            .transact_runtime(|runtime| runtime.start_new_game(&state.content))
            .unwrap();
        let dialogue = state
            .transact_runtime(|runtime| {
                runtime.presentation_complete(&state.content, first.update_id)
            })
            .unwrap();
        assert!(matches!(
            dialogue.snapshot.prompt,
            crate::model::PromptSnapshot::Dialogue { .. }
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
}
