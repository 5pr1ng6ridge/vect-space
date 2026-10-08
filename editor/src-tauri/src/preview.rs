//! Editor previews that run the real runtime against the current draft:
//! the one-shot node preview here and the live gameplay session in `session`.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;
use vectspace_core::content::ContentCatalog;
use vectspace_core::interaction::{
    WindowRole, WindowTitles, DEFAULT_MAIN_TITLE, DEFAULT_SECONDARY_TITLE,
};
use vectspace_core::model::{AssetKind, ChoiceSnapshot, ResolvedAsset, SceneNode, StoryLocation};
use vectspace_core::runtime::{
    PreviewChoiceDecision as CorePreviewChoiceDecision, PreviewRunResult, RuntimeEngine,
};
use vectspace_core::visual::{ParticleDefinition, TextBlockDefinition};
use vectspace_protocol::{
    variable_map_from_wire, WireCommandError, WireRuntimeSnapshot, WireRuntimeUpdate,
    WireVariableMap,
};

use crate::assets::registry::{request_staged_imports, staged_asset_overrides};
use crate::documents::draft_catalog;
use crate::error::{display_error, validation_command_error};
use crate::files::hash_file_streaming;
use crate::layout::PreviewChoiceDecision;
use crate::model::SaveProjectRequest;
use crate::state::{require_project, EditorState, ProjectSession};

pub(crate) mod session;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BuildNodePreviewRequest {
    project: SaveProjectRequest,
    target: StoryLocation,
    #[serde(default)]
    variable_overrides: WireVariableMap,
    #[serde(default)]
    choices: Vec<PreviewChoiceDecision>,
}

#[derive(Debug, Serialize)]
#[allow(clippy::large_enum_variant)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum BuildNodePreviewResult {
    NeedsChoice {
        location: StoryLocation,
        visit: usize,
        choices: Vec<ChoiceSnapshot>,
        trace: Vec<StoryLocation>,
    },
    Ready {
        start_snapshot: WireRuntimeSnapshot,
        update: WireRuntimeUpdate,
        trace: Vec<StoryLocation>,
        resolved_texts: BTreeMap<String, String>,
        #[serde(flatten)]
        resources: PreviewResources,
    },
    Unreachable {
        message: String,
        trace: Vec<StoryLocation>,
    },
}

#[tauri::command]
pub(crate) fn build_node_preview(
    request: BuildNodePreviewRequest,
    state: State<'_, EditorState>,
) -> Result<BuildNodePreviewResult, WireCommandError> {
    build_node_preview_command(request, &state)
}

/// Core command path, kept separate from the Tauri argument extractor so tests
/// can run the same project validation and runtime resolution without a
/// platform WebView.
fn build_node_preview_command(
    request: BuildNodePreviewRequest,
    state: &EditorState,
) -> Result<BuildNodePreviewResult, WireCommandError> {
    let guard = state.lock_session()?;
    let session = require_project(&guard)?;
    let catalog = build_preview_catalog(state, session, &request.project)?;
    let decisions = core_choice_decisions(&request.choices, &request.target.scene_id);
    let variable_overrides =
        variable_map_from_wire(request.variable_overrides).map_err(validation_command_error)?;
    let mut runtime = RuntimeEngine::with_preview_overrides(&catalog, &variable_overrides)
        .map_err(validation_command_error)?;
    prepare_preview_titles(
        &mut runtime,
        preview_local_role(&catalog, &request.target.scene_id),
    );
    let preview = runtime.preview_to_from_scene_entry(
        &catalog,
        &request.target.scene_id,
        &request.target,
        &decisions,
    );
    match preview {
        Ok(PreviewRunResult::NeedsChoice {
            location,
            visit,
            choices,
            trace,
        }) => Ok(BuildNodePreviewResult::NeedsChoice {
            location,
            visit,
            choices,
            trace,
        }),
        Ok(PreviewRunResult::Ready {
            snapshot: start_snapshot,
            trace,
        }) => {
            let update = runtime
                .preview_execute_current_node(&catalog)
                .map_err(validation_command_error)?;
            let resolved_texts = catalog
                .scene(&request.target.scene_id)
                .ok()
                .and_then(|scene| scene.nodes.get(&request.target.node_id))
                .and_then(|node| match node {
                    SceneNode::LongText { steps, .. } => Some(
                        steps
                            .iter()
                            .map(|step| {
                                runtime
                                    .resolve_preview_text(&catalog, &step.text)
                                    .map(|text| (step.id.clone(), text))
                            })
                            .collect::<Result<BTreeMap<_, _>, _>>(),
                    ),
                    _ => None,
                })
                .transpose()
                .map_err(validation_command_error)?
                .unwrap_or_default();
            Ok(BuildNodePreviewResult::Ready {
                start_snapshot: start_snapshot.into(),
                update: update.into(),
                trace,
                resolved_texts,
                resources: preview_resources(&catalog)?,
            })
        }
        Ok(PreviewRunResult::Unreachable { message, trace }) => {
            Ok(BuildNodePreviewResult::Unreachable { message, trace })
        }
        Err(error) => Ok(BuildNodePreviewResult::Unreachable {
            message: error.to_string(),
            trace: Vec::new(),
        }),
    }
}

