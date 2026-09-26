use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use image::{GenericImageView, ImageReader};
use serde::{de::DeserializeOwned, Deserialize, Serialize, Serializer};
use sha2::{Digest, Sha256};
use symphonia::core::{
    codecs::CODEC_TYPE_NULL, formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions,
    probe::Hint,
};
use tauri::{AppHandle, Manager, State};
use ttf_parser::Face;
use vectspace_core::{
    content::ContentCatalog,
    model::{
        AssetDefinition, AssetKind, AdvanceSource, ButtonTemplate, ChapterMapDefinition, ChapterMapReplay,
        ChapterMapReveal, ChoiceSnapshot, ContentManifest, CurtainFill, ImageAnimationDefinition,
        PresentationOutcome, ResolvedAsset, SceneDefinition, SceneNode, SpriteActionDefinition,
        StoryLocation, TimelineEvent, TimelineTrack, UiMotionPreset, VariableMap,
    },
    runtime::{
        PreviewChoiceDecision as CorePreviewChoiceDecision, PreviewRunResult, RuntimeEngine,
    },
};
use vectspace_protocol::{
    variable_map_from_wire, WireAssetDiagnostic, WireAssetInspection, WireAssetKind,
    WireAssetMetadata, WireAssetReuseCandidate, WireCommandError, WireCommandErrorCode,
    WireImportedAsset, WireInspectAssetImportsRequest, WireRuntimeSnapshot, WireRuntimeUpdate,
    WireStageAssetImportsRequest, WireU64, WireVariableMap,
};

const LAYOUT_RELATIVE_PATH: &str = ".vectspace/layout-v1.json";
const MAX_PENDING_ASSET_INSPECTIONS: usize = 512;
const MAX_FONT_INSPECTION_BYTES: u64 = 64 * 1024 * 1024;
const HASH_IO_BUFFER_SIZE: usize = 1024 * 1024;
// Windows' common file dialog loads the user's Explorer shell extensions into
// the host process. Some real-world extension sets exhaust Rust's default
// worker-thread stack and terminate the entire editor with STATUS_STACK_OVERFLOW.
// Keep the picker isolated on a deliberately large stack and never run it on
// Tauri's IPC worker or WebView event-loop thread.
const NATIVE_PICKER_STACK_BYTES: usize = 32 * 1024 * 1024;

#[derive(Default)]
struct EditorState {
    session: Mutex<Option<ProjectSession>>,
    /// Asset imports are staged outside the managed content tree until the
    /// user saves the project.  Keeping the records in the host (rather than
    /// trusting paths sent back by the WebView) makes an import token
    /// capability-like and lets us discard abandoned imports on the next
    /// project open.
    imports: Mutex<BTreeMap<String, StagedImport>>,
    inspections: Mutex<BTreeMap<String, InspectedImport>>,
    /// A single live editor gameplay preview.  It owns the isolated runtime so
    /// `advance`/`choose`/`click_button`/`presentation_complete` act on the same
    /// world the editor is showing.  It never touches the player's save or
    /// profile: it is built with the preview override profile like
    /// `build_node_preview`.  The lock is only ever held for synchronous runtime
    /// work, never across a presentation await.
    preview: Mutex<Option<LivePreviewSession>>,
    preview_ids: AtomicU64,
}

/// Editor-owned gameplay preview session.
///
/// Kept alongside the catalog that produced the runtime because every
/// `RuntimeEngine` call takes `&ContentCatalog` and the draft (including staged
/// imports) is validated once at start.
struct LivePreviewSession {
    session_id: u64,
    catalog: ContentCatalog,
    runtime: RuntimeEngine,
}

/// Width of the per-session id window reserved for a live preview.
///
/// Each preview session owns a disjoint `[base, base + PREVIEW_ID_STRIDE)`
/// range for its revision, update and cue ids.  A restarted session can then
/// never reuse an id the presentation controller still remembers, so the
/// controller's per-update-id de-duplication cannot confuse a new presentation
/// with a still-settling old one.  A live preview emits far fewer than 2^20
/// updates/cues.
const PREVIEW_ID_STRIDE: u64 = 1 << 20;

/// Base id of a session's id window, overflow checked.
fn preview_id_namespace(session_id: u64) -> Result<u64, WireCommandError> {
    session_id
        .checked_mul(PREVIEW_ID_STRIDE)
        .ok_or_else(|| internal_command_error("预览编号空间耗尽，请重启编辑器"))
}

#[derive(Debug, Clone)]
struct StagedImport {
    token: String,
    project_root: PathBuf,
    id: String,
    kind: AssetKind,
    relative_path: String,
    staged_path: PathBuf,
    sha256: String,
    /// A staged record may point at an already managed file with the same
    /// content.  Such a record is only a new manifest registration; the
    /// save transaction must never delete or rewrite the shared file.
    owns_staged_path: bool,
    reused_from: Option<String>,
    /// Present when this staged record deliberately re-points an existing
    /// asset id at a new binary.  The recorded old path is checked again at
    /// save time and is never overwritten or deleted.
    replaces: Option<StagedReplacement>,
}

#[derive(Debug, Clone)]
struct StagedReplacement {
    old_relative_path: String,
    old_kind: AssetKind,
}

#[derive(Debug, Clone)]
struct InspectedImport {
    project_root: PathBuf,
    source_path: PathBuf,
    sha256: String,
}

struct ProjectSession {
    root: PathBuf,
    catalog: ContentCatalog,
    fingerprint: String,
    document_models: BTreeMap<String, serde_json::Value>,
}

async fn run_native_picker<T, F>(name: &str, picker: F) -> Result<T, WireCommandError>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let thread = std::thread::Builder::new()
        .name(name.to_owned())
        .stack_size(NATIVE_PICKER_STACK_BYTES)
        .spawn(picker)
        .map_err(io_command_error)?;
    let joined = tauri::async_runtime::spawn_blocking(move || thread.join())
        .await
        .map_err(|error| internal_command_error(format!("等待文件选择器失败: {error}")))?;
    joined.map_err(|_| internal_command_error("文件选择器线程意外终止"))
}

#[tauri::command]
async fn pick_project_directory() -> Result<Option<String>, WireCommandError> {
    run_native_picker("vectspace-project-picker", || {
        rfd::FileDialog::new()
            .set_title("选择 VECTSPACE 项目或 game 目录")
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
async fn pick_asset_files() -> Result<Vec<String>, WireCommandError> {
    run_native_picker("vectspace-asset-picker", || {
        rfd::FileDialog::new()
            .set_title("选择一个或多个素材文件")
            .add_filter(
                "VECTSPACE 素材",
                &[
                    "png", "jpg", "jpeg", "webp", "wav", "ogg", "mp3", "flac", "mp4", "ttf", "otf",
                ],
            )
            .pick_files()
            .unwrap_or_default()
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect()
    })
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorProject {
    root: String,
    manifest: ContentManifest,
    scenes: Vec<EditorSceneFile>,
    ui_motions: Vec<EditorUiMotionFile>,
    buttons: Vec<EditorButtonFile>,
    animations: Vec<EditorAnimationFile>,
    actions: Vec<EditorActionFile>,
    chapter_map: Option<EditorChapterMapFile>,
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
    buttons: &'a [EditorButtonFile],
    animations: &'a [EditorAnimationFile],
    actions: &'a [EditorActionFile],
    chapter_map: &'a Option<EditorChapterMapFile>,
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
            buttons: &self.buttons,
            animations: &self.animations,
            actions: &self.actions,
            chapter_map: &self.chapter_map,
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
struct EditorButtonFile {
    path: String,
    definition: ButtonTemplate,
}

/// One standalone image animation document, keyed by the manifest path that
/// lists it.  Unsaved drafts travel through the same shape as a saved file, so
/// preview and commit validate identical bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorAnimationFile {
    path: String,
    definition: ImageAnimationDefinition,
}

/// One reusable relative sprite action document, keyed by the manifest path
/// that lists it. Unsaved drafts use the same shape as on-disk files.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorActionFile {
    path: String,
    definition: SpriteActionDefinition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorChapterMapFile {
    path: String,
    definition: ChapterMapDefinition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditorAsset {
    id: String,
    kind: AssetKind,
    /// Static image path.  Animated assets carry `animation` instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    /// Loop animation document id, present for animated assets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    animation: Option<String>,
    absolute_path: String,
    #[serde(default = "default_wire_u64")]
    size_bytes: WireU64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    metadata: Option<WireAssetMetadata>,
}

fn default_wire_u64() -> WireU64 {
    WireU64::from(0)
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
struct AssetFolderLayout {
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
struct AssetLayoutMetadata {
    #[serde(default)]
    folder_id: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    hidden: bool,
}

/// Folder ids share the editable-identifier contract used by assets.
const MAX_ASSET_FOLDER_NAME_CHARS: usize = 120;
const MAX_ASSET_FOLDER_DEPTH: usize = 32;

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
    variable_overrides: WireVariableMap,
    #[serde(default)]
    choices: Vec<PreviewChoiceDecision>,
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
    buttons: Vec<EditorButtonFile>,
    animations: Vec<EditorAnimationFile>,
    actions: Vec<EditorActionFile>,
    chapter_map: Option<EditorChapterMapFile>,
    layout: EditorLayout,
    expected_fingerprint: String,
    import_tokens: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveProjectRequestRaw {
    manifest: ContentManifest,
    scenes: Vec<EditorSceneFile>,
    ui_motions: Vec<EditorUiMotionFile>,
    #[serde(default)]
    buttons: Vec<EditorButtonFile>,
    #[serde(default)]
    animations: Vec<EditorAnimationFile>,
    #[serde(default)]
    actions: Vec<EditorActionFile>,
    chapter_map: Option<EditorChapterMapFile>,
    layout: EditorLayout,
    expected_fingerprint: String,
    #[serde(default)]
    import_tokens: Vec<String>,
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
            buttons: raw.buttons,
            animations: raw.animations,
            actions: raw.actions,
            chapter_map: raw.chapter_map,
            layout: raw.layout,
            expected_fingerprint: raw.expected_fingerprint,
            import_tokens: raw.import_tokens,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[derive(Clone)]
struct ImportAssetRequest {
    id: String,
    kind: AssetKind,
    #[serde(default)]
    file_name: Option<String>,
    #[serde(default)]
    inspection_id: Option<String>,
    /// When present the staged upload replaces the binary of an existing
    /// asset.  The host requires it to equal `id` and validates the old
    /// definition before issuing a token.
    #[serde(default)]
    replace_id: Option<String>,
}

fn empty_asset_metadata(format: &str) -> WireAssetMetadata {
    WireAssetMetadata {
        format: format.to_owned(),
        width: None,
        height: None,
        duration_ms: None,
        channels: None,
        sample_rate: None,
        font_family: None,
        font_style: None,
    }
}

fn wire_asset_kind(kind: AssetKind) -> WireAssetKind {
    match kind {
        AssetKind::Background => WireAssetKind::Background,
        AssetKind::Sprite => WireAssetKind::Sprite,
        AssetKind::Gui => WireAssetKind::Gui,
        AssetKind::Bgm => WireAssetKind::Bgm,
        AssetKind::Ambience => WireAssetKind::Ambience,
        AssetKind::Sfx => WireAssetKind::Sfx,
        AssetKind::Video => WireAssetKind::Video,
        AssetKind::Font => WireAssetKind::Font,
    }
}

fn asset_kind_from_wire(kind: WireAssetKind) -> AssetKind {
    match kind {
        WireAssetKind::Background => AssetKind::Background,
        WireAssetKind::Sprite => AssetKind::Sprite,
        WireAssetKind::Gui => AssetKind::Gui,
        WireAssetKind::Bgm => AssetKind::Bgm,
        WireAssetKind::Ambience => AssetKind::Ambience,
        WireAssetKind::Sfx => AssetKind::Sfx,
        WireAssetKind::Video => AssetKind::Video,
        WireAssetKind::Font => AssetKind::Font,
    }
}

fn inferred_asset_kind(path: &Path) -> Option<WireAssetKind> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if ["png", "jpg", "jpeg", "webp"].contains(&extension.as_str()) {
        return Some(WireAssetKind::Background);
    }
    if ["ogg", "wav", "mp3", "flac"].contains(&extension.as_str()) {
        // Containers do not identify whether an author intends BGM, ambience,
        // or SFX. Preserve the historical SFX fallback while honoring the
        // explicit `ambience`/`ambient` filename convention used by the
        // editor's import queue.
        if stem
            .split(|character: char| !character.is_ascii_alphanumeric())
            .any(|token| matches!(token, "ambience" | "ambient"))
        {
            return Some(WireAssetKind::Ambience);
        }
        return Some(WireAssetKind::Sfx);
    }
    if extension == "mp4" {
        return Some(WireAssetKind::Video);
    }
    if ["ttf", "otf"].contains(&extension.as_str()) {
        return Some(WireAssetKind::Font);
    }
    None
}

fn inspect_media_source(source: &Path) -> Result<WireAssetMetadata, String> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    // ImageReader and the container parsers validate their own structure, but
    // a few formats are permissive about the caller-provided extension.  A
    // cheap signature check keeps a renamed WAV/OGG/MP3/FLAC/MP4 from being
    // registered under a misleading path and makes the import contract
    // deterministic on both Windows and the test host.
    if matches!(extension.as_str(), "ogg" | "wav" | "mp3" | "flac" | "mp4") {
        validate_media_signature(source, &extension)?;
    }
    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "webp" => {
            let reader = ImageReader::open(source)
                .map_err(|error| error.to_string())?
                .with_guessed_format()
                .map_err(|error| error.to_string())?;
            let detected = reader.format();
            let extension_matches = match (extension.as_str(), detected) {
                ("png", Some(image::ImageFormat::Png))
                | ("jpg" | "jpeg", Some(image::ImageFormat::Jpeg))
                | ("webp", Some(image::ImageFormat::WebP)) => true,
                // `with_guessed_format` is allowed to return None for a few
                // valid image readers.  The full decode below is still the
                // authoritative corruption check in that case.
                (_, None) => true,
                _ => false,
            };
            if !extension_matches {
                return Err("文件扩展名与实际图片格式不匹配".to_owned());
            }
            let format = detected
                .map(|value| format!("{value:?}"))
                .unwrap_or_else(|| extension.to_ascii_uppercase());
            // Decode rather than only reading the header. This catches
            // truncated images that happen to carry a valid signature.
            let image = reader.decode().map_err(|error| error.to_string())?;
            let (width, height) = image.dimensions();
            let mut metadata = empty_asset_metadata(&format);
            metadata.width = Some(width);
            metadata.height = Some(height);
            Ok(metadata)
        }
        "ogg" | "wav" | "mp3" | "flac" => inspect_audio_source(source),
        "mp4" => inspect_mp4_source(source),
        "ttf" | "otf" => inspect_font_source(source),
        _ => Err("不支持的素材扩展名".to_owned()),
    }
}

fn validate_media_signature(source: &Path, extension: &str) -> Result<(), String> {
    let mut file = File::open(source).map_err(|error| error.to_string())?;
    let mut prefix = [0_u8; 12];
    let length = file.read(&mut prefix).map_err(|error| error.to_string())?;
    let bytes = &prefix[..length];
    let valid = match extension {
        "ogg" => bytes.starts_with(b"OggS"),
        "wav" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE",
        "flac" => bytes.starts_with(b"fLaC"),
        "mp3" => {
            bytes.starts_with(b"ID3")
                || (bytes.len() >= 2 && bytes[0] == 0xff && (bytes[1] & 0xe0) == 0xe0)
        }
        "mp4" => bytes.len() >= 8 && &bytes[4..8] == b"ftyp",
        _ => true,
    };
    if valid {
        Ok(())
    } else {
        Err(format!("文件头与 .{extension} 扩展名不匹配"))
    }
}

fn inspect_audio_source(source: &Path) -> Result<WireAssetMetadata, String> {
    let file = File::open(source).map_err(|error| error.to_string())?;
    let source_stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = source.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            source_stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|error| error.to_string())?;
    let track = probed
        .format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "音频容器中没有有效音轨".to_owned())?;
    let params = &track.codec_params;
    let duration_ms = params
        .time_base
        .zip(params.n_frames)
        .and_then(|(time_base, frames)| {
            let time = time_base.calc_time(frames);
            let fraction = (time.frac * 1000.0).round();
            if !fraction.is_finite() || fraction < 0.0 {
                return None;
            }
            time.seconds
                .checked_mul(1000)
                .and_then(|value| value.checked_add(fraction as u64))
        });
    Ok(WireAssetMetadata {
        format: source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("audio")
            .to_ascii_uppercase(),
        width: None,
        height: None,
        duration_ms: duration_ms.map(WireU64::from),
        channels: params.channels.map(|value| value.count() as u16),
        sample_rate: params.sample_rate,
        font_family: None,
        font_style: None,
    })
}

fn inspect_mp4_source(source: &Path) -> Result<WireAssetMetadata, String> {
    let mut file = File::open(source).map_err(|error| error.to_string())?;
    let context = mp4parse::read_mp4(&mut file).map_err(|error| error.to_string())?;
    let track = context
        .tracks
        .iter()
        .find(|track| track.track_type == mp4parse::TrackType::Video)
        .ok_or_else(|| "MP4 容器中没有视频轨道".to_owned())?;
    let header = track
        .tkhd
        .as_ref()
        .ok_or_else(|| "MP4 视频轨道缺少尺寸信息".to_owned())?;
    let width = header.width >> 16;
    let height = header.height >> 16;
    if width == 0 || height == 0 {
        return Err("MP4 视频轨道尺寸无效".to_owned());
    }
    let duration_ms = track.duration.as_ref().and_then(|duration| {
        let timescale = track.timescale.as_ref()?.0;
        if timescale == 0 {
            return None;
        }
        duration.0.checked_mul(1000).map(|value| value / timescale)
    });
    Ok(WireAssetMetadata {
        format: "MP4".to_owned(),
        width: Some(width),
        height: Some(height),
        duration_ms: duration_ms.map(WireU64::from),
        channels: None,
        sample_rate: None,
        font_family: None,
        font_style: None,
    })
}

fn inspect_font_source(source: &Path) -> Result<WireAssetMetadata, String> {
    let length = fs::metadata(source)
        .map_err(|error| error.to_string())?
        .len();
    if length > MAX_FONT_INSPECTION_BYTES {
        return Err(format!(
            "字体文件过大，检查上限为 {} MiB",
            MAX_FONT_INSPECTION_BYTES / (1024 * 1024)
        ));
    }
    let bytes = fs::read(source).map_err(|error| error.to_string())?;
    let face = Face::parse(&bytes, 0).map_err(|error| format!("字体结构无效: {error:?}"))?;
    let family = face
        .names()
        .into_iter()
        .find(|name| {
            name.name_id == ttf_parser::name_id::TYPOGRAPHIC_FAMILY
                || name.name_id == ttf_parser::name_id::FAMILY
        })
        .and_then(|name| name.to_string());
    let style = face
        .names()
        .into_iter()
        .find(|name| {
            name.name_id == ttf_parser::name_id::TYPOGRAPHIC_SUBFAMILY
                || name.name_id == ttf_parser::name_id::SUBFAMILY
        })
        .and_then(|name| name.to_string());
    Ok(WireAssetMetadata {
        format: source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("font")
            .to_ascii_uppercase(),
        width: None,
        height: None,
        duration_ms: None,
        channels: None,
        sample_rate: None,
        font_family: family,
        font_style: style,
    })
}

#[tauri::command]
fn inspect_asset_imports(
    request: WireInspectAssetImportsRequest,
    state: State<'_, EditorState>,
) -> Result<Vec<WireAssetInspection>, WireCommandError> {
    let session_guard = state
        .session
        .lock()
        .map_err(|_| internal_command_error("编辑器项目锁已损坏"))?;
    let session = session_guard
        .as_ref()
        .ok_or_else(|| validation_command_error("尚未打开项目"))?;
    let mut inspections = state
        .inspections
        .lock()
        .map_err(|_| internal_command_error("素材检查锁已损坏"))?;
    let batch_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut output = Vec::with_capacity(request.source_paths.len());
    for (index, raw_path) in request.source_paths.iter().enumerate() {
        let source = fs::canonicalize(raw_path);
        let inspection_id = format!("inspection-{batch_id}-{index}");
        let mut diagnostics = Vec::new();
        let (source_path, metadata, sha256, suggested_kind) = match source {
            Ok(path) if path.is_file() => match fs::metadata(&path) {
                Ok(stat) if stat.len() > 0 => match inspect_media_source(&path) {
                    Ok(metadata) => match hash_file_streaming(&path) {
                        Ok(hash) => {
                            let suggested_kind = inferred_asset_kind(&path);
                            (Some(path), metadata, Some(hash), suggested_kind)
                        }
                        Err(error) => {
                            diagnostics.push(WireAssetDiagnostic {
                                severity: "error".to_owned(),
                                code: "io".to_owned(),
                                message: error.to_string(),
                            });
                            (None, empty_asset_metadata("unknown"), None, None)
                        }
                    },
                    Err(error) => {
                        diagnostics.push(WireAssetDiagnostic {
                            severity: "error".to_owned(),
                            code: "invalid_media".to_owned(),
                            message: error,
                        });
                        (None, empty_asset_metadata("unknown"), None, None)
                    }
                },
                Ok(_) => {
                    diagnostics.push(WireAssetDiagnostic {
                        severity: "error".to_owned(),
                        code: "empty_file".to_owned(),
                        message: "素材文件为空".to_owned(),
                    });
                    (None, empty_asset_metadata("unknown"), None, None)
                }
                Err(error) => {
                    diagnostics.push(WireAssetDiagnostic {
                        severity: "error".to_owned(),
                        code: "io".to_owned(),
                        message: error.to_string(),
                    });
                    (None, empty_asset_metadata("unknown"), None, None)
                }
            },
            Ok(_) => {
                diagnostics.push(WireAssetDiagnostic {
                    severity: "error".to_owned(),
                    code: "not_file".to_owned(),
                    message: "选择的路径不是文件".to_owned(),
                });
                (None, empty_asset_metadata("unknown"), None, None)
            }
            Err(error) => {
                diagnostics.push(WireAssetDiagnostic {
                    severity: "error".to_owned(),
                    code: "io".to_owned(),
                    message: error.to_string(),
                });
                (None, empty_asset_metadata("unknown"), None, None)
            }
        };
        let mut reuse_candidates = Vec::new();
        if let (Some(path), Some(hash)) = (&source_path, &sha256) {
            for (id, definition) in &session.catalog.manifest.assets {
                // Animated assets have no single file to compare against.
                let Some(relative) = &definition.path else {
                    continue;
                };
                let absolute = session.catalog.assets_root().join(relative);
                if hash_file_streaming(&absolute).ok().as_deref() == Some(hash) {
                    reuse_candidates.push(WireAssetReuseCandidate {
                        id: id.clone(),
                        kind: wire_asset_kind(definition.kind),
                        path: relative.clone(),
                    });
                }
            }
            let _ = path;
        }
        let inspection = WireAssetInspection {
            inspection_id: inspection_id.clone(),
            source_name: source_path
                .as_ref()
                .and_then(|path| path.file_name())
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| raw_path.clone()),
            detected_format: metadata.format.clone(),
            suggested_kind,
            size_bytes: WireU64::from(
                source_path
                    .as_ref()
                    .and_then(|path| fs::metadata(path).ok())
                    .map(|stat| stat.len())
                    .unwrap_or(0),
            ),
            sha256: sha256.clone().unwrap_or_default(),
            metadata: metadata.clone(),
            reuse_candidates,
            diagnostics,
        };
        if let (Some(source_path), Some(sha256)) = (source_path, sha256) {
            if inspection.diagnostics.is_empty() {
                inspections.insert(
                    inspection_id.clone(),
                    InspectedImport {
                        project_root: session.root.clone(),
                        source_path,
                        sha256,
                    },
                );
            }
        }
        output.push(inspection);
    }
    // Inspection IDs are short-lived capabilities.  Bound the table so a
    // user repeatedly opening the file picker cannot grow the editor process
    // forever; the oldest IDs naturally expire and the UI can re-inspect.
    let project_root = session.root.clone();
    while inspections
        .values()
        .filter(|item| item.project_root == project_root)
        .count()
        > MAX_PENDING_ASSET_INSPECTIONS
    {
        let Some(oldest) = inspections
            .iter()
            .find(|(_, item)| item.project_root == project_root)
            .map(|(id, _)| id.clone())
        else {
            break;
        };
        inspections.remove(&oldest);
    }
    Ok(output)
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
    // Only discard staged imports after the new project has loaded and its
    // asset scope has been accepted.  If the user picked an invalid project,
    // their current in-memory import session must remain recoverable.
    clear_staged_imports(&state, &root).map_err(io_command_error)?;

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

/// Reveal a host-validated registered asset (animation: its first frame).
/// Never accept an arbitrary WebView path or launch a shell interpreter.
#[tauri::command]
fn reveal_asset(id: String, state: State<'_, EditorState>) -> Result<(), WireCommandError> {
    let path = {
        let guard = state
            .session
            .lock()
            .map_err(|_| internal_command_error("编辑器项目锁已损坏"))?;
        let session = guard
            .as_ref()
            .ok_or_else(|| validation_command_error("尚未打开项目"))?;
        let resolved = session
            .catalog
            .resolve_assets(&[id])
            .map_err(validation_command_error)?;
        PathBuf::from(&resolved[0].absolute_path)
    };
    if !path.is_file() {
        return Err(validation_command_error("素材文件尚未保存到磁盘或已被移走"));
    }
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer.exe");
        command.arg(format!("/select,{}", path.display()));
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg("-R").arg(&path);
        command
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(
            path.parent()
                .ok_or_else(|| validation_command_error("素材没有所在目录"))?,
        );
        command
    };
    command.spawn().map_err(io_command_error)?;
    Ok(())
}

#[tauri::command]
async fn save_project(
    request: SaveProjectRequest,
    app: AppHandle,
) -> Result<SaveProjectResult, WireCommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        save_project_command(request, app.state::<EditorState>())
    })
    .await
    .map_err(|error| internal_command_error(format!("保存任务失败: {error}")))?
}

