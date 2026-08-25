// The game remains the canonical home of these modules during the editor
// extraction. Both binaries compile these exact source files, so YAML and
// runtime semantics cannot silently drift apart.
#[path = "../../../src-tauri/src/model.rs"]
pub mod model;

#[path = "../../../src-tauri/src/content.rs"]
pub mod content;

#[path = "../../../src-tauri/src/runtime.rs"]
pub mod runtime;

