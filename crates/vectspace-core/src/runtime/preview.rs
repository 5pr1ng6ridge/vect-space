use crate::content::ContentCatalog;
use crate::interaction::{WindowControlAction, WindowRequest, WindowRole};
use crate::model::{
    AdvanceSource, ChoiceSnapshot, PlaybackAutoMode, PresentationOutcome, PromptSnapshot,
    RuntimeSnapshot, RuntimeUpdate, SceneNode, StoryLocation,
};
use super::{MAX_IMMEDIATE_NODES, RuntimeEngine, RuntimeError};

/// A deterministic choice supplied by the editor's timeline-context wizard.
/// `visit` disambiguates loops that encounter the same choice node more than
/// once while replaying from the scene entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewChoiceDecision {
    pub scene_id: String,
    pub node_id: String,
    pub visit: usize,
    pub choice_id: String,
}

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

fn preview_successor(scene_id: &str, node: &SceneNode) -> Option<StoryLocation> {
    let local = |next: &str| StoryLocation {
        scene_id: scene_id.to_owned(),
        node_id: next.to_owned(),
    };
    match node {
        SceneNode::Background { next, .. }
        | SceneNode::Sprite { next, .. }
        | SceneNode::Particle { next, .. }
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
        | SceneNode::Timeline { next, .. }
        | SceneNode::OpenWindow { next, .. }
        | SceneNode::WindowTitle { next, .. }
        | SceneNode::WindowControl { next, .. }
        | SceneNode::WindowGeometry { next, .. }
        | SceneNode::WindowLayer { next, .. }
        | SceneNode::Timer { next, .. } => Some(local(next)),
        SceneNode::Jump { scene, target } => Some(StoryLocation {
            scene_id: scene.clone().unwrap_or_else(|| scene_id.to_owned()),
            node_id: target.clone(),
        }),
        SceneNode::Choice { .. } | SceneNode::Condition { .. } | SceneNode::End => None,
    }
}

