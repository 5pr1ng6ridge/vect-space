//! Editor-side project diagnostics: unreachable nodes, unused assets and
//! immediate (never-yielding) loops.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use vectspace_core::content::ContentCatalog;
use vectspace_core::interaction::TimerAction;
use vectspace_core::model::{
    ChapterMapReplay, ChapterMapReveal, ContentManifest, CurtainFill, SceneNode, TimelineEvent,
    TimelineTrack,
};
use vectspace_core::visual::SpriteSource;

use crate::model::{DiagnosticSeverity, EditorDiagnostic};

pub(crate) fn analyze_catalog(catalog: &ContentCatalog) -> Vec<EditorDiagnostic> {
    if !catalog.scenes.contains_key(&catalog.manifest.entry_scene) {
        return Vec::new();
    }
    let mut diagnostics = unreachable_node_diagnostics(catalog);
    diagnostics.extend(unused_asset_diagnostics(catalog));
    diagnostics.extend(find_immediate_cycles(catalog));
    diagnostics
}

fn unreachable_node_diagnostics(catalog: &ContentCatalog) -> Vec<EditorDiagnostic> {
    let Some(entry_scene) = catalog.scenes.get(&catalog.manifest.entry_scene) else {
        return Vec::new();
    };
    let mut reachable = BTreeSet::new();
    let mut queue = VecDeque::from([(entry_scene.id.clone(), entry_scene.entry.clone())]);
    // A chapter that is both unconditionally visible and unconditionally
    // replayable is a second, author-declared entry point.  It is intentionally
    // allowed to be disconnected from the main story graph, so analysing only
    // `manifest.entry_scene` produces a false unreachable warning for every
    // node in that chapter.
    if let Some(map) = &catalog.chapter_map {
        for hotspot in &map.hotspots {
            if !matches!(hotspot.reveal, ChapterMapReveal::Always)
                || !matches!(hotspot.replay, ChapterMapReplay::Always)
            {
                continue;
            }
            if let Some(scene) = catalog.scenes.get(&hotspot.scene_id) {
                queue.push_back((scene.id.clone(), scene.entry.clone()));
            }
        }
    }
    // Effect-only targets are reachable but not flow sources.
    let mut effect_reachable = BTreeSet::new();
    while let Some((scene_id, node_id)) = queue.pop_front() {
        if !reachable.insert((scene_id.clone(), node_id.clone())) {
            continue;
        }
        let Some(scene) = catalog.scenes.get(&scene_id) else {
            continue;
        };
        let Some(node) = scene.nodes.get(&node_id) else {
            continue;
        };
        queue.extend(successors(&scene_id, node));
        // Keep flow successors unchanged for immediate-cycle detection. The
        // secondary window independently enters its scene alongside `next`.
        if let SceneNode::OpenWindow { scene: target, .. } = node {
            if let Some(window_scene) = catalog.scenes.get(target) {
                queue.push_back((window_scene.id.clone(), window_scene.entry.clone()));
            }
        }
        // A timer's effect node runs on its own; its successors do not follow.
        if let Some(effect) = effect_references(node) {
            if scene.nodes.contains_key(effect) {
                effect_reachable.insert((scene_id.clone(), effect.to_owned()));
            }
        }
    }

    let mut diagnostics = Vec::new();
    for (scene_id, scene) in &catalog.scenes {
        for node_id in scene.nodes.keys() {
            let key = (scene_id.clone(), node_id.clone());
            if !reachable.contains(&key) && !effect_reachable.contains(&key) {
                diagnostics.push(EditorDiagnostic {
                    severity: DiagnosticSeverity::Warning,
                    code: "unreachable_node".to_owned(),
                    message: "节点无法从项目入口到达".to_owned(),
                    scene_id: Some(scene_id.clone()),
                    node_id: Some(node_id.clone()),
                });
            }
        }
    }
    diagnostics
}

