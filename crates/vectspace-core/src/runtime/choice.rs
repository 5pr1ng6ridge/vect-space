use crate::choice::{layout_choice_items, legacy_choice_anchor};
use crate::content::ContentCatalog;
use crate::model::{
    AssetKind, ButtonClickAction, ButtonTemplate, CHOICE_DEFAULT_ANCHOR_X, CHOICE_DEFAULT_ANCHOR_Y,
    CHOICE_DEFAULT_GAP, CHOICE_FALLBACK_BUTTON_HEIGHT, CHOICE_FALLBACK_BUTTON_WIDTH,
    CHOICE_STAGE_HEIGHT, CHOICE_STAGE_WIDTH, ChoiceDiagnostic, ChoiceDiagnosticCode,
    ChoiceFlowDirection, ChoiceLayoutSnapshot, ChoicePresentation, ChoiceSnapshot,
    ChoiceTemplateSnapshot, PromptSnapshot, RuntimeSnapshot, SceneNode,
};
use super::{RuntimeEngine, RuntimeError};
use super::execute::make_button_snapshot;

/// One visible, already-interpolated choice item before its presentation is
/// resolved.
struct ChoiceItemDraft {
    id: String,
    label: String,
    enabled: bool,
    template: Option<String>,
    icon: Option<String>,
}

fn choice_diagnostic(
    code: ChoiceDiagnosticCode,
    message: String,
    scene_id: &str,
    node_id: &str,
    choice_id: Option<&str>,
) -> ChoiceDiagnostic {
    ChoiceDiagnostic {
        code,
        message,
        scene_id: scene_id.to_owned(),
        node_id: node_id.to_owned(),
        choice_id: choice_id.map(str::to_owned),
    }
}

/// Anchors are design pixels inside the fixed 1920x1080 stage; an invalid
/// component falls back to the documented default and reports a diagnostic
/// instead of aborting the story.
fn resolve_choice_anchor(
    value: f32,
    default: f32,
    max: f32,
    label: &str,
    scene_id: &str,
    node_id: &str,
    diagnostics: &mut Vec<ChoiceDiagnostic>,
) -> f32 {
    if value.is_finite() && (0.0..=max).contains(&value) {
        value
    } else {
        diagnostics.push(choice_diagnostic(
            ChoiceDiagnosticCode::InvalidAnchor,
            format!(
                "选择节点的 {label} 必须是 0 到 {max} 之间的设计像素有限数，已回退到默认值 {default}"
            ),
            scene_id,
            node_id,
            None,
        ));
        default
    }
}

/// A negative or non-finite gap falls back to the documented default.
fn resolve_choice_gap(
    value: f32,
    scene_id: &str,
    node_id: &str,
    diagnostics: &mut Vec<ChoiceDiagnostic>,
) -> f32 {
    if value.is_finite() && value >= 0.0 {
        value
    } else {
        diagnostics.push(choice_diagnostic(
            ChoiceDiagnosticCode::InvalidGap,
            format!("选择节点的 gap 必须是非负有限数，已回退到默认值 {CHOICE_DEFAULT_GAP}"),
            scene_id,
            node_id,
            None,
        ));
        CHOICE_DEFAULT_GAP
    }
}

/// Node-wide size overrides must be finite positive numbers; an invalid side
/// is ignored once, and every affected item keeps its resolved template size
/// or the built-in fallback.
fn validate_choice_size_override(
    value: Option<f32>,
    label: &str,
    scene_id: &str,
    node_id: &str,
    diagnostics: &mut Vec<ChoiceDiagnostic>,
) -> Option<f32> {
    match value {
        None => None,
        Some(value) if value.is_finite() && value > 0.0 => Some(value),
        Some(_) => {
            diagnostics.push(choice_diagnostic(
                ChoiceDiagnosticCode::InvalidDimension,
                format!("选择节点的 button_{label} 必须是有限正数，已回退到模板尺寸或内置回退尺寸"),
                scene_id,
                node_id,
                None,
            ));
            None
        }
    }
}

