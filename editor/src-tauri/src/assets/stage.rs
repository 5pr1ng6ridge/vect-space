//! Stage a batch of inspected source files for import.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, State};
use vectspace_core::model::AssetKind;
use vectspace_protocol::{
    WireAssetMetadata, WireCommandError, WireImportedAsset, WireStageAssetImportsRequest, WireU64,
};

use crate::assets::inspect::{format_family_from_path, inspect_media_source, media_format_family};
use crate::assets::registry::staged_import_directories;
use crate::assets::{
    asset_folder, asset_kind_from_wire, staging_dir, valid_asset_registration_id,
    validate_import_extension, validate_import_file_name, wire_asset_kind, ImportAssetRequest,
    InspectedImport, StagedImport, StagedReplacement,
};
use crate::error::{asset_command_error, io_command_error, validation_command_error};
use crate::files::{
    copy_file_streaming, hash_file_streaming, path_reservation_key, resolve_case_insensitive,
    safe_relative_path,
};
use crate::state::{require_project, EditorState, ProjectSession};

/// Validate one import batch and stage every accepted binary.
///
/// Kept apart from the `stage_asset_imports` command so the staging rules can
/// be exercised without a Tauri app handle.  On any error every directory
/// created by this call is removed.
fn prepare_asset_imports(
    session: &ProjectSession,
    existing_imports: &BTreeMap<String, StagedImport>,
    inspections: &BTreeMap<String, InspectedImport>,
    requests: &[ImportAssetRequest],
    batch_id: u128,
) -> Result<Vec<StagedImport>, WireCommandError> {
    let mut ids = session
        .catalog
        .manifest
        .assets
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut paths = session
        .catalog
        .manifest
        .assets
        .values()
        .filter_map(|asset| asset.path.as_deref())
        .map(path_reservation_key)
        .collect::<BTreeSet<_>>();
    // A second import dialog can be opened before the first one is saved.
    // Reserve those staged IDs and destinations as well, otherwise two
    // independent batches could collide at commit time.
    for staged in existing_imports
        .values()
        .filter(|item| item.project_root == session.root)
    {
        ids.insert(staged.id.clone());
        paths.insert(path_reservation_key(&staged.relative_path));
    }
    let mut prepared: Vec<StagedImport> = Vec::with_capacity(requests.len());
    let mut created_staging_dirs = BTreeSet::new();
    let mut replacement_ids = BTreeSet::new();

    let preparation = (|| -> Result<(), WireCommandError> {
        for (index, item) in requests.iter().enumerate() {
            if !valid_asset_registration_id(&item.id) {
                return Err(validation_command_error(format!(
                    "素材 ID 包含非法字符: {}",
                    item.id
                )));
            }
            let inspection_id = item
                .inspection_id
                .as_ref()
                .ok_or_else(|| validation_command_error("素材必须先经过检查，再加入导入清单"))?;
            let inspected = inspections.get(inspection_id).ok_or_else(|| {
                validation_command_error(format!("素材检查已失效: {inspection_id}"))
            })?;
            if inspected.project_root != session.root {
                return Err(validation_command_error("素材检查属于另一个项目"));
            }
            let current_hash =
                hash_file_streaming(&inspected.source_path).map_err(io_command_error)?;
            if current_hash != inspected.sha256 {
                return Err(validation_command_error(
                    "源素材在检查后发生了变化，请重新检查",
                ));
            }
            let source = inspected.source_path.clone();
            let (file_name, requested_relative_path) =
                normalize_import_request_for_source(item, &source)?;
            validate_import_file_name(item.kind, &file_name, &source)?;
            let is_replacement = item.replace_id.is_some();
            if let Some(replace_id) = &item.replace_id {
                if replace_id != &item.id {
                    return Err(validation_command_error(format!(
                        "替换标记 {replace_id} 与素材 ID {} 不一致",
                        item.id
                    )));
                }
            }
            if is_replacement {
                // The id already exists by definition, so the id reservation
                // cannot reject a duplicate.  Reject a second staged
                // replacement of the same id *in this batch* instead: one batch
                // must not contain two competing binaries for one manifest
                // entry.  A superseded replacement from an earlier batch is
                // allowed: the author can undo a staged replacement and stage
                // another file without saving first.  The two tokens stay
                // distinct (the `paths` reservation above keeps their
                // destination files apart) and save only submits the token
                // whose new path matches the manifest, so the obsolete token
                // fails closed in `staged_imports_for_request`.  The
                // superseded binary stays on disk for redo and is removed by
                // the best-effort cleanup after a save.
                if !replacement_ids.insert(item.id.clone()) {
                    return Err(validation_command_error(format!(
                        "同一批次只能替换一次素材: {}",
                        item.id
                    )));
                }
            } else if !ids.insert(item.id.clone()) {
                return Err(validation_command_error(format!(
                    "素材 ID 已存在或重复: {}",
                    item.id
                )));
            }
            if !source.is_file() {
                return Err(validation_command_error("选择的素材不是文件"));
            }
            validate_import_extension(item.kind, &source)?;
            let source_metadata = inspect_media_source(&source).map_err(|message| {
                validation_command_error(format!(
                    "素材 {} 内容校验失败：{}",
                    source.display(),
                    message
                ))
            })?;
            let replacement = if is_replacement {
                Some(replacement_target(
                    session,
                    item,
                    &source_metadata,
                    &requested_relative_path,
                )?)
            } else {
                None
            };
            let sha256 = hash_file_streaming(&source).map_err(io_command_error)?;
            // A replacement must own a brand new staged binary even when its
            // bytes match the registered file, so formal deduplication is
            // skipped entirely for it.
            let reusable = if is_replacement {
                None
            } else {
                // Reuse a file already staged in this batch before scanning the
                // formal catalog. This keeps two logical registrations of the
                // same upload on one temporary binary and preserves cross-kind
                // reuse semantics for a shared file.
                let staged_reusable = prepared
                    .iter()
                    .find(|candidate| candidate.sha256 == sha256)
                    .map(|candidate| {
                        (
                            candidate.id.clone(),
                            candidate.relative_path.clone(),
                            candidate.staged_path.clone(),
                        )
                    });
                match staged_reusable {
                    Some(candidate) => Some(candidate),
                    None => find_reusable_asset(session, item.kind, &sha256)
                        .map_err(io_command_error)?,
                }
            };
            let token = format!("import-{batch_id}-{index}");
            let (relative_path, staged_path, owns_staged_path, reused_from) =
                if let Some((existing_id, existing_path, existing_absolute)) = reusable {
                    // Reuse the existing formal or staged file when the bytes
                    // already exist. A new logical ID may still register the
                    // same file under another kind (for example a shared OGG
                    // used as both BGM and SFX).
                    (existing_path, existing_absolute, false, Some(existing_id))
                } else {
                    if !paths.insert(path_reservation_key(&requested_relative_path)) {
                        return Err(validation_command_error(format!(
                            "目标素材文件已存在或重复: {requested_relative_path}"
                        )));
                    }
                    let staged_dir = staging_dir(&session.root).join(&token);
                    fs::create_dir_all(&staged_dir).map_err(io_command_error)?;
                    created_staging_dirs.insert(staged_dir.clone());
                    let staged_path = staged_dir.join(&file_name);
                    if let Err(error) = copy_file_streaming(&source, &staged_path) {
                        let _ = fs::remove_dir_all(&staged_dir);
                        return Err(io_command_error(error));
                    }
                    (requested_relative_path, staged_path, true, None)
                };
            if owns_staged_path && fs::metadata(&staged_path).map_err(io_command_error)?.len() == 0
            {
                return Err(validation_command_error(format!(
                    "素材文件为空: {}",
                    source.display()
                )));
            }
            prepared.push(StagedImport {
                token,
                project_root: session.root.clone(),
                id: item.id.clone(),
                kind: item.kind,
                relative_path,
                staged_path,
                sha256,
                owns_staged_path,
                reused_from,
                replaces: replacement,
            });
        }
        Ok(())
    })();
    match preparation {
        Ok(()) => Ok(prepared),
        Err(error) => {
            for directory in &created_staging_dirs {
                let _ = fs::remove_dir_all(directory);
            }
            Err(error)
        }
    }
}

