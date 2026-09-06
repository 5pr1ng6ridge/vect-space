use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{self, File},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{de::DeserializeOwned, Deserialize, Serialize, Serializer};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use vectspace_core::{
    content::ContentCatalog,
    model::{
        AssetKind, ChoiceSnapshot, ContentManifest, ResolvedAsset, SceneDefinition, SceneNode,
        StoryFlowDefinition, StoryLocation, TimelineEvent, TimelineTrack, UiMotionPreset,
        VariableMap,
    },
    runtime::{
        PreviewChoiceDecision as CorePreviewChoiceDecision, PreviewRunResult, RuntimeEngine,
    },
};
use vectspace_protocol::{
    variable_map_from_wire, WireCommandError, WireCommandErrorCode, WireRuntimeSnapshot,
    WireRuntimeUpdate, WireVariableMap,
};

const LAYOUT_RELATIVE_PATH: &str = ".vectspace/layout-v1.json";

#[derive(Default)]
struct EditorState {
    session: Mutex<Option<ProjectSession>>,
}

struct ProjectSession {
    root: PathBuf,
    catalog: ContentCatalog,
    fingerprint: String,
    document_models: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorProject {
    root: String,
    manifest: ContentManifest,
    scenes: Vec<EditorSceneFile>,
    ui_motions: Vec<EditorUiMotionFile>,
    story_flow: Option<EditorStoryFlowFile>,
    layout: EditorLayout,
    assets: Vec<EditorAsset>,
    diagnostics: Vec<EditorDiagnostic>,
    fingerprint: String,
}

#[derive(Serialize)]
struct EditorProjectView<'a> {
    root: &'a str,
    manifest: &'a ContentManifest,
    scenes: &'a [EditorSceneFile],
    ui_motions: &'a [EditorUiMotionFile],
    story_flow: &'a Option<EditorStoryFlowFile>,
    layout: &'a EditorLayout,
    assets: &'a [EditorAsset],
    diagnostics: &'a [EditorDiagnostic],
    fingerprint: &'a str,
}

