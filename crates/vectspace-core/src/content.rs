use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

use schemars::schema_for;
use thiserror::Error;

use crate::image_header::{probe, ImageSize};
use crate::model::{
    AssetDefinition, AssetKind, AudioAction, BackgroundTransitionSpec, ButtonClickAction,
    ButtonPanel, ButtonPostAction, ButtonTemplate, ChapterMapDefinition, ChapterMapReveal,
    CharacterDefinition, CharacterExpression, ConditionExpression, ContentManifest, CurtainAction,
    CurtainFill, DialogueMode, ImageAnimationDefinition, LongTextMode, LongTextPagination,
    MutationValue, ResolvedAnimation, ResolvedAnimationFrame, ResolvedAsset, ScalarValue,
    SceneDefinition, SceneNode, ScreenEffectSpec, SpriteAction, SpriteActionDefinition,
    TimelineChannels, TimelineEasing, TimelineEvent, TimelineTrack, UiMotionBindings,
    UiMotionPreset, ValueOperand, VariableDefinition, VariableOperation, VariableScope,
    VariableType, FLASH_PEAK_ALPHA_MAX, FLASH_PEAK_ALPHA_MIN, IMAGE_ANIMATION_MAX_DECODED_BYTES,
    IMAGE_ANIMATION_MAX_EDGE, IMAGE_ANIMATION_MAX_FRAMES, IMAGE_ANIMATION_MAX_FRAME_MS,
    IMAGE_ANIMATION_MIN_FRAME_MS, IMAGE_ANIMATION_SCHEMA_VERSION, LONG_TEXT_FONT_SIZE_MAX,
    LONG_TEXT_FONT_SIZE_MIN, SHAKE_AMPLITUDE_MAX, SHAKE_DECAY_MAX, SHAKE_DECAY_MIN,
    SHAKE_FREQUENCY_HZ_MAX, SHAKE_FREQUENCY_HZ_MIN, SPRITE_ACTION_SCHEMA_VERSION,
    TRANSITION_SOFTNESS_MAX,
};
use crate::text_template::{self, MAX_VARIABLE_STRING_BYTES};

const CONTENT_SCHEMA_VERSION: u32 = 2;
const MAX_CONDITION_DEPTH: usize = 32;
const MAX_CONDITION_NODES: usize = 256;
const MAX_TIMELINE_DURATION_MS: u64 = 30 * 60 * 1_000;
const MAX_TIMELINE_TRACKS: usize = 64;
const MAX_TIMELINE_KEYFRAMES: usize = 10_000;
const MAX_TIMELINE_EVENTS: usize = 2_048;
const MAX_LONG_TEXT_STEPS: usize = 1_024;
const UI_MOTION_SCHEMA_VERSION: u32 = 1;
const CHAPTER_MAP_SCHEMA_VERSION: u32 = 1;
const BUTTON_SCHEMA_VERSION: u32 = 1;
const ACTION_MAX_PARAMETERS: usize = 32;
const ACTION_MAX_CHANNELS: usize = 16;
const ACTION_MAX_KEYFRAMES: usize = 2_048;
const CHAPTER_MAP_MIN_WIDTH: u32 = 1920;
const CHAPTER_MAP_MIN_HEIGHT: u32 = 1080;
const CHAPTER_MAP_MAX_SIZE: u32 = 16_380;
const CHAPTER_MAP_GRID: i32 = 20;
const MAX_CHAPTER_MAP_HOVER_TEXT_CHARS: usize = 256;

#[derive(Debug, Error)]
pub enum ContentError {
    #[error("无法读取内容文件 {path}: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("YAML 格式错误 {path}: {message}")]
    Yaml { path: PathBuf, message: String },
    #[error("内容校验失败: {0}")]
    Validation(String),
}

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
        validate_scenes(
            &scenes,
            &manifest.assets,
            &manifest.variables,
            &manifest.characters,
            &ui_motions,
            &buttons,
            &actions,
        )?;
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
            animation_metrics,
        })
    }

    /// Builds and validates a catalog from an in-memory editor document while
    /// still resolving assets against the real project root. The visual editor
    /// uses this before replacing any YAML files, so invalid graph edits never
    /// reach the on-disk project.
    #[allow(dead_code)]
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

    /// In-memory project construction with an optional room map.  The
    /// compatibility wrapper above keeps existing editor/test callers that do
    /// not model the map source compatible.
    pub fn from_documents_with_chapter_map(
        root: PathBuf,
        manifest: ContentManifest,
        scenes: BTreeMap<String, SceneDefinition>,
        ui_motion_files: BTreeMap<String, UiMotionPreset>,
        chapter_map: Option<ChapterMapDefinition>,
    ) -> Result<Self, ContentError> {
        Self::from_documents_with_chapter_map_and_asset_overrides(
            root,
            manifest,
            scenes,
            ui_motion_files,
            chapter_map,
            &BTreeMap::new(),
        )
    }

    /// Builds an in-memory catalog while allowing trusted host code to supply
    /// paths for newly staged assets.  The paths are only used for validation
    /// and resolution; they are never accepted from the WebView directly.
    pub fn from_documents_with_chapter_map_and_asset_overrides(
        root: PathBuf,
        manifest: ContentManifest,
        scenes: BTreeMap<String, SceneDefinition>,
        ui_motion_files: BTreeMap<String, UiMotionPreset>,
        chapter_map: Option<ChapterMapDefinition>,
        asset_overrides: &BTreeMap<String, PathBuf>,
    ) -> Result<Self, ContentError> {
        Self::from_documents_with_chapter_map_and_asset_overrides_and_buttons(
            root,
            manifest,
            scenes,
            ui_motion_files,
            chapter_map,
            asset_overrides,
            None,
        )
    }

    /// Editor variant that validates unsaved button template documents from
    /// memory while keeping the same trusted asset overlay rules.
    #[allow(clippy::too_many_arguments)]
    pub fn from_documents_with_chapter_map_and_asset_overrides_and_buttons(
        root: PathBuf,
        manifest: ContentManifest,
        scenes: BTreeMap<String, SceneDefinition>,
        ui_motion_files: BTreeMap<String, UiMotionPreset>,
        chapter_map: Option<ChapterMapDefinition>,
        asset_overrides: &BTreeMap<String, PathBuf>,
        button_files: Option<BTreeMap<String, ButtonTemplate>>,
    ) -> Result<Self, ContentError> {
        Self::from_documents_with_all_documents(
            root,
            manifest,
            scenes,
            ui_motion_files,
            chapter_map,
            asset_overrides,
            button_files,
            None,
        )
    }

    /// Deepest in-memory constructor.  Every optional document family can be
    /// supplied as an unsaved editor draft; `None` loads whatever the manifest
    /// references from the trusted project root instead.
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
    ) -> Result<Self, ContentError> {
        Self::from_documents_with_all_documents_and_actions(
            root,
            manifest,
            scenes,
            ui_motion_files,
            chapter_map,
            asset_overrides,
            button_files,
            animation_files,
            None,
        )
    }

    /// Deepest in-memory constructor, including unsaved reusable action
    /// documents.  The previous constructor remains as a compatibility
    /// wrapper for callers that do not model actions yet.
    #[allow(clippy::too_many_arguments)]
    pub fn from_documents_with_all_documents_and_actions(
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
        validate_scenes(
            &scenes,
            &manifest.assets,
            &manifest.variables,
            &manifest.characters,
            &ui_motions,
            &buttons,
            &actions,
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
            animation_metrics,
        })
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
                    // The legacy `absolute_path` keeps naming a real image so
                    // hosts that only understand a single path still show the
                    // first frame instead of failing.
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

