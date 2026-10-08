use super::{ack, advance, engine, has_cue, is_dialogue, prologue};
use crate::content::ContentCatalog;
use crate::model::{
    AdvanceSource, CtrlFastForwardMode, PlaybackAutoMode, PresentationCueKind, PromptSnapshot,
    RuntimeUpdate, SceneNode, ScalarValue, VariableDefinition,
};
use crate::runtime::RuntimeError;
use crate::test_support::{fixture_catalog, from_yaml, node};

fn page_steps(update: &RuntimeUpdate) -> Vec<&str> {
    update
        .snapshot
        .long_text_page
        .as_ref()
        .expect("a retained long-text page")
        .steps
        .iter()
        .map(|step| step.step_id.as_str())
        .collect()
}

/// The fixture with `node_id` added to `prologue` and made its entry.
fn prologue_entering(node_id: &str, yaml: &str) -> ContentCatalog {
    let mut content = fixture_catalog();
    let scene = content.scenes.get_mut("prologue").unwrap();
    scene.entry = node_id.to_owned();
    scene.nodes.insert(node_id.to_owned(), node(yaml));
    content
}

#[test]
fn dialogue_prompts_resolve_speaker_style_and_stay_stable() {
    let content = fixture_catalog();
    let mut runtime = engine(&content);
    runtime.snapshot.location.node_id = "introduction".to_owned();
    runtime.run_until_boundary(&content).unwrap();
    let PromptSnapshot::Dialogue { speaker, speaker_id, name_color, text_color, text, .. } =
        &runtime.snapshot.prompt
    else {
        panic!("expected dialogue")
    };
    assert_eq!(speaker.as_deref(), Some("测试角色"));
    assert_eq!(speaker_id.as_deref(), Some("test"));
    assert_eq!(name_color.as_deref(), Some("#1D5C78"));
    assert_eq!(text_color.as_deref(), Some("#17213A"));
    assert!(text.contains("当前分数为 $0$"));

    // Interpolated values are escaped so they cannot inject markup.
    runtime
        .profile_variables
        .insert("ending_seen".to_owned(), ScalarValue::Boolean(true));
    runtime
        .snapshot
        .variables
        .insert("route".to_owned(), ScalarValue::Text("$x$[pause=1ms]".to_owned()));
    assert_eq!(
        runtime
            .interpolate_text(&content, "[var=route] / [var=ending_seen]")
            .unwrap(),
        r"\$x\$\[pause=1ms] / true"
    );

    // A speaker that is not a declared character is a temporary name without
    // styling, and the resolved snapshot text does not follow later changes.
    let mut content = fixture_catalog();
    let prologue = content.scenes.get_mut("prologue").unwrap();
    let SceneNode::Say { text, .. } = prologue.nodes.get_mut("conclusion").unwrap() else {
        panic!("expected dialogue fixture")
    };
    *text = "seen=[var=ending_seen]".to_owned();
    let mut runtime = engine(&content);
    runtime.snapshot.location.node_id = "conclusion".to_owned();
    runtime.run_until_boundary(&content).unwrap();
    let before = runtime.snapshot.prompt.clone();
    let PromptSnapshot::Dialogue { speaker, speaker_id, name_color, text_color, text, .. } = &before
    else {
        panic!("expected dialogue")
    };
    assert_eq!(speaker.as_deref(), Some("系统"));
    assert_eq!((speaker_id, name_color, text_color), (&None, &None, &None));
    assert_eq!(text, "seen=false");
    runtime
        .profile_variables
        .insert("ending_seen".to_owned(), ScalarValue::Boolean(true));
    assert_eq!(runtime.snapshot.prompt, before);

    let prologue = content.scenes.get_mut("prologue").unwrap();
    let SceneNode::Say { speaker, .. } = prologue.nodes.get_mut("conclusion").unwrap() else {
        panic!("expected dialogue fixture")
    };
    *speaker = None;
    let mut narrator = engine(&content);
    narrator.snapshot.location.node_id = "conclusion".to_owned();
    narrator.run_until_boundary(&content).unwrap();
    let PromptSnapshot::Dialogue { speaker, speaker_id, .. } = &narrator.snapshot.prompt else {
        panic!("expected dialogue")
    };
    assert_eq!((speaker, speaker_id), (&None, &None));
}

