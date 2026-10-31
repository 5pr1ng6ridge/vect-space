use super::*;

fn parse<T: serde::de::DeserializeOwned>(yaml: &str) -> T {
    let options = serde_saphyr::options! { strict_booleans: true };
    serde_saphyr::from_str_with_options(yaml, options).expect("document must parse")
}

fn parse_err<T: serde::de::DeserializeOwned>(yaml: &str) -> String {
    let options = serde_saphyr::options! { strict_booleans: true };
    match serde_saphyr::from_str_with_options::<T>(yaml, options) {
        Ok(_) => panic!("document must be rejected: {yaml}"),
        Err(error) => error.to_string(),
    }
}

fn effect(yaml_effect: &str) -> ScreenEffectSpec {
    let node: SceneNode = parse(&format!(
        "type: screen_effect\neffect: {yaml_effect}\nnext: end\n"
    ));
    let SceneNode::ScreenEffect { effect, .. } = node else {
        panic!("expected a screen_effect node");
    };
    effect
}

fn timeline_effect(yaml_effect: &str) -> ScreenEffectSpec {
    let event: TimelineEvent = parse(&format!(
        "type: screen_effect\nid: e\nat_ms: 0\neffect: {yaml_effect}\nduration_ms: 240\n"
    ));
    let TimelineEvent::ScreenEffect { effect, .. } = event else {
        panic!("expected a screen_effect event");
    };
    effect
}

#[test]
fn ambience_uses_the_fixed_four_slot_contract() {
    let node: SceneNode = parse(
        "type: ambience\nslot: slot_3\naction: start\nasset: ambience.forest\nnext: end\n",
    );
    assert!(matches!(
        node,
        SceneNode::Ambience {
            slot: AmbienceSlot::Slot3,
            action: AudioAction::Start,
            asset: Some(asset),
            volume,
            ..
        } if asset == "ambience.forest" && volume == AMBIENCE_VOLUME_DEFAULT
    ));

    let names: Vec<String> = AmbienceSlot::ALL
        .into_iter()
        .map(|slot| serde_json::to_string(&slot).unwrap())
        .collect();
    assert_eq!(names, ["\"slot_1\"", "\"slot_2\"", "\"slot_3\"", "\"slot_4\""]);
    for slot in AmbienceSlot::ALL {
        let parsed: AmbienceSlot = serde_json::from_str(&format!("\"{}\"", slot.as_str())).unwrap();
        assert_eq!(parsed, slot);
    }

    let state = LoopingAudioSnapshot {
        asset: "ambience.forest".to_owned(),
        volume: 0.35,
        start_ms: 120,
        loop_start_ms: Some(400),
        loop_end_ms: Some(1800),
    };
    let mut ambience = AmbienceSnapshot::default();
    ambience.set(AmbienceSlot::Slot2, Some(state.clone()));
    assert_eq!(ambience.get(AmbienceSlot::Slot2), Some(&state));
    assert!(ambience.get(AmbienceSlot::Slot1).is_none());

    // An empty ambience object is omitted from the wire entirely.
    let empty = serde_json::to_value(AudioSnapshot::default()).unwrap();
    assert_eq!(empty, serde_json::json!({"bgm": null}));
    let populated = serde_json::to_value(AudioSnapshot { bgm: None, ambience }).unwrap();
    assert_eq!(populated["ambience"]["slot_2"]["asset"], "ambience.forest");
    assert!(populated["ambience"].get("slot_1").is_none());
}

