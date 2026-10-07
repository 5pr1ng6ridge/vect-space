//! Validates the repository's real `game/` project through the content model.
//!
//! Binary assets are Git LFS tracked, so a checkout without `git lfs pull`
//! only has pointer text; the content model deliberately rejects unresolved
//! pointers, and this test then skips instead of reporting a content bug that
//! is really a missing `git lfs pull`.

use std::path::{Path, PathBuf};

use vectspace_core::content::ContentCatalog;

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn repository_game_project_validates_including_animations() {
    let root = repository_root().join("game");
    if !root.join("manifest.yaml").is_file() {
        return;
    }
    let catalog = match ContentCatalog::from_root(root) {
        Ok(catalog) => catalog,
        // Unresolved LFS pointers mean the fixtures were never downloaded.
        Err(error) if error.to_string().contains("Git LFS") => return,
        Err(error) => panic!("game content must validate: {error}"),
    };

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
    assert_eq!(
        catalog.animations_referencing("bg.anim_scan_a"),
        vec!["anim.scan".to_owned()],
        "frame images must report the animation that uses them"
    );

    // Every browser parity target (npm run parity:check) must still name a
    // real node, and the parity fixture must never leak into the player-facing
    // chapter map.
    let targets: serde_json::Value = serde_json::from_slice(
        &std::fs::read(repository_root().join("parity/targets.json"))
            .expect("parity targets must be readable"),
    )
    .expect("parity targets must be JSON");
    for target in targets["targets"].as_array().expect("targets array") {
        let scene_id = target["scene_id"].as_str().expect("scene_id");
        let node_id = target["node_id"].as_str().expect("node_id");
        assert!(
            catalog
                .scenes
                .get(scene_id)
                .is_some_and(|scene| scene.nodes.contains_key(node_id)),
            "parity target {scene_id}/{node_id} must exist"
        );
    }
    if let Some(map) = &catalog.chapter_map {
        assert!(
            !map.hotspots
                .iter()
                .any(|hotspot| hotspot.scene_id == "surface_parity"),
            "the parity fixture must not become a chapter-map hotspot"
        );
    }
}

/// Plays the unified-visual showcase through the real runtime: persistent
/// emitters are saved world state, bursts are cues only, and the text block is
/// an ordinary Sprite source.
#[test]
fn visual_showcase_plays_through_unified_sprites_and_particles() {
    use vectspace_core::model::{
        AdvanceSource, PresentationCueKind, PresentationOutcome, PromptSnapshot,
    };
    use vectspace_core::runtime::RuntimeEngine;
    use vectspace_core::visual::{CoordinateSpace, SpriteSource};

    let root = repository_root().join("game");
    if !root.join("manifest.yaml").is_file() {
        return;
    }
    let catalog = match ContentCatalog::from_root(root) {
        Ok(catalog) => catalog,
        Err(error) if error.to_string().contains("Git LFS") => return,
        Err(error) => panic!("game content must validate: {error}"),
    };
    let mut runtime = RuntimeEngine::new(&catalog).unwrap();
    let mut update = runtime
        .start_scene_preview(&catalog, "visual_showcase")
        .unwrap();
    let (mut snow, mut burst, mut text, mut screen_ui) = (false, false, false, false);
    for _ in 0..64 {
        let world = &update.snapshot.world;
        snow |= world.emitters.contains_key("snow");
        assert!(!world.emitters.contains_key("spark"), "bursts are never saved");
        text |= world.sprites.get("formula").is_some_and(|sprite| {
            matches!(&sprite.source, SpriteSource::Text { text_block } if text_block == "text.formula_card")
        });
        screen_ui |= world
            .sprites
            .get("badge")
            .is_some_and(|sprite| sprite.space == CoordinateSpace::Screen);
        burst |= update.cues.iter().any(|cue| {
            matches!(&cue.kind, PresentationCueKind::ParticleState { emitter_id, burst: true, .. } if emitter_id == "spark")
        });
        if update.requires_ack {
            update = runtime
                .presentation_complete(&catalog, update.update_id, PresentationOutcome::Completed)
                .unwrap();
        } else if matches!(update.snapshot.prompt, PromptSnapshot::Dialogue { .. }) {
            update = runtime
                .advance(&catalog, update.snapshot.revision, AdvanceSource::Manual)
                .unwrap();
        } else {
            break;
        }
    }
    assert!(snow && burst && text && screen_ui, "{snow} {burst} {text} {screen_ui}");
    assert_eq!(update.snapshot.location.node_id, "end");
    assert!(update.snapshot.world.emitters.is_empty());
    assert!(update.snapshot.world.sprites.is_empty());
}
