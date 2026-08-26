use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};

use schemars::schema_for;
use tauri::{path::BaseDirectory, App, Manager};
use thiserror::Error;

use crate::model::{
    AssetDefinition, AssetKind, AudioAction, CharacterDefinition, ConditionExpression,
    ContentManifest, MutationValue, ResolvedAsset, ScalarValue, SceneDefinition, SceneNode,
    SpriteAction, ValueOperand, VariableDefinition, VariableOperation, VariableType,
};
use crate::text_template::{self, MAX_VARIABLE_STRING_BYTES};

const CONTENT_SCHEMA_VERSION: u32 = 2;
const MAX_CONDITION_DEPTH: usize = 32;
const MAX_CONDITION_NODES: usize = 256;

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
    #[error("无法定位应用资源: {0}")]
    Resource(String),
}

#[derive(Debug)]
pub struct ContentCatalog {
    assets_root: PathBuf,
    pub manifest: ContentManifest,
    pub scenes: BTreeMap<String, SceneDefinition>,
}

impl ContentCatalog {
    pub fn load_for_app(app: &App) -> Result<Self, ContentError> {
        let root = if cfg!(debug_assertions) {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../game")
        } else {
            app.path()
                .resolve("game", BaseDirectory::Resource)
                .map_err(|error| ContentError::Resource(error.to_string()))?
        };

        Self::from_root(root)
    }

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
        )?;

        Ok(Self {
            assets_root,
            manifest,
            scenes,
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
        )?;

        Ok(Self {
            assets_root,
            manifest,
            scenes,
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

    pub fn write_development_schemas(&self) -> Result<(), ContentError> {
        if !cfg!(debug_assertions) {
            return Ok(());
        }
        let target = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("gen/content-schemas");
        fs::create_dir_all(&target).map_err(|source| ContentError::Read {
            path: target.clone(),
            source,
        })?;
        write_schema(
            &target.join("manifest.schema.json"),
            &schema_for!(ContentManifest),
        )?;
        write_schema(
            &target.join("scene.schema.json"),
            &schema_for!(SceneDefinition),
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
        canonical_file_within(assets_root, &assets_root.join(relative))?;
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
                    if scale.is_some_and(|value| value <= 0.0) {
                        return node_error(scene_id, node_id, "scale 必须大于 0");
                    }
                    if opacity.is_some_and(|value| !(0.0..=1.0).contains(&value)) {
                        return node_error(scene_id, node_id, "opacity 必须在 0 到 1 之间");
                    }
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Say {
                    speaker,
                    text,
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
                    validate_text_markup(text, variables, scene_id, node_id)?;
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
                    zoom,
                    duration_ms,
                    next,
                    ..
                } => {
                    if *zoom <= 0.0 {
                        return node_error(scene_id, node_id, "camera zoom 必须大于 0");
                    }
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::ScreenEffect {
                    duration_ms, next, ..
                }
                | SceneNode::DialogueUi {
                    duration_ms, next, ..
                } => {
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::End => {}
            }
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
    let open_effects = ["shake", "wave", "glow"]
        .iter()
        .map(|tag| text.matches(&format!("[fx={tag}]")).count())
        .sum::<usize>();
    if open_effects != text.matches("[/fx]").count() {
        return node_error(scene_id, node_id, "文本特效标记未闭合");
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
    use crate::model::{LiteralOperand, VariableOperand};

    #[test]
    fn traversal_is_rejected() {
        assert!(validate_relative_path("../secret.yaml").is_err());
        assert!(validate_relative_path("assets/../../secret").is_err());
        assert!(validate_relative_path("backgrounds/room.png").is_ok());
    }

    #[test]
    fn generated_development_schemas_are_current() {
        let catalog =
            ContentCatalog::from_root(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../game"))
                .unwrap();
        catalog.write_development_schemas().unwrap();
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