fn unused_asset_diagnostics(catalog: &ContentCatalog) -> Vec<EditorDiagnostic> {
    let mut referenced_assets = BTreeSet::new();
    for scene in catalog.scenes.values() {
        for node in scene.nodes.values() {
            collect_node_assets(node, &mut referenced_assets);
        }
    }
    // Asset usage is not limited to story nodes.  Keep the editor's unused
    // asset diagnostics in lockstep with the authoritative content model so
    // a map background, chapter artwork, the shared font, or an implicit UI
    // asset is not incorrectly reported as unused (and therefore offered for
    // deletion) just because it lives outside a SceneDefinition.
    collect_manifest_assets(&catalog.manifest, &mut referenced_assets);
    for template in catalog.buttons.values() {
        for asset in [&template.normal, &template.hover, &template.pressed]
            .into_iter()
            .flatten()
        {
            referenced_assets.insert(asset.clone());
        }
    }
    for text in catalog.text_blocks.values() {
        if let Some(font) = &text.font {
            referenced_assets.insert(font.clone());
        }
    }
    for particle in catalog.particles.values() {
        referenced_assets.insert(particle.image.clone());
    }
    for implicit in ["gui.dialogue_box", "gui.name_box", "sfx.typing"] {
        if catalog.manifest.assets.contains_key(implicit) {
            referenced_assets.insert(implicit.to_owned());
        }
    }
    if let Some(map) = &catalog.chapter_map {
        if let Some(background) = &map.background {
            referenced_assets.insert(background.clone());
        }
        for decoration in &map.decorations {
            referenced_assets.insert(decoration.asset.clone());
        }
        for hotspot in &map.hotspots {
            if let Some(asset) = &hotspot.asset {
                referenced_assets.insert(asset.clone());
            }
        }
    }
    catalog
        .manifest
        .assets
        .keys()
        .filter(|id| !referenced_assets.contains(*id))
        .map(|id| EditorDiagnostic {
            severity: DiagnosticSeverity::Info,
            code: "unused_asset".to_owned(),
            message: format!("素材 {id} 尚未被剧情节点引用"),
            scene_id: None,
            node_id: None,
        })
        .collect()
}

fn successors(scene_id: &str, node: &SceneNode) -> Vec<(String, String)> {
    let local = |target: &str| (scene_id.to_owned(), target.to_owned());
    match node {
        SceneNode::Background { next, .. }
        | SceneNode::Sprite { next, .. }
        | SceneNode::Particle { next, .. }
        | SceneNode::Clear { next, .. }
        | SceneNode::Say { next, .. }
        | SceneNode::LongText { next, .. }
        | SceneNode::LongTextControl { next, .. }
        | SceneNode::Set { next, .. }
        | SceneNode::Playback { next, .. }
        | SceneNode::Action { next, .. }
        | SceneNode::Wait { next, .. }
        | SceneNode::Bgm { next, .. }
        | SceneNode::Ambience { next, .. }
        | SceneNode::Sfx { next, .. }
        | SceneNode::Camera { next, .. }
        | SceneNode::ScreenEffect { next, .. }
        | SceneNode::Curtain { next, .. }
        | SceneNode::DialogueUi { next, .. }
        | SceneNode::UiMotionSet { next, .. }
        | SceneNode::UiMotionPlay { next, .. }
        | SceneNode::ButtonCreate { next, .. }
        | SceneNode::ButtonUpdate { next, .. }
        | SceneNode::ButtonRemove { next, .. }
        | SceneNode::WindowTitle { next, .. }
        | SceneNode::WindowControl { next, .. }
        | SceneNode::WindowGeometry { next, .. }
        | SceneNode::WindowLayer { next, .. }
        // A timer's effect target is a reference (see `effect_references`),
        // not a flow successor: only `next` continues the story.
        | SceneNode::Timer { next, .. }
        | SceneNode::Timeline { next, .. } => vec![local(next)],
        // A non-blocking host request: control continues to `next` in the same
        // Scene. The named window Scene is a reference, not a flow successor.
        SceneNode::OpenWindow { next, .. } => vec![local(next)],
        SceneNode::Proof { next, abandon, .. } => {
            std::iter::once(next).chain(abandon.iter()).map(|target| local(target)).collect()
        }
        SceneNode::Choice { choices, .. } => {
            choices.iter().map(|choice| local(&choice.next)).collect()
        }
        SceneNode::Condition {
            then, otherwise, ..
        } => vec![local(then), local(otherwise)],
        SceneNode::Jump { scene, target } => {
            vec![(
                scene.as_deref().unwrap_or(scene_id).to_owned(),
                target.clone(),
            )]
        }
        SceneNode::End => Vec::new(),
    }
}

