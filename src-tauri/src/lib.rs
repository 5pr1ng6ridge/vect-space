mod content;
mod model;
mod runtime;
mod save;

use std::sync::{Mutex, MutexGuard};

use content::ContentCatalog;
use model::{
    BootstrapPayload, ResolvedAsset, RuntimeSnapshot, RuntimeUpdate, SaveSlotRequest,
    SaveSlotSummary, Settings,
};
use runtime::RuntimeEngine;
use save::SaveManager;
use tauri::{Manager, State};

struct EngineState {
    content: ContentCatalog,
    runtime: Mutex<RuntimeEngine>,
    saves: SaveManager,
}

impl EngineState {
    fn runtime(&self) -> Result<MutexGuard<'_, RuntimeEngine>, String> {
        self.runtime
            .lock()
            .map_err(|_| "运行时互斥锁已损坏".to_owned())
    }
}

#[tauri::command]
fn bootstrap(state: State<'_, EngineState>) -> Result<BootstrapPayload, String> {
    Ok(state.runtime()?.bootstrap(&state.content))
}

#[tauri::command]
fn start_new_game(state: State<'_, EngineState>) -> Result<RuntimeUpdate, String> {
    state
        .runtime()?
        .start_new_game(&state.content)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn advance(expected_revision: u64, state: State<'_, EngineState>) -> Result<RuntimeUpdate, String> {
    state
        .runtime()?
        .advance(&state.content, expected_revision)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn choose(
    choice_id: String,
    expected_revision: u64,
    state: State<'_, EngineState>,
) -> Result<RuntimeUpdate, String> {
    state
        .runtime()?
        .choose(&state.content, &choice_id, expected_revision)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn presentation_complete(
    update_id: u64,
    state: State<'_, EngineState>,
) -> Result<RuntimeUpdate, String> {
    state
        .runtime()?
        .presentation_complete(&state.content, update_id)
        .map_err(|error| error.to_string())
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
    state
        .runtime()?
        .load_snapshot(&state.content, snapshot)
        .map_err(|error| error.to_string())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let content = ContentCatalog::load_for_app(app)?;
            content.write_development_schemas()?;
            app.asset_protocol_scope()
                .allow_directory(content.assets_root(), true)?;
            let save_root = app.path().app_data_dir()?.join("saves");
            let saves = SaveManager::new(save_root, content.manifest.content_version.clone())?;
            let runtime = RuntimeEngine::new(&content)?;
            app.manage(EngineState {
                content,
                runtime: Mutex::new(runtime),
                saves,
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
