//! Repository-level contract tests for template-driven choice presentation.
//!
//! These exercise the public content and runtime API the way a host does:
//! authored YAML is loaded through the real validator, executed and restored,
//! so a change to the canonical choice layout cannot silently break the legacy
//! choice content that is already committed.  The repository's real `game/`
//! project still uses the legacy shape; see `game_content.rs`.

use std::collections::BTreeMap;
use std::path::PathBuf;

use vectspace_core::content::ContentCatalog;
use vectspace_core::model::{
    ChoiceDiagnostic, ChoiceDiagnosticCode, ChoiceFlowDirection, ChoiceLayoutSnapshot,
    ChoiceSnapshot, ChoiceTemplateSnapshot, PromptSnapshot, RuntimeSnapshot, SceneDefinition,
    CHOICE_DEFAULT_ANCHOR_X, CHOICE_DEFAULT_ANCHOR_Y, CHOICE_DEFAULT_GAP,
    CHOICE_FALLBACK_BUTTON_HEIGHT, CHOICE_FALLBACK_BUTTON_WIDTH, CHOICE_FALLBACK_PANEL_X,
    CHOICE_FALLBACK_PANEL_Y, CHOICE_STAGE_HEIGHT, CHOICE_STAGE_WIDTH,
};
use vectspace_core::runtime::RuntimeEngine;

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/game")
}

fn fixture_catalog() -> ContentCatalog {
    ContentCatalog::from_root(fixture_root()).expect("fixture content must be valid")
}

fn scene_from_yaml(yaml: &str) -> SceneDefinition {
    let options = serde_saphyr::options! { strict_booleans: true };
    serde_saphyr::from_str_with_options(yaml, options).expect("scene YAML must parse")
}

/// Re-validates a scene map through the public in-memory constructor, exactly
/// like the loader does for a saved project, while keeping the fixture's
/// button template documents available for resolution.
fn rebuild(catalog: &ContentCatalog, scenes: BTreeMap<String, SceneDefinition>) -> ContentCatalog {
    let root = catalog
        .assets_root()
        .parent()
        .expect("fixture assets parent")
        .to_path_buf();
    let ui_motions = catalog
        .manifest
        .ui_motions
        .iter()
        .cloned()
        .zip(catalog.ui_motions.values().cloned())
        .collect();
    let button_files = catalog
        .manifest
        .buttons
        .iter()
        .cloned()
        .zip(catalog.buttons.values().cloned())
        .collect();
    ContentCatalog::from_documents_with_all_documents(
        root,
        catalog.manifest.clone(),
        scenes,
        ui_motions,
        catalog.chapter_map.clone(),
        &BTreeMap::new(),
        Some(button_files),
        None,
        None,
    )
    .expect("choice fixture content must validate")
}

fn catalog_with_scene(catalog: &ContentCatalog, scene: SceneDefinition) -> ContentCatalog {
    let mut scenes = catalog.scenes.clone();
    scenes.insert(scene.id.clone(), scene);
    rebuild(catalog, scenes)
}

#[allow(clippy::type_complexity)]
fn run_choice(
    content: &ContentCatalog,
    scene_id: &str,
) -> (
    ChoiceLayoutSnapshot,
    Vec<ChoiceSnapshot>,
    Vec<ChoiceDiagnostic>,
) {
    let mut runtime = RuntimeEngine::new(content).expect("engine");
    let update = runtime
        .start_scene_preview(content, scene_id)
        .expect("scene preview must reach the choice");
    let PromptSnapshot::Choice {
        layout,
        choices,
        diagnostics,
        ..
    } = update.snapshot.prompt
    else {
        panic!("expected a choice prompt");
    };
    (layout, choices, diagnostics)
}

/// Builds a scene whose single choice node has `option_count` visible options
/// and, when `presentation` is `Some`, an explicit presentation written as a
/// YAML flow mapping (`"{}"` opts in with defaults only).
fn choice_scene(
    scene_id: &str,
    option_count: usize,
    presentation: Option<&str>,
) -> SceneDefinition {
    let mut yaml = format!(
        "schema_version: 2\nid: {scene_id}\nentry: prompt\nnodes:\n  prompt:\n    type: choice\n"
    );
    if let Some(presentation) = presentation {
        yaml.push_str(&format!("    presentation: {presentation}\n"));
    }
    yaml.push_str("    choices:\n");
    for index in 0..option_count {
        yaml.push_str(&format!(
            "    - id: option_{index}\n      label: 选项{index}\n      next: done\n"
        ));
    }
    yaml.push_str("  done:\n    type: end\n");
    scene_from_yaml(&yaml)
}

/// Height of a vertical group of `count` fallback buttons.
fn fallback_group_height(count: usize) -> f32 {
    count as f32 * CHOICE_FALLBACK_BUTTON_HEIGHT
        + (count.saturating_sub(1)) as f32 * CHOICE_DEFAULT_GAP
}

fn legacy_choice_scene() -> SceneDefinition {
    scene_from_yaml(
        r#"
schema_version: 2
id: legacy_choice
entry: prompt
nodes:
  prompt:
    type: choice
    choices:
    - id: first
      label: 第一项
      next: done
    - id: second
      label: 第二项
      next: done
  done:
    type: end
"#,
    )
}

