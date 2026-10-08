//! Asset import: media inspection, staging and the staged-import registry.
//!
//! Imports never touch the managed `assets/` tree directly.  A source file is
//! first inspected (`inspect`), then copied into `.vectspace/tmp/imports`
//! under an opaque token (`stage`), and only a save publishes it.  `registry`
//! resolves, validates and discards the staged records.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use vectspace_core::model::AssetKind;
use vectspace_protocol::{WireAssetKind, WireCommandError};

use crate::error::validation_command_error;

pub(crate) mod inspect;
pub(crate) mod registry;
pub(crate) mod stage;

/// A binary copied into the import staging area, waiting for a save.
#[derive(Debug, Clone)]
pub(crate) struct StagedImport {
    pub(crate) token: String,
    pub(crate) project_root: PathBuf,
    pub(crate) id: String,
    pub(crate) kind: AssetKind,
    pub(crate) relative_path: String,
    pub(crate) staged_path: PathBuf,
    pub(crate) sha256: String,
    /// A staged record may point at an already managed file with the same
    /// content.  Such a record is only a new manifest registration; the
    /// save transaction must never delete or rewrite the shared file.
    pub(crate) owns_staged_path: bool,
    pub(crate) reused_from: Option<String>,
    /// Present when this staged record deliberately re-points an existing
    /// asset id at a new binary.  The recorded old path is checked again at
    /// save time and is never overwritten or deleted.
    pub(crate) replaces: Option<StagedReplacement>,
}

#[derive(Debug, Clone)]
pub(crate) struct StagedReplacement {
    pub(crate) old_relative_path: String,
    pub(crate) old_kind: AssetKind,
}

/// A source file that passed inspection; staging accepts only these.
#[derive(Debug, Clone)]
pub(crate) struct InspectedImport {
    pub(crate) project_root: PathBuf,
    pub(crate) source_path: PathBuf,
    pub(crate) sha256: String,
}

#[derive(Debug)]
pub(crate) struct ImportAssetRequest {
    pub(crate) id: String,
    pub(crate) kind: AssetKind,
    pub(crate) file_name: Option<String>,
    pub(crate) inspection_id: Option<String>,
    /// When present the staged upload replaces the binary of an existing
    /// asset.  The host requires it to equal `id` and validates the old
    /// definition before issuing a token.
    pub(crate) replace_id: Option<String>,
}

/// Where a project's staged imports live.
pub(crate) fn staging_dir(root: &Path) -> PathBuf {
    root.join(".vectspace").join("tmp").join("imports")
}

pub(crate) fn wire_asset_kind(kind: AssetKind) -> WireAssetKind {
    match kind {
        AssetKind::Background => WireAssetKind::Background,
        AssetKind::Sprite => WireAssetKind::Sprite,
        AssetKind::Gui => WireAssetKind::Gui,
        AssetKind::Bgm => WireAssetKind::Bgm,
        AssetKind::Ambience => WireAssetKind::Ambience,
        AssetKind::Sfx => WireAssetKind::Sfx,
        AssetKind::Video => WireAssetKind::Video,
        AssetKind::Font => WireAssetKind::Font,
    }
}

pub(crate) fn asset_kind_from_wire(kind: WireAssetKind) -> AssetKind {
    match kind {
        WireAssetKind::Background => AssetKind::Background,
        WireAssetKind::Sprite => AssetKind::Sprite,
        WireAssetKind::Gui => AssetKind::Gui,
        WireAssetKind::Bgm => AssetKind::Bgm,
        WireAssetKind::Ambience => AssetKind::Ambience,
        WireAssetKind::Sfx => AssetKind::Sfx,
        WireAssetKind::Video => AssetKind::Video,
        WireAssetKind::Font => AssetKind::Font,
    }
}

pub(crate) fn asset_folder(kind: AssetKind) -> &'static str {
    match kind {
        AssetKind::Background => "backgrounds",
        AssetKind::Sprite => "sprites",
        AssetKind::Gui => "gui",
        AssetKind::Bgm | AssetKind::Ambience | AssetKind::Sfx => "audio",
        AssetKind::Font => "fonts",
        AssetKind::Video => "videos",
    }
}

