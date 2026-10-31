use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::fs;
use std::io::Read;

use crate::model::{
    AssetDefinition, AssetKind, CharacterDefinition, CharacterExpression, ContentManifest,
    VariableDefinition,
};
use super::ContentError;
use super::common::{
    canonical_file_within, canonical_staged_asset, validate_color, validate_display_name,
    validate_identifier, validate_relative_path,
};
use super::conditions::validate_value_for_type;

pub(super) fn validate_assets(
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
pub(super) fn validate_manifest_paths(manifest: &ContentManifest) -> Result<(), ContentError> {
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
    for path in &manifest.text_blocks { register("text_block", path)?; }
    for path in &manifest.particles { register("particle", path)?; }
    for path in &manifest.proofs { register("proof", path)?; }
    if let Some(path) = &manifest.chapter_map {
        register("chapter_map", path)?;
    }
    Ok(())
}

pub(super) fn validate_default_font(manifest: &ContentManifest) -> Result<(), ContentError> {
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

pub(super) fn reject_git_lfs_pointer(id: &str, path: &Path) -> Result<(), ContentError> {
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

pub(super) fn validate_variable_definitions(
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

pub(super) fn validate_character_definitions(
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
