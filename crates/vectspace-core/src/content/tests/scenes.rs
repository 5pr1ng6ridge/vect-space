use std::collections::BTreeMap;

use super::{node_error, prologue_with_node, rebuild};
use crate::content::scenes::validate_scenes;
use crate::content::timeline::{validate_timeline, validate_timeline_channels};
use crate::model::{AssetDefinition, AssetKind, SceneNode, TimelineChannels, TimelineEvent};
use crate::test_support::{fixture_catalog, from_yaml, node, scene};

#[test]
fn open_window_requires_a_declared_scene_and_a_declared_next_node() {
    let catalog = fixture_catalog();
    let mut scenes = catalog.scenes.clone();
    scenes.insert(
        "secondary_scene".to_owned(),
        scene("schema_version: 2\nid: secondary_scene\nwindow_role: secondary\nentry: done\nnodes:\n  done: {type: end}\n"),
    );
    let with_open = |target: &str, next: &str| {
        let mut scenes = scenes.clone();
        scenes.insert(
            "window_scene".to_owned(),
            scene(&format!(
                "schema_version: 2\nid: window_scene\nentry: open\nnodes:\n  open: {{type: open_window, scene: {target}, next: {next}}}\n  done: {{type: end}}\n"
            )),
        );
        rebuild(&catalog, scenes)
    };

    let valid = with_open("secondary_scene", "done");
    assert!(valid.is_ok(), "{valid:?}");
    // An undeclared target Scene must be rejected at load time, not when the
    // player reaches the node.
    let error = with_open("does_not_exist", "done").unwrap_err().to_string();
    assert!(error.contains("does_not_exist"), "{error}");
    // `next` stays inside the current Scene and must exist there.
    let error = with_open("secondary_scene", "missing").unwrap_err().to_string();
    assert!(error.contains("open_window"), "{error}");
}

fn lecture(document: &str, mode: &str, extra: &str, steps: &str) -> SceneNode {
    node(&format!(
        "type: long_text\ndocument: {document}\nmode: {mode}\n{extra}steps:\n{steps}next: introduction\n"
    ))
}

#[test]
fn long_text_steps_require_stable_ids_and_a_nonleading_page_break() {
    let catalog = fixture_catalog();
    let start = |first_break: bool| {
        lecture(
            "lecture",
            "start",
            "paper: gui.dialogue_box\npagination: auto\n",
            &format!(
                "- {{id: definition, text: '设 $V$ 是向量空间。', page_break_before: {first_break}}}\n- {{id: consequence, text: '则 $0\\in V$。', page_break_before: true}}\n"
            ),
        )
    };
    let valid = rebuild(&catalog, prologue_with_node(&catalog, "lecture", start(false)));
    assert!(valid.is_ok(), "{valid:?}");

    let scenes = prologue_with_node(&catalog, "lecture", start(true));
    let error = rebuild(&catalog, scenes).unwrap_err();
    assert!(error.to_string().contains("第一步骤"), "{error}");
}

#[test]
fn continuation_inherits_start_presentation_and_pagination_rules() {
    let catalog = fixture_catalog();
    let mut scenes = prologue_with_node(
        &catalog,
        "lecture_start",
        lecture(
            "lecture",
            "start",
            "pagination: continuous\non_exit: keep_visible\nfont_size: 32\n",
            "- {id: first, text: 第一段}\n",
        ),
    );
    let continuation = |extra: &str, page_break: bool| {
        lecture(
            "lecture",
            "continue",
            extra,
            &format!("- {{id: second, text: 第二段, page_break_before: {page_break}}}\n"),
        )
    };
    let prologue = scenes.get_mut("prologue").unwrap();
    prologue
        .nodes
        .insert("restyled".to_owned(), continuation("pagination: auto\n", false));
    let error = rebuild(&catalog, scenes.clone()).unwrap_err().to_string();
    assert!(error.contains("只能继承"), "{error}");

    let prologue = scenes.get_mut("prologue").unwrap();
    prologue.nodes.remove("restyled");
    prologue
        .nodes
        .insert("paged".to_owned(), continuation("", true));
    let error = rebuild(&catalog, scenes).unwrap_err().to_string();
    assert!(error.contains("连续长文本"), "{error}");
}

