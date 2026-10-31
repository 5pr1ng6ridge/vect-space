use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Defaults of the parameterised screen effect shared by `screen_effect` nodes
/// and timeline events; every omitted field falls back to these.
pub const FLASH_COLOR_DEFAULT: &str = "#FFFFFF";
pub const FLASH_PEAK_ALPHA_DEFAULT: f32 = 0.88;
pub const FLASH_PEAK_ALPHA_MIN: f32 = 0.0;
pub const FLASH_PEAK_ALPHA_MAX: f32 = 1.0;
/// Peak horizontal amplitude in design pixels of the shipped shake.
pub const SHAKE_AMPLITUDE_X_DEFAULT: f32 = 16.0;
/// Peak vertical amplitude of the shipped shake (`0.6 * x`).
pub const SHAKE_AMPLITUDE_Y_DEFAULT: f32 = 9.6;
pub const SHAKE_AMPLITUDE_MAX: f32 = 256.0;
pub const SHAKE_FREQUENCY_HZ_DEFAULT: f32 = 18.0;
pub const SHAKE_FREQUENCY_HZ_MIN: f32 = 0.1;
pub const SHAKE_FREQUENCY_HZ_MAX: f32 = 60.0;
/// `1.0` reproduces the shipped linear fade-out; `0.0` never decays.
pub const SHAKE_DECAY_DEFAULT: f32 = 1.0;
pub const SHAKE_DECAY_MIN: f32 = 0.0;
pub const SHAKE_DECAY_MAX: f32 = 1.0;
/// Stable seed carried by the spec.  The evaluator converts it into a stable
/// per-axis phase offset, so the default `0` is a valid deterministic seed
/// instead of inventing randomness.
///
/// The seed crosses the WebView IPC boundary as a JSON number, so it stays well
/// inside the JavaScript safe integer range (`<= 2^53 - 1`); `u32` keeps that
/// guarantee in the type and in the generated schema.
pub const SHAKE_SEED_DEFAULT: u32 = 0;
pub const SHAKE_SEED_MAX: u32 = u32::MAX;