#[test]
fn background_transitions_parse_with_defaults() {
    let transition = |yaml: &str| {
        let SceneNode::Background { transition, .. } =
            parse::<SceneNode>(&format!("type: background\n{yaml}next: end\n"))
        else {
            panic!("expected a background node");
        };
        transition
    };
    assert_eq!(transition(""), BackgroundTransitionSpec::CrossFade);
    assert_eq!(
        transition("transition:\n  type: wipe\n  direction: left_to_right\n"),
        BackgroundTransitionSpec::Wipe {
            direction: TransitionDirection::LeftToRight,
            softness: TRANSITION_SOFTNESS_DEFAULT,
        }
    );
    assert_eq!(
        transition("transition: {type: push, direction: bottom_to_top, softness: 0.25}\n"),
        BackgroundTransitionSpec::Push {
            direction: TransitionDirection::BottomToTop,
            softness: 0.25,
        }
    );
    assert_eq!(
        transition("transition: {type: fade_through_color, color: \"#11223344\"}\n"),
        BackgroundTransitionSpec::FadeThroughColor {
            color: "#11223344".to_owned()
        }
    );
}

#[test]
fn screen_effects_default_every_omitted_parameter() {
    let default_center = (SCREEN_EFFECT_CENTER_X_DEFAULT, SCREEN_EFFECT_CENTER_Y_DEFAULT);
    let (intensity, fade_in, fade_out) = (
        SCREEN_EFFECT_INTENSITY_DEFAULT,
        SCREEN_EFFECT_FADE_IN_DEFAULT,
        SCREEN_EFFECT_FADE_OUT_DEFAULT,
    );
    let cases = [
        (
            "flash",
            ScreenEffectSpec::Flash {
                color: FLASH_COLOR_DEFAULT.to_owned(),
                peak_alpha: FLASH_PEAK_ALPHA_DEFAULT,
            },
        ),
        (
            "shake",
            ScreenEffectSpec::Shake {
                amplitude_x: SHAKE_AMPLITUDE_X_DEFAULT,
                amplitude_y: SHAKE_AMPLITUDE_Y_DEFAULT,
                frequency_hz: SHAKE_FREQUENCY_HZ_DEFAULT,
                decay: SHAKE_DECAY_DEFAULT,
                seed: SHAKE_SEED_DEFAULT,
            },
        ),
        (
            "chromatic_aberration",
            ScreenEffectSpec::ChromaticAberration {
                intensity: CHROMATIC_INTENSITY_DEFAULT,
                angle_deg: CHROMATIC_ANGLE_DEG_DEFAULT,
                center_x: default_center.0,
                center_y: default_center.1,
                edge_weight: CHROMATIC_EDGE_WEIGHT_DEFAULT,
                fade_in: CHROMATIC_FADE_IN_DEFAULT,
                fade_out: CHROMATIC_FADE_OUT_DEFAULT,
            },
        ),
        (
            "glitch",
            ScreenEffectSpec::Glitch {
                displacement: GLITCH_DISPLACEMENT_DEFAULT,
                slice_count: GLITCH_SLICE_COUNT_DEFAULT,
                density: GLITCH_DENSITY_DEFAULT,
                frequency_hz: GLITCH_FREQUENCY_HZ_DEFAULT,
                seed: GLITCH_SEED_DEFAULT,
                fade_in: GLITCH_FADE_IN_DEFAULT,
                fade_out: GLITCH_FADE_OUT_DEFAULT,
            },
        ),
        (
            "shockwave",
            ScreenEffectSpec::Shockwave {
                center_x: default_center.0,
                center_y: default_center.1,
                max_radius: SHOCKWAVE_MAX_RADIUS_DEFAULT,
                wave_width: SHOCKWAVE_WAVE_WIDTH_DEFAULT,
                strength: SHOCKWAVE_STRENGTH_DEFAULT,
            },
        ),
        (
            "color_grade",
            ScreenEffectSpec::ColorGrade {
                brightness: COLOR_GRADE_BRIGHTNESS_DEFAULT,
                contrast: COLOR_GRADE_CONTRAST_DEFAULT,
                saturation: COLOR_GRADE_SATURATION_DEFAULT,
                tint: COLOR_GRADE_TINT_DEFAULT.to_owned(),
                tint_strength: COLOR_GRADE_TINT_STRENGTH_DEFAULT,
                intensity,
                fade_in,
                fade_out,
            },
        ),
        (
            "focus",
            ScreenEffectSpec::Focus {
                center_x: default_center.0,
                center_y: default_center.1,
                radius: FOCUS_RADIUS_DEFAULT,
                softness: FOCUS_SOFTNESS_DEFAULT,
                blur: FOCUS_BLUR_DEFAULT,
                darkness: FOCUS_DARKNESS_DEFAULT,
                intensity,
                fade_in,
                fade_out,
            },
        ),
        (
            "ripple",
            ScreenEffectSpec::Ripple {
                center_x: default_center.0,
                center_y: default_center.1,
                amplitude: RIPPLE_AMPLITUDE_DEFAULT,
                wavelength: RIPPLE_WAVELENGTH_DEFAULT,
                speed: RIPPLE_SPEED_DEFAULT,
                damping: RIPPLE_DAMPING_DEFAULT,
                intensity,
                fade_in,
                fade_out,
            },
        ),
    ];
    for (name, expected) in cases {
        let yaml = format!("{{type: {name}}}");
        assert_eq!(effect(&yaml), expected, "{name} on a scene node");
        assert_eq!(timeline_effect(&yaml), expected, "{name} on a timeline event");
    }
}