#[test]
fn dialogue_page_survives_animation_and_append_reveals_only_new_segment() {
    let content = prologue(
        "schema_version: 2\nid: prologue\nentry: first\nnodes:\n  first: {type: say, text: 前半句——, page_id: realization, next: shake}\n  shake: {type: screen_effect, effect: {type: shake}, duration_ms: 200, await: true, next: second}\n  second: {type: say, text: 后半句。, mode: append, page_id: realization, speed_cps: 20, next: end}\n  end: {type: end}\n",
    );
    let mut runtime = engine(&content);
    let first = runtime.start_new_game(&content).unwrap();
    assert_eq!(first.snapshot.dialogue_page.as_ref().unwrap().segments, ["前半句——"]);
    assert!(has_cue(&first, |kind| matches!(
        kind,
        PresentationCueKind::DialogueReveal { speed_cps: None, .. }
    )));

    let effect = advance(&mut runtime, &content, &first);
    assert!(effect.requires_ack);
    assert!(matches!(effect.snapshot.prompt, PromptSnapshot::None));
    assert_eq!(effect.snapshot.dialogue_page.as_ref().unwrap().segments, ["前半句——"]);

    let appended = ack(&mut runtime, &content, &effect);
    assert_eq!(
        appended.snapshot.dialogue_page.as_ref().unwrap().segments,
        ["前半句——", "后半句。"]
    );
    let PromptSnapshot::Dialogue { text, .. } = &appended.snapshot.prompt else {
        panic!("expected appended dialogue prompt")
    };
    assert_eq!(text, "后半句。");
    assert!(has_cue(&appended, |kind| matches!(
        kind,
        PresentationCueKind::DialogueReveal { speed_cps, .. } if *speed_cps == Some(20.0)
    )));
    assert!(advance(&mut runtime, &content, &appended).snapshot.dialogue_page.is_none());
}

#[test]
fn long_text_keeps_a_stable_paper_until_its_final_step() {
    let content = prologue_entering(
        "long_text_test",
        "type: long_text\npagination: manual\nfont_size: 36\nspeed_cps: 24\nsteps:\n- {id: definition, text: '设 $V$ 是一个向量空间。'}\n- {id: consequence, text: '因此 $0\\in V$。', page_break_before: true}\nnext: conclusion\n",
    );
    let mut runtime = engine(&content);
    let first = runtime.start_new_game(&content).unwrap();
    let PromptSnapshot::LongText { prompt_id, step_id, step_index, is_read, .. } =
        &first.snapshot.prompt
    else {
        panic!("expected first long-text step")
    };
    assert_eq!(prompt_id, "prologue/long_text_test/definition");
    assert_eq!((step_id.as_str(), *step_index, *is_read), ("definition", 0, false));
    assert_eq!(first.snapshot.location.node_id, "long_text_test");
    assert_eq!(page_steps(&first), ["definition"]);
    assert!(has_cue(&first, |kind| matches!(
        kind,
        PresentationCueKind::LongTextReveal { speed_cps, .. } if *speed_cps == Some(24.0)
    )));

    let second = advance(&mut runtime, &content, &first);
    let PromptSnapshot::LongText { prompt_id, step_index, .. } = &second.snapshot.prompt else {
        panic!("expected second long-text step")
    };
    assert_eq!(prompt_id, "prologue/long_text_test/consequence");
    assert_eq!(*step_index, 1);
    let page = second.snapshot.long_text_page.as_ref().unwrap();
    assert_eq!(page.steps.len(), 2);
    assert_eq!(page.font_size, 36.0);
    assert_eq!(page.pagination, crate::model::LongTextPagination::Manual);
    assert!(page.steps[1].page_break_before);
    assert!(runtime.read_dialogues.contains("prologue/long_text_test/definition"));

    // A save made mid-document restores without replaying any cue.
    let mut restored = crate::runtime::RuntimeEngine::with_profile(&content, runtime.profile_state(&content)).unwrap();
    let loaded = restored.load_snapshot(&content, second.snapshot.clone()).unwrap();
    assert!(loaded.cues.is_empty() && !loaded.requires_ack);
    assert!(matches!(loaded.snapshot.prompt, PromptSnapshot::LongText { is_read: false, .. }));

    let completed = advance(&mut runtime, &content, &second);
    assert!(completed.snapshot.long_text_page.is_none());
    assert!(is_dialogue(&completed));
    assert!(runtime.read_dialogues.contains("prologue/long_text_test/consequence"));
    let history = runtime
        .dialogue_history()
        .iter()
        .filter(|entry| entry.prompt_id.starts_with("prologue/long_text_test/"))
        .count();
    assert_eq!(history, 2);
}