#[test]
fn legacy_choice_yaml_resolves_to_the_shipped_css_panel() {
    let catalog = fixture_catalog();
    let content = catalog_with_scene(&catalog, legacy_choice_scene());
    let (layout, choices, diagnostics) = run_choice(&content, "legacy_choice");

    // The shipped CSS panel is `left: 470px; top: 360px; width: 980px`, so the
    // resolved layout reports exactly that top-left placement plus the
    // equivalent group-centre anchor (960, 360 + 204 / 2).
    assert_eq!(
        layout,
        ChoiceLayoutSnapshot {
            stage_width: CHOICE_STAGE_WIDTH,
            stage_height: CHOICE_STAGE_HEIGHT,
            anchor_x: CHOICE_DEFAULT_ANCHOR_X,
            anchor_y: CHOICE_FALLBACK_PANEL_Y + 204.0 / 2.0,
            direction: ChoiceFlowDirection::Vertical,
            gap: CHOICE_DEFAULT_GAP,
            x: CHOICE_FALLBACK_PANEL_X,
            y: CHOICE_FALLBACK_PANEL_Y,
            width: CHOICE_FALLBACK_BUTTON_WIDTH,
            height: 204.0,
        }
    );
    assert!(diagnostics.is_empty());
    assert_eq!(choices.len(), 2);
    for (index, choice) in choices.iter().enumerate() {
        assert_eq!(choice.template, ChoiceTemplateSnapshot::Fallback);
        assert_eq!(choice.icon, None);
        assert_eq!(choice.width, CHOICE_FALLBACK_BUTTON_WIDTH);
        assert_eq!(choice.height, CHOICE_FALLBACK_BUTTON_HEIGHT);
        assert_eq!(choice.x, CHOICE_FALLBACK_PANEL_X);
        assert_eq!(
            choice.y,
            CHOICE_FALLBACK_PANEL_Y
                + index as f32 * (CHOICE_FALLBACK_BUTTON_HEIGHT + CHOICE_DEFAULT_GAP)
        );
    }
    assert_eq!(choices[0].id, "first");
    assert_eq!(choices[1].id, "second");
}

#[test]
fn legacy_choices_stay_top_anchored_at_360_for_one_two_and_three_options() {
    let catalog = fixture_catalog();
    for count in 1..=3 {
        let scene_id = format!("legacy_count_{count}");
        let content = catalog_with_scene(&catalog, choice_scene(&scene_id, count, None));
        let (layout, choices, diagnostics) = run_choice(&content, &scene_id);

        assert!(diagnostics.is_empty(), "{count} options: {diagnostics:?}");
        let height = fallback_group_height(count);
        assert_eq!(
            (layout.x, layout.y, layout.width, layout.height),
            (
                CHOICE_FALLBACK_PANEL_X,
                CHOICE_FALLBACK_PANEL_Y,
                CHOICE_FALLBACK_BUTTON_WIDTH,
                height
            ),
            "{count} legacy options must keep the CSS panel origin"
        );
        // The reported anchor is the centre that reproduces the top-anchored
        // placement, not a re-anchoring of the group.
        assert_eq!(layout.anchor_x, CHOICE_DEFAULT_ANCHOR_X);
        assert_eq!(layout.anchor_y, CHOICE_FALLBACK_PANEL_Y + height / 2.0);
        for (index, choice) in choices.iter().enumerate() {
            assert_eq!(
                choice.y,
                CHOICE_FALLBACK_PANEL_Y
                    + index as f32 * (CHOICE_FALLBACK_BUTTON_HEIGHT + CHOICE_DEFAULT_GAP),
                "{count} options, item {index}"
            );
        }
    }
}

#[test]
fn explicit_default_presentation_centres_on_960_540_for_one_two_and_three_options() {
    let catalog = fixture_catalog();
    for count in 1..=3 {
        let scene_id = format!("explicit_count_{count}");
        let content = catalog_with_scene(&catalog, choice_scene(&scene_id, count, Some("{}")));
        let (layout, choices, diagnostics) = run_choice(&content, &scene_id);

        assert!(diagnostics.is_empty(), "{count} options: {diagnostics:?}");
        assert_eq!(layout.anchor_x, CHOICE_DEFAULT_ANCHOR_X);
        assert_eq!(layout.anchor_y, CHOICE_DEFAULT_ANCHOR_Y);
        let height = fallback_group_height(count);
        let expected_top = CHOICE_DEFAULT_ANCHOR_Y - height / 2.0;
        assert_eq!(
            (layout.x, layout.y, layout.width, layout.height),
            (
                CHOICE_FALLBACK_PANEL_X,
                expected_top,
                CHOICE_FALLBACK_BUTTON_WIDTH,
                height
            ),
            "{count} explicitly presented options must centre on 960/540"
        );
        // Legacy top anchoring and explicit default centring are deliberately
        // different placements for the same content.
        assert_ne!(choices[0].y, CHOICE_FALLBACK_PANEL_Y);
        for (index, choice) in choices.iter().enumerate() {
            assert_eq!(
                choice.y,
                expected_top + index as f32 * (CHOICE_FALLBACK_BUTTON_HEIGHT + CHOICE_DEFAULT_GAP),
                "{count} options, item {index}"
            );
        }
    }
}

