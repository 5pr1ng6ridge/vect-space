use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::fs;

use schemars::schema_for;
use super::visuals;

use crate::model::{
    AssetDefinition, ButtonTemplate, ChapterMapDefinition, ContentManifest,
    ImageAnimationDefinition, ResolvedAnimation, ResolvedAnimationFrame, ResolvedAsset,
    SceneDefinition, SpriteActionDefinition, UiMotionPreset,
};
use crate::visual::{ParticleDefinition, SpriteSource, TextBlockDefinition};
use super::{CONTENT_SCHEMA_VERSION, ContentError};
use super::animation::{
    load_actions, load_animations, validate_action_files, validate_action_namespace,
    validate_animation_files, validate_animations,
};
use super::chapter_map::{load_chapter_map, validate_chapter_map};
use super::common::{
    canonical_directory, canonical_file_within, canonical_staged_asset, read_yaml,
    validate_identifier, validate_relative_path,
};
use super::manifest::{
    validate_assets, validate_character_definitions, validate_default_font, validate_manifest_paths,
    validate_variable_definitions,
};
use super::scenes::validate_scenes;
use super::ui::{
    load_buttons, load_ui_motions, validate_all_button_assets, validate_button_files,
    validate_ui_motion_bindings, validate_ui_motion_files,
};

#[derive(Debug)]
pub struct ContentCatalog {
    assets_root: PathBuf,
    /// Trusted host supplied paths for assets that only exist in an editor
    /// import staging directory.  This never comes from the WebView.
    asset_overrides: BTreeMap<String, PathBuf>,
    pub manifest: ContentManifest,
    pub scenes: BTreeMap<String, SceneDefinition>,
    pub ui_motions: BTreeMap<String, UiMotionPreset>,
    pub buttons: BTreeMap<String, ButtonTemplate>,
    pub chapter_map: Option<ChapterMapDefinition>,
    /// Validated loop animation documents, keyed by animation id.
    pub animations: BTreeMap<String, ImageAnimationDefinition>,
    /// Validated reusable sprite actions, keyed by action id.
    pub actions: BTreeMap<String, SpriteActionDefinition>,
    pub text_blocks: BTreeMap<String, TextBlockDefinition>,
    pub particles: BTreeMap<String, ParticleDefinition>,
    pub proofs: vectspace_proof::library::ProofLibrary,
    /// Geometry measured once while the catalog was built.  The shared image
    /// resolver needs a stable layout size per animation so switching frames
    /// can never move or resize an object, and re-probing headers on every
    /// resolve would repeat the same I/O for no benefit.
    animation_metrics: BTreeMap<String, AnimationMetrics>,
}

/// Measured geometry of one animation.  Derived, never author-written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnimationMetrics {
    pub width: u32,
    pub height: u32,
    /// Decoded RGBA footprint of the animation's unique frame images.
    pub decoded_bytes: u64,
}

