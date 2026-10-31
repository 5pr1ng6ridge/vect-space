//! Deterministic visual-novel runtime with no desktop-host dependencies.

use thiserror::Error;

use crate::content::ContentCatalog;
use crate::interaction::{UpdateKind, WindowRequest, WindowTitles};
use crate::model::{
    BootstrapPayload, ChapterMapDecorationSnapshot, ChapterMapHotspotSnapshot,
    ChapterMapReveal, ChapterMapSnapshot, CueGate, DialogueHistoryEntry,
    PresentationCue, PresentationCueKind, ProfileState, PromptSnapshot, RuntimeSnapshot,
    RuntimeUpdate, StoryLocation, VariableMap, VariableScope,
};

mod choice;
mod commands;
mod dialogue;
mod execute;
mod interaction;
mod preview;
mod proof;
mod snapshot;
mod timeline;
mod variables;
#[cfg(test)]
mod tests;

pub use preview::{PreviewChoiceDecision, PreviewRunResult};

use choice::resync_choice_prompt_from_content;
use snapshot::{initial_snapshot, validate_snapshot};
use variables::{normalize_value, profile_defaults, validate_profile_variables};

const MAX_IMMEDIATE_NODES: usize = 10_000;
/// Same bound the profile layer enforces on the persisted dialogue ledger, so a
/// host-merged main+secondary ledger is always already canonical when it is
/// written back through `ProfileManager::save`.
const MAX_DIALOGUE_HISTORY_ENTRIES: usize = 500;
const MAX_LONG_TEXT_DOCUMENT_STEPS: usize = 1_024;
const MAX_LONG_TEXT_DOCUMENT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("剧情尚未开始")]
    NotStarted,
    #[error("当前修订号已过期：期望 {expected}，实际 {actual}")]
    StaleRevision { expected: u64, actual: u64 },
    #[error("表现层仍在执行 update {0}，当前不能推进")]
    PresentationPending(u64),
    #[error("表现确认不匹配：期望 update {expected}，收到 {actual}")]
    InvalidAcknowledgement { expected: u64, actual: u64 },
    #[error("该表现不可跳过")]
    PresentationNotSkippable,
    #[error("当前不是可推进的对话")]
    AdvanceNotAllowed,
    #[error("当前不是选择状态")]
    ChoiceNotAllowed,
    #[error("The current prompt is not a proof activity")]
    ProofNotAllowed,
    #[error("This proof activity cannot be abandoned")]
    ProofAbandonNotAllowed,
    #[error("Invalid proof draft: {0}")]
    InvalidProofDraft(String),
    #[error("选项不可用或不存在: {0}")]
    UnknownChoice(String),
    #[error("按钮不可用或不存在: {0}")]
    UnknownButton(String),
    #[error("内容运行错误: {0}")]
    Content(String),
    #[error("连续即时节点超过安全上限，可能存在无交互死循环")]
    ImmediateLoop,
    #[error("存档状态无效: {0}")]
    InvalidSnapshot(String),
}

#[derive(Debug, Clone)]
pub struct RuntimeEngine {
    snapshot: RuntimeSnapshot,
    window_variables: VariableMap,
    initial_window_titles: Option<WindowTitles>,
    window_requests: Vec<WindowRequest>,
    host_boundary: bool,
    last_fired_timer: Option<String>,
    profile_variables: VariableMap,
    read_dialogues: std::collections::BTreeSet<String>,
    seen_presentations: std::collections::BTreeSet<String>,
    dialogue_history: Vec<DialogueHistoryEntry>,
    completed_scenes: std::collections::BTreeSet<String>,
    solved_proofs: std::collections::BTreeSet<String>,
    started: bool,
    next_update_id: u64,
    next_cue_id: u64,
    /// Optional revision namespace used by an isolated host session (for
    /// example Scene replay).  Keeping the namespace in the revision and
    /// update/cue counters means a late acknowledgement from an old session
    /// cannot accidentally match a newly-created main runtime update.
    session_revision_override: Option<u64>,
    initial_save_overrides: VariableMap,
    pending_runtime_update: Option<PendingPresentation>,
    preview_target: Option<StoryLocation>,
    preview_skip_target_once: bool,
    /// When true this engine is the secondary window's runtime: it shares the
    /// host-authoritative variable maps with the main runtime, so leaving a
    /// Scene must not reset Save-scope variables to their declared defaults.
    /// Only the main runtime owns the shared map's reset semantics.
    shared_save_variables: bool,
    /// Dialogue entries appended since the host last drained this queue.  The
    /// desktop hosts keep one ordered ledger across the main and secondary
    /// runtimes, and that delta cannot be reconstructed from `dialogue_history`
    /// because a Scene boundary resets it.  The queue therefore survives
    /// `leave_scene` and is only dropped by explicit history resets, so an
    /// occurrence produced inside one command can never be silently lost.
    appended_history: Vec<DialogueHistoryEntry>,
}

