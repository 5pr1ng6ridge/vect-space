use crate::{
    content::ContentCatalog,
    model::{
        AudioAction, AudioSnapshot, BootstrapPayload, CameraSnapshot, ChoiceSnapshot, CueGate,
        LoopingAudioSnapshot, PresentationCue, PresentationCueKind, PromptSnapshot,
        RuntimeSnapshot, RuntimeUpdate, SceneNode, SpriteAction, SpriteSnapshot, StoryLocation,
        WorldSnapshot,
    },
};
use thiserror::Error;

const MAX_IMMEDIATE_NODES: usize = 10_000;

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

#[derive(Debug)]
pub struct RuntimeEngine {
    snapshot: RuntimeSnapshot,
    started: bool,
    next_update_id: u64,
    next_cue_id: u64,
    pending_runtime_update: Option<u64>,
}

impl RuntimeEngine {
    pub fn new(content: &ContentCatalog) -> Result<Self, RuntimeError> {
        let snapshot = initial_snapshot(content)?;
        Ok(Self {
            snapshot,
            started: false,
            next_update_id: 1,
            next_cue_id: 1,
            pending_runtime_update: None,
        })
    }

    pub fn bootstrap(&mut self, content: &ContentCatalog) -> BootstrapPayload {
        let update = self.update_without_cues();
        BootstrapPayload {
            update,
            asset_ids: content.asset_ids(),
            content_version: content.manifest.content_version.clone(),
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
    ) -> Result<RuntimeUpdate, RuntimeError> {
        self.ensure_interactive(expected_revision)?;
        if !matches!(self.snapshot.prompt, PromptSnapshot::Dialogue { .. }) {
            return Err(RuntimeError::AdvanceNotAllowed);
        }
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
    ) -> Result<RuntimeUpdate, RuntimeError> {
        let expected = self
            .pending_runtime_update
            .ok_or(RuntimeError::InvalidAcknowledgement {
                expected: 0,
                actual: update_id,
            })?;
        if expected != update_id {
            return Err(RuntimeError::InvalidAcknowledgement {
                expected,
                actual: update_id,
            });
        }
        self.pending_runtime_update = None;
        let cues = self.run_until_boundary(content)?;
        Ok(self.finish_update(cues, true))
    }

    pub fn snapshot(&self) -> &RuntimeSnapshot {
        &self.snapshot
    }

    pub fn pending_runtime_update(&self) -> Option<u64> {
        self.pending_runtime_update
    }

    pub fn load_snapshot(
        &mut self,
        content: &ContentCatalog,
        mut snapshot: RuntimeSnapshot,
    ) -> Result<RuntimeUpdate, RuntimeError> {
        validate_snapshot(content, &snapshot)?;
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
        if let Some(update_id) = self.pending_runtime_update {
            return Err(RuntimeError::PresentationPending(update_id));
        }
        if self.snapshot.revision != expected_revision {
            return Err(RuntimeError::StaleRevision {
                expected: expected_revision,
                actual: self.snapshot.revision,
            });
        }
        Ok(())
    }

    fn run_until_boundary(
        &mut self,
        content: &ContentCatalog,
    ) -> Result<Vec<PresentationCue>, RuntimeError> {
        let mut cues = Vec::new();
        for _ in 0..MAX_IMMEDIATE_NODES {
            let scene_id = self.snapshot.location.scene_id.clone();
            let node_id = self.snapshot.location.node_id.clone();
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
                SceneNode::Say {
                    speaker,
                    text,
                    speed_cps,
                    next,
                } => {
                    let prompt_id = format!("{scene_id}/{node_id}");
                    self.snapshot.location.node_id = next;
                    self.snapshot.prompt = PromptSnapshot::Dialogue {
                        prompt_id: prompt_id.clone(),
                        speaker,
                        text,
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
                    self.snapshot.prompt = PromptSnapshot::Choice {
                        prompt_id,
                        choices: choices
                            .into_iter()
                            .map(|choice| ChoiceSnapshot {
                                id: choice.id,
                                label: choice.label,
                                enabled: true,
                            })
                            .collect(),
                    };
                    return Ok(cues);
                }
                SceneNode::Set {
                    variable,
                    value,
                    next,
                } => {
                    self.snapshot.variables.insert(variable, value);
                    self.snapshot.location.node_id = next;
                }
                SceneNode::Branch {
                    variable,
                    equals,
                    then,
                    otherwise,
                } => {
                    self.snapshot.location.node_id =
                        if self.snapshot.variables.get(&variable) == Some(&equals) {
                            then
                        } else {
                            otherwise
                        };
                }
                SceneNode::Jump { scene, target } => {
                    if let Some(scene) = scene {
                        self.snapshot.location.scene_id = scene;
                    }
                    self.snapshot.location.node_id = target;
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
                    let to = CameraSnapshot { x, y, zoom };
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
                    duration_ms,
                    await_completion,
                    next,
                } => {
                    self.snapshot.world.dialogue_ui_visible = visible;
                    self.snapshot.location.node_id = next;
                    cues.push(self.cue(
                        gate(await_completion),
                        PresentationCueKind::DialogueUiTransition {
                            visible,
                            duration_ms,
                        },
                    ));
                    if await_completion {
                        return Ok(cues);
                    }
                }
                SceneNode::End => {
                    self.snapshot.prompt = PromptSnapshot::End {
                        prompt_id: format!("{scene_id}/{node_id}"),
                    };
                    return Ok(cues);
                }
            }
        }
        Err(RuntimeError::ImmediateLoop)
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

    fn finish_update(&mut self, cues: Vec<PresentationCue>, bump_revision: bool) -> RuntimeUpdate {
        if bump_revision {
            self.snapshot.revision = self.snapshot.revision.saturating_add(1);
        }
        let update_id = self.next_update_id;
        self.next_update_id = self.next_update_id.saturating_add(1);
        let requires_ack = cues.iter().any(|cue| cue.gate == CueGate::Runtime);
        if requires_ack {
            self.pending_runtime_update = Some(update_id);
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

fn gate(await_completion: bool) -> CueGate {
    if await_completion {
        CueGate::Runtime
    } else {
        CueGate::None
    }
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
        variables: Default::default(),
        world: WorldSnapshot::default(),
        audio: AudioSnapshot::default(),
        prompt: PromptSnapshot::None,
    })
}

fn validate_snapshot(
    content: &ContentCatalog,
    snapshot: &RuntimeSnapshot,
) -> Result<(), RuntimeError> {
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
    if !snapshot.world.camera.zoom.is_finite() || snapshot.world.camera.zoom <= 0.0 {
        return Err(RuntimeError::InvalidSnapshot(
            "相机缩放不是有效正数".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn catalog() -> ContentCatalog {
        ContentCatalog::from_root(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../game"))
            .expect("demo content must be valid")
    }

    #[test]
    fn stale_revision_cannot_skip_dialogue() {
        let content = catalog();
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        let first = runtime.start_new_game(&content).unwrap();
        if first.requires_ack {
            let next = runtime
                .presentation_complete(&content, first.update_id)
                .unwrap();
            assert!(matches!(
                next.snapshot.prompt,
                PromptSnapshot::Dialogue { .. }
            ));
            assert!(matches!(
                runtime.advance(&content, first.snapshot.revision),
                Err(RuntimeError::StaleRevision { .. })
            ));
        }
    }

    #[test]
    fn snapshots_round_trip_as_json() {
        let content = catalog();
        let mut runtime = RuntimeEngine::new(&content).unwrap();
        runtime.start_new_game(&content).unwrap();
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
            runtime.advance(&content, update.snapshot.revision),
            Err(RuntimeError::PresentationPending(_))
        ));
        assert!(matches!(
            runtime.presentation_complete(&content, update.update_id + 1),
            Err(RuntimeError::InvalidAcknowledgement { .. })
        ));
        assert!(runtime
            .presentation_complete(&content, update.update_id)
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
}
