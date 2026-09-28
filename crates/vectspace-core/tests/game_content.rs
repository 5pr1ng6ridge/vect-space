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