impl ContentCatalog {
    pub fn from_root(root: PathBuf) -> Result<Self, ContentError> {
        let root = canonical_directory(&root)?;
        let manifest_path = root.join("manifest.yaml");
        let manifest: ContentManifest = read_yaml(&manifest_path)?;
        if manifest.schema_version != CONTENT_SCHEMA_VERSION {
            return Err(ContentError::Validation(format!(
                "不支持 manifest schema_version {}",
                manifest.schema_version
            )));
        }
        validate_manifest_paths(&manifest)?;
        validate_identifier("entry_scene", &manifest.entry_scene)?;
        validate_variable_definitions(&manifest.variables)?;
        validate_character_definitions(&manifest.characters, &manifest.assets)?;

        let assets_root = canonical_directory(&root.join("assets"))?;
        validate_assets(&assets_root, &manifest.assets, &BTreeMap::new())?;
        validate_default_font(&manifest)?;

        let animations = load_animations(&root, &manifest.animations)?;
        let animation_metrics = validate_animations(
            &animations,
            &manifest.assets,
            &assets_root,
            &BTreeMap::new(),
        )?;
        let actions = load_actions(&root, &manifest.actions)?;
        validate_action_namespace(&actions, &manifest.assets, &animations)?;
        let text_blocks = visuals::documents(&root, &manifest.text_blocks, None, |value: &TextBlockDefinition| &value.id)?;
        let proofs = super::proofs::load(&root, &manifest.proofs)?;
        let particles = visuals::documents(&root, &manifest.particles, None, |value: &ParticleDefinition| &value.id)?;
        visuals::validate_documents(&manifest, &text_blocks, &particles, &assets_root, &BTreeMap::new(), &animations, &actions)?;

        let ui_motions = load_ui_motions(&root, &manifest.ui_motions)?;
        validate_ui_motion_bindings(&manifest.ui_motion_defaults, &ui_motions)?;
        let buttons = load_buttons(&root, &manifest.buttons)?;
        validate_all_button_assets(&buttons, &manifest.assets)?;

        let mut scenes = BTreeMap::new();
        for scene_path in &manifest.scenes {
            let relative = validate_relative_path(scene_path)?;
            let full_path = canonical_file_within(&root, &root.join(relative))?;
            let scene: SceneDefinition = read_yaml(&full_path)?;
            if scene.schema_version != CONTENT_SCHEMA_VERSION {
                return Err(ContentError::Validation(format!(
                    "场景 {} 使用了不支持的 schema_version {}",
                    scene.id, scene.schema_version
                )));
            }
            validate_identifier("scene id", &scene.id)?;
            if scenes.insert(scene.id.clone(), scene).is_some() {
                return Err(ContentError::Validation(format!(
                    "场景 ID 重复: {}",
                    scene_path
                )));
            }
        }

        if !scenes.contains_key(&manifest.entry_scene) {
            return Err(ContentError::Validation(format!(
                "入口场景不存在: {}",
                manifest.entry_scene
            )));
        }
        if scenes.get(&manifest.entry_scene).is_some_and(|scene| scene.window_role != crate::interaction::WindowRole::Main) {
            return Err(ContentError::Validation("项目入口必须是主窗口 Scene".to_owned()));
        }
        if manifest.variables.keys().any(|id| crate::interaction::is_window_variable(id)) {
            return Err(ContentError::Validation("窗口标题变量是保留的只读变量".to_owned()));
        }
        validate_scenes(
            &scenes,
            &manifest.assets,
            &manifest.variables,
            &manifest.characters,
            &ui_motions,
            &buttons,
            &actions,
            &proofs,
        )?;
        visuals::validate_scenes(&scenes, &manifest.assets, &text_blocks, &particles)?;
        let chapter_map = load_chapter_map(
            &root,
            manifest.chapter_map.as_deref(),
            &scenes,
            &manifest.assets,
            &manifest.variables,
        )?;

        Ok(Self {
            assets_root,
            asset_overrides: BTreeMap::new(),
            manifest,
            scenes,
            ui_motions,
            buttons,
            chapter_map,
            animations,
            actions,
            text_blocks,
            particles,
            proofs,
            animation_metrics,
        })
    }

    /// Builds and validates a catalog from an in-memory editor document while
    /// still resolving assets against the real project root. The visual editor
    /// uses this before replacing any YAML files, so invalid graph edits never
    /// reach the on-disk project.
    pub fn from_documents(
        root: PathBuf,
        manifest: ContentManifest,
        scenes: BTreeMap<String, SceneDefinition>,
        ui_motion_files: BTreeMap<String, UiMotionPreset>,
    ) -> Result<Self, ContentError> {
        let chapter_map = if manifest.chapter_map.is_some() {
            load_chapter_map(
                &root,
                manifest.chapter_map.as_deref(),
                &scenes,
                &manifest.assets,
                &manifest.variables,
            )?
        } else {
            None
        };
        Self::from_documents_with_chapter_map(root, manifest, scenes, ui_motion_files, chapter_map)
    }

    /// In-memory project construction with an explicit (optional) room map.
    pub fn from_documents_with_chapter_map(
        root: PathBuf,
        manifest: ContentManifest,
        scenes: BTreeMap<String, SceneDefinition>,
        ui_motion_files: BTreeMap<String, UiMotionPreset>,
        chapter_map: Option<ChapterMapDefinition>,
    ) -> Result<Self, ContentError> {
        Self::from_documents_with_all_documents(
            root,
            manifest,
            scenes,
            ui_motion_files,
            chapter_map,
            &BTreeMap::new(),
            None,
            None,
            None,
        )
    }

