use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::image_header::{ImageSize, probe};
use crate::model::{
    AssetDefinition, AssetKind, IMAGE_ANIMATION_MAX_DECODED_BYTES, IMAGE_ANIMATION_MAX_EDGE,
    IMAGE_ANIMATION_MAX_FRAME_MS, IMAGE_ANIMATION_MAX_FRAMES, IMAGE_ANIMATION_MIN_FRAME_MS,
    IMAGE_ANIMATION_SCHEMA_VERSION, ImageAnimationDefinition, SPRITE_ACTION_SCHEMA_VERSION,
    SpriteActionDefinition,
};
use super::ContentError;
use super::catalog::AnimationMetrics;
use super::common::{
    canonical_file_within, canonical_staged_asset, read_yaml, validate_identifier,
    validate_relative_path,
};
use super::timeline::MAX_TIMELINE_DURATION_MS;

const ACTION_MAX_PARAMETERS: usize = 32;
const ACTION_MAX_CHANNELS: usize = 16;
const ACTION_MAX_KEYFRAMES: usize = 2_048;

pub(super) fn load_animations(
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
pub(super) fn validate_animation_files(
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

pub(super) fn load_actions(
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
pub(super) fn validate_action_files(
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

pub(super) fn validate_action_document(action: &SpriteActionDefinition) -> Result<(), ContentError> {
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
                || (channel == "scale" && keyframe.value <= 0.0)
                || (matches!(channel.as_str(), "scale_x" | "scale_y")
                    && keyframe.value == 0.0)
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

pub(super) fn validate_action_namespace(
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
pub(super) fn validate_animations(
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
