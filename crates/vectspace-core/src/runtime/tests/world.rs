use super::{ack, engine, has_cue, prologue};
use crate::model::{
    AudioSnapshot, CameraSnapshot, CtrlFastForwardMode, CueGate, CurtainAction, CurtainFill,
    CurtainSnapshot, CurtainTransitionSpec, DialoguePageSnapshot, Easing, LoopingAudioSnapshot,
    PlaybackAutoMode, PlaybackSnapshot, PresentationCue, PresentationCueKind, PromptSnapshot,
    ScalarValue, SpriteActionDefinition, SpriteSnapshot, StoryLocation, TimelineKeyframeValue,
    TimelineTrack,
};
use crate::runtime::timeline::apply_timeline_final_state;
use crate::runtime::RuntimeError;
use crate::test_support::{fixture_catalog, from_yaml};
use crate::visual::{CoordinateSpace, EmitterSnapshot, ImageFit, SpriteSource};

const JELLY: &str = "{type: sprite, sprite_id: jelly, action: show, asset: sprite.jelly, flip_x: false, x: 100, y: 200, scale: 2, opacity: 1, z: 3, duration_ms: 0, easing: linear";

#[test]
fn sprite_action_expands_relative_channels_and_parameters() {
    let mut content = prologue(&format!(
        "schema_version: 2\nid: prologue\nentry: show_action\nnodes:\n  show_action: {JELLY}, next: action}}\n  action: {{type: action, sprite_id: jelly, action: sprite.bob, duration_ms: 200, await: true, parameters: {{distance: 15}}, next: done}}\n  done: {{type: end}}\n"
    ));
    content.actions.insert(
        "sprite.bob".to_owned(),
        from_yaml::<SpriteActionDefinition>(
            "schema_version: 1\nid: sprite.bob\nname: 轻轻跳动\nduration_ms: 100\nchannels:\n  x: [{at_ms: 0, value: 0, easing: linear}, {at_ms: 100, value: 10, easing: ease_out, parameter: distance}]\n  scale: [{at_ms: 0, value: 1, easing: linear}, {at_ms: 100, value: 1.2, easing: ease_in_out}]\nparameters:\n  distance: {default: 10, min: 0, max: 50}\nend: hold\n",
        ),
    );
    let update = engine(&content).start_scene_preview(&content, "prologue").unwrap();
    let tracks = update
        .cues
        .iter()
        .find_map(|cue| match &cue.kind {
            PresentationCueKind::Timeline { tracks, .. } => Some(tracks),
            _ => None,
        })
        .expect("action should emit a sprite timeline");
    let TimelineTrack::Sprite { sprite_id, channels, .. } = &tracks[0] else {
        panic!("expected a sprite track")
    };
    assert_eq!(sprite_id, "jelly");
    // Position is relative to the start pose (100 + 15), scale is a multiplier (2 * 1.2).
    let x = channels["x"].last().unwrap();
    assert_eq!(x.at_ms, 200);
    assert_eq!(x.value, TimelineKeyframeValue::Number(115.0));
    assert_eq!(channels["scale"].last().unwrap().value, TimelineKeyframeValue::Number(2.4));
    assert_eq!(update.snapshot.world.sprites["jelly"].x, 115.0);
    assert_eq!(update.snapshot.world.sprites["jelly"].scale, 2.4);
    assert!(update.requires_ack);
}

#[test]
fn sprite_action_restore_returns_to_the_starting_pose() {
    let mut content = prologue(&format!(
        "schema_version: 2\nid: prologue\nentry: show_restore\nnodes:\n  show_restore: {JELLY}, rotation_deg: 0, next: restore}}\n  restore: {{type: action, sprite_id: jelly, action: sprite.restore, await: true, end: restore, next: done}}\n  done: {{type: end}}\n"
    ));
    content.actions.insert(
        "sprite.restore".to_owned(),
        from_yaml::<SpriteActionDefinition>(
            "schema_version: 1\nid: sprite.restore\nname: 恢复\nduration_ms: 100\nchannels:\n  rotation_deg: [{at_ms: 0, value: 0}, {at_ms: 100, value: 45}]\nend: restore\n",
        ),
    );
    let update = engine(&content).start_scene_preview(&content, "prologue").unwrap();
    assert_eq!(update.snapshot.world.sprites["jelly"].rotation_deg, 0.0);
    assert!(has_cue(&update, |kind| matches!(kind, PresentationCueKind::Timeline { .. })));
}

