use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Fixed ambience channel identity shared by authored nodes, snapshots and
/// timeline tracks. Explicit serde names are required because
/// `rename_all = "snake_case"` would serialize `Slot1` as `slot1`, not the
/// contract's `slot_1`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum AmbienceSlot {
    #[serde(rename = "slot_1")]
    Slot1,
    #[serde(rename = "slot_2")]
    Slot2,
    #[serde(rename = "slot_3")]
    Slot3,
    #[serde(rename = "slot_4")]
    Slot4,
}

impl AmbienceSlot {
    pub const ALL: [Self; 4] = [Self::Slot1, Self::Slot2, Self::Slot3, Self::Slot4];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Slot1 => "slot_1",
            Self::Slot2 => "slot_2",
            Self::Slot3 => "slot_3",
            Self::Slot4 => "slot_4",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AmbienceSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_1: Option<LoopingAudioSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_2: Option<LoopingAudioSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_3: Option<LoopingAudioSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_4: Option<LoopingAudioSnapshot>,
}

impl AmbienceSnapshot {
    pub const fn is_empty(&self) -> bool {
        self.slot_1.is_none()
            && self.slot_2.is_none()
            && self.slot_3.is_none()
            && self.slot_4.is_none()
    }

    pub fn get(&self, slot: AmbienceSlot) -> Option<&LoopingAudioSnapshot> {
        match slot {
            AmbienceSlot::Slot1 => self.slot_1.as_ref(),
            AmbienceSlot::Slot2 => self.slot_2.as_ref(),
            AmbienceSlot::Slot3 => self.slot_3.as_ref(),
            AmbienceSlot::Slot4 => self.slot_4.as_ref(),
        }
    }

    pub fn get_mut(&mut self, slot: AmbienceSlot) -> Option<&mut LoopingAudioSnapshot> {
        match slot {
            AmbienceSlot::Slot1 => self.slot_1.as_mut(),
            AmbienceSlot::Slot2 => self.slot_2.as_mut(),
            AmbienceSlot::Slot3 => self.slot_3.as_mut(),
            AmbienceSlot::Slot4 => self.slot_4.as_mut(),
        }
    }

    pub fn set(&mut self, slot: AmbienceSlot, state: Option<LoopingAudioSnapshot>) {
        match slot {
            AmbienceSlot::Slot1 => self.slot_1 = state,
            AmbienceSlot::Slot2 => self.slot_2 = state,
            AmbienceSlot::Slot3 => self.slot_3 = state,
            AmbienceSlot::Slot4 => self.slot_4 = state,
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (AmbienceSlot, &LoopingAudioSnapshot)> {
        AmbienceSlot::ALL
            .into_iter()
            .filter_map(|slot| self.get(slot).map(|state| (slot, state)))
    }

    pub fn iter_mut(&mut self) -> impl Iterator<Item = (AmbienceSlot, &mut LoopingAudioSnapshot)> {
        // A fixed array of mutable optional references avoids exposing the
        // representation as a map while still making validation exhaustive.
        let slots = [
            (AmbienceSlot::Slot1, &mut self.slot_1),
            (AmbienceSlot::Slot2, &mut self.slot_2),
            (AmbienceSlot::Slot3, &mut self.slot_3),
            (AmbienceSlot::Slot4, &mut self.slot_4),
        ];
        slots
            .into_iter()
            .filter_map(|(slot, state)| state.as_mut().map(|state| (slot, state)))
    }
}

/// Player-facing default for authored ambience nodes and the corresponding
/// settings control. BGM/SFX defaults remain unchanged.
pub const AMBIENCE_VOLUME_DEFAULT: f32 = 0.8;

pub(super) fn default_ambience_volume() -> f32 {
    AMBIENCE_VOLUME_DEFAULT
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AudioAction {
    Start,
    Stop,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AudioSnapshot {
    pub bgm: Option<LoopingAudioSnapshot>,
    /// Four fixed optional slots. The whole object is omitted when empty.
    #[serde(default, skip_serializing_if = "AmbienceSnapshot::is_empty")]
    pub ambience: AmbienceSnapshot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LoopingAudioSnapshot {
    pub asset: String,
    pub volume: f32,
    #[serde(default)]
    pub start_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_start_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_end_ms: Option<u64>,
}
