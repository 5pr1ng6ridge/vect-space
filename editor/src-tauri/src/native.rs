//! Native file pickers and the "reveal in file manager" action.

use std::path::PathBuf;
use tauri::State;
use vectspace_protocol::WireCommandError;

use crate::error::{internal_command_error, io_command_error, validation_command_error};
use crate::state::{require_project, EditorState};

// Windows' common file dialog loads the user's Explorer shell extensions into
// the host process. Some real-world extension sets exhaust Rust's default
// worker-thread stack and terminate the entire editor with STATUS_STACK_OVERFLOW.
// Keep the picker isolated on a deliberately large stack and never run it on
// Tauri's IPC worker or WebView event-loop thread.
const NATIVE_PICKER_STACK_BYTES: usize = 32 * 1024 * 1024;

async fn run_native_picker<T, F>(name: &str, picker: F) -> Result<T, WireCommandError>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let thread = std::thread::Builder::new()
        .name(name.to_owned())
        .stack_size(NATIVE_PICKER_STACK_BYTES)
        .spawn(picker)
        .map_err(io_command_error)?;
    let joined = tauri::async_runtime::spawn_blocking(move || thread.join())
        .await
        .map_err(|error| internal_command_error(format!("等待文件选择器失败: {error}")))?;
    joined.map_err(|_| internal_command_error("文件选择器线程意外终止"))
}

#[tauri::command]
pub(crate) async fn pick_project_directory() -> Result<Option<String>, WireCommandError> {
    run_native_picker("vectspace-project-picker", || {
        rfd::FileDialog::new()
            .set_title("选择 VECTSPACE 项目或 game 目录")
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
pub(crate) async fn pick_asset_files() -> Result<Vec<String>, WireCommandError> {
    run_native_picker("vectspace-asset-picker", || {
        rfd::FileDialog::new()
            .set_title("选择一个或多个素材文件")
            .add_filter(
                "VECTSPACE 素材",
                &[
                    "png", "jpg", "jpeg", "webp", "wav", "ogg", "mp3", "flac", "mp4", "ttf", "otf",
                ],
            )
            .pick_files()
            .unwrap_or_default()
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect()
    })
    .await
}

/// Reveal a host-validated registered asset (animation: its first frame).
/// Never accept an arbitrary WebView path or launch a shell interpreter.
#[tauri::command]
pub(crate) fn reveal_asset(
    id: String,
    state: State<'_, EditorState>,
) -> Result<(), WireCommandError> {
    let path = {
        let guard = state.lock_session()?;
        let session = require_project(&guard)?;
        let resolved = session
            .catalog
            .resolve_assets(&[id])
            .map_err(validation_command_error)?;
        PathBuf::from(&resolved[0].absolute_path)
    };
    if !path.is_file() {
        return Err(validation_command_error("素材文件尚未保存到磁盘或已被移走"));
    }
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer.exe");
        command.arg(format!("/select,{}", path.display()));
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg("-R").arg(&path);
        command
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(
            path.parent()
                .ok_or_else(|| validation_command_error("素材没有所在目录"))?,
        );
        command
    };
    command.spawn().map_err(io_command_error)?;
    Ok(())
}
