//! Fixtures shared by the unit tests.
//!
//! Scenes and nodes are written as YAML, the format authors use, instead of
//! struct literals: a node has dozens of optional fields and the tests only
//! care about the few they set.

use std::path::PathBuf;

use serde::de::DeserializeOwned;

use crate::content::ContentCatalog;
use crate::model::{SceneDefinition, SceneNode};

pub(crate) fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/game")
}

pub(crate) fn fixture_catalog() -> ContentCatalog {
    ContentCatalog::from_root(fixture_root()).expect("fixture content must be valid")
}

pub(crate) fn from_yaml<T: DeserializeOwned>(yaml: &str) -> T {
    let options = serde_saphyr::options! { strict_booleans: true };
    serde_saphyr::from_str_with_options(yaml, options).expect("test YAML must parse")
}

pub(crate) fn node(yaml: &str) -> SceneNode {
    from_yaml(yaml)
}

pub(crate) fn scene(yaml: &str) -> SceneDefinition {
    from_yaml(yaml)
}

/// The fixture project with every given scene added (or replaced, by id).
/// The scenes are not validated: runtime tests rely on that to drive nodes
/// the loader would reject.
pub(crate) fn catalog_with_scenes(scenes: &[&str]) -> ContentCatalog {
    let mut catalog = fixture_catalog();
    for yaml in scenes {
        let scene = scene(yaml);
        catalog.scenes.insert(scene.id.clone(), scene);
    }
    catalog
}