/// Stage a batch of binaries without mutating the managed `assets/` tree.
/// The returned opaque tokens are the only handles accepted by
/// `save_project`; the WebView never gets to choose a copy destination.
#[tauri::command]
pub(crate) fn stage_asset_imports(
    request: WireStageAssetImportsRequest,
    app: AppHandle,
    state: State<'_, EditorState>,
) -> Result<Vec<WireImportedAsset>, WireCommandError> {
    let requests = request
        .requests
        .into_iter()
        .map(|item| ImportAssetRequest {
            id: item.id,
            kind: asset_kind_from_wire(item.kind),
            file_name: item.file_name,
            inspection_id: item.inspection_id,
            replace_id: item.replace_id,
        })
        .collect::<Vec<_>>();
    if requests.is_empty() {
        return Ok(Vec::new());
    }
    let session_guard = state.lock_session()?;
    let session = require_project(&session_guard)?;
    let mut imports = state.lock_imports()?;
    let mut inspections = state.lock_inspections()?;
    let batch_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let prepared = prepare_asset_imports(session, &imports, &inspections, &requests, batch_id)?;

    // All validation and copies above succeeded.  Resolve the final metadata
    // before publishing any token.  A formal reused file may disappear
    // between preparation and publication; checking it here prevents a
    // half-published batch when that happens.
    let output = match prepared
        .iter()
        .map(|staged| {
            let size_bytes = fs::metadata(&staged.staged_path)
                .map_err(io_command_error)?
                .len();
            Ok(WireImportedAsset {
                id: staged.id.clone(),
                kind: wire_asset_kind(staged.kind),
                path: staged.relative_path.clone(),
                absolute_path: staged.staged_path.to_string_lossy().into_owned(),
                size_bytes: WireU64::from(size_bytes),
                token: Some(staged.token.clone()),
                reused_from: staged.reused_from.clone(),
                replaced_from: staged
                    .replaces
                    .as_ref()
                    .map(|replacement| replacement.old_relative_path.clone()),
            })
        })
        .collect::<Result<Vec<_>, WireCommandError>>()
    {
        Ok(output) => output,
        Err(error) => {
            for directory in staged_import_directories(&prepared) {
                let _ = fs::remove_dir_all(directory);
            }
            return Err(error);
        }
    };

    // Publish the records as one batch so a partial import can never be
    // observed by save_project.
    let mut published = Vec::with_capacity(prepared.len());
    for staged in &prepared {
        if staged.owns_staged_path {
            if let Err(error) = app.asset_protocol_scope().allow_file(&staged.staged_path) {
                for token in published {
                    imports.remove(&token);
                }
                for directory in staged_import_directories(&prepared) {
                    let _ = fs::remove_dir_all(directory);
                }
                return Err(asset_command_error(error));
            }
        }
        imports.insert(staged.token.clone(), staged.clone());
        published.push(staged.token.clone());
    }
    for item in &requests {
        if let Some(inspection_id) = &item.inspection_id {
            inspections.remove(inspection_id);
        }
    }
    Ok(output)
}

