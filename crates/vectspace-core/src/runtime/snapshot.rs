use crate::content::ContentCatalog;
use crate::model::{
    AssetKind, AudioSnapshot, CurtainFill, LongTextMode, PlaybackSnapshot, PromptSnapshot,
    RuntimeSnapshot, SceneNode, StoryLocation, VariableScope, WorldSnapshot,
};
use crate::visual::PARTICLE_SURFACE_MAX_LIVE;
use super::RuntimeError;
use super::dialogue::{long_text_document_id, validate_long_text_document_size};
use super::interaction::validate_interaction_snapshot;
use super::variables::{defaults_for_scope, validate_variables_for_scope};

pub(super) fn initial_snapshot(content: &ContentCatalog) -> Result<RuntimeSnapshot, RuntimeError> {
    let scene = content
        .scene(&content.manifest.entry_scene)
        .map_err(|error| RuntimeError::Content(error.to_string()))?;
    Ok(RuntimeSnapshot {
        interaction: Default::default(),
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

pub(super) fn validate_snapshot(
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
            || button.scale_x == 0.0
            || button.scale_y == 0.0
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
    if let PromptSnapshot::Choice { .. } = &snapshot.prompt {
        if !matches!(
            scene.nodes.get(&snapshot.location.node_id),
            Some(SceneNode::Choice { .. })
        ) {
            return Err(RuntimeError::InvalidSnapshot(
                "选择提示的位置不是 choice 节点".to_owned(),
            ));
        }
        // An empty or all-disabled filtered choice is a valid waiting state:
        // another window or a timer may still unlock an option.
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
    // After the prompt/location checks so their more specific errors win.
    validate_interaction_snapshot(content, snapshot)?;
    let mut referenced_assets = Vec::new();
    for sprite in snapshot.world.sprites.values() {
        if ![sprite.x, sprite.y, sprite.scale, sprite.scale_x, sprite.scale_y, sprite.rotation_deg, sprite.opacity, sprite.anchor_x, sprite.anchor_y].into_iter().all(f32::is_finite)
            || sprite.scale <= 0.0 || sprite.scale_x == 0.0 || sprite.scale_y == 0.0
            || !(0.0..=1.0).contains(&sprite.opacity) || !(0.0..=1.0).contains(&sprite.anchor_x) || !(0.0..=1.0).contains(&sprite.anchor_y)
            || sprite.layout.as_ref().is_some_and(|layout| [layout.width, layout.height].into_iter().any(|size| !size.is_finite() || size <= 0.0 || size > 16_384.0)) {
            return Err(RuntimeError::InvalidSnapshot("Sprite 布局或变换无效".into()));
        }
        content.validate_sprite_source(&sprite.source).map_err(|error| RuntimeError::InvalidSnapshot(error.to_string()))?;
        if let Some(asset) = sprite.source.image_asset() { referenced_assets.push(asset.to_owned()); }
    }
    let mut particle_budget = 0_u32;
    for emitter in snapshot.world.emitters.values() {
        let definition = content.particles.get(&emitter.particle).ok_or_else(|| RuntimeError::InvalidSnapshot(format!("未知粒子定义 {}", emitter.particle)))?;
        particle_budget = particle_budget.saturating_add(definition.max_particles);
        if particle_budget > PARTICLE_SURFACE_MAX_LIVE || ![emitter.x, emitter.y, emitter.scale, emitter.rotation_deg, emitter.opacity].into_iter().all(f32::is_finite)
            || emitter.scale <= 0.0 || !(0.0..=1.0).contains(&emitter.opacity) {
            return Err(RuntimeError::InvalidSnapshot("发射器变换或预算无效".into()));
        }
        referenced_assets.push(definition.image.clone());
    }
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
            || sprite.scale_x == 0.0
            || sprite.scale_y == 0.0
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
