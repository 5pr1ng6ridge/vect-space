//! Conversions into the wire errors the editor frontend understands.

use vectspace_core::runtime::RuntimeError;
use vectspace_protocol::{WireCommandError, WireCommandErrorCode};

pub(crate) fn display_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn command_error(code: WireCommandErrorCode, error: impl std::fmt::Display) -> WireCommandError {
    WireCommandError::new(code, error.to_string())
}

pub(crate) fn validation_command_error(error: impl std::fmt::Display) -> WireCommandError {
    command_error(WireCommandErrorCode::Validation, error)
}

pub(crate) fn io_command_error(error: impl std::fmt::Display) -> WireCommandError {
    command_error(WireCommandErrorCode::Io, error)
}

pub(crate) fn asset_command_error(error: impl std::fmt::Display) -> WireCommandError {
    command_error(WireCommandErrorCode::Asset, error)
}

pub(crate) fn internal_command_error(error: impl std::fmt::Display) -> WireCommandError {
    command_error(WireCommandErrorCode::Internal, error)
}

/// Map a runtime rejection to the wire error the editor UI understands.  A
/// stale revision is reported as `StaleSession` so the preview can resync
/// instead of surfacing it as a generic content error.
pub(crate) fn runtime_command_error(error: RuntimeError) -> WireCommandError {
    let code = match error {
        RuntimeError::StaleRevision { .. } => WireCommandErrorCode::StaleSession,
        _ => WireCommandErrorCode::Runtime,
    };
    command_error(code, error)
}