/// Shader effects only post-process the Pixi world layer; positions are design
/// pixels of the fixed 1920x1080 stage and default to its centre.
pub const SCREEN_EFFECT_CENTER_X_DEFAULT: f32 = 960.0;
pub const SCREEN_EFFECT_CENTER_Y_DEFAULT: f32 = 540.0;
pub const SCREEN_EFFECT_CENTER_X_MAX: f32 = 1920.0;
pub const SCREEN_EFFECT_CENTER_Y_MAX: f32 = 1080.0;
/// `fade_in`/`fade_out` are fractions of the effect window spent ramping the
/// intensity up from zero and back down to zero; their sum stays within `1`.
pub const SCREEN_EFFECT_FADE_MIN: f32 = 0.0;
pub const SCREEN_EFFECT_FADE_MAX: f32 = 1.0;
/// Peak RGB channel offset in design pixels.
pub const CHROMATIC_INTENSITY_DEFAULT: f32 = 12.0;
pub const CHROMATIC_INTENSITY_MAX: f32 = 128.0;
pub const CHROMATIC_ANGLE_DEG_DEFAULT: f32 = 0.0;
pub const CHROMATIC_ANGLE_DEG_MIN: f32 = -360.0;
pub const CHROMATIC_ANGLE_DEG_MAX: f32 = 360.0;
/// `0` splits every pixel equally; `1` grows the split from nothing at the
/// centre to the full intensity at the farthest stage corner.
pub const CHROMATIC_EDGE_WEIGHT_DEFAULT: f32 = 0.6;
pub const CHROMATIC_EDGE_WEIGHT_MIN: f32 = 0.0;
pub const CHROMATIC_EDGE_WEIGHT_MAX: f32 = 1.0;
/// A chromatic hit decays across the whole window by default, like a flash.
pub const CHROMATIC_FADE_IN_DEFAULT: f32 = 0.0;
pub const CHROMATIC_FADE_OUT_DEFAULT: f32 = 1.0;
/// Peak horizontal band displacement in design pixels.
pub const GLITCH_DISPLACEMENT_DEFAULT: f32 = 48.0;
pub const GLITCH_DISPLACEMENT_MAX: f32 = 512.0;
/// Horizontal bands the stage is cut into; the upper bound is the size of the
/// shader's offset table.
pub const GLITCH_SLICE_COUNT_DEFAULT: u32 = 16;
pub const GLITCH_SLICE_COUNT_MIN: u32 = 1;
pub const GLITCH_SLICE_COUNT_MAX: u32 = 32;
/// Probability that one band is displaced during one step.
pub const GLITCH_DENSITY_DEFAULT: f32 = 0.35;
pub const GLITCH_DENSITY_MIN: f32 = 0.0;
pub const GLITCH_DENSITY_MAX: f32 = 1.0;
/// Steps per second: how often the band pattern changes.
pub const GLITCH_FREQUENCY_HZ_DEFAULT: f32 = 12.0;
pub const GLITCH_FREQUENCY_HZ_MIN: f32 = 0.1;
pub const GLITCH_FREQUENCY_HZ_MAX: f32 = 60.0;
/// Same JavaScript-safe `u32` contract as the shake seed.
pub const GLITCH_SEED_DEFAULT: u32 = 0;
pub const GLITCH_FADE_IN_DEFAULT: f32 = 0.0;
pub const GLITCH_FADE_OUT_DEFAULT: f32 = 0.0;
/// Radius in design pixels the ring reaches at the end of the window; the
/// default reaches the stage corners from the centre.
pub const SHOCKWAVE_MAX_RADIUS_DEFAULT: f32 = 1100.0;
pub const SHOCKWAVE_MAX_RADIUS_MIN: f32 = 1.0;
pub const SHOCKWAVE_MAX_RADIUS_MAX: f32 = 4096.0;
/// Thickness of the distorted ring in design pixels.
pub const SHOCKWAVE_WAVE_WIDTH_DEFAULT: f32 = 140.0;
pub const SHOCKWAVE_WAVE_WIDTH_MIN: f32 = 1.0;
pub const SHOCKWAVE_WAVE_WIDTH_MAX: f32 = 1024.0;
/// Peak radial displacement in design pixels.
pub const SHOCKWAVE_STRENGTH_DEFAULT: f32 = 28.0;
pub const SHOCKWAVE_STRENGTH_MAX: f32 = 256.0;
/// Shared strength of the composable `color_grade`, `focus` and `ripple`
/// effects: `1` applies them fully, `0` is an identity no-op.
pub const SCREEN_EFFECT_INTENSITY_DEFAULT: f32 = 1.0;
pub const SCREEN_EFFECT_INTENSITY_MIN: f32 = 0.0;
pub const SCREEN_EFFECT_INTENSITY_MAX: f32 = 1.0;
/// Default ramp-in / ramp-out of the composable effects, as fractions of the
/// effect window; their sum stays within `1`.
pub const SCREEN_EFFECT_FADE_IN_DEFAULT: f32 = 0.1;
pub const SCREEN_EFFECT_FADE_OUT_DEFAULT: f32 = 0.2;
/// Additive brightness in straight RGB, applied to the graded signal.
pub const COLOR_GRADE_BRIGHTNESS_DEFAULT: f32 = 0.0;
pub const COLOR_GRADE_BRIGHTNESS_MIN: f32 = -1.0;
pub const COLOR_GRADE_BRIGHTNESS_MAX: f32 = 1.0;
/// Contrast multiplier pivoting around mid grey (`0.5`).
pub const COLOR_GRADE_CONTRAST_DEFAULT: f32 = 1.0;
pub const COLOR_GRADE_CONTRAST_MIN: f32 = 0.0;
pub const COLOR_GRADE_CONTRAST_MAX: f32 = 2.0;
/// Saturation multiplier around the pixel's luminance.
pub const COLOR_GRADE_SATURATION_DEFAULT: f32 = 1.0;
pub const COLOR_GRADE_SATURATION_MIN: f32 = 0.0;
pub const COLOR_GRADE_SATURATION_MAX: f32 = 2.0;
/// Multiplicative tint colour; same `#RRGGBB`/`#RRGGBBAA` contract as every
/// other authored colour.
pub const COLOR_GRADE_TINT_DEFAULT: &str = "#ffffff";
/// How far the graded colour is pulled towards the multiplicative tint.
pub const COLOR_GRADE_TINT_STRENGTH_DEFAULT: f32 = 0.0;
pub const COLOR_GRADE_TINT_STRENGTH_MIN: f32 = 0.0;
pub const COLOR_GRADE_TINT_STRENGTH_MAX: f32 = 1.0;
/// Radius of the fully sharp centre disc in design pixels.
pub const FOCUS_RADIUS_DEFAULT: f32 = 280.0;
pub const FOCUS_RADIUS_MIN: f32 = 0.0;
/// Half the stage diagonal: the largest meaningful design-pixel radius.
pub const FOCUS_RADIUS_MAX: f32 = 2203.0;
/// Width of the smoothstep band fading a sharp centre into a blurred
/// periphery.
pub const FOCUS_SOFTNESS_DEFAULT: f32 = 160.0;
pub const FOCUS_SOFTNESS_MIN: f32 = 1.0;
pub const FOCUS_SOFTNESS_MAX: f32 = 2203.0;
/// Maximum design-pixel blur reached at the periphery.
pub const FOCUS_BLUR_DEFAULT: f32 = 8.0;
pub const FOCUS_BLUR_MIN: f32 = 0.0;
pub const FOCUS_BLUR_MAX: f32 = 24.0;
/// How far the periphery is darkened relative to the centre.
pub const FOCUS_DARKNESS_DEFAULT: f32 = 0.3;
pub const FOCUS_DARKNESS_MIN: f32 = 0.0;
pub const FOCUS_DARKNESS_MAX: f32 = 1.0;
/// Peak radial displacement of the ripple in design pixels.
pub const RIPPLE_AMPLITUDE_DEFAULT: f32 = 12.0;
pub const RIPPLE_AMPLITUDE_MIN: f32 = 0.0;
pub const RIPPLE_AMPLITUDE_MAX: f32 = 64.0;
/// Distance between two ripple crests in design pixels.
pub const RIPPLE_WAVELENGTH_DEFAULT: f32 = 160.0;
pub const RIPPLE_WAVELENGTH_MIN: f32 = 8.0;
pub const RIPPLE_WAVELENGTH_MAX: f32 = 2203.0;
/// Outward travel speed of the rings in design pixels per second.
pub const RIPPLE_SPEED_DEFAULT: f32 = 240.0;
pub const RIPPLE_SPEED_MIN: f32 = 0.0;
pub const RIPPLE_SPEED_MAX: f32 = 2000.0;
/// Spatial decay; `0` keeps the rings everywhere, larger values confine them
/// near the centre.
pub const RIPPLE_DAMPING_DEFAULT: f32 = 1.0;
pub const RIPPLE_DAMPING_MIN: f32 = 0.0;
pub const RIPPLE_DAMPING_MAX: f32 = 8.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScreenEffectSpec {
    Flash {
        #[serde(default = "default_flash_color")]
        color: String,
        #[serde(default = "default_flash_peak_alpha")]
        peak_alpha: f32,
    },
    Shake {
        #[serde(default = "default_shake_amplitude_x")]
        amplitude_x: f32,
        #[serde(default = "default_shake_amplitude_y")]
        amplitude_y: f32,
        #[serde(default = "default_shake_frequency_hz")]
        frequency_hz: f32,
        #[serde(default = "default_shake_decay")]
        decay: f32,
        #[serde(default = "default_shake_seed")]
        seed: u32,
    },
    /// RGB channel split along `angle_deg`, weighted by the distance from the
    /// centre.
    ChromaticAberration {
        #[serde(default = "default_chromatic_intensity")]
        #[schemars(range(min = 0.0, max = CHROMATIC_INTENSITY_MAX))]
        intensity: f32,
        #[serde(default = "default_chromatic_angle_deg")]
        #[schemars(range(min = CHROMATIC_ANGLE_DEG_MIN, max = CHROMATIC_ANGLE_DEG_MAX))]
        angle_deg: f32,
        #[serde(default = "default_screen_effect_center_x")]
        #[schemars(range(min = 0.0, max = SCREEN_EFFECT_CENTER_X_MAX))]
        center_x: f32,
        #[serde(default = "default_screen_effect_center_y")]
        #[schemars(range(min = 0.0, max = SCREEN_EFFECT_CENTER_Y_MAX))]
        center_y: f32,
        #[serde(default = "default_chromatic_edge_weight")]
        #[schemars(range(min = CHROMATIC_EDGE_WEIGHT_MIN, max = CHROMATIC_EDGE_WEIGHT_MAX))]
        edge_weight: f32,
        #[serde(default = "default_chromatic_fade_in")]
        #[schemars(range(min = SCREEN_EFFECT_FADE_MIN, max = SCREEN_EFFECT_FADE_MAX))]
        fade_in: f32,
        #[serde(default = "default_chromatic_fade_out")]
        #[schemars(range(min = SCREEN_EFFECT_FADE_MIN, max = SCREEN_EFFECT_FADE_MAX))]
        fade_out: f32,
    },
    /// Horizontal band displacement that changes `frequency_hz` times per
    /// second; the seed makes the pattern a pure function of the playhead.
    Glitch {
        #[serde(default = "default_glitch_displacement")]
        #[schemars(range(min = 0.0, max = GLITCH_DISPLACEMENT_MAX))]
        displacement: f32,
        #[serde(default = "default_glitch_slice_count")]
        #[schemars(range(min = GLITCH_SLICE_COUNT_MIN, max = GLITCH_SLICE_COUNT_MAX))]
        slice_count: u32,
        #[serde(default = "default_glitch_density")]
        #[schemars(range(min = GLITCH_DENSITY_MIN, max = GLITCH_DENSITY_MAX))]
        density: f32,
        #[serde(default = "default_glitch_frequency_hz")]
        #[schemars(range(min = GLITCH_FREQUENCY_HZ_MIN, max = GLITCH_FREQUENCY_HZ_MAX))]
        frequency_hz: f32,
        #[serde(default = "default_glitch_seed")]
        seed: u32,
        #[serde(default = "default_glitch_fade_in")]
        #[schemars(range(min = SCREEN_EFFECT_FADE_MIN, max = SCREEN_EFFECT_FADE_MAX))]
        fade_in: f32,
        #[serde(default = "default_glitch_fade_out")]
        #[schemars(range(min = SCREEN_EFFECT_FADE_MIN, max = SCREEN_EFFECT_FADE_MAX))]
        fade_out: f32,
    },
    /// A ring of radial distortion expanding from the centre to `max_radius`
    /// while its strength fades out.
    Shockwave {
        #[serde(default = "default_screen_effect_center_x")]
        #[schemars(range(min = 0.0, max = SCREEN_EFFECT_CENTER_X_MAX))]
        center_x: f32,
        #[serde(default = "default_screen_effect_center_y")]
        #[schemars(range(min = 0.0, max = SCREEN_EFFECT_CENTER_Y_MAX))]
        center_y: f32,
        #[serde(default = "default_shockwave_max_radius")]
        #[schemars(range(min = SHOCKWAVE_MAX_RADIUS_MIN, max = SHOCKWAVE_MAX_RADIUS_MAX))]
        max_radius: f32,
        #[serde(default = "default_shockwave_wave_width")]
        #[schemars(range(min = SHOCKWAVE_WAVE_WIDTH_MIN, max = SHOCKWAVE_WAVE_WIDTH_MAX))]
        wave_width: f32,
        #[serde(default = "default_shockwave_strength")]
        #[schemars(range(min = 0.0, max = SHOCKWAVE_STRENGTH_MAX))]
        strength: f32,
    },
    /// Straight-RGB colour grade blended into the world layer by the
    /// enveloped intensity.
    ColorGrade {
        #[serde(default = "default_color_grade_brightness")]
        #[schemars(range(min = COLOR_GRADE_BRIGHTNESS_MIN, max = COLOR_GRADE_BRIGHTNESS_MAX))]
        brightness: f32,
        #[serde(default = "default_color_grade_contrast")]
        #[schemars(range(min = COLOR_GRADE_CONTRAST_MIN, max = COLOR_GRADE_CONTRAST_MAX))]
        contrast: f32,
        #[serde(default = "default_color_grade_saturation")]
        #[schemars(range(min = COLOR_GRADE_SATURATION_MIN, max = COLOR_GRADE_SATURATION_MAX))]
        saturation: f32,
        #[serde(default = "default_color_grade_tint")]
        tint: String,
        #[serde(default = "default_color_grade_tint_strength")]
        #[schemars(range(min = COLOR_GRADE_TINT_STRENGTH_MIN, max = COLOR_GRADE_TINT_STRENGTH_MAX))]
        tint_strength: f32,
        #[serde(default = "default_screen_effect_intensity")]
        #[schemars(range(min = SCREEN_EFFECT_INTENSITY_MIN, max = SCREEN_EFFECT_INTENSITY_MAX))]
        intensity: f32,
        #[serde(default = "default_screen_effect_fade_in")]
        #[schemars(range(min = SCREEN_EFFECT_FADE_MIN, max = SCREEN_EFFECT_FADE_MAX))]
        fade_in: f32,
        #[serde(default = "default_screen_effect_fade_out")]
        #[schemars(range(min = SCREEN_EFFECT_FADE_MIN, max = SCREEN_EFFECT_FADE_MAX))]
        fade_out: f32,
    },
    /// Variable-radius blur with a fully sharp centre disc and a soft
    /// transition to a blurred, optionally darkened periphery.
    Focus {
        #[serde(default = "default_screen_effect_center_x")]
        #[schemars(range(min = 0.0, max = SCREEN_EFFECT_CENTER_X_MAX))]
        center_x: f32,
        #[serde(default = "default_screen_effect_center_y")]
        #[schemars(range(min = 0.0, max = SCREEN_EFFECT_CENTER_Y_MAX))]
        center_y: f32,
        #[serde(default = "default_focus_radius")]
        #[schemars(range(min = FOCUS_RADIUS_MIN, max = FOCUS_RADIUS_MAX))]
        radius: f32,
        #[serde(default = "default_focus_softness")]
        #[schemars(range(min = FOCUS_SOFTNESS_MIN, max = FOCUS_SOFTNESS_MAX))]
        softness: f32,
        #[serde(default = "default_focus_blur")]
        #[schemars(range(min = FOCUS_BLUR_MIN, max = FOCUS_BLUR_MAX))]
        blur: f32,
        #[serde(default = "default_focus_darkness")]
        #[schemars(range(min = FOCUS_DARKNESS_MIN, max = FOCUS_DARKNESS_MAX))]
        darkness: f32,
        #[serde(default = "default_screen_effect_intensity")]
        #[schemars(range(min = SCREEN_EFFECT_INTENSITY_MIN, max = SCREEN_EFFECT_INTENSITY_MAX))]
        intensity: f32,
        #[serde(default = "default_screen_effect_fade_in")]
        #[schemars(range(min = SCREEN_EFFECT_FADE_MIN, max = SCREEN_EFFECT_FADE_MAX))]
        fade_in: f32,
        #[serde(default = "default_screen_effect_fade_out")]
        #[schemars(range(min = SCREEN_EFFECT_FADE_MIN, max = SCREEN_EFFECT_FADE_MAX))]
        fade_out: f32,
    },
    /// Concentric ripple rings travelling outwards from the centre, distinct
    /// from the single expanding ring of `shockwave`.
    Ripple {
        #[serde(default = "default_screen_effect_center_x")]
        #[schemars(range(min = 0.0, max = SCREEN_EFFECT_CENTER_X_MAX))]
        center_x: f32,
        #[serde(default = "default_screen_effect_center_y")]
        #[schemars(range(min = 0.0, max = SCREEN_EFFECT_CENTER_Y_MAX))]
        center_y: f32,
        #[serde(default = "default_ripple_amplitude")]
        #[schemars(range(min = RIPPLE_AMPLITUDE_MIN, max = RIPPLE_AMPLITUDE_MAX))]
        amplitude: f32,
        #[serde(default = "default_ripple_wavelength")]
        #[schemars(range(min = RIPPLE_WAVELENGTH_MIN, max = RIPPLE_WAVELENGTH_MAX))]
        wavelength: f32,
        #[serde(default = "default_ripple_speed")]
        #[schemars(range(min = RIPPLE_SPEED_MIN, max = RIPPLE_SPEED_MAX))]
        speed: f32,
        #[serde(default = "default_ripple_damping")]
        #[schemars(range(min = RIPPLE_DAMPING_MIN, max = RIPPLE_DAMPING_MAX))]
        damping: f32,
        #[serde(default = "default_screen_effect_intensity")]
        #[schemars(range(min = SCREEN_EFFECT_INTENSITY_MIN, max = SCREEN_EFFECT_INTENSITY_MAX))]
        intensity: f32,
        #[serde(default = "default_screen_effect_fade_in")]
        #[schemars(range(min = SCREEN_EFFECT_FADE_MIN, max = SCREEN_EFFECT_FADE_MAX))]
        fade_in: f32,
        #[serde(default = "default_screen_effect_fade_out")]
        #[schemars(range(min = SCREEN_EFFECT_FADE_MIN, max = SCREEN_EFFECT_FADE_MAX))]
        fade_out: f32,
    },
}

