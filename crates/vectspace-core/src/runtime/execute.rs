use crate::content::ContentCatalog;
use crate::interaction::{
    MAX_SCENE_TIMERS, MIN_TIMER_INTERVAL_MS, SceneTimer, timer_target_allowed, TimerAction,
    validate_title, WindowRequest,
};
use crate::model::{
    AudioAction, AudioSnapshot, ButtonClickAction, ButtonSnapshot, ButtonTemplate, CameraSnapshot,
    CueGate, CurtainAction, CurtainSnapshot, DialogueMode, DialoguePageSnapshot,
    LongTextControlAction, LongTextMode, LongTextPageSnapshot, LongTextStepSnapshot,
    LoopingAudioSnapshot, PlaybackSnapshot, PresentationCue, PresentationCueKind, PromptSnapshot,
    RuntimeSnapshot, SceneNode, SpriteAction, TimelineTrack, UiMotionPreset, UiMotionSlot,
    VariableScope, WorldSnapshot,
};
use crate::visual::{
    EmitterSnapshot, PARTICLE_SURFACE_MAX_LIVE, ParticleAction, SpriteKind, SpriteSource,
};
use crate::text_template;
use super::{MAX_IMMEDIATE_NODES, RuntimeEngine, RuntimeError};
use super::dialogue::{long_text_document_id, validate_long_text_document_size};
use super::timeline::{apply_timeline_final_state, expand_sprite_action};
use super::variables::{apply_variable_operation, defaults_for_scope};

