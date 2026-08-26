use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{self, File},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use vectspace_core::{
    content::ContentCatalog,
    model::{
        AdvanceSource, AssetKind, ContentManifest, ResolvedAsset, RuntimeUpdate, SceneDefinition,
        SceneNode,
    },
    runtime::{RuntimeEngine, RuntimeError},
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
    preview: Option<RuntimeEngine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorProject {
    root: String,
    manifest: ContentManifest,
    scenes: Vec<EditorSceneFile>,
    layout: EditorLayout,
    assets: Vec<EditorAsset>,
    diagnostics: Vec<EditorDiagnostic>,
    fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorSceneFile {
    path: String,
    definition: SceneDefinition,
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
}

impl Default for EditorLayout {
    fn default() -> Self {
        Self {
            version: 1,
            scenes: BTreeMap::new(),
        }
    }
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveProjectRequest {
    manifest: ContentManifest,
    scenes: Vec<EditorSceneFile>,
    layout: EditorLayout,
    expected_fingerprint: String,
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
) -> Result<EditorProject, String> {
    let root = resolve_content_root(Path::new(&root)).map_err(display_error)?;
    let catalog = ContentCatalog::from_root(root.clone()).map_err(display_error)?;
    app.asset_protocol_scope()
        .allow_directory(catalog.assets_root(), true)
        .map_err(display_error)?;

    let fingerprint = project_fingerprint(&root, &catalog.manifest).map_err(display_error)?;
    let layout = read_layout(&root)?;
    let project = project_payload(&root, &catalog, layout, fingerprint.clone())?;
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "编辑器项目锁已损坏".to_owned())?;
    *guard = Some(ProjectSession {
        root,
        catalog,
        fingerprint,
        preview: None,
    });
    Ok(project)
}

#[tauri::command]
fn save_project(
    request: SaveProjectRequest,
    state: State<'_, EditorState>,
) -> Result<EditorProject, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "编辑器项目锁已损坏".to_owned())?;
    let session = guard.as_mut().ok_or("尚未打开项目")?;

    let actual_fingerprint =
        project_fingerprint(&session.root, &session.catalog.manifest).map_err(display_error)?;
    if request.expected_fingerprint != session.fingerprint
        || actual_fingerprint != session.fingerprint
    {
        return Err(
            "项目文件已被其他程序修改。请重新打开项目后再保存，以免覆盖外部更改。".to_owned(),
        );
    }

    let scenes = validate_scene_file_set(&request.manifest, &request.scenes)?;
    let candidate =
        ContentCatalog::from_documents(session.root.clone(), request.manifest.clone(), scenes)
            .map_err(display_error)?;

    let writes = serialize_project(&session.root, &request)?;
    atomic_write_batch(&writes).map_err(display_error)?;

    let fingerprint =
        project_fingerprint(&session.root, &request.manifest).map_err(display_error)?;
    session.catalog = candidate;
    session.fingerprint.clone_from(&fingerprint);
    session.preview = None;
    project_payload(&session.root, &session.catalog, request.layout, fingerprint)
}

#[tauri::command]
fn validate_project(
    request: SaveProjectRequest,
    state: State<'_, EditorState>,
) -> Result<Vec<EditorDiagnostic>, String> {
    let guard = state
        .session
        .lock()
        .map_err(|_| "编辑器项目锁已损坏".to_owned())?;
    let session = guard.as_ref().ok_or("尚未打开项目")?;
    let scenes = validate_scene_file_set(&request.manifest, &request.scenes)?;
    let candidate = ContentCatalog::from_documents(session.root.clone(), request.manifest, scenes)
        .map_err(display_error)?;
    Ok(analyze_catalog(&candidate))
}

