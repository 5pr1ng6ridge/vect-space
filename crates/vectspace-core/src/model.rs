//! Stable content, runtime and persistence models shared by both desktop hosts.
//!
//! Every public item lives in a topic submodule and is re-exported here, so
//! consumers keep addressing the types as `vectspace_core::model::*`.

mod animation;
mod assets;
mod audio;
mod chapter_map;
mod choice;
mod effects;
mod manifest;
mod persistence;
mod scene;
mod snapshot;
mod text;
mod timeline;
mod transition;
mod ui;
mod update;
mod variables;

pub use animation::*;
pub use assets::*;
pub use audio::*;
pub use chapter_map::*;
pub use choice::*;
pub use effects::*;
pub use manifest::*;
pub use persistence::*;
pub use scene::*;
pub use snapshot::*;
pub use text::*;
pub use timeline::*;
pub use transition::*;
pub use ui::*;
pub use update::*;
pub use variables::*;

fn default_true() -> bool {
    true
}

fn default_volume() -> f32 {
    1.0
}

fn default_short_duration() -> u64 {
    200
}

fn default_scale_component() -> f32 {
    1.0
}

#[cfg(test)]
mod tests;
