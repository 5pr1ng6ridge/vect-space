//! The VECTSPACE game host: owns the story runtime and the two game windows and
//! serves the frontends through the Tauri commands in [`commands`].

mod commands;
mod proof;
mod native_plan;
mod native_window;
mod pair;
mod replay;
mod save;
mod secondary;
mod state;
mod sync;
mod timers;
mod transaction;
mod window_fx;

#[cfg(test)]
mod tests;

use std::{
    collections::BTreeSet,
    error::Error,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::Instant,
};

use native_window::{role_for_label, TauriWindowOps, MAIN_WINDOW_LABEL, SECONDARY_WINDOW_LABEL};
use save::{ProfileManager, SaveManager};
use state::EngineState;
use tauri::{path::BaseDirectory, Manager};
use vectspace_core::{content::ContentCatalog, model::SceneNode, runtime::RuntimeEngine};

/// Every `scene/node` location a profile may record as read or seen, including
/// the per-step locations of long-text documents.
fn story_locations(content: &ContentCatalog) -> BTreeSet<String> {
    content
        .scenes
        .iter()
        .flat_map(|(scene_id, scene)| {
            scene.nodes.iter().flat_map(move |(node_id, node)| {
                let mut locations = vec![format!("{scene_id}/{node_id}")];
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
        .collect()
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn Error>> {
    #[cfg(windows)]
    {
        let window = app
            .get_webview_window(MAIN_WINDOW_LABEL)
            .expect("main WebView window is missing");
        native_window::disable_browser_features(&window)?;
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
    let (profile, profile_state) = ProfileManager::new_with_content(
        app_data_root,
        &content.manifest.variables,
        content.manifest.content_version.clone(),
        Some(valid_scenes),
        Some(story_locations(&content)),
    )?;
    let runtime = RuntimeEngine::with_profile(&content, profile_state)?;
    let mut engine = EngineState::new(
        content,
        runtime,
        Arc::new(TauriWindowOps {
            app: app.handle().clone(),
            closing_secondary: AtomicBool::new(false),
            pending_destroy_since: Mutex::new(None),
            clock: Instant::now,
        }),
        saves,
        profile,
    );
    let lean_dir = if cfg!(debug_assertions) {
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../lean"))
    } else {
        app.path().resolve("lean", BaseDirectory::Resource).ok().filter(|path| path.is_dir())
    };
    let lean = lean_dir.and_then(|path| vectspace_proof::check::LeanConfig::discover(&path).ok());
    engine.proof_checker = Arc::new(Mutex::new(vectspace_proof::check::ProofChecker::new(lean)));
    app.manage(engine);
    // Story timers run on a host thread with a monotonic clock; the WebViews
    // never own an authoritative timer.
    let wake = timers::spawn_timer_scheduler(app.handle().clone());
    if let Ok(mut slot) = app.state::<EngineState>().timer_wake.lock() {
        *slot = Some(wake);
    }
    // Window animations tick on their own host thread, independent of the story
    // timers and of the story's pause state.
    let fx_wake = window_fx::spawn_fx_scheduler(app.handle().clone());
    app.state::<EngineState>().fx.set_wake(fx_wake);
    Ok(())
}

/// The secondary window may only be destroyed by a host transition: a
/// user/native close request is always prevented, so it cannot be closed out
/// from under the story that owns it.
fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    // A destroyed window takes its animation and layer with it.  Only the short
    // state lock is taken: this runs on the event loop, which a thread waiting on
    // a native call must never end up blocking.
    if let tauri::WindowEvent::Destroyed = event {
        if let (Some(role), Some(state)) = (
            role_for_label(window.label()),
            window.app_handle().try_state::<EngineState>(),
        ) {
            state.fx.forget_window(role);
        }
    }
    if window.label() != SECONDARY_WINDOW_LABEL {
        // Closing the main window must not leave the prevented secondary behind.
        // The same host destruction path is used so the close guard can tell it
        // apart from a user close request.
        if window.label() == MAIN_WINDOW_LABEL {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.app_handle().try_state::<EngineState>() {
                    let _ = state.windows.hide_secondary();
                }
            }
        }
        return;
    }
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let controlled = window
            .app_handle()
            .try_state::<EngineState>()
            .is_some_and(|state| state.windows.is_closing_secondary());
        if !controlled {
            api.prevent_close();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(setup)
        .on_window_event(on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::secondary_bootstrap,
            commands::start_new_game,
            commands::advance,
            commands::choose,
            proof::proof_board,
            proof::proof_check,
            proof::proof_save_draft,
            proof::proof_submit,
            proof::proof_abandon,
            commands::click_button,
            commands::presentation_complete,
            commands::secondary_advance,
            commands::secondary_choose,
            commands::secondary_click_button,
            commands::secondary_presentation_complete,
            commands::sync_updates,
            commands::secondary_sync_updates,
            commands::set_story_pause,
            commands::secondary_set_story_pause,
            commands::get_dialogue_history,
            commands::get_chapter_map,
            commands::start_scene_replay,
            commands::exit_scene_replay,
            commands::invalidate_session,
            commands::resolve_assets,
            commands::list_save_slots,
            commands::save_slot,
            commands::load_slot,
            commands::load_settings,
            commands::save_settings,
        ])
        .build(tauri::generate_context!())
        .expect("VECTSPACE failed to build")
        .run(|app, event| {
            // Application shutdown must never leave a prevented secondary
            // window orphaned behind an exiting main window.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<EngineState>() {
                    let _ = state.windows.hide_secondary();
                }
            }
        });
}
