use super::{ack, engine, has_cue};
use crate::content::ContentCatalog;
use crate::model::{
    AdvanceSource, AmbienceSlot, AssetDefinition, AssetKind, CueGate, LoopingAudioSnapshot,
    PresentationCueKind, PresentationOutcome, PromptSnapshot,
};
use crate::runtime::RuntimeError;
use crate::test_support::catalog_with_scenes;

/// A project whose entry scene is `ambience_scene` made of the given YAML
/// nodes (flow-style lines), with one ambience asset registered.
fn ambience_project(entry: &str, nodes: &str) -> ContentCatalog {
    let mut content = catalog_with_scenes(&[
        &format!("schema_version: 2\nid: ambience_scene\nentry: {entry}\nnodes:\n{nodes}"),
        "schema_version: 2\nid: destination\nentry: end\nnodes:\n  end: {type: end}\n",
    ]);
    content.manifest.entry_scene = "ambience_scene".to_owned();
    content.manifest.assets.insert(
        "ambience.test".to_owned(),
        AssetDefinition {
            kind: AssetKind::Ambience,
            path: Some("audio/test_bgm.ogg".to_owned()),
            animation: None,
        },
    );
    content
}

fn start(slot: u8, next: &str) -> String {
    format!(
        "  start_{slot}: {{type: ambience, slot: slot_{slot}, action: start, asset: ambience.test, volume: 0.8, duration_ms: 100, next: {next}}}\n"
    )
}

#[test]
fn ambience_updates_four_slots_independently_and_replaces_or_stops_one_slot() {
    use AmbienceSlot::{Slot1, Slot2, Slot3, Slot4};

    let nodes = [
        start(1, "start_2"),
        start(2, "start_3"),
        start(3, "start_4"),
        start(4, "replace_2"),
        "  replace_2: {type: ambience, slot: slot_2, action: start, asset: ambience.test, volume: 0.35, start_ms: 900, duration_ms: 100, next: stop_3}\n".to_owned(),
        "  stop_3: {type: ambience, slot: slot_3, action: stop, duration_ms: 100, next: end}\n".to_owned(),
        "  end: {type: end}\n".to_owned(),
    ]
    .concat();
    let content = ambience_project("start_1", &nodes);
    let update = engine(&content).start_new_game(&content).unwrap();

    assert!(!update.requires_ack);
    let ambience = &update.snapshot.audio.ambience;
    assert!(ambience.get(Slot1).is_some() && ambience.get(Slot4).is_some());
    assert!(ambience.get(Slot3).is_none());
    let slot2 = ambience.get(Slot2).unwrap();
    assert_eq!((slot2.asset.as_str(), slot2.volume), ("ambience.test", 0.35));
    // Replacing a running slot reports the previous state; stopping reports `to: None`.
    assert!(has_cue(&update, |kind| matches!(
        kind,
        PresentationCueKind::AmbienceTransition { slot: Slot2, from: Some(from), to: Some(to), .. }
            if from.asset == to.asset
    )));
    assert!(has_cue(&update, |kind| matches!(
        kind,
        PresentationCueKind::AmbienceTransition { slot: Slot3, from: Some(_), to: None, .. }
    )));
}

#[test]
fn awaited_ambience_uses_the_existing_cue_gate() {
    let nodes = "  start_1: {type: ambience, slot: slot_1, action: start, asset: ambience.test, duration_ms: 100, await: true, next: end}\n  end: {type: end}\n";
    let content = ambience_project("start_1", nodes);
    let mut runtime = engine(&content);
    let update = runtime.start_new_game(&content).unwrap();
    assert!(update.requires_ack);
    assert_eq!(update.cues[0].gate, CueGate::Runtime);
    assert!(matches!(
        runtime.advance(&content, update.snapshot.revision, AdvanceSource::Manual),
        Err(RuntimeError::PresentationPending(_))
    ));
    let done = ack(&mut runtime, &content, &update);
    assert!(matches!(done.snapshot.prompt, PromptSnapshot::End { .. }));
}

#[test]
fn clear_preserves_ambience_but_scene_leave_stops_it() {
    let nodes = format!(
        "{}  clear: {{type: clear, duration_ms: 100, easing: linear, next: leave}}\n  leave: {{type: jump, scene: destination, target: end}}\n",
        start(1, "clear")
    );
    let content = ambience_project("start_1", &nodes);
    let mut runtime = engine(&content);
    let cleared = runtime.start_new_game(&content).unwrap();
    assert!(cleared.snapshot.audio.ambience.get(AmbienceSlot::Slot1).is_some());
    let left = ack(&mut runtime, &content, &cleared);
    assert!(left.snapshot.audio.ambience.is_empty());
    assert!(has_cue(&left, |kind| matches!(
        kind,
        PresentationCueKind::AmbienceTransition { slot: AmbienceSlot::Slot1, to: None, .. }
    )));
}

#[test]
fn ambience_timeline_volume_is_transient_and_does_not_change_snapshot() {
    let nodes = format!(
        "{}  timeline: {{type: timeline, duration_ms: 100, await: true, skippable: true, next: end, tracks: [{{type: ambience, slot: slot_1, channels: {{volume: [{{at_ms: 0, value: 0.2}}, {{at_ms: 100, value: 0.1}}]}}}}]}}\n  end: {{type: end}}\n",
        start(1, "timeline")
    );
    let content = ambience_project("start_1", &nodes);
    let mut runtime = engine(&content);
    let update = runtime.start_new_game(&content).unwrap();
    assert!(update.requires_ack);
    let volume = |update: &crate::model::RuntimeUpdate| {
        update.snapshot.audio.ambience.get(AmbienceSlot::Slot1).unwrap().volume
    };
    assert_eq!(volume(&update), 0.8);
    let skipped = runtime
        .presentation_complete(&content, update.update_id, PresentationOutcome::Skipped)
        .unwrap();
    assert_eq!(volume(&skipped), 0.8);
}

#[test]
fn malformed_ambience_snapshots_are_rejected_on_load() {
    let content = ambience_project("end", "  end: {type: end}\n");
    let mut runtime = engine(&content);
    let state = |asset: &str, volume: f32, start_ms: u64, loop_start: Option<u64>, loop_end: Option<u64>| {
        LoopingAudioSnapshot {
            asset: asset.to_owned(),
            volume,
            start_ms,
            loop_start_ms: loop_start,
            loop_end_ms: loop_end,
        }
    };
    let cases = [
        (state("ambience.test", f32::NAN, 0, None, None), "无效数值"),
        (state("ambience.test", 1.01, 0, None, None), "无效数值"),
        (state("ambience.test", 0.8, 0, Some(100), None), "无效数值"),
        (state("ambience.test", 0.8, 901, Some(100), Some(900)), "无效数值"),
        (state("bgm.test1", 0.8, 0, None, None), "必须引用 ambience"),
        (state("ambience.missing", 0.8, 0, None, None), "素材未登记"),
    ];
    for (audio, expected) in cases {
        let mut malformed = runtime.snapshot().clone();
        malformed.audio.ambience.set(AmbienceSlot::Slot1, Some(audio));
        assert!(
            matches!(
                runtime.load_snapshot(&content, malformed),
                Err(RuntimeError::InvalidSnapshot(message)) if message.contains(expected)
            ),
            "{expected}"
        );
    }
}
