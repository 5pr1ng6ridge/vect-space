use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use schemars::JsonSchema;
use vectspace_core::model::{
    DialogueHistoryEntry, ProfileState, PromptSnapshot, RuntimeSnapshot, SaveSlotSummary,
    ScalarValue, Settings, VariableDefinition, VariableMap, VariableScope, VariableType,
    AMBIENCE_VOLUME_DEFAULT,
};

const SAVE_SCHEMA_VERSION: u32 = 3;
const SETTINGS_SCHEMA_VERSION: u32 = 1;
const PROFILE_SCHEMA_VERSION: u32 = 4;
const MAX_THUMBNAIL_LENGTH: usize = 2_800_000;
// Keep a generous file bound for profiles while still bounding each history
// entry below.  A profile is user data, so malformed entries are repaired
// rather than allowed to make the whole profile unreadable.
const MAX_PROFILE_FILE_BYTES: usize = 64 * 1024 * 1024;
/// Bounds a slot read the same way a profile read is bounded.  A slot carries
/// the dialogue ledger, so an unbounded read would let a malformed slot
/// allocate without limit before any validation runs.
const MAX_SAVE_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_HISTORY_ENTRIES: usize = 500;
const MAX_HISTORY_TEXT_BYTES: usize = 1024 * 1024;
const MAX_HISTORY_SPEAKER_ID_BYTES: usize = 128;
const MAX_HISTORY_SPEAKER_CHARS: usize = 64;
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
    /// The complete ordered dialogue ledger (main + secondary occurrences), not
    /// nested inside `secondary`, because history outlives the secondary window.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    history: Vec<DialogueHistoryEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secondary: Option<SecondaryState>,
}

/// Everything needed to rebuild the secondary window's runtime at the exact
/// scene it was showing.  Transient host/IPC identity (session tokens, pending
/// acknowledgements) is deliberately absent: a restored secondary always gets a
/// fresh token and a fresh frontend bootstrap.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SecondaryState {
    /// Scene currently shown in the secondary window.
    pub scene_id: String,
    /// Main-story Scene that owns the window; leaving it closes the window.
    pub owning_scene: String,
    pub snapshot: RuntimeSnapshot,
    /// The secondary runtime's own progression metadata (read/seen/completed).
    /// Shared variables are intentionally excluded: the main snapshot is their
    /// authority.
    pub profile: ProfileState,
}

/// The complete contents of one slot as passed to [`SaveManager::save`].
#[derive(Debug, Clone, Copy)]
pub struct SlotDocument<'a> {
    pub snapshot: &'a RuntimeSnapshot,
    pub history: &'a [DialogueHistoryEntry],
    pub secondary: Option<&'a SecondaryState>,
}