#[test]
fn option_template_beats_the_node_default_template() {
    let catalog = fixture_catalog();
    let content = catalog_with_scene(
        &catalog,
        scene_from_yaml(
            r#"
schema_version: 2
id: priority_choice
entry: prompt
nodes:
  prompt:
    type: choice
    presentation:
      template: choice.primary
    choices:
    - id: wide
      label: 主模板
      next: done
    - id: compact
      label: 选项模板
      template: choice.secondary
      next: done
  done:
    type: end
"#,
        ),
    );
    let (layout, choices, diagnostics) = run_choice(&content, "priority_choice");

    assert!(diagnostics.is_empty());
    assert_eq!(choices.len(), 2);
    // The node template (320x88) and the option template (240x72) keep their
    // own dimensions in mixed-size flow.
    assert_eq!((choices[0].width, choices[0].height), (320.0, 88.0));
    assert_eq!((choices[1].width, choices[1].height), (240.0, 72.0));
    assert_eq!((choices[0].x, choices[0].y), (800.0, 450.0));
    assert_eq!((choices[1].x, choices[1].y), (840.0, 558.0));
    assert_eq!(
        (layout.x, layout.y, layout.width, layout.height),
        (800.0, 450.0, 320.0, 180.0)
    );
    let ChoiceTemplateSnapshot::Button(primary) = &choices[0].template else {
        panic!("node template must resolve to a button skin");
    };
    assert_eq!(primary.template, "choice.primary");
    assert_eq!(primary.normal.as_deref(), Some("gui.dialogue_box"));
    assert_eq!(primary.width, 320.0);
    let ChoiceTemplateSnapshot::Button(secondary) = &choices[1].template else {
        panic!("option template must resolve to a button skin");
    };
    assert_eq!(secondary.template, "choice.secondary");
    assert_eq!(secondary.normal.as_deref(), Some("gui.name_box"));
    assert_eq!(secondary.id, "compact");
}

#[test]
fn node_size_override_beats_every_resolved_template() {
    let catalog = fixture_catalog();
    let content = catalog_with_scene(
        &catalog,
        scene_from_yaml(
            r#"
schema_version: 2
id: override_choice
entry: prompt
nodes:
  prompt:
    type: choice
    presentation:
      template: choice.primary
      button_width: 500
      button_height: 120
    choices:
    - id: first
      label: 一
      next: done
    - id: second
      label: 二
      template: choice.secondary
      next: done
  done:
    type: end
"#,
        ),
    );
    let (layout, choices, diagnostics) = run_choice(&content, "override_choice");

    assert!(diagnostics.is_empty());
    for choice in &choices {
        assert_eq!(choice.width, 500.0);
        assert_eq!(choice.height, 120.0);
        let ChoiceTemplateSnapshot::Button(button) = &choice.template else {
            panic!("templates must stay resolved under a size override");
        };
        assert_eq!(button.width, 500.0);
        assert_eq!(button.height, 120.0);
    }
    assert_eq!((choices[0].x, choices[0].y), (710.0, 410.0));
    assert_eq!((choices[1].x, choices[1].y), (710.0, 550.0));
    assert_eq!((layout.width, layout.height), (500.0, 260.0));
}

#[test]
fn one_sided_size_overrides_keep_the_other_template_dimension() {
    let catalog = fixture_catalog();
    // Width-only override: every item becomes 500px wide while each keeps the
    // height of its own resolved template.
    let content = catalog_with_scene(
        &catalog,
        scene_from_yaml(
            r#"
schema_version: 2
id: width_only_choice
entry: prompt
nodes:
  prompt:
    type: choice
    presentation:
      template: choice.primary
      button_width: 500
    choices:
    - id: primary
      label: 主模板
      next: done
    - id: secondary
      label: 选项模板
      template: choice.secondary
      next: done
  done:
    type: end
"#,
        ),
    );
    let (layout, choices, diagnostics) = run_choice(&content, "width_only_choice");
    assert!(diagnostics.is_empty());
    assert_eq!((choices[0].width, choices[0].height), (500.0, 88.0));
    assert_eq!((choices[1].width, choices[1].height), (500.0, 72.0));
    // 88 + 20 + 72 = 180 tall, centred on 540, and 500 wide on 960.
    assert_eq!((choices[0].x, choices[0].y), (710.0, 450.0));
    assert_eq!((choices[1].x, choices[1].y), (710.0, 558.0));
    assert_eq!(
        (layout.x, layout.y, layout.width, layout.height),
        (710.0, 450.0, 500.0, 180.0)
    );

    // Height-only override: heights collapse to 100px while the cross-axis
    // extents stay template-sized.
    let content = catalog_with_scene(
        &catalog,
        scene_from_yaml(
            r#"
schema_version: 2
id: height_only_choice
entry: prompt
nodes:
  prompt:
    type: choice
    presentation:
      template: choice.primary
      button_height: 100
    choices:
    - id: primary
      label: 主模板
      next: done
    - id: secondary
      label: 选项模板
      template: choice.secondary
      next: done
  done:
    type: end
"#,
        ),
    );
    let (layout, choices, diagnostics) = run_choice(&content, "height_only_choice");
    assert!(diagnostics.is_empty());
    assert_eq!((choices[0].width, choices[0].height), (320.0, 100.0));
    assert_eq!((choices[1].width, choices[1].height), (240.0, 100.0));
    assert_eq!((choices[0].x, choices[0].y), (800.0, 430.0));
    assert_eq!((choices[1].x, choices[1].y), (840.0, 550.0));
    assert_eq!(
        (layout.x, layout.y, layout.width, layout.height),
        (800.0, 430.0, 320.0, 220.0)
    );
}

