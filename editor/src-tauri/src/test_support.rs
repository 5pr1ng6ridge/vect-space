//! Fixtures shared by the unit tests.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::path::{Path, PathBuf};

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder, Rgb, RgbImage, Rgba, RgbaImage};
use vectspace_core::content::ContentCatalog;
use vectspace_core::model::ContentManifest;

use crate::documents::project_payload;
use crate::fingerprint::project_fingerprint;
use crate::layout::EditorLayout;
use crate::model::SaveProjectRequest;
use crate::state::{EditorState, ProjectSession};
use crate::transaction::{atomic_write_batch, AtomicBatchOutcome};

/// The shipped demo project.
pub(crate) fn demo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../game")
        .canonicalize()
        .unwrap()
}

pub(crate) fn demo_catalog() -> ContentCatalog {
    ContentCatalog::from_root(demo_root()).unwrap()
}

/// An editor state with the demo project open.
pub(crate) fn demo_state() -> EditorState {
    let root = demo_root();
    let catalog = ContentCatalog::from_root(root.clone()).unwrap();
    let fingerprint = project_fingerprint(&root, &catalog.manifest).unwrap();
    let state = EditorState::default();
    state.session.lock().unwrap().replace(ProjectSession {
        root,
        catalog,
        fingerprint,
        document_models: BTreeMap::new(),
    });
    state
}

/// The demo project in the shape the WebView sends back as a project request:
/// the real editor payload without the host-only `root`, `assets` and
/// `diagnostics` fields, so defaults and integer wire values follow the same
/// IPC shape as the production `projectRequest` path.
pub(crate) fn demo_wire_project() -> serde_json::Value {
    let root = demo_root();
    let catalog = ContentCatalog::from_root(root.clone()).unwrap();
    let fingerprint = project_fingerprint(&root, &catalog.manifest).unwrap();
    let payload = project_payload(&root, &catalog, EditorLayout::default(), fingerprint).unwrap();
    let mut project = serde_json::to_value(&payload).unwrap();
    let object = project.as_object_mut().unwrap();
    for host_only in ["root", "assets", "diagnostics", "proofs"] {
        object.remove(host_only);
    }
    let fingerprint = object.remove("fingerprint").unwrap();
    object.insert("expected_fingerprint".to_owned(), fingerprint);
    object.insert("import_tokens".to_owned(), serde_json::json!([]));
    project
}

pub(crate) fn write_test_png(path: &Path, width: u32, height: u32) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let image = RgbaImage::from_pixel(width, height, Rgba([9, 21, 33, 255]));
    PngEncoder::new(File::create(path).unwrap())
        .write_image(image.as_raw(), width, height, ExtendedColorType::Rgba8)
        .unwrap();
}

pub(crate) fn write_test_jpeg(path: &Path, width: u32, height: u32) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let image = RgbImage::from_pixel(width, height, Rgb([9, 21, 33]));
    JpegEncoder::new(File::create(path).unwrap())
        .write_image(image.as_raw(), width, height, ExtendedColorType::Rgb8)
        .unwrap();
}

/// Manifest of the minimal project: one background asset and one scene.
pub(crate) const MINIMAL_MANIFEST_YAML: &str = "schema_version: 2\ncontent_version: test\nentry_scene: main\ndefault_locale: zh-CN\nassets:\n  bg.room:\n    kind: background\n    path: backgrounds/room.png\nscenes:\n  - scenes/main.yaml\n";

const MINIMAL_SCENE_YAML: &str =
    "schema_version: 2\nid: main\nentry: end\nnodes:\n  end:\n    type: end\n";

pub(crate) fn minimal_manifest() -> ContentManifest {
    serde_saphyr::from_str(MINIMAL_MANIFEST_YAML).unwrap()
}

/// Minimal valid project: one real 8×8 background PNG, one scene.
pub(crate) fn seed_asset_project(root: &Path) {
    fs::create_dir_all(root.join("scenes")).unwrap();
    write_test_png(&root.join("assets/backgrounds/room.png"), 8, 8);
    fs::write(root.join("manifest.yaml"), MINIMAL_MANIFEST_YAML).unwrap();
    fs::write(root.join("scenes/main.yaml"), MINIMAL_SCENE_YAML).unwrap();
}

/// Same project plus a two-frame loop animation over `bg.room`.
pub(crate) fn seed_animated_asset_project(root: &Path) {
    fs::create_dir_all(root.join("scenes")).unwrap();
    fs::create_dir_all(root.join("animations")).unwrap();
    write_test_png(&root.join("assets/backgrounds/room.png"), 8, 8);
    write_test_png(&root.join("assets/backgrounds/room2.png"), 8, 8);
    fs::write(
        root.join("manifest.yaml"),
        "schema_version: 2\ncontent_version: test\nentry_scene: main\ndefault_locale: zh-CN\nassets:\n  bg.room:\n    kind: background\n    path: backgrounds/room.png\n  bg.room2:\n    kind: background\n    path: backgrounds/room2.png\n  anim.blink:\n    kind: background\n    animation: blink\nscenes:\n  - scenes/main.yaml\nanimations:\n  - animations/blink.yaml\n",
    )
    .unwrap();
    fs::write(root.join("scenes/main.yaml"), MINIMAL_SCENE_YAML).unwrap();
    fs::write(
        root.join("animations/blink.yaml"),
        "schema_version: 1\nid: blink\nframes:\n  - asset: bg.room\n    duration_ms: 100\n  - asset: bg.room2\n    duration_ms: 100\n",
    )
    .unwrap();
}

/// A session over the project seeded at `root`.
pub(crate) fn asset_session(root: &Path) -> ProjectSession {
    let root = root.canonicalize().unwrap();
    ProjectSession {
        catalog: ContentCatalog::from_root(root.clone()).unwrap(),
        root,
        fingerprint: String::new(),
        document_models: BTreeMap::new(),
    }
}

/// A save request that re-points `bg.room` at `asset_path` and submits the
/// token `import-1`.
pub(crate) fn replacement_save_request(
    session: &ProjectSession,
    asset_path: &str,
) -> SaveProjectRequest {
    let mut manifest = session.catalog.manifest.clone();
    manifest.assets.get_mut("bg.room").unwrap().path = Some(asset_path.to_owned());
    SaveProjectRequest {
        manifest,
        scenes: Vec::new(),
        ui_motions: Vec::new(),
        buttons: Vec::new(),
        animations: Vec::new(),
        actions: Vec::new(),
        text_blocks: Vec::new(),
        particles: Vec::new(),
        chapter_map: None,
        layout: EditorLayout::default(),
        expected_fingerprint: session.fingerprint.clone(),
        import_tokens: vec!["import-1".to_owned()],
    }
}

/// Publish documents and deletions through the journal with no staged binaries.
pub(crate) fn write_batch(
    root: &Path,
    writes: &[(PathBuf, Vec<u8>)],
    deletes: &[PathBuf],
) -> AtomicBatchOutcome {
    atomic_write_batch(root, writes, &[], &BTreeMap::new(), deletes).unwrap()
}