fn default_flash_color() -> String {
    FLASH_COLOR_DEFAULT.to_owned()
}

fn default_flash_peak_alpha() -> f32 {
    FLASH_PEAK_ALPHA_DEFAULT
}

fn default_shake_amplitude_x() -> f32 {
    SHAKE_AMPLITUDE_X_DEFAULT
}

fn default_shake_amplitude_y() -> f32 {
    SHAKE_AMPLITUDE_Y_DEFAULT
}

fn default_shake_frequency_hz() -> f32 {
    SHAKE_FREQUENCY_HZ_DEFAULT
}

fn default_shake_decay() -> f32 {
    SHAKE_DECAY_DEFAULT
}

fn default_shake_seed() -> u32 {
    SHAKE_SEED_DEFAULT
}

fn default_screen_effect_center_x() -> f32 {
    SCREEN_EFFECT_CENTER_X_DEFAULT
}

fn default_screen_effect_center_y() -> f32 {
    SCREEN_EFFECT_CENTER_Y_DEFAULT
}

fn default_chromatic_intensity() -> f32 {
    CHROMATIC_INTENSITY_DEFAULT
}

fn default_chromatic_angle_deg() -> f32 {
    CHROMATIC_ANGLE_DEG_DEFAULT
}

fn default_chromatic_edge_weight() -> f32 {
    CHROMATIC_EDGE_WEIGHT_DEFAULT
}