impl Serialize for EditorProject {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut value = serde_json::to_value(EditorProjectView {
            root: &self.root,
            manifest: &self.manifest,
            scenes: &self.scenes,
            ui_motions: &self.ui_motions,
            story_flow: &self.story_flow,
            layout: &self.layout,
            assets: &self.assets,
            diagnostics: &self.diagnostics,
            fingerprint: &self.fingerprint,
        })
        .map_err(serde::ser::Error::custom)?;
        encode_project_scalars(&mut value, &self.manifest.variables);
        value.serialize(serializer)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct SaveProjectResult {
    project: EditorProject,
    changed_paths: Vec<String>,
    deleted_paths: Vec<String>,
    warnings: Vec<EditorDiagnostic>,
    transaction_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorSceneFile {
    path: String,
    definition: SceneDefinition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorUiMotionFile {
    path: String,
    definition: UiMotionPreset,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorStoryFlowFile {
    path: String,
    definition: StoryFlowDefinition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorAsset {
    id: String,
    kind: AssetKind,
    path: String,
    absolute_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorDiagnostic {
    severity: DiagnosticSeverity,
    code: String,
    message: String,
    scene_id: Option<String>,
    node_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DiagnosticSeverity {
    Warning,
    Info,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorLayout {
    version: u32,
    #[serde(default)]
    scenes: BTreeMap<String, SceneLayout>,
    #[serde(default)]
    timeline_previews: BTreeMap<String, TimelinePreviewSettings>,
}

impl Default for EditorLayout {
    fn default() -> Self {
        Self {
            version: 1,
            scenes: BTreeMap::new(),
            timeline_previews: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TimelinePreviewSettings {
    #[serde(default)]
    variable_overrides: VariableMap,
    #[serde(default)]
    choices: Vec<PreviewChoiceDecision>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewChoiceDecision {
    scene_id: String,
    node_id: String,
    visit: usize,
    choice_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BuildNodePreviewRequest {
    project: SaveProjectRequest,
    target: StoryLocation,
    #[serde(default)]
    origin: PreviewOrigin,
    #[serde(default)]
    variable_overrides: WireVariableMap,
    #[serde(default)]
    choices: Vec<PreviewChoiceDecision>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PreviewOrigin {
    #[default]
    StoryEntry,
    SceneEntry,
}

#[derive(Debug, Serialize)]
#[allow(clippy::large_enum_variant)]
#[serde(tag = "status", rename_all = "snake_case")]
enum BuildNodePreviewResult {
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
        #[serde(default)]
        resolved_texts: BTreeMap<String, String>,
    },
    Unreachable {
        message: String,
        trace: Vec<StoryLocation>,
        #[serde(default)]
        can_retry_from_scene_entry: bool,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SceneLayout {
    #[serde(default)]
    nodes: BTreeMap<String, NodePosition>,
    #[serde(default)]
    viewport: Option<EditorViewport>,
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

#[derive(Debug)]
struct SaveProjectRequest {
    manifest: ContentManifest,
    scenes: Vec<EditorSceneFile>,
    ui_motions: Vec<EditorUiMotionFile>,
    story_flow: Option<EditorStoryFlowFile>,
    layout: EditorLayout,
    expected_fingerprint: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveProjectRequestRaw {
    manifest: ContentManifest,
    scenes: Vec<EditorSceneFile>,
    ui_motions: Vec<EditorUiMotionFile>,
    story_flow: Option<EditorStoryFlowFile>,
    layout: EditorLayout,
    expected_fingerprint: String,
}

impl<'de> Deserialize<'de> for SaveProjectRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let mut value = serde_json::Value::deserialize(deserializer)?;
        decode_wire_scalars(&mut value).map_err(serde::de::Error::custom)?;
        let raw: SaveProjectRequestRaw =
            serde_json::from_value(value).map_err(serde::de::Error::custom)?;
        Ok(Self {
            manifest: raw.manifest,
            scenes: raw.scenes,
            ui_motions: raw.ui_motions,
            story_flow: raw.story_flow,
            layout: raw.layout,
            expected_fingerprint: raw.expected_fingerprint,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportAssetRequest {
    id: String,
    kind: AssetKind,
    source_path: String,
}

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields)]
struct ImportedAsset {
    id: String,
    kind: AssetKind,
    path: String,
    absolute_path: String,
}

#[tauri::command]
fn open_project(
    root: String,
    app: AppHandle,
    state: State<'_, EditorState>,
) -> Result<EditorProject, WireCommandError> {
    let root = resolve_content_root(Path::new(&root)).map_err(io_command_error)?;
    recover_pending_transactions(&root).map_err(io_command_error)?;
    let catalog = ContentCatalog::from_root(root.clone()).map_err(validation_command_error)?;
    app.asset_protocol_scope()
        .allow_directory(catalog.assets_root(), true)
        .map_err(asset_command_error)?;

    let fingerprint = project_fingerprint(&root, &catalog.manifest).map_err(io_command_error)?;
    let layout = read_layout(&root).map_err(io_command_error)?;
    let document_models =
        document_models(&root, &catalog.manifest, &layout).map_err(io_command_error)?;
    let project = project_payload(&root, &catalog, layout, fingerprint.clone())
        .map_err(validation_command_error)?;
    let mut guard = state
        .session
        .lock()
        .map_err(|_| internal_command_error("编辑器项目锁已损坏"))?;
    *guard = Some(ProjectSession {
        root,
        catalog,
        fingerprint,
        document_models,
    });
    Ok(project)
}

#[tauri::command]
fn save_project(
    request: SaveProjectRequest,
    state: State<'_, EditorState>,
) -> Result<SaveProjectResult, WireCommandError> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| internal_command_error("编辑器项目锁已损坏"))?;
    let session = guard
        .as_mut()
        .ok_or_else(|| validation_command_error("尚未打开项目"))?;

    let actual_fingerprint =
        project_fingerprint(&session.root, &session.catalog.manifest).map_err(io_command_error)?;
    if request.expected_fingerprint != session.fingerprint
        || actual_fingerprint != session.fingerprint
    {
        return Err(WireCommandError::new(
            WireCommandErrorCode::StaleProject,
            "项目文件已被其他程序修改。请重新打开项目后再保存，以免覆盖外部更改。",
        ));
    }

    let scenes = validate_scene_file_set(&request.manifest, &request.scenes)
        .map_err(validation_command_error)?;
    let ui_motions = validate_ui_motion_file_set(&request.manifest, &request.ui_motions)
        .map_err(validation_command_error)?;
    let candidate = ContentCatalog::from_documents(
        session.root.clone(),
        request.manifest.clone(),
        scenes,
        ui_motions,
        request
            .story_flow
            .as_ref()
            .map(|file| file.definition.clone()),
    )
    .map_err(validation_command_error)?;

    let all_writes =
        serialize_project(&session.root, &request).map_err(validation_command_error)?;
    let next_models = document_models_from_request(&request).map_err(validation_command_error)?;
    let writes = retain_changed_model_writes(
        &session.root,
        &request,
        all_writes,
        &session.document_models,
    )
    .map_err(validation_command_error)?;
    let deletes = managed_deletions(&session.root, &session.catalog.manifest, &request.manifest);
    let changed_paths = writes
        .iter()
        .filter_map(|(path, _)| path.strip_prefix(&session.root).ok())
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .collect::<Vec<_>>();
    let transaction_id = if writes.is_empty() && deletes.is_empty() {
        None
    } else {
        let id = atomic_write_batch_with_deletes(&session.root, &writes, &deletes)
            .map_err(io_command_error)?;
        Some(id)
    };

    let fingerprint =
        project_fingerprint(&session.root, &request.manifest).map_err(io_command_error)?;
    let layout = request.layout.clone();
    let project = project_payload_from_request(
        &session.root,
        &candidate,
        &request,
        layout,
        fingerprint.clone(),
    )
    .map_err(validation_command_error)?;
    session.catalog = candidate;
    session.fingerprint.clone_from(&fingerprint);
    session.document_models = next_models;
    Ok(SaveProjectResult {
        project,
        changed_paths,
        deleted_paths: deletes
            .iter()
            .filter_map(|path| path.strip_prefix(&session.root).ok())
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect(),
        warnings: Vec::new(),
        transaction_id,
    })
}

#[tauri::command]
fn validate_project(
    request: SaveProjectRequest,
    state: State<'_, EditorState>,
) -> Result<Vec<EditorDiagnostic>, WireCommandError> {
    let guard = state
        .session
        .lock()
        .map_err(|_| internal_command_error("编辑器项目锁已损坏"))?;
    let session = guard
        .as_ref()
        .ok_or_else(|| validation_command_error("尚未打开项目"))?;
    let scenes = validate_scene_file_set(&request.manifest, &request.scenes)
        .map_err(validation_command_error)?;
    let ui_motions = validate_ui_motion_file_set(&request.manifest, &request.ui_motions)
        .map_err(validation_command_error)?;
    let candidate = ContentCatalog::from_documents(
        session.root.clone(),
        request.manifest,
        scenes,
        ui_motions,
        request
            .story_flow
            .as_ref()
            .map(|file| file.definition.clone()),
    )
    .map_err(validation_command_error)?;
    Ok(analyze_catalog(&candidate))
}

#[tauri::command]
fn import_asset(
    request: ImportAssetRequest,
    app: AppHandle,
    state: State<'_, EditorState>,
) -> Result<ImportedAsset, WireCommandError> {
    if !valid_identifier(&request.id) {
        return Err(WireCommandError::new(
            WireCommandErrorCode::Validation,
            "素材 ID 只能包含 ASCII 字母、数字、点、下划线或连字符，长度为 1–128。",
        ));
    }
    let guard = state
        .session
        .lock()
        .map_err(|_| internal_command_error("编辑器项目锁已损坏"))?;
    let session = guard
        .as_ref()
        .ok_or_else(|| validation_command_error("尚未打开项目"))?;
    if session.catalog.manifest.assets.contains_key(&request.id) {
        return Err(validation_command_error(format!(
            "素材 ID 已存在: {}",
            request.id
        )));
    }

    let source = fs::canonicalize(&request.source_path).map_err(io_command_error)?;
    if !source.is_file() {
        return Err(validation_command_error("选择的素材不是文件"));
    }
    if request.kind == AssetKind::Video
        && source
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("mp4"))
    {
        return Err(validation_command_error("视频素材必须是 .mp4（H.264/AAC）"));
    }
    let file_name = source
        .file_name()
        .ok_or_else(|| validation_command_error("无法识别素材文件名"))?
        .to_owned();
    let folder = asset_folder(request.kind);
    let destination_dir = session.root.join("assets").join(folder);
    fs::create_dir_all(&destination_dir).map_err(io_command_error)?;
    let destination = destination_dir.join(file_name);
    if destination.exists() {
        return Err(validation_command_error(format!(
            "目标素材文件已存在: {}",
            destination.display()
        )));
    }
    fs::copy(&source, &destination).map_err(io_command_error)?;
    let canonical = fs::canonicalize(&destination).map_err(io_command_error)?;
    app.asset_protocol_scope()
        .allow_file(&canonical)
        .map_err(asset_command_error)?;
    let relative = canonical
        .strip_prefix(
            session
                .root
                .join("assets")
                .canonicalize()
                .map_err(io_command_error)?,
        )
        .map_err(io_command_error)?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(ImportedAsset {
        id: request.id,
        kind: request.kind,
        path: relative,
        absolute_path: canonical.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn build_node_preview(
    request: BuildNodePreviewRequest,
    state: State<'_, EditorState>,
) -> Result<BuildNodePreviewResult, WireCommandError> {
    build_node_preview_impl(request, state)
}

fn build_node_preview_impl(
    request: BuildNodePreviewRequest,
    state: State<'_, EditorState>,
) -> Result<BuildNodePreviewResult, WireCommandError> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| internal_command_error("编辑器项目锁已损坏"))?;
    let session = guard
        .as_mut()
        .ok_or_else(|| validation_command_error("尚未打开项目"))?;
    let scenes = validate_scene_file_set(&request.project.manifest, &request.project.scenes)
        .map_err(validation_command_error)?;
    let ui_motions =
        validate_ui_motion_file_set(&request.project.manifest, &request.project.ui_motions)
            .map_err(validation_command_error)?;
    let catalog = ContentCatalog::from_documents(
        session.root.clone(),
        request.project.manifest.clone(),
        scenes,
        ui_motions,
        request
            .project
            .story_flow
            .as_ref()
            .map(|file| file.definition.clone()),
    )
    .map_err(validation_command_error)?;
    let decisions = request
        .choices
        .iter()
        .map(|choice| CorePreviewChoiceDecision {
            scene_id: choice.scene_id.clone(),
            node_id: choice.node_id.clone(),
            visit: choice.visit,
            choice_id: choice.choice_id.clone(),
        })
        .collect::<Vec<_>>();
    let variable_overrides =
        variable_map_from_wire(request.variable_overrides).map_err(validation_command_error)?;
    let mut runtime = RuntimeEngine::with_preview_overrides(&catalog, &variable_overrides)
        .map_err(validation_command_error)?;
    let preview = match request.origin {
        PreviewOrigin::StoryEntry => runtime.preview_to(&catalog, &request.target, &decisions),
        PreviewOrigin::SceneEntry => runtime.preview_to_from_scene_entry(
            &catalog,
            &request.target.scene_id,
            &request.target,
            &decisions,
        ),
    };
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
            })
        }
        Ok(PreviewRunResult::Unreachable { message, trace }) => {
            Ok(BuildNodePreviewResult::Unreachable {
                message,
                trace,
                can_retry_from_scene_entry: matches!(request.origin, PreviewOrigin::StoryEntry),
            })
        }
        Err(error) => Ok(BuildNodePreviewResult::Unreachable {
            message: error.to_string(),
            trace: Vec::new(),
            can_retry_from_scene_entry: matches!(request.origin, PreviewOrigin::StoryEntry),
        }),
    }
}

fn resolve_content_root(selected: &Path) -> Result<PathBuf, std::io::Error> {
    let selected = fs::canonicalize(selected)?;
    if selected.join("manifest.yaml").is_file() {
        Ok(selected)
    } else if selected.join("game/manifest.yaml").is_file() {
        fs::canonicalize(selected.join("game"))
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "所选目录及其 game/ 子目录中都没有 manifest.yaml",
        ))
    }
}

fn project_payload(
    root: &Path,
    catalog: &ContentCatalog,
    layout: EditorLayout,
    fingerprint: String,
) -> Result<EditorProject, String> {
    let mut scenes = Vec::with_capacity(catalog.manifest.scenes.len());
    for path in &catalog.manifest.scenes {
        let definition: SceneDefinition = read_yaml(&root.join(path))?;
        scenes.push(EditorSceneFile {
            path: path.clone(),
            definition,
        });
    }
    let mut ui_motions = Vec::with_capacity(catalog.manifest.ui_motions.len());
    for path in &catalog.manifest.ui_motions {
        ui_motions.push(EditorUiMotionFile {
            path: path.clone(),
            definition: read_yaml(&root.join(path))?,
        });
    }
    let story_flow = match &catalog.manifest.story_flow {
        Some(path) => Some(EditorStoryFlowFile {
            path: path.clone(),
            definition: read_yaml(&root.join(path))?,
        }),
        None => None,
    };

    let definitions = &catalog.manifest.assets;
    let ids = catalog.asset_ids();
    let resolved = catalog.resolve_assets(&ids).map_err(display_error)?;
    let by_id: BTreeMap<&str, &ResolvedAsset> = resolved
        .iter()
        .map(|asset| (asset.id.as_str(), asset))
        .collect();
    let assets = definitions
        .iter()
        .filter_map(|(id, definition)| {
            by_id.get(id.as_str()).map(|asset| EditorAsset {
                id: id.clone(),
                kind: definition.kind,
                path: definition.path.clone(),
                absolute_path: asset.absolute_path.clone(),
            })
        })
        .collect();

    Ok(EditorProject {
        root: root.to_string_lossy().into_owned(),
        manifest: catalog.manifest.clone(),
        scenes,
        ui_motions,
        story_flow,
        layout,
        assets,
        diagnostics: analyze_catalog(catalog),
        fingerprint,
    })
}

fn project_payload_from_request(
    root: &Path,
    catalog: &ContentCatalog,
    request: &SaveProjectRequest,
    layout: EditorLayout,
    fingerprint: String,
) -> Result<EditorProject, String> {
    let resolved = catalog
        .resolve_assets(&catalog.asset_ids())
        .map_err(display_error)?;
    let by_id: BTreeMap<&str, &ResolvedAsset> = resolved
        .iter()
        .map(|asset| (asset.id.as_str(), asset))
        .collect();
    let assets = catalog
        .manifest
        .assets
        .iter()
        .filter_map(|(id, definition)| {
            by_id.get(id.as_str()).map(|asset| EditorAsset {
                id: id.clone(),
                kind: definition.kind,
                path: definition.path.clone(),
                absolute_path: asset.absolute_path.clone(),
            })
        })
        .collect();
    Ok(EditorProject {
        root: root.to_string_lossy().into_owned(),
        manifest: request.manifest.clone(),
        scenes: request.scenes.clone(),
        ui_motions: request.ui_motions.clone(),
        story_flow: request.story_flow.clone(),
        layout,
        assets,
        diagnostics: analyze_catalog(catalog),
        fingerprint,
    })
}

fn read_yaml<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let text = fs::read_to_string(path).map_err(display_error)?;
    let options = serde_saphyr::options! { strict_booleans: true };
    serde_saphyr::from_str_with_options(&text, options).map_err(display_error)
}

fn read_layout(root: &Path) -> Result<EditorLayout, String> {
    let path = root.join(LAYOUT_RELATIVE_PATH);
    if !path.exists() {
        return Ok(EditorLayout::default());
    }
    let bytes = fs::read(&path).map_err(display_error)?;
    let layout: EditorLayout = serde_json::from_slice(&bytes).map_err(display_error)?;
    if layout.version != 1 {
        return Err(format!("不支持编辑器布局版本 {}", layout.version));
    }
    Ok(layout)
}

fn validate_scene_file_set(
    manifest: &ContentManifest,
    files: &[EditorSceneFile],
) -> Result<BTreeMap<String, SceneDefinition>, String> {
    if manifest.scenes.len() != files.len() {
        return Err("manifest 的场景文件列表与编辑器文档不一致".to_owned());
    }
    let declared: BTreeSet<&str> = manifest.scenes.iter().map(String::as_str).collect();
    if declared.len() != manifest.scenes.len() {
        return Err("manifest 中存在重复场景路径".to_owned());
    }
    let provided: BTreeSet<&str> = files.iter().map(|file| file.path.as_str()).collect();
    if declared != provided {
        return Err("提交的场景路径与 manifest 不一致".to_owned());
    }

    let mut scenes = BTreeMap::new();
    for file in files {
        safe_relative_path(&file.path)?;
        if scenes
            .insert(file.definition.id.clone(), file.definition.clone())
            .is_some()
        {
            return Err(format!("场景 ID 重复: {}", file.definition.id));
        }
    }
    Ok(scenes)
}

fn validate_ui_motion_file_set(
    manifest: &ContentManifest,
    files: &[EditorUiMotionFile],
) -> Result<BTreeMap<String, UiMotionPreset>, String> {
    if manifest.ui_motions.len() != files.len() {
        return Err("manifest 的 UI 动效文件列表与编辑器文档不一致".to_owned());
    }
    let declared = manifest
        .ui_motions
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let provided = files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<BTreeSet<_>>();
    if declared.len() != manifest.ui_motions.len() || declared != provided {
        return Err("提交的 UI 动效路径与 manifest 不一致".to_owned());
    }
    let mut motions = BTreeMap::new();
    for file in files {
        safe_relative_path(&file.path)?;
        motions.insert(file.path.clone(), file.definition.clone());
    }
    Ok(motions)
}

fn serialize_project(
    root: &Path,
    request: &SaveProjectRequest,
) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    let mut writes = Vec::with_capacity(request.scenes.len() + request.ui_motions.len() + 3);
    writes.push((root.join("manifest.yaml"), yaml_bytes(&request.manifest)?));
    for scene in &request.scenes {
        safe_relative_path(&scene.path)?;
        writes.push((root.join(&scene.path), yaml_bytes(&scene.definition)?));
    }
    for motion in &request.ui_motions {
        safe_relative_path(&motion.path)?;
        writes.push((root.join(&motion.path), yaml_bytes(&motion.definition)?));
    }
    if let Some(flow) = &request.story_flow {
        safe_relative_path(&flow.path)?;
        writes.push((root.join(&flow.path), yaml_bytes(&flow.definition)?));
    }
    let layout = serde_json::to_vec_pretty(&request.layout).map_err(display_error)?;
    writes.push((root.join(LAYOUT_RELATIVE_PATH), layout));
    Ok(writes)
}

fn managed_deletions(
    root: &Path,
    previous: &ContentManifest,
    next: &ContentManifest,
) -> Vec<PathBuf> {
    let mut previous_paths = previous.scenes.clone();
    previous_paths.extend(previous.ui_motions.iter().cloned());
    if let Some(path) = &previous.story_flow {
        previous_paths.push(path.clone());
    }
    let mut next_paths = next.scenes.clone();
    next_paths.extend(next.ui_motions.iter().cloned());
    if let Some(path) = &next.story_flow {
        next_paths.push(path.clone());
    }
    previous_paths
        .into_iter()
        .filter(|path| !next_paths.iter().any(|candidate| candidate == path))
        .filter_map(|path| {
            safe_relative_path(&path).ok()?;
            Some(root.join(path))
        })
        .collect()
}

fn document_models(
    root: &Path,
    manifest: &ContentManifest,
    layout: &EditorLayout,
) -> Result<BTreeMap<String, serde_json::Value>, String> {
    let mut models = BTreeMap::new();
    models.insert(
        "manifest.yaml".to_owned(),
        serde_json::to_value(manifest).map_err(display_error)?,
    );
    for path in &manifest.scenes {
        let definition: SceneDefinition = read_yaml(&root.join(path))?;
        models.insert(
            path.replace('\\', "/"),
            serde_json::to_value(definition).map_err(display_error)?,
        );
    }
    for path in &manifest.ui_motions {
        let definition: UiMotionPreset = read_yaml(&root.join(path))?;
        models.insert(
            path.replace('\\', "/"),
            serde_json::to_value(definition).map_err(display_error)?,
        );
    }
    if let Some(path) = &manifest.story_flow {
        let definition: StoryFlowDefinition = read_yaml(&root.join(path))?;
        models.insert(
            path.replace('\\', "/"),
            serde_json::to_value(definition).map_err(display_error)?,
        );
    }
    models.insert(
        LAYOUT_RELATIVE_PATH.to_owned(),
        serde_json::to_value(layout).map_err(display_error)?,
    );
    Ok(models)
}

fn document_models_from_request(
    request: &SaveProjectRequest,
) -> Result<BTreeMap<String, serde_json::Value>, String> {
    let mut models = BTreeMap::new();
    models.insert(
        "manifest.yaml".to_owned(),
        serde_json::to_value(&request.manifest).map_err(display_error)?,
    );
    for file in &request.scenes {
        models.insert(
            file.path.replace('\\', "/"),
            serde_json::to_value(&file.definition).map_err(display_error)?,
        );
    }
    for file in &request.ui_motions {
        models.insert(
            file.path.replace('\\', "/"),
            serde_json::to_value(&file.definition).map_err(display_error)?,
        );
    }
    if let Some(file) = &request.story_flow {
        models.insert(
            file.path.replace('\\', "/"),
            serde_json::to_value(&file.definition).map_err(display_error)?,
        );
    }
    models.insert(
        LAYOUT_RELATIVE_PATH.to_owned(),
        serde_json::to_value(&request.layout).map_err(display_error)?,
    );
    Ok(models)
}

fn retain_changed_model_writes(
    root: &Path,
    request: &SaveProjectRequest,
    writes: Vec<(PathBuf, Vec<u8>)>,
    baseline: &BTreeMap<String, serde_json::Value>,
) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    writes
        .into_iter()
        .filter_map(|(path, bytes)| {
            let key = path
                .strip_prefix(root)
                .map(|relative| relative.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));
            let current = match key.as_str() {
                "manifest.yaml" => serde_json::to_value(&request.manifest),
                LAYOUT_RELATIVE_PATH => serde_json::to_value(&request.layout),
                _ => request
                    .scenes
                    .iter()
                    .find(|file| file.path.replace('\\', "/") == key)
                    .map(|file| serde_json::to_value(&file.definition))
                    .or_else(|| {
                        request
                            .ui_motions
                            .iter()
                            .find(|file| file.path.replace('\\', "/") == key)
                            .map(|file| serde_json::to_value(&file.definition))
                    })
                    .or_else(|| {
                        request
                            .story_flow
                            .as_ref()
                            .filter(|file| file.path.replace('\\', "/") == key)
                            .map(|file| serde_json::to_value(&file.definition))
                    })
                    .unwrap_or(Ok(serde_json::Value::Null)),
            };
            match current {
                Ok(value) if baseline.get(&key) == Some(&value) => None,
                _ => Some(Ok((path, bytes))),
            }
        })
        .collect()
}

fn encode_project_scalars(
    project: &mut serde_json::Value,
    variables: &BTreeMap<String, vectspace_core::model::VariableDefinition>,
) {
    let Some(object) = project.as_object_mut() else {
        return;
    };
    if let Some(manifest) = object
        .get_mut("manifest")
        .and_then(|value| value.as_object_mut())
    {
        if let Some(variable_values) = manifest
            .get_mut("variables")
            .and_then(|value| value.as_object_mut())
        {
            for (id, definition) in variables {
                if let Some(default) = variable_values
                    .get_mut(id)
                    .and_then(|value| value.as_object_mut())
                    .and_then(|value| value.get_mut("default"))
                {
                    let raw = std::mem::take(default);
                    *default = encode_scalar_json(raw, Some(definition.value_type));
                }
            }
        }
    }
    if let Some(scenes) = object
        .get_mut("scenes")
        .and_then(|value| value.as_array_mut())
    {
        for scene in scenes {
            if let Some(nodes) = scene
                .as_object_mut()
                .and_then(|value| value.get_mut("definition"))
                .and_then(|value| value.as_object_mut())
                .and_then(|value| value.get_mut("nodes"))
                .and_then(|value| value.as_object_mut())
            {
                for node in nodes.values_mut() {
                    encode_node_scalars(node);
                }
            }
        }
    }
    if let Some(story_flow) = object
        .get_mut("story_flow")
        .and_then(|value| value.as_object_mut())
        .and_then(|value| value.get_mut("definition"))
    {
        if let Some(nodes) = story_flow
            .as_object_mut()
            .and_then(|value| value.get_mut("nodes"))
        {
            if let Some(nodes) = nodes.as_object_mut() {
                for node in nodes.values_mut() {
                    if let Some(condition) = node
                        .as_object_mut()
                        .and_then(|value| value.get_mut("reveal"))
                        .and_then(|value| value.as_object_mut())
                        .and_then(|value| value.get_mut("condition"))
                    {
                        encode_condition_scalars(condition);
                    }
                }
            }
        }
    }
    if let Some(layout) = object
        .get_mut("layout")
        .and_then(|value| value.as_object_mut())
    {
        if let Some(previews) = layout
            .get_mut("timeline_previews")
            .and_then(|value| value.as_object_mut())
        {
            for settings in previews.values_mut() {
                if let Some(overrides) = settings
                    .as_object_mut()
                    .and_then(|value| value.get_mut("variable_overrides"))
                    .and_then(|value| value.as_object_mut())
                {
                    for (id, value) in overrides.iter_mut() {
                        let raw = std::mem::take(value);
                        let expected = variables.get(id).map(|definition| definition.value_type);
                        *value = encode_scalar_json(raw, expected);
                    }
                }
            }
        }
    }
}

fn encode_node_scalars(node: &mut serde_json::Value) {
    let Some(object) = node.as_object_mut() else {
        return;
    };
    match object.get("type").and_then(|value| value.as_str()) {
        Some("set") => {
            if let Some(value) = object.get_mut("value") {
                if !value.is_object() || value.get("variable").is_none() {
                    let raw = std::mem::take(value);
                    *value = encode_scalar_json(raw, None);
                }
            }
        }
        Some("condition") => {
            if let Some(condition) = object.get_mut("condition") {
                encode_condition_scalars(condition);
            }
        }
        Some("choice") => {
            if let Some(choices) = object
                .get_mut("choices")
                .and_then(|value| value.as_array_mut())
            {
                for choice in choices {
                    for key in ["visible_if", "enabled_if"] {
                        if let Some(condition) =
                            choice.as_object_mut().and_then(|value| value.get_mut(key))
                        {
                            encode_condition_scalars(condition);
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

fn encode_condition_scalars(condition: &mut serde_json::Value) {
    let Some(object) = condition.as_object_mut() else {
        return;
    };
    match object.get("op").and_then(|value| value.as_str()) {
        Some("eq") | Some("ne") | Some("lt") | Some("le") | Some("gt") | Some("ge") => {
            for key in ["left", "right"] {
                if let Some(operand) = object.get_mut(key) {
                    if let Some(value) = operand
                        .as_object_mut()
                        .and_then(|value| value.get_mut("value"))
                    {
                        let raw = std::mem::take(value);
                        *value = encode_scalar_json(raw, None);
                    }
                }
            }
        }
        Some("and") | Some("or") => {
            if let Some(children) = object
                .get_mut("conditions")
                .and_then(|value| value.as_array_mut())
            {
                for child in children {
                    encode_condition_scalars(child);
                }
            }
        }
        Some("not") => {
            if let Some(child) = object.get_mut("condition") {
                encode_condition_scalars(child);
            }
        }
        _ => {}
    }
}

fn encode_scalar_json(
    value: serde_json::Value,
    expected: Option<vectspace_core::model::VariableType>,
) -> serde_json::Value {
    if value
        .as_object()
        .is_some_and(|object| object.get("kind").is_some() && object.get("value").is_some())
    {
        return value;
    }
    let (kind, value) = match value {
        serde_json::Value::Bool(value) => ("boolean", serde_json::Value::Bool(value)),
        serde_json::Value::Number(value)
            if expected == Some(vectspace_core::model::VariableType::Number)
                && value.as_f64().is_some() =>
        {
            ("number", serde_json::Value::Number(value))
        }
        serde_json::Value::Number(value) => {
            if let Some(integer) = value.as_i64() {
                ("integer", serde_json::Value::String(integer.to_string()))
            } else if let Some(number) = value.as_f64() {
                ("number", serde_json::json!(number))
            } else {
                return serde_json::Value::Null;
            }
        }
        serde_json::Value::String(value) => ("string", serde_json::Value::String(value)),
        other => return other,
    };
    serde_json::json!({ "kind": kind, "value": value })
}

fn decode_wire_scalars(value: &mut serde_json::Value) -> Result<(), String> {
    if let Some(object) = value.as_object_mut() {
        if let (Some(kind), Some(payload)) = (object.get("kind"), object.get("value")) {
            if object.len() == 2 {
                let decoded = match kind.as_str() {
                    Some("boolean") if payload.is_boolean() => payload.clone(),
                    Some("string") if payload.is_string() => payload.clone(),
                    Some("number") => {
                        let number = payload
                            .as_f64()
                            .ok_or_else(|| "wire number 必须是有限数字".to_owned())?;
                        if !number.is_finite() {
                            return Err("wire number 必须是有限数字".to_owned());
                        }
                        serde_json::json!(number)
                    }
                    Some("integer") => {
                        let text = payload
                            .as_str()
                            .ok_or_else(|| "wire integer 必须是字符串".to_owned())?;
                        let parsed = text
                            .parse::<i64>()
                            .map_err(|_| format!("非法或越界整数: {text}"))?;
                        if parsed.to_string() != text {
                            return Err(format!("非规范整数: {text}"));
                        }
                        serde_json::json!(parsed)
                    }
                    Some(other) => return Err(format!("未知 wire 标量类型: {other}")),
                    None => return Err("wire 标量 kind 必须是字符串".to_owned()),
                };
                *value = decoded;
                return Ok(());
            }
        }
        for child in object.values_mut() {
            decode_wire_scalars(child)?;
        }
        return Ok(());
    }
    if let Some(array) = value.as_array_mut() {
        for child in array {
            decode_wire_scalars(child)?;
        }
    }
    Ok(())
}

fn yaml_bytes(value: &impl Serialize) -> Result<Vec<u8>, String> {
    let mut text = serde_saphyr::to_string(value).map_err(display_error)?;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    Ok(text.into_bytes())
}

const TRANSACTION_VERSION: u32 = 1;

#[cfg(test)]
#[allow(dead_code)]
fn retain_changed_writes(writes: Vec<(PathBuf, Vec<u8>)>) -> Vec<(PathBuf, Vec<u8>)> {
    writes
        .into_iter()
        .filter(|(path, bytes)| match fs::read(path) {
            Ok(existing) => existing != *bytes,
            Err(_) => true,
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TransactionState {
    Prepared,
    Applying,
    Committed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TransactionFile {
    relative_path: String,
    new_sha256: Option<String>,
    old_sha256: Option<String>,
    existed: bool,
    #[serde(default)]
    delete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TransactionJournal {
    version: u32,
    transaction_id: String,
    state: TransactionState,
    files: Vec<TransactionFile>,
    applied: usize,
}

#[allow(dead_code)]
fn atomic_write_batch(
    root: &Path,
    writes: &[(PathBuf, Vec<u8>)],
) -> Result<String, std::io::Error> {
    atomic_write_batch_with_deletes(root, writes, &[])
}

fn atomic_write_batch_with_deletes(
    root: &Path,
    writes: &[(PathBuf, Vec<u8>)],
    deletes: &[PathBuf],
) -> Result<String, std::io::Error> {
    if writes.is_empty() && deletes.is_empty() {
        return Ok(String::new());
    }
    let save_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string();
    let metadata_root = root.join(".vectspace");
    let temporary_root = metadata_root.join("tmp").join(&save_id);
    let backup_root = metadata_root.join("backups").join(&save_id);
    let journal_path = temporary_root.join("journal.json");
    let mut journal = TransactionJournal {
        version: TRANSACTION_VERSION,
        transaction_id: save_id.clone(),
        state: TransactionState::Prepared,
        files: Vec::with_capacity(writes.len()),
        applied: 0,
    };
    let operation = (|| -> Result<(), std::io::Error> {
        for (target, bytes) in writes {
            let relative = checked_project_relative(root, target)?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let temporary = temporary_root.join(relative);
            let backup = backup_root.join(relative);
            if let Some(parent) = temporary.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut file = File::create(&temporary)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            let existed = target.is_file();
            let old_sha256 = if existed {
                if let Some(parent) = backup.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(target, &backup)?;
                Some(hash_bytes(&fs::read(target)?))
            } else {
                None
            };
            journal.files.push(TransactionFile {
                relative_path: relative.to_string_lossy().replace('\\', "/"),
                new_sha256: Some(hash_bytes(bytes)),
                old_sha256,
                existed,
                delete: false,
            });
        }
        for target in deletes {
            let relative = checked_project_relative(root, target)?;
            let relative_text = relative.to_string_lossy().replace('\\', "/");
            let backup = backup_root.join(relative);
            let existed = target.is_file();
            let old_sha256 = if existed {
                if let Some(parent) = backup.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(target, &backup)?;
                Some(hash_bytes(&fs::read(target)?))
            } else {
                None
            };
            journal.files.push(TransactionFile {
                relative_path: relative_text,
                new_sha256: None,
                old_sha256,
                existed,
                delete: true,
            });
        }
        let mut paths = BTreeSet::new();
        for file in &journal.files {
            if !paths.insert(file.relative_path.clone()) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("保存事务包含重复路径: {}", file.relative_path),
                ));
            }
        }
        // The manifest is the commit marker for a content project.  Replace
        // it last so an interrupted save never advertises a document set that
        // has not been fully installed yet.
        journal.files.sort_by_key(|file| {
            if file.relative_path == "manifest.yaml" {
                1_u8
            } else {
                0_u8
            }
        });
        write_transaction_journal(&journal_path, &journal)?;
        journal.state = TransactionState::Applying;
        write_transaction_journal(&journal_path, &journal)?;

        for index in journal.applied..journal.files.len() {
            let item = &journal.files[index];
            let target = project_child(root, &item.relative_path)?;
            let temporary = project_child(&temporary_root, &item.relative_path)?;
            if item.delete {
                if target.exists() {
                    fs::remove_file(&target)?;
                }
            } else {
                replace_file(&temporary, &target)?;
            }
            journal.applied = index + 1;
            write_transaction_journal(&journal_path, &journal)?;
        }
        journal.state = TransactionState::Committed;
        write_transaction_journal(&journal_path, &journal)?;
        Ok(())
    })();

    match operation {
        Ok(()) => {
            // The project is already committed at this point.  Cleanup is
            // best-effort; a later open can remove a committed journal.
            if let Err(error) = fs::remove_dir_all(&temporary_root) {
                eprintln!("保存事务临时目录清理失败（不影响本次保存）: {error}");
            }
            if let Err(error) = prune_backup_generations(&metadata_root.join("backups"), 10) {
                eprintln!("保存备份清理失败（不影响本次保存）: {error}");
            }
            Ok(save_id)
        }
        Err(error) => {
            // Before the Applying marker no project target has been touched.
            // Once applying starts, restore every target from its validated
            // backup immediately so a synchronous error is transactional too.
            if matches!(journal.state, TransactionState::Applying) {
                if let Err(rollback) = restore_transaction(root, &backup_root, &journal) {
                    return Err(std::io::Error::new(
                        error.kind(),
                        format!("保存事务失败: {error}；立即回滚失败: {rollback}"),
                    ));
                }
            }
            if let Err(cleanup) = fs::remove_dir_all(&temporary_root) {
                eprintln!("失败保存的临时目录清理失败: {cleanup}");
            }
            if let Err(cleanup) = fs::remove_dir_all(&backup_root) {
                eprintln!("失败保存的备份清理失败: {cleanup}");
            }
            Err(error)
        }
    }
}

fn checked_project_relative<'a>(root: &Path, target: &'a Path) -> Result<&'a Path, std::io::Error> {
    let relative = target.strip_prefix(root).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("保存目标不在项目目录内: {}", target.display()),
        )
    })?;
    let text = relative.to_string_lossy().replace('\\', "/");
    safe_relative_path(&text)
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
    Ok(relative)
}

fn project_child(root: &Path, relative: &str) -> Result<PathBuf, std::io::Error> {
    safe_relative_path(relative)
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
    let child = root.join(relative);
    if !child.starts_with(root) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("路径逃逸项目目录: {relative}"),
        ));
    }
    Ok(child)
}

/// Replace a project document without exposing a delete-then-rename gap on
/// Windows.  The non-Windows implementation is kept for cross-platform unit
/// tests; Windows is the supported shipping target and uses the kernel's
/// replace-existing operation with write-through semantics.
#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> Result<(), std::io::Error> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(target.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| std::io::Error::other(error.to_string()))
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> Result<(), std::io::Error> {
    if target.exists() {
        fs::remove_file(target)?;
    }
    fs::rename(source, target)
}

fn write_transaction_journal(
    path: &Path,
    journal: &TransactionJournal,
) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(journal)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string()))?;
    let temporary = path.with_extension("json.tmp");
    let mut file = File::create(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    // Keep the recovery marker itself atomic.  If the process is interrupted
    // while recording progress, the previous complete journal remains
    // readable and recovery can safely resume from it.
    replace_file(&temporary, path)
}

fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Resume or roll back an interrupted editor save before the catalog is
/// opened.  Every journal path is validated before touching the filesystem;
/// no path supplied by a journal can escape its project root.
fn recover_pending_transactions(root: &Path) -> Result<(), std::io::Error> {
    let tmp_root = root.join(".vectspace").join("tmp");
    if !tmp_root.is_dir() {
        return Ok(());
    }
    let mut transactions = fs::read_dir(&tmp_root)?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .collect::<Vec<_>>();
    transactions.sort_by_key(std::fs::DirEntry::file_name);
    for transaction in transactions {
        let transaction_root = transaction.path();
        let journal_path = transaction_root.join("journal.json");
        if !journal_path.is_file() {
            // An empty temporary directory is never a committed project file;
            // it is safe to remove only this transaction directory.
            fs::remove_dir_all(&transaction_root)?;
            continue;
        }
        let bytes = fs::read(&journal_path)?;
        let journal: TransactionJournal = serde_json::from_slice(&bytes).map_err(|error| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "无法读取保存事务 journal {}: {error}",
                    journal_path.display()
                ),
            )
        })?;
        let directory_name = transaction_root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if journal.version != TRANSACTION_VERSION
            || journal.transaction_id.is_empty()
            || journal.transaction_id != directory_name
            || !journal
                .transaction_id
                .bytes()
                .all(|character| character.is_ascii_digit())
            || journal.applied > journal.files.len()
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("保存事务 journal 无效: {}", journal_path.display()),
            ));
        }
        // Validate the complete manifest before applying any entry.  This is
        // important when a malformed or hand-edited journal is encountered.
        let mut paths = BTreeSet::new();
        for file in &journal.files {
            if !paths.insert(file.relative_path.clone()) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("保存事务包含重复路径: {}", file.relative_path),
                ));
            }
            project_child(root, &file.relative_path)?;
            if !file.delete {
                project_child(&transaction_root, &file.relative_path)?;
            }
            project_child(
                &root
                    .join(".vectspace")
                    .join("backups")
                    .join(&journal.transaction_id),
                &file.relative_path,
            )?;
        }
        if matches!(journal.state, TransactionState::Committed) {
            fs::remove_dir_all(&transaction_root)?;
            continue;
        }
        let backup_root = root
            .join(".vectspace")
            .join("backups")
            .join(&journal.transaction_id);
        let mut can_finish = true;
        for file in &journal.files {
            let target = project_child(root, &file.relative_path)?;
            let staged = project_child(&transaction_root, &file.relative_path)?;
            let current_hash = fs::read(&target).ok().map(|bytes| hash_bytes(&bytes));
            if file.delete {
                continue;
            }
            if current_hash.as_deref() != file.new_sha256.as_deref() && !staged.is_file() {
                can_finish = false;
                break;
            }
        }
        if can_finish {
            for file in &journal.files {
                let target = project_child(root, &file.relative_path)?;
                let staged = project_child(&transaction_root, &file.relative_path)?;
                let current_hash = fs::read(&target).ok().map(|bytes| hash_bytes(&bytes));
                if file.delete {
                    if target.exists() {
                        fs::remove_file(target)?;
                    }
                    continue;
                }
                if current_hash.as_deref() == file.new_sha256.as_deref() {
                    continue;
                }
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                replace_file(&staged, &target)?;
            }
        } else {
            restore_transaction(root, &backup_root, &journal)?;
        }
        fs::remove_dir_all(&transaction_root)?;
    }
    Ok(())
}

