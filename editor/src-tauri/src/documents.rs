//! Reading, validating and serializing the project's managed documents
//! (manifest, scenes, UI motions, buttons, animations, actions, visuals,
//! chapter map and the editor layout).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;
use vectspace_core::content::ContentCatalog;
use vectspace_core::model::{
    ButtonTemplate, ChapterMapDefinition, ContentManifest, ImageAnimationDefinition, ResolvedAsset,
    SceneDefinition, SpriteActionDefinition, UiMotionPreset,
};
use vectspace_core::visual::{ParticleDefinition, TextBlockDefinition};
use vectspace_protocol::WireU64;

use crate::assets::inspect::inspect_media_source;
use crate::diagnostics::analyze_catalog;
use crate::error::display_error;
use crate::files::{path_reservation_key, safe_relative_path};
use crate::layout::{EditorLayout, LAYOUT_RELATIVE_PATH};
use crate::model::{EditorAsset, EditorFile, EditorProject, EditorSceneFile, SaveProjectRequest};

type Models = BTreeMap<String, serde_json::Value>;

pub(crate) fn read_yaml<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let text = fs::read_to_string(path).map_err(display_error)?;
    let options = serde_saphyr::options! { strict_booleans: true };
    serde_saphyr::from_str_with_options(&text, options).map_err(display_error)
}

fn read_files<T: DeserializeOwned>(
    root: &Path,
    paths: &[String],
) -> Result<Vec<EditorFile<T>>, String> {
    paths
        .iter()
        .map(|path| {
            Ok(EditorFile {
                path: path.clone(),
                definition: read_yaml(&root.join(path))?,
            })
        })
        .collect()
}

fn yaml_bytes(value: &impl Serialize) -> Result<Vec<u8>, String> {
    let mut text = serde_saphyr::to_string(value).map_err(display_error)?;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    Ok(text.into_bytes())
}

/// Every document path the manifest lists, in a fixed order.
pub(crate) fn manifest_document_paths(manifest: &ContentManifest) -> impl Iterator<Item = &String> {
    manifest
        .scenes
        .iter()
        .chain(&manifest.ui_motions)
        .chain(&manifest.buttons)
        .chain(&manifest.animations)
        .chain(&manifest.actions)
        .chain(&manifest.text_blocks)
        .chain(&manifest.particles)
        .chain(&manifest.chapter_map)
}

// -- draft validation -----------------------------------------------------

fn validate_scene_file_set(
    manifest: &ContentManifest,
    files: &[EditorSceneFile],
) -> Result<BTreeMap<String, SceneDefinition>, String> {
    if manifest.scenes.len() != files.len() {
        return Err("manifest 的场景文件列表与编辑器文档不一致".to_owned());
    }
    let declared: BTreeSet<&str> = manifest.scenes.iter().map(String::as_str).collect();
    if declared.len() != manifest.scenes.len() {
        return Err("manifest 中存在重复场景路径".to_owned());
    }
    let provided: BTreeSet<&str> = files.iter().map(|file| file.path.as_str()).collect();
    if declared != provided {
        return Err("提交的场景路径与 manifest 不一致".to_owned());
    }

    let mut scenes = BTreeMap::new();
    for file in files {
        safe_relative_path(&file.path)?;
        if scenes
            .insert(file.definition.id.clone(), file.definition.clone())
            .is_some()
        {
            return Err(format!("场景 ID 重复: {}", file.definition.id));
        }
    }
    Ok(scenes)
}

/// The submitted documents must be exactly the paths the manifest lists, each
/// once; `label` names the document kind in the error text.
fn validate_file_set<T: Clone>(
    label: &str,
    declared: &[String],
    files: &[EditorFile<T>],
) -> Result<BTreeMap<String, T>, String> {
    if declared.len() != files.len() {
        return Err(format!("manifest 的{label}文件列表与编辑器文档不一致"));
    }
    let declared_set = declared.iter().map(String::as_str).collect::<BTreeSet<_>>();
    let provided = files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<BTreeSet<_>>();
    if declared_set.len() != declared.len() || declared_set != provided {
        return Err(format!("提交的{label}路径与 manifest 不一致"));
    }
    files
        .iter()
        .map(|file| {
            safe_relative_path(&file.path)?;
            Ok((file.path.clone(), file.definition.clone()))
        })
        .collect()
}