fn save_project_command(
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

    // A save fingerprints the same tree twice: once here to reject a stale
    // session, then again after serialization to substitute the bytes that are
    // about to be published.  Sharing one save-local cache across both passes
    // reuses the pre-save disk hashes for every unchanged file instead of
    // reading large assets from disk twice.
    //
    // The first pass is the snapshot this save commits to.  Because unchanged
    // files are reused from the cache, an external edit/delete that lands after
    // this check is not folded into the fingerprint published here; the next
    // save's fresh staleness pass detects it and fails closed instead of
    // overwriting the external change.
    let mut hash_cache = BTreeMap::new();
    let actual_fingerprint =
        project_fingerprint_cached(&session.root, &session.catalog.manifest, &mut hash_cache)
            .map_err(io_command_error)?;
    if request.expected_fingerprint != session.fingerprint
        || actual_fingerprint != session.fingerprint
    {
        return Err(WireCommandError::new(
            WireCommandErrorCode::StaleProject,
            "项目文件已被其他程序修改。请重新打开项目后再保存，以免覆盖外部更改。",
        ));
    }

    let staged = {
        let imports = state
            .imports
            .lock()
            .map_err(|_| internal_command_error("素材导入锁已损坏"))?;
        staged_imports_for_request(
            &imports,
            &session.root,
            &session.catalog.manifest.assets,
            &request,
        )
        .map_err(validation_command_error)?
    };
    validate_staged_imports(&staged).map_err(io_command_error)?;
    ensure_import_targets_available(&session.root, &staged).map_err(io_command_error)?;
    let asset_overrides = staged_asset_overrides(&staged);

    let mut result = (|| -> Result<SaveProjectResult, WireCommandError> {
        let scenes = validate_scene_file_set(&request.manifest, &request.scenes)
            .map_err(validation_command_error)?;
        let ui_motions = validate_ui_motion_file_set(&request.manifest, &request.ui_motions)
            .map_err(validation_command_error)?;
        let buttons = validate_button_file_set(&request.manifest, &request.buttons)
            .map_err(validation_command_error)?;
        let animations = validate_animation_file_set(&request.manifest, &request.animations)
            .map_err(validation_command_error)?;
        let actions = validate_action_file_set(&request.manifest, &request.actions)
            .map_err(validation_command_error)?;
        let candidate = ContentCatalog::from_documents_with_all_documents_and_actions(
            session.root.clone(),
            request.manifest.clone(),
            scenes,
            ui_motions,
            request
                .chapter_map
                .as_ref()
                .map(|file| file.definition.clone()),
            &asset_overrides,
            Some(buttons),
            Some(animations),
            Some(actions),
        )
        .map_err(validation_command_error)?;

        let all_writes =
            serialize_project(&session.root, &request).map_err(validation_command_error)?;
        // Staged binaries participate in the same journal as the manifest and
        // scene documents.  Keep them as source paths until the transaction
        // stages them; this avoids loading a batch of videos/audio into the
        // editor process memory just to write them back out.
        let staging_root = session.root.join(".vectspace").join("tmp").join("imports");
        let mut asset_targets = BTreeSet::new();
        let mut asset_writes = Vec::new();
        let mut asset_hashes = BTreeMap::new();
        let mut published_asset_paths = BTreeMap::new();
        for item in &staged {
            let target = session.root.join("assets").join(&item.relative_path);
            published_asset_paths
                .entry(item.id.clone())
                .or_insert_with(|| target.clone());
            let target_exists =
                path_exists_case_insensitive(&session.root.join("assets"), &item.relative_path)
                    .map_err(io_command_error)?;
            // Usually only the owning token writes a new binary.  If that
            // token was removed from the manifest before save, a remaining
            // registration can still refer to its staged bytes; promote that
            // reference to the one write for this target.  Formal reuse is
            // never copied because its source already lives in assets/.
            let needs_copy = item.owns_staged_path
                || (item.staged_path.starts_with(&staging_root) && !target_exists);
            if needs_copy && asset_targets.insert(target.clone()) {
                asset_hashes.insert(target.clone(), item.sha256.clone());
                asset_writes.push((target, item.staged_path.clone()));
            }
        }
        let next_models =
            document_models_from_request(&request).map_err(validation_command_error)?;
        let writes = retain_changed_model_writes(
            &session.root,
            &request,
            all_writes,
            &session.document_models,
        )
        .map_err(validation_command_error)?;
        let deletes =
            managed_deletions(&session.root, &session.catalog.manifest, &request.manifest);
        // Compute every value needed by the response before publication. The
        // fingerprint is built from the bytes that are actually going to be
        // written (and the inspected hashes of staged binaries), from the
        // save-start snapshot memoized for paths that already existed then, and
        // by re-reading paths that were missing when the save began. Once the
        // journal is committed, the command therefore cannot report a failure
        // while the editor still holds the old fingerprint.
        let mut expected_hashes = BTreeMap::new();
        for (path, bytes) in &writes {
            expected_hashes.insert(path.clone(), hash_bytes(bytes));
        }
        expected_hashes.extend(
            asset_hashes
                .iter()
                .map(|(path, hash)| (path.clone(), hash.clone())),
        );
        let fingerprint = project_fingerprint_with_hashes(
            &session.root,
            &request.manifest,
            &expected_hashes,
            &mut hash_cache,
        )
        .map_err(io_command_error)?;
        let project = project_payload_from_request(
            &session.root,
            &candidate,
            &request,
            request.layout.clone(),
            &published_asset_paths,
            fingerprint.clone(),
        )
        .map_err(validation_command_error)?;
        let changed_paths = writes
            .iter()
            .filter_map(|(path, _)| path.strip_prefix(&session.root).ok())
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .chain(
                asset_writes
                    .iter()
                    .filter_map(|(path, _)| path.strip_prefix(&session.root).ok())
                    .map(|path| path.to_string_lossy().replace('\\', "/")),
            )
            .collect::<Vec<_>>();
        let (transaction_id, warnings) =
            if writes.is_empty() && asset_writes.is_empty() && deletes.is_empty() {
                (None, Vec::new())
            } else {
                let outcome = atomic_write_batch_with_source_hashes(
                    &session.root,
                    &writes,
                    &asset_writes,
                    &asset_hashes,
                    &deletes,
                )
                .map_err(io_command_error)?;
                (Some(outcome.transaction_id), outcome.warnings)
            };

        // `candidate` was validated against the trusted staging overlay above.
        // Once publication succeeds its resolver can be rebased to the formal
        // assets tree without another fallible filesystem read.
        session.catalog = candidate.into_published();
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
            warnings,
            transaction_id,
        })
    })();

    if result.is_ok() {
        // Cleanup is deliberately best-effort.  In particular, a poisoned
        // import mutex must not turn a successful disk commit into an error
        // response with a stale editor session.
        match state.imports.lock() {
            Ok(mut imports) => {
                let retained = staged
                    .iter()
                    .map(|item| item.token.as_str())
                    .collect::<BTreeSet<_>>();
                let stale = imports
                    .values()
                    .filter(|item| item.project_root == session.root)
                    .filter(|item| !retained.contains(item.token.as_str()))
                    .cloned()
                    .collect::<Vec<_>>();
                let mut cleanup_warnings = Vec::new();
                let mut cleanup_dirs = BTreeSet::new();
                for item in staged.iter().chain(stale.iter()) {
                    imports.remove(&item.token);
                    if item.owns_staged_path {
                        if let Some(parent) = item.staged_path.parent() {
                            // Two logical registrations may deliberately reuse
                            // one staged binary. Remove its directory once,
                            // otherwise the second token would produce a
                            // spurious warning after the first cleaned it up.
                            cleanup_dirs.insert(parent.to_path_buf());
                        }
                    }
                }
                for directory in cleanup_dirs {
                    if let Err(error) = fs::remove_dir_all(&directory) {
                        if error.kind() != std::io::ErrorKind::NotFound {
                            cleanup_warnings.push(cleanup_warning(format!(
                                "导入暂存目录清理失败（{}）：{error}",
                                directory.display()
                            )));
                        }
                    }
                }
                if let Ok(saved) = &mut result {
                    saved.warnings.extend(cleanup_warnings);
                }
            }
            Err(_) => {
                if let Ok(saved) = &mut result {
                    saved.warnings.push(cleanup_warning(
                        "素材导入锁已损坏，暂存文件将在下次打开项目时清理",
                    ));
                }
            }
        }
    }
    result
}

#[tauri::command]
async fn validate_project(
    request: SaveProjectRequest,
    app: AppHandle,
) -> Result<Vec<EditorDiagnostic>, WireCommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_project_command(request, app.state::<EditorState>())
    })
    .await
    .map_err(|error| internal_command_error(format!("验证任务失败: {error}")))?
}

fn validate_project_command(
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
    let staged = request_staged_imports(&state, session, &request)?;
    let asset_overrides = staged_asset_overrides(&staged);
    let scenes = validate_scene_file_set(&request.manifest, &request.scenes)
        .map_err(validation_command_error)?;
    let ui_motions = validate_ui_motion_file_set(&request.manifest, &request.ui_motions)
        .map_err(validation_command_error)?;
    let buttons = validate_button_file_set(&request.manifest, &request.buttons)
        .map_err(validation_command_error)?;
    let animations = validate_animation_file_set(&request.manifest, &request.animations)
        .map_err(validation_command_error)?;
    let actions = validate_action_file_set(&request.manifest, &request.actions)
        .map_err(validation_command_error)?;
    let candidate = ContentCatalog::from_documents_with_all_documents_and_actions(
        session.root.clone(),
        request.manifest,
        scenes,
        ui_motions,
        request
            .chapter_map
            .as_ref()
            .map(|file| file.definition.clone()),
        &asset_overrides,
        Some(buttons),
        Some(animations),
        Some(actions),
    )
    .map_err(validation_command_error)?;
    Ok(analyze_catalog(&candidate))
}

