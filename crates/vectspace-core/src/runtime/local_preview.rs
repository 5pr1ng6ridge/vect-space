//! Window requests for a single-window editor preview. The desktop host owns
//! the real two-window semantics; a preview applies only what targets its own
//! window and reports everything else instead of pretending it happened.

use super::*;

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
