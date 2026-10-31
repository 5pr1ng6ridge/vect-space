mod proof;
mod animation;
mod documents;
mod effects;
mod scenes;

use std::collections::BTreeMap;

use super::common::read_yaml;
use super::scenes::validate_scenes;
use super::{ContentCatalog, ContentError};
use crate::model::{SceneDefinition, SceneNode, UiMotionPreset};
use crate::test_support::fixture_root;

/// Revalidates `scenes` in place of the fixture's own, the way the editor does
/// for unsaved drafts, so cross-scene rules (jumps, window roles) are covered.
fn rebuild(
    catalog: &ContentCatalog,
    scenes: BTreeMap<String, SceneDefinition>,
) -> Result<ContentCatalog, ContentError> {
    let root = fixture_root();
    let ui_motion_files: BTreeMap<String, UiMotionPreset> = catalog
        .manifest
        .ui_motions
        .iter()
        .map(|path| (path.clone(), read_yaml(&root.join(path)).unwrap()))
        .collect();
    ContentCatalog::from_documents(root, catalog.manifest.clone(), scenes, ui_motion_files)
}

/// The fixture scenes with `node` added to `prologue` under `node_id`.
fn prologue_with_node(
    catalog: &ContentCatalog,
    node_id: &str,
    node: SceneNode,
) -> BTreeMap<String, SceneDefinition> {
    let mut scenes = catalog.scenes.clone();
    scenes
        .get_mut("prologue")
        .unwrap()
        .nodes
        .insert(node_id.to_owned(), node);
    scenes
}

/// Runs only the scene validator against the fixture's other documents.
fn validate_fixture_scenes(
    catalog: &ContentCatalog,
    scenes: &BTreeMap<String, SceneDefinition>,
) -> Result<(), ContentError> {
    validate_scenes(
        scenes,
        &catalog.manifest.assets,
        &catalog.manifest.variables,
        &catalog.manifest.characters,
        &catalog.ui_motions,
        &catalog.buttons,
        &catalog.actions,
        &catalog.proofs,
    )
}

/// Adds `node` to `prologue` and returns the validator's error text.
fn node_error(catalog: &ContentCatalog, node: SceneNode) -> String {
    let scenes = prologue_with_node(catalog, "probe", node);
    validate_fixture_scenes(catalog, &scenes)
        .expect_err("the node must be rejected")
        .to_string()
}

/// Adds `node` to `prologue` and requires the validator to accept it.
fn assert_node_valid(catalog: &ContentCatalog, node: SceneNode) {
    let scenes = prologue_with_node(catalog, "probe", node);
    validate_fixture_scenes(catalog, &scenes).unwrap_or_else(|error| panic!("{error}"));
}
