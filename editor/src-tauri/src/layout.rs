//! The editor-only layout file (`.vectspace/layout-v1.json`): node positions,
//! rigid groups, pinned text blocks and the virtual asset folders.  It is never
//! part of the game content, and a damaged one is repaired rather than rejected.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use vectspace_core::model::VariableMap;

use crate::assets::valid_asset_registration_id;
use crate::error::display_error;

pub(crate) const LAYOUT_RELATIVE_PATH: &str = ".vectspace/layout-v1.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EditorLayout {
    pub(crate) version: u32,
    #[serde(default)]
    pub(crate) scenes: BTreeMap<String, SceneLayout>,
    #[serde(default)]
    pub(crate) timeline_previews: BTreeMap<String, TimelinePreviewSettings>,
    /// Editor-only virtual asset folders.  Folder ids are stable, independent
    /// of physical asset paths, and are never written into the manifest.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    asset_folders: BTreeMap<String, AssetFolderLayout>,
    /// Editor-only per-asset metadata (virtual folder, display name, hidden).
    /// Asset ids stay the manifest keys, so a removal never invalidates the
    /// rest of the file.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    asset_metadata: BTreeMap<String, AssetLayoutMetadata>,
}

impl Default for EditorLayout {
    fn default() -> Self {
        Self {
            version: 1,
            scenes: BTreeMap::new(),
            timeline_previews: BTreeMap::new(),
            asset_folders: BTreeMap::new(),
            asset_metadata: BTreeMap::new(),
        }
    }
}

/// One editor-only virtual folder.  `parent_id: None` is a root folder.
/// Moving a folder only rewrites this parent link; no asset file ever moves.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AssetFolderLayout {
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    name: String,
    /// Deterministic sibling ordering.  Ties fall back to the folder id.
    #[serde(default)]
    order: i64,
}

/// Editor-only metadata for one existing asset id.  Every field is optional so
/// an untouched asset stays absent from the persisted file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AssetLayoutMetadata {
    #[serde(default)]
    folder_id: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    hidden: bool,
}

const MAX_ASSET_FOLDER_NAME_CHARS: usize = 120;
const MAX_ASSET_FOLDER_DEPTH: usize = 32;

/// Folder ids share the editable-identifier contract used by assets.
fn valid_asset_folder_id(value: &str) -> bool {
    valid_asset_registration_id(value)
}

fn valid_asset_folder_name(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() <= MAX_ASSET_FOLDER_NAME_CHARS
        && !trimmed.chars().any(char::is_control)
}

/// A link is safe when its parent exists and the parent chain terminates at a
/// root within the depth budget.  A self-parent or a cycle fails here.
fn folder_reaches_root(links: &BTreeMap<String, Option<String>>, start: &str) -> bool {
    let mut seen = BTreeSet::new();
    let mut current = start.to_owned();
    for _ in 0..MAX_ASSET_FOLDER_DEPTH {
        if !seen.insert(current.clone()) {
            return false;
        }
        match links.get(&current) {
            None | Some(None) => return true,
            Some(Some(parent)) => current = parent.clone(),
        }
    }
    false
}

