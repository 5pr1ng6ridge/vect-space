//! Repository-level contract tests for the transition/effect/curtain wire.
//!
//! These exercise the public content and runtime API the way a host does:
//! authored YAML is loaded, validated, executed and restored.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use vectspace_core::content::{ContentCatalog, ContentError};
use vectspace_core::model::{
    BackgroundTransitionSpec, CueGate, CurtainAction, CurtainFill, CurtainSnapshot,
    CurtainTransitionSpec, Easing, PresentationCue, PresentationCueKind, SceneDefinition,
    StoryLocation, TransitionDirection,
};
use vectspace_core::runtime::RuntimeEngine;

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/game")
}

fn fixture_catalog() -> ContentCatalog {
    ContentCatalog::from_root(fixture_root()).expect("fixture content must be valid")
}

/// Re-validates a scene map through the public constructor, exactly like the
/// loader does for a saved project.
fn rebuild(
    catalog: &ContentCatalog,
    scenes: BTreeMap<String, SceneDefinition>,
) -> Result<ContentCatalog, ContentError> {
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
    ContentCatalog::from_documents_with_chapter_map(
        root,
        catalog.manifest.clone(),
        scenes,
        ui_motions,
        catalog.chapter_map.clone(),
    )
}

fn scene_from_yaml(yaml: &str) -> SceneDefinition {
    let options = serde_saphyr::options! { strict_booleans: true };
    serde_saphyr::from_str_with_options(yaml, options).expect("scene YAML must parse")
}

#[test]
fn canonical_transitions_effect_and_curtain_yaml_validates() {
    let catalog = fixture_catalog();
    let scene = scene_from_yaml(
        r##"
schema_version: 2
id: canonical_contract
entry: color
nodes:
  color:
    type: background
    background: bg.vector_space
    transition:
      type: fade_through_color
      color: "#11223344"
    duration_ms: 500
    easing: ease_in_out
    await: false
    next: wipe
  wipe:
    type: background
    background: bg.nvctsp
    transition:
      type: wipe
      direction: right_to_left
      softness: 0.08
    duration_ms: 700
    easing: ease_out
    await: false
    next: push
  push:
    type: background
    background: bg.vector_space
    transition:
      type: push
      direction: bottom_to_top
    duration_ms: 700
    easing: ease_in
    await: false
    next: shake
  shake:
    type: screen_effect
    effect:
      type: shake
      amplitude_x: 18
      amplitude_y: 8
      frequency_hz: 22
      decay: 0.75
      seed: 42
    duration_ms: 220
    await: false
    next: cover
  cover:
    type: curtain
    action: cover
    fill:
      color: "#000000"
    transition:
      type: split_horizontal
    duration_ms: 600
    easing: ease_in_out
    await: true
    next: cover_asset
  cover_asset:
    type: curtain
    action: cover
    fill:
      asset: gui.dialogue_box
    transition:
      type: wipe
      direction: top_to_bottom
    duration_ms: 400
    easing: linear
    await: true
    next: reveal
  reveal:
    type: curtain
    action: reveal
    transition:
      type: split_vertical
    duration_ms: 500
    easing: ease_in_out
    await: true
    next: done
  done:
    type: end
"##,
    );
    let mut scenes = catalog.scenes.clone();
    scenes.insert("canonical_contract".to_owned(), scene);
    let rebuilt = rebuild(&catalog, scenes).expect("canonical YAML must validate");

    let color = &rebuilt.scenes["canonical_contract"].nodes["color"];
    assert!(matches!(
        color,
        vectspace_core::model::SceneNode::Background {
            transition: BackgroundTransitionSpec::FadeThroughColor { color },
            ..
        } if color == "#11223344"
    ));
    let cover = &rebuilt.scenes["canonical_contract"].nodes["cover"];
    assert!(matches!(
        cover,
        vectspace_core::model::SceneNode::Curtain {
            action: CurtainAction::Cover,
            fill: Some(CurtainFill::Color { .. }),
            transition: CurtainTransitionSpec::SplitHorizontal,
            ..
        }
    ));
}

#[test]
fn a_restored_covered_curtain_keeps_its_state_and_can_reveal() {
    let catalog = fixture_catalog();
    let scene = scene_from_yaml(
        r#"
schema_version: 2
id: curtain_restore
entry: reveal
nodes:
  reveal:
    type: curtain
    action: reveal
    transition:
      type: fade
    duration_ms: 400
    easing: ease_in_out
    await: true
    next: done
  done:
    type: end
"#,
    );
    let mut scenes = catalog.scenes.clone();
    scenes.insert("curtain_restore".to_owned(), scene);
    let rebuilt = rebuild(&catalog, scenes).expect("curtain restore scene must validate");

    let mut engine = RuntimeEngine::new(&rebuilt).expect("engine");
    let mut snapshot = engine.snapshot().clone();
    snapshot.location = StoryLocation {
        scene_id: "curtain_restore".to_owned(),
        node_id: "reveal".to_owned(),
    };
    snapshot.world.curtain = CurtainSnapshot {
        covered: true,
        fill: Some(CurtainFill::Asset {
            asset: "gui.dialogue_box".to_owned(),
        }),
    };
    let loaded = engine
        .load_snapshot(&rebuilt, snapshot)
        .expect("a consistent covered curtain must restore");
    // Restoring never replays a cue: the stable state is simply there.
    assert!(loaded.snapshot.world.curtain.covered);
    assert!(loaded.cues.is_empty());
}

