use super::*;

pub(super) fn validate_interaction_snapshot(
    content: &ContentCatalog,
    snapshot: &RuntimeSnapshot,
) -> Result<(), RuntimeError> {
    let interaction = &snapshot.interaction;
    let invalid = |message: &str| RuntimeError::InvalidSnapshot(message.to_owned());
    let valid_id = |id: &str| !id.is_empty() && id.len() <= 128
        && id.chars().all(|character| character.is_ascii_alphanumeric() || "._-".contains(character));
    validate_title(&interaction.titles.main).map_err(RuntimeError::InvalidSnapshot)?;
    validate_title(&interaction.titles.secondary).map_err(RuntimeError::InvalidSnapshot)?;
    if interaction.timers.len() > MAX_SCENE_TIMERS {
        return Err(invalid("存档中的 Scene 计时器过多"));
    }
    let scene = content.scenes.get(&snapshot.location.scene_id)
        .ok_or_else(|| invalid("存档引用了未知 Scene"))?;
    for (id, timer) in &interaction.timers {
        if !valid_id(id) || timer.remaining_ms > 30 * 60 * 1_000
            || timer.interval_ms.is_some_and(|interval| !(MIN_TIMER_INTERVAL_MS..=60_000).contains(&interval))
            || !scene.nodes.get(&timer.target).is_some_and(timer_target_allowed) {
            return Err(invalid("存档中的计时器 ID、时长或效果目标无效"));
        }
    }
    let mut block_ids = std::collections::BTreeSet::new();
    for block in &interaction.blocks {
        if !valid_id(&block.id)
            || !content.scenes.get(&block.source_scene).is_some_and(|source| source.window_role == block.source)
            || !block_ids.insert((block.source_scene.as_str(), block.id.as_str())) {
            return Err(invalid("存档中的阻挡来源、ID 或唯一性无效"));
        }
        if let Some(template) = &block.message_template {
            for reference in text_template::references(template).map_err(|error| invalid(&error.to_string()))? {
                let value_type = if crate::interaction::is_window_variable(&reference.id) {
                    crate::model::VariableType::String
                } else {
                    content.manifest.variables.get(&reference.id)
                        .ok_or_else(|| invalid("阻挡提示引用了未知变量"))?.value_type
                };
                text_template::validate_reference_type(&reference, value_type)
                    .map_err(|error| invalid(&error.to_string()))?;
            }
        }
    }
    if !interaction.prompt_instance.is_empty() && interaction.prompt_instance.parse::<u64>().is_err() {
        return Err(invalid("存档中的提示实例标识无效"));
    }
    if let Some(source) = &interaction.prompt_source {
        let node = scene.nodes.get(&source.node_id);
        if source.scene_id != scene.id || node.is_none() {
            return Err(invalid("存档中的提示来源不属于当前 Scene"));
        }
        let matches = match &snapshot.prompt {
            PromptSnapshot::Dialogue { prompt_id, .. } => matches!(node, Some(SceneNode::Say { .. }))
                && *prompt_id == format!("{}/{}", source.scene_id, source.node_id),
            PromptSnapshot::LongText { .. } => matches!(node, Some(SceneNode::LongText { .. }))
                && source == &snapshot.location,
            PromptSnapshot::Choice { prompt_id, .. } => matches!(node, Some(SceneNode::Choice { .. }))
                && source == &snapshot.location
                && *prompt_id == format!("{}/{}", source.scene_id, source.node_id),
            _ => true,
        };
        if !matches { return Err(invalid("存档中的提示来源与提示类型不匹配")); }
    }
    Ok(())
}

impl RuntimeEngine {
    /// Seed the next session before its first authored node is evaluated.
    pub fn prepare_window_titles(&mut self, titles: WindowTitles) {
        self.initial_window_titles = Some(titles);
    }

    pub(super) fn reset_window_context(&mut self) {
        let titles = self.initial_window_titles.take().unwrap_or_default();
        self.set_window_titles(titles);
        self.window_requests.clear();
        self.host_boundary = false;
    }

    pub(super) fn validate_scene_transfer(
        &self,
        content: &ContentCatalog,
        destination: &str,
        target: &str,
    ) -> Result<(), RuntimeError> {
        let source = content.scene(&self.snapshot.location.scene_id)
            .map_err(|error| RuntimeError::Content(error.to_string()))?;
        let destination = content.scene(destination)
            .map_err(|error| RuntimeError::Content(error.to_string()))?;
        if source.window_role != destination.window_role || !destination.nodes.contains_key(target) {
            return Err(RuntimeError::Content("Scene 跳转目标不存在或主/副窗口用途不匹配".to_owned()));
        }
        Ok(())
    }

    pub fn last_fired_timer(&self) -> Option<&str> {
        self.last_fired_timer.as_deref()
    }

