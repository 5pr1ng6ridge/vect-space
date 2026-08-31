use std::path::PathBuf;

use vectspace_core::content::ContentCatalog;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let catalog = ContentCatalog::from_root(crate_root.join("tests/fixtures/game"))?;
    let target = crate_root.join("../../src-tauri/gen/content-schemas");
    catalog.write_schemas(&target)?;
    println!("wrote content schemas to {}", target.display());
    Ok(())
}
