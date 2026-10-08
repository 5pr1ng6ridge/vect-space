use std::fs;
use std::path::PathBuf;

use super::{assert_node_valid, node_error};
use crate::model::*;
use crate::test_support::{fixture_catalog, node};

#[test]
fn generated_development_schemas_are_current() {
    let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let catalog = fixture_catalog();
    let generated = tempfile::tempdir().unwrap();
    catalog.write_schemas(generated.path()).unwrap();
    let checked_in = crate_root.join("../../src-tauri/gen/content-schemas");
    for name in [
        "manifest.schema.json",
        "scene.schema.json",
        "chapter-map.schema.json",
        "ui-motion.schema.json",
        "button.schema.json",
        "image-animation.schema.json",
    ] {
        assert_eq!(
            fs::read(generated.path().join(name)).unwrap(),
            fs::read(checked_in.join(name)).unwrap(),
            "generated schema is stale: {name}"
        );
    }
}

#[test]
fn generated_schema_tracks_canonical_screen_effect_bounds() {
    let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let text = fs::read_to_string(
        crate_root.join("../../src-tauri/gen/content-schemas/scene.schema.json"),
    )
    .unwrap();
    let schema: serde_json::Value = serde_json::from_str(&text).unwrap();
    let variants = schema["$defs"]["ScreenEffectSpec"]["oneOf"]
        .as_array()
        .expect("screen effect variants");
    let properties = |name: &str| {
        variants
            .iter()
            .find(|variant| variant["properties"]["type"]["const"] == name)
            .unwrap_or_else(|| panic!("missing variant {name}"))["properties"]
            .clone()
    };
    let bound = |value: &serde_json::Value, key: &str| {
        value[key]
            .as_f64()
            .unwrap_or_else(|| panic!("missing {key} bound in {value}"))
    };

    let check = |props: &serde_json::Value, label: &str, cases: &[(&str, f32, f32)]| {
        for (field, minimum, maximum) in cases {
            assert_eq!(
                bound(&props[*field], "minimum"),
                f64::from(*minimum),
                "{label} {field} minimum"
            );
            assert_eq!(
                bound(&props[*field], "maximum"),
                f64::from(*maximum),
                "{label} {field} maximum"
            );
        }
    };

    // Regression for the accepted schedule/validator disagreement: the
    // generated schema now carries the canonical 1..=32 slice-count bound.
    let glitch = properties("glitch");
    assert_eq!(
        bound(&glitch["slice_count"], "minimum"),
        f64::from(GLITCH_SLICE_COUNT_MIN)
    );
    assert_eq!(
        bound(&glitch["slice_count"], "maximum"),
        f64::from(GLITCH_SLICE_COUNT_MAX)
    );
    check(
        &glitch,
        "glitch",
        &[
            ("displacement", 0.0, GLITCH_DISPLACEMENT_MAX),
            ("density", GLITCH_DENSITY_MIN, GLITCH_DENSITY_MAX),
            (
                "frequency_hz",
                GLITCH_FREQUENCY_HZ_MIN,
                GLITCH_FREQUENCY_HZ_MAX,
            ),
            ("fade_in", SCREEN_EFFECT_FADE_MIN, SCREEN_EFFECT_FADE_MAX),
            ("fade_out", SCREEN_EFFECT_FADE_MIN, SCREEN_EFFECT_FADE_MAX),
        ],
    );

    check(
        &properties("chromatic_aberration"),
        "chromatic_aberration",
        &[
            ("intensity", 0.0, CHROMATIC_INTENSITY_MAX),
            (
                "angle_deg",
                CHROMATIC_ANGLE_DEG_MIN,
                CHROMATIC_ANGLE_DEG_MAX,
            ),
            ("center_x", 0.0, SCREEN_EFFECT_CENTER_X_MAX),
            ("center_y", 0.0, SCREEN_EFFECT_CENTER_Y_MAX),
            (
                "edge_weight",
                CHROMATIC_EDGE_WEIGHT_MIN,
                CHROMATIC_EDGE_WEIGHT_MAX,
            ),
            ("fade_in", SCREEN_EFFECT_FADE_MIN, SCREEN_EFFECT_FADE_MAX),
            ("fade_out", SCREEN_EFFECT_FADE_MIN, SCREEN_EFFECT_FADE_MAX),
        ],
    );

    check(
        &properties("shockwave"),
        "shockwave",
        &[
            ("center_x", 0.0, SCREEN_EFFECT_CENTER_X_MAX),
            ("center_y", 0.0, SCREEN_EFFECT_CENTER_Y_MAX),
            (
                "max_radius",
                SHOCKWAVE_MAX_RADIUS_MIN,
                SHOCKWAVE_MAX_RADIUS_MAX,
            ),
            (
                "wave_width",
                SHOCKWAVE_WAVE_WIDTH_MIN,
                SHOCKWAVE_WAVE_WIDTH_MAX,
            ),
            ("strength", 0.0, SHOCKWAVE_STRENGTH_MAX),
        ],
    );

    check(
        &properties("color_grade"),
        "color_grade",
        &[
            (
                "brightness",
                COLOR_GRADE_BRIGHTNESS_MIN,
                COLOR_GRADE_BRIGHTNESS_MAX,
            ),
            (
                "contrast",
                COLOR_GRADE_CONTRAST_MIN,
                COLOR_GRADE_CONTRAST_MAX,
            ),
            (
                "saturation",
                COLOR_GRADE_SATURATION_MIN,
                COLOR_GRADE_SATURATION_MAX,
            ),
            (
                "tint_strength",
                COLOR_GRADE_TINT_STRENGTH_MIN,
                COLOR_GRADE_TINT_STRENGTH_MAX,
            ),
            (
                "intensity",
                SCREEN_EFFECT_INTENSITY_MIN,
                SCREEN_EFFECT_INTENSITY_MAX,
            ),
            ("fade_in", SCREEN_EFFECT_FADE_MIN, SCREEN_EFFECT_FADE_MAX),
            ("fade_out", SCREEN_EFFECT_FADE_MIN, SCREEN_EFFECT_FADE_MAX),
        ],
    );

    check(
        &properties("focus"),
        "focus",
        &[
            ("center_x", 0.0, SCREEN_EFFECT_CENTER_X_MAX),
            ("center_y", 0.0, SCREEN_EFFECT_CENTER_Y_MAX),
            ("radius", FOCUS_RADIUS_MIN, FOCUS_RADIUS_MAX),
            ("softness", FOCUS_SOFTNESS_MIN, FOCUS_SOFTNESS_MAX),
            ("blur", FOCUS_BLUR_MIN, FOCUS_BLUR_MAX),
            ("darkness", FOCUS_DARKNESS_MIN, FOCUS_DARKNESS_MAX),
            (
                "intensity",
                SCREEN_EFFECT_INTENSITY_MIN,
                SCREEN_EFFECT_INTENSITY_MAX,
            ),
        ],
    );

    check(
        &properties("ripple"),
        "ripple",
        &[
            ("center_x", 0.0, SCREEN_EFFECT_CENTER_X_MAX),
            ("center_y", 0.0, SCREEN_EFFECT_CENTER_Y_MAX),
            ("amplitude", RIPPLE_AMPLITUDE_MIN, RIPPLE_AMPLITUDE_MAX),
            ("wavelength", RIPPLE_WAVELENGTH_MIN, RIPPLE_WAVELENGTH_MAX),
            ("speed", RIPPLE_SPEED_MIN, RIPPLE_SPEED_MAX),
            ("damping", RIPPLE_DAMPING_MIN, RIPPLE_DAMPING_MAX),
            (
                "intensity",
                SCREEN_EFFECT_INTENSITY_MIN,
                SCREEN_EFFECT_INTENSITY_MAX,
            ),
        ],
    );
}

