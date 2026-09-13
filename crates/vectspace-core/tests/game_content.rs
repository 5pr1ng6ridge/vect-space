//! Validates the repository's real `game/` project through the content model.
//!
//! Binary assets are Git LFS tracked, so a checkout without `git lfs pull`
//! only has pointer text; the content model deliberately rejects unresolved
//! pointers, and this test then skips instead of reporting a content bug that
//! is really a missing `git lfs pull`.

use std::path::Path;

use vectspace_core::content::ContentCatalog;

fn repository_game_root() -> Option<std::path::PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../game");
    root.join("manifest.yaml").is_file().then_some(root)
}

#[test]
fn repository_game_project_validates_including_animations() {
    let Some(root) = repository_game_root() else {
        return;
    };
    match ContentCatalog::from_root(root) {
        Ok(catalog) => {
            assert!(
                !catalog.animations.is_empty(),
                "the showcase animation documents must be registered"
            );
            let resolved = catalog
                .resolve_assets(&["bg.anim_scan".to_owned(), "gui.button_pulse".to_owned()])
                .expect("animated assets must resolve");
            for asset in &resolved {
                let animation = asset
                    .animation
                    .as_ref()
                    .expect("showcase assets must carry a frame list");
                assert!(animation.frames.len() >= 2, "{}", asset.id);
                assert!(animation.width > 0 && animation.height > 0, "{}", asset.id);
                assert!(animation.total_duration_ms > 0, "{}", asset.id);
            }
            // Every frame resolves to a real file that is not another animation.
            let scan = resolved[0].animation.as_ref().unwrap();
            let expected: Vec<&str> = scan
                .frames
                .iter()
                .map(|frame| frame.asset.as_str())
                .collect();
            assert_eq!(expected, vec!["bg.anim_scan_a", "bg.anim_scan_b"]);
            assert!(
                catalog.animations_referencing("bg.anim_scan_a") == vec!["anim.scan".to_owned()],
                "frame images must report the animation that uses them"
            );

            let alli = catalog
                .manifest
                .characters
                .get("alli")
                .expect("showcase character must be registered");
            assert_eq!(alli.default_expression.as_deref(), Some("neutral"));
            assert_eq!(alli.expressions["smug"].asset, "sprite.alli_smug");
            assert_eq!(alli.expressions["smug"].anchor_y, 1.0);

            let bounce = catalog
                .actions
                .get("sprite.bounce")
                .expect("showcase action must be registered");
            assert_eq!(bounce.duration_ms, 600);
            assert!(bounce.channels.contains_key("y"));
            assert!(bounce.channels.contains_key("rotation_deg"));

            let showcase = catalog
                .scenes
                .get("character_action_showcase")
                .expect("role/action showcase scene must be registered");
            assert!(showcase.nodes.values().any(|node| matches!(
                node,
                vectspace_core::model::SceneNode::Action { action, .. }
                    if action == "sprite.bounce"
            )));
            assert!(matches!(
                showcase.nodes.get("alli_show"),
                Some(vectspace_core::model::SceneNode::Sprite {
                    asset: None,
                    character: Some(character),
                    expression: Some(expression),
                    ..
                }) if character == "alli" && expression == "neutral"
            ));
            assert!(showcase.nodes.values().any(|node| matches!(
                node,
                vectspace_core::model::SceneNode::Sprite {
                    asset: Some(asset),
                    ..
                } if asset == "sprite.stopmotion"
            )));

            // The parity fixture is a frozen presentation baseline: the
            // browser entry (npm run parity:check) resolves these exact nodes
            // through the real runtime, so keep their targets and cue shapes
            // from silently drifting.  See docs/scene-surface-migration-baseline.md.
            let parity = catalog
                .scenes
                .get("surface_parity")
                .expect("the presentation parity fixture must be registered");
            assert!(matches!(
                parity.nodes.get("stage_timeline"),
                Some(vectspace_core::model::SceneNode::Timeline {
                    duration_ms: 640,
                    await_completion: true,
                    skippable: true,
                    tracks,
                    events,
                    ..
                }) if tracks.iter().any(|track| matches!(
                    track,
                    vectspace_core::model::TimelineTrack::Sprite { sprite_id, asset: Some(asset), .. }
                        if sprite_id == "alli" && asset == "sprite.alli_neutral"
                )) && tracks.iter().any(|track| matches!(
                    track,
                    vectspace_core::model::TimelineTrack::Camera { .. }
                )) && events.iter().any(|event| matches!(
                    event,
                    vectspace_core::model::TimelineEvent::ScreenEffect {
                        id,
                        at_ms: 320,
                        effect: vectspace_core::model::ScreenEffectKind::Flash,
                        duration_ms: 120,
                    } if id == "parity_flash"
                )) && events.iter().any(|event| matches!(
                    event,
                    vectspace_core::model::TimelineEvent::ScreenEffect {
                        id,
                        at_ms: 320,
                        effect: vectspace_core::model::ScreenEffectKind::Shake,
                        duration_ms: 200,
                    } if id == "parity_shake"
                ))
            ));
            assert!(matches!(
                parity.nodes.get("frames_timeline"),
                Some(vectspace_core::model::SceneNode::Timeline { tracks, .. })
                    if tracks.iter().any(|track| matches!(
                        track,
                        vectspace_core::model::TimelineTrack::Sprite { sprite_id, asset: Some(asset), .. }
                            if sprite_id == "prop" && asset == "sprite.stopmotion"
                    ))
            ));
            // The video fixture keeps a real video track on existing local
            // media; the browser entry asserts nonzero media observations for
            // it instead of silently skipping a target without video.
            assert!(matches!(
                parity.nodes.get("video_timeline"),
                Some(vectspace_core::model::SceneNode::Timeline {
                    duration_ms: 1600,
                    tracks,
                    ..
                }) if tracks.iter().any(|track| matches!(
                    track,
                    vectspace_core::model::TimelineTrack::Video {
                        asset,
                        clip_end_ms: Some(4000),
                        audio_enabled: false,
                        ..
                    } if asset == "video.test"
                ))
            ));
            let stopmotion = catalog
                .resolve_assets(&["sprite.stopmotion".to_owned()])
                .expect("the parity frame animation must resolve");
            let stopmotion = stopmotion[0]
                .animation
                .as_ref()
                .expect("sprite.stopmotion must stay an animation");
            assert!(stopmotion.frames.len() >= 2, "sprite.stopmotion");
            assert!(stopmotion.width > 0 && stopmotion.height > 0);
            // The fixture is deliberately unreachable from the chapter map so
            // it can never leak into the player-facing route.
            if let Some(map) = &catalog.chapter_map {
                assert!(
                    !map.hotspots
                        .iter()
                        .any(|hotspot| hotspot.scene_id == "surface_parity"),
                    "the parity fixture must not become a chapter-map hotspot"
                );
            }
        }
        // Unresolved LFS pointers mean the fixtures were never downloaded.
        Err(error) if error.to_string().contains("Git LFS") => {}
        Err(error) => panic!("game content must validate: {error}"),
    }
}