fn is_immediate(node: &SceneNode) -> bool {
    match node {
        SceneNode::Say { .. }
        | SceneNode::LongText { .. }
        | SceneNode::Choice { .. }
        | SceneNode::Proof { .. }
        | SceneNode::Wait { .. }
        | SceneNode::End => false,
        SceneNode::Background {
            await_completion, ..
        }
        | SceneNode::Sprite {
            await_completion, ..
        }
        | SceneNode::Clear {
            await_completion, ..
        }
        | SceneNode::Bgm {
            await_completion, ..
        }
        | SceneNode::Ambience {
            await_completion, ..
        }
        | SceneNode::Camera {
            await_completion, ..
        }
        | SceneNode::ScreenEffect {
            await_completion, ..
        }
        | SceneNode::Curtain {
            await_completion, ..
        }
        | SceneNode::DialogueUi {
            await_completion, ..
        }
        | SceneNode::UiMotionPlay {
            await_completion, ..
        }
        | SceneNode::Timeline {
            await_completion, ..
        } => !await_completion,
        // Only a real wait holds the story back: an unawaited or zero-length
        // move passes straight through.
        SceneNode::WindowGeometry {
            await_completion,
            duration_ms,
            ..
        } => !(*await_completion && *duration_ms > 0),
        SceneNode::Set { .. }
        | SceneNode::Particle { .. }
        | SceneNode::Condition { .. }
        | SceneNode::Playback { .. }
        | SceneNode::Action { .. }
        | SceneNode::Jump { .. }
        | SceneNode::UiMotionSet { .. }
        | SceneNode::Sfx { .. }
        | SceneNode::LongTextControl { .. }
        | SceneNode::ButtonCreate { .. }
        | SceneNode::ButtonUpdate { .. }
        | SceneNode::ButtonRemove { .. }
        | SceneNode::WindowTitle { .. }
        | SceneNode::WindowControl { .. }
        | SceneNode::WindowLayer { .. }
        | SceneNode::Timer { .. }
        | SceneNode::OpenWindow { .. } => true,
    }
}

/// Same-Scene nodes a node runs as an *effect* without following their `next`.
/// They keep the target reachable but never extend the story flow.
fn effect_references(node: &SceneNode) -> Option<&str> {
    match node {
        SceneNode::Timer {
            action: TimerAction::Start,
            target: Some(target),
            ..
        } => Some(target.as_str()),
        _ => None,
    }
}

fn find_immediate_cycles(catalog: &ContentCatalog) -> Vec<EditorDiagnostic> {
    type Key = (String, String);
    fn visit(
        key: &Key,
        catalog: &ContentCatalog,
        colors: &mut BTreeMap<Key, u8>,
        reported: &mut BTreeSet<Key>,
        diagnostics: &mut Vec<EditorDiagnostic>,
    ) {
        colors.insert(key.clone(), 1);
        let Some(scene) = catalog.scenes.get(&key.0) else {
            return;
        };
        let Some(node) = scene.nodes.get(&key.1) else {
            return;
        };
        if is_immediate(node) {
            for next in successors(&key.0, node) {
                let Some(next_node) = catalog
                    .scenes
                    .get(&next.0)
                    .and_then(|candidate| candidate.nodes.get(&next.1))
                else {
                    continue;
                };
                if !is_immediate(next_node) {
                    continue;
                }
                match colors.get(&next).copied().unwrap_or(0) {
                    0 => visit(&next, catalog, colors, reported, diagnostics),
                    1 if reported.insert(next.clone()) => diagnostics.push(EditorDiagnostic {
                        severity: DiagnosticSeverity::Warning,
                        code: "immediate_cycle".to_owned(),
                        message: "检测到没有对话、选择、等待或 awaited 表现的即时循环".to_owned(),
                        scene_id: Some(next.0.clone()),
                        node_id: Some(next.1.clone()),
                    }),
                    _ => {}
                }
            }
        }
        colors.insert(key.clone(), 2);
    }

    let mut diagnostics = Vec::new();
    let mut colors = BTreeMap::new();
    let mut reported = BTreeSet::new();
    for (scene_id, scene) in &catalog.scenes {
        for node_id in scene.nodes.keys() {
            let key = (scene_id.clone(), node_id.clone());
            if colors.get(&key).copied().unwrap_or(0) == 0 {
                visit(&key, catalog, &mut colors, &mut reported, &mut diagnostics);
            }
        }
    }
    diagnostics
}

