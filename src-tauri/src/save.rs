use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::model::{
    ProfileState, PromptSnapshot, RuntimeSnapshot, SaveSlotSummary, ScalarValue, Settings,
    VariableDefinition, VariableMap, VariableScope, VariableType,
};

const SAVE_SCHEMA_VERSION: u32 = 2;
const SETTINGS_SCHEMA_VERSION: u32 = 1;
const PROFILE_SCHEMA_VERSION: u32 = 3;
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

#[derive(Debug)]
pub struct ProfileManager {
    path: PathBuf,
    content_version: String,
    definitions: std::collections::BTreeMap<String, VariableDefinition>,
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfileFile {
    schema_version: u32,
    variables: VariableMap,
    read_content_version: String,
    read_dialogues: std::collections::BTreeSet<String>,
    seen_presentations: std::collections::BTreeSet<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyProfileV2File {
    schema_version: u32,
    variables: VariableMap,
    read_content_version: String,
    read_dialogues: std::collections::BTreeSet<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyProfileFile {
    schema_version: u32,
    variables: VariableMap,
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

impl ProfileManager {
    pub fn new(
        root: PathBuf,
        variables: &std::collections::BTreeMap<String, VariableDefinition>,
        content_version: String,
    ) -> Result<(Self, ProfileState), SaveError> {
        fs::create_dir_all(&root).map_err(|source| SaveError::Io {
            path: root.clone(),
            source,
        })?;
        let definitions = variables
            .iter()
            .filter(|(_, definition)| definition.scope == VariableScope::Profile)
            .map(|(id, definition)| (id.clone(), definition.clone()))
            .collect();
        let manager = Self {
            path: root.join("profile.json"),
            content_version,
            definitions,
        };
        let values = manager.load_reconciled()?;
        Ok((manager, values))
    }

    pub fn save(&self, state: &ProfileState) -> Result<(), SaveError> {
        let normalized = self.reconcile(&state.variables)?;
        if normalized != state.variables || state.read_content_version != self.content_version {
            return Err(SaveError::InvalidData(
                "profile 状态与当前内容或变量声明不匹配".to_owned(),
            ));
        }
        if state.read_dialogues.iter().any(|id| {
            id.split_once('/')
                .is_none_or(|(scene, node)| scene.is_empty() || node.is_empty())
        }) {
            return Err(SaveError::InvalidData(
                "profile 包含无效已读节点 ID".to_owned(),
            ));
        }
        if state.seen_presentations.iter().any(|id| {
            id.split_once('/')
                .is_none_or(|(scene, node)| scene.is_empty() || node.is_empty())
        }) {
            return Err(SaveError::InvalidData(
                "profile 包含无效已观看表现 ID".to_owned(),
            ));
        }
        self.write(state)
    }

    fn load_reconciled(&self) -> Result<ProfileState, SaveError> {
        if !self.path.exists() && !backup_path(&self.path).exists() {
            let defaults = self.default_state()?;
            self.write(&defaults)?;
            return Ok(defaults);
        }

        let loaded = read_json_with_backup::<serde_json::Value>(&self.path);
        let (stored, mut rewrite) = match loaded {
            Ok(value) if value.get("schema_version").and_then(|v| v.as_u64()) == Some(3) => {
                let file: ProfileFile = serde_json::from_value(value)
                    .map_err(|error| SaveError::InvalidData(error.to_string()))?;
                (
                    ProfileState {
                        variables: file.variables,
                        read_content_version: file.read_content_version,
                        read_dialogues: file.read_dialogues,
                        seen_presentations: file.seen_presentations,
                    },
                    false,
                )
            }
            Ok(value) if value.get("schema_version").and_then(|v| v.as_u64()) == Some(2) => {
                let file: LegacyProfileV2File = serde_json::from_value(value)
                    .map_err(|error| SaveError::InvalidData(error.to_string()))?;
                eprintln!("profile v2 已迁移为 v3，已观看表现集合从空集合开始");
                (
                    ProfileState {
                        variables: file.variables,
                        read_content_version: file.read_content_version,
                        read_dialogues: file.read_dialogues,
                        seen_presentations: Default::default(),
                    },
                    true,
                )
            }
            Ok(value) if value.get("schema_version").and_then(|v| v.as_u64()) == Some(1) => {
                let file: LegacyProfileFile = serde_json::from_value(value)
                    .map_err(|error| SaveError::InvalidData(error.to_string()))?;
                eprintln!("profile v1 已迁移为 v3，已读与已观看表现集合从空集合开始");
                (
                    ProfileState {
                        variables: file.variables,
                        read_content_version: self.content_version.clone(),
                        read_dialogues: Default::default(),
                        seen_presentations: Default::default(),
                    },
                    true,
                )
            }
            Ok(value) => {
                eprintln!(
                    "profile schema {:?} 不受支持，已备份并重建",
                    value["schema_version"]
                );
                self.backup_incompatible()?;
                (self.default_state()?, true)
            }
            Err(error) => {
                eprintln!("profile 无法读取，已备份并重建: {error}");
                self.backup_incompatible()?;
                (self.default_state()?, true)
            }
        };
        let variables = self.reconcile(&stored.variables)?;
        rewrite |= variables != stored.variables;
        let mut reconciled = ProfileState {
            variables,
            ..stored
        };
        if reconciled.read_content_version != self.content_version {
            reconciled
                .read_content_version
                .clone_from(&self.content_version);
            reconciled.read_dialogues.clear();
            reconciled.seen_presentations.clear();
            rewrite = true;
        }
        if rewrite {
            eprintln!("profile 已按当前声明与内容版本调整，并保留上一版本备份");
            self.write(&reconciled)?;
        }
        Ok(reconciled)
    }

    fn default_state(&self) -> Result<ProfileState, SaveError> {
        Ok(ProfileState {
            variables: self.defaults()?,
            read_content_version: self.content_version.clone(),
            read_dialogues: Default::default(),
            seen_presentations: Default::default(),
        })
    }

    fn defaults(&self) -> Result<VariableMap, SaveError> {
        self.definitions
            .iter()
            .map(|(id, definition)| {
                normalize_profile_value(&definition.default, definition.value_type)
                    .map(|value| (id.clone(), value))
                    .ok_or_else(|| {
                        SaveError::InvalidData(format!("profile 变量 {id} 默认值类型不匹配"))
                    })
            })
            .collect()
    }

    fn reconcile(&self, stored: &VariableMap) -> Result<VariableMap, SaveError> {
        let defaults = self.defaults()?;
        Ok(self
            .definitions
            .iter()
            .map(|(id, definition)| {
                let value = stored
                    .get(id)
                    .and_then(|value| normalize_profile_value(value, definition.value_type))
                    .unwrap_or_else(|| defaults[id].clone());
                (id.clone(), value)
            })
            .collect())
    }

    fn write(&self, state: &ProfileState) -> Result<(), SaveError> {
        let file = ProfileFile {
            schema_version: PROFILE_SCHEMA_VERSION,
            variables: state.variables.clone(),
            read_content_version: state.read_content_version.clone(),
            read_dialogues: state.read_dialogues.clone(),
            seen_presentations: state.seen_presentations.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&file)
            .map_err(|error| SaveError::InvalidData(error.to_string()))?;
        atomic_write(&self.path, &bytes)
    }

    fn backup_incompatible(&self) -> Result<(), SaveError> {
        if !self.path.exists() {
            return Ok(());
        }
        let backup = self.path.with_extension("incompatible.json.bak");
        fs::copy(&self.path, &backup).map_err(|source| SaveError::Io {
            path: backup,
            source,
        })?;
        Ok(())
    }
}

fn normalize_profile_value(value: &ScalarValue, expected: VariableType) -> Option<ScalarValue> {
    match (expected, value) {
        (VariableType::Boolean, value @ ScalarValue::Boolean(_))
        | (VariableType::Integer, value @ ScalarValue::Integer(_))
        | (VariableType::String, value @ ScalarValue::Text(_)) => Some(value.clone()),
        (VariableType::Number, ScalarValue::Integer(value)) => {
            Some(ScalarValue::Number(*value as f64))
        }
        (VariableType::Number, ScalarValue::Number(value)) if value.is_finite() => {
            Some(ScalarValue::Number(*value))
        }
        _ => None,
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
        settings.video_volume,
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
    settings.video_volume = finite_clamp(settings.video_volume, 0.0, 1.0, 1.0);
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
    use tempfile::tempdir;

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

    #[test]
    fn old_settings_default_to_read_only_skip() {
        let settings: Settings = serde_json::from_value(serde_json::json!({
            "master_volume": 1.0,
            "bgm_volume": 0.7,
            "sfx_volume": 0.8,
            "text_speed_cps": 30.0
        }))
        .unwrap();
        assert_eq!(settings.skip_mode, crate::model::SkipMode::ReadOnly);
        assert_eq!(settings.video_volume, 1.0);
    }

    #[test]
    fn profile_values_persist_and_reconcile_with_declarations() {
        let directory = tempdir().unwrap();
        let definitions = std::collections::BTreeMap::from([(
            "ending_seen".to_owned(),
            VariableDefinition {
                scope: VariableScope::Profile,
                value_type: VariableType::Boolean,
                default: ScalarValue::Boolean(false),
            },
        )]);
        let (manager, mut values) = ProfileManager::new(
            directory.path().to_path_buf(),
            &definitions,
            "demo-2".to_owned(),
        )
        .unwrap();
        assert_eq!(
            values.variables.get("ending_seen"),
            Some(&ScalarValue::Boolean(false))
        );
        values
            .variables
            .insert("ending_seen".to_owned(), ScalarValue::Boolean(true));
        manager.save(&values).unwrap();

        let (_, loaded) = ProfileManager::new(
            directory.path().to_path_buf(),
            &definitions,
            "demo-2".to_owned(),
        )
        .unwrap();
        assert_eq!(
            loaded.variables.get("ending_seen"),
            Some(&ScalarValue::Boolean(true))
        );

        let changed = std::collections::BTreeMap::from([(
            "ending_seen".to_owned(),
            VariableDefinition {
                scope: VariableScope::Profile,
                value_type: VariableType::String,
                default: ScalarValue::Text("reset".to_owned()),
            },
        )]);
        let (_, reconciled) = ProfileManager::new(
            directory.path().to_path_buf(),
            &changed,
            "demo-2".to_owned(),
        )
        .unwrap();
        assert_eq!(
            reconciled.variables.get("ending_seen"),
            Some(&ScalarValue::Text("reset".to_owned()))
        );
        assert!(directory.path().join("profile.json.bak").exists());
    }

    #[test]
    fn profile_write_failures_are_reported() {
        let directory = tempdir().unwrap();
        let definitions = std::collections::BTreeMap::from([(
            "ending_seen".to_owned(),
            VariableDefinition {
                scope: VariableScope::Profile,
                value_type: VariableType::Boolean,
                default: ScalarValue::Boolean(false),
            },
        )]);
        let (manager, mut values) = ProfileManager::new(
            directory.path().to_path_buf(),
            &definitions,
            "demo-2".to_owned(),
        )
        .unwrap();
        values
            .variables
            .insert("ending_seen".to_owned(), ScalarValue::Boolean(true));
        fs::remove_dir_all(directory.path()).unwrap();
        assert!(manager.save(&values).is_err());
    }

    #[test]
    fn profile_v1_migrates_and_content_changes_only_clear_read_history() {
        let directory = tempdir().unwrap();
        let definitions = std::collections::BTreeMap::from([(
            "ending_seen".to_owned(),
            VariableDefinition {
                scope: VariableScope::Profile,
                value_type: VariableType::Boolean,
                default: ScalarValue::Boolean(false),
            },
        )]);
        fs::write(
            directory.path().join("profile.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema_version": 1,
                "variables": { "ending_seen": true }
            }))
            .unwrap(),
        )
        .unwrap();

        let (manager, mut migrated) = ProfileManager::new(
            directory.path().to_path_buf(),
            &definitions,
            "demo-2".to_owned(),
        )
        .unwrap();
        assert_eq!(
            migrated.variables.get("ending_seen"),
            Some(&ScalarValue::Boolean(true))
        );
        assert!(migrated.read_dialogues.is_empty());
        migrated
            .read_dialogues
            .insert("prologue/introduction".to_owned());
        migrated
            .seen_presentations
            .insert("prologue/timeline_showcase".to_owned());
        manager.save(&migrated).unwrap();

        let (_, changed) = ProfileManager::new(
            directory.path().to_path_buf(),
            &definitions,
            "demo-3".to_owned(),
        )
        .unwrap();
        assert_eq!(
            changed.variables.get("ending_seen"),
            Some(&ScalarValue::Boolean(true))
        );
        assert_eq!(changed.read_content_version, "demo-3");
        assert!(changed.read_dialogues.is_empty());
        assert!(changed.seen_presentations.is_empty());
    }

    #[test]
    fn profile_v2_migrates_to_v3_without_losing_variables_or_read_history() {
        let directory = tempdir().unwrap();
        let definitions = std::collections::BTreeMap::from([(
            "ending_seen".to_owned(),
            VariableDefinition {
                scope: VariableScope::Profile,
                value_type: VariableType::Boolean,
                default: ScalarValue::Boolean(false),
            },
        )]);
        fs::write(
            directory.path().join("profile.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema_version": 2,
                "variables": { "ending_seen": true },
                "read_content_version": "demo-2",
                "read_dialogues": ["prologue/introduction"]
            }))
            .unwrap(),
        )
        .unwrap();
        let (_, migrated) = ProfileManager::new(
            directory.path().to_path_buf(),
            &definitions,
            "demo-2".to_owned(),
        )
        .unwrap();
        assert_eq!(
            migrated.variables.get("ending_seen"),
            Some(&ScalarValue::Boolean(true))
        );
        assert!(migrated.read_dialogues.contains("prologue/introduction"));
        assert!(migrated.seen_presentations.is_empty());
    }
}