#[derive(Debug, Clone)]
struct PendingPresentation {
    update_id: u64,
    presentation_id: Option<String>,
    skippable: bool,
}

impl RuntimeEngine {
    pub fn new(content: &ContentCatalog) -> Result<Self, RuntimeError> {
        Self::with_profile(
            content,
            ProfileState {
                variables: profile_defaults(content)?,
                read_content_version: content.manifest.content_version.clone(),
                read_dialogues: Default::default(),
                seen_presentations: Default::default(),
                solved_proofs: Default::default(),
                completed_scenes: Default::default(),
                dialogue_history: Default::default(),
            },
        )
    }

    pub fn with_profile(
        content: &ContentCatalog,
        profile: ProfileState,
    ) -> Result<Self, RuntimeError> {
        validate_profile_variables(content, &profile.variables)?;
        let snapshot = initial_snapshot(content)?;
        Ok(Self {
            window_variables: snapshot.interaction.titles.variables(),
            initial_window_titles: None,
            window_requests: Vec::new(),
            host_boundary: false,
            last_fired_timer: None,
            snapshot,
            profile_variables: profile.variables,
            read_dialogues: profile.read_dialogues,
            solved_proofs: profile.solved_proofs,
            seen_presentations: profile.seen_presentations,
            dialogue_history: profile.dialogue_history,
            completed_scenes: profile.completed_scenes,
            started: false,
            next_update_id: 1,
            next_cue_id: 1,
            session_revision_override: None,
            initial_save_overrides: VariableMap::new(),
            pending_runtime_update: None,
            preview_target: None,
            preview_skip_target_once: false,
            shared_save_variables: false,
            appended_history: Vec::new(),
        })
    }

    /// Mark this engine as the host's secondary-window runtime.  A secondary
    /// engine shares the authoritative Save/Profile variable maps with the main
    /// runtime, so its own Scene boundary must preserve them instead of
    /// resetting Save-scope variables to the declared defaults.
    pub fn set_shared_save_variables(&mut self, shared: bool) {
        self.shared_save_variables = shared;
    }

    /// Replace the Save-scope variable map with the host-authoritative copy.
    pub fn set_save_variables(&mut self, variables: VariableMap) {
        self.snapshot.variables = variables;
    }

    /// Replace the Profile-scope variable map with the host-authoritative copy.
    pub fn set_profile_variables(&mut self, variables: VariableMap) {
        self.profile_variables = variables;
    }

    /// Take the entries appended since the previous drain.  The desktop host
    /// merges them into its single ordered ledger right after a command
    /// commits; the queue is intentionally not cleared by a Scene boundary.
    pub fn take_appended_history(&mut self) -> Vec<DialogueHistoryEntry> {
        std::mem::take(&mut self.appended_history)
    }

    /// Append host-merged history entries (for example the secondary window's
    /// occurrences) to this runtime's ledger, keeping it canonical: ids are
    /// renumbered and the ledger keeps the newest entries up to the same cap the
    /// profile layer enforces.
    pub fn extend_dialogue_history(
        &mut self,
        entries: impl IntoIterator<Item = DialogueHistoryEntry>,
    ) {
        self.dialogue_history.extend(entries);
        self.canonicalize_dialogue_history();
    }

    /// Replace the ledger with a persisted one (used when a save slot's merged
    /// history is restored) and make it canonical again.
    pub fn replace_dialogue_history(&mut self, entries: Vec<DialogueHistoryEntry>) {
        self.dialogue_history = entries;
        self.canonicalize_dialogue_history();
    }

    fn canonicalize_dialogue_history(&mut self) {
        if self.dialogue_history.len() > MAX_DIALOGUE_HISTORY_ENTRIES {
            let excess = self.dialogue_history.len() - MAX_DIALOGUE_HISTORY_ENTRIES;
            self.dialogue_history.drain(..excess);
        }
        for (index, entry) in self.dialogue_history.iter_mut().enumerate() {
            entry.entry_id = index as u64 + 1;
        }
    }