#[test]
fn filtering_and_interpolation_run_before_layout() {
    let catalog = fixture_catalog();
    let scene = |scene_id: &str, presentation: Option<&str>| {
        let mut yaml = format!(
            r#"
schema_version: 2
id: {scene_id}
entry: prompt
nodes:
  prompt:
    type: choice
"#
        );
        if let Some(presentation) = presentation {
            yaml.push_str(&format!("    presentation: {presentation}\n"));
        }
        yaml.push_str(
            r#"    choices:
    - id: alpha
      label: 观察 [var=score] 分
      next: done
    - id: beta
      label: 隐藏 [var=score]
      next: done
      visible_if:
        op: eq
        left:
          variable: score
        right:
          value: 99
    - id: gamma
      label: 普通
      next: done
    - id: delta
      label: 禁用
      next: done
      enabled_if:
        op: eq
        left:
          variable: score
        right:
          value: 99
  done:
    type: end
"#,
        );
        scene_from_yaml(&yaml)
    };

    // Legacy (no presentation): the three visible options stay top-anchored.
    let content = catalog_with_scene(&catalog, scene("filtered_legacy_choice", None));
    let (layout, choices, diagnostics) = run_choice(&content, "filtered_legacy_choice");
    assert!(diagnostics.is_empty());
    assert_eq!(
        choices
            .iter()
            .map(|choice| choice.id.as_str())
            .collect::<Vec<_>>(),
        vec!["alpha", "gamma", "delta"]
    );
    assert_eq!(choices[0].label, "观察 0 分");
    assert!(choices[0].enabled);
    assert!(!choices[2].enabled);
    // The hidden option consumes neither a button rect nor a gap slot.
    assert_eq!(
        choices.iter().map(|choice| choice.y).collect::<Vec<_>>(),
        vec![360.0, 472.0, 584.0]
    );
    assert_eq!((layout.y, layout.height), (360.0, 316.0));

    // Explicitly presented: the same visible set is centred on 960/540.
    let content = catalog_with_scene(&catalog, scene("filtered_explicit_choice", Some("{}")));
    let (layout, choices, diagnostics) = run_choice(&content, "filtered_explicit_choice");
    assert!(diagnostics.is_empty());
    assert_eq!(
        choices
            .iter()
            .map(|choice| choice.id.as_str())
            .collect::<Vec<_>>(),
        vec!["alpha", "gamma", "delta"]
    );
    assert_eq!(choices[0].label, "观察 0 分");
    assert_eq!(
        choices.iter().map(|choice| choice.y).collect::<Vec<_>>(),
        vec![382.0, 494.0, 606.0]
    );
    assert_eq!((layout.y, layout.height), (382.0, 316.0));
    assert_eq!((layout.anchor_x, layout.anchor_y), (960.0, 540.0));
}

#[test]
fn off_centre_design_pixel_anchors_place_the_group_where_authored() {
    let catalog = fixture_catalog();
    let content = catalog_with_scene(
        &catalog,
        scene_from_yaml(
            r#"
schema_version: 2
id: off_centre_choice
entry: prompt
nodes:
  prompt:
    type: choice
    presentation:
      template: choice.secondary
      anchor_x: 480
      anchor_y: 810
    choices:
    - id: only
      label: 唯一
      next: done
  done:
    type: end
"#,
        ),
    );
    let (layout, choices, diagnostics) = run_choice(&content, "off_centre_choice");
    assert!(diagnostics.is_empty());
    // 240x72 centred on (480, 810).
    assert_eq!((layout.anchor_x, layout.anchor_y), (480.0, 810.0));
    assert_eq!(
        (layout.x, layout.y, layout.width, layout.height),
        (360.0, 774.0, 240.0, 72.0)
    );
    assert_eq!(
        (
            choices[0].x,
            choices[0].y,
            choices[0].width,
            choices[0].height
        ),
        (360.0, 774.0, 240.0, 72.0)
    );
}

#[test]
fn anchor_boundaries_cover_the_whole_stage_without_diagnostics() {
    let catalog = fixture_catalog();
    for (anchor_x, anchor_y) in [(0.0, 0.0), (CHOICE_STAGE_WIDTH, CHOICE_STAGE_HEIGHT)] {
        let content = catalog_with_scene(
            &catalog,
            choice_scene(
                "boundary_choice",
                1,
                Some(&format!("{{ anchor_x: {anchor_x}, anchor_y: {anchor_y} }}")),
            ),
        );
        let (layout, _, diagnostics) = run_choice(&content, "boundary_choice");
        assert!(
            diagnostics.is_empty(),
            "{anchor_x}/{anchor_y}: {diagnostics:?}"
        );
        assert_eq!((layout.anchor_x, layout.anchor_y), (anchor_x, anchor_y));
    }
}

#[test]
fn icon_kind_is_validated_with_choice_context() {
    let catalog = fixture_catalog();
    let content = catalog_with_scene(
        &catalog,
        scene_from_yaml(
            r#"
schema_version: 2
id: icon_choice
entry: prompt
nodes:
  prompt:
    type: choice
    choices:
    - id: good
      label: 正常图标
      icon: gui.dialogue_box
      next: done
    - id: wrong
      label: 错误图标类型
      icon: sprite.jelly
      next: done
    - id: missing
      label: 缺失图标
      icon: gui.missing
      next: done
  done:
    type: end
"#,
        ),
    );
    let (_, choices, diagnostics) = run_choice(&content, "icon_choice");

    assert_eq!(choices[0].icon.as_deref(), Some("gui.dialogue_box"));
    assert_eq!(choices[1].icon, None);
    assert_eq!(choices[2].icon, None);
    assert_eq!(diagnostics.len(), 2);
    assert_eq!(diagnostics[0].code, ChoiceDiagnosticCode::InvalidIconKind);
    assert_eq!(diagnostics[0].choice_id.as_deref(), Some("wrong"));
    assert_eq!(diagnostics[0].scene_id, "icon_choice");
    assert_eq!(diagnostics[0].node_id, "prompt");
    assert!(diagnostics[0].message.contains("sprite.jelly"));
    assert_eq!(diagnostics[1].code, ChoiceDiagnosticCode::MissingIcon);
    assert_eq!(diagnostics[1].choice_id.as_deref(), Some("missing"));
    assert!(diagnostics[1].message.contains("gui.missing"));
}

