//! YAML content loading and validation.
//!
//! `ContentCatalog` is the validated, immutable view of a game project.  The
//! per-document validators live in the submodules below; the catalog wires them
//! together for a project on disk or for an editor's unsaved drafts.

use std::path::PathBuf;

use thiserror::Error;

mod animation;
mod catalog;
mod chapter_map;
mod common;
mod conditions;
mod effects;
mod manifest;
mod markup;
mod scenes;
mod timeline;
mod ui;
mod visuals;
#[cfg(test)]
mod tests;

pub use catalog::{AnimationMetrics, ContentCatalog};
pub(crate) use common::validate_color;

const CONTENT_SCHEMA_VERSION: u32 = 2;

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