    /// Build an isolated runtime with editor-provided variable overrides.
    /// This never touches the player's profile or save data.
    pub fn with_preview_overrides(
        content: &ContentCatalog,
        overrides: &VariableMap,
    ) -> Result<Self, RuntimeError> {
        Self::with_profile_overrides(
            content,
            ProfileState {
                variables: profile_defaults(content)?,
                read_content_version: content.manifest.content_version.clone(),
                read_dialogues: Default::default(),
                seen_presentations: Default::default(),
                solved_proofs: Default::default(),
                completed_scenes: Default::default(),
                dialogue_history: Default::default(),
            },
            overrides,
        )
    }

    /// Build an isolated runtime from a profile clone and apply author
    /// supplied overrides.  Save-scope values are written to the fresh
    /// snapshot; profile-scope values are written to the cloned profile.  No
    /// caller-owned state is mutated, which is what scene replay and editor
    /// previews need.
    pub fn with_profile_overrides(
        content: &ContentCatalog,
        profile: ProfileState,
        overrides: &VariableMap,
    ) -> Result<Self, RuntimeError> {
        let mut runtime = Self::with_profile(content, profile)?;
        for (id, value) in overrides {
            let definition = content
                .manifest
                .variables
                .get(id)
                .ok_or_else(|| RuntimeError::Content(format!("未声明变量 {id}")))?;
            let value = normalize_value(value.clone(), definition.value_type)?;
            match definition.scope {
                VariableScope::Save => {
                    runtime
                        .initial_save_overrides
                        .insert(id.clone(), value.clone());
                    runtime.snapshot.variables.insert(id.clone(), value);
                }
                VariableScope::Profile => {
                    runtime.profile_variables.insert(id.clone(), value);
                }
            }
        }
        Ok(runtime)
    }

    /// Replay uses author defaults, retaining only the player's read/seen flags.
    pub fn with_replay_overrides(
        content: &ContentCatalog,
        profile: ProfileState,
        overrides: &VariableMap,
    ) -> Result<Self, RuntimeError> {
        Self::with_profile_overrides(
            content,
            ProfileState {
                variables: profile_defaults(content)?,
                read_content_version: content.manifest.content_version.clone(),
                read_dialogues: profile.read_dialogues,
                solved_proofs: profile.solved_proofs,
                seen_presentations: profile.seen_presentations,
                completed_scenes: Default::default(),
                // Replay is isolated: retain read/seen flags for skip
                // behaviour, but never expose or mutate global history.
                dialogue_history: Default::default(),
            },
            overrides,
        )
    }

    /// Put this runtime in a host-chosen ID namespace before starting a
    /// temporary session.  The revision override is consumed by the next
    /// `start_new_game`/`start_scene_preview` reset; update and cue counters
    /// remain in that namespace for the rest of the session.
    ///
    /// This is deliberately not part of the content or save format.  It only
    /// protects the IPC boundary from stale async work when a replay is
    /// closed while a cue is still settling.
    pub fn prepare_session_ids(&mut self, revision: u64, update_id: u64, cue_id: u64) {
        self.session_revision_override = Some(revision);
        self.next_update_id = update_id.max(1);
        self.next_cue_id = cue_id.max(1);
    }

    pub fn bootstrap(&mut self, content: &ContentCatalog) -> BootstrapPayload {
        let update = self.update_without_cues();
        BootstrapPayload {
            update,
            text_blocks: content.text_blocks.clone(),
            particles: content.particles.clone(),
            asset_ids: content.asset_ids(),
            content_version: content.manifest.content_version.clone(),
            chapter_map_available: content.chapter_map.is_some(),
            default_font: content.manifest.default_font.clone().or_else(|| {
                content
                    .manifest
                    .assets
                    .iter()
                    .find(|(id, definition)| {
                        id.as_str() == "font.fusion_pixel"
                            && definition.kind == crate::model::AssetKind::Font
                    })
                    .map(|(id, _)| id.clone())
            }),
        }
    }

    pub fn start_new_game(
        &mut self,
        content: &ContentCatalog,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        self.begin_session(content, None)
    }