impl RuntimeEngine {
    /// Replay one Scene from its entry until immediately before `target`.
    /// Dialogue and awaited presentation boundaries are completed internally;
    /// choices are returned to the editor so the caller can extend the path.
    /// The replay never leaves the target's Scene, so a path that does ends as
    /// `Unreachable` instead of silently changing the preview context.
    pub fn preview_to_from_scene_entry(
        &mut self,
        content: &ContentCatalog,
        scene_id: &str,
        target: &StoryLocation,
        decisions: &[PreviewChoiceDecision],
    ) -> Result<PreviewRunResult, RuntimeError> {
        self.preview_target = Some(target.clone());
        self.preview_skip_target_once = false;
        let mut last_trace = Vec::new();
        let result = (|| {
            let mut visits = std::collections::BTreeMap::<StoryLocation, usize>::new();
            let mut trace = Vec::new();
            let mut update = self.start_scene_preview(content, scene_id)?;
            for _ in 0..MAX_IMMEDIATE_NODES {
                if self.snapshot.location.scene_id != target.scene_id {
                    return Err(RuntimeError::Content(format!(
                        "当前 Scene 内无法到达预览目标 {}/{}：路径已离开 {}",
                        target.scene_id, target.node_id, target.scene_id
                    )));
                }
                if trace.last() != Some(&self.snapshot.location) {
                    trace.push(self.snapshot.location.clone());
                    last_trace.clone_from(&trace);
                }
                if self.host_boundary {
                    // Reconstruction only needs this window's flow; requests
                    // for the other window cannot change it.
                    let local = content
                        .scene(&self.snapshot.location.scene_id)
                        .map_err(|error| RuntimeError::Content(error.to_string()))?
                        .window_role;
                    update = self.settle_local_host(content, local, update, &mut Vec::new())?;
                    continue;
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

    /// Continue a live editor preview from the current location to the next
    /// interactive boundary.
    ///
    /// [`preview_execute_current_node`] is a one-shot *static* preview: it stops
    /// at the selected node's successor so the editor can inspect exactly that
    /// node's update.  A live session must instead behave like gameplay: after
    /// executing the selected node it keeps running immediate nodes
    /// (background/set/ui/audio, non-awaited cues) until a real prompt or an
    /// awaited presentation gate, so a selected immediate node never stalls on
    /// an empty prompt.  The node at the current location is executed exactly
    /// once.
    pub fn preview_enter_current_node(
        &mut self,
        content: &ContentCatalog,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        self.preview_target = None;
        self.preview_skip_target_once = false;
        let cues = self.run_until_boundary(content)?;
        Ok(self.finish_update(cues, true))
    }

    /// Start an isolated session at a scene's declared entry.  It keeps the
    /// profile/variable clone of the runtime it is called on and never touches
    /// the player's persisted state.
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
        self.begin_session(
            content,
            Some(StoryLocation {
                scene_id: scene_id.to_owned(),
                node_id: entry,
            }),
        )
    }

    /// Start an isolated editor preview directly at an arbitrary node.
    ///
    /// This is the explicit "reset and start here" fallback the editor offers
    /// when a target cannot be reconstructed from the scene entry.  It builds
    /// the same fresh preview snapshot and override set as
    /// [`start_scene_preview`], validates the scene and node *before* touching
    /// any runtime state, then positions the runtime at the target and executes
    /// it.  No preceding authored node, action or choice runs, so the initial
    /// world is the scene's declared defaults plus the supplied overrides.
    pub fn start_node_preview(
        &mut self,
        content: &ContentCatalog,
        scene_id: &str,
        node_id: &str,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        let scene = content
            .scene(scene_id)
            .map_err(|error| RuntimeError::Content(error.to_string()))?;
        if !scene.nodes.contains_key(node_id) {
            return Err(RuntimeError::Content(format!(
                "节点不存在: {scene_id}/{node_id}"
            )));
        }
        self.begin_session(
            content,
            Some(StoryLocation {
                scene_id: scene_id.to_owned(),
                node_id: node_id.to_owned(),
            }),
        )
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
}

// Window requests of a single-window editor preview.  The desktop host owns
// the real two-window semantics; a preview applies only what targets its own
// window and reports everything else instead of pretending it happened.

const MAX_LOCAL_HOST_STEPS: usize = 64;

impl RuntimeEngine {
    /// Settle every host boundary reached by `update`, merging the resumed
    /// cues so the caller still presents one update.
    pub fn settle_local_host(
        &mut self,
        content: &ContentCatalog,
        local: WindowRole,
        mut update: RuntimeUpdate,
        notes: &mut Vec<String>,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        for _ in 0..MAX_LOCAL_HOST_STEPS {
            if !self.host_boundary {
                // Window geometry/layer requests need no boundary but must
                // still be reported now, not at some later boundary.
                if self.window_requests.is_empty() {
                    return Ok(update);
                }
                if let Some(mut advanced) = self.apply_local_requests(content, local, notes)? {
                    update.cues.append(&mut advanced.cues);
                    advanced.cues = std::mem::take(&mut update.cues);
                    update = advanced;
                }
                continue;
            }
            // The source runtime is mid-story here, so a self advance is
            // reported by `apply_local_requests` rather than applied.
            self.apply_local_requests(content, local, notes)?;
            let mut resumed = self.resume_after_host(content)?;
            update.cues.append(&mut resumed.cues);
            resumed.cues = std::mem::take(&mut update.cues);
            update = resumed;
        }
        Err(RuntimeError::ImmediateLoop)
    }

    /// Apply requests queued outside a story boundary (timer callbacks).
    /// Returns the story update of a local script advance, already settled.
    pub fn settle_local_requests(
        &mut self,
        content: &ContentCatalog,
        local: WindowRole,
        notes: &mut Vec<String>,
    ) -> Result<Vec<RuntimeUpdate>, RuntimeError> {
        let mut updates = Vec::new();
        if let Some(update) = self.apply_local_requests(content, local, notes)? {
            updates.push(self.settle_local_host(content, local, update, notes)?);
        }
        Ok(updates)
    }

    fn apply_local_requests(
        &mut self,
        content: &ContentCatalog,
        local: WindowRole,
        notes: &mut Vec<String>,
    ) -> Result<Option<RuntimeUpdate>, RuntimeError> {
        let scene_id = self.snapshot.location.scene_id.clone();
        let mut advance = false;
        for request in self.take_window_requests() {
            match request {
                WindowRequest::Title { target, title } if target == local => {
                    let mut titles = self.snapshot.interaction.titles.clone();
                    titles.set(target, title);
                    self.set_window_titles(titles);
                }
                WindowRequest::Control { target, action: WindowControlAction::Advance, .. }
                    if target == local =>
                {
                    if self.can_script_advance() {
                        advance = true;
                    } else {
                        notes.push("预览窗口当前不可推进：脚本推进已忽略，不会排队到之后的对话".to_owned());
                    }
                }
                WindowRequest::Control { target, action, id, message } if target == local => {
                    self.control_block(local, &scene_id, action, &id, &message);
                }
                // Moving or restacking the editor's own window would be wrong
                // for either target.
                WindowRequest::Geometry { .. } => {
                    notes.push("预览不会移动或缩放真实窗口：窗口位置/大小未应用，请在桌面运行验证".to_owned());
                }
                WindowRequest::Layer { .. } => {
                    notes.push("预览不会改变真实窗口层级：窗口层级未应用，请在桌面运行验证".to_owned());
                }
                WindowRequest::Title { .. } => {
                    notes.push("预览是单窗口：另一窗口的标题修改未应用，请在桌面双窗口运行验证".to_owned());
                }
                WindowRequest::Control { action, .. } => {
                    let what = match action {
                        WindowControlAction::Block => "阻挡",
                        WindowControlAction::Unblock => "解除阻挡",
                        WindowControlAction::Advance => "脚本推进",
                    };
                    notes.push(format!("预览是单窗口：对另一窗口的{what}未应用，请在桌面双窗口运行验证"));
                }
            }
        }
        self.refresh_prompt(content)?;
        if !advance {
            return Ok(None);
        }
        self.advance(content, self.snapshot.revision, AdvanceSource::Script).map(Some)
    }
}
