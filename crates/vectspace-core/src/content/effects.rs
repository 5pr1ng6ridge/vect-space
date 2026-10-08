use std::collections::BTreeMap;

use crate::model::{
    AssetDefinition, AssetKind, CHROMATIC_ANGLE_DEG_MAX, CHROMATIC_ANGLE_DEG_MIN,
    CHROMATIC_EDGE_WEIGHT_MAX, CHROMATIC_EDGE_WEIGHT_MIN, CHROMATIC_INTENSITY_MAX,
    COLOR_GRADE_BRIGHTNESS_MAX, COLOR_GRADE_BRIGHTNESS_MIN, COLOR_GRADE_CONTRAST_MAX,
    COLOR_GRADE_CONTRAST_MIN, COLOR_GRADE_SATURATION_MAX, COLOR_GRADE_SATURATION_MIN,
    COLOR_GRADE_TINT_STRENGTH_MAX, COLOR_GRADE_TINT_STRENGTH_MIN, CurtainFill, FLASH_PEAK_ALPHA_MAX,
    FLASH_PEAK_ALPHA_MIN, FOCUS_BLUR_MAX, FOCUS_BLUR_MIN, FOCUS_DARKNESS_MAX, FOCUS_DARKNESS_MIN,
    FOCUS_RADIUS_MAX, FOCUS_RADIUS_MIN, FOCUS_SOFTNESS_MAX, FOCUS_SOFTNESS_MIN, GLITCH_DENSITY_MAX,
    GLITCH_DENSITY_MIN, GLITCH_DISPLACEMENT_MAX, GLITCH_FREQUENCY_HZ_MAX, GLITCH_FREQUENCY_HZ_MIN,
    GLITCH_SLICE_COUNT_MAX, GLITCH_SLICE_COUNT_MIN, RIPPLE_AMPLITUDE_MAX, RIPPLE_AMPLITUDE_MIN,
    RIPPLE_DAMPING_MAX, RIPPLE_DAMPING_MIN, RIPPLE_SPEED_MAX, RIPPLE_SPEED_MIN,
    RIPPLE_WAVELENGTH_MAX, RIPPLE_WAVELENGTH_MIN, SCREEN_EFFECT_CENTER_X_MAX,
    SCREEN_EFFECT_CENTER_Y_MAX, SCREEN_EFFECT_FADE_MAX, SCREEN_EFFECT_FADE_MIN,
    SCREEN_EFFECT_INTENSITY_MAX, SCREEN_EFFECT_INTENSITY_MIN, ScreenEffectSpec, SHAKE_AMPLITUDE_MAX,
    SHAKE_DECAY_MAX, SHAKE_DECAY_MIN, SHAKE_FREQUENCY_HZ_MAX, SHAKE_FREQUENCY_HZ_MIN,
    SHOCKWAVE_MAX_RADIUS_MAX, SHOCKWAVE_MAX_RADIUS_MIN, SHOCKWAVE_STRENGTH_MAX,
    SHOCKWAVE_WAVE_WIDTH_MAX, SHOCKWAVE_WAVE_WIDTH_MIN,
};
use super::ContentError;
use super::common::{node_error, validate_color};
use super::scenes::require_asset;