#[test]
fn long_text_can_be_continued_after_an_intervening_dialogue() {
    let content = prologue(
        "schema_version: 2\nid: prologue\nentry: lesson_start\nnodes:\n  lesson_start: {type: long_text, document: lesson, on_exit: hide, pagination: manual, steps: [{id: statement, text: 命题。}], next: interlude}\n  interlude: {type: say, text: 先看一个图。, next: lesson_continue}\n  lesson_continue: {type: long_text, document: lesson, mode: continue, on_exit: keep_visible, steps: [{id: proof, text: 证明。, page_break_before: true}], next: end}\n  end: {type: end}\n",
    );
    let mut runtime = engine(&content);
    let first = runtime.start_new_game(&content).unwrap();
    assert_eq!(page_steps(&first), ["statement"]);
    let interlude = advance(&mut runtime, &content, &first);
    assert!(interlude.snapshot.long_text_page.as_ref().is_some_and(|page| !page.visible));
    let continuation = advance(&mut runtime, &content, &interlude);
    assert!(matches!(continuation.snapshot.prompt, PromptSnapshot::LongText { .. }));
    let page = continuation.snapshot.long_text_page.as_ref().unwrap();
    assert!(page.visible);
    assert_eq!(page_steps(&continuation), ["statement", "proof"]);
    assert_eq!(page.active_step_index, 1);

    // The prompt's step_index is local to the continuation node (zero) while
    // the retained page points at the second cumulative step (one); loading
    // must validate both indexes independently.
    let mut restored = crate::runtime::RuntimeEngine::with_profile(&content, runtime.profile_state(&content)).unwrap();
    let loaded = restored.load_snapshot(&content, continuation.snapshot.clone()).unwrap();
    assert!(loaded.cues.is_empty());
    assert_eq!(loaded.snapshot.long_text_page.as_ref().unwrap().active_step_index, 1);
    assert!(matches!(loaded.snapshot.prompt, PromptSnapshot::LongText { step_index: 0, .. }));
}

#[test]
fn revisiting_a_continuation_reuses_resolved_text_without_appending() {
    let mut content = prologue(
        "schema_version: 2\nid: prologue\nentry: start_lecture\nnodes:\n  start_lecture: {type: long_text, document: lesson, on_exit: keep_visible, pagination: auto, steps: [{id: statement, text: '分数是 [var=lecture_score]。'}], next: increase}\n  increase: {type: set, variable: lecture_score, op: add, value: 1, next: continue_lecture}\n  continue_lecture: {type: long_text, document: lesson, mode: continue, on_exit: keep_visible, steps: [{id: proof, text: '证明时分数仍是 [var=lecture_score]。'}], next: revisit}\n  revisit: {type: jump, target: continue_lecture}\n",
    );
    content.manifest.variables.insert(
        "lecture_score".to_owned(),
        from_yaml::<VariableDefinition>("{scope: save, type: integer, default: 0}"),
    );
    let mut runtime = engine(&content);
    let first = runtime.start_new_game(&content).unwrap();
    let second = advance(&mut runtime, &content, &first);
    let PromptSnapshot::LongText { text, .. } = &second.snapshot.prompt else {
        panic!("expected continuation prompt")
    };
    assert_eq!(text, "证明时分数仍是 1。");
    assert_eq!(page_steps(&second).len(), 2);

    let revisited = advance(&mut runtime, &content, &second);
    let PromptSnapshot::LongText { text, is_read, .. } = &revisited.snapshot.prompt else {
        panic!("expected re-entered continuation prompt")
    };
    assert_eq!(text, "证明时分数仍是 1。", "stored text must not be re-interpolated");
    assert!(*is_read, "a previously completed step is read on revisit");
    assert_eq!(page_steps(&revisited).len(), 2);
}

#[test]
fn long_text_controls_toggle_visibility_and_close_the_retained_page() {
    let content = prologue(
        "schema_version: 2\nid: prologue\nentry: start_lecture\nnodes:\n  start_lecture: {type: long_text, document: lesson, on_exit: keep_visible, steps: [{id: statement, text: 命题}], next: hide}\n  hide: {type: long_text_control, document: lesson, action: hide, next: show}\n  show: {type: long_text_control, document: lesson, action: show, next: observe}\n  observe: {type: say, text: 文稿已重新显示。, next: close}\n  close: {type: long_text_control, document: lesson, action: close, next: end}\n  end: {type: end}\n",
    );
    let mut runtime = engine(&content);
    let first = runtime.start_new_game(&content).unwrap();
    let say = advance(&mut runtime, &content, &first);
    assert!(say.snapshot.long_text_page.as_ref().unwrap().visible, "show must win over the preceding hide");
    assert!(is_dialogue(&say));
    let ended = advance(&mut runtime, &content, &say);
    assert!(ended.snapshot.long_text_page.is_none());
    assert!(matches!(ended.snapshot.prompt, PromptSnapshot::End { .. }));
}