/// Validate one import batch and stage every accepted binary.
///
/// Extracted from the `stage_asset_imports` command so the
/// undo → replace another file → save flow (superseding an earlier staged
/// replacement of the same id) can be exercised without a Tauri app handle.
/// On any error every directory created by this call is removed.
fn prepare_asset_imports(
    session: &ProjectSession,
    existing_imports: &BTreeMap<String, StagedImport>,
    inspections: &BTreeMap<String, InspectedImport>,
    requests: &[ImportAssetRequest],
    batch_id: u128,
) -> Result<Vec<StagedImport>, WireCommandError> {
    let mut ids = session
        .catalog
        .manifest
        .assets
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut paths = session
        .catalog
        .manifest
        .assets
        .values()
        .filter_map(|asset| asset.path.as_deref())
        .map(path_reservation_key)
        .collect::<BTreeSet<_>>();
    // A second import dialog can be opened before the first one is saved.
    // Reserve those staged IDs and destinations as well, otherwise two
    // independent batches could collide at commit time.
    for staged in existing_imports
        .values()
        .filter(|item| item.project_root == session.root)
    {
        ids.insert(staged.id.clone());
        paths.insert(path_reservation_key(&staged.relative_path));
    }
    let mut prepared: Vec<StagedImport> = Vec::with_capacity(requests.len());
    let mut created_staging_dirs = BTreeSet::new();
    // One replacement per asset id per batch, and never two replacements of a
    // matching kind/path pair.
    let mut replacement_ids = BTreeSet::new();

    let preparation = (|| -> Result<(), WireCommandError> {
        for (index, item) in requests.iter().enumerate() {
            if !valid_asset_registration_id(&item.id) {
                return Err(validation_command_error(format!(
                    "素材 ID 包含非法字符: {}",
                    item.id
                )));
            }
            let inspection_id = item
                .inspection_id
                .as_ref()
                .ok_or_else(|| validation_command_error("素材必须先经过检查，再加入导入清单"))?;
            let inspected = inspections.get(inspection_id).ok_or_else(|| {
                validation_command_error(format!("素材检查已失效: {inspection_id}"))
            })?;
            if inspected.project_root != session.root {
                return Err(validation_command_error("素材检查属于另一个项目"));
            }
            let current_hash =
                hash_file_streaming(&inspected.source_path).map_err(io_command_error)?;
            if current_hash != inspected.sha256 {
                return Err(validation_command_error(
                    "源素材在检查后发生了变化，请重新检查",
                ));
            }
            let source = inspected.source_path.clone();
            let (file_name, requested_relative_path) =
                normalize_import_request_for_source(item, &source)?;
            validate_import_file_name(item.kind, &file_name, &source)?;
            let is_replacement = item.replace_id.is_some();
            if let Some(replace_id) = &item.replace_id {
                if replace_id != &item.id {
                    return Err(validation_command_error(format!(
                        "替换标记 {replace_id} 与素材 ID {} 不一致",
                        item.id
                    )));
                }
            }
            if is_replacement {
                // The id already exists by definition, so the id reservation
                // cannot be used to reject a duplicate.  Reject a second
                // staged replacement of the same id *in this batch* instead:
                // one batch must not contain two competing binaries for one
                // manifest entry.  A superseded replacement from an earlier
                // batch is allowed: the author can undo a staged replacement
                // and stage another file without saving first.  The two
                // tokens stay distinct (the `paths` reservation above keeps
                // their destination files apart) and save only submits the
                // token whose new path matches the manifest, so the obsolete
                // token fails closed in `staged_imports_for_request`.  The
                // superseded staged binary is intentionally left on disk for
                // redo/history and is removed by the existing best-effort
                // import cleanup.
                if !replacement_ids.insert(item.id.clone()) {
                    return Err(validation_command_error(format!(
                        "同一批次只能替换一次素材: {}",
                        item.id
                    )));
                }
            } else if !ids.insert(item.id.clone()) {
                return Err(validation_command_error(format!(
                    "素材 ID 已存在或重复: {}",
                    item.id
                )));
            }
            if !source.is_file() {
                return Err(validation_command_error("选择的素材不是文件"));
            }
            validate_import_extension(item.kind, &source)?;
            let source_metadata = inspect_import_source(item.kind, &source).map_err(|message| {
                validation_command_error(format!(
                    "素材 {} 内容校验失败：{}",
                    source.display(),
                    message
                ))
            })?;
            let replacement = if is_replacement {
                Some(replacement_target(
                    session,
                    item,
                    &source_metadata,
                    &requested_relative_path,
                )?)
            } else {
                None
            };
            let sha256 = hash_file_streaming(&source).map_err(io_command_error)?;
            // A replacement must own a brand new staged binary even when its
            // bytes match the registered file, so formal deduplication is
            // skipped entirely for it.
            let reusable = if is_replacement {
                None
            } else {
                // Reuse a file already staged in this batch before scanning the
                // formal catalog. This keeps two logical registrations of the
                // same upload on one temporary binary and preserves cross-kind
                // reuse semantics for a shared file.
                let staged_reusable = prepared
                    .iter()
                    .find(|candidate| candidate.sha256 == sha256)
                    .map(|candidate| {
                        (
                            candidate.id.clone(),
                            candidate.relative_path.clone(),
                            candidate.staged_path.clone(),
                        )
                    });
                match staged_reusable {
                    Some(candidate) => Some(candidate),
                    None => find_reusable_asset(session, item.kind, &sha256)
                        .map_err(io_command_error)?,
                }
            };
            let token = format!("import-{batch_id}-{index}");
            let (relative_path, staged_path, owns_staged_path, reused_from) =
                if let Some((existing_id, existing_path, existing_absolute)) = reusable {
                    // Reuse the existing formal or staged file when the bytes
                    // already exist. A new logical ID may still register the
                    // same file under another kind (for example a shared OGG
                    // used as both BGM and SFX).
                    (existing_path, existing_absolute, false, Some(existing_id))
                } else {
                    if !paths.insert(path_reservation_key(&requested_relative_path)) {
                        return Err(validation_command_error(format!(
                            "目标素材文件已存在或重复: {requested_relative_path}"
                        )));
                    }
                    let staged_dir = session
                        .root
                        .join(".vectspace")
                        .join("tmp")
                        .join("imports")
                        .join(&token);
                    fs::create_dir_all(&staged_dir).map_err(io_command_error)?;
                    created_staging_dirs.insert(staged_dir.clone());
                    let staged_path = staged_dir.join(&file_name);
                    if let Err(error) = copy_file_streaming(&source, &staged_path) {
                        let _ = fs::remove_dir_all(&staged_dir);
                        return Err(io_command_error(error));
                    }
                    (requested_relative_path, staged_path, true, None)
                };
            if owns_staged_path && fs::metadata(&staged_path).map_err(io_command_error)?.len() == 0
            {
                return Err(validation_command_error(format!(
                    "素材文件为空: {}",
                    source.display()
                )));
            }
            let staged = StagedImport {
                token: token.clone(),
                project_root: session.root.clone(),
                id: item.id.clone(),
                kind: item.kind,
                relative_path: relative_path.clone(),
                staged_path: staged_path.clone(),
                sha256,
                owns_staged_path,
                reused_from,
                replaces: replacement.map(ReplacementTarget::into_staged),
            };
            prepared.push(staged);
        }
        Ok(())
    })();
    match preparation {
        Ok(()) => Ok(prepared),
        Err(error) => {
            for directory in created_staging_dirs.iter() {
                let _ = fs::remove_dir_all(directory);
            }
            Err(error)
        }
    }
}

/// Stage a batch of binaries without mutating the managed `assets/` tree.
/// The returned opaque tokens are the only handles accepted by
/// `save_project`; the WebView never gets to choose a copy destination.
#[tauri::command]
fn stage_asset_imports(
    request: WireStageAssetImportsRequest,
    app: AppHandle,
    state: State<'_, EditorState>,
) -> Result<Vec<WireImportedAsset>, WireCommandError> {
    let requests = request
        .requests
        .into_iter()
        .map(|item| ImportAssetRequest {
            id: item.id,
            kind: asset_kind_from_wire(item.kind),
            file_name: item.file_name,
            inspection_id: item.inspection_id,
            replace_id: item.replace_id,
        })
        .collect::<Vec<_>>();
    if requests.is_empty() {
        return Ok(Vec::new());
    }
    let session_guard = state
        .session
        .lock()
        .map_err(|_| internal_command_error("编辑器项目锁已损坏"))?;
    let session = session_guard
        .as_ref()
        .ok_or_else(|| validation_command_error("尚未打开项目"))?;

    let mut imports = state
        .imports
        .lock()
        .map_err(|_| internal_command_error("素材导入锁已损坏"))?;
    let mut inspections = state
        .inspections
        .lock()
        .map_err(|_| internal_command_error("素材检查锁已损坏"))?;
    let batch_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let prepared = prepare_asset_imports(session, &imports, &inspections, &requests, batch_id)?;

    // All validation and copies above succeeded.  Resolve the final metadata
    // before publishing any token.  A formal reused file may disappear
    // between preparation and publication; checking it here prevents a
    // half-published batch when that happens.
    let output = match prepared
        .iter()
        .map(|staged| {
            let size_bytes = fs::metadata(&staged.staged_path)
                .map_err(io_command_error)?
                .len();
            Ok(WireImportedAsset {
                id: staged.id.clone(),
                kind: wire_asset_kind(staged.kind),
                path: staged.relative_path.clone(),
                absolute_path: staged.staged_path.to_string_lossy().into_owned(),
                size_bytes: WireU64::from(size_bytes),
                token: Some(staged.token.clone()),
                reused_from: staged.reused_from.clone(),
                replaced_from: staged
                    .replaces
                    .as_ref()
                    .map(|replacement| replacement.old_relative_path.clone()),
            })
        })
        .collect::<Result<Vec<_>, WireCommandError>>()
    {
        Ok(output) => output,
        Err(error) => {
            for directory in staged_import_directories(&prepared) {
                let _ = fs::remove_dir_all(directory);
            }
            return Err(error);
        }
    };

    // Publish the records as one batch so a partial import can never be
    // observed by save_project.
    let mut published = Vec::with_capacity(prepared.len());
    for staged in &prepared {
        if staged.owns_staged_path {
            if let Err(error) = app.asset_protocol_scope().allow_file(&staged.staged_path) {
                for token in published {
                    imports.remove(&token);
                }
                let mut cleanup_dirs = BTreeSet::new();
                for candidate in &prepared {
                    if candidate.owns_staged_path {
                        if let Some(parent) = candidate.staged_path.parent() {
                            cleanup_dirs.insert(parent.to_path_buf());
                        }
                    }
                }
                for directory in cleanup_dirs {
                    let _ = fs::remove_dir_all(directory);
                }
                return Err(asset_command_error(error));
            }
        }
        imports.insert(staged.token.clone(), staged.clone());
        published.push(staged.token.clone());
    }
    for item in &requests {
        if let Some(inspection_id) = &item.inspection_id {
            inspections.remove(inspection_id);
        }
    }
    Ok(output)
}

fn normalize_import_request_for_source(
    request: &ImportAssetRequest,
    source: &Path,
) -> Result<(std::ffi::OsString, String), WireCommandError> {
    let file_name = request
        .file_name
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(std::ffi::OsString::from)
        .or_else(|| source.file_name().map(ToOwned::to_owned))
        .ok_or_else(|| validation_command_error("无法识别素材文件名"))?;
    let text = file_name.to_string_lossy();
    if text.len() > 200
        || Path::new(&file_name).components().count() != 1
        || matches!(file_name.to_str(), Some(".") | Some(".."))
        || text.trim().is_empty()
        || text.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
    {
        return Err(validation_command_error("素材文件名必须是单个安全文件名"));
    }
    validate_import_extension(request.kind, Path::new(&file_name))?;
    let relative_path = format!("{}/{}", asset_folder(request.kind), text.replace('\\', "/"));
    safe_relative_path(&relative_path).map_err(validation_command_error)?;
    // Do not reject an existing destination here.  The source hash is needed
    // first so an identical formal asset can be safely reused; the caller
    // performs the destination reservation check only for genuinely new
    // content.
    Ok((file_name, relative_path))
}

/// Windows asset paths are case-insensitive.  Keep the reservation check
/// deterministic on the development hosts too, so importing `A.PNG` after
/// `a.png` cannot create two manifest entries that resolve to one file when
/// the project is later opened on Windows.
fn path_reservation_key(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// Keep the staging boundary in lock-step with the core manifest validator.
/// An import token must never be issued for an ID that could only fail later
/// during catalog validation; rejecting it here also avoids leaving an
/// apparently valid, but unusable, staged binary behind after a cancelled
/// dialog.
fn valid_asset_registration_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
}

fn path_exists_case_insensitive(root: &Path, relative: &str) -> Result<bool, std::io::Error> {
    match resolve_case_insensitive(root, relative) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn resolve_case_insensitive(root: &Path, relative: &str) -> Result<PathBuf, std::io::Error> {
    let mut current = root.to_path_buf();
    for component in Path::new(relative).components() {
        let Component::Normal(name) = component else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("非法素材相对路径: {relative}"),
            ));
        };
        if !current.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("素材路径不存在: {relative}"),
            ));
        }
        let wanted = name.to_string_lossy().to_lowercase();
        let mut matching = None;
        for entry in fs::read_dir(&current)? {
            let entry = entry?;
            if entry.file_name().to_string_lossy().to_lowercase() == wanted {
                matching = Some(entry.path());
                break;
            }
        }
        let Some(next) = matching else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("素材路径不存在: {relative}"),
            ));
        };
        current = next;
    }
    if current.exists() {
        Ok(current)
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("素材路径不存在: {relative}"),
        ))
    }
}

fn validate_import_extension(kind: AssetKind, source: &Path) -> Result<(), WireCommandError> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let valid = match kind {
        AssetKind::Background | AssetKind::Sprite | AssetKind::Gui => {
            ["png", "jpg", "jpeg", "webp"].contains(&extension.as_str())
        }
        AssetKind::Bgm | AssetKind::Ambience | AssetKind::Sfx => {
            ["ogg", "wav", "mp3", "flac"].contains(&extension.as_str())
        }
        AssetKind::Font => ["ttf", "otf"].contains(&extension.as_str()),
        AssetKind::Video => extension == "mp4",
    };
    if valid {
        Ok(())
    } else {
        Err(validation_command_error(format!(
            "素材扩展名与 {:?} 类型不匹配",
            kind
        )))
    }
}

/// The manifest path is also part of the media contract.  Checking only the
/// selected source path would allow a valid PNG to be registered as
/// `assets/backgrounds/foo.jpg`, which later makes format detection and
/// browser loading disagree.  JPEG/JPG are the sole aliases we accept.
fn validate_import_file_name(
    kind: AssetKind,
    file_name: &std::ffi::OsStr,
    source: &Path,
) -> Result<(), WireCommandError> {
    let target_extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let source_extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let canonical = |extension: &str| match extension {
        "jpg" | "jpeg" => "jpeg".to_owned(),
        other => other.to_owned(),
    };
    if canonical(&target_extension) != canonical(&source_extension) {
        return Err(validation_command_error(format!(
            "目标文件名扩展名 .{target_extension} 与源素材 .{source_extension} 不一致"
        )));
    }
    validate_import_extension(kind, Path::new(file_name))
}

/// Validate the container/header before a staged file can be referenced by a
/// project.  This deliberately stays dependency-free: the WebView remains
/// responsible for actual playback compatibility, while the host rejects
/// obvious renamed/corrupt files and never writes them to `assets/`.
#[cfg(test)]
fn validate_import_bytes(kind: AssetKind, bytes: &[u8]) -> Result<(), String> {
    let starts = |signature: &[u8]| bytes.starts_with(signature);
    let valid = match kind {
        AssetKind::Background | AssetKind::Sprite | AssetKind::Gui => {
            starts(b"\x89PNG\r\n\x1a\n")
                || starts(b"\xff\xd8\xff")
                || (bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
        }
        AssetKind::Bgm | AssetKind::Ambience | AssetKind::Sfx => {
            starts(b"OggS")
                || starts(b"RIFF") && bytes.len() >= 12 && &bytes[8..12] == b"WAVE"
                || starts(b"fLaC")
                || starts(b"ID3")
                || (bytes.len() >= 2 && bytes[0] == 0xff && (bytes[1] & 0xe0) == 0xe0)
        }
        AssetKind::Font => starts(b"\x00\x01\x00\x00") || starts(b"OTTO"),
        AssetKind::Video => bytes.len() >= 12 && &bytes[4..8] == b"ftyp",
    };
    if valid {
        Ok(())
    } else {
        Err(format!("文件头与 {:?} 类型不匹配", kind))
    }
}

/// Fully inspect a source before copying it into the import session.  The
/// older implementation only checked a sixteen-byte signature, which let
/// truncated images and malformed media reach the staged tree.  Inspection
/// now decodes image data and parses the audio/video/font container while
/// keeping hashing and the eventual copy streaming and bounded.
fn inspect_import_source(kind: AssetKind, source: &Path) -> Result<WireAssetMetadata, String> {
    let expected_extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let expected_kind = match expected_extension.as_str() {
        "png" | "jpg" | "jpeg" | "webp" => {
            matches!(
                kind,
                AssetKind::Background | AssetKind::Sprite | AssetKind::Gui
            )
        }
        "ogg" | "wav" | "mp3" | "flac" => {
            matches!(kind, AssetKind::Bgm | AssetKind::Ambience | AssetKind::Sfx)
        }
        "mp4" => matches!(kind, AssetKind::Video),
        "ttf" | "otf" => matches!(kind, AssetKind::Font),
        _ => false,
    };
    if !expected_kind {
        return Err(format!("素材扩展名与 {:?} 类型不匹配", kind));
    }
    inspect_media_source(source)
}

/// Canonical format family of an inspected media record.  `Png`/`PNG` and
/// `Jpeg`/`JPG` must never disagree when a replacement compares formats.
fn media_format_family(format: &str) -> Option<&'static str> {
    match format.trim().to_ascii_lowercase().as_str() {
        "png" => Some("png"),
        "jpeg" | "jpg" => Some("jpeg"),
        "webp" => Some("webp"),
        "ogg" => Some("ogg"),
        "wav" => Some("wav"),
        "mp3" => Some("mp3"),
        "flac" => Some("flac"),
        "mp4" => Some("mp4"),
        "ttf" => Some("ttf"),
        "otf" => Some("otf"),
        _ => None,
    }
}

fn format_family_from_path(path: &Path) -> Option<&'static str> {
    path.extension()
        .and_then(|value| value.to_str())
        .and_then(media_format_family)
}

/// Everything the staging step needs to know about an existing asset whose
/// binary is being replaced.  `None` means an ordinary brand-new import.
#[derive(Debug, Clone)]
struct ReplacementTarget {
    old_relative_path: String,
    old_kind: AssetKind,
}

impl ReplacementTarget {
    fn into_staged(self) -> StagedReplacement {
        StagedReplacement {
            old_relative_path: self.old_relative_path,
            old_kind: self.old_kind,
        }
    }
}

/// Resolve and validate the existing asset a replacement request targets.
/// The logical id and kind must match, a composite animated asset is refused
/// with a domain explanation, the new upload must keep the registered binary's
/// actual format family, the destination must be a *different* safe path, and
/// an asset used as an animation frame must keep the animation's uniform
/// pixel size.
fn replacement_target(
    session: &ProjectSession,
    request: &ImportAssetRequest,
    source_metadata: &WireAssetMetadata,
    requested_relative_path: &str,
) -> Result<ReplacementTarget, WireCommandError> {
    let definition = session
        .catalog
        .manifest
        .assets
        .get(&request.id)
        .ok_or_else(|| validation_command_error(format!("要替换的素材不存在: {}", request.id)))?;
    if definition.kind != request.kind {
        return Err(validation_command_error(format!(
            "替换素材 {} 时必须保持原始类型 {:?}",
            request.id, definition.kind
        )));
    }
    if definition.animation.is_some() {
        return Err(validation_command_error(format!(
            "素材 {} 是合成动画，不能替换其二进制；请改换它的帧图片或重新创建动画",
            request.id
        )));
    }
    let old_relative_path = definition
        .path
        .as_deref()
        .ok_or_else(|| {
            validation_command_error(format!("素材 {} 没有可替换的静态文件", request.id))
        })?
        .replace('\\', "/");
    if path_reservation_key(requested_relative_path) == path_reservation_key(&old_relative_path) {
        return Err(validation_command_error(format!(
            "替换素材 {} 必须写入新的文件路径，不能覆盖 {}",
            request.id, old_relative_path
        )));
    }
    let old_absolute = resolve_case_insensitive(&session.root.join("assets"), &old_relative_path)
        .map_err(|error| {
        validation_command_error(format!(
            "无法定位要替换的素材文件 {}: {error}",
            old_relative_path
        ))
    })?;
    // Decode the registered binary so a renamed or re-encoded upload cannot
    // silently change the media format behind a stable id.
    let old_metadata = inspect_media_source(&old_absolute).ok();
    let old_family = old_metadata
        .as_ref()
        .and_then(|metadata| media_format_family(&metadata.format))
        .or_else(|| format_family_from_path(&old_absolute));
    let new_family = media_format_family(&source_metadata.format)
        .or_else(|| format_family_from_path(Path::new(&requested_relative_path)));
    if old_family.is_none() || new_family.is_none() || old_family != new_family {
        return Err(validation_command_error(format!(
            "替换素材 {} 的实际格式必须与原文件 {} 一致（原为 {}）",
            request.id,
            old_relative_path,
            old_family.unwrap_or("未知")
        )));
    }
    if session
        .catalog
        .animations_referencing(&request.id)
        .is_empty()
    {
        // Not a frame of any loop animation: geometry may change freely.
    } else {
        let Some((width, height)) = old_metadata
            .as_ref()
            .and_then(|metadata| metadata.width.zip(metadata.height))
        else {
            return Err(validation_command_error(format!(
                "素材 {} 被帧动画引用，但无法测量当前帧尺寸，替换已取消",
                request.id
            )));
        };
        let Some((new_width, new_height)) = source_metadata.width.zip(source_metadata.height)
        else {
            return Err(validation_command_error(format!(
                "素材 {} 被帧动画引用，新图片缺少像素尺寸信息",
                request.id
            )));
        };
        if width != new_width || height != new_height {
            return Err(validation_command_error(format!(
                "素材 {} 是帧动画的一帧，新图片尺寸 {}×{} 必须与动画尺寸 {}×{} 一致",
                request.id, new_width, new_height, width, height
            )));
        }
    }
    Ok(ReplacementTarget {
        old_relative_path,
        old_kind: definition.kind,
    })
}

