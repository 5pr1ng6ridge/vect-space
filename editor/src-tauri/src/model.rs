//! Wire types of the project payload the editor receives and sends back.

use serde::{Deserialize, Serialize, Serializer};
use vectspace_core::model::{
    AssetKind, ButtonTemplate, ChapterMapDefinition, ContentManifest, ImageAnimationDefinition,
    SceneDefinition, SpriteActionDefinition, UiMotionPreset,
};
use vectspace_core::visual::{ParticleDefinition, TextBlockDefinition};
use vectspace_protocol::{WireAssetMetadata, WireU64};

use crate::layout::EditorLayout;
use crate::scalars::{decode_wire_scalars, encode_project_scalars};

#[derive(Debug, Clone)]
pub(crate) struct EditorProject {
    pub(crate) root: String,
    pub(crate) manifest: ContentManifest,
    pub(crate) scenes: Vec<EditorSceneFile>,
    pub(crate) ui_motions: Vec<EditorUiMotionFile>,
    pub(crate) buttons: Vec<EditorButtonFile>,
    pub(crate) animations: Vec<EditorAnimationFile>,
    pub(crate) actions: Vec<EditorActionFile>,
    pub(crate) text_blocks: Vec<EditorTextBlockFile>,
    pub(crate) particles: Vec<EditorParticleFile>,
    pub(crate) chapter_map: Option<EditorChapterMapFile>,
    pub(crate) layout: EditorLayout,
    pub(crate) assets: Vec<EditorAsset>,
    pub(crate) diagnostics: Vec<EditorDiagnostic>,
    pub(crate) fingerprint: String,
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
    text_blocks: &'a [EditorTextBlockFile],
    particles: &'a [EditorParticleFile],
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
            text_blocks: &self.text_blocks,
            particles: &self.particles,
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
pub(crate) struct SaveProjectResult {
    pub(crate) project: EditorProject,
    pub(crate) changed_paths: Vec<String>,
    pub(crate) deleted_paths: Vec<String>,
    pub(crate) warnings: Vec<EditorDiagnostic>,
    pub(crate) transaction_id: Option<String>,
}

/// One content document keyed by the manifest path that lists it.  Unsaved
/// drafts travel through the same shape as a saved file, so preview and commit
/// validate identical bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EditorFile<T> {
    pub(crate) path: String,
    pub(crate) definition: T,
}

pub(crate) type EditorSceneFile = EditorFile<SceneDefinition>;
pub(crate) type EditorUiMotionFile = EditorFile<UiMotionPreset>;
pub(crate) type EditorButtonFile = EditorFile<ButtonTemplate>;
pub(crate) type EditorAnimationFile = EditorFile<ImageAnimationDefinition>;
pub(crate) type EditorActionFile = EditorFile<SpriteActionDefinition>;
pub(crate) type EditorChapterMapFile = EditorFile<ChapterMapDefinition>;
pub(crate) type EditorTextBlockFile = EditorFile<TextBlockDefinition>;
pub(crate) type EditorParticleFile = EditorFile<ParticleDefinition>;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct EditorAsset {
    pub(crate) id: String,
    pub(crate) kind: AssetKind,
    /// Static image path.  Animated assets carry `animation` instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) path: Option<String>,
    /// Loop animation document id, present for animated assets.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) animation: Option<String>,
    pub(crate) absolute_path: String,
    pub(crate) size_bytes: WireU64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) metadata: Option<WireAssetMetadata>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct EditorDiagnostic {
    pub(crate) severity: DiagnosticSeverity,
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) scene_id: Option<String>,
    pub(crate) node_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DiagnosticSeverity {
    Warning,
    Info,
}

#[derive(Debug)]
pub(crate) struct SaveProjectRequest {
    pub(crate) manifest: ContentManifest,
    pub(crate) scenes: Vec<EditorSceneFile>,
    pub(crate) ui_motions: Vec<EditorUiMotionFile>,
    pub(crate) buttons: Vec<EditorButtonFile>,
    pub(crate) animations: Vec<EditorAnimationFile>,
    pub(crate) actions: Vec<EditorActionFile>,
    pub(crate) text_blocks: Vec<EditorTextBlockFile>,
    pub(crate) particles: Vec<EditorParticleFile>,
    pub(crate) chapter_map: Option<EditorChapterMapFile>,
    pub(crate) layout: EditorLayout,
    pub(crate) expected_fingerprint: String,
    pub(crate) import_tokens: Vec<String>,
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
    #[serde(default)]
    text_blocks: Vec<EditorTextBlockFile>,
    #[serde(default)]
    particles: Vec<EditorParticleFile>,
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
            text_blocks: raw.text_blocks,
            particles: raw.particles,
            chapter_map: raw.chapter_map,
            layout: raw.layout,
            expected_fingerprint: raw.expected_fingerprint,
            import_tokens: raw.import_tokens,
        })
    }
}
