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
            assert!(showcase.nodes.values().any(|node| matches!(
                node,
                vectspace_core::model::SceneNode::Sprite {
                    asset: Some(asset),
                    ..
                } if asset == "sprite.stopmotion"
            )));
        }
        // Unresolved LFS pointers mean the fixtures were never downloaded.
        Err(error) if error.to_string().contains("Git LFS") => {}
        Err(error) => panic!("game content must validate: {error}"),
    }
}