fn read_yaml<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, ContentError> {
    let text = fs::read_to_string(path).map_err(|source| ContentError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    let options = serde_saphyr::options! {
        strict_booleans: true,
    };
    serde_saphyr::from_str_with_options(&text, options).map_err(|error| ContentError::Yaml {
        path: path.to_path_buf(),
        message: error.to_string(),
    })
}

fn load_ui_motions(
    root: &Path,
    paths: &[String],
) -> Result<BTreeMap<String, UiMotionPreset>, ContentError> {
    let mut files = BTreeMap::new();
    for path in paths {
        let relative = validate_relative_path(path)?;
        let full_path = canonical_file_within(root, &root.join(relative))?;
        files.insert(path.clone(), read_yaml(&full_path)?);
    }
    validate_ui_motion_files(paths, &files)
}

fn load_buttons(
    root: &Path,
    paths: &[String],
) -> Result<BTreeMap<String, ButtonTemplate>, ContentError> {
    let mut files = BTreeMap::new();
    for path in paths {
        let relative = validate_relative_path(path)?;
        let full_path = canonical_file_within(root, &root.join(relative))?;
        files.insert(path.clone(), read_yaml(&full_path)?);
    }
    validate_button_files(paths, &files)
}

fn validate_button_files(
    paths: &[String],
    files: &BTreeMap<String, ButtonTemplate>,
) -> Result<BTreeMap<String, ButtonTemplate>, ContentError> {
    let expected = paths.iter().cloned().collect::<BTreeSet<_>>();
    let actual = files.keys().cloned().collect::<BTreeSet<_>>();
    if expected != actual {
        return Err(ContentError::Validation(
            "按钮模板文件集合与 manifest 不一致".to_owned(),
        ));
    }
    let mut result = BTreeMap::new();
    for (path, template) in files {
        validate_relative_path(path)?;
        validate_button_template(template)?;
        if result
            .insert(template.id.clone(), template.clone())
            .is_some()
        {
            return Err(ContentError::Validation(format!(
                "按钮模板 ID 重复: {}",
                template.id
            )));
        }
    }
    Ok(result)
}

fn validate_button_template(template: &ButtonTemplate) -> Result<(), ContentError> {
    if template.schema_version != BUTTON_SCHEMA_VERSION {
        return Err(ContentError::Validation(format!(
            "按钮模板 {} 使用了不支持的 schema_version {}",
            template.id, template.schema_version
        )));
    }
    validate_identifier("button template id", &template.id)?;
    if !template.width.is_finite()
        || !template.height.is_finite()
        || template.width <= 0.0
        || template.height <= 0.0
    {
        return Err(ContentError::Validation(format!(
            "按钮模板 {} 的默认尺寸必须是有限正数",
            template.id
        )));
    }
    // The same visual asset can be used in all three states.  Asset kind and
    // existence are checked when scene references are validated.
    for (state, animation) in [
        ("normal", &template.animations.normal),
        ("hover", &template.animations.hover),
        ("pressed", &template.animations.pressed),
    ] {
        if let Some(animation) = animation {
            if animation.duration_ms == 0 || animation.duration_ms > MAX_TIMELINE_DURATION_MS {
                return Err(ContentError::Validation(format!(
                    "按钮模板 {} 的 {state} 动画时长无效",
                    template.id
                )));
            }
            let mut count = 0;
            validate_timeline_channels(
                &animation.channels,
                &[
                    "offset_x",
                    "offset_y",
                    "scale_x",
                    "scale_y",
                    "rotation_deg",
                    "opacity",
                ],
                animation.duration_ms,
                "button_animation",
                &template.id,
                &mut count,
                false,
            )?;
        }
    }
    Ok(())
}

fn load_chapter_map(
    root: &Path,
    path: Option<&str>,
    scenes: &BTreeMap<String, SceneDefinition>,
    assets: &BTreeMap<String, AssetDefinition>,
    variables: &BTreeMap<String, VariableDefinition>,
) -> Result<Option<ChapterMapDefinition>, ContentError> {
    let Some(path) = path else { return Ok(None) };
    let relative = validate_relative_path(path)?;
    let full_path = canonical_file_within(root, &root.join(relative))?;
    let map: ChapterMapDefinition = read_yaml(&full_path)?;
    validate_chapter_map(&map, scenes, assets, variables)?;
    Ok(Some(map))
}

fn validate_chapter_map(
    map: &ChapterMapDefinition,
    scenes: &BTreeMap<String, SceneDefinition>,
    assets: &BTreeMap<String, AssetDefinition>,
    variables: &BTreeMap<String, VariableDefinition>,
) -> Result<(), ContentError> {
    if map.schema_version != CHAPTER_MAP_SCHEMA_VERSION {
        return Err(ContentError::Validation(format!(
            "不支持 chapter map schema_version {}",
            map.schema_version
        )));
    }
    if !(CHAPTER_MAP_MIN_WIDTH..=CHAPTER_MAP_MAX_SIZE).contains(&map.width)
        || !(CHAPTER_MAP_MIN_HEIGHT..=CHAPTER_MAP_MAX_SIZE).contains(&map.height)
    {
        return Err(ContentError::Validation(format!(
            "地图尺寸宽度必须在 {CHAPTER_MAP_MIN_WIDTH} 到 {CHAPTER_MAP_MAX_SIZE} 之间，高度必须在 {CHAPTER_MAP_MIN_HEIGHT} 到 {CHAPTER_MAP_MAX_SIZE} 之间"
        )));
    }
    if !map.width.is_multiple_of(CHAPTER_MAP_GRID as u32)
        || !map.height.is_multiple_of(CHAPTER_MAP_GRID as u32)
    {
        return Err(ContentError::Validation(
            "地图宽高必须吸附到 20px 网格".to_owned(),
        ));
    }
    let valid_view_x = valid_map_view_center(map.view_x, map.width, 1920);
    let valid_view_y = valid_map_view_center(map.view_y, map.height, 1080);
    if !valid_view_x || !valid_view_y {
        return Err(ContentError::Validation(
            "地图初始视图中心超出 1920×1080 视口边界".to_owned(),
        ));
    }
    if map.view_x.rem_euclid(CHAPTER_MAP_GRID) != 0 || map.view_y.rem_euclid(CHAPTER_MAP_GRID) != 0
    {
        return Err(ContentError::Validation(
            "地图初始视图中心必须吸附到 20px 网格".to_owned(),
        ));
    }
    if let Some(background) = &map.background {
        validate_map_asset(background, assets, AssetKind::Background, "地图背景")?;
    }
    let mut ids = BTreeSet::new();
    for decoration in &map.decorations {
        validate_identifier("地图装饰 ID", &decoration.id)?;
        if !ids.insert(&decoration.id) {
            return Err(ContentError::Validation(format!(
                "地图对象 ID 重复: {}",
                decoration.id
            )));
        }
        validate_map_asset(&decoration.asset, assets, AssetKind::Gui, "地图装饰").or_else(
            |_| validate_map_asset(&decoration.asset, assets, AssetKind::Sprite, "地图装饰"),
        )?;
        validate_map_rect(
            decoration.x,
            decoration.y,
            decoration.width,
            decoration.height,
            map,
            &decoration.id,
        )?;
    }
    let mut scenes_in_map = BTreeSet::new();
    for hotspot in &map.hotspots {
        validate_identifier("章节热点 ID", &hotspot.id)?;
        if !ids.insert(&hotspot.id) {
            return Err(ContentError::Validation(format!(
                "地图对象 ID 重复: {}",
                hotspot.id
            )));
        }
        if !scenes.contains_key(&hotspot.scene_id) {
            return Err(ContentError::Validation(format!(
                "章节热点 {} 引用了未知 Scene {}",
                hotspot.id, hotspot.scene_id
            )));
        }
        if !scenes_in_map.insert(&hotspot.scene_id) {
            return Err(ContentError::Validation(format!(
                "Scene {} 在地图中有多个章节热点",
                hotspot.scene_id
            )));
        }
        validate_display_name(&hotspot.title).map_err(|message| {
            ContentError::Validation(format!("章节热点 {} 标题无效: {message}", hotspot.id))
        })?;
        if let Some(text) = &hotspot.hover_text {
            if text.chars().count() > MAX_CHAPTER_MAP_HOVER_TEXT_CHARS {
                return Err(ContentError::Validation(format!(
                    "章节热点 {} 的 hover 文案不能超过 {} 个字符",
                    hotspot.id, MAX_CHAPTER_MAP_HOVER_TEXT_CHARS
                )));
            }
            if text
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
            {
                return Err(ContentError::Validation(format!(
                    "章节热点 {} 的 hover 文案包含非法控制字符",
                    hotspot.id
                )));
            }
        }
        if let Some(asset) = &hotspot.asset {
            validate_map_asset(asset, assets, AssetKind::Gui, "章节热点")
                .or_else(|_| validate_map_asset(asset, assets, AssetKind::Sprite, "章节热点"))?;
        }
        validate_map_rect(
            hotspot.x,
            hotspot.y,
            hotspot.width,
            hotspot.height,
            map,
            &hotspot.id,
        )?;
        if let ChapterMapReveal::Condition { condition } = &hotspot.reveal {
            validate_condition(condition, variables, "chapter_map", &hotspot.id)?;
            validate_profile_only_condition(condition, variables, &hotspot.id)?;
        }
        for (id, value) in &hotspot.variable_overrides {
            let definition = variables.get(id).ok_or_else(|| {
                ContentError::Validation(format!("章节热点 {} 覆盖了未声明变量 {}", hotspot.id, id))
            })?;
            validate_value_for_type(value, definition.value_type).map_err(|message| {
                ContentError::Validation(format!(
                    "章节热点 {} 的变量 {} 无效: {message}",
                    hotspot.id, id
                ))
            })?;
        }
    }
    Ok(())
}

/// A map's initial view is a viewport center, not an arbitrary point in the
/// room.  Keeping this check in the content validator prevents a hand-edited
/// map from opening with part of the 1920×1080 game viewport outside the room.
fn valid_map_view_center(value: i32, room_size: u32, viewport_size: u32) -> bool {
    if value < 0 {
        return false;
    }
    let value = value as u32;
    if room_size <= viewport_size {
        return value == room_size / 2;
    }
    let half = viewport_size / 2;
    value >= half && value <= room_size.saturating_sub(half)
}

fn validate_map_asset(
    id: &str,
    assets: &BTreeMap<String, AssetDefinition>,
    kind: AssetKind,
    label: &str,
) -> Result<(), ContentError> {
    let definition = assets
        .get(id)
        .ok_or_else(|| ContentError::Validation(format!("{label}引用了未知素材 {id}")))?;
    if definition.kind != kind {
        return Err(ContentError::Validation(format!(
            "{label}素材 {id} 必须是 {kind:?}"
        )));
    }
    Ok(())
}

fn validate_map_rect(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    map: &ChapterMapDefinition,
    id: &str,
) -> Result<(), ContentError> {
    if x < 0
        || y < 0
        || width == 0
        || height == 0
        || x % CHAPTER_MAP_GRID != 0
        || y % CHAPTER_MAP_GRID != 0
        || !width.is_multiple_of(CHAPTER_MAP_GRID as u32)
        || !height.is_multiple_of(CHAPTER_MAP_GRID as u32)
    {
        return Err(ContentError::Validation(format!(
            "地图对象 {id} 的位置和尺寸必须是正数并吸附到 20px 网格"
        )));
    }
    let Some(right) = (x as u32).checked_add(width) else {
        return Err(ContentError::Validation(format!(
            "地图对象 {id} 超出房间边界"
        )));
    };
    let Some(bottom) = (y as u32).checked_add(height) else {
        return Err(ContentError::Validation(format!(
            "地图对象 {id} 超出房间边界"
        )));
    };
    if right > map.width || bottom > map.height {
        return Err(ContentError::Validation(format!(
            "地图对象 {id} 超出房间边界"
        )));
    }
    Ok(())
}

fn validate_profile_only_condition(
    condition: &ConditionExpression,
    variables: &BTreeMap<String, VariableDefinition>,
    node_id: &str,
) -> Result<(), ContentError> {
    let operands: Vec<&ValueOperand> = match condition {
        ConditionExpression::Eq { left, right }
        | ConditionExpression::Ne { left, right }
        | ConditionExpression::Lt { left, right }
        | ConditionExpression::Le { left, right }
        | ConditionExpression::Gt { left, right }
        | ConditionExpression::Ge { left, right } => vec![left, right],
        ConditionExpression::And { conditions } | ConditionExpression::Or { conditions } => {
            for child in conditions {
                validate_profile_only_condition(child, variables, node_id)?;
            }
            Vec::new()
        }
        ConditionExpression::Not { condition } => {
            validate_profile_only_condition(condition, variables, node_id)?;
            Vec::new()
        }
    };
    for operand in operands {
        if let ValueOperand::Variable(reference) = operand {
            if variables
                .get(&reference.variable)
                .is_none_or(|definition| definition.scope != VariableScope::Profile)
            {
                return Err(ContentError::Validation(format!(
                    "地图热点 {node_id} 的揭示条件只能引用 profile 变量: {}",
                    reference.variable
                )));
            }
        }
    }
    Ok(())
}

fn validate_ui_motion_files(
    paths: &[String],
    files: &BTreeMap<String, UiMotionPreset>,
) -> Result<BTreeMap<String, UiMotionPreset>, ContentError> {
    let expected = paths.iter().cloned().collect::<BTreeSet<_>>();
    let actual = files.keys().cloned().collect::<BTreeSet<_>>();
    if expected != actual {
        return Err(ContentError::Validation(
            "UI 动效文件集合与 manifest 不一致".to_owned(),
        ));
    }
    let mut result = BTreeMap::new();
    for (path, preset) in files {
        validate_relative_path(path)?;
        validate_ui_motion(preset)?;
        if result.insert(preset.id.clone(), preset.clone()).is_some() {
            return Err(ContentError::Validation(format!(
                "UI 动效 ID 重复: {}",
                preset.id
            )));
        }
    }
    Ok(result)
}

fn load_animations(
    root: &Path,
    paths: &[String],
) -> Result<BTreeMap<String, ImageAnimationDefinition>, ContentError> {
    let mut files = BTreeMap::new();
    for path in paths {
        let relative = validate_relative_path(path)?;
        let full_path = canonical_file_within(root, &root.join(relative))?;
        files.insert(path.clone(), read_yaml(&full_path)?);
    }
    validate_animation_files(paths, &files)
}

/// Mirrors `validate_ui_motion_files`: the manifest path list and the supplied
/// document set must describe exactly the same files, so an unsaved editor
/// draft can never silently drop or invent an animation document.
fn validate_animation_files(
    paths: &[String],
    files: &BTreeMap<String, ImageAnimationDefinition>,
) -> Result<BTreeMap<String, ImageAnimationDefinition>, ContentError> {
    let expected = paths.iter().cloned().collect::<BTreeSet<_>>();
    let actual = files.keys().cloned().collect::<BTreeSet<_>>();
    if expected != actual {
        return Err(ContentError::Validation(
            "图片动画文件集合与 manifest 不一致".to_owned(),
        ));
    }
    let mut result = BTreeMap::new();
    for (path, animation) in files {
        validate_relative_path(path)?;
        validate_animation_document(animation)?;
        if result
            .insert(animation.id.clone(), animation.clone())
            .is_some()
        {
            return Err(ContentError::Validation(format!(
                "图片动画 ID 重复: {}",
                animation.id
            )));
        }
    }
    Ok(result)
}

fn load_actions(
    root: &Path,
    paths: &[String],
) -> Result<BTreeMap<String, SpriteActionDefinition>, ContentError> {
    let mut files = BTreeMap::new();
    for path in paths {
        let relative = validate_relative_path(path)?;
        let full_path = canonical_file_within(root, &root.join(relative))?;
        files.insert(path.clone(), read_yaml(&full_path)?);
    }
    validate_action_files(paths, &files)
}

/// Validate reusable relative transform actions and index them by stable ID.
fn validate_action_files(
    paths: &[String],
    files: &BTreeMap<String, SpriteActionDefinition>,
) -> Result<BTreeMap<String, SpriteActionDefinition>, ContentError> {
    let expected = paths.iter().cloned().collect::<BTreeSet<_>>();
    let actual = files.keys().cloned().collect::<BTreeSet<_>>();
    if expected != actual {
        return Err(ContentError::Validation(
            "立绘动作文件集合与 manifest 不一致".to_owned(),
        ));
    }
    let mut result = BTreeMap::new();
    for (path, action) in files {
        validate_relative_path(path)?;
        validate_action_document(action)?;
        if result.insert(action.id.clone(), action.clone()).is_some() {
            return Err(ContentError::Validation(format!(
                "立绘动作 ID 重复: {}",
                action.id
            )));
        }
    }
    Ok(result)
}

fn validate_action_document(action: &SpriteActionDefinition) -> Result<(), ContentError> {
    if action.schema_version != SPRITE_ACTION_SCHEMA_VERSION {
        return Err(ContentError::Validation(format!(
            "立绘动作 {} 使用了不支持的 schema_version {}",
            action.id, action.schema_version
        )));
    }
    validate_identifier("sprite action id", &action.id)?;
    if action.name.trim().is_empty() || action.name.chars().count() > 128 {
        return Err(ContentError::Validation(format!(
            "立绘动作 {} 的 name 不能为空且不能超过 128 个 Unicode 字符",
            action.id
        )));
    }
    if action.duration_ms == 0 || action.duration_ms > MAX_TIMELINE_DURATION_MS {
        return Err(ContentError::Validation(format!(
            "立绘动作 {} 时长必须在 1ms 到 30 分钟之间",
            action.id
        )));
    }
    if action.channels.len() > ACTION_MAX_CHANNELS {
        return Err(ContentError::Validation(format!(
            "立绘动作 {} 的通道超过 {} 条",
            action.id, ACTION_MAX_CHANNELS
        )));
    }
    if action.parameters.len() > ACTION_MAX_PARAMETERS {
        return Err(ContentError::Validation(format!(
            "立绘动作 {} 的参数超过 {} 个",
            action.id, ACTION_MAX_PARAMETERS
        )));
    }
    if action.channels.is_empty() {
        return Err(ContentError::Validation(format!(
            "立绘动作 {} 至少需要一个变换通道",
            action.id
        )));
    }
    for (parameter_id, parameter) in &action.parameters {
        validate_identifier("sprite action parameter id", parameter_id)?;
        if !parameter.default.is_finite()
            || parameter.min.is_some_and(|value| !value.is_finite())
            || parameter.max.is_some_and(|value| !value.is_finite())
            || parameter
                .min
                .zip(parameter.max)
                .is_some_and(|(min, max)| min > max)
            || parameter.min.is_some_and(|min| parameter.default < min)
            || parameter.max.is_some_and(|max| parameter.default > max)
        {
            return Err(ContentError::Validation(format!(
                "立绘动作 {} 的参数 {} 范围或默认值无效",
                action.id, parameter_id
            )));
        }
    }
    let allowed = [
        "x",
        "y",
        "scale",
        "scale_x",
        "scale_y",
        "rotation_deg",
        "opacity",
    ];
    let mut keyframe_count = 0usize;
    for (channel, keyframes) in &action.channels {
        if !allowed.contains(&channel.as_str()) {
            return Err(ContentError::Validation(format!(
                "立绘动作 {} 不支持通道 {channel}",
                action.id
            )));
        }
        if keyframes.is_empty() {
            return Err(ContentError::Validation(format!(
                "立绘动作 {} 的通道 {channel} 不能为空",
                action.id
            )));
        }
        if keyframes.first().is_none_or(|keyframe| keyframe.at_ms != 0) {
            return Err(ContentError::Validation(format!(
                "立绘动作 {} 的通道 {channel} 必须从 0ms 关键帧开始",
                action.id
            )));
        }
        keyframe_count = keyframe_count.saturating_add(keyframes.len());
        let mut previous = None;
        for keyframe in keyframes {
            if keyframe.at_ms > action.duration_ms
                || previous.is_some_and(|at| keyframe.at_ms <= at)
                || !keyframe.value.is_finite()
                || (matches!(channel.as_str(), "scale" | "scale_x" | "scale_y")
                    && keyframe.value <= 0.0)
                || (channel == "opacity" && !(0.0..=1.0).contains(&keyframe.value))
            {
                return Err(ContentError::Validation(format!(
                    "立绘动作 {} 的通道 {channel} 关键帧无效",
                    action.id
                )));
            }
            if let Some(parameter) = &keyframe.parameter {
                if !action.parameters.contains_key(parameter) {
                    return Err(ContentError::Validation(format!(
                        "立绘动作 {} 的关键帧引用了未知参数 {parameter}",
                        action.id
                    )));
                }
            }
            if let crate::model::TimelineEasing::CubicBezier { cubic_bezier } = &keyframe.easing {
                if cubic_bezier.iter().any(|value| !value.is_finite())
                    || !(0.0..=1.0).contains(&cubic_bezier[0])
                    || !(0.0..=1.0).contains(&cubic_bezier[2])
                {
                    return Err(ContentError::Validation(format!(
                        "立绘动作 {} 的 cubic_bezier 控制点无效",
                        action.id
                    )));
                }
            }
            previous = Some(keyframe.at_ms);
        }
    }
    if keyframe_count > ACTION_MAX_KEYFRAMES {
        return Err(ContentError::Validation(format!(
            "立绘动作 {} 的关键帧超过 {} 个",
            action.id, ACTION_MAX_KEYFRAMES
        )));
    }
    Ok(())
}

fn validate_action_namespace(
    actions: &BTreeMap<String, SpriteActionDefinition>,
    assets: &BTreeMap<String, AssetDefinition>,
    animations: &BTreeMap<String, ImageAnimationDefinition>,
) -> Result<(), ContentError> {
    for id in actions.keys() {
        if assets.contains_key(id) || animations.contains_key(id) {
            return Err(ContentError::Validation(format!(
                "立绘动作 ID {id} 与素材或图片动画 ID 冲突"
            )));
        }
    }
    Ok(())
}

/// Document-local animation rules that need no asset table.
fn validate_animation_document(animation: &ImageAnimationDefinition) -> Result<(), ContentError> {
    if animation.schema_version != IMAGE_ANIMATION_SCHEMA_VERSION {
        return Err(ContentError::Validation(format!(
            "图片动画 {} 使用了不支持的 schema_version {}",
            animation.id, animation.schema_version
        )));
    }
    validate_identifier("image animation id", &animation.id)?;
    if animation.frames.is_empty() {
        return Err(ContentError::Validation(format!(
            "图片动画 {} 至少需要一帧",
            animation.id
        )));
    }
    if animation.frames.len() > IMAGE_ANIMATION_MAX_FRAMES {
        return Err(ContentError::Validation(format!(
            "图片动画 {} 的帧数 {} 超过上限 {}",
            animation.id,
            animation.frames.len(),
            IMAGE_ANIMATION_MAX_FRAMES
        )));
    }
    for (index, frame) in animation.frames.iter().enumerate() {
        validate_identifier("animation frame asset id", &frame.asset)?;
        if !(IMAGE_ANIMATION_MIN_FRAME_MS..=IMAGE_ANIMATION_MAX_FRAME_MS)
            .contains(&frame.duration_ms)
        {
            return Err(ContentError::Validation(format!(
                "图片动画 {} 第 {} 帧时长 {}ms 必须在 {}-{}ms 之间",
                animation.id,
                index + 1,
                frame.duration_ms,
                IMAGE_ANIMATION_MIN_FRAME_MS,
                IMAGE_ANIMATION_MAX_FRAME_MS
            )));
        }
    }
    Ok(())
}

/// Asset-aware animation validation: frame references, static-only frames,
/// one shared pixel size, and the decode memory budget.  Returns the measured
/// geometry that the shared image resolver later reuses.
fn validate_animations(
    animations: &BTreeMap<String, ImageAnimationDefinition>,
    assets: &BTreeMap<String, AssetDefinition>,
    assets_root: &Path,
    asset_overrides: &BTreeMap<String, PathBuf>,
) -> Result<BTreeMap<String, AnimationMetrics>, ContentError> {
    let mut metrics = BTreeMap::new();
    for (id, animation) in animations {
        if assets.contains_key(id) {
            return Err(ContentError::Validation(format!(
                "图片动画 ID {id} 与素材 ID 冲突：动画 ID 必须独立于素材命名空间"
            )));
        }
        let mut shared_size: Option<ImageSize> = None;
        let mut decoded_bytes = 0_u64;
        let mut counted = BTreeSet::new();
        for (index, frame) in animation.frames.iter().enumerate() {
            let position = index + 1;
            let definition = assets.get(&frame.asset).ok_or_else(|| {
                ContentError::Validation(format!(
                    "图片动画 {id} 第 {position} 帧引用了未登记的素材 {}",
                    frame.asset
                ))
            })?;
            if !matches!(
                definition.kind,
                AssetKind::Background | AssetKind::Sprite | AssetKind::Gui
            ) {
                return Err(ContentError::Validation(format!(
                    "图片动画 {id} 第 {position} 帧的素材 {} 不是图片素材",
                    frame.asset
                )));
            }
            if definition.animation.is_some() {
                return Err(ContentError::Validation(format!(
                    "图片动画 {id} 第 {position} 帧引用了动画素材 {}：动画帧只能引用静态图片",
                    frame.asset
                )));
            }
            let size = measure_frame(&frame.asset, definition, assets_root, asset_overrides)?;
            match shared_size {
                Some(expected) if expected != size => {
                    return Err(ContentError::Validation(format!(
                        "图片动画 {id} 第 {position} 帧尺寸 {}x{} 与首帧 {}x{} 不一致",
                        size.width, size.height, expected.width, expected.height
                    )));
                }
                Some(_) => {}
                None => shared_size = Some(size),
            }
            if size.width > IMAGE_ANIMATION_MAX_EDGE || size.height > IMAGE_ANIMATION_MAX_EDGE {
                return Err(ContentError::Validation(format!(
                    "图片动画 {id} 第 {position} 帧尺寸 {}x{} 超过单边上限 {IMAGE_ANIMATION_MAX_EDGE}",
                    size.width, size.height
                )));
            }
            if counted.insert(frame.asset.clone()) {
                decoded_bytes = decoded_bytes.saturating_add(size.decoded_bytes());
            }
        }
        if decoded_bytes > IMAGE_ANIMATION_MAX_DECODED_BYTES {
            return Err(ContentError::Validation(format!(
                "图片动画 {id} 解码内存 {} MiB 超过预算 {} MiB：请减少帧数或降低分辨率",
                decoded_bytes / (1024 * 1024),
                IMAGE_ANIMATION_MAX_DECODED_BYTES / (1024 * 1024)
            )));
        }
        let size = shared_size.expect("frame list was validated as non-empty");
        metrics.insert(
            id.clone(),
            AnimationMetrics {
                width: size.width,
                height: size.height,
                decoded_bytes,
            },
        );
    }
    Ok(metrics)
}

fn measure_frame(
    asset_id: &str,
    definition: &AssetDefinition,
    assets_root: &Path,
    asset_overrides: &BTreeMap<String, PathBuf>,
) -> Result<ImageSize, ContentError> {
    let relative = definition.path.as_deref().ok_or_else(|| {
        ContentError::Validation(format!("动画帧素材 {asset_id} 没有静态图片路径"))
    })?;
    let relative = validate_relative_path(relative)?;
    let path = match asset_overrides.get(asset_id) {
        Some(override_path) => canonical_staged_asset(override_path)?,
        None => canonical_file_within(assets_root, &assets_root.join(relative))?,
    };
    probe(&path).map_err(|error| {
        ContentError::Validation(format!("动画帧素材 {asset_id} 无法测量像素尺寸：{error}"))
    })
}

fn validate_ui_motion(preset: &UiMotionPreset) -> Result<(), ContentError> {
    if preset.schema_version != UI_MOTION_SCHEMA_VERSION {
        return Err(ContentError::Validation(format!(
            "UI 动效 {} 使用了不支持的 schema_version {}",
            preset.id, preset.schema_version
        )));
    }
    validate_identifier("ui motion id", &preset.id)?;
    if preset.duration_ms == 0 || preset.duration_ms > MAX_TIMELINE_DURATION_MS {
        return Err(ContentError::Validation(format!(
            "UI 动效 {} 时长必须在 1ms 到 30 分钟之间",
            preset.id
        )));
    }
    if preset.tracks.is_empty() {
        return Err(ContentError::Validation(format!(
            "UI 动效 {} 至少需要一条轨道",
            preset.id
        )));
    }
    let mut targets = BTreeSet::new();
    let mut keyframe_count = 0;
    for track in &preset.tracks {
        if !targets.insert(track.target) {
            return Err(ContentError::Validation(format!(
                "UI 动效 {} 的目标 {:?} 重复",
                preset.id, track.target
            )));
        }
        if track.channels.is_empty() {
            return Err(ContentError::Validation(format!(
                "UI 动效 {} 的目标 {:?} 至少需要一个通道",
                preset.id, track.target
            )));
        }
        validate_timeline_channels(
            &track.channels,
            &[
                "offset_x",
                "offset_y",
                "scale_x",
                "scale_y",
                "rotation_deg",
                "opacity",
            ],
            preset.duration_ms,
            "ui_motion",
            &preset.id,
            &mut keyframe_count,
            false,
        )?;
    }
    if keyframe_count > MAX_TIMELINE_KEYFRAMES {
        return Err(ContentError::Validation(format!(
            "UI 动效 {} 的关键帧超过 10000 个",
            preset.id
        )));
    }
    Ok(())
}

fn validate_ui_motion_bindings(
    bindings: &UiMotionBindings,
    motions: &BTreeMap<String, UiMotionPreset>,
) -> Result<(), ContentError> {
    for (slot, motion) in [
        ("dialogue_show", &bindings.dialogue_show),
        ("dialogue_hide", &bindings.dialogue_hide),
    ] {
        if let Some(motion) = motion {
            if !motions.contains_key(motion) {
                return Err(ContentError::Validation(format!(
                    "UI 动效默认绑定 {slot} 引用了未知动效 {motion}"
                )));
            }
        }
    }
    Ok(())
}

fn validate_ui_motion_reference(
    motion: Option<&str>,
    motions: &BTreeMap<String, UiMotionPreset>,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    if let Some(motion) = motion {
        if !motions.contains_key(motion) {
            return node_error(scene_id, node_id, &format!("引用了未知 UI 动效 {motion}"));
        }
    }
    Ok(())
}

fn validate_assets(
    assets_root: &Path,
    assets: &BTreeMap<String, AssetDefinition>,
    asset_overrides: &BTreeMap<String, PathBuf>,
) -> Result<(), ContentError> {
    if assets.is_empty() {
        return Err(ContentError::Validation("素材表不能为空".to_owned()));
    }
    for (id, definition) in assets {
        validate_identifier("asset id", id)?;
        let relative_text = match (&definition.path, &definition.animation) {
            (Some(_), Some(_)) => {
                return Err(ContentError::Validation(format!(
                    "素材 {id} 的 path 与 animation 互斥，只能登记其中一个"
                )));
            }
            (None, None) => {
                return Err(ContentError::Validation(format!(
                    "素材 {id} 必须登记 path 或 animation 之一"
                )));
            }
            (Some(path), None) => path,
            // Animated assets carry no static path.  Their frames are
            // canonicalized and measured in `validate_animations`, which also
            // owns the frame count, duration and memory budget rules.
            (None, Some(_))
                if matches!(
                    definition.kind,
                    AssetKind::Background | AssetKind::Sprite | AssetKind::Gui
                ) =>
            {
                continue
            }
            (None, Some(_)) => {
                return Err(ContentError::Validation(format!(
                    "动画素材 {id} 必须是 background、sprite 或 gui 类型"
                )));
            }
        };
        let relative = validate_relative_path(relative_text)?;
        if definition.kind == AssetKind::Video
            && Path::new(relative_text)
                .extension()
                .and_then(|value| value.to_str())
                .is_none_or(|extension| !extension.eq_ignore_ascii_case("mp4"))
        {
            return Err(ContentError::Validation(format!(
                "视频素材 {id} 必须使用 .mp4（H.264/AAC）"
            )));
        }
        let asset_path = match asset_overrides.get(id) {
            Some(override_path) => canonical_staged_asset(override_path)?,
            None => canonical_file_within(assets_root, &assets_root.join(relative))?,
        };
        reject_git_lfs_pointer(id, &asset_path)?;
    }
    Ok(())
}

/// Validate the complete set of content document paths before any of them is
/// loaded or written.  Windows resolves paths case-insensitively, so a
/// case-only rename such as `scenes/Intro.yaml` → `scenes/intro.yaml` must not
/// be treated as two independent files by the journal.  Content documents
/// are also kept out of the managed asset and editor-metadata trees to prevent
/// an authoring request from overwriting a binary or layout file.
fn validate_manifest_paths(manifest: &ContentManifest) -> Result<(), ContentError> {
    let mut seen = BTreeMap::<String, String>::new();
    let mut register = |label: &str, path: &str| -> Result<(), ContentError> {
        let relative = validate_relative_path(path)?;
        let normalized = relative.to_string_lossy().replace('\\', "/");
        let key = normalized.to_lowercase();
        if key == "manifest.yaml" || key.starts_with("assets/") || key.starts_with(".vectspace/") {
            return Err(ContentError::Validation(format!(
                "{label} 路径不能覆盖受管制文件: {path}"
            )));
        }
        if let Some(previous) = seen.insert(key, label.to_owned()) {
            return Err(ContentError::Validation(format!(
                "内容文件路径与 {previous} 冲突: {path}"
            )));
        }
        Ok(())
    };
    for path in &manifest.scenes {
        register("scene", path)?;
    }
    for path in &manifest.ui_motions {
        register("ui_motion", path)?;
    }
    for path in &manifest.buttons {
        register("button", path)?;
    }
    for path in &manifest.animations {
        register("animation", path)?;
    }
    for path in &manifest.actions {
        register("action", path)?;
    }
    if let Some(path) = &manifest.chapter_map {
        register("chapter_map", path)?;
    }
    Ok(())
}

fn validate_default_font(manifest: &ContentManifest) -> Result<(), ContentError> {
    let Some(id) = manifest.default_font.as_deref() else {
        return Ok(());
    };
    let Some(asset) = manifest.assets.get(id) else {
        return Err(ContentError::Validation(format!(
            "default_font 引用了未知素材: {id}"
        )));
    };
    if asset.kind != AssetKind::Font {
        return Err(ContentError::Validation(format!(
            "default_font 必须引用 kind: font 素材: {id}"
        )));
    }
    Ok(())
}

fn reject_git_lfs_pointer(id: &str, path: &Path) -> Result<(), ContentError> {
    const LFS_SIGNATURE: &[u8] = b"version https://git-lfs.github.com/spec/v1";
    let mut file = fs::File::open(path).map_err(|source| ContentError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    let mut header = [0_u8; 128];
    let bytes_read = file
        .read(&mut header)
        .map_err(|source| ContentError::Read {
            path: path.to_path_buf(),
            source,
        })?;
    if header[..bytes_read].starts_with(LFS_SIGNATURE) {
        return Err(ContentError::Validation(format!(
            "素材 {id} 仍是 Git LFS 指针，尚未下载真实文件：{}。请在项目根目录运行 `git lfs pull` 后重试",
            path.display()
        )));
    }
    Ok(())
}

fn validate_variable_definitions(
    variables: &BTreeMap<String, VariableDefinition>,
) -> Result<(), ContentError> {
    for (id, definition) in variables {
        validate_identifier("variable", id)?;
        validate_value_for_type(&definition.default, definition.value_type).map_err(|message| {
            ContentError::Validation(format!("变量 {id} 的默认值无效: {message}"))
        })?;
    }
    Ok(())
}

fn validate_character_definitions(
    characters: &BTreeMap<String, CharacterDefinition>,
    assets: &BTreeMap<String, AssetDefinition>,
) -> Result<(), ContentError> {
    for (id, definition) in characters {
        validate_identifier("character", id)?;
        validate_display_name(&definition.display_name).map_err(|message| {
            ContentError::Validation(format!("角色 {id} 的显示名无效: {message}"))
        })?;
        for (label, color) in [
            ("name_color", &definition.name_color),
            ("text_color", &definition.text_color),
        ] {
            if let Some(color) = color {
                validate_color(color).map_err(|message| {
                    ContentError::Validation(format!("角色 {id} 的 {label} 无效: {message}"))
                })?;
            }
        }
        if !definition.default_scale.is_finite() || definition.default_scale <= 0.0 {
            return Err(ContentError::Validation(format!(
                "角色 {id} 的 default_scale 必须是有限正数"
            )));
        }
        if let Some(expression) = &definition.default_expression {
            if !definition.expressions.contains_key(expression) {
                return Err(ContentError::Validation(format!(
                    "角色 {id} 的 default_expression 未定义: {expression}"
                )));
            }
        }
        for (expression_id, expression) in &definition.expressions {
            validate_identifier("character expression", expression_id)?;
            validate_character_expression(id, expression_id, expression, assets)?;
        }
    }
    Ok(())
}

fn validate_character_expression(
    character_id: &str,
    expression_id: &str,
    expression: &CharacterExpression,
    assets: &BTreeMap<String, AssetDefinition>,
) -> Result<(), ContentError> {
    let Some(asset) = assets.get(&expression.asset) else {
        return Err(ContentError::Validation(format!(
            "角色 {character_id} 的表情 {expression_id} 引用了未知素材: {}",
            expression.asset
        )));
    };
    if asset.kind != AssetKind::Sprite {
        return Err(ContentError::Validation(format!(
            "角色 {character_id} 的表情 {expression_id} 必须引用 sprite 素材: {}",
            expression.asset
        )));
    }
    if !expression.anchor_x.is_finite()
        || !expression.anchor_y.is_finite()
        || !(0.0..=1.0).contains(&expression.anchor_x)
        || !(0.0..=1.0).contains(&expression.anchor_y)
    {
        return Err(ContentError::Validation(format!(
            "角色 {character_id} 的表情 {expression_id} 锚点必须在 0 到 1 之间"
        )));
    }
    if !expression.offset_x.is_finite()
        || !expression.offset_y.is_finite()
        || !expression.scale.is_finite()
        || expression.scale <= 0.0
    {
        return Err(ContentError::Validation(format!(
            "角色 {character_id} 的表情 {expression_id} 对齐参数无效"
        )));
    }
    Ok(())
}

fn validate_scenes(
    scenes: &BTreeMap<String, SceneDefinition>,
    assets: &BTreeMap<String, AssetDefinition>,
    variables: &BTreeMap<String, VariableDefinition>,
    characters: &BTreeMap<String, CharacterDefinition>,
    ui_motions: &BTreeMap<String, UiMotionPreset>,
    buttons: &BTreeMap<String, ButtonTemplate>,
    actions: &BTreeMap<String, SpriteActionDefinition>,
) -> Result<(), ContentError> {
    #[derive(Clone)]
    struct LongTextPresentation {
        pagination: LongTextPagination,
        font_size: f32,
        text_color: String,
        layout: crate::model::LongTextLayout,
    }

    for (scene_id, scene) in scenes {
        if !scene.nodes.contains_key(&scene.entry) {
            return Err(ContentError::Validation(format!(
                "场景 {scene_id} 的入口节点不存在: {}",
                scene.entry
            )));
        }
        let mut long_text_documents = BTreeMap::<String, (bool, BTreeSet<String>)>::new();
        let mut long_text_starts = BTreeMap::<String, LongTextPresentation>::new();
        for (node_id, node) in &scene.nodes {
            if let SceneNode::LongText {
                document,
                mode,
                pagination,
                font_size,
                text_color,
                layout,
                steps,
                ..
            } = node
            {
                let document_id = document.clone().unwrap_or_else(|| node_id.clone());
                validate_identifier("long text document id", &document_id)?;
                if *mode == LongTextMode::Continue && document.is_none() {
                    return node_error(scene_id, node_id, "continue 长文本必须提供 document");
                }
                let entry = long_text_documents
                    .entry(document_id.clone())
                    .or_insert_with(|| (false, BTreeSet::new()));
                if *mode == LongTextMode::Start {
                    if entry.0 {
                        return node_error(scene_id, node_id, "同一文稿只能有一个 start 节点");
                    }
                    entry.0 = true;
                    long_text_starts.insert(
                        document_id.clone(),
                        LongTextPresentation {
                            pagination: pagination.unwrap_or_default(),
                            font_size: font_size
                                .unwrap_or(crate::model::LONG_TEXT_FONT_SIZE_DEFAULT),
                            text_color: text_color.clone().unwrap_or_else(|| {
                                crate::model::LONG_TEXT_COLOR_DEFAULT.to_owned()
                            }),
                            layout: layout.clone().unwrap_or_default(),
                        },
                    );
                }
                for step in steps {
                    if !entry.1.insert(step.id.clone()) {
                        return node_error(scene_id, node_id, "同一文稿的 step id 重复");
                    }
                }
            }
        }
        for (document_id, (has_start, _)) in &long_text_documents {
            if !has_start {
                return Err(ContentError::Validation(format!(
                    "场景 {scene_id} 的长文本 {document_id} 缺少 start 节点"
                )));
            }
        }
        for (node_id, node) in &scene.nodes {
            validate_identifier("node id", node_id)?;
            match node {
                SceneNode::Background {
                    background,
                    transition,
                    duration_ms,
                    next,
                    ..
                } => {
                    if let Some(id) = background {
                        require_asset(assets, id, AssetKind::Background, scene_id, node_id)?;
                    }
                    validate_background_transition(transition, scene_id, node_id)?;
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Sprite {
                    action,
                    asset,
                    character,
                    expression,
                    crossfade_ms,
                    x,
                    y,
                    scale,
                    opacity,
                    duration_ms,
                    next,
                    ..
                } => {
                    if *action == SpriteAction::Show && asset.is_none() && character.is_none() {
                        return node_error(
                            scene_id,
                            node_id,
                            "show 动作必须提供 asset 或 character",
                        );
                    }
                    if let Some(id) = asset {
                        require_asset(assets, id, AssetKind::Sprite, scene_id, node_id)?;
                    }
                    if let Some(character_id) = character {
                        let Some(character_definition) = characters.get(character_id) else {
                            return Err(ContentError::Validation(format!(
                                "{scene_id}/{node_id}: 未知角色 {character_id}"
                            )));
                        };
                        if let Some(expression_id) = expression {
                            if !character_definition.expressions.contains_key(expression_id) {
                                return Err(ContentError::Validation(format!(
                                    "{scene_id}/{node_id}: 角色 {character_id} 未定义表情 {expression_id}"
                                )));
                            }
                        } else if character_definition.default_expression.is_none()
                            && asset.is_none()
                            && *action != SpriteAction::Hide
                        {
                            return Err(ContentError::Validation(format!(
                                "{scene_id}/{node_id}: 角色 {character_id} 没有可用表情或素材"
                            )));
                        }
                    } else if expression.is_some() {
                        return node_error(
                            scene_id,
                            node_id,
                            "expression 必须与 character 一起使用",
                        );
                    }
                    if x.is_some_and(|value| !value.is_finite())
                        || y.is_some_and(|value| !value.is_finite())
                    {
                        return node_error(scene_id, node_id, "sprite 坐标必须是有限数");
                    }
                    if scale.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                        return node_error(scene_id, node_id, "scale 必须是有限正数");
                    }
                    if opacity.is_some_and(|value| !(0.0..=1.0).contains(&value)) {
                        return node_error(scene_id, node_id, "opacity 必须在 0 到 1 之间");
                    }
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    if let Some(duration) = crossfade_ms {
                        validate_duration(*duration, scene_id, node_id)?;
                    }
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Clear {
                    duration_ms, next, ..
                } => {
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Say {
                    speaker,
                    text,
                    mode,
                    page_id,
                    speed_cps,
                    next,
                    ..
                } => {
                    if text.trim().is_empty() {
                        return node_error(scene_id, node_id, "对话文本不能为空");
                    }
                    if let Some(speaker) = speaker {
                        if !characters.contains_key(speaker) {
                            validate_display_name(speaker).map_err(|message| {
                                ContentError::Validation(format!(
                                    "{scene_id}/{node_id}: 临时说话人无效: {message}"
                                ))
                            })?;
                        }
                    }
                    if let Some(page_id) = page_id {
                        validate_identifier("dialogue page id", page_id)?;
                    }
                    if *mode == DialogueMode::Append && page_id.is_none() {
                        return node_error(scene_id, node_id, "append 对话必须提供 page_id");
                    }
                    if speed_cps.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                        return node_error(scene_id, node_id, "speed_cps 必须是有限正数");
                    }
                    validate_text_markup(text, variables, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::LongText {
                    document,
                    mode,
                    paper,
                    pagination,
                    font_size,
                    text_color,
                    layout,
                    steps,
                    speed_cps,
                    next,
                    ..
                } => {
                    if *mode == LongTextMode::Continue
                        && (paper.is_some()
                            || pagination.is_some()
                            || font_size.is_some()
                            || text_color.is_some()
                            || layout.is_some())
                    {
                        return node_error(
                            scene_id,
                            node_id,
                            "continue 长文本只能继承 start 的纸张、分页、字号、颜色和布局",
                        );
                    }
                    let document_id = document.clone().unwrap_or_else(|| node_id.clone());
                    let (pagination, font_size, text_color, layout) = if *mode
                        == LongTextMode::Continue
                    {
                        let presentation = long_text_starts.get(&document_id).ok_or_else(|| {
                            ContentError::Validation(format!(
                                "{scene_id}/{node_id}: 接续长文本缺少 start 节点"
                            ))
                        })?;
                        (
                            presentation.pagination,
                            presentation.font_size,
                            presentation.text_color.clone(),
                            presentation.layout.clone(),
                        )
                    } else {
                        (
                            pagination.unwrap_or_default(),
                            font_size.unwrap_or(crate::model::LONG_TEXT_FONT_SIZE_DEFAULT),
                            text_color.clone().unwrap_or_else(|| {
                                crate::model::LONG_TEXT_COLOR_DEFAULT.to_owned()
                            }),
                            layout.clone().unwrap_or_default(),
                        )
                    };
                    if let Some(paper) = paper {
                        require_asset(assets, paper, AssetKind::Gui, scene_id, node_id)?;
                    }
                    if steps.is_empty() || steps.len() > MAX_LONG_TEXT_STEPS {
                        return node_error(scene_id, node_id, "长文本必须包含 1 到 1024 个步骤");
                    }
                    if *mode == LongTextMode::Continue && document.is_none() {
                        return node_error(scene_id, node_id, "continue 长文本必须提供 document");
                    }
                    if speed_cps.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                        return node_error(scene_id, node_id, "speed_cps 必须是有限正数");
                    }
                    if !font_size.is_finite()
                        || font_size < LONG_TEXT_FONT_SIZE_MIN
                        || font_size > LONG_TEXT_FONT_SIZE_MAX
                    {
                        return node_error(
                            scene_id,
                            node_id,
                            "长文本 font_size 必须在 16 到 72 之间",
                        );
                    }
                    validate_color(&text_color).map_err(|message| {
                        ContentError::Validation(format!(
                            "{scene_id}/{node_id}: 长文本颜色无效: {message}"
                        ))
                    })?;
                    let values = [
                        layout.x,
                        layout.y,
                        layout.width,
                        layout.height,
                        layout.padding_x,
                        layout.padding_y,
                        layout.page_height,
                        layout.page_gap,
                    ];
                    if values.iter().any(|value| !value.is_finite())
                        || layout.x < 0.0
                        || layout.y < 0.0
                        || layout.width < 160.0
                        || layout.height < 240.0
                        || layout.x + layout.width > 1920.0
                        || layout.y + layout.height > 1080.0
                        || layout.padding_x < 0.0
                        || layout.padding_y < 0.0
                        || layout.width <= layout.padding_x * 2.0 + 80.0
                        || layout.height <= layout.padding_y * 2.0 + 80.0
                        || layout.page_height <= layout.padding_y * 2.0 + 80.0
                        || layout.page_gap < 0.0
                    {
                        return node_error(
                            scene_id,
                            node_id,
                            "长文本 layout 非法或超出 1920×1080 画面",
                        );
                    }
                    let mut ids = BTreeSet::new();
                    for (index, step) in steps.iter().enumerate() {
                        validate_identifier("long text step id", &step.id)?;
                        if !ids.insert(&step.id) {
                            return node_error(scene_id, node_id, "长文本 step id 重复");
                        }
                        if step.text.trim().is_empty() {
                            return node_error(scene_id, node_id, "长文本步骤不能为空");
                        }
                        if *mode == LongTextMode::Start && index == 0 && step.page_break_before {
                            return node_error(
                                scene_id,
                                node_id,
                                "长文本第一步骤不能在前方强制分页",
                            );
                        }
                        if pagination == LongTextPagination::Continuous && step.page_break_before {
                            return node_error(
                                scene_id,
                                node_id,
                                "连续长文本不能使用 page_break_before",
                            );
                        }
                        validate_text_markup(&step.text, variables, scene_id, node_id)?;
                    }
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::LongTextControl { document, next, .. } => {
                    validate_identifier("long text document id", document)?;
                    if !long_text_documents.contains_key(document) {
                        return node_error(scene_id, node_id, "文稿控制引用了未知文稿");
                    }
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Choice { choices } => {
                    if choices.is_empty() {
                        return node_error(scene_id, node_id, "选项列表不能为空");
                    }
                    let mut ids = BTreeSet::new();
                    for choice in choices {
                        validate_identifier("choice id", &choice.id)?;
                        if !ids.insert(&choice.id) {
                            return node_error(scene_id, node_id, "choice id 重复");
                        }
                        validate_text_markup(&choice.label, variables, scene_id, node_id)?;
                        if let Some(condition) = &choice.visible_if {
                            validate_condition(condition, variables, scene_id, node_id)?;
                        }
                        if let Some(condition) = &choice.enabled_if {
                            validate_condition(condition, variables, scene_id, node_id)?;
                        }
                        require_node(scene, &choice.next, scene_id, node_id)?;
                    }
                }
                SceneNode::Set {
                    variable,
                    op,
                    value,
                    next,
                } => {
                    validate_identifier("variable", variable)?;
                    let definition = variables.get(variable).ok_or_else(|| {
                        ContentError::Validation(format!(
                            "{scene_id}/{node_id}: 引用了未声明变量 {variable}"
                        ))
                    })?;
                    validate_mutation(
                        *op,
                        value.as_ref(),
                        definition.value_type,
                        variables,
                        scene_id,
                        node_id,
                    )?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Condition {
                    condition,
                    then,
                    otherwise,
                } => {
                    validate_condition(condition, variables, scene_id, node_id)?;
                    require_node(scene, then, scene_id, node_id)?;
                    require_node(scene, otherwise, scene_id, node_id)?;
                }
                SceneNode::Playback { next, .. } => {
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Action {
                    sprite_id,
                    action,
                    duration_ms,
                    await_completion: _,
                    parameters,
                    end: _,
                    next,
                } => {
                    validate_identifier("action sprite id", sprite_id)?;
                    validate_identifier("action id", action)?;
                    if !actions.contains_key(action) {
                        return node_error(
                            scene_id,
                            node_id,
                            &format!("引用了未知立绘动作 {action}"),
                        );
                    }
                    if let Some(duration_ms) = duration_ms {
                        validate_duration(*duration_ms, scene_id, node_id)?;
                    }
                    let definition = actions.get(action).expect("checked above");
                    for (parameter, value) in parameters {
                        validate_identifier("action parameter", parameter)?;
                        let Some(parameter_definition) = definition.parameters.get(parameter)
                        else {
                            return node_error(
                                scene_id,
                                node_id,
                                &format!("引用了未声明的立绘动作参数 {parameter}"),
                            );
                        };
                        if !value.is_finite()
                            || parameter_definition.min.is_some_and(|min| *value < min)
                            || parameter_definition.max.is_some_and(|max| *value > max)
                        {
                            return node_error(scene_id, node_id, "动作参数必须是有限数");
                        }
                    }
                    if !scene.nodes.values().any(|candidate| {
                        matches!(
                            candidate,
                            SceneNode::Sprite { sprite_id: declared, .. }
                                if declared == sprite_id
                        )
                    }) {
                        return node_error(
                            scene_id,
                            node_id,
                            &format!("动作引用了未声明的立绘实例 {sprite_id}"),
                        );
                    }
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Jump {
                    scene: target_scene,
                    target,
                } => {
                    let destination = target_scene.as_deref().unwrap_or(scene_id);
                    let destination_scene = scenes.get(destination).ok_or_else(|| {
                        ContentError::Validation(format!(
                            "{scene_id}/{node_id} 跳转到未知场景 {destination}"
                        ))
                    })?;
                    if !destination_scene.nodes.contains_key(target) {
                        return node_error(scene_id, node_id, "jump 目标节点不存在");
                    }
                }
                SceneNode::Wait { duration_ms, next } => {
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Bgm {
                    action,
                    asset,
                    volume,
                    duration_ms,
                    start_ms,
                    loop_start_ms,
                    loop_end_ms,
                    next,
                    ..
                } => {
                    if *action == AudioAction::Start && asset.is_none() {
                        return node_error(scene_id, node_id, "BGM start 必须提供 asset");
                    }
                    if let Some(id) = asset {
                        require_asset(assets, id, AssetKind::Bgm, scene_id, node_id)?;
                    }
                    validate_volume(*volume, scene_id, node_id)?;
                    if loop_start_ms.is_some() != loop_end_ms.is_some() {
                        return node_error(scene_id, node_id, "BGM 循环起止点必须同时提供");
                    }
                    if let (Some(start), Some(end)) = (loop_start_ms, loop_end_ms) {
                        if start >= end || *start_ms > *end {
                            return node_error(scene_id, node_id, "BGM 循环点顺序无效");
                        }
                    }
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Sfx {
                    asset,
                    volume,
                    next,
                } => {
                    require_asset(assets, asset, AssetKind::Sfx, scene_id, node_id)?;
                    validate_volume(*volume, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Camera {
                    x,
                    y,
                    zoom,
                    duration_ms,
                    next,
                    ..
                } => {
                    if !x.is_finite() || !y.is_finite() || !zoom.is_finite() || *zoom <= 0.0 {
                        return node_error(
                            scene_id,
                            node_id,
                            "camera 坐标必须有限，zoom 必须为正数",
                        );
                    }
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::ScreenEffect {
                    effect,
                    duration_ms,
                    next,
                    ..
                } => {
                    validate_screen_effect(effect, scene_id, node_id)?;
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Curtain {
                    action,
                    fill,
                    duration_ms,
                    next,
                    ..
                } => {
                    match action {
                        CurtainAction::Cover => {
                            let fill = fill.as_ref().ok_or_else(|| {
                                ContentError::Validation(format!(
                                    "{scene_id}/{node_id} 的 curtain cover 必须提供 fill"
                                ))
                            })?;
                            validate_curtain_fill(fill, assets, scene_id, node_id)?;
                        }
                        CurtainAction::Reveal => {
                            if fill.is_some() {
                                return node_error(
                                    scene_id,
                                    node_id,
                                    "curtain reveal 不能指定 fill，将使用当前幕布",
                                );
                            }
                        }
                    }
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::DialogueUi {
                    motion,
                    duration_ms,
                    next,
                    ..
                } => {
                    validate_ui_motion_reference(motion.as_deref(), ui_motions, scene_id, node_id)?;
                    if let Some(duration_ms) = duration_ms {
                        validate_duration(*duration_ms, scene_id, node_id)?;
                    }
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::UiMotionSet { motion, next, .. } => {
                    validate_ui_motion_reference(motion.as_deref(), ui_motions, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::UiMotionPlay {
                    motion,
                    duration_ms,
                    next,
                    ..
                } => {
                    validate_ui_motion_reference(Some(motion), ui_motions, scene_id, node_id)?;
                    if let Some(duration_ms) = duration_ms {
                        validate_duration(*duration_ms, scene_id, node_id)?;
                    }
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::ButtonCreate {
                    instance_id,
                    template,
                    x,
                    y,
                    width,
                    height,
                    rotation_deg,
                    scale_x,
                    scale_y,
                    opacity,
                    z: _,
                    visible: _,
                    enabled: _,
                    action,
                    next,
                } => {
                    validate_identifier("button instance id", instance_id)?;
                    let definition = buttons.get(template).ok_or_else(|| {
                        ContentError::Validation(format!(
                            "{scene_id}/{node_id} 引用了未知按钮模板 {template}"
                        ))
                    })?;
                    for (label, value) in [("x", *x), ("y", *y), ("rotation_deg", *rotation_deg)] {
                        if value.is_some_and(|value| !value.is_finite()) {
                            return node_error(
                                scene_id,
                                node_id,
                                &format!("按钮 {label} 必须是有限数"),
                            );
                        }
                    }
                    for (label, value) in [("width", *width), ("height", *height)] {
                        if value.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                            return node_error(
                                scene_id,
                                node_id,
                                &format!("按钮 {label} 必须是有限正数"),
                            );
                        }
                    }
                    for (label, value) in [("scale_x", *scale_x), ("scale_y", *scale_y)] {
                        if value.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                            return node_error(
                                scene_id,
                                node_id,
                                &format!("按钮 {label} 必须是有限正数"),
                            );
                        }
                    }
                    if opacity
                        .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
                    {
                        return node_error(scene_id, node_id, "按钮 opacity 必须在 0 到 1 之间");
                    }
                    validate_button_assets(definition, assets, scene_id, node_id)?;
                    validate_button_action(action, variables, scenes, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::ButtonUpdate {
                    instance_id,
                    template,
                    x,
                    y,
                    width,
                    height,
                    rotation_deg,
                    scale_x,
                    scale_y,
                    opacity,
                    z: _,
                    visible: _,
                    enabled: _,
                    action,
                    next,
                } => {
                    validate_identifier("button instance id", instance_id)?;
                    if let Some(template) = template {
                        let definition = buttons.get(template).ok_or_else(|| {
                            ContentError::Validation(format!(
                                "{scene_id}/{node_id} 引用了未知按钮模板 {template}"
                            ))
                        })?;
                        validate_button_assets(definition, assets, scene_id, node_id)?;
                    }
                    for (label, value) in [("x", *x), ("y", *y), ("rotation_deg", *rotation_deg)] {
                        if value.is_some_and(|value| !value.is_finite()) {
                            return node_error(
                                scene_id,
                                node_id,
                                &format!("按钮 {label} 必须是有限数"),
                            );
                        }
                    }
                    for (label, value) in [
                        ("width", *width),
                        ("height", *height),
                        ("scale_x", *scale_x),
                        ("scale_y", *scale_y),
                    ] {
                        if value.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                            return node_error(
                                scene_id,
                                node_id,
                                &format!("按钮 {label} 必须是有限正数"),
                            );
                        }
                    }
                    if opacity
                        .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
                    {
                        return node_error(scene_id, node_id, "按钮 opacity 必须在 0 到 1 之间");
                    }
                    if let Some(action) = action {
                        validate_button_action(action, variables, scenes, scene_id, node_id)?;
                    }
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::ButtonRemove { instance_id, next } => {
                    validate_identifier("button instance id", instance_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Timeline {
                    duration_ms,
                    await_completion,
                    skippable,
                    tracks,
                    events,
                    next,
                } => {
                    for track in tracks {
                        if let TimelineTrack::Button { instance_id, .. } = track {
                            let declared = scene.nodes.values().any(|candidate| {
                                matches!(
                                    candidate,
                                    SceneNode::ButtonCreate { instance_id: created, .. }
                                        if created == instance_id
                                )
                            });
                            if !declared {
                                return node_error(
                                    scene_id,
                                    node_id,
                                    &format!("时间线引用了未创建的按钮实例 {instance_id}"),
                                );
                            }
                        }
                    }
                    validate_timeline(
                        *duration_ms,
                        *await_completion,
                        *skippable,
                        tracks,
                        events,
                        assets,
                        scene_id,
                        node_id,
                    )?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::End => {}
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_timeline(
    duration_ms: u64,
    await_completion: bool,
    skippable: bool,
    tracks: &[TimelineTrack],
    events: &[TimelineEvent],
    assets: &BTreeMap<String, AssetDefinition>,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    if duration_ms == 0 || duration_ms > MAX_TIMELINE_DURATION_MS {
        return node_error(scene_id, node_id, "时间线时长必须在 1ms 到 30 分钟之间");
    }
    if tracks.len() > MAX_TIMELINE_TRACKS {
        return node_error(scene_id, node_id, "时间线轨道超过 64 条");
    }
    if events.len() > MAX_TIMELINE_EVENTS {
        return node_error(scene_id, node_id, "时间线事件超过 2048 个");
    }
    if !await_completion && skippable {
        return node_error(scene_id, node_id, "非阻塞时间线不能设为可跳过");
    }
    let mut keyframe_count = 0usize;
    let mut video_count = 0usize;
    let mut track_ids = BTreeSet::new();
    for track in tracks {
        let (channels, allowed, allow_inherit): (&TimelineChannels, &[&str], bool) = match track {
            TimelineTrack::Sprite {
                sprite_id,
                asset,
                channels,
                ..
            } => {
                validate_identifier("timeline sprite id", sprite_id)?;
                if !track_ids.insert(format!("sprite:{sprite_id}")) {
                    return node_error(scene_id, node_id, "同一立绘不能出现多条时间线轨道");
                }
                if let Some(asset) = asset {
                    require_asset(assets, asset, AssetKind::Sprite, scene_id, node_id)?;
                }
                (
                    channels,
                    &[
                        "x",
                        "y",
                        "scale",
                        "scale_x",
                        "scale_y",
                        "rotation_deg",
                        "opacity",
                        "z",
                    ],
                    true,
                )
            }
            TimelineTrack::Camera { channels } => {
                if !track_ids.insert("camera".to_owned()) {
                    return node_error(scene_id, node_id, "时间线只能包含一条镜头轨");
                }
                (channels, &["x", "y", "zoom", "rotation_deg"], true)
            }
            TimelineTrack::Button {
                instance_id,
                channels,
            } => {
                validate_identifier("timeline button id", instance_id)?;
                if !track_ids.insert(format!("button:{instance_id}")) {
                    return node_error(scene_id, node_id, "同一按钮不能出现多条时间线轨道");
                }
                (
                    channels,
                    &[
                        "x",
                        "y",
                        "width",
                        "height",
                        "scale_x",
                        "scale_y",
                        "rotation_deg",
                        "opacity",
                        "z",
                    ],
                    true,
                )
            }
            TimelineTrack::Video {
                asset,
                clip_start_ms,
                clip_end_ms,
                channels,
                ..
            } => {
                video_count += 1;
                track_ids.insert("video".to_owned());
                if !await_completion {
                    return node_error(scene_id, node_id, "包含视频的时间线必须 await: true");
                }
                require_asset(assets, asset, AssetKind::Video, scene_id, node_id)?;
                if clip_end_ms.is_some_and(|end| end <= *clip_start_ms) {
                    return node_error(scene_id, node_id, "视频裁剪终点必须晚于起点");
                }
                (
                    channels,
                    &["x", "y", "width", "height", "opacity", "z", "volume"],
                    false,
                )
            }
            TimelineTrack::Bgm { channels } => {
                if !track_ids.insert("bgm".to_owned()) {
                    return node_error(scene_id, node_id, "时间线只能包含一条 BGM 音量轨");
                }
                (channels, &["volume"], true)
            }
        };
        validate_timeline_channels(
            channels,
            allowed,
            duration_ms,
            scene_id,
            node_id,
            &mut keyframe_count,
            allow_inherit,
        )?;
    }
    if video_count > 1 {
        return node_error(scene_id, node_id, "单条时间线最多包含一个视频轨");
    }
    if keyframe_count > MAX_TIMELINE_KEYFRAMES {
        return node_error(scene_id, node_id, "时间线关键帧超过 10000 个");
    }
    let mut event_ids = BTreeSet::new();
    let mut previous = 0;
    for (index, event) in events.iter().enumerate() {
        let (id, at_ms) = match event {
            TimelineEvent::Sfx {
                id,
                at_ms,
                asset,
                volume,
            } => {
                require_asset(assets, asset, AssetKind::Sfx, scene_id, node_id)?;
                validate_volume(*volume, scene_id, node_id)?;
                (id, *at_ms)
            }
            TimelineEvent::ScreenEffect {
                id,
                at_ms,
                effect,
                duration_ms: effect_duration,
            } => {
                validate_screen_effect(effect, scene_id, node_id)?;
                validate_duration(*effect_duration, scene_id, node_id)?;
                if at_ms.saturating_add(*effect_duration) > duration_ms {
                    return node_error(scene_id, node_id, "屏幕效果事件超出时间线时长");
                }
                (id, *at_ms)
            }
        };
        validate_identifier("timeline event id", id)?;
        if !event_ids.insert(id) {
            return node_error(scene_id, node_id, "时间线事件 ID 重复");
        }
        if at_ms > duration_ms || (index > 0 && at_ms < previous) {
            return node_error(scene_id, node_id, "时间线事件必须按时间排序且位于时长内");
        }
        previous = at_ms;
    }
    Ok(())
}

fn validate_timeline_channels(
    channels: &TimelineChannels,
    allowed: &[&str],
    duration_ms: u64,
    scene_id: &str,
    node_id: &str,
    keyframe_count: &mut usize,
    allow_inherit: bool,
) -> Result<(), ContentError> {
    for (name, keyframes) in channels {
        if !allowed.contains(&name.as_str()) {
            return node_error(
                scene_id,
                node_id,
                &format!("时间线通道 {name} 不适用于该轨道"),
            );
        }
        if keyframes.is_empty() {
            return node_error(scene_id, node_id, &format!("时间线通道 {name} 不能为空"));
        }
        *keyframe_count = keyframe_count.saturating_add(keyframes.len());
        let mut previous = None;
        for (index, keyframe) in keyframes.iter().enumerate() {
            if keyframe.at_ms > duration_ms || previous.is_some_and(|value| keyframe.at_ms <= value)
            {
                return node_error(
                    scene_id,
                    node_id,
                    &format!("时间线通道 {name} 的关键帧无效"),
                );
            }
            if keyframe.value.is_inherit() {
                if !allow_inherit || index != 0 || keyframe.at_ms != 0 || keyframes.len() < 2 {
                    return node_error(
                        scene_id,
                        node_id,
                        &format!("时间线通道 {name} 的 inherit 只能作为 0ms 起始帧"),
                    );
                }
            } else if let Some(value) = keyframe.value.number() {
                if !value.is_finite() {
                    return node_error(
                        scene_id,
                        node_id,
                        &format!("时间线通道 {name} 的关键帧数值无效"),
                    );
                }
                if matches!(name.as_str(), "opacity" | "volume") && !(0.0..=1.0).contains(&value) {
                    return node_error(
                        scene_id,
                        node_id,
                        &format!("时间线通道 {name} 必须在 0 到 1 之间"),
                    );
                }
                if matches!(
                    name.as_str(),
                    "scale" | "scale_x" | "scale_y" | "zoom" | "width" | "height"
                ) && value <= 0.0
                {
                    return node_error(scene_id, node_id, &format!("时间线通道 {name} 必须大于 0"));
                }
            }
            if let TimelineEasing::CubicBezier { cubic_bezier } = &keyframe.easing {
                if cubic_bezier.iter().any(|value| !value.is_finite())
                    || !(0.0..=1.0).contains(&cubic_bezier[0])
                    || !(0.0..=1.0).contains(&cubic_bezier[2])
                {
                    return node_error(
                        scene_id,
                        node_id,
                        "cubic_bezier 的 x 控制点必须在 0 到 1 之间",
                    );
                }
            }
            previous = Some(keyframe.at_ms);
        }
    }
    Ok(())
}

fn validate_condition(
    condition: &ConditionExpression,
    variables: &BTreeMap<String, VariableDefinition>,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    let mut nodes = 0;
    validate_condition_inner(condition, variables, scene_id, node_id, 1, &mut nodes)
}

fn validate_condition_inner(
    condition: &ConditionExpression,
    variables: &BTreeMap<String, VariableDefinition>,
    scene_id: &str,
    node_id: &str,
    depth: usize,
    nodes: &mut usize,
) -> Result<(), ContentError> {
    *nodes += 1;
    if depth > MAX_CONDITION_DEPTH {
        return node_error(scene_id, node_id, "条件表达式嵌套过深");
    }
    if *nodes > MAX_CONDITION_NODES {
        return node_error(scene_id, node_id, "条件表达式节点过多");
    }

    match condition {
        ConditionExpression::Eq { left, right } | ConditionExpression::Ne { left, right } => {
            let left_type = operand_type(left, variables, scene_id, node_id)?;
            let right_type = operand_type(right, variables, scene_id, node_id)?;
            if !types_comparable_for_equality(left_type, right_type) {
                return node_error(scene_id, node_id, "Eq/Ne 两侧类型不兼容");
            }
        }
        ConditionExpression::Lt { left, right }
        | ConditionExpression::Le { left, right }
        | ConditionExpression::Gt { left, right }
        | ConditionExpression::Ge { left, right } => {
            let left_type = operand_type(left, variables, scene_id, node_id)?;
            let right_type = operand_type(right, variables, scene_id, node_id)?;
            if !is_numeric_type(left_type) || !is_numeric_type(right_type) {
                return node_error(scene_id, node_id, "Lt/Le/Gt/Ge 只允许比较数值");
            }
        }
        ConditionExpression::And { conditions } | ConditionExpression::Or { conditions } => {
            if conditions.is_empty() {
                return node_error(scene_id, node_id, "And/Or 至少需要一个子条件");
            }
            for child in conditions {
                validate_condition_inner(child, variables, scene_id, node_id, depth + 1, nodes)?;
            }
        }
        ConditionExpression::Not { condition } => {
            validate_condition_inner(condition, variables, scene_id, node_id, depth + 1, nodes)?
        }
    }
    Ok(())
}

fn operand_type(
    operand: &ValueOperand,
    variables: &BTreeMap<String, VariableDefinition>,
    scene_id: &str,
    node_id: &str,
) -> Result<VariableType, ContentError> {
    match operand {
        ValueOperand::Variable(reference) => {
            validate_identifier("variable", &reference.variable)?;
            variables
                .get(&reference.variable)
                .map(|definition| definition.value_type)
                .ok_or_else(|| {
                    ContentError::Validation(format!(
                        "{scene_id}/{node_id}: 条件引用了未声明变量 {}",
                        reference.variable
                    ))
                })
        }
        ValueOperand::Literal(literal) => {
            let value_type = scalar_type(&literal.value);
            validate_value_for_type(&literal.value, value_type).map_err(|message| {
                ContentError::Validation(format!("{scene_id}/{node_id}: 条件字面量无效: {message}"))
            })?;
            Ok(value_type)
        }
    }
}

fn validate_mutation(
    operation: VariableOperation,
    value: Option<&MutationValue>,
    target_type: VariableType,
    variables: &BTreeMap<String, VariableDefinition>,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    if operation == VariableOperation::Toggle {
        if target_type != VariableType::Boolean {
            return node_error(scene_id, node_id, "toggle 只能用于 boolean 变量");
        }
        if value.is_some() {
            return node_error(scene_id, node_id, "toggle 不接受 value");
        }
        return Ok(());
    }

    let value = value.ok_or_else(|| {
        ContentError::Validation(format!(
            "{scene_id}/{node_id}: {operation:?} 操作缺少 value"
        ))
    })?;
    let source_type = mutation_value_type(value, variables, scene_id, node_id)?;
    let valid = match operation {
        VariableOperation::Assign => {
            target_type == source_type
                || (target_type == VariableType::Number && source_type == VariableType::Integer)
        }
        VariableOperation::Add | VariableOperation::Sub | VariableOperation::Mul => {
            match target_type {
                VariableType::Integer => source_type == VariableType::Integer,
                VariableType::Number => is_numeric_type(source_type),
                _ => false,
            }
        }
        VariableOperation::Mod => {
            target_type == VariableType::Integer && source_type == VariableType::Integer
        }
        VariableOperation::Append => {
            target_type == VariableType::String && source_type == VariableType::String
        }
        VariableOperation::Toggle => unreachable!(),
    };
    if !valid {
        return node_error(
            scene_id,
            node_id,
            &format!("{operation:?} 不支持 {target_type:?} 目标与 {source_type:?} 操作数"),
        );
    }
    Ok(())
}

fn mutation_value_type(
    value: &MutationValue,
    variables: &BTreeMap<String, VariableDefinition>,
    scene_id: &str,
    node_id: &str,
) -> Result<VariableType, ContentError> {
    match value {
        MutationValue::Variable(reference) => {
            validate_identifier("variable", &reference.variable)?;
            variables
                .get(&reference.variable)
                .map(|definition| definition.value_type)
                .ok_or_else(|| {
                    ContentError::Validation(format!(
                        "{scene_id}/{node_id}: set 引用了未声明变量 {}",
                        reference.variable
                    ))
                })
        }
        MutationValue::Literal(value) => {
            let value_type = scalar_type(value);
            validate_value_for_type(value, value_type).map_err(|message| {
                ContentError::Validation(format!("{scene_id}/{node_id}: set 字面量无效: {message}"))
            })?;
            Ok(value_type)
        }
    }
}

fn validate_value_for_type(value: &ScalarValue, expected: VariableType) -> Result<(), String> {
    if let ScalarValue::Text(value) = value {
        if value.len() > MAX_VARIABLE_STRING_BYTES {
            return Err(format!("字符串超过 {} 字节上限", MAX_VARIABLE_STRING_BYTES));
        }
    }
    let valid = match (expected, value) {
        (VariableType::Boolean, ScalarValue::Boolean(_))
        | (VariableType::Integer, ScalarValue::Integer(_))
        | (VariableType::String, ScalarValue::Text(_)) => true,
        (VariableType::Number, ScalarValue::Integer(_)) => true,
        (VariableType::Number, ScalarValue::Number(value)) => value.is_finite(),
        (_, ScalarValue::Number(value)) if !value.is_finite() => {
            return Err("数值必须是有限数".to_owned());
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!("期望 {expected:?}，实际 {:?}", scalar_type(value)))
    }
}

fn scalar_type(value: &ScalarValue) -> VariableType {
    match value {
        ScalarValue::Boolean(_) => VariableType::Boolean,
        ScalarValue::Integer(_) => VariableType::Integer,
        ScalarValue::Number(_) => VariableType::Number,
        ScalarValue::Text(_) => VariableType::String,
    }
}

fn is_numeric_type(value_type: VariableType) -> bool {
    matches!(value_type, VariableType::Integer | VariableType::Number)
}

fn types_comparable_for_equality(left: VariableType, right: VariableType) -> bool {
    left == right || (is_numeric_type(left) && is_numeric_type(right))
}

fn require_asset(
    assets: &BTreeMap<String, AssetDefinition>,
    id: &str,
    expected: AssetKind,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    let definition = assets.get(id).ok_or_else(|| {
        ContentError::Validation(format!("{scene_id}/{node_id} 引用了未知素材 {id}"))
    })?;
    if definition.kind != expected {
        return node_error(scene_id, node_id, &format!("素材 {id} 类型不正确"));
    }
    Ok(())
}

fn validate_button_assets(
    template: &ButtonTemplate,
    assets: &BTreeMap<String, AssetDefinition>,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    for asset in [&template.normal, &template.hover, &template.pressed]
        .into_iter()
        .flatten()
    {
        let definition = assets.get(asset).ok_or_else(|| {
            ContentError::Validation(format!(
                "{scene_id}/{node_id} 的按钮模板 {} 引用了未知素材 {asset}",
                template.id
            ))
        })?;
        if !matches!(definition.kind, AssetKind::Gui | AssetKind::Sprite) {
            return node_error(scene_id, node_id, "按钮贴图必须是 gui 或 sprite 素材");
        }
    }
    Ok(())
}

fn validate_all_button_assets(
    buttons: &BTreeMap<String, ButtonTemplate>,
    assets: &BTreeMap<String, AssetDefinition>,
) -> Result<(), ContentError> {
    for template in buttons.values() {
        for asset in [&template.normal, &template.hover, &template.pressed]
            .into_iter()
            .flatten()
        {
            let definition = assets.get(asset).ok_or_else(|| {
                ContentError::Validation(format!("按钮模板 {} 引用了未知素材 {asset}", template.id))
            })?;
            if !matches!(definition.kind, AssetKind::Gui | AssetKind::Sprite) {
                return Err(ContentError::Validation(format!(
                    "按钮模板 {} 的贴图必须是 gui 或 sprite 素材",
                    template.id
                )));
            }
        }
    }
    Ok(())
}

fn validate_button_action(
    action: &ButtonClickAction,
    variables: &BTreeMap<String, VariableDefinition>,
    scenes: &BTreeMap<String, SceneDefinition>,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    if action.sets.len() > 64 {
        return node_error(scene_id, node_id, "按钮点击变量修改不能超过 64 条");
    }
    for set in &action.sets {
        validate_identifier("variable", &set.variable)?;
        let definition = variables.get(&set.variable).ok_or_else(|| {
            ContentError::Validation(format!(
                "{scene_id}/{node_id}: 按钮点击引用了未声明变量 {}",
                set.variable
            ))
        })?;
        validate_mutation(
            set.op,
            set.value.as_ref(),
            definition.value_type,
            variables,
            scene_id,
            node_id,
        )?;
    }
    if let Some(ButtonPostAction::Jump { scene, target }) = &action.next {
        let destination = scene.as_deref().unwrap_or(scene_id);
        let destination_scene = scenes.get(destination).ok_or_else(|| {
            ContentError::Validation(format!(
                "{scene_id}/{node_id}: 按钮跳转到未知场景 {destination}"
            ))
        })?;
        if !destination_scene.nodes.contains_key(target) {
            return node_error(scene_id, node_id, "按钮 jump 目标节点不存在");
        }
    }
    if let Some(ButtonPostAction::OpenPanel { panel }) = &action.next {
        let _ = match panel {
            ButtonPanel::Saves | ButtonPanel::Settings | ButtonPanel::History => panel,
        };
    }
    Ok(())
}

fn require_node(
    scene: &SceneDefinition,
    target: &str,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    if !scene.nodes.contains_key(target) {
        return node_error(scene_id, node_id, &format!("目标节点不存在: {target}"));
    }
    Ok(())
}

fn validate_duration(value: u64, scene_id: &str, node_id: &str) -> Result<(), ContentError> {
    if value > 60_000 {
        return node_error(scene_id, node_id, "单个动画时长不能超过 60 秒");
    }
    Ok(())
}

fn validate_volume(value: f32, scene_id: &str, node_id: &str) -> Result<(), ContentError> {
    if !(0.0..=1.0).contains(&value) {
        return node_error(scene_id, node_id, "音量必须在 0 到 1 之间");
    }
    Ok(())
}

fn validate_background_transition(
    transition: &BackgroundTransitionSpec,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    match transition {
        BackgroundTransitionSpec::Cut | BackgroundTransitionSpec::CrossFade => Ok(()),
        BackgroundTransitionSpec::FadeThroughColor { color } => {
            validate_color(color).map_err(|message| {
                ContentError::Validation(format!("{scene_id}/{node_id}: {message}"))
            })
        }
        BackgroundTransitionSpec::Wipe {
            direction: _,
            softness,
        }
        | BackgroundTransitionSpec::Push {
            direction: _,
            softness,
        } => {
            if !softness.is_finite() || !(0.0..=TRANSITION_SOFTNESS_MAX).contains(softness) {
                return node_error(
                    scene_id,
                    node_id,
                    &format!("转场 softness 必须在 0 到 {TRANSITION_SOFTNESS_MAX} 之间"),
                );
            }
            Ok(())
        }
    }
}

fn validate_screen_effect(
    effect: &ScreenEffectSpec,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    match effect {
        ScreenEffectSpec::Flash { color, peak_alpha } => {
            validate_color(color).map_err(|message| {
                ContentError::Validation(format!("{scene_id}/{node_id}: {message}"))
            })?;
            if !peak_alpha.is_finite()
                || !(FLASH_PEAK_ALPHA_MIN..=FLASH_PEAK_ALPHA_MAX).contains(peak_alpha)
            {
                return node_error(scene_id, node_id, "flash peak_alpha 必须在 0 到 1 之间");
            }
            Ok(())
        }
        ScreenEffectSpec::Shake {
            amplitude_x,
            amplitude_y,
            frequency_hz,
            decay,
            seed: _,
        } => {
            for (label, value) in [("amplitude_x", *amplitude_x), ("amplitude_y", *amplitude_y)] {
                if !value.is_finite() || !(0.0..=SHAKE_AMPLITUDE_MAX).contains(&value) {
                    return node_error(
                        scene_id,
                        node_id,
                        &format!("shake {label} 必须在 0 到 {SHAKE_AMPLITUDE_MAX} 之间"),
                    );
                }
            }
            if !frequency_hz.is_finite()
                || !(SHAKE_FREQUENCY_HZ_MIN..=SHAKE_FREQUENCY_HZ_MAX).contains(frequency_hz)
            {
                return node_error(
                    scene_id,
                    node_id,
                    &format!(
                        "shake frequency_hz 必须在 {SHAKE_FREQUENCY_HZ_MIN} 到 {SHAKE_FREQUENCY_HZ_MAX} 之间"
                    ),
                );
            }
            if !decay.is_finite() || !(SHAKE_DECAY_MIN..=SHAKE_DECAY_MAX).contains(decay) {
                return node_error(
                    scene_id,
                    node_id,
                    &format!("shake decay 必须在 {SHAKE_DECAY_MIN} 到 {SHAKE_DECAY_MAX} 之间"),
                );
            }
            Ok(())
        }
    }
}

fn validate_curtain_fill(
    fill: &CurtainFill,
    assets: &BTreeMap<String, AssetDefinition>,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    match fill {
        CurtainFill::Color { color } => validate_color(color).map_err(|message| {
            ContentError::Validation(format!("{scene_id}/{node_id}: {message}"))
        }),
        CurtainFill::Asset { asset } => {
            require_asset(assets, asset, AssetKind::Gui, scene_id, node_id)
        }
    }
}

fn validate_text_markup(
    text: &str,
    variables: &BTreeMap<String, VariableDefinition>,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    for forbidden in ["<script", "javascript:", "[html", "[/html]"] {
        if text.to_ascii_lowercase().contains(forbidden) {
            return node_error(scene_id, node_id, "文本中包含禁止的 HTML 或脚本标记");
        }
    }
    if let Err(message) = scan_text_markup(text) {
        return node_error(scene_id, node_id, &message);
    }
    let references = text_template::references(text)
        .map_err(|error| ContentError::Validation(format!("{scene_id}/{node_id}: {error}")))?;
    for reference in references {
        let definition = variables.get(&reference.id).ok_or_else(|| {
            ContentError::Validation(format!(
                "{scene_id}/{node_id}: 插值引用了未声明变量 {}",
                reference.id
            ))
        })?;
        text_template::validate_reference_type(&reference, definition.value_type)
            .map_err(|error| ContentError::Validation(format!("{scene_id}/{node_id}: {error}")))?;
    }
    Ok(())
}

/// Validate author-facing text markup using the same boundary rules as the
/// renderer: escaped controls are literals and formulas are opaque units.
/// An unmatched `$` remains ordinary text for backwards compatibility.
fn scan_text_markup(text: &str) -> Result<(), String> {
    let mut cursor = 0;
    let mut effect_stack: Vec<(&str, usize)> = Vec::new();
    let mut auto_markers = Vec::new();

    while cursor < text.len() {
        if text[cursor..].starts_with('\\') {
            let next = cursor + 1;
            if next < text.len()
                && text[next..]
                    .chars()
                    .next()
                    .is_some_and(|character| matches!(character, '$' | '[' | '\\'))
            {
                cursor = next_char_boundary(text, next);
                continue;
            }
        }

        // Display formulas take precedence over inline formulas. Controls in
        // a formula body are TeX text and must not affect the markup stack.
        if text[cursor..].starts_with("$$") {
            if let Some(end) = find_unescaped_markup_delimiter(text, "$$", cursor + 2) {
                cursor = end + 2;
                continue;
            }
            cursor += 2;
            continue;
        }
        if text[cursor..].starts_with('$') {
            if let Some(end) = find_unescaped_markup_delimiter(text, "$", cursor + 1) {
                cursor = end + 1;
                continue;
            }
            cursor += 1;
            continue;
        }

        if text[cursor..].starts_with('[') {
            let remainder = &text[cursor..];
            if remainder.starts_with("[/fx]") {
                if effect_stack.pop().is_none() {
                    return Err(markup_error(cursor, "[/fx] 没有对应的 [fx=...]"));
                }
                cursor += "[/fx]".len();
                continue;
            }

            if remainder.starts_with("[fx")
                && remainder
                    .as_bytes()
                    .get(3)
                    .is_none_or(|byte| *byte == b'=' || *byte == b']')
            {
                let end = control_end(remainder, cursor, "[fx=...]")?;
                let token = &remainder[..=end];
                let Some(effect) = token
                    .strip_prefix("[fx=")
                    .and_then(|value| value.strip_suffix(']'))
                else {
                    return Err(markup_error(
                        cursor,
                        "特效标记必须使用 [fx=shake|wave|glow]",
                    ));
                };
                if !matches!(effect, "shake" | "wave" | "glow") {
                    return Err(markup_error(cursor, &format!("未知文本特效: {effect}")));
                }
                effect_stack.push((effect, cursor));
                cursor += end + 1;
                continue;
            }

            if remainder.starts_with("[pause")
                && remainder
                    .as_bytes()
                    .get(6)
                    .is_none_or(|byte| *byte == b'=' || *byte == b']')
            {
                let end = control_end(remainder, cursor, "[pause=数字ms]")?;
                let token = &remainder[..=end];
                let value = token
                    .strip_prefix("[pause=")
                    .and_then(|value| value.strip_suffix("ms]"))
                    .filter(|value| {
                        !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
                    })
                    .ok_or_else(|| markup_error(cursor, "暂停标记必须是 [pause=数字ms]"))?;
                value
                    .parse::<u64>()
                    .map_err(|_| markup_error(cursor, "暂停时长超出范围"))?;
                cursor += end + 1;
                continue;
            }

            if remainder.starts_with("[speed")
                && remainder
                    .as_bytes()
                    .get(6)
                    .is_none_or(|byte| *byte == b'=' || *byte == b']')
            {
                let end = control_end(remainder, cursor, "[speed=default|数字cps]")?;
                let token = &remainder[..=end];
                let value = token
                    .strip_prefix("[speed=")
                    .and_then(|value| value.strip_suffix(']'))
                    .ok_or_else(|| {
                        markup_error(cursor, "速度标记必须是 [speed=default] 或 [speed=数字cps]")
                    })?;
                if value != "default" {
                    let numeric = value
                        .strip_suffix("cps")
                        .ok_or_else(|| markup_error(cursor, "速度标记必须以 cps 结尾"))?;
                    if numeric.is_empty()
                        || numeric.matches('.').count() > 1
                        || !numeric
                            .chars()
                            .all(|character| character.is_ascii_digit() || character == '.')
                    {
                        return Err(markup_error(cursor, "速度必须是正的有限数字"));
                    }
                    let cps = numeric
                        .parse::<f64>()
                        .map_err(|_| markup_error(cursor, "速度必须是正的有限数字"))?;
                    if !cps.is_finite() || cps <= 0.0 {
                        return Err(markup_error(cursor, "速度必须是正的有限数字"));
                    }
                }
                cursor += end + 1;
                continue;
            }

            if remainder.starts_with("[auto")
                && remainder
                    .as_bytes()
                    .get(5)
                    .is_none_or(|byte| *byte == b']' || byte.is_ascii_whitespace())
            {
                if !remainder.starts_with("[auto]") {
                    return Err(markup_error(cursor, "自动推进标记只能写成 [auto]"));
                }
                auto_markers.push(cursor);
                cursor += "[auto]".len();
                continue;
            }

            // The template validator checks the variable ID and scope. Here
            // we only ensure a malformed known prefix cannot become prose.
            if remainder.starts_with("[var")
                && remainder
                    .as_bytes()
                    .get(4)
                    .is_none_or(|byte| *byte == b'=' || *byte == b']')
            {
                let end = control_end(remainder, cursor, "[var=id]")?;
                let token = &remainder[..=end];
                if !token.starts_with("[var=") || !token.ends_with(']') {
                    return Err(markup_error(cursor, "变量插值必须写成 [var=id]"));
                }
                cursor += end + 1;
                continue;
            }

            if remainder.starts_with("[/fx") {
                return Err(markup_error(cursor, "特效结束标记必须写成 [/fx]"));
            }
        }

        cursor = next_char_boundary(text, cursor);
    }

    if let Some((effect, position)) = effect_stack.last() {
        return Err(markup_error(
            *position,
            &format!("[fx={effect}] 缺少对应的 [/fx]"),
        ));
    }
    if auto_markers.len() > 1 {
        return Err(markup_error(
            auto_markers[1],
            "[auto] 只能出现一次且必须位于对话末尾",
        ));
    }
    if let Some(position) = auto_markers.first().copied() {
        if !text[position + "[auto]".len()..].trim().is_empty() {
            return Err(markup_error(
                position,
                "[auto] 只能出现一次且必须位于对话末尾",
            ));
        }
    }
    Ok(())
}

fn control_end(remainder: &str, position: usize, syntax: &str) -> Result<usize, String> {
    remainder
        .find(']')
        .ok_or_else(|| markup_error(position, &format!("{syntax} 缺少右方括号")))
}

fn markup_error(position: usize, message: &str) -> String {
    format!("文本标记错误（字节 {position}）：{message}")
}

fn find_unescaped_markup_delimiter(text: &str, delimiter: &str, from: usize) -> Option<usize> {
    text[from..]
        .match_indices(delimiter)
        .map(|(offset, _)| from + offset)
        .find(|index| {
            let slash_count = text[..*index]
                .bytes()
                .rev()
                .take_while(|byte| *byte == b'\\')
                .count();
            slash_count % 2 == 0
        })
}

fn next_char_boundary(text: &str, cursor: usize) -> usize {
    cursor
        + text[cursor..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1)
}

#[cfg(test)]
fn validate_auto_advance_marker(
    text: &str,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    const MARKER: &str = "[auto]";
    let mut markers = text.match_indices(MARKER).filter(|(index, _)| {
        let slash_count = text.as_bytes()[..*index]
            .iter()
            .rev()
            .take_while(|byte| **byte == b'\\')
            .count();
        slash_count % 2 == 0
    });
    let Some((index, _)) = markers.next() else {
        return Ok(());
    };
    if markers.next().is_some() || !text[index + MARKER.len()..].trim().is_empty() {
        return node_error(scene_id, node_id, "[auto] 只能出现一次且必须位于对话末尾");
    }
    Ok(())
}

fn validate_display_name(value: &str) -> Result<(), String> {
    let length = value.chars().count();
    if value.trim().is_empty() {
        return Err("显示名不能为空".to_owned());
    }
    if length > 64 {
        return Err("显示名不能超过 64 个字符".to_owned());
    }
    if value.chars().any(char::is_control) {
        return Err("显示名不能包含控制字符".to_owned());
    }
    Ok(())
}

pub(crate) fn validate_color(value: &str) -> Result<(), String> {
    let valid_length = value.len() == 7 || value.len() == 9;
    if !valid_length
        || !value.starts_with('#')
        || !value[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("颜色必须是 #RRGGBB 或 #RRGGBBAA".to_owned());
    }
    Ok(())
}

fn validate_identifier(label: &str, value: &str) -> Result<(), ContentError> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character));
    if !valid {
        return Err(ContentError::Validation(format!(
            "{label} 包含非法字符: {value}"
        )));
    }
    Ok(())
}

fn validate_relative_path(value: &str) -> Result<PathBuf, ContentError> {
    let path = Path::new(value);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(ContentError::Validation(format!(
            "只允许内容根目录内的相对路径: {value}"
        )));
    }
    Ok(path.to_path_buf())
}

fn canonical_directory(path: &Path) -> Result<PathBuf, ContentError> {
    let canonical = fs::canonicalize(path).map_err(|source| ContentError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    if !canonical.is_dir() {
        return Err(ContentError::Validation(format!(
            "预期目录但得到其他类型: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

fn canonical_file_within(root: &Path, path: &Path) -> Result<PathBuf, ContentError> {
    let canonical = fs::canonicalize(path).map_err(|source| ContentError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    if !canonical.is_file() || !canonical.starts_with(root) {
        return Err(ContentError::Validation(format!(
            "路径越界或不是文件: {}",
            path.display()
        )));
    }
    Ok(canonical)
}

fn canonical_staged_asset(path: &Path) -> Result<PathBuf, ContentError> {
    let canonical = fs::canonicalize(path).map_err(|source| ContentError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    if !canonical.is_file() {
        return Err(ContentError::Validation(format!(
            "暂存素材不是文件: {}",
            path.display()
        )));
    }
    Ok(canonical)
}

fn node_error<T>(scene_id: &str, node_id: &str, message: &str) -> Result<T, ContentError> {
    Err(ContentError::Validation(format!(
        "{scene_id}/{node_id}: {message}"
    )))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::model::{
        ChapterMapHotspot, ChapterMapReveal, ImageAnimationFrame, LiteralOperand,
        SpriteActionDefinition, SpriteActionEnd, SpriteActionKeyframe, SpriteActionParameter,
        TimelineEasingPreset, TimelineKeyframe, TimelineKeyframeKeyword, TimelineKeyframeValue,
        VariableMap, VariableOperand,
    };

    /// Writes a real PNG header.  The animation validator only needs the
    /// declared pixel size, and a header keeps the fixture hermetic: the test
    /// never depends on a decoded (or LFS-backed) binary asset.
    fn write_png(path: &Path, width: u32, height: u32) {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(&13_u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    /// Registers one image asset whose bytes live in the staging overlay, so
    /// the in-memory catalog can measure a real frame size.
    fn stage_image(
        directory: &Path,
        assets: &mut BTreeMap<String, AssetDefinition>,
        overrides: &mut BTreeMap<String, PathBuf>,
        id: &str,
        width: u32,
        height: u32,
    ) {
        let relative = format!("gui/{}.png", id.replace('.', "_"));
        let path = directory.join(&relative);
        write_png(&path, width, height);
        overrides.insert(id.to_owned(), path);
        assets.insert(
            id.to_owned(),
            AssetDefinition {
                kind: AssetKind::Gui,
                path: Some(relative),
                animation: None,
            },
        );
    }

    fn frames(entries: &[(&str, u64)]) -> Vec<ImageAnimationFrame> {
        entries
            .iter()
            .map(|(asset, duration_ms)| ImageAnimationFrame {
                asset: (*asset).to_owned(),
                duration_ms: *duration_ms,
            })
            .collect()
    }

    /// Builds a catalog whose animation documents are supplied in memory, the
    /// same path the editor uses for an unsaved draft.
    fn animation_catalog(
        assets: BTreeMap<String, AssetDefinition>,
        overrides: &BTreeMap<String, PathBuf>,
        manifest_animations: Vec<String>,
        animations: BTreeMap<String, ImageAnimationDefinition>,
    ) -> Result<ContentCatalog, ContentError> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/game");
        // `canonical_file_within` compares canonical paths, so the helper must
        // not hand it a path with mixed separators.
        let canonical_root = fs::canonicalize(&root).unwrap();
        let catalog = ContentCatalog::from_root(root.clone()).unwrap();
        let mut manifest = catalog.manifest.clone();
        // Merge instead of replacing: the fixture scenes keep referencing the
        // project's own static assets, and each test only adds staged images.
        for (id, definition) in assets {
            manifest.assets.insert(id, definition);
        }
        manifest.animations = manifest_animations;
        // The in-memory document map is keyed by manifest path, while the
        // built catalog indexes the same documents by id.
        let ui_motion_files: BTreeMap<String, UiMotionPreset> = manifest
            .ui_motions
            .iter()
            .map(|path| (path.clone(), read_yaml(&canonical_root.join(path)).unwrap()))
            .collect();
        ContentCatalog::from_documents_with_all_documents(
            root,
            manifest,
            catalog.scenes.clone(),
            ui_motion_files,
            catalog.chapter_map.clone(),
            overrides,
            None,
            Some(animations),
        )
    }

    #[test]
    fn image_animation_resolves_frames_and_geometry() {
        let directory = tempfile::tempdir().unwrap();
        let mut assets = BTreeMap::new();
        let mut overrides = BTreeMap::new();
        stage_image(
            directory.path(),
            &mut assets,
            &mut overrides,
            "img.idle",
            64,
            48,
        );
        stage_image(
            directory.path(),
            &mut assets,
            &mut overrides,
            "img.blink",
            64,
            48,
        );
        assets.insert(
            "gui.blinking".to_owned(),
            AssetDefinition {
                kind: AssetKind::Gui,
                path: None,
                animation: Some("anim.blinking".to_owned()),
            },
        );
        let mut animations = BTreeMap::new();
        animations.insert(
            "animations/blinking.yaml".to_owned(),
            ImageAnimationDefinition {
                schema_version: IMAGE_ANIMATION_SCHEMA_VERSION,
                id: "anim.blinking".to_owned(),
                frames: frames(&[("img.idle", 400), ("img.blink", 120)]),
            },
        );
        let catalog = animation_catalog(
            assets,
            &overrides,
            vec!["animations/blinking.yaml".to_owned()],
            animations,
        )
        .expect("animation project must validate");

        let resolved = catalog
            .resolve_assets(&["gui.blinking".to_owned()])
            .unwrap();
        assert_eq!(resolved.len(), 1);
        let animation = resolved[0].animation.as_ref().unwrap();
        assert_eq!(animation.id, "anim.blinking");
        assert_eq!((animation.width, animation.height), (64, 48));
        assert_eq!(animation.total_duration_ms, 520);
        assert_eq!(animation.frames.len(), 2);
        assert_eq!(animation.frames[0].duration_ms, 400);
        assert_eq!(animation.frames[1].asset, "img.blink");
        assert!(animation.frames[0].absolute_path.ends_with("img_idle.png"));
        // The legacy single path keeps pointing at a real frame.
        assert_eq!(resolved[0].absolute_path, animation.frames[0].absolute_path);
        assert_eq!(
            catalog.animations_referencing("img.blink"),
            vec!["anim.blinking".to_owned()]
        );
        assert!(catalog.animations_referencing("img.idle").len() == 1);
        assert!(catalog.animations_referencing("img.unused").is_empty());
    }

    #[test]
    fn animated_assets_are_limited_to_visual_kinds() {
        let directory = tempfile::tempdir().unwrap();
        let mut assets = BTreeMap::new();
        let mut overrides = BTreeMap::new();
        stage_image(
            directory.path(),
            &mut assets,
            &mut overrides,
            "img.frame",
            32,
            32,
        );
        assets.insert(
            "bgm.invalid_animation".to_owned(),
            AssetDefinition {
                kind: AssetKind::Bgm,
                path: None,
                animation: Some("anim.invalid_owner".to_owned()),
            },
        );
        let animations = BTreeMap::from([(
            "animations/invalid-owner.yaml".to_owned(),
            ImageAnimationDefinition {
                schema_version: IMAGE_ANIMATION_SCHEMA_VERSION,
                id: "anim.invalid_owner".to_owned(),
                frames: frames(&[("img.frame", 100)]),
            },
        )]);
        let error = animation_catalog(
            assets,
            &overrides,
            vec!["animations/invalid-owner.yaml".to_owned()],
            animations,
        )
        .expect_err("audio assets must not own image animations");
        assert!(error
            .to_string()
            .contains("必须是 background、sprite 或 gui"));
    }

    #[test]
    fn animation_frames_must_share_one_pixel_size() {
        let directory = tempfile::tempdir().unwrap();
        let mut assets = BTreeMap::new();
        let mut overrides = BTreeMap::new();
        stage_image(
            directory.path(),
            &mut assets,
            &mut overrides,
            "img.a",
            64,
            48,
        );
        stage_image(
            directory.path(),
            &mut assets,
            &mut overrides,
            "img.b",
            64,
            49,
        );
        let mut animations = BTreeMap::new();
        animations.insert(
            "animations/mismatch.yaml".to_owned(),
            ImageAnimationDefinition {
                schema_version: IMAGE_ANIMATION_SCHEMA_VERSION,
                id: "anim.mismatch".to_owned(),
                frames: frames(&[("img.a", 100), ("img.b", 100)]),
            },
        );
        let error = animation_catalog(
            assets,
            &overrides,
            vec!["animations/mismatch.yaml".to_owned()],
            animations,
        )
        .unwrap_err();
        assert!(error.to_string().contains("尺寸"), "{error}");
        assert!(error.to_string().contains("不一致"), "{error}");
    }

    #[test]
    fn animation_frames_reject_unknown_animated_and_non_image_assets() {
        let directory = tempfile::tempdir().unwrap();
        let mut assets = BTreeMap::new();
        let mut overrides = BTreeMap::new();
        stage_image(
            directory.path(),
            &mut assets,
            &mut overrides,
            "img.a",
            32,
            32,
        );
        assets.insert(
            "bgm.loop".to_owned(),
            AssetDefinition {
                kind: AssetKind::Bgm,
                path: Some("audio/test_bgm.ogg".to_owned()),
                animation: None,
            },
        );
        assets.insert(
            "gui.nested".to_owned(),
            AssetDefinition {
                kind: AssetKind::Gui,
                path: None,
                animation: Some("anim.outer".to_owned()),
            },
        );

        let unknown = animation_catalog(
            assets.clone(),
            &overrides,
            vec!["animations/x.yaml".to_owned()],
            BTreeMap::from([(
                "animations/x.yaml".to_owned(),
                ImageAnimationDefinition {
                    schema_version: IMAGE_ANIMATION_SCHEMA_VERSION,
                    id: "anim.x".to_owned(),
                    frames: frames(&[("img.missing", 100)]),
                },
            )]),
        )
        .unwrap_err();
        assert!(unknown.to_string().contains("未登记"), "{unknown}");

        let non_image = animation_catalog(
            assets.clone(),
            &overrides,
            vec!["animations/x.yaml".to_owned()],
            BTreeMap::from([(
                "animations/x.yaml".to_owned(),
                ImageAnimationDefinition {
                    schema_version: IMAGE_ANIMATION_SCHEMA_VERSION,
                    id: "anim.x".to_owned(),
                    frames: frames(&[("bgm.loop", 100)]),
                },
            )]),
        )
        .unwrap_err();
        assert!(
            non_image.to_string().contains("不是图片素材"),
            "{non_image}"
        );

        let recursive = animation_catalog(
            assets,
            &overrides,
            vec!["animations/x.yaml".to_owned()],
            BTreeMap::from([(
                "animations/x.yaml".to_owned(),
                ImageAnimationDefinition {
                    schema_version: IMAGE_ANIMATION_SCHEMA_VERSION,
                    id: "anim.x".to_owned(),
                    frames: frames(&[("gui.nested", 100)]),
                },
            )]),
        )
        .unwrap_err();
        assert!(
            recursive.to_string().contains("只能引用静态图片"),
            "{recursive}"
        );
    }

    #[test]
    fn animation_document_rules_reject_bad_shape_and_durations() {
        let directory = tempfile::tempdir().unwrap();
        let mut assets = BTreeMap::new();
        let mut overrides = BTreeMap::new();
        stage_image(
            directory.path(),
            &mut assets,
            &mut overrides,
            "img.a",
            32,
            32,
        );

        let empty = animation_catalog(
            assets.clone(),
            &overrides,
            vec!["animations/x.yaml".to_owned()],
            BTreeMap::from([(
                "animations/x.yaml".to_owned(),
                ImageAnimationDefinition {
                    schema_version: IMAGE_ANIMATION_SCHEMA_VERSION,
                    id: "anim.x".to_owned(),
                    frames: Vec::new(),
                },
            )]),
        )
        .unwrap_err();
        assert!(empty.to_string().contains("至少需要一帧"), "{empty}");

        let zero_duration = animation_catalog(
            assets.clone(),
            &overrides,
            vec!["animations/x.yaml".to_owned()],
            BTreeMap::from([(
                "animations/x.yaml".to_owned(),
                ImageAnimationDefinition {
                    schema_version: IMAGE_ANIMATION_SCHEMA_VERSION,
                    id: "anim.x".to_owned(),
                    frames: frames(&[("img.a", 0)]),
                },
            )]),
        )
        .unwrap_err();
        assert!(
            zero_duration.to_string().contains("时长"),
            "{zero_duration}"
        );

        let too_slow = animation_catalog(
            assets.clone(),
            &overrides,
            vec!["animations/x.yaml".to_owned()],
            BTreeMap::from([(
                "animations/x.yaml".to_owned(),
                ImageAnimationDefinition {
                    schema_version: IMAGE_ANIMATION_SCHEMA_VERSION,
                    id: "anim.x".to_owned(),
                    frames: frames(&[("img.a", IMAGE_ANIMATION_MAX_FRAME_MS + 1)]),
                },
            )]),
        )
        .unwrap_err();
        assert!(too_slow.to_string().contains("时长"), "{too_slow}");

        let wrong_schema = animation_catalog(
            assets.clone(),
            &overrides,
            vec!["animations/x.yaml".to_owned()],
            BTreeMap::from([(
                "animations/x.yaml".to_owned(),
                ImageAnimationDefinition {
                    schema_version: 2,
                    id: "anim.x".to_owned(),
                    frames: frames(&[("img.a", 100)]),
                },
            )]),
        )
        .unwrap_err();
        assert!(
            wrong_schema.to_string().contains("schema_version"),
            "{wrong_schema}"
        );

        let mismatched_files = animation_catalog(
            assets.clone(),
            &overrides,
            vec!["animations/other.yaml".to_owned()],
            BTreeMap::from([(
                "animations/missing.yaml".to_owned(),
                ImageAnimationDefinition {
                    schema_version: IMAGE_ANIMATION_SCHEMA_VERSION,
                    id: "anim.x".to_owned(),
                    frames: frames(&[("img.a", 100)]),
                },
            )]),
        )
        .unwrap_err();
        assert!(
            mismatched_files
                .to_string()
                .contains("集合与 manifest 不一致"),
            "{mismatched_files}"
        );

        let id_collision = animation_catalog(
            assets,
            &overrides,
            vec!["animations/x.yaml".to_owned()],
            BTreeMap::from([(
                "animations/x.yaml".to_owned(),
                ImageAnimationDefinition {
                    schema_version: IMAGE_ANIMATION_SCHEMA_VERSION,
                    id: "img.a".to_owned(),
                    frames: frames(&[("img.a", 100)]),
                },
            )]),
        )
        .unwrap_err();
        assert!(
            id_collision.to_string().contains("素材 ID 冲突"),
            "{id_collision}"
        );
    }

    #[test]
    fn animation_decode_budget_is_enforced() {
        let directory = tempfile::tempdir().unwrap();
        let mut assets = BTreeMap::new();
        let mut overrides = BTreeMap::new();
        // Two unique 8192x8192 frames decode to 2 x 256 MiB, which is over the
        // 256 MiB budget.  Only headers are written: the budget is computed
        // from the declared size, not from decoded pixels.
        stage_image(
            directory.path(),
            &mut assets,
            &mut overrides,
            "img.big",
            8192,
            8192,
        );
        stage_image(
            directory.path(),
            &mut assets,
            &mut overrides,
            "img.big2",
            8192,
            8192,
        );
        let error = animation_catalog(
            assets,
            &overrides,
            vec!["animations/x.yaml".to_owned()],
            BTreeMap::from([(
                "animations/x.yaml".to_owned(),
                ImageAnimationDefinition {
                    schema_version: IMAGE_ANIMATION_SCHEMA_VERSION,
                    id: "anim.x".to_owned(),
                    frames: frames(&[("img.big", 100), ("img.big2", 100)]),
                },
            )]),
        )
        .unwrap_err();
        assert!(error.to_string().contains("解码内存"), "{error}");
    }

    #[test]
    fn animation_reuses_one_decoded_frame_for_repeated_assets() {
        let directory = tempfile::tempdir().unwrap();
        let mut assets = BTreeMap::new();
        let mut overrides = BTreeMap::new();
        stage_image(
            directory.path(),
            &mut assets,
            &mut overrides,
            "img.big",
            8192,
            8192,
        );
        // The same image twice is one decoded frame, so the budget holds.  A
        // ping-pong animation is authored exactly this way.
        let catalog = animation_catalog(
            assets,
            &overrides,
            vec!["animations/x.yaml".to_owned()],
            BTreeMap::from([(
                "animations/x.yaml".to_owned(),
                ImageAnimationDefinition {
                    schema_version: IMAGE_ANIMATION_SCHEMA_VERSION,
                    id: "anim.x".to_owned(),
                    frames: frames(&[("img.big", 100), ("img.big", 200), ("img.big", 100)]),
                },
            )]),
        )
        .expect("one unique frame stays inside the budget");
        let animation = &catalog.animations["anim.x"];
        assert_eq!(animation.total_duration_ms(), 400);
        assert_eq!(animation.unique_frame_assets().len(), 1);
    }

    #[test]
    fn static_assets_still_require_exactly_one_source() {
        let directory = tempfile::tempdir().unwrap();
        let mut assets = BTreeMap::new();
        let mut overrides = BTreeMap::new();
        stage_image(
            directory.path(),
            &mut assets,
            &mut overrides,
            "img.a",
            32,
            32,
        );
        // path and animation together are ambiguous.
        assets.insert(
            "gui.both".to_owned(),
            AssetDefinition {
                kind: AssetKind::Gui,
                path: Some("gui/a.png".to_owned()),
                animation: Some("anim.a".to_owned()),
            },
        );
        let error = animation_catalog(assets, &overrides, Vec::new(), BTreeMap::new()).unwrap_err();
        assert!(error.to_string().contains("互斥"), "{error}");
    }

    #[test]
    fn hidden_source_assets_surface_a_missing_frame_path() {
        let directory = tempfile::tempdir().unwrap();
        let mut assets = BTreeMap::new();
        let mut overrides = BTreeMap::new();
        // Declared as an animation frame but registered as another animation:
        // the recursion rule fires before any path is resolved.
        stage_image(
            directory.path(),
            &mut assets,
            &mut overrides,
            "img.a",
            32,
            32,
        );
        assets.insert(
            "gui.animated".to_owned(),
            AssetDefinition {
                kind: AssetKind::Gui,
                path: None,
                animation: Some("anim.self".to_owned()),
            },
        );
        let error = animation_catalog(
            assets,
            &overrides,
            vec!["animations/x.yaml".to_owned()],
            BTreeMap::from([(
                "animations/x.yaml".to_owned(),
                ImageAnimationDefinition {
                    schema_version: IMAGE_ANIMATION_SCHEMA_VERSION,
                    id: "anim.self".to_owned(),
                    frames: frames(&[("gui.animated", 100)]),
                },
            )]),
        )
        .unwrap_err();
        assert!(error.to_string().contains("只能引用静态图片"), "{error}");

        let missing_path = animation_catalog(
            BTreeMap::from([(
                "gui.broken".to_owned(),
                AssetDefinition {
                    kind: AssetKind::Gui,
                    path: None,
                    animation: None,
                },
            )]),
            &BTreeMap::new(),
            Vec::new(),
            BTreeMap::new(),
        )
        .unwrap_err();
        assert!(
            missing_path
                .to_string()
                .contains("必须登记 path 或 animation"),
            "{missing_path}"
        );
    }

    #[test]
    fn traversal_is_rejected() {
        assert!(validate_relative_path("../secret.yaml").is_err());
        assert!(validate_relative_path("assets/../../secret").is_err());
        assert!(validate_relative_path("backgrounds/room.png").is_ok());
    }

    #[test]
    fn bundled_demo_registers_all_button_template_modes() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../game");
        let catalog = ContentCatalog::from_root(root).expect("bundled demo must be valid");
        assert_eq!(catalog.buttons.len(), 4);
        assert_eq!(
            catalog.buttons["demo.transparent"].normal, None,
            "transparent template keeps an empty hit area",
        );
        assert_eq!(
            catalog.buttons["demo.separate"].asset_mode,
            crate::model::ButtonAssetMode::Separate
        );
        assert_eq!(
            catalog.buttons["demo.overlay"].asset_mode,
            crate::model::ButtonAssetMode::Overlay
        );
        // The showcase template proves a button state can point at an animated
        // asset, which is what the presentation fixture exercises.
        assert_eq!(
            catalog.buttons["showcase.animated"].normal.as_deref(),
            Some("gui.button_pulse")
        );
        assert!(
            catalog.manifest.assets["gui.button_pulse"]
                .animation
                .is_some(),
            "the showcase button artwork must be an animation"
        );
    }

    #[test]
    fn managed_document_paths_are_case_insensitive_and_cannot_target_metadata() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/game");
        let catalog = ContentCatalog::from_root(root).unwrap();
        let mut manifest = catalog.manifest.clone();
        manifest.scenes = vec![
            "scenes/intro.yaml".to_owned(),
            "scenes/INTRO.yaml".to_owned(),
        ];
        assert!(validate_manifest_paths(&manifest)
            .unwrap_err()
            .to_string()
            .contains("冲突"));

        manifest.scenes = vec!["assets/scene.yaml".to_owned()];
        assert!(validate_manifest_paths(&manifest).is_err());
    }

    #[test]
    fn chapter_map_grid_and_checked_bounds_reject_invalid_geometry() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/game");
        let catalog = ContentCatalog::from_root(root).unwrap();
        let mut map = ChapterMapDefinition {
            schema_version: CHAPTER_MAP_SCHEMA_VERSION,
            width: 1920,
            height: 1080,
            view_x: 960,
            view_y: 540,
            background: None,
            decorations: Vec::new(),
            hotspots: vec![ChapterMapHotspot {
                id: "entry".to_owned(),
                scene_id: "prologue".to_owned(),
                title: "入口".to_owned(),
                hover_text: None,
                x: 240,
                y: 460,
                width: 280,
                height: 160,
                z: 1,
                asset: None,
                reveal: ChapterMapReveal::Completed,
                replay: crate::model::ChapterMapReplay::Completed,
                variable_overrides: VariableMap::new(),
            }],
        };
        assert!(validate_chapter_map(
            &map,
            &catalog.scenes,
            &catalog.manifest.assets,
            &catalog.manifest.variables,
        )
        .is_ok());

        map.hotspots[0].hover_text = Some("x".repeat(MAX_CHAPTER_MAP_HOVER_TEXT_CHARS + 1));
        assert!(validate_chapter_map(
            &map,
            &catalog.scenes,
            &catalog.manifest.assets,
            &catalog.manifest.variables,
        )
        .is_err());
        map.hotspots[0].hover_text = Some("入口\u{0007}".to_owned());
        assert!(validate_chapter_map(
            &map,
            &catalog.scenes,
            &catalog.manifest.assets,
            &catalog.manifest.variables,
        )
        .is_err());
        map.hotspots[0].hover_text = None;

        map.width = 1930;
        assert!(validate_chapter_map(
            &map,
            &catalog.scenes,
            &catalog.manifest.assets,
            &catalog.manifest.variables,
        )
        .is_err());

        map.width = 1920;
        map.hotspots[0].x = i32::MAX;
        assert!(validate_chapter_map(
            &map,
            &catalog.scenes,
            &catalog.manifest.assets,
            &catalog.manifest.variables,
        )
        .is_err());

        map.hotspots[0].x = 240;
        map.view_x = 0;
        assert!(validate_chapter_map(
            &map,
            &catalog.scenes,
            &catalog.manifest.assets,
            &catalog.manifest.variables,
        )
        .is_err());
        map.view_x = 960;
        map.width = 3840;
        map.view_x = 960 - 20;
        assert!(validate_chapter_map(
            &map,
            &catalog.scenes,
            &catalog.manifest.assets,
            &catalog.manifest.variables,
        )
        .is_err());
        map.view_x = 960;
        assert!(validate_chapter_map(
            &map,
            &catalog.scenes,
            &catalog.manifest.assets,
            &catalog.manifest.variables,
        )
        .is_ok());

        map.view_x = 951;
        assert!(validate_chapter_map(
            &map,
            &catalog.scenes,
            &catalog.manifest.assets,
            &catalog.manifest.variables,
        )
        .is_err());
    }

    #[test]
    fn unresolved_git_lfs_assets_are_rejected_with_an_actionable_error() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("missing.png");
        fs::write(
            &path,
            "version https://git-lfs.github.com/spec/v1\noid sha256:deadbeef\nsize 42\n",
        )
        .unwrap();

        let error = reject_git_lfs_pointer("bg.missing", &path).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("Git LFS 指针"));
        assert!(message.contains("git lfs pull"));
    }

    #[test]
    fn generated_development_schemas_are_current() {
        let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let catalog = ContentCatalog::from_root(crate_root.join("tests/fixtures/game")).unwrap();
        let generated = tempfile::tempdir().unwrap();
        catalog.write_schemas(generated.path()).unwrap();
        let checked_in = crate_root.join("../../src-tauri/gen/content-schemas");
        for name in [
            "manifest.schema.json",
            "scene.schema.json",
            "chapter-map.schema.json",
            "ui-motion.schema.json",
            "button.schema.json",
            "image-animation.schema.json",
        ] {
            assert_eq!(
                fs::read(generated.path().join(name)).unwrap(),
                fs::read(checked_in.join(name)).unwrap(),
                "generated schema is stale: {name}"
            );
        }
    }

    #[test]
    fn auto_advance_marker_must_be_terminal_and_unescaped() {
        assert!(validate_auto_advance_marker("完成后继续。[auto]", "s", "n").is_ok());
        assert!(validate_auto_advance_marker(r"\[auto]", "s", "n").is_ok());
        assert!(validate_auto_advance_marker("[auto] 不能在开头", "s", "n").is_err());
        assert!(validate_auto_advance_marker("[auto][auto]", "s", "n").is_err());
    }

    #[test]
    fn markup_scanner_respects_escapes_and_formula_boundaries() {
        assert!(scan_text_markup(r"\[fx=glow] $[pause=oops]$ \$ [var=name]").is_ok());
        assert!(scan_text_markup("$$[fx=not-a-control][/fx]$$").is_ok());
        assert!(scan_text_markup("[fx=shake][fx=glow]字[/fx][/fx]").is_ok());
        assert!(scan_text_markup("普通文本 [AFKV;").is_ok());
    }

    #[test]
    fn markup_scanner_rejects_malformed_controls_and_effect_stack_errors() {
        for source in [
            "[fx=unknown]字[/fx]",
            "[fx=glow]未闭合",
            "[/fx]多余结束",
            "[fx=glow]错序[/fx][/fx]",
            "[pause=abcms]",
            "[pause=50]",
            "[speed=0cps]",
            "[speed=fast]",
            "[auto]后面还有字",
        ] {
            assert!(scan_text_markup(source).is_err(), "should reject {source}");
        }
    }

    #[test]
    fn markup_scanner_keeps_unmatched_dollars_as_plain_text() {
        assert!(scan_text_markup("金额 $678932{}|{}[AFKV;").is_ok());
        assert!(scan_text_markup("\n[fx=glow]字[/fx]\r\n").is_ok());
    }

    #[test]
    fn long_text_steps_require_stable_ids_and_a_nonleading_page_break() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/game");
        let catalog = ContentCatalog::from_root(root.clone()).unwrap();
        let ui_motion_files: BTreeMap<String, UiMotionPreset> = catalog
            .manifest
            .ui_motions
            .iter()
            .map(|path| (path.clone(), read_yaml(&root.join(path)).unwrap()))
            .collect();
        let mut scenes = catalog.scenes.clone();
        let scene = scenes.get_mut("prologue").unwrap();
        scene.nodes.insert(
            "lecture".to_owned(),
            SceneNode::LongText {
                document: None,
                mode: crate::model::LongTextMode::Start,
                on_exit: crate::model::LongTextExit::Close,
                paper: Some("gui.dialogue_box".to_owned()),
                pagination: Some(crate::model::LongTextPagination::Auto),
                font_size: Some(crate::model::LONG_TEXT_FONT_SIZE_DEFAULT),
                text_color: Some(crate::model::LONG_TEXT_COLOR_DEFAULT.to_owned()),
                layout: Some(crate::model::LongTextLayout::default()),
                steps: vec![
                    crate::model::LongTextStep {
                        id: "definition".to_owned(),
                        text: "设 $V$ 是向量空间。".to_owned(),
                        page_break_before: false,
                    },
                    crate::model::LongTextStep {
                        id: "consequence".to_owned(),
                        text: "则 $0\\in V$。".to_owned(),
                        page_break_before: true,
                    },
                ],
                speed_cps: Some(30.0),
                reveal_animation: None,
                next: "introduction".to_owned(),
            },
        );
        let valid = ContentCatalog::from_documents(
            root.clone(),
            catalog.manifest.clone(),
            scenes.clone(),
            ui_motion_files.clone(),
        );
        assert!(valid.is_ok(), "{valid:?}");

        let SceneNode::LongText { steps, .. } = scenes
            .get_mut("prologue")
            .unwrap()
            .nodes
            .get_mut("lecture")
            .unwrap()
        else {
            panic!("fixture must contain long_text")
        };
        steps[0].page_break_before = true;
        let error =
            ContentCatalog::from_documents(root, catalog.manifest.clone(), scenes, ui_motion_files)
                .unwrap_err();
        assert!(error.to_string().contains("第一步骤"));
    }

    #[test]
    fn continuation_inherits_start_presentation_and_pagination_rules() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/game");
        let catalog = ContentCatalog::from_root(root.clone()).unwrap();
        let ui_motion_files: BTreeMap<String, UiMotionPreset> = catalog
            .manifest
            .ui_motions
            .iter()
            .map(|path| (path.clone(), read_yaml(&root.join(path)).unwrap()))
            .collect();
        let mut scenes = catalog.scenes.clone();
        let scene = scenes.get_mut("prologue").unwrap();
        scene.nodes.insert(
            "lecture_start".to_owned(),
            SceneNode::LongText {
                document: Some("lecture".to_owned()),
                mode: LongTextMode::Start,
                on_exit: crate::model::LongTextExit::KeepVisible,
                paper: None,
                pagination: Some(LongTextPagination::Continuous),
                font_size: Some(32.0),
                text_color: Some(crate::model::LONG_TEXT_COLOR_DEFAULT.to_owned()),
                layout: Some(crate::model::LongTextLayout::default()),
                steps: vec![crate::model::LongTextStep {
                    id: "first".to_owned(),
                    text: "第一段".to_owned(),
                    page_break_before: false,
                }],
                speed_cps: None,
                reveal_animation: None,
                next: "introduction".to_owned(),
            },
        );

        let mut with_style = scenes.clone();
        with_style.get_mut("prologue").unwrap().nodes.insert(
            "lecture_continue_style".to_owned(),
            SceneNode::LongText {
                document: Some("lecture".to_owned()),
                mode: LongTextMode::Continue,
                on_exit: crate::model::LongTextExit::Close,
                paper: None,
                pagination: Some(LongTextPagination::Auto),
                font_size: None,
                text_color: None,
                layout: None,
                steps: vec![crate::model::LongTextStep {
                    id: "second".to_owned(),
                    text: "第二段".to_owned(),
                    page_break_before: false,
                }],
                speed_cps: None,
                reveal_animation: None,
                next: "introduction".to_owned(),
            },
        );
        let style_error = ContentCatalog::from_documents(
            root.clone(),
            catalog.manifest.clone(),
            with_style,
            ui_motion_files.clone(),
        )
        .unwrap_err();
        assert!(style_error.to_string().contains("只能继承"));

        let mut with_break = scenes;
        with_break.get_mut("prologue").unwrap().nodes.insert(
            "lecture_continue_break".to_owned(),
            SceneNode::LongText {
                document: Some("lecture".to_owned()),
                mode: LongTextMode::Continue,
                on_exit: crate::model::LongTextExit::Close,
                paper: None,
                pagination: None,
                font_size: None,
                text_color: None,
                layout: None,
                steps: vec![crate::model::LongTextStep {
                    id: "third".to_owned(),
                    text: "第三段".to_owned(),
                    page_break_before: true,
                }],
                speed_cps: None,
                reveal_animation: None,
                next: "introduction".to_owned(),
            },
        );
        let break_error =
            ContentCatalog::from_documents(root, catalog.manifest, with_break, ui_motion_files)
                .unwrap_err();
        assert!(break_error.to_string().contains("连续长文本"));
    }

    #[test]
    fn story_node_numeric_fields_reject_non_finite_values() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/game");
        let catalog = ContentCatalog::from_root(root).unwrap();
        let validate = |scenes: &BTreeMap<String, SceneDefinition>| {
            validate_scenes(
                scenes,
                &catalog.manifest.assets,
                &catalog.manifest.variables,
                &catalog.manifest.characters,
                &catalog.ui_motions,
                &catalog.buttons,
                &catalog.actions,
            )
        };

        let mut sprite_scenes = catalog.scenes.clone();
        sprite_scenes.get_mut("prologue").unwrap().nodes.insert(
            "invalid_sprite_position".to_owned(),
            SceneNode::Sprite {
                sprite_id: "nan".to_owned(),
                action: SpriteAction::Show,
                asset: Some("sprite.jelly".to_owned()),
                character: None,
                expression: None,
                flip_x: Some(false),
                crossfade_ms: None,
                x: Some(f32::NAN),
                y: None,
                scale: Some(1.0),
                opacity: Some(1.0),
                z: None,
                duration_ms: 0,
                easing: crate::model::Easing::Linear,
                await_completion: false,
                next: "introduction".to_owned(),
            },
        );
        assert!(validate(&sprite_scenes)
            .unwrap_err()
            .to_string()
            .contains("sprite 坐标"));

        let mut speed_scenes = catalog.scenes.clone();
        speed_scenes.get_mut("prologue").unwrap().nodes.insert(
            "invalid_say_speed".to_owned(),
            SceneNode::Say {
                speaker: None,
                text: "无效速度".to_owned(),
                mode: DialogueMode::Start,
                page_id: None,
                speed_cps: Some(f32::INFINITY),
                reveal_animation: None,
                next: "introduction".to_owned(),
            },
        );
        assert!(validate(&speed_scenes)
            .unwrap_err()
            .to_string()
            .contains("speed_cps"));

        let mut long_text_scenes = catalog.scenes.clone();
        long_text_scenes.get_mut("prologue").unwrap().nodes.insert(
            "invalid_long_text_font_size".to_owned(),
            SceneNode::LongText {
                document: None,
                mode: crate::model::LongTextMode::Start,
                on_exit: crate::model::LongTextExit::Close,
                paper: None,
                pagination: Some(crate::model::LongTextPagination::Auto),
                font_size: Some(73.0),
                text_color: Some(crate::model::LONG_TEXT_COLOR_DEFAULT.to_owned()),
                layout: Some(crate::model::LongTextLayout::default()),
                steps: vec![crate::model::LongTextStep {
                    id: "step".to_owned(),
                    text: "无效字号".to_owned(),
                    page_break_before: false,
                }],
                speed_cps: None,
                reveal_animation: None,
                next: "introduction".to_owned(),
            },
        );
        assert!(validate(&long_text_scenes)
            .unwrap_err()
            .to_string()
            .contains("font_size"));

        let mut camera_scenes = catalog.scenes.clone();
        camera_scenes.get_mut("prologue").unwrap().nodes.insert(
            "invalid_camera_position".to_owned(),
            SceneNode::Camera {
                x: f32::NEG_INFINITY,
                y: 0.0,
                zoom: f32::NAN,
                duration_ms: 0,
                easing: crate::model::Easing::Linear,
                await_completion: false,
                next: "introduction".to_owned(),
            },
        );
        assert!(validate(&camera_scenes)
            .unwrap_err()
            .to_string()
            .contains("camera 坐标"));
    }

    #[test]
    fn timeline_screen_effects_follow_the_single_animation_duration_limit() {
        let catalog = ContentCatalog::from_root(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/game"),
        )
        .unwrap();
        let error = validate_timeline(
            120_000,
            true,
            false,
            &[],
            &[TimelineEvent::ScreenEffect {
                id: "too_long".to_owned(),
                at_ms: 1,
                effect: crate::model::ScreenEffectSpec::Flash {
                    color: crate::model::FLASH_COLOR_DEFAULT.to_owned(),
                    peak_alpha: crate::model::FLASH_PEAK_ALPHA_DEFAULT,
                },
                duration_ms: 60_001,
            }],
            &catalog.manifest.assets,
            "prologue",
            "timeline_limit_test",
        )
        .unwrap_err();
        assert!(error.to_string().contains("不能超过 60 秒"));
    }

    #[test]
    fn identifiers_are_deliberately_boring() {
        assert!(validate_identifier("id", "bg.classroom-night_1").is_ok());
        assert!(validate_identifier("id", "../scene").is_err());
        assert!(validate_identifier("id", "space here").is_err());
    }

    #[test]
    fn duplicate_yaml_keys_are_rejected() {
        let yaml = "schema_version: 1\ncontent_version: first\ncontent_version: second\nentry_scene: a\ndefault_locale: zh-CN\nassets: {}\nscenes: []\n";
        let options = serde_saphyr::options! { strict_booleans: true };
        let result = serde_saphyr::from_str_with_options::<ContentManifest>(yaml, options);
        assert!(result.is_err());
    }

    #[test]
    fn timeline_inherit_is_only_a_zero_ms_first_frame() {
        let inherited = TimelineKeyframe {
            at_ms: 0,
            value: TimelineKeyframeValue::Keyword(TimelineKeyframeKeyword::Inherit),
            easing: TimelineEasing::Preset(TimelineEasingPreset::Linear),
        };
        let target = TimelineKeyframe {
            at_ms: 500,
            value: TimelineKeyframeValue::Number(700.0),
            easing: TimelineEasing::Preset(TimelineEasingPreset::Linear),
        };
        let mut count = 0;
        let valid = BTreeMap::from([("x".to_owned(), vec![inherited.clone(), target.clone()])]);
        assert!(validate_timeline_channels(
            &valid,
            &["x"],
            500,
            "scene",
            "timeline",
            &mut count,
            true,
        )
        .is_ok());

        let mut late = inherited.clone();
        late.at_ms = 100;
        let mut count = 0;
        let invalid_position = BTreeMap::from([("x".to_owned(), vec![late, target.clone()])]);
        assert!(validate_timeline_channels(
            &invalid_position,
            &["x"],
            500,
            "scene",
            "timeline",
            &mut count,
            true,
        )
        .is_err());

        let mut count = 0;
        assert!(validate_timeline_channels(
            &valid,
            &["x"],
            500,
            "scene",
            "timeline",
            &mut count,
            false,
        )
        .is_err());

        let mut count = 0;
        let missing_target = BTreeMap::from([("x".to_owned(), vec![inherited])]);
        assert!(validate_timeline_channels(
            &missing_target,
            &["x"],
            500,
            "scene",
            "timeline",
            &mut count,
            true,
        )
        .is_err());
    }

    #[test]
    fn variable_defaults_and_condition_types_are_strict() {
        let mut variables = BTreeMap::from([(
            "score".to_owned(),
            VariableDefinition {
                scope: crate::model::VariableScope::Save,
                value_type: VariableType::Integer,
                default: ScalarValue::Integer(0),
            },
        )]);
        assert!(validate_variable_definitions(&variables).is_ok());
        variables.get_mut("score").unwrap().default = ScalarValue::Text("0".to_owned());
        assert!(validate_variable_definitions(&variables).is_err());

        let invalid_order = ConditionExpression::Gt {
            left: ValueOperand::Variable(VariableOperand {
                variable: "score".to_owned(),
            }),
            right: ValueOperand::Literal(LiteralOperand {
                value: ScalarValue::Text("ten".to_owned()),
            }),
        };
        variables.get_mut("score").unwrap().default = ScalarValue::Integer(0);
        assert!(validate_condition(&invalid_order, &variables, "scene", "node").is_err());
    }

    #[test]
    fn empty_and_excessively_deep_conditions_are_rejected() {
        let variables = BTreeMap::new();
        assert!(validate_condition(
            &ConditionExpression::And {
                conditions: Vec::new(),
            },
            &variables,
            "scene",
            "node",
        )
        .is_err());

        let mut condition = ConditionExpression::Eq {
            left: ValueOperand::Literal(LiteralOperand {
                value: ScalarValue::Boolean(true),
            }),
            right: ValueOperand::Literal(LiteralOperand {
                value: ScalarValue::Boolean(true),
            }),
        };
        for _ in 0..MAX_CONDITION_DEPTH {
            condition = ConditionExpression::Not {
                condition: Box::new(condition),
            };
        }
        assert!(validate_condition(&condition, &variables, "scene", "node").is_err());
    }

    #[test]
    fn character_names_colors_and_template_types_are_strict() {
        assert!(validate_display_name("爱丽丝").is_ok());
        assert!(validate_display_name("").is_err());
        assert!(validate_display_name("line\nbreak").is_err());
        assert!(validate_display_name(&"角".repeat(65)).is_err());
        assert!(validate_color("#80D8FF").is_ok());
        assert!(validate_color("#80D8FFCC").is_ok());
        assert!(validate_color("80D8FF").is_err());
        assert!(validate_color("#XYZXYZ").is_err());

        let variables = BTreeMap::from([
            (
                "score".to_owned(),
                VariableDefinition {
                    scope: crate::model::VariableScope::Save,
                    value_type: VariableType::Integer,
                    default: ScalarValue::Integer(0),
                },
            ),
            (
                "name".to_owned(),
                VariableDefinition {
                    scope: crate::model::VariableScope::Save,
                    value_type: VariableType::String,
                    default: ScalarValue::Text(String::new()),
                },
            ),
        ]);
        assert!(validate_text_markup("[var=name] $[var=score]$", &variables, "s", "n").is_ok());
        assert!(validate_text_markup("$[var=name]$", &variables, "s", "n").is_err());
        assert!(validate_text_markup("[var=missing]", &variables, "s", "n").is_err());
        assert!(validate_text_markup(r"\[var=missing]", &variables, "s", "n").is_ok());
    }

    #[test]
    fn mutation_validation_covers_operations_and_operand_variables() {
        let variables = BTreeMap::from([
            (
                "score".to_owned(),
                VariableDefinition {
                    scope: crate::model::VariableScope::Save,
                    value_type: VariableType::Integer,
                    default: ScalarValue::Integer(0),
                },
            ),
            (
                "bonus".to_owned(),
                VariableDefinition {
                    scope: crate::model::VariableScope::Save,
                    value_type: VariableType::Integer,
                    default: ScalarValue::Integer(1),
                },
            ),
            (
                "flag".to_owned(),
                VariableDefinition {
                    scope: crate::model::VariableScope::Save,
                    value_type: VariableType::Boolean,
                    default: ScalarValue::Boolean(false),
                },
            ),
        ]);
        assert!(validate_mutation(
            VariableOperation::Add,
            Some(&MutationValue::Variable(VariableOperand {
                variable: "bonus".to_owned(),
            })),
            VariableType::Integer,
            &variables,
            "scene",
            "node",
        )
        .is_ok());
        assert!(validate_mutation(
            VariableOperation::Toggle,
            None,
            VariableType::Boolean,
            &variables,
            "scene",
            "node",
        )
        .is_ok());
        assert!(validate_mutation(
            VariableOperation::Append,
            Some(&MutationValue::Literal(ScalarValue::Text("x".to_owned()))),
            VariableType::Integer,
            &variables,
            "scene",
            "node",
        )
        .is_err());
    }

    #[test]
    fn sprite_action_documents_reject_empty_channels_and_bad_parameters() {
        let base = SpriteActionDefinition {
            schema_version: SPRITE_ACTION_SCHEMA_VERSION,
            id: "sprite.test".to_owned(),
            name: "测试动作".to_owned(),
            duration_ms: 100,
            channels: BTreeMap::new(),
            parameters: BTreeMap::new(),
            end: SpriteActionEnd::Hold,
        };
        assert!(validate_action_document(&base)
            .unwrap_err()
            .to_string()
            .contains("至少需要一个变换通道"));

        let invalid_range = SpriteActionDefinition {
            channels: BTreeMap::from([(
                "x".to_owned(),
                vec![SpriteActionKeyframe {
                    at_ms: 0,
                    value: 0.0,
                    easing: TimelineEasing::default(),
                    parameter: Some("distance".to_owned()),
                }],
            )]),
            parameters: BTreeMap::from([(
                "distance".to_owned(),
                SpriteActionParameter {
                    default: 5.0,
                    min: Some(10.0),
                    max: Some(1.0),
                },
            )]),
            ..base.clone()
        };
        assert!(validate_action_document(&invalid_range).is_err());

        let delayed_start = SpriteActionDefinition {
            channels: BTreeMap::from([(
                "x".to_owned(),
                vec![SpriteActionKeyframe {
                    at_ms: 50,
                    value: 10.0,
                    easing: TimelineEasing::default(),
                    parameter: None,
                }],
            )]),
            ..base.clone()
        };
        assert!(validate_action_document(&delayed_start)
            .unwrap_err()
            .to_string()
            .contains("必须从 0ms"));

        let unknown_parameter = SpriteActionDefinition {
            channels: BTreeMap::from([(
                "x".to_owned(),
                vec![SpriteActionKeyframe {
                    at_ms: 0,
                    value: 0.0,
                    easing: TimelineEasing::default(),
                    parameter: Some("missing".to_owned()),
                }],
            )]),
            ..base
        };
        assert!(validate_action_document(&unknown_parameter)
            .unwrap_err()
            .to_string()
            .contains("未知参数"));
    }

    fn fixture_catalog() -> ContentCatalog {
        ContentCatalog::from_root(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/game"),
        )
        .expect("fixture content must be valid")
    }

    fn validate_fixture_scenes(
        catalog: &ContentCatalog,
        scenes: &BTreeMap<String, SceneDefinition>,
    ) -> Result<(), ContentError> {
        validate_scenes(
            scenes,
            &catalog.manifest.assets,
            &catalog.manifest.variables,
            &catalog.manifest.characters,
            &catalog.ui_motions,
            &catalog.buttons,
            &catalog.actions,
        )
    }

    fn prologue_with_node(
        catalog: &ContentCatalog,
        node_id: &str,
        node: SceneNode,
    ) -> BTreeMap<String, SceneDefinition> {
        let mut scenes = catalog.scenes.clone();
        scenes
            .get_mut("prologue")
            .unwrap()
            .nodes
            .insert(node_id.to_owned(), node);
        scenes
    }

    #[test]
    fn transition_and_effect_parameters_are_range_checked() {
        let catalog = fixture_catalog();
        let background = |transition| SceneNode::Background {
            background: None,
            transition,
            duration_ms: 300,
            easing: crate::model::Easing::EaseInOut,
            await_completion: false,
            next: "introduction".to_owned(),
        };
        let effect = |effect| SceneNode::ScreenEffect {
            effect,
            duration_ms: 200,
            await_completion: false,
            next: "introduction".to_owned(),
        };
        let cases = vec![
            (
                "bad_transition_color",
                background(BackgroundTransitionSpec::FadeThroughColor {
                    color: "red".to_owned(),
                }),
                "颜色",
            ),
            (
                "bad_transition_softness",
                background(BackgroundTransitionSpec::Wipe {
                    direction: crate::model::TransitionDirection::LeftToRight,
                    softness: 1.5,
                }),
                "softness",
            ),
            (
                "bad_flash_color",
                effect(ScreenEffectSpec::Flash {
                    color: "#FFF".to_owned(),
                    peak_alpha: 0.5,
                }),
                "颜色",
            ),
            (
                "bad_flash_alpha",
                effect(ScreenEffectSpec::Flash {
                    color: "#FFFFFF".to_owned(),
                    peak_alpha: 1.5,
                }),
                "peak_alpha",
            ),
            (
                "bad_shake_amplitude",
                effect(ScreenEffectSpec::Shake {
                    amplitude_x: 300.0,
                    amplitude_y: 0.0,
                    frequency_hz: 10.0,
                    decay: 1.0,
                    seed: 0,
                }),
                "amplitude_x",
            ),
            (
                "bad_shake_frequency",
                effect(ScreenEffectSpec::Shake {
                    amplitude_x: 0.0,
                    amplitude_y: 0.0,
                    frequency_hz: 0.0,
                    decay: 1.0,
                    seed: 0,
                }),
                "frequency_hz",
            ),
            (
                "bad_shake_decay",
                effect(ScreenEffectSpec::Shake {
                    amplitude_x: 0.0,
                    amplitude_y: 0.0,
                    frequency_hz: 10.0,
                    decay: 1.5,
                    seed: 0,
                }),
                "decay",
            ),
        ];
        for (node_id, node, expected) in cases {
            let scenes = prologue_with_node(&catalog, node_id, node);
            let error = validate_fixture_scenes(&catalog, &scenes)
                .unwrap_err()
                .to_string();
            assert!(error.contains(expected), "{node_id}: {error}");
        }
    }

    #[test]
    fn curtain_nodes_require_a_cover_fill_and_reject_one_on_reveal() {
        let catalog = fixture_catalog();
        let curtain = |action, fill| SceneNode::Curtain {
            action,
            fill,
            transition: crate::model::CurtainTransitionSpec::SplitHorizontal,
            duration_ms: 600,
            easing: crate::model::Easing::EaseInOut,
            await_completion: true,
            next: "introduction".to_owned(),
        };
        let cases = vec![
            (
                "cover_without_fill",
                curtain(CurtainAction::Cover, None),
                "必须提供 fill",
            ),
            (
                "reveal_with_fill",
                curtain(
                    CurtainAction::Reveal,
                    Some(CurtainFill::Color {
                        color: "#000000".to_owned(),
                    }),
                ),
                "不能指定 fill",
            ),
            (
                "cover_with_bad_color",
                curtain(
                    CurtainAction::Cover,
                    Some(CurtainFill::Color {
                        color: "#00".to_owned(),
                    }),
                ),
                "颜色",
            ),
            (
                "cover_with_unknown_asset",
                curtain(
                    CurtainAction::Cover,
                    Some(CurtainFill::Asset {
                        asset: "gui.missing".to_owned(),
                    }),
                ),
                "未知素材",
            ),
            (
                "cover_with_wrong_kind",
                curtain(
                    CurtainAction::Cover,
                    Some(CurtainFill::Asset {
                        asset: "sprite.jelly".to_owned(),
                    }),
                ),
                "类型不正确",
            ),
        ];
        for (node_id, node, expected) in cases {
            let scenes = prologue_with_node(&catalog, node_id, node);
            let error = validate_fixture_scenes(&catalog, &scenes)
                .unwrap_err()
                .to_string();
            assert!(error.contains(expected), "{node_id}: {error}");
        }

        let scenes = prologue_with_node(
            &catalog,
            "valid_cover",
            curtain(
                CurtainAction::Cover,
                Some(CurtainFill::Asset {
                    asset: "gui.dialogue_box".to_owned(),
                }),
            ),
        );
        assert!(validate_fixture_scenes(&catalog, &scenes).is_ok());
    }
}