    /// Reset to a fresh snapshot, optionally positioned at `location`, and run
    /// to the first boundary.
    pub(super) fn begin_session(
        &mut self,
        content: &ContentCatalog,
        location: Option<StoryLocation>,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        let previous_revision = self.snapshot.revision;
        self.snapshot = initial_snapshot(content)?;
        self.reset_window_context();
        self.snapshot
            .variables
            .append(&mut self.initial_save_overrides);
        self.snapshot.revision = self
            .session_revision_override
            .take()
            .unwrap_or(previous_revision);
        if let Some(location) = location {
            self.snapshot.location = location;
        }
        self.started = true;
        self.pending_runtime_update = None;
        self.dialogue_history.clear();
        self.appended_history.clear();
        let cues = self.run_until_boundary(content)?;
        Ok(self.finish_update(cues, true))
    }

    pub fn snapshot(&self) -> &RuntimeSnapshot {
        &self.snapshot
    }

    /// The Profile-scope variable map, for hosts that own it as shared
    /// authoritative state across more than one runtime.
    pub fn profile_variables_map(&self) -> &VariableMap {
        &self.profile_variables
    }

    pub fn profile_state(&self, content: &ContentCatalog) -> ProfileState {
        ProfileState {
            variables: self.profile_variables.clone(),
            read_content_version: content.manifest.content_version.clone(),
            read_dialogues: self.read_dialogues.clone(),
            seen_presentations: self.seen_presentations.clone(),
            solved_proofs: self.solved_proofs.clone(),
            completed_scenes: self.completed_scenes.clone(),
            dialogue_history: self.dialogue_history.clone(),
        }
    }

    pub fn dialogue_history(&self) -> &[DialogueHistoryEntry] {
        &self.dialogue_history
    }

    /// Return only the revealed part of the chapter room.  The content map is
    /// authored independently from story jumps; profile conditions are
    /// evaluated here so hidden chapters never reach the WebView.
    pub fn chapter_map(
        &self,
        content: &ContentCatalog,
    ) -> Result<Option<ChapterMapSnapshot>, RuntimeError> {
        let Some(map) = &content.chapter_map else {
            return Ok(None);
        };
        let mut hotspots = Vec::new();
        for hotspot in &map.hotspots {
            let completed = self.completed_scenes.contains(&hotspot.scene_id);
            let replayable =
                completed || matches!(hotspot.replay, crate::model::ChapterMapReplay::Always);
            let visible = match &hotspot.reveal {
                ChapterMapReveal::Completed => completed,
                ChapterMapReveal::Always => true,
                ChapterMapReveal::Condition { condition } => {
                    self.evaluate_condition(content, condition)?
                }
            };
            if visible {
                hotspots.push(ChapterMapHotspotSnapshot {
                    id: hotspot.id.clone(),
                    scene_id: hotspot.scene_id.clone(),
                    title: hotspot.title.clone(),
                    hover_text: hotspot.hover_text.clone(),
                    x: hotspot.x,
                    y: hotspot.y,
                    width: hotspot.width,
                    height: hotspot.height,
                    z: hotspot.z,
                    asset: hotspot.asset.clone(),
                    completed,
                    replayable,
                });
            }
        }
        Ok(Some(ChapterMapSnapshot {
            width: map.width,
            height: map.height,
            view_x: map.view_x,
            view_y: map.view_y,
            background: map.background.clone(),
            decorations: map
                .decorations
                .iter()
                .map(|decoration| ChapterMapDecorationSnapshot {
                    id: decoration.id.clone(),
                    asset: decoration.asset.clone(),
                    x: decoration.x,
                    y: decoration.y,
                    width: decoration.width,
                    height: decoration.height,
                    z: decoration.z,
                })
                .collect(),
            hotspots,
        }))
    }

    pub fn pending_runtime_update(&self) -> Option<u64> {
        self.pending_runtime_update
            .as_ref()
            .map(|pending| pending.update_id)
    }