    pub fn stop_timer(&mut self, id: &str) -> bool {
        self.snapshot.interaction.timers.remove(id).is_some()
    }

    pub fn set_window_titles(&mut self, titles: WindowTitles) {
        self.window_variables = titles.variables();
        self.snapshot.interaction.titles = titles;
    }

    pub fn take_window_requests(&mut self) -> Vec<WindowRequest> {
        std::mem::take(&mut self.window_requests)
    }

    pub fn at_host_boundary(&self) -> bool { self.host_boundary }

    pub fn resume_after_host(&mut self, content: &ContentCatalog) -> Result<RuntimeUpdate, RuntimeError> {
        if !self.host_boundary || self.pending_runtime_update.is_some() {
            return Err(RuntimeError::AdvanceNotAllowed);
        }
        self.host_boundary = false;
        let cues = self.run_until_boundary(content)?;
        Ok(self.finish_update(cues, true))
    }

    pub fn control_block(
        &mut self,
        source: WindowRole,
        source_scene: &str,
        action: WindowControlAction,
        id: &str,
        message: &str,
    ) {
        self.snapshot.interaction.blocks.retain(|block| {
            !(block.source == source && block.source_scene == source_scene && block.id == id)
        });
        if action == WindowControlAction::Block {
            self.snapshot.interaction.blocks.push(AdvanceBlock {
                id: id.to_owned(), source, source_scene: source_scene.to_owned(), message: message.to_owned(),
                message_template: Some(message.to_owned()),
            });
        }
    }

    pub fn clear_blocks_from(&mut self, source: WindowRole, scene: &str) {
        self.snapshot.interaction.blocks.retain(|block| block.source != source || block.source_scene != scene);
    }

    pub fn can_script_advance(&self) -> bool {
        self.started && !self.host_boundary && self.pending_runtime_update.is_none()
            && self.snapshot.interaction.blocks.is_empty()
            && matches!(self.snapshot.prompt, PromptSnapshot::Dialogue { .. } | PromptSnapshot::LongText { .. })
    }

    pub fn refresh_update(&mut self, content: &ContentCatalog) -> Result<RuntimeUpdate, RuntimeError> {
        self.refresh_prompt(content)?;
        let mut update = self.finish_update(Vec::new(), true);
        update.kind = UpdateKind::StateRefresh;
        Ok(update)
    }

    pub(super) fn mark_prompt_source(&mut self, scene_id: &str, node_id: &str) {
        self.snapshot.interaction.prompt_source = Some(StoryLocation {
            scene_id: scene_id.to_owned(), node_id: node_id.to_owned(),
        });
        self.snapshot.interaction.prompt_instance = self.next_update_id.to_string();
    }

    pub(super) fn choice_prompt(
        &self,
        content: &ContentCatalog,
        scene_id: &str,
        node_id: &str,
        presentation: Option<&ChoicePresentation>,
        definitions: &[crate::model::ChoiceDefinition],
    ) -> Result<PromptSnapshot, RuntimeError> {
        let mut drafts = Vec::new();
        for choice in definitions {
            if !choice.visible_if.as_ref().map(|condition| self.evaluate_condition(content, condition)).transpose()?.unwrap_or(true) {
                continue;
            }
            drafts.push(ChoiceItemDraft {
                id: choice.id.clone(),
                label: self.interpolate_text(content, &choice.label)?,
                enabled: choice.enabled_if.as_ref().map(|condition| self.evaluate_condition(content, condition)).transpose()?.unwrap_or(true),
                template: choice.template.clone(), icon: choice.icon.clone(),
            });
        }
        let (choices, layout, diagnostics) = resolve_choice_items(content, scene_id, node_id, presentation, &drafts);
        Ok(PromptSnapshot::Choice { prompt_id: format!("{scene_id}/{node_id}"), choices, layout, diagnostics })
    }