/// Make a persisted layout safe to consume without ever rejecting the project.
/// Invalid folder ids/names are dropped, dangling and cyclic parents detach to
/// a root folder, and folder references to a removed folder are cleared.
/// Metadata for a missing asset is kept: an asset can be restored, and an old
/// layout must keep loading after an asset was removed.
fn normalize_asset_layout(layout: &mut EditorLayout) {
    let mut valid_ids = BTreeSet::new();
    for (id, folder) in &layout.asset_folders {
        if valid_asset_folder_id(id) && valid_asset_folder_name(&folder.name) {
            valid_ids.insert(id.clone());
        }
    }
    layout.asset_folders.retain(|id, _| valid_ids.contains(id));
    let links = layout
        .asset_folders
        .iter()
        .map(|(id, folder)| (id.clone(), folder.parent_id.clone()))
        .collect::<BTreeMap<_, _>>();
    for (id, folder) in layout.asset_folders.iter_mut() {
        let parent_ok = folder.parent_id.as_deref().is_some_and(|parent| {
            parent != id && valid_ids.contains(parent) && folder_reaches_root(&links, parent)
        });
        if !parent_ok {
            folder.parent_id = None;
        }
    }
    layout.asset_metadata.retain(|_, metadata| {
        metadata.folder_id.is_some() || metadata.display_name.is_some() || metadata.hidden
    });
    for metadata in layout.asset_metadata.values_mut() {
        if let Some(folder_id) = metadata.folder_id.clone() {
            if !valid_ids.contains(&folder_id) {
                metadata.folder_id = None;
            }
        }
        if let Some(display_name) = metadata.display_name.clone() {
            let trimmed = display_name.trim();
            metadata.display_name = if valid_asset_folder_name(trimmed) {
                Some(trimmed.to_owned())
            } else {
                None
            };
        }
    }
}

const GROUP_ID_PREFIX: &str = "group-";

/// Give every group a stable, unique id: a stored id is kept unless it is
/// empty or a duplicate, which get a fresh `group-N` id instead.  Mirrors the
/// editor's `parseSceneGroups`.
fn assign_unique_group_ids(groups: Vec<SceneGroup>) -> Vec<SceneGroup> {
    let mut claimed: BTreeSet<String> = groups
        .iter()
        .filter(|group| !group.id.is_empty())
        .map(|group| group.id.clone())
        .collect();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut auto = 0usize;
    groups
        .into_iter()
        .map(|mut group| {
            if group.id.is_empty() || !seen.insert(group.id.clone()) {
                group.id = loop {
                    let id = format!("{GROUP_ID_PREFIX}{auto}");
                    auto += 1;
                    if claimed.insert(id.clone()) {
                        break id;
                    }
                };
            }
            group
        })
        .collect()
}

/// Drop un-ownable references: duplicate members within a group and any node or
/// group a previous group already owns.  Self-parents and unknown group ids are
/// dropped too.  Returns whether anything changed.
fn prune_scene_groups(groups: &mut [SceneGroup]) -> bool {
    let ids: BTreeSet<String> = groups.iter().map(|group| group.id.clone()).collect();
    let mut owned_nodes: BTreeSet<String> = BTreeSet::new();
    let mut owned_groups: BTreeSet<String> = BTreeSet::new();
    let mut changed = false;
    for group in groups.iter_mut() {
        let own_id = group.id.clone();
        let children = std::mem::take(&mut group.children);
        let mut kept: Vec<GroupChildRef> = Vec::with_capacity(children.len());
        for child in children {
            match child {
                GroupChildRef::Node { node } => {
                    if owned_nodes.insert(node.clone()) {
                        kept.push(GroupChildRef::Node { node });
                    } else {
                        changed = true;
                    }
                }
                GroupChildRef::Group { group: child_id } => {
                    if child_id != own_id
                        && ids.contains(&child_id)
                        && owned_groups.insert(child_id.clone())
                    {
                        kept.push(GroupChildRef::Group { group: child_id });
                    } else {
                        changed = true;
                    }
                }
            }
        }
        group.children = kept;
    }
    changed
}