#[test]
fn missing_templates_fall_back_with_structured_diagnostics() {
    let catalog = fixture_catalog();
    let content = catalog_with_scene(
        &catalog,
        scene_from_yaml(
            r#"
schema_version: 2
id: missing_template_choice
entry: prompt
nodes:
  prompt:
    type: choice
    presentation:
      template: missing.node
    choices:
    - id: a
      label: 选项模板缺失
      template: missing.option
      next: done
    - id: b
      label: 仅节点模板缺失
      next: done
  done:
    type: end
"#,
        ),
    );
    let (layout, choices, diagnostics) = run_choice(&content, "missing_template_choice");

    // One node-level diagnostic, plus one for the option that named its own
    // missing template; the second option reuses the node resolution.
    assert_eq!(diagnostics.len(), 2);
    assert!(diagnostics
        .iter()
        .all(|diagnostic| diagnostic.code == ChoiceDiagnosticCode::MissingTemplate));
    assert_eq!(diagnostics[0].choice_id, None);
    assert!(diagnostics[0].message.contains("missing.node"));
    assert_eq!(diagnostics[1].choice_id.as_deref(), Some("a"));
    assert!(diagnostics[1].message.contains("missing.option"));
    for choice in &choices {
        assert_eq!(choice.template, ChoiceTemplateSnapshot::Fallback);
        assert_eq!(choice.width, CHOICE_FALLBACK_BUTTON_WIDTH);
        assert_eq!(choice.height, CHOICE_FALLBACK_BUTTON_HEIGHT);
    }
    // Explicitly presented, so the fallback pair centres on 960/540.
    assert_eq!(
        (layout.x, layout.y, layout.width, layout.height),
        (470.0, 438.0, 980.0, 204.0)
    );
}

#[test]
fn a_missing_node_template_leaves_a_valid_option_template_working() {
    let catalog = fixture_catalog();
    let content = catalog_with_scene(
        &catalog,
        scene_from_yaml(
            r#"
schema_version: 2
id: missing_node_template_choice
entry: prompt
nodes:
  prompt:
    type: choice
    presentation:
      template: missing.node
    choices:
    - id: skinned
      label: 选项模板可用
      template: choice.primary
      next: done
    - id: plain
      label: 无可用模板
      next: done
  done:
    type: end
"#,
        ),
    );
    let (layout, choices, diagnostics) = run_choice(&content, "missing_node_template_choice");

    // Only the node-level diagnostic exists; the option's own template still
    // resolves instead of being dragged down by the missing node template.
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, ChoiceDiagnosticCode::MissingTemplate);
    assert_eq!(diagnostics[0].choice_id, None);
    assert!(diagnostics[0].message.contains("missing.node"));
    let ChoiceTemplateSnapshot::Button(primary) = &choices[0].template else {
        panic!("the option template must resolve even when the node template is missing");
    };
    assert_eq!(primary.template, "choice.primary");
    assert_eq!((choices[0].width, choices[0].height), (320.0, 88.0));
    assert_eq!(choices[1].template, ChoiceTemplateSnapshot::Fallback);
    assert_eq!((choices[1].width, choices[1].height), (980.0, 92.0));
    // Mixed sizes centred on the default 960/540 anchor.
    assert_eq!((choices[0].x, choices[0].y), (800.0, 440.0));
    assert_eq!((choices[1].x, choices[1].y), (470.0, 548.0));
    assert_eq!(
        (layout.x, layout.y, layout.width, layout.height),
        (470.0, 440.0, 980.0, 200.0)
    );
}

#[test]
fn a_missing_option_template_falls_back_to_the_node_template() {
    let catalog = fixture_catalog();
    let content = catalog_with_scene(
        &catalog,
        scene_from_yaml(
            r#"
schema_version: 2
id: option_fallback_choice
entry: prompt
nodes:
  prompt:
    type: choice
    presentation:
      template: choice.primary
    choices:
    - id: a
      label: 选项模板缺失
      template: missing.option
      next: done
  done:
    type: end
"#,
        ),
    );
    let (_, choices, diagnostics) = run_choice(&content, "option_fallback_choice");

    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].choice_id.as_deref(), Some("a"));
    let ChoiceTemplateSnapshot::Button(button) = &choices[0].template else {
        panic!("a missing option template must fall back to the node template");
    };
    assert_eq!(button.template, "choice.primary");
    assert_eq!((choices[0].width, choices[0].height), (320.0, 88.0));
}

#[test]
fn invalid_presentation_numbers_fall_back_with_diagnostics() {
    let catalog = fixture_catalog();
    let content = catalog_with_scene(
        &catalog,
        scene_from_yaml(
            r#"
schema_version: 2
id: invalid_choice
entry: prompt
nodes:
  prompt:
    type: choice
    presentation:
      template: choice.primary
      anchor_x: 2400
      anchor_y: -1
      gap: -5
      button_width: 0
      button_height: -10
    choices:
    - id: only
      label: 唯一
      next: done
  done:
    type: end
"#,
        ),
    );
    let (layout, choices, diagnostics) = run_choice(&content, "invalid_choice");

    assert_eq!(
        diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code)
            .collect::<Vec<_>>(),
        vec![
            ChoiceDiagnosticCode::InvalidAnchor,
            ChoiceDiagnosticCode::InvalidAnchor,
            ChoiceDiagnosticCode::InvalidGap,
            ChoiceDiagnosticCode::InvalidDimension,
            ChoiceDiagnosticCode::InvalidDimension,
        ]
    );
    // The structured messages document the design-pixel bounds per axis.
    assert!(diagnostics[0].message.contains("1920"));
    assert!(diagnostics[1].message.contains("1080"));
    assert!(diagnostics
        .iter()
        .all(|diagnostic| diagnostic.choice_id.is_none()));
    assert_eq!(layout.anchor_x, CHOICE_DEFAULT_ANCHOR_X);
    assert_eq!(layout.anchor_y, CHOICE_DEFAULT_ANCHOR_Y);
    assert_eq!(layout.gap, CHOICE_DEFAULT_GAP);
    // Invalid overrides are ignored, so the template dimensions survive.
    assert_eq!((choices[0].width, choices[0].height), (320.0, 88.0));
    assert_eq!((choices[0].x, choices[0].y), (800.0, 496.0));
    assert_eq!(
        (layout.x, layout.y, layout.width, layout.height),
        (800.0, 496.0, 320.0, 88.0)
    );
}

