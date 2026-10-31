use crate::content::ContentCatalog;
use crate::model::{
    CueGate, LongTextExit, LongTextPageSnapshot, LongTextStepSnapshot, PresentationCue,
    PresentationCueKind, PromptSnapshot, RuntimeSnapshot, SceneNode,
};
use super::{
    MAX_LONG_TEXT_DOCUMENT_BYTES, MAX_LONG_TEXT_DOCUMENT_STEPS, RuntimeEngine, RuntimeError,
};

impl RuntimeEngine {
    pub(super) fn advance_long_text(
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
            self.mark_prompt_source(&scene_id, &node_id);
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
}

pub(super) fn long_text_document_id(scene_id: &str, node_id: &str, document: Option<&str>) -> String {
    match document {
        Some(document) => format!("{scene_id}/{document}"),
        None => format!("{scene_id}/{node_id}"),
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

pub(super) fn validate_long_text_document_size(
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