#[test]
fn screen_effects_parse_overrides_and_reject_unknown_parameters() {
    assert_eq!(
        effect("{type: shake, amplitude_x: 18.0, amplitude_y: 8.0, frequency_hz: 22.0, decay: 0.75, seed: 42}"),
        ScreenEffectSpec::Shake {
            amplitude_x: 18.0,
            amplitude_y: 8.0,
            frequency_hz: 22.0,
            decay: 0.75,
            seed: 42,
        }
    );
    // An override leaves the remaining parameters at their defaults.
    assert_eq!(
        timeline_effect("{type: glitch, displacement: 64, slice_count: 20, seed: 7, fade_out: 0.3}"),
        ScreenEffectSpec::Glitch {
            displacement: 64.0,
            slice_count: 20,
            density: GLITCH_DENSITY_DEFAULT,
            frequency_hz: GLITCH_FREQUENCY_HZ_DEFAULT,
            seed: 7,
            fade_in: GLITCH_FADE_IN_DEFAULT,
            fade_out: 0.3,
        }
    );
    assert_eq!(
        effect("{type: focus, center_x: 640, center_y: 360, radius: 120, softness: 40, blur: 16, darkness: 0.6}"),
        ScreenEffectSpec::Focus {
            center_x: 640.0,
            center_y: 360.0,
            radius: 120.0,
            softness: 40.0,
            blur: 16.0,
            darkness: 0.6,
            intensity: SCREEN_EFFECT_INTENSITY_DEFAULT,
            fade_in: SCREEN_EFFECT_FADE_IN_DEFAULT,
            fade_out: SCREEN_EFFECT_FADE_OUT_DEFAULT,
        }
    );

    for unknown in [
        "{type: color_grade, sharpness: 2}",
        "{type: focus, depth: 3}",
        "{type: ripple, frequency: 5}",
        "{type: shockwave, speed: 2}",
    ] {
        let yaml = format!(
            "type: screen_effect\nid: bad\nat_ms: 0\neffect: {unknown}\nduration_ms: 240\n"
        );
        parse_err::<TimelineEvent>(&yaml);
    }
}

#[test]
fn shake_seed_stays_in_the_javascript_safe_integer_range() {
    // Number.MAX_SAFE_INTEGER; the wire is JSON, so the seed must never
    // exceed what a WebView can represent exactly.
    assert!(u64::from(SHAKE_SEED_MAX) < 9_007_199_254_740_991);
    assert!(matches!(
        effect("{type: shake, seed: 4294967295}"),
        ScreenEffectSpec::Shake { seed, .. } if seed == SHAKE_SEED_MAX
    ));
    parse_err::<SceneNode>("type: screen_effect\neffect: {type: shake, seed: 4294967296}\nnext: end\n");
}