/// Remove one reference that closes a group containment cycle.  Ownership
/// already limits every group to a single parent, so each cycle is a simple
/// loop; dropping the parent link of a group on the loop makes it a root.
fn break_scene_group_cycles(groups: &mut [SceneGroup]) -> bool {
    let index_of: BTreeMap<String, usize> = groups
        .iter()
        .enumerate()
        .map(|(index, group)| (group.id.clone(), index))
        .collect();
    let mut parent_of: BTreeMap<String, String> = BTreeMap::new();
    for group in groups.iter() {
        for child in &group.children {
            if let GroupChildRef::Group { group: child_id } = child {
                parent_of.insert(child_id.clone(), group.id.clone());
            }
        }
    }
    let mut hit: Option<(usize, String)> = None;
    for group in groups.iter() {
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut cursor: Option<String> = Some(group.id.clone());
        while let Some(current) = cursor {
            if !seen.insert(current.clone()) {
                if let Some(parent) = parent_of.get(&current) {
                    if let Some(&index) = index_of.get(parent) {
                        hit = Some((index, current));
                    }
                }
                break;
            }
            cursor = parent_of.get(&current).cloned();
        }
        if hit.is_some() {
            break;
        }
    }
    match hit {
        Some((index, member)) => {
            groups[index].children.retain(
                |child| !matches!(child, GroupChildRef::Group { group } if group == &member),
            );
            true
        }
        None => false,
    }
}

/// Enforce the nested-forest invariants to a fixed point: unique ownership and
/// acyclic containment, then collapse any group left with fewer than two
/// children.  A `0`-child group is removed; a `1`-child group is dissolved in
/// place and its single child promoted into its slot.  Mirrors the editor's
/// `repairSceneGroups`.
fn repair_scene_groups(mut groups: Vec<SceneGroup>) -> Vec<SceneGroup> {
    loop {
        let mut changed = prune_scene_groups(&mut groups);
        changed = break_scene_group_cycles(&mut groups) || changed;
        if changed {
            continue;
        }
        match groups.iter().position(|group| group.children.len() < 2) {
            Some(index) => {
                let removed = groups.remove(index);
                if removed.children.len() == 1 {
                    let child = removed.children[0].clone();
                    for other in groups.iter_mut() {
                        for reference in other.children.iter_mut() {
                            if let GroupChildRef::Group { group } = reference {
                                if group == &removed.id {
                                    *reference = child.clone();
                                }
                            }
                        }
                    }
                }
            }
            None => break,
        }
    }
    groups
}