/// The lowercase extension of `path`, or an empty string.
pub(crate) fn lowercase_extension(path: &Path) -> String {
    path.extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// File extensions an asset of `kind` may be imported from.
fn allowed_extensions(kind: AssetKind) -> &'static [&'static str] {
    match kind {
        AssetKind::Background | AssetKind::Sprite | AssetKind::Gui => {
            &["png", "jpg", "jpeg", "webp"]
        }
        AssetKind::Bgm | AssetKind::Ambience | AssetKind::Sfx => &["ogg", "wav", "mp3", "flac"],
        AssetKind::Font => &["ttf", "otf"],
        AssetKind::Video => &["mp4"],
    }
}

pub(crate) fn inferred_asset_kind(path: &Path) -> Option<WireAssetKind> {
    let extension = lowercase_extension(path);
    let stem = path
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if ["png", "jpg", "jpeg", "webp"].contains(&extension.as_str()) {
        return Some(WireAssetKind::Background);
    }
    if ["ogg", "wav", "mp3", "flac"].contains(&extension.as_str()) {
        // Containers do not identify whether an author intends BGM, ambience,
        // or SFX. Preserve the historical SFX fallback while honoring the
        // explicit `ambience`/`ambient` filename convention used by the
        // editor's import queue.
        if stem
            .split(|character: char| !character.is_ascii_alphanumeric())
            .any(|token| matches!(token, "ambience" | "ambient"))
        {
            return Some(WireAssetKind::Ambience);
        }
        return Some(WireAssetKind::Sfx);
    }
    if extension == "mp4" {
        return Some(WireAssetKind::Video);
    }
    if ["ttf", "otf"].contains(&extension.as_str()) {
        return Some(WireAssetKind::Font);
    }
    None
}

/// Keep the staging boundary in lock-step with the core manifest validator.
/// An import token must never be issued for an ID that could only fail later
/// during catalog validation; rejecting it here also avoids leaving an
/// apparently valid, but unusable, staged binary behind after a cancelled
/// dialog.
pub(crate) fn valid_asset_registration_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
}

pub(crate) fn validate_import_extension(
    kind: AssetKind,
    source: &Path,
) -> Result<(), WireCommandError> {
    if allowed_extensions(kind).contains(&lowercase_extension(source).as_str()) {
        Ok(())
    } else {
        Err(validation_command_error(format!(
            "素材扩展名与 {kind:?} 类型不匹配"
        )))
    }
}

/// The manifest path is also part of the media contract.  Checking only the
/// selected source path would allow a valid PNG to be registered as
/// `assets/backgrounds/foo.jpg`, which later makes format detection and
/// browser loading disagree.  JPEG/JPG are the sole aliases we accept.
pub(crate) fn validate_import_file_name(
    kind: AssetKind,
    file_name: &OsStr,
    source: &Path,
) -> Result<(), WireCommandError> {
    let target_extension = lowercase_extension(Path::new(file_name));
    let source_extension = lowercase_extension(source);
    let canonical = |extension: &str| match extension {
        "jpg" | "jpeg" => "jpeg".to_owned(),
        other => other.to_owned(),
    };
    if canonical(&target_extension) != canonical(&source_extension) {
        return Err(validation_command_error(format!(
            "目标文件名扩展名 .{target_extension} 与源素材 .{source_extension} 不一致"
        )));
    }
    validate_import_extension(kind, Path::new(file_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_kind_inference_honours_explicit_ambience_names() {
        for (name, kind) in [
            ("ambience.forest.ogg", WireAssetKind::Ambience),
            ("ambient_rain.wav", WireAssetKind::Ambience),
            ("button_click.ogg", WireAssetKind::Sfx),
        ] {
            assert_eq!(inferred_asset_kind(Path::new(name)), Some(kind), "{name}");
        }
    }

    #[test]
    fn registration_ids_follow_the_manifest_identifier_contract() {
        assert!(valid_asset_registration_id("bg.classroom-night_1"));
        assert!(valid_asset_registration_id(&"a".repeat(128)));
        assert!(!valid_asset_registration_id(""));
        assert!(!valid_asset_registration_id("../outside"));
        assert!(!valid_asset_registration_id("contains space"));
        assert!(!valid_asset_registration_id(&"a".repeat(129)));
    }
}
