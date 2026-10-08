//! The in-memory registry of staged imports: resolving the tokens a request
//! submits, checking them before a save, and discarding them on project switch.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use vectspace_core::model::AssetDefinition;
use vectspace_protocol::WireCommandError;

use crate::assets::{staging_dir, StagedImport};
use crate::error::{io_command_error, validation_command_error};
use crate::files::{hash_file_streaming, path_exists_case_insensitive, resolve_case_insensitive};
use crate::model::SaveProjectRequest;
use crate::state::{EditorState, ProjectSession};

/// Resolve the staged imports a request's tokens refer to, failing closed when
/// a token is unknown, belongs to another project, or no longer matches the
/// manifest it was minted for.
pub(crate) fn staged_imports_for_request(
    imports: &BTreeMap<String, StagedImport>,
    root: &Path,
    previous_assets: &BTreeMap<String, AssetDefinition>,
    request: &SaveProjectRequest,
) -> Result<Vec<StagedImport>, String> {
    let mut seen = BTreeSet::new();
    let mut output = Vec::with_capacity(request.import_tokens.len());
    for token in &request.import_tokens {
        if !seen.insert(token) {
            return Err(format!("保存请求包含重复素材导入 token: {token}"));
        }
        let staged = imports
            .get(token)
            .ok_or_else(|| format!("素材导入 token 已失效: {token}"))?;
        if staged.project_root != root {
            return Err("素材导入 token 不属于当前项目".to_owned());
        }
        let definition = request
            .manifest
            .assets
            .get(&staged.id)
            .ok_or_else(|| format!("素材导入 {} 已不在当前 manifest 中", staged.id))?;
        if definition.kind != staged.kind
            || definition
                .path
                .as_deref()
                .map(|path| path.replace('\\', "/"))
                != Some(staged.relative_path.clone())
        {
            return Err(format!("素材导入 {} 的类型或目标路径已被修改", staged.id));
        }
        if let Some(replacement) = &staged.replaces {
            // A replacement token is only valid while the session still holds
            // the *old* registration it was minted against.  If the old path
            // changed (for example an undo restored a different file), the
            // capability must fail closed instead of re-pointing the id.
            let previous = previous_assets
                .get(&staged.id)
                .ok_or_else(|| format!("素材替换 {} 的原始素材已不存在", staged.id))?;
            if previous.kind != replacement.old_kind
                || previous.path.as_deref().map(|path| path.replace('\\', "/"))
                    != Some(replacement.old_relative_path.clone())
            {
                return Err(format!(
                    "素材 {} 自暂存替换后已被修改，请重新导入",
                    staged.id
                ));
            }
        }
        output.push(staged.clone());
    }
    Ok(output)
}

/// Resolve and verify the staged imports a draft request submits.
pub(crate) fn request_staged_imports(
    state: &EditorState,
    session: &ProjectSession,
    request: &SaveProjectRequest,
) -> Result<Vec<StagedImport>, WireCommandError> {
    let staged = {
        let imports = state.lock_imports()?;
        staged_imports_for_request(
            &imports,
            &session.root,
            &session.catalog.manifest.assets,
            request,
        )
        .map_err(validation_command_error)?
    };
    validate_staged_imports(&staged).map_err(io_command_error)?;
    Ok(staged)
}

/// Every staged binary must still hold the bytes that were inspected.
fn validate_staged_imports(imports: &[StagedImport]) -> Result<(), std::io::Error> {
    for item in imports {
        if hash_file_streaming(&item.staged_path)?.as_str() != item.sha256 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("暂存素材校验失败: {}", item.id),
            ));
        }
    }
    Ok(())
}

pub(crate) fn ensure_import_targets_available(
    root: &Path,
    imports: &[StagedImport],
) -> Result<(), std::io::Error> {
    let staging_root = staging_dir(root);
    for item in imports {
        // A non-owning token can still point at another token's staged file.
        // This happens when the first logical registration is removed before
        // save.  If its target has appeared externally, accept it only when
        // the bytes are exactly the inspected upload; otherwise fail closed
        // instead of silently binding the manifest to an unrelated file.
        let points_at_staging = item.staged_path.starts_with(&staging_root);
        if !item.owns_staged_path && !points_at_staging {
            continue;
        }
        let target = root.join("assets").join(&item.relative_path);
        if path_exists_case_insensitive(&root.join("assets"), &item.relative_path)? {
            if item.owns_staged_path {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!("目标素材文件已存在: {}", target.display()),
                ));
            }
            let existing = resolve_case_insensitive(&root.join("assets"), &item.relative_path)?;
            if hash_file_streaming(&existing)? != item.sha256 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!("目标素材文件已存在且内容不同: {}", target.display()),
                ));
            }
        }
    }
    Ok(())
}

/// Staging directories owned by a prepared batch, used to clean up when a
/// later step of the same batch fails.
pub(crate) fn staged_import_directories(imports: &[StagedImport]) -> BTreeSet<PathBuf> {
    imports
        .iter()
        .filter(|item| item.owns_staged_path)
        .filter_map(|item| item.staged_path.parent().map(Path::to_path_buf))
        .collect()
}

