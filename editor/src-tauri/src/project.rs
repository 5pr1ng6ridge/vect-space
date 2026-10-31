//! Project lifecycle commands: open, validate and save.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};
use vectspace_core::content::ContentCatalog;
use vectspace_protocol::{WireCommandError, WireCommandErrorCode};

use crate::assets::registry::{
    clear_staged_imports, ensure_import_targets_available, request_staged_imports,
    staged_asset_overrides,
};
use crate::assets::{staging_dir, StagedImport};
use crate::diagnostics::analyze_catalog;
use crate::documents::{
    document_models, document_models_from_request, draft_catalog, managed_deletions,
    project_payload, project_payload_from_request, retain_changed_model_writes, serialize_project,
};
use crate::error::{
    asset_command_error, internal_command_error, io_command_error, validation_command_error,
};
use crate::files::{hash_bytes, path_exists_case_insensitive};
use crate::fingerprint::{
    project_fingerprint, project_fingerprint_cached, project_fingerprint_with_hashes,
};
use crate::layout::read_layout;
use crate::model::{EditorDiagnostic, EditorProject, SaveProjectRequest, SaveProjectResult};
use crate::state::{require_project, require_project_mut, EditorState, ProjectSession};
use crate::transaction::{atomic_write_batch, cleanup_warning, recover_pending_transactions};

#[tauri::command]
pub(crate) fn open_project(
    root: String,
    app: AppHandle,
    state: State<'_, EditorState>,
) -> Result<EditorProject, WireCommandError> {
    let root = resolve_content_root(Path::new(&root)).map_err(io_command_error)?;
    recover_pending_transactions(&root).map_err(io_command_error)?;
    let catalog = ContentCatalog::from_root(root.clone()).map_err(validation_command_error)?;
    app.asset_protocol_scope()
        .allow_directory(catalog.assets_root(), true)
        .map_err(asset_command_error)?;
    // Only discard staged imports after the new project has loaded and its
    // asset scope has been accepted.  If the user picked an invalid project,
    // their current in-memory import session must remain recoverable.
    clear_staged_imports(&state, &root).map_err(io_command_error)?;

    let fingerprint = project_fingerprint(&root, &catalog.manifest).map_err(io_command_error)?;
    let layout = read_layout(&root).map_err(io_command_error)?;
    let document_models =
        document_models(&root, &catalog.manifest, &layout).map_err(io_command_error)?;
    let project = project_payload(&root, &catalog, layout, fingerprint.clone())
        .map_err(validation_command_error)?;
    *state.lock_session()? = Some(ProjectSession {
        root,
        catalog,
        fingerprint,
        document_models,
    });
    Ok(project)
}

fn resolve_content_root(selected: &Path) -> Result<PathBuf, std::io::Error> {
    let selected = fs::canonicalize(selected)?;
    if selected.join("manifest.yaml").is_file() {
        Ok(selected)
    } else if selected.join("game/manifest.yaml").is_file() {
        fs::canonicalize(selected.join("game"))
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "所选目录及其 game/ 子目录中都没有 manifest.yaml",
        ))
    }
}

#[tauri::command]
pub(crate) async fn validate_project(
    request: SaveProjectRequest,
    app: AppHandle,
) -> Result<Vec<EditorDiagnostic>, WireCommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_project_command(request, app.state::<EditorState>())
    })
    .await
    .map_err(|error| internal_command_error(format!("验证任务失败: {error}")))?
}

fn validate_project_command(
    request: SaveProjectRequest,
    state: State<'_, EditorState>,
) -> Result<Vec<EditorDiagnostic>, WireCommandError> {
    let guard = state.lock_session()?;
    let session = require_project(&guard)?;
    let staged = request_staged_imports(&state, session, &request)?;
    let candidate = draft_catalog(&session.root, &request, &staged_asset_overrides(&staged))
        .map_err(validation_command_error)?;
    Ok(analyze_catalog(&candidate))
}

#[tauri::command]
pub(crate) async fn save_project(
    request: SaveProjectRequest,
    app: AppHandle,
) -> Result<SaveProjectResult, WireCommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        save_project_command(request, app.state::<EditorState>())
    })
    .await
    .map_err(|error| internal_command_error(format!("保存任务失败: {error}")))?
}