fn normalize_import_request_for_source(
    request: &ImportAssetRequest,
    source: &Path,
) -> Result<(OsString, String), WireCommandError> {
    let file_name = request
        .file_name
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(OsString::from)
        .or_else(|| source.file_name().map(ToOwned::to_owned))
        .ok_or_else(|| validation_command_error("无法识别素材文件名"))?;
    let text = file_name.to_string_lossy();
    if text.len() > 200
        || Path::new(&file_name).components().count() != 1
        || matches!(file_name.to_str(), Some(".") | Some(".."))
        || text.trim().is_empty()
        || text.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
    {
        return Err(validation_command_error("素材文件名必须是单个安全文件名"));
    }
    validate_import_extension(request.kind, Path::new(&file_name))?;
    let relative_path = format!("{}/{}", asset_folder(request.kind), text.replace('\\', "/"));
    safe_relative_path(&relative_path).map_err(validation_command_error)?;
    // Do not reject an existing destination here.  The source hash is needed
    // first so an identical formal asset can be safely reused; the caller
    // performs the destination reservation check only for genuinely new
    // content.
    Ok((file_name, relative_path))
}

/// Resolve and validate the existing asset a replacement request targets.
/// The logical id and kind must match, a composite animated asset is refused
/// with a domain explanation, the new upload must keep the registered binary's
/// actual format family, the destination must be a *different* safe path, and
/// an asset used as an animation frame must keep the animation's uniform
/// pixel size.
fn replacement_target(
    session: &ProjectSession,
    request: &ImportAssetRequest,
    source_metadata: &WireAssetMetadata,
    requested_relative_path: &str,
) -> Result<StagedReplacement, WireCommandError> {
    let definition = session
        .catalog
        .manifest
        .assets
        .get(&request.id)
        .ok_or_else(|| validation_command_error(format!("要替换的素材不存在: {}", request.id)))?;
    if definition.kind != request.kind {
        return Err(validation_command_error(format!(
            "替换素材 {} 时必须保持原始类型 {:?}",
            request.id, definition.kind
        )));
    }
    if definition.animation.is_some() {
        return Err(validation_command_error(format!(
            "素材 {} 是合成动画，不能替换其二进制；请改换它的帧图片或重新创建动画",
            request.id
        )));
    }
    let old_relative_path = definition
        .path
        .as_deref()
        .ok_or_else(|| {
            validation_command_error(format!("素材 {} 没有可替换的静态文件", request.id))
        })?
        .replace('\\', "/");
    if path_reservation_key(requested_relative_path) == path_reservation_key(&old_relative_path) {
        return Err(validation_command_error(format!(
            "替换素材 {} 必须写入新的文件路径，不能覆盖 {}",
            request.id, old_relative_path
        )));
    }
    let old_absolute = resolve_case_insensitive(&session.root.join("assets"), &old_relative_path)
        .map_err(|error| {
        validation_command_error(format!(
            "无法定位要替换的素材文件 {}: {error}",
            old_relative_path
        ))
    })?;
    // Decode the registered binary so a renamed or re-encoded upload cannot
    // silently change the media format behind a stable id.
    let old_metadata = inspect_media_source(&old_absolute).ok();
    let old_family = old_metadata
        .as_ref()
        .and_then(|metadata| media_format_family(&metadata.format))
        .or_else(|| format_family_from_path(&old_absolute));
    let new_family = media_format_family(&source_metadata.format)
        .or_else(|| format_family_from_path(Path::new(&requested_relative_path)));
    if old_family.is_none() || new_family.is_none() || old_family != new_family {
        return Err(validation_command_error(format!(
            "替换素材 {} 的实际格式必须与原文件 {} 一致（原为 {}）",
            request.id,
            old_relative_path,
            old_family.unwrap_or("未知")
        )));
    }
    // A frame of a loop animation must keep the animation's uniform pixel
    // size; any other asset's geometry may change freely.
    if !session
        .catalog
        .animations_referencing(&request.id)
        .is_empty()
    {
        let Some((width, height)) = old_metadata
            .as_ref()
            .and_then(|metadata| metadata.width.zip(metadata.height))
        else {
            return Err(validation_command_error(format!(
                "素材 {} 被帧动画引用，但无法测量当前帧尺寸，替换已取消",
                request.id
            )));
        };
        let Some((new_width, new_height)) = source_metadata.width.zip(source_metadata.height)
        else {
            return Err(validation_command_error(format!(
                "素材 {} 被帧动画引用，新图片缺少像素尺寸信息",
                request.id
            )));
        };
        if width != new_width || height != new_height {
            return Err(validation_command_error(format!(
                "素材 {} 是帧动画的一帧，新图片尺寸 {}×{} 必须与动画尺寸 {}×{} 一致",
                request.id, new_width, new_height, width, height
            )));
        }
    }
    Ok(StagedReplacement {
        old_relative_path,
        old_kind: definition.kind,
    })
}