#[test]
fn horizontal_flow_places_mixed_templates_around_the_anchor() {
    let catalog = fixture_catalog();
    let content = catalog_with_scene(
        &catalog,
        scene_from_yaml(
            r#"
schema_version: 2
id: horizontal_choice
entry: prompt
nodes:
  prompt:
    type: choice
    presentation:
      direction: horizontal
      anchor_x: 960
      anchor_y: 540
      gap: 16
    choices:
    - id: first
      label: 一
      template: choice.secondary
      next: done
    - id: second
      label: 二
      template: choice.primary
      next: done
  done:
    type: end
"#,
        ),
    );
    let (layout, choices, diagnostics) = run_choice(&content, "horizontal_choice");

    assert!(diagnostics.is_empty());
    assert_eq!((choices[0].width, choices[0].height), (240.0, 72.0));
    assert_eq!((choices[1].width, choices[1].height), (320.0, 88.0));
    assert_eq!((choices[0].x, choices[0].y), (672.0, 504.0));
    assert_eq!((choices[1].x, choices[1].y), (928.0, 496.0));
    assert_eq!(
        (layout.x, layout.y, layout.width, layout.height),
        (672.0, 496.0, 576.0, 88.0)
    );
}

#[test]
fn a_presentation_less_node_still_left_anchors_template_sizes() {
    let catalog = fixture_catalog();
    let content = catalog_with_scene(
        &catalog,
        scene_from_yaml(
            r#"
schema_version: 2
id: legacy_template_choice
entry: prompt
nodes:
  prompt:
    type: choice
    choices:
    - id: skinned
      label: 主模板
      template: choice.primary
      next: done
    - id: plain
      label: 回退
      next: done
  done:
    type: end
"#,
        ),
    );
    let (layout, choices, diagnostics) = run_choice(&content, "legacy_template_choice");
    assert!(diagnostics.is_empty());
    // The CSS panel origin is fixed at (470, 360): the widest item keeps the
    // left edge while the narrower one centres on the panel axis.
    assert_eq!(
        (layout.x, layout.y, layout.width, layout.height),
        (470.0, 360.0, 980.0, 200.0)
    );
    assert_eq!(layout.anchor_x, CHOICE_DEFAULT_ANCHOR_X);
    assert_eq!(layout.anchor_y, CHOICE_FALLBACK_PANEL_Y + 200.0 / 2.0);
    assert_eq!((choices[0].x, choices[0].y), (800.0, 360.0));
    assert_eq!((choices[1].x, choices[1].y), (470.0, 468.0));
    let ChoiceTemplateSnapshot::Button(button) = &choices[0].template else {
        panic!("an option template must resolve without a node-wise presentation");
    };
    assert_eq!(button.template, "choice.primary");
    assert_eq!(choices[1].template, ChoiceTemplateSnapshot::Fallback);
}

#[test]
fn empty_visible_choices_are_a_waiting_prompt() {
    let catalog = fixture_catalog();
    let content = catalog_with_scene(
        &catalog,
        scene_from_yaml(
            r#"
schema_version: 2
id: empty_choice
entry: prompt
nodes:
  prompt:
    type: choice
    choices:
    - id: a
      label: 一
      next: done
      visible_if:
        op: eq
        left:
          variable: score
        right:
          value: 99
    - id: b
      label: 二
      next: done
      visible_if:
        op: eq
        left:
          variable: score
        right:
          value: 100
  done:
    type: end
"#,
        ),
    );
    let mut runtime = RuntimeEngine::new(&content).expect("engine");
    // Another window or a timer may still make an option visible.
    let update = runtime
        .start_scene_preview(&content, "empty_choice")
        .expect("an empty visible choice list is a waiting prompt");
    let PromptSnapshot::Choice { choices, .. } = update.snapshot.prompt else {
        panic!("expected a waiting choice prompt");
    };
    assert!(choices.is_empty());
}

#[test]
fn resolved_choice_prompts_round_trip_through_snapshot_json() {
    let catalog = fixture_catalog();
    let content = catalog_with_scene(&catalog, legacy_choice_scene());
    let mut runtime = RuntimeEngine::new(&content).expect("engine");
    let update = runtime
        .start_scene_preview(&content, "legacy_choice")
        .expect("scene preview");
    let json = serde_json::to_string(&update.snapshot).expect("snapshot must serialize");
    assert!(json.contains("\"layout\""), "{json}");
    assert!(json.contains("\"diagnostics\""), "{json}");
    let decoded: RuntimeSnapshot =
        serde_json::from_str(&json).expect("resolved snapshots must deserialize");
    assert_eq!(decoded, update.snapshot);
}