    pub fn refresh_prompt(&mut self, content: &ContentCatalog) -> Result<(), RuntimeError> {
        let messages = self.snapshot.interaction.blocks.iter().map(|block| {
            block.message_template.as_deref().map(|source| self.interpolate_text(content, source))
                .unwrap_or_else(|| Ok(block.message.clone()))
        }).collect::<Result<Vec<_>, _>>()?;
        for (block, message) in self.snapshot.interaction.blocks.iter_mut().zip(messages) {
            block.message = message;
        }
        let source = self.snapshot.interaction.prompt_source.clone().or_else(|| {
            match &self.snapshot.prompt {
                PromptSnapshot::Choice { .. } | PromptSnapshot::LongText { .. } => Some(self.snapshot.location.clone()),
                PromptSnapshot::Dialogue { prompt_id, .. } => prompt_id.split_once('/').map(|(scene, node)| StoryLocation {
                    scene_id: scene.to_owned(), node_id: node.to_owned(),
                }),
                _ => None,
            }
        });
        let Some(source) = source else { return Ok(()); };
        let Some(node) = content.scenes.get(&source.scene_id).and_then(|scene| scene.nodes.get(&source.node_id)) else { return Ok(()); };
        match (node, self.snapshot.prompt.clone()) {
            (SceneNode::Choice { presentation, choices }, PromptSnapshot::Choice { .. }) => {
                self.snapshot.prompt = self.choice_prompt(content, &source.scene_id, &source.node_id, presentation.as_ref(), choices)?;
            }
            (SceneNode::Say { text, .. }, PromptSnapshot::Dialogue { .. }) => {
                let text = self.interpolate_text(content, text)?;
                if let PromptSnapshot::Dialogue { text: current, .. } = &mut self.snapshot.prompt { *current = text.clone(); }
                if let Some(segment) = self.snapshot.dialogue_page.as_mut().and_then(|page| page.segments.last_mut()) {
                    *segment = text;
                }
            }
            (SceneNode::LongText { steps, .. }, PromptSnapshot::LongText { step_index, .. }) => {
                if let Some(step) = steps.get(step_index as usize) {
                    let text = self.interpolate_text(content, &step.text)?;
                    if let PromptSnapshot::LongText { text: current, .. } = &mut self.snapshot.prompt { *current = text.clone(); }
                    if let Some(page) = &mut self.snapshot.long_text_page {
                        if let Some(current) = page.steps.get_mut(page.active_step_index as usize) { current.text = text; }
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Called with monotonic elapsed time by a host. A gated callback remains
    /// due, but missed repeating periods are never queued up for a later burst.
    pub fn tick_timers(&mut self, content: &ContentCatalog, elapsed_ms: u64) -> (Vec<RuntimeUpdate>, Vec<String>) {
        self.last_fired_timer = None;
        let mut updates = Vec::new();
        let mut diagnostics = Vec::new();
        for timer in self.snapshot.interaction.timers.values_mut() {
            timer.remaining_ms = timer.remaining_ms.saturating_sub(elapsed_ms);
        }
        if self.pending_runtime_update.is_some() || self.host_boundary { return (updates, diagnostics); }
        let due: Vec<_> = self.snapshot.interaction.timers.iter()
            .filter(|(_, timer)| timer.remaining_ms == 0)
            .map(|(id, timer)| (id.clone(), timer.clone())).collect();
        for (id, timer) in due {
            let before = self.clone();
            let scene_id = self.snapshot.location.scene_id.clone();
            let result = (|| {
                let node = content.scenes.get(&scene_id).and_then(|scene| scene.nodes.get(&timer.target))
                    .filter(|node| timer_target_allowed(node)).cloned()
                    .ok_or_else(|| RuntimeError::Content(format!("计时器 {id} 的效果目标无效")))?;
                let mut cues = Vec::new();
                self.last_fired_timer = Some(id.clone());
                self.execute_node(content, &scene_id, &timer.target, node, &mut cues, true)?;
                self.refresh_prompt(content)?;
                Ok::<_, RuntimeError>(cues)
            })();
            match result {
                Ok(cues) => {
                    if let Some(interval) = timer.interval_ms {
                        // A repeated effect must finish before its next occurrence.
                        let duration = cues.iter().map(|cue| match &cue.kind {
                            PresentationCueKind::Timeline { duration_ms, .. }
                            | PresentationCueKind::SpriteTween { duration_ms, .. }
                            | PresentationCueKind::CameraTween { duration_ms, .. }
                            | PresentationCueKind::ScreenEffect { duration_ms, .. }
                            | PresentationCueKind::BackgroundTransition { duration_ms, .. }
                            | PresentationCueKind::CurtainTransition { duration_ms, .. }
                            | PresentationCueKind::BgmTransition { duration_ms, .. }
                            | PresentationCueKind::AmbienceTransition { duration_ms, .. }
                            | PresentationCueKind::UiMotion { duration_ms, .. } => *duration_ms,
                            _ => 0,
                        }).max().unwrap_or(0);
                        if let Some(active) = self.snapshot.interaction.timers.get_mut(&id) {
                            active.remaining_ms = interval.max(duration).max(MIN_TIMER_INTERVAL_MS);
                        }
                    } else { self.snapshot.interaction.timers.remove(&id); }
                    let mut update = self.finish_update(cues, true);
                    update.kind = UpdateKind::Effect;
                    update.effect_timer = Some(id.clone());
                    updates.push(update);
                    // A later callback may read a title or block just changed by
                    // this one. Let the host commit the request before continuing.
                    if !self.window_requests.is_empty() { break; }
                }
                Err(error) => {
                    *self = before;
                    self.last_fired_timer = Some(id.clone());
                    self.snapshot.interaction.timers.remove(&id);
                    diagnostics.push(format!("计时器 {id} 已停止：{error}"));
                }
            }
        }
        (updates, diagnostics)
    }
}