#[test]
fn feature_lab_scene_plays_presentation_text_and_cross_scene_boundaries() {
    let mut content = fixture_catalog();
    content.manifest.entry_scene = "feature_lab".to_owned();
    let mut runtime = engine(&content);

    let opening = runtime.start_new_game(&content).unwrap();
    assert!(opening.requires_ack);
    assert_eq!(opening.snapshot.location.node_id, "timeline");
    let world = &opening.snapshot.world;
    assert_eq!(world.background_asset(), Some("bg.nvctsp"));
    assert_eq!(world.sprites["lab"].x, 600.0);
    assert_eq!(world.camera.zoom, 1.1);
    assert_eq!(world.ui_motion_bindings.dialogue_show.as_deref(), Some("ui.dialogue.emphasis"));
    assert_eq!(opening.snapshot.audio.bgm.as_ref().unwrap().volume, 0.25);
    assert!(has_cue(&opening, |kind| matches!(kind, PresentationCueKind::BackgroundTransition { .. })));
    assert!(has_cue(&opening, |kind| matches!(kind, PresentationCueKind::PlaySfx { .. })));
    assert!(has_cue(&opening, |kind| matches!(kind, PresentationCueKind::UiMotion { .. })));

    let timeline = ack(&mut runtime, &content, &opening);
    assert!(timeline.requires_ack);
    assert_eq!(timeline.snapshot.location.node_id, "wait_after_timeline");
    assert_eq!(timeline.snapshot.world.sprites["lab"].x, 800.0);
    assert_eq!(timeline.snapshot.world.sprites["lab"].scale, 1.2);
    assert_eq!(timeline.snapshot.world.camera.x, 0.0);
    assert_eq!(timeline.snapshot.audio.bgm.as_ref().unwrap().volume, 0.4);
    assert!(has_cue(&timeline, |kind| matches!(
        kind,
        PresentationCueKind::Timeline { duration_ms: 100, skippable: true, .. }
    )));

    let waiting = ack(&mut runtime, &content, &timeline);
    assert!(waiting.requires_ack);
    assert!(runtime.seen_presentations.contains("feature_lab/timeline"));
    assert!(has_cue(&waiting, |kind| matches!(kind, PresentationCueKind::Delay { duration_ms: 10 })));

    let first_page = ack(&mut runtime, &content, &waiting);
    let PromptSnapshot::Dialogue { text, .. } = &first_page.snapshot.prompt else {
        panic!("expected the first dialogue page")
    };
    assert_eq!(text, "第一段，变量为 0。");
    assert!(!first_page.requires_ack);
    let appended = advance(&mut runtime, &content, &first_page);
    assert_eq!(
        appended.snapshot.dialogue_page.as_ref().unwrap().segments,
        ["第一段，变量为 0。", "第二段，公式 $1+1=2$。"]
    );

    let first_long_text = advance(&mut runtime, &content, &appended);
    let PromptSnapshot::LongText { step_id, .. } = &first_long_text.snapshot.prompt else {
        panic!("expected first long-text step")
    };
    assert_eq!(step_id, "definition");
    assert_eq!(page_steps(&first_long_text).len(), 1);
    let second_long_text = advance(&mut runtime, &content, &first_long_text);
    assert_eq!(page_steps(&second_long_text).len(), 2);

    let choice = advance(&mut runtime, &content, &second_long_text);
    assert_eq!(choice.snapshot.variables["score"], ScalarValue::Integer(2));
    assert_eq!(runtime.profile_variables["ending_seen"], ScalarValue::Boolean(true));
    let PromptSnapshot::Choice { choices, .. } = &choice.snapshot.prompt else {
        panic!("expected feature-lab choice")
    };
    let enabled = |id: &str| choices.iter().find(|choice| choice.id == id).unwrap().enabled;
    assert_eq!(choices.len(), 2);
    assert!(!enabled("disabled") && enabled("proceed"));

    let leaving = runtime.choose(&content, "proceed", choice.snapshot.revision).unwrap();
    assert!(leaving.requires_ack);
    assert_eq!(leaving.snapshot.location.scene_id, "test_scene");
    assert!(runtime.completed_scenes.contains("feature_lab"));
    assert!(has_cue(&leaving, |kind| matches!(kind, PresentationCueKind::ClearScene { duration_ms: 0, .. })));
    let ending = ack(&mut runtime, &content, &leaving);
    assert!(matches!(ending.snapshot.prompt, PromptSnapshot::End { .. }));
    assert!(runtime.completed_scenes.contains("test_scene"));
    assert!(runtime.dialogue_history().is_empty());
}