    /// End an isolated replay at a scene boundary without evaluating the
    /// destination scene.  A cross-scene jump emits a clear-scene runtime cue
    /// first; once that cue is acknowledged the host uses this method instead
    /// of allowing the normal story loop to enter the next scene.
    pub fn finish_replay_boundary(
        &mut self,
        update_id: u64,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        let expected =
            self.pending_runtime_update
                .take()
                .ok_or(RuntimeError::InvalidAcknowledgement {
                    expected: 0,
                    actual: update_id,
                })?;
        if expected.update_id != update_id {
            self.pending_runtime_update = Some(expected.clone());
            return Err(RuntimeError::InvalidAcknowledgement {
                expected: expected.update_id,
                actual: update_id,
            });
        }
        self.snapshot.revision = self.snapshot.revision.saturating_add(1);
        self.snapshot.dialogue_page = None;
        self.snapshot.long_text_page = None;
        self.snapshot.prompt = PromptSnapshot::End {
            prompt_id: format!(
                "replay/{}/{}",
                self.snapshot.location.scene_id, self.snapshot.location.node_id
            ),
        };
        Ok(self.finish_update(Vec::new(), true))
    }

    pub fn load_snapshot(
        &mut self,
        content: &ContentCatalog,
        mut snapshot: RuntimeSnapshot,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        resync_choice_prompt_from_content(content, &mut snapshot)?;
        validate_snapshot(content, &snapshot)?;
        match &mut snapshot.prompt {
            PromptSnapshot::Dialogue {
                prompt_id, is_read, ..
            }
            | PromptSnapshot::LongText {
                prompt_id, is_read, ..
            } => {
                *is_read = self.read_dialogues.contains(prompt_id);
            }
            _ => {}
        }
        snapshot.revision = self.snapshot.revision.saturating_add(1);
        if snapshot.interaction.prompt_instance.is_empty() {
            snapshot.interaction.prompt_instance = self.next_update_id.to_string();
        }
        self.initial_window_titles = None;
        self.window_variables = snapshot.interaction.titles.variables();
        self.window_requests.clear();
        self.host_boundary = false;
        self.snapshot = snapshot;
        self.started = true;
        self.pending_runtime_update = None;
        self.dialogue_history.clear();
        self.appended_history.clear();
        Ok(self.update_without_cues())
    }

    fn cue(&mut self, gate: CueGate, kind: PresentationCueKind) -> PresentationCue {
        let cue = PresentationCue {
            cue_id: self.next_cue_id,
            gate,
            kind,
        };
        self.next_cue_id = self.next_cue_id.saturating_add(1);
        cue
    }

    fn append_history(
        &mut self,
        prompt_id: String,
        speaker_id: Option<String>,
        speaker: Option<String>,
        name_color: Option<String>,
        text_color: Option<String>,
        text: String,
    ) {
        let entry_id = self
            .dialogue_history
            .last()
            .map_or(1, |entry| entry.entry_id.saturating_add(1));
        let entry = DialogueHistoryEntry {
            entry_id,
            prompt_id,
            speaker_id,
            speaker,
            name_color,
            text_color,
            text,
        };
        self.appended_history.push(entry.clone());
        self.dialogue_history.push(entry);
        self.canonicalize_dialogue_history();
        if self.appended_history.len() > MAX_DIALOGUE_HISTORY_ENTRIES {
            let excess = self.appended_history.len() - MAX_DIALOGUE_HISTORY_ENTRIES;
            self.appended_history.drain(..excess);
        }
    }

    fn finish_update(&mut self, cues: Vec<PresentationCue>, bump_revision: bool) -> RuntimeUpdate {
        if bump_revision {
            self.snapshot.revision = self.snapshot.revision.saturating_add(1);
        }
        let update_id = self.next_update_id;
        self.next_update_id = self.next_update_id.saturating_add(1);
        let requires_ack = cues.iter().any(|cue| cue.gate == CueGate::Runtime);
        if requires_ack {
            let timeline = cues.iter().find_map(|cue| match &cue.kind {
                PresentationCueKind::Timeline {
                    presentation_id,
                    skippable,
                    ..
                } if cue.gate == CueGate::Runtime => Some((presentation_id.clone(), *skippable)),
                _ => None,
            });
            self.pending_runtime_update = Some(PendingPresentation {
                update_id,
                presentation_id: timeline.as_ref().map(|value| value.0.clone()),
                skippable: timeline.is_some_and(|value| value.1),
            });
        }
        RuntimeUpdate {
            kind: UpdateKind::Story,
            effect_timer: None,
            update_id,
            snapshot: self.snapshot.clone(),
            cues,
            requires_ack,
        }
    }

    fn update_without_cues(&mut self) -> RuntimeUpdate {
        self.finish_update(Vec::new(), false)
    }
}