fn validate_visual_file_set<T: Clone>(
    paths: &[String],
    files: &[EditorFile<T>],
) -> Result<BTreeMap<String, T>, String> {
    let declared = paths.iter().collect::<BTreeSet<_>>();
    let provided = files.iter().map(|file| &file.path).collect::<BTreeSet<_>>();
    if paths.len() != files.len()
        || declared.len() != paths.len()
        || provided.len() != files.len()
        || declared != provided
    {
        return Err("视觉文档路径与 manifest 不一致或重复".to_owned());
    }
    files
        .iter()
        .map(|file| {
            safe_relative_path(&file.path)?;
            Ok((file.path.clone(), file.definition.clone()))
        })
        .collect()
}

/// Validate a draft request with the game's own content loader.  The editor
/// save, validate and preview paths all build their catalog here, so a preview
/// can never run against a different world than the one that would be saved.
/// `asset_overrides` points staged imports at their staging files.
pub(crate) fn draft_catalog(
    root: &Path,
    request: &SaveProjectRequest,
    asset_overrides: &BTreeMap<String, PathBuf>,
) -> Result<ContentCatalog, String> {
    let manifest = &request.manifest;
    let scenes = validate_scene_file_set(manifest, &request.scenes)?;
    let ui_motions = validate_file_set(" UI 动效", &manifest.ui_motions, &request.ui_motions)?;
    let buttons = validate_file_set("按钮模板", &manifest.buttons, &request.buttons)?;
    let animations = validate_file_set("图片动画", &manifest.animations, &request.animations)?;
    let actions = validate_file_set("立绘动作", &manifest.actions, &request.actions)?;
    let text_blocks = validate_visual_file_set(&manifest.text_blocks, &request.text_blocks)?;
    let particles = validate_visual_file_set(&manifest.particles, &request.particles)?;
    ContentCatalog::from_documents_with_visuals(
        root.to_path_buf(),
        manifest.clone(),
        scenes,
        ui_motions,
        request
            .chapter_map
            .as_ref()
            .map(|file| file.definition.clone()),
        asset_overrides,
        Some(buttons),
        Some(animations),
        Some(actions),
        Some(text_blocks),
        Some(particles),
    )
    .map_err(display_error)
}

// -- writing --------------------------------------------------------------

pub(crate) fn serialize_project(
    root: &Path,
    request: &SaveProjectRequest,
) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    fn push<T: Serialize>(
        writes: &mut Vec<(PathBuf, Vec<u8>)>,
        root: &Path,
        file: &EditorFile<T>,
    ) -> Result<(), String> {
        safe_relative_path(&file.path)?;
        writes.push((root.join(&file.path), yaml_bytes(&file.definition)?));
        Ok(())
    }

    let mut writes = vec![(root.join("manifest.yaml"), yaml_bytes(&request.manifest)?)];
    for file in &request.scenes {
        push(&mut writes, root, file)?;
    }
    for file in &request.ui_motions {
        push(&mut writes, root, file)?;
    }
    for file in &request.buttons {
        push(&mut writes, root, file)?;
    }
    for file in &request.animations {
        push(&mut writes, root, file)?;
    }
    for file in &request.actions {
        push(&mut writes, root, file)?;
    }
    for file in &request.text_blocks {
        push(&mut writes, root, file)?;
    }
    for file in &request.particles {
        push(&mut writes, root, file)?;
    }
    if let Some(file) = &request.chapter_map {
        push(&mut writes, root, file)?;
    }
    let layout = serde_json::to_vec_pretty(&request.layout).map_err(display_error)?;
    writes.push((root.join(LAYOUT_RELATIVE_PATH), layout));
    Ok(writes)
}

