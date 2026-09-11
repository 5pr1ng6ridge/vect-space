//! Pure VECTSPACE content and runtime core.
//!
//! Desktop hosts depend on this crate; the core never depends on Tauri or on
//! either host's resource and persistence layout.

pub mod content;
pub mod image_header;
pub mod model;
pub mod runtime;
pub mod text_template;
