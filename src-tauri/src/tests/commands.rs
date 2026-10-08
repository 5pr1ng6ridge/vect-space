//! Static checks of the command surface and the capability files.

use super::*;
use crate::native_window::role_for_label;

#[test]
fn window_routing_is_label_based_and_rejects_unknown_labels() {
    assert_eq!(role_for_label("main"), Some(WindowRole::Main));
    assert_eq!(role_for_label("secondary"), Some(WindowRole::Secondary));
    // Anything the host did not create is denied, so a future window cannot
    // inherit main authority by accident.
    for label in ["", "Main", "secondary ", "main-window", "evil"] {
        assert_eq!(role_for_label(label), None, "{label} must not route");
    }
}

#[test]
fn every_gate_taking_ipc_command_runs_off_the_ipc_thread() {
    // A synchronous `#[tauri::command]` runs inline on the event-loop thread on
    // Windows: creating a WebView there deadlocks the host, and blocking on the
    // session gate stalls the whole app.  So a command that takes the gate must be
    // `async`, and the commands that reach the native window seam are listed
    // explicitly so a new one cannot be added as a synchronous command by accident.
    let source = include_str!("../commands.rs");
    let mut async_commands = Vec::new();
    let mut blocking_gate_commands = Vec::new();
    for chunk in source.split("#[tauri::command]").skip(1) {
        let signature = chunk.split('{').next().unwrap_or_default();
        let name = signature
            .split("fn ")
            .nth(1)
            .and_then(|rest| rest.split('(').next())
            .expect("every command has a name")
            .trim()
            .to_owned();
        if signature.contains("async fn ") {
            async_commands.push(name);
        } else if chunk.contains("session_gate()") {
            blocking_gate_commands.push(name);
        }
    }
    assert!(
        blocking_gate_commands.is_empty(),
        "these commands block the event loop and must be async: {blocking_gate_commands:?}"
    );
    for name in [
        "bootstrap",
        "secondary_bootstrap",
        "start_new_game",
        "advance",
        "choose",
        "click_button",
        "presentation_complete",
        "get_dialogue_history",
        "get_chapter_map",
        "start_scene_replay",
        "exit_scene_replay",
        "invalidate_session",
        "save_slot",
        "load_slot",
        "secondary_advance",
        "secondary_choose",
        "secondary_click_button",
        "secondary_presentation_complete",
    ] {
        assert!(
            async_commands.iter().any(|command| command == name),
            "{name} must be an async command"
        );
    }
}

#[test]
fn secondary_capability_is_scoped_to_the_secondary_window_only() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    let read = |name: &str| -> serde_json::Value {
        serde_json::from_slice(&fs::read(root.join(name)).unwrap()).unwrap()
    };
    assert_eq!(read("default.json")["windows"], serde_json::json!(["main"]));
    let secondary = read("secondary.json");
    assert_eq!(secondary["windows"], serde_json::json!(["secondary"]));
    let permissions: Vec<&str> = secondary["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();
    // Without its own capability the secondary window could not even subscribe
    // to the host's session event.
    assert!(permissions.contains(&"core:event:allow-listen"));
    assert!(permissions.contains(&"core:event:allow-unlisten"));
    for forbidden in [
        "core:default",
        "core:window:allow-create",
        "core:webview:allow-create-webview-window",
        "core:window:allow-get-all-windows",
        "core:window:allow-fullscreen",
        "core:app:allow-register-listener",
    ] {
        assert!(
            !permissions.contains(&forbidden),
            "{forbidden} must not be granted to the secondary window"
        );
    }
    // Every capability targets a label the host actually creates, so no unknown
    // window can inherit a permission set by accident.
    for entry in fs::read_dir(&root).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        for label in value["windows"].as_array().into_iter().flatten() {
            let label = label.as_str().unwrap();
            assert!(
                role_for_label(label).is_some(),
                "capability targets unknown window label {label}"
            );
        }
    }
}