#[tauri::command]
fn import_asset(
    request: ImportAssetRequest,
    app: AppHandle,
    state: State<'_, EditorState>,
) -> Result<ImportedAsset, String> {
    if !valid_identifier(&request.id) {
        return Err(
            "素材 ID 只能包含 ASCII 字母、数字、点、下划线或连字符，长度为 1–128。".to_owned(),
        );
    }
    let guard = state
        .session
        .lock()
        .map_err(|_| "编辑器项目锁已损坏".to_owned())?;
    let session = guard.as_ref().ok_or("尚未打开项目")?;
    if session.catalog.manifest.assets.contains_key(&request.id) {
        return Err(format!("素材 ID 已存在: {}", request.id));
    }

    let source = fs::canonicalize(&request.source_path).map_err(display_error)?;
    if !source.is_file() {
        return Err("选择的素材不是文件".to_owned());
    }
    let file_name = source.file_name().ok_or("无法识别素材文件名")?.to_owned();
    let folder = asset_folder(request.kind);
    let destination_dir = session.root.join("assets").join(folder);
    fs::create_dir_all(&destination_dir).map_err(display_error)?;
    let destination = destination_dir.join(file_name);
    if destination.exists() {
        return Err(format!("目标素材文件已存在: {}", destination.display()));
    }
    fs::copy(&source, &destination).map_err(display_error)?;
    let canonical = fs::canonicalize(&destination).map_err(display_error)?;
    app.asset_protocol_scope()
        .allow_file(&canonical)
        .map_err(display_error)?;
    let relative = canonical
        .strip_prefix(
            session
                .root
                .join("assets")
                .canonicalize()
                .map_err(display_error)?,
        )
        .map_err(display_error)?
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
fn preview_start(state: State<'_, EditorState>) -> Result<RuntimeUpdate, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "编辑器项目锁已损坏".to_owned())?;
    let session = guard.as_mut().ok_or("尚未打开项目")?;
    let mut runtime = RuntimeEngine::new(&session.catalog).map_err(display_error)?;
    let update = runtime
        .start_new_game(&session.catalog)
        .map_err(display_error)?;
    session.preview = Some(runtime);
    Ok(update)
}

#[tauri::command]
fn preview_advance(
    expected_revision: u64,
    source: AdvanceSource,
    state: State<'_, EditorState>,
) -> Result<RuntimeUpdate, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "编辑器项目锁已损坏".to_owned())?;
    let session = guard.as_mut().ok_or("尚未打开项目")?;
    transact_preview(session, |runtime, catalog| {
        runtime.advance(catalog, expected_revision, source)
    })
}

#[tauri::command]
fn preview_choose(
    choice_id: String,
    expected_revision: u64,
    state: State<'_, EditorState>,
) -> Result<RuntimeUpdate, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "编辑器项目锁已损坏".to_owned())?;
    let session = guard.as_mut().ok_or("尚未打开项目")?;
    transact_preview(session, |runtime, catalog| {
        runtime.choose(catalog, &choice_id, expected_revision)
    })
}

#[tauri::command]
fn preview_presentation_complete(
    update_id: u64,
    state: State<'_, EditorState>,
) -> Result<RuntimeUpdate, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "编辑器项目锁已损坏".to_owned())?;
    let session = guard.as_mut().ok_or("尚未打开项目")?;
    transact_preview(session, |runtime, catalog| {
        runtime.presentation_complete(catalog, update_id)
    })
}

fn transact_preview(
    session: &mut ProjectSession,
    operation: impl FnOnce(&mut RuntimeEngine, &ContentCatalog) -> Result<RuntimeUpdate, RuntimeError>,
) -> Result<RuntimeUpdate, String> {
    let mut candidate = session.preview.as_ref().ok_or("预览尚未开始")?.clone();
    let update = operation(&mut candidate, &session.catalog).map_err(display_error)?;
    session.preview = Some(candidate);
    Ok(update)
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

fn serialize_project(
    root: &Path,
    request: &SaveProjectRequest,
) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    let mut writes = Vec::with_capacity(request.scenes.len() + 2);
    writes.push((root.join("manifest.yaml"), yaml_bytes(&request.manifest)?));
    for scene in &request.scenes {
        safe_relative_path(&scene.path)?;
        writes.push((root.join(&scene.path), yaml_bytes(&scene.definition)?));
    }
    let layout = serde_json::to_vec_pretty(&request.layout).map_err(display_error)?;
    writes.push((root.join(LAYOUT_RELATIVE_PATH), layout));
    Ok(writes)
}