fn interactive_dialogue(content: &ContentCatalog) -> crate::runtime::RuntimeEngine {
    let mut runtime = engine(content);
    runtime.started = true;
    runtime.snapshot.revision = 7;
    runtime.snapshot.location.node_id = "ending".to_owned();
    runtime.snapshot.prompt = PromptSnapshot::Dialogue {
        prompt_id: "prologue/test_line".to_owned(),
        speaker_id: None,
        speaker: None,
        name_color: None,
        text_color: None,
        text: "test".to_owned(),
        is_read: false,
    };
    runtime
}

#[test]
fn advance_sources_follow_the_authoritative_playback_policy() {
    let content = fixture_catalog();
    let normal = [AdvanceSource::Manual, AdvanceSource::Auto, AdvanceSource::FastForward];
    for source in normal {
        assert!(interactive_dialogue(&content).advance(&content, 7, source).is_ok(), "{source:?}");
    }
    assert!(matches!(
        interactive_dialogue(&content).advance(&content, 7, AdvanceSource::ForcedAuto),
        Err(RuntimeError::AdvanceNotAllowed)
    ));

    for source in normal {
        let mut forced = interactive_dialogue(&content);
        forced.snapshot.playback.auto = PlaybackAutoMode::Forced;
        assert!(matches!(forced.advance(&content, 7, source), Err(RuntimeError::AdvanceNotAllowed)));
    }
    let mut forced = interactive_dialogue(&content);
    forced.snapshot.playback.auto = PlaybackAutoMode::Forced;
    assert!(forced.advance(&content, 7, AdvanceSource::ForcedAuto).is_ok());

    let mut blocked = interactive_dialogue(&content);
    blocked.snapshot.playback.ctrl_fast_forward = CtrlFastForwardMode::Block;
    assert!(matches!(
        blocked.advance(&content, 7, AdvanceSource::FastForward),
        Err(RuntimeError::AdvanceNotAllowed)
    ));
}

#[test]
fn playback_nodes_apply_state_and_read_status_survives_new_game_and_load() {
    let mut content = fixture_catalog();
    let prologue = content.scenes.get_mut("prologue").unwrap();
    prologue.nodes.insert(
        "playback_policy_test".to_owned(),
        node("type: playback\nauto: forced\nctrl_fast_forward: block\nnext: playback_dialogue_test\n"),
    );
    prologue.nodes.insert(
        "playback_dialogue_test".to_owned(),
        node("type: say\ntext: 固定的测试对话\nnext: conclusion\n"),
    );
    let mut runtime = engine(&content);
    runtime.started = true;
    runtime.snapshot.location.node_id = "playback_policy_test".to_owned();
    runtime.run_until_boundary(&content).unwrap();
    assert_eq!(runtime.snapshot.playback.auto, PlaybackAutoMode::Forced);
    assert_eq!(runtime.snapshot.playback.ctrl_fast_forward, CtrlFastForwardMode::Block);
    let unread_snapshot = runtime.snapshot.clone();
    let PromptSnapshot::Dialogue { is_read, .. } = runtime.snapshot.prompt else {
        panic!("expected dialogue")
    };
    assert!(!is_read);

    runtime.advance(&content, 0, AdvanceSource::ForcedAuto).unwrap();
    assert!(runtime.read_dialogues.contains("prologue/playback_dialogue_test"));
    runtime.start_new_game(&content).unwrap();
    let loaded = runtime.load_snapshot(&content, unread_snapshot).unwrap();
    let PromptSnapshot::Dialogue { is_read, text, .. } = loaded.snapshot.prompt else {
        panic!("expected loaded dialogue")
    };
    assert!(is_read);
    assert!(text.contains("固定的"));
}

#[test]
fn dialogue_ui_uses_the_snapshot_binding_and_embeds_the_resolved_preset() {
    let content = fixture_catalog();
    let mut runtime = engine(&content);
    assert_eq!(
        runtime.snapshot.world.ui_motion_bindings.dialogue_show.as_deref(),
        Some("ui.dialogue.slide_in")
    );
    let first = runtime.start_new_game(&content).unwrap();
    let dialogue = ack(&mut runtime, &content, &first);
    assert!(is_dialogue(&dialogue));
    assert!(has_cue(&dialogue, |kind| matches!(
        kind,
        PresentationCueKind::DialogueUiTransition { motion: Some(motion), .. }
            if motion.id == "ui.dialogue.slide_in"
    )));
}
