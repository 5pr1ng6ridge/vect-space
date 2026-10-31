use std::path::Path;

use vectspace_proof::{library::ProofLibrary, model::ProofDocument};

use super::{common::{canonical_file_within, read_yaml, validate_relative_path}, ContentError};

pub(super) fn load(root: &Path, paths: &[String]) -> Result<ProofLibrary, ContentError> {
    let documents = paths.iter().map(|path| {
        let relative = validate_relative_path(path)?;
        let full_path = canonical_file_within(root, &root.join(relative))?;
        let document: ProofDocument = read_yaml(&full_path)?;
        Ok((path.clone(), document))
    }).collect::<Result<Vec<_>, ContentError>>()?;
    ProofLibrary::from_documents(documents).map_err(|issues| ContentError::Validation(
        issues.into_iter().map(|issue| format!("{}:{}: {}", issue.path, issue.location, issue.message))
            .collect::<Vec<_>>().join("\n"),
    ))
}
