//! Blocking proof verification stays outside the story session lock. Submission
//! captures the active prompt, then validates it again inside the story transaction.
use tauri::State;
use vectspace_core::{model::{PromptSnapshot, RuntimeSnapshot}, runtime::RuntimeError};
use vectspace_proof::{
    check::{board_spec, CheckMode},
    feedback::{ProofBoardSpec, ProofCheckResult, ProofStatus},
    graph::ProofGraph,
};
use vectspace_protocol::{WireCommandError, WireCommandErrorCode, WireRuntimeUpdate, WireU64};

use crate::{commands::require_main, state::EngineState};

#[derive(serde::Serialize)]
pub(crate) struct ProofSubmitResult {
    accepted: bool,
    check: ProofCheckResult,
    update: Option<WireRuntimeUpdate>,
}

fn internal(message: impl Into<String>) -> WireCommandError {
    WireCommandError::new(WireCommandErrorCode::Internal, message)
}

impl EngineState {
    fn active_proof_snapshot(&self, session: Option<&WireU64>) -> Result<RuntimeSnapshot, WireCommandError> {
        let _gate = self.session_gate()?;
        self.check_session(session)?;
        let replay = self.replay()?;
        let snapshot = if let Some(replay) = replay.as_ref() {
            replay.runtime.snapshot().clone()
        } else { self.runtime()?.snapshot().clone() };
        if !matches!(snapshot.prompt, PromptSnapshot::Proof { .. }) {
            return Err(RuntimeError::ProofNotAllowed.into());
        }
        Ok(snapshot)
    }

    pub(crate) fn commit_verified_proof(
        &self,
        session: Option<&WireU64>,
        captured: &RuntimeSnapshot,
        revision: u64,
    ) -> Result<WireRuntimeUpdate, WireCommandError> {
        self.transact_active_runtime(session, |runtime| {
            let current = runtime.snapshot();
            if current.location != captured.location
                || current.interaction.prompt_instance != captured.interaction.prompt_instance
                || !matches!((&current.prompt, &captured.prompt),
                    (PromptSnapshot::Proof { puzzle: current, .. }, PromptSnapshot::Proof { puzzle: expected, .. }) if current == expected) {
                return Err(RuntimeError::ProofNotAllowed);
            }
            runtime.complete_proof(&self.content, revision)
        })
    }
}

#[tauri::command]
pub(crate) async fn proof_board(
    window: tauri::WebviewWindow,
    puzzle: String,
    state: State<'_, EngineState>,
) -> Result<ProofBoardSpec, WireCommandError> {
    require_main(&window)?;
    let library = state.content.proofs.clone();
    let checker = state.proof_checker.clone();
    let mut board = tauri::async_runtime::spawn_blocking(move || {
        let board = board_spec(&library, &puzzle).ok_or_else(|| {
            WireCommandError::new(WireCommandErrorCode::UnknownProof, format!("Unknown proof puzzle: {puzzle}"))
        })?;
        checker.lock().map_err(|_| internal("Proof checker mutex is poisoned"))?.warm_up();
        Ok::<_, WireCommandError>(board)
    }).await.map_err(|error| internal(error.to_string()))??;
    // A board can also be opened outside a running story. Only substitute a
    // saved draft when the current story/replay is on this exact puzzle.
    let _gate = state.session_gate()?;
    let replay = state.replay()?;
    let snapshot = if let Some(replay) = replay.as_ref() {
        replay.runtime.snapshot().clone()
    } else { state.runtime()?.snapshot().clone() };
    if let PromptSnapshot::Proof { puzzle, draft: Some(draft), .. } = snapshot.prompt {
        if puzzle == board.puzzle.id { board.initial_graph = draft; }
    }
    Ok(board)
}

#[tauri::command]
pub(crate) async fn proof_check(
    window: tauri::WebviewWindow,
    puzzle: String,
    graph: ProofGraph,
    state: State<'_, EngineState>,
) -> Result<ProofCheckResult, WireCommandError> {
    require_main(&window)?;
    if state.content.proofs.puzzle(&puzzle).is_none() {
        return Err(WireCommandError::new(WireCommandErrorCode::UnknownProof, format!("Unknown proof puzzle: {puzzle}")));
    }
    let library = state.content.proofs.clone();
    let checker = state.proof_checker.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(checker.lock().map_err(|_| internal("Proof checker mutex is poisoned"))?
            .check(&library, &puzzle, &graph, CheckMode::Feedback))
    }).await.map_err(|error| internal(error.to_string()))?
}

/// A debounced draft can arrive after its board was replaced by the next proof
/// prompt, so it names the prompt it was drawn on.
pub(crate) fn save_draft_to(
    runtime: &mut vectspace_core::runtime::RuntimeEngine,
    prompt_id: &str,
    graph: ProofGraph,
) -> Result<(), WireCommandError> {
    if !matches!(&runtime.snapshot().prompt, PromptSnapshot::Proof { prompt_id: current, .. } if current == prompt_id) {
        return Err(RuntimeError::ProofNotAllowed.into());
    }
    Ok(runtime.update_proof_draft(graph)?)
}

#[tauri::command]
pub(crate) async fn proof_save_draft(
    window: tauri::WebviewWindow,
    prompt_id: String,
    graph: ProofGraph,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<(), WireCommandError> {
    require_main(&window)?;
    let _gate = state.session_gate()?;
    state.check_session(expected_session_id.as_ref())?;
    let mut replay = state.replay()?;
    if let Some(replay) = replay.as_mut() {
        save_draft_to(&mut replay.runtime, &prompt_id, graph)
    } else {
        let mut runtime = state.runtime()?;
        save_draft_to(&mut runtime, &prompt_id, graph)
    }
}

#[tauri::command]
pub(crate) async fn proof_submit(
    window: tauri::WebviewWindow,
    expected_revision: WireU64,
    expected_session_id: Option<WireU64>,
    graph: ProofGraph,
    state: State<'_, EngineState>,
) -> Result<ProofSubmitResult, WireCommandError> {
    require_main(&window)?;
    let revision = expected_revision.parse().map_err(WireCommandError::from)?;
    let captured = state.active_proof_snapshot(expected_session_id.as_ref())?;
    if captured.revision != revision {
        return Err(RuntimeError::StaleRevision { expected: revision, actual: captured.revision }.into());
    }
    let PromptSnapshot::Proof { puzzle, .. } = &captured.prompt else { unreachable!() };
    let puzzle = puzzle.clone();
    let library = state.content.proofs.clone();
    let checker = state.proof_checker.clone();
    let check = tauri::async_runtime::spawn_blocking(move || {
        Ok::<_, WireCommandError>(checker.lock().map_err(|_| internal("Proof checker mutex is poisoned"))?
            .check(&library, &puzzle, &graph, CheckMode::Verify))
    }).await.map_err(|error| internal(error.to_string()))??;
    let accepted = check.status == ProofStatus::Complete;
    let update = if accepted {
        Some(state.commit_verified_proof(expected_session_id.as_ref(), &captured, revision)?)
    } else { None };
    Ok(ProofSubmitResult { accepted, check, update })
}

#[tauri::command]
pub(crate) async fn proof_abandon(
    window: tauri::WebviewWindow,
    expected_revision: WireU64,
    expected_session_id: Option<WireU64>,
    state: State<'_, EngineState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    require_main(&window)?;
    let revision = expected_revision.parse().map_err(WireCommandError::from)?;
    state.transact_active_runtime(expected_session_id.as_ref(), |runtime| {
        runtime.abandon_proof(&state.content, revision)
    })
}
