//! Host side of the VECTSPACE Story Editor: Tauri commands for opening,
//! validating and saving a content project, importing assets, and running the
//! editor previews.

mod assets;
mod diagnostics;
mod documents;
mod error;
mod files;
mod fingerprint;
mod layout;
mod model;
mod native;
mod preview;
mod project;
mod scalars;
mod state;
mod transaction;

#[cfg(test)]
mod test_support;

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
                use tauri::Manager;

                let window = app
                    .get_webview_window("main")
                    .expect("main WebView window is missing");
                disable_browser_features(&window)?;
            }
            Ok(())
        })
        .manage(state::EditorState::default())
        .invoke_handler(tauri::generate_handler![
            native::pick_project_directory,
            native::pick_asset_files,
            native::reveal_asset,
            project::open_project,
            project::save_project,
            project::validate_project,
            assets::inspect::inspect_asset_imports,
            assets::stage::stage_asset_imports,
            preview::build_node_preview,
            preview::session::preview_session_start,
            preview::session::preview_session_advance,
            preview::session::preview_session_choose,
            preview::session::proof::preview_proof_board,
            preview::session::proof::preview_proof_check,
            preview::session::proof::preview_proof_save_draft,
            preview::session::proof::preview_proof_submit,
            preview::session::proof::preview_proof_abandon,
            preview::session::preview_session_click_button,
            preview::session::preview_session_presentation_complete,
            preview::session::preview_session_tick,
            preview::session::preview_session_stop,
        ])
        .run(tauri::generate_context!())
        .expect("VECTSPACE Story Editor failed to start");
}
