use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::model::{
    AssetDefinition, AssetKind, ButtonClickAction, ButtonPanel, ButtonPostAction, ButtonTemplate,
    SceneDefinition, UiMotionBindings, UiMotionPreset, VariableDefinition,
};
use super::ContentError;
use super::common::{
    canonical_file_within, node_error, read_yaml, validate_identifier, validate_relative_path,
};
use super::conditions::validate_mutation;
use super::timeline::{MAX_TIMELINE_DURATION_MS, MAX_TIMELINE_KEYFRAMES, validate_timeline_channels};

const UI_MOTION_SCHEMA_VERSION: u32 = 1;

const BUTTON_SCHEMA_VERSION: u32 = 1;

pub(super) fn load_ui_motions(
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

pub(super) fn load_buttons(
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

pub(super) fn validate_button_files(
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

pub(super) fn validate_ui_motion_files(
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

pub(super) fn validate_ui_motion_bindings(
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

pub(super) fn validate_ui_motion_reference(
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

pub(super) fn validate_button_assets(
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

pub(super) fn validate_all_button_assets(
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

pub(super) fn validate_button_action(
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
        if scenes.get(scene_id).is_some_and(|source| source.window_role != destination_scene.window_role) {
            return node_error(scene_id, node_id, "按钮不能跨主/副窗口用途跳转 Scene");
        }
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