/// Hash a source without loading a complete video/audio file into memory.
fn hash_file_streaming(path: &Path) -> Result<String, std::io::Error> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    // Keep the sizeable I/O buffer off the caller's stack.  `open_project`
    // runs on Tauri's command thread, whose stack is only 1 MiB on Windows.
    let mut buffer = vec![0_u8; HASH_IO_BUFFER_SIZE];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Copy a staged source in bounded chunks.  The destination is created only
/// after the source has passed header validation and is never published as a
/// formal asset until the content transaction commits.
fn copy_file_streaming(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    copy_and_hash_streaming(source, destination).map(|_| ())
}

fn copy_and_hash_streaming(source: &Path, destination: &Path) -> Result<String, std::io::Error> {
    let mut input = File::open(source)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut output = File::create(destination)?;
    let mut hasher = Sha256::new();
    // Keep the sizeable I/O buffer off the caller's stack.  This function is
    // also used by save transactions that may run on a normal command thread.
    let mut buffer = vec![0_u8; HASH_IO_BUFFER_SIZE];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
    }
    output.sync_all()?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// Find a formal project file with identical bytes.  Prefer the same logical
/// kind, then fall back to the first stable manifest order so cross-kind
/// registrations (for example one OGG used as BGM and SFX) are deterministic.
fn find_reusable_asset(
    session: &ProjectSession,
    kind: AssetKind,
    sha256: &str,
) -> Result<Option<(String, String, PathBuf)>, std::io::Error> {
    let mut fallback = None;
    for (id, definition) in &session.catalog.manifest.assets {
        // Reuse matching only applies to static files; an animated asset
        // already owns a whole frame list.
        let Some(relative) = &definition.path else {
            continue;
        };
        let absolute = session.catalog.assets_root().join(relative);
        if hash_file_streaming(&absolute)?.as_str() != sha256 {
            continue;
        }
        let candidate = (id.clone(), relative.clone(), absolute);
        if definition.kind == kind {
            return Ok(Some(candidate));
        }
        if fallback.is_none() {
            fallback = Some(candidate);
        }
    }
    Ok(fallback)
}

fn staged_imports_for_request(
    imports: &BTreeMap<String, StagedImport>,
    root: &Path,
    previous_assets: &BTreeMap<String, AssetDefinition>,
    request: &SaveProjectRequest,
) -> Result<Vec<StagedImport>, String> {
    let mut seen = BTreeSet::new();
    let mut output = Vec::with_capacity(request.import_tokens.len());
    for token in &request.import_tokens {
        if !seen.insert(token) {
            return Err(format!("保存请求包含重复素材导入 token: {token}"));
        }
        let staged = imports
            .get(token)
            .ok_or_else(|| format!("素材导入 token 已失效: {token}"))?;
        if staged.project_root != root {
            return Err("素材导入 token 不属于当前项目".to_owned());
        }
        let definition = request
            .manifest
            .assets
            .get(&staged.id)
            .ok_or_else(|| format!("素材导入 {} 已不在当前 manifest 中", staged.id))?;
        if definition.kind != staged.kind
            || definition
                .path
                .as_deref()
                .map(|path| path.replace('\\', "/"))
                != Some(staged.relative_path.clone())
        {
            return Err(format!("素材导入 {} 的类型或目标路径已被修改", staged.id));
        }
        if let Some(replacement) = &staged.replaces {
            // A replacement token is only valid while the session still holds
            // the *old* registration it was minted against.  If the old path
            // changed (for example an undo restored a different file), the
            // capability must fail closed instead of re-pointing the id.
            let previous = previous_assets
                .get(&staged.id)
                .ok_or_else(|| format!("素材替换 {} 的原始素材已不存在", staged.id))?;
            if previous.kind != replacement.old_kind
                || previous.path.as_deref().map(|path| path.replace('\\', "/"))
                    != Some(replacement.old_relative_path.clone())
            {
                return Err(format!(
                    "素材 {} 自暂存替换后已被修改，请重新导入",
                    staged.id
                ));
            }
        }
        output.push(staged.clone());
    }
    Ok(output)
}

fn validate_staged_imports(imports: &[StagedImport]) -> Result<(), std::io::Error> {
    for item in imports {
        if hash_file_streaming(&item.staged_path)?.as_str() != item.sha256 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("暂存素材校验失败: {}", item.id),
            ));
        }
    }
    Ok(())
}

fn ensure_import_targets_available(
    root: &Path,
    imports: &[StagedImport],
) -> Result<(), std::io::Error> {
    let staging_root = root.join(".vectspace").join("tmp").join("imports");
    for item in imports {
        // A non-owning token can still point at another token's staged file.
        // This happens when the first logical registration is removed before
        // save.  If its target has appeared externally, accept it only when
        // the bytes are exactly the inspected upload; otherwise fail closed
        // instead of silently binding the manifest to an unrelated file.
        let points_at_staging = item.staged_path.starts_with(&staging_root);
        if !item.owns_staged_path && !points_at_staging {
            continue;
        }
        let target = root.join("assets").join(&item.relative_path);
        if path_exists_case_insensitive(&root.join("assets"), &item.relative_path)? {
            if item.owns_staged_path {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!("目标素材文件已存在: {}", target.display()),
                ));
            }
            let existing = resolve_case_insensitive(&root.join("assets"), &item.relative_path)?;
            if hash_file_streaming(&existing)? != item.sha256 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!("目标素材文件已存在且内容不同: {}", target.display()),
                ));
            }
        }
    }
    Ok(())
}

/// Staging directories owned by a prepared batch, used to clean up when a
/// later step of the same batch fails.
fn staged_import_directories(imports: &[StagedImport]) -> BTreeSet<PathBuf> {
    imports
        .iter()
        .filter(|item| item.owns_staged_path)
        .filter_map(|item| item.staged_path.parent().map(Path::to_path_buf))
        .collect()
}

fn staged_asset_overrides(imports: &[StagedImport]) -> BTreeMap<String, PathBuf> {
    imports
        .iter()
        .map(|item| (item.id.clone(), item.staged_path.clone()))
        .collect()
}

fn request_staged_imports(
    state: &EditorState,
    session: &ProjectSession,
    request: &SaveProjectRequest,
) -> Result<Vec<StagedImport>, WireCommandError> {
    let staged = {
        let imports = state
            .imports
            .lock()
            .map_err(|_| internal_command_error("素材导入锁已损坏"))?;
        staged_imports_for_request(
            &imports,
            &session.root,
            &session.catalog.manifest.assets,
            request,
        )
        .map_err(validation_command_error)?
    };
    validate_staged_imports(&staged).map_err(io_command_error)?;
    Ok(staged)
}

