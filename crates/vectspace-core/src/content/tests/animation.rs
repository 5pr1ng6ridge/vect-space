use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use tempfile::TempDir;

use crate::content::common::read_yaml;
use crate::content::{ContentCatalog, ContentError};
use crate::model::{
    AssetDefinition, AssetKind, ImageAnimationDefinition, ImageAnimationFrame, UiMotionPreset,
    IMAGE_ANIMATION_MAX_FRAME_MS, IMAGE_ANIMATION_SCHEMA_VERSION,
};
use crate::test_support::{fixture_catalog, fixture_root};

/// Image assets whose bytes live in a staging directory, as the editor stages
/// unsaved imports.  Only a PNG header is written: the validator reads the
/// declared pixel size, never the pixels, which keeps the fixture hermetic and
/// independent of Git LFS.
struct Staged {
    dir: TempDir,
    assets: BTreeMap<String, AssetDefinition>,
    overrides: BTreeMap<String, PathBuf>,
}

fn write_png(path: &std::path::Path, width: u32, height: u32) {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    bytes.extend_from_slice(&13_u32.to_be_bytes());
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn asset(kind: AssetKind, path: Option<&str>, animation: Option<&str>) -> AssetDefinition {
    AssetDefinition {
        kind,
        path: path.map(str::to_owned),
        animation: animation.map(str::to_owned),
    }
}

impl Staged {
    fn new(images: &[(&str, u32, u32)]) -> Self {
        let mut staged = Self {
            dir: tempfile::tempdir().unwrap(),
            assets: BTreeMap::new(),
            overrides: BTreeMap::new(),
        };
        for (id, width, height) in images {
            let relative = format!("gui/{}.png", id.replace('.', "_"));
            let path = staged.dir.path().join(&relative);
            write_png(&path, *width, *height);
            staged.overrides.insert((*id).to_owned(), path);
            staged
                .assets
                .insert((*id).to_owned(), asset(AssetKind::Gui, Some(&relative), None));
        }
        staged
    }

    fn with(mut self, id: &str, definition: AssetDefinition) -> Self {
        self.assets.insert(id.to_owned(), definition);
        self
    }

    /// Builds the fixture project with these assets and animation documents
    /// supplied in memory, the same path the editor uses for an unsaved draft.
    /// `manifest_paths` defaults to the documents' own paths.
    fn build(
        &self,
        manifest_paths: Option<Vec<&str>>,
        documents: Vec<(&str, ImageAnimationDefinition)>,
    ) -> Result<ContentCatalog, ContentError> {
        let root = fixture_root();
        let catalog = fixture_catalog();
        let mut manifest = catalog.manifest.clone();
        // Merge instead of replacing: the fixture scenes keep referencing the
        // project's own static assets.
        manifest.assets.extend(self.assets.clone());
        manifest.animations = manifest_paths
            .unwrap_or_else(|| documents.iter().map(|(path, _)| *path).collect())
            .into_iter()
            .map(str::to_owned)
            .collect();
        let canonical_root = fs::canonicalize(&root).unwrap();
        let ui_motion_files: BTreeMap<String, UiMotionPreset> = manifest
            .ui_motions
            .iter()
            .map(|path| (path.clone(), read_yaml(&canonical_root.join(path)).unwrap()))
            .collect();
        ContentCatalog::from_documents_with_all_documents(
            root,
            manifest,
            catalog.scenes.clone(),
            ui_motion_files,
            catalog.chapter_map.clone(),
            &self.overrides,
            None,
            Some(
                documents
                    .into_iter()
                    .map(|(path, document)| (path.to_owned(), document))
                    .collect(),
            ),
            None,
        )
    }
}

fn animation(id: &str, frames: &[(&str, u64)]) -> ImageAnimationDefinition {
    ImageAnimationDefinition {
        schema_version: IMAGE_ANIMATION_SCHEMA_VERSION,
        id: id.to_owned(),
        frames: frames
            .iter()
            .map(|(asset, duration_ms)| ImageAnimationFrame {
                asset: (*asset).to_owned(),
                duration_ms: *duration_ms,
            })
            .collect(),
    }
}

#[test]
fn image_animation_resolves_frames_and_geometry() {
    let staged = Staged::new(&[("img.idle", 64, 48), ("img.blink", 64, 48)]).with(
        "gui.blinking",
        asset(AssetKind::Gui, None, Some("anim.blinking")),
    );
    let catalog = staged
        .build(
            None,
            vec![(
                "animations/blinking.yaml",
                animation("anim.blinking", &[("img.idle", 400), ("img.blink", 120)]),
            )],
        )
        .expect("animation project must validate");

    let resolved = catalog
        .resolve_assets(&["gui.blinking".to_owned()])
        .unwrap();
    assert_eq!(resolved.len(), 1);
    let animation = resolved[0].animation.as_ref().unwrap();
    assert_eq!(animation.id, "anim.blinking");
    assert_eq!((animation.width, animation.height), (64, 48));
    assert_eq!(animation.total_duration_ms, 520);
    assert_eq!(animation.frames.len(), 2);
    assert_eq!(animation.frames[0].duration_ms, 400);
    assert_eq!(animation.frames[1].asset, "img.blink");
    assert!(animation.frames[0].absolute_path.ends_with("img_idle.png"));
    // The single asset path points at the first frame.
    assert_eq!(resolved[0].absolute_path, animation.frames[0].absolute_path);
    assert_eq!(
        catalog.animations_referencing("img.blink"),
        vec!["anim.blinking".to_owned()]
    );
    assert_eq!(catalog.animations_referencing("img.idle").len(), 1);
    assert!(catalog.animations_referencing("img.unused").is_empty());
}

#[test]
fn animation_reuses_one_decoded_frame_for_repeated_assets() {
    // The same image three times is one decoded frame, so the budget holds.
    // A ping-pong animation is authored exactly this way.
    let catalog = Staged::new(&[("img.big", 8192, 8192)])
        .build(
            None,
            vec![(
                "animations/x.yaml",
                animation("anim.x", &[("img.big", 100), ("img.big", 200), ("img.big", 100)]),
            )],
        )
        .expect("one unique frame stays inside the budget");
    let animation = &catalog.animations["anim.x"];
    assert_eq!(animation.total_duration_ms(), 400);
    assert_eq!(animation.frame_assets().len(), 1);
}

#[test]
fn invalid_animation_projects_are_rejected() {
    let two_frames = || Staged::new(&[("img.a", 32, 32), ("img.b", 32, 32)]);
    let single = |id: &str, frames: &[(&str, u64)]| {
        vec![("animations/x.yaml", animation(id, frames))]
    };
    let cases: Vec<(&str, Result<ContentCatalog, ContentError>, &[&str])> = vec![
        (
            "audio assets must not own image animations",
            Staged::new(&[("img.frame", 32, 32)])
                .with(
                    "bgm.invalid_animation",
                    asset(AssetKind::Bgm, None, Some("anim.invalid_owner")),
                )
                .build(None, single("anim.invalid_owner", &[("img.frame", 100)])),
            &["必须是 background、sprite 或 gui"],
        ),
        (
            "frames of one animation share a pixel size",
            Staged::new(&[("img.a", 64, 48), ("img.b", 64, 49)])
                .build(None, single("anim.mismatch", &[("img.a", 100), ("img.b", 100)])),
            &["尺寸", "不一致"],
        ),
        (
            "unregistered frame asset",
            two_frames().build(None, single("anim.x", &[("img.missing", 100)])),
            &["未登记"],
        ),
        (
            "frame asset is not an image",
            two_frames()
                .with("bgm.loop", asset(AssetKind::Bgm, Some("audio/test_bgm.ogg"), None))
                .build(None, single("anim.x", &[("bgm.loop", 100)])),
            &["不是图片素材"],
        ),
        (
            "frame asset is itself animated",
            two_frames()
                .with("gui.nested", asset(AssetKind::Gui, None, Some("anim.outer")))
                .build(None, single("anim.x", &[("gui.nested", 100)])),
            &["只能引用静态图片"],
        ),
        (
            "an animation cannot contain its own asset",
            two_frames()
                .with("gui.animated", asset(AssetKind::Gui, None, Some("anim.self")))
                .build(None, single("anim.self", &[("gui.animated", 100)])),
            &["只能引用静态图片"],
        ),
        (
            "no frames",
            two_frames().build(None, single("anim.x", &[])),
            &["至少需要一帧"],
        ),
        (
            "zero frame duration",
            two_frames().build(None, single("anim.x", &[("img.a", 0)])),
            &["时长"],
        ),
        (
            "frame duration over the limit",
            two_frames().build(
                None,
                single("anim.x", &[("img.a", IMAGE_ANIMATION_MAX_FRAME_MS + 1)]),
            ),
            &["时长"],
        ),
        (
            "unsupported schema version",
            two_frames().build(
                None,
                vec![(
                    "animations/x.yaml",
                    ImageAnimationDefinition {
                        schema_version: 2,
                        ..animation("anim.x", &[("img.a", 100)])
                    },
                )],
            ),
            &["schema_version"],
        ),
        (
            "document set differs from the manifest list",
            two_frames().build(
                Some(vec!["animations/other.yaml"]),
                vec![("animations/missing.yaml", animation("anim.x", &[("img.a", 100)]))],
            ),
            &["集合与 manifest 不一致"],
        ),
        (
            "animation id collides with an asset id",
            two_frames().build(None, single("img.a", &[("img.a", 100)])),
            &["素材 ID 冲突"],
        ),
        (
            // Two unique 8192x8192 frames decode to 2 x 256 MiB, over the
            // 256 MiB budget; only headers exist, the budget is computed from
            // the declared size.
            "decoded footprint over the budget",
            Staged::new(&[("img.big", 8192, 8192), ("img.big2", 8192, 8192)]).build(
                None,
                single("anim.x", &[("img.big", 100), ("img.big2", 100)]),
            ),
            &["解码内存"],
        ),
        (
            "an asset registers both a path and an animation",
            two_frames()
                .with("gui.both", asset(AssetKind::Gui, Some("gui/a.png"), Some("anim.a")))
                .build(Some(Vec::new()), Vec::new()),
            &["互斥"],
        ),
        (
            "an asset registers neither a path nor an animation",
            Staged::new(&[])
                .with("gui.broken", asset(AssetKind::Gui, None, None))
                .build(Some(Vec::new()), Vec::new()),
            &["必须登记 path 或 animation"],
        ),
    ];
    for (label, result, expected) in cases {
        let error = result.expect_err(label).to_string();
        for fragment in expected {
            assert!(error.contains(fragment), "{label}: {error}");
        }
    }
}