/// Find a formal project file with identical bytes.  Prefer the same logical
/// kind, then fall back to the first stable manifest order so cross-kind
/// registrations (for example one OGG used as BGM and SFX) are deterministic.
fn find_reusable_asset(
    session: &ProjectSession,
    kind: AssetKind,
    sha256: &str,
) -> Result<Option<(String, String, PathBuf)>, std::io::Error> {
    let mut fallback = None;
    for (id, definition) in &session.catalog.manifest.assets {
        // Reuse matching only applies to static files; an animated asset
        // already owns a whole frame list.
        let Some(relative) = &definition.path else {
            continue;
        };
        let absolute = session.catalog.assets_root().join(relative);
        if hash_file_streaming(&absolute)?.as_str() != sha256 {
            continue;
        }
        let candidate = (id.clone(), relative.clone(), absolute);
        if definition.kind == kind {
            return Ok(Some(candidate));
        }
        if fallback.is_none() {
            fallback = Some(candidate);
        }
    }
    Ok(fallback)
}

#[cfg(test)]
mod tests {
    use vectspace_core::content::ContentCatalog;

    use super::*;
    use crate::assets::registry::staged_imports_for_request;
    use crate::test_support::{
        asset_session, demo_root, replacement_save_request, seed_animated_asset_project,
        seed_asset_project, write_test_jpeg, write_test_png,
    };

    fn replacement_request(id: &str, kind: AssetKind, file_name: &str) -> ImportAssetRequest {
        ImportAssetRequest {
            id: id.to_owned(),
            kind,
            file_name: Some(file_name.to_owned()),
            inspection_id: None,
            replace_id: Some(id.to_owned()),
        }
    }