#[test]
fn story_node_numeric_fields_reject_non_finite_values() {
    // YAML itself refuses non-finite floats, so they are patched in afterwards
    // the way a non-YAML producer (the editor's IPC) could deliver them.
    let catalog = fixture_catalog();
    let mut sprite = node("type: sprite
sprite_id: nan
action: show
asset: sprite.jelly
next: introduction
");
    if let SceneNode::Sprite { x, .. } = &mut sprite {
        *x = Some(f32::NAN);
    }
    let mut say = node("type: say
text: 无效速度
next: introduction
");
    if let SceneNode::Say { speed_cps, .. } = &mut say {
        *speed_cps = Some(f32::INFINITY);
    }
    let mut camera = node("type: camera
x: 0
y: 0
zoom: 1
next: introduction
");
    if let SceneNode::Camera { x, zoom, .. } = &mut camera {
        *x = f32::NEG_INFINITY;
        *zoom = f32::NAN;
    }
    let long_text = node(
        "type: long_text
font_size: 73
steps:
- {id: step, text: 无效字号}
next: introduction
",
    );
    for (node, expected) in [
        (sprite, "sprite 坐标"),
        (say, "speed_cps"),
        (long_text, "font_size"),
        (camera, "camera 坐标"),
    ] {
        let error = node_error(&catalog, node);
        assert!(error.contains(expected), "{expected}: {error}");
    }
}

#[test]
fn timeline_screen_effects_follow_the_single_animation_duration_limit() {
    let event: TimelineEvent = from_yaml(
        "{type: screen_effect, id: too_long, at_ms: 1, effect: {type: flash}, duration_ms: 60001}",
    );
    let error = validate_timeline(
        120_000,
        true,
        false,
        &[],
        &[event],
        &fixture_catalog().manifest.assets,
        "prologue",
        "timeline_limit_test",
    )
    .unwrap_err();
    assert!(error.to_string().contains("不能超过 60 秒"));
}

fn channels_valid(yaml: &str, duration_ms: u64, allow_inherit: bool) -> bool {
    let channels: TimelineChannels = from_yaml(yaml);
    let names: Vec<&str> = channels.keys().map(String::as_str).collect();
    let mut count = 0;
    validate_timeline_channels(
        &channels,
        &names,
        duration_ms,
        "scene",
        "timeline",
        &mut count,
        allow_inherit,
    )
    .is_ok()
}

#[test]
fn axis_scale_keyframes_allow_mirroring_but_not_zero() {
    for channel in ["scale_x", "scale_y"] {
        assert!(channels_valid(&format!("{channel}: [{{at_ms: 0, value: -1}}]"), 100, true));
        assert!(!channels_valid(&format!("{channel}: [{{at_ms: 0, value: 0}}]"), 100, true));
    }
}

#[test]
fn timeline_inherit_is_only_a_zero_ms_first_frame() {
    let inherit_then_target = "x: [{at_ms: 0, value: inherit}, {at_ms: 500, value: 700}]";
    assert!(channels_valid(inherit_then_target, 500, true));
    assert!(!channels_valid(inherit_then_target, 500, false));
    assert!(!channels_valid(
        "x: [{at_ms: 100, value: inherit}, {at_ms: 500, value: 700}]",
        500,
        true
    ));
    assert!(!channels_valid("x: [{at_ms: 0, value: inherit}]", 500, true));
}

#[test]
fn ambience_nodes_validate_kind_asset_loop_volume_and_timeline_slots() {
    let catalog = fixture_catalog();
    let mut assets = catalog.manifest.assets.clone();
    assets.insert(
        "ambience.test".to_owned(),
        AssetDefinition {
            kind: AssetKind::Ambience,
            path: Some("audio/test_bgm.ogg".to_owned()),
            animation: None,
        },
    );
    let ambience = |overrides: &[(&str, &str)]| {
        let mut fields = BTreeMap::from([
            ("type", "ambience"),
            ("slot", "slot_1"),
            ("action", "start"),
            ("asset", "ambience.test"),
            ("volume", "0.6"),
            ("start_ms", "0"),
            ("loop_start_ms", "100"),
            ("loop_end_ms", "900"),
            ("duration_ms", "300"),
            ("next", "introduction"),
        ]);
        fields.extend(overrides.iter().copied());
        node(
            &fields
                .iter()
                .map(|(key, value)| format!("{key}: {value}\n"))
                .collect::<String>(),
        )
    };
    let validate = |node| {
        validate_scenes(
            &prologue_with_node(&catalog, "probe", node),
            &assets,
            &catalog.manifest.variables,
            &catalog.manifest.characters,
            &catalog.ui_motions,
            &catalog.buttons,
            &catalog.actions,
        &catalog.proofs,
        )
    };
    validate(ambience(&[])).expect("a fully specified ambience node is valid");

    let mut cases = vec![
        (ambience(&[("asset", "bgm.test1")]), "类型不正确"),
        (ambience(&[("asset", "null")]), "必须提供 asset"),
        (ambience(&[("action", "stop")]), "不能提供 asset"),
        (ambience(&[("loop_end_ms", "50")]), "循环点顺序无效"),
        (ambience(&[("start_ms", "901")]), "循环点顺序无效"),
        (
            ambience(&[("duration_ms", "18446744073709551615")]),
            "单个动画时长不能超过 60 秒",
        ),
    ];
    for volume in [f32::NAN, -0.01, 1.01] {
        let mut node = ambience(&[]);
        if let SceneNode::Ambience { volume: value, .. } = &mut node {
            *value = volume;
        }
        cases.push((node, "音量必须"));
    }
    let slot_track = "{type: ambience, slot: slot_2, channels: {volume: [{at_ms: 0, value: 0.2}]}}";
    cases.push((
        node(&format!(
            "type: timeline\nduration_ms: 300\nawait: true\nskippable: true\ntracks: [{slot_track}, {slot_track}]\nnext: introduction\n"
        )),
        "同一 ambience 槽位",
    ));
    for (node, expected) in cases {
        let error = validate(node).unwrap_err().to_string();
        assert!(error.contains(expected), "expected {expected}, got {error}");
    }
}