#[test]
fn loading_a_forged_choice_prompt_rederives_rects_and_skins() {
    let catalog = fixture_catalog();
    let content = catalog_with_scene(
        &catalog,
        choice_scene("forged_choice", 2, Some("{ template: choice.primary }")),
    );
    let mut runtime = RuntimeEngine::new(&content).expect("engine");
    let update = runtime
        .start_scene_preview(&content, "forged_choice")
        .expect("scene preview");
    let expected_prompt = update.snapshot.prompt.clone();

    // A hand-edited save that injects arbitrary rects, a forged button skin
    // and a forged diagnostic.
    let mut forged = serde_json::to_value(&update.snapshot).expect("snapshot to value");
    let prompt = forged
        .get_mut("prompt")
        .and_then(serde_json::Value::as_object_mut)
        .expect("prompt object");
    prompt.insert(
        "diagnostics".to_owned(),
        serde_json::json!([{
            "code": "missing_icon",
            "message": "伪造诊断",
            "scene_id": "forged_choice",
            "node_id": "prompt",
        }]),
    );
    let layout = prompt
        .get_mut("layout")
        .and_then(serde_json::Value::as_object_mut)
        .expect("layout object");
    for (key, value) in [
        ("x", 1234.0),
        ("y", 2345.0),
        ("width", 1.0),
        ("height", 2.0),
    ] {
        layout.insert(key.to_owned(), serde_json::json!(value));
    }
    layout.insert("anchor_x".to_owned(), serde_json::json!(1.0));
    layout.insert("anchor_y".to_owned(), serde_json::json!(1.0));
    for choice in prompt["choices"].as_array_mut().expect("choices") {
        let choice = choice.as_object_mut().expect("choice object");
        choice.insert("icon".to_owned(), serde_json::json!("sprite.jelly"));
        choice.insert(
            "template".to_owned(),
            serde_json::json!({
                "kind": "button",
                "button": {
                    "id": "forged",
                    "template": "forged.template",
                    "normal": "gui.missing",
                    "x": 7.0,
                    "y": 8.0,
                    "width": 9.0,
                    "height": 10.0
                }
            }),
        );
        choice.insert("x".to_owned(), serde_json::json!(9999.0));
        choice.insert("y".to_owned(), serde_json::json!(9999.0));
        choice.insert("width".to_owned(), serde_json::json!(1.0));
        choice.insert("height".to_owned(), serde_json::json!(1.0));
    }
    let forged: RuntimeSnapshot =
        serde_json::from_value(forged).expect("forged save must deserialize");

    let loaded = runtime
        .load_snapshot(&content, forged)
        .expect("loading must re-resolve instead of trusting the save");
    // Everything the save invented (rects, skins, icons, diagnostics, layout
    // anchors) is replaced by the current content resolution.
    assert_eq!(loaded.snapshot.prompt, expected_prompt);
    let PromptSnapshot::Choice {
        layout,
        diagnostics,
        choices,
        ..
    } = loaded.snapshot.prompt
    else {
        panic!("expected a choice prompt");
    };
    assert!(diagnostics.is_empty());
    assert_eq!((layout.anchor_x, layout.anchor_y), (960.0, 540.0));
    for (index, choice) in choices.iter().enumerate() {
        assert_eq!(choice.icon, None);
        let ChoiceTemplateSnapshot::Button(button) = &choice.template else {
            panic!("the current content template must replace the forged skin");
        };
        assert_eq!(button.template, "choice.primary");
        assert_eq!(button.normal.as_deref(), Some("gui.dialogue_box"));
        assert_eq!(
            (choice.x, choice.y, choice.width, choice.height),
            (800.0, 442.0 + index as f32 * 108.0, 320.0, 88.0)
        );
    }
}

#[test]
fn a_stale_choice_save_keeps_identity_but_reresolves_presentation() {
    let catalog = fixture_catalog();
    let legacy_content = catalog_with_scene(&catalog, choice_scene("stale_choice", 2, None));
    let mut runtime = RuntimeEngine::new(&legacy_content).expect("engine");
    let update = runtime
        .start_scene_preview(&legacy_content, "stale_choice")
        .expect("scene preview");

    // The current content rewrites the same node with an explicit off-centre
    // presentation, mirroring an author edit between save and load.
    let updated_content = catalog_with_scene(
        &catalog,
        choice_scene("stale_choice", 2, Some("{ anchor_x: 700, anchor_y: 900 }")),
    );

    // The save keeps the old order, edited labels and enabled flags but its
    // rects are stale; a ghost id no longer exists in the current content and
    // must be dropped instead of resurrecting a deleted option.
    let mut stale = serde_json::to_value(&update.snapshot).expect("snapshot to value");
    let prompt = stale
        .get_mut("prompt")
        .and_then(serde_json::Value::as_object_mut)
        .expect("prompt object");
    let choices = prompt["choices"].as_array_mut().expect("choices");
    choices.reverse();
    choices[0]["label"] = serde_json::json!("改过的第二项");
    choices[0]["enabled"] = serde_json::json!(false);
    choices[1]["label"] = serde_json::json!("改过的第一项");
    choices.push(serde_json::json!({
        "id": "ghost",
        "label": "幽灵",
        "enabled": true,
        "template": { "kind": "fallback" },
        "x": 5.0,
        "y": 6.0,
        "width": 7.0,
        "height": 8.0
    }));
    let stale: RuntimeSnapshot =
        serde_json::from_value(stale).expect("stale save must deserialize");

    let loaded = runtime
        .load_snapshot(&updated_content, stale)
        .expect("a stale choice save must load against the current content");
    let PromptSnapshot::Choice {
        layout,
        diagnostics,
        choices,
        ..
    } = loaded.snapshot.prompt
    else {
        panic!("expected a choice prompt");
    };
    assert!(diagnostics.is_empty());
    // Identity, order, labels and enabled flags come from the save; the ghost
    // id is dropped because the current content no longer defines it.
    assert_eq!(
        choices
            .iter()
            .map(|choice| choice.id.as_str())
            .collect::<Vec<_>>(),
        vec!["option_1", "option_0"]
    );
    assert_eq!(choices[0].label, "改过的第二项");
    assert_eq!(choices[1].label, "改过的第一项");
    assert_eq!(
        choices
            .iter()
            .map(|choice| choice.enabled)
            .collect::<Vec<_>>(),
        vec![false, true]
    );
    // Geometry comes from the current content: the anchor is the rewritten
    // 700/900 and the dropped ghost consumes neither a rect nor a gap slot.
    assert_eq!((layout.anchor_x, layout.anchor_y), (700.0, 900.0));
    assert_eq!(
        (layout.x, layout.y, layout.width, layout.height),
        (210.0, 798.0, 980.0, 204.0)
    );
    assert_eq!(
        choices.iter().map(|choice| choice.y).collect::<Vec<_>>(),
        vec![798.0, 910.0]
    );
    for choice in &choices {
        assert_eq!(choice.template, ChoiceTemplateSnapshot::Fallback);
        assert_eq!((choice.width, choice.height), (980.0, 92.0));
        assert_eq!(choice.x, 210.0);
    }
}

