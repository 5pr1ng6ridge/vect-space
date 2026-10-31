/**
 * Authoring defaults for the presentation specs.
 *
 * Every editor creator (a new node, a new timeline event, or an inspector type
 * switch) hands out these values, which mirror the Rust serde defaults; one
 * source keeps them from drifting apart.  Factories return fresh objects
 * because specs are copied on edit.
 */

import type {
  BackgroundTransitionSpec,
  CurtainTransitionSpec,
  ScreenEffectSpec,
} from "./types";

/** Default transition of a new `background` node. */
export function defaultBackgroundTransition(): BackgroundTransitionSpec {
  return { type: "cross_fade" };
}

/** Default fill of a new `curtain` cover: opaque black. */
export function defaultCurtainFill(): { color: string } {
  return { color: "#000000" };
}

/** Default open/close animation of a new `curtain` node. */
export function defaultCurtainTransition(): CurtainTransitionSpec {
  return { type: "fade" };
}

/** Default effect of a new `screen_effect` node / timeline event. */
export function defaultFlashEffect(): ScreenEffectSpec {
  return { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 };
}

/** Default shake parameters: 16×9.6, 18 Hz, decay 1, seed 0. */
function defaultShakeEffect(): ScreenEffectSpec {
  return {
    type: "shake",
    amplitude_x: 16,
    amplitude_y: 9.6,
    frequency_hz: 18,
    decay: 1,
    seed: 0,
  };
}

/** Default RGB split: 12 px horizontal, edge-weighted, decaying out. */
export function defaultChromaticAberrationEffect(): ScreenEffectSpec {
  return {
    type: "chromatic_aberration",
    intensity: 12,
    angle_deg: 0,
    center_x: 960,
    center_y: 540,
    edge_weight: 0.6,
    fade_in: 0,
    fade_out: 1,
  };
}

/** Default glitch: 16 bands, 48 px, 35 % density, 12 Hz, seed 0. */
export function defaultGlitchEffect(): ScreenEffectSpec {
  return {
    type: "glitch",
    displacement: 48,
    slice_count: 16,
    density: 0.35,
    frequency_hz: 12,
    seed: 0,
    fade_in: 0,
    fade_out: 0,
  };
}

/** Default shockwave: from the stage centre out to its corners. */
export function defaultShockwaveEffect(): ScreenEffectSpec {
  return {
    type: "shockwave",
    center_x: 960,
    center_y: 540,
    max_radius: 1100,
    wave_width: 140,
    strength: 28,
  };
}

/**
 * Default colour grade: the canonical neutral grade (brightness 0, contrast 1,
 * saturation 1, no tint).  It is deliberately an identity until an author
 * edits the parameters — the shared evaluator then bypasses the pass instead
 * of installing a no-op filter.
 */
export function defaultColorGradeEffect(): ScreenEffectSpec {
  return {
    type: "color_grade",
    brightness: 0,
    contrast: 1,
    saturation: 1,
    tint: "#ffffff",
    tint_strength: 0,
    intensity: 1,
    fade_in: 0.1,
    fade_out: 0.2,
  };
}

/** Default focus: sharp 280 px centre, 160 px softness, 8 px blur, 0.3 dark. */
export function defaultFocusEffect(): ScreenEffectSpec {
  return {
    type: "focus",
    center_x: 960,
    center_y: 540,
    radius: 280,
    softness: 160,
    blur: 8,
    darkness: 0.3,
    intensity: 1,
    fade_in: 0.1,
    fade_out: 0.2,
  };
}

/** Default ripple: 12 px amplitude, 160 px wavelength, 240 px/s, damping 1. */
export function defaultRippleEffect(): ScreenEffectSpec {
  return {
    type: "ripple",
    center_x: 960,
    center_y: 540,
    amplitude: 12,
    wavelength: 160,
    speed: 240,
    damping: 1,
    intensity: 1,
    fade_in: 0.1,
    fade_out: 0.2,
  };
}

/** Default spec of one effect type (the inspector's type switch). */
export function defaultScreenEffect(
  type: ScreenEffectSpec["type"],
): ScreenEffectSpec {
  switch (type) {
    case "flash":
      return defaultFlashEffect();
    case "shake":
      return defaultShakeEffect();
    case "chromatic_aberration":
      return defaultChromaticAberrationEffect();
    case "glitch":
      return defaultGlitchEffect();
    case "shockwave":
      return defaultShockwaveEffect();
    case "color_grade":
      return defaultColorGradeEffect();
    case "focus":
      return defaultFocusEffect();
    case "ripple":
      return defaultRippleEffect();
  }
}
