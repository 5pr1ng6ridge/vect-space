use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::model::{
    AssetDefinition, AssetKind, ChapterMapDefinition, ChapterMapReveal, ConditionExpression,
    SceneDefinition, ValueOperand, VariableDefinition, VariableScope,
};
use super::ContentError;
use super::common::{
    canonical_file_within, read_yaml, validate_display_name, validate_identifier,
    validate_relative_path,
};
use super::conditions::{validate_condition, validate_value_for_type};

pub(super) const CHAPTER_MAP_SCHEMA_VERSION: u32 = 1;

const CHAPTER_MAP_MIN_WIDTH: u32 = 1920;
const CHAPTER_MAP_MIN_HEIGHT: u32 = 1080;
const CHAPTER_MAP_MAX_SIZE: u32 = 16_380;
const CHAPTER_MAP_GRID: i32 = 20;
pub(super) const MAX_CHAPTER_MAP_HOVER_TEXT_CHARS: usize = 256;

pub(super) fn load_chapter_map(
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

pub(super) fn validate_chapter_map(
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
        if scenes[&hotspot.scene_id].window_role != crate::interaction::WindowRole::Main {
            return Err(ContentError::Validation(format!(
                "章节热点 {} 不能引用副窗口专用 Scene {}",
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