/// Staged binaries a save copies into `assets/`.
struct AssetWrites {
    /// `(target, staged source)` pairs for the transaction journal.
    sources: Vec<(PathBuf, PathBuf)>,
    /// Inspected digest of every source, checked again while copying.
    hashes: BTreeMap<PathBuf, String>,
    /// Formal path each staged asset id will have once the save commits.
    published_paths: BTreeMap<String, PathBuf>,
}

/// Staged binaries participate in the same journal as the manifest and scene
/// documents.  They stay source paths until the transaction stages them, which
/// avoids loading a batch of videos/audio into the editor process memory just
/// to write them back out.
fn plan_asset_writes(root: &Path, staged: &[StagedImport]) -> Result<AssetWrites, std::io::Error> {
    let staging_root = staging_dir(root);
    let mut targets = BTreeSet::new();
    let mut plan = AssetWrites {
        sources: Vec::new(),
        hashes: BTreeMap::new(),
        published_paths: BTreeMap::new(),
    };
    for item in staged {
        let target = root.join("assets").join(&item.relative_path);
        plan.published_paths
            .entry(item.id.clone())
            .or_insert_with(|| target.clone());
        let target_exists =
            path_exists_case_insensitive(&root.join("assets"), &item.relative_path)?;
        // Usually only the owning token writes a new binary.  If that token was
        // removed from the manifest before save, a remaining registration can
        // still refer to its staged bytes; promote that reference to the one
        // write for this target.  Formal reuse is never copied because its
        // source already lives in assets/.
        let needs_copy = item.owns_staged_path
            || (item.staged_path.starts_with(&staging_root) && !target_exists);
        if needs_copy && targets.insert(target.clone()) {
            plan.hashes.insert(target.clone(), item.sha256.clone());
            plan.sources.push((target, item.staged_path.clone()));
        }
    }
    Ok(plan)
}

fn project_relative_paths<'a>(
    root: &'a Path,
    paths: impl Iterator<Item = &'a PathBuf> + 'a,
) -> impl Iterator<Item = String> + 'a {
    paths
        .filter_map(move |path| path.strip_prefix(root).ok())
        .map(|path| path.to_string_lossy().replace('\\', "/"))
}