#[test]
fn inconsistent_curtain_snapshots_are_rejected() {
    let catalog = fixture_catalog();

    let cases = [
        (
            "covered-without-fill",
            CurtainSnapshot {
                covered: true,
                fill: None,
            },
        ),
        (
            "hidden-with-fill",
            CurtainSnapshot {
                covered: false,
                fill: Some(CurtainFill::Color {
                    color: "#000000".to_owned(),
                }),
            },
        ),
        (
            "bad-colour",
            CurtainSnapshot {
                covered: true,
                fill: Some(CurtainFill::Color {
                    color: "#00".to_owned(),
                }),
            },
        ),
        (
            "unknown-asset",
            CurtainSnapshot {
                covered: true,
                fill: Some(CurtainFill::Asset {
                    asset: "gui.missing".to_owned(),
                }),
            },
        ),
        (
            "wrong-kind",
            CurtainSnapshot {
                covered: true,
                fill: Some(CurtainFill::Asset {
                    asset: "sprite.jelly".to_owned(),
                }),
            },
        ),
    ];
    for (label, curtain) in cases {
        let mut engine = RuntimeEngine::new(&catalog).expect("engine");
        let mut snapshot = engine.snapshot().clone();
        snapshot.world.curtain = curtain;
        assert!(
            engine.load_snapshot(&catalog, snapshot).is_err(),
            "{label} must be rejected"
        );
    }
}

#[test]
fn direction_and_type_typos_report_actionable_diagnostics() {
    let options = serde_saphyr::options! { strict_booleans: true };
    let bad_direction: Result<SceneDefinition, _> = serde_saphyr::from_str_with_options(
        "schema_version: 2\nid: s\nentry: a\nnodes:\n  a:\n    type: background\n    transition: {type: wipe, direction: sideways}\n    next: a\n",
        options,
    );
    let message = bad_direction.unwrap_err().to_string();
    assert!(message.contains("sideways"), "{message}");
    assert!(message.contains("left_to_right"), "{message}");

    let options = serde_saphyr::options! { strict_booleans: true };
    let missing_direction: Result<SceneDefinition, _> = serde_saphyr::from_str_with_options(
        "schema_version: 2\nid: s\nentry: a\nnodes:\n  a:\n    type: background\n    transition: {type: push}\n    next: a\n",
        options,
    );
    assert!(missing_direction
        .unwrap_err()
        .to_string()
        .contains("direction"));

    let options = serde_saphyr::options! { strict_booleans: true };
    let bad_type: Result<SceneDefinition, _> = serde_saphyr::from_str_with_options(
        "schema_version: 2\nid: s\nentry: a\nnodes:\n  a:\n    type: screen_effect\n    effect: {type: blur}\n    next: a\n",
        options,
    );
    let message = bad_type.unwrap_err().to_string();
    assert!(message.contains("blur"), "{message}");
}

#[test]
fn presentation_cues_round_trip() {
    let cue = PresentationCue {
        cue_id: 7,
        gate: CueGate::Runtime,
        kind: PresentationCueKind::CurtainTransition {
            action: CurtainAction::Cover,
            fill: Some(CurtainFill::Color {
                color: "#000000".to_owned(),
            }),
            transition: CurtainTransitionSpec::Wipe {
                direction: TransitionDirection::TopToBottom,
            },
            duration_ms: 600,
            easing: Easing::EaseInOut,
        },
    };
    let json = serde_json::to_string(&cue).unwrap();
    assert_eq!(serde_json::from_str::<PresentationCue>(&json).unwrap(), cue);
}

/// The generated schema must reject `{color, asset}` exactly like the loader.
///
/// `CurtainFill` is an untagged enum whose custom deserializer reports an
/// ambiguous fill; the schema mirrors that rule through
/// `additionalProperties: false` on both branches, so a schema-only validator
/// (the editor's authoring check) cannot accept a document the runtime would
/// refuse to load.
#[test]
fn curtain_fill_schema_rejects_the_ambiguous_object_like_the_loader() {
    let schema_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../src-tauri/gen/content-schemas/scene.schema.json");
    let schema: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(schema_path).unwrap()).unwrap();
    let branches = schema["$defs"]["CurtainFill"]["anyOf"]
        .as_array()
        .expect("CurtainFill must be an anyOf of its two fills");
    assert_eq!(branches.len(), 2, "one branch per fill");
    for branch in branches {
        assert_eq!(
            branch["additionalProperties"],
            serde_json::Value::Bool(false),
            "a branch without additionalProperties would accept the other fill too"
        );
        let required = branch["required"].as_array().expect("required field");
        assert_eq!(required.len(), 1, "exactly one fill key");
        let key = required[0].as_str().unwrap();
        assert!(
            matches!(key, "color" | "asset"),
            "unexpected fill key: {key}"
        );
        assert!(
            branch["properties"][key].is_object(),
            "missing {key} schema"
        );
    }
}