#[test]
fn character_expression_resolves_pose_and_default_crossfade() {
    let mut content = prologue(
        "schema_version: 2\nid: prologue\nentry: role_show\nnodes:\n  role_show: {type: sprite, sprite_id: role, action: show, character: test, flip_x: false, x: 100, y: 200, scale: 2, opacity: 1, z: 2, duration_ms: 0, easing: linear, next: role_change}\n  role_change: {type: sprite, sprite_id: role, action: move, character: test, expression: smug, flip_x: true, x: 120, y: 220, scale: 1, opacity: 0.9, z: 3, duration_ms: 100, easing: linear, await: true, next: done}\n  done: {type: end}\n",
    );
    let character = content.manifest.characters.get_mut("test").unwrap();
    character.default_expression = Some("neutral".to_owned());
    character.default_scale = 1.25;
    character.expressions.insert(
        "neutral".to_owned(),
        from_yaml("{asset: sprite.jelly, anchor_x: 0.4, anchor_y: 0.9, offset_x: 12, offset_y: -8, scale: 0.8}"),
    );
    character.expressions.insert(
        "smug".to_owned(),
        from_yaml("{asset: sprite.omo, anchor_x: 0.6, anchor_y: 1.0, offset_x: -4, offset_y: 0, scale: 1.0}"),
    );

    let update = engine(&content).start_scene_preview(&content, "prologue").unwrap();
    let sprite = &update.snapshot.world.sprites["role"];
    assert_eq!(sprite.source.image_asset(), Some("sprite.omo"));
    assert_eq!((sprite.x, sprite.y), (116.0, 220.0));
    assert_eq!((sprite.scale, sprite.z), (1.25, 3));
    assert!(sprite.flip_x);
    assert_eq!((sprite.anchor_x, sprite.anchor_y), (0.6, 1.0));
    let crossfade = update.cues.iter().find_map(|cue| match &cue.kind {
        PresentationCueKind::SpriteTween { sprite_id, crossfade_ms, to: Some(to), .. }
            if sprite_id == "role" && to.source.image_asset() == Some("sprite.omo") =>
        {
            Some((*crossfade_ms, to.anchor_x))
        }
        _ => None,
    });
    assert_eq!(crossfade, Some((Some(150), 0.6)), "an expression change cross-fades by default");
}

#[test]
fn transparent_button_click_applies_action_and_cross_scene_jump_clears_instances() {
    let mut content = prologue(
        "schema_version: 2\nid: prologue\nentry: button_a\nnodes:\n  button_a: {type: button_create, instance_id: transparent, template: test.transparent, x: 10, y: 20, width: 200, height: 80, opacity: 0, z: 3, action: {sets: [{variable: score, op: add, value: 1}]}, next: button_b}\n  button_b: {type: button_create, instance_id: jump, template: test.transparent, z: 4, action: {next: {type: jump, scene: button_destination, target: done}}, next: end}\n  end: {type: end}\n",
    );
    content.scenes.insert(
        "button_destination".to_owned(),
        from_yaml("schema_version: 2\nid: button_destination\nentry: done\nnodes:\n  done: {type: end}\n"),
    );
    content.buttons.insert(
        "test.transparent".to_owned(),
        from_yaml("{schema_version: 1, id: test.transparent}"),
    );
    let mut runtime = engine(&content);
    let started = runtime.start_new_game(&content).unwrap();
    assert_eq!(started.snapshot.world.buttons.len(), 2);
    // A transparent button is still an intentional hit area.
    assert_eq!(started.snapshot.world.buttons["transparent"].opacity, 0.0);

    let clicked = runtime.click_button(&content, "transparent", started.snapshot.revision).unwrap();
    assert_eq!(clicked.snapshot.variables["score"], ScalarValue::Integer(1));
    assert!(matches!(
        runtime.click_button(&content, "transparent", started.snapshot.revision).unwrap_err(),
        RuntimeError::StaleRevision { .. }
    ));

    let jumped = runtime.click_button(&content, "jump", clicked.snapshot.revision).unwrap();
    assert_eq!(
        jumped.snapshot.location,
        StoryLocation { scene_id: "button_destination".to_owned(), node_id: "done".to_owned() }
    );
    assert!(jumped.snapshot.world.buttons.is_empty());
    assert_eq!(jumped.snapshot.variables["score"], ScalarValue::Integer(0));
    assert!(matches!(
        jumped.cues.first().map(|cue| &cue.kind),
        Some(PresentationCueKind::ClearScene { .. })
    ));
    assert!(jumped.requires_ack);
    let destination = ack(&mut runtime, &content, &jumped);
    assert!(matches!(destination.snapshot.prompt, PromptSnapshot::End { .. }));
}