/// Screen-effect and transition nodes with a single out-of-range parameter.
/// Omitted parameters take their (valid) defaults, so only the named field can
/// be the cause of the rejection.
#[test]
fn transition_and_effect_parameters_are_range_checked() {
    let catalog = fixture_catalog();
    let background = |transition: &str| {
        format!("type: background
transition: {transition}
duration_ms: 300
next: introduction
")
    };
    let effect = |effect: &str| {
        format!("type: screen_effect
effect: {effect}
duration_ms: 200
next: introduction
")
    };
    let cases = [
        (background("{type: fade_through_color, color: red}"), "颜色"),
        (background("{type: wipe, direction: left_to_right, softness: 1.5}"), "softness"),
        (effect("{type: flash, color: \"#FFF\"}"), "颜色"),
        (effect("{type: flash, peak_alpha: 1.5}"), "peak_alpha"),
        (effect("{type: shake, amplitude_x: 300}"), "amplitude_x"),
        (effect("{type: shake, frequency_hz: 0}"), "frequency_hz"),
        (effect("{type: shake, decay: 1.5}"), "decay"),
        (effect("{type: chromatic_aberration, intensity: 200}"), "intensity"),
        (effect("{type: chromatic_aberration, center_y: 1200}"), "center_y"),
        (effect("{type: chromatic_aberration, fade_in: 0.6, fade_out: 0.6}"), "fade_in 与 fade_out"),
        (effect("{type: glitch, slice_count: 0}"), "slice_count"),
        (effect("{type: shockwave, wave_width: 0}"), "wave_width"),
        (effect("{type: shockwave, strength: -1}"), "strength"),
        (effect("{type: color_grade, brightness: 1.5}"), "brightness"),
        (effect("{type: color_grade, tint: ffffff}"), "颜色"),
        (effect("{type: color_grade, intensity: 1.5}"), "intensity"),
        (effect("{type: focus, softness: 0}"), "softness"),
        (effect("{type: focus, blur: 40}"), "blur"),
        (effect("{type: focus, center_y: 1400}"), "center_y"),
        (effect("{type: focus, fade_in: 0.6, fade_out: 0.6}"), "fade_in 与 fade_out"),
        (effect("{type: ripple, amplitude: 128}"), "amplitude"),
        (effect("{type: ripple, wavelength: 4}"), "wavelength"),
        (effect("{type: ripple, fade_in: 0.7, fade_out: 0.7}"), "fade_in 与 fade_out"),
    ];
    for (yaml, expected) in cases {
        let error = node_error(&catalog, node(&yaml));
        assert!(error.contains(expected), "{yaml}: {error}");
    }

    // YAML refuses non-finite floats, so NaN is patched into a parsed spec.
    for (yaml, expected) in [
        (effect("{type: glitch}"), "density"),
        (effect("{type: color_grade}"), "saturation"),
    ] {
        let mut probe = node(&yaml);
        if let SceneNode::ScreenEffect { effect, .. } = &mut probe {
            match effect {
                ScreenEffectSpec::Glitch { density, .. } => *density = f32::NAN,
                ScreenEffectSpec::ColorGrade { saturation, .. } => *saturation = f32::NAN,
                _ => unreachable!(),
            }
        }
        let error = node_error(&catalog, probe);
        assert!(error.contains(expected), "{expected}: {error}");
    }
}

#[test]
fn composable_screen_effects_accept_their_defaults_and_boundaries() {
    let catalog = fixture_catalog();
    let valid = |_name: &str, spec: ScreenEffectSpec| {
        assert_node_valid(
            &catalog,
            SceneNode::ScreenEffect {
                effect: spec,
                duration_ms: 200,
                await_completion: false,
                next: "introduction".to_owned(),
            },
        );
    };
    valid(
        "valid_color_grade",
        ScreenEffectSpec::ColorGrade {
            brightness: COLOR_GRADE_BRIGHTNESS_MIN,
            contrast: COLOR_GRADE_CONTRAST_MAX,
            saturation: COLOR_GRADE_SATURATION_MAX,
            tint: COLOR_GRADE_TINT_DEFAULT.to_owned(),
            tint_strength: COLOR_GRADE_TINT_STRENGTH_MAX,
            intensity: SCREEN_EFFECT_INTENSITY_MAX,
            fade_in: SCREEN_EFFECT_FADE_MIN,
            fade_out: SCREEN_EFFECT_FADE_MAX,
        },
    );
    valid(
        "valid_focus",
        ScreenEffectSpec::Focus {
            center_x: SCREEN_EFFECT_CENTER_X_MAX,
            center_y: SCREEN_EFFECT_CENTER_Y_MAX,
            radius: FOCUS_RADIUS_MAX,
            softness: FOCUS_SOFTNESS_MIN,
            blur: FOCUS_BLUR_MAX,
            darkness: FOCUS_DARKNESS_MAX,
            intensity: SCREEN_EFFECT_INTENSITY_MIN,
            fade_in: SCREEN_EFFECT_FADE_MAX,
            fade_out: SCREEN_EFFECT_FADE_MIN,
        },
    );
    valid(
        "valid_ripple",
        ScreenEffectSpec::Ripple {
            center_x: SCREEN_EFFECT_CENTER_X_DEFAULT,
            center_y: SCREEN_EFFECT_CENTER_Y_DEFAULT,
            amplitude: RIPPLE_AMPLITUDE_MAX,
            wavelength: RIPPLE_WAVELENGTH_MIN,
            speed: RIPPLE_SPEED_MAX,
            damping: RIPPLE_DAMPING_MAX,
            intensity: SCREEN_EFFECT_INTENSITY_MAX,
            fade_in: SCREEN_EFFECT_FADE_IN_DEFAULT,
            fade_out: SCREEN_EFFECT_FADE_OUT_DEFAULT,
        },
    );
}

#[test]
fn curtain_nodes_require_a_cover_fill_and_reject_one_on_reveal() {
    let catalog = fixture_catalog();
    let curtain = |action: &str, fill: &str| {
        node(&format!(
            "type: curtain
action: {action}
{fill}transition: {{type: split_horizontal}}
duration_ms: 600
next: introduction
"
        ))
    };
    let cases = [
        (curtain("cover", ""), "必须提供 fill"),
        (curtain("reveal", "fill: {color: \"#000000\"}
"), "不能指定 fill"),
        (curtain("cover", "fill: {color: \"#00\"}
"), "颜色"),
        (curtain("cover", "fill: {asset: gui.missing}
"), "未知素材"),
        (curtain("cover", "fill: {asset: sprite.jelly}
"), "类型不正确"),
    ];
    for (node, expected) in cases {
        let error = node_error(&catalog, node);
        assert!(error.contains(expected), "{expected}: {error}");
    }
    assert_node_valid(&catalog, curtain("cover", "fill: {asset: gui.dialogue_box}
"));
}