fn save_project_command(
    request: SaveProjectRequest,
    state: State<'_, EditorState>,
) -> Result<SaveProjectResult, WireCommandError> {
    let mut guard = state.lock_session()?;
    let session = require_project_mut(&mut guard)?;

    // A save fingerprints the same tree twice: once here to reject a stale
    // session, then again after serialization to substitute the bytes that are
    // about to be published.  Sharing one save-local cache across both passes
    // reuses the pre-save disk hashes for every unchanged file instead of
    // reading large assets from disk twice.
    //
    // The first pass is the snapshot this save commits to.  Because unchanged
    // files are reused from the cache, an external edit/delete that lands after
    // this check is not folded into the fingerprint published here; the next
    // save's fresh staleness pass detects it and fails closed instead of
    // overwriting the external change.
    let mut hash_cache = BTreeMap::new();
    let actual_fingerprint =
        project_fingerprint_cached(&session.root, &session.catalog.manifest, &mut hash_cache)
            .map_err(io_command_error)?;
    if request.expected_fingerprint != session.fingerprint
        || actual_fingerprint != session.fingerprint
    {
        return Err(WireCommandError::new(
            WireCommandErrorCode::StaleProject,
            "项目文件已被其他程序修改。请重新打开项目后再保存，以免覆盖外部更改。",
        ));
    }

    let staged = request_staged_imports(&state, session, &request)?;
    ensure_import_targets_available(&session.root, &staged).map_err(io_command_error)?;
    let asset_overrides = staged_asset_overrides(&staged);

    let mut result = (|| -> Result<SaveProjectResult, WireCommandError> {
        let candidate = draft_catalog(&session.root, &request, &asset_overrides)
            .map_err(validation_command_error)?;
        let all_writes =
            serialize_project(&session.root, &request).map_err(validation_command_error)?;
        let assets = plan_asset_writes(&session.root, &staged).map_err(io_command_error)?;
        let next_models =
            document_models_from_request(&request).map_err(validation_command_error)?;
        let writes = retain_changed_model_writes(
            &session.root,
            all_writes,
            &next_models,
            &session.document_models,
        );
        let deletes =
            managed_deletions(&session.root, &session.catalog.manifest, &request.manifest);
        // Compute every value needed by the response before publication. The
        // fingerprint is built from the bytes that are actually going to be
        // written (and the inspected hashes of staged binaries), from the
        // save-start snapshot memoized for paths that already existed then, and
        // by re-reading paths that were missing when the save began. Once the
        // journal is committed, the command therefore cannot report a failure
        // while the editor still holds the old fingerprint.
        let mut expected_hashes = writes
            .iter()
            .map(|(path, bytes)| (path.clone(), hash_bytes(bytes)))
            .collect::<BTreeMap<_, _>>();
        expected_hashes.extend(assets.hashes.clone());
        let fingerprint = project_fingerprint_with_hashes(
            &session.root,
            &request.manifest,
            &expected_hashes,
            &mut hash_cache,
        )
        .map_err(io_command_error)?;
        let project = project_payload_from_request(
            &session.root,
            &candidate,
            &request,
            &assets.published_paths,
            fingerprint.clone(),
        )
        .map_err(validation_command_error)?;
        let changed_paths = project_relative_paths(
            &session.root,
            writes
                .iter()
                .map(|(path, _)| path)
                .chain(assets.sources.iter().map(|(path, _)| path)),
        )
        .collect();
        let (transaction_id, warnings) =
            if writes.is_empty() && assets.sources.is_empty() && deletes.is_empty() {
                (None, Vec::new())
            } else {
                let outcome = atomic_write_batch(
                    &session.root,
                    &writes,
                    &assets.sources,
                    &assets.hashes,
                    &deletes,
                )
                .map_err(io_command_error)?;
                (Some(outcome.transaction_id), outcome.warnings)
            };

        // `candidate` was validated against the trusted staging overlay above.
        // Once publication succeeds its resolver can be rebased to the formal
        // assets tree without another fallible filesystem read.
        session.catalog = candidate.into_published();
        session.fingerprint.clone_from(&fingerprint);
        session.document_models = next_models;
        Ok(SaveProjectResult {
            project,
            changed_paths,
            deleted_paths: project_relative_paths(&session.root, deletes.iter()).collect(),
            warnings,
            transaction_id,
        })
    })();

    if let Ok(saved) = &mut result {
        saved
            .warnings
            .extend(release_staged_imports(&state, &session.root, &staged));
    }
    result
}

/// Forget the imports a committed save consumed (and any other staged import of
/// this project that the save no longer references) and delete their staging
/// directories.
///
/// Cleanup is deliberately best-effort.  In particular, a poisoned import mutex
/// must not turn a successful disk commit into an error response with a stale
/// editor session, so failures come back as warnings.
fn release_staged_imports(
    state: &EditorState,
    root: &Path,
    staged: &[StagedImport],
) -> Vec<EditorDiagnostic> {
    let Ok(mut imports) = state.imports.lock() else {
        return vec![cleanup_warning(
            "素材导入锁已损坏，暂存文件将在下次打开项目时清理",
        )];
    };
    let retained = staged
        .iter()
        .map(|item| item.token.as_str())
        .collect::<BTreeSet<_>>();
    let stale = imports
        .values()
        .filter(|item| item.project_root == root)
        .filter(|item| !retained.contains(item.token.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let mut cleanup_dirs = BTreeSet::new();
    for item in staged.iter().chain(stale.iter()) {
        imports.remove(&item.token);
        if item.owns_staged_path {
            if let Some(parent) = item.staged_path.parent() {
                // Two logical registrations may deliberately reuse one staged
                // binary. Remove its directory once, otherwise the second token
                // would produce a spurious warning after the first cleaned it up.
                cleanup_dirs.insert(parent.to_path_buf());
            }
        }
    }
    let mut warnings = Vec::new();
    for directory in cleanup_dirs {
        if let Err(error) = fs::remove_dir_all(&directory) {
            if error.kind() != std::io::ErrorKind::NotFound {
                warnings.push(cleanup_warning(format!(
                    "导入暂存目录清理失败（{}）：{error}",
                    directory.display()
                )));
            }
        }
    }
    warnings
}