#[test]
fn loading_a_choice_prompt_with_duplicate_surviving_ids_is_rejected() {
    let catalog = fixture_catalog();
    let content = catalog_with_scene(&catalog, legacy_choice_scene());
    let mut runtime = RuntimeEngine::new(&content).expect("engine");
    let update = runtime
        .start_scene_preview(&content, "legacy_choice")
        .expect("scene preview");

    let mut duplicated = serde_json::to_value(&update.snapshot).expect("snapshot to value");
    let first = duplicated["prompt"]["choices"][0].clone();
    duplicated["prompt"]["choices"]
        .as_array_mut()
        .expect("choices")
        .push(first);
    let duplicated: RuntimeSnapshot =
        serde_json::from_value(duplicated).expect("snapshot must deserialize");

    let error = runtime
        .load_snapshot(&content, duplicated)
        .expect_err("duplicate surviving choice ids must be rejected");
    assert!(error.to_string().contains("重复选项 id first"), "{error}");
}

#[test]
fn loading_an_empty_choice_prompt_keeps_a_waiting_prompt() {
    let catalog = fixture_catalog();
    let content = catalog_with_scene(&catalog, legacy_choice_scene());
    let mut runtime = RuntimeEngine::new(&content).expect("engine");
    let update = runtime
        .start_scene_preview(&content, "legacy_choice")
        .expect("scene preview");

    // A filtered-out choice set is a legal waiting state; the host
    // re-evaluates the conditions once both windows are restored.
    let mut emptied = serde_json::to_value(&update.snapshot).expect("snapshot to value");
    emptied["prompt"]["choices"] = serde_json::json!([]);
    let emptied: RuntimeSnapshot =
        serde_json::from_value(emptied).expect("snapshot must deserialize");

    let loaded = runtime
        .load_snapshot(&content, emptied)
        .expect("an empty loaded choice prompt is a waiting prompt");
    let PromptSnapshot::Choice { choices, .. } = loaded.snapshot.prompt else {
        panic!("expected a waiting choice prompt");
    };
    assert!(choices.is_empty());
}

#[test]
fn loading_an_all_disabled_choice_prompt_keeps_a_waiting_prompt() {
    let catalog = fixture_catalog();
    let content = catalog_with_scene(&catalog, legacy_choice_scene());
    let mut runtime = RuntimeEngine::new(&content).expect("engine");
    let update = runtime
        .start_scene_preview(&content, "legacy_choice")
        .expect("scene preview");

    let mut disabled = serde_json::to_value(&update.snapshot).expect("snapshot to value");
    for choice in disabled["prompt"]["choices"]
        .as_array_mut()
        .expect("choices")
    {
        choice["enabled"] = serde_json::json!(false);
    }
    let disabled: RuntimeSnapshot =
        serde_json::from_value(disabled).expect("snapshot must deserialize");

    let loaded = runtime
        .load_snapshot(&content, disabled)
        .expect("an all-disabled loaded choice prompt is a waiting prompt");
    let PromptSnapshot::Choice { choices, .. } = loaded.snapshot.prompt else {
        panic!("expected a waiting choice prompt");
    };
    assert!(!choices.is_empty() && choices.iter().all(|choice| !choice.enabled));
}

#[test]
fn a_choice_prompt_at_a_non_choice_node_is_rejected() {
    let catalog = fixture_catalog();
    let content = catalog_with_scene(&catalog, legacy_choice_scene());
    let mut runtime = RuntimeEngine::new(&content).expect("engine");
    let update = runtime
        .start_scene_preview(&content, "legacy_choice")
        .expect("scene preview");

    let mut forged = serde_json::to_value(&update.snapshot).expect("snapshot to value");
    forged["location"]["node_id"] = serde_json::json!("done");
    let forged: RuntimeSnapshot =
        serde_json::from_value(forged).expect("snapshot must deserialize");

    let error = runtime
        .load_snapshot(&content, forged)
        .expect_err("a choice prompt must not survive at a non-choice node");
    assert!(error.to_string().contains("choice"), "{error}");
}