fn clear_staged_imports(state: &EditorState, root: &Path) -> Result<(), std::io::Error> {
    // A project switch invalidates imports belonging to the project that was
    // open before the switch.  Do not clear unrelated capability records: a
    // user can have another editor window open in the same process, and its
    // staged files must remain usable until that window is closed.
    let active_root = state
        .session
        .lock()
        .map_err(|_| std::io::Error::other("编辑器项目锁已损坏"))?
        .as_ref()
        .map(|session| session.root.clone());
    let mut imports = state
        .imports
        .lock()
        .map_err(|_| std::io::Error::other("素材导入锁已损坏"))?;
    let mut roots_to_clean = BTreeSet::new();
    roots_to_clean.insert(active_root.clone().unwrap_or_else(|| root.to_path_buf()));
    imports.retain(|_, item| !roots_to_clean.contains(&item.project_root));
    let mut inspections = state
        .inspections
        .lock()
        .map_err(|_| std::io::Error::other("素材检查锁已损坏"))?;
    inspections.retain(|_, item| !roots_to_clean.contains(&item.project_root));
    // Remove only staging directories that are no longer referenced by a
    // surviving token.  The old implementation deleted the entire
    // `<project>/.vectspace/tmp/imports` tree, which could invalidate another
    // editor window's in-memory token (and could also remove a shared staged
    // file still referenced by a non-owning registration).
    let retained_directories = imports
        .values()
        .filter_map(|item| item.staged_path.parent().map(Path::to_path_buf))
        .collect::<BTreeSet<_>>();
    for project_root in roots_to_clean {
        let imports_root = project_root.join(".vectspace").join("tmp").join("imports");
        let entries = match fs::read_dir(&imports_root) {
            Ok(entries) => entries.collect::<Result<Vec<_>, _>>()?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for entry in entries {
            let path = entry.path();
            if entry.file_type()?.is_dir() && !retained_directories.contains(&path) {
                fs::remove_dir_all(path)?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn build_node_preview(
    request: BuildNodePreviewRequest,
    state: State<'_, EditorState>,
) -> Result<BuildNodePreviewResult, WireCommandError> {
    build_node_preview_command(request, &state)
}

/// Core command path kept separate from the Tauri argument extractor.  The
/// wrapper above is intentionally thin; this boundary lets the fixture test
/// exercise the same project validation/runtime resolution without requiring a
/// platform WebView binary in CI.
fn build_node_preview_command(
    request: BuildNodePreviewRequest,
    state: &EditorState,
) -> Result<BuildNodePreviewResult, WireCommandError> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| internal_command_error("编辑器项目锁已损坏"))?;
    let session = guard
        .as_mut()
        .ok_or_else(|| validation_command_error("尚未打开项目"))?;
    let catalog = build_preview_catalog(state, session, &request.project)?;
    // Preview metadata used to be collected from the story entry and can
    // therefore contain stale decisions from earlier Scenes. A node preview
    // owns only the path from its own Scene entry to the target.
    let decisions = request
        .choices
        .iter()
        .filter(|choice| choice.scene_id == request.target.scene_id)
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
fn build_preview_catalog(
    state: &EditorState,
    session: &ProjectSession,
    project: &SaveProjectRequest,
) -> Result<ContentCatalog, WireCommandError> {
    let staged = request_staged_imports(state, session, project)?;
    let asset_overrides = staged_asset_overrides(&staged);
    let scenes = validate_scene_file_set(&project.manifest, &project.scenes)
        .map_err(validation_command_error)?;
    let ui_motions = validate_ui_motion_file_set(&project.manifest, &project.ui_motions)
        .map_err(validation_command_error)?;
    let buttons = validate_button_file_set(&project.manifest, &project.buttons)
        .map_err(validation_command_error)?;
    let animations = validate_animation_file_set(&project.manifest, &project.animations)
        .map_err(validation_command_error)?;
    let actions = validate_action_file_set(&project.manifest, &project.actions)
        .map_err(validation_command_error)?;
    ContentCatalog::from_documents_with_all_documents_and_actions(
        session.root.clone(),
        project.manifest.clone(),
        scenes,
        ui_motions,
        project.chapter_map.as_ref().map(|file| file.definition.clone()),
        &asset_overrides,
        Some(buttons),
        Some(animations),
        Some(actions),
    )
    .map_err(validation_command_error)
}

// -- live gameplay preview session -----------------------------------------
//
// The editor can run one real gameplay preview at a time.  The session owns an
// isolated `RuntimeEngine` built from the current draft with
// `with_preview_overrides`, which never touches the player's profile or save.
// Every mutating request carries the session id (generation) so a late reply or
// a stop/ack from a replaced session is rejected instead of acting on the new
// world.  The lock is only held for synchronous runtime work, never across a
// presentation await.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PreviewStartMode {
    /// Start at the scene's declared entry.
    Scene,
    /// Reconstruct the target by replaying the scene path from its entry,
    /// returning `NeedsChoice` instead of guessing a branch.
    Node,
    /// Explicit fallback: reset to the scene's declared defaults and start
    /// directly at the target node without executing any predecessor.
    ResetNode,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewSessionStartRequest {
    project: SaveProjectRequest,
    mode: PreviewStartMode,
    scene_id: String,
    #[serde(default)]
    node_id: Option<String>,
    #[serde(default)]
    variable_overrides: WireVariableMap,
    #[serde(default)]
    choices: Vec<PreviewChoiceDecision>,
}

#[derive(Debug, Serialize)]
#[allow(clippy::large_enum_variant)]
#[serde(tag = "status", rename_all = "snake_case")]
enum PreviewSessionStartResult {
    Started {
        session_id: WireU64,
        update: WireRuntimeUpdate,
        assets: Vec<ResolvedAsset>,
    },
    NeedsChoice {
        location: StoryLocation,
        visit: usize,
        choices: Vec<ChoiceSnapshot>,
        trace: Vec<StoryLocation>,
    },
    Unreachable {
        message: String,
        trace: Vec<StoryLocation>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewSessionAdvanceRequest {
    session_id: WireU64,
    expected_revision: WireU64,
    source: AdvanceSource,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewSessionChooseRequest {
    session_id: WireU64,
    expected_revision: WireU64,
    choice_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewSessionClickButtonRequest {
    session_id: WireU64,
    expected_revision: WireU64,
    instance_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewSessionAckRequest {
    session_id: WireU64,
    update_id: WireU64,
    outcome: PresentationOutcome,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewSessionStopRequest {
    session_id: WireU64,
}

/// Lock the live preview and reject a request that does not belong to it.
fn with_preview_session<T>(
    state: &EditorState,
    session_id: &WireU64,
    run: impl FnOnce(&mut LivePreviewSession) -> Result<T, WireCommandError>,
) -> Result<T, WireCommandError> {
    let expected = session_id
        .parse()
        .map_err(|_| validation_command_error("无效的预览会话编号"))?;
    let mut guard = state
        .preview
        .lock()
        .map_err(|_| internal_command_error("预览会话锁已损坏"))?;
    let session = guard.as_mut().ok_or_else(|| validation_command_error("预览会话不存在"))?;
    if session.session_id != expected {
        return Err(validation_command_error("预览会话已过期，请重新开始预览"));
    }
    run(session)
}

#[tauri::command]
fn preview_session_start(
    request: PreviewSessionStartRequest,
    state: State<'_, EditorState>,
) -> Result<PreviewSessionStartResult, WireCommandError> {
    preview_session_start_command(request, &state)
}

fn preview_session_start_command(
    request: PreviewSessionStartRequest,
    state: &EditorState,
) -> Result<PreviewSessionStartResult, WireCommandError> {
    if request.mode != PreviewStartMode::Scene && request.node_id.is_none() {
        return Err(validation_command_error("未选择起始节点"));
    }
    // Allocate the session id and its id window *before* any reconstruction so
    // the runtime's update/cue/revision namespaces are unique for this session
    // and can never collide with a still-settling previous session.
    let session_id = state
        .preview_ids
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1)
        .max(1);
    let namespace = preview_id_namespace(session_id)?;
    // Build the draft catalog first, then drop the project lock before touching
    // the live-preview slot.  An invalid draft therefore fails here and cannot
    // replace or half-install a running preview.
    let catalog = {
        let mut guard = state
            .session
            .lock()
            .map_err(|_| internal_command_error("编辑器项目锁已损坏"))?;
        let session = guard
            .as_mut()
            .ok_or_else(|| validation_command_error("尚未打开项目"))?;
        build_preview_catalog(state, session, &request.project)?
    };
    let variable_overrides = variable_map_from_wire(request.variable_overrides.clone())
        .map_err(validation_command_error)?;
    let mut runtime = RuntimeEngine::with_preview_overrides(&catalog, &variable_overrides)
        .map_err(validation_command_error)?;
    runtime.prepare_session_ids(namespace, namespace, namespace);
    // A node preview only owns the path from its own Scene entry; choices from
    // other scenes are stale metadata and are ignored.
    let decisions = request
        .choices
        .iter()
        .filter(|choice| choice.scene_id == request.scene_id)
        .map(|choice| CorePreviewChoiceDecision {
            scene_id: choice.scene_id.clone(),
            node_id: choice.node_id.clone(),
            visit: choice.visit,
            choice_id: choice.choice_id.clone(),
        })
        .collect::<Vec<_>>();
    let update = match request.mode {
        PreviewStartMode::Scene => runtime
            .start_scene_preview(&catalog, &request.scene_id)
            .map_err(validation_command_error)?,
        PreviewStartMode::Node => {
            let target = StoryLocation {
                scene_id: request.scene_id.clone(),
                node_id: request.node_id.clone().unwrap_or_default(),
            };
            match runtime.preview_to_from_scene_entry(
                &catalog,
                &request.scene_id,
                &target,
                &decisions,
            ) {
                Ok(PreviewRunResult::Ready { .. }) => runtime
                    .preview_enter_current_node(&catalog)
                    .map_err(validation_command_error)?,
                Ok(PreviewRunResult::NeedsChoice {
                    location,
                    visit,
                    choices,
                    trace,
                }) => {
                    return Ok(PreviewSessionStartResult::NeedsChoice {
                        location,
                        visit,
                        choices,
                        trace,
                    });
                }
                Ok(PreviewRunResult::Unreachable { message, trace }) => {
                    return Ok(PreviewSessionStartResult::Unreachable { message, trace });
                }
                Err(error) => {
                    return Ok(PreviewSessionStartResult::Unreachable {
                        message: error.to_string(),
                        trace: Vec::new(),
                    });
                }
            }
        }
        PreviewStartMode::ResetNode => runtime
            .start_node_preview(
                &catalog,
                &request.scene_id,
                &request.node_id.clone().unwrap_or_default(),
            )
            .map_err(validation_command_error)?,
    };
    let assets = catalog
        .resolve_assets(&catalog.asset_ids())
        .map_err(validation_command_error)?;
    let mut guard = state
        .preview
        .lock()
        .map_err(|_| internal_command_error("预览会话锁已损坏"))?;
    *guard = Some(LivePreviewSession {
        session_id,
        catalog,
        runtime,
    });
    Ok(PreviewSessionStartResult::Started {
        session_id: WireU64::from(session_id),
        update: update.into(),
        assets,
    })
}

#[tauri::command]
fn preview_session_advance(
    request: PreviewSessionAdvanceRequest,
    state: State<'_, EditorState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    preview_session_advance_command(request, &state)
}

fn preview_session_advance_command(
    request: PreviewSessionAdvanceRequest,
    state: &EditorState,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    let revision = request
        .expected_revision
        .parse()
        .map_err(|_| validation_command_error("无效的修订号"))?;
    with_preview_session(state, &request.session_id, |session| {
        session
            .runtime
            .advance(&session.catalog, revision, request.source)
            .map(Into::into)
            .map_err(runtime_command_error)
    })
}

#[tauri::command]
fn preview_session_choose(
    request: PreviewSessionChooseRequest,
    state: State<'_, EditorState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    preview_session_choose_command(request, &state)
}

fn preview_session_choose_command(
    request: PreviewSessionChooseRequest,
    state: &EditorState,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    let revision = request
        .expected_revision
        .parse()
        .map_err(|_| validation_command_error("无效的修订号"))?;
    with_preview_session(state, &request.session_id, |session| {
        session
            .runtime
            .choose(&session.catalog, &request.choice_id, revision)
            .map(Into::into)
            .map_err(runtime_command_error)
    })
}

#[tauri::command]
fn preview_session_click_button(
    request: PreviewSessionClickButtonRequest,
    state: State<'_, EditorState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    preview_session_click_button_command(request, &state)
}

fn preview_session_click_button_command(
    request: PreviewSessionClickButtonRequest,
    state: &EditorState,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    let revision = request
        .expected_revision
        .parse()
        .map_err(|_| validation_command_error("无效的修订号"))?;
    with_preview_session(state, &request.session_id, |session| {
        session
            .runtime
            .click_button(&session.catalog, &request.instance_id, revision)
            .map(Into::into)
            .map_err(runtime_command_error)
    })
}

#[tauri::command]
fn preview_session_presentation_complete(
    request: PreviewSessionAckRequest,
    state: State<'_, EditorState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    preview_session_presentation_complete_command(request, &state)
}

fn preview_session_presentation_complete_command(
    request: PreviewSessionAckRequest,
    state: &EditorState,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    let update_id = request
        .update_id
        .parse()
        .map_err(|_| validation_command_error("无效的 update 编号"))?;
    with_preview_session(state, &request.session_id, |session| {
        session
            .runtime
            .presentation_complete(&session.catalog, update_id, request.outcome)
            .map(Into::into)
            .map_err(runtime_command_error)
    })
}

/// Stop the live preview and release its runtime.
///
/// A stop from a replaced session is a no-op that never tears down the newer
/// preview: only the matching session id may clear the slot.
#[tauri::command]
fn preview_session_stop(
    request: PreviewSessionStopRequest,
    state: State<'_, EditorState>,
) -> Result<bool, WireCommandError> {
    preview_session_stop_command(request, &state)
}

fn preview_session_stop_command(
    request: PreviewSessionStopRequest,
    state: &EditorState,
) -> Result<bool, WireCommandError> {
    let expected = request
        .session_id
        .parse()
        .map_err(|_| validation_command_error("无效的预览会话编号"))?;
    let mut guard = state
        .preview
        .lock()
        .map_err(|_| internal_command_error("预览会话锁已损坏"))?;
    if guard
        .as_ref()
        .is_some_and(|session| session.session_id == expected)
    {
        *guard = None;
        return Ok(true);
    }
    Ok(false)
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
    let mut buttons = Vec::with_capacity(catalog.manifest.buttons.len());
    for path in &catalog.manifest.buttons {
        buttons.push(EditorButtonFile {
            path: path.clone(),
            definition: read_yaml(&root.join(path))?,
        });
    }
    let mut animations = Vec::with_capacity(catalog.manifest.animations.len());
    for path in &catalog.manifest.animations {
        animations.push(EditorAnimationFile {
            path: path.clone(),
            definition: read_yaml(&root.join(path))?,
        });
    }
    let mut actions = Vec::with_capacity(catalog.manifest.actions.len());
    for path in &catalog.manifest.actions {
        actions.push(EditorActionFile {
            path: path.clone(),
            definition: read_yaml(&root.join(path))?,
        });
    }
    let chapter_map = match &catalog.manifest.chapter_map {
        Some(path) => Some(EditorChapterMapFile {
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
                animation: definition.animation.clone(),
                absolute_path: asset.absolute_path.clone(),
                size_bytes: WireU64::from(
                    fs::metadata(&asset.absolute_path)
                        .map(|metadata| metadata.len())
                        .unwrap_or_default(),
                ),
                metadata: inspect_media_source(Path::new(&asset.absolute_path)).ok(),
            })
        })
        .collect();

    Ok(EditorProject {
        root: root.to_string_lossy().into_owned(),
        manifest: catalog.manifest.clone(),
        scenes,
        ui_motions,
        buttons,
        animations,
        actions,
        chapter_map,
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
    published_asset_paths: &BTreeMap<String, PathBuf>,
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
                animation: definition.animation.clone(),
                // Resolve metadata from the trusted staging path before the
                // transaction, but return the formal path the newly committed
                // project will use after staging is cleaned up.
                absolute_path: published_asset_paths
                    .get(id)
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_else(|| asset.absolute_path.clone()),
                size_bytes: WireU64::from(
                    fs::metadata(&asset.absolute_path)
                        .map(|metadata| metadata.len())
                        .unwrap_or_default(),
                ),
                metadata: inspect_media_source(Path::new(&asset.absolute_path)).ok(),
            })
        })
        .collect();
    Ok(EditorProject {
        root: root.to_string_lossy().into_owned(),
        manifest: request.manifest.clone(),
        scenes: request.scenes.clone(),
        ui_motions: request.ui_motions.clone(),
        buttons: request.buttons.clone(),
        animations: request.animations.clone(),
        actions: request.actions.clone(),
        chapter_map: request.chapter_map.clone(),
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
    let mut layout: EditorLayout = serde_json::from_slice(&bytes).map_err(display_error)?;
    if layout.version != 1 {
        return Err(format!("不支持编辑器布局版本 {}", layout.version));
    }
    // A hand-edited or half-written layout must not make the whole project
    // unopenable; repair the editor-only asset metadata instead.
    normalize_asset_layout(&mut layout);
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

fn validate_button_file_set(
    manifest: &ContentManifest,
    files: &[EditorButtonFile],
) -> Result<BTreeMap<String, ButtonTemplate>, String> {
    if manifest.buttons.len() != files.len() {
        return Err("manifest 的按钮模板文件列表与编辑器文档不一致".to_owned());
    }
    let declared = manifest
        .buttons
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let provided = files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<BTreeSet<_>>();
    if declared.len() != manifest.buttons.len() || declared != provided {
        return Err("提交的按钮模板路径与 manifest 不一致".to_owned());
    }
    let mut buttons = BTreeMap::new();
    for file in files {
        safe_relative_path(&file.path)?;
        buttons.insert(file.path.clone(), file.definition.clone());
    }
    Ok(buttons)
}

/// Same contract as `validate_button_file_set`, for the standalone image
/// animation documents a project may register.
fn validate_animation_file_set(
    manifest: &ContentManifest,
    files: &[EditorAnimationFile],
) -> Result<BTreeMap<String, ImageAnimationDefinition>, String> {
    if manifest.animations.len() != files.len() {
        return Err("manifest 的图片动画文件列表与编辑器文档不一致".to_owned());
    }
    let declared = manifest
        .animations
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let provided = files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<BTreeSet<_>>();
    if declared.len() != manifest.animations.len() || declared != provided {
        return Err("提交的图片动画路径与 manifest 不一致".to_owned());
    }
    let mut animations = BTreeMap::new();
    for file in files {
        safe_relative_path(&file.path)?;
        animations.insert(file.path.clone(), file.definition.clone());
    }
    Ok(animations)
}

fn validate_action_file_set(
    manifest: &ContentManifest,
    files: &[EditorActionFile],
) -> Result<BTreeMap<String, SpriteActionDefinition>, String> {
    if manifest.actions.len() != files.len() {
        return Err("manifest 的立绘动作文件列表与编辑器文档不一致".to_owned());
    }
    let declared = manifest
        .actions
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let provided = files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<BTreeSet<_>>();
    if declared.len() != manifest.actions.len() || declared != provided {
        return Err("提交的立绘动作路径与 manifest 不一致".to_owned());
    }
    let mut actions = BTreeMap::new();
    for file in files {
        safe_relative_path(&file.path)?;
        if actions
            .insert(file.path.clone(), file.definition.clone())
            .is_some()
        {
            return Err(format!("立绘动作路径重复: {}", file.path));
        }
    }
    Ok(actions)
}

fn serialize_project(
    root: &Path,
    request: &SaveProjectRequest,
) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    let mut writes = Vec::with_capacity(
        request.scenes.len()
            + request.ui_motions.len()
            + request.buttons.len()
            + request.animations.len()
            + request.actions.len()
            + 4,
    );
    writes.push((root.join("manifest.yaml"), yaml_bytes(&request.manifest)?));
    for scene in &request.scenes {
        safe_relative_path(&scene.path)?;
        writes.push((root.join(&scene.path), yaml_bytes(&scene.definition)?));
    }
    for motion in &request.ui_motions {
        safe_relative_path(&motion.path)?;
        writes.push((root.join(&motion.path), yaml_bytes(&motion.definition)?));
    }
    for button in &request.buttons {
        safe_relative_path(&button.path)?;
        writes.push((root.join(&button.path), yaml_bytes(&button.definition)?));
    }
    for animation in &request.animations {
        safe_relative_path(&animation.path)?;
        writes.push((
            root.join(&animation.path),
            yaml_bytes(&animation.definition)?,
        ));
    }
    for action in &request.actions {
        safe_relative_path(&action.path)?;
        writes.push((root.join(&action.path), yaml_bytes(&action.definition)?));
    }
    if let Some(map) = &request.chapter_map {
        safe_relative_path(&map.path)?;
        writes.push((root.join(&map.path), yaml_bytes(&map.definition)?));
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
    previous_paths.extend(previous.buttons.iter().cloned());
    previous_paths.extend(previous.animations.iter().cloned());
    previous_paths.extend(previous.actions.iter().cloned());
    if let Some(path) = &previous.chapter_map {
        previous_paths.push(path.clone());
    }
    let mut next_paths = next.scenes.clone();
    next_paths.extend(next.ui_motions.iter().cloned());
    next_paths.extend(next.buttons.iter().cloned());
    next_paths.extend(next.animations.iter().cloned());
    next_paths.extend(next.actions.iter().cloned());
    if let Some(path) = &next.chapter_map {
        next_paths.push(path.clone());
    }
    let next_keys = next_paths
        .iter()
        .map(|path| path_reservation_key(path))
        .collect::<BTreeSet<_>>();
    previous_paths
        .into_iter()
        .filter(|path| !next_keys.contains(&path_reservation_key(path)))
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
    for path in &manifest.buttons {
        let definition: ButtonTemplate = read_yaml(&root.join(path))?;
        models.insert(
            path.replace('\\', "/"),
            serde_json::to_value(definition).map_err(display_error)?,
        );
    }
    for path in &manifest.animations {
        let definition: ImageAnimationDefinition = read_yaml(&root.join(path))?;
        models.insert(
            path.replace('\\', "/"),
            serde_json::to_value(definition).map_err(display_error)?,
        );
    }
    for path in &manifest.actions {
        let definition: SpriteActionDefinition = read_yaml(&root.join(path))?;
        models.insert(
            path.replace('\\', "/"),
            serde_json::to_value(definition).map_err(display_error)?,
        );
    }
    if let Some(path) = &manifest.chapter_map {
        let definition: ChapterMapDefinition = read_yaml(&root.join(path))?;
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
    for file in &request.buttons {
        models.insert(
            file.path.replace('\\', "/"),
            serde_json::to_value(&file.definition).map_err(display_error)?,
        );
    }
    for file in &request.animations {
        models.insert(
            file.path.replace('\\', "/"),
            serde_json::to_value(&file.definition).map_err(display_error)?,
        );
    }
    for file in &request.actions {
        models.insert(
            file.path.replace('\\', "/"),
            serde_json::to_value(&file.definition).map_err(display_error)?,
        );
    }
    if let Some(file) = &request.chapter_map {
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
                            .buttons
                            .iter()
                            .find(|file| file.path.replace('\\', "/") == key)
                            .map(|file| serde_json::to_value(&file.definition))
                    })
                    .or_else(|| {
                        request
                            .animations
                            .iter()
                            .find(|file| file.path.replace('\\', "/") == key)
                            .map(|file| serde_json::to_value(&file.definition))
                    })
                    .or_else(|| {
                        request
                            .actions
                            .iter()
                            .find(|file| file.path.replace('\\', "/") == key)
                            .map(|file| serde_json::to_value(&file.definition))
                    })
                    .or_else(|| {
                        request
                            .chapter_map
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
    if let Some(chapter_map) = object
        .get_mut("chapter_map")
        .and_then(|value| value.as_object_mut())
        .and_then(|value| value.get_mut("definition"))
    {
        if let Some(hotspots) = chapter_map
            .as_object_mut()
            .and_then(|value| value.get_mut("hotspots"))
            .and_then(|value| value.as_array_mut())
        {
            for hotspot in hotspots {
                if let Some(condition) = hotspot
                    .as_object_mut()
                    .and_then(|value| value.get_mut("reveal"))
                    .and_then(|value| value.as_object_mut())
                    .and_then(|value| value.get_mut("condition"))
                {
                    encode_condition_scalars(condition);
                }
                if let Some(overrides) = hotspot
                    .as_object_mut()
                    .and_then(|value| value.get_mut("variable_overrides"))
                    .and_then(|value| value.as_object_mut())
                {
                    for value in overrides.values_mut() {
                        let raw = std::mem::take(value);
                        *value = encode_scalar_json(raw, None);
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
        Some("button_create") | Some("button_update") => {
            if let Some(action) = object
                .get_mut("action")
                .and_then(|value| value.as_object_mut())
            {
                if let Some(sets) = action
                    .get_mut("sets")
                    .and_then(|value| value.as_array_mut())
                {
                    for set in sets {
                        let Some(value) =
                            set.as_object_mut().and_then(|value| value.get_mut("value"))
                        else {
                            continue;
                        };
                        if value
                            .as_object()
                            .is_some_and(|object| object.get("variable").is_some())
                        {
                            continue;
                        }
                        let raw = std::mem::take(value);
                        *value = encode_scalar_json(raw, None);
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

#[derive(Debug, Default)]
struct AtomicBatchOutcome {
    transaction_id: String,
    warnings: Vec<EditorDiagnostic>,
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
    atomic_write_batch_with_sources(root, writes, &[], deletes)
        .map(|outcome| outcome.transaction_id)
}

/// Write small serialized documents and large staged binaries through the
/// same journal.  Binary sources stay on disk until the transaction stages
/// them, so importing a large video never requires holding the whole batch in
/// memory.
fn atomic_write_batch_with_sources(
    root: &Path,
    writes: &[(PathBuf, Vec<u8>)],
    source_writes: &[(PathBuf, PathBuf)],
    deletes: &[PathBuf],
) -> Result<AtomicBatchOutcome, std::io::Error> {
    atomic_write_batch_with_source_hashes(root, writes, source_writes, &BTreeMap::new(), deletes)
}

/// Variant used by the editor save path to close the gap between validating a
/// staged import and copying it.  A user (or antivirus/indexer) can replace a
/// temporary file between those operations; comparing the streaming copy hash
/// with the inspected token makes the transaction fail before publication.
fn atomic_write_batch_with_source_hashes(
    root: &Path,
    writes: &[(PathBuf, Vec<u8>)],
    source_writes: &[(PathBuf, PathBuf)],
    expected_source_hashes: &BTreeMap<PathBuf, String>,
    deletes: &[PathBuf],
) -> Result<AtomicBatchOutcome, std::io::Error> {
    if writes.is_empty() && source_writes.is_empty() && deletes.is_empty() {
        return Ok(AtomicBatchOutcome::default());
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
        files: Vec::with_capacity(writes.len() + source_writes.len()),
        applied: 0,
    };
    let operation = (|| -> Result<(), std::io::Error> {
        enum WriteSource<'a> {
            Bytes(&'a [u8]),
            File(&'a Path),
        }
        let mut pending = Vec::with_capacity(writes.len() + source_writes.len());
        pending.extend(
            writes
                .iter()
                .map(|(target, bytes)| (target.as_path(), WriteSource::Bytes(bytes))),
        );
        pending.extend(
            source_writes
                .iter()
                .map(|(target, source)| (target.as_path(), WriteSource::File(source))),
        );
        for (target, source) in pending {
            let relative = checked_project_relative(root, target)?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let temporary = temporary_root.join(relative);
            let backup = backup_root.join(relative);
            let new_sha256 = match source {
                WriteSource::Bytes(bytes) => {
                    if let Some(parent) = temporary.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    let mut file = File::create(&temporary)?;
                    file.write_all(bytes)?;
                    file.sync_all()?;
                    hash_bytes(bytes)
                }
                WriteSource::File(source) => {
                    let hash = copy_and_hash_streaming(source, &temporary)?;
                    if let Some(expected) = expected_source_hashes.get(source) {
                        if expected != &hash {
                            return Err(std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                format!("暂存素材在保存期间发生变化: {}", source.display()),
                            ));
                        }
                    }
                    hash
                }
            };
            let existed = target.is_file();
            let old_sha256 = if existed {
                if let Some(parent) = backup.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(target, &backup)?;
                Some(hash_file_streaming(target)?)
            } else {
                None
            };
            journal.files.push(TransactionFile {
                relative_path: relative.to_string_lossy().replace('\\', "/"),
                new_sha256: Some(new_sha256),
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
                Some(hash_file_streaming(target)?)
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
            let mut warnings = Vec::new();
            if let Err(error) = fs::remove_dir_all(&temporary_root) {
                warnings.push(cleanup_warning(format!(
                    "保存事务临时目录清理失败（事务 {save_id}）：{error}"
                )));
            }
            if let Err(error) = prune_backup_generations(&metadata_root.join("backups"), 10) {
                warnings.push(cleanup_warning(format!(
                    "保存备份清理失败（事务 {save_id}）：{error}"
                )));
            }
            Ok(AtomicBatchOutcome {
                transaction_id: save_id,
                warnings,
            })
        }
        Err(error) => {
            // Before the Applying marker no project target has been touched.
            // Once applying starts, restore every target from its validated
            // backup immediately so a synchronous error is transactional too.
            if matches!(journal.state, TransactionState::Applying) {
                if let Err(rollback) = restore_transaction(root, &backup_root, &journal) {
                    return Err(std::io::Error::new(
                        error.kind(),
                        format!("保存事务 {save_id} 失败: {error}；立即回滚失败: {rollback}"),
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

fn cleanup_warning(message: impl Into<String>) -> EditorDiagnostic {
    EditorDiagnostic {
        severity: DiagnosticSeverity::Warning,
        code: "cleanup_warning".to_owned(),
        message: message.into(),
        scene_id: None,
        node_id: None,
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

fn hash_file(path: &Path) -> Result<Option<String>, std::io::Error> {
    match hash_file_streaming(path) {
        Ok(hash) => Ok(Some(hash)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
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
        // A transaction may be resumed only while every target is still in
        // one of the states that this journal could have produced: the old
        // bytes or the new bytes (and, for a deletion, an absent target).
        // Treating an unrelated hash as recoverable would overwrite a user's
        // edit made while the application was not running.
        let mut can_finish = true;
        let mut requires_rollback = false;
        for file in &journal.files {
            let target = project_child(root, &file.relative_path)?;
            let staged = project_child(&transaction_root, &file.relative_path)?;
            let current_hash = hash_file(&target)?;
            let old_state = match (&current_hash, file.existed, &file.old_sha256) {
                (None, false, _) => true,
                (Some(current), true, Some(old)) => current == old,
                _ => false,
            };
            let new_state = if file.delete {
                current_hash.is_none()
            } else {
                current_hash.as_deref() == file.new_sha256.as_deref()
            };
            if !old_state && !new_state {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!(
                        "保存事务检测到外部修改，无法安全恢复: {} (事务 {})",
                        file.relative_path, journal.transaction_id
                    ),
                ));
            }
            if !new_state {
                if staged.is_file() {
                    // The staged bytes are available, so this file can be
                    // applied on the next pass.
                } else {
                    can_finish = false;
                    requires_rollback = true;
                }
            }
        }
        if can_finish {
            for file in &journal.files {
                let target = project_child(root, &file.relative_path)?;
                let staged = project_child(&transaction_root, &file.relative_path)?;
                let current_hash = hash_file(&target)?;
                if file.delete {
                    if current_hash.is_some() {
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
        } else if requires_rollback {
            // A missing staged file means we cannot safely finish the new
            // version.  Roll back only after the state check above proved no
            // target contains an unrelated external version.
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
    // A synchronous write error is not proof that the target still contains
    // the bytes this transaction expected.  Check every target before
    // deleting/replacing anything so an external edit made concurrently with
    // the save is never mistaken for a partially applied transaction.
    for file in &journal.files {
        let target = project_child(root, &file.relative_path)?;
        let current_hash = hash_file(&target)?;
        let old_state = match (&current_hash, file.existed, &file.old_sha256) {
            (None, false, _) => true,
            (Some(current), true, Some(old)) => current == old,
            _ => false,
        };
        let new_state = if file.delete {
            current_hash.is_none()
        } else {
            current_hash.as_deref() == file.new_sha256.as_deref()
        };
        if !old_state && !new_state {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("保存事务检测到外部修改，拒绝回滚 {}", file.relative_path),
            ));
        }
    }
    for file in &journal.files {
        let target = project_child(root, &file.relative_path)?;
        let backup = project_child(backup_root, &file.relative_path)?;
        if file.existed {
            let backup_hash = hash_file_streaming(&backup).map_err(|error| {
                std::io::Error::new(
                    error.kind(),
                    format!("保存事务无法从备份恢复 {}: {error}", file.relative_path),
                )
            })?;
            if file.old_sha256.as_deref() != Some(backup_hash.as_str()) {
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
            copy_file_streaming(&backup, &temporary)?;
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
    project_fingerprint_cached(root, manifest, &mut BTreeMap::new())
}

/// Fingerprint the current on-disk project, memoizing every resolved-path hash
/// in `cache`.  A save computes the staleness fingerprint first and the
/// post-serialization fingerprint second over the same tree; sharing the cache
/// lets the second pass reuse the first pass's file reads.
///
/// The first pass's hashes are the save's snapshot: once a present path is
/// memoized, the second pass reports those pre-save bytes even if the file is
/// externally edited or deleted in between.  That is deliberate.  An external
/// edit/delete that lands after the staleness check is therefore not absorbed
/// into the fingerprint published by this save; it leaves the on-disk tree
/// diverged from `session.fingerprint`, so the *next* save's fresh staleness
/// pass detects it and fails closed with `StaleProject` rather than overwriting
/// the external change.  Only missing paths are left uncached (see
/// `append_expected_or_disk_hash`).
fn project_fingerprint_cached(
    root: &Path,
    manifest: &ContentManifest,
    cache: &mut BTreeMap<PathBuf, String>,
) -> Result<String, std::io::Error> {
    project_fingerprint_with_hashes(root, manifest, &BTreeMap::new(), cache)
}

/// Compute the fingerprint while optionally substituting hashes for files that
/// are about to be published.  Save requests use this before the journal is
/// applied, so no fallible read is needed after the transaction commits.
///
/// `expected_hashes` always wins over `cache`: those bytes are about to be
/// written, so a hash memoized from the pre-save tree would be stale.
fn project_fingerprint_with_hashes(
    root: &Path,
    manifest: &ContentManifest,
    expected_hashes: &BTreeMap<PathBuf, String>,
    cache: &mut BTreeMap<PathBuf, String>,
) -> Result<String, std::io::Error> {
    let mut hasher = Sha256::new();
    let mut paths = Vec::with_capacity(
        manifest.assets.len()
            + manifest.scenes.len()
            + manifest.ui_motions.len()
            + manifest.buttons.len()
            + manifest.animations.len()
            + manifest.actions.len()
            + 3,
    );
    paths.push(root.join("manifest.yaml"));
    for path in &manifest.scenes {
        paths.push(root.join(path));
    }
    for path in &manifest.ui_motions {
        paths.push(root.join(path));
    }
    for path in &manifest.buttons {
        paths.push(root.join(path));
    }
    for path in &manifest.animations {
        paths.push(root.join(path));
    }
    for path in &manifest.actions {
        paths.push(root.join(path));
    }
    if let Some(path) = &manifest.chapter_map {
        paths.push(root.join(path));
    }
    paths.push(root.join(LAYOUT_RELATIVE_PATH));
    // Asset bytes are part of the project fingerprint too.  A changed image,
    // font or audio file must make a stale editor session fail closed instead
    // of silently overwriting the user's external change.  Sort by logical
    // asset ID for deterministic fingerprints and hash in bounded chunks.
    let mut assets = manifest
        .assets
        .iter()
        .filter_map(|(id, asset)| {
            // Animated assets carry no static file of their own; their frame
            // list lives in an animation document that is hashed above.
            asset
                .path
                .as_ref()
                .map(|relative| (id, root.join("assets").join(relative)))
        })
        .collect::<Vec<_>>();
    assets.sort_by(|left, right| left.0.cmp(right.0));
    for (id, path) in assets {
        hasher.update(b"asset:");
        hasher.update(id.as_bytes());
        hasher.update(b"\0");
        hasher.update(path.to_string_lossy().as_bytes());
        append_expected_or_disk_hash(&mut hasher, &path, expected_hashes, cache)?;
    }
    for path in paths {
        hasher.update(path.to_string_lossy().as_bytes());
        append_expected_or_disk_hash(&mut hasher, &path, expected_hashes, cache)?;
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn append_expected_or_disk_hash(
    hasher: &mut Sha256,
    path: &Path,
    expected_hashes: &BTreeMap<PathBuf, String>,
    cache: &mut BTreeMap<PathBuf, String>,
) -> Result<(), std::io::Error> {
    // Bytes that are about to be published take precedence over a hash that was
    // memoized during the pre-save staleness pass.
    if let Some(hash) = expected_hashes.get(path) {
        hasher.update(hash.as_bytes());
        return Ok(());
    }
    if let Some(hash) = cache.get(path) {
        hasher.update(hash.as_bytes());
        return Ok(());
    }
    match hash_file_streaming(path) {
        Ok(hash) => {
            hasher.update(hash.as_bytes());
            // Successful first-pass hashes are the save's snapshot: memoizing
            // them reuses the pre-save bytes on the second pass even if the
            // file is edited or deleted in between.  Only missing paths stay
            // uncached, so a path that appears between passes is still observed
            // instead of being pinned to the first pass's `<missing>` value.
            cache.insert(path.to_path_buf(), hash);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => hasher.update(b"<missing>"),
        Err(error) => return Err(error),
    }
    Ok(())
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
    for id in catalog.manifest.assets.keys() {
        if !referenced_assets.contains(id) {
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
        | SceneNode::ButtonRemove { next, .. } => vec![local(next)],
        SceneNode::Timeline { next, .. } => vec![local(next)],
        // A non-blocking host request: control continues to `next` in the same
        // Scene. The named window Scene is a reference, not a flow successor.
        SceneNode::OpenWindow { next, .. } => vec![local(next)],
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
        SceneNode::Set { .. }
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
        | SceneNode::OpenWindow { .. } => true,
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
        SceneNode::Action { .. } => {}
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
                    TimelineTrack::Sprite {
                        asset: Some(asset), ..
                    } => {
                        output.insert(asset.clone());
                    }
                    TimelineTrack::Video { asset, .. } => {
                        output.insert(asset.clone());
                    }
                    TimelineTrack::Sprite { asset: None, .. }
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

fn asset_folder(kind: AssetKind) -> &'static str {
    match kind {
        AssetKind::Background => "backgrounds",
        AssetKind::Sprite => "sprites",
        AssetKind::Gui => "gui",
        AssetKind::Bgm | AssetKind::Ambience | AssetKind::Sfx => "audio",
        AssetKind::Font => "fonts",
        AssetKind::Video => "videos",
    }
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

/// Map a runtime rejection to the wire error the editor UI understands.  A
/// stale revision is reported as `StaleSession` so the preview can resync
/// instead of surfacing it as a generic content error.
fn runtime_command_error(error: vectspace_core::runtime::RuntimeError) -> WireCommandError {
    use vectspace_core::runtime::RuntimeError;
    let code = match error {
        RuntimeError::StaleRevision { .. } => WireCommandErrorCode::StaleSession,
        _ => WireCommandErrorCode::Runtime,
    };
    command_error(code, error)
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
            pick_project_directory,
            pick_asset_files,
            reveal_asset,
            open_project,
            save_project,
            validate_project,
            inspect_asset_imports,
            stage_asset_imports,
            build_node_preview,
            preview_session_start,
            preview_session_advance,
            preview_session_choose,
            preview_session_click_button,
            preview_session_presentation_complete,
            preview_session_stop,
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
    fn build_node_preview_command_resolves_the_repository_choice_fixture() {
        let root = demo_root().canonicalize().unwrap();
        let catalog = ContentCatalog::from_root(root.clone()).unwrap();
        let fingerprint = project_fingerprint(&root, &catalog.manifest).unwrap();
        let payload = project_payload(
            &root,
            &catalog,
            EditorLayout::default(),
            fingerprint.clone(),
        )
        .unwrap();

        // The WebView sends the project request without host-only root/assets/
        // diagnostics fields.  Serialize the real editor payload first so
        // defaults and integer wire values follow the same IPC shape as the
        // production `projectRequest` path.
        let mut project = serde_json::to_value(&payload).unwrap();
        let object = project.as_object_mut().unwrap();
        object.remove("root");
        object.remove("assets");
        object.remove("diagnostics");
        let wire_fingerprint = object
            .remove("fingerprint")
            .expect("editor payload should carry a fingerprint");
        object.insert("expected_fingerprint".to_owned(), wire_fingerprint);
        object.insert("import_tokens".to_owned(), serde_json::json!([]));
        let request = serde_json::json!({
            "request": {
                "project": project,
                "target": { "scene_id": "prologue", "node_id": "route_choice" },
                "choices": [],
                "variable_overrides": {}
            }
        });

        let state = EditorState::default();
        state.session.lock().unwrap().replace(ProjectSession {
            root,
            catalog,
            fingerprint,
            document_models: BTreeMap::new(),
        });
        // Deserialize the exact JSON body sent through Tauri, then call the
        // command's state-backed implementation.  The public Tauri wrapper is
        // only the extractor/delegation boundary, so this still covers the
        // production validation, catalog construction and runtime preview.
        let body = request["request"].clone();
        let request: BuildNodePreviewRequest = serde_json::from_value(body).unwrap();
        let response = build_node_preview_command(request, &state).unwrap();
        let response = serde_json::to_value(response).unwrap();

        assert_eq!(response["status"], "ready");
        assert_eq!(response["update"]["snapshot"]["prompt"]["kind"], "choice");
        let choices = response["update"]["snapshot"]["prompt"]["choices"]
            .as_array()
            .unwrap();
        // ending_seen=false and score=0 filter the conditional geometry/test
        // options, while the repository's unconditional regression choices
        // remain in their authored order.
        let ids: Vec<&str> = choices
            .iter()
            .map(|choice| choice["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["algebra", "SANDBOX", "BUTTONTEST", "UIMOTIONTEST"]);
        assert_eq!(
            response["update"]["snapshot"]["prompt"]["layout"]["direction"],
            "vertical"
        );
    }

    fn editor_state_with_request(_project: &serde_json::Value) -> EditorState {
        let root = demo_root().canonicalize().unwrap();
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

    #[test]
    fn preview_session_runs_a_live_draft_and_rejects_stale_generations() {
        let root = demo_root().canonicalize().unwrap();
        let catalog = ContentCatalog::from_root(root.clone()).unwrap();
        let fingerprint = project_fingerprint(&root, &catalog.manifest).unwrap();
        let payload = project_payload(
            &root,
            &catalog,
            EditorLayout::default(),
            fingerprint.clone(),
        )
        .unwrap();
        let project = serde_json::to_value(&payload).unwrap();
        let state = editor_state_with_request(&project);
        let mut project = project;
        {
            let object = project.as_object_mut().unwrap();
            object.remove("root");
            object.remove("assets");
            object.remove("diagnostics");
            let wire_fingerprint = object.remove("fingerprint").unwrap();
            object.insert("expected_fingerprint".to_owned(), wire_fingerprint);
            object.insert("import_tokens".to_owned(), serde_json::json!([]));
        }

        let start: PreviewSessionStartRequest = serde_json::from_value(serde_json::json!({
            "project": project,
            "mode": "node",
            "scene_id": "prologue",
            "node_id": "route_choice",
            "choices": [],
            "variable_overrides": {}
        }))
        .unwrap();
        let started =
            serde_json::to_value(preview_session_start_command(start, &state).unwrap()).unwrap();
        assert_eq!(started["status"], "started");
        assert_eq!(started["update"]["snapshot"]["prompt"]["kind"], "choice");
        // The start response carries the resolved assets the surface needs.
        assert!(!started["assets"].as_array().unwrap().is_empty());
        let session_id = started["session_id"].as_str().unwrap().to_owned();
        let revision = started["update"]["snapshot"]["revision"]
            .as_str()
            .unwrap()
            .to_owned();

        // A stale session id can never act on the replacement session.
        let stale: PreviewSessionAdvanceRequest = serde_json::from_value(serde_json::json!({
            "session_id": "999999",
            "expected_revision": revision,
            "source": "manual"
        }))
        .unwrap();
        let error = preview_session_advance_command(stale, &state).unwrap_err();
        assert_eq!(error.code, WireCommandErrorCode::Validation);

        // A stale stop is a no-op that leaves the live session running.
        let stale_stop: PreviewSessionStopRequest =
            serde_json::from_value(serde_json::json!({ "session_id": "999999" })).unwrap();
        assert!(!preview_session_stop_command(stale_stop, &state).unwrap());

        // The matching command advances the same world.
        let choice_id = started["update"]["snapshot"]["prompt"]["choices"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let choose: PreviewSessionChooseRequest = serde_json::from_value(serde_json::json!({
            "session_id": session_id,
            "expected_revision": revision,
            "choice_id": choice_id
        }))
        .unwrap();
        let update = preview_session_choose_command(choose, &state).unwrap();
        assert!(
            update.snapshot.revision.parse().unwrap() > revision.parse::<u64>().unwrap()
        );

        // The matching stop releases the runtime; there is no leaked session.
        let stop: PreviewSessionStopRequest =
            serde_json::from_value(serde_json::json!({ "session_id": session_id })).unwrap();
        assert!(preview_session_stop_command(stop, &state).unwrap());
        assert!(state.preview.lock().unwrap().is_none());
    }

    #[test]
    fn preview_session_rejects_an_invalid_draft_without_installing_a_session() {
        let root = demo_root().canonicalize().unwrap();
        let catalog = ContentCatalog::from_root(root.clone()).unwrap();
        let fingerprint = project_fingerprint(&root, &catalog.manifest).unwrap();
        let payload = project_payload(
            &root,
            &catalog,
            EditorLayout::default(),
            fingerprint.clone(),
        )
        .unwrap();
        let state = editor_state_with_request(&serde_json::to_value(&payload).unwrap());
        let mut project = serde_json::to_value(&payload).unwrap();
        {
            let object = project.as_object_mut().unwrap();
            object.remove("root");
            object.remove("assets");
            object.remove("diagnostics");
            let wire_fingerprint = object.remove("fingerprint").unwrap();
            object.insert("expected_fingerprint".to_owned(), wire_fingerprint);
            object.insert("import_tokens".to_owned(), serde_json::json!([]));
        }
        // An unknown node makes the Rust scene validator fail before any
        // runtime is built, so no partially installed session can exist.
        let start: PreviewSessionStartRequest = serde_json::from_value(serde_json::json!({
            "project": project,
            "mode": "reset_node",
            "scene_id": "prologue",
            "node_id": "does_not_exist",
            "choices": [],
            "variable_overrides": {}
        }))
        .unwrap();
        let error = preview_session_start_command(start, &state).unwrap_err();
        assert_ne!(error.code, WireCommandErrorCode::StaleSession);
        assert!(state.preview.lock().unwrap().is_none());
    }

    #[test]
    fn preview_id_namespace_is_disjoint_and_overflow_checked() {
        assert_eq!(preview_id_namespace(1).unwrap(), PREVIEW_ID_STRIDE);
        assert_eq!(preview_id_namespace(2).unwrap(), 2 * PREVIEW_ID_STRIDE);
        assert!(preview_id_namespace(u64::MAX).is_err());
    }

    #[test]
    fn preview_session_allocates_a_fresh_id_namespace_per_start() {
        let root = demo_root().canonicalize().unwrap();
        let catalog = ContentCatalog::from_root(root.clone()).unwrap();
        let fingerprint = project_fingerprint(&root, &catalog.manifest).unwrap();
        let payload = project_payload(
            &root,
            &catalog,
            EditorLayout::default(),
            fingerprint.clone(),
        )
        .unwrap();
        let state = editor_state_with_request(&serde_json::to_value(&payload).unwrap());
        let mut project = serde_json::to_value(&payload).unwrap();
        {
            let object = project.as_object_mut().unwrap();
            object.remove("root");
            object.remove("assets");
            object.remove("diagnostics");
            let wire_fingerprint = object.remove("fingerprint").unwrap();
            object.insert("expected_fingerprint".to_owned(), wire_fingerprint);
            object.insert("import_tokens".to_owned(), serde_json::json!([]));
        }
        let start_once = |state: &EditorState| {
            let start: PreviewSessionStartRequest =
                serde_json::from_value(serde_json::json!({
                    "project": project.clone(),
                    "mode": "scene",
                    "scene_id": "prologue",
                    "choices": [],
                    "variable_overrides": {}
                }))
                .unwrap();
            serde_json::to_value(preview_session_start_command(start, state).unwrap()).unwrap()
        };
        let parse = |value: &serde_json::Value, path: &[&str]| -> u64 {
            let mut current = value;
            for key in path {
                current = &current[*key];
            }
            current.as_str().unwrap().parse().unwrap()
        };

        let first = start_once(&state);
        let first_session = parse(&first, &["session_id"]);
        let first_update = parse(&first, &["update", "update_id"]);
        let first_revision = parse(&first, &["update", "snapshot", "revision"]);
        let base = preview_id_namespace(first_session).unwrap();
        assert_eq!(first_update, base);
        assert!(first_revision >= base && first_revision < base + PREVIEW_ID_STRIDE);

        let second = start_once(&state);
        let second_session = parse(&second, &["session_id"]);
        let second_update = parse(&second, &["update", "update_id"]);
        assert_ne!(second_session, first_session);
        assert_ne!(second_update, first_update);
        let second_base = preview_id_namespace(second_session).unwrap();
        assert!(second_update >= second_base);
        // The windows are disjoint, so a restarted session can never reuse an
        // update id the presentation controller still remembers.
        assert!(second_base >= base + PREVIEW_ID_STRIDE);
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
        let error =
            ContentCatalog::from_documents(root, catalog.manifest.clone(), scenes, ui_motions)
                .unwrap_err();
        assert!(error.to_string().contains("目标节点不存在"));
    }

    #[test]
    fn editor_payload_encodes_button_action_integers_losslessly() {
        let mut node = serde_json::json!({
            "type": "button_create",
            "action": {
                "sets": [{
                    "variable": "score",
                    "op": "assign",
                    "value": i64::MAX
                }]
            }
        });
        encode_node_scalars(&mut node);
        assert_eq!(
            node["action"]["sets"][0]["value"],
            serde_json::json!({
                "kind": "integer",
                "value": i64::MAX.to_string()
            })
        );

        let mut reference = serde_json::json!({
            "type": "button_create",
            "action": {
                "sets": [{
                    "variable": "score",
                    "op": "assign",
                    "value": {"variable": "other"}
                }]
            }
        });
        encode_node_scalars(&mut reference);
        assert_eq!(
            reference["action"]["sets"][0]["value"],
            serde_json::json!({"variable": "other"})
        );
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
        let candidate =
            ContentCatalog::from_documents(root, catalog.manifest.clone(), scenes, ui_motions)
                .unwrap();
        assert!(analyze_catalog(&candidate)
            .iter()
            .any(|diagnostic| diagnostic.code == "immediate_cycle"));
    }

    #[test]
    fn always_replayable_chapter_map_scenes_are_reachability_roots() {
        let root = demo_root().canonicalize().unwrap();
        let catalog = ContentCatalog::from_root(root).unwrap();
        let diagnostics = analyze_catalog(&catalog);

        assert!(!diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "unreachable_node"
                && diagnostic.scene_id.as_deref() == Some("character_action_showcase")
        }));
    }

    #[test]
    fn reached_secondary_window_is_reachable_without_changing_flow_cycles() {
        let root = demo_root().canonicalize().unwrap();
        let mut catalog = ContentCatalog::from_root(root).unwrap();
        let entry_id = catalog.manifest.entry_scene.clone();
        let mut secondary = catalog.scenes[&entry_id].clone();
        secondary.id = "secondary_reachability_test".to_owned();
        secondary.entry = "entered".to_owned();
        secondary.nodes = BTreeMap::from([("entered".to_owned(), SceneNode::End)]);
        catalog.scenes.insert(secondary.id.clone(), secondary);
        let entry = catalog.scenes[&entry_id].entry.clone();
        let main_scene = catalog.scenes.get_mut(&entry_id).unwrap();
        main_scene.nodes.insert("after_window_test".to_owned(), SceneNode::End);
        main_scene.nodes.insert(
            entry,
            SceneNode::OpenWindow {
                scene: "secondary_reachability_test".to_owned(),
                next: "after_window_test".to_owned(),
            },
        );
        assert!(!analyze_catalog(&catalog).iter().any(|diagnostic| {
            diagnostic.code == "unreachable_node"
                && diagnostic.scene_id.as_deref() == Some("secondary_reachability_test")
        }));
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
    fn batch_writer_streams_source_files_into_the_same_transaction() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("staged/video.mp4");
        let target = directory.path().join("assets/video.mp4");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, b"staged media bytes").unwrap();

        atomic_write_batch_with_sources(
            directory.path(),
            &[(
                directory.path().join("manifest.yaml"),
                b"assets: video\n".to_vec(),
            )],
            &[(target.clone(), source.clone())],
            &[],
        )
        .unwrap();

        assert_eq!(fs::read(target).unwrap(), b"staged media bytes");
        assert!(
            source.is_file(),
            "the import staging file is cleaned by the caller"
        );
    }

    #[test]
    fn batch_writer_rejects_a_staged_source_changed_after_validation() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("staged/video.mp4");
        let target = directory.path().join("assets/video.mp4");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, b"actual bytes").unwrap();

        let error = atomic_write_batch_with_source_hashes(
            directory.path(),
            &[],
            &[(target.clone(), source.clone())],
            &BTreeMap::from([(source.clone(), hash_bytes(b"inspected bytes"))]),
            &[],
        )
        .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("暂存素材在保存期间发生变化"));
        assert!(!target.exists(), "a mismatched source must never publish");
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
    fn audio_import_inference_recognizes_explicit_ambience_names() {
        assert_eq!(
            inferred_asset_kind(Path::new("ambience.forest.ogg")),
            Some(WireAssetKind::Ambience)
        );
        assert_eq!(
            inferred_asset_kind(Path::new("ambient_rain.wav")),
            Some(WireAssetKind::Ambience)
        );
        assert_eq!(
            inferred_asset_kind(Path::new("button_click.ogg")),
            Some(WireAssetKind::Sfx)
        );
    }

    #[test]
    fn staged_import_headers_reject_renamed_or_empty_files() {
        assert!(validate_import_bytes(AssetKind::Background, b"\x89PNG\r\n\x1a\nminimal").is_ok());
        assert!(validate_import_bytes(AssetKind::Bgm, b"RIFF0000WAVEfmt ").is_ok());
        assert!(validate_import_bytes(AssetKind::Ambience, b"RIFF0000WAVEfmt ").is_ok());
        assert!(validate_import_bytes(AssetKind::Font, b"\x00\x01\x00\x00font").is_ok());
        assert!(validate_import_bytes(AssetKind::Video, b"\x00\x00\x00\x18ftypisom").is_ok());
        assert!(validate_import_bytes(AssetKind::Background, b"not an image").is_err());
        assert!(validate_import_bytes(AssetKind::Font, &[]).is_err());
    }

    #[test]
    fn staged_import_ids_use_the_same_identifier_contract_as_manifest_assets() {
        assert!(valid_asset_registration_id("bg.classroom-night_1"));
        assert!(valid_asset_registration_id(&"a".repeat(128)));
        assert!(!valid_asset_registration_id(""));
        assert!(!valid_asset_registration_id("../outside"));
        assert!(!valid_asset_registration_id("contains space"));
        assert!(!valid_asset_registration_id(&"a".repeat(129)));
    }

    #[test]
    fn media_signature_rejects_renamed_audio_and_accepts_canonical_headers() {
        let directory = tempdir().unwrap();
        let wav = directory.path().join("sound.wav");
        fs::write(&wav, b"RIFF0000WAVEfmt ").unwrap();
        assert!(validate_media_signature(&wav, "wav").is_ok());
        assert!(validate_media_signature(&wav, "ogg").is_err());

        let mp4 = directory.path().join("movie.mp4");
        fs::write(&mp4, b"\0\0\0\x18ftypisom").unwrap();
        assert!(validate_media_signature(&mp4, "mp4").is_ok());
        assert!(validate_media_signature(&mp4, "mp3").is_err());
    }

    #[test]
    fn identical_imports_reuse_a_formal_asset_without_claiming_ownership() {
        let root = demo_root().canonicalize().unwrap();
        let catalog = ContentCatalog::from_root(root.clone()).unwrap();
        let session = ProjectSession {
            root,
            catalog,
            fingerprint: String::new(),
            document_models: BTreeMap::new(),
        };
        let (asset_id, path, absolute) = find_reusable_asset(
            &session,
            AssetKind::Background,
            &hash_file_streaming(
                &session
                    .catalog
                    .assets_root()
                    .join("backgrounds/Photoshop_3a52oGnGn0.png"),
            )
            .unwrap(),
        )
        .unwrap()
        .expect("the demo classroom should be reusable");
        assert_eq!(asset_id, "bg.nvctsp");
        assert_eq!(path, "backgrounds/Photoshop_3a52oGnGn0.png");
        assert!(absolute.is_file());
    }

    #[test]
    fn import_path_reservations_are_case_insensitive() {
        let directory = tempdir().unwrap();
        let assets = directory.path().join("assets");
        fs::create_dir_all(assets.join("backgrounds")).unwrap();
        fs::write(assets.join("backgrounds/Classroom.PNG"), b"asset").unwrap();

        assert!(path_exists_case_insensitive(&assets, "backgrounds/classroom.png").unwrap());
        assert_eq!(
            path_reservation_key("backgrounds\\Classroom.PNG"),
            "backgrounds/classroom.png"
        );
    }

    #[test]
    fn clearing_one_project_keeps_other_project_import_staging() {
        let root = tempdir().unwrap();
        let other = tempdir().unwrap();
        let root_import = root.path().join(".vectspace/tmp/imports/import-root");
        let other_import = other.path().join(".vectspace/tmp/imports/import-other");
        fs::create_dir_all(&root_import).unwrap();
        fs::create_dir_all(&other_import).unwrap();
        fs::write(root_import.join("asset.png"), b"root").unwrap();
        fs::write(other_import.join("asset.png"), b"other").unwrap();

        let state = EditorState::default();
        state.imports.lock().unwrap().insert(
            "other-token".to_owned(),
            StagedImport {
                token: "other-token".to_owned(),
                project_root: other.path().to_path_buf(),
                id: "asset.other".to_owned(),
                kind: AssetKind::Sprite,
                relative_path: "sprites/asset.png".to_owned(),
                staged_path: other_import.join("asset.png"),
                sha256: hash_bytes(b"other"),
                owns_staged_path: true,
                reused_from: None,
                replaces: None,
            },
        );

        clear_staged_imports(&state, root.path()).unwrap();

        assert!(!root_import.exists());
        assert!(other_import.exists());
        assert!(state.imports.lock().unwrap().contains_key("other-token"));
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
        // The target is still the validated old version, but the staged
        // payload was lost.  Recovery can safely choose the old backup.
        fs::write(&target, b"old").unwrap();
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
    fn recovery_stops_on_an_external_target_conflict() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let target = root.join("scene.yaml");
        fs::write(&target, b"external").unwrap();
        let transaction_id = "457";
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

        let error = recover_pending_transactions(root).unwrap_err();
        assert!(error.to_string().contains("外部修改"));
        assert_eq!(fs::read(&target).unwrap(), b"external");
        assert!(transaction_root.exists());
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

    #[test]
    fn manifest_character_expression_assets_are_collected() {
        use vectspace_core::model::{CharacterDefinition, CharacterExpression};

        let manifest = ContentManifest {
            schema_version: 2,
            content_version: "test".to_owned(),
            entry_scene: "main".to_owned(),
            default_locale: "zh-CN".to_owned(),
            default_font: None,
            variables: BTreeMap::new(),
            characters: BTreeMap::from([(
                "alice".to_owned(),
                CharacterDefinition {
                    display_name: "Alice".to_owned(),
                    name_color: None,
                    text_color: None,
                    expressions: BTreeMap::from([(
                        "happy".to_owned(),
                        CharacterExpression {
                            asset: "sprite.alice.happy".to_owned(),
                            anchor_x: 0.5,
                            anchor_y: 1.0,
                            offset_x: 0.0,
                            offset_y: 0.0,
                            scale: 1.0,
                        },
                    )]),
                    default_expression: None,
                    default_scale: 1.0,
                },
            )]),
            assets: BTreeMap::new(),
            scenes: Vec::new(),
            ui_motions: Vec::new(),
            buttons: Vec::new(),
            ui_motion_defaults: Default::default(),
            animations: Vec::new(),
            actions: Vec::new(),
            chapter_map: None,
        };
        let mut assets = BTreeSet::new();
        collect_manifest_assets(&manifest, &mut assets);
        assert_eq!(
            assets.into_iter().collect::<Vec<_>>(),
            vec!["sprite.alice.happy".to_owned()]
        );
    }

    #[test]
    fn curtain_gui_fill_assets_are_collected() {
        use vectspace_core::model::{CurtainAction, CurtainFill, CurtainTransitionSpec, Easing};

        let curtain = |fill: Option<CurtainFill>| SceneNode::Curtain {
            action: CurtainAction::Cover,
            fill,
            transition: CurtainTransitionSpec::Fade,
            duration_ms: 300,
            easing: Easing::EaseInOut,
            await_completion: true,
            next: "end".to_owned(),
        };

        // A gui fill is a real asset reference; the unused-asset diagnostic
        // and the editor's delete protection must see it.
        let mut assets = std::collections::BTreeSet::new();
        collect_node_assets(
            &curtain(Some(CurtainFill::Asset {
                asset: "gui.curtain".to_owned(),
            })),
            &mut assets,
        );
        assert_eq!(
            assets.into_iter().collect::<Vec<_>>(),
            vec!["gui.curtain".to_owned()]
        );

        // A colour fill references no asset at all.
        let mut assets = std::collections::BTreeSet::new();
        collect_node_assets(
            &curtain(Some(CurtainFill::Color {
                color: "#000000".to_owned(),
            })),
            &mut assets,
        );
        assert!(assets.is_empty());

        // A reveal carries no fill and therefore no reference either.
        let mut assets = std::collections::BTreeSet::new();
        collect_node_assets(&curtain(None), &mut assets);
        assert!(assets.is_empty());

        // A choice icon is a real gui reference, while a button-template id is
        // not an asset and must never leak into the asset set.
        let mut assets = std::collections::BTreeSet::new();
        collect_node_assets(
            &SceneNode::Choice {
                presentation: None,
                choices: vec![vectspace_core::model::ChoiceDefinition {
                    id: "a".to_owned(),
                    label: "A".to_owned(),
                    next: "end".to_owned(),
                    visible_if: None,
                    enabled_if: None,
                    template: Some("choice.primary".to_owned()),
                    icon: Some("gui.icon".to_owned()),
                }],
            },
            &mut assets,
        );
        assert_eq!(
            assets.into_iter().collect::<Vec<_>>(),
            vec!["gui.icon".to_owned()]
        );
    }

    /// Minimal manifest that makes the fingerprint walk one document path and
    /// one static asset path (the layout file is intentionally absent).
    fn fingerprint_manifest() -> ContentManifest {
        use vectspace_core::model::AssetDefinition;

        ContentManifest {
            schema_version: 2,
            content_version: "test".to_owned(),
            entry_scene: "main".to_owned(),
            default_locale: "zh-CN".to_owned(),
            default_font: None,
            variables: BTreeMap::new(),
            characters: BTreeMap::new(),
            assets: BTreeMap::from([(
                "bg.room".to_owned(),
                AssetDefinition {
                    kind: AssetKind::Background,
                    path: Some("backgrounds/room.png".to_owned()),
                    animation: None,
                },
            )]),
            scenes: vec!["scenes/main.yaml".to_owned()],
            ui_motions: Vec::new(),
            buttons: Vec::new(),
            ui_motion_defaults: Default::default(),
            animations: Vec::new(),
            actions: Vec::new(),
            chapter_map: None,
        }
    }

    fn seed_fingerprint_project(root: &Path) -> ContentManifest {
        fs::create_dir_all(root.join("assets/backgrounds")).unwrap();
        fs::create_dir_all(root.join("scenes")).unwrap();
        fs::write(root.join("manifest.yaml"), b"manifest").unwrap();
        fs::write(root.join("scenes/main.yaml"), b"scene").unwrap();
        fs::write(root.join("assets/backgrounds/room.png"), b"png bytes one").unwrap();
        fingerprint_manifest()
    }

    #[test]
    fn save_fingerprint_cache_reuses_unchanged_hashes() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let manifest = seed_fingerprint_project(root);

        // The staleness pass fills the save-local cache from disk.
        let mut cache = BTreeMap::new();
        let first = project_fingerprint_cached(root, &manifest, &mut cache).unwrap();
        assert!(cache.contains_key(&root.join("scenes/main.yaml")));
        assert!(cache.contains_key(&root.join("assets/backgrounds/room.png")));

        // The second pass must reuse those hashes instead of reading the tree
        // again, so a later on-disk edit cannot change its result.
        fs::write(root.join("scenes/main.yaml"), b"scene edited").unwrap();
        fs::write(root.join("assets/backgrounds/room.png"), b"png bytes two").unwrap();
        let second =
            project_fingerprint_with_hashes(root, &manifest, &BTreeMap::new(), &mut cache).unwrap();
        assert_eq!(first, second);

        // Without the cache the same tree yields a different fingerprint, so
        // the equality above is real cache reuse rather than a fixed hash.
        assert_ne!(first, project_fingerprint(root, &manifest).unwrap());
    }

    #[test]
    fn save_fingerprint_expected_hashes_override_cached_disk_hashes() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let manifest = seed_fingerprint_project(root);

        let mut cache = BTreeMap::new();
        let first = project_fingerprint_cached(root, &manifest, &mut cache).unwrap();

        // Rewrite the scene on disk so the memoized hash is now stale.
        fs::write(root.join("scenes/main.yaml"), b"externally edited").unwrap();

        // The cache alone reproduces the pre-save fingerprint...
        let cached_only =
            project_fingerprint_with_hashes(root, &manifest, &BTreeMap::new(), &mut cache).unwrap();
        assert_eq!(first, cached_only);

        // ...but bytes that are about to be published win over the stale cached
        // hash, matching a fingerprint computed with no cache at all.
        let mut expected = BTreeMap::new();
        expected.insert(
            root.join("scenes/main.yaml"),
            hash_bytes(b"staged scene bytes"),
        );
        let with_expected =
            project_fingerprint_with_hashes(root, &manifest, &expected, &mut cache).unwrap();
        let reference =
            project_fingerprint_with_hashes(root, &manifest, &expected, &mut BTreeMap::new())
                .unwrap();
        assert_ne!(first, with_expected);
        assert_eq!(with_expected, reference);
    }

    #[test]
    fn save_fingerprint_cache_does_not_memoize_missing_paths() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let manifest = seed_fingerprint_project(root);
        let scene = root.join("scenes/main.yaml");
        fs::remove_file(&scene).unwrap();

        let mut cache = BTreeMap::new();
        let first = project_fingerprint_cached(root, &manifest, &mut cache).unwrap();
        assert!(
            !cache.contains_key(&scene),
            "a missing path must not be memoized"
        );

        // Because the missing entry was never cached, a path that appears
        // before the second pass is observed by that pass instead of being
        // pinned to the first pass's `<missing>` value.
        fs::write(&scene, b"scene appeared").unwrap();
        let second =
            project_fingerprint_with_hashes(root, &manifest, &BTreeMap::new(), &mut cache).unwrap();
        assert_ne!(first, second);
        assert_eq!(second, project_fingerprint(root, &manifest).unwrap());
    }

    #[test]
    fn save_fingerprint_cache_keeps_present_paths_as_snapshot() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let manifest = seed_fingerprint_project(root);
        let scene = root.join("scenes/main.yaml");

        // The first pass memoizes the present scene's bytes.
        let mut cache = BTreeMap::new();
        let first = project_fingerprint_cached(root, &manifest, &mut cache).unwrap();
        assert!(cache.contains_key(&scene));

        // A delete after the staleness pass is not absorbed into this save's
        // fingerprint: the second pass reuses the snapshot hash instead of
        // degrading to `<missing>`.
        fs::remove_file(&scene).unwrap();
        let second =
            project_fingerprint_with_hashes(root, &manifest, &BTreeMap::new(), &mut cache).unwrap();
        assert_eq!(first, second);

        // The delete is not lost, only deferred to the next save, whose fresh
        // cache sees the path as missing and fails closed on the mismatch.
        assert_ne!(first, project_fingerprint(root, &manifest).unwrap());
    }

    /* ---------------------------------------------------------------- *
     * Slice 2: editor-only asset metadata and staged same-id replacement.
     * ---------------------------------------------------------------- */

    fn write_test_png(path: &Path, width: u32, height: u32) {
        use image::{codecs::png::PngEncoder, ImageEncoder, Rgba, RgbaImage};
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let image = RgbaImage::from_pixel(width, height, Rgba([9, 21, 33, 255]));
        PngEncoder::new(File::create(path).unwrap())
            .write_image(
                image.as_raw(),
                width,
                height,
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();
    }

    fn write_test_jpeg(path: &Path, width: u32, height: u32) {
        use image::{codecs::jpeg::JpegEncoder, ImageEncoder, Rgb, RgbImage};
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let image = RgbImage::from_pixel(width, height, Rgb([9, 21, 33]));
        JpegEncoder::new(File::create(path).unwrap())
            .write_image(
                image.as_raw(),
                width,
                height,
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
    }

    /// Minimal valid project: one real 8×8 background PNG, one scene.
    fn seed_asset_project(root: &Path) {
        fs::create_dir_all(root.join("scenes")).unwrap();
        write_test_png(&root.join("assets/backgrounds/room.png"), 8, 8);
        fs::write(
            root.join("manifest.yaml"),
            b"schema_version: 2\ncontent_version: test\nentry_scene: main\ndefault_locale: zh-CN\nassets:\n  bg.room:\n    kind: background\n    path: backgrounds/room.png\nscenes:\n  - scenes/main.yaml\n",
        )
        .unwrap();
        fs::write(
            root.join("scenes/main.yaml"),
            b"schema_version: 2\nid: main\nentry: end\nnodes:\n  end:\n    type: end\n",
        )
        .unwrap();
    }

    /// Same project plus a two-frame loop animation over `bg.room`.
    fn seed_animated_asset_project(root: &Path) {
        fs::create_dir_all(root.join("scenes")).unwrap();
        fs::create_dir_all(root.join("animations")).unwrap();
        write_test_png(&root.join("assets/backgrounds/room.png"), 8, 8);
        write_test_png(&root.join("assets/backgrounds/room2.png"), 8, 8);
        fs::write(
            root.join("manifest.yaml"),
            b"schema_version: 2\ncontent_version: test\nentry_scene: main\ndefault_locale: zh-CN\nassets:\n  bg.room:\n    kind: background\n    path: backgrounds/room.png\n  bg.room2:\n    kind: background\n    path: backgrounds/room2.png\n  anim.blink:\n    kind: background\n    animation: blink\nscenes:\n  - scenes/main.yaml\nanimations:\n  - animations/blink.yaml\n",
        )
        .unwrap();
        fs::write(
            root.join("scenes/main.yaml"),
            b"schema_version: 2\nid: main\nentry: end\nnodes:\n  end:\n    type: end\n",
        )
        .unwrap();
        fs::write(
            root.join("animations/blink.yaml"),
            b"schema_version: 1\nid: blink\nframes:\n  - asset: bg.room\n    duration_ms: 100\n  - asset: bg.room2\n    duration_ms: 100\n",
        )
        .unwrap();
    }

    fn asset_session(root: &Path) -> ProjectSession {
        let root = root.canonicalize().unwrap();
        ProjectSession {
            catalog: ContentCatalog::from_root(root.clone()).unwrap(),
            root,
            fingerprint: String::new(),
            document_models: BTreeMap::new(),
        }
    }

    fn replacement_request(id: &str, kind: AssetKind, file_name: &str) -> ImportAssetRequest {
        ImportAssetRequest {
            id: id.to_owned(),
            kind,
            file_name: Some(file_name.to_owned()),
            inspection_id: None,
            replace_id: Some(id.to_owned()),
        }
    }

    #[test]
    fn layout_without_asset_metadata_loads_and_stays_minimal() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        fs::write(root.join("manifest.yaml"), b"manifest").unwrap();
        fs::create_dir_all(root.join(".vectspace")).unwrap();
        fs::write(
            root.join(LAYOUT_RELATIVE_PATH),
            br#"{"version":1,"scenes":{"main":{"nodes":{},"viewport":null}}}"#,
        )
        .unwrap();
        let layout = read_layout(root).unwrap();
        assert!(layout.asset_folders.is_empty());
        assert!(layout.asset_metadata.is_empty());
        assert!(layout.scenes.contains_key("main"));
        // Re-serializing an untouched old layout must not invent the new
        // editor-only fields.
        let text = serde_json::to_string(&layout).unwrap();
        assert!(!text.contains("asset_folders"), "{text}");
        assert!(!text.contains("asset_metadata"), "{text}");
        // A missing layout file keeps the historical default.
        assert_eq!(
            read_layout(&root.join("missing")).unwrap().version,
            EditorLayout::default().version
        );
    }

    #[test]
    fn layout_normalization_repairs_cycles_and_keeps_orphan_metadata() {
        let mut layout = EditorLayout::default();
        layout.asset_folders.insert(
            "a".to_owned(),
            AssetFolderLayout {
                parent_id: Some("b".to_owned()),
                name: "A".to_owned(),
                order: 0,
            },
        );
        layout.asset_folders.insert(
            "b".to_owned(),
            AssetFolderLayout {
                parent_id: Some("a".to_owned()),
                name: "B".to_owned(),
                order: 0,
            },
        );
        layout.asset_folders.insert(
            "dangling".to_owned(),
            AssetFolderLayout {
                parent_id: Some("missing".to_owned()),
                name: "D".to_owned(),
                order: 1,
            },
        );
        layout.asset_folders.insert(
            "bad id".to_owned(),
            AssetFolderLayout {
                parent_id: None,
                name: "X".to_owned(),
                order: 2,
            },
        );
        layout.asset_folders.insert(
            "noname".to_owned(),
            AssetFolderLayout {
                parent_id: None,
                name: "   ".to_owned(),
                order: 3,
            },
        );
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

        assert_eq!(layout.asset_folders["a"].parent_id, None);
        assert_eq!(layout.asset_folders["b"].parent_id, None);
        assert_eq!(layout.asset_folders["dangling"].parent_id, None);
        assert!(!layout.asset_folders.contains_key("bad id"));
        assert!(!layout.asset_folders.contains_key("noname"));
        // A removed asset keeps its metadata harmless instead of failing the
        // whole layout, but the folder link to a dropped/unknown folder is
        // cleared while a live folder link survives.
        let metadata = &layout.asset_metadata["bg.gone"];
        assert_eq!(metadata.display_name.as_deref(), Some("旧图"));
        assert!(metadata.folder_id.is_none());
        assert!(metadata.hidden);
        assert_eq!(
            layout.asset_metadata["bg.kept"].folder_id.as_deref(),
            Some("a")
        );
        assert!(!layout.asset_metadata.contains_key("bg.empty"));
    }

    #[test]
    fn asset_folders_and_metadata_round_trip_through_the_layout_file() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        fs::write(root.join("manifest.yaml"), b"manifest").unwrap();
        fs::create_dir_all(root.join(".vectspace")).unwrap();
        let mut layout = EditorLayout::default();
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
        fs::write(
            root.join(LAYOUT_RELATIVE_PATH),
            serde_json::to_vec(&layout).unwrap(),
        )
        .unwrap();
        let reopened = read_layout(root).unwrap();
        assert_eq!(reopened.asset_folders["bg.root"].name, "背景");
        assert_eq!(
            reopened.asset_metadata["bg.room"].display_name.as_deref(),
            Some("客厅")
        );
        assert!(reopened.asset_metadata["bg.room"].hidden);
    }

    #[test]
    fn replacement_target_requires_a_new_path_and_matching_actual_format() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        seed_asset_project(root);
        let session = asset_session(root);
        let incoming = root.join("incoming");
        write_test_png(&incoming.join("room_v2.png"), 8, 8);
        write_test_jpeg(&incoming.join("room_v2.jpg"), 8, 8);
        let png_metadata = inspect_media_source(&incoming.join("room_v2.png")).unwrap();
        let jpeg_metadata = inspect_media_source(&incoming.join("room_v2.jpg")).unwrap();

        // Same id, same kind, same actual format, brand-new path.
        let accepted = replacement_target(
            &session,
            &replacement_request("bg.room", AssetKind::Background, "room_v2.png"),
            &png_metadata,
            "backgrounds/room_v2.png",
        )
        .unwrap();
        assert_eq!(accepted.old_relative_path, "backgrounds/room.png");
        assert_eq!(accepted.old_kind, AssetKind::Background);

        // The registered destination is never overwritten.
        let same_path = replacement_target(
            &session,
            &replacement_request("bg.room", AssetKind::Background, "room.png"),
            &png_metadata,
            "backgrounds/room.png",
        )
        .unwrap_err();
        assert!(same_path.message.contains("新的文件路径"), "{same_path:?}");

        // A re-encoded upload must keep the registered format family.
        let wrong_format = replacement_target(
            &session,
            &replacement_request("bg.room", AssetKind::Background, "room_v2.jpg"),
            &jpeg_metadata,
            "backgrounds/room_v2.jpg",
        )
        .unwrap_err();
        assert!(wrong_format.message.contains("格式"), "{wrong_format:?}");

        // Kind and existence are both enforced.
        let wrong_kind = replacement_target(
            &session,
            &replacement_request("bg.room", AssetKind::Sprite, "room_v2.png"),
            &png_metadata,
            "sprites/room_v2.png",
        )
        .unwrap_err();
        assert!(wrong_kind.message.contains("原始类型"), "{wrong_kind:?}");
        let missing = replacement_target(
            &session,
            &replacement_request("bg.ghost", AssetKind::Background, "ghost.png"),
            &png_metadata,
            "backgrounds/ghost.png",
        )
        .unwrap_err();
        assert!(missing.message.contains("不存在"), "{missing:?}");
    }

    #[test]
    fn replacement_refuses_composite_animations_and_checks_frame_geometry() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        seed_animated_asset_project(root);
        let session = asset_session(root);
        assert_eq!(session.catalog.animations_referencing("bg.room"), ["blink"]);
        let incoming = root.join("incoming");
        write_test_png(&incoming.join("room_v3.png"), 8, 8);
        write_test_png(&incoming.join("room_big.png"), 16, 16);
        let matching = inspect_media_source(&incoming.join("room_v3.png")).unwrap();
        let bigger = inspect_media_source(&incoming.join("room_big.png")).unwrap();

        // Replacing a frame image is allowed while its animation keeps one
        // uniform pixel size.
        assert!(replacement_target(
            &session,
            &replacement_request("bg.room", AssetKind::Background, "room_v3.png"),
            &matching,
            "backgrounds/room_v3.png",
        )
        .is_ok());
        let resized = replacement_target(
            &session,
            &replacement_request("bg.room", AssetKind::Background, "room_big.png"),
            &bigger,
            "backgrounds/room_big.png",
        )
        .unwrap_err();
        assert!(resized.message.contains("尺寸"), "{resized:?}");

        // Replacing the composite animated asset itself needs a helper
        // explanation rather than a silent partial replacement.
        let composite = replacement_target(
            &session,
            &replacement_request("anim.blink", AssetKind::Background, "blink.png"),
            &matching,
            "backgrounds/blink.png",
        )
        .unwrap_err();
        assert!(composite.message.contains("合成动画"), "{composite:?}");
    }

    fn replacement_save_request(session: &ProjectSession, asset_path: &str) -> SaveProjectRequest {
        let mut manifest = session.catalog.manifest.clone();
        manifest.assets.get_mut("bg.room").unwrap().path = Some(asset_path.to_owned());
        SaveProjectRequest {
            manifest,
            scenes: Vec::new(),
            ui_motions: Vec::new(),
            buttons: Vec::new(),
            animations: Vec::new(),
            actions: Vec::new(),
            chapter_map: None,
            layout: EditorLayout::default(),
            expected_fingerprint: session.fingerprint.clone(),
            import_tokens: vec!["import-1".to_owned()],
        }
    }

    fn replacement_staged_import(root: &Path, old_path: &str) -> StagedImport {
        StagedImport {
            token: "import-1".to_owned(),
            project_root: root.to_path_buf(),
            id: "bg.room".to_owned(),
            kind: AssetKind::Background,
            relative_path: "backgrounds/room_v2.png".to_owned(),
            staged_path: root.join(".vectspace/tmp/imports/import-1/room_v2.png"),
            sha256: "0".repeat(64),
            owns_staged_path: true,
            reused_from: None,
            replaces: Some(StagedReplacement {
                old_relative_path: old_path.to_owned(),
                old_kind: AssetKind::Background,
            }),
        }
    }

    #[test]
    fn replacement_token_tracks_the_session_old_path() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        seed_asset_project(root);
        let session = asset_session(root);
        let root = session.root.clone();

        // The manifest now points at the new staged path, the token records
        // the old registration the session still holds.
        let request = replacement_save_request(&session, "backgrounds/room_v2.png");
        let imports = BTreeMap::from([(
            "import-1".to_owned(),
            replacement_staged_import(&root, "backgrounds/room.png"),
        )]);
        let resolved =
            staged_imports_for_request(&imports, &root, &session.catalog.manifest.assets, &request)
                .unwrap();
        assert_eq!(resolved.len(), 1);

        // An undo (or an external edit) that re-points the id at another file
        // invalidates the capability instead of re-binding it.
        let stale = BTreeMap::from([(
            "import-1".to_owned(),
            replacement_staged_import(&root, "backgrounds/moved.png"),
        )]);
        let error =
            staged_imports_for_request(&stale, &root, &session.catalog.manifest.assets, &request)
                .unwrap_err();
        assert!(error.contains("已被修改"), "{error}");

        // A token whose id is gone from the session fails closed too.
        let mut without_room = session.catalog.manifest.assets.clone();
        without_room.remove("bg.room");
        let error =
            staged_imports_for_request(&imports, &root, &without_room, &request).unwrap_err();
        assert!(error.contains("已不存在"), "{error}");
    }

    #[test]
    fn replacement_supersedes_an_earlier_staged_replacement() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        seed_asset_project(root);
        let session = asset_session(root);
        let root = session.root.clone();
        let incoming = root.join("incoming");
        write_test_png(&incoming.join("room_v2.png"), 8, 8);
        write_test_png(&incoming.join("room_v3.png"), 8, 8);

        let inspections = BTreeMap::from([
            (
                "insp-a".to_owned(),
                InspectedImport {
                    project_root: root.clone(),
                    source_path: incoming.join("room_v2.png"),
                    sha256: hash_file_streaming(&incoming.join("room_v2.png")).unwrap(),
                },
            ),
            (
                "insp-b".to_owned(),
                InspectedImport {
                    project_root: root.clone(),
                    source_path: incoming.join("room_v3.png"),
                    sha256: hash_file_streaming(&incoming.join("room_v3.png")).unwrap(),
                },
            ),
        ]);
        let request = |file_name: &str, inspection: &str| ImportAssetRequest {
            id: "bg.room".to_owned(),
            kind: AssetKind::Background,
            file_name: Some(file_name.to_owned()),
            inspection_id: Some(inspection.to_owned()),
            replace_id: Some("bg.room".to_owned()),
        };

        // First replacement: stage `room_v2.png`.
        let staged_a = prepare_asset_imports(
            &session,
            &BTreeMap::new(),
            &inspections,
            &[request("room_v2.png", "insp-a")],
            1,
        )
        .unwrap();
        assert_eq!(staged_a.len(), 1);
        assert_eq!(staged_a[0].token, "import-1-0");
        assert_eq!(staged_a[0].relative_path, "backgrounds/room_v2.png");
        assert!(staged_a[0].staged_path.is_file());

        // An undo restores the session's original path; staging a *different*
        // file for the same id must be allowed (the superseded token stays for
        // redo and its staged binary stays on disk).
        let existing = BTreeMap::from([(staged_a[0].token.clone(), staged_a[0].clone())]);
        let staged_b = prepare_asset_imports(
            &session,
            &existing,
            &inspections,
            &[request("room_v3.png", "insp-b")],
            2,
        )
        .unwrap();
        assert_eq!(staged_b[0].token, "import-2-0");
        assert_eq!(staged_b[0].relative_path, "backgrounds/room_v3.png");
        assert!(staged_a[0].staged_path.is_file());
        assert!(staged_b[0].staged_path.is_file());

        // Two replacements in one batch are still rejected.
        let batched = prepare_asset_imports(
            &session,
            &BTreeMap::new(),
            &inspections,
            &[
                request("room_v2.png", "insp-a"),
                request("room_v3.png", "insp-b"),
            ],
            4,
        )
        .unwrap_err();
        assert!(batched.message.contains("同一批次"), "{batched:?}");

        // Distinct destination reservation: reusing the superseded token's
        // path is rejected and the failed batch leaves no staged directory.
        let collide = prepare_asset_imports(
            &session,
            &existing,
            &inspections,
            &[request("room_v2.png", "insp-a")],
            3,
        )
        .unwrap_err();
        assert!(collide.message.contains("已存在或重复"), "{collide:?}");
        assert!(!root.join(".vectspace/tmp/imports/import-3-0").exists());

        // The *original* on-disk path stays forbidden even though the current
        // row now points at the staged path: the host never overwrites it.
        let original = prepare_asset_imports(
            &session,
            &existing,
            &inspections,
            &[request("room.png", "insp-a")],
            5,
        )
        .unwrap_err();
        assert!(
            original.message.contains("不能覆盖") || original.message.contains("已存在或重复"),
            "{original:?}"
        );
        assert!(root.join("assets/backgrounds/room.png").is_file());

        // Save isolation: only the token whose new path matches the manifest
        // resolves; the obsolete token fails closed instead of re-binding the
        // id, and submitting both is rejected.
        let imports = BTreeMap::from([
            (staged_a[0].token.clone(), staged_a[0].clone()),
            (staged_b[0].token.clone(), staged_b[0].clone()),
        ]);
        let mut save = replacement_save_request(&session, "backgrounds/room_v3.png");
        save.import_tokens = vec![staged_b[0].token.clone()];
        let resolved =
            staged_imports_for_request(&imports, &root, &session.catalog.manifest.assets, &save)
                .unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].relative_path, "backgrounds/room_v3.png");

        save.import_tokens = vec![staged_a[0].token.clone()];
        let stale =
            staged_imports_for_request(&imports, &root, &session.catalog.manifest.assets, &save)
                .unwrap_err();
        assert!(stale.contains("类型或目标路径已被修改"), "{stale}");

        save.import_tokens = vec![staged_a[0].token.clone(), staged_b[0].token.clone()];
        assert!(staged_imports_for_request(
            &imports,
            &root,
            &session.catalog.manifest.assets,
            &save
        )
        .is_err());
    }

    #[test]
    fn replacement_never_queues_the_old_binary_for_deletion() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let previous = fingerprint_manifest();
        let mut next = previous.clone();
        next.assets.get_mut("bg.room").unwrap().path = Some("backgrounds/room_v2.png".to_owned());
        // Removing the manifest entry entirely still never deletes the binary:
        // the editor only manages document files.
        let mut removed = previous.clone();
        removed.assets.remove("bg.room");
        assert!(managed_deletions(root, &previous, &next).is_empty());
        assert!(managed_deletions(root, &previous, &removed).is_empty());
    }
}