    #[test]
    fn identical_bytes_are_found_in_the_formal_asset_tree() {
        let root = demo_root();
        let session = ProjectSession {
            catalog: ContentCatalog::from_root(root.clone()).unwrap(),
            root,
            fingerprint: String::new(),
            document_models: BTreeMap::new(),
        };
        let digest = hash_file_streaming(
            &session
                .catalog
                .assets_root()
                .join("backgrounds/Photoshop_3a52oGnGn0.png"),
        )
        .unwrap();
        let (asset_id, path, absolute) =
            find_reusable_asset(&session, AssetKind::Background, &digest)
                .unwrap()
                .expect("the demo classroom should be reusable");
        assert_eq!(asset_id, "bg.nvctsp");
        assert_eq!(path, "backgrounds/Photoshop_3a52oGnGn0.png");
        assert!(absolute.is_file());
    }

    #[test]
    fn replacement_target_requires_a_new_path_and_matching_actual_format() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        seed_asset_project(root);
        let session = asset_session(root);
        let incoming = root.join("incoming");
        write_test_png(&incoming.join("room_v2.png"), 8, 8);
        write_test_jpeg(&incoming.join("room_v2.jpg"), 8, 8);
        let png_metadata = inspect_media_source(&incoming.join("room_v2.png")).unwrap();
        let jpeg_metadata = inspect_media_source(&incoming.join("room_v2.jpg")).unwrap();
        let background =
            |file_name| replacement_request("bg.room", AssetKind::Background, file_name);

        // Same id, same kind, same actual format, brand-new path.
        let accepted = replacement_target(
            &session,
            &background("room_v2.png"),
            &png_metadata,
            "backgrounds/room_v2.png",
        )
        .unwrap();
        assert_eq!(accepted.old_relative_path, "backgrounds/room.png");
        assert_eq!(accepted.old_kind, AssetKind::Background);