/// Only `gui` assets are valid choice icons; anything else is reported and
/// dropped from the resolved item instead of breaking the prompt.
fn resolve_choice_icon(
    content: &ContentCatalog,
    icon: Option<&str>,
    scene_id: &str,
    node_id: &str,
    choice_id: &str,
    diagnostics: &mut Vec<ChoiceDiagnostic>,
) -> Option<String> {
    let icon = icon?;
    match content.manifest.assets.get(icon) {
        None => {
            diagnostics.push(choice_diagnostic(
                ChoiceDiagnosticCode::MissingIcon,
                format!("选项 {choice_id} 引用了未知图标素材 {icon}"),
                scene_id,
                node_id,
                Some(choice_id),
            ));
            None
        }
        Some(definition) if definition.kind != AssetKind::Gui => {
            diagnostics.push(choice_diagnostic(
                ChoiceDiagnosticCode::InvalidIconKind,
                format!("选项 {choice_id} 的图标 {icon} 必须是 gui 素材"),
                scene_id,
                node_id,
                Some(choice_id),
            ));
            None
        }
        Some(_) => Some(icon.to_owned()),
    }
}

/// Resolves the visible choice drafts into wire snapshots.
///
/// Size priority is option template, then node default template, then the
/// built-in CSS fallback; node width/height override the resolved template
/// dimensions.  Layout always happens after filtering and interpolation so
/// invisible options never consume a flow slot.
fn resolve_choice_items(
    content: &ContentCatalog,
    scene_id: &str,
    node_id: &str,
    presentation: Option<&ChoicePresentation>,
    drafts: &[ChoiceItemDraft],
) -> (
    Vec<ChoiceSnapshot>,
    ChoiceLayoutSnapshot,
    Vec<ChoiceDiagnostic>,
) {
    let mut diagnostics = Vec::new();
    let mut direction = ChoiceFlowDirection::Vertical;
    let mut anchor_x = CHOICE_DEFAULT_ANCHOR_X;
    let mut anchor_y = CHOICE_DEFAULT_ANCHOR_Y;
    let mut gap = CHOICE_DEFAULT_GAP;
    let mut button_width = None;
    let mut button_height = None;
    let mut node_template: Option<(&str, &ButtonTemplate)> = None;
    if let Some(presentation) = presentation {
        direction = presentation.direction;
        anchor_x = resolve_choice_anchor(
            presentation.anchor_x,
            CHOICE_DEFAULT_ANCHOR_X,
            CHOICE_STAGE_WIDTH,
            "anchor_x",
            scene_id,
            node_id,
            &mut diagnostics,
        );
        anchor_y = resolve_choice_anchor(
            presentation.anchor_y,
            CHOICE_DEFAULT_ANCHOR_Y,
            CHOICE_STAGE_HEIGHT,
            "anchor_y",
            scene_id,
            node_id,
            &mut diagnostics,
        );
        gap = resolve_choice_gap(presentation.gap, scene_id, node_id, &mut diagnostics);
        button_width = validate_choice_size_override(
            presentation.button_width,
            "width",
            scene_id,
            node_id,
            &mut diagnostics,
        );
        button_height = validate_choice_size_override(
            presentation.button_height,
            "height",
            scene_id,
            node_id,
            &mut diagnostics,
        );
        if let Some(template_id) = presentation.template.as_deref() {
            match content.buttons.get(template_id) {
                Some(template) => node_template = Some((template_id, template)),
                None => diagnostics.push(choice_diagnostic(
                    ChoiceDiagnosticCode::MissingTemplate,
                    format!("选择节点引用了未知按钮模板 {template_id}，已回退到内置 CSS 按钮"),
                    scene_id,
                    node_id,
                    None,
                )),
            }
        }
    }
    let mut sizes = Vec::with_capacity(drafts.len());
    let mut templates: Vec<Option<(&str, &ButtonTemplate)>> = Vec::with_capacity(drafts.len());
    for draft in drafts {
        let option_template = match draft.template.as_deref() {
            Some(template_id) => match content.buttons.get(template_id) {
                Some(template) => Some((template_id, template)),
                None => {
                    diagnostics.push(choice_diagnostic(
                        ChoiceDiagnosticCode::MissingTemplate,
                        format!(
                            "选项 {} 引用了未知按钮模板 {template_id}，已回退到节点默认模板或内置 CSS 按钮",
                            draft.id
                        ),
                        scene_id,
                        node_id,
                        Some(&draft.id),
                    ));
                    None
                }
            },
            None => None,
        };
        let resolved = option_template.or(node_template);
        let (base_width, base_height) = match resolved {
            Some((_, template)) => (template.width, template.height),
            None => (CHOICE_FALLBACK_BUTTON_WIDTH, CHOICE_FALLBACK_BUTTON_HEIGHT),
        };
        sizes.push((
            button_width.unwrap_or(base_width),
            button_height.unwrap_or(base_height),
        ));
        templates.push(resolved);
    }
    if presentation.is_none() {
        // A node that never opted into `presentation` keeps the shipped CSS
        // panel origin: derive the equivalent group-centre anchor so the
        // resolved rects and the legacy rendering agree without migration.
        (anchor_x, anchor_y) = legacy_choice_anchor(direction, gap, &sizes);
    }
    let layout = layout_choice_items(direction, anchor_x, anchor_y, gap, &sizes);
    let mut items = Vec::with_capacity(drafts.len());
    for (index, draft) in drafts.iter().enumerate() {
        let rect = layout.items[index];
        let icon = resolve_choice_icon(
            content,
            draft.icon.as_deref(),
            scene_id,
            node_id,
            &draft.id,
            &mut diagnostics,
        );
        let template = match templates[index] {
            Some((template_id, template)) => {
                ChoiceTemplateSnapshot::Button(Box::new(make_button_snapshot(
                    draft.id.clone(),
                    template_id,
                    template,
                    Some(rect.x),
                    Some(rect.y),
                    Some(rect.width),
                    Some(rect.height),
                    None,
                    None,
                    None,
                    None,
                    None,
                    true,
                    draft.enabled,
                    ButtonClickAction::default(),
                )))
            }
            None => ChoiceTemplateSnapshot::Fallback,
        };
        items.push(ChoiceSnapshot {
            id: draft.id.clone(),
            label: draft.label.clone(),
            enabled: draft.enabled,
            icon,
            template,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        });
    }
    let layout = ChoiceLayoutSnapshot {
        stage_width: CHOICE_STAGE_WIDTH,
        stage_height: CHOICE_STAGE_HEIGHT,
        anchor_x,
        anchor_y,
        direction,
        gap,
        x: layout.x,
        y: layout.y,
        width: layout.width,
        height: layout.height,
    };
    (items, layout, diagnostics)
}