fn default_chromatic_fade_in() -> f32 {
    CHROMATIC_FADE_IN_DEFAULT
}

fn default_chromatic_fade_out() -> f32 {
    CHROMATIC_FADE_OUT_DEFAULT
}

fn default_glitch_displacement() -> f32 {
    GLITCH_DISPLACEMENT_DEFAULT
}

fn default_glitch_slice_count() -> u32 {
    GLITCH_SLICE_COUNT_DEFAULT
}

fn default_glitch_density() -> f32 {
    GLITCH_DENSITY_DEFAULT
}

fn default_glitch_frequency_hz() -> f32 {
    GLITCH_FREQUENCY_HZ_DEFAULT
}

fn default_glitch_seed() -> u32 {
    GLITCH_SEED_DEFAULT
}

fn default_glitch_fade_in() -> f32 {
    GLITCH_FADE_IN_DEFAULT
}

fn default_glitch_fade_out() -> f32 {
    GLITCH_FADE_OUT_DEFAULT
}

fn default_shockwave_max_radius() -> f32 {
    SHOCKWAVE_MAX_RADIUS_DEFAULT
}

fn default_shockwave_wave_width() -> f32 {
    SHOCKWAVE_WAVE_WIDTH_DEFAULT
}

fn default_shockwave_strength() -> f32 {
    SHOCKWAVE_STRENGTH_DEFAULT
}

