//! Proof checks run outside the preview lock; completion revalidates the prompt.
use super::{parse_revision, run_preview_command, with_preview_session};
use crate::error::{internal_command_error, runtime_command_error, validation_command_error};
use crate::state::EditorState;
use serde::{Deserialize, Serialize};
use tauri::State;
use vectspace_core::{
    model::{PromptSnapshot, RuntimeSnapshot},
    runtime::RuntimeError,
};
use vectspace_proof::{
    board_spec, CheckMode, ProofBoardSpec, ProofCheckResult, ProofGraph, ProofStatus,
};
use vectspace_protocol::{WireCommandError, WireRuntimeUpdate, WireU64};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProofBoardRequest {
    session_id: WireU64,
    puzzle: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProofCheckRequest {
    session_id: WireU64,
    puzzle: String,
    graph: ProofGraph,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProofDraftRequest {
    session_id: WireU64,
    prompt_id: String,
    graph: ProofGraph,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProofSubmitRequest {
    session_id: WireU64,
    expected_revision: WireU64,
    graph: ProofGraph,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProofAbandonRequest {
    session_id: WireU64,
    expected_revision: WireU64,
}

#[derive(Serialize)]
pub(crate) struct ProofSubmitResult {
    accepted: bool,
    check: ProofCheckResult,
    update: Option<WireRuntimeUpdate>,
}

#[tauri::command]
pub(crate) async fn preview_proof_board(
    request: ProofBoardRequest,
    state: State<'_, EditorState>,
) -> Result<ProofBoardSpec, WireCommandError> {
    let board = proof_board_command(&request, &state)?;
    let checker = state.proof_checker.clone();
    tauri::async_runtime::spawn_blocking(move || {
        checker
            .lock()
            .map_err(|_| internal_command_error("证明检查器锁已损坏"))?
            .warm_up();
        Ok::<_, WireCommandError>(board)
    })
    .await
    .map_err(internal_command_error)?
}

fn proof_board_command(
    request: &ProofBoardRequest,
    state: &EditorState,
) -> Result<ProofBoardSpec, WireCommandError> {
    with_preview_session(state, &request.session_id, |session| {
        let mut spec = board_spec(&session.catalog.proofs, &request.puzzle)
            .ok_or_else(|| validation_command_error("证明题未登记"))?;
        if let PromptSnapshot::Proof {
            puzzle,
            draft: Some(graph),
            ..
        } = &session.runtime.snapshot().prompt
        {
            if puzzle == &request.puzzle {
                spec.initial_graph = graph.clone();
            }
        }
        Ok(spec)
    })
}

#[tauri::command]
pub(crate) async fn preview_proof_check(
    request: ProofCheckRequest,
    state: State<'_, EditorState>,
) -> Result<ProofCheckResult, WireCommandError> {
    let library = with_preview_session(&state, &request.session_id, |session| {
        if session.catalog.proofs.puzzle(&request.puzzle).is_none() {
            return Err(validation_command_error("证明题未登记"));
        }
        Ok(session.catalog.proofs.clone())
    })?;
    let checker = state.proof_checker.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(checker
            .lock()
            .map_err(|_| internal_command_error("证明检查器锁已损坏"))?
            .check(
                &library,
                &request.puzzle,
                &request.graph,
                CheckMode::Feedback,
            ))
    })
    .await
    .map_err(internal_command_error)?
}

#[tauri::command]
pub(crate) fn preview_proof_save_draft(
    request: ProofDraftRequest,
    state: State<'_, EditorState>,
) -> Result<(), WireCommandError> {
    proof_save_draft_command(request, &state)
}

fn proof_save_draft_command(
    request: ProofDraftRequest,
    state: &EditorState,
) -> Result<(), WireCommandError> {
    with_preview_session(state, &request.session_id, |session| {
        if !matches!(&session.runtime.snapshot().prompt, PromptSnapshot::Proof { prompt_id, .. } if prompt_id == &request.prompt_id)
        {
            return Err(runtime_command_error(RuntimeError::ProofNotAllowed));
        }
        session
            .runtime
            .update_proof_draft(request.graph)
            .map_err(runtime_command_error)
    })
}

#[tauri::command]
pub(crate) async fn preview_proof_submit(
    request: ProofSubmitRequest,
    state: State<'_, EditorState>,
) -> Result<ProofSubmitResult, WireCommandError> {
    proof_submit_command(request, &state).await
}

async fn proof_submit_command(
    request: ProofSubmitRequest,
    state: &EditorState,
) -> Result<ProofSubmitResult, WireCommandError> {
    let revision = parse_revision(&request.expected_revision)?;
    let (captured, library, puzzle) =
        with_preview_session(state, &request.session_id, |session| {
            let snapshot = session.runtime.snapshot();
            let PromptSnapshot::Proof { puzzle, .. } = &snapshot.prompt else {
                return Err(runtime_command_error(RuntimeError::ProofNotAllowed));
            };
            if snapshot.revision != revision {
                return Err(runtime_command_error(RuntimeError::StaleRevision {
                    expected: revision,
                    actual: snapshot.revision,
                }));
            }
            Ok((
                snapshot.clone(),
                session.catalog.proofs.clone(),
                puzzle.clone(),
            ))
        })?;
    let checker = state.proof_checker.clone();
    let check = tauri::async_runtime::spawn_blocking(move || {
        Ok::<_, WireCommandError>(
            checker
                .lock()
                .map_err(|_| internal_command_error("证明检查器锁已损坏"))?
                .check(&library, &puzzle, &request.graph, CheckMode::Verify),
        )
    })
    .await
    .map_err(internal_command_error)??;
    let accepted = check.status == ProofStatus::Complete;
    let update = if accepted {
        Some(commit_verified_proof(
            state,
            &request.session_id,
            &captured,
            revision,
        )?)
    } else {
        None
    };
    Ok(ProofSubmitResult {
        accepted,
        check,
        update,
    })
}

fn commit_verified_proof(
    state: &EditorState,
    session_id: &WireU64,
    captured: &RuntimeSnapshot,
    revision: u64,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    with_preview_session(state, session_id, |session| {
        let current = session.runtime.snapshot();
        if current.location != captured.location
            || current.interaction.prompt_instance != captured.interaction.prompt_instance
            || !matches!((&current.prompt, &captured.prompt),
                (PromptSnapshot::Proof { puzzle: current, .. }, PromptSnapshot::Proof { puzzle: expected, .. }) if current == expected)
        {
            return Err(runtime_command_error(RuntimeError::ProofNotAllowed));
        }
        run_preview_command(session, |runtime, catalog| {
            runtime.complete_proof(catalog, revision)
        })
    })
}

#[tauri::command]
pub(crate) fn preview_proof_abandon(
    request: ProofAbandonRequest,
    state: State<'_, EditorState>,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    proof_abandon_command(request, &state)
}

fn proof_abandon_command(
    request: ProofAbandonRequest,
    state: &EditorState,
) -> Result<WireRuntimeUpdate, WireCommandError> {
    let revision = parse_revision(&request.expected_revision)?;
    with_preview_session(state, &request.session_id, |session| {
        run_preview_command(session, |runtime, catalog| {
            runtime.abandon_proof(catalog, revision)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::super::tests::{demo_project_with_scene, request, start_preview};
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use vectspace_proof::ProofChecker;

    #[test]
    fn preview_proof_unavailable_draft_submit_abandon_and_stale_sessions() {
        let (mut state, project) = demo_project_with_scene(json!({
            "schema_version": 2, "id": "proof_preview", "entry": "start",
            "nodes": {
                "start": {"type": "proof", "puzzle": "and_comm", "next": "done", "abandon": "done"},
                "done": {"type": "end"}
            }
        }));
        state.proof_checker = Arc::new(Mutex::new(ProofChecker::new(None)));
        let first = start_preview(&state, &project, "proof_preview", "scene", None);
        let session = first["session_id"].as_str().unwrap();
        let board = proof_board_command(
            &request(json!({"session_id":session,"puzzle":"and_comm"})),
            &state,
        )
        .unwrap();
        let graph = board.initial_graph;
        let library = state
            .preview
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .catalog
            .proofs
            .clone();
        let feedback = state.proof_checker.lock().unwrap().check(
            &library,
            "and_comm",
            &graph,
            CheckMode::Feedback,
        );
        assert_eq!(feedback.status, ProofStatus::Unavailable);
        proof_save_draft_command(request(json!({"session_id":session,"prompt_id":first["update"]["snapshot"]["prompt"]["prompt_id"],"graph":graph})), &state).unwrap();
        let saved = proof_board_command(
            &request(json!({"session_id":session,"puzzle":"and_comm"})),
            &state,
        )
        .unwrap();
        assert_eq!(saved.initial_graph, graph);
        assert!(proof_save_draft_command(request(json!({
            "session_id": session, "prompt_id": "another-proof", "graph": graph
        })), &state).is_err());
        assert!(tauri::async_runtime::block_on(proof_submit_command(request(json!({
            "session_id": session, "expected_revision": "0", "graph": graph
        })), &state)).is_err());
        let result = tauri::async_runtime::block_on(proof_submit_command(request(json!({
            "session_id":session,"expected_revision":first["update"]["snapshot"]["revision"],"graph":graph
        })), &state)).unwrap();
        assert!(!result.accepted);
        assert_eq!(result.check.status, ProofStatus::Unavailable);
        assert!(result.update.is_none());
        let captured = state
            .preview
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .runtime
            .snapshot()
            .clone();
        let abandoned = proof_abandon_command(
            request(json!({
                "session_id":session,"expected_revision":first["update"]["snapshot"]["revision"]
            })),
            &state,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(abandoned).unwrap()["snapshot"]["prompt"]["kind"],
            "end"
        );
        assert!(commit_verified_proof(
            &state,
            &WireU64::from(session.parse::<u64>().unwrap()),
            &captured,
            captured.revision
        )
        .is_err());
        let second = start_preview(&state, &project, "proof_preview", "scene", None);
        assert!(proof_board_command(
            &request(json!({"session_id":session,"puzzle":"and_comm"})),
            &state
        )
        .is_err());
        assert!(proof_save_draft_command(request(json!({"session_id":session,"prompt_id":first["update"]["snapshot"]["prompt"]["prompt_id"],"graph":graph})), &state).is_err());
        let current = state.preview.lock().unwrap().as_ref().unwrap().runtime.snapshot().clone();
        let completed = commit_verified_proof(
            &state, &request(second["session_id"].clone()), &current, current.revision,
        ).unwrap();
        assert_eq!(serde_json::to_value(completed).unwrap()["snapshot"]["prompt"]["kind"], "end");
    }
}