/// Documents the previous manifest listed that the next one no longer does.
/// Asset binaries are never managed here, so removing or replacing an asset
/// never deletes its file.
pub(crate) fn managed_deletions(
    root: &Path,
    previous: &ContentManifest,
    next: &ContentManifest,
) -> Vec<PathBuf> {
    let next_keys = manifest_document_paths(next)
        .map(|path| path_reservation_key(path))
        .collect::<BTreeSet<_>>();
    manifest_document_paths(previous)
        .filter(|path| !next_keys.contains(&path_reservation_key(path)))
        .filter_map(|path| {
            safe_relative_path(path).ok()?;
            Some(root.join(path))
        })
        .collect()
}

// -- change detection -----------------------------------------------------
//
// A save rewrites only the documents whose JSON model differs from the model
// the session last read or wrote, so an untouched file keeps its bytes (and its
// formatting) on disk.

fn model_key(path: &str) -> String {
    path.replace('\\', "/")
}

fn to_model(value: &impl Serialize) -> Result<serde_json::Value, String> {
    serde_json::to_value(value).map_err(display_error)
}

/// The models of the documents currently on disk.
pub(crate) fn document_models(
    root: &Path,
    manifest: &ContentManifest,
    layout: &EditorLayout,
) -> Result<Models, String> {
    fn read_models<'a, T: DeserializeOwned + Serialize>(
        models: &mut Models,
        root: &Path,
        paths: impl IntoIterator<Item = &'a String>,
    ) -> Result<(), String> {
        for path in paths {
            let definition: T = read_yaml(&root.join(path))?;
            models.insert(model_key(path), to_model(&definition)?);
        }
        Ok(())
    }

    let mut models = Models::new();
    models.insert("manifest.yaml".to_owned(), to_model(manifest)?);
    read_models::<SceneDefinition>(&mut models, root, &manifest.scenes)?;
    read_models::<UiMotionPreset>(&mut models, root, &manifest.ui_motions)?;
    read_models::<ButtonTemplate>(&mut models, root, &manifest.buttons)?;
    read_models::<ImageAnimationDefinition>(&mut models, root, &manifest.animations)?;
    read_models::<SpriteActionDefinition>(&mut models, root, &manifest.actions)?;
    read_models::<TextBlockDefinition>(&mut models, root, &manifest.text_blocks)?;
    read_models::<ParticleDefinition>(&mut models, root, &manifest.particles)?;
    read_models::<ChapterMapDefinition>(&mut models, root, &manifest.chapter_map)?;
    models.insert(LAYOUT_RELATIVE_PATH.to_owned(), to_model(layout)?);
    Ok(models)
}

/// The models of the documents a request is about to write.
pub(crate) fn document_models_from_request(request: &SaveProjectRequest) -> Result<Models, String> {
    fn request_models<'a, T: Serialize + 'a>(
        models: &mut Models,
        files: impl IntoIterator<Item = &'a EditorFile<T>>,
    ) -> Result<(), String> {
        for file in files {
            models.insert(model_key(&file.path), to_model(&file.definition)?);
        }
        Ok(())
    }

    let mut models = Models::new();
    models.insert("manifest.yaml".to_owned(), to_model(&request.manifest)?);
    request_models(&mut models, &request.scenes)?;
    request_models(&mut models, &request.ui_motions)?;
    request_models(&mut models, &request.buttons)?;
    request_models(&mut models, &request.animations)?;
    request_models(&mut models, &request.actions)?;
    request_models(&mut models, &request.text_blocks)?;
    request_models(&mut models, &request.particles)?;
    request_models(&mut models, &request.chapter_map)?;
    models.insert(LAYOUT_RELATIVE_PATH.to_owned(), to_model(&request.layout)?);
    Ok(models)
}

/// Drop the writes whose `next` model equals the `baseline` model.
pub(crate) fn retain_changed_model_writes(
    root: &Path,
    writes: Vec<(PathBuf, Vec<u8>)>,
    next: &Models,
    baseline: &Models,
) -> Vec<(PathBuf, Vec<u8>)> {
    writes
        .into_iter()
        .filter(|(path, _)| {
            let key = model_key(&path.strip_prefix(root).unwrap_or(path).to_string_lossy());
            !matches!((next.get(&key), baseline.get(&key)), (Some(a), Some(b)) if a == b)
        })
        .collect()
}