#[test]
fn visual_timeline_sources_and_emitter_transforms_share_final_state() {
    let content = fixture_catalog();
    let mut snapshot = engine(&content).snapshot;
    let tracks: Vec<TimelineTrack> = serde_json::from_value(serde_json::json!([
        {"type":"sprite", "sprite_id":"label", "source":{"type":"text", "text_block":"label"},
         "sprite_kind":"ui", "channels":{"x":[{"at_ms":100,"value":240}]}},
        {"type":"sprite", "sprite_id":"room", "source":{"type":"image", "asset":"bg.classroom"},
         "sprite_kind":"background"}
    ])).unwrap();
    apply_timeline_final_state(&mut snapshot, &tracks).unwrap();
    let label = &snapshot.world.sprites["label"];
    assert_eq!(label.space, CoordinateSpace::Screen);
    assert_eq!((label.x, label.y, label.anchor_y), (240.0, 540.0, 0.5));
    assert_eq!(snapshot.world.sprites["room"].layout.as_ref().unwrap().fit, ImageFit::Cover);
    let updates: Vec<TimelineTrack> = serde_json::from_value(serde_json::json!([
        {"type":"sprite", "sprite_id":"label", "sprite_kind":"character"}
    ])).unwrap();
    apply_timeline_final_state(&mut snapshot, &updates).unwrap();
    assert_eq!(snapshot.world.sprites["label"].anchor_y, 0.5);
    assert_eq!(snapshot.world.sprites["label"].x, 240.0);
    snapshot.world.emitters.insert("snow".into(), EmitterSnapshot {
        particle: "snow".into(), seed: 17, generation: 2, space: CoordinateSpace::World,
        x: 100.0, y: 200.0, scale: 1.0, rotation_deg: 0.0, opacity: 1.0, z: 0,
    });
    let emitter_tracks: Vec<TimelineTrack> = serde_json::from_value(serde_json::json!([
        {"type":"emitter", "emitter_id":"snow", "channels":{"x":[{"at_ms":100,"value":400}], "scale":[{"at_ms":100,"value":2}]}}
    ])).unwrap();
    apply_timeline_final_state(&mut snapshot, &emitter_tracks).unwrap();
    let emitter = &snapshot.world.emitters["snow"];
    assert_eq!((emitter.x, emitter.scale, emitter.seed, emitter.generation), (400.0, 2.0, 17, 2));
    snapshot.world.emitters.clear();
    assert!(apply_timeline_final_state(&mut snapshot, &emitter_tracks).unwrap_err().contains("未启动"));
}

#[test]
fn timeline_commits_final_state_and_tracks_seen_outcomes() {
    let content = fixture_catalog();
    let mut runtime = engine(&content);
    runtime.started = true;
    runtime.snapshot.audio.bgm = Some(LoopingAudioSnapshot {
        asset: "bgm.test1".to_owned(),
        volume: 0.5,
        start_ms: 0,
        loop_start_ms: None,
        loop_end_ms: None,
    });
    runtime.snapshot.location.node_id = "timeline_showcase".to_owned();
    let cues = runtime.run_until_boundary(&content).unwrap();
    let update = runtime.finish_update(cues, true);
    assert!(update.requires_ack);
    assert_eq!(update.snapshot.world.sprites["omo"].x, 1380.0);
    assert_eq!(update.snapshot.world.camera.rotation_deg, 0.0);
    assert_eq!(update.snapshot.audio.bgm.as_ref().unwrap().volume, 0.35);
    let PresentationCueKind::Timeline { presentation_id, is_seen, .. } = &update.cues[0].kind else {
        panic!("expected timeline cue")
    };
    assert_eq!(presentation_id, "prologue/timeline_showcase");
    assert!(!is_seen);

    let video_update = ack(&mut runtime, &content, &update);
    assert!(video_update.requires_ack);
    assert!(runtime.seen_presentations.contains("prologue/timeline_showcase"));
}

