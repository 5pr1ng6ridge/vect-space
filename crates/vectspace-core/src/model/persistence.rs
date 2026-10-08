use std::collections::BTreeSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::default_volume;
use super::audio::{AMBIENCE_VOLUME_DEFAULT, default_ambience_volume};
use super::text::TextRevealAnimation;
use super::variables::VariableMap;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProfileState {
    pub variables: VariableMap,
    pub read_content_version: String,
    pub read_dialogues: BTreeSet<String>,
    #[serde(default)]
    pub seen_presentations: BTreeSet<String>,
    #[serde(default)]
    pub completed_scenes: BTreeSet<String>,
    /// Persisted storage for the active Scene's dialogue history. The runtime
    /// clears it whenever a new Scene/session becomes the owner.
    #[serde(default)]
    pub dialogue_history: Vec<DialogueHistoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DialogueHistoryEntry {
    pub entry_id: u64,
    pub prompt_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker_id: Option<String>,
    #[serde(default)]
    pub speaker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SaveSlotSummary {
    pub slot: String,
    pub exists: bool,
    pub saved_at_unix_ms: Option<u64>,
    pub scene_id: Option<String>,
    pub prompt_preview: Option<String>,
    pub thumbnail_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub master_volume: f32,
    pub bgm_volume: f32,
    pub sfx_volume: f32,
    #[serde(default = "default_volume")]
    pub video_volume: f32,
    #[serde(default = "default_ambience_volume")]
    pub ambience_volume: f32,
    pub text_speed_cps: f32,
    #[serde(default)]
    pub text_reveal_animation: TextRevealAnimation,
    #[serde(default)]
    pub skip_mode: SkipMode,
    /// Player accessibility preference: attenuates flashes, shakes and the
    /// shader screen effects.  Absent in settings files written before it.
    #[serde(default)]
    pub reduce_motion: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkipMode {
    Disabled,
    #[default]
    ReadOnly,
    All,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            master_volume: 1.0,
            bgm_volume: 0.7,
            sfx_volume: 0.8,
            video_volume: 1.0,
            ambience_volume: AMBIENCE_VOLUME_DEFAULT,
            text_speed_cps: 30.0,
            text_reveal_animation: TextRevealAnimation::Typewriter,
            skip_mode: SkipMode::ReadOnly,
            reduce_motion: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SaveSlotRequest {
    pub slot: String,
    pub thumbnail_data_url: Option<String>,
}
