//! Deterministic visual-novel runtime with no desktop-host dependencies.

use crate::{
    choice::{layout_choice_items, legacy_choice_anchor},
    content::ContentCatalog,
    model::{
        AdvanceSource, AssetKind, AudioAction, AudioSnapshot, BootstrapPayload, ButtonClickAction,
        ButtonPostAction, ButtonSnapshot, ButtonTemplate, CameraSnapshot,
        ChapterMapDecorationSnapshot, ChapterMapHotspotSnapshot, ChapterMapReveal,
        ChapterMapSnapshot, ChoiceDiagnostic, ChoiceDiagnosticCode, ChoiceFlowDirection,
        ChoiceLayoutSnapshot, ChoicePresentation, ChoiceSnapshot, ChoiceTemplateSnapshot,
        ConditionExpression, CtrlFastForwardMode, CueGate, CurtainAction, CurtainFill,
        CurtainSnapshot, DialogueHistoryEntry, DialogueMode, DialoguePageSnapshot,
        LongTextControlAction, LongTextExit, LongTextMode, LongTextPageSnapshot,
        LongTextStepSnapshot, LoopingAudioSnapshot, MutationValue, PlaybackAutoMode,
        PlaybackSnapshot, PresentationCue, PresentationCueKind, PresentationOutcome, ProfileState,
        PromptSnapshot, RuntimeSnapshot, RuntimeUpdate, ScalarValue, SceneNode, SpriteAction,
        SpriteActionDefinition, SpriteActionEnd, SpriteSnapshot, StoryLocation, TimelineChannels,
        TimelineEasing, TimelineKeyframe, TimelineKeyframeValue, TimelineTrack, UiMotionPreset,
        UiMotionSlot, ValueOperand, VariableMap, VariableOperation, VariableScope, VariableType,
        WorldSnapshot, CHOICE_DEFAULT_ANCHOR_X, CHOICE_DEFAULT_ANCHOR_Y, CHOICE_DEFAULT_GAP,
        CHOICE_FALLBACK_BUTTON_HEIGHT, CHOICE_FALLBACK_BUTTON_WIDTH, CHOICE_STAGE_HEIGHT,
        CHOICE_STAGE_WIDTH,
    },
    text_template::{self, MAX_VARIABLE_STRING_BYTES},
};
use thiserror::Error;

const MAX_IMMEDIATE_NODES: usize = 10_000;
const MAX_LONG_TEXT_DOCUMENT_STEPS: usize = 1_024;
const MAX_LONG_TEXT_DOCUMENT_BYTES: usize = 1024 * 1024;

/// A deterministic choice supplied by the editor's timeline-context wizard.
/// `visit` disambiguates loops that encounter the same choice node more than
/// once while replaying from the scene entry.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewChoiceDecision {
    pub scene_id: String,
    pub node_id: String,
    pub visit: usize,
    pub choice_id: String,
}

#[allow(dead_code)]
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq)]
pub enum PreviewRunResult {
    Ready {
        snapshot: RuntimeSnapshot,
        trace: Vec<StoryLocation>,
    },
    NeedsChoice {
        location: StoryLocation,
        visit: usize,
        choices: Vec<ChoiceSnapshot>,
        trace: Vec<StoryLocation>,
    },
    Unreachable {
        message: String,
        trace: Vec<StoryLocation>,
    },
}

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
    profile_variables: VariableMap,
    read_dialogues: std::collections::BTreeSet<String>,
    seen_presentations: std::collections::BTreeSet<String>,
    dialogue_history: Vec<DialogueHistoryEntry>,
    completed_scenes: std::collections::BTreeSet<String>,
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
}

#[derive(Debug, Clone)]
struct PendingPresentation {
    update_id: u64,
    presentation_id: Option<String>,
    skippable: bool,
}

impl RuntimeEngine {
    #[allow(dead_code)]
    pub fn new(content: &ContentCatalog) -> Result<Self, RuntimeError> {
        Self::with_profile(
            content,
            ProfileState {
                variables: profile_defaults(content)?,
                read_content_version: content.manifest.content_version.clone(),
                read_dialogues: Default::default(),
                seen_presentations: Default::default(),
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
            snapshot,
            profile_variables: profile.variables,
            read_dialogues: profile.read_dialogues,
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
        })
    }

    /// Build an isolated runtime with editor-provided variable overrides.
    /// This never touches the player's profile or save data.
    #[allow(dead_code)]
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

    /// Replay the story from its entry until immediately before `target`.
    /// Dialogue and awaited presentation boundaries are completed internally;
    /// choices are returned to the editor so the caller can extend the path.
    #[allow(dead_code)]
    pub fn preview_to(
        &mut self,
        content: &ContentCatalog,
        target: &StoryLocation,
        decisions: &[PreviewChoiceDecision],
    ) -> Result<PreviewRunResult, RuntimeError> {
        self.preview_to_with_origin(content, target, decisions, None)
    }

    /// Variant of [`preview_to`] that starts at a scene entry rather than the
    /// manifest entry.  It is intentionally explicit so the editor never
    /// silently changes preview context after an unreachable path.
    pub fn preview_to_from_scene_entry(
        &mut self,
        content: &ContentCatalog,
        scene_id: &str,
        target: &StoryLocation,
        decisions: &[PreviewChoiceDecision],
    ) -> Result<PreviewRunResult, RuntimeError> {
        self.preview_to_with_origin(content, target, decisions, Some(scene_id))
    }

    fn preview_to_with_origin(
        &mut self,
        content: &ContentCatalog,
        target: &StoryLocation,
        decisions: &[PreviewChoiceDecision],
        origin_scene: Option<&str>,
    ) -> Result<PreviewRunResult, RuntimeError> {
        self.preview_target = Some(target.clone());
        self.preview_skip_target_once = false;
        let mut last_trace = Vec::new();
        let result = (|| {
            let mut visits = std::collections::BTreeMap::<StoryLocation, usize>::new();
            let mut trace = Vec::new();
            let mut update = match origin_scene {
                Some(scene_id) => self.start_scene_preview(content, scene_id)?,
                None => self.start_new_game(content)?,
            };
            for _ in 0..MAX_IMMEDIATE_NODES {
                if origin_scene.is_some() && self.snapshot.location.scene_id != target.scene_id {
                    return Err(RuntimeError::Content(format!(
                        "当前 Scene 内无法到达预览目标 {}/{}：路径已离开 {}",
                        target.scene_id, target.node_id, target.scene_id
                    )));
                }
                if trace.last() != Some(&self.snapshot.location) {
                    trace.push(self.snapshot.location.clone());
                    last_trace.clone_from(&trace);
                }
                if self.snapshot.location == *target
                    && matches!(self.snapshot.prompt, PromptSnapshot::None)
                    && !update.requires_ack
                {
                    return Ok(PreviewRunResult::Ready {
                        snapshot: self.snapshot.clone(),
                        trace,
                    });
                }
                if update.requires_ack {
                    update = self.presentation_complete(
                        content,
                        update.update_id,
                        PresentationOutcome::Completed,
                    )?;
                    continue;
                }
                match &self.snapshot.prompt {
                    PromptSnapshot::Dialogue { .. } | PromptSnapshot::LongText { .. } => {
                        let source = if self.snapshot.playback.auto == PlaybackAutoMode::Forced {
                            AdvanceSource::ForcedAuto
                        } else {
                            AdvanceSource::Auto
                        };
                        update = self.advance(content, self.snapshot.revision, source)?;
                    }
                    PromptSnapshot::Choice { choices, .. } => {
                        let location = self.snapshot.location.clone();
                        let visit = visits.entry(location.clone()).or_insert(0);
                        *visit += 1;
                        let decision = decisions.iter().find(|candidate| {
                            candidate.scene_id == location.scene_id
                                && candidate.node_id == location.node_id
                                && candidate.visit == *visit
                        });
                        let Some(decision) = decision else {
                            return Ok(PreviewRunResult::NeedsChoice {
                                location,
                                visit: *visit,
                                choices: choices.clone(),
                                trace,
                            });
                        };
                        if !choices
                            .iter()
                            .any(|choice| choice.id == decision.choice_id && choice.enabled)
                        {
                            // A changed document can invalidate a persisted
                            // editor choice. Re-open the wizard at this first
                            // invalid point instead of turning it into a
                            // generic unreachable error.
                            return Ok(PreviewRunResult::NeedsChoice {
                                location,
                                visit: *visit,
                                choices: choices.clone(),
                                trace,
                            });
                        }
                        update =
                            self.choose(content, &decision.choice_id, self.snapshot.revision)?;
                    }
                    PromptSnapshot::End { .. } => {
                        return Err(RuntimeError::Content(format!(
                            "未能到达时间轴节点 {}/{}：提前到达结束节点",
                            target.scene_id, target.node_id
                        )));
                    }
                    PromptSnapshot::None => {
                        update = self.update_without_cues();
                    }
                }
            }
            Err(RuntimeError::ImmediateLoop)
        })();
        self.preview_target = None;
        Ok(match result {
            Ok(result) => result,
            Err(error) => PreviewRunResult::Unreachable {
                message: error.to_string(),
                trace: last_trace,
            },
        })
    }

    /// Execute the timeline node at the current location exactly once and
    /// return the same update the game would present. The preview target is
    /// temporarily set to the node's successor so immediate nodes after the
    /// timeline are not folded into this update.
    #[allow(dead_code)]
    pub fn preview_execute_current(
        &mut self,
        content: &ContentCatalog,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        let scene_id = self.snapshot.location.scene_id.clone();
        let node_id = self.snapshot.location.node_id.clone();
        let scene = content
            .scene(&scene_id)
            .map_err(|error| RuntimeError::Content(error.to_string()))?;
        if !matches!(scene.nodes.get(&node_id), Some(SceneNode::Timeline { .. })) {
            return Err(RuntimeError::Content(format!(
                "目标节点不是 timeline：{scene_id}/{node_id}"
            )));
        }
        self.preview_execute_current_node(content)
    }

    /// Execute any node currently selected by an editor preview.  The
    /// successor is used as a temporary breakpoint, so the returned update is
    /// exactly the update the game would emit for that node and no later
    /// immediate nodes are folded into the result.  Choice and End nodes have
    /// no successor and naturally return their prompt boundary.
    pub fn preview_execute_current_node(
        &mut self,
        content: &ContentCatalog,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        let scene_id = self.snapshot.location.scene_id.clone();
        let node_id = self.snapshot.location.node_id.clone();
        let scene = content
            .scene(&scene_id)
            .map_err(|error| RuntimeError::Content(error.to_string()))?;
        let node = scene
            .nodes
            .get(&node_id)
            .ok_or_else(|| RuntimeError::Content(format!("节点不存在: {scene_id}/{node_id}")))?;
        self.preview_target = preview_successor(&scene_id, node);
        // The successor can legally loop back to this same node. Skip the
        // breakpoint once so the selected node itself is always executed.
        self.preview_skip_target_once = true;
        let result = self
            .run_until_boundary(content)
            .map(|cues| self.finish_update(cues, true));
        self.preview_target = None;
        self.preview_skip_target_once = false;
        result
    }