fn yaml_bytes(value: &impl Serialize) -> Result<Vec<u8>, String> {
    let mut text = serde_saphyr::to_string(value).map_err(display_error)?;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    Ok(text.into_bytes())
}

fn atomic_write_batch(writes: &[(PathBuf, Vec<u8>)]) -> Result<(), std::io::Error> {
    #[derive(Debug)]
    struct Prepared {
        target: PathBuf,
        temporary: PathBuf,
        backup: PathBuf,
        existed: bool,
    }

    let mut prepared = Vec::with_capacity(writes.len());
    for (target, bytes) in writes {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = sidecar_path(target, "vectspace.tmp");
        let backup = sidecar_path(target, "vectspace.bak");
        let mut file = File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        let existed = target.exists();
        if existed {
            fs::copy(target, &backup)?;
        }
        prepared.push(Prepared {
            target: target.clone(),
            temporary,
            backup,
            existed,
        });
    }

    for (index, item) in prepared.iter().enumerate() {
        let replace_result = (|| {
            if item.target.exists() {
                fs::remove_file(&item.target)?;
            }
            fs::rename(&item.temporary, &item.target)
        })();
        if let Err(error) = replace_result {
            for rollback in prepared.iter().take(index + 1) {
                if rollback.existed && rollback.backup.exists() {
                    let _ = fs::copy(&rollback.backup, &rollback.target);
                } else if !rollback.existed && rollback.target.exists() {
                    let _ = fs::remove_file(&rollback.target);
                }
            }
            for cleanup in &prepared {
                if cleanup.temporary.exists() {
                    let _ = fs::remove_file(&cleanup.temporary);
                }
            }
            return Err(error);
        }
    }
    Ok(())
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy())
        .unwrap_or_default();
    path.with_file_name(format!("{file_name}.{suffix}"))
}

fn project_fingerprint(root: &Path, manifest: &ContentManifest) -> Result<String, std::io::Error> {
    let mut hasher = Sha256::new();
    let mut paths = Vec::with_capacity(manifest.scenes.len() + 2);
    paths.push(root.join("manifest.yaml"));
    for path in &manifest.scenes {
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
        | SceneNode::Say { next, .. }
        | SceneNode::Set { next, .. }
        | SceneNode::Playback { next, .. }
        | SceneNode::Wait { next, .. }
        | SceneNode::Bgm { next, .. }
        | SceneNode::Sfx { next, .. }
        | SceneNode::Camera { next, .. }
        | SceneNode::ScreenEffect { next, .. }
        | SceneNode::DialogueUi { next, .. } => vec![local(next)],
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
        | SceneNode::Choice { .. }
        | SceneNode::Wait { .. }
        | SceneNode::End => false,
        SceneNode::Background {
            await_completion, ..
        }
        | SceneNode::Sprite {
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
        } => !await_completion,
        SceneNode::Set { .. }
        | SceneNode::Condition { .. }
        | SceneNode::Playback { .. }
        | SceneNode::Jump { .. }
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
            preview_start,
            preview_advance,
            preview_choose,
            preview_presentation_complete,
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
        assert_eq!(payload.scenes.len(), 1);
        assert!(payload.scenes[0]
            .definition
            .nodes
            .contains_key("route_choice"));
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
        let error =
            ContentCatalog::from_documents(root, catalog.manifest.clone(), scenes).unwrap_err();
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
        let candidate =
            ContentCatalog::from_documents(root, catalog.manifest.clone(), scenes).unwrap();
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
        atomic_write_batch(&[
            (first.clone(), b"new first".to_vec()),
            (second.clone(), b"new second".to_vec()),
        ])
        .unwrap();
        assert_eq!(fs::read(&first).unwrap(), b"new first");
        assert_eq!(fs::read(&second).unwrap(), b"new second");
        assert_eq!(
            fs::read(sidecar_path(&first, "vectspace.bak")).unwrap(),
            b"old"
        );
    }
}