/// Build the runtime catalog for an editor preview from the *current draft*
/// request (staged imports included).  `build_node_preview` and the live
/// gameplay session share this exact validation path so a preview can never run
/// against a different world than the one the editor is editing.
pub(crate) fn build_preview_catalog(
    state: &EditorState,
    session: &ProjectSession,
    project: &SaveProjectRequest,
) -> Result<ContentCatalog, WireCommandError> {
    let staged = request_staged_imports(state, session, project)?;
    draft_catalog(&session.root, project, &staged_asset_overrides(&staged))
        .map_err(validation_command_error)
}

/// What the preview surface needs besides the runtime update to render it.
#[derive(Debug, Serialize)]
pub(crate) struct PreviewResources {
    assets: Vec<ResolvedAsset>,
    text_blocks: BTreeMap<String, TextBlockDefinition>,
    particles: BTreeMap<String, ParticleDefinition>,
    /// Content hash of every font, so the surface reloads a font whose file
    /// changed under the same asset id.
    font_versions: BTreeMap<String, String>,
}

pub(crate) fn preview_resources(
    catalog: &ContentCatalog,
) -> Result<PreviewResources, WireCommandError> {
    Ok(PreviewResources {
        assets: catalog
            .resolve_assets(&catalog.asset_ids())
            .map_err(validation_command_error)?,
        text_blocks: catalog.text_blocks.clone(),
        particles: catalog.particles.clone(),
        font_versions: font_versions(catalog).map_err(validation_command_error)?,
    })
}

fn font_versions(catalog: &ContentCatalog) -> Result<BTreeMap<String, String>, String> {
    let ids = catalog
        .manifest
        .assets
        .iter()
        .filter(|(_, asset)| asset.kind == AssetKind::Font)
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    catalog
        .resolve_assets(&ids)
        .map_err(display_error)?
        .into_iter()
        .map(|asset| {
            let version =
                hash_file_streaming(Path::new(&asset.absolute_path)).map_err(display_error)?;
            Ok((asset.id, version))
        })
        .collect()
}

/// Choices recorded for other Scenes are stale: a node preview owns only the
/// path from its own Scene entry to the target.
pub(crate) fn core_choice_decisions(
    choices: &[PreviewChoiceDecision],
    scene_id: &str,
) -> Vec<CorePreviewChoiceDecision> {
    choices
        .iter()
        .filter(|choice| choice.scene_id == scene_id)
        .map(|choice| CorePreviewChoiceDecision {
            scene_id: choice.scene_id.clone(),
            node_id: choice.node_id.clone(),
            visit: choice.visit,
            choice_id: choice.choice_id.clone(),
        })
        .collect()
}

/// Role of the Scene a preview starts in; unknown Scenes fall back to `main`
/// (the runtime reports the real error when it starts).
pub(crate) fn preview_local_role(catalog: &ContentCatalog, scene_id: &str) -> WindowRole {
    catalog
        .scenes
        .get(scene_id)
        .map_or(WindowRole::Main, |scene| scene.window_role)
}

/// A secondary Scene previews as if its window had just been created.
pub(crate) fn prepare_preview_titles(runtime: &mut RuntimeEngine, local: WindowRole) {
    runtime.prepare_window_titles(WindowTitles {
        main: DEFAULT_MAIN_TITLE.to_owned(),
        secondary: if local == WindowRole::Secondary {
            DEFAULT_SECONDARY_TITLE.to_owned()
        } else {
            String::new()
        },
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{demo_state, demo_wire_project};

    #[test]
    fn build_node_preview_command_resolves_the_repository_choice_fixture() {
        let state = demo_state();
        // The exact JSON body the WebView sends through Tauri; the command's
        // state-backed implementation covers the production validation, catalog
        // construction and runtime preview.
        let request: BuildNodePreviewRequest = serde_json::from_value(serde_json::json!({
            "project": demo_wire_project(),
            "target": { "scene_id": "prologue", "node_id": "route_choice" },
            "choices": [],
            "variable_overrides": {}
        }))
        .unwrap();
        let response =
            serde_json::to_value(build_node_preview_command(request, &state).unwrap()).unwrap();

        assert_eq!(response["status"], "ready");
        let prompt = &response["update"]["snapshot"]["prompt"];
        assert_eq!(prompt["kind"], "choice");
        // ending_seen=false and score=0 filter the conditional geometry/test
        // options, while the repository's unconditional regression choices
        // remain in their authored order.
        let ids: Vec<&str> = prompt["choices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|choice| choice["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["algebra", "SANDBOX", "BUTTONTEST", "UIMOTIONTEST"]);
        assert_eq!(prompt["layout"]["direction"], "vertical");
        // The shared preview resources are flattened into the result.
        assert!(response["assets"].is_array() && response["font_versions"].is_object());
    }
}
