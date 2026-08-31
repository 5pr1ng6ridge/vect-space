//! Deterministic visual-novel runtime with no desktop-host dependencies.

use crate::{
    content::ContentCatalog,
    model::{
        AdvanceSource, AudioAction, AudioSnapshot, BootstrapPayload, CameraSnapshot,
        ChoiceSnapshot, ConditionExpression, CtrlFastForwardMode, CueGate, DialogueHistoryEntry,
        DialogueMode, DialoguePageSnapshot, LoopingAudioSnapshot, MutationValue, PlaybackAutoMode,
        PlaybackSnapshot, PresentationCue, PresentationCueKind, PresentationOutcome, ProfileState,
        PromptSnapshot, RuntimeSnapshot, RuntimeUpdate, ScalarValue, SceneNode, SpriteAction,
        SpriteSnapshot, StoryFlowReveal, StoryFlowSnapshot, StoryLocation, TimelineChannels,
        TimelineTrack, UiMotionPreset, UiMotionSlot, ValueOperand, VariableMap, VariableOperation,
        VariableScope, VariableType, WorldSnapshot,
    },
    text_template::{self, MAX_VARIABLE_STRING_BYTES},
};
use thiserror::Error;

const MAX_IMMEDIATE_NODES: usize = 10_000;

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
                dialogue_history: Default::default(),
                completed_scenes: Default::default(),
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
        let mut runtime = Self::new(content)?;
        for (id, value) in overrides {
            let definition = content
                .manifest
                .variables
                .get(id)
                .ok_or_else(|| RuntimeError::Content(format!("未声明变量 {id}")))?;
            let value = normalize_value(value.clone(), definition.value_type)?;
            match definition.scope {
                VariableScope::Save => {
                    runtime.snapshot.variables.insert(id.clone(), value);
                }
                VariableScope::Profile => {
                    runtime.profile_variables.insert(id.clone(), value);
                }
            }
        }
        Ok(runtime)
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
        self.preview_target = Some(target.clone());
        self.preview_skip_target_once = false;
        let mut last_trace = Vec::new();
        let result = (|| {
            let mut visits = std::collections::BTreeMap::<StoryLocation, usize>::new();
            let mut trace = Vec::new();
            let mut update = self.start_new_game(content)?;
            for _ in 0..MAX_IMMEDIATE_NODES {
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
                    PromptSnapshot::Dialogue { .. } => {
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
        let SceneNode::Timeline { next, .. } = scene
            .nodes
            .get(&node_id)
            .ok_or_else(|| RuntimeError::Content(format!("节点不存在: {scene_id}/{node_id}")))?
        else {
            return Err(RuntimeError::Content(format!(
                "目标节点不是 timeline：{scene_id}/{node_id}"
            )));
        };
        self.preview_target = Some(StoryLocation {
            scene_id,
            node_id: next.clone(),
        });
        // The successor can legally loop back to this same node. Skip the
        // breakpoint once so the target timeline itself is always executed.
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
            story_flow_available: content.story_flow.is_some(),
        }
    }

    pub fn start_new_game(
        &mut self,
        content: &ContentCatalog,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        let previous_revision = self.snapshot.revision;
        self.snapshot = initial_snapshot(content)?;
        self.snapshot.revision = previous_revision;
        self.started = true;
        self.pending_runtime_update = None;
        let cues = self.run_until_boundary(content)?;
        Ok(self.finish_update(cues, true))
    }

    pub fn advance(
        &mut self,
        content: &ContentCatalog,
        expected_revision: u64,
        source: AdvanceSource,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        self.ensure_interactive(expected_revision)?;
        self.validate_advance_source(source)?;
        let PromptSnapshot::Dialogue { prompt_id, .. } = &self.snapshot.prompt else {
            return Err(RuntimeError::AdvanceNotAllowed);
        };
        let prompt_id = prompt_id.clone();
        self.read_dialogues.insert(prompt_id);
        self.snapshot.prompt = PromptSnapshot::None;
        let cues = self.run_until_boundary(content)?;
        Ok(self.finish_update(cues, true))
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
        let SceneNode::Choice { choices } = node else {
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
            dialogue_history: self.dialogue_history.clone(),
            completed_scenes: self.completed_scenes.clone(),
        }
    }

    pub fn dialogue_history(&self) -> &[DialogueHistoryEntry] {
        &self.dialogue_history
    }

    pub fn story_flow(
        &self,
        content: &ContentCatalog,
    ) -> Result<Option<StoryFlowSnapshot>, RuntimeError> {
        let Some(flow) = &content.story_flow else {
            return Ok(None);
        };
        let mut nodes = Vec::new();
        for (scene_id, node) in &flow.nodes {
            let completed = self.completed_scenes.contains(scene_id);
            let visible = match &node.reveal {
                StoryFlowReveal::Completed => completed,
                StoryFlowReveal::Always => true,
                StoryFlowReveal::Condition { condition } => {
                    self.evaluate_condition(content, condition)?
                }
            };
            if visible {
                nodes.push(crate::model::VisibleStoryFlowNode {
                    scene_id: scene_id.clone(),
                    title: node.title.clone(),
                    x: node.x,
                    y: node.y,
                    completed,
                });
            }
        }
        let visible = nodes
            .iter()
            .map(|node| node.scene_id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let edges = flow
            .edges
            .iter()
            .filter(|edge| {
                visible.contains(edge.from.as_str()) && visible.contains(edge.to.as_str())
            })
            .map(|edge| crate::model::VisibleStoryFlowEdge {
                id: edge.id.clone(),
                from: edge.from.clone(),
                to: edge.to.clone(),
                label: edge.label.clone(),
            })
            .collect();
        Ok(Some(StoryFlowSnapshot { nodes, edges }))
    }

    pub fn pending_runtime_update(&self) -> Option<u64> {
        self.pending_runtime_update
            .as_ref()
            .map(|pending| pending.update_id)
    }

    pub fn load_snapshot(
        &mut self,
        content: &ContentCatalog,
        mut snapshot: RuntimeSnapshot,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        hydrate_legacy_dialogue_page(&mut snapshot);
        validate_snapshot(content, &snapshot)?;
        if let PromptSnapshot::Dialogue {
            prompt_id, is_read, ..
        } = &mut snapshot.prompt
        {
            *is_read = self.read_dialogues.contains(prompt_id);
        }
        snapshot.revision = self.snapshot.revision.saturating_add(1);
        self.snapshot = snapshot;
        self.started = true;
        self.pending_runtime_update = None;
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
                        SpriteAction::Show => Some(SpriteSnapshot {
                            asset: asset.ok_or_else(|| {
                                RuntimeError::Content(format!(
                                    "{scene_id}/{node_id}: show 缺少 asset"
                                ))
                            })?,
                            x: x.unwrap_or(960.0),
                            y: y.unwrap_or(1080.0),
                            scale: scale.unwrap_or(1.0),
                            scale_x: 1.0,
                            scale_y: 1.0,
                            rotation_deg: 0.0,
                            opacity: opacity.unwrap_or(1.0),
                            z: z.unwrap_or(0),
                        }),
                        SpriteAction::Move => {
                            let mut target = from.clone().ok_or_else(|| {
                                RuntimeError::Content(format!(
                                    "{scene_id}/{node_id}: 无法移动不存在的立绘 {sprite_id}"
                                ))
                            })?;
                            if let Some(value) = asset {
                                target.asset = value;
                            }
                            if let Some(value) = x {
                                target.x = value;
                            }
                            if let Some(value) = y {
                                target.y = value;
                            }
                            if let Some(value) = scale {
                                target.scale = value;
                            }
                            if let Some(value) = opacity {
                                target.opacity = value;
                            }
                            if let Some(value) = z {
                                target.z = value;
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
                    self.snapshot.location.node_id = next;
                    cues.push(self.cue(
                        gate(await_completion),
                        PresentationCueKind::SpriteTween {
                            sprite_id,
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
                            speed_cps: speed_cps.unwrap_or(30.0),
                        },
                    ));
                    return Ok(cues);
                }
                SceneNode::Choice { choices } => {
                    let prompt_id = format!("{scene_id}/{node_id}");
                    let mut visible_choices = Vec::new();
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
                        visible_choices.push(ChoiceSnapshot {
                            id: choice.id,
                            label: self.interpolate_text(content, &choice.label)?,
                            enabled,
                        });
                    }
                    if !visible_choices.iter().any(|choice| choice.enabled) {
                        return Err(RuntimeError::Content(format!(
                            "{scene_id}/{node_id}: 没有任何可见且可用的选项"
                        )));
                    }
                    self.snapshot.dialogue_page = None;
                    self.snapshot.prompt = PromptSnapshot::Choice {
                        prompt_id,
                        choices: visible_choices,
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
                        self.clear_scene_visual_state();
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
                SceneNode::Timeline {
                    duration_ms,
                    await_completion,
                    skippable,
                    tracks,
                    events,
                    next,
                } => {
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
        }
    }

    /// Reset only scene-owned visual state. BGM, dialogue UI visibility and UI
    /// motion bindings are global presentation concerns and intentionally
    /// survive a scene transition.
    fn clear_scene_visual_state(&mut self) {
        self.snapshot.world.background = None;
        self.snapshot.world.sprites.clear();
        self.snapshot.world.camera = CameraSnapshot::default();
        self.snapshot.world.persistent_effects.clear();
        self.snapshot.dialogue_page = None;
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
        (ScalarValue::Integer(left), ScalarValue::Number(right)) => (*left as f64)
            .partial_cmp(right)
            .ok_or_else(|| RuntimeError::Content("无法比较非有限数值".to_owned())),
        (ScalarValue::Number(left), ScalarValue::Integer(right)) => left
            .partial_cmp(&(*right as f64))
            .ok_or_else(|| RuntimeError::Content("无法比较非有限数值".to_owned())),
        (ScalarValue::Number(left), ScalarValue::Number(right)) => left
            .partial_cmp(right)
            .ok_or_else(|| RuntimeError::Content("无法比较非有限数值".to_owned())),
        _ => Err(RuntimeError::Content(
            "Lt/Le/Gt/Ge 只允许比较数值".to_owned(),
        )),
    }
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
        prompt: PromptSnapshot::None,
    })
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
    let scene = content
        .scene(&snapshot.location.scene_id)
        .map_err(|error| RuntimeError::InvalidSnapshot(error.to_string()))?;
    if !scene.nodes.contains_key(&snapshot.location.node_id) {
        return Err(RuntimeError::InvalidSnapshot(format!(
            "节点不存在: {}/{}",
            snapshot.location.scene_id, snapshot.location.node_id
        )));
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use super::*;
    use crate::model::{LiteralOperand, VariableOperand};

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

        let cues = runtime.run_until_boundary(&content).unwrap();
        assert_eq!(runtime.snapshot.world.background, None);
        assert!(runtime.snapshot.world.sprites.is_empty());
        assert_eq!(runtime.snapshot.world.camera, CameraSnapshot::default());
        assert!(runtime.snapshot.world.persistent_effects.is_empty());
        assert_eq!(runtime.snapshot.dialogue_page, None);
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
        let update = runtime
            .advance(
                &content,
                source_update.snapshot.revision,
                AdvanceSource::Manual,
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
                next: "segment_effect".to_owned(),
            },
        );
        scene.nodes.insert(
            "segment_effect".to_owned(),
            SceneNode::ScreenEffect {
                effect: crate::model::ScreenEffectKind::Shake,
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
            PresentationCueKind::DialogueReveal { speed_cps, .. } if *speed_cps == 20.0
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
                speed_cps: 30.0,
            },
        };
        let value = serde_json::to_value(cue).unwrap();
        assert_eq!(value["type"], "dialogue_reveal");
        assert_eq!(value["gate"], "player_advance");
        assert_eq!(value["cue_id"], 9);
        assert!(value.get("kind").is_none());
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
        let SceneNode::Choice { choices } = scene.nodes.get_mut("route_choice").unwrap() else {
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
    fn dialogue_history_and_story_flow_are_profile_scoped() {
        let content = catalog();
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        runtime.snapshot.location.node_id = "introduction".to_owned();
        runtime.run_until_boundary(&content).unwrap();
        assert_eq!(runtime.dialogue_history().len(), 1);
        let first = runtime.dialogue_history()[0].clone();
        assert_eq!(first.prompt_id, "prologue/introduction");

        let before = runtime.story_flow(&content).unwrap().unwrap();
        assert!(before
            .nodes
            .iter()
            .any(|node| node.scene_id == "test_scene"));
        assert!(!before.nodes.iter().any(|node| node.scene_id == "prologue"));
        runtime.completed_scenes.insert("prologue".to_owned());
        let after = runtime.story_flow(&content).unwrap().unwrap();
        assert!(after
            .nodes
            .iter()
            .any(|node| node.scene_id == "prologue" && node.completed));

        runtime.start_new_game(&content).unwrap();
        assert_eq!(runtime.dialogue_history().len(), 1);
        assert!(runtime.completed_scenes.contains("prologue"));
    }
}