// -- editor payloads ------------------------------------------------------

/// Registered assets with their on-disk size and inspected metadata.
/// `published_paths` overrides the reported path of assets whose bytes are
/// still staged: metadata is resolved from the trusted staging path before the
/// transaction, but the formal path the committed project will use after
/// staging is cleaned up is what the editor must see.
fn editor_assets(
    catalog: &ContentCatalog,
    published_paths: &BTreeMap<String, PathBuf>,
) -> Result<Vec<EditorAsset>, String> {
    let resolved = catalog
        .resolve_assets(&catalog.asset_ids())
        .map_err(display_error)?;
    let by_id: BTreeMap<&str, &ResolvedAsset> = resolved
        .iter()
        .map(|asset| (asset.id.as_str(), asset))
        .collect();
    Ok(catalog
        .manifest
        .assets
        .iter()
        .filter_map(|(id, definition)| {
            by_id.get(id.as_str()).map(|asset| EditorAsset {
                id: id.clone(),
                kind: definition.kind,
                path: definition.path.clone(),
                animation: definition.animation.clone(),
                absolute_path: published_paths
                    .get(id)
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_else(|| asset.absolute_path.clone()),
                size_bytes: WireU64::from(
                    fs::metadata(&asset.absolute_path)
                        .map(|metadata| metadata.len())
                        .unwrap_or_default(),
                ),
                metadata: inspect_media_source(Path::new(&asset.absolute_path)).ok(),
            })
        })
        .collect())
}

/// The editor's view of a project as it is on disk.
pub(crate) fn project_payload(
    root: &Path,
    catalog: &ContentCatalog,
    layout: EditorLayout,
    fingerprint: String,
) -> Result<EditorProject, String> {
    let manifest = &catalog.manifest;
    Ok(EditorProject {
        root: root.to_string_lossy().into_owned(),
        manifest: manifest.clone(),
        scenes: read_files(root, &manifest.scenes)?,
        ui_motions: read_files(root, &manifest.ui_motions)?,
        buttons: read_files(root, &manifest.buttons)?,
        animations: read_files(root, &manifest.animations)?,
        actions: read_files(root, &manifest.actions)?,
        text_blocks: read_files(root, &manifest.text_blocks)?,
        particles: read_files(root, &manifest.particles)?,
        chapter_map: read_files(root, manifest.chapter_map.as_slice())?.pop(),
        layout,
        assets: editor_assets(catalog, &BTreeMap::new())?,
        diagnostics: analyze_catalog(catalog),
        fingerprint,
    })
}