/// Repair persisted groups to unique ids, unique ownership and acyclic
/// containment.  Editor-only, so a hand-edited layout still loads without
/// rejecting the project.
fn normalize_scene_groups(layout: &mut EditorLayout) {
    for scene in layout.scenes.values_mut() {
        let groups = std::mem::take(&mut scene.groups);
        scene.groups = repair_scene_groups(assign_unique_group_ids(groups));
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TimelinePreviewSettings {
    #[serde(default)]
    variable_overrides: VariableMap,
    #[serde(default)]
    choices: Vec<PreviewChoiceDecision>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PreviewChoiceDecision {
    pub(crate) scene_id: String,
    pub(crate) node_id: String,
    pub(crate) visit: usize,
    pub(crate) choice_id: String,
}

/// One editor-only rigid group.  Ownership lives solely in `children`; `id` is
/// stable and independent of node names, so a rename never reassigns a group.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SceneGroup {
    id: String,
    #[serde(default)]
    children: Vec<GroupChildRef>,
}

/// A persisted group member: a scene node or a nested child group.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
enum GroupChildRef {
    Node { node: String },
    Group { group: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SceneLayout {
    #[serde(default)]
    nodes: BTreeMap<String, NodePosition>,
    #[serde(default)]
    viewport: Option<EditorViewport>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    groups: Vec<SceneGroup>,
    /// Editor-only: fixed text block ids filed under this scene before any
    /// Sprite uses them.  Never reaches the runtime registry or text YAML; an
    /// empty list is omitted so an old layout stays byte-identical.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) text_block_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NodePosition {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorViewport {
    x: f64,
    y: f64,
    zoom: f64,
}

pub(crate) fn read_layout(root: &Path) -> Result<EditorLayout, String> {
    let path = root.join(LAYOUT_RELATIVE_PATH);
    if !path.exists() {
        return Ok(EditorLayout::default());
    }
    let bytes = fs::read(&path).map_err(display_error)?;
    let mut layout: EditorLayout = serde_json::from_slice(&bytes).map_err(display_error)?;
    if layout.version != 1 {
        return Err(format!("不支持编辑器布局版本 {}", layout.version));
    }
    // A hand-edited or half-written layout must not make the whole project
    // unopenable; repair the editor-only asset metadata instead.
    normalize_asset_layout(&mut layout);
    normalize_scene_groups(&mut layout);
    Ok(layout)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(id: &str, children: Vec<GroupChildRef>) -> SceneGroup {
        SceneGroup {
            id: id.to_owned(),
            children,
        }
    }

    fn node(id: &str) -> GroupChildRef {
        GroupChildRef::Node {
            node: id.to_owned(),
        }
    }

    fn nested(id: &str) -> GroupChildRef {
        GroupChildRef::Group {
            group: id.to_owned(),
        }
    }

    fn scene_with_groups(groups: Vec<SceneGroup>) -> EditorLayout {
        let mut layout = EditorLayout::default();
        layout.scenes.entry("main".to_owned()).or_default().groups = groups;
        layout
    }

    fn write_layout(root: &Path, bytes: impl AsRef<[u8]>) {
        fs::create_dir_all(root.join(".vectspace")).unwrap();
        fs::write(root.join(LAYOUT_RELATIVE_PATH), bytes).unwrap();
    }

    #[test]
    fn layout_file_keeps_old_layouts_minimal_and_round_trips_editor_only_fields() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();

        // A layout written before the editor-only fields existed loads and is
        // written back byte-minimal.
        write_layout(
            root,
            br#"{"version":1,"scenes":{"main":{"nodes":{},"viewport":null}}}"#,
        );
        let old = read_layout(root).unwrap();
        assert!(old.scenes.contains_key("main"));
        let untouched = serde_json::to_string(&old).unwrap();
        for field in [
            "asset_folders",
            "asset_metadata",
            "groups",
            "text_block_ids",
        ] {
            assert!(!untouched.contains(field), "{untouched}");
        }

        // Nested groups, pinned text blocks and asset organisation survive a
        // round trip through the file in order.
        let mut layout = scene_with_groups(vec![
            group("group-0", vec![node("a"), nested("group-1")]),
            group("group-1", vec![node("b"), node("c")]),
        ]);
        layout.scenes.get_mut("main").unwrap().text_block_ids =
            vec!["intro.title".to_owned(), "label".to_owned()];
        layout.asset_folders.insert(
            "bg.root".to_owned(),
            AssetFolderLayout {
                parent_id: None,
                name: "背景".to_owned(),
                order: 0,
            },
        );
        layout.asset_metadata.insert(
            "bg.room".to_owned(),
            AssetLayoutMetadata {
                folder_id: Some("bg.root".to_owned()),
                display_name: Some("客厅".to_owned()),
                hidden: true,
            },
        );
        write_layout(root, serde_json::to_vec(&layout).unwrap());
        let reopened = read_layout(root).unwrap();
        assert_eq!(reopened.scenes["main"].groups, layout.scenes["main"].groups);
        assert_eq!(
            reopened.scenes["main"].text_block_ids,
            ["intro.title", "label"]
        );
        assert_eq!(reopened.asset_folders["bg.root"].name, "背景");
        let metadata = &reopened.asset_metadata["bg.room"];
        assert_eq!(metadata.display_name.as_deref(), Some("客厅"));
        assert!(metadata.hidden);

        // The scene entry stays strict, and a missing file keeps the default.
        write_layout(
            root,
            br#"{"version":1,"scenes":{"main":{"nodes":{},"viewport":null,"text_blocks":[]}}}"#,
        );
        assert!(read_layout(root).is_err());
        assert_eq!(
            read_layout(&root.join("missing")).unwrap().version,
            EditorLayout::default().version
        );
    }

    #[test]
    fn group_normalization_repairs_persisted_groups() {
        let cases = [
            (
                "ownership and cycles",
                vec![
                    group("g1", vec![node("a"), node("b"), nested("g2")]),
                    group("g2", vec![node("c"), node("d"), nested("g1")]),
                ],
                vec![
                    group("g1", vec![node("a"), node("b"), nested("g2")]),
                    group("g2", vec![node("c"), node("d")]),
                ],
            ),
            (
                "duplicate members and self-parents",
                vec![
                    group("g1", vec![node("a"), node("b")]),
                    group("g2", vec![node("b"), node("c"), node("d"), nested("g2")]),
                ],
                vec![
                    group("g1", vec![node("a"), node("b")]),
                    group("g2", vec![node("c"), node("d")]),
                ],
            ),
            (
                "unary groups promote their child",
                vec![
                    group("parent", vec![nested("child"), node("d")]),
                    group("child", vec![node("e")]),
                ],
                vec![group("parent", vec![node("e"), node("d")])],
            ),
            (
                "empty ids never reuse a stored id",
                vec![
                    group("group-0", vec![node("a"), node("b")]),
                    group("", vec![node("c"), node("d")]),
                ],
                vec![
                    group("group-0", vec![node("a"), node("b")]),
                    group("group-1", vec![node("c"), node("d")]),
                ],
            ),
        ];
        for (name, input, expected) in cases {
            let mut layout = scene_with_groups(input);
            normalize_scene_groups(&mut layout);
            assert_eq!(layout.scenes["main"].groups, expected, "{name}");
        }
    }

    #[test]
    fn asset_layout_normalization_repairs_folders_and_keeps_orphan_metadata() {
        let folder = |parent: Option<&str>, name: &str, order| AssetFolderLayout {
            parent_id: parent.map(str::to_owned),
            name: name.to_owned(),
            order,
        };
        let mut layout = EditorLayout::default();
        for (id, entry) in [
            ("a", folder(Some("b"), "A", 0)),
            ("b", folder(Some("a"), "B", 0)),
            ("dangling", folder(Some("missing"), "D", 1)),
            ("bad id", folder(None, "X", 2)),
            ("noname", folder(None, "   ", 3)),
        ] {
            layout.asset_folders.insert(id.to_owned(), entry);
        }
        layout.asset_metadata.insert(
            "bg.gone".to_owned(),
            AssetLayoutMetadata {
                folder_id: Some("missing_folder".to_owned()),
                display_name: Some("  旧图  ".to_owned()),
                hidden: true,
            },
        );
        layout.asset_metadata.insert(
            "bg.kept".to_owned(),
            AssetLayoutMetadata {
                folder_id: Some("a".to_owned()),
                display_name: None,
                hidden: false,
            },
        );
        layout
            .asset_metadata
            .insert("bg.empty".to_owned(), AssetLayoutMetadata::default());
        normalize_asset_layout(&mut layout);

        // Cyclic and dangling parents detach to roots; invalid folders vanish.
        assert_eq!(layout.asset_folders["a"].parent_id, None);
        assert_eq!(layout.asset_folders["b"].parent_id, None);
        assert_eq!(layout.asset_folders["dangling"].parent_id, None);
        assert!(!layout.asset_folders.contains_key("bad id"));
        assert!(!layout.asset_folders.contains_key("noname"));
        // A removed asset keeps its metadata, but a link to an unknown folder
        // is cleared while a live folder link survives.
        let gone = &layout.asset_metadata["bg.gone"];
        assert_eq!(gone.display_name.as_deref(), Some("旧图"));
        assert!(gone.folder_id.is_none());
        assert!(gone.hidden);
        assert_eq!(
            layout.asset_metadata["bg.kept"].folder_id.as_deref(),
            Some("a")
        );
        assert!(!layout.asset_metadata.contains_key("bg.empty"));
    }
}