    pub fn bootstrap(&mut self, content: &ContentCatalog) -> BootstrapPayload {
        let update = self.update_without_cues();
        BootstrapPayload {
            update,
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
        let previous_revision = self.snapshot.revision;
        self.snapshot = initial_snapshot(content)?;
        self.snapshot
            .variables
            .append(&mut self.initial_save_overrides);
        self.snapshot.revision = self
            .session_revision_override
            .take()
            .unwrap_or(previous_revision);
        self.started = true;
        self.pending_runtime_update = None;
        self.dialogue_history.clear();
        let cues = self.run_until_boundary(content)?;
        Ok(self.finish_update(cues, true))
    }

    /// Start an isolated preview at a scene's declared entry.  This is used
    /// only by editor tooling; it keeps the same profile/variable clone as a
    /// story-entry preview and never touches the player's persisted state.
    pub fn start_scene_preview(
        &mut self,
        content: &ContentCatalog,
        scene_id: &str,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        let entry = content
            .scene(scene_id)
            .map_err(|error| RuntimeError::Content(error.to_string()))?
            .entry
            .clone();
        let previous_revision = self.snapshot.revision;
        self.snapshot = initial_snapshot(content)?;
        self.snapshot
            .variables
            .append(&mut self.initial_save_overrides);
        self.snapshot.revision = self
            .session_revision_override
            .take()
            .unwrap_or(previous_revision);
        self.snapshot.location = StoryLocation {
            scene_id: scene_id.to_owned(),
            node_id: entry,
        };
        self.started = true;
        self.pending_runtime_update = None;
        self.dialogue_history.clear();
        let cues = self.run_until_boundary(content)?;
        Ok(self.finish_update(cues, true))
    }

    /// Resolve editor preview text using the exact variable/profile clone
    /// used by the runtime.  The host uses this for non-active long-text
    /// steps so their measurement never falls back to a second interpolation
    /// implementation in JavaScript.
    pub fn resolve_preview_text(
        &self,
        content: &ContentCatalog,
        source: &str,
    ) -> Result<String, RuntimeError> {
        self.interpolate_text(content, source)
    }

    pub fn advance(
        &mut self,
        content: &ContentCatalog,
        expected_revision: u64,
        source: AdvanceSource,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        self.ensure_interactive(expected_revision)?;
        self.validate_advance_source(source)?;
        let cues = match self.snapshot.prompt.clone() {
            PromptSnapshot::Dialogue { prompt_id, .. } => {
                self.read_dialogues.insert(prompt_id);
                self.snapshot.prompt = PromptSnapshot::None;
                self.run_until_boundary(content)?
            }
            PromptSnapshot::LongText {
                prompt_id,
                step_index,
                ..
            } => self.advance_long_text(content, prompt_id, step_index)?,
            _ => return Err(RuntimeError::AdvanceNotAllowed),
        };
        Ok(self.finish_update(cues, true))
    }

    fn advance_long_text(
        &mut self,
        content: &ContentCatalog,
        prompt_id: String,
        step_index: u32,
    ) -> Result<Vec<PresentationCue>, RuntimeError> {
        let scene_id = self.snapshot.location.scene_id.clone();
        let node_id = self.snapshot.location.node_id.clone();
        let scene = content
            .scene(&scene_id)
            .map_err(|error| RuntimeError::Content(error.to_string()))?;
        let node =
            scene.nodes.get(&node_id).cloned().ok_or_else(|| {
                RuntimeError::Content(format!("节点不存在: {scene_id}/{node_id}"))
            })?;
        let SceneNode::LongText {
            document,
            on_exit,
            steps,
            speed_cps,
            reveal_animation,
            next,
            ..
        } = node
        else {
            return Err(RuntimeError::AdvanceNotAllowed);
        };
        let current_step = steps.get(step_index as usize).ok_or_else(|| {
            RuntimeError::Content(format!("{scene_id}/{node_id}: 当前长文本步骤索引无效"))
        })?;
        let document_id = long_text_document_id(&scene_id, &node_id, document.as_deref());
        if prompt_id != format!("{document_id}/{}", current_step.id) {
            return Err(RuntimeError::Content(format!(
                "{scene_id}/{node_id}: 当前长文本提示与节点步骤不一致"
            )));
        }
        let mut page =
            self.snapshot.long_text_page.clone().ok_or_else(|| {
                RuntimeError::Content(format!("{document_id}: 缺少长文本稳定页面"))
            })?;
        if page.document_id != document_id {
            return Err(RuntimeError::Content(format!(
                "{scene_id}/{node_id}: 当前文稿是 {}，不能推进 {document_id}",
                page.document_id
            )));
        }
        let active_page_index = page
            .steps
            .iter()
            .position(|step| step.step_id == current_step.id)
            .ok_or_else(|| {
                RuntimeError::Content(format!("{scene_id}/{node_id}: 当前步骤不在累计文稿中"))
            })?;
        if page.active_step_index as usize != active_page_index {
            return Err(RuntimeError::Content(format!(
                "{scene_id}/{node_id}: 当前长文本活动段落不一致"
            )));
        }
        self.read_dialogues.insert(prompt_id);
        let next_index = step_index
            .checked_add(1)
            .ok_or_else(|| RuntimeError::Content("长文本步骤索引溢出".to_owned()))?;
        if let Some(step) = steps.get(next_index as usize) {
            let page_index = if let Some(index) = page
                .steps
                .iter()
                .position(|candidate| candidate.step_id == step.id)
            {
                index
            } else {
                let text = self.interpolate_text(content, &step.text)?;
                page.steps.push(LongTextStepSnapshot {
                    step_id: step.id.clone(),
                    text,
                    page_break_before: step.page_break_before,
                });
                page.steps.len() - 1
            };
            validate_long_text_document_size(&page, &scene_id, &node_id)?;
            page.active_step_index = page_index as u32;
            let text = page.steps[page_index].text.clone();
            self.snapshot.long_text_page = Some(page);
            let next_prompt_id = format!("{document_id}/{}", step.id);
            self.append_history(next_prompt_id.clone(), None, None, None, None, text.clone());
            self.snapshot.prompt = PromptSnapshot::LongText {
                prompt_id: next_prompt_id.clone(),
                document_id,
                step_id: step.id.clone(),
                step_index: next_index,
                text,
                is_read: self.read_dialogues.contains(&next_prompt_id),
            };
            return Ok(vec![self.cue(
                CueGate::PlayerAdvance,
                PresentationCueKind::LongTextReveal {
                    prompt_id: next_prompt_id,
                    speed_cps,
                    reveal_animation,
                },
            )]);
        }

        apply_long_text_exit(&mut self.snapshot, on_exit);
        self.snapshot.prompt = PromptSnapshot::None;
        self.snapshot.location.node_id = next;
        self.run_until_boundary(content)
    }

    pub fn choose(
        &mut self,
        content: &ContentCatalog,
        choice_id: &str,
        expected_revision: u64,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        self.ensure_interactive(expected_revision)?;
        let choices = match &self.snapshot.prompt {
            PromptSnapshot::Choice { choices, .. } => choices,
            _ => return Err(RuntimeError::ChoiceNotAllowed),
        };
        if !choices
            .iter()
            .any(|choice| choice.id == choice_id && choice.enabled)
        {
            return Err(RuntimeError::UnknownChoice(choice_id.to_owned()));
        }

        let scene = content
            .scene(&self.snapshot.location.scene_id)
            .map_err(|error| RuntimeError::Content(error.to_string()))?;
        let node = scene
            .nodes
            .get(&self.snapshot.location.node_id)
            .ok_or_else(|| RuntimeError::Content("选择节点已不存在".to_owned()))?;
        let SceneNode::Choice { choices, .. } = node else {
            return Err(RuntimeError::ChoiceNotAllowed);
        };
        let selected = choices
            .iter()
            .find(|choice| choice.id == choice_id)
            .ok_or_else(|| RuntimeError::UnknownChoice(choice_id.to_owned()))?;
        self.snapshot.location.node_id.clone_from(&selected.next);
        self.snapshot.prompt = PromptSnapshot::None;
        let cues = self.run_until_boundary(content)?;
        Ok(self.finish_update(cues, true))
    }

    /// Activate a scene button. The hit test is intentionally performed by
    /// the host UI, while this method remains the authoritative gate for
    /// visibility, enabled state, revision and click effects.
    pub fn click_button(
        &mut self,
        content: &ContentCatalog,
        instance_id: &str,
        expected_revision: u64,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        self.ensure_interactive(expected_revision)?;
        let button = self
            .snapshot
            .world
            .buttons
            .get(instance_id)
            .cloned()
            .ok_or_else(|| RuntimeError::UnknownButton(instance_id.to_owned()))?;
        // A transparent button is still an intentional hit area.  Visibility
        // and enabled are the explicit interaction gates; visual opacity is
        // independent so designers can use invisible click regions.
        if !button.visible || !button.enabled {
            return Err(RuntimeError::UnknownButton(instance_id.to_owned()));
        }
        for set in &button.action.sets {
            let definition = content
                .manifest
                .variables
                .get(&set.variable)
                .ok_or_else(|| RuntimeError::Content(format!("未声明变量 {}", set.variable)))?;
            let current = self.variable_value(content, &set.variable)?.clone();
            let operand = set
                .value
                .as_ref()
                .map(|value| self.resolve_mutation_value(content, value))
                .transpose()?;
            let value = apply_variable_operation(set.op, definition.value_type, current, operand)
                .map_err(RuntimeError::Content)?;
            match definition.scope {
                VariableScope::Save => {
                    self.snapshot.variables.insert(set.variable.clone(), value);
                }
                VariableScope::Profile => {
                    self.profile_variables.insert(set.variable.clone(), value);
                }
            }
        }

        match button.action.next {
            Some(ButtonPostAction::Advance) => {
                self.advance(content, self.snapshot.revision, AdvanceSource::Manual)
            }
            Some(ButtonPostAction::Jump { scene, target }) => {
                let previous_scene = self.snapshot.location.scene_id.clone();
                let destination_scene = scene.unwrap_or(previous_scene.clone());
                let crosses_scene = destination_scene != previous_scene;
                self.snapshot.location.scene_id = destination_scene;
                self.snapshot.location.node_id = target;
                self.snapshot.prompt = PromptSnapshot::None;
                let mut cues = Vec::new();
                if crosses_scene {
                    self.completed_scenes.insert(previous_scene);
                    cues.extend(self.leave_scene(content)?);
                    cues.push(self.cue(
                        CueGate::Runtime,
                        PresentationCueKind::ClearScene {
                            duration_ms: 0,
                            easing: crate::model::Easing::Linear,
                        },
                    ));
                    // Match a regular cross-scene Jump: finish the old
                    // presentation first, then evaluate the destination on
                    // the acknowledgement boundary.
                    return Ok(self.finish_update(cues, true));
                }
                cues.extend(self.run_until_boundary(content)?);
                Ok(self.finish_update(cues, true))
            }
            Some(ButtonPostAction::OpenPanel { panel }) => {
                let cue = self.cue(
                    CueGate::None,
                    PresentationCueKind::ButtonSystemAction { panel },
                );
                Ok(self.finish_update(vec![cue], true))
            }
            None => Ok(self.finish_update(Vec::new(), true)),
        }
    }

    pub fn presentation_complete(
        &mut self,
        content: &ContentCatalog,
        update_id: u64,
        outcome: PresentationOutcome,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        let expected =
            self.pending_runtime_update
                .clone()
                .ok_or(RuntimeError::InvalidAcknowledgement {
                    expected: 0,
                    actual: update_id,
                })?;
        if expected.update_id != update_id {
            return Err(RuntimeError::InvalidAcknowledgement {
                expected: expected.update_id,
                actual: update_id,
            });
        }
        if outcome == PresentationOutcome::Skipped && !expected.skippable {
            return Err(RuntimeError::PresentationNotSkippable);
        }
        if outcome != PresentationOutcome::Failed {
            if let Some(presentation_id) = expected.presentation_id {
                self.seen_presentations.insert(presentation_id);
            }
        }
        self.pending_runtime_update = None;
        let cues = self.run_until_boundary(content)?;
        Ok(self.finish_update(cues, true))
    }

    pub fn snapshot(&self) -> &RuntimeSnapshot {
        &self.snapshot
    }

    #[cfg(test)]
    pub fn profile_variables(&self) -> &VariableMap {
        &self.profile_variables
    }

    pub fn profile_state(&self, content: &ContentCatalog) -> ProfileState {
        ProfileState {
            variables: self.profile_variables.clone(),
            read_content_version: content.manifest.content_version.clone(),
            read_dialogues: self.read_dialogues.clone(),
            seen_presentations: self.seen_presentations.clone(),
            completed_scenes: self.completed_scenes.clone(),
            dialogue_history: self.dialogue_history.clone(),
        }
    }

    pub fn dialogue_history(&self) -> &[DialogueHistoryEntry] {
        &self.dialogue_history
    }

    /// Clear the current Scene's dialogue history for an explicit user action.
    pub fn clear_dialogue_history(&mut self) {
        self.dialogue_history.clear();
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
        hydrate_legacy_dialogue_page(&mut snapshot);
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
        self.snapshot = snapshot;
        self.started = true;
        self.pending_runtime_update = None;
        self.dialogue_history.clear();
        Ok(self.update_without_cues())
    }

    fn ensure_interactive(&self, expected_revision: u64) -> Result<(), RuntimeError> {
        if !self.started {
            return Err(RuntimeError::NotStarted);
        }
        if let Some(pending) = &self.pending_runtime_update {
            return Err(RuntimeError::PresentationPending(pending.update_id));
        }
        if self.snapshot.revision != expected_revision {
            return Err(RuntimeError::StaleRevision {
                expected: expected_revision,
                actual: self.snapshot.revision,
            });
        }
        Ok(())
    }

    fn validate_advance_source(&self, source: AdvanceSource) -> Result<(), RuntimeError> {
        let allowed = match self.snapshot.playback.auto {
            PlaybackAutoMode::Forced => source == AdvanceSource::ForcedAuto,
            PlaybackAutoMode::Normal => match source {
                AdvanceSource::Manual | AdvanceSource::Auto => true,
                AdvanceSource::FastForward => {
                    self.snapshot.playback.ctrl_fast_forward == CtrlFastForwardMode::Allow
                }
                AdvanceSource::ForcedAuto => false,
            },
        };
        allowed.then_some(()).ok_or(RuntimeError::AdvanceNotAllowed)
    }

    fn run_until_boundary(
        &mut self,
        content: &ContentCatalog,
    ) -> Result<Vec<PresentationCue>, RuntimeError> {
        let mut cues = Vec::new();
        for _ in 0..MAX_IMMEDIATE_NODES {
            let scene_id = self.snapshot.location.scene_id.clone();
            let node_id = self.snapshot.location.node_id.clone();
            if self.preview_skip_target_once {
                self.preview_skip_target_once = false;
            } else if self
                .preview_target
                .as_ref()
                .is_some_and(|target| target.scene_id == scene_id && target.node_id == node_id)
            {
                return Ok(cues);
            }
            let scene = content
                .scene(&scene_id)
                .map_err(|error| RuntimeError::Content(error.to_string()))?;
            let node = scene.nodes.get(&node_id).cloned().ok_or_else(|| {
                RuntimeError::Content(format!("节点不存在: {scene_id}/{node_id}"))
            })?;

            match node {
                SceneNode::Background {
                    background,
                    transition,
                    duration_ms,
                    easing,
                    await_completion,
                    next,
                } => {
                    self.snapshot.world.background.clone_from(&background);
                    self.snapshot.location.node_id = next;
                    cues.push(self.cue(
                        gate(await_completion),
                        PresentationCueKind::BackgroundTransition {
                            background,
                            transition,
                            duration_ms,
                            easing,
                        },
                    ));
                    if await_completion {
                        return Ok(cues);
                    }
                }
                SceneNode::Sprite {
                    sprite_id,
                    action,
                    asset,
                    character,
                    expression,
                    flip_x,
                    crossfade_ms,
                    x,
                    y,
                    scale,
                    opacity,
                    z,
                    duration_ms,
                    easing,
                    await_completion,
                    next,
                } => {
                    let from = self.snapshot.world.sprites.get(&sprite_id).cloned();
                    let to = match action {
                        SpriteAction::Show => {
                            let (
                                resolved_asset,
                                offset_x,
                                offset_y,
                                expression_scale,
                                anchor_x,
                                anchor_y,
                            ) = resolve_character_asset(
                                content,
                                character.as_deref(),
                                expression.as_deref(),
                                asset,
                                &scene_id,
                                &node_id,
                            )?;
                            Some(SpriteSnapshot {
                                asset: resolved_asset.ok_or_else(|| {
                                    RuntimeError::Content(format!(
                                        "{scene_id}/{node_id}: show 缺少 asset 或有效表情"
                                    ))
                                })?,
                                x: x.unwrap_or(960.0) + offset_x,
                                y: y.unwrap_or(1080.0) + offset_y,
                                scale: scale.unwrap_or(1.0) * expression_scale,
                                scale_x: 1.0,
                                scale_y: 1.0,
                                rotation_deg: 0.0,
                                flip_x: flip_x.unwrap_or(false),
                                anchor_x,
                                anchor_y,
                                opacity: opacity.unwrap_or(1.0),
                                z: z.unwrap_or(0),
                            })
                        }
                        SpriteAction::Move => {
                            let mut target = from.clone().ok_or_else(|| {
                                RuntimeError::Content(format!(
                                    "{scene_id}/{node_id}: 无法移动不存在的立绘 {sprite_id}"
                                ))
                            })?;
                            let (
                                resolved_asset,
                                offset_x,
                                offset_y,
                                expression_scale,
                                anchor_x,
                                anchor_y,
                            ) = resolve_character_asset(
                                content,
                                character.as_deref(),
                                expression.as_deref(),
                                asset,
                                &scene_id,
                                &node_id,
                            )?;
                            if let Some(value) = resolved_asset {
                                target.asset = value;
                            }
                            if let Some(value) = x {
                                target.x = value + offset_x;
                            }
                            if let Some(value) = y {
                                target.y = value + offset_y;
                            }
                            if let Some(value) = scale {
                                target.scale = value * expression_scale;
                            }
                            if character.is_some() || expression.is_some() {
                                target.anchor_x = anchor_x;
                                target.anchor_y = anchor_y;
                            }
                            if let Some(value) = opacity {
                                target.opacity = value;
                            }
                            if let Some(value) = z {
                                target.z = value;
                            }
                            if let Some(value) = flip_x {
                                target.flip_x = value;
                            }
                            Some(target)
                        }
                        SpriteAction::Hide => None,
                    };
                    if let Some(target) = &to {
                        self.snapshot
                            .world
                            .sprites
                            .insert(sprite_id.clone(), target.clone());
                    } else {
                        self.snapshot.world.sprites.remove(&sprite_id);
                    }
                    let crossfade_ms = crossfade_ms.or_else(|| {
                        if !(character.is_some() || expression.is_some()) {
                            return None;
                        }
                        match (from.as_ref(), to.as_ref()) {
                            (Some(previous), Some(next)) if previous.asset != next.asset => {
                                Some(150)
                            }
                            _ => None,
                        }
                    });
                    self.snapshot.location.node_id = next;
                    cues.push(self.cue(
                        gate(await_completion),
                        PresentationCueKind::SpriteTween {
                            sprite_id,
                            from,
                            to,
                            duration_ms,
                            easing,
                            crossfade_ms,
                        },
                    ));
                    if await_completion {
                        return Ok(cues);
                    }
                }
                SceneNode::Clear {
                    duration_ms,
                    easing,
                    await_completion,
                    next,
                } => {
                    self.clear_scene_visual_state();
                    self.snapshot.location.node_id = next;
                    cues.push(self.cue(
                        gate(await_completion),
                        PresentationCueKind::ClearScene {
                            duration_ms,
                            easing,
                        },
                    ));
                    if await_completion {
                        return Ok(cues);
                    }
                }
                SceneNode::Say {
                    speaker,
                    text,
                    mode,
                    page_id,
                    speed_cps,
                    reveal_animation,
                    next,
                } => {
                    let prompt_id = format!("{scene_id}/{node_id}");
                    let text = self.interpolate_text(content, &text)?;
                    let (speaker_id, speaker, name_color, text_color) = match speaker {
                        None => (None, None, None, None),
                        Some(source) => match content.manifest.characters.get(&source) {
                            Some(character) => (
                                Some(source),
                                Some(character.display_name.clone()),
                                character.name_color.clone(),
                                character.text_color.clone(),
                            ),
                            None => (None, Some(source), None, None),
                        },
                    };
                    let page = match mode {
                        DialogueMode::Start => DialoguePageSnapshot {
                            page_id: page_id.unwrap_or_else(|| prompt_id.clone()),
                            speaker_id: speaker_id.clone(),
                            speaker: speaker.clone(),
                            name_color: name_color.clone(),
                            text_color: text_color.clone(),
                            segments: vec![text.clone()],
                        },
                        DialogueMode::Append => {
                            let expected_page_id = page_id.ok_or_else(|| {
                                RuntimeError::Content(format!(
                                    "{scene_id}/{node_id}: append 对话缺少 page_id"
                                ))
                            })?;
                            let mut page =
                                self.snapshot.dialogue_page.clone().ok_or_else(|| {
                                    RuntimeError::Content(format!(
                                    "{scene_id}/{node_id}: 没有可接续的对话页 {expected_page_id}"
                                ))
                                })?;
                            if page.page_id != expected_page_id {
                                return Err(RuntimeError::Content(format!(
                                    "{scene_id}/{node_id}: 当前对话页是 {}，不能接续 {expected_page_id}",
                                    page.page_id
                                )));
                            }
                            if page.speaker_id != speaker_id
                                || page.speaker != speaker
                                || page.name_color != name_color
                                || page.text_color != text_color
                            {
                                return Err(RuntimeError::Content(format!(
                                    "{scene_id}/{node_id}: 接续对话的说话人与样式必须和页面起始段一致"
                                )));
                            }
                            page.segments.push(text.clone());
                            page
                        }
                    };
                    self.snapshot.dialogue_page = Some(page);
                    self.snapshot.location.node_id = next;
                    self.append_history(
                        prompt_id.clone(),
                        speaker_id.clone(),
                        speaker.clone(),
                        name_color.clone(),
                        text_color.clone(),
                        text.clone(),
                    );
                    self.snapshot.prompt = PromptSnapshot::Dialogue {
                        prompt_id: prompt_id.clone(),
                        speaker_id,
                        speaker,
                        name_color,
                        text_color,
                        text,
                        is_read: self.read_dialogues.contains(&prompt_id),
                    };
                    cues.push(self.cue(
                        CueGate::PlayerAdvance,
                        PresentationCueKind::DialogueReveal {
                            prompt_id,
                            speed_cps,
                            reveal_animation,
                        },
                    ));
                    return Ok(cues);
                }
                SceneNode::LongText {
                    document,
                    mode,
                    on_exit: _,
                    paper,
                    pagination,
                    font_size,
                    text_color,
                    layout,
                    steps,
                    speed_cps,
                    reveal_animation,
                    ..
                } => {
                    let step = steps.first().ok_or_else(|| {
                        RuntimeError::Content(format!(
                            "{scene_id}/{node_id}: 长文本没有可显示的步骤"
                        ))
                    })?;
                    let document_id =
                        long_text_document_id(&scene_id, &node_id, document.as_deref());
                    let mut page = match mode {
                        LongTextMode::Start => {
                            if step.page_break_before {
                                return Err(RuntimeError::Content(format!(
                                    "{scene_id}/{node_id}: 长文本第一步骤不能在前方强制分页"
                                )));
                            }
                            let text = self.interpolate_text(content, &step.text)?;
                            let mut page = LongTextPageSnapshot {
                                document_id: document_id.clone(),
                                visible: true,
                                paper,
                                pagination: pagination.unwrap_or_default(),
                                font_size: font_size
                                    .unwrap_or(crate::model::LONG_TEXT_FONT_SIZE_DEFAULT),
                                text_color: text_color.unwrap_or_else(|| {
                                    crate::model::LONG_TEXT_COLOR_DEFAULT.to_owned()
                                }),
                                layout: layout.unwrap_or_default(),
                                steps: Vec::new(),
                                active_step_index: 0,
                            };
                            page.steps.push(LongTextStepSnapshot {
                                step_id: step.id.clone(),
                                text,
                                page_break_before: step.page_break_before,
                            });
                            page
                        }
                        LongTextMode::Continue => {
                            if paper.is_some()
                                || pagination.is_some()
                                || font_size.is_some()
                                || text_color.is_some()
                                || layout.is_some()
                            {
                                return Err(RuntimeError::Content(format!(
                                    "{scene_id}/{node_id}: continue 长文本不能重复定义纸张、分页、字号、颜色或布局"
                                )));
                            }
                            let mut page =
                                self.snapshot.long_text_page.clone().ok_or_else(|| {
                                    RuntimeError::Content(format!(
                                        "{scene_id}/{node_id}: 没有可接续的长文本 {document_id}"
                                    ))
                                })?;
                            if page.document_id != document_id {
                                return Err(RuntimeError::Content(format!(
                                    "{scene_id}/{node_id}: 当前文稿是 {}，不能接续 {document_id}",
                                    page.document_id
                                )));
                            }
                            page.visible = true;
                            page
                        }
                    };
                    let page_index = if let Some(index) = page
                        .steps
                        .iter()
                        .position(|candidate| candidate.step_id == step.id)
                    {
                        index
                    } else {
                        let text = self.interpolate_text(content, &step.text)?;
                        page.steps.push(LongTextStepSnapshot {
                            step_id: step.id.clone(),
                            text,
                            page_break_before: step.page_break_before,
                        });
                        page.steps.len() - 1
                    };
                    validate_long_text_document_size(&page, &scene_id, &node_id)?;
                    page.active_step_index = page_index as u32;
                    let text = page.steps[page_index].text.clone();
                    self.snapshot.dialogue_page = None;
                    self.snapshot.long_text_page = Some(page);
                    let prompt_id = format!("{document_id}/{}", step.id);
                    self.append_history(prompt_id.clone(), None, None, None, None, text.clone());
                    self.snapshot.prompt = PromptSnapshot::LongText {
                        prompt_id: prompt_id.clone(),
                        document_id,
                        step_id: step.id.clone(),
                        step_index: 0,
                        text,
                        is_read: self.read_dialogues.contains(&prompt_id),
                    };
                    cues.push(self.cue(
                        CueGate::PlayerAdvance,
                        PresentationCueKind::LongTextReveal {
                            prompt_id,
                            speed_cps,
                            reveal_animation,
                        },
                    ));
                    return Ok(cues);
                }
                SceneNode::LongTextControl {
                    document,
                    action,
                    next,
                } => {
                    let current = self.snapshot.long_text_page.as_mut().ok_or_else(|| {
                        RuntimeError::Content(format!(
                            "{scene_id}/{node_id}: 没有可控制的长文本 {document}"
                        ))
                    })?;
                    let expected = long_text_document_id(&scene_id, &node_id, Some(&document));
                    if current.document_id != expected {
                        return Err(RuntimeError::Content(format!(
                            "{scene_id}/{node_id}: 当前文稿是 {}，不能控制 {expected}",
                            current.document_id
                        )));
                    }
                    match action {
                        LongTextControlAction::Show => current.visible = true,
                        LongTextControlAction::Hide => current.visible = false,
                        LongTextControlAction::Close => self.snapshot.long_text_page = None,
                    }
                    self.snapshot.location.node_id = next;
                }
                SceneNode::Choice {
                    presentation,
                    choices,
                } => {
                    let prompt_id = format!("{scene_id}/{node_id}");
                    // Filtering and interpolation always run before layout, so
                    // hidden options neither consume a flow slot nor leak
                    // variables into the resolved layout.
                    let mut drafts = Vec::new();
                    for choice in choices {
                        let visible = match &choice.visible_if {
                            Some(condition) => self.evaluate_condition(content, condition)?,
                            None => true,
                        };
                        if !visible {
                            continue;
                        }
                        let enabled = match &choice.enabled_if {
                            Some(condition) => self.evaluate_condition(content, condition)?,
                            None => true,
                        };
                        drafts.push(ChoiceItemDraft {
                            id: choice.id.clone(),
                            label: self.interpolate_text(content, &choice.label)?,
                            enabled,
                            template: choice.template.clone(),
                            icon: choice.icon.clone(),
                        });
                    }
                    if !drafts.iter().any(|choice| choice.enabled) {
                        return Err(RuntimeError::Content(format!(
                            "{scene_id}/{node_id}: 没有任何可见且可用的选项"
                        )));
                    }
                    let (choices, layout, diagnostics) = resolve_choice_items(
                        content,
                        &scene_id,
                        &node_id,
                        presentation.as_ref(),
                        &drafts,
                    );
                    self.snapshot.dialogue_page = None;
                    self.snapshot.prompt = PromptSnapshot::Choice {
                        prompt_id,
                        layout,
                        diagnostics,
                        choices,
                    };
                    return Ok(cues);
                }
                SceneNode::Set {
                    variable,
                    op,
                    value,
                    next,
                } => {
                    let definition =
                        content.manifest.variables.get(&variable).ok_or_else(|| {
                            RuntimeError::Content(format!(
                                "{scene_id}/{node_id}: 未声明变量 {variable}"
                            ))
                        })?;
                    let current = self.variable_value(content, &variable)?.clone();
                    let operand = value
                        .as_ref()
                        .map(|value| self.resolve_mutation_value(content, value))
                        .transpose()?;
                    let value =
                        apply_variable_operation(op, definition.value_type, current, operand)
                            .map_err(|message| {
                                RuntimeError::Content(format!("{scene_id}/{node_id}: {message}"))
                            })?;
                    match definition.scope {
                        VariableScope::Save => {
                            self.snapshot.variables.insert(variable, value);
                        }
                        VariableScope::Profile => {
                            self.profile_variables.insert(variable, value);
                        }
                    }
                    self.snapshot.location.node_id = next;
                }
                SceneNode::Condition {
                    condition,
                    then,
                    otherwise,
                } => {
                    self.snapshot.location.node_id =
                        if self.evaluate_condition(content, &condition)? {
                            then
                        } else {
                            otherwise
                        };
                }
                SceneNode::Playback {
                    auto,
                    ctrl_fast_forward,
                    next,
                } => {
                    self.snapshot.playback = PlaybackSnapshot {
                        auto,
                        ctrl_fast_forward,
                    };
                    self.snapshot.location.node_id = next;
                }
                SceneNode::Action {
                    sprite_id,
                    action,
                    duration_ms,
                    await_completion,
                    parameters,
                    end,
                    next,
                } => {
                    let base = self
                        .snapshot
                        .world
                        .sprites
                        .get(&sprite_id)
                        .cloned()
                        .ok_or_else(|| {
                            RuntimeError::Content(format!(
                                "{scene_id}/{node_id}: 动作引用了不存在的立绘实例 {sprite_id}"
                            ))
                        })?;
                    let definition = content.actions.get(&action).ok_or_else(|| {
                        RuntimeError::Content(format!(
                            "{scene_id}/{node_id}: 未知立绘动作 {action}"
                        ))
                    })?;
                    let duration = duration_ms.unwrap_or(definition.duration_ms);
                    let tracks = expand_sprite_action(
                        &sprite_id,
                        definition,
                        &base,
                        duration,
                        end.unwrap_or(definition.end),
                        &parameters,
                    )
                    .map_err(|message| {
                        RuntimeError::Content(format!("{scene_id}/{node_id}: {message}"))
                    })?;
                    apply_timeline_final_state(&mut self.snapshot, &tracks).map_err(|message| {
                        RuntimeError::Content(format!("{scene_id}/{node_id}: {message}"))
                    })?;
                    self.snapshot.location.node_id = next;
                    cues.push(self.cue(
                        gate(await_completion),
                        PresentationCueKind::Timeline {
                            presentation_id: format!("action/{scene_id}/{node_id}/{action}"),
                            duration_ms: duration,
                            skippable: false,
                            is_seen: false,
                            button_bases: Default::default(),
                            tracks,
                            events: Vec::new(),
                        },
                    ));
                    if await_completion {
                        return Ok(cues);
                    }
                }
                SceneNode::Jump { scene, target } => {
                    let crosses_scene = scene
                        .as_ref()
                        .is_some_and(|destination| destination != &scene_id);
                    if let Some(destination) = scene {
                        self.snapshot.location.scene_id = destination;
                    }
                    self.snapshot.location.node_id = target;
                    // A scene is a visual ownership boundary. Establish an
                    // explicit presentation boundary before evaluating the
                    // destination so stale views cannot blend into its first
                    // background or sprite cue.
                    if crosses_scene {
                        self.completed_scenes.insert(scene_id.clone());
                        cues.extend(self.leave_scene(content)?);
                        cues.push(self.cue(
                            CueGate::Runtime,
                            PresentationCueKind::ClearScene {
                                duration_ms: 0,
                                easing: crate::model::Easing::Linear,
                            },
                        ));
                        return Ok(cues);
                    }
                }
                SceneNode::Wait { duration_ms, next } => {
                    self.snapshot.location.node_id = next;
                    cues.push(
                        self.cue(CueGate::Runtime, PresentationCueKind::Delay { duration_ms }),
                    );
                    return Ok(cues);
                }
                SceneNode::Bgm {
                    action,
                    asset,
                    volume,
                    start_ms,
                    loop_start_ms,
                    loop_end_ms,
                    duration_ms,
                    await_completion,
                    next,
                } => {
                    let from = self.snapshot.audio.bgm.clone();
                    let to = match action {
                        AudioAction::Start => Some(LoopingAudioSnapshot {
                            asset: asset.ok_or_else(|| {
                                RuntimeError::Content(format!(
                                    "{scene_id}/{node_id}: BGM start 缺少 asset"
                                ))
                            })?,
                            volume,
                            start_ms,
                            loop_start_ms,
                            loop_end_ms,
                        }),
                        AudioAction::Stop => None,
                    };
                    self.snapshot.audio.bgm.clone_from(&to);
                    self.snapshot.location.node_id = next;
                    cues.push(self.cue(
                        gate(await_completion),
                        PresentationCueKind::BgmTransition {
                            from,
                            to,
                            duration_ms,
                        },
                    ));
                    if await_completion {
                        return Ok(cues);
                    }
                }
                SceneNode::Ambience {
                    slot,
                    action,
                    asset,
                    volume,
                    start_ms,
                    loop_start_ms,
                    loop_end_ms,
                    duration_ms,
                    await_completion,
                    next,
                } => {
                    let from = self.snapshot.audio.ambience.get(slot).cloned();
                    let to = match action {
                        AudioAction::Start => Some(LoopingAudioSnapshot {
                            asset: asset.ok_or_else(|| {
                                RuntimeError::Content(format!(
                                    "{scene_id}/{node_id}: ambience start 缺少 asset"
                                ))
                            })?,
                            volume,
                            start_ms,
                            loop_start_ms,
                            loop_end_ms,
                        }),
                        AudioAction::Stop => None,
                    };
                    self.snapshot.audio.ambience.set(slot, to.clone());
                    self.snapshot.location.node_id = next;
                    cues.push(self.cue(
                        gate(await_completion),
                        PresentationCueKind::AmbienceTransition {
                            slot,
                            from,
                            to,
                            duration_ms,
                        },
                    ));
                    if await_completion {
                        return Ok(cues);
                    }
                }
                SceneNode::Sfx {
                    asset,
                    volume,
                    next,
                } => {
                    self.snapshot.location.node_id = next;
                    cues.push(self.cue(
                        CueGate::None,
                        PresentationCueKind::PlaySfx { asset, volume },
                    ));
                }
                SceneNode::Camera {
                    x,
                    y,
                    zoom,
                    duration_ms,
                    easing,
                    await_completion,
                    next,
                } => {
                    let from = self.snapshot.world.camera.clone();
                    let to = CameraSnapshot {
                        x,
                        y,
                        zoom,
                        rotation_deg: from.rotation_deg,
                    };
                    self.snapshot.world.camera.clone_from(&to);
                    self.snapshot.location.node_id = next;
                    cues.push(self.cue(
                        gate(await_completion),
                        PresentationCueKind::CameraTween {
                            from,
                            to,
                            duration_ms,
                            easing,
                        },
                    ));
                    if await_completion {
                        return Ok(cues);
                    }
                }
                SceneNode::ScreenEffect {
                    effect,
                    duration_ms,
                    await_completion,
                    next,
                } => {
                    self.snapshot.location.node_id = next;
                    cues.push(self.cue(
                        gate(await_completion),
                        PresentationCueKind::ScreenEffect {
                            effect,
                            duration_ms,
                        },
                    ));
                    if await_completion {
                        return Ok(cues);
                    }
                }
                SceneNode::Curtain {
                    action,
                    fill,
                    transition,
                    duration_ms,
                    easing,
                    await_completion,
                    next,
                } => {
                    self.snapshot.location.node_id = next;
                    let applied_fill = match action {
                        CurtainAction::Cover => {
                            let fill = fill.clone().ok_or_else(|| {
                                RuntimeError::Content(format!(
                                    "{scene_id}/{node_id}: curtain cover 缺少 fill"
                                ))
                            })?;
                            self.snapshot.world.curtain = CurtainSnapshot {
                                covered: true,
                                fill: Some(fill.clone()),
                            };
                            Some(fill)
                        }
                        CurtainAction::Reveal => {
                            // Re-revealing an already revealed curtain is a safe
                            // no-op: it must never emit a cue the host would wait
                            // on, which is what would deadlock an `await` node.
                            if !self.snapshot.world.curtain.covered {
                                continue;
                            }
                            let previous = self.snapshot.world.curtain.fill.clone();
                            self.snapshot.world.curtain = CurtainSnapshot::default();
                            previous
                        }
                    };
                    cues.push(self.cue(
                        gate(await_completion),
                        PresentationCueKind::CurtainTransition {
                            action,
                            fill: applied_fill,
                            transition,
                            duration_ms,
                            easing,
                        },
                    ));
                    if await_completion {
                        return Ok(cues);
                    }
                }
                SceneNode::DialogueUi {
                    visible,
                    motion,
                    duration_ms,
                    await_completion,
                    next,
                } => {
                    self.snapshot.world.dialogue_ui_visible = visible;
                    self.snapshot.location.node_id = next;
                    let preset = resolve_dialogue_motion(
                        content,
                        &self.snapshot,
                        visible,
                        motion.as_deref(),
                    )?;
                    if let Some(preset) = preset {
                        let cue_duration = duration_ms.unwrap_or(preset.duration_ms);
                        cues.push(self.cue(
                            gate(await_completion),
                            PresentationCueKind::DialogueUiTransition {
                                visible,
                                duration_ms: cue_duration,
                                motion: Some(preset),
                            },
                        ));
                        if await_completion {
                            return Ok(cues);
                        }
                    }
                }
                SceneNode::UiMotionSet { slot, motion, next } => {
                    match slot {
                        UiMotionSlot::DialogueShow => {
                            self.snapshot.world.ui_motion_bindings.dialogue_show = motion;
                        }
                        UiMotionSlot::DialogueHide => {
                            self.snapshot.world.ui_motion_bindings.dialogue_hide = motion;
                        }
                    }
                    self.snapshot.location.node_id = next;
                }
                SceneNode::UiMotionPlay {
                    motion,
                    duration_ms,
                    await_completion,
                    next,
                } => {
                    let preset =
                        content.ui_motions.get(&motion).cloned().ok_or_else(|| {
                            RuntimeError::Content(format!("未知 UI 动效 {motion}"))
                        })?;
                    let cue_duration = duration_ms.unwrap_or(preset.duration_ms);
                    self.snapshot.location.node_id = next;
                    cues.push(self.cue(
                        gate(await_completion),
                        PresentationCueKind::UiMotion {
                            duration_ms: cue_duration,
                            motion: preset,
                        },
                    ));
                    if await_completion {
                        return Ok(cues);
                    }
                }
                SceneNode::ButtonCreate {
                    instance_id,
                    template,
                    x,
                    y,
                    width,
                    height,
                    rotation_deg,
                    scale_x,
                    scale_y,
                    opacity,
                    z,
                    visible,
                    enabled,
                    action,
                    next,
                } => {
                    let definition = content
                        .buttons
                        .get(&template)
                        .ok_or_else(|| RuntimeError::Content(format!("未知按钮模板 {template}")))?;
                    if self.snapshot.world.buttons.contains_key(&instance_id) {
                        return Err(RuntimeError::Content(format!(
                            "按钮实例 ID 重复: {instance_id}"
                        )));
                    }
                    self.snapshot.world.buttons.insert(
                        instance_id.clone(),
                        make_button_snapshot(
                            instance_id,
                            &template,
                            definition,
                            x,
                            y,
                            width,
                            height,
                            rotation_deg,
                            scale_x,
                            scale_y,
                            opacity,
                            z,
                            visible,
                            enabled,
                            action,
                        ),
                    );
                    self.snapshot.location.node_id = next;
                }
                SceneNode::ButtonUpdate {
                    instance_id,
                    template,
                    x,
                    y,
                    width,
                    height,
                    rotation_deg,
                    scale_x,
                    scale_y,
                    opacity,
                    z,
                    visible,
                    enabled,
                    action,
                    next,
                } => {
                    let current = self
                        .snapshot
                        .world
                        .buttons
                        .get_mut(&instance_id)
                        .ok_or_else(|| {
                            RuntimeError::Content(format!(
                                "按钮实例不存在，无法更新: {instance_id}"
                            ))
                        })?;
                    if let Some(template) = template {
                        let definition = content.buttons.get(&template).ok_or_else(|| {
                            RuntimeError::Content(format!("未知按钮模板 {template}"))
                        })?;
                        current.template = template;
                        current.asset_mode = definition.asset_mode;
                        current.fit = definition.fit;
                        current.normal = definition.normal.clone();
                        current.hover = definition.hover.clone();
                        current.pressed = definition.pressed.clone();
                        current.animations = definition.animations.clone();
                    }
                    if let Some(value) = x {
                        current.x = value;
                    }
                    if let Some(value) = y {
                        current.y = value;
                    }
                    if let Some(value) = width {
                        current.width = value;
                    }
                    if let Some(value) = height {
                        current.height = value;
                    }
                    if let Some(value) = rotation_deg {
                        current.rotation_deg = value;
                    }
                    if let Some(value) = scale_x {
                        current.scale_x = value;
                    }
                    if let Some(value) = scale_y {
                        current.scale_y = value;
                    }
                    if let Some(value) = opacity {
                        current.opacity = value;
                    }
                    if let Some(value) = z {
                        current.z = value;
                    }
                    if let Some(value) = visible {
                        current.visible = value;
                    }
                    if let Some(value) = enabled {
                        current.enabled = value;
                    }
                    if let Some(value) = action {
                        current.action = value;
                    }
                    self.snapshot.location.node_id = next;
                }
                SceneNode::ButtonRemove { instance_id, next } => {
                    self.snapshot
                        .world
                        .buttons
                        .remove(&instance_id)
                        .ok_or_else(|| {
                            RuntimeError::Content(format!(
                                "按钮实例不存在，无法移除: {instance_id}"
                            ))
                        })?;
                    self.snapshot.location.node_id = next;
                }
                SceneNode::Timeline {
                    duration_ms,
                    await_completion,
                    skippable,
                    tracks,
                    events,
                    next,
                } => {
                    let button_bases = self
                        .snapshot
                        .world
                        .buttons
                        .iter()
                        .filter(|(id, _)| {
                            tracks.iter().any(|track| {
                                matches!(
                                    track,
                                    TimelineTrack::Button { instance_id, .. }
                                        if instance_id == *id
                                )
                            })
                        })
                        .map(|(id, button)| {
                            (
                                id.clone(),
                                crate::model::ButtonTimelineBase {
                                    x: button.x,
                                    y: button.y,
                                    width: button.width,
                                    height: button.height,
                                    rotation_deg: button.rotation_deg,
                                    scale_x: button.scale_x,
                                    scale_y: button.scale_y,
                                    opacity: button.opacity,
                                    z: button.z,
                                },
                            )
                        })
                        .collect();
                    apply_timeline_final_state(&mut self.snapshot, &tracks).map_err(|message| {
                        RuntimeError::Content(format!("{scene_id}/{node_id}: {message}"))
                    })?;
                    self.snapshot.location.node_id = next;
                    let presentation_id = format!("{scene_id}/{node_id}");
                    let is_seen = self.seen_presentations.contains(&presentation_id);
                    cues.push(self.cue(
                        gate(await_completion),
                        PresentationCueKind::Timeline {
                            presentation_id,
                            duration_ms,
                            skippable,
                            is_seen,
                            button_bases,
                            tracks,
                            events,
                        },
                    ));
                    if await_completion {
                        return Ok(cues);
                    }
                }
                SceneNode::End => {
                    self.completed_scenes.insert(scene_id.clone());
                    self.snapshot.dialogue_page = None;
                    self.snapshot.long_text_page = None;
                    self.snapshot.prompt = PromptSnapshot::End {
                        prompt_id: format!("{scene_id}/{node_id}"),
                    };
                    return Ok(cues);
                }
            }
        }
        Err(RuntimeError::ImmediateLoop)
    }

    fn evaluate_condition(
        &self,
        content: &ContentCatalog,
        condition: &ConditionExpression,
    ) -> Result<bool, RuntimeError> {
        match condition {
            ConditionExpression::Eq { left, right } => compare_values(
                self.resolve_operand(content, left)?,
                self.resolve_operand(content, right)?,
            )
            .map(|ordering| ordering == std::cmp::Ordering::Equal),
            ConditionExpression::Ne { left, right } => compare_values(
                self.resolve_operand(content, left)?,
                self.resolve_operand(content, right)?,
            )
            .map(|ordering| ordering != std::cmp::Ordering::Equal),
            ConditionExpression::Lt { left, right } => compare_numeric(
                self.resolve_operand(content, left)?,
                self.resolve_operand(content, right)?,
            )
            .map(|ordering| ordering == std::cmp::Ordering::Less),
            ConditionExpression::Le { left, right } => compare_numeric(
                self.resolve_operand(content, left)?,
                self.resolve_operand(content, right)?,
            )
            .map(|ordering| ordering != std::cmp::Ordering::Greater),
            ConditionExpression::Gt { left, right } => compare_numeric(
                self.resolve_operand(content, left)?,
                self.resolve_operand(content, right)?,
            )
            .map(|ordering| ordering == std::cmp::Ordering::Greater),
            ConditionExpression::Ge { left, right } => compare_numeric(
                self.resolve_operand(content, left)?,
                self.resolve_operand(content, right)?,
            )
            .map(|ordering| ordering != std::cmp::Ordering::Less),
            ConditionExpression::And { conditions } => {
                for child in conditions {
                    if !self.evaluate_condition(content, child)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            ConditionExpression::Or { conditions } => {
                for child in conditions {
                    if self.evaluate_condition(content, child)? {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            ConditionExpression::Not { condition } => {
                Ok(!self.evaluate_condition(content, condition)?)
            }
        }
    }

    fn resolve_operand<'a>(
        &'a self,
        content: &'a ContentCatalog,
        operand: &'a ValueOperand,
    ) -> Result<&'a ScalarValue, RuntimeError> {
        match operand {
            ValueOperand::Literal(literal) => Ok(&literal.value),
            ValueOperand::Variable(reference) => self.variable_value(content, &reference.variable),
        }
    }

    fn resolve_mutation_value(
        &self,
        content: &ContentCatalog,
        value: &MutationValue,
    ) -> Result<ScalarValue, RuntimeError> {
        match value {
            MutationValue::Literal(value) => Ok(value.clone()),
            MutationValue::Variable(reference) => {
                self.variable_value(content, &reference.variable).cloned()
            }
        }
    }

    fn variable_value<'a>(
        &'a self,
        content: &'a ContentCatalog,
        id: &str,
    ) -> Result<&'a ScalarValue, RuntimeError> {
        let definition = content
            .manifest
            .variables
            .get(id)
            .ok_or_else(|| RuntimeError::Content(format!("引用了未声明变量 {id}")))?;
        let variables = match definition.scope {
            VariableScope::Save => &self.snapshot.variables,
            VariableScope::Profile => &self.profile_variables,
        };
        variables
            .get(id)
            .ok_or_else(|| RuntimeError::Content(format!("变量 {id} 尚未初始化")))
    }

    fn interpolate_text(
        &self,
        content: &ContentCatalog,
        source: &str,
    ) -> Result<String, RuntimeError> {
        text_template::interpolate(source, |id| {
            self.variable_value(content, id)
                .cloned()
                .map_err(|error| text_template::TemplateError(error.to_string()))
        })
        .map_err(|error| RuntimeError::Content(error.to_string()))
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
        self.dialogue_history.push(DialogueHistoryEntry {
            entry_id,
            prompt_id,
            speaker_id,
            speaker,
            name_color,
            text_color,
            text,
        });
        if self.dialogue_history.len() > 500 {
            self.dialogue_history
                .drain(..self.dialogue_history.len() - 500);
            for (index, entry) in self.dialogue_history.iter_mut().enumerate() {
                entry.entry_id = index as u64 + 1;
            }
        }
    }

    /// Reset the visual portion of a scene. This is also used by an explicit
    /// `clear` node, which must not reset the rest of the scene's state.
    fn clear_scene_visual_state(&mut self) {
        self.snapshot.world.background = None;
        self.snapshot.world.sprites.clear();
        self.snapshot.world.buttons.clear();
        self.snapshot.world.camera = CameraSnapshot::default();
        self.snapshot.world.persistent_effects.clear();
        self.snapshot.world.curtain = CurtainSnapshot::default();
        self.snapshot.dialogue_page = None;
        self.snapshot.long_text_page = None;
    }

    /// A Scene is a complete runtime ownership boundary. Nothing authored by
    /// the previous Scene is allowed to become an implicit input to the next
    /// one: presentation state, BGM, playback policy, dialogue history, and
    /// save-scoped variables all return to their declared defaults. Profile
    /// variables and read/seen/completion metadata live outside a Scene and
    /// deliberately remain available for global progression.
    fn leave_scene(
        &mut self,
        content: &ContentCatalog,
    ) -> Result<Vec<PresentationCue>, RuntimeError> {
        // The audio snapshot is authoritative, but hosts also need an
        // explicit stop cue for every active ambience slot at a scene
        // boundary.  Keep this separate from `clear`, whose contract is
        // visual-only and must preserve ambience.
        let ambience_to_stop: Vec<_> = self
            .snapshot
            .audio
            .ambience
            .iter()
            .map(|(slot, state)| (slot, state.clone()))
            .collect();
        self.snapshot.variables = defaults_for_scope(content, VariableScope::Save)?;
        self.snapshot.world = WorldSnapshot {
            ui_motion_bindings: content.manifest.ui_motion_defaults.clone(),
            ..WorldSnapshot::default()
        };
        self.snapshot.audio = AudioSnapshot::default();
        self.snapshot.playback = PlaybackSnapshot::default();
        self.snapshot.dialogue_page = None;
        self.snapshot.long_text_page = None;
        self.snapshot.prompt = PromptSnapshot::None;
        self.dialogue_history.clear();
        Ok(ambience_to_stop
            .into_iter()
            .map(|(slot, from)| {
                self.cue(
                    CueGate::Runtime,
                    PresentationCueKind::AmbienceTransition {
                        slot,
                        from: Some(from),
                        to: None,
                        duration_ms: 0,
                    },
                )
            })
            .collect())
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

fn apply_variable_operation(
    operation: VariableOperation,
    target_type: VariableType,
    current: ScalarValue,
    operand: Option<ScalarValue>,
) -> Result<ScalarValue, String> {
    if operation == VariableOperation::Toggle {
        return match (target_type, current, operand) {
            (VariableType::Boolean, ScalarValue::Boolean(value), None) => {
                Ok(ScalarValue::Boolean(!value))
            }
            (_, _, Some(_)) => Err("toggle 不接受 value".to_owned()),
            _ => Err("toggle 只能用于 boolean 变量".to_owned()),
        };
    }

    let operand = operand.ok_or_else(|| format!("{operation:?} 操作缺少 value"))?;
    match operation {
        VariableOperation::Assign => {
            normalize_value(operand, target_type).map_err(|error| error.to_string())
        }
        VariableOperation::Add | VariableOperation::Sub | VariableOperation::Mul => {
            match target_type {
                VariableType::Integer => {
                    let (ScalarValue::Integer(left), ScalarValue::Integer(right)) =
                        (current, operand)
                    else {
                        return Err("integer 运算只接受 integer 操作数".to_owned());
                    };
                    let result = match operation {
                        VariableOperation::Add => left.checked_add(right),
                        VariableOperation::Sub => left.checked_sub(right),
                        VariableOperation::Mul => left.checked_mul(right),
                        _ => unreachable!(),
                    }
                    .ok_or_else(|| "integer 运算溢出".to_owned())?;
                    Ok(ScalarValue::Integer(result))
                }
                VariableType::Number => {
                    let left = scalar_to_f64(&current)?;
                    let right = scalar_to_f64(&operand)?;
                    let result = match operation {
                        VariableOperation::Add => left + right,
                        VariableOperation::Sub => left - right,
                        VariableOperation::Mul => left * right,
                        _ => unreachable!(),
                    };
                    if !result.is_finite() {
                        return Err("number 运算结果必须是有限数".to_owned());
                    }
                    Ok(ScalarValue::Number(result))
                }
                _ => Err("add/sub/mul 只能用于数值变量".to_owned()),
            }
        }
        VariableOperation::Mod => {
            let (ScalarValue::Integer(left), ScalarValue::Integer(right)) = (current, operand)
            else {
                return Err("mod 只能用于 integer 变量和操作数".to_owned());
            };
            let result = left.checked_rem(right).ok_or_else(|| {
                if right == 0 {
                    "mod 除数不能为零".to_owned()
                } else {
                    "integer mod 运算溢出".to_owned()
                }
            })?;
            Ok(ScalarValue::Integer(result))
        }
        VariableOperation::Append => {
            let (ScalarValue::Text(mut left), ScalarValue::Text(right)) = (current, operand) else {
                return Err("append 只能用于 string 变量和操作数".to_owned());
            };
            if left.len().saturating_add(right.len()) > MAX_VARIABLE_STRING_BYTES {
                return Err(format!(
                    "append 结果超过 {} 字节上限",
                    MAX_VARIABLE_STRING_BYTES
                ));
            }
            left.push_str(&right);
            Ok(ScalarValue::Text(left))
        }
        VariableOperation::Toggle => unreachable!(),
    }
}

fn scalar_to_f64(value: &ScalarValue) -> Result<f64, String> {
    match value {
        ScalarValue::Integer(value) => Ok(*value as f64),
        ScalarValue::Number(value) if value.is_finite() => Ok(*value),
        ScalarValue::Number(_) => Err("数值必须有限".to_owned()),
        _ => Err("number 运算只接受数值操作数".to_owned()),
    }
}

fn gate(await_completion: bool) -> CueGate {
    if await_completion {
        CueGate::Runtime
    } else {
        CueGate::None
    }
}

type CharacterAssetResolution = (Option<String>, f32, f32, f32, f32, f32);

fn resolve_character_asset(
    content: &ContentCatalog,
    character_id: Option<&str>,
    expression_id: Option<&str>,
    explicit_asset: Option<String>,
    scene_id: &str,
    node_id: &str,
) -> Result<CharacterAssetResolution, RuntimeError> {
    let Some(character_id) = character_id else {
        if expression_id.is_some() {
            return Err(RuntimeError::Content(format!(
                "{scene_id}/{node_id}: expression 必须与 character 一起使用"
            )));
        }
        return Ok((explicit_asset, 0.0, 0.0, 1.0, 0.5, 1.0));
    };
    let character = content
        .manifest
        .characters
        .get(character_id)
        .ok_or_else(|| RuntimeError::Content(format!("未知角色 {character_id}")))?;
    let selected_expression = expression_id
        .or(character.default_expression.as_deref())
        .map(|id| {
            character
                .expressions
                .get(id)
                .ok_or_else(|| RuntimeError::Content(format!("未知角色表情 {character_id}/{id}")))
        })
        .transpose()?;
    if explicit_asset.is_none() && selected_expression.is_none() {
        return Err(RuntimeError::Content(format!(
            "{scene_id}/{node_id}: 角色 {character_id} 没有可用表情或素材"
        )));
    }
    if let Some(expression) = selected_expression {
        return Ok((
            Some(explicit_asset.unwrap_or_else(|| expression.asset.clone())),
            expression.offset_x,
            expression.offset_y,
            character.default_scale * expression.scale,
            expression.anchor_x,
            expression.anchor_y,
        ));
    }
    Ok((explicit_asset, 0.0, 0.0, character.default_scale, 0.5, 1.0))
}

fn preview_successor(scene_id: &str, node: &SceneNode) -> Option<StoryLocation> {
    let local = |next: &str| StoryLocation {
        scene_id: scene_id.to_owned(),
        node_id: next.to_owned(),
    };
    match node {
        SceneNode::Background { next, .. }
        | SceneNode::Sprite { next, .. }
        | SceneNode::Clear { next, .. }
        | SceneNode::Say { next, .. }
        | SceneNode::LongText { next, .. }
        | SceneNode::LongTextControl { next, .. }
        | SceneNode::Set { next, .. }
        | SceneNode::Playback { next, .. }
        | SceneNode::Action { next, .. }
        | SceneNode::Wait { next, .. }
        | SceneNode::Bgm { next, .. }
        | SceneNode::Ambience { next, .. }
        | SceneNode::Sfx { next, .. }
        | SceneNode::Camera { next, .. }
        | SceneNode::ScreenEffect { next, .. }
        | SceneNode::Curtain { next, .. }
        | SceneNode::DialogueUi { next, .. }
        | SceneNode::UiMotionSet { next, .. }
        | SceneNode::UiMotionPlay { next, .. }
        | SceneNode::ButtonCreate { next, .. }
        | SceneNode::ButtonUpdate { next, .. }
        | SceneNode::ButtonRemove { next, .. }
        | SceneNode::Timeline { next, .. } => Some(local(next)),
        SceneNode::Jump { scene, target } => Some(StoryLocation {
            scene_id: scene.clone().unwrap_or_else(|| scene_id.to_owned()),
            node_id: target.clone(),
        }),
        SceneNode::Choice { .. } | SceneNode::Condition { .. } | SceneNode::End => None,
    }
}

fn long_text_document_id(scene_id: &str, node_id: &str, document: Option<&str>) -> String {
    match document {
        Some(document) => format!("{scene_id}/{document}"),
        None => format!("{scene_id}/{node_id}"),
    }
}

/// Expand a reusable relative action into the absolute Timeline representation
/// understood by both game and editor presentation layers.  Keeping this
/// conversion in Rust means an action always uses the exact same starting pose
/// and parameter validation as the authoritative runtime.
fn expand_sprite_action(
    sprite_id: &str,
    action: &SpriteActionDefinition,
    base: &SpriteSnapshot,
    duration_ms: u64,
    end: SpriteActionEnd,
    overrides: &std::collections::BTreeMap<String, f32>,
) -> Result<Vec<TimelineTrack>, String> {
    if duration_ms == 0 {
        return Err("动作时长必须大于 0".to_owned());
    }
    if overrides
        .keys()
        .any(|parameter| !action.parameters.contains_key(parameter))
    {
        let unknown = overrides
            .keys()
            .find(|parameter| !action.parameters.contains_key(*parameter))
            .expect("checked above");
        return Err(format!("动作参数未声明: {unknown}"));
    }
    for (parameter_id, parameter) in &action.parameters {
        let value = overrides
            .get(parameter_id)
            .copied()
            .unwrap_or(parameter.default);
        if !value.is_finite()
            || parameter.min.is_some_and(|min| value < min)
            || parameter.max.is_some_and(|max| value > max)
        {
            return Err(format!("动作参数 {parameter_id} 超出声明范围"));
        }
    }

    let mut channels = TimelineChannels::new();
    for (channel, keyframes) in &action.channels {
        let mut expanded =
            Vec::with_capacity(keyframes.len() + usize::from(end == SpriteActionEnd::Restore));
        let mut previous_at = None;
        for keyframe in keyframes {
            let at_ms = scale_action_time(keyframe.at_ms, action.duration_ms, duration_ms)?;
            if previous_at.is_some_and(|previous| at_ms <= previous) {
                return Err(format!("动作通道 {channel} 的关键帧在目标时长下发生重叠"));
            }
            let relative = keyframe
                .parameter
                .as_ref()
                .and_then(|parameter| overrides.get(parameter).copied())
                .or_else(|| {
                    keyframe.parameter.as_ref().and_then(|parameter| {
                        action.parameters.get(parameter).map(|value| value.default)
                    })
                })
                .unwrap_or(keyframe.value);
            if !relative.is_finite() {
                return Err(format!("动作通道 {channel} 的值必须是有限数"));
            }
            let absolute = action_channel_value(channel, relative, base)?;
            expanded.push(TimelineKeyframe {
                at_ms,
                value: TimelineKeyframeValue::Number(absolute),
                easing: keyframe.easing.clone(),
            });
            previous_at = Some(at_ms);
        }
        if end == SpriteActionEnd::Restore {
            let restore = action_base_channel_value(channel, base)?;
            let restore_frame = TimelineKeyframe {
                at_ms: duration_ms,
                value: TimelineKeyframeValue::Number(restore),
                easing: TimelineEasing::default(),
            };
            if expanded
                .last()
                .is_some_and(|frame| frame.at_ms == duration_ms)
            {
                *expanded.last_mut().expect("last exists") = restore_frame;
            } else {
                expanded.push(restore_frame);
            }
        }
        channels.insert(channel.clone(), expanded);
    }
    if channels.is_empty() {
        return Err("动作至少需要一个变换通道".to_owned());
    }
    Ok(vec![TimelineTrack::Sprite {
        sprite_id: sprite_id.to_owned(),
        asset: None,
        remove_at_end: false,
        channels,
    }])
}

fn scale_action_time(
    at_ms: u64,
    source_duration: u64,
    target_duration: u64,
) -> Result<u64, String> {
    if source_duration == 0 {
        return Err("动作定义时长必须大于 0".to_owned());
    }
    let scaled = (u128::from(at_ms) * u128::from(target_duration)
        + u128::from(source_duration / 2))
        / u128::from(source_duration);
    u64::try_from(scaled).map_err(|_| "动作关键帧时间溢出".to_owned())
}

fn action_channel_value(
    channel: &str,
    relative: f32,
    base: &SpriteSnapshot,
) -> Result<f32, String> {
    let base_value = action_base_channel_value(channel, base)?;
    let value = match channel {
        "x" | "y" | "rotation_deg" => base_value + relative,
        "scale" | "scale_x" | "scale_y" | "opacity" => base_value * relative,
        _ => return Err(format!("动作不支持通道 {channel}")),
    };
    if !value.is_finite() {
        return Err(format!("动作通道 {channel} 的结果必须是有限数"));
    }
    if matches!(channel, "scale" | "scale_x" | "scale_y") && value <= 0.0 {
        return Err(format!("动作通道 {channel} 的结果必须为正数"));
    }
    if channel == "opacity" && !(0.0..=1.0).contains(&value) {
        return Err("动作 opacity 结果必须在 0 到 1 之间".to_owned());
    }
    Ok(value)
}

fn action_base_channel_value(channel: &str, base: &SpriteSnapshot) -> Result<f32, String> {
    match channel {
        "x" => Ok(base.x),
        "y" => Ok(base.y),
        "scale" => Ok(base.scale),
        "scale_x" => Ok(base.scale_x),
        "scale_y" => Ok(base.scale_y),
        "rotation_deg" => Ok(base.rotation_deg),
        "opacity" => Ok(base.opacity),
        _ => Err(format!("动作不支持通道 {channel}")),
    }
}

fn apply_long_text_exit(snapshot: &mut RuntimeSnapshot, exit: LongTextExit) {
    match exit {
        LongTextExit::Close => snapshot.long_text_page = None,
        LongTextExit::Hide => {
            if let Some(page) = snapshot.long_text_page.as_mut() {
                page.visible = false;
            }
        }
        LongTextExit::KeepVisible => {
            if let Some(page) = snapshot.long_text_page.as_mut() {
                page.visible = true;
            }
        }
    }
}

fn validate_long_text_document_size(
    page: &LongTextPageSnapshot,
    scene_id: &str,
    node_id: &str,
) -> Result<(), RuntimeError> {
    if page.steps.len() > MAX_LONG_TEXT_DOCUMENT_STEPS {
        return Err(RuntimeError::Content(format!(
            "{scene_id}/{node_id}: 累计长文本步骤超过 {MAX_LONG_TEXT_DOCUMENT_STEPS}"
        )));
    }
    let bytes = page
        .steps
        .iter()
        .try_fold(0usize, |total, step| total.checked_add(step.text.len()))
        .ok_or_else(|| RuntimeError::Content("累计长文本大小溢出".to_owned()))?;
    if bytes > MAX_LONG_TEXT_DOCUMENT_BYTES {
        return Err(RuntimeError::Content(format!(
            "{scene_id}/{node_id}: 累计长文本超过 {} MiB",
            MAX_LONG_TEXT_DOCUMENT_BYTES / (1024 * 1024)
        )));
    }
    Ok(())
}

fn final_channel(channels: &TimelineChannels, id: &str) -> Option<f32> {
    channels
        .get(id)
        .and_then(|keyframes| keyframes.last())
        .and_then(|keyframe| keyframe.value.number())
}

fn has_inherited_channel(channels: &TimelineChannels) -> bool {
    channels
        .values()
        .any(|frames| frames.first().is_some_and(|frame| frame.value.is_inherit()))
}

fn apply_timeline_final_state(
    snapshot: &mut RuntimeSnapshot,
    tracks: &[TimelineTrack],
) -> Result<(), String> {
    for track in tracks {
        match track {
            TimelineTrack::Sprite {
                sprite_id,
                asset,
                remove_at_end,
                channels,
            } => {
                if has_inherited_channel(channels)
                    && !snapshot.world.sprites.contains_key(sprite_id)
                {
                    return Err(format!(
                        "立绘 {sprite_id} 使用 inherit，但进入时间线时该实例不存在"
                    ));
                }
                if *remove_at_end {
                    snapshot.world.sprites.remove(sprite_id);
                    continue;
                }
                let mut target = snapshot
                    .world
                    .sprites
                    .get(sprite_id)
                    .cloned()
                    .or_else(|| {
                        asset.as_ref().map(|asset| SpriteSnapshot {
                            asset: asset.clone(),
                            x: 960.0,
                            y: 1080.0,
                            scale: 1.0,
                            scale_x: 1.0,
                            scale_y: 1.0,
                            rotation_deg: 0.0,
                            flip_x: false,
                            anchor_x: 0.5,
                            anchor_y: 1.0,
                            opacity: 1.0,
                            z: 0,
                        })
                    })
                    .ok_or_else(|| {
                        format!("立绘 {sprite_id} 未指定素材，且进入时间线时实例不存在")
                    })?;
                if let Some(asset) = asset {
                    target.asset.clone_from(asset);
                }
                if let Some(value) = final_channel(channels, "x") {
                    target.x = value;
                }
                if let Some(value) = final_channel(channels, "y") {
                    target.y = value;
                }
                if let Some(value) = final_channel(channels, "scale") {
                    target.scale = value;
                }
                if let Some(value) = final_channel(channels, "scale_x") {
                    target.scale_x = value;
                }
                if let Some(value) = final_channel(channels, "scale_y") {
                    target.scale_y = value;
                }
                if let Some(value) = final_channel(channels, "rotation_deg") {
                    target.rotation_deg = value;
                }
                if let Some(value) = final_channel(channels, "opacity") {
                    target.opacity = value;
                }
                if let Some(value) = final_channel(channels, "z") {
                    target.z = value.round() as i32;
                }
                if target.scale <= 0.0 || target.scale_x <= 0.0 || target.scale_y <= 0.0 {
                    return Err(format!("立绘 {sprite_id} 的最终缩放必须大于 0"));
                }
                snapshot.world.sprites.insert(sprite_id.clone(), target);
            }
            TimelineTrack::Camera { channels } => {
                if let Some(value) = final_channel(channels, "x") {
                    snapshot.world.camera.x = value;
                }
                if let Some(value) = final_channel(channels, "y") {
                    snapshot.world.camera.y = value;
                }
                if let Some(value) = final_channel(channels, "zoom") {
                    if value <= 0.0 {
                        return Err("相机最终 zoom 必须大于 0".to_owned());
                    }
                    snapshot.world.camera.zoom = value;
                }
                if let Some(value) = final_channel(channels, "rotation_deg") {
                    snapshot.world.camera.rotation_deg = value;
                }
            }
            TimelineTrack::Button {
                instance_id,
                channels,
            } => {
                if has_inherited_channel(channels)
                    && !snapshot.world.buttons.contains_key(instance_id)
                {
                    return Err(format!(
                        "按钮 {instance_id} 使用 inherit，但进入时间线时该实例不存在"
                    ));
                }
                let button = snapshot
                    .world
                    .buttons
                    .get_mut(instance_id)
                    .ok_or_else(|| format!("按钮 {instance_id} 未创建，无法应用时间线"))?;
                if let Some(value) = final_channel(channels, "x") {
                    button.x = value;
                }
                if let Some(value) = final_channel(channels, "y") {
                    button.y = value;
                }
                if let Some(value) = final_channel(channels, "width") {
                    button.width = value;
                }
                if let Some(value) = final_channel(channels, "height") {
                    button.height = value;
                }
                if let Some(value) = final_channel(channels, "scale_x") {
                    button.scale_x = value;
                }
                if let Some(value) = final_channel(channels, "scale_y") {
                    button.scale_y = value;
                }
                if let Some(value) = final_channel(channels, "rotation_deg") {
                    button.rotation_deg = value;
                }
                if let Some(value) = final_channel(channels, "opacity") {
                    button.opacity = value;
                }
                if let Some(value) = final_channel(channels, "z") {
                    button.z = value.round() as i32;
                }
                if !button.width.is_finite()
                    || !button.height.is_finite()
                    || button.width <= 0.0
                    || button.height <= 0.0
                    || !button.scale_x.is_finite()
                    || !button.scale_y.is_finite()
                    || button.scale_x <= 0.0
                    || button.scale_y <= 0.0
                {
                    return Err(format!("按钮 {instance_id} 的最终尺寸或缩放无效"));
                }
            }
            TimelineTrack::Bgm { channels } => {
                if let Some(value) = final_channel(channels, "volume") {
                    let bgm = snapshot
                        .audio
                        .bgm
                        .as_mut()
                        .ok_or_else(|| "BGM 音量轨要求当前存在 BGM".to_owned())?;
                    bgm.volume = value;
                }
            }
            // Ambience volume automation is presentation-only. The
            // authoritative loop state, including its volume, remains in the
            // snapshot so skip/final evaluation cannot persist a transient
            // timeline value. Like the existing BGM track, an absent slot is
            // simply left unchanged.
            TimelineTrack::Ambience { .. } => {}
            TimelineTrack::Video { .. } => {}
        }
    }
    Ok(())
}

#[allow(dead_code)]
pub(crate) fn profile_defaults(content: &ContentCatalog) -> Result<VariableMap, RuntimeError> {
    defaults_for_scope(content, VariableScope::Profile)
}

fn defaults_for_scope(
    content: &ContentCatalog,
    scope: VariableScope,
) -> Result<VariableMap, RuntimeError> {
    content
        .manifest
        .variables
        .iter()
        .filter(|(_, definition)| definition.scope == scope)
        .map(|(id, definition)| {
            normalize_value(definition.default.clone(), definition.value_type)
                .map(|value| (id.clone(), value))
        })
        .collect()
}

fn normalize_value(
    value: ScalarValue,
    expected: VariableType,
) -> Result<ScalarValue, RuntimeError> {
    match (expected, value) {
        (VariableType::Boolean, value @ ScalarValue::Boolean(_))
        | (VariableType::Integer, value @ ScalarValue::Integer(_)) => Ok(value),
        (VariableType::String, ScalarValue::Text(value))
            if value.len() <= MAX_VARIABLE_STRING_BYTES =>
        {
            Ok(ScalarValue::Text(value))
        }
        (VariableType::String, ScalarValue::Text(_)) => Err(RuntimeError::Content(format!(
            "字符串超过 {} 字节上限",
            MAX_VARIABLE_STRING_BYTES
        ))),
        (VariableType::Number, ScalarValue::Integer(value)) => {
            Ok(ScalarValue::Number(value as f64))
        }
        (VariableType::Number, ScalarValue::Number(value)) if value.is_finite() => {
            Ok(ScalarValue::Number(value))
        }
        (_, ScalarValue::Number(value)) if !value.is_finite() => {
            Err(RuntimeError::Content("变量数值必须是有限数".to_owned()))
        }
        (expected, actual) => Err(RuntimeError::Content(format!(
            "变量类型不匹配：期望 {expected:?}，实际 {actual:?}"
        ))),
    }
}

fn validate_profile_variables(
    content: &ContentCatalog,
    variables: &VariableMap,
) -> Result<(), RuntimeError> {
    validate_variables_for_scope(content, variables, VariableScope::Profile)
}

fn validate_variables_for_scope(
    content: &ContentCatalog,
    variables: &VariableMap,
    scope: VariableScope,
) -> Result<(), RuntimeError> {
    let expected_count = content
        .manifest
        .variables
        .values()
        .filter(|definition| definition.scope == scope)
        .count();
    if variables.len() != expected_count {
        return Err(RuntimeError::InvalidSnapshot(format!(
            "{scope:?} 变量数量不匹配"
        )));
    }
    for (id, definition) in &content.manifest.variables {
        if definition.scope != scope {
            continue;
        }
        let value = variables
            .get(id)
            .ok_or_else(|| RuntimeError::InvalidSnapshot(format!("缺少 {scope:?} 变量 {id}")))?;
        normalize_value(value.clone(), definition.value_type).map_err(|error| {
            RuntimeError::InvalidSnapshot(format!("变量 {id} 类型错误: {error}"))
        })?;
    }
    for id in variables.keys() {
        if content
            .manifest
            .variables
            .get(id)
            .is_none_or(|definition| definition.scope != scope)
        {
            return Err(RuntimeError::InvalidSnapshot(format!(
                "包含未知或错误作用域的变量 {id}"
            )));
        }
    }
    Ok(())
}

fn compare_values(
    left: &ScalarValue,
    right: &ScalarValue,
) -> Result<std::cmp::Ordering, RuntimeError> {
    match (left, right) {
        (ScalarValue::Boolean(left), ScalarValue::Boolean(right)) => Ok(left.cmp(right)),
        (ScalarValue::Text(left), ScalarValue::Text(right)) => Ok(left.cmp(right)),
        _ => compare_numeric(left, right),
    }
}

fn compare_numeric(
    left: &ScalarValue,
    right: &ScalarValue,
) -> Result<std::cmp::Ordering, RuntimeError> {
    match (left, right) {
        (ScalarValue::Integer(left), ScalarValue::Integer(right)) => Ok(left.cmp(right)),
        (ScalarValue::Integer(left), ScalarValue::Number(right)) => {
            compare_integer_number(*left, *right)
        }
        (ScalarValue::Number(left), ScalarValue::Integer(right)) => {
            compare_integer_number(*right, *left).map(std::cmp::Ordering::reverse)
        }
        (ScalarValue::Number(left), ScalarValue::Number(right)) => left
            .partial_cmp(right)
            .ok_or_else(|| RuntimeError::Content("无法比较非有限数值".to_owned())),
        _ => Err(RuntimeError::Content(
            "Lt/Le/Gt/Ge 只允许比较数值".to_owned(),
        )),
    }
}

/// Compare an exact i64 with an f64 without first rounding the integer to a
/// floating-point value.  A direct `i64 as f64` cast collapses neighbouring
/// values above 2^53 and can make an equality condition unexpectedly true.
fn compare_integer_number(integer: i64, number: f64) -> Result<std::cmp::Ordering, RuntimeError> {
    if !number.is_finite() {
        return Err(RuntimeError::Content("无法比较非有限数值".to_owned()));
    }
    // 2^63 is the first value outside the signed i64 range.  Keep the
    // constants explicit so the boundary remains exact in f64.
    const I64_MIN_F64: f64 = -9_223_372_036_854_775_808.0;
    const I64_MAX_EXCLUSIVE_F64: f64 = 9_223_372_036_854_775_808.0;
    if number < I64_MIN_F64 {
        return Ok(std::cmp::Ordering::Greater);
    }
    if number >= I64_MAX_EXCLUSIVE_F64 {
        return Ok(std::cmp::Ordering::Less);
    }

    // Within the range above, the truncated f64 value is safe to convert to
    // i128.  Compare integer parts exactly, then account for a fractional
    // remainder when the integer parts match.
    let truncated = number.trunc() as i128;
    let ordering = i128::from(integer).cmp(&truncated);
    if ordering != std::cmp::Ordering::Equal {
        return Ok(ordering);
    }
    let fraction = number.fract();
    Ok(if fraction > 0.0 {
        std::cmp::Ordering::Less
    } else if fraction < 0.0 {
        std::cmp::Ordering::Greater
    } else {
        std::cmp::Ordering::Equal
    })
}

fn resolve_dialogue_motion(
    content: &ContentCatalog,
    snapshot: &RuntimeSnapshot,
    visible: bool,
    override_id: Option<&str>,
) -> Result<Option<UiMotionPreset>, RuntimeError> {
    let selected = override_id.or({
        if visible {
            snapshot.world.ui_motion_bindings.dialogue_show.as_deref()
        } else {
            snapshot.world.ui_motion_bindings.dialogue_hide.as_deref()
        }
    });
    selected
        .map(|id| {
            content
                .ui_motions
                .get(id)
                .cloned()
                .ok_or_else(|| RuntimeError::Content(format!("未知 UI 动效 {id}")))
        })
        .transpose()
}

fn initial_snapshot(content: &ContentCatalog) -> Result<RuntimeSnapshot, RuntimeError> {
    let scene = content
        .scene(&content.manifest.entry_scene)
        .map_err(|error| RuntimeError::Content(error.to_string()))?;
    Ok(RuntimeSnapshot {
        revision: 0,
        location: StoryLocation {
            scene_id: scene.id.clone(),
            node_id: scene.entry.clone(),
        },
        variables: defaults_for_scope(content, VariableScope::Save)?,
        world: WorldSnapshot {
            ui_motion_bindings: content.manifest.ui_motion_defaults.clone(),
            ..WorldSnapshot::default()
        },
        audio: AudioSnapshot::default(),
        playback: PlaybackSnapshot::default(),
        dialogue_page: None,
        long_text_page: None,
        prompt: PromptSnapshot::None,
    })
}

#[allow(clippy::too_many_arguments)]
fn make_button_snapshot(
    instance_id: String,
    template_id: &str,
    template: &ButtonTemplate,
    x: Option<f32>,
    y: Option<f32>,
    width: Option<f32>,
    height: Option<f32>,
    rotation_deg: Option<f32>,
    scale_x: Option<f32>,
    scale_y: Option<f32>,
    opacity: Option<f32>,
    z: Option<i32>,
    visible: bool,
    enabled: bool,
    action: ButtonClickAction,
) -> ButtonSnapshot {
    ButtonSnapshot {
        id: instance_id,
        template: template_id.to_owned(),
        asset_mode: template.asset_mode,
        fit: template.fit,
        normal: template.normal.clone(),
        hover: template.hover.clone(),
        pressed: template.pressed.clone(),
        animations: template.animations.clone(),
        x: x.unwrap_or(0.0),
        y: y.unwrap_or(0.0),
        width: width.unwrap_or(template.width),
        height: height.unwrap_or(template.height),
        rotation_deg: rotation_deg.unwrap_or(0.0),
        scale_x: scale_x.unwrap_or(1.0),
        scale_y: scale_y.unwrap_or(1.0),
        opacity: opacity.unwrap_or(1.0),
        z: z.unwrap_or(0),
        visible,
        enabled,
        action,
    }
}

/// One visible, already-interpolated choice item before its presentation is
/// resolved.
struct ChoiceItemDraft {
    id: String,
    label: String,
    enabled: bool,
    template: Option<String>,
    icon: Option<String>,
}

fn choice_diagnostic(
    code: ChoiceDiagnosticCode,
    message: String,
    scene_id: &str,
    node_id: &str,
    choice_id: Option<&str>,
) -> ChoiceDiagnostic {
    ChoiceDiagnostic {
        code,
        message,
        scene_id: scene_id.to_owned(),
        node_id: node_id.to_owned(),
        choice_id: choice_id.map(str::to_owned),
    }
}

/// Anchors are design pixels inside the fixed 1920x1080 stage; an invalid
/// component falls back to the documented default and reports a diagnostic
/// instead of aborting the story.
fn resolve_choice_anchor(
    value: f32,
    default: f32,
    max: f32,
    label: &str,
    scene_id: &str,
    node_id: &str,
    diagnostics: &mut Vec<ChoiceDiagnostic>,
) -> f32 {
    if value.is_finite() && (0.0..=max).contains(&value) {
        value
    } else {
        diagnostics.push(choice_diagnostic(
            ChoiceDiagnosticCode::InvalidAnchor,
            format!(
                "选择节点的 {label} 必须是 0 到 {max} 之间的设计像素有限数，已回退到默认值 {default}"
            ),
            scene_id,
            node_id,
            None,
        ));
        default
    }
}

/// A negative or non-finite gap falls back to the documented default.
fn resolve_choice_gap(
    value: f32,
    scene_id: &str,
    node_id: &str,
    diagnostics: &mut Vec<ChoiceDiagnostic>,
) -> f32 {
    if value.is_finite() && value >= 0.0 {
        value
    } else {
        diagnostics.push(choice_diagnostic(
            ChoiceDiagnosticCode::InvalidGap,
            format!("选择节点的 gap 必须是非负有限数，已回退到默认值 {CHOICE_DEFAULT_GAP}"),
            scene_id,
            node_id,
            None,
        ));
        CHOICE_DEFAULT_GAP
    }
}

/// Node-wide size overrides must be finite positive numbers; an invalid side
/// is ignored once, and every affected item keeps its resolved template size
/// or the built-in fallback.
fn validate_choice_size_override(
    value: Option<f32>,
    label: &str,
    scene_id: &str,
    node_id: &str,
    diagnostics: &mut Vec<ChoiceDiagnostic>,
) -> Option<f32> {
    match value {
        None => None,
        Some(value) if value.is_finite() && value > 0.0 => Some(value),
        Some(_) => {
            diagnostics.push(choice_diagnostic(
                ChoiceDiagnosticCode::InvalidDimension,
                format!("选择节点的 button_{label} 必须是有限正数，已回退到模板尺寸或内置回退尺寸"),
                scene_id,
                node_id,
                None,
            ));
            None
        }
    }
}

/// Only `gui` assets are valid choice icons; anything else is reported and
/// dropped from the resolved item instead of breaking the prompt.
fn resolve_choice_icon(
    content: &ContentCatalog,
    icon: Option<&str>,
    scene_id: &str,
    node_id: &str,
    choice_id: &str,
    diagnostics: &mut Vec<ChoiceDiagnostic>,
) -> Option<String> {
    let icon = icon?;
    match content.manifest.assets.get(icon) {
        None => {
            diagnostics.push(choice_diagnostic(
                ChoiceDiagnosticCode::MissingIcon,
                format!("选项 {choice_id} 引用了未知图标素材 {icon}"),
                scene_id,
                node_id,
                Some(choice_id),
            ));
            None
        }
        Some(definition) if definition.kind != AssetKind::Gui => {
            diagnostics.push(choice_diagnostic(
                ChoiceDiagnosticCode::InvalidIconKind,
                format!("选项 {choice_id} 的图标 {icon} 必须是 gui 素材"),
                scene_id,
                node_id,
                Some(choice_id),
            ));
            None
        }
        Some(_) => Some(icon.to_owned()),
    }
}

/// Resolves the visible choice drafts into wire snapshots.
///
/// Size priority is option template, then node default template, then the
/// built-in CSS fallback; node width/height override the resolved template
/// dimensions.  Layout always happens after filtering and interpolation so
/// invisible options never consume a flow slot.
fn resolve_choice_items(
    content: &ContentCatalog,
    scene_id: &str,
    node_id: &str,
    presentation: Option<&ChoicePresentation>,
    drafts: &[ChoiceItemDraft],
) -> (
    Vec<ChoiceSnapshot>,
    ChoiceLayoutSnapshot,
    Vec<ChoiceDiagnostic>,
) {
    let mut diagnostics = Vec::new();
    let mut direction = ChoiceFlowDirection::Vertical;
    let mut anchor_x = CHOICE_DEFAULT_ANCHOR_X;
    let mut anchor_y = CHOICE_DEFAULT_ANCHOR_Y;
    let mut gap = CHOICE_DEFAULT_GAP;
    let mut button_width = None;
    let mut button_height = None;
    let mut node_template: Option<(&str, &ButtonTemplate)> = None;
    if let Some(presentation) = presentation {
        direction = presentation.direction;
        anchor_x = resolve_choice_anchor(
            presentation.anchor_x,
            CHOICE_DEFAULT_ANCHOR_X,
            CHOICE_STAGE_WIDTH,
            "anchor_x",
            scene_id,
            node_id,
            &mut diagnostics,
        );
        anchor_y = resolve_choice_anchor(
            presentation.anchor_y,
            CHOICE_DEFAULT_ANCHOR_Y,
            CHOICE_STAGE_HEIGHT,
            "anchor_y",
            scene_id,
            node_id,
            &mut diagnostics,
        );
        gap = resolve_choice_gap(presentation.gap, scene_id, node_id, &mut diagnostics);
        button_width = validate_choice_size_override(
            presentation.button_width,
            "width",
            scene_id,
            node_id,
            &mut diagnostics,
        );
        button_height = validate_choice_size_override(
            presentation.button_height,
            "height",
            scene_id,
            node_id,
            &mut diagnostics,
        );
        if let Some(template_id) = presentation.template.as_deref() {
            match content.buttons.get(template_id) {
                Some(template) => node_template = Some((template_id, template)),
                None => diagnostics.push(choice_diagnostic(
                    ChoiceDiagnosticCode::MissingTemplate,
                    format!("选择节点引用了未知按钮模板 {template_id}，已回退到内置 CSS 按钮"),
                    scene_id,
                    node_id,
                    None,
                )),
            }
        }
    }
    let mut sizes = Vec::with_capacity(drafts.len());
    let mut templates: Vec<Option<(&str, &ButtonTemplate)>> = Vec::with_capacity(drafts.len());
    for draft in drafts {
        let option_template = match draft.template.as_deref() {
            Some(template_id) => match content.buttons.get(template_id) {
                Some(template) => Some((template_id, template)),
                None => {
                    diagnostics.push(choice_diagnostic(
                        ChoiceDiagnosticCode::MissingTemplate,
                        format!(
                            "选项 {} 引用了未知按钮模板 {template_id}，已回退到节点默认模板或内置 CSS 按钮",
                            draft.id
                        ),
                        scene_id,
                        node_id,
                        Some(&draft.id),
                    ));
                    None
                }
            },
            None => None,
        };
        let resolved = option_template.or(node_template);
        let (base_width, base_height) = match resolved {
            Some((_, template)) => (template.width, template.height),
            None => (CHOICE_FALLBACK_BUTTON_WIDTH, CHOICE_FALLBACK_BUTTON_HEIGHT),
        };
        sizes.push((
            button_width.unwrap_or(base_width),
            button_height.unwrap_or(base_height),
        ));
        templates.push(resolved);
    }
    if presentation.is_none() {
        // A node that never opted into `presentation` keeps the shipped CSS
        // panel origin: derive the equivalent group-centre anchor so the
        // resolved rects and the legacy rendering agree without migration.
        (anchor_x, anchor_y) = legacy_choice_anchor(direction, gap, &sizes);
    }
    let layout = layout_choice_items(direction, anchor_x, anchor_y, gap, &sizes);
    let mut items = Vec::with_capacity(drafts.len());
    for (index, draft) in drafts.iter().enumerate() {
        let rect = layout.items[index];
        let icon = resolve_choice_icon(
            content,
            draft.icon.as_deref(),
            scene_id,
            node_id,
            &draft.id,
            &mut diagnostics,
        );
        let template = match templates[index] {
            Some((template_id, template)) => {
                ChoiceTemplateSnapshot::Button(Box::new(make_button_snapshot(
                    draft.id.clone(),
                    template_id,
                    template,
                    Some(rect.x),
                    Some(rect.y),
                    Some(rect.width),
                    Some(rect.height),
                    None,
                    None,
                    None,
                    None,
                    None,
                    true,
                    draft.enabled,
                    ButtonClickAction::default(),
                )))
            }
            None => ChoiceTemplateSnapshot::Fallback,
        };
        items.push(ChoiceSnapshot {
            id: draft.id.clone(),
            label: draft.label.clone(),
            enabled: draft.enabled,
            icon,
            template,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        });
    }
    let layout = ChoiceLayoutSnapshot {
        stage_width: CHOICE_STAGE_WIDTH,
        stage_height: CHOICE_STAGE_HEIGHT,
        anchor_x,
        anchor_y,
        direction,
        gap,
        x: layout.x,
        y: layout.y,
        width: layout.width,
        height: layout.height,
    };
    (items, layout, diagnostics)
}

/// Re-derives the resolved presentation of a saved choice prompt from the
/// current content.
///
/// A save only contributes identity and interaction state: the saved ids,
/// their order, the interpolated labels and the enabled flags are kept
/// verbatim, while rects, resolved templates, icons, layout and diagnostics
/// are always recomputed from the current content.  A hand-edited or stale
/// save therefore cannot inject arbitrary rects or skins, and a save written
/// before Choice presentation existed needs no migration.
///
/// A saved id that no longer exists in the current content is a ghost: it is
/// dropped instead of being kept as an unskinnable option, so a save can never
/// resurrect an option the author deleted.  Order, labels and enabled flags of
/// the surviving matches are preserved exactly as saved.  Duplicate surviving
/// ids are rejected before the prompt can reach a host; the result may be empty
/// (or all-disabled), which [`validate_snapshot`] then rejects.
fn resync_choice_prompt_from_content(
    content: &ContentCatalog,
    snapshot: &mut RuntimeSnapshot,
) -> Result<(), RuntimeError> {
    let scene_id = snapshot.location.scene_id.clone();
    let node_id = snapshot.location.node_id.clone();
    let Some(SceneNode::Choice {
        presentation,
        choices: definitions,
    }) = content
        .scene(&scene_id)
        .ok()
        .and_then(|scene| scene.nodes.get(&node_id))
    else {
        return Ok(());
    };
    let PromptSnapshot::Choice {
        layout,
        diagnostics,
        choices,
        ..
    } = &mut snapshot.prompt
    else {
        return Ok(());
    };
    let mut surviving_ids = std::collections::BTreeSet::new();
    let mut drafts = Vec::with_capacity(choices.len());
    for item in choices.iter() {
        // Saved order wins, but only for ids the current content still
        // defines; a ghost id is dropped rather than rendering an option the
        // author removed.
        let Some(definition) = definitions.iter().find(|candidate| candidate.id == item.id) else {
            continue;
        };
        if !surviving_ids.insert(item.id.as_str()) {
            return Err(RuntimeError::InvalidSnapshot(format!(
                "选择提示包含重复选项 id {}",
                item.id
            )));
        }
        drafts.push(ChoiceItemDraft {
            id: item.id.clone(),
            label: item.label.clone(),
            enabled: item.enabled,
            template: definition.template.clone(),
            icon: definition.icon.clone(),
        });
    }
    let (resolved, resolved_layout, resolved_diagnostics) =
        resolve_choice_items(content, &scene_id, &node_id, presentation.as_ref(), &drafts);
    *choices = resolved;
    *layout = resolved_layout;
    *diagnostics = resolved_diagnostics;
    Ok(())
}

fn hydrate_legacy_dialogue_page(snapshot: &mut RuntimeSnapshot) {
    if snapshot.dialogue_page.is_some() {
        return;
    }
    let PromptSnapshot::Dialogue {
        prompt_id,
        speaker_id,
        speaker,
        name_color,
        text_color,
        text,
        ..
    } = &snapshot.prompt
    else {
        return;
    };
    snapshot.dialogue_page = Some(DialoguePageSnapshot {
        page_id: prompt_id.clone(),
        speaker_id: speaker_id.clone(),
        speaker: speaker.clone(),
        name_color: name_color.clone(),
        text_color: text_color.clone(),
        segments: vec![text.clone()],
    });
}

fn validate_snapshot_curtain(
    content: &ContentCatalog,
    snapshot: &RuntimeSnapshot,
) -> Result<(), RuntimeError> {
    let curtain = &snapshot.world.curtain;
    match (curtain.covered, &curtain.fill) {
        (false, None) => Ok(()),
        (false, Some(_)) => Err(RuntimeError::InvalidSnapshot(
            "幕布未覆盖时不能保留 fill".to_owned(),
        )),
        (true, None) => Err(RuntimeError::InvalidSnapshot(
            "幕布覆盖时必须保留 fill".to_owned(),
        )),
        (true, Some(CurtainFill::Color { color })) => crate::content::validate_color(color)
            .map_err(|message| RuntimeError::InvalidSnapshot(format!("幕布颜色无效: {message}"))),
        (true, Some(CurtainFill::Asset { asset })) => {
            let definition = content.manifest.assets.get(asset).ok_or_else(|| {
                RuntimeError::InvalidSnapshot(format!("幕布引用了未知素材 {asset}"))
            })?;
            if definition.kind != AssetKind::Gui {
                return Err(RuntimeError::InvalidSnapshot(format!(
                    "幕布素材 {asset} 必须是 gui 类型"
                )));
            }
            Ok(())
        }
    }
}

fn validate_snapshot(
    content: &ContentCatalog,
    snapshot: &RuntimeSnapshot,
) -> Result<(), RuntimeError> {
    validate_variables_for_scope(content, &snapshot.variables, VariableScope::Save)?;
    for motion in [
        &snapshot.world.ui_motion_bindings.dialogue_show,
        &snapshot.world.ui_motion_bindings.dialogue_hide,
    ]
    .into_iter()
    .flatten()
    {
        if !content.ui_motions.contains_key(motion) {
            return Err(RuntimeError::InvalidSnapshot(format!(
                "UI 动效绑定引用了未知动效 {motion}"
            )));
        }
    }
    for (id, button) in &snapshot.world.buttons {
        if id != &button.id {
            return Err(RuntimeError::InvalidSnapshot(format!(
                "按钮实例索引与 ID 不一致: {id}"
            )));
        }
        let template = content.buttons.get(&button.template).ok_or_else(|| {
            RuntimeError::InvalidSnapshot(format!("按钮引用了未知模板 {}", button.template))
        })?;
        if !button.x.is_finite()
            || !button.y.is_finite()
            || !button.width.is_finite()
            || !button.height.is_finite()
            || button.width <= 0.0
            || button.height <= 0.0
            || !button.scale_x.is_finite()
            || !button.scale_y.is_finite()
            || button.scale_x <= 0.0
            || button.scale_y <= 0.0
            || !button.opacity.is_finite()
            || !(0.0..=1.0).contains(&button.opacity)
        {
            return Err(RuntimeError::InvalidSnapshot(format!(
                "按钮实例 {id} 的布局或透明度无效"
            )));
        }
        if button.asset_mode != template.asset_mode
            || button.fit != template.fit
            || button.animations != template.animations
            || button.normal != template.normal
            || button.hover != template.hover
            || button.pressed != template.pressed
        {
            return Err(RuntimeError::InvalidSnapshot(format!(
                "按钮实例 {id} 的模板视觉数据不一致"
            )));
        }
    }
    validate_snapshot_curtain(content, snapshot)?;
    if let Some(page) = &snapshot.dialogue_page {
        if page.page_id.is_empty()
            || page.segments.is_empty()
            || page
                .segments
                .iter()
                .any(|segment| segment.trim().is_empty())
        {
            return Err(RuntimeError::InvalidSnapshot(
                "对话页 ID 或分段无效".to_owned(),
            ));
        }
        if let PromptSnapshot::Dialogue {
            speaker_id,
            speaker,
            name_color,
            text_color,
            text,
            ..
        } = &snapshot.prompt
        {
            if &page.speaker_id != speaker_id
                || &page.speaker != speaker
                || &page.name_color != name_color
                || &page.text_color != text_color
                || page.segments.last() != Some(text)
            {
                return Err(RuntimeError::InvalidSnapshot(
                    "当前对话提示与稳定对话页不一致".to_owned(),
                ));
            }
        }
    } else if matches!(snapshot.prompt, PromptSnapshot::Dialogue { .. }) {
        return Err(RuntimeError::InvalidSnapshot(
            "对话提示缺少稳定对话页".to_owned(),
        ));
    }
    if let Some(page) = &snapshot.long_text_page {
        if page.document_id.is_empty()
            || page.steps.is_empty()
            || page.active_step_index as usize >= page.steps.len()
            || page
                .steps
                .iter()
                .any(|step| step.step_id.is_empty() || step.text.trim().is_empty())
        {
            return Err(RuntimeError::InvalidSnapshot(
                "长文本页面或步骤无效".to_owned(),
            ));
        }
        validate_long_text_document_size(
            page,
            &snapshot.location.scene_id,
            &snapshot.location.node_id,
        )
        .map_err(|error| RuntimeError::InvalidSnapshot(error.to_string()))?;
        if let PromptSnapshot::LongText {
            prompt_id,
            document_id,
            step_id,
            step_index: _,
            text,
            ..
        } = &snapshot.prompt
        {
            let expected_page_index = page
                .steps
                .iter()
                .position(|step| step.step_id == *step_id)
                .ok_or_else(|| {
                    RuntimeError::InvalidSnapshot(
                        "当前长文本提示的步骤不在累计长文本页面中".to_owned(),
                    )
                })?;
            let active = &page.steps[page.active_step_index as usize];
            if &page.document_id != document_id
                || page.active_step_index as usize != expected_page_index
                || active.step_id != *step_id
                || active.text != *text
                || prompt_id != &format!("{document_id}/{step_id}")
            {
                return Err(RuntimeError::InvalidSnapshot(
                    "当前长文本提示与稳定长文本页面不一致".to_owned(),
                ));
            }
        }
    } else if matches!(snapshot.prompt, PromptSnapshot::LongText { .. }) {
        return Err(RuntimeError::InvalidSnapshot(
            "长文本提示缺少稳定长文本页面".to_owned(),
        ));
    }
    let scene = content
        .scene(&snapshot.location.scene_id)
        .map_err(|error| RuntimeError::InvalidSnapshot(error.to_string()))?;
    if !scene.nodes.contains_key(&snapshot.location.node_id) {
        return Err(RuntimeError::InvalidSnapshot(format!(
            "节点不存在: {}/{}",
            snapshot.location.scene_id, snapshot.location.node_id
        )));
    }
    if let Some(page) = &snapshot.long_text_page {
        // A retained manuscript is scene-owned.  Do not allow a crafted save
        // to inject a document from another scene or arbitrary step IDs into
        // a dialogue/choice snapshot merely because its paper asset is valid.
        let mut start_found = false;
        let mut expected_presentation = None;
        let mut known_steps = std::collections::BTreeMap::new();
        for (candidate_id, candidate) in &scene.nodes {
            let SceneNode::LongText {
                document,
                mode,
                paper,
                pagination,
                font_size,
                text_color,
                layout,
                steps,
                ..
            } = candidate
            else {
                continue;
            };
            let document_id = long_text_document_id(
                &snapshot.location.scene_id,
                candidate_id,
                document.as_deref(),
            );
            if document_id != page.document_id {
                continue;
            }
            if *mode == LongTextMode::Start {
                start_found = true;
                expected_presentation = Some((
                    paper.clone(),
                    pagination.unwrap_or_default(),
                    font_size.unwrap_or(crate::model::LONG_TEXT_FONT_SIZE_DEFAULT),
                    text_color
                        .clone()
                        .unwrap_or_else(|| crate::model::LONG_TEXT_COLOR_DEFAULT.to_owned()),
                    layout.clone().unwrap_or_default(),
                ));
            }
            for step in steps {
                known_steps.insert(step.id.as_str(), step);
            }
        }
        if !start_found {
            return Err(RuntimeError::InvalidSnapshot(
                "长文本页面不属于当前场景的已声明文稿".to_owned(),
            ));
        }
        if let Some((paper, pagination, font_size, text_color, layout)) = expected_presentation {
            if page.paper != paper
                || page.pagination != pagination
                || page.font_size != font_size
                || page.text_color != text_color
                || page.layout != layout
            {
                return Err(RuntimeError::InvalidSnapshot(
                    "累计长文本的纸张、分页或排版样式与开始节点不一致".to_owned(),
                ));
            }
        }
        let mut seen_steps = std::collections::BTreeSet::new();
        if page.steps.iter().any(|step| {
            !seen_steps.insert(step.step_id.as_str())
                || known_steps
                    .get(step.step_id.as_str())
                    .is_none_or(|definition| definition.page_break_before != step.page_break_before)
        }) {
            return Err(RuntimeError::InvalidSnapshot(
                "累计长文本包含未知或重复步骤".to_owned(),
            ));
        }
    }
    if matches!(snapshot.prompt, PromptSnapshot::LongText { .. })
        && !matches!(
            scene.nodes.get(&snapshot.location.node_id),
            Some(SceneNode::LongText { .. })
        )
    {
        return Err(RuntimeError::InvalidSnapshot(
            "长文本提示的位置不是 long_text 节点".to_owned(),
        ));
    }
    // A crafted save must not keep a choice prompt alive at a node that is
    // not a choice; the prompt is re-resolved from content first, so this also
    // rejects a stale save whose choice node was rewritten.
    if let PromptSnapshot::Choice { choices, .. } = &snapshot.prompt {
        if !matches!(
            scene.nodes.get(&snapshot.location.node_id),
            Some(SceneNode::Choice { .. })
        ) {
            return Err(RuntimeError::InvalidSnapshot(
                "选择提示的位置不是 choice 节点".to_owned(),
            ));
        }
        // Ghost ids have already been dropped and the current content defines
        // at least one enabled option before a prompt is ever produced, so an
        // empty or fully disabled loaded prompt can only come from a crafted or
        // unrecoverable save: it would deadlock the player.
        if choices.is_empty() {
            return Err(RuntimeError::InvalidSnapshot(
                "选择提示没有任何选项".to_owned(),
            ));
        }
        if !choices.iter().any(|choice| choice.enabled) {
            return Err(RuntimeError::InvalidSnapshot(
                "选择提示没有任何可用选项".to_owned(),
            ));
        }
    }
    if let PromptSnapshot::LongText {
        step_index,
        step_id,
        ..
    } = &snapshot.prompt
    {
        if let Some(SceneNode::LongText { steps, .. }) = scene.nodes.get(&snapshot.location.node_id)
        {
            let node_step = steps.get(*step_index as usize).ok_or_else(|| {
                RuntimeError::InvalidSnapshot("当前长文本节点步骤索引无效".to_owned())
            })?;
            if node_step.id != *step_id {
                return Err(RuntimeError::InvalidSnapshot(
                    "当前长文本提示的节点步骤不一致".to_owned(),
                ));
            }
        }
    }
    let mut referenced_assets = Vec::new();
    if let Some(background) = &snapshot.world.background {
        referenced_assets.push(background.clone());
    }
    referenced_assets.extend(
        snapshot
            .world
            .sprites
            .values()
            .map(|sprite| sprite.asset.clone()),
    );
    if let Some(bgm) = &snapshot.audio.bgm {
        referenced_assets.push(bgm.asset.clone());
    }
    for (_, ambience) in snapshot.audio.ambience.iter() {
        referenced_assets.push(ambience.asset.clone());
    }
    if let Some(paper) = snapshot
        .long_text_page
        .as_ref()
        .and_then(|page| page.paper.clone())
    {
        referenced_assets.push(paper);
    }
    content
        .resolve_assets(&referenced_assets)
        .map_err(|error| RuntimeError::InvalidSnapshot(error.to_string()))?;
    if !snapshot.world.camera.x.is_finite()
        || !snapshot.world.camera.y.is_finite()
        || !snapshot.world.camera.rotation_deg.is_finite()
        || !snapshot.world.camera.zoom.is_finite()
        || snapshot.world.camera.zoom <= 0.0
    {
        return Err(RuntimeError::InvalidSnapshot(
            "相机状态包含无效数值".to_owned(),
        ));
    }
    for (id, sprite) in &snapshot.world.sprites {
        if !sprite.x.is_finite()
            || !sprite.y.is_finite()
            || !sprite.scale.is_finite()
            || !sprite.scale_x.is_finite()
            || !sprite.scale_y.is_finite()
            || !sprite.rotation_deg.is_finite()
            || !sprite.opacity.is_finite()
            || sprite.scale <= 0.0
            || sprite.scale_x <= 0.0
            || sprite.scale_y <= 0.0
            || !(0.0..=1.0).contains(&sprite.opacity)
        {
            return Err(RuntimeError::InvalidSnapshot(format!(
                "立绘 {id} 状态包含无效数值"
            )));
        }
    }
    if let Some(bgm) = &snapshot.audio.bgm {
        if !bgm.volume.is_finite()
            || !(0.0..=1.0).contains(&bgm.volume)
            || bgm.loop_start_ms.is_some() != bgm.loop_end_ms.is_some()
            || matches!((bgm.loop_start_ms, bgm.loop_end_ms), (Some(start), Some(end)) if start >= end || bgm.start_ms > end)
        {
            return Err(RuntimeError::InvalidSnapshot(
                "BGM 状态包含无效数值或循环点".to_owned(),
            ));
        }
    }
    for (slot, ambience) in snapshot.audio.ambience.iter() {
        if !ambience.volume.is_finite()
            || !(0.0..=1.0).contains(&ambience.volume)
            || ambience.loop_start_ms.is_some() != ambience.loop_end_ms.is_some()
            || matches!(
                (ambience.loop_start_ms, ambience.loop_end_ms),
                (Some(start), Some(end))
                    if start >= end || ambience.start_ms > end
            )
        {
            return Err(RuntimeError::InvalidSnapshot(format!(
                "ambience {} 状态包含无效数值或循环点",
                slot.as_str()
            )));
        }
        let asset = content
            .manifest
            .assets
            .get(&ambience.asset)
            .ok_or_else(|| {
                RuntimeError::InvalidSnapshot(format!(
                    "ambience {} 引用了未知素材 {}",
                    slot.as_str(),
                    ambience.asset
                ))
            })?;
        if asset.kind != AssetKind::Ambience {
            return Err(RuntimeError::InvalidSnapshot(format!(
                "ambience {} 必须引用 ambience 素材 {}",
                slot.as_str(),
                ambience.asset
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use super::*;
    use crate::model::{
        ButtonAssetFit, ButtonAssetMode, ButtonClickAction, ButtonPostAction, ButtonTemplate,
        ChapterMapDefinition, ChapterMapHotspot, LiteralOperand, SceneDefinition,
        SpriteActionDefinition, SpriteActionEnd, SpriteActionKeyframe, TimelineEasing,
        TimelineEasingPreset, VariableOperand, VariableOperation,
    };

    #[derive(serde::Deserialize)]
    struct TimelineConformanceSample {
        name: String,
        easing: crate::model::TimelineEasing,
        time: f32,
        expected: f32,
    }

    fn catalog() -> ContentCatalog {
        ContentCatalog::from_root(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/game"),
        )
        .expect("demo content must be valid")
    }

    fn ambience_content(nodes: BTreeMap<String, SceneNode>) -> ContentCatalog {
        let mut content = catalog();
        content.manifest.entry_scene = "ambience_scene".to_owned();
        content.manifest.assets.insert(
            "ambience.test".to_owned(),
            crate::model::AssetDefinition {
                kind: AssetKind::Ambience,
                path: Some("audio/test_bgm.ogg".to_owned()),
                animation: None,
            },
        );
        content.scenes.insert(
            "ambience_scene".to_owned(),
            SceneDefinition {
                schema_version: 2,
                id: "ambience_scene".to_owned(),
                entry: ["start", "start_1", "await_ambience"]
                    .into_iter()
                    .find(|id| nodes.contains_key(*id))
                    .map(str::to_owned)
                    .or_else(|| nodes.keys().next().cloned())
                    .expect("ambience fixture needs an entry"),
                nodes,
            },
        );
        content
    }

    fn ambience_node(
        slot: crate::model::AmbienceSlot,
        action: AudioAction,
        asset: Option<&str>,
        await_completion: bool,
        next: &str,
    ) -> SceneNode {
        SceneNode::Ambience {
            slot,
            action,
            asset: asset.map(str::to_owned),
            volume: 0.8,
            start_ms: 0,
            loop_start_ms: None,
            loop_end_ms: None,
            duration_ms: 100,
            await_completion,
            next: next.to_owned(),
        }
    }

    #[test]
    fn ambience_updates_four_slots_independently_and_replaces_or_stops_one_slot() {
        use crate::model::AmbienceSlot::{Slot1, Slot2, Slot3, Slot4};

        let content = ambience_content(BTreeMap::from([
            (
                "start_1".to_owned(),
                ambience_node(
                    Slot1,
                    AudioAction::Start,
                    Some("ambience.test"),
                    false,
                    "start_2",
                ),
            ),
            (
                "start_2".to_owned(),
                ambience_node(
                    Slot2,
                    AudioAction::Start,
                    Some("ambience.test"),
                    false,
                    "start_3",
                ),
            ),
            (
                "start_3".to_owned(),
                ambience_node(
                    Slot3,
                    AudioAction::Start,
                    Some("ambience.test"),
                    false,
                    "start_4",
                ),
            ),
            (
                "start_4".to_owned(),
                ambience_node(
                    Slot4,
                    AudioAction::Start,
                    Some("ambience.test"),
                    false,
                    "replace_2",
                ),
            ),
            (
                "replace_2".to_owned(),
                SceneNode::Ambience {
                    slot: Slot2,
                    action: AudioAction::Start,
                    asset: Some("ambience.test".to_owned()),
                    volume: 0.35,
                    start_ms: 900,
                    loop_start_ms: None,
                    loop_end_ms: None,
                    duration_ms: 100,
                    await_completion: false,
                    next: "stop_3".to_owned(),
                },
            ),
            (
                "stop_3".to_owned(),
                ambience_node(Slot3, AudioAction::Stop, None, false, "end"),
            ),
            ("end".to_owned(), SceneNode::End),
        ]));
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let update = runtime.start_new_game(&content).unwrap();

        assert!(!update.requires_ack);
        assert!(update.snapshot.audio.ambience.get(Slot1).is_some());
        let slot2 = update.snapshot.audio.ambience.get(Slot2).unwrap();
        assert_eq!(slot2.asset, "ambience.test");
        assert_eq!(slot2.volume, 0.35);
        assert!(update.snapshot.audio.ambience.get(Slot3).is_none());
        assert!(update.snapshot.audio.ambience.get(Slot4).is_some());
        assert!(update.cues.iter().any(|cue| matches!(
            &cue.kind,
            PresentationCueKind::AmbienceTransition {
                slot: Slot2,
                from: Some(from),
                to: Some(to),
                ..
            } if from.asset == to.asset
        )));
        assert!(update.cues.iter().any(|cue| matches!(
            &cue.kind,
            PresentationCueKind::AmbienceTransition {
                slot: Slot3,
                from: Some(_),
                to: None,
                ..
            }
        )));
    }

    #[test]
    fn awaited_ambience_uses_the_existing_cue_gate() {
        use crate::model::AmbienceSlot::Slot1;

        let content = ambience_content(BTreeMap::from([
            (
                "await_ambience".to_owned(),
                ambience_node(
                    Slot1,
                    AudioAction::Start,
                    Some("ambience.test"),
                    true,
                    "end",
                ),
            ),
            ("end".to_owned(), SceneNode::End),
        ]));
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let update = runtime.start_new_game(&content).unwrap();
        assert!(update.requires_ack);
        assert_eq!(update.cues[0].gate, CueGate::Runtime);
        assert!(matches!(
            runtime.advance(&content, update.snapshot.revision, AdvanceSource::Manual),
            Err(RuntimeError::PresentationPending(_))
        ));
        let complete = runtime
            .presentation_complete(&content, update.update_id, PresentationOutcome::Completed)
            .unwrap();
        assert!(matches!(
            complete.snapshot.prompt,
            PromptSnapshot::End { .. }
        ));
    }

    #[test]
    fn clear_preserves_ambience_but_scene_leave_stops_it() {
        use crate::model::AmbienceSlot::Slot1;

        let mut content = ambience_content(BTreeMap::from([
            (
                "start".to_owned(),
                ambience_node(
                    Slot1,
                    AudioAction::Start,
                    Some("ambience.test"),
                    false,
                    "clear",
                ),
            ),
            (
                "clear".to_owned(),
                SceneNode::Clear {
                    duration_ms: 100,
                    easing: crate::model::Easing::Linear,
                    await_completion: true,
                    next: "leave".to_owned(),
                },
            ),
            (
                "leave".to_owned(),
                SceneNode::Jump {
                    scene: Some("destination".to_owned()),
                    target: "end".to_owned(),
                },
            ),
        ]));
        content.scenes.insert(
            "destination".to_owned(),
            SceneDefinition {
                schema_version: 2,
                id: "destination".to_owned(),
                entry: "end".to_owned(),
                nodes: BTreeMap::from([("end".to_owned(), SceneNode::End)]),
            },
        );
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let cleared = runtime.start_new_game(&content).unwrap();
        assert!(cleared.snapshot.audio.ambience.get(Slot1).is_some());
        let left = runtime
            .presentation_complete(&content, cleared.update_id, PresentationOutcome::Completed)
            .unwrap();
        assert!(left.snapshot.audio.ambience.is_empty());
        assert!(left.cues.iter().any(|cue| matches!(
            &cue.kind,
            PresentationCueKind::AmbienceTransition {
                slot: Slot1,
                to: None,
                ..
            }
        )));
    }

    #[test]
    fn ambience_timeline_volume_is_transient_and_does_not_change_snapshot() {
        use crate::model::AmbienceSlot::Slot1;

        let track = TimelineTrack::Ambience {
            slot: Slot1,
            channels: BTreeMap::from([(
                "volume".to_owned(),
                vec![
                    crate::model::TimelineKeyframe {
                        at_ms: 0,
                        value: crate::model::TimelineKeyframeValue::Number(0.2),
                        easing: TimelineEasing::default(),
                    },
                    crate::model::TimelineKeyframe {
                        at_ms: 100,
                        value: crate::model::TimelineKeyframeValue::Number(0.1),
                        easing: TimelineEasing::default(),
                    },
                ],
            )]),
        };
        let content = ambience_content(BTreeMap::from([
            (
                "start".to_owned(),
                ambience_node(
                    Slot1,
                    AudioAction::Start,
                    Some("ambience.test"),
                    false,
                    "timeline",
                ),
            ),
            (
                "timeline".to_owned(),
                SceneNode::Timeline {
                    duration_ms: 100,
                    await_completion: true,
                    skippable: true,
                    tracks: vec![track],
                    events: Vec::new(),
                    next: "end".to_owned(),
                },
            ),
            ("end".to_owned(), SceneNode::End),
        ]));
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let update = runtime.start_new_game(&content).unwrap();
        assert!(update.requires_ack);
        assert_eq!(
            update.snapshot.audio.ambience.get(Slot1).unwrap().volume,
            0.8
        );
        let complete = runtime
            .presentation_complete(&content, update.update_id, PresentationOutcome::Skipped)
            .unwrap();
        assert_eq!(
            complete.snapshot.audio.ambience.get(Slot1).unwrap().volume,
            0.8
        );
    }

    #[test]
    fn malformed_ambience_snapshot_rejects_numeric_loop_and_asset_errors() {
        use crate::model::{AmbienceSlot, LoopingAudioSnapshot};

        let content = ambience_content(BTreeMap::from([("end".to_owned(), SceneNode::End)]));
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let malformed_states = [
            (
                LoopingAudioSnapshot {
                    asset: "ambience.test".to_owned(),
                    volume: f32::NAN,
                    start_ms: 0,
                    loop_start_ms: None,
                    loop_end_ms: None,
                },
                "无效数值",
            ),
            (
                LoopingAudioSnapshot {
                    asset: "ambience.test".to_owned(),
                    volume: 1.01,
                    start_ms: 0,
                    loop_start_ms: None,
                    loop_end_ms: None,
                },
                "无效数值",
            ),
            (
                LoopingAudioSnapshot {
                    asset: "ambience.test".to_owned(),
                    volume: 0.8,
                    start_ms: 0,
                    loop_start_ms: Some(100),
                    loop_end_ms: None,
                },
                "无效数值",
            ),
            (
                LoopingAudioSnapshot {
                    asset: "ambience.test".to_owned(),
                    volume: 0.8,
                    start_ms: 901,
                    loop_start_ms: Some(100),
                    loop_end_ms: Some(900),
                },
                "无效数值",
            ),
        ];
        for (state, expected) in malformed_states {
            let mut malformed = runtime.snapshot().clone();
            malformed
                .audio
                .ambience
                .set(AmbienceSlot::Slot1, Some(state));
            assert!(matches!(
                runtime.load_snapshot(&content, malformed),
                Err(RuntimeError::InvalidSnapshot(message)) if message.contains(expected)
            ));
        }

        let mut snapshot = runtime.snapshot().clone();
        snapshot.audio.ambience.set(
            AmbienceSlot::Slot1,
            Some(LoopingAudioSnapshot {
                asset: "bgm.test1".to_owned(),
                volume: 0.8,
                start_ms: 0,
                loop_start_ms: None,
                loop_end_ms: None,
            }),
        );
        assert!(matches!(
            runtime.load_snapshot(&content, snapshot),
            Err(RuntimeError::InvalidSnapshot(message)) if message.contains("必须引用 ambience")
        ));

        let mut unknown = runtime.snapshot().clone();
        unknown.audio.ambience.set(
            AmbienceSlot::Slot1,
            Some(LoopingAudioSnapshot {
                asset: "ambience.missing".to_owned(),
                volume: 0.8,
                start_ms: 0,
                loop_start_ms: None,
                loop_end_ms: None,
            }),
        );
        assert!(matches!(
            runtime.load_snapshot(&content, unknown),
            Err(RuntimeError::InvalidSnapshot(message)) if message.contains("素材未登记")
        ));
    }

    fn catalog_with_chapter_map() -> ContentCatalog {
        let base = catalog();
        let root = base
            .assets_root()
            .parent()
            .expect("fixture assets parent")
            .to_path_buf();
        let mut manifest = base.manifest.clone();
        manifest.chapter_map = Some("chapter-map.yaml".to_owned());
        let map = ChapterMapDefinition {
            schema_version: 1,
            width: 1920,
            height: 1080,
            view_x: 960,
            view_y: 540,
            background: None,
            decorations: Vec::new(),
            hotspots: vec![
                ChapterMapHotspot {
                    id: "hidden".to_owned(),
                    scene_id: "prologue".to_owned(),
                    title: "隐藏章节".to_owned(),
                    hover_text: Some("完成后说明".to_owned()),
                    x: 200,
                    y: 400,
                    width: 280,
                    height: 160,
                    z: 1,
                    asset: None,
                    reveal: ChapterMapReveal::Completed,
                    replay: crate::model::ChapterMapReplay::Completed,
                    variable_overrides: VariableMap::new(),
                },
                ChapterMapHotspot {
                    id: "always".to_owned(),
                    scene_id: "test_scene".to_owned(),
                    title: "始终显示".to_owned(),
                    hover_text: Some("始终章节的说明".to_owned()),
                    x: 600,
                    y: 400,
                    width: 280,
                    height: 160,
                    z: 1,
                    asset: None,
                    reveal: ChapterMapReveal::Always,
                    replay: crate::model::ChapterMapReplay::Completed,
                    variable_overrides: VariableMap::new(),
                },
            ],
        };
        ContentCatalog::from_documents_with_chapter_map(
            root,
            manifest,
            base.scenes.clone(),
            base.manifest
                .ui_motions
                .iter()
                .cloned()
                .zip(base.ui_motions.values().cloned())
                .collect(),
            Some(map),
        )
        .expect("fixture map should be valid")
    }

    #[test]
    fn sprite_action_expands_relative_channels_and_parameters() {
        let mut content = catalog();
        content.actions.insert(
            "sprite.bob".to_owned(),
            SpriteActionDefinition {
                schema_version: 1,
                id: "sprite.bob".to_owned(),
                name: "轻轻跳动".to_owned(),
                duration_ms: 100,
                channels: BTreeMap::from([
                    (
                        "x".to_owned(),
                        vec![
                            SpriteActionKeyframe {
                                at_ms: 0,
                                value: 0.0,
                                easing: TimelineEasing::Preset(TimelineEasingPreset::Linear),
                                parameter: None,
                            },
                            SpriteActionKeyframe {
                                at_ms: 100,
                                value: 10.0,
                                easing: TimelineEasing::Preset(TimelineEasingPreset::EaseOut),
                                parameter: Some("distance".to_owned()),
                            },
                        ],
                    ),
                    (
                        "scale".to_owned(),
                        vec![
                            SpriteActionKeyframe {
                                at_ms: 0,
                                value: 1.0,
                                easing: TimelineEasing::Preset(TimelineEasingPreset::Linear),
                                parameter: None,
                            },
                            SpriteActionKeyframe {
                                at_ms: 100,
                                value: 1.2,
                                easing: TimelineEasing::Preset(TimelineEasingPreset::EaseInOut),
                                parameter: None,
                            },
                        ],
                    ),
                ]),
                parameters: BTreeMap::from([(
                    "distance".to_owned(),
                    crate::model::SpriteActionParameter {
                        default: 10.0,
                        min: Some(0.0),
                        max: Some(50.0),
                    },
                )]),
                end: SpriteActionEnd::Hold,
            },
        );
        let scene = content.scenes.get_mut("prologue").unwrap();
        scene.entry = "show_action".to_owned();
        scene.nodes = BTreeMap::from([
            (
                "show_action".to_owned(),
                SceneNode::Sprite {
                    sprite_id: "jelly".to_owned(),
                    action: SpriteAction::Show,
                    asset: Some("sprite.jelly".to_owned()),
                    character: None,
                    expression: None,
                    flip_x: Some(false),
                    crossfade_ms: None,
                    x: Some(100.0),
                    y: Some(200.0),
                    scale: Some(2.0),
                    opacity: Some(1.0),
                    z: Some(3),
                    duration_ms: 0,
                    easing: crate::model::Easing::Linear,
                    await_completion: false,
                    next: "action".to_owned(),
                },
            ),
            (
                "action".to_owned(),
                SceneNode::Action {
                    sprite_id: "jelly".to_owned(),
                    action: "sprite.bob".to_owned(),
                    duration_ms: Some(200),
                    await_completion: true,
                    parameters: BTreeMap::from([("distance".to_owned(), 15.0)]),
                    end: None,
                    next: "done".to_owned(),
                },
            ),
            ("done".to_owned(), SceneNode::End),
        ]);

        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let update = runtime.start_scene_preview(&content, "prologue").unwrap();
        let action_cue = update
            .cues
            .iter()
            .find_map(|cue| match &cue.kind {
                PresentationCueKind::Timeline { tracks, .. }
                    if tracks.iter().any(|track| matches!(track, TimelineTrack::Sprite { sprite_id, .. } if sprite_id == "jelly")) =>
                {
                    Some(tracks)
                }
                _ => None,
            })
            .expect("action should emit a sprite timeline");
        let track = action_cue
            .iter()
            .find_map(|track| match track {
                TimelineTrack::Sprite { channels, .. } => Some(channels),
                _ => None,
            })
            .unwrap();
        let x = track["x"].last().unwrap();
        assert_eq!(x.at_ms, 200);
        assert_eq!(x.value, TimelineKeyframeValue::Number(115.0));
        let scale = track["scale"].last().unwrap();
        assert_eq!(scale.value, TimelineKeyframeValue::Number(2.4));
        assert_eq!(update.snapshot.world.sprites["jelly"].x, 115.0);
        assert_eq!(update.snapshot.world.sprites["jelly"].scale, 2.4);
        assert!(update.requires_ack);
    }

    #[test]
    fn character_expression_resolves_pose_and_default_crossfade() {
        let mut content = catalog();
        let character = content.manifest.characters.get_mut("test").unwrap();
        character.default_expression = Some("neutral".to_owned());
        character.default_scale = 1.25;
        character.expressions.insert(
            "neutral".to_owned(),
            crate::model::CharacterExpression {
                asset: "sprite.jelly".to_owned(),
                anchor_x: 0.4,
                anchor_y: 0.9,
                offset_x: 12.0,
                offset_y: -8.0,
                scale: 0.8,
            },
        );
        character.expressions.insert(
            "smug".to_owned(),
            crate::model::CharacterExpression {
                asset: "sprite.omo".to_owned(),
                anchor_x: 0.6,
                anchor_y: 1.0,
                offset_x: -4.0,
                offset_y: 0.0,
                scale: 1.0,
            },
        );
        let scene = content.scenes.get_mut("prologue").unwrap();
        scene.entry = "role_show".to_owned();
        scene.nodes = BTreeMap::from([
            (
                "role_show".to_owned(),
                SceneNode::Sprite {
                    sprite_id: "role".to_owned(),
                    action: SpriteAction::Show,
                    asset: None,
                    character: Some("test".to_owned()),
                    expression: None,
                    flip_x: Some(false),
                    crossfade_ms: None,
                    x: Some(100.0),
                    y: Some(200.0),
                    scale: Some(2.0),
                    opacity: Some(1.0),
                    z: Some(2),
                    duration_ms: 0,
                    easing: crate::model::Easing::Linear,
                    await_completion: false,
                    next: "role_change".to_owned(),
                },
            ),
            (
                "role_change".to_owned(),
                SceneNode::Sprite {
                    sprite_id: "role".to_owned(),
                    action: SpriteAction::Move,
                    asset: None,
                    character: Some("test".to_owned()),
                    expression: Some("smug".to_owned()),
                    flip_x: Some(true),
                    crossfade_ms: None,
                    x: Some(120.0),
                    y: Some(220.0),
                    scale: Some(1.0),
                    opacity: Some(0.9),
                    z: Some(3),
                    duration_ms: 100,
                    easing: crate::model::Easing::Linear,
                    await_completion: true,
                    next: "done".to_owned(),
                },
            ),
            ("done".to_owned(), SceneNode::End),
        ]);

        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let update = runtime.start_scene_preview(&content, "prologue").unwrap();
        let sprite = &update.snapshot.world.sprites["role"];
        assert_eq!(sprite.asset, "sprite.omo");
        assert_eq!(sprite.x, 116.0);
        assert_eq!(sprite.y, 220.0);
        assert_eq!(sprite.scale, 1.25);
        assert!(sprite.flip_x);
        assert_eq!(sprite.anchor_x, 0.6);
        assert_eq!(sprite.anchor_y, 1.0);
        assert_eq!(sprite.z, 3);
        let tween = update.cues.iter().find_map(|cue| match &cue.kind {
            PresentationCueKind::SpriteTween {
                sprite_id,
                crossfade_ms,
                to: Some(to),
                ..
            } if sprite_id == "role" && to.asset == "sprite.omo" => Some((to, *crossfade_ms)),
            _ => None,
        });
        let Some((to, crossfade_ms)) = tween else {
            panic!("expected expression change tween")
        };
        assert_eq!(crossfade_ms, Some(150));
        assert_eq!(to.anchor_x, 0.6);
    }

    #[test]
    fn sprite_action_restore_returns_to_the_starting_pose() {
        let mut content = catalog();
        content.actions.insert(
            "sprite.restore".to_owned(),
            SpriteActionDefinition {
                schema_version: 1,
                id: "sprite.restore".to_owned(),
                name: "恢复".to_owned(),
                duration_ms: 100,
                channels: BTreeMap::from([(
                    "rotation_deg".to_owned(),
                    vec![
                        SpriteActionKeyframe {
                            at_ms: 0,
                            value: 0.0,
                            easing: TimelineEasing::Preset(TimelineEasingPreset::Linear),
                            parameter: None,
                        },
                        SpriteActionKeyframe {
                            at_ms: 100,
                            value: 45.0,
                            easing: TimelineEasing::Preset(TimelineEasingPreset::Linear),
                            parameter: None,
                        },
                    ],
                )]),
                parameters: BTreeMap::new(),
                end: SpriteActionEnd::Restore,
            },
        );
        let scene = content.scenes.get_mut("prologue").unwrap();
        scene.entry = "show_restore".to_owned();
        scene.nodes = BTreeMap::from([
            (
                "show_restore".to_owned(),
                SceneNode::Sprite {
                    sprite_id: "jelly".to_owned(),
                    action: SpriteAction::Show,
                    asset: Some("sprite.jelly".to_owned()),
                    character: None,
                    expression: None,
                    flip_x: Some(false),
                    crossfade_ms: None,
                    x: Some(10.0),
                    y: Some(20.0),
                    scale: Some(1.0),
                    opacity: Some(1.0),
                    z: Some(3),
                    duration_ms: 0,
                    easing: crate::model::Easing::Linear,
                    await_completion: false,
                    next: "restore".to_owned(),
                },
            ),
            (
                "restore".to_owned(),
                SceneNode::Action {
                    sprite_id: "jelly".to_owned(),
                    action: "sprite.restore".to_owned(),
                    duration_ms: None,
                    await_completion: true,
                    parameters: BTreeMap::new(),
                    end: Some(SpriteActionEnd::Restore),
                    next: "done".to_owned(),
                },
            ),
            ("done".to_owned(), SceneNode::End),
        ]);
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let update = runtime.start_scene_preview(&content, "prologue").unwrap();
        let sprite = &update.snapshot.world.sprites["jelly"];
        assert_eq!(sprite.rotation_deg, 0.0);
        assert!(update
            .cues
            .iter()
            .any(|cue| matches!(cue.kind, PresentationCueKind::Timeline { .. })));
    }

    #[test]
    fn transparent_button_click_applies_action_and_cross_scene_jump_clears_instances() {
        let mut content = catalog();
        content.buttons.insert(
            "test.transparent".to_owned(),
            ButtonTemplate {
                schema_version: 1,
                id: "test.transparent".to_owned(),
                width: 200.0,
                height: 80.0,
                asset_mode: ButtonAssetMode::Separate,
                fit: ButtonAssetFit::Stretch,
                normal: None,
                hover: None,
                pressed: None,
                animations: Default::default(),
            },
        );
        content.scenes.insert(
            "button_destination".to_owned(),
            SceneDefinition {
                schema_version: 2,
                id: "button_destination".to_owned(),
                entry: "done".to_owned(),
                nodes: BTreeMap::from([("done".to_owned(), SceneNode::End)]),
            },
        );
        let scene = content.scenes.get_mut("prologue").unwrap();
        scene.entry = "button_a".to_owned();
        scene.nodes = BTreeMap::from([
            (
                "button_a".to_owned(),
                SceneNode::ButtonCreate {
                    instance_id: "transparent".to_owned(),
                    template: "test.transparent".to_owned(),
                    x: Some(10.0),
                    y: Some(20.0),
                    width: Some(200.0),
                    height: Some(80.0),
                    rotation_deg: None,
                    scale_x: None,
                    scale_y: None,
                    opacity: Some(0.0),
                    z: Some(3),
                    visible: true,
                    enabled: true,
                    action: ButtonClickAction {
                        sets: vec![crate::model::ButtonSetAction {
                            variable: "score".to_owned(),
                            op: VariableOperation::Add,
                            value: Some(crate::model::MutationValue::Literal(
                                ScalarValue::Integer(1),
                            )),
                        }],
                        next: None,
                    },
                    next: "button_b".to_owned(),
                },
            ),
            (
                "button_b".to_owned(),
                SceneNode::ButtonCreate {
                    instance_id: "jump".to_owned(),
                    template: "test.transparent".to_owned(),
                    x: None,
                    y: None,
                    width: None,
                    height: None,
                    rotation_deg: None,
                    scale_x: None,
                    scale_y: None,
                    opacity: None,
                    z: Some(4),
                    visible: true,
                    enabled: true,
                    action: ButtonClickAction {
                        sets: Vec::new(),
                        next: Some(ButtonPostAction::Jump {
                            scene: Some("button_destination".to_owned()),
                            target: "done".to_owned(),
                        }),
                    },
                    next: "end".to_owned(),
                },
            ),
            ("end".to_owned(), SceneNode::End),
        ]);

        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let started = runtime.start_new_game(&content).unwrap();
        assert_eq!(started.snapshot.world.buttons.len(), 2);
        assert_eq!(started.snapshot.world.buttons["transparent"].opacity, 0.0);

        let clicked = runtime
            .click_button(&content, "transparent", started.snapshot.revision)
            .unwrap();
        assert_eq!(clicked.snapshot.variables["score"], ScalarValue::Integer(1));
        assert!(matches!(
            runtime
                .click_button(&content, "transparent", started.snapshot.revision)
                .unwrap_err(),
            RuntimeError::StaleRevision { .. }
        ));

        let jumped = runtime
            .click_button(&content, "jump", clicked.snapshot.revision)
            .unwrap();
        assert_eq!(jumped.snapshot.location.scene_id, "button_destination");
        assert_eq!(jumped.snapshot.location.node_id, "done");
        assert!(jumped.snapshot.world.buttons.is_empty());
        assert_eq!(jumped.snapshot.variables["score"], ScalarValue::Integer(0));
        assert!(matches!(
            jumped.cues.first().map(|cue| &cue.kind),
            Some(PresentationCueKind::ClearScene { .. })
        ));
        assert!(jumped.requires_ack);
        let destination = runtime
            .presentation_complete(&content, jumped.update_id, PresentationOutcome::Completed)
            .unwrap();
        assert!(matches!(
            destination.snapshot.prompt,
            PromptSnapshot::End { .. }
        ));
    }

    #[test]
    fn replay_entry_uses_author_defaults_and_overrides_before_interpolation() {
        let mut content = catalog();
        let scene = content.scenes.get_mut("prologue").unwrap();
        let mut say = scene
            .nodes
            .values()
            .find(|node| matches!(node, SceneNode::Say { .. }))
            .unwrap()
            .clone();
        if let SceneNode::Say { text, next, .. } = &mut say {
            *text = "[var=score]/[var=route]/[var=ending_seen]".to_owned();
            *next = "done".to_owned();
        }
        scene.entry = "line".to_owned();
        scene.nodes = BTreeMap::from([
            ("line".to_owned(), say),
            ("done".to_owned(), SceneNode::End),
        ]);
        let mut profile = RuntimeEngine::new(&content)
            .unwrap()
            .profile_state(&content);
        profile
            .variables
            .insert("ending_seen".to_owned(), ScalarValue::Boolean(true));
        profile.read_dialogues.insert("prologue/line".to_owned());
        profile
            .seen_presentations
            .insert("prologue/movie".to_owned());
        profile.completed_scenes.insert("prologue".to_owned());
        let overrides = BTreeMap::from([
            ("score".to_owned(), ScalarValue::Integer(i64::MAX)),
            ("route".to_owned(), ScalarValue::Text("author".to_owned())),
        ]);
        for scene_origin in [false, true] {
            let mut replay =
                RuntimeEngine::with_replay_overrides(&content, profile.clone(), &overrides)
                    .unwrap();
            let update = if scene_origin {
                replay.start_scene_preview(&content, "prologue").unwrap()
            } else {
                replay.start_new_game(&content).unwrap()
            };
            let PromptSnapshot::Dialogue { text, is_read, .. } = update.snapshot.prompt else {
                panic!("expected dialogue")
            };
            assert_eq!(text, "9223372036854775807/author/false");
            assert!(is_read);
            assert!(replay.seen_presentations.contains("prologue/movie"));
            assert!(replay.completed_scenes.is_empty());
            assert_eq!(profile.variables["ending_seen"], ScalarValue::Boolean(true));
            assert_eq!(
                replay.start_new_game(&content).unwrap().snapshot.variables["score"],
                ScalarValue::Integer(0)
            );
        }
        let mut explicit = overrides;
        explicit.insert("ending_seen".to_owned(), ScalarValue::Boolean(true));
        let mut replay =
            RuntimeEngine::with_replay_overrides(&content, profile, &explicit).unwrap();
        let update = replay.start_scene_preview(&content, "prologue").unwrap();
        let PromptSnapshot::Dialogue { text, .. } = update.snapshot.prompt else {
            panic!("expected dialogue")
        };
        assert_eq!(text, "9223372036854775807/author/true");
    }

    #[test]
    fn chapter_map_marks_always_replayable_hotspots_as_enterable_before_completion() {
        let mut content = catalog_with_chapter_map();
        let runtime = RuntimeEngine::new(&content).unwrap();
        // The fixture's visible hotspot is not completed yet and keeps the
        // historical locked policy.
        let map = runtime.chapter_map(&content).unwrap().unwrap();
        let always = map
            .hotspots
            .iter()
            .find(|item| item.scene_id == "test_scene")
            .expect("visible hotspot");
        assert!(!always.completed);
        assert!(
            !always.replayable,
            "a completed-only hotspot must stay locked before completion"
        );

        // Switching the authored policy opens it without any story progress.
        content
            .chapter_map
            .as_mut()
            .expect("chapter map")
            .hotspots
            .iter_mut()
            .find(|item| item.scene_id == "test_scene")
            .expect("fixture hotspot")
            .replay = crate::model::ChapterMapReplay::Always;
        let map = runtime.chapter_map(&content).unwrap().unwrap();
        let opened = map
            .hotspots
            .iter()
            .find(|item| item.scene_id == "test_scene")
            .expect("visible hotspot");
        assert!(!opened.completed, "progress is still untouched");
        assert!(
            opened.replayable,
            "an always replayable hotspot is enterable before completion"
        );
    }

    #[test]
    fn chapter_map_filters_hidden_hotspots_and_reports_completion() {
        let mut content = catalog_with_chapter_map();
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let map = runtime.chapter_map(&content).unwrap().unwrap();
        assert_eq!(map.hotspots.len(), 1);
        assert_eq!(map.hotspots[0].scene_id, "test_scene");
        assert_eq!(
            map.hotspots[0].hover_text.as_deref(),
            Some("始终章节的说明")
        );
        runtime.completed_scenes.insert("prologue".to_owned());
        let map = runtime.chapter_map(&content).unwrap().unwrap();
        assert_eq!(map.hotspots.len(), 2);
        assert!(map
            .hotspots
            .iter()
            .any(|item| item.completed && item.scene_id == "prologue"));
        assert_eq!(
            map.hotspots
                .iter()
                .find(|item| item.scene_id == "prologue")
                .and_then(|item| item.hover_text.as_deref()),
            Some("完成后说明")
        );
        content.chapter_map.as_mut().expect("chapter map").hotspots[1].hover_text =
            Some(String::new());
        let map = runtime.chapter_map(&content).unwrap().unwrap();
        assert_eq!(
            map.hotspots
                .iter()
                .find(|item| item.scene_id == "test_scene")
                .and_then(|item| item.hover_text.as_deref()),
            Some("")
        );
    }

    #[test]
    fn bounded_history_remains_canonical_after_trimming() {
        let content = catalog();
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        runtime.dialogue_history = (1..=500)
            .map(|entry_id| DialogueHistoryEntry {
                entry_id,
                prompt_id: "prologue/introduction".to_owned(),
                speaker_id: None,
                speaker: None,
                name_color: None,
                text_color: None,
                text: format!("history {entry_id}"),
            })
            .collect();

        runtime.append_history(
            "prologue/introduction".to_owned(),
            None,
            None,
            None,
            None,
            "newest".to_owned(),
        );

        assert_eq!(runtime.dialogue_history.len(), 500);
        assert_eq!(runtime.dialogue_history.first().unwrap().entry_id, 1);
        assert_eq!(runtime.dialogue_history.last().unwrap().entry_id, 500);
        assert_eq!(runtime.dialogue_history.last().unwrap().text, "newest");
    }

    fn literal(value: ScalarValue) -> ValueOperand {
        ValueOperand::Literal(LiteralOperand { value })
    }

    fn variable(id: &str) -> ValueOperand {
        ValueOperand::Variable(VariableOperand {
            variable: id.to_owned(),
        })
    }

    #[test]
    fn clear_node_fades_to_an_empty_scene_owned_world() {
        let mut content = catalog();
        let scene = content.scenes.get_mut("prologue").unwrap();
        scene.nodes.insert(
            "clear_test".to_owned(),
            SceneNode::Clear {
                duration_ms: 700,
                easing: crate::model::Easing::EaseOut,
                await_completion: true,
                next: "introduction".to_owned(),
            },
        );
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        runtime.snapshot.location.node_id = "clear_test".to_owned();
        runtime.snapshot.world.background = Some("bg.classroom".to_owned());
        runtime.snapshot.world.sprites.insert(
            "alice".to_owned(),
            SpriteSnapshot {
                asset: "sprite.jelly".to_owned(),
                x: 960.0,
                y: 1080.0,
                scale: 1.0,
                scale_x: 1.0,
                scale_y: 1.0,
                rotation_deg: 0.0,
                flip_x: false,
                anchor_x: 0.5,
                anchor_y: 1.0,
                opacity: 1.0,
                z: 4,
            },
        );
        runtime.snapshot.world.camera = CameraSnapshot {
            x: 40.0,
            y: -20.0,
            zoom: 1.3,
            rotation_deg: 10.0,
        };
        runtime.snapshot.world.persistent_effects = vec!["rain".to_owned()];
        runtime.snapshot.dialogue_page = Some(DialoguePageSnapshot {
            page_id: "old_page".to_owned(),
            speaker_id: None,
            speaker: None,
            name_color: None,
            text_color: None,
            segments: vec!["旧文本".to_owned()],
        });
        runtime.append_history(
            "prologue/old".to_owned(),
            None,
            None,
            None,
            None,
            "历史应保留".to_owned(),
        );

        let cues = runtime.run_until_boundary(&content).unwrap();
        assert_eq!(runtime.snapshot.world.background, None);
        assert!(runtime.snapshot.world.sprites.is_empty());
        assert_eq!(runtime.snapshot.world.camera, CameraSnapshot::default());
        assert!(runtime.snapshot.world.persistent_effects.is_empty());
        assert_eq!(runtime.snapshot.dialogue_page, None);
        assert_eq!(runtime.dialogue_history().len(), 1);
        assert!(matches!(
            cues.as_slice(),
            [PresentationCue {
                gate: CueGate::Runtime,
                kind: PresentationCueKind::ClearScene {
                    duration_ms: 700,
                    easing: crate::model::Easing::EaseOut,
                },
                ..
            }]
        ));
    }

    #[test]
    fn cross_scene_jump_clears_visual_state_before_running_destination() {
        let mut content = catalog();
        let source = content.scenes.get_mut("prologue").unwrap();
        source.entry = "source_sprite".to_owned();
        source.nodes.insert(
            "source_sprite".to_owned(),
            SceneNode::Sprite {
                sprite_id: "alice".to_owned(),
                action: SpriteAction::Show,
                asset: Some("sprite.jelly".to_owned()),
                character: None,
                expression: None,
                flip_x: Some(false),
                crossfade_ms: None,
                x: None,
                y: None,
                scale: None,
                opacity: None,
                z: None,
                duration_ms: 0,
                easing: crate::model::Easing::Linear,
                await_completion: false,
                next: "source_line".to_owned(),
            },
        );
        source.nodes.insert(
            "source_line".to_owned(),
            SceneNode::Say {
                speaker: None,
                text: "离开当前场景。".to_owned(),
                mode: DialogueMode::Start,
                page_id: None,
                speed_cps: None,
                reveal_animation: None,
                next: "cross_scene_test".to_owned(),
            },
        );
        source.nodes.insert(
            "cross_scene_test".to_owned(),
            SceneNode::Jump {
                scene: Some("destination".to_owned()),
                target: "end".to_owned(),
            },
        );
        content.scenes.insert(
            "destination".to_owned(),
            crate::model::SceneDefinition {
                schema_version: 2,
                id: "destination".to_owned(),
                entry: "end".to_owned(),
                nodes: BTreeMap::from([("end".to_owned(), SceneNode::End)]),
            },
        );

        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let source_update = runtime.start_new_game(&content).unwrap();
        assert!(source_update.snapshot.world.sprites.contains_key("alice"));
        runtime
            .snapshot
            .variables
            .insert("score".to_owned(), ScalarValue::Integer(42));
        runtime.snapshot.audio.bgm = Some(LoopingAudioSnapshot {
            asset: "bgm.test1".to_owned(),
            volume: 0.5,
            start_ms: 250,
            loop_start_ms: None,
            loop_end_ms: None,
        });
        runtime.snapshot.playback = PlaybackSnapshot {
            auto: PlaybackAutoMode::Forced,
            ctrl_fast_forward: CtrlFastForwardMode::Block,
        };
        runtime.snapshot.world.dialogue_ui_visible = false;
        let update = runtime
            .advance(
                &content,
                source_update.snapshot.revision,
                AdvanceSource::ForcedAuto,
            )
            .unwrap();

        assert!(update.requires_ack);
        assert_eq!(
            update.snapshot.location,
            StoryLocation {
                scene_id: "destination".to_owned(),
                node_id: "end".to_owned(),
            }
        );
        assert_eq!(update.snapshot.world.background, None);
        assert!(update.snapshot.world.sprites.is_empty());
        assert!(update.snapshot.audio.bgm.is_none());
        assert_eq!(update.snapshot.playback, PlaybackSnapshot::default());
        assert!(update.snapshot.world.dialogue_ui_visible);
        assert_eq!(update.snapshot.variables["score"], ScalarValue::Integer(0));
        assert!(runtime.dialogue_history().is_empty());
        assert!(matches!(
            update.cues.as_slice(),
            [PresentationCue {
                gate: CueGate::Runtime,
                kind: PresentationCueKind::ClearScene { duration_ms: 0, .. },
                ..
            }]
        ));

        let destination = runtime
            .presentation_complete(&content, update.update_id, PresentationOutcome::Completed)
            .unwrap();
        assert!(matches!(
            destination.snapshot.prompt,
            PromptSnapshot::End { .. }
        ));
    }

    #[test]
    fn same_scene_jump_keeps_dialogue_history() {
        let mut content = catalog();
        let scene = content.scenes.get_mut("prologue").unwrap();
        scene.entry = "history_first".to_owned();
        scene.nodes.insert(
            "history_first".to_owned(),
            SceneNode::Say {
                speaker: None,
                text: "第一句".to_owned(),
                mode: DialogueMode::Start,
                page_id: None,
                speed_cps: None,
                reveal_animation: None,
                next: "history_jump".to_owned(),
            },
        );
        scene.nodes.insert(
            "history_jump".to_owned(),
            SceneNode::Jump {
                scene: None,
                target: "history_second".to_owned(),
            },
        );
        scene.nodes.insert(
            "history_second".to_owned(),
            SceneNode::Say {
                speaker: None,
                text: "第二句".to_owned(),
                mode: DialogueMode::Start,
                page_id: None,
                speed_cps: None,
                reveal_animation: None,
                next: "history_end".to_owned(),
            },
        );
        scene.nodes.insert("history_end".to_owned(), SceneNode::End);
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let first = runtime.start_new_game(&content).unwrap();
        assert_eq!(runtime.dialogue_history().len(), 1);
        let second = runtime
            .advance(&content, first.snapshot.revision, AdvanceSource::Manual)
            .unwrap();
        assert_eq!(second.snapshot.location.node_id, "history_end");
        assert_eq!(runtime.dialogue_history().len(), 2);
    }

    #[test]
    fn timeline_easing_matches_the_shared_frontend_corpus() {
        let samples: Vec<TimelineConformanceSample> =
            serde_json::from_str(include_str!("../../../shared/timeline-conformance.json"))
                .unwrap();
        for sample in samples {
            let progress = sample.time / 1000.0;
            let value = 10.0 * test_timeline_ease(progress, &sample.easing);
            assert!(
                (value - sample.expected).abs() < 0.001,
                "{}: expected {}, got {}",
                sample.name,
                sample.expected,
                value
            );
        }
    }

    #[test]
    fn editor_preview_replays_choices_to_the_timeline_breakpoint() {
        let content = catalog();
        let target = StoryLocation {
            scene_id: "prologue".to_owned(),
            node_id: "timeline_showcase".to_owned(),
        };
        let decisions = [PreviewChoiceDecision {
            scene_id: "prologue".to_owned(),
            node_id: "route_choice".to_owned(),
            visit: 1,
            choice_id: "algebra".to_owned(),
        }];
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let PreviewRunResult::Ready { snapshot, trace } =
            runtime.preview_to(&content, &target, &decisions).unwrap()
        else {
            panic!("the default demo path should reach the timeline");
        };
        assert_eq!(snapshot.location, target);
        assert!(trace
            .iter()
            .any(|location| location.node_id == "route_choice"));
        let update = runtime.preview_execute_current(&content).unwrap();
        assert!(update
            .cues
            .iter()
            .any(|cue| matches!(cue.kind, PresentationCueKind::Timeline { .. })));
    }

    #[test]
    fn editor_scene_preview_needs_only_choices_from_that_scene() {
        let content = catalog();
        let target = StoryLocation {
            scene_id: "test_scene".to_owned(),
            node_id: "move_jelly_copy".to_owned(),
        };
        let decisions = [PreviewChoiceDecision {
            scene_id: "test_scene".to_owned(),
            node_id: "choice_background_start".to_owned(),
            visit: 1,
            choice_id: "option_1".to_owned(),
        }];
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let PreviewRunResult::Ready { snapshot, trace } = runtime
            .preview_to_from_scene_entry(&content, "test_scene", &target, &decisions)
            .unwrap()
        else {
            panic!("the Scene-local choice should reach the target");
        };
        assert_eq!(snapshot.location, target);
        assert!(trace
            .iter()
            .all(|location| location.scene_id == "test_scene"));
    }

    #[test]
    fn editor_scene_preview_does_not_follow_cross_scene_paths() {
        let mut content = catalog();
        content.scenes.insert(
            "preview_boundary".to_owned(),
            SceneDefinition {
                schema_version: 2,
                id: "preview_boundary".to_owned(),
                entry: "leave".to_owned(),
                nodes: BTreeMap::from([
                    (
                        "leave".to_owned(),
                        SceneNode::Jump {
                            scene: Some("prologue".to_owned()),
                            target: "establish".to_owned(),
                        },
                    ),
                    ("target".to_owned(), SceneNode::End),
                ]),
            },
        );
        let target = StoryLocation {
            scene_id: "preview_boundary".to_owned(),
            node_id: "target".to_owned(),
        };
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let result = runtime
            .preview_to_from_scene_entry(&content, "preview_boundary", &target, &[])
            .unwrap();
        let PreviewRunResult::Unreachable { message, trace } = result else {
            panic!("a Scene preview must stop at its ownership boundary");
        };
        assert!(message.contains("路径已离开"));
        assert!(trace
            .iter()
            .all(|location| location.scene_id == "preview_boundary"));
    }

    fn test_timeline_ease(value: f32, easing: &crate::model::TimelineEasing) -> f32 {
        use crate::model::{TimelineEasing, TimelineEasingPreset};
        let value = value.clamp(0.0, 1.0);
        match easing {
            TimelineEasing::Preset(TimelineEasingPreset::Step) => {
                if value < 1.0 {
                    0.0
                } else {
                    1.0
                }
            }
            TimelineEasing::Preset(TimelineEasingPreset::Linear) => value,
            TimelineEasing::Preset(TimelineEasingPreset::EaseIn) => value * value,
            TimelineEasing::Preset(TimelineEasingPreset::EaseOut) => 1.0 - (1.0 - value).powi(2),
            TimelineEasing::Preset(TimelineEasingPreset::EaseInOut) => {
                if value < 0.5 {
                    2.0 * value * value
                } else {
                    1.0 - (-2.0 * value + 2.0).powi(2) / 2.0
                }
            }
            TimelineEasing::CubicBezier { cubic_bezier } => {
                let sample = |time: f32, first: f32, second: f32| {
                    3.0 * (1.0 - time).powi(2) * time * first
                        + 3.0 * (1.0 - time) * time.powi(2) * second
                        + time.powi(3)
                };
                let mut low = 0.0;
                let mut high = 1.0;
                let mut time = value;
                for _ in 0..14 {
                    if sample(time, cubic_bezier[0], cubic_bezier[2]) < value {
                        low = time;
                    } else {
                        high = time;
                    }
                    time = (low + high) / 2.0;
                }
                sample(time, cubic_bezier[1], cubic_bezier[3])
            }
        }
    }

    fn mutate(
        operation: VariableOperation,
        target_type: VariableType,
        current: ScalarValue,
        operand: Option<ScalarValue>,
    ) -> Result<ScalarValue, String> {
        apply_variable_operation(operation, target_type, current, operand)
    }

    #[test]
    fn every_variable_operation_and_variable_operand_is_supported() {
        assert_eq!(
            mutate(
                VariableOperation::Assign,
                VariableType::Number,
                ScalarValue::Number(0.0),
                Some(ScalarValue::Integer(4)),
            )
            .unwrap(),
            ScalarValue::Number(4.0)
        );
        assert_eq!(
            mutate(
                VariableOperation::Add,
                VariableType::Integer,
                ScalarValue::Integer(4),
                Some(ScalarValue::Integer(3)),
            )
            .unwrap(),
            ScalarValue::Integer(7)
        );
        assert_eq!(
            mutate(
                VariableOperation::Sub,
                VariableType::Number,
                ScalarValue::Number(4.5),
                Some(ScalarValue::Integer(2)),
            )
            .unwrap(),
            ScalarValue::Number(2.5)
        );
        assert_eq!(
            mutate(
                VariableOperation::Mul,
                VariableType::Integer,
                ScalarValue::Integer(6),
                Some(ScalarValue::Integer(7)),
            )
            .unwrap(),
            ScalarValue::Integer(42)
        );
        assert_eq!(
            mutate(
                VariableOperation::Mod,
                VariableType::Integer,
                ScalarValue::Integer(17),
                Some(ScalarValue::Integer(5)),
            )
            .unwrap(),
            ScalarValue::Integer(2)
        );
        assert_eq!(
            mutate(
                VariableOperation::Append,
                VariableType::String,
                ScalarValue::Text("向量".to_owned()),
                Some(ScalarValue::Text("空间".to_owned())),
            )
            .unwrap(),
            ScalarValue::Text("向量空间".to_owned())
        );
        assert_eq!(
            mutate(
                VariableOperation::Toggle,
                VariableType::Boolean,
                ScalarValue::Boolean(false),
                None,
            )
            .unwrap(),
            ScalarValue::Boolean(true)
        );

        let content = catalog();
        let runtime = RuntimeEngine::new(&content).unwrap();
        assert_eq!(
            runtime
                .resolve_mutation_value(
                    &content,
                    &MutationValue::Variable(VariableOperand {
                        variable: "score".to_owned(),
                    }),
                )
                .unwrap(),
            ScalarValue::Integer(0)
        );
    }

    #[test]
    fn variable_operation_failures_are_explicit() {
        assert!(mutate(
            VariableOperation::Add,
            VariableType::Integer,
            ScalarValue::Integer(i64::MAX),
            Some(ScalarValue::Integer(1)),
        )
        .unwrap_err()
        .contains("溢出"));
        assert!(mutate(
            VariableOperation::Mod,
            VariableType::Integer,
            ScalarValue::Integer(2),
            Some(ScalarValue::Integer(0)),
        )
        .unwrap_err()
        .contains("零"));
        assert!(mutate(
            VariableOperation::Mul,
            VariableType::Number,
            ScalarValue::Number(f64::MAX),
            Some(ScalarValue::Number(2.0)),
        )
        .unwrap_err()
        .contains("有限"));
        assert!(mutate(
            VariableOperation::Append,
            VariableType::String,
            ScalarValue::Text("a".repeat(MAX_VARIABLE_STRING_BYTES)),
            Some(ScalarValue::Text("b".to_owned())),
        )
        .unwrap_err()
        .contains("上限"));
        assert!(mutate(
            VariableOperation::Toggle,
            VariableType::Boolean,
            ScalarValue::Boolean(false),
            Some(ScalarValue::Boolean(true)),
        )
        .is_err());
    }

    #[test]
    fn dialogue_resolves_character_style_and_interpolation() {
        let content = catalog();
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        runtime.snapshot.location.node_id = "introduction".to_owned();
        runtime.run_until_boundary(&content).unwrap();
        let PromptSnapshot::Dialogue {
            speaker,
            speaker_id,
            name_color,
            text_color,
            text,
            ..
        } = &runtime.snapshot.prompt
        else {
            panic!("expected dialogue")
        };
        assert_eq!(speaker.as_deref(), Some("测试角色"));
        assert_eq!(speaker_id.as_deref(), Some("test"));
        assert_eq!(name_color.as_deref(), Some("#1D5C78"));
        assert_eq!(text_color.as_deref(), Some("#17213A"));
        assert!(text.contains("当前分数为 $0$"));

        runtime
            .profile_variables
            .insert("ending_seen".to_owned(), ScalarValue::Boolean(true));
        runtime.snapshot.variables.insert(
            "route".to_owned(),
            ScalarValue::Text("$x$[pause=1ms]".to_owned()),
        );
        assert_eq!(
            runtime
                .interpolate_text(&content, "[var=route] / [var=ending_seen]")
                .unwrap(),
            r"\$x\$\[pause=1ms] / true"
        );
    }

    #[test]
    fn dialogue_page_survives_animation_and_append_reveals_only_new_segment() {
        let mut content = catalog();
        let scene = content.scenes.get_mut("prologue").unwrap();
        scene.entry = "segment_start".to_owned();
        scene.nodes.insert(
            "segment_start".to_owned(),
            SceneNode::Say {
                speaker: None,
                text: "前半句——".to_owned(),
                mode: DialogueMode::Start,
                page_id: Some("realization".to_owned()),
                speed_cps: None,
                reveal_animation: None,
                next: "segment_effect".to_owned(),
            },
        );
        scene.nodes.insert(
            "segment_effect".to_owned(),
            SceneNode::ScreenEffect {
                effect: crate::model::ScreenEffectSpec::Shake {
                    amplitude_x: crate::model::SHAKE_AMPLITUDE_X_DEFAULT,
                    amplitude_y: crate::model::SHAKE_AMPLITUDE_Y_DEFAULT,
                    frequency_hz: crate::model::SHAKE_FREQUENCY_HZ_DEFAULT,
                    decay: crate::model::SHAKE_DECAY_DEFAULT,
                    seed: crate::model::SHAKE_SEED_DEFAULT,
                },
                duration_ms: 200,
                await_completion: true,
                next: "segment_append".to_owned(),
            },
        );
        scene.nodes.insert(
            "segment_append".to_owned(),
            SceneNode::Say {
                speaker: None,
                text: "后半句。".to_owned(),
                mode: DialogueMode::Append,
                page_id: Some("realization".to_owned()),
                speed_cps: Some(20.0),
                reveal_animation: None,
                next: "segment_end".to_owned(),
            },
        );
        scene.nodes.insert("segment_end".to_owned(), SceneNode::End);

        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let first = runtime.start_new_game(&content).unwrap();
        assert_eq!(
            first.snapshot.dialogue_page.as_ref().unwrap().segments,
            ["前半句——"]
        );
        assert!(first.cues.iter().any(|cue| matches!(
            cue.kind,
            PresentationCueKind::DialogueReveal {
                speed_cps: None,
                ..
            }
        )));

        let effect = runtime
            .advance(&content, first.snapshot.revision, AdvanceSource::Manual)
            .unwrap();
        assert!(effect.requires_ack);
        assert!(matches!(effect.snapshot.prompt, PromptSnapshot::None));
        assert_eq!(
            effect.snapshot.dialogue_page.as_ref().unwrap().segments,
            ["前半句——"]
        );

        let appended = runtime
            .presentation_complete(&content, effect.update_id, PresentationOutcome::Completed)
            .unwrap();
        assert_eq!(
            appended.snapshot.dialogue_page.as_ref().unwrap().segments,
            ["前半句——", "后半句。"]
        );
        let PromptSnapshot::Dialogue { text, .. } = &appended.snapshot.prompt else {
            panic!("expected appended dialogue prompt")
        };
        assert_eq!(text, "后半句。");
        assert!(appended.cues.iter().any(|cue| matches!(
            &cue.kind,
            PresentationCueKind::DialogueReveal { speed_cps, .. }
                if *speed_cps == Some(20.0)
        )));

        let ended = runtime
            .advance(&content, appended.snapshot.revision, AdvanceSource::Manual)
            .unwrap();
        assert!(ended.snapshot.dialogue_page.is_none());
    }

    #[test]
    fn old_dialogue_snapshots_default_new_character_fields() {
        let value = serde_json::json!({
            "kind": "dialogue",
            "prompt_id": "scene/line",
            "speaker": "临时名",
            "text": "文本"
        });
        let prompt: PromptSnapshot = serde_json::from_value(value).unwrap();
        let PromptSnapshot::Dialogue {
            speaker_id,
            name_color,
            text_color,
            is_read,
            ..
        } = prompt
        else {
            panic!("expected dialogue")
        };
        assert_eq!((speaker_id, name_color, text_color), (None, None, None));
        assert!(!is_read);
    }

    #[test]
    fn loading_an_old_dialogue_snapshot_rebuilds_the_stable_page() {
        let content = catalog();
        let mut source = RuntimeEngine::new(&content).unwrap();
        source.snapshot.location.node_id = "introduction".to_owned();
        source.run_until_boundary(&content).unwrap();
        let current = source.snapshot.clone();
        assert!(matches!(current.prompt, PromptSnapshot::Dialogue { .. }));
        let mut value = serde_json::to_value(current).unwrap();
        value.as_object_mut().unwrap().remove("dialogue_page");
        let legacy: RuntimeSnapshot = serde_json::from_value(value).unwrap();
        assert!(legacy.dialogue_page.is_none());

        let mut target = RuntimeEngine::new(&content).unwrap();
        let loaded = target.load_snapshot(&content, legacy).unwrap();
        let page = loaded.snapshot.dialogue_page.unwrap();
        let PromptSnapshot::Dialogue { text, .. } = loaded.snapshot.prompt else {
            panic!("expected dialogue prompt")
        };
        assert_eq!(page.segments, [text]);
    }

    #[test]
    fn long_text_keeps_a_stable_paper_until_its_final_step() {
        let mut content = catalog();
        let scene = content.scenes.get_mut("prologue").unwrap();
        scene.entry = "long_text_test".to_owned();
        scene.nodes.insert(
            "long_text_test".to_owned(),
            SceneNode::LongText {
                document: None,
                mode: LongTextMode::Start,
                on_exit: LongTextExit::Close,
                paper: None,
                pagination: Some(crate::model::LongTextPagination::Manual),
                font_size: Some(36.0),
                text_color: Some(crate::model::LONG_TEXT_COLOR_DEFAULT.to_owned()),
                layout: Some(crate::model::LongTextLayout::default()),
                steps: vec![
                    crate::model::LongTextStep {
                        id: "definition".to_owned(),
                        text: "设 $V$ 是一个向量空间。".to_owned(),
                        page_break_before: false,
                    },
                    crate::model::LongTextStep {
                        id: "consequence".to_owned(),
                        text: "因此 $0\\in V$。".to_owned(),
                        page_break_before: true,
                    },
                ],
                speed_cps: Some(24.0),
                reveal_animation: None,
                next: "conclusion".to_owned(),
            },
        );

        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let first = runtime.start_new_game(&content).unwrap();
        let PromptSnapshot::LongText {
            prompt_id,
            step_id,
            step_index,
            is_read,
            ..
        } = &first.snapshot.prompt
        else {
            panic!("expected first long-text step")
        };
        assert_eq!(prompt_id, "prologue/long_text_test/definition");
        assert_eq!(step_id, "definition");
        assert_eq!(*step_index, 0);
        assert!(!is_read);
        assert_eq!(first.snapshot.location.node_id, "long_text_test");
        assert_eq!(
            first.snapshot.long_text_page.as_ref().unwrap().steps.len(),
            1
        );
        assert!(first.cues.iter().any(|cue| matches!(
            cue.kind,
            PresentationCueKind::LongTextReveal { speed_cps, .. }
                if speed_cps == Some(24.0)
        )));

        let second = runtime
            .advance(&content, first.snapshot.revision, AdvanceSource::Manual)
            .unwrap();
        let PromptSnapshot::LongText {
            prompt_id,
            step_id,
            step_index,
            ..
        } = &second.snapshot.prompt
        else {
            panic!("expected second long-text step")
        };
        assert_eq!(prompt_id, "prologue/long_text_test/consequence");
        assert_eq!(step_id, "consequence");
        assert_eq!(*step_index, 1);
        let page = second.snapshot.long_text_page.as_ref().unwrap();
        assert_eq!(page.steps.len(), 2);
        assert_eq!(page.font_size, 36.0);
        assert_eq!(page.pagination, crate::model::LongTextPagination::Manual);
        assert!(page.steps[1].page_break_before);
        assert!(runtime
            .read_dialogues
            .contains("prologue/long_text_test/definition"));

        let saved = second.snapshot.clone();
        let profile = runtime.profile_state(&content);
        let mut restored = RuntimeEngine::with_profile(&content, profile).unwrap();
        let loaded = restored.load_snapshot(&content, saved).unwrap();
        assert!(loaded.cues.is_empty());
        assert!(!loaded.requires_ack);
        assert!(matches!(
            loaded.snapshot.prompt,
            PromptSnapshot::LongText { is_read: false, .. }
        ));

        let completed = runtime
            .advance(&content, second.snapshot.revision, AdvanceSource::Manual)
            .unwrap();
        assert!(completed.snapshot.long_text_page.is_none());
        assert!(matches!(
            completed.snapshot.prompt,
            PromptSnapshot::Dialogue { .. }
        ));
        assert!(runtime
            .read_dialogues
            .contains("prologue/long_text_test/consequence"));
        assert_eq!(
            runtime
                .dialogue_history()
                .iter()
                .filter(|entry| entry.prompt_id.starts_with("prologue/long_text_test/"))
                .count(),
            2
        );
    }

    #[test]
    fn long_text_can_be_continued_after_an_intervening_dialogue() {
        let mut content = catalog();
        let scene = content.scenes.get_mut("prologue").unwrap();
        scene.entry = "lesson_start".to_owned();
        scene.nodes = BTreeMap::from([
            (
                "lesson_start".to_owned(),
                SceneNode::LongText {
                    document: Some("lesson".to_owned()),
                    mode: LongTextMode::Start,
                    on_exit: LongTextExit::Hide,
                    paper: None,
                    pagination: Some(crate::model::LongTextPagination::Manual),
                    font_size: Some(32.0),
                    text_color: Some(crate::model::LONG_TEXT_COLOR_DEFAULT.to_owned()),
                    layout: Some(crate::model::LongTextLayout::default()),
                    steps: vec![crate::model::LongTextStep {
                        id: "statement".to_owned(),
                        text: "命题。".to_owned(),
                        page_break_before: false,
                    }],
                    speed_cps: None,
                    reveal_animation: None,
                    next: "interlude".to_owned(),
                },
            ),
            (
                "interlude".to_owned(),
                SceneNode::Say {
                    speaker: None,
                    text: "先看一个图。".to_owned(),
                    mode: DialogueMode::Start,
                    page_id: None,
                    speed_cps: None,
                    reveal_animation: None,
                    next: "lesson_continue".to_owned(),
                },
            ),
            (
                "lesson_continue".to_owned(),
                SceneNode::LongText {
                    document: Some("lesson".to_owned()),
                    mode: LongTextMode::Continue,
                    on_exit: LongTextExit::KeepVisible,
                    paper: None,
                    pagination: None,
                    font_size: None,
                    text_color: None,
                    layout: None,
                    steps: vec![crate::model::LongTextStep {
                        id: "proof".to_owned(),
                        text: "证明。".to_owned(),
                        page_break_before: true,
                    }],
                    speed_cps: None,
                    reveal_animation: None,
                    next: "end".to_owned(),
                },
            ),
            ("end".to_owned(), SceneNode::End),
        ]);

        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let first = runtime.start_new_game(&content).unwrap();
        assert_eq!(
            first.snapshot.long_text_page.as_ref().unwrap().steps.len(),
            1
        );
        let interlude = runtime
            .advance(&content, first.snapshot.revision, AdvanceSource::Manual)
            .unwrap();
        assert!(interlude
            .snapshot
            .long_text_page
            .as_ref()
            .is_some_and(|page| !page.visible));
        let continuation = runtime
            .advance(&content, interlude.snapshot.revision, AdvanceSource::Manual)
            .unwrap();
        assert!(matches!(
            continuation.snapshot.prompt,
            PromptSnapshot::LongText { .. }
        ));
        let page = continuation.snapshot.long_text_page.as_ref().unwrap();
        assert!(page.visible);
        assert_eq!(
            page.steps
                .iter()
                .map(|step| step.step_id.as_str())
                .collect::<Vec<_>>(),
            ["statement", "proof"]
        );
        assert_eq!(page.active_step_index, 1);

        // The prompt's step_index is local to the continuation node (zero),
        // while the retained page points at the second cumulative step (one).
        // Loading this snapshot must validate both indexes independently.
        let saved = continuation.snapshot.clone();
        let profile = runtime.profile_state(&content);
        let mut restored = RuntimeEngine::with_profile(&content, profile).unwrap();
        let loaded = restored.load_snapshot(&content, saved).unwrap();
        assert!(loaded.cues.is_empty());
        assert_eq!(
            loaded
                .snapshot
                .long_text_page
                .as_ref()
                .unwrap()
                .active_step_index,
            1
        );
        assert!(matches!(
            loaded.snapshot.prompt,
            PromptSnapshot::LongText { step_index: 0, .. }
        ));
    }

    #[test]
    fn revisiting_a_continuation_reuses_resolved_text_without_appending() {
        let mut content = catalog();
        content.manifest.variables.insert(
            "lecture_score".to_owned(),
            crate::model::VariableDefinition {
                scope: VariableScope::Save,
                value_type: VariableType::Integer,
                default: ScalarValue::Integer(0),
            },
        );
        let scene = content.scenes.get_mut("prologue").unwrap();
        scene.entry = "start_lecture".to_owned();
        scene.nodes = BTreeMap::from([
            (
                "start_lecture".to_owned(),
                SceneNode::LongText {
                    document: Some("lesson".to_owned()),
                    mode: LongTextMode::Start,
                    on_exit: LongTextExit::KeepVisible,
                    paper: None,
                    pagination: Some(crate::model::LongTextPagination::Auto),
                    font_size: Some(32.0),
                    text_color: Some(crate::model::LONG_TEXT_COLOR_DEFAULT.to_owned()),
                    layout: Some(crate::model::LongTextLayout::default()),
                    steps: vec![crate::model::LongTextStep {
                        id: "statement".to_owned(),
                        text: "分数是 [var=lecture_score]。".to_owned(),
                        page_break_before: false,
                    }],
                    speed_cps: None,
                    reveal_animation: None,
                    next: "increase".to_owned(),
                },
            ),
            (
                "increase".to_owned(),
                SceneNode::Set {
                    variable: "lecture_score".to_owned(),
                    op: VariableOperation::Add,
                    value: Some(MutationValue::Literal(ScalarValue::Integer(1))),
                    next: "continue_lecture".to_owned(),
                },
            ),
            (
                "continue_lecture".to_owned(),
                SceneNode::LongText {
                    document: Some("lesson".to_owned()),
                    mode: LongTextMode::Continue,
                    on_exit: LongTextExit::KeepVisible,
                    paper: None,
                    pagination: None,
                    font_size: None,
                    text_color: None,
                    layout: None,
                    steps: vec![crate::model::LongTextStep {
                        id: "proof".to_owned(),
                        text: "证明时分数仍是 [var=lecture_score]。".to_owned(),
                        page_break_before: false,
                    }],
                    speed_cps: None,
                    reveal_animation: None,
                    next: "revisit".to_owned(),
                },
            ),
            (
                "revisit".to_owned(),
                SceneNode::Jump {
                    scene: None,
                    target: "continue_lecture".to_owned(),
                },
            ),
        ]);

        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let first = runtime.start_new_game(&content).unwrap();
        let second = runtime
            .advance(&content, first.snapshot.revision, AdvanceSource::Manual)
            .unwrap();
        let PromptSnapshot::LongText { text, .. } = &second.snapshot.prompt else {
            panic!("expected continuation prompt")
        };
        assert_eq!(text, "证明时分数仍是 1。");
        assert_eq!(
            second.snapshot.long_text_page.as_ref().unwrap().steps.len(),
            2
        );

        let revisited = runtime
            .advance(&content, second.snapshot.revision, AdvanceSource::Manual)
            .unwrap();
        let PromptSnapshot::LongText { text, is_read, .. } = &revisited.snapshot.prompt else {
            panic!("expected re-entered continuation prompt")
        };
        assert_eq!(
            text, "证明时分数仍是 1。",
            "stored text must not be re-interpolated"
        );
        assert!(*is_read, "a previously completed step is read on revisit");
        assert_eq!(
            revisited
                .snapshot
                .long_text_page
                .as_ref()
                .unwrap()
                .steps
                .len(),
            2
        );
    }

    #[test]
    fn long_text_controls_toggle_visibility_and_close_the_retained_page() {
        let mut content = catalog();
        let scene = content.scenes.get_mut("prologue").unwrap();
        scene.entry = "start_lecture".to_owned();
        scene.nodes = BTreeMap::from([
            (
                "start_lecture".to_owned(),
                SceneNode::LongText {
                    document: Some("lesson".to_owned()),
                    mode: LongTextMode::Start,
                    on_exit: LongTextExit::KeepVisible,
                    paper: None,
                    pagination: Some(crate::model::LongTextPagination::Auto),
                    font_size: Some(32.0),
                    text_color: Some(crate::model::LONG_TEXT_COLOR_DEFAULT.to_owned()),
                    layout: Some(crate::model::LongTextLayout::default()),
                    steps: vec![crate::model::LongTextStep {
                        id: "statement".to_owned(),
                        text: "命题".to_owned(),
                        page_break_before: false,
                    }],
                    speed_cps: None,
                    reveal_animation: None,
                    next: "hide".to_owned(),
                },
            ),
            (
                "hide".to_owned(),
                SceneNode::LongTextControl {
                    document: "lesson".to_owned(),
                    action: LongTextControlAction::Hide,
                    next: "show".to_owned(),
                },
            ),
            (
                "show".to_owned(),
                SceneNode::LongTextControl {
                    document: "lesson".to_owned(),
                    action: LongTextControlAction::Show,
                    next: "observe".to_owned(),
                },
            ),
            (
                "observe".to_owned(),
                SceneNode::Say {
                    speaker: None,
                    text: "文稿已重新显示。".to_owned(),
                    mode: DialogueMode::Start,
                    page_id: None,
                    speed_cps: None,
                    reveal_animation: None,
                    next: "close".to_owned(),
                },
            ),
            (
                "close".to_owned(),
                SceneNode::LongTextControl {
                    document: "lesson".to_owned(),
                    action: LongTextControlAction::Close,
                    next: "end".to_owned(),
                },
            ),
            ("end".to_owned(), SceneNode::End),
        ]);

        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let first = runtime.start_new_game(&content).unwrap();
        let say = runtime
            .advance(&content, first.snapshot.revision, AdvanceSource::Manual)
            .unwrap();
        let page = say.snapshot.long_text_page.as_ref().unwrap();
        assert!(page.visible, "show must win over the preceding hide");
        assert!(matches!(
            say.snapshot.prompt,
            PromptSnapshot::Dialogue { .. }
        ));
        let ended = runtime
            .advance(&content, say.snapshot.revision, AdvanceSource::Manual)
            .unwrap();
        assert!(ended.snapshot.long_text_page.is_none());
        assert!(matches!(ended.snapshot.prompt, PromptSnapshot::End { .. }));
    }

    #[test]
    fn old_long_text_pages_default_to_automatic_pagination() {
        let page: LongTextPageSnapshot = serde_json::from_value(serde_json::json!({
            "document_id": "prologue/lecture",
            "paper": null,
            "steps": [{
                "step_id": "definition",
                "text": "定义",
                "page_break_before": false
            }],
            "active_step_index": 0
        }))
        .unwrap();

        assert_eq!(page.pagination, crate::model::LongTextPagination::Auto);
        assert_eq!(page.font_size, crate::model::LONG_TEXT_FONT_SIZE_DEFAULT);
    }

    #[test]
    fn feature_lab_yaml_exercises_presentation_text_and_cross_scene_boundaries() {
        let mut content = catalog();
        content.manifest.entry_scene = "feature_lab".to_owned();
        let mut runtime = RuntimeEngine::new(&content).unwrap();

        let opening = runtime.start_new_game(&content).unwrap();
        assert!(opening.requires_ack);
        assert_eq!(opening.snapshot.location.node_id, "timeline");
        assert_eq!(
            opening.snapshot.world.background.as_deref(),
            Some("bg.nvctsp")
        );
        assert_eq!(opening.snapshot.world.sprites["lab"].x, 600.0);
        assert_eq!(opening.snapshot.world.camera.zoom, 1.1);
        assert_eq!(opening.snapshot.audio.bgm.as_ref().unwrap().volume, 0.25);
        assert_eq!(
            opening
                .snapshot
                .world
                .ui_motion_bindings
                .dialogue_show
                .as_deref(),
            Some("ui.dialogue.emphasis")
        );
        assert!(opening
            .cues
            .iter()
            .any(|cue| matches!(cue.kind, PresentationCueKind::BackgroundTransition { .. })));
        assert!(opening
            .cues
            .iter()
            .any(|cue| matches!(cue.kind, PresentationCueKind::PlaySfx { .. })));
        assert!(opening
            .cues
            .iter()
            .any(|cue| matches!(cue.kind, PresentationCueKind::UiMotion { .. })));

        let timeline = runtime
            .presentation_complete(&content, opening.update_id, PresentationOutcome::Completed)
            .unwrap();
        assert!(timeline.requires_ack);
        assert_eq!(timeline.snapshot.location.node_id, "wait_after_timeline");
        assert_eq!(timeline.snapshot.world.sprites["lab"].x, 800.0);
        assert_eq!(timeline.snapshot.world.sprites["lab"].scale, 1.2);
        assert_eq!(timeline.snapshot.world.camera.x, 0.0);
        assert_eq!(timeline.snapshot.audio.bgm.as_ref().unwrap().volume, 0.4);
        assert!(timeline.cues.iter().any(|cue| matches!(
            cue.kind,
            PresentationCueKind::Timeline {
                duration_ms: 100,
                skippable: true,
                ..
            }
        )));

        let waiting = runtime
            .presentation_complete(&content, timeline.update_id, PresentationOutcome::Completed)
            .unwrap();
        assert!(waiting.requires_ack);
        assert!(runtime.seen_presentations.contains("feature_lab/timeline"));
        assert!(waiting
            .cues
            .iter()
            .any(|cue| matches!(cue.kind, PresentationCueKind::Delay { duration_ms: 10 })));

        let first_page = runtime
            .presentation_complete(&content, waiting.update_id, PresentationOutcome::Completed)
            .unwrap();
        let PromptSnapshot::Dialogue { text, .. } = &first_page.snapshot.prompt else {
            panic!("expected the first dialogue page")
        };
        assert_eq!(text, "第一段，变量为 0。");
        assert!(!first_page.requires_ack);

        let appended = runtime
            .advance(
                &content,
                first_page.snapshot.revision,
                AdvanceSource::Manual,
            )
            .unwrap();
        assert_eq!(
            appended.snapshot.dialogue_page.as_ref().unwrap().segments,
            vec!["第一段，变量为 0。", "第二段，公式 $1+1=2$。"]
        );

        let first_long_text = runtime
            .advance(&content, appended.snapshot.revision, AdvanceSource::Manual)
            .unwrap();
        let PromptSnapshot::LongText { step_id, .. } = &first_long_text.snapshot.prompt else {
            panic!("expected first long-text step")
        };
        assert_eq!(step_id, "definition");
        assert_eq!(
            first_long_text
                .snapshot
                .long_text_page
                .as_ref()
                .unwrap()
                .steps
                .len(),
            1
        );

        let second_long_text = runtime
            .advance(
                &content,
                first_long_text.snapshot.revision,
                AdvanceSource::Manual,
            )
            .unwrap();
        assert_eq!(
            second_long_text
                .snapshot
                .long_text_page
                .as_ref()
                .unwrap()
                .steps
                .len(),
            2
        );

        let choice = runtime
            .advance(
                &content,
                second_long_text.snapshot.revision,
                AdvanceSource::Manual,
            )
            .unwrap();
        assert_eq!(choice.snapshot.variables["score"], ScalarValue::Integer(2));
        assert_eq!(
            runtime.profile_variables["ending_seen"],
            ScalarValue::Boolean(true)
        );
        let PromptSnapshot::Choice { choices, .. } = &choice.snapshot.prompt else {
            panic!("expected feature-lab choice")
        };
        assert_eq!(choices.len(), 2);
        assert!(
            !choices
                .iter()
                .find(|choice| choice.id == "disabled")
                .unwrap()
                .enabled
        );
        assert!(
            choices
                .iter()
                .find(|choice| choice.id == "proceed")
                .unwrap()
                .enabled
        );

        let leaving = runtime
            .choose(&content, "proceed", choice.snapshot.revision)
            .unwrap();
        assert!(leaving.requires_ack);
        assert_eq!(leaving.snapshot.location.scene_id, "test_scene");
        assert!(runtime.completed_scenes.contains("feature_lab"));
        assert!(leaving.cues.iter().any(|cue| matches!(
            cue.kind,
            PresentationCueKind::ClearScene { duration_ms: 0, .. }
        )));

        let ending = runtime
            .presentation_complete(&content, leaving.update_id, PresentationOutcome::Completed)
            .unwrap();
        assert!(matches!(ending.snapshot.prompt, PromptSnapshot::End { .. }));
        assert!(runtime.completed_scenes.contains("test_scene"));
        assert!(runtime.dialogue_history().is_empty());
    }

    fn interactive_dialogue(content: &ContentCatalog) -> RuntimeEngine {
        let mut runtime = RuntimeEngine::new(content).unwrap();
        runtime.started = true;
        runtime.snapshot.revision = 7;
        runtime.snapshot.location.node_id = "ending".to_owned();
        runtime.snapshot.prompt = PromptSnapshot::Dialogue {
            prompt_id: "prologue/test_line".to_owned(),
            speaker_id: None,
            speaker: None,
            name_color: None,
            text_color: None,
            text: "test".to_owned(),
            is_read: false,
        };
        runtime
    }

    #[test]
    fn advance_sources_follow_the_authoritative_playback_policy() {
        let content = catalog();
        for source in [
            AdvanceSource::Manual,
            AdvanceSource::Auto,
            AdvanceSource::FastForward,
        ] {
            let mut runtime = interactive_dialogue(&content);
            assert!(runtime.advance(&content, 7, source).is_ok(), "{source:?}");
        }
        let mut normal = interactive_dialogue(&content);
        assert!(matches!(
            normal.advance(&content, 7, AdvanceSource::ForcedAuto),
            Err(RuntimeError::AdvanceNotAllowed)
        ));

        for source in [
            AdvanceSource::Manual,
            AdvanceSource::Auto,
            AdvanceSource::FastForward,
        ] {
            let mut runtime = interactive_dialogue(&content);
            runtime.snapshot.playback.auto = PlaybackAutoMode::Forced;
            assert!(matches!(
                runtime.advance(&content, 7, source),
                Err(RuntimeError::AdvanceNotAllowed)
            ));
        }
        let mut forced = interactive_dialogue(&content);
        forced.snapshot.playback.auto = PlaybackAutoMode::Forced;
        assert!(forced
            .advance(&content, 7, AdvanceSource::ForcedAuto)
            .is_ok());

        let mut blocked = interactive_dialogue(&content);
        blocked.snapshot.playback.ctrl_fast_forward = CtrlFastForwardMode::Block;
        assert!(matches!(
            blocked.advance(&content, 7, AdvanceSource::FastForward),
            Err(RuntimeError::AdvanceNotAllowed)
        ));
    }

    #[test]
    fn playback_nodes_apply_state_and_read_status_survives_new_game_and_load() {
        let mut content = catalog();
        let scene = content.scenes.get_mut("prologue").unwrap();
        scene.nodes.insert(
            "playback_policy_test".to_owned(),
            SceneNode::Playback {
                auto: PlaybackAutoMode::Forced,
                ctrl_fast_forward: CtrlFastForwardMode::Block,
                next: "playback_dialogue_test".to_owned(),
            },
        );
        scene.nodes.insert(
            "playback_dialogue_test".to_owned(),
            SceneNode::Say {
                speaker: None,
                text: "固定的测试对话".to_owned(),
                mode: DialogueMode::Start,
                page_id: None,
                speed_cps: None,
                reveal_animation: None,
                next: "conclusion".to_owned(),
            },
        );
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        runtime.started = true;
        runtime.snapshot.location.node_id = "playback_policy_test".to_owned();
        runtime.run_until_boundary(&content).unwrap();
        assert_eq!(runtime.snapshot.playback.auto, PlaybackAutoMode::Forced);
        assert_eq!(
            runtime.snapshot.playback.ctrl_fast_forward,
            CtrlFastForwardMode::Block
        );
        let unread_snapshot = runtime.snapshot.clone();
        let PromptSnapshot::Dialogue { is_read, .. } = runtime.snapshot.prompt else {
            panic!("expected dialogue")
        };
        assert!(!is_read);

        runtime
            .advance(&content, 0, AdvanceSource::ForcedAuto)
            .unwrap();
        assert!(runtime
            .read_dialogues
            .contains("prologue/playback_dialogue_test"));
        runtime.start_new_game(&content).unwrap();
        let loaded = runtime.load_snapshot(&content, unread_snapshot).unwrap();
        let PromptSnapshot::Dialogue { is_read, text, .. } = loaded.snapshot.prompt else {
            panic!("expected loaded dialogue")
        };
        assert!(is_read);
        assert!(text.contains("固定的"));
    }

    #[test]
    fn old_runtime_snapshots_default_playback_policy() {
        let content = catalog();
        let snapshot = initial_snapshot(&content).unwrap();
        let mut value = serde_json::to_value(snapshot).unwrap();
        value.as_object_mut().unwrap().remove("playback");
        let decoded: RuntimeSnapshot = serde_json::from_value(value).unwrap();
        assert_eq!(decoded.playback, PlaybackSnapshot::default());
    }

    #[test]
    fn old_runtime_snapshots_default_to_no_curtain() {
        let content = catalog();
        let snapshot = initial_snapshot(&content).unwrap();
        let mut value = serde_json::to_value(snapshot).unwrap();
        assert!(value["world"]["curtain"].is_object());
        value["world"].as_object_mut().unwrap().remove("curtain");
        let decoded: RuntimeSnapshot = serde_json::from_value(value).unwrap();
        assert_eq!(decoded.world.curtain, CurtainSnapshot::default());
    }

    #[test]
    fn narrator_temporary_names_and_resolved_snapshot_text_are_stable() {
        let mut content = catalog();
        let scene = content.scenes.get_mut("prologue").unwrap();
        let SceneNode::Say { text, .. } = scene.nodes.get_mut("conclusion").unwrap() else {
            panic!("expected dialogue fixture")
        };
        *text = "seen=[var=ending_seen]".to_owned();

        let mut runtime = RuntimeEngine::new(&content).unwrap();
        runtime.snapshot.location.node_id = "conclusion".to_owned();
        runtime.run_until_boundary(&content).unwrap();
        let before = runtime.snapshot.prompt.clone();
        let PromptSnapshot::Dialogue {
            speaker,
            speaker_id,
            name_color,
            text_color,
            text,
            ..
        } = &before
        else {
            panic!("expected dialogue")
        };
        assert_eq!(speaker.as_deref(), Some("系统"));
        assert_eq!((speaker_id, name_color, text_color), (&None, &None, &None));
        assert_eq!(text, "seen=false");

        runtime
            .profile_variables
            .insert("ending_seen".to_owned(), ScalarValue::Boolean(true));
        assert_eq!(runtime.snapshot.prompt, before);

        let SceneNode::Say { speaker, .. } = content
            .scenes
            .get_mut("prologue")
            .unwrap()
            .nodes
            .get_mut("conclusion")
            .unwrap()
        else {
            panic!("expected dialogue fixture")
        };
        *speaker = None;
        let mut narrator = RuntimeEngine::new(&content).unwrap();
        narrator.snapshot.location.node_id = "conclusion".to_owned();
        narrator.run_until_boundary(&content).unwrap();
        let PromptSnapshot::Dialogue {
            speaker,
            speaker_id,
            ..
        } = &narrator.snapshot.prompt
        else {
            panic!("expected dialogue")
        };
        assert_eq!((speaker, speaker_id), (&None, &None));
    }

    #[test]
    fn stale_revision_cannot_skip_dialogue() {
        let content = catalog();
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let first = runtime.start_new_game(&content).unwrap();
        if first.requires_ack {
            let next = runtime
                .presentation_complete(&content, first.update_id, PresentationOutcome::Completed)
                .unwrap();
            assert!(matches!(
                next.snapshot.prompt,
                PromptSnapshot::Dialogue { .. }
            ));
            assert!(matches!(
                runtime.advance(&content, first.snapshot.revision, AdvanceSource::Manual,),
                Err(RuntimeError::StaleRevision { .. })
            ));
        }
    }

    #[test]
    fn dialogue_ui_uses_the_snapshot_binding_and_embeds_the_resolved_preset() {
        let content = catalog();
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        assert_eq!(
            runtime
                .snapshot
                .world
                .ui_motion_bindings
                .dialogue_show
                .as_deref(),
            Some("ui.dialogue.slide_in")
        );

        let first = runtime.start_new_game(&content).unwrap();
        let dialogue = runtime
            .presentation_complete(&content, first.update_id, PresentationOutcome::Completed)
            .unwrap();
        assert!(matches!(
            dialogue.snapshot.prompt,
            PromptSnapshot::Dialogue { .. }
        ));
        assert!(dialogue.cues.iter().any(|cue| matches!(
            &cue.kind,
            PresentationCueKind::DialogueUiTransition {
                motion: Some(motion),
                ..
            } if motion.id == "ui.dialogue.slide_in"
        )));
    }

    #[test]
    fn snapshots_round_trip_as_json() {
        let content = catalog();
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        runtime.snapshot.location.node_id = "introduction".to_owned();
        runtime.run_until_boundary(&content).unwrap();
        let json = serde_json::to_string(runtime.snapshot()).unwrap();
        let decoded: RuntimeSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, *runtime.snapshot());
    }

    #[test]
    fn bootstrap_and_load_never_replay_cues() {
        let content = catalog();
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        assert!(runtime.bootstrap(&content).update.cues.is_empty());

        let started = runtime.start_new_game(&content).unwrap();
        let target = started.snapshot;
        let loaded = runtime.load_snapshot(&content, target).unwrap();
        assert!(loaded.cues.is_empty());
        assert!(!loaded.requires_ack);
    }

    #[test]
    fn a_runtime_gate_blocks_story_commands_until_exact_ack() {
        let content = catalog();
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let update = runtime.start_new_game(&content).unwrap();
        assert!(update.requires_ack);
        assert!(matches!(
            runtime.advance(&content, update.snapshot.revision, AdvanceSource::Manual,),
            Err(RuntimeError::PresentationPending(_))
        ));
        assert!(matches!(
            runtime.presentation_complete(
                &content,
                update.update_id + 1,
                PresentationOutcome::Completed,
            ),
            Err(RuntimeError::InvalidAcknowledgement { .. })
        ));
        assert!(runtime
            .presentation_complete(&content, update.update_id, PresentationOutcome::Completed,)
            .is_ok());
    }

    #[test]
    fn cue_wire_format_is_flat_and_explicit() {
        let cue = PresentationCue {
            cue_id: 9,
            gate: CueGate::PlayerAdvance,
            kind: PresentationCueKind::DialogueReveal {
                prompt_id: "scene/line".to_owned(),
                speed_cps: Some(30.0),
                reveal_animation: None,
            },
        };
        let value = serde_json::to_value(cue).unwrap();
        assert_eq!(value["type"], "dialogue_reveal");
        assert_eq!(value["gate"], "player_advance");
        assert_eq!(value["cue_id"], 9);
        assert!(value.get("kind").is_none());

        let default_speed = PresentationCue {
            cue_id: 10,
            gate: CueGate::PlayerAdvance,
            kind: PresentationCueKind::DialogueReveal {
                prompt_id: "scene/default-speed".to_owned(),
                speed_cps: None,
                reveal_animation: None,
            },
        };
        let value = serde_json::to_value(default_speed).unwrap();
        assert!(value["speed_cps"].is_null());
    }

    #[test]
    fn timeline_commits_final_state_and_tracks_seen_outcomes() {
        let content = catalog();
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        runtime.started = true;
        runtime.snapshot.audio.bgm = Some(LoopingAudioSnapshot {
            asset: "bgm.test1".to_owned(),
            volume: 0.5,
            start_ms: 0,
            loop_start_ms: None,
            loop_end_ms: None,
        });
        runtime.snapshot.location.node_id = "timeline_showcase".to_owned();
        let cues = runtime.run_until_boundary(&content).unwrap();
        let update = runtime.finish_update(cues, true);
        assert!(update.requires_ack);
        assert_eq!(update.snapshot.world.sprites["omo"].x, 1380.0);
        assert_eq!(update.snapshot.world.camera.rotation_deg, 0.0);
        assert_eq!(update.snapshot.audio.bgm.as_ref().unwrap().volume, 0.35);
        let PresentationCueKind::Timeline {
            presentation_id,
            is_seen,
            ..
        } = &update.cues[0].kind
        else {
            panic!("expected timeline cue")
        };
        assert_eq!(presentation_id, "prologue/timeline_showcase");
        assert!(!is_seen);

        let video_update = runtime
            .presentation_complete(&content, update.update_id, PresentationOutcome::Completed)
            .unwrap();
        assert!(video_update.requires_ack);
        assert!(runtime
            .seen_presentations
            .contains("prologue/timeline_showcase"));
    }

    #[test]
    fn every_comparison_and_boolean_operator_is_evaluated() {
        let content = catalog();
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        runtime
            .snapshot
            .variables
            .insert("score".to_owned(), ScalarValue::Integer(10));
        runtime
            .snapshot
            .variables
            .insert("route".to_owned(), ScalarValue::Text("algebra".to_owned()));

        let comparisons = [
            (
                ConditionExpression::Eq {
                    left: variable("score"),
                    right: literal(ScalarValue::Number(10.0)),
                },
                true,
            ),
            (
                ConditionExpression::Ne {
                    left: variable("route"),
                    right: literal(ScalarValue::Text("geometry".to_owned())),
                },
                true,
            ),
            (
                ConditionExpression::Lt {
                    left: literal(ScalarValue::Integer(9)),
                    right: variable("score"),
                },
                true,
            ),
            (
                ConditionExpression::Le {
                    left: variable("score"),
                    right: literal(ScalarValue::Integer(10)),
                },
                true,
            ),
            (
                ConditionExpression::Gt {
                    left: variable("score"),
                    right: literal(ScalarValue::Integer(1)),
                },
                true,
            ),
            (
                ConditionExpression::Ge {
                    left: variable("score"),
                    right: literal(ScalarValue::Number(10.0)),
                },
                true,
            ),
        ];
        for (condition, expected) in comparisons {
            assert_eq!(
                runtime.evaluate_condition(&content, &condition).unwrap(),
                expected
            );
        }

        let nested = ConditionExpression::And {
            conditions: vec![
                ConditionExpression::Or {
                    conditions: vec![
                        ConditionExpression::Eq {
                            left: variable("score"),
                            right: literal(ScalarValue::Integer(0)),
                        },
                        ConditionExpression::Eq {
                            left: variable("score"),
                            right: literal(ScalarValue::Integer(10)),
                        },
                    ],
                },
                ConditionExpression::Not {
                    condition: Box::new(ConditionExpression::Eq {
                        left: variable("route"),
                        right: literal(ScalarValue::Text("geometry".to_owned())),
                    }),
                },
            ],
        };
        assert!(runtime.evaluate_condition(&content, &nested).unwrap());
    }

    #[test]
    fn mixed_integer_number_comparison_preserves_i64_precision() {
        use std::cmp::Ordering;

        // Both values round to the same f64. Comparing through `as f64`
        // would incorrectly report equality for the exact integer pair.
        assert_eq!(
            compare_numeric(
                &ScalarValue::Integer(9_007_199_254_740_993),
                &ScalarValue::Number(9_007_199_254_740_992.0),
            )
            .unwrap(),
            Ordering::Greater
        );
        assert_eq!(
            compare_numeric(
                &ScalarValue::Integer(i64::MAX),
                &ScalarValue::Number(9_223_372_036_854_775_808.0),
            )
            .unwrap(),
            Ordering::Less
        );
        assert_eq!(
            compare_numeric(&ScalarValue::Integer(0), &ScalarValue::Number(-0.0)).unwrap(),
            Ordering::Equal
        );
    }

    #[test]
    fn boolean_conditions_short_circuit_left_to_right() {
        let content = catalog();
        let runtime = RuntimeEngine::new(&content).unwrap();
        let invalid_tail = ConditionExpression::Eq {
            left: variable("missing"),
            right: literal(ScalarValue::Boolean(true)),
        };
        let and = ConditionExpression::And {
            conditions: vec![
                ConditionExpression::Eq {
                    left: literal(ScalarValue::Integer(1)),
                    right: literal(ScalarValue::Integer(2)),
                },
                invalid_tail.clone(),
            ],
        };
        let or = ConditionExpression::Or {
            conditions: vec![
                ConditionExpression::Eq {
                    left: literal(ScalarValue::Integer(1)),
                    right: literal(ScalarValue::Integer(1)),
                },
                invalid_tail,
            ],
        };
        assert!(!runtime.evaluate_condition(&content, &and).unwrap());
        assert!(runtime.evaluate_condition(&content, &or).unwrap());
    }

    #[test]
    fn profile_values_survive_new_game_and_loading_a_slot() {
        let content = catalog();
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        runtime
            .profile_variables
            .insert("ending_seen".to_owned(), ScalarValue::Boolean(true));
        let old_slot = runtime.snapshot.clone();
        runtime.start_new_game(&content).unwrap();
        assert_eq!(
            runtime.profile_variables.get("ending_seen"),
            Some(&ScalarValue::Boolean(true))
        );
        runtime.load_snapshot(&content, old_slot).unwrap();
        assert_eq!(
            runtime.profile_variables.get("ending_seen"),
            Some(&ScalarValue::Boolean(true))
        );
    }

    #[test]
    fn choice_conditions_hide_and_disable_options() {
        let content = catalog();
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        runtime.snapshot.location.node_id = "route_choice".to_owned();
        runtime.run_until_boundary(&content).unwrap();
        let PromptSnapshot::Choice { choices, .. } = &runtime.snapshot.prompt else {
            panic!("expected choice")
        };
        assert!(!choices.iter().any(|choice| choice.id == "test"));

        runtime
            .profile_variables
            .insert("ending_seen".to_owned(), ScalarValue::Boolean(true));
        runtime.snapshot.location.node_id = "route_choice".to_owned();
        runtime.snapshot.prompt = PromptSnapshot::None;
        runtime.run_until_boundary(&content).unwrap();
        let PromptSnapshot::Choice { choices, .. } = &runtime.snapshot.prompt else {
            panic!("expected choice")
        };
        assert!(choices
            .iter()
            .any(|choice| choice.id == "test" && choice.enabled));
    }

    #[test]
    fn a_choice_without_any_enabled_visible_option_is_an_error() {
        let mut content = catalog();
        let scene = content.scenes.get_mut("prologue").unwrap();
        let SceneNode::Choice { choices, .. } = scene.nodes.get_mut("route_choice").unwrap() else {
            panic!("expected choice fixture")
        };
        let always_false = ConditionExpression::Eq {
            left: literal(ScalarValue::Boolean(false)),
            right: literal(ScalarValue::Boolean(true)),
        };
        for choice in choices {
            choice.visible_if = None;
            choice.enabled_if = Some(always_false.clone());
        }
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        runtime.snapshot.location.node_id = "route_choice".to_owned();
        let error = runtime.run_until_boundary(&content).unwrap_err();
        assert!(error.to_string().contains("没有任何可见且可用的选项"));
    }

    #[test]
    fn new_game_clears_scene_dialogue_history() {
        let content = catalog();
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        runtime.snapshot.location.node_id = "introduction".to_owned();
        runtime.run_until_boundary(&content).unwrap();
        assert_eq!(runtime.dialogue_history().len(), 1);
        assert_eq!(
            runtime.dialogue_history()[0].prompt_id,
            "prologue/introduction"
        );

        runtime.completed_scenes.insert("prologue".to_owned());
        runtime.start_new_game(&content).unwrap();
        assert!(runtime.dialogue_history().is_empty());
        assert!(runtime.completed_scenes.contains("prologue"));
    }

    #[test]
    fn curtain_cover_and_reveal_track_stable_state_without_deadlocking() {
        let mut content = catalog();
        let scene = content.scenes.get_mut("prologue").unwrap();
        scene.entry = "curtain_cover".to_owned();
        scene.nodes.insert(
            "curtain_cover".to_owned(),
            SceneNode::Curtain {
                action: CurtainAction::Cover,
                fill: Some(crate::model::CurtainFill::Color {
                    color: "#000000".to_owned(),
                }),
                transition: crate::model::CurtainTransitionSpec::SplitHorizontal,
                duration_ms: 600,
                easing: crate::model::Easing::EaseInOut,
                await_completion: true,
                next: "curtain_reveal".to_owned(),
            },
        );
        scene.nodes.insert(
            "curtain_reveal".to_owned(),
            SceneNode::Curtain {
                action: CurtainAction::Reveal,
                fill: None,
                transition: crate::model::CurtainTransitionSpec::Fade,
                duration_ms: 400,
                easing: crate::model::Easing::EaseInOut,
                await_completion: true,
                next: "curtain_reveal_again".to_owned(),
            },
        );
        // Re-revealing an already revealed curtain must advance immediately
        // instead of emitting an awaited cue that nobody resolves.
        scene.nodes.insert(
            "curtain_reveal_again".to_owned(),
            SceneNode::Curtain {
                action: CurtainAction::Reveal,
                fill: None,
                transition: crate::model::CurtainTransitionSpec::Fade,
                duration_ms: 400,
                easing: crate::model::Easing::EaseInOut,
                await_completion: true,
                next: "curtain_end".to_owned(),
            },
        );
        scene.nodes.insert("curtain_end".to_owned(), SceneNode::End);

        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let cover = runtime.start_new_game(&content).unwrap();
        assert_eq!(cover.snapshot.location.node_id, "curtain_reveal");
        assert!(cover.requires_ack);
        assert!(cover.snapshot.world.curtain.covered);
        assert_eq!(
            cover.snapshot.world.curtain.fill,
            Some(crate::model::CurtainFill::Color {
                color: "#000000".to_owned(),
            })
        );
        assert!(cover.cues.iter().any(|cue| matches!(
            &cue.kind,
            PresentationCueKind::CurtainTransition {
                action: CurtainAction::Cover,
                fill: Some(crate::model::CurtainFill::Color { color }),
                transition: crate::model::CurtainTransitionSpec::SplitHorizontal,
                duration_ms: 600,
                easing: crate::model::Easing::EaseInOut,
            } if color == "#000000"
        )));

        let reveal = runtime
            .presentation_complete(&content, cover.update_id, PresentationOutcome::Completed)
            .unwrap();
        assert_eq!(reveal.snapshot.location.node_id, "curtain_reveal_again");
        assert!(reveal.requires_ack);
        assert!(!reveal.snapshot.world.curtain.covered);
        assert_eq!(reveal.snapshot.world.curtain.fill, None);
        assert!(reveal.cues.iter().any(|cue| matches!(
            &cue.kind,
            PresentationCueKind::CurtainTransition {
                action: CurtainAction::Reveal,
                fill: Some(crate::model::CurtainFill::Color { color }),
                transition: crate::model::CurtainTransitionSpec::Fade,
                duration_ms: 400,
                easing: crate::model::Easing::EaseInOut,
            } if color == "#000000"
        )));

        let repeated = runtime
            .presentation_complete(&content, reveal.update_id, PresentationOutcome::Completed)
            .unwrap();
        assert_eq!(repeated.snapshot.location.node_id, "curtain_end");
        assert!(!repeated.requires_ack);
        assert!(!repeated
            .cues
            .iter()
            .any(|cue| matches!(cue.kind, PresentationCueKind::CurtainTransition { .. })));
    }

    #[test]
    fn clear_node_hides_the_curtain() {
        let mut content = catalog();
        let scene = content.scenes.get_mut("prologue").unwrap();
        scene.nodes.insert(
            "clear_curtain".to_owned(),
            SceneNode::Clear {
                duration_ms: 700,
                easing: crate::model::Easing::EaseOut,
                await_completion: false,
                next: "introduction".to_owned(),
            },
        );
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        runtime.snapshot.location.node_id = "clear_curtain".to_owned();
        runtime.snapshot.world.curtain = CurtainSnapshot {
            covered: true,
            fill: Some(crate::model::CurtainFill::Asset {
                asset: "gui.dialogue_box".to_owned(),
            }),
        };
        runtime.run_until_boundary(&content).unwrap();
        assert!(!runtime.snapshot.world.curtain.covered);
        assert_eq!(runtime.snapshot.world.curtain.fill, None);
    }
}
