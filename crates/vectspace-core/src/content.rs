use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

use schemars::schema_for;
use thiserror::Error;

use crate::model::{
    AssetDefinition, AssetKind, AudioAction, CharacterDefinition, ConditionExpression,
    ContentManifest, DialogueMode, LongTextPagination, MutationValue, ResolvedAsset, ScalarValue,
    SceneDefinition, SceneNode, SpriteAction, StoryFlowDefinition, StoryFlowReveal,
    TimelineChannels, TimelineEasing, TimelineEvent, TimelineTrack, UiMotionBindings,
    UiMotionPreset, ValueOperand, VariableDefinition, VariableOperation, VariableScope,
    VariableType, LONG_TEXT_FONT_SIZE_MAX, LONG_TEXT_FONT_SIZE_MIN,
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
const STORY_FLOW_SCHEMA_VERSION: u32 = 1;

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
    pub manifest: ContentManifest,
    pub scenes: BTreeMap<String, SceneDefinition>,
    pub ui_motions: BTreeMap<String, UiMotionPreset>,
    pub story_flow: Option<StoryFlowDefinition>,
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
        validate_identifier("entry_scene", &manifest.entry_scene)?;
        validate_variable_definitions(&manifest.variables)?;
        validate_character_definitions(&manifest.characters)?;

        let assets_root = canonical_directory(&root.join("assets"))?;
        validate_assets(&assets_root, &manifest.assets)?;

        let ui_motions = load_ui_motions(&root, &manifest.ui_motions)?;
        validate_ui_motion_bindings(&manifest.ui_motion_defaults, &ui_motions)?;

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
        )?;
        let story_flow = load_story_flow(
            &root,
            manifest.story_flow.as_deref(),
            &scenes,
            &manifest.variables,
        )?;

        Ok(Self {
            assets_root,
            manifest,
            scenes,
            ui_motions,
            story_flow,
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
        story_flow: Option<StoryFlowDefinition>,
    ) -> Result<Self, ContentError> {
        let root = canonical_directory(&root)?;
        if manifest.schema_version != CONTENT_SCHEMA_VERSION {
            return Err(ContentError::Validation(format!(
                "不支持 manifest schema_version {}",
                manifest.schema_version
            )));
        }
        validate_identifier("entry_scene", &manifest.entry_scene)?;
        validate_variable_definitions(&manifest.variables)?;
        validate_character_definitions(&manifest.characters)?;

        let assets_root = canonical_directory(&root.join("assets"))?;
        validate_assets(&assets_root, &manifest.assets)?;
        let ui_motions = validate_ui_motion_files(&manifest.ui_motions, &ui_motion_files)?;
        validate_ui_motion_bindings(&manifest.ui_motion_defaults, &ui_motions)?;

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
        )?;
        if manifest.story_flow.is_some() != story_flow.is_some() {
            return Err(ContentError::Validation(
                "manifest 的 story_flow 与编辑器文档不一致".to_owned(),
            ));
        }
        if let Some(flow) = &story_flow {
            validate_story_flow(flow, &scenes, &manifest.variables)?;
        }

        Ok(Self {
            assets_root,
            manifest,
            scenes,
            ui_motions,
            story_flow,
        })
    }

    pub fn assets_root(&self) -> &Path {
        &self.assets_root
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
            let relative = validate_relative_path(&definition.path)?;
            let path = canonical_file_within(&self.assets_root, &self.assets_root.join(relative))?;
            resolved.push(ResolvedAsset {
                id: id.clone(),
                kind: definition.kind,
                absolute_path: path.to_string_lossy().into_owned(),
            });
        }
        Ok(resolved)
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
            &target.join("story-flow.schema.json"),
            &schema_for!(StoryFlowDefinition),
        )?;
        write_schema(
            &target.join("scene.schema.json"),
            &schema_for!(SceneDefinition),
        )?;
        write_schema(
            &target.join("ui-motion.schema.json"),
            &schema_for!(UiMotionPreset),
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

fn load_story_flow(
    root: &Path,
    path: Option<&str>,
    scenes: &BTreeMap<String, SceneDefinition>,
    variables: &BTreeMap<String, VariableDefinition>,
) -> Result<Option<StoryFlowDefinition>, ContentError> {
    let Some(path) = path else { return Ok(None) };
    let relative = validate_relative_path(path)?;
    let full_path = canonical_file_within(root, &root.join(relative))?;
    let flow: StoryFlowDefinition = read_yaml(&full_path)?;
    validate_story_flow(&flow, scenes, variables)?;
    Ok(Some(flow))
}

fn validate_story_flow(
    flow: &StoryFlowDefinition,
    scenes: &BTreeMap<String, SceneDefinition>,
    variables: &BTreeMap<String, VariableDefinition>,
) -> Result<(), ContentError> {
    if flow.schema_version != STORY_FLOW_SCHEMA_VERSION {
        return Err(ContentError::Validation(format!(
            "不支持 story flow schema_version {}",
            flow.schema_version
        )));
    }
    for (scene_id, node) in &flow.nodes {
        validate_identifier("story flow scene id", scene_id)?;
        if !scenes.contains_key(scene_id) {
            return Err(ContentError::Validation(format!(
                "流程图引用未知场景 {scene_id}"
            )));
        }
        validate_display_name(&node.title).map_err(|message| {
            ContentError::Validation(format!("流程节点 {scene_id} 标题无效: {message}"))
        })?;
        if node.x % 20 != 0 || node.y % 20 != 0 {
            return Err(ContentError::Validation(format!(
                "流程节点 {scene_id} 坐标必须吸附到 20px 网格"
            )));
        }
        if !(-100_000..=100_000).contains(&node.x) || !(-100_000..=100_000).contains(&node.y) {
            return Err(ContentError::Validation(format!(
                "流程节点 {scene_id} 坐标超出允许范围"
            )));
        }
        if let StoryFlowReveal::Condition { condition } = &node.reveal {
            validate_condition(condition, variables, "story_flow", scene_id)?;
            validate_profile_only_condition(condition, variables, scene_id)?;
        }
    }
    let mut ids = BTreeSet::new();
    let mut connections = BTreeSet::new();
    for edge in &flow.edges {
        validate_identifier("story flow edge id", &edge.id)?;
        if !ids.insert(&edge.id) {
            return Err(ContentError::Validation(format!(
                "流程边 ID 重复: {}",
                edge.id
            )));
        }
        if edge.from == edge.to {
            return Err(ContentError::Validation(format!(
                "流程边 {} 不能自连接",
                edge.id
            )));
        }
        if !flow.nodes.contains_key(&edge.from) || !flow.nodes.contains_key(&edge.to) {
            return Err(ContentError::Validation(format!(
                "流程边 {} 存在悬空端点",
                edge.id
            )));
        }
        if !connections.insert((&edge.from, &edge.to)) {
            return Err(ContentError::Validation(format!(
                "流程连接重复: {} -> {}",
                edge.from, edge.to
            )));
        }
        if let Some(label) = &edge.label {
            validate_display_name(label).map_err(|message| {
                ContentError::Validation(format!("流程边 {} 标签无效: {message}", edge.id))
            })?;
        }
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
                    "流程节点 {node_id} 的揭示条件只能引用 profile 变量: {}",
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
) -> Result<(), ContentError> {
    if assets.is_empty() {
        return Err(ContentError::Validation("素材表不能为空".to_owned()));
    }
    for (id, definition) in assets {
        validate_identifier("asset id", id)?;
        let relative = validate_relative_path(&definition.path)?;
        let asset_path = canonical_file_within(assets_root, &assets_root.join(relative))?;
        reject_git_lfs_pointer(id, &asset_path)?;
        if definition.kind == AssetKind::Video
            && Path::new(&definition.path)
                .extension()
                .and_then(|value| value.to_str())
                .is_none_or(|extension| !extension.eq_ignore_ascii_case("mp4"))
        {
            return Err(ContentError::Validation(format!(
                "视频素材 {id} 必须使用 .mp4（H.264/AAC）"
            )));
        }
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
    }
    Ok(())
}

fn validate_scenes(
    scenes: &BTreeMap<String, SceneDefinition>,
    assets: &BTreeMap<String, AssetDefinition>,
    variables: &BTreeMap<String, VariableDefinition>,
    characters: &BTreeMap<String, CharacterDefinition>,
    ui_motions: &BTreeMap<String, UiMotionPreset>,
) -> Result<(), ContentError> {
    for (scene_id, scene) in scenes {
        if !scene.nodes.contains_key(&scene.entry) {
            return Err(ContentError::Validation(format!(
                "场景 {scene_id} 的入口节点不存在: {}",
                scene.entry
            )));
        }
        for (node_id, node) in &scene.nodes {
            validate_identifier("node id", node_id)?;
            match node {
                SceneNode::Background {
                    background,
                    duration_ms,
                    next,
                    ..
                } => {
                    if let Some(id) = background {
                        require_asset(assets, id, AssetKind::Background, scene_id, node_id)?;
                    }
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Sprite {
                    action,
                    asset,
                    x,
                    y,
                    scale,
                    opacity,
                    duration_ms,
                    next,
                    ..
                } => {
                    if *action == SpriteAction::Show && asset.is_none() {
                        return node_error(scene_id, node_id, "show 动作必须提供 asset");
                    }
                    if let Some(id) = asset {
                        require_asset(assets, id, AssetKind::Sprite, scene_id, node_id)?;
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
                    if let Some(paper) = paper {
                        require_asset(assets, paper, AssetKind::Gui, scene_id, node_id)?;
                    }
                    if steps.is_empty() || steps.len() > MAX_LONG_TEXT_STEPS {
                        return node_error(scene_id, node_id, "长文本必须包含 1 到 1024 个步骤");
                    }
                    if speed_cps.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                        return node_error(scene_id, node_id, "speed_cps 必须是有限正数");
                    }
                    if !font_size.is_finite()
                        || *font_size < LONG_TEXT_FONT_SIZE_MIN
                        || *font_size > LONG_TEXT_FONT_SIZE_MAX
                    {
                        return node_error(
                            scene_id,
                            node_id,
                            "长文本 font_size 必须在 16 到 72 之间",
                        );
                    }
                    validate_color(text_color).map_err(|message| {
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
                        if index == 0 && step.page_break_before {
                            return node_error(
                                scene_id,
                                node_id,
                                "长文本第一步骤不能在前方强制分页",
                            );
                        }
                        if *pagination == LongTextPagination::Continuous && step.page_break_before {
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
                    duration_ms, next, ..
                } => {
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
                SceneNode::Timeline {
                    duration_ms,
                    await_completion,
                    skippable,
                    tracks,
                    events,
                    next,
                } => {
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
                duration_ms: effect_duration,
                ..
            } => {
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

fn validate_color(value: &str) -> Result<(), String> {
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
        LiteralOperand, TimelineEasingPreset, TimelineKeyframe, TimelineKeyframeKeyword,
        TimelineKeyframeValue, VariableOperand,
    };

    #[test]
    fn traversal_is_rejected() {
        assert!(validate_relative_path("../secret.yaml").is_err());
        assert!(validate_relative_path("assets/../../secret").is_err());
        assert!(validate_relative_path("backgrounds/room.png").is_ok());
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
            "story-flow.schema.json",
            "ui-motion.schema.json",
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
                paper: Some("gui.dialogue_box".to_owned()),
                pagination: crate::model::LongTextPagination::Auto,
                font_size: crate::model::LONG_TEXT_FONT_SIZE_DEFAULT,
                text_color: crate::model::LONG_TEXT_COLOR_DEFAULT.to_owned(),
                layout: crate::model::LongTextLayout::default(),
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
            catalog.story_flow.clone(),
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
        let error = ContentCatalog::from_documents(
            root,
            catalog.manifest.clone(),
            scenes,
            ui_motion_files,
            catalog.story_flow.clone(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("第一步骤"));
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
            )
        };

        let mut sprite_scenes = catalog.scenes.clone();
        sprite_scenes.get_mut("prologue").unwrap().nodes.insert(
            "invalid_sprite_position".to_owned(),
            SceneNode::Sprite {
                sprite_id: "nan".to_owned(),
                action: SpriteAction::Show,
                asset: Some("sprite.jelly".to_owned()),
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
                paper: None,
                pagination: crate::model::LongTextPagination::Auto,
                font_size: 73.0,
                text_color: crate::model::LONG_TEXT_COLOR_DEFAULT.to_owned(),
                layout: crate::model::LongTextLayout::default(),
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
                effect: crate::model::ScreenEffectKind::Flash,
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
}
