use std::collections::BTreeMap;
use std::fs;

use crate::content::chapter_map::{validate_chapter_map, MAX_CHAPTER_MAP_HOVER_TEXT_CHARS};
use crate::content::common::{
    validate_color, validate_display_name, validate_identifier, validate_relative_path,
};
use crate::content::conditions::{validate_condition, validate_mutation, MAX_CONDITION_DEPTH};
use crate::content::manifest::{
    reject_git_lfs_pointer, validate_manifest_paths, validate_variable_definitions,
};
use crate::content::markup::{scan_text_markup, validate_text_markup};
use crate::content::animation::validate_action_document;

use crate::model::{
    ChapterMapDefinition, ConditionExpression, ContentManifest, MutationValue, SpriteActionDefinition,
    VariableDefinition, VariableOperation, VariableType,
};
use crate::test_support::{fixture_catalog, from_yaml};

fn variables(yaml: &str) -> BTreeMap<String, VariableDefinition> {
    from_yaml(yaml)
}

#[test]
fn paths_and_identifiers_are_deliberately_boring() {
    assert!(validate_relative_path("../secret.yaml").is_err());
    assert!(validate_relative_path("assets/../../secret").is_err());
    assert!(validate_relative_path("backgrounds/room.png").is_ok());
    assert!(validate_identifier("id", "bg.classroom-night_1").is_ok());
    assert!(validate_identifier("id", "../scene").is_err());
    assert!(validate_identifier("id", "space here").is_err());
}

#[test]
fn duplicate_yaml_keys_are_rejected() {
    let yaml = "schema_version: 1\ncontent_version: first\ncontent_version: second\nentry_scene: a\ndefault_locale: zh-CN\nassets: {}\nscenes: []\n";
    let options = serde_saphyr::options! { strict_booleans: true };
    assert!(serde_saphyr::from_str_with_options::<ContentManifest>(yaml, options).is_err());
}

#[test]
fn managed_document_paths_are_case_insensitive_and_cannot_target_metadata() {
    let mut manifest = fixture_catalog().manifest;
    manifest.scenes = vec![
        "scenes/intro.yaml".to_owned(),
        "scenes/INTRO.yaml".to_owned(),
    ];
    assert!(validate_manifest_paths(&manifest)
        .unwrap_err()
        .to_string()
        .contains("冲突"));

    manifest.scenes = vec!["assets/scene.yaml".to_owned()];
    assert!(validate_manifest_paths(&manifest).is_err());
}

#[test]
fn unresolved_git_lfs_assets_are_rejected_with_an_actionable_error() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("missing.png");
    fs::write(
        &path,
        "version https://git-lfs.github.com/spec/v1\noid sha256:deadbeef\nsize 42\n",
    )
    .unwrap();

    let message = reject_git_lfs_pointer("bg.missing", &path)
        .unwrap_err()
        .to_string();
    assert!(message.contains("Git LFS 指针"));
    assert!(message.contains("git lfs pull"));
}

#[test]
fn chapter_map_grid_and_checked_bounds_reject_invalid_geometry() {
    let catalog = fixture_catalog();
    let mut map: ChapterMapDefinition = from_yaml(
        "schema_version: 1\nhotspots:\n- {id: entry, scene_id: prologue, title: 入口, x: 240, y: 460, width: 280, height: 160, z: 1}\n",
    );
    let accepts = |map: &ChapterMapDefinition| {
        validate_chapter_map(
            map,
            &catalog.scenes,
            &catalog.manifest.assets,
            &catalog.manifest.variables,
        )
        .is_ok()
    };
    assert!(accepts(&map));

    map.hotspots[0].hover_text = Some("x".repeat(MAX_CHAPTER_MAP_HOVER_TEXT_CHARS + 1));
    assert!(!accepts(&map));
    map.hotspots[0].hover_text = Some("入口\u{0007}".to_owned());
    assert!(!accepts(&map));
    map.hotspots[0].hover_text = None;

    // The room size must be a multiple of the editor grid.
    map.width = 1930;
    assert!(!accepts(&map));
    map.width = 1920;

    map.hotspots[0].x = i32::MAX;
    assert!(!accepts(&map));
    map.hotspots[0].x = 240;

    // The viewport centre must keep the viewport inside the room.
    map.view_x = 0;
    assert!(!accepts(&map));
    map.width = 3840;
    map.view_x = 960 - 20;
    assert!(!accepts(&map));
    map.view_x = 960;
    assert!(accepts(&map));
    map.view_x = 951;
    assert!(!accepts(&map));
}