fn restore_transaction(
    root: &Path,
    backup_root: &Path,
    journal: &TransactionJournal,
) -> Result<(), std::io::Error> {
    for file in &journal.files {
        let target = project_child(root, &file.relative_path)?;
        let backup = project_child(backup_root, &file.relative_path)?;
        if file.existed {
            let bytes = fs::read(&backup).map_err(|error| {
                std::io::Error::new(
                    error.kind(),
                    format!("保存事务无法从备份恢复 {}: {error}", file.relative_path),
                )
            })?;
            if file.old_sha256.as_deref() != Some(hash_bytes(&bytes).as_str()) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("保存事务备份校验失败: {}", file.relative_path),
                ));
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            // Copy the validated backup to a sibling temporary first, then
            // replace the target atomically.  A crash during rollback leaves
            // the journal and original backup intact for the next recovery
            // attempt instead of exposing a partially copied YAML file.
            let temporary = backup.with_extension("restore.tmp");
            fs::copy(&backup, &temporary)?;
            replace_file(&temporary, &target)?;
        } else if target.exists() {
            fs::remove_file(target)?;
        }
    }
    Ok(())
}

fn prune_backup_generations(root: &Path, retain: usize) -> Result<(), std::io::Error> {
    if !root.exists() {
        return Ok(());
    }
    let mut generations = fs::read_dir(root)?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .collect::<Vec<_>>();
    generations.sort_by_key(std::fs::DirEntry::file_name);
    let remove_count = generations.len().saturating_sub(retain);
    for generation in generations.into_iter().take(remove_count) {
        fs::remove_dir_all(generation.path())?;
    }
    Ok(())
}