#[test]
fn clear_node_fades_to_an_empty_scene_owned_world_and_hides_the_curtain() {
    let mut content = fixture_catalog();
    content.scenes.get_mut("prologue").unwrap().nodes.insert(
        "clear_test".to_owned(),
        from_yaml("{type: clear, duration_ms: 700, easing: ease_out, await: true, next: introduction}"),
    );
    let mut runtime = engine(&content);
    runtime.snapshot.location.node_id = "clear_test".to_owned();
    runtime.snapshot.world.set_legacy_background(Some("bg.classroom".to_owned()));
    runtime.snapshot.world.sprites.insert(
        "alice".to_owned(),
        SpriteSnapshot {
            source: SpriteSource::Image { asset: "sprite.jelly".to_owned() },
            z: 4,
            ..SpriteSnapshot::default()
        },
    );
    runtime.snapshot.world.camera = CameraSnapshot { x: 40.0, y: -20.0, zoom: 1.3, rotation_deg: 10.0 };
    runtime.snapshot.world.persistent_effects = vec!["rain".to_owned()];
    runtime.snapshot.world.curtain = CurtainSnapshot {
        covered: true,
        fill: Some(CurtainFill::Asset { asset: "gui.dialogue_box".to_owned() }),
    };
    runtime.snapshot.dialogue_page = Some(DialoguePageSnapshot {
        page_id: "old_page".to_owned(),
        speaker_id: None,
        speaker: None,
        name_color: None,
        text_color: None,
        segments: vec!["旧文本".to_owned()],
    });
    runtime.append_history("prologue/old".to_owned(), None, None, None, None, "历史应保留".to_owned());

    let cues = runtime.run_until_boundary(&content).unwrap();
    let world = &runtime.snapshot.world;
    assert_eq!(world.background_asset(), None);
    assert!(world.sprites.is_empty() && world.persistent_effects.is_empty());
    assert_eq!(world.camera, CameraSnapshot::default());
    assert_eq!(world.curtain, CurtainSnapshot::default());
    assert_eq!(runtime.snapshot.dialogue_page, None);
    // `clear` is visual only: the dialogue ledger stays.
    assert_eq!(runtime.dialogue_history().len(), 1);
    assert!(matches!(
        cues.as_slice(),
        [PresentationCue {
            gate: CueGate::Runtime,
            kind: PresentationCueKind::ClearScene { duration_ms: 700, easing: Easing::EaseOut },
            ..
        }]
    ));
}