        let rejected = |request, metadata, path| {
            replacement_target(&session, &request, metadata, path)
                .unwrap_err()
                .message
        };
        // The registered destination is never overwritten.
        let same_path = rejected(
            background("room.png"),
            &png_metadata,
            "backgrounds/room.png",
        );
        assert!(same_path.contains("新的文件路径"), "{same_path}");
        // A re-encoded upload must keep the registered format family.
        let wrong_format = rejected(
            background("room_v2.jpg"),
            &jpeg_metadata,
            "backgrounds/room_v2.jpg",
        );
        assert!(wrong_format.contains("格式"), "{wrong_format}");
        // Kind and existence are both enforced.
        let wrong_kind = rejected(
            replacement_request("bg.room", AssetKind::Sprite, "room_v2.png"),
            &png_metadata,
            "sprites/room_v2.png",
        );
        assert!(wrong_kind.contains("原始类型"), "{wrong_kind}");
        let missing = rejected(
            replacement_request("bg.ghost", AssetKind::Background, "ghost.png"),
            &png_metadata,
            "backgrounds/ghost.png",
        );
        assert!(missing.contains("不存在"), "{missing}");
    }

    #[test]
    fn replacement_refuses_composite_animations_and_checks_frame_geometry() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        seed_animated_asset_project(root);
        let session = asset_session(root);
        assert_eq!(session.catalog.animations_referencing("bg.room"), ["blink"]);
        let incoming = root.join("incoming");
        write_test_png(&incoming.join("room_v3.png"), 8, 8);
        write_test_png(&incoming.join("room_big.png"), 16, 16);
        let matching = inspect_media_source(&incoming.join("room_v3.png")).unwrap();
        let bigger = inspect_media_source(&incoming.join("room_big.png")).unwrap();

        // A frame image may be replaced while its animation keeps one uniform
        // pixel size.
        assert!(replacement_target(
            &session,
            &replacement_request("bg.room", AssetKind::Background, "room_v3.png"),
            &matching,
            "backgrounds/room_v3.png",
        )
        .is_ok());
        let resized = replacement_target(
            &session,
            &replacement_request("bg.room", AssetKind::Background, "room_big.png"),
            &bigger,
            "backgrounds/room_big.png",
        )
        .unwrap_err();
        assert!(resized.message.contains("尺寸"), "{resized:?}");

        // The composite animated asset itself needs an explanation rather than
        // a silent partial replacement.
        let composite = replacement_target(
            &session,
            &replacement_request("anim.blink", AssetKind::Background, "blink.png"),
            &matching,
            "backgrounds/blink.png",
        )
        .unwrap_err();
        assert!(composite.message.contains("合成动画"), "{composite:?}");
    }

    #[test]
    fn replacement_supersedes_an_earlier_staged_replacement() {
        let directory = tempfile::tempdir().unwrap();
        seed_asset_project(directory.path());
        let session = asset_session(directory.path());
        let root = session.root.clone();
        let incoming = root.join("incoming");
        write_test_png(&incoming.join("room_v2.png"), 8, 8);
        write_test_png(&incoming.join("room_v3.png"), 8, 8);

        let inspected = |file: &str| InspectedImport {
            project_root: root.clone(),
            source_path: incoming.join(file),
            sha256: hash_file_streaming(&incoming.join(file)).unwrap(),
        };
        let inspections = BTreeMap::from([
            ("insp-a".to_owned(), inspected("room_v2.png")),
            ("insp-b".to_owned(), inspected("room_v3.png")),
        ]);
        let request = |file_name: &str, inspection: &str| ImportAssetRequest {
            inspection_id: Some(inspection.to_owned()),
            ..replacement_request("bg.room", AssetKind::Background, file_name)
        };

        // First replacement: stage `room_v2.png`.
        let staged_a = prepare_asset_imports(
            &session,
            &BTreeMap::new(),
            &inspections,
            &[request("room_v2.png", "insp-a")],
            1,
        )
        .unwrap();
        assert_eq!(staged_a[0].token, "import-1-0");
        assert_eq!(staged_a[0].relative_path, "backgrounds/room_v2.png");
        assert!(staged_a[0].staged_path.is_file());

        // An undo restores the session's original path; staging a *different*
        // file for the same id must be allowed (the superseded token stays for
        // redo and its staged binary stays on disk).
        let existing = BTreeMap::from([(staged_a[0].token.clone(), staged_a[0].clone())]);
        let staged_b = prepare_asset_imports(
            &session,
            &existing,
            &inspections,
            &[request("room_v3.png", "insp-b")],
            2,
        )
        .unwrap();
        assert_eq!(staged_b[0].token, "import-2-0");
        assert_eq!(staged_b[0].relative_path, "backgrounds/room_v3.png");
        assert!(staged_a[0].staged_path.is_file() && staged_b[0].staged_path.is_file());

        // Two replacements in one batch are still rejected.
        let batched = prepare_asset_imports(
            &session,
            &BTreeMap::new(),
            &inspections,
            &[
                request("room_v2.png", "insp-a"),
                request("room_v3.png", "insp-b"),
            ],
            4,
        )
        .unwrap_err();
        assert!(batched.message.contains("同一批次"), "{batched:?}");

        // Reusing the superseded token's destination is rejected and the failed
        // batch leaves no staged directory.
        let collide = prepare_asset_imports(
            &session,
            &existing,
            &inspections,
            &[request("room_v2.png", "insp-a")],
            3,
        )
        .unwrap_err();
        assert!(collide.message.contains("已存在或重复"), "{collide:?}");
        assert!(!root.join(".vectspace/tmp/imports/import-3-0").exists());

        // The *original* on-disk path stays forbidden even though the current
        // row now points at the staged path: the host never overwrites it.
        let original = prepare_asset_imports(
            &session,
            &existing,
            &inspections,
            &[request("room.png", "insp-a")],
            5,
        )
        .unwrap_err();
        assert!(
            original.message.contains("不能覆盖") || original.message.contains("已存在或重复"),
            "{original:?}"
        );
        assert!(root.join("assets/backgrounds/room.png").is_file());

        // Save isolation: only the token whose new path matches the manifest
        // resolves; the obsolete token fails closed instead of re-binding the
        // id, and submitting both is rejected.
        let imports = BTreeMap::from([
            (staged_a[0].token.clone(), staged_a[0].clone()),
            (staged_b[0].token.clone(), staged_b[0].clone()),
        ]);
        let mut save = replacement_save_request(&session, "backgrounds/room_v3.png");
        let resolve = |save: &crate::model::SaveProjectRequest| {
            staged_imports_for_request(&imports, &root, &session.catalog.manifest.assets, save)
        };
        save.import_tokens = vec![staged_b[0].token.clone()];
        let resolved = resolve(&save).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].relative_path, "backgrounds/room_v3.png");

        save.import_tokens = vec![staged_a[0].token.clone()];
        let stale = resolve(&save).unwrap_err();
        assert!(stale.contains("类型或目标路径已被修改"), "{stale}");

        save.import_tokens = vec![staged_a[0].token.clone(), staged_b[0].token.clone()];
        assert!(resolve(&save).is_err());
    }
}
