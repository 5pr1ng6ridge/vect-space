use std::path::{Component, Path, PathBuf};
use std::fs;

use super::ContentError;

pub(super) fn validate_display_name(value: &str) -> Result<(), String> {
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

pub(super) fn validate_identifier(label: &str, value: &str) -> Result<(), ContentError> {
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

pub(super) fn validate_relative_path(value: &str) -> Result<PathBuf, ContentError> {
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

pub(super) fn canonical_directory(path: &Path) -> Result<PathBuf, ContentError> {
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

pub(super) fn canonical_file_within(root: &Path, path: &Path) -> Result<PathBuf, ContentError> {
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

pub(super) fn canonical_staged_asset(path: &Path) -> Result<PathBuf, ContentError> {
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

pub(super) fn node_error<T>(scene_id: &str, node_id: &str, message: &str) -> Result<T, ContentError> {
    Err(ContentError::Validation(format!(
        "{scene_id}/{node_id}: {message}"
    )))
}

pub(super) fn read_yaml<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, ContentError> {
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