#[test]
fn curtains_serialize_only_stable_state_and_reject_ambiguous_fills() {
    let color = CurtainSnapshot {
        covered: true,
        fill: Some(CurtainFill::Color {
            color: "#000000".to_owned(),
        }),
    };
    let json = serde_json::to_string(&color).unwrap();
    assert_eq!(json, r##"{"covered":true,"fill":{"color":"#000000"}}"##);
    assert_eq!(serde_json::from_str::<CurtainSnapshot>(&json).unwrap(), color);

    let asset = CurtainSnapshot {
        covered: true,
        fill: Some(CurtainFill::Asset {
            asset: "gui.dialogue_box".to_owned(),
        }),
    };
    assert_eq!(
        serde_json::to_string(&asset).unwrap(),
        r#"{"covered":true,"fill":{"asset":"gui.dialogue_box"}}"#
    );

    let curtain = |fill: &str| {
        format!("type: curtain\naction: cover\nfill: {fill}\ntransition: {{type: fade}}\nnext: end\n")
    };
    let both = parse_err::<SceneNode>(&curtain(r##"{color: "#000000", asset: gui.dialogue_box}"##));
    assert!(both.contains("只能"), "{both}");
    let empty = parse_err::<SceneNode>(&curtain("{}"));
    assert!(empty.contains("必须"), "{empty}");
    let unknown = parse_err::<SceneNode>(&curtain(r##"{tint: "#000000"}"##));
    assert!(unknown.contains("color"), "{unknown}");
}

#[test]
fn choice_presentation_defaults_overrides_and_rejections() {
    let SceneNode::Choice {
        presentation,
        choices,
    } = parse("type: choice\nchoices:\n- id: a\n  label: A\n  next: end\n")
    else {
        panic!("expected a choice node");
    };
    assert!(presentation.is_none());
    assert!(choices[0].template.is_none() && choices[0].icon.is_none());

    let SceneNode::Choice {
        presentation: Some(presentation),
        ..
    } = parse("type: choice\npresentation:\n  template: choice.primary\nchoices: []\n")
    else {
        panic!("expected a presentation");
    };
    assert_eq!(presentation.template.as_deref(), Some("choice.primary"));
    assert_eq!(presentation.anchor_x, CHOICE_DEFAULT_ANCHOR_X);
    assert_eq!(presentation.anchor_y, CHOICE_DEFAULT_ANCHOR_Y);
    assert_eq!(presentation.direction, ChoiceFlowDirection::Vertical);
    assert_eq!(presentation.gap, CHOICE_DEFAULT_GAP);
    assert_eq!((presentation.button_width, presentation.button_height), (None, None));

    let SceneNode::Choice {
        presentation: Some(presentation),
        choices,
    } = parse(
        "type: choice\npresentation:\n  anchor_x: 480\n  anchor_y: 810\n  direction: horizontal\n  gap: 12\n  button_width: 300\n  button_height: 72\nchoices:\n- id: a\n  label: A\n  template: choice.secondary\n  icon: gui.dialogue_box\n  next: end\n",
    )
    else {
        panic!("expected a presentation");
    };
    assert_eq!((presentation.anchor_x, presentation.anchor_y), (480.0, 810.0));
    assert_eq!(presentation.direction, ChoiceFlowDirection::Horizontal);
    assert_eq!(presentation.gap, 12.0);
    assert_eq!(presentation.button_width, Some(300.0));
    assert_eq!(presentation.button_height, Some(72.0));
    assert_eq!(choices[0].template.as_deref(), Some("choice.secondary"));
    assert_eq!(choices[0].icon.as_deref(), Some("gui.dialogue_box"));

    let typo = parse_err::<SceneNode>("type: choice\npresentation: {direction: sideways}\nchoices: []\n");
    for expected in ["sideways", "vertical", "horizontal"] {
        assert!(typo.contains(expected), "{typo}");
    }
    let unknown = parse_err::<SceneNode>("type: choice\npresentation: {spacing: 4}\nchoices: []\n");
    assert!(unknown.contains("spacing"), "{unknown}");
}