/// Staged files by asset id, for resolving a draft catalog before the
/// binaries are published.
pub(crate) fn staged_asset_overrides(imports: &[StagedImport]) -> BTreeMap<String, PathBuf> {
    imports
        .iter()
        .map(|item| (item.id.clone(), item.staged_path.clone()))
        .collect()
}

/// Discard the staged imports and inspections of the project that was open
/// before a project switch.  Records of other projects are kept: a user can
/// have another editor window open in the same process, and its staged files
/// must remain usable until that window is closed.
pub(crate) fn clear_staged_imports(state: &EditorState, root: &Path) -> Result<(), std::io::Error> {
    let stale_root = state
        .session
        .lock()
        .map_err(|_| std::io::Error::other("编辑器项目锁已损坏"))?
        .as_ref()
        .map_or_else(|| root.to_path_buf(), |session| session.root.clone());
    let mut imports = state
        .imports
        .lock()
        .map_err(|_| std::io::Error::other("素材导入锁已损坏"))?;
    imports.retain(|_, item| item.project_root != stale_root);
    let mut inspections = state
        .inspections
        .lock()
        .map_err(|_| std::io::Error::other("素材检查锁已损坏"))?;
    inspections.retain(|_, item| item.project_root != stale_root);
    // Remove only staging directories that no surviving token references.
    // Wiping the whole imports tree would invalidate another editor window's
    // in-memory token, and could remove a shared staged file still referenced
    // by a non-owning registration.
    let retained_directories = imports
        .values()
        .filter_map(|item| item.staged_path.parent().map(Path::to_path_buf))
        .collect::<BTreeSet<_>>();
    let entries = match fs::read_dir(staging_dir(&stale_root)) {
        Ok(entries) => entries.collect::<Result<Vec<_>, _>>()?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let path = entry.path();
        if entry.file_type()?.is_dir() && !retained_directories.contains(&path) {
            fs::remove_dir_all(path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::StagedReplacement;
    use crate::files::hash_bytes;
    use crate::test_support::{asset_session, replacement_save_request, seed_asset_project};
    use vectspace_core::model::AssetKind;

    fn staged_import(root: &Path, relative_path: &str, staged_path: PathBuf) -> StagedImport {
        StagedImport {
            token: "import-1".to_owned(),
            project_root: root.to_path_buf(),
            id: "bg.room".to_owned(),
            kind: AssetKind::Background,
            relative_path: relative_path.to_owned(),
            staged_path,
            sha256: hash_bytes(b"staged"),
            owns_staged_path: true,
            reused_from: None,
            replaces: None,
        }
    }

    #[test]
    fn clearing_one_project_keeps_other_project_import_staging() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let root_import = staging_dir(root.path()).join("import-root");
        let other_import = staging_dir(other.path()).join("import-other");
        fs::create_dir_all(&root_import).unwrap();
        fs::create_dir_all(&other_import).unwrap();
        fs::write(root_import.join("asset.png"), b"root").unwrap();
        fs::write(other_import.join("asset.png"), b"other").unwrap();

        let state = EditorState::default();
        let mut other_staged = staged_import(
            other.path(),
            "sprites/asset.png",
            other_import.join("asset.png"),
        );
        other_staged.token = "other-token".to_owned();
        state
            .imports
            .lock()
            .unwrap()
            .insert("other-token".to_owned(), other_staged);

        clear_staged_imports(&state, root.path()).unwrap();

        assert!(!root_import.exists());
        assert!(other_import.exists());
        assert!(state.imports.lock().unwrap().contains_key("other-token"));
    }

    #[test]
    fn replacement_token_tracks_the_session_old_path() {
        let directory = tempfile::tempdir().unwrap();
        seed_asset_project(directory.path());
        let session = asset_session(directory.path());
        let root = session.root.clone();
        let staged_path = root.join(".vectspace/tmp/imports/import-1/room_v2.png");
        let replacing = |old_path: &str| {
            let mut staged = staged_import(&root, "backgrounds/room_v2.png", staged_path.clone());
            staged.replaces = Some(StagedReplacement {
                old_relative_path: old_path.to_owned(),
                old_kind: AssetKind::Background,
            });
            BTreeMap::from([("import-1".to_owned(), staged)])
        };

        // The manifest now points at the new staged path; the token records the
        // old registration the session still holds.
        let request = replacement_save_request(&session, "backgrounds/room_v2.png");
        let imports = replacing("backgrounds/room.png");
        let resolved =
            staged_imports_for_request(&imports, &root, &session.catalog.manifest.assets, &request)
                .unwrap();
        assert_eq!(resolved.len(), 1);

        // An undo (or an external edit) that re-points the id at another file
        // invalidates the capability instead of re-binding it.
        let error = staged_imports_for_request(
            &replacing("backgrounds/moved.png"),
            &root,
            &session.catalog.manifest.assets,
            &request,
        )
        .unwrap_err();
        assert!(error.contains("已被修改"), "{error}");

        // A token whose id is gone from the session fails closed too.
        let mut without_room = session.catalog.manifest.assets.clone();
        without_room.remove("bg.room");
        let error =
            staged_imports_for_request(&imports, &root, &without_room, &request).unwrap_err();
        assert!(error.contains("已不存在"), "{error}");
    }
}
