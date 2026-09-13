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
                        effect: vectspace_core::model::ScreenEffectSpec::Flash { .. },
                        duration_ms: 120,
                    } if id == "parity_flash"
                )) && events.iter().any(|event| matches!(
                    event,
                    vectspace_core::model::TimelineEvent::ScreenEffect {
                        id,
                        at_ms: 320,
                        effect: vectspace_core::model::ScreenEffectSpec::Shake { .. },
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
                // The transition lab is the manual acceptance scene for the
                // canonical transition/curtain/effect work; keep it reachable
                // while asserting the whole feature set stays demonstrated.
                assert!(
                    map.hotspots
                        .iter()
                        .any(|hotspot| hotspot.scene_id == "transition_lab"),
                    "the transition lab must stay a chapter-map hotspot"
                );
            }

            use vectspace_core::model::{
                BackgroundTransitionSpec, CurtainAction, CurtainFill, CurtainTransitionSpec,
                ScreenEffectSpec, TransitionDirection,
            };
            let lab = catalog
                .scenes
                .get("transition_lab")
                .expect("the transition lab fixture must be registered");
            let transitions: Vec<&BackgroundTransitionSpec> = lab
                .nodes
                .values()
                .filter_map(|node| match node {
                    vectspace_core::model::SceneNode::Background { transition, .. } => {
                        Some(transition)
                    }
                    _ => None,
                })
                .collect();
            for name in ["cut", "cross_fade", "fade_through_color"] {
                assert!(
                    transitions.iter().any(|transition| matches!(
                        (name, transition),
                        ("cut", BackgroundTransitionSpec::Cut)
                            | ("cross_fade", BackgroundTransitionSpec::CrossFade)
                            | (
                                "fade_through_color",
                                BackgroundTransitionSpec::FadeThroughColor { .. }
                            )
                    )),
                    "transition_lab must demonstrate {name}"
                );
            }
            for (kind, direction) in [
                ("wipe", TransitionDirection::LeftToRight),
                ("wipe", TransitionDirection::RightToLeft),
                ("push", TransitionDirection::TopToBottom),
                ("push", TransitionDirection::BottomToTop),
            ] {
                assert!(
                    transitions.iter().any(|transition| matches!(
                        (kind, transition),
                        ("wipe", BackgroundTransitionSpec::Wipe { direction: found, .. })
                            | ("push", BackgroundTransitionSpec::Push { direction: found, .. })
                            if *found == direction
                    )),
                    "transition_lab must demonstrate {kind} {direction:?}"
                );
            }
            let curtains: Vec<&vectspace_core::model::SceneNode> = lab
                .nodes
                .values()
                .filter(|node| matches!(node, vectspace_core::model::SceneNode::Curtain { .. }))
                .collect();
            assert!(curtains.iter().any(|node| matches!(
                node,
                vectspace_core::model::SceneNode::Curtain {
                    action: CurtainAction::Cover,
                    fill: Some(CurtainFill::Color { .. }),
                    transition: CurtainTransitionSpec::Fade,
                    ..
                }
            )));
            assert!(curtains.iter().any(|node| matches!(
                node,
                vectspace_core::model::SceneNode::Curtain {
                    action: CurtainAction::Cover,
                    fill: Some(CurtainFill::Asset { asset }),
                    ..
                } if asset == "gui.dialogue_box"
            )));
            for direction in [
                TransitionDirection::LeftToRight,
                TransitionDirection::RightToLeft,
                TransitionDirection::TopToBottom,
                TransitionDirection::BottomToTop,
            ] {
                assert!(curtains.iter().any(|node| matches!(
                    node,
                    vectspace_core::model::SceneNode::Curtain {
                        transition: CurtainTransitionSpec::Wipe { direction: found },
                        ..
                    } if *found == direction
                )));
            }
            assert!(curtains.iter().any(|node| matches!(
                node,
                vectspace_core::model::SceneNode::Curtain {
                    action: CurtainAction::Reveal,
                    transition: CurtainTransitionSpec::SplitHorizontal,
                    ..
                }
            )));
            assert!(curtains.iter().any(|node| matches!(
                node,
                vectspace_core::model::SceneNode::Curtain {
                    action: CurtainAction::Cover,
                    transition: CurtainTransitionSpec::SplitVertical,
                    ..
                }
            )));
            let effects: Vec<&ScreenEffectSpec> = lab
                .nodes
                .values()
                .filter_map(|node| match node {
                    vectspace_core::model::SceneNode::ScreenEffect { effect, .. } => Some(effect),
                    _ => None,
                })
                .collect();
            assert!(effects.iter().any(|effect| matches!(
                effect,
                ScreenEffectSpec::Flash { peak_alpha, .. } if (*peak_alpha - 0.55).abs() < f32::EPSILON
            )));
            assert!(effects.iter().any(|effect| matches!(
                effect,
                ScreenEffectSpec::Shake { seed: 42, amplitude_x, .. } if (*amplitude_x - 18.0).abs() < f32::EPSILON
            )));
            let timeline = lab
                .nodes
                .get("effects_timeline")
                .expect("the effects timeline must stay registered");
            let events = match timeline {
                vectspace_core::model::SceneNode::Timeline { events, .. } => events,
                _ => panic!("effects_timeline must stay a timeline"),
            };
            let shake_windows: Vec<(u64, u64, u32)> = events
                .iter()
                .filter_map(|event| match event {
                    vectspace_core::model::TimelineEvent::ScreenEffect {
                        at_ms,
                        effect: ScreenEffectSpec::Shake { seed, .. },
                        duration_ms,
                        ..
                    } => Some((*at_ms, *duration_ms, *seed)),
                    _ => None,
                })
                .collect();
            assert!(
                shake_windows.iter().any(|(at, duration, seed)| {
                    *seed == 42
                        && shake_windows.iter().any(|(later_at, _, later_seed)| {
                            *later_seed != 42 && *later_at > *at && *later_at < at + duration
                        })
                }),
                "transition_lab must keep two overlapping shake windows"
            );
        }
        // Unresolved LFS pointers mean the fixtures were never downloaded.
        Err(error) if error.to_string().contains("Git LFS") => {}
        Err(error) => panic!("game content must validate: {error}"),
    }
}