impl RuntimeEngine {
    pub(super) fn run_until_boundary(
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

            if matches!(node, SceneNode::Say { .. } | SceneNode::LongText { .. } | SceneNode::Choice { .. }) {
                self.mark_prompt_source(&scene_id, &node_id);
            }
            if self.execute_node(content, &scene_id, &node_id, node, &mut cues, false)? {
                return Ok(cues);
            }
        }
        Err(RuntimeError::ImmediateLoop)
    }

    pub(super) fn execute_node(
        &mut self,
        content: &ContentCatalog,
        scene_id: &str,
        node_id: &str,
        node: SceneNode,
        cues: &mut Vec<PresentationCue>,
        effect_only: bool,
    ) -> Result<bool, RuntimeError> {
        match node {
            SceneNode::Background {
                background,
                transition,
                duration_ms,
                easing,
                await_completion,
                next,
            } => {
                self.snapshot.world.set_legacy_background(background.clone());
                if !effect_only { self.snapshot.location.node_id = next; }
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
                    return Ok(true);
                }
            }
            SceneNode::Sprite {
                sprite_id, action, source, sprite_kind, space, layout, asset, character,
                expression, flip_x, crossfade_ms, x, y, scale, scale_x, scale_y,
                rotation_deg, anchor_x, anchor_y, opacity, z, duration_ms, easing,
                await_completion, next,
            } => {
                let from = self.snapshot.world.sprites.get(&sprite_id).cloned();
                let to = if action == SpriteAction::Hide {
                    None
                } else {
                    let (resolved_asset, offset_x, offset_y, expression_scale, expression_anchor_x, expression_anchor_y)
                        = resolve_character_asset(content, character.as_deref(), expression.as_deref(), asset, scene_id, node_id)?;
                    let requested_source = source.or_else(|| resolved_asset.map(|asset| SpriteSource::Image { asset }));
                    let mut target = if action == SpriteAction::Show {
                        let source = requested_source.clone().ok_or_else(|| RuntimeError::Content(format!("{scene_id}/{node_id}: show 缺少来源或有效表情")))?;
                        let kind = sprite_kind.unwrap_or(if matches!(source, SpriteSource::Text { .. }) { SpriteKind::Text } else { SpriteKind::Character });
                        kind.preset(source)
                    } else {
                        from.clone().ok_or_else(|| RuntimeError::Content(format!("{scene_id}/{node_id}: 无法移动不存在的 Sprite {sprite_id}")))?
                    };
                    if let Some(source) = requested_source { target.source = source; }
                    if let Some(kind) = sprite_kind { target.sprite_kind = kind; }
                    if let Some(space) = space { target.space = space; }
                    if let Some(layout) = layout { target.layout = Some(layout); }
                    if action == SpriteAction::Show {
                        target.x += offset_x;
                        target.y += offset_y;
                        target.scale *= expression_scale;
                    }
                    if let Some(value) = x { target.x = value + offset_x; }
                    if let Some(value) = y { target.y = value + offset_y; }
                    if let Some(value) = scale { target.scale = value * expression_scale; }
                    if character.is_some() || expression.is_some() {
                        target.anchor_x = expression_anchor_x;
                        target.anchor_y = expression_anchor_y;
                    }
                    if let Some(value) = scale_x { target.scale_x = value; }
                    if let Some(value) = scale_y { target.scale_y = value; }
                    if let Some(value) = rotation_deg { target.rotation_deg = value; }
                    if let Some(value) = anchor_x { target.anchor_x = value; }
                    if let Some(value) = anchor_y { target.anchor_y = value; }
                    if let Some(value) = opacity { target.opacity = value; }
                    if let Some(value) = z { target.z = value; }
                    if let Some(value) = flip_x { target.flip_x = value; }
                    content.validate_sprite_source(&target.source).map_err(|error| RuntimeError::Content(error.to_string()))?;
                    Some(target)
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
                        (Some(previous), Some(next)) if previous.source != next.source => {
                            Some(150)
                        }
                        _ => None,
                    }
                });
                if !effect_only { self.snapshot.location.node_id = next; }
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
                    return Ok(true);
                }
            }
            SceneNode::Particle { emitter_id, action, particle, seed, space, x, y, scale, rotation_deg, opacity, z, next } => {
                let emitter = if action == ParticleAction::Stop {
                    self.snapshot.world.emitters.remove(&emitter_id);
                    None
                } else {
                    let particle = particle.ok_or_else(|| RuntimeError::Content("发射器缺少粒子定义".into()))?;
                    let definition = content.particles.get(&particle).ok_or_else(|| RuntimeError::Content(format!("未知粒子定义: {particle}")))?;
                    let emitter = EmitterSnapshot { particle, seed: seed.unwrap_or(definition.seed), generation: self.next_cue_id as u32, space, x, y, scale, rotation_deg, opacity, z };
                    if action == ParticleAction::Start {
                        let budget: u32 = self.snapshot.world.emitters.iter().filter(|(id, _)| *id != &emitter_id)
                            .filter_map(|(_, emitter)| content.particles.get(&emitter.particle)).map(|definition| definition.max_particles).sum();
                        if budget.saturating_add(definition.max_particles) > PARTICLE_SURFACE_MAX_LIVE {
                            return Err(RuntimeError::Content("粒子系统超过单画面预算".into()));
                        }
                        self.snapshot.world.emitters.insert(emitter_id.clone(), emitter.clone());
                    }
                    Some(emitter)
                };
                cues.push(self.cue(CueGate::None, PresentationCueKind::ParticleState { emitter_id, emitter, burst: action == ParticleAction::Burst }));
                if !effect_only { self.snapshot.location.node_id = next; }
            }
            SceneNode::Clear {
                duration_ms,
                easing,
                await_completion,
                next,
            } => {
                self.clear_scene_visual_state();
                if !effect_only { self.snapshot.location.node_id = next; }
                cues.push(self.cue(
                    gate(await_completion),
                    PresentationCueKind::ClearScene {
                        duration_ms,
                        easing,
                    },
                ));
                if await_completion {
                    return Ok(true);
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
                if !effect_only { self.snapshot.location.node_id = next; }
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
                return Ok(true);
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
                    long_text_document_id(scene_id, node_id, document.as_deref());
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
                validate_long_text_document_size(&page, scene_id, node_id)?;
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
                return Ok(true);
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
                let expected = long_text_document_id(scene_id, node_id, Some(&document));
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
                if !effect_only { self.snapshot.location.node_id = next; }
            }
            SceneNode::Choice { presentation, choices } => {
                self.snapshot.dialogue_page = None;
                self.snapshot.prompt = self.choice_prompt(content, scene_id, node_id, presentation.as_ref(), &choices)?;
                return Ok(true);
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
                if !effect_only { self.snapshot.location.node_id = next; }
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
                if !effect_only { self.snapshot.location.node_id = next; }
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
                if !effect_only { self.snapshot.location.node_id = next; }
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
                    return Ok(true);
                }
            }
            SceneNode::Jump { scene, target } => {
                self.validate_scene_transfer(content, scene.as_deref().unwrap_or(scene_id), &target)?;
                let crosses_scene = scene
                    .as_ref()
                    .is_some_and(|destination| destination != scene_id);
                if let Some(destination) = scene {
                    self.snapshot.location.scene_id = destination;
                }
                self.snapshot.location.node_id = target;
                // A scene is a visual ownership boundary. Establish an
                // explicit presentation boundary before evaluating the
                // destination so stale views cannot blend into its first
                // background or sprite cue.
                if crosses_scene {
                    self.completed_scenes.insert(scene_id.to_owned());
                    cues.extend(self.leave_scene(content)?);
                    cues.push(self.cue(
                        CueGate::Runtime,
                        PresentationCueKind::ClearScene {
                            duration_ms: 0,
                            easing: crate::model::Easing::Linear,
                        },
                    ));
                    return Ok(true);
                }
            }
            SceneNode::OpenWindow { scene, next } => {
                // Never blocking: the runtime only records the request and
                // continues to `next`.  The desktop host decides whether to
                // act on it (the main story runtime, and the replay it is
                // running, but never the secondary engine) and strips the cue
                // before the update reaches any WebView.
                if !effect_only { self.snapshot.location.node_id = next; }
                cues.push(
                    self.cue(CueGate::None, PresentationCueKind::OpenWindow { scene }),
                );
            }
            SceneNode::WindowTitle { target, title, next } => {
                let title = text_template::interpolate_plain(&title, |id| {
                    self.variable_value(content, id).cloned()
                        .map_err(|error| text_template::TemplateError(error.to_string()))
                }).map_err(|error| RuntimeError::Content(error.to_string()))?;
                validate_title(&title).map_err(RuntimeError::Content)?;
                self.window_requests.push(WindowRequest::Title { target, title });
                if !effect_only { self.snapshot.location.node_id = next; self.host_boundary = true; }
                return Ok(true);
            }
            SceneNode::WindowControl { target, action, id, message, next } => {
                self.window_requests.push(WindowRequest::Control { target, action, id, message });
                if !effect_only { self.snapshot.location.node_id = next; self.host_boundary = true; }
                return Ok(true);
            }
            // Native window changes are host work that nothing later in the
            // story reads, so unlike titles they need no host boundary: the
            // host drains the request after this step, in node order.
            SceneNode::WindowGeometry {
                target,
                position,
                size,
                duration_ms,
                easing,
                await_completion,
                next,
            } => {
                self.window_requests.push(WindowRequest::Geometry {
                    target,
                    position,
                    size,
                    duration_ms,
                    easing,
                });
                if !effect_only { self.snapshot.location.node_id = next; }
                if await_completion && duration_ms > 0 {
                    cues.push(
                        self.cue(CueGate::Runtime, PresentationCueKind::Delay { duration_ms }),
                    );
                    return Ok(true);
                }
            }
            SceneNode::WindowLayer { target, action, next } => {
                self.window_requests.push(WindowRequest::Layer { target, action });
                if !effect_only { self.snapshot.location.node_id = next; }
            }
            SceneNode::Timer { id, action, delay_ms, interval_ms, target, next } => {
                match action {
                    TimerAction::Stop => { self.snapshot.interaction.timers.remove(&id); }
                    TimerAction::Start => {
                        if id.is_empty() || interval_ms.is_some_and(|value| value < MIN_TIMER_INTERVAL_MS)
                            || (!self.snapshot.interaction.timers.contains_key(&id)
                                && self.snapshot.interaction.timers.len() >= MAX_SCENE_TIMERS) {
                            return Err(RuntimeError::Content("计时器 ID、间隔或数量无效".to_owned()));
                        }
                        let target = target.ok_or_else(|| RuntimeError::Content("计时器缺少目标".to_owned()))?;
                        let target_node = content.scene(scene_id).ok().and_then(|scene| scene.nodes.get(&target));
                        if !target_node.is_some_and(timer_target_allowed) {
                            return Err(RuntimeError::Content("计时器必须引用同场景的非阻塞效果节点".to_owned()));
                        }
                        self.snapshot.interaction.timers.insert(id, SceneTimer { target, remaining_ms: delay_ms, interval_ms });
                    }
                }
                self.snapshot.location.node_id = next;
            }
            SceneNode::Wait { duration_ms, next } => {
                if !effect_only { self.snapshot.location.node_id = next; }
                cues.push(
                    self.cue(CueGate::Runtime, PresentationCueKind::Delay { duration_ms }),
                );
                return Ok(true);
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
                if !effect_only { self.snapshot.location.node_id = next; }
                cues.push(self.cue(
                    gate(await_completion),
                    PresentationCueKind::BgmTransition {
                        from,
                        to,
                        duration_ms,
                    },
                ));
                if await_completion {
                    return Ok(true);
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
                if !effect_only { self.snapshot.location.node_id = next; }
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
                    return Ok(true);
                }
            }
            SceneNode::Sfx {
                asset,
                volume,
                next,
            } => {
                if !effect_only { self.snapshot.location.node_id = next; }
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
                if !effect_only { self.snapshot.location.node_id = next; }
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
                    return Ok(true);
                }
            }
            SceneNode::ScreenEffect {
                effect,
                duration_ms,
                await_completion,
                next,
            } => {
                if !effect_only { self.snapshot.location.node_id = next; }
                cues.push(self.cue(
                    gate(await_completion),
                    PresentationCueKind::ScreenEffect {
                        effect,
                        duration_ms,
                    },
                ));
                if await_completion {
                    return Ok(true);
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
                if !effect_only { self.snapshot.location.node_id = next; }
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
                            return Ok(false);
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
                    return Ok(true);
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
                if !effect_only { self.snapshot.location.node_id = next; }
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
                        return Ok(true);
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
                if !effect_only { self.snapshot.location.node_id = next; }
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
                if !effect_only { self.snapshot.location.node_id = next; }
                cues.push(self.cue(
                    gate(await_completion),
                    PresentationCueKind::UiMotion {
                        duration_ms: cue_duration,
                        motion: preset,
                    },
                ));
                if await_completion {
                    return Ok(true);
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
                if !effect_only { self.snapshot.location.node_id = next; }
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
                if !effect_only { self.snapshot.location.node_id = next; }
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
                if !effect_only { self.snapshot.location.node_id = next; }
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
                if !effect_only { self.snapshot.location.node_id = next; }
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
                    return Ok(true);
                }
            }
            SceneNode::End => {
                self.snapshot.interaction.timers.clear();
                self.completed_scenes.insert(scene_id.to_owned());
                self.snapshot.dialogue_page = None;
                self.snapshot.long_text_page = None;
                self.snapshot.prompt = PromptSnapshot::End {
                    prompt_id: format!("{scene_id}/{node_id}"),
                };
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Reset the visual portion of a scene. This is also used by an explicit
    /// `clear` node, which must not reset the rest of the scene's state.
    fn clear_scene_visual_state(&mut self) {
        self.snapshot.world.sprites.clear();
        self.snapshot.world.emitters.clear();
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
    ///
    /// The secondary-window runtime shares the host-authoritative variable maps
    /// with the main runtime, so it deliberately preserves them here; only the
    /// main runtime owns the shared map's reset. The pending append queue is
    /// left untouched as well so a boundary inside one command cannot drop an
    /// occurrence the host has not drained yet.
    pub(super) fn leave_scene(
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
        self.snapshot.interaction.timers.clear();
        self.snapshot.interaction.blocks.clear();
        self.snapshot.interaction.prompt_source = None;
        if !self.shared_save_variables {
            self.snapshot.variables = defaults_for_scope(content, VariableScope::Save)?;
        }
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

#[allow(clippy::too_many_arguments)]
pub(super) fn make_button_snapshot(
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