fn collect_manifest_assets(manifest: &ContentManifest, output: &mut BTreeSet<String>) {
    if let Some(font) = &manifest.default_font {
        output.insert(font.clone());
    }
    for character in manifest.characters.values() {
        for expression in character.expressions.values() {
            output.insert(expression.asset.clone());
        }
    }
}

fn collect_node_assets(node: &SceneNode, output: &mut BTreeSet<String>) {
    match node {
        SceneNode::Sprite {
            source: Some(SpriteSource::Image { asset }),
            ..
        } => {
            output.insert(asset.clone());
        }
        SceneNode::Background {
            background: Some(id),
            ..
        }
        | SceneNode::Sprite {
            asset: Some(id), ..
        }
        | SceneNode::Bgm {
            asset: Some(id), ..
        }
        | SceneNode::Ambience {
            asset: Some(id), ..
        }
        | SceneNode::Sfx { asset: id, .. } => {
            output.insert((*id).to_owned());
        }
        SceneNode::LongText {
            paper: Some(id), ..
        } => {
            output.insert(id.clone());
        }
        SceneNode::Curtain {
            fill: Some(CurtainFill::Asset { asset }),
            ..
        } => {
            output.insert(asset.clone());
        }
        // Choice icons are optional `gui` assets; like every other reference
        // they keep the asset from being reported as unused or offered for
        // deletion.
        SceneNode::Choice { choices, .. } => {
            for choice in choices {
                if let Some(icon) = &choice.icon {
                    output.insert(icon.clone());
                }
            }
        }
        SceneNode::Timeline { tracks, events, .. } => {
            for track in tracks {
                match track {
                    TimelineTrack::Sprite { asset, source, .. } => {
                        if let Some(asset) = source
                            .as_ref()
                            .and_then(SpriteSource::image_asset)
                            .or(asset.as_deref())
                        {
                            output.insert(asset.to_owned());
                        }
                    }
                    TimelineTrack::Video { asset, .. } => {
                        output.insert(asset.clone());
                    }
                    TimelineTrack::Emitter { .. }
                    | TimelineTrack::Camera { .. }
                    | TimelineTrack::Button { .. }
                    | TimelineTrack::Bgm { .. }
                    | TimelineTrack::Ambience { .. } => {}
                }
            }
            for event in events {
                if let TimelineEvent::Sfx { asset, .. } = event {
                    output.insert(asset.clone());
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use vectspace_core::interaction::{
        WindowLayerAction, WindowPlacement, WindowReference, WindowRole,
    };
    use vectspace_core::model::{
        ChoiceDefinition, CurtainAction, CurtainTransitionSpec, Easing, MutationValue, ScalarValue,
        VariableOperation,
    };

    use super::*;
    use crate::documents::read_yaml;
    use crate::test_support::{demo_catalog, demo_root, minimal_manifest};

    /// Analyse the demo project with its `prologue` scene replaced by `nodes`.
    fn analyse_prologue(entry: &str, nodes: BTreeMap<String, SceneNode>) -> Vec<EditorDiagnostic> {
        let root = demo_root();
        let catalog = demo_catalog();
        let mut scenes = catalog.scenes.clone();
        let scene = scenes.get_mut("prologue").unwrap();
        scene.entry = entry.to_owned();
        scene.nodes = nodes;
        let ui_motions = catalog
            .manifest
            .ui_motions
            .iter()
            .map(|path| {
                (
                    path.clone(),
                    read_yaml(&root.join(path)).expect("demo UI motion should load"),
                )
            })
            .collect();
        let candidate =
            ContentCatalog::from_documents(root, catalog.manifest.clone(), scenes, ui_motions)
                .unwrap();
        analyze_catalog(&candidate)
    }

    fn flagged(diagnostics: &[EditorDiagnostic], scene: &str, code: &str) -> bool {
        diagnostics.iter().any(|diagnostic| {
            diagnostic.scene_id.as_deref() == Some(scene) && diagnostic.code == code
        })
    }

    #[test]
    fn immediate_cycles_are_reported_before_runtime_limit() {
        let diagnostics = analyse_prologue(
            "a",
            BTreeMap::from([
                (
                    "a".to_owned(),
                    SceneNode::Set {
                        variable: "score".to_owned(),
                        op: VariableOperation::Assign,
                        value: Some(MutationValue::Literal(ScalarValue::Integer(1))),
                        next: "b".to_owned(),
                    },
                ),
                (
                    "b".to_owned(),
                    SceneNode::Jump {
                        scene: None,
                        target: "a".to_owned(),
                    },
                ),
            ]),
        );
        assert!(flagged(&diagnostics, "prologue", "immediate_cycle"));
    }

    #[test]
    fn window_layout_nodes_are_flow_nodes_for_reachability_and_cycles() {
        let geometry = |duration_ms: u64, await_completion: bool| SceneNode::WindowGeometry {
            target: WindowRole::Secondary,
            position: Some(WindowPlacement {
                relative_to: WindowReference::Window,
                x: 1.0,
                y: 0.5,
                anchor_x: 0.0,
                anchor_y: 0.5,
                offset_x: 16.0,
                offset_y: 0.0,
            }),
            size: None,
            duration_ms,
            easing: Easing::EaseInOut,
            await_completion,
            next: "raise".to_owned(),
        };
        let layer = |next: &str| SceneNode::WindowLayer {
            target: WindowRole::Main,
            action: WindowLayerAction::Raise,
            next: next.to_owned(),
        };

        // move -> raise -> tail: both new nodes hand control on to `next`.
        let chain = analyse_prologue(
            "move",
            BTreeMap::from([
                ("move".to_owned(), geometry(600, false)),
                ("raise".to_owned(), layer("tail")),
                ("tail".to_owned(), SceneNode::End),
            ]),
        );
        assert!(
            !flagged(&chain, "prologue", "unreachable_node"),
            "{chain:?}"
        );
        assert!(!flagged(&chain, "prologue", "immediate_cycle"), "{chain:?}");

        // A loop made only of window requests never yields to the player.
        let looping = |geometry: SceneNode| {
            analyse_prologue(
                "move",
                BTreeMap::from([
                    ("move".to_owned(), geometry),
                    ("raise".to_owned(), layer("move")),
                ]),
            )
        };
        assert!(flagged(
            &looping(geometry(600, false)),
            "prologue",
            "immediate_cycle"
        ));
        // An awaited zero-length move does not wait either...
        assert!(flagged(
            &looping(geometry(0, true)),
            "prologue",
            "immediate_cycle"
        ));
        // ...but a timed awaited one holds the story back, so it is no busy loop.
        assert!(!flagged(
            &looping(geometry(600, true)),
            "prologue",
            "immediate_cycle"
        ));
    }

    #[test]
    fn always_replayable_chapter_map_scenes_are_reachability_roots() {
        let diagnostics = analyze_catalog(&demo_catalog());
        assert!(!flagged(
            &diagnostics,
            "character_action_showcase",
            "unreachable_node"
        ));
    }

    #[test]
    fn reached_secondary_window_is_reachable_without_changing_flow_cycles() {
        let mut catalog = demo_catalog();
        let entry_id = catalog.manifest.entry_scene.clone();
        let mut secondary = catalog.scenes[&entry_id].clone();
        secondary.id = "secondary_reachability_test".to_owned();
        secondary.entry = "entered".to_owned();
        secondary.nodes = BTreeMap::from([("entered".to_owned(), SceneNode::End)]);
        catalog.scenes.insert(secondary.id.clone(), secondary);
        let entry = catalog.scenes[&entry_id].entry.clone();
        let main_scene = catalog.scenes.get_mut(&entry_id).unwrap();
        main_scene
            .nodes
            .insert("after_window_test".to_owned(), SceneNode::End);
        main_scene.nodes.insert(
            entry,
            SceneNode::OpenWindow {
                scene: "secondary_reachability_test".to_owned(),
                next: "after_window_test".to_owned(),
            },
        );
        assert!(!flagged(
            &analyze_catalog(&catalog),
            "secondary_reachability_test",
            "unreachable_node"
        ));
    }

    #[test]
    fn timer_effect_targets_are_reachable_but_do_not_extend_the_flow() {
        let mut catalog = demo_catalog();
        let entry_id = catalog.manifest.entry_scene.clone();
        let entry = catalog.scenes[&entry_id].entry.clone();
        let scene = catalog.scenes.get_mut(&entry_id).unwrap();
        scene.nodes.insert(
            "effect_only".to_owned(),
            SceneNode::Sfx {
                asset: "sfx.none".to_owned(),
                volume: 1.0,
                next: "effect_successor".to_owned(),
            },
        );
        scene
            .nodes
            .insert("effect_successor".to_owned(), SceneNode::End);
        scene.nodes.insert(
            entry,
            SceneNode::Timer {
                id: "t".to_owned(),
                action: TimerAction::Start,
                delay_ms: 10,
                interval_ms: None,
                target: Some("effect_only".to_owned()),
                next: "after_timer".to_owned(),
            },
        );
        scene.nodes.insert("after_timer".to_owned(), SceneNode::End);
        let diagnostics = analyze_catalog(&catalog);
        let unreachable = |node: &str| {
            diagnostics.iter().any(|diagnostic| {
                diagnostic.code == "unreachable_node"
                    && diagnostic.scene_id.as_deref() == Some(entry_id.as_str())
                    && diagnostic.node_id.as_deref() == Some(node)
            })
        };
        assert!(!unreachable("effect_only"));
        assert!(!unreachable("after_timer"));
        // The effect node's own `next` is not run, so it stays unreachable.
        assert!(unreachable("effect_successor"));
    }

    #[test]
    fn asset_references_are_collected_from_the_manifest_and_nodes() {
        // Character expressions are asset references.
        let mut manifest = minimal_manifest();
        manifest.characters = serde_json::from_value(serde_json::json!({
            "alice": {
                "display_name": "Alice",
                "expressions": { "happy": { "asset": "sprite.alice.happy" } }
            }
        }))
        .unwrap();
        let mut assets = BTreeSet::new();
        collect_manifest_assets(&manifest, &mut assets);
        assert_eq!(
            assets.into_iter().collect::<Vec<_>>(),
            ["sprite.alice.happy"]
        );

        let collected = |node: SceneNode| {
            let mut assets = BTreeSet::new();
            collect_node_assets(&node, &mut assets);
            assets.into_iter().collect::<Vec<_>>()
        };
        let curtain = |fill: Option<CurtainFill>| SceneNode::Curtain {
            action: CurtainAction::Cover,
            fill,
            transition: CurtainTransitionSpec::Fade,
            duration_ms: 300,
            easing: Easing::EaseInOut,
            await_completion: true,
            next: "end".to_owned(),
        };
        // A gui fill is a real reference the unused-asset diagnostic and the
        // editor's delete protection must see; a colour fill or a reveal is not.
        assert_eq!(
            collected(curtain(Some(CurtainFill::Asset {
                asset: "gui.curtain".to_owned()
            }))),
            ["gui.curtain"]
        );
        assert!(collected(curtain(Some(CurtainFill::Color {
            color: "#000000".to_owned()
        })))
        .is_empty());
        assert!(collected(curtain(None)).is_empty());
        // A choice icon is a gui reference, while its button-template id is not
        // an asset and must never leak into the set.
        assert_eq!(
            collected(SceneNode::Choice {
                presentation: None,
                choices: vec![ChoiceDefinition {
                    id: "a".to_owned(),
                    label: "A".to_owned(),
                    next: "end".to_owned(),
                    visible_if: None,
                    enabled_if: None,
                    template: Some("choice.primary".to_owned()),
                    icon: Some("gui.icon".to_owned()),
                }],
            }),
            ["gui.icon"]
        );
    }
}