fn default_screen_effect_intensity() -> f32 {
    SCREEN_EFFECT_INTENSITY_DEFAULT
}

fn default_screen_effect_fade_in() -> f32 {
    SCREEN_EFFECT_FADE_IN_DEFAULT
}

fn default_screen_effect_fade_out() -> f32 {
    SCREEN_EFFECT_FADE_OUT_DEFAULT
}

fn default_color_grade_brightness() -> f32 {
    COLOR_GRADE_BRIGHTNESS_DEFAULT
}

fn default_color_grade_contrast() -> f32 {
    COLOR_GRADE_CONTRAST_DEFAULT
}

fn default_color_grade_saturation() -> f32 {
    COLOR_GRADE_SATURATION_DEFAULT
}

fn default_color_grade_tint() -> String {
    COLOR_GRADE_TINT_DEFAULT.to_owned()
}

fn default_color_grade_tint_strength() -> f32 {
    COLOR_GRADE_TINT_STRENGTH_DEFAULT
}

fn default_focus_radius() -> f32 {
    FOCUS_RADIUS_DEFAULT
}

fn default_focus_softness() -> f32 {
    FOCUS_SOFTNESS_DEFAULT
}

fn default_focus_blur() -> f32 {
    FOCUS_BLUR_DEFAULT
}

fn default_focus_darkness() -> f32 {
    FOCUS_DARKNESS_DEFAULT
}

fn default_ripple_amplitude() -> f32 {
    RIPPLE_AMPLITUDE_DEFAULT
}

fn default_ripple_wavelength() -> f32 {
    RIPPLE_WAVELENGTH_DEFAULT
}

fn default_ripple_speed() -> f32 {
    RIPPLE_SPEED_DEFAULT
}

fn default_ripple_damping() -> f32 {
    RIPPLE_DAMPING_DEFAULT
}