/// Re-derives the resolved presentation of a saved choice prompt from the
/// current content.
///
/// A save only contributes identity and interaction state: the saved ids,
/// their order, the interpolated labels and the enabled flags are kept
/// verbatim, while rects, resolved templates, icons, layout and diagnostics
/// are always recomputed from the current content.  A hand-edited or stale
/// save therefore cannot inject arbitrary rects or skins, and a save written
/// before Choice presentation existed needs no migration.
///
/// A saved id that no longer exists in the current content is a ghost: it is
/// dropped instead of being kept as an unskinnable option, so a save can never
/// resurrect an option the author deleted.  Order, labels and enabled flags of
/// the surviving matches are preserved exactly as saved.  Duplicate surviving
/// ids are rejected before the prompt can reach a host; the result may be empty
/// (or all-disabled), which [`validate_snapshot`] then rejects.
pub(super) fn resync_choice_prompt_from_content(
    content: &ContentCatalog,
    snapshot: &mut RuntimeSnapshot,
) -> Result<(), RuntimeError> {
    let scene_id = snapshot.location.scene_id.clone();
    let node_id = snapshot.location.node_id.clone();
    let Some(SceneNode::Choice {
        presentation,
        choices: definitions,
    }) = content
        .scene(&scene_id)
        .ok()
        .and_then(|scene| scene.nodes.get(&node_id))
    else {
        return Ok(());
    };
    let PromptSnapshot::Choice {
        layout,
        diagnostics,
        choices,
        ..
    } = &mut snapshot.prompt
    else {
        return Ok(());
    };
    let mut surviving_ids = std::collections::BTreeSet::new();
    let mut drafts = Vec::with_capacity(choices.len());
    for item in choices.iter() {
        // Saved order wins, but only for ids the current content still
        // defines; a ghost id is dropped rather than rendering an option the
        // author removed.
        let Some(definition) = definitions.iter().find(|candidate| candidate.id == item.id) else {
            continue;
        };
        if !surviving_ids.insert(item.id.as_str()) {
            return Err(RuntimeError::InvalidSnapshot(format!(
                "选择提示包含重复选项 id {}",
                item.id
            )));
        }
        drafts.push(ChoiceItemDraft {
            id: item.id.clone(),
            label: item.label.clone(),
            enabled: item.enabled,
            template: definition.template.clone(),
            icon: definition.icon.clone(),
        });
    }
    let (resolved, resolved_layout, resolved_diagnostics) =
        resolve_choice_items(content, &scene_id, &node_id, presentation.as_ref(), &drafts);
    *choices = resolved;
    *layout = resolved_layout;
    *diagnostics = resolved_diagnostics;
    Ok(())
}

impl RuntimeEngine {
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
}