#[test]
fn markup_scanner_accepts_escapes_and_formulas_and_rejects_malformed_controls() {
    for source in [
        r"\[fx=glow] $[pause=oops]$ \$ [var=name]",
        "$$[fx=not-a-control][/fx]$$",
        "[fx=shake][fx=glow]字[/fx][/fx]",
        "普通文本 [AFKV;",
        "金额 $678932{}|{}[AFKV;",
        "\n[fx=glow]字[/fx]\r\n",
    ] {
        assert!(scan_text_markup(source).is_ok(), "should accept {source:?}");
    }
    for source in [
        "[fx=unknown]字[/fx]",
        "[fx=glow]未闭合",
        "[/fx]多余结束",
        "[fx=glow]错序[/fx][/fx]",
        "[pause=abcms]",
        "[pause=50]",
        "[speed=0cps]",
        "[speed=fast]",
        "[auto]后面还有字",
    ] {
        assert!(scan_text_markup(source).is_err(), "should reject {source:?}");
    }
}

#[test]
fn variable_definitions_conditions_and_text_references_are_type_checked() {
    let mut vars = variables("score: {scope: save, type: integer, default: 0}");
    assert!(validate_variable_definitions(&vars).is_ok());
    vars.get_mut("score").unwrap().default = from_yaml("\"0\"");
    assert!(validate_variable_definitions(&vars).is_err());
    vars.get_mut("score").unwrap().default = from_yaml("0");

    let ordering_a_string: ConditionExpression =
        from_yaml("{op: gt, left: {variable: score}, right: {value: ten}}");
    assert!(validate_condition(&ordering_a_string, &vars, "scene", "node").is_err());

    let empty_and = ConditionExpression::And {
        conditions: Vec::new(),
    };
    assert!(validate_condition(&empty_and, &BTreeMap::new(), "scene", "node").is_err());
    let mut deep: ConditionExpression = from_yaml("{op: eq, left: {value: true}, right: {value: true}}");
    for _ in 0..MAX_CONDITION_DEPTH {
        deep = ConditionExpression::Not {
            condition: Box::new(deep),
        };
    }
    assert!(validate_condition(&deep, &BTreeMap::new(), "scene", "node").is_err());

    let vars = variables(
        "score: {scope: save, type: integer, default: 0}\nname: {scope: save, type: string, default: \"\"}",
    );
    assert!(validate_text_markup("[var=name] $[var=score]$", &vars, "s", "n").is_ok());
    assert!(validate_text_markup("$[var=name]$", &vars, "s", "n").is_err());
    assert!(validate_text_markup("[var=missing]", &vars, "s", "n").is_err());
    assert!(validate_text_markup(r"\[var=missing]", &vars, "s", "n").is_ok());
}

#[test]
fn character_names_and_colors_are_strict() {
    assert!(validate_display_name("爱丽丝").is_ok());
    assert!(validate_display_name("").is_err());
    assert!(validate_display_name("line\nbreak").is_err());
    assert!(validate_display_name(&"角".repeat(65)).is_err());
    assert!(validate_color("#80D8FF").is_ok());
    assert!(validate_color("#80D8FFCC").is_ok());
    assert!(validate_color("80D8FF").is_err());
    assert!(validate_color("#XYZXYZ").is_err());
}

#[test]
fn mutation_validation_covers_operations_and_operand_variables() {
    let vars = variables(
        "score: {scope: save, type: integer, default: 0}\nbonus: {scope: save, type: integer, default: 1}",
    );
    let check = |op, value: Option<MutationValue>, target| {
        validate_mutation(op, value.as_ref(), target, &vars, "scene", "node").is_ok()
    };
    assert!(check(
        VariableOperation::Add,
        Some(from_yaml("{variable: bonus}")),
        VariableType::Integer
    ));
    assert!(check(VariableOperation::Toggle, None, VariableType::Boolean));
    assert!(!check(
        VariableOperation::Append,
        Some(MutationValue::Literal(from_yaml("x"))),
        VariableType::Integer
    ));
}

#[test]
fn sprite_action_documents_reject_empty_channels_and_bad_parameters() {
    let action = |channels: &str, parameters: &str| -> SpriteActionDefinition {
        from_yaml(&format!(
            "schema_version: 1\nid: sprite.test\nname: 测试动作\nduration_ms: 100\nchannels: {channels}\nparameters: {parameters}\n"
        ))
    };
    let message = |document: SpriteActionDefinition| {
        validate_action_document(&document).unwrap_err().to_string()
    };
    assert!(message(action("{}", "{}")).contains("至少需要一个变换通道"));
    assert!(message(action(
        "{x: [{at_ms: 0, value: 0, parameter: distance}]}",
        "{distance: {default: 5, min: 10, max: 1}}"
    ))
    .contains("范围或默认值无效"));
    assert!(message(action("{x: [{at_ms: 50, value: 10}]}", "{}")).contains("必须从 0ms"));
    assert!(message(action("{x: [{at_ms: 0, value: 0, parameter: missing}]}", "{}"))
        .contains("未知参数"));
}