#[test]
fn cross_scene_jump_clears_visual_state_before_running_destination() {
    let mut content = prologue(
        "schema_version: 2\nid: prologue\nentry: source_sprite\nnodes:\n  source_sprite: {type: sprite, sprite_id: alice, action: show, asset: sprite.jelly, next: source_line}\n  source_line: {type: say, text: 离开当前场景。, next: cross_scene_test}\n  cross_scene_test: {type: jump, scene: destination, target: end}\n",
    );
    content.scenes.insert(
        "destination".to_owned(),
        from_yaml("schema_version: 2\nid: destination\nentry: end\nnodes:\n  end: {type: end}\n"),
    );
    let mut runtime = engine(&content);
    let source_update = runtime.start_new_game(&content).unwrap();
    assert!(source_update.snapshot.world.sprites.contains_key("alice"));
    runtime.snapshot.variables.insert("score".to_owned(), ScalarValue::Integer(42));
    runtime.snapshot.audio.bgm = Some(LoopingAudioSnapshot {
        asset: "bgm.test1".to_owned(),
        volume: 0.5,
        start_ms: 250,
        loop_start_ms: None,
        loop_end_ms: None,
    });
    runtime.snapshot.playback = PlaybackSnapshot {
        auto: PlaybackAutoMode::Forced,
        ctrl_fast_forward: CtrlFastForwardMode::Block,
    };
    runtime.snapshot.world.dialogue_ui_visible = false;
    let update = runtime
        .advance(&content, source_update.snapshot.revision, crate::model::AdvanceSource::ForcedAuto)
        .unwrap();

    assert!(update.requires_ack);
    assert_eq!(
        update.snapshot.location,
        StoryLocation { scene_id: "destination".to_owned(), node_id: "end".to_owned() }
    );
    // A Scene is a complete ownership boundary: everything it authored resets.
    let snapshot = &update.snapshot;
    assert_eq!(snapshot.world.background_asset(), None);
    assert!(snapshot.world.sprites.is_empty());
    assert!(snapshot.audio.bgm.is_none());
    assert_eq!(snapshot.audio, AudioSnapshot::default());
    assert_eq!(snapshot.playback, PlaybackSnapshot::default());
    assert!(snapshot.world.dialogue_ui_visible);
    assert_eq!(snapshot.variables["score"], ScalarValue::Integer(0));
    assert!(runtime.dialogue_history().is_empty());
    assert!(matches!(
        update.cues.as_slice(),
        [PresentationCue {
            gate: CueGate::Runtime,
            kind: PresentationCueKind::ClearScene { duration_ms: 0, .. },
            ..
        }]
    ));
    let destination = ack(&mut runtime, &content, &update);
    assert!(matches!(destination.snapshot.prompt, PromptSnapshot::End { .. }));
}

#[test]
fn curtain_cover_and_reveal_track_stable_state_without_deadlocking() {
    let content = prologue(
        "schema_version: 2\nid: prologue\nentry: curtain_cover\nnodes:\n  curtain_cover: {type: curtain, action: cover, fill: {color: '#000000'}, transition: {type: split_horizontal}, duration_ms: 600, easing: ease_in_out, await: true, next: curtain_reveal}\n  curtain_reveal: {type: curtain, action: reveal, transition: {type: fade}, duration_ms: 400, easing: ease_in_out, await: true, next: curtain_reveal_again}\n  curtain_reveal_again: {type: curtain, action: reveal, transition: {type: fade}, duration_ms: 400, easing: ease_in_out, await: true, next: curtain_end}\n  curtain_end: {type: end}\n",
    );
    let black = || CurtainFill::Color { color: "#000000".to_owned() };
    let mut runtime = engine(&content);
    let cover = runtime.start_new_game(&content).unwrap();
    assert_eq!(cover.snapshot.location.node_id, "curtain_reveal");
    assert!(cover.requires_ack);
    assert!(cover.snapshot.world.curtain.covered);
    assert_eq!(cover.snapshot.world.curtain.fill, Some(black()));
    assert!(has_cue(&cover, |kind| *kind
        == PresentationCueKind::CurtainTransition {
            action: CurtainAction::Cover,
            fill: Some(black()),
            transition: CurtainTransitionSpec::SplitHorizontal,
            duration_ms: 600,
            easing: Easing::EaseInOut,
        }));

    let reveal = ack(&mut runtime, &content, &cover);
    assert_eq!(reveal.snapshot.location.node_id, "curtain_reveal_again");
    assert!(reveal.requires_ack);
    assert_eq!(reveal.snapshot.world.curtain, CurtainSnapshot::default());
    assert!(has_cue(&reveal, |kind| *kind
        == PresentationCueKind::CurtainTransition {
            action: CurtainAction::Reveal,
            fill: Some(black()),
            transition: CurtainTransitionSpec::Fade,
            duration_ms: 400,
            easing: Easing::EaseInOut,
        }));

    // Re-revealing an already revealed curtain must advance immediately
    // instead of emitting an awaited cue that nobody resolves.
    let repeated = ack(&mut runtime, &content, &reveal);
    assert_eq!(repeated.snapshot.location.node_id, "curtain_end");
    assert!(!repeated.requires_ack);
    assert!(!has_cue(&repeated, |kind| matches!(kind, PresentationCueKind::CurtainTransition { .. })));
}
