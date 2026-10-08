mod audio;
mod dialogue;
mod preview;
mod state;
mod world;

use super::RuntimeEngine;
use crate::content::ContentCatalog;
use crate::model::{
    AdvanceSource, PresentationCueKind, PresentationOutcome, PromptSnapshot, RuntimeUpdate,
};
use crate::test_support::catalog_with_scenes;

/// The fixture project with `prologue` (the entry scene) replaced by `yaml`.
fn prologue(yaml: &str) -> ContentCatalog {
    catalog_with_scenes(&[yaml])
}

fn engine(content: &ContentCatalog) -> RuntimeEngine {
    RuntimeEngine::new(content).unwrap()
}

/// Player advance from the state `update` left the engine in.
fn advance(
    runtime: &mut RuntimeEngine,
    content: &ContentCatalog,
    update: &RuntimeUpdate,
) -> RuntimeUpdate {
    runtime
        .advance(content, update.snapshot.revision, AdvanceSource::Manual)
        .unwrap()
}

/// Host acknowledgement of the presentation `update` is waiting for.
fn ack(
    runtime: &mut RuntimeEngine,
    content: &ContentCatalog,
    update: &RuntimeUpdate,
) -> RuntimeUpdate {
    runtime
        .presentation_complete(content, update.update_id, PresentationOutcome::Completed)
        .unwrap()
}

fn has_cue(update: &RuntimeUpdate, matches: impl Fn(&PresentationCueKind) -> bool) -> bool {
    update.cues.iter().any(|cue| matches(&cue.kind))
}

fn is_dialogue(update: &RuntimeUpdate) -> bool {
    matches!(update.snapshot.prompt, PromptSnapshot::Dialogue { .. })
}