/// Restored slot contents.
#[derive(Debug, Clone)]
pub struct LoadedSlot {
    pub snapshot: RuntimeSnapshot,
    /// Merged dialogue ledger (main + secondary occurrences).
    pub history: Vec<DialogueHistoryEntry>,
    pub secondary: Option<SecondaryState>,
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
    /// Kept as a raw JSON value so one malformed history item does not discard
    /// otherwise valid profile variables and completion flags.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dialogue_history: Option<serde_json::Value>,
    completed_scenes: std::collections::BTreeSet<String>,
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
        document: SlotDocument<'_>,
        thumbnail_data_url: Option<String>,
    ) -> Result<SaveSlotSummary, SaveError> {
        validate_slot(slot)?;
        validate_thumbnail(thumbnail_data_url.as_deref())?;
        let file = SaveFile {
            schema_version: SAVE_SCHEMA_VERSION,
            content_version: self.content_version.clone(),
            saved_at_unix_ms: now_unix_ms(),
            snapshot: document.snapshot.clone(),
            thumbnail_data_url,
            history: document.history.to_vec(),
            secondary: document.secondary.cloned(),
        };
        let bytes = serde_json::to_vec_pretty(&file)
            .map_err(|error| SaveError::InvalidData(error.to_string()))?;
        atomic_write(&self.slot_path(slot), &bytes)?;
        Ok(summary_from_file(slot, &file))
    }

    pub fn load(&self, slot: &str) -> Result<LoadedSlot, SaveError> {
        validate_slot(slot)?;
        let (file, _from_backup) =
            read_json_with_backup_limit_source::<SaveFile>(&self.slot_path(slot), MAX_SAVE_FILE_BYTES)?;
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
        let mut history = file.history;
        if history.len() > MAX_HISTORY_ENTRIES {
            let excess = history.len() - MAX_HISTORY_ENTRIES;
            history.drain(..excess);
        }
        Ok(LoadedSlot {
            snapshot: file.snapshot,
            history,
            secondary: file.secondary,
        })
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
        if state
            .read_dialogues
            .iter()
            .any(|id| !valid_history_location(id))
        {
            return Err(SaveError::InvalidData(
                "profile 包含无效已读节点 ID".to_owned(),
            ));
        }
        if state
            .seen_presentations
            .iter()
            .any(|id| !valid_history_location(id))
        {
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

        let (loaded, loaded_from_backup) = match read_json_with_backup_limit_source::<
            serde_json::Value,
        >(&self.path, MAX_PROFILE_FILE_BYTES)
        {
            Ok((value, from_backup)) => (Ok(value), from_backup),
            Err(error) => (Err(error), false),
        };
        let (stored, mut rewrite) = match loaded {
            Ok(value)
                if value.get("schema_version").and_then(|v| v.as_u64())
                    == Some(u64::from(PROFILE_SCHEMA_VERSION)) =>
            {
                match serde_json::from_value::<ProfileFile>(value) {
                    Ok(file) => {
                        let (dialogue_history, history_rewrite) =
                            decode_profile_history(file.dialogue_history);
                        (
                            ProfileState {
                                variables: file.variables,
                                read_content_version: file.read_content_version,
                                read_dialogues: file.read_dialogues,
                                seen_presentations: file.seen_presentations,
                                completed_scenes: file.completed_scenes,
                                dialogue_history,
                            },
                            history_rewrite,
                        )
                    }
                    Err(error) => {
                        eprintln!("profile 内容损坏，已备份并重建: {error}");
                        self.backup_incompatible()?;
                        (self.default_state()?, true)
                    }
                }
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
        // A valid backup is still only a recovery source.  Rewrite the
        // primary file so a transient/corrupt primary does not force every
        // subsequent launch through the same fallback path.
        rewrite |= loaded_from_backup;
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
            reconciled.completed_scenes.clear();
            reconciled.dialogue_history.clear();
            rewrite = true;
        }
        rewrite |= self.reconcile_metadata(&mut reconciled);
        if rewrite {
            // Reconciliation can be triggered by a content-version change,
            // stale scene IDs, malformed history metadata, or a variable
            // declaration change.  Preserve the exact source file before
            // writing the repaired state so a bad migration never destroys
            // the user's recoverable profile.
            if self.path.is_file() {
                self.backup_incompatible()?;
            }
            eprintln!("profile 已按当前声明与内容版本调整，并保留上一版本备份");
            if loaded_from_backup {
                self.write_without_rotating_backup(&reconciled)?;
            } else {
                self.write(&reconciled)?;
            }
        }
        Ok(reconciled)
    }

    fn default_state(&self) -> Result<ProfileState, SaveError> {
        Ok(ProfileState {
            variables: self.defaults()?,
            read_content_version: self.content_version.clone(),
            read_dialogues: Default::default(),
            seen_presentations: Default::default(),
            completed_scenes: Default::default(),
            dialogue_history: Default::default(),
        })
    }

    fn reconcile_metadata(&self, state: &mut ProfileState) -> bool {
        let mut changed = false;
        if let Some(valid_locations) = &self.valid_locations {
            let before_read = state.read_dialogues.len();
            let before_seen = state.seen_presentations.len();
            state
                .read_dialogues
                .retain(|location| valid_locations.contains(location));
            state
                .seen_presentations
                .retain(|location| valid_locations.contains(location));
            changed |= before_read != state.read_dialogues.len()
                || before_seen != state.seen_presentations.len();
        }
        if let Some(valid_scenes) = &self.valid_scenes {
            let before = state.completed_scenes.len();
            state
                .completed_scenes
                .retain(|scene| valid_scenes.contains(scene));
            changed |= before != state.completed_scenes.len();
        } else {
            let before = state.completed_scenes.clone();
            state.completed_scenes.retain(|scene| {
                !scene.is_empty()
                    && scene.len() <= 128
                    && scene.chars().all(|character| {
                        character.is_ascii_alphanumeric() || "._-".contains(character)
                    })
            });
            changed |= before != state.completed_scenes;
        }
        let original_history = state.dialogue_history.clone();
        state
            .dialogue_history
            .retain(|entry| self.valid_history_entry(entry));
        if state.dialogue_history.len() > MAX_HISTORY_ENTRIES {
            let excess = state.dialogue_history.len() - MAX_HISTORY_ENTRIES;
            state.dialogue_history.drain(..excess);
        }
        for (index, entry) in state.dialogue_history.iter_mut().enumerate() {
            let canonical_id = index as u64 + 1;
            if entry.entry_id != canonical_id {
                entry.entry_id = canonical_id;
            }
        }
        changed |= original_history != state.dialogue_history;
        changed
    }

    fn valid_history_entry(&self, entry: &DialogueHistoryEntry) -> bool {
        let prompt_is_valid = if let Some(valid_locations) = &self.valid_locations {
            valid_locations.contains(&entry.prompt_id)
        } else {
            // A profile may be opened before the current content catalog is
            // available (for example while recovering a project).  The
            // fallback still needs to validate the complete location shape,
            // rather than merely checking for a slash and control-free text.
            // Long-text prompts can contain more than two path components,
            // so require at least scene/node and validate every component with
            // the same identifier rules used by content loading.
            valid_history_location(&entry.prompt_id)
        };
        if !prompt_is_valid {
            return false;
        }
        if entry
            .speaker_id
            .as_deref()
            .is_some_and(|id| !valid_history_identifier(id))
        {
            return false;
        }
        if entry.speaker.as_deref().is_some_and(|speaker| {
            speaker.is_empty()
                || speaker.chars().count() > MAX_HISTORY_SPEAKER_CHARS
                || speaker.chars().any(char::is_control)
        }) {
            return false;
        }
        if entry
            .name_color
            .as_deref()
            .is_some_and(|color| !valid_history_color(color))
            || entry
                .text_color
                .as_deref()
                .is_some_and(|color| !valid_history_color(color))
        {
            return false;
        }
        !entry.text.trim().is_empty() && entry.text.len() <= MAX_HISTORY_TEXT_BYTES
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
        self.write_with_backup(state, true)
    }

    /// Persist a state recovered from the ordinary `.json.bak` without
    /// rotating that backup away. The backup is the only known-good copy in
    /// this situation; replacing it with the malformed primary would make a
    /// second recovery attempt impossible if the repaired write is
    /// interrupted.
    fn write_without_rotating_backup(&self, state: &ProfileState) -> Result<(), SaveError> {
        self.write_with_backup(state, false)
    }

    fn write_with_backup(
        &self,
        state: &ProfileState,
        rotate_backup: bool,
    ) -> Result<(), SaveError> {
        let file = ProfileFile {
            schema_version: PROFILE_SCHEMA_VERSION,
            variables: state.variables.clone(),
            read_content_version: state.read_content_version.clone(),
            read_dialogues: state.read_dialogues.clone(),
            seen_presentations: state.seen_presentations.clone(),
            dialogue_history: Some(
                serde_json::to_value(&state.dialogue_history)
                    .map_err(|error| SaveError::InvalidData(error.to_string()))?,
            ),
            completed_scenes: state.completed_scenes.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&file)
            .map_err(|error| SaveError::InvalidData(error.to_string()))?;
        if rotate_backup {
            atomic_write(&self.path, &bytes)
        } else {
            atomic_write_preserving_backup(&self.path, &bytes)
        }
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

fn decode_profile_history(raw: Option<serde_json::Value>) -> (Vec<DialogueHistoryEntry>, bool) {
    let Some(raw) = raw else {
        // Add the field when repairing profiles written by the previous
        // implementation, which intentionally omitted it.
        return (Vec::new(), true);
    };
    let Some(entries) = raw.as_array() else {
        return (Vec::new(), true);
    };
    let mut changed = false;
    let decoded = entries
        .iter()
        .filter_map(
            |value| match serde_json::from_value::<DialogueHistoryEntry>(value.clone()) {
                Ok(entry) => Some(entry),
                Err(_) => {
                    changed = true;
                    None
                }
            },
        )
        .collect();
    (decoded, changed)
}

fn valid_history_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_HISTORY_SPEAKER_ID_BYTES
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
}

fn valid_history_location(value: &str) -> bool {
    let components = value.split('/').collect::<Vec<_>>();
    components.len() >= 2
        && components
            .iter()
            // Identifiers themselves intentionally permit dots, but a
            // persisted location is later treated as a slash-separated key.
            // Never accept path-navigation components here: "../outside"
            // would otherwise survive fallback reconciliation when no live
            // catalog is available.
            .all(|component| {
                !matches!(*component, "." | "..") && valid_history_identifier(component)
            })
}

fn valid_history_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    matches!(bytes.len(), 7 | 9)
        && bytes[0] == b'#'
        && bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit())
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
        settings.ambience_volume,
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
    settings.ambience_volume =
        finite_clamp(settings.ambience_volume, 0.0, 1.0, AMBIENCE_VOLUME_DEFAULT);
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

/// Read a bounded JSON file and report whether the recovery backup was used.
/// Callers that can repair the primary file should persist the recovered value
/// instead of leaving a permanently broken primary beside a valid backup.
fn read_json_with_backup_limit_source<T: serde::de::DeserializeOwned>(
    path: &Path,
    maximum_bytes: usize,
) -> Result<(T, bool), SaveError> {
    match read_json_limited(path, maximum_bytes) {
        Ok(value) => Ok((value, false)),
        Err(primary_error) => {
            let backup = backup_path(path);
            read_json_limited(&backup, maximum_bytes)
                .map(|value| (value, true))
                .map_err(|_| primary_error)
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

fn read_json_limited<T: serde::de::DeserializeOwned>(
    path: &Path,
    maximum_bytes: usize,
) -> Result<T, SaveError> {
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
    if bytes.len() > maximum_bytes {
        return Err(SaveError::InvalidData(format!(
            "文件 {} 超过 {} 字节限制",
            path.display(),
            maximum_bytes
        )));
    }
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
    }
    replace_file(&temporary, path).map_err(|source| SaveError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn atomic_write_preserving_backup(path: &Path, bytes: &[u8]) -> Result<(), SaveError> {
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes).map_err(|source| SaveError::Io {
        path: temporary.clone(),
        source,
    })?;
    replace_file(&temporary, path).map_err(|source| SaveError::Io {
        path: path.to_path_buf(),
        source,
    })
}

/// Replace a save/profile document without exposing a delete-then-rename gap
/// on Windows.  The game is shipped on Windows, where `rename` does not
/// replace an existing file.  Keeping this operation atomic means a crash
/// cannot leave an empty or missing profile between writes.
#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> Result<(), std::io::Error> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(target.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| std::io::Error::other(error.to_string()))
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> Result<(), std::io::Error> {
    if target.exists() {
        fs::remove_file(target)?;
    }
    fs::rename(source, target)
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
        assert_eq!(settings.ambience_volume, 0.8);
        assert!(!settings.reduce_motion);
    }

    #[test]
    fn ambience_volume_is_validated_and_sanitized() {
        let invalid = Settings {
            ambience_volume: 1.1,
            ..Settings::default()
        };
        assert!(validate_settings(invalid).is_err());
        let repaired = sanitize_settings(Settings {
            ambience_volume: f32::NAN,
            ..Settings::default()
        });
        assert_eq!(repaired.ambience_volume, 0.8);
    }

    #[test]
    fn active_ambience_save_load_round_trip_preserves_all_schema_versions() {
        use vectspace_core::model::{
            AmbienceSlot, AmbienceSnapshot, AudioSnapshot, LoopingAudioSnapshot, PlaybackSnapshot,
            RuntimeSnapshot, StoryLocation, WorldSnapshot,
        };

        let directory = tempdir().unwrap();
        let manager =
            SaveManager::new(directory.path().to_path_buf(), "demo-c1".to_owned()).unwrap();
        let state = LoopingAudioSnapshot {
            asset: "ambience.forest".to_owned(),
            volume: 0.45,
            start_ms: 120,
            loop_start_ms: Some(400),
            loop_end_ms: Some(1_800),
        };
        let mut ambience = AmbienceSnapshot::default();
        ambience.set(AmbienceSlot::Slot2, Some(state.clone()));
        let snapshot = RuntimeSnapshot {
            interaction: Default::default(),
            revision: 7,
            location: StoryLocation {
                scene_id: "prologue".to_owned(),
                node_id: "ambience".to_owned(),
            },
            variables: VariableMap::new(),
            world: WorldSnapshot::default(),
            audio: AudioSnapshot {
                bgm: None,
                ambience,
            },
            playback: PlaybackSnapshot::default(),
            dialogue_page: None,
            long_text_page: None,
            prompt: PromptSnapshot::None,
        };

        manager
            .save(
                "1",
                SlotDocument {
                    snapshot: &snapshot,
                    history: &[],
                    secondary: None,
                },
                None,
            )
            .unwrap();
        let loaded = manager.load("1").unwrap();
        assert_eq!(
            loaded.snapshot.audio.ambience.get(AmbienceSlot::Slot2),
            Some(&state)
        );
        assert!(loaded.history.is_empty());
        assert!(loaded.secondary.is_none());
        let save_file: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.path().join("slot-1.json")).unwrap())
                .unwrap();
        assert_eq!(save_file["schema_version"], SAVE_SCHEMA_VERSION);
        assert_eq!(
            save_file["snapshot"]["audio"]["ambience"]["slot_2"]["asset"],
            "ambience.forest"
        );

        manager.save_settings(Settings::default()).unwrap();
        let settings_file: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.path().join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(settings_file["schema_version"], SETTINGS_SCHEMA_VERSION);
        assert_eq!(manager.load_settings().ambience_volume, 0.8);

        let (profile_manager, profile) = ProfileManager::new(
            directory.path().to_path_buf(),
            &std::collections::BTreeMap::new(),
            "demo-c1".to_owned(),
        )
        .unwrap();
        profile_manager.save(&profile).unwrap();
        let profile_file: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.path().join("profile.json")).unwrap())
                .unwrap();
        assert_eq!(profile_file["schema_version"], PROFILE_SCHEMA_VERSION);
    }

    #[test]
    fn schema_v3_round_trips_merged_history_and_secondary_state() {
        use vectspace_core::model::{
            AudioSnapshot, PlaybackSnapshot, RuntimeSnapshot, StoryLocation, WorldSnapshot,
        };

        let directory = tempdir().unwrap();
        let manager =
            SaveManager::new(directory.path().to_path_buf(), "demo-c1".to_owned()).unwrap();
        let snapshot = RuntimeSnapshot {
            interaction: Default::default(),
            revision: 9,
            location: StoryLocation {
                scene_id: "prologue".to_owned(),
                node_id: "intro".to_owned(),
            },
            variables: VariableMap::new(),
            world: WorldSnapshot::default(),
            audio: AudioSnapshot::default(),
            playback: PlaybackSnapshot::default(),
            dialogue_page: None,
            long_text_page: None,
            prompt: PromptSnapshot::None,
        };
        let history = vec![
            DialogueHistoryEntry {
                entry_id: 1,
                prompt_id: "prologue/intro".to_owned(),
                speaker_id: None,
                speaker: None,
                name_color: None,
                text_color: None,
                text: "main line".to_owned(),
            },
            DialogueHistoryEntry {
                entry_id: 2,
                prompt_id: "ambience_lab/intro".to_owned(),
                speaker_id: None,
                speaker: None,
                name_color: None,
                text_color: None,
                text: "secondary line".to_owned(),
            },
        ];
        let secondary = SecondaryState {
            scene_id: "ambience_lab".to_owned(),
            owning_scene: "prologue".to_owned(),
            snapshot: RuntimeSnapshot {
                location: StoryLocation {
                    scene_id: "ambience_lab".to_owned(),
                    node_id: "intro".to_owned(),
                },
                ..snapshot.clone()
            },
            profile: ProfileState {
                variables: VariableMap::new(),
                read_content_version: "demo-c1".to_owned(),
                read_dialogues: Default::default(),
                seen_presentations: Default::default(),
                completed_scenes: Default::default(),
                dialogue_history: Default::default(),
            },
        };

        manager
            .save(
                "3",
                SlotDocument {
                    snapshot: &snapshot,
                    history: &history,
                    secondary: Some(&secondary),
                },
                None,
            )
            .unwrap();
        let loaded = manager.load("3").unwrap();
        assert_eq!(loaded.history, history);
        assert_eq!(loaded.secondary, Some(secondary));

        // The ledger lives at the top level, never nested inside the optional
        // secondary, so a slot without a secondary still carries history.
        manager
            .save(
                "1",
                SlotDocument {
                    snapshot: &snapshot,
                    history: &history,
                    secondary: None,
                },
                None,
            )
            .unwrap();
        let only_history: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.path().join("slot-1.json")).unwrap())
                .unwrap();
        assert!(only_history.get("secondary").is_none());
        assert_eq!(
            only_history["history"].as_array().map(Vec::len),
            Some(history.len())
        );
        assert_eq!(
            manager.load("1").unwrap().history,
            history,
            "history must survive without a live secondary window"
        );
    }

    #[test]
    fn interaction_state_round_trips_and_an_old_save_without_it_still_loads() {
        use vectspace_core::interaction::{
            AdvanceBlock, SceneTimer, WindowRole, WindowTitles,
        };
        use vectspace_core::model::{
            AudioSnapshot, PlaybackSnapshot, RuntimeSnapshot, StoryLocation, WorldSnapshot,
        };

        let directory = tempdir().unwrap();
        let manager =
            SaveManager::new(directory.path().to_path_buf(), "demo-c1".to_owned()).unwrap();
        let mut snapshot = RuntimeSnapshot {
            interaction: Default::default(),
            revision: 3,
            location: StoryLocation {
                scene_id: "prologue".to_owned(),
                node_id: "intro".to_owned(),
            },
            variables: VariableMap::new(),
            world: WorldSnapshot::default(),
            audio: AudioSnapshot::default(),
            playback: PlaybackSnapshot::default(),
            dialogue_page: None,
            long_text_page: None,
            prompt: PromptSnapshot::None,
        };
        snapshot.interaction.titles = WindowTitles {
            main: "Main!".to_owned(),
            secondary: "Side".to_owned(),
        };
        snapshot.interaction.blocks.push(AdvanceBlock {
            id: "lock".to_owned(),
            source: WindowRole::Secondary,
            source_scene: "ambience_lab".to_owned(),
            message: "wait".to_owned(),
            message_template: None,
        });
        snapshot.interaction.timers.insert(
            "t".to_owned(),
            SceneTimer {
                target: "bump".to_owned(),
                remaining_ms: 321,
                interval_ms: Some(100),
            },
        );
        snapshot.interaction.prompt_instance = "7".to_owned();
        let document = SlotDocument {
            snapshot: &snapshot,
            history: &[],
            secondary: None,
        };
        manager.save("2", document, None).unwrap();
        // Remaining time, not an absolute process time, is what is stored.
        assert_eq!(manager.load("2").unwrap().snapshot, snapshot);

        // A save written before this state existed has no `interaction` key.
        let path = directory.path().join("slot-2.json");
        let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["snapshot"].as_object_mut().unwrap().remove("interaction");
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let old = manager.load("2").unwrap();
        assert_eq!(old.snapshot.interaction, Default::default());
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
    fn dialogue_history_persists_with_profile_and_is_cleared_on_content_change() {
        let directory = tempdir().unwrap();
        let (manager, mut state) = ProfileManager::new(
            directory.path().to_path_buf(),
            &std::collections::BTreeMap::new(),
            "demo-2".to_owned(),
        )
        .unwrap();
        state.dialogue_history.push(DialogueHistoryEntry {
            entry_id: 1,
            prompt_id: "prologue/line".to_owned(),
            speaker_id: Some("alice".to_owned()),
            speaker: Some("爱丽丝".to_owned()),
            name_color: Some("#80D8FF".to_owned()),
            text_color: Some("#FFFFFF".to_owned()),
            text: "第一行\n第二行".to_owned(),
        });
        manager.save(&state).unwrap();

        let (_, loaded) = ProfileManager::new(
            directory.path().to_path_buf(),
            &std::collections::BTreeMap::new(),
            "demo-2".to_owned(),
        )
        .unwrap();
        assert_eq!(loaded.dialogue_history, state.dialogue_history);

        let (_, changed) = ProfileManager::new(
            directory.path().to_path_buf(),
            &std::collections::BTreeMap::new(),
            "demo-3".to_owned(),
        )
        .unwrap();
        assert!(changed.dialogue_history.is_empty());
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
    fn profile_history_is_preserved_and_invalid_metadata_is_repaired() {
        let directory = tempdir().unwrap();
        fs::write(
            directory.path().join("profile.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema_version": 4,
                "variables": {},
                "read_content_version": "demo-2",
                "read_dialogues": [],
                "seen_presentations": [],
                "dialogue_history": [
                    {"entry_id": 1, "prompt_id": "prologue/line", "speaker": null, "text": "legacy"},
                    {"entry_id": 2, "prompt_id": "../outside", "speaker": null, "text": "must be removed"},
                    {"entry_id": 3, "prompt_id": "prologue//line", "speaker": null, "text": "must be removed"}
                ],
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
        assert_eq!(
            state.completed_scenes,
            std::collections::BTreeSet::from(["prologue".to_owned()])
        );
        assert_eq!(state.dialogue_history.len(), 1);
        assert_eq!(state.dialogue_history[0].text, "legacy");
        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.path().join("profile.json")).unwrap())
                .unwrap();
        assert_eq!(
            written
                .get("dialogue_history")
                .and_then(serde_json::Value::as_array)
                .map(Vec::len),
            Some(1)
        );
        assert!(directory
            .path()
            .join("profile.incompatible.json.bak")
            .is_file());
    }

    #[test]
    fn malformed_history_is_ignored_without_losing_profile_variables() {
        let directory = tempdir().unwrap();
        fs::write(
            directory.path().join("profile.json"),
            br#"{
                "schema_version": 4,
                "variables": {"ending_seen": true},
                "read_content_version": "demo-2",
                "read_dialogues": [],
                "seen_presentations": [],
                "dialogue_history": [{"entry_id":"not-an-integer"}],
                "completed_scenes": []
            }"#,
        )
        .unwrap();

        let definitions = std::collections::BTreeMap::from([(
            "ending_seen".to_owned(),
            VariableDefinition {
                scope: VariableScope::Profile,
                value_type: VariableType::Boolean,
                default: ScalarValue::Boolean(false),
            },
        )]);
        let (_, state) = ProfileManager::new(
            directory.path().to_path_buf(),
            &definitions,
            "demo-2".to_owned(),
        )
        .unwrap();
        assert_eq!(
            state.variables.get("ending_seen"),
            Some(&ScalarValue::Boolean(true))
        );
        assert!(directory
            .path()
            .join("profile.incompatible.json.bak")
            .is_file());
    }

    #[test]
    fn profile_recovery_repairs_primary_without_overwriting_valid_backup() {
        let directory = tempdir().unwrap();
        let (_, initial) = ProfileManager::new(
            directory.path().to_path_buf(),
            &std::collections::BTreeMap::new(),
            "demo-2".to_owned(),
        )
        .unwrap();
        let primary = directory.path().join("profile.json");
        let backup = directory.path().join("profile.json.bak");
        let known_good = fs::read(&primary).unwrap();
        fs::write(&backup, &known_good).unwrap();
        fs::write(&primary, b"{\"schema_version\":4").unwrap();

        let (_, recovered) = ProfileManager::new(
            directory.path().to_path_buf(),
            &std::collections::BTreeMap::new(),
            "demo-2".to_owned(),
        )
        .unwrap();
        assert_eq!(recovered, initial);
        assert!(serde_json::from_slice::<serde_json::Value>(&fs::read(&primary).unwrap()).is_ok());
        assert_eq!(fs::read(&backup).unwrap(), known_good);
        assert!(directory
            .path()
            .join("profile.incompatible.json.bak")
            .is_file());
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
    }

    #[test]
    fn content_changes_only_clear_read_history() {
        let directory = tempdir().unwrap();
        let definitions = std::collections::BTreeMap::from([(
            "ending_seen".to_owned(),
            VariableDefinition {
                scope: VariableScope::Profile,
                value_type: VariableType::Boolean,
                default: ScalarValue::Boolean(false),
            },
        )]);
        let (manager, mut profile) = ProfileManager::new(
            directory.path().to_path_buf(),
            &definitions,
            "demo-2".to_owned(),
        )
        .unwrap();
        profile
            .variables
            .insert("ending_seen".to_owned(), ScalarValue::Boolean(true));
        profile
            .read_dialogues
            .insert("prologue/introduction".to_owned());
        profile
            .seen_presentations
            .insert("prologue/timeline_showcase".to_owned());
        manager.save(&profile).unwrap();

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
}
