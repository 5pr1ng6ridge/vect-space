use std::collections::{BTreeMap, BTreeSet};

use super::visuals;

use crate::model::{
    AssetDefinition, AssetKind, AudioAction, BackgroundTransitionSpec, ButtonTemplate,
    CharacterDefinition, CurtainAction, DialogueMode, LONG_TEXT_FONT_SIZE_MAX,
    LONG_TEXT_FONT_SIZE_MIN, LongTextMode, LongTextPagination, SceneDefinition, SceneNode,
    SpriteAction, SpriteActionDefinition, TimelineTrack, TRANSITION_SOFTNESS_MAX, UiMotionPreset,
    VariableDefinition,
};
use crate::visual::SpriteSource;
use super::ContentError;
use super::common::{node_error, validate_color, validate_display_name, validate_identifier};
use super::conditions::{validate_condition, validate_mutation};
use super::effects::{validate_curtain_fill, validate_screen_effect};
use super::markup::validate_text_markup;
use super::timeline::validate_timeline;
use super::ui::{validate_button_action, validate_button_assets, validate_ui_motion_reference};

const MAX_LONG_TEXT_STEPS: usize = 1_024;

#[allow(clippy::too_many_arguments)]
pub(super) fn validate_scenes(
    scenes: &BTreeMap<String, SceneDefinition>,
    assets: &BTreeMap<String, AssetDefinition>,
    variables: &BTreeMap<String, VariableDefinition>,
    characters: &BTreeMap<String, CharacterDefinition>,
    ui_motions: &BTreeMap<String, UiMotionPreset>,
    buttons: &BTreeMap<String, ButtonTemplate>,
    actions: &BTreeMap<String, SpriteActionDefinition>,
    proofs: &vectspace_proof::library::ProofLibrary,
) -> Result<(), ContentError> {
    #[derive(Clone)]
    struct LongTextPresentation {
        pagination: LongTextPagination,
        font_size: f32,
        text_color: String,
        layout: crate::model::LongTextLayout,
    }

    for (scene_id, scene) in scenes {
        if !scene.nodes.contains_key(&scene.entry) {
            return Err(ContentError::Validation(format!(
                "场景 {scene_id} 的入口节点不存在: {}",
                scene.entry
            )));
        }
        let mut long_text_documents = BTreeMap::<String, (bool, BTreeSet<String>)>::new();
        let mut long_text_starts = BTreeMap::<String, LongTextPresentation>::new();
        for (node_id, node) in &scene.nodes {
            if let SceneNode::LongText {
                document,
                mode,
                pagination,
                font_size,
                text_color,
                layout,
                steps,
                ..
            } = node
            {
                let document_id = document.clone().unwrap_or_else(|| node_id.clone());
                validate_identifier("long text document id", &document_id)?;
                if *mode == LongTextMode::Continue && document.is_none() {
                    return node_error(scene_id, node_id, "continue 长文本必须提供 document");
                }
                let entry = long_text_documents
                    .entry(document_id.clone())
                    .or_insert_with(|| (false, BTreeSet::new()));
                if *mode == LongTextMode::Start {
                    if entry.0 {
                        return node_error(scene_id, node_id, "同一文稿只能有一个 start 节点");
                    }
                    entry.0 = true;
                    long_text_starts.insert(
                        document_id.clone(),
                        LongTextPresentation {
                            pagination: pagination.unwrap_or_default(),
                            font_size: font_size
                                .unwrap_or(crate::model::LONG_TEXT_FONT_SIZE_DEFAULT),
                            text_color: text_color.clone().unwrap_or_else(|| {
                                crate::model::LONG_TEXT_COLOR_DEFAULT.to_owned()
                            }),
                            layout: layout.clone().unwrap_or_default(),
                        },
                    );
                }
                for step in steps {
                    if !entry.1.insert(step.id.clone()) {
                        return node_error(scene_id, node_id, "同一文稿的 step id 重复");
                    }
                }
            }
        }
        for (document_id, (has_start, _)) in &long_text_documents {
            if !has_start {
                return Err(ContentError::Validation(format!(
                    "场景 {scene_id} 的长文本 {document_id} 缺少 start 节点"
                )));
            }
        }
        for (node_id, node) in &scene.nodes {
            validate_identifier("node id", node_id)?;
            match node {
                SceneNode::Background {
                    background,
                    transition,
                    duration_ms,
                    next,
                    ..
                } => {
                    if let Some(id) = background {
                        require_asset(assets, id, AssetKind::Background, scene_id, node_id)?;
                    }
                    validate_background_transition(transition, scene_id, node_id)?;
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Sprite {
                    action,
                    source,
                    asset,
                    character,
                    expression,
                    crossfade_ms,
                    x,
                    y,
                    scale,
                    opacity,
                    duration_ms,
                    next,
                    ..
                } => {
                    if *action == SpriteAction::Show && source.is_none() && asset.is_none() && character.is_none() {
                        return node_error(
                            scene_id,
                            node_id,
                            "show 动作必须提供 asset 或 character",
                        );
                    }
                    if let Some(id) = asset {
                        visuals::source(&SpriteSource::Image { asset: id.clone() }, assets, &BTreeMap::new())?;
                    }
                    if let Some(character_id) = character {
                        let Some(character_definition) = characters.get(character_id) else {
                            return Err(ContentError::Validation(format!(
                                "{scene_id}/{node_id}: 未知角色 {character_id}"
                            )));
                        };
                        if let Some(expression_id) = expression {
                            if !character_definition.expressions.contains_key(expression_id) {
                                return Err(ContentError::Validation(format!(
                                    "{scene_id}/{node_id}: 角色 {character_id} 未定义表情 {expression_id}"
                                )));
                            }
                        } else if character_definition.default_expression.is_none()
                            && asset.is_none()
                            && *action != SpriteAction::Hide
                        {
                            return Err(ContentError::Validation(format!(
                                "{scene_id}/{node_id}: 角色 {character_id} 没有可用表情或素材"
                            )));
                        }
                    } else if expression.is_some() {
                        return node_error(
                            scene_id,
                            node_id,
                            "expression 必须与 character 一起使用",
                        );
                    }
                    if x.is_some_and(|value| !value.is_finite())
                        || y.is_some_and(|value| !value.is_finite())
                    {
                        return node_error(scene_id, node_id, "sprite 坐标必须是有限数");
                    }
                    if scale.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                        return node_error(scene_id, node_id, "scale 必须是有限正数");
                    }
                    if opacity.is_some_and(|value| !(0.0..=1.0).contains(&value)) {
                        return node_error(scene_id, node_id, "opacity 必须在 0 到 1 之间");
                    }
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    if let Some(duration) = crossfade_ms {
                        validate_duration(*duration, scene_id, node_id)?;
                    }
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Particle { next, .. } => {
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Clear {
                    duration_ms, next, ..
                } => {
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Say {
                    speaker,
                    text,
                    mode,
                    page_id,
                    speed_cps,
                    next,
                    ..
                } => {
                    if text.trim().is_empty() {
                        return node_error(scene_id, node_id, "对话文本不能为空");
                    }
                    if let Some(speaker) = speaker {
                        if !characters.contains_key(speaker) {
                            validate_display_name(speaker).map_err(|message| {
                                ContentError::Validation(format!(
                                    "{scene_id}/{node_id}: 临时说话人无效: {message}"
                                ))
                            })?;
                        }
                    }
                    if let Some(page_id) = page_id {
                        validate_identifier("dialogue page id", page_id)?;
                    }
                    if *mode == DialogueMode::Append && page_id.is_none() {
                        return node_error(scene_id, node_id, "append 对话必须提供 page_id");
                    }
                    if speed_cps.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                        return node_error(scene_id, node_id, "speed_cps 必须是有限正数");
                    }
                    validate_text_markup(text, variables, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::LongText {
                    document,
                    mode,
                    paper,
                    pagination,
                    font_size,
                    text_color,
                    layout,
                    steps,
                    speed_cps,
                    next,
                    ..
                } => {
                    if *mode == LongTextMode::Continue
                        && (paper.is_some()
                            || pagination.is_some()
                            || font_size.is_some()
                            || text_color.is_some()
                            || layout.is_some())
                    {
                        return node_error(
                            scene_id,
                            node_id,
                            "continue 长文本只能继承 start 的纸张、分页、字号、颜色和布局",
                        );
                    }
                    let document_id = document.clone().unwrap_or_else(|| node_id.clone());
                    let (pagination, font_size, text_color, layout) = if *mode
                        == LongTextMode::Continue
                    {
                        let presentation = long_text_starts.get(&document_id).ok_or_else(|| {
                            ContentError::Validation(format!(
                                "{scene_id}/{node_id}: 接续长文本缺少 start 节点"
                            ))
                        })?;
                        (
                            presentation.pagination,
                            presentation.font_size,
                            presentation.text_color.clone(),
                            presentation.layout.clone(),
                        )
                    } else {
                        (
                            pagination.unwrap_or_default(),
                            font_size.unwrap_or(crate::model::LONG_TEXT_FONT_SIZE_DEFAULT),
                            text_color.clone().unwrap_or_else(|| {
                                crate::model::LONG_TEXT_COLOR_DEFAULT.to_owned()
                            }),
                            layout.clone().unwrap_or_default(),
                        )
                    };
                    if let Some(paper) = paper {
                        require_asset(assets, paper, AssetKind::Gui, scene_id, node_id)?;
                    }
                    if steps.is_empty() || steps.len() > MAX_LONG_TEXT_STEPS {
                        return node_error(scene_id, node_id, "长文本必须包含 1 到 1024 个步骤");
                    }
                    if *mode == LongTextMode::Continue && document.is_none() {
                        return node_error(scene_id, node_id, "continue 长文本必须提供 document");
                    }
                    if speed_cps.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                        return node_error(scene_id, node_id, "speed_cps 必须是有限正数");
                    }
                    if !font_size.is_finite()
                        || font_size < LONG_TEXT_FONT_SIZE_MIN
                        || font_size > LONG_TEXT_FONT_SIZE_MAX
                    {
                        return node_error(
                            scene_id,
                            node_id,
                            "长文本 font_size 必须在 16 到 72 之间",
                        );
                    }
                    validate_color(&text_color).map_err(|message| {
                        ContentError::Validation(format!(
                            "{scene_id}/{node_id}: 长文本颜色无效: {message}"
                        ))
                    })?;
                    let values = [
                        layout.x,
                        layout.y,
                        layout.width,
                        layout.height,
                        layout.padding_x,
                        layout.padding_y,
                        layout.page_height,
                        layout.page_gap,
                    ];
                    if values.iter().any(|value| !value.is_finite())
                        || layout.x < 0.0
                        || layout.y < 0.0
                        || layout.width < 160.0
                        || layout.height < 240.0
                        || layout.x + layout.width > 1920.0
                        || layout.y + layout.height > 1080.0
                        || layout.padding_x < 0.0
                        || layout.padding_y < 0.0
                        || layout.width <= layout.padding_x * 2.0 + 80.0
                        || layout.height <= layout.padding_y * 2.0 + 80.0
                        || layout.page_height <= layout.padding_y * 2.0 + 80.0
                        || layout.page_gap < 0.0
                    {
                        return node_error(
                            scene_id,
                            node_id,
                            "长文本 layout 非法或超出 1920×1080 画面",
                        );
                    }
                    let mut ids = BTreeSet::new();
                    for (index, step) in steps.iter().enumerate() {
                        validate_identifier("long text step id", &step.id)?;
                        if !ids.insert(&step.id) {
                            return node_error(scene_id, node_id, "长文本 step id 重复");
                        }
                        if step.text.trim().is_empty() {
                            return node_error(scene_id, node_id, "长文本步骤不能为空");
                        }
                        if *mode == LongTextMode::Start && index == 0 && step.page_break_before {
                            return node_error(
                                scene_id,
                                node_id,
                                "长文本第一步骤不能在前方强制分页",
                            );
                        }
                        if pagination == LongTextPagination::Continuous && step.page_break_before {
                            return node_error(
                                scene_id,
                                node_id,
                                "连续长文本不能使用 page_break_before",
                            );
                        }
                        validate_text_markup(&step.text, variables, scene_id, node_id)?;
                    }
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::LongTextControl { document, next, .. } => {
                    validate_identifier("long text document id", document)?;
                    if !long_text_documents.contains_key(document) {
                        return node_error(scene_id, node_id, "文稿控制引用了未知文稿");
                    }
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Proof { puzzle, next, abandon } => {
                    if scene.window_role != crate::interaction::WindowRole::Main {
                        return node_error(scene_id, node_id, "proof nodes are supported only in main-window scenes");
                    }
                    if proofs.puzzle(puzzle).is_none() {
                        return node_error(scene_id, node_id, &format!("unknown proof puzzle: {puzzle}"));
                    }
                    require_node(scene, next, scene_id, node_id)?;
                    if let Some(target) = abandon { require_node(scene, target, scene_id, node_id)?; }
                }
                SceneNode::Choice { choices, .. } => {
                    if choices.is_empty() {
                        return node_error(scene_id, node_id, "选项列表不能为空");
                    }
                    let mut ids = BTreeSet::new();
                    for choice in choices {
                        validate_identifier("choice id", &choice.id)?;
                        if !ids.insert(&choice.id) {
                            return node_error(scene_id, node_id, "choice id 重复");
                        }
                        validate_text_markup(&choice.label, variables, scene_id, node_id)?;
                        if let Some(condition) = &choice.visible_if {
                            validate_condition(condition, variables, scene_id, node_id)?;
                        }
                        if let Some(condition) = &choice.enabled_if {
                            validate_condition(condition, variables, scene_id, node_id)?;
                        }
                        require_node(scene, &choice.next, scene_id, node_id)?;
                    }
                }
                SceneNode::Set {
                    variable,
                    op,
                    value,
                    next,
                } => {
                    validate_identifier("variable", variable)?;
                    let definition = variables.get(variable).ok_or_else(|| {
                        ContentError::Validation(format!(
                            "{scene_id}/{node_id}: 引用了未声明变量 {variable}"
                        ))
                    })?;
                    validate_mutation(
                        *op,
                        value.as_ref(),
                        definition.value_type,
                        variables,
                        scene_id,
                        node_id,
                    )?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Condition {
                    condition,
                    then,
                    otherwise,
                } => {
                    validate_condition(condition, variables, scene_id, node_id)?;
                    require_node(scene, then, scene_id, node_id)?;
                    require_node(scene, otherwise, scene_id, node_id)?;
                }
                SceneNode::Playback { next, .. } => {
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Action {
                    sprite_id,
                    action,
                    duration_ms,
                    await_completion: _,
                    parameters,
                    end: _,
                    next,
                } => {
                    validate_identifier("action sprite id", sprite_id)?;
                    validate_identifier("action id", action)?;
                    if !actions.contains_key(action) {
                        return node_error(
                            scene_id,
                            node_id,
                            &format!("引用了未知立绘动作 {action}"),
                        );
                    }
                    if let Some(duration_ms) = duration_ms {
                        validate_duration(*duration_ms, scene_id, node_id)?;
                    }
                    let definition = actions.get(action).expect("checked above");
                    for (parameter, value) in parameters {
                        validate_identifier("action parameter", parameter)?;
                        let Some(parameter_definition) = definition.parameters.get(parameter)
                        else {
                            return node_error(
                                scene_id,
                                node_id,
                                &format!("引用了未声明的立绘动作参数 {parameter}"),
                            );
                        };
                        if !value.is_finite()
                            || parameter_definition.min.is_some_and(|min| *value < min)
                            || parameter_definition.max.is_some_and(|max| *value > max)
                        {
                            return node_error(scene_id, node_id, "动作参数必须是有限数");
                        }
                    }
                    if !scene.nodes.values().any(|candidate| {
                        matches!(
                            candidate,
                            SceneNode::Sprite { sprite_id: declared, .. }
                                if declared == sprite_id
                        )
                    }) {
                        return node_error(
                            scene_id,
                            node_id,
                            &format!("动作引用了未声明的立绘实例 {sprite_id}"),
                        );
                    }
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Jump {
                    scene: target_scene,
                    target,
                } => {
                    let destination = target_scene.as_deref().unwrap_or(scene_id);
                    let destination_scene = scenes.get(destination).ok_or_else(|| {
                        ContentError::Validation(format!(
                            "{scene_id}/{node_id} 跳转到未知场景 {destination}"
                        ))
                    })?;
                    if destination_scene.window_role != scene.window_role {
                        return node_error(scene_id, node_id, "不能跨主/副窗口用途跳转 Scene");
                    }
                    if !destination_scene.nodes.contains_key(target) {
                        return node_error(scene_id, node_id, "jump 目标节点不存在");
                    }
                }
                SceneNode::OpenWindow {
                    scene: target_scene,
                    next,
                } => {
                    if !scenes.contains_key(target_scene) {
                        return node_error(
                            scene_id,
                            node_id,
                            &format!("open_window 指向未声明的场景 {target_scene}"),
                        );
                    }
                    if scene.window_role != crate::interaction::WindowRole::Main
                        || scenes[target_scene].window_role != crate::interaction::WindowRole::Secondary {
                        return node_error(scene_id, node_id, "open_window 必须由主窗口打开副窗口专用 Scene；请设置目标 Scene 用途");
                    }
                    // `next` continues the *current* Scene; only the named
                    // window Scene is resolved across scenes.
                    if !scene.nodes.contains_key(next) {
                        return node_error(scene_id, node_id, "open_window 的 next 节点不存在");
                    }
                }
                SceneNode::WindowTitle { title, next, .. } => {
                    crate::interaction::validate_title(title).map_err(ContentError::Validation)?;
                    validate_text_markup(title, variables, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::WindowControl { action, id, message, next, .. } => {
                    if *action != crate::interaction::WindowControlAction::Advance {
                        validate_identifier("block id", id)?;
                    }
                    validate_text_markup(message, variables, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::WindowGeometry { position, size, duration_ms, next, .. } => {
                    crate::interaction::validate_window_geometry(position.as_ref(), size.as_ref())
                        .map_err(|message| {
                            ContentError::Validation(format!("{scene_id}/{node_id}: {message}"))
                        })?;
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::WindowLayer { next, .. } => {
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Timer { id, action, delay_ms, interval_ms, target, next } => {
                    validate_identifier("timer id", id)?;
                    validate_duration(*delay_ms, scene_id, node_id)?;
                    if *action == crate::interaction::TimerAction::Start {
                        if let Some(interval) = interval_ms {
                            validate_duration(*interval, scene_id, node_id)?;
                            if *interval < crate::interaction::MIN_TIMER_INTERVAL_MS {
                                return node_error(scene_id, node_id, "重复计时器间隔至少为 50ms");
                            }
                        }
                        if !target.as_ref().and_then(|id| scene.nodes.get(id)).is_some_and(crate::interaction::timer_target_allowed) {
                            return node_error(scene_id, node_id, "计时器必须引用同 Scene 的非阻塞效果节点，不能引用流程或计时器节点");
                        }
                    }
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Wait { duration_ms, next } => {
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Bgm {
                    action,
                    asset,
                    volume,
                    duration_ms,
                    start_ms,
                    loop_start_ms,
                    loop_end_ms,
                    next,
                    ..
                } => {
                    if *action == AudioAction::Start && asset.is_none() {
                        return node_error(scene_id, node_id, "BGM start 必须提供 asset");
                    }
                    if let Some(id) = asset {
                        require_asset(assets, id, AssetKind::Bgm, scene_id, node_id)?;
                    }
                    validate_volume(*volume, scene_id, node_id)?;
                    if loop_start_ms.is_some() != loop_end_ms.is_some() {
                        return node_error(scene_id, node_id, "BGM 循环起止点必须同时提供");
                    }
                    if let (Some(start), Some(end)) = (loop_start_ms, loop_end_ms) {
                        if start >= end || *start_ms > *end {
                            return node_error(scene_id, node_id, "BGM 循环点顺序无效");
                        }
                    }
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Ambience {
                    action,
                    asset,
                    volume,
                    duration_ms,
                    start_ms,
                    loop_start_ms,
                    loop_end_ms,
                    next,
                    ..
                } => {
                    if *action == AudioAction::Start && asset.is_none() {
                        return node_error(scene_id, node_id, "ambience start 必须提供 asset");
                    }
                    if *action == AudioAction::Stop && asset.is_some() {
                        return node_error(scene_id, node_id, "ambience stop 不能提供 asset");
                    }
                    if let Some(id) = asset {
                        require_asset(assets, id, AssetKind::Ambience, scene_id, node_id)?;
                    }
                    validate_volume(*volume, scene_id, node_id)?;
                    if loop_start_ms.is_some() != loop_end_ms.is_some() {
                        return node_error(scene_id, node_id, "ambience 循环起止点必须同时提供");
                    }
                    if let (Some(start), Some(end)) = (loop_start_ms, loop_end_ms) {
                        if start >= end || *start_ms > *end {
                            return node_error(scene_id, node_id, "ambience 循环点顺序无效");
                        }
                    }
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Sfx {
                    asset,
                    volume,
                    next,
                } => {
                    require_asset(assets, asset, AssetKind::Sfx, scene_id, node_id)?;
                    validate_volume(*volume, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Camera {
                    x,
                    y,
                    zoom,
                    duration_ms,
                    next,
                    ..
                } => {
                    if !x.is_finite() || !y.is_finite() || !zoom.is_finite() || *zoom <= 0.0 {
                        return node_error(
                            scene_id,
                            node_id,
                            "camera 坐标必须有限，zoom 必须为正数",
                        );
                    }
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::ScreenEffect {
                    effect,
                    duration_ms,
                    next,
                    ..
                } => {
                    validate_screen_effect(effect, scene_id, node_id)?;
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Curtain {
                    action,
                    fill,
                    duration_ms,
                    next,
                    ..
                } => {
                    match action {
                        CurtainAction::Cover => {
                            let fill = fill.as_ref().ok_or_else(|| {
                                ContentError::Validation(format!(
                                    "{scene_id}/{node_id} 的 curtain cover 必须提供 fill"
                                ))
                            })?;
                            validate_curtain_fill(fill, assets, scene_id, node_id)?;
                        }
                        CurtainAction::Reveal => {
                            if fill.is_some() {
                                return node_error(
                                    scene_id,
                                    node_id,
                                    "curtain reveal 不能指定 fill，将使用当前幕布",
                                );
                            }
                        }
                    }
                    validate_duration(*duration_ms, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::DialogueUi {
                    motion,
                    duration_ms,
                    next,
                    ..
                } => {
                    validate_ui_motion_reference(motion.as_deref(), ui_motions, scene_id, node_id)?;
                    if let Some(duration_ms) = duration_ms {
                        validate_duration(*duration_ms, scene_id, node_id)?;
                    }
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::UiMotionSet { motion, next, .. } => {
                    validate_ui_motion_reference(motion.as_deref(), ui_motions, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::UiMotionPlay {
                    motion,
                    duration_ms,
                    next,
                    ..
                } => {
                    validate_ui_motion_reference(Some(motion), ui_motions, scene_id, node_id)?;
                    if let Some(duration_ms) = duration_ms {
                        validate_duration(*duration_ms, scene_id, node_id)?;
                    }
                    require_node(scene, next, scene_id, node_id)?;
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
                    z: _,
                    visible: _,
                    enabled: _,
                    action,
                    next,
                } => {
                    validate_identifier("button instance id", instance_id)?;
                    let definition = buttons.get(template).ok_or_else(|| {
                        ContentError::Validation(format!(
                            "{scene_id}/{node_id} 引用了未知按钮模板 {template}"
                        ))
                    })?;
                    for (label, value) in [("x", *x), ("y", *y), ("rotation_deg", *rotation_deg)] {
                        if value.is_some_and(|value| !value.is_finite()) {
                            return node_error(
                                scene_id,
                                node_id,
                                &format!("按钮 {label} 必须是有限数"),
                            );
                        }
                    }
                    for (label, value) in [("width", *width), ("height", *height)] {
                        if value.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                            return node_error(
                                scene_id,
                                node_id,
                                &format!("按钮 {label} 必须是有限正数"),
                            );
                        }
                    }
                    for (label, value) in [("scale_x", *scale_x), ("scale_y", *scale_y)] {
                        if value.is_some_and(|value| !value.is_finite() || value == 0.0) {
                            return node_error(
                                scene_id,
                                node_id,
                                &format!("按钮 {label} 必须是有限正数"),
                            );
                        }
                    }
                    if opacity
                        .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
                    {
                        return node_error(scene_id, node_id, "按钮 opacity 必须在 0 到 1 之间");
                    }
                    validate_button_assets(definition, assets, scene_id, node_id)?;
                    validate_button_action(action, variables, scenes, scene_id, node_id)?;
                    require_node(scene, next, scene_id, node_id)?;
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
                    z: _,
                    visible: _,
                    enabled: _,
                    action,
                    next,
                } => {
                    validate_identifier("button instance id", instance_id)?;
                    if let Some(template) = template {
                        let definition = buttons.get(template).ok_or_else(|| {
                            ContentError::Validation(format!(
                                "{scene_id}/{node_id} 引用了未知按钮模板 {template}"
                            ))
                        })?;
                        validate_button_assets(definition, assets, scene_id, node_id)?;
                    }
                    for (label, value) in [("x", *x), ("y", *y), ("rotation_deg", *rotation_deg)] {
                        if value.is_some_and(|value| !value.is_finite()) {
                            return node_error(
                                scene_id,
                                node_id,
                                &format!("按钮 {label} 必须是有限数"),
                            );
                        }
                    }
                    for (label, value) in [("width", *width), ("height", *height)] {
                        if value.is_some_and(|value| !value.is_finite() || value <= 0.0) {
                            return node_error(scene_id, node_id, &format!("按钮 {label} 必须是有限正数"));
                        }
                    }
                    for (label, value) in [("scale_x", *scale_x), ("scale_y", *scale_y)] {
                        if value.is_some_and(|value| !value.is_finite() || value == 0.0) {
                            return node_error(
                                scene_id,
                                node_id,
                                &format!("按钮 {label} 必须是有限正数"),
                            );
                        }
                    }
                    if opacity
                        .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
                    {
                        return node_error(scene_id, node_id, "按钮 opacity 必须在 0 到 1 之间");
                    }
                    if let Some(action) = action {
                        validate_button_action(action, variables, scenes, scene_id, node_id)?;
                    }
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::ButtonRemove { instance_id, next } => {
                    validate_identifier("button instance id", instance_id)?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::Timeline {
                    duration_ms,
                    await_completion,
                    skippable,
                    tracks,
                    events,
                    next,
                } => {
                    for track in tracks {
                        if let TimelineTrack::Button { instance_id, .. } = track {
                            let declared = scene.nodes.values().any(|candidate| {
                                matches!(
                                    candidate,
                                    SceneNode::ButtonCreate { instance_id: created, .. }
                                        if created == instance_id
                                )
                            });
                            if !declared {
                                return node_error(
                                    scene_id,
                                    node_id,
                                    &format!("时间线引用了未创建的按钮实例 {instance_id}"),
                                );
                            }
                        }
                    }
                    validate_timeline(
                        *duration_ms,
                        *await_completion,
                        *skippable,
                        tracks,
                        events,
                        assets,
                        scene_id,
                        node_id,
                    )?;
                    require_node(scene, next, scene_id, node_id)?;
                }
                SceneNode::End => {}
            }
        }
    }
    Ok(())
}

pub(super) fn require_asset(
    assets: &BTreeMap<String, AssetDefinition>,
    id: &str,
    expected: AssetKind,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    let definition = assets.get(id).ok_or_else(|| {
        ContentError::Validation(format!("{scene_id}/{node_id} 引用了未知素材 {id}"))
    })?;
    if definition.kind != expected {
        return node_error(scene_id, node_id, &format!("素材 {id} 类型不正确"));
    }
    Ok(())
}

fn require_node(
    scene: &SceneDefinition,
    target: &str,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    if !scene.nodes.contains_key(target) {
        return node_error(scene_id, node_id, &format!("目标节点不存在: {target}"));
    }
    Ok(())
}

pub(super) fn validate_duration(value: u64, scene_id: &str, node_id: &str) -> Result<(), ContentError> {
    if value > 60_000 {
        return node_error(scene_id, node_id, "单个动画时长不能超过 60 秒");
    }
    Ok(())
}

pub(super) fn validate_volume(value: f32, scene_id: &str, node_id: &str) -> Result<(), ContentError> {
    if !(0.0..=1.0).contains(&value) {
        return node_error(scene_id, node_id, "音量必须在 0 到 1 之间");
    }
    Ok(())
}

fn validate_background_transition(
    transition: &BackgroundTransitionSpec,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    match transition {
        BackgroundTransitionSpec::Cut | BackgroundTransitionSpec::CrossFade => Ok(()),
        BackgroundTransitionSpec::FadeThroughColor { color } => {
            validate_color(color).map_err(|message| {
                ContentError::Validation(format!("{scene_id}/{node_id}: {message}"))
            })
        }
        BackgroundTransitionSpec::Wipe {
            direction: _,
            softness,
        }
        | BackgroundTransitionSpec::Push {
            direction: _,
            softness,
        } => {
            if !softness.is_finite() || !(0.0..=TRANSITION_SOFTNESS_MAX).contains(softness) {
                return node_error(
                    scene_id,
                    node_id,
                    &format!("转场 softness 必须在 0 到 {TRANSITION_SOFTNESS_MAX} 之间"),
                );
            }
            Ok(())
        }
    }
}
