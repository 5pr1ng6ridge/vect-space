use crate::content::ContentCatalog;
use crate::model::{
    AdvanceSource, ButtonPostAction, CtrlFastForwardMode, CueGate, PlaybackAutoMode,
    PresentationCueKind, PresentationOutcome, PromptSnapshot, RuntimeUpdate, SceneNode,
    VariableScope,
};
use super::{RuntimeEngine, RuntimeError};
use super::variables::apply_variable_operation;

impl RuntimeEngine {
    pub fn advance(
        &mut self,
        content: &ContentCatalog,
        expected_revision: u64,
        source: AdvanceSource,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        self.ensure_interactive(expected_revision)?;
        if !self.snapshot.interaction.blocks.is_empty() {
            return Err(RuntimeError::AdvanceNotAllowed);
        }
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

    pub fn choose(
        &mut self,
        content: &ContentCatalog,
        choice_id: &str,
        expected_revision: u64,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        self.ensure_interactive(expected_revision)?;
        self.refresh_prompt(content)?;
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
        if matches!(button.action.next, Some(ButtonPostAction::Advance)) {
            if !self.snapshot.interaction.blocks.is_empty() {
                return Err(RuntimeError::AdvanceNotAllowed);
            }
            self.validate_advance_source(AdvanceSource::Manual)?;
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
                self.validate_scene_transfer(content, &destination_scene, &target)?;
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
                self.refresh_prompt(content)?;
                let cue = self.cue(
                    CueGate::None,
                    PresentationCueKind::ButtonSystemAction { panel },
                );
                Ok(self.finish_update(vec![cue], true))
            }
            None => self.refresh_update(content),
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

    fn ensure_interactive(&self, expected_revision: u64) -> Result<(), RuntimeError> {
        if !self.started {
            return Err(RuntimeError::NotStarted);
        }
        if let Some(pending) = &self.pending_runtime_update {
            return Err(RuntimeError::PresentationPending(pending.update_id));
        }
        if self.host_boundary {
            return Err(RuntimeError::AdvanceNotAllowed);
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
        if source == AdvanceSource::Script { return Ok(()); }
        let allowed = match self.snapshot.playback.auto {
            PlaybackAutoMode::Forced => source == AdvanceSource::ForcedAuto,
            PlaybackAutoMode::Normal => match source {
                AdvanceSource::Manual | AdvanceSource::Auto | AdvanceSource::Script => true,
                AdvanceSource::FastForward => {
                    self.snapshot.playback.ctrl_fast_forward == CtrlFastForwardMode::Allow
                }
                AdvanceSource::ForcedAuto => false,
            },
        };
        allowed.then_some(()).ok_or(RuntimeError::AdvanceNotAllowed)
    }
}
