//! Process-wide editor state shared by the Tauri commands.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, MutexGuard};

use vectspace_core::content::ContentCatalog;
use vectspace_protocol::WireCommandError;

use crate::assets::{InspectedImport, StagedImport};
use crate::error::{internal_command_error, validation_command_error};
use crate::preview::session::LivePreviewSession;

pub(crate) struct EditorState {
    pub(crate) proof_checker: Arc<Mutex<vectspace_proof::ProofChecker>>,
    pub(crate) session: Mutex<Option<ProjectSession>>,
    /// Asset imports are staged outside the managed content tree until the
    /// user saves the project.  Keeping the records in the host (rather than
    /// trusting paths sent back by the WebView) makes an import token
    /// capability-like and lets us discard abandoned imports on the next
    /// project open.
    pub(crate) imports: Mutex<BTreeMap<String, StagedImport>>,
    pub(crate) inspections: Mutex<BTreeMap<String, InspectedImport>>,
    /// A single live gameplay preview.  It owns the isolated runtime so
    /// `advance`/`choose`/`click_button`/`presentation_complete` act on the same
    /// world the editor is showing, and never touches the player's save or
    /// profile.  The lock is only held for synchronous runtime work, never
    /// across a presentation await.
    pub(crate) preview: Mutex<Option<LivePreviewSession>>,
    pub(crate) preview_ids: AtomicU64,
}

impl Default for EditorState {
    fn default() -> Self {
        let lean = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../lean");
        Self {
            session: Mutex::default(),
            imports: Mutex::default(),
            inspections: Mutex::default(),
            preview: Mutex::default(),
            preview_ids: AtomicU64::default(),
            proof_checker: Arc::new(Mutex::new(vectspace_proof::ProofChecker::new(
                vectspace_proof::LeanConfig::discover(&lean).ok(),
            ))),
        }
    }
}

pub(crate) struct ProjectSession {
    pub(crate) root: PathBuf,
    pub(crate) catalog: ContentCatalog,
    pub(crate) fingerprint: String,
    pub(crate) document_models: BTreeMap<String, serde_json::Value>,
}

impl EditorState {
    pub(crate) fn lock_session(
        &self,
    ) -> Result<MutexGuard<'_, Option<ProjectSession>>, WireCommandError> {
        self.session
            .lock()
            .map_err(|_| internal_command_error("编辑器项目锁已损坏"))
    }

    pub(crate) fn lock_imports(
        &self,
    ) -> Result<MutexGuard<'_, BTreeMap<String, StagedImport>>, WireCommandError> {
        self.imports
            .lock()
            .map_err(|_| internal_command_error("素材导入锁已损坏"))
    }

    pub(crate) fn lock_inspections(
        &self,
    ) -> Result<MutexGuard<'_, BTreeMap<String, InspectedImport>>, WireCommandError> {
        self.inspections
            .lock()
            .map_err(|_| internal_command_error("素材检查锁已损坏"))
    }

    pub(crate) fn lock_preview(
        &self,
    ) -> Result<MutexGuard<'_, Option<LivePreviewSession>>, WireCommandError> {
        self.preview
            .lock()
            .map_err(|_| internal_command_error("预览会话锁已损坏"))
    }
}

pub(crate) fn require_project(
    session: &Option<ProjectSession>,
) -> Result<&ProjectSession, WireCommandError> {
    session
        .as_ref()
        .ok_or_else(|| validation_command_error("尚未打开项目"))
}

pub(crate) fn require_project_mut(
    session: &mut Option<ProjectSession>,
) -> Result<&mut ProjectSession, WireCommandError> {
    session
        .as_mut()
        .ok_or_else(|| validation_command_error("尚未打开项目"))
}