    /// Deepest in-memory constructor.  Every optional document family can be
    /// supplied as an unsaved editor draft; `None` loads whatever the manifest
    /// references from the trusted project root instead.  `asset_overrides`
    /// lets trusted host code supply paths for newly staged assets; they are
    /// only used for validation and resolution and are never accepted from the
    /// WebView directly.
    #[allow(clippy::too_many_arguments)]
    pub fn from_documents_with_all_documents(
        root: PathBuf,
        manifest: ContentManifest,
        scenes: BTreeMap<String, SceneDefinition>,
        ui_motion_files: BTreeMap<String, UiMotionPreset>,
        chapter_map: Option<ChapterMapDefinition>,
        asset_overrides: &BTreeMap<String, PathBuf>,
        button_files: Option<BTreeMap<String, ButtonTemplate>>,
        animation_files: Option<BTreeMap<String, ImageAnimationDefinition>>,
        action_files: Option<BTreeMap<String, SpriteActionDefinition>>,
    ) -> Result<Self, ContentError> {
        Self::from_documents_with_visuals(root, manifest, scenes, ui_motion_files, chapter_map, asset_overrides, button_files, animation_files, action_files, None, None)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn from_documents_with_visuals(
        root: PathBuf, manifest: ContentManifest, scenes: BTreeMap<String, SceneDefinition>,
        ui_motion_files: BTreeMap<String, UiMotionPreset>, chapter_map: Option<ChapterMapDefinition>,
        asset_overrides: &BTreeMap<String, PathBuf>, button_files: Option<BTreeMap<String, ButtonTemplate>>,
        animation_files: Option<BTreeMap<String, ImageAnimationDefinition>>,
        action_files: Option<BTreeMap<String, SpriteActionDefinition>>,
        text_files: Option<BTreeMap<String, TextBlockDefinition>>,
        particle_files: Option<BTreeMap<String, ParticleDefinition>>,
    ) -> Result<Self, ContentError> {
        let root = canonical_directory(&root)?;
        if manifest.schema_version != CONTENT_SCHEMA_VERSION {
            return Err(ContentError::Validation(format!(
                "不支持 manifest schema_version {}",
                manifest.schema_version
            )));
        }
        validate_manifest_paths(&manifest)?;
        validate_identifier("entry_scene", &manifest.entry_scene)?;
        validate_variable_definitions(&manifest.variables)?;
        validate_character_definitions(&manifest.characters, &manifest.assets)?;

        let assets_root = canonical_directory(&root.join("assets"))?;
        validate_assets(&assets_root, &manifest.assets, asset_overrides)?;
        validate_default_font(&manifest)?;
        let ui_motions = validate_ui_motion_files(&manifest.ui_motions, &ui_motion_files)?;
        validate_ui_motion_bindings(&manifest.ui_motion_defaults, &ui_motions)?;
        let buttons = if let Some(button_files) = button_files {
            validate_button_files(&manifest.buttons, &button_files)?
        } else if manifest.buttons.is_empty() {
            BTreeMap::new()
        } else {
            // Existing callers predate button documents. Load them from the
            // trusted project root; the editor uses the extended constructor
            // below when it has unsaved button drafts in memory.
            load_buttons(&root, &manifest.buttons)?
        };
        validate_all_button_assets(&buttons, &manifest.assets)?;
        // Animation documents are validated against the asset table rather
        // than the scene graph: a frame is legal exactly when it names a
        // registered static image asset, no matter where the animation is
        // later used.
        let animations = match animation_files {
            Some(files) => validate_animation_files(&manifest.animations, &files)?,
            None if manifest.animations.is_empty() => BTreeMap::new(),
            None => load_animations(&root, &manifest.animations)?,
        };
        let animation_metrics =
            validate_animations(&animations, &manifest.assets, &assets_root, asset_overrides)?;
        let actions = match action_files {
            Some(files) => validate_action_files(&manifest.actions, &files)?,
            None if manifest.actions.is_empty() => BTreeMap::new(),
            None => load_actions(&root, &manifest.actions)?,
        };
        validate_action_namespace(&actions, &manifest.assets, &animations)?;
        let text_blocks = visuals::documents(&root, &manifest.text_blocks, text_files, |value: &TextBlockDefinition| &value.id)?;
        let proofs = super::proofs::load(&root, &manifest.proofs)?;
        let particles = visuals::documents(&root, &manifest.particles, particle_files, |value: &ParticleDefinition| &value.id)?;
        visuals::validate_documents(&manifest, &text_blocks, &particles, &assets_root, asset_overrides, &animations, &actions)?;
        visuals::validate_scenes(&scenes, &manifest.assets, &text_blocks, &particles)?;

        for (scene_id, scene) in &scenes {
            if scene.schema_version != CONTENT_SCHEMA_VERSION {
                return Err(ContentError::Validation(format!(
                    "场景 {} 使用了不支持的 schema_version {}",
                    scene.id, scene.schema_version
                )));
            }
            validate_identifier("scene id", &scene.id)?;
            if scene_id != &scene.id {
                return Err(ContentError::Validation(format!(
                    "场景索引 {scene_id} 与场景 ID {} 不一致",
                    scene.id
                )));
            }
        }
        if !scenes.contains_key(&manifest.entry_scene) {
            return Err(ContentError::Validation(format!(
                "入口场景不存在: {}",
                manifest.entry_scene
            )));
        }
        if scenes.get(&manifest.entry_scene).is_some_and(|scene| scene.window_role != crate::interaction::WindowRole::Main) {
            return Err(ContentError::Validation("项目入口必须是主窗口 Scene".to_owned()));
        }
        if manifest.variables.keys().any(|id| crate::interaction::is_window_variable(id)) {
            return Err(ContentError::Validation("窗口标题变量是保留的只读变量".to_owned()));
        }
        validate_scenes(
            &scenes,
            &manifest.assets,
            &manifest.variables,
            &manifest.characters,
            &ui_motions,
            &buttons,
            &actions,
            &proofs,
        )?;
        if manifest.chapter_map.is_some() != chapter_map.is_some() {
            return Err(ContentError::Validation(
                "manifest 的 chapter_map 与编辑器文档不一致".to_owned(),
            ));
        }
        if let Some(map) = &chapter_map {
            validate_chapter_map(map, &scenes, &manifest.assets, &manifest.variables)?;
        }

        Ok(Self {
            assets_root,
            asset_overrides: asset_overrides.clone(),
            manifest,
            scenes,
            ui_motions,
            buttons,
            chapter_map,
            animations,
            actions,
            text_blocks,
            particles,
            proofs,
            animation_metrics,
        })
    }

    pub fn validate_sprite_source(&self, source: &SpriteSource) -> Result<(), ContentError> {
        visuals::source(source, &self.manifest.assets, &self.text_blocks)
    }

    pub fn assets_root(&self) -> &Path {
        &self.assets_root
    }

    /// Drop trusted editor-only asset overrides after an authoring transaction
    /// has published the staged files into the project's formal `assets/`
    /// tree.  The catalog has already been fully validated at this point, so
    /// rebasing the resolver is infallible and does not need to touch disk.
    pub fn into_published(mut self) -> Self {
        self.asset_overrides.clear();
        self
    }

    pub fn scene(&self, id: &str) -> Result<&SceneDefinition, ContentError> {
        self.scenes
            .get(id)
            .ok_or_else(|| ContentError::Validation(format!("未知场景: {id}")))
    }

    pub fn asset_ids(&self) -> Vec<String> {
        self.manifest.assets.keys().cloned().collect()
    }

    pub fn resolve_assets(&self, ids: &[String]) -> Result<Vec<ResolvedAsset>, ContentError> {
        let mut unique = BTreeSet::new();
        let mut resolved = Vec::with_capacity(ids.len());
        for id in ids {
            if !unique.insert(id) {
                continue;
            }
            let definition = self.manifest.assets.get(id).ok_or_else(|| {
                ContentError::Validation(format!("素材未登记或素材 ID 未知: {id}"))
            })?;
            match &definition.animation {
                // Static asset: exactly the historical payload plus an
                // explicit `animation: None`.
                None => {
                    let path = self.resolve_asset_path(id, definition)?;
                    resolved.push(ResolvedAsset {
                        id: id.clone(),
                        kind: definition.kind,
                        absolute_path: path.to_string_lossy().into_owned(),
                        animation: None,
                    });
                }
                Some(animation_id) => {
                    let animation = self.animations.get(animation_id).ok_or_else(|| {
                        ContentError::Validation(format!(
                            "素材 {id} 引用了未登记的图片动画 {animation_id}"
                        ))
                    })?;
                    let metrics = self.animation_metrics.get(animation_id).ok_or_else(|| {
                        ContentError::Validation(format!(
                            "图片动画 {animation_id} 缺少已验证的帧几何"
                        ))
                    })?;
                    let mut frames = Vec::with_capacity(animation.frames.len());
                    for frame in &animation.frames {
                        let frame_definition =
                            self.manifest.assets.get(&frame.asset).ok_or_else(|| {
                                ContentError::Validation(format!(
                                    "图片动画 {animation_id} 引用了未登记的素材 {}",
                                    frame.asset
                                ))
                            })?;
                        let path = self.resolve_asset_path(&frame.asset, frame_definition)?;
                        frames.push(ResolvedAnimationFrame {
                            asset: frame.asset.clone(),
                            duration_ms: frame.duration_ms,
                            absolute_path: path.to_string_lossy().into_owned(),
                        });
                    }
                    // `absolute_path` names the first frame so single-image
                    // consumers (URL maps, thumbnails) still show real pixels.
                    let absolute_path = frames
                        .first()
                        .map(|frame| frame.absolute_path.clone())
                        .ok_or_else(|| {
                            ContentError::Validation(format!("图片动画 {animation_id} 没有任何帧"))
                        })?;
                    resolved.push(ResolvedAsset {
                        id: id.clone(),
                        kind: definition.kind,
                        absolute_path,
                        animation: Some(ResolvedAnimation {
                            id: animation_id.clone(),
                            width: metrics.width,
                            height: metrics.height,
                            total_duration_ms: animation.total_duration_ms(),
                            frames,
                        }),
                    });
                }
            }
        }
        Ok(resolved)
    }

    /// Animations that use `asset_id` as one of their frames.  The editor uses
    /// this to block deleting an image that an animation still references.
    pub fn animations_referencing(&self, asset_id: &str) -> Vec<String> {
        self.animations
            .iter()
            .filter(|(_, animation)| animation.frame_assets().contains(asset_id))
            .map(|(id, _)| id.clone())
            .collect()
    }

    fn resolve_asset_path(
        &self,
        id: &str,
        definition: &AssetDefinition,
    ) -> Result<PathBuf, ContentError> {
        let relative = definition
            .path
            .as_deref()
            .ok_or_else(|| ContentError::Validation(format!("素材 {id} 没有静态图片路径")))?;
        let relative = validate_relative_path(relative)?;
        match self.asset_overrides.get(id) {
            Some(override_path) => canonical_staged_asset(override_path),
            None => canonical_file_within(&self.assets_root, &self.assets_root.join(relative)),
        }
    }

    pub fn write_schemas(&self, target: &Path) -> Result<(), ContentError> {
        fs::create_dir_all(target).map_err(|source| ContentError::Read {
            path: target.to_path_buf(),
            source,
        })?;
        write_schema(
            &target.join("manifest.schema.json"),
            &schema_for!(ContentManifest),
        )?;
        write_schema(
            &target.join("chapter-map.schema.json"),
            &schema_for!(ChapterMapDefinition),
        )?;
        write_schema(
            &target.join("scene.schema.json"),
            &schema_for!(SceneDefinition),
        )?;
        write_schema(
            &target.join("ui-motion.schema.json"),
            &schema_for!(UiMotionPreset),
        )?;
        write_schema(
            &target.join("button.schema.json"),
            &schema_for!(ButtonTemplate),
        )?;
        write_schema(
            &target.join("image-animation.schema.json"),
            &schema_for!(ImageAnimationDefinition),
        )?;
        write_schema(
            &target.join("sprite-action.schema.json"),
            &schema_for!(SpriteActionDefinition),
        )?;
        write_schema(&target.join("text-block.schema.json"), &schema_for!(TextBlockDefinition))?;
        write_schema(&target.join("particle.schema.json"), &schema_for!(ParticleDefinition))?;
        write_schema(&target.join("proof.schema.json"), &schema_for!(vectspace_proof::model::ProofDocument))?;
        Ok(())
    }
}

fn write_schema(path: &Path, schema: &impl serde::Serialize) -> Result<(), ContentError> {
    let bytes = serde_json::to_vec_pretty(schema)
        .map_err(|error| ContentError::Validation(format!("JSON Schema 生成失败: {error}")))?;
    fs::write(path, bytes).map_err(|source| ContentError::Read {
        path: path.to_path_buf(),
        source,
    })
}
