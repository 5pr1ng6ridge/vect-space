use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use vectspace_core::model::{
    DialogueHistoryEntry, ProfileState, PromptSnapshot, RuntimeSnapshot, SaveSlotSummary,
    ScalarValue, Settings, VariableDefinition, VariableMap, VariableScope, VariableType,
};

const SAVE_SCHEMA_VERSION: u32 = 2;
const SETTINGS_SCHEMA_VERSION: u32 = 1;
const PROFILE_SCHEMA_VERSION: u32 = 4;
const MAX_THUMBNAIL_LENGTH: usize = 2_800_000;
const MAX_HISTORY_ENTRIES: usize = 500;
const MAX_HISTORY_TEXT_BYTES: usize = 64 * 1024;
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
    valid_scenes: Option<std::collections::BTreeSet<String>>,
    valid_locations: Option<std::collections::BTreeSet<String>>,
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
    #[serde(default)]
    dialogue_history: Vec<DialogueHistoryEntry>,
    #[serde(default)]
    completed_scenes: std::collections::BTreeSet<String>,
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
    #[cfg(test)]
    pub fn new(
        root: PathBuf,
        variables: &std::collections::BTreeMap<String, VariableDefinition>,
        content_version: String,
    ) -> Result<(Self, ProfileState), SaveError> {
        Self::new_with_content(root, variables, content_version, None, None)
    }

    pub fn new_with_content(
        root: PathBuf,
        variables: &std::collections::BTreeMap<String, VariableDefinition>,
        content_version: String,
        valid_scenes: Option<std::collections::BTreeSet<String>>,
        valid_locations: Option<std::collections::BTreeSet<String>>,
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
            valid_scenes,
            valid_locations,
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
        let mut normalized_metadata = state.clone();
        self.reconcile_metadata(&mut normalized_metadata);
        if normalized_metadata != *state {
            return Err(SaveError::InvalidData(
                "profile 历史或场景完成记录不是规范格式".to_owned(),
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
            Ok(value)
                if matches!(
                    value.get("schema_version").and_then(|v| v.as_u64()),
                    Some(4) | Some(3)
                ) =>
            {
                let is_v3 = value.get("schema_version").and_then(|v| v.as_u64()) == Some(3);
                let file: ProfileFile = serde_json::from_value(value)
                    .map_err(|error| SaveError::InvalidData(error.to_string()))?;
                (
                    ProfileState {
                        variables: file.variables,
                        read_content_version: file.read_content_version,
                        read_dialogues: file.read_dialogues,
                        seen_presentations: file.seen_presentations,
                        dialogue_history: file.dialogue_history,
                        completed_scenes: file.completed_scenes,
                    },
                    is_v3,
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
                        dialogue_history: Default::default(),
                        completed_scenes: Default::default(),
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
                        dialogue_history: Default::default(),
                        completed_scenes: Default::default(),
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
            reconciled.dialogue_history.clear();
            reconciled.completed_scenes.clear();
            rewrite = true;
        }
        rewrite |= self.reconcile_metadata(&mut reconciled);
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
            dialogue_history: Default::default(),
            completed_scenes: Default::default(),
        })
    }

    fn reconcile_metadata(&self, state: &mut ProfileState) -> bool {
        let mut changed = reconcile_profile_metadata(state);
        if let Some(valid_locations) = &self.valid_locations {
            let before_read = state.read_dialogues.len();
            let before_seen = state.seen_presentations.len();
            let before_history = state.dialogue_history.len();
            state
                .read_dialogues
                .retain(|location| valid_locations.contains(location));
            state
                .seen_presentations
                .retain(|location| valid_locations.contains(location));
            state
                .dialogue_history
                .retain(|entry| valid_locations.contains(&entry.prompt_id));
            for (index, entry) in state.dialogue_history.iter_mut().enumerate() {
                let next_id = index as u64 + 1;
                changed |= entry.entry_id != next_id;
                entry.entry_id = next_id;
            }
            changed |= before_read != state.read_dialogues.len()
                || before_seen != state.seen_presentations.len()
                || before_history != state.dialogue_history.len();
        }
        if let Some(valid_scenes) = &self.valid_scenes {
            let before = state.completed_scenes.len();
            state
                .completed_scenes
                .retain(|scene| valid_scenes.contains(scene));
            changed |= before != state.completed_scenes.len();
        }
        changed
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
            dialogue_history: state.dialogue_history.clone(),
            completed_scenes: state.completed_scenes.clone(),
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

fn reconcile_profile_metadata(state: &mut ProfileState) -> bool {
    let before_history = state.dialogue_history.clone();
    let before_scenes = state.completed_scenes.clone();
    state.dialogue_history.retain(valid_history_entry);
    if state.dialogue_history.len() > MAX_HISTORY_ENTRIES {
        state
            .dialogue_history
            .drain(..state.dialogue_history.len() - MAX_HISTORY_ENTRIES);
    }
    for (index, entry) in state.dialogue_history.iter_mut().enumerate() {
        entry.entry_id = index as u64 + 1;
    }
    state
        .completed_scenes
        .retain(|scene_id| valid_identifier(scene_id));
    state.dialogue_history != before_history || state.completed_scenes != before_scenes
}

fn valid_history_entry(entry: &DialogueHistoryEntry) -> bool {
    valid_story_location(&entry.prompt_id)
        && entry.text.len() <= MAX_HISTORY_TEXT_BYTES
        && entry.speaker_id.as_deref().is_none_or(valid_identifier)
        && entry.speaker.as_deref().is_none_or(valid_display_name)
        && entry.name_color.as_deref().is_none_or(valid_color)
        && entry.text_color.as_deref().is_none_or(valid_color)
}

fn valid_story_location(value: &str) -> bool {
    let mut parts = value.split('/');
    let Some(scene) = parts.next() else {
        return false;
    };
    let Some(node) = parts.next() else {
        return false;
    };
    let step = parts.next();
    parts.next().is_none()
        && valid_identifier(scene)
        && valid_identifier(node)
        && step.is_none_or(valid_identifier)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
}

fn valid_display_name(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 64 && !value.chars().any(char::is_control)
}

fn valid_color(value: &str) -> bool {
    matches!(value.len(), 7 | 9)
        && value.starts_with('#')
        && value[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
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
        prompt_preview: prompt_preview(&file.snapshot),
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

fn prompt_preview(snapshot: &RuntimeSnapshot) -> Option<String> {
    let combined_dialogue;
    let text = match &snapshot.prompt {
        PromptSnapshot::Dialogue { text, .. } => {
            combined_dialogue = snapshot
                .dialogue_page
                .as_ref()
                .map(|page| page.segments.concat());
            combined_dialogue.as_ref().unwrap_or(text)
        }
        PromptSnapshot::LongText { text, .. } => text,
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
        assert_eq!(
            settings.skip_mode,
            vectspace_core::model::SkipMode::ReadOnly
        );
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
    fn profile_history_is_bounded_validated_and_renumbered_on_load() {
        let directory = tempdir().unwrap();
        let mut history = (0..505)
            .map(|index| DialogueHistoryEntry {
                entry_id: 7,
                prompt_id: format!("prologue/line_{index}"),
                speaker_id: None,
                speaker: None,
                name_color: None,
                text_color: None,
                text: format!("line {index}"),
            })
            .collect::<Vec<_>>();
        history.push(DialogueHistoryEntry {
            entry_id: 8,
            prompt_id: "invalid".to_owned(),
            speaker_id: None,
            speaker: None,
            name_color: None,
            text_color: None,
            text: "discard me".to_owned(),
        });
        fs::write(
            directory.path().join("profile.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema_version": 4,
                "variables": {},
                "read_content_version": "demo-2",
                "read_dialogues": [],
                "seen_presentations": [],
                "dialogue_history": history,
                "completed_scenes": ["prologue", "../invalid"]
            }))
            .unwrap(),
        )
        .unwrap();

        let (_, state) = ProfileManager::new(
            directory.path().to_path_buf(),
            &std::collections::BTreeMap::new(),
            "demo-2".to_owned(),
        )
        .unwrap();
        assert_eq!(state.dialogue_history.len(), MAX_HISTORY_ENTRIES);
        assert_eq!(state.dialogue_history.first().unwrap().entry_id, 1);
        assert_eq!(state.dialogue_history.last().unwrap().entry_id, 500);
        assert_eq!(
            state.completed_scenes,
            std::collections::BTreeSet::from(["prologue".to_owned()])
        );
    }

    #[test]
    fn profile_reconciliation_drops_locations_removed_from_current_content() {
        let directory = tempdir().unwrap();
        fs::write(
            directory.path().join("profile.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema_version": 4,
                "variables": {},
                "read_content_version": "demo-2",
                "read_dialogues": ["prologue/kept", "removed/line"],
                "seen_presentations": ["prologue/kept", "prologue/removed"],
                "dialogue_history": [
                    {"entry_id": 9, "prompt_id": "removed/line", "speaker": null, "text": "old"},
                    {"entry_id": 11, "prompt_id": "prologue/kept", "speaker": null, "text": "kept"}
                ],
                "completed_scenes": ["prologue", "removed"]
            }))
            .unwrap(),
        )
        .unwrap();

        let (_, state) = ProfileManager::new_with_content(
            directory.path().to_path_buf(),
            &std::collections::BTreeMap::new(),
            "demo-2".to_owned(),
            Some(std::collections::BTreeSet::from(["prologue".to_owned()])),
            Some(std::collections::BTreeSet::from([
                "prologue/kept".to_owned()
            ])),
        )
        .unwrap();
        assert_eq!(state.read_dialogues.len(), 1);
        assert_eq!(state.seen_presentations.len(), 1);
        assert_eq!(state.dialogue_history.len(), 1);
        assert_eq!(state.dialogue_history[0].entry_id, 1);
        assert_eq!(state.completed_scenes.len(), 1);
    }

    #[test]
    fn profile_reconciliation_keeps_long_text_step_locations() {
        let directory = tempdir().unwrap();
        fs::write(
            directory.path().join("profile.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema_version": 4,
                "variables": {},
                "read_content_version": "demo-2",
                "read_dialogues": ["prologue/lecture/definition"],
                "seen_presentations": [],
                "dialogue_history": [
                    {"entry_id": 1, "prompt_id": "prologue/lecture/definition", "speaker": null, "text": "定义"}
                ],
                "completed_scenes": []
            }))
            .unwrap(),
        )
        .unwrap();

        let (_, state) = ProfileManager::new_with_content(
            directory.path().to_path_buf(),
            &std::collections::BTreeMap::new(),
            "demo-2".to_owned(),
            Some(std::collections::BTreeSet::from(["prologue".to_owned()])),
            Some(std::collections::BTreeSet::from([
                "prologue/lecture/definition".to_owned(),
            ])),
        )
        .unwrap();
        assert!(state.read_dialogues.contains("prologue/lecture/definition"));
        assert_eq!(state.dialogue_history.len(), 1);
        assert!(valid_story_location("prologue/lecture/definition"));
        assert!(!valid_story_location("prologue/lecture/definition/extra"));
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