pub(super) fn validate_screen_effect(
    effect: &ScreenEffectSpec,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    match effect {
        ScreenEffectSpec::Flash { color, peak_alpha } => {
            validate_color(color).map_err(|message| {
                ContentError::Validation(format!("{scene_id}/{node_id}: {message}"))
            })?;
            if !peak_alpha.is_finite()
                || !(FLASH_PEAK_ALPHA_MIN..=FLASH_PEAK_ALPHA_MAX).contains(peak_alpha)
            {
                return node_error(scene_id, node_id, "flash peak_alpha 必须在 0 到 1 之间");
            }
            Ok(())
        }
        ScreenEffectSpec::Shake {
            amplitude_x,
            amplitude_y,
            frequency_hz,
            decay,
            seed: _,
        } => {
            for (label, value) in [("amplitude_x", *amplitude_x), ("amplitude_y", *amplitude_y)] {
                if !value.is_finite() || !(0.0..=SHAKE_AMPLITUDE_MAX).contains(&value) {
                    return node_error(
                        scene_id,
                        node_id,
                        &format!("shake {label} 必须在 0 到 {SHAKE_AMPLITUDE_MAX} 之间"),
                    );
                }
            }
            if !frequency_hz.is_finite()
                || !(SHAKE_FREQUENCY_HZ_MIN..=SHAKE_FREQUENCY_HZ_MAX).contains(frequency_hz)
            {
                return node_error(
                    scene_id,
                    node_id,
                    &format!(
                        "shake frequency_hz 必须在 {SHAKE_FREQUENCY_HZ_MIN} 到 {SHAKE_FREQUENCY_HZ_MAX} 之间"
                    ),
                );
            }
            if !decay.is_finite() || !(SHAKE_DECAY_MIN..=SHAKE_DECAY_MAX).contains(decay) {
                return node_error(
                    scene_id,
                    node_id,
                    &format!("shake decay 必须在 {SHAKE_DECAY_MIN} 到 {SHAKE_DECAY_MAX} 之间"),
                );
            }
            Ok(())
        }
        ScreenEffectSpec::ChromaticAberration {
            intensity,
            angle_deg,
            center_x,
            center_y,
            edge_weight,
            fade_in,
            fade_out,
        } => {
            let label = "chromatic_aberration";
            validate_effect_range(
                label,
                "intensity",
                *intensity,
                0.0,
                CHROMATIC_INTENSITY_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_range(
                label,
                "angle_deg",
                *angle_deg,
                CHROMATIC_ANGLE_DEG_MIN,
                CHROMATIC_ANGLE_DEG_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_center(label, *center_x, *center_y, scene_id, node_id)?;
            validate_effect_range(
                label,
                "edge_weight",
                *edge_weight,
                CHROMATIC_EDGE_WEIGHT_MIN,
                CHROMATIC_EDGE_WEIGHT_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_fades(label, *fade_in, *fade_out, scene_id, node_id)
        }
        ScreenEffectSpec::Glitch {
            displacement,
            slice_count,
            density,
            frequency_hz,
            seed: _,
            fade_in,
            fade_out,
        } => {
            let label = "glitch";
            validate_effect_range(
                label,
                "displacement",
                *displacement,
                0.0,
                GLITCH_DISPLACEMENT_MAX,
                scene_id,
                node_id,
            )?;
            if !(GLITCH_SLICE_COUNT_MIN..=GLITCH_SLICE_COUNT_MAX).contains(slice_count) {
                return node_error(
                    scene_id,
                    node_id,
                    &format!(
                        "glitch slice_count 必须在 {GLITCH_SLICE_COUNT_MIN} 到 {GLITCH_SLICE_COUNT_MAX} 之间"
                    ),
                );
            }
            validate_effect_range(
                label,
                "density",
                *density,
                GLITCH_DENSITY_MIN,
                GLITCH_DENSITY_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_range(
                label,
                "frequency_hz",
                *frequency_hz,
                GLITCH_FREQUENCY_HZ_MIN,
                GLITCH_FREQUENCY_HZ_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_fades(label, *fade_in, *fade_out, scene_id, node_id)
        }
        ScreenEffectSpec::Shockwave {
            center_x,
            center_y,
            max_radius,
            wave_width,
            strength,
        } => {
            let label = "shockwave";
            validate_effect_center(label, *center_x, *center_y, scene_id, node_id)?;
            validate_effect_range(
                label,
                "max_radius",
                *max_radius,
                SHOCKWAVE_MAX_RADIUS_MIN,
                SHOCKWAVE_MAX_RADIUS_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_range(
                label,
                "wave_width",
                *wave_width,
                SHOCKWAVE_WAVE_WIDTH_MIN,
                SHOCKWAVE_WAVE_WIDTH_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_range(
                label,
                "strength",
                *strength,
                0.0,
                SHOCKWAVE_STRENGTH_MAX,
                scene_id,
                node_id,
            )
        }
        ScreenEffectSpec::ColorGrade {
            brightness,
            contrast,
            saturation,
            tint,
            tint_strength,
            intensity,
            fade_in,
            fade_out,
        } => {
            let label = "color_grade";
            validate_color(tint).map_err(|message| {
                ContentError::Validation(format!("{scene_id}/{node_id}: {message}"))
            })?;
            validate_effect_range(
                label,
                "brightness",
                *brightness,
                COLOR_GRADE_BRIGHTNESS_MIN,
                COLOR_GRADE_BRIGHTNESS_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_range(
                label,
                "contrast",
                *contrast,
                COLOR_GRADE_CONTRAST_MIN,
                COLOR_GRADE_CONTRAST_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_range(
                label,
                "saturation",
                *saturation,
                COLOR_GRADE_SATURATION_MIN,
                COLOR_GRADE_SATURATION_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_range(
                label,
                "tint_strength",
                *tint_strength,
                COLOR_GRADE_TINT_STRENGTH_MIN,
                COLOR_GRADE_TINT_STRENGTH_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_intensity(label, *intensity, scene_id, node_id)?;
            validate_effect_fades(label, *fade_in, *fade_out, scene_id, node_id)
        }
        ScreenEffectSpec::Focus {
            center_x,
            center_y,
            radius,
            softness,
            blur,
            darkness,
            intensity,
            fade_in,
            fade_out,
        } => {
            let label = "focus";
            validate_effect_center(label, *center_x, *center_y, scene_id, node_id)?;
            validate_effect_range(
                label,
                "radius",
                *radius,
                FOCUS_RADIUS_MIN,
                FOCUS_RADIUS_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_range(
                label,
                "softness",
                *softness,
                FOCUS_SOFTNESS_MIN,
                FOCUS_SOFTNESS_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_range(
                label,
                "blur",
                *blur,
                FOCUS_BLUR_MIN,
                FOCUS_BLUR_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_range(
                label,
                "darkness",
                *darkness,
                FOCUS_DARKNESS_MIN,
                FOCUS_DARKNESS_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_intensity(label, *intensity, scene_id, node_id)?;
            validate_effect_fades(label, *fade_in, *fade_out, scene_id, node_id)
        }
        ScreenEffectSpec::Ripple {
            center_x,
            center_y,
            amplitude,
            wavelength,
            speed,
            damping,
            intensity,
            fade_in,
            fade_out,
        } => {
            let label = "ripple";
            validate_effect_center(label, *center_x, *center_y, scene_id, node_id)?;
            validate_effect_range(
                label,
                "amplitude",
                *amplitude,
                RIPPLE_AMPLITUDE_MIN,
                RIPPLE_AMPLITUDE_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_range(
                label,
                "wavelength",
                *wavelength,
                RIPPLE_WAVELENGTH_MIN,
                RIPPLE_WAVELENGTH_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_range(
                label,
                "speed",
                *speed,
                RIPPLE_SPEED_MIN,
                RIPPLE_SPEED_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_range(
                label,
                "damping",
                *damping,
                RIPPLE_DAMPING_MIN,
                RIPPLE_DAMPING_MAX,
                scene_id,
                node_id,
            )?;
            validate_effect_intensity(label, *intensity, scene_id, node_id)?;
            validate_effect_fades(label, *fade_in, *fade_out, scene_id, node_id)
        }
    }
}

fn validate_effect_intensity(
    effect: &str,
    intensity: f32,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    validate_effect_range(
        effect,
        "intensity",
        intensity,
        SCREEN_EFFECT_INTENSITY_MIN,
        SCREEN_EFFECT_INTENSITY_MAX,
        scene_id,
        node_id,
    )
}

fn validate_effect_range(
    effect: &str,
    field: &str,
    value: f32,
    minimum: f32,
    maximum: f32,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    if !value.is_finite() || !(minimum..=maximum).contains(&value) {
        return node_error(
            scene_id,
            node_id,
            &format!("{effect} {field} 必须在 {minimum} 到 {maximum} 之间"),
        );
    }
    Ok(())
}

fn validate_effect_center(
    effect: &str,
    center_x: f32,
    center_y: f32,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    validate_effect_range(
        effect,
        "center_x",
        center_x,
        0.0,
        SCREEN_EFFECT_CENTER_X_MAX,
        scene_id,
        node_id,
    )?;
    validate_effect_range(
        effect,
        "center_y",
        center_y,
        0.0,
        SCREEN_EFFECT_CENTER_Y_MAX,
        scene_id,
        node_id,
    )
}

fn validate_effect_fades(
    effect: &str,
    fade_in: f32,
    fade_out: f32,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    validate_effect_range(
        effect,
        "fade_in",
        fade_in,
        SCREEN_EFFECT_FADE_MIN,
        SCREEN_EFFECT_FADE_MAX,
        scene_id,
        node_id,
    )?;
    validate_effect_range(
        effect,
        "fade_out",
        fade_out,
        SCREEN_EFFECT_FADE_MIN,
        SCREEN_EFFECT_FADE_MAX,
        scene_id,
        node_id,
    )?;
    if fade_in + fade_out > SCREEN_EFFECT_FADE_MAX {
        return node_error(
            scene_id,
            node_id,
            &format!("{effect} fade_in 与 fade_out 之和不能超过 1"),
        );
    }
    Ok(())
}

pub(super) fn validate_curtain_fill(
    fill: &CurtainFill,
    assets: &BTreeMap<String, AssetDefinition>,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    match fill {
        CurtainFill::Color { color } => validate_color(color).map_err(|message| {
            ContentError::Validation(format!("{scene_id}/{node_id}: {message}"))
        }),
        CurtainFill::Asset { asset } => {
            require_asset(assets, asset, AssetKind::Gui, scene_id, node_id)
        }
    }
}
