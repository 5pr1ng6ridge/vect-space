//! Validate authored cards and reference solutions using the real Lean server.
use serde::Deserialize;
use std::{path::PathBuf, process::ExitCode};
use vectspace_proof::{
    CheckMode, LeanConfig, ProofChecker, ProofDocument, ProofLibrary, ProofStatus,
};
#[derive(Deserialize)]
struct Manifest {
    #[serde(default)]
    proofs: Vec<String>,
}
fn run() -> Result<(), String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let args: Vec<_> = std::env::args().skip(1).collect();
    let files: Vec<PathBuf> = if args.is_empty() {
        let manifest: Manifest = serde_saphyr::from_str(
            &std::fs::read_to_string(root.join("game/manifest.yaml")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        manifest
            .proofs
            .into_iter()
            .map(|p| root.join("game").join(p))
            .collect()
    } else {
        args.into_iter().map(PathBuf::from).collect()
    };
    if files.is_empty() {
        return Err("manifest has no proofs; pass proof document paths explicitly".into());
    }
    let documents = files
        .into_iter()
        .map(|path| {
            let source =
                std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let document: ProofDocument =
                serde_saphyr::from_str(&source).map_err(|e| format!("{}: {e}", path.display()))?;
            Ok((path.display().to_string(), document))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let library = ProofLibrary::from_documents(documents).map_err(|issues| {
        issues
            .into_iter()
            .map(|i| format!("{} {}: {}", i.path, i.location, i.message))
            .collect::<Vec<_>>()
            .join("\n")
    })?;
    let mut checker = ProofChecker::new(Some(LeanConfig::discover(&root.join("lean"))?));
    let mut source = vectspace_proof::compile::HEADER.to_owned();
    source.push_str("namespace VS\n");
    // Every card is checked, including cards not enabled in any reference puzzle.
    for card in library.cards() {
        source.push_str(&vectspace_proof::compile::card_source(card));
    }
    source.push_str("end VS\n");
    let response = checker.check_card_source(&source)?;
    let card_errors = response["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| {
            m["severity"] == "error" || m["kind"].as_str().is_some_and(|k| k.contains("hasSorry"))
        })
        .map(|m| m["data"].as_str().unwrap_or_default().to_owned())
        .collect::<Vec<_>>();
    if !card_errors.is_empty() {
        return Err(format!("card proof failure:\n{}", card_errors.join("\n")));
    }
    println!("cards: {} verified", library.cards().count());
    let mut failed = false;
    for puzzle in library.puzzles() {
        let Some(solution) = &puzzle.solution else {
            println!("{}: no reference solution", puzzle.id);
            continue;
        };
        let result = checker.check(&library, &puzzle.id, solution, CheckMode::Verify);
        println!(
            "{}: {:?} ({} ms)",
            puzzle.id, result.status, result.elapsed_ms
        );
        if result.status != ProofStatus::Complete {
            failed = true;
            for d in result.diagnostics {
                eprintln!(
                    "  {} {:?}: {} {}",
                    d.code,
                    d.node,
                    d.message,
                    d.detail.unwrap_or_default()
                );
            }
        }
    }
    if failed {
        Err("reference solution verification failed".into())
    } else {
        Ok(())
    }
}
fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
