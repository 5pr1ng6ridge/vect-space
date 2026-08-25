use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::model::{PromptSnapshot, RuntimeSnapshot, SaveSlotSummary, Settings};

const SAVE_SCHEMA_VERSION: u32 = 1;
const SETTINGS_SCHEMA_VERSION: u32 = 1;
const MAX_THUMBNAIL_LENGTH: usize = 2_800_000;
const SLOT_IDS: [&str; 4] = ["auto", "1", "2", "3"];

#[derive(Debug, Error)]
pub enum SaveError {
    #[error("无效存档槽: {0}")]
    InvalidSlot(String),
    #[error("存档不存在: {0}")]
    MissingSlot(String),
    #[error("存档内容版本不兼容: 需要 {expected}，实际 {actual}")]
    ContentVersion { expected: String, actual: String },
    #[error("存档格式错误: {0}")]
    InvalidData(String),
    #[error("存档文件操作失败 {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
}

#[derive(Debug)]
pub struct SaveManager {
    root: PathBuf,
    content_version: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveFile {
    schema_version: u32,
    content_version: String,
    saved_at_unix_ms: u64,
    snapshot: RuntimeSnapshot,
    thumbnail_data_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsFile {
    schema_version: u32,
    settings: Settings,
}

impl SaveManager {
    pub fn new(root: PathBuf, content_version: String) -> Result<Self, SaveError> {
        fs::create_dir_all(&root).map_err(|source| SaveError::Io {
            path: root.clone(),
            source,
        })?;
        Ok(Self {
            root,
            content_version,
        })
    }

    pub fn save(
        &self,
        slot: &str,
        snapshot: &RuntimeSnapshot,
        thumbnail_data_url: Option<String>,
    ) -> Result<SaveSlotSummary, SaveError> {
        validate_slot(slot)?;
        validate_thumbnail(thumbnail_data_url.as_deref())?;
        let file = SaveFile {
            schema_version: SAVE_SCHEMA_VERSION,
            content_version: self.content_version.clone(),
            saved_at_unix_ms: now_unix_ms(),
            snapshot: snapshot.clone(),
            thumbnail_data_url,
        };
        let bytes = serde_json::to_vec_pretty(&file)
            .map_err(|error| SaveError::InvalidData(error.to_string()))?;
        atomic_write(&self.slot_path(slot), &bytes)?;
        Ok(summary_from_file(slot, &file))
    }

    pub fn load(&self, slot: &str) -> Result<RuntimeSnapshot, SaveError> {
        validate_slot(slot)?;
        let file: SaveFile = read_json_with_backup(&self.slot_path(slot))?;
        if file.schema_version != SAVE_SCHEMA_VERSION {
            return Err(SaveError::InvalidData(format!(
                "不支持 schema_version {}",
                file.schema_version
            )));
        }
        if file.content_version != self.content_version {
            return Err(SaveError::ContentVersion {
                expected: self.content_version.clone(),
                actual: file.content_version,
            });
        }
        Ok(file.snapshot)
    }

    pub fn list(&self) -> Vec<SaveSlotSummary> {
        SLOT_IDS
            .iter()
            .map(|slot| {
                read_json_with_backup::<SaveFile>(&self.slot_path(slot))
                    .map(|file| summary_from_file(slot, &file))
                    .unwrap_or_else(|_| empty_summary(slot))
            })
            .collect()
    }

    pub fn load_settings(&self) -> Settings {
        let path = self.root.join("settings.json");
        read_json_with_backup::<SettingsFile>(&path)
            .ok()
            .filter(|file| file.schema_version == SETTINGS_SCHEMA_VERSION)
            .map(|file| sanitize_settings(file.settings))
            .unwrap_or_default()
    }

    pub fn save_settings(&self, settings: Settings) -> Result<Settings, SaveError> {
        let settings = validate_settings(settings)?;
        let file = SettingsFile {
            schema_version: SETTINGS_SCHEMA_VERSION,
            settings: settings.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&file)
            .map_err(|error| SaveError::InvalidData(error.to_string()))?;
        atomic_write(&self.root.join("settings.json"), &bytes)?;
        Ok(settings)
    }

    fn slot_path(&self, slot: &str) -> PathBuf {
        self.root.join(format!("slot-{slot}.json"))
    }
}

fn validate_slot(slot: &str) -> Result<(), SaveError> {
    if SLOT_IDS.contains(&slot) {
        Ok(())
    } else {
        Err(SaveError::InvalidSlot(slot.to_owned()))
    }
}

fn validate_thumbnail(value: Option<&str>) -> Result<(), SaveError> {
    if let Some(value) = value {
        if value.len() > MAX_THUMBNAIL_LENGTH || !value.starts_with("data:image/png;base64,") {
            return Err(SaveError::InvalidData(
                "缩略图必须是小于 2 MiB 的 PNG data URL".to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_settings(settings: Settings) -> Result<Settings, SaveError> {
    let volumes = [
        settings.master_volume,
        settings.bgm_volume,
        settings.sfx_volume,
    ];
    if volumes
        .iter()
        .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
    {
        return Err(SaveError::InvalidData(
            "音量设置必须在 0 到 1 之间".to_owned(),
        ));
    }
    if !settings.text_speed_cps.is_finite() || !(1.0..=200.0).contains(&settings.text_speed_cps) {
        return Err(SaveError::InvalidData(
            "文字速度必须在 1 到 200 cps 之间".to_owned(),
        ));
    }
    Ok(settings)
}

fn sanitize_settings(mut settings: Settings) -> Settings {
    settings.master_volume = finite_clamp(settings.master_volume, 0.0, 1.0, 1.0);
    settings.bgm_volume = finite_clamp(settings.bgm_volume, 0.0, 1.0, 0.7);
    settings.sfx_volume = finite_clamp(settings.sfx_volume, 0.0, 1.0, 0.8);
    settings.text_speed_cps = finite_clamp(settings.text_speed_cps, 1.0, 200.0, 30.0);
    settings
}

fn finite_clamp(value: f32, minimum: f32, maximum: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value.clamp(minimum, maximum)
    } else {
        fallback
    }
}

fn read_json_with_backup<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, SaveError> {
    match read_json(path) {
        Ok(value) => Ok(value),
        Err(primary_error) => {
            let backup = backup_path(path);
            read_json(&backup).map_err(|_| primary_error)
        }
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, SaveError> {
    let bytes = fs::read(path).map_err(|source| {
        if source.kind() == std::io::ErrorKind::NotFound {
            SaveError::MissingSlot(path.display().to_string())
        } else {
            SaveError::Io {
                path: path.to_path_buf(),
                source,
            }
        }
    })?;
    serde_json::from_slice(&bytes).map_err(|error| SaveError::InvalidData(error.to_string()))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), SaveError> {
    let temporary = path.with_extension("json.tmp");
    let backup = backup_path(path);
    fs::write(&temporary, bytes).map_err(|source| SaveError::Io {
        path: temporary.clone(),
        source,
    })?;

    if path.exists() {
        fs::copy(path, &backup).map_err(|source| SaveError::Io {
            path: backup.clone(),
            source,
        })?;
        fs::remove_file(path).map_err(|source| SaveError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    }
    fs::rename(&temporary, path).map_err(|source| SaveError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

fn summary_from_file(slot: &str, file: &SaveFile) -> SaveSlotSummary {
    SaveSlotSummary {
        slot: slot.to_owned(),
        exists: true,
        saved_at_unix_ms: Some(file.saved_at_unix_ms),
        scene_id: Some(file.snapshot.location.scene_id.clone()),
        prompt_preview: prompt_preview(&file.snapshot.prompt),
        thumbnail_data_url: file.thumbnail_data_url.clone(),
    }
}

fn empty_summary(slot: &str) -> SaveSlotSummary {
    SaveSlotSummary {
        slot: slot.to_owned(),
        exists: false,
        saved_at_unix_ms: None,
        scene_id: None,
        prompt_preview: None,
        thumbnail_data_url: None,
    }
}

fn prompt_preview(prompt: &PromptSnapshot) -> Option<String> {
    let text = match prompt {
        PromptSnapshot::Dialogue { text, .. } => text,
        PromptSnapshot::Choice { choices, .. } => choices.first().map(|choice| &choice.label)?,
        PromptSnapshot::None | PromptSnapshot::End { .. } => return None,
    };
    let preview: String = text.chars().take(80).collect();
    Some(preview)
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_four_declared_slots_are_valid() {
        for slot in SLOT_IDS {
            assert!(validate_slot(slot).is_ok());
        }
        assert!(validate_slot("../other").is_err());
        assert!(validate_slot("4").is_err());
    }

    #[test]
    fn invalid_settings_are_rejected() {
        let invalid = Settings {
            master_volume: 2.0,
            ..Settings::default()
        };
        assert!(validate_settings(invalid).is_err());
    }
}
