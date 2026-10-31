use vectspace_proof::{graph::ProofGraph, library::validate_draft_shape};

use crate::{content::ContentCatalog, model::{PromptSnapshot, RuntimeUpdate, SceneNode}};
use super::{RuntimeEngine, RuntimeError};

impl RuntimeEngine {
    /// Draft syncing is presentation-neutral and does not consume a revision.
    pub fn update_proof_draft(&mut self, graph: ProofGraph) -> Result<(), RuntimeError> {
        let PromptSnapshot::Proof { draft, .. } = &mut self.snapshot.prompt else {
            return Err(RuntimeError::ProofNotAllowed);
        };
        validate_draft_shape(&graph).map_err(RuntimeError::InvalidProofDraft)?;
        *draft = Some(graph);
        Ok(())
    }

    pub fn complete_proof(&mut self, content: &ContentCatalog, expected_revision: u64) -> Result<RuntimeUpdate, RuntimeError> {
        self.finish_proof(content, expected_revision, false)
    }

    pub fn abandon_proof(&mut self, content: &ContentCatalog, expected_revision: u64) -> Result<RuntimeUpdate, RuntimeError> {
        self.finish_proof(content, expected_revision, true)
    }

    fn finish_proof(&mut self, content: &ContentCatalog, expected_revision: u64, abandoning: bool) -> Result<RuntimeUpdate, RuntimeError> {
        self.ensure_interactive(expected_revision)?;
        let PromptSnapshot::Proof { puzzle, .. } = &self.snapshot.prompt else {
            return Err(RuntimeError::ProofNotAllowed);
        };
        let scene = content.scene(&self.snapshot.location.scene_id)
            .map_err(|error| RuntimeError::Content(error.to_string()))?;
        let Some(SceneNode::Proof { puzzle: expected, next, abandon }) = scene.nodes.get(&self.snapshot.location.node_id) else {
            return Err(RuntimeError::ProofNotAllowed);
        };
        if expected != puzzle { return Err(RuntimeError::ProofNotAllowed); }
        let target = if abandoning {
            abandon.as_ref().ok_or(RuntimeError::ProofAbandonNotAllowed)?
        } else {
            self.solved_proofs.insert(puzzle.clone());
            next
        };
        self.snapshot.location.node_id.clone_from(target);
        self.snapshot.prompt = PromptSnapshot::None;
        let cues = self.run_until_boundary(content)?;
        Ok(self.finish_update(cues, true))
    }
}