fn project_fingerprint(root: &Path, manifest: &ContentManifest) -> Result<String, std::io::Error> {
    let mut hasher = Sha256::new();
    let mut paths = Vec::with_capacity(manifest.scenes.len() + manifest.ui_motions.len() + 3);
    paths.push(root.join("manifest.yaml"));
    for path in &manifest.scenes {
        paths.push(root.join(path));
    }
    for path in &manifest.ui_motions {
        paths.push(root.join(path));
    }
    if let Some(path) = &manifest.story_flow {
        paths.push(root.join(path));
    }
    paths.push(root.join(LAYOUT_RELATIVE_PATH));
    for path in paths {
        hasher.update(path.to_string_lossy().as_bytes());
        match fs::read(&path) {
            Ok(bytes) => hasher.update(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                hasher.update(b"<missing>")
            }
            Err(error) => return Err(error),
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn safe_relative_path(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("只允许项目目录内的相对路径: {value}"));
    }
    Ok(())
}

fn analyze_catalog(catalog: &ContentCatalog) -> Vec<EditorDiagnostic> {
    let mut diagnostics = Vec::new();
    let mut reachable = BTreeSet::new();
    let entry_scene = match catalog.scenes.get(&catalog.manifest.entry_scene) {
        Some(scene) => scene,
        None => return diagnostics,
    };
    let mut queue = VecDeque::from([(entry_scene.id.clone(), entry_scene.entry.clone())]);
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
    }

    for (scene_id, scene) in &catalog.scenes {
        for node_id in scene.nodes.keys() {
            if !reachable.contains(&(scene_id.clone(), node_id.clone())) {
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

    let mut referenced_assets = BTreeSet::new();
    for scene in catalog.scenes.values() {
        for node in scene.nodes.values() {
            collect_node_assets(node, &mut referenced_assets);
        }
    }
    for id in catalog.manifest.assets.keys() {
        if !referenced_assets.contains(id.as_str()) {
            diagnostics.push(EditorDiagnostic {
                severity: DiagnosticSeverity::Info,
                code: "unused_asset".to_owned(),
                message: format!("素材 {id} 尚未被剧情节点引用"),
                scene_id: None,
                node_id: None,
            });
        }
    }

    diagnostics.extend(find_immediate_cycles(catalog));
    diagnostics
}

fn successors(scene_id: &str, node: &SceneNode) -> Vec<(String, String)> {
    let local = |target: &str| (scene_id.to_owned(), target.to_owned());
    match node {
        SceneNode::Background { next, .. }
        | SceneNode::Sprite { next, .. }
        | SceneNode::Clear { next, .. }
        | SceneNode::Say { next, .. }
        | SceneNode::LongText { next, .. }
        | SceneNode::Set { next, .. }
        | SceneNode::Playback { next, .. }
        | SceneNode::Wait { next, .. }
        | SceneNode::Bgm { next, .. }
        | SceneNode::Sfx { next, .. }
        | SceneNode::Camera { next, .. }
        | SceneNode::ScreenEffect { next, .. }
        | SceneNode::DialogueUi { next, .. }
        | SceneNode::UiMotionSet { next, .. }
        | SceneNode::UiMotionPlay { next, .. } => vec![local(next)],
        SceneNode::Timeline { next, .. } => vec![local(next)],
        SceneNode::Choice { choices } => choices.iter().map(|choice| local(&choice.next)).collect(),
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
        | SceneNode::Camera {
            await_completion, ..
        }
        | SceneNode::ScreenEffect {
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
        SceneNode::Set { .. }
        | SceneNode::Condition { .. }
        | SceneNode::Playback { .. }
        | SceneNode::Jump { .. }
        | SceneNode::UiMotionSet { .. }
        | SceneNode::Sfx { .. } => true,
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

fn collect_node_assets<'a>(node: &'a SceneNode, output: &mut BTreeSet<&'a str>) {
    match node {
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
        | SceneNode::Sfx { asset: id, .. } => {
            output.insert(id);
        }
        SceneNode::LongText {
            paper: Some(id), ..
        } => {
            output.insert(id);
        }
        SceneNode::Timeline { tracks, events, .. } => {
            for track in tracks {
                match track {
                    TimelineTrack::Sprite {
                        asset: Some(asset), ..
                    } => {
                        output.insert(asset);
                    }
                    TimelineTrack::Video { asset, .. } => {
                        output.insert(asset);
                    }
                    TimelineTrack::Sprite { asset: None, .. }
                    | TimelineTrack::Camera { .. }
                    | TimelineTrack::Bgm { .. } => {}
                }
            }
            for event in events {
                if let TimelineEvent::Sfx { asset, .. } = event {
                    output.insert(asset);
                }
            }
        }
        _ => {}
    }
}

fn asset_folder(kind: AssetKind) -> &'static str {
    match kind {
        AssetKind::Background => "backgrounds",
        AssetKind::Sprite => "sprites",
        AssetKind::Gui => "gui",
        AssetKind::Bgm | AssetKind::Sfx => "audio",
        AssetKind::Font => "fonts",
        AssetKind::Video => "videos",
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
}

fn display_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn command_error(code: WireCommandErrorCode, error: impl std::fmt::Display) -> WireCommandError {
    WireCommandError::new(code, error.to_string())
}

fn validation_command_error(error: impl std::fmt::Display) -> WireCommandError {
    command_error(WireCommandErrorCode::Validation, error)
}

fn io_command_error(error: impl std::fmt::Display) -> WireCommandError {
    command_error(WireCommandErrorCode::Io, error)
}

fn asset_command_error(error: impl std::fmt::Display) -> WireCommandError {
    command_error(WireCommandErrorCode::Asset, error)
}

fn internal_command_error(error: impl std::fmt::Display) -> WireCommandError {
    command_error(WireCommandErrorCode::Internal, error)
}

#[cfg(windows)]
fn disable_browser_features<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> tauri::Result<()> {
    use windows::core::Interface;

    window.with_webview(|webview| unsafe {
        let controller = webview.controller();
        let core = controller
            .CoreWebView2()
            .expect("WebView2 CoreWebView2 interface is unavailable");
        let settings = core.Settings().expect("WebView2 settings are unavailable");
        let _ = settings.SetAreDefaultContextMenusEnabled(false);
        let _ = settings.SetAreDevToolsEnabled(false);
        let _ = settings.SetIsZoomControlEnabled(false);
        if let Ok(settings3) =
            settings.cast::<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3>()
        {
            let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
        }
    })?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(windows)]
            {
                let window = app
                    .get_webview_window("main")
                    .expect("main WebView window is missing");
                disable_browser_features(&window)?;
            }
            Ok(())
        })
        .manage(EditorState::default())
        .invoke_handler(tauri::generate_handler![
            open_project,
            save_project,
            validate_project,
            import_asset,
            build_node_preview,
        ])
        .run(tauri::generate_context!())
        .expect("VECTSPACE Story Editor failed to start");
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, path::PathBuf};

    use tempfile::tempdir;
    use vectspace_core::model::{MutationValue, ScalarValue, SceneNode, VariableOperation};

    use super::*;

    fn demo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../game")
    }

    #[test]
    fn editor_payload_opens_the_real_demo_project() {
        let root = demo_root().canonicalize().unwrap();
        let catalog = ContentCatalog::from_root(root.clone()).unwrap();
        let fingerprint = project_fingerprint(&root, &catalog.manifest).unwrap();
        let payload =
            project_payload(&root, &catalog, EditorLayout::default(), fingerprint).unwrap();
        assert_eq!(payload.manifest.entry_scene, "prologue");
        let prologue = payload
            .scenes
            .iter()
            .find(|scene| scene.definition.id == "prologue")
            .expect("entry scene should be present in the editor payload");
        assert!(prologue.definition.nodes.contains_key("route_choice"));
    }

    #[test]
    fn editor_documents_use_the_game_validator() {
        let root = demo_root().canonicalize().unwrap();
        let catalog = ContentCatalog::from_root(root.clone()).unwrap();
        let mut scenes = catalog.scenes.clone();
        let scene = scenes.get_mut("prologue").unwrap();
        let SceneNode::Say { next, .. } = scene.nodes.get_mut("introduction").unwrap() else {
            panic!("fixture changed")
        };
        *next = "missing".to_owned();
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
        let error = ContentCatalog::from_documents(
            root,
            catalog.manifest.clone(),
            scenes,
            ui_motions,
            catalog.story_flow.clone(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("目标节点不存在"));
    }

    #[test]
    fn immediate_cycles_are_reported_before_runtime_limit() {
        let root = demo_root().canonicalize().unwrap();
        let catalog = ContentCatalog::from_root(root.clone()).unwrap();
        let mut scenes = catalog.scenes.clone();
        let scene = scenes.get_mut("prologue").unwrap();
        scene.entry = "a".to_owned();
        scene.nodes = BTreeMap::from([
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
        ]);
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
        let candidate = ContentCatalog::from_documents(
            root,
            catalog.manifest.clone(),
            scenes,
            ui_motions,
            catalog.story_flow.clone(),
        )
        .unwrap();
        assert!(analyze_catalog(&candidate)
            .iter()
            .any(|diagnostic| diagnostic.code == "immediate_cycle"));
    }

    #[test]
    fn batch_writer_keeps_backups_and_replaces_all_files() {
        let directory = tempdir().unwrap();
        let first = directory.path().join("first.yaml");
        let second = directory.path().join("nested/second.yaml");
        fs::write(&first, b"old").unwrap();
        atomic_write_batch(
            directory.path(),
            &[
                (first.clone(), b"new first".to_vec()),
                (second.clone(), b"new second".to_vec()),
            ],
        )
        .unwrap();
        assert_eq!(fs::read(&first).unwrap(), b"new first");
        assert_eq!(fs::read(&second).unwrap(), b"new second");
        let backups = directory.path().join(".vectspace/backups");
        let generation = fs::read_dir(backups).unwrap().next().unwrap().unwrap();
        assert_eq!(
            fs::read(generation.path().join("first.yaml")).unwrap(),
            b"old"
        );
    }

    #[test]
    fn unchanged_documents_are_excluded_before_atomic_save() {
        let directory = tempdir().unwrap();
        let unchanged = directory.path().join("unchanged.yaml");
        let changed = directory.path().join("changed.yaml");
        fs::write(&unchanged, b"same").unwrap();
        fs::write(&changed, b"old").unwrap();

        let writes = retain_changed_writes(vec![
            (unchanged, b"same".to_vec()),
            (changed.clone(), b"new".to_vec()),
        ]);
        assert_eq!(writes, vec![(changed, b"new".to_vec())]);
    }

    #[test]
    fn recovery_finishes_a_transaction_when_staged_files_are_available() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let target = root.join("scene.yaml");
        fs::write(&target, b"old").unwrap();
        let transaction_id = "123";
        let transaction_root = root.join(".vectspace/tmp").join(transaction_id);
        let backup_root = root.join(".vectspace/backups").join(transaction_id);
        fs::create_dir_all(&transaction_root).unwrap();
        fs::create_dir_all(&backup_root).unwrap();
        fs::write(transaction_root.join("scene.yaml"), b"new").unwrap();
        fs::copy(&target, backup_root.join("scene.yaml")).unwrap();
        let journal = TransactionJournal {
            version: TRANSACTION_VERSION,
            transaction_id: transaction_id.to_owned(),
            state: TransactionState::Applying,
            files: vec![TransactionFile {
                relative_path: "scene.yaml".to_owned(),
                new_sha256: Some(hash_bytes(b"new")),
                old_sha256: Some(hash_bytes(b"old")),
                existed: true,
                delete: false,
            }],
            applied: 0,
        };
        write_transaction_journal(&transaction_root.join("journal.json"), &journal).unwrap();

        recover_pending_transactions(root).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert!(!transaction_root.exists());
    }

    #[test]
    fn recovery_restores_the_old_version_when_staged_file_is_missing() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let target = root.join("scene.yaml");
        fs::write(&target, b"partial").unwrap();
        let transaction_id = "456";
        let transaction_root = root.join(".vectspace/tmp").join(transaction_id);
        let backup_root = root.join(".vectspace/backups").join(transaction_id);
        fs::create_dir_all(&transaction_root).unwrap();
        fs::create_dir_all(&backup_root).unwrap();
        fs::write(backup_root.join("scene.yaml"), b"old").unwrap();
        let journal = TransactionJournal {
            version: TRANSACTION_VERSION,
            transaction_id: transaction_id.to_owned(),
            state: TransactionState::Applying,
            files: vec![TransactionFile {
                relative_path: "scene.yaml".to_owned(),
                new_sha256: Some(hash_bytes(b"new")),
                old_sha256: Some(hash_bytes(b"old")),
                existed: true,
                delete: false,
            }],
            applied: 0,
        };
        write_transaction_journal(&transaction_root.join("journal.json"), &journal).unwrap();

        recover_pending_transactions(root).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"old");
        assert!(!transaction_root.exists());
    }

    #[test]
    fn recovery_rejects_path_traversal_before_mutating_files() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let transaction_id = "789";
        let transaction_root = root.join(".vectspace/tmp").join(transaction_id);
        fs::create_dir_all(&transaction_root).unwrap();
        let journal = TransactionJournal {
            version: TRANSACTION_VERSION,
            transaction_id: transaction_id.to_owned(),
            state: TransactionState::Applying,
            files: vec![TransactionFile {
                relative_path: "../outside.yaml".to_owned(),
                new_sha256: Some(hash_bytes(b"bad")),
                old_sha256: None,
                existed: false,
                delete: false,
            }],
            applied: 0,
        };
        write_transaction_journal(&transaction_root.join("journal.json"), &journal).unwrap();

        assert!(recover_pending_transactions(root).is_err());
        assert!(transaction_root.exists());
    }
}