/// The editor's view of a project after a save, built from the saved request
/// rather than re-read from disk.
pub(crate) fn project_payload_from_request(
    root: &Path,
    catalog: &ContentCatalog,
    request: &SaveProjectRequest,
    published_asset_paths: &BTreeMap<String, PathBuf>,
    fingerprint: String,
) -> Result<EditorProject, String> {
    Ok(EditorProject {
        root: root.to_string_lossy().into_owned(),
        manifest: request.manifest.clone(),
        scenes: request.scenes.clone(),
        ui_motions: request.ui_motions.clone(),
        buttons: request.buttons.clone(),
        animations: request.animations.clone(),
        actions: request.actions.clone(),
        text_blocks: request.text_blocks.clone(),
        particles: request.particles.clone(),
        chapter_map: request.chapter_map.clone(),
        layout: request.layout.clone(),
        assets: editor_assets(catalog, published_asset_paths)?,
        diagnostics: analyze_catalog(catalog),
        fingerprint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fingerprint::project_fingerprint;
    use crate::layout::read_layout;
    use crate::model::{EditorParticleFile, EditorTextBlockFile};
    use crate::state::ProjectSession;
    use crate::test_support::{
        asset_session, minimal_manifest, seed_asset_project, write_batch, write_test_png,
    };

    fn visual_file<T>(path: &str, definition: T) -> EditorFile<T> {
        EditorFile {
            path: path.to_owned(),
            definition,
        }
    }

    fn visual_save_request(
        root: &Path,
        manifest: ContentManifest,
        text_blocks: Vec<EditorTextBlockFile>,
        particles: Vec<EditorParticleFile>,
    ) -> SaveProjectRequest {
        SaveProjectRequest {
            manifest,
            scenes: vec![EditorSceneFile {
                path: "scenes/main.yaml".to_owned(),
                definition: read_yaml(&root.join("scenes/main.yaml")).unwrap(),
            }],
            ui_motions: Vec::new(),
            buttons: Vec::new(),
            animations: Vec::new(),
            actions: Vec::new(),
            text_blocks,
            particles,
            chapter_map: None,
            layout: EditorLayout::default(),
            expected_fingerprint: String::new(),
            import_tokens: Vec::new(),
        }
    }

    /// The writes a save of `request` would journal against `baseline`.
    fn changed_writes(
        root: &Path,
        request: &SaveProjectRequest,
        baseline: &Models,
    ) -> Vec<(PathBuf, Vec<u8>)> {
        retain_changed_model_writes(
            root,
            serialize_project(root, request).unwrap(),
            &document_models_from_request(request).unwrap(),
            baseline,
        )
    }

    fn paths(writes: &[(PathBuf, Vec<u8>)]) -> Vec<PathBuf> {
        writes.iter().map(|(path, _)| path.clone()).collect()
    }

    fn draft(root: &Path, request: &SaveProjectRequest) -> Result<ContentCatalog, String> {
        draft_catalog(root, request, &BTreeMap::new())
    }

    /// A project with one text block and one particle definition registered.
    fn visual_fixture(
        root: &Path,
    ) -> (
        ProjectSession,
        ContentManifest,
        TextBlockDefinition,
        ParticleDefinition,
    ) {
        seed_asset_project(root);
        write_test_png(&root.join("assets/gui/dot.png"), 8, 8);
        write_test_png(&root.join("assets/gui/huge.png"), 600, 8);
        let session = asset_session(root);
        let mut manifest = session.catalog.manifest.clone();
        for (id, path) in [("dot", "gui/dot.png"), ("huge", "gui/huge.png")] {
            manifest.assets.insert(
                id.to_owned(),
                serde_json::from_value(serde_json::json!({ "kind": "gui", "path": path })).unwrap(),
            );
        }
        manifest.text_blocks = vec!["visuals/texts/label.yaml".to_owned()];
        manifest.particles = vec!["visuals/particles/snow.yaml".to_owned()];
        let text = serde_json::from_value(serde_json::json!({
            "schema_version": 2, "id": "label", "content": "中文 $x^2$", "width": 400, "height": 100,
            "font_size": 24, "line_height": 1.3, "padding": 8, "color": "#FFFFFF",
            "align": "left", "vertical_align": "top", "font": null, "background": null,
        }))
        .unwrap();
        let particle = serde_json::from_value(serde_json::json!({
            "schema_version": 2, "id": "snow", "image": "dot",
            "area": { "type": "rectangle", "width": 400, "height": 100 },
            "rate": 40, "burst_count": 20, "max_particles": 200,
            "lifetime_ms": { "min": 1500, "max": 3000 },
            "velocity_x": { "min": -20, "max": 20 }, "velocity_y": { "min": 30, "max": 80 },
            "gravity_x": 0, "gravity_y": 10, "size": { "min": 0.5, "max": 1 },
            "rotation_deg": { "min": 0, "max": 360 }, "angular_velocity_deg": { "min": -30, "max": 30 },
            "alpha_start": 1, "alpha_end": 0, "blend": "normal", "seed": 17,
        }))
        .unwrap();
        (session, manifest, text, particle)
    }

    #[test]
    fn visual_documents_round_trip_through_the_atomic_save_pipeline() {
        let directory = tempfile::tempdir().unwrap();
        let (session, manifest, text, particle) = visual_fixture(directory.path());
        let root = session.root.clone();
        let request = visual_save_request(
            &root,
            manifest,
            vec![visual_file("visuals/texts/label.yaml", text.clone())],
            vec![visual_file("visuals/particles/snow.yaml", particle.clone())],
        );
        let candidate = draft(&root, &request).unwrap();
        assert!(candidate.text_blocks.contains_key("label"));
        assert!(candidate.particles.contains_key("snow"));

        // The first save publishes both documents with the manifest in one journal.
        let writes = changed_writes(&root, &request, &session.document_models);
        for path in [
            "visuals/texts/label.yaml",
            "visuals/particles/snow.yaml",
            "manifest.yaml",
        ] {
            assert!(
                writes.iter().any(|(target, _)| target == &root.join(path)),
                "{path}"
            );
        }
        let deletes = managed_deletions(&root, &session.catalog.manifest, &request.manifest);
        assert!(deletes.is_empty());
        let before = project_fingerprint(&root, &session.catalog.manifest).unwrap();
        write_batch(&root, &writes, &deletes);
        let reloaded = ContentCatalog::from_root(root.clone()).unwrap();
        assert_eq!(reloaded.particles["snow"], particle);
        assert_eq!(reloaded.text_blocks["label"].content, text.content);
        let saved = project_fingerprint(&root, &reloaded.manifest).unwrap();
        assert_ne!(before, saved);

        // A definition edit rewrites exactly that document.
        let baseline =
            document_models(&root, &reloaded.manifest, &EditorLayout::default()).unwrap();
        let mut edited_text = text.clone();
        edited_text.content = "改动后的文本".to_owned();
        let edited = visual_save_request(
            &root,
            reloaded.manifest.clone(),
            vec![visual_file("visuals/texts/label.yaml", edited_text)],
            vec![visual_file("visuals/particles/snow.yaml", particle)],
        );
        assert_eq!(
            paths(&changed_writes(&root, &edited, &baseline)),
            [root.join("visuals/texts/label.yaml")]
        );

        // Removing a definition deletes its managed file in the same transaction.
        let mut without_particle = reloaded.manifest.clone();
        without_particle.particles.clear();
        assert_eq!(
            managed_deletions(&root, &reloaded.manifest, &without_particle),
            [root.join("visuals/particles/snow.yaml")]
        );

        // An external edit to a visual document makes the session stale.
        fs::write(
            root.join("visuals/texts/label.yaml"),
            b"schema_version: 2\nid: label\ncontent: external\nwidth: 10\nheight: 10\n",
        )
        .unwrap();
        assert_ne!(
            project_fingerprint(&root, &reloaded.manifest).unwrap(),
            saved
        );
    }

    #[test]
    fn unused_scene_text_pins_persist_through_the_atomic_save_and_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let (session, manifest, text, particle) = visual_fixture(directory.path());
        let root = session.root.clone();
        let layout_path = root.join(LAYOUT_RELATIVE_PATH);
        let request_with =
            |manifest: ContentManifest, texts: Vec<EditorTextBlockFile>, pins: &[&str]| {
                let mut request = visual_save_request(
                    &root,
                    manifest,
                    texts,
                    vec![visual_file("visuals/particles/snow.yaml", particle.clone())],
                );
                request
                    .layout
                    .scenes
                    .entry("main".to_owned())
                    .or_default()
                    .text_block_ids = pins.iter().map(|pin| (*pin).to_owned()).collect();
                request
            };
        let label = || vec![visual_file("visuals/texts/label.yaml", text.clone())];

        // `label` is defined but no Sprite uses it yet: only the layout files
        // it under the scene, and the first save publishes that pin.
        let request = request_with(manifest, label(), &["label"]);
        draft(&root, &request).unwrap();
        let writes = changed_writes(&root, &request, &session.document_models);
        let layout_write = writes
            .iter()
            .find(|(target, _)| target == &layout_path)
            .expect("layout is published with the new text");
        assert!(String::from_utf8_lossy(&layout_write.1).contains("text_block_ids"));
        write_batch(&root, &writes, &[]);

        // Reopen: the pin is back and the text document carries no scene data.
        let reopened = read_layout(&root).unwrap();
        assert_eq!(reopened.scenes["main"].text_block_ids, ["label"]);
        let catalog = ContentCatalog::from_root(root.clone()).unwrap();
        assert!(catalog.text_blocks.contains_key("label"));
        let text_yaml = fs::read_to_string(root.join("visuals/texts/label.yaml")).unwrap();
        assert!(!text_yaml.contains("text_block_ids"), "{text_yaml}");

        // Saving the reopened document again rewrites nothing...
        let baseline = document_models(&root, &catalog.manifest, &reopened).unwrap();
        let mut again = request_with(catalog.manifest.clone(), label(), &["label"]);
        again.layout = reopened;
        let unchanged = changed_writes(&root, &again, &baseline);
        assert!(unchanged.is_empty(), "{unchanged:?}");

        // ...and moving only the pin rewrites only the layout file.
        let moved = request_with(catalog.manifest.clone(), label(), &["label", "label_2"]);
        assert_eq!(
            paths(&changed_writes(&root, &moved, &baseline)),
            vec![layout_path.clone()]
        );

        // Deleting the text removes its file and its pin in one transaction.
        let mut without_text = catalog.manifest.clone();
        without_text.text_blocks.clear();
        let removed = request_with(without_text.clone(), Vec::new(), &[]);
        let removal_writes = changed_writes(&root, &removed, &baseline);
        let removal_deletes = managed_deletions(&root, &catalog.manifest, &without_text);
        assert_eq!(removal_deletes, [root.join("visuals/texts/label.yaml")]);
        write_batch(&root, &removal_writes, &removal_deletes);
        assert!(read_layout(&root).unwrap().scenes["main"]
            .text_block_ids
            .is_empty());
        assert!(!fs::read_to_string(&layout_path)
            .unwrap()
            .contains("text_block_ids"));
        assert!(!root.join("visuals/texts/label.yaml").exists());
    }

    #[test]
    fn draft_validation_rejects_mismatched_sets_and_invalid_definitions() {
        let directory = tempfile::tempdir().unwrap();
        let (session, manifest, text, particle) = visual_fixture(directory.path());
        let root = session.root.clone();
        let rejection =
            |text: TextBlockDefinition, particle: ParticleDefinition, text_path: &str| {
                let request = visual_save_request(
                    &root,
                    manifest.clone(),
                    vec![visual_file(text_path, text)],
                    vec![visual_file("visuals/particles/snow.yaml", particle)],
                );
                draft(&root, &request).unwrap_err()
            };
        let label = "visuals/texts/label.yaml";

        let mismatched = rejection(text.clone(), particle.clone(), "visuals/texts/other.yaml");
        assert!(mismatched.contains("manifest"), "{mismatched}");

        let mut huge = particle.clone();
        huge.image = "huge".to_owned();
        let oversized = rejection(text.clone(), huge, label);
        assert!(oversized.contains("512"), "{oversized}");

        let mut colliding = particle.clone();
        colliding.id = "dot".to_owned();
        let collision = rejection(text.clone(), colliding, label);
        assert!(collision.contains("冲突"), "{collision}");

        let mut wrong_font = text;
        wrong_font.font = Some("dot".to_owned());
        let font = rejection(wrong_font, particle, label);
        assert!(font.contains("字体"), "{font}");
    }

    #[test]
    fn replacing_or_removing_an_asset_never_queues_its_binary_for_deletion() {
        let root = Path::new("project");
        let previous = minimal_manifest();
        let mut replaced = previous.clone();
        replaced.assets.get_mut("bg.room").unwrap().path =
            Some("backgrounds/room_v2.png".to_owned());
        let mut removed = previous.clone();
        removed.assets.remove("bg.room");
        assert!(managed_deletions(root, &previous, &replaced).is_empty());
        assert!(managed_deletions(root, &previous, &removed).is_empty());
    }
}
