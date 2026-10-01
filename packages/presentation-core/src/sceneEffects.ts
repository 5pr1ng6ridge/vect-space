/**
 * Pure, deterministic screen-effect evaluation shared by the game renderer and
 * the editor preview.
 *
 * Screen effects are presentation events rather than world state, so every
 * value here is a pure function of the playhead.  Scrubbing, pausing, playback
 * and both hosts therefore agree on the exact same pixels, and a fixed seed can
 * never drift between them.
 */

import { applyEasing } from "./timeline";
import type { ScreenEffectSpec } from "./types";

export type FlashSpec = Extract<ScreenEffectSpec, { type: "flash" }>;
export type ShakeSpec = Extract<ScreenEffectSpec, { type: "shake" }>;
export type ChromaticAberrationSpec = Extract<
  ScreenEffectSpec,
  { type: "chromatic_aberration" }
>;
export type GlitchSpec = Extract<ScreenEffectSpec, { type: "glitch" }>;
export type ShockwaveSpec = Extract<ScreenEffectSpec, { type: "shockwave" }>;
export type ColorGradeSpec = Extract<ScreenEffectSpec, { type: "color_grade" }>;
export type FocusSpec = Extract<ScreenEffectSpec, { type: "focus" }>;
export type RippleSpec = Extract<ScreenEffectSpec, { type: "ripple" }>;

/** Player preferences that shape how strongly effects are rendered. */
export interface ScreenEffectOptions {
  /** Accessibility setting: attenuate flashes, shakes and rapid changes. */
  reducedMotion?: boolean;
}

/**
 * Attenuation applied under `reducedMotion`.
 *
 * Effects are softened rather than removed, so a scene keeps its beats: bright
 * flashes are capped, displacement is scaled down and the glitch pattern stops
 * changing faster than a few times per second.
 */
export const REDUCED_MOTION = {
  flashPeakAlphaMax: 0.3,
  shakeScale: 0.25,
  chromaticScale: 0.5,
  glitchScale: 0.35,
  glitchFrequencyMaxHz: 4,
  shockwaveScale: 0.4,
  /** The concentric wave is the most vestibular effect, so it is turned off. */
  rippleScale: 0,
  /** Focus keeps its darkening but loses its blur, leaving a still vignette. */
  focusBlurScale: 0,
} as const;

/**
 * Design-space length the ripple falloff is normalised against.
 *
 * Mirrors the Rust `FOCUS_RADIUS_MAX`/stage diagonal (`hypot(1920, 1080)`), so
 * `exp(-damping * distance / 2203)` always decays over the visible stage.
 */
export const RIPPLE_FALLOFF_DISTANCE = 2203;

/** Size of the shader's band offset table (mirrors the Rust bound). */
export const GLITCH_SLICE_COUNT_MAX = 32;

/** A spec plus the authored interval it is active over. */
export interface ActiveScreenEffectLike {
  startMs: number;
  durationMs: number;
  effect: ScreenEffectSpec;
}

export interface ScreenEffectFrame {
  flash: { color: string; alpha: number } | null;
  shake: { x: number; y: number };
}

/**
 * Largest accepted seed.
 *
 * The seed crosses the Tauri IPC boundary as a JSON number, so it must stay
 * inside the JavaScript safe integer range; `0xffffffff` mirrors the Rust
 * `u32` and is exactly representable.
 */
export const SHAKE_SEED_MAX = 0xffff_ffff;

/**
 * Normalised progress of an effect window.
 *
 * Returns `NaN` outside the window so a stale playhead can never apply an
 * out-of-window flash or shake.
 */
export function normalizedEffectProgress(
  elapsedMs: number,
  startMs: number,
  durationMs: number,
): number {
  if (elapsedMs < startMs) return Number.NaN;
  const duration = Math.max(1, durationMs);
  const progress = (elapsedMs - startMs) / duration;
  if (progress >= 1) return Number.NaN;
  return Math.max(0, progress);
}

/**
 * Stable per-axis phase offset derived from the authored seed.
 *
 * A fixed integer hash (32-bit xorshift-style mixing) maps the seed to
 * `[0, 2π)` without touching floating point randomness, so the same seed
 * always produces the same offset on every engine, host and seek position.
 * Seed `0` (the default) is a valid, stable seed.
 */
export function shakeSeedPhase(seed: number, axis: 0 | 1): number {
  const salt = axis === 0 ? 0x9e37_79b9 : 0x85eb_ca6b;
  let value = ((normalizeSeed(seed) & SHAKE_SEED_MAX) ^ salt) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9_f3b) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9_f3b) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  return (value / 0x1_0000_0000) * Math.PI * 2;
}

function normalizeSeed(seed: number): number {
  return Number.isFinite(seed) ? Math.max(0, Math.floor(seed)) : 0;
}

/**
 * Stable value in `[0, 1)` for one seed, one step and one salt.
 *
 * The same 32-bit integer mixing as `shakeSeedPhase`, so a glitch pattern is
 * a pure function of the authored seed and the playhead on every host.
 */
export function seededUnit(seed: number, step: number, salt: number): number {
  let value =
    ((normalizeSeed(seed) & SHAKE_SEED_MAX) ^
      Math.imul(Math.floor(step) | 0, 0x9e37_79b1) ^
      Math.imul((salt | 0) + 1, 0x85eb_ca6b)) >>>
    0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9_f3b) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9_f3b) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  return value / 0x1_0000_0000;
}

/**
 * Intensity envelope of a shader effect: linear ramps over the first
 * `fadeIn` and the last `fadeOut` fraction of the window, full in between.
 * A zero fade is an instant edge; `fadeIn = 1` ramps up across the window.
 */
export function evaluateEffectEnvelope(
  progress: number,
  fadeIn: number,
  fadeOut: number,
): number {
  if (Number.isNaN(progress)) return 0;
  const rise = fadeIn > 0 ? progress / fadeIn : 1;
  const fall = fadeOut > 0 ? (1 - progress) / fadeOut : 1;
  return Math.max(0, Math.min(1, rise, fall));
}

/**
 * Flash alpha at one playhead position.
 *
 * The shipped `ease_out` decay is kept; only colour and peak alpha are
 * parameterised.  Reduced motion caps the peak instead of dropping the beat.
 */
export function evaluateFlashAlpha(
  spec: FlashSpec,
  elapsedMs: number,
  startMs: number,
  durationMs: number,
  options: ScreenEffectOptions = {},
): number {
  const progress = normalizedEffectProgress(elapsedMs, startMs, durationMs);
  if (Number.isNaN(progress)) return 0;
  const authored = Number.isFinite(spec.peak_alpha) ? spec.peak_alpha : 0;
  const peak =
    options.reducedMotion === true
      ? Math.min(authored, REDUCED_MOTION.flashPeakAlphaMax)
      : authored;
  return peak * (1 - applyEasing(progress, "ease_out"));
}

/**
 * Shake offset at one playhead position.
 *
 * The offset is a sinusoid at `frequency_hz` against elapsed seconds, with a
 * per-axis phase derived from the seed, bounded by `amplitude_x`/`amplitude_y`
 * and scaled by the linear envelope `1 - decay * progress` (decay `0` never
 * decays, decay `1` reaches zero exactly at the end of the window).
 */
export function evaluateShakeOffset(
  spec: ShakeSpec,
  elapsedMs: number,
  startMs: number,
  durationMs: number,
  options: ScreenEffectOptions = {},
): { x: number; y: number } {
  const progress = normalizedEffectProgress(elapsedMs, startMs, durationMs);
  if (Number.isNaN(progress)) return { x: 0, y: 0 };
  const envelope =
    (1 - spec.decay * progress) *
    (options.reducedMotion === true ? REDUCED_MOTION.shakeScale : 1);
  const seconds = Math.max(0, elapsedMs - startMs) / 1000;
  const omega = 2 * Math.PI * spec.frequency_hz;
  const phaseX = shakeSeedPhase(spec.seed, 0);
  const phaseY = shakeSeedPhase(spec.seed, 1);
  return {
    x: Math.sin(omega * seconds + phaseX) * spec.amplitude_x * envelope,
    y: Math.sin(omega * seconds + phaseY) * spec.amplitude_y * envelope,
  };
}

/**
 * Both screen effects at one playhead position.
 *
 * Flash and shake are independent channels, so they stack; a window whose spec
 * does not match the channel is ignored instead of being coerced.
 */
export function evaluateScreenEffectFrame(
  elapsedMs: number,
  flash: ActiveScreenEffectLike | null,
  shake: ActiveScreenEffectLike | null,
  options: ScreenEffectOptions = {},
): ScreenEffectFrame {
  const flashFrame =
    flash !== null && flash.effect.type === "flash"
      ? {
          color: flash.effect.color,
          alpha: evaluateFlashAlpha(
            flash.effect,
            elapsedMs,
            flash.startMs,
            flash.durationMs,
            options,
          ),
        }
      : null;
  const shakeFrame =
    shake !== null && shake.effect.type === "shake"
      ? evaluateShakeOffset(
          shake.effect,
          elapsedMs,
          shake.startMs,
          shake.durationMs,
          options,
        )
      : { x: 0, y: 0 };
  return {
    flash: flashFrame !== null && flashFrame.alpha > 0 ? flashFrame : null,
    shake: shakeFrame,
  };
}

// ---------------------------------------------------------------------------
// Shader effects
//
// The evaluators below only compute plain uniform values; `sceneShaders.ts`
// owns the GLSL.  "The shader draws, the playhead decides when and how
// strongly": a frame is `null` outside its window or at zero intensity, so an
// idle surface never runs a post-processing pass.
// ---------------------------------------------------------------------------

/** RGB split uniforms; red samples at `+offset`, blue at `-offset`. */
export interface ChromaticAberrationFrame {
  /** Channel offset at full weight, in design pixels. */
  offsetX: number;
  offsetY: number;
  centerX: number;
  centerY: number;
  edgeWeight: number;
}

/** Band displacement uniforms for one glitch step. */
export interface GlitchFrame {
  /** Horizontal displacement per band in design pixels (one per band). */
  offsets: readonly number[];
  /** Vertical phase of the band grid, as a fraction of one band. */
  phase: number;
}

/** Expanding ring uniforms. */
export interface ShockwaveFrame {
  centerX: number;
  centerY: number;
  radius: number;
  waveWidth: number;
  strength: number;
}

/**
 * Straight-RGB colour grading uniforms.
 *
 * Every colour value is in `[0, 1]`; `mix` is the enveloped intensity that
 * blends the neutral source with the transformed colour, so an intensity of
 * `0` never reaches the shader (the evaluator returns `null`).
 */
export interface ColorGradeFrame {
  /** Additive brightness in straight RGB. */
  brightness: number;
  /** Contrast around mid grey `0.5`. */
  contrast: number;
  /** Saturation around the luminance. */
  saturation: number;
  /** Tint colour, straight RGB in `[0, 1]`. */
  tintR: number;
  tintG: number;
  tintB: number;
  /** `0..1` blend of the graded colour toward the multiplicative tint. */
  tintStrength: number;
  /** `0..1` enveloped intensity: neutral source ↔ fully graded colour. */
  mix: number;
}

/**
 * Focus (variable-radius blur + darkening) uniforms.
 *
 * The shader derives the per-pixel mask from the geometry and scales
 * `maxBlur` by it; `darkness` is applied exactly once, on the final vertical
 * pass, so the two Gaussian passes never darken twice.
 */
export interface FocusFrame {
  centerX: number;
  centerY: number;
  /** Sharp centre disc radius in design pixels. */
  radius: number;
  /** Design-pixel width of the `radius → radius + softness` transition. */
  softness: number;
  /** Peak design-pixel blur at the full mask; `0` runs no blur pass. */
  maxBlur: number;
  /** `0..1` darkening at the full mask; applied once on the final pass. */
  darkness: number;
}

/** Signed concentric displacement uniforms of one ripple. */
export interface RippleFrame {
  centerX: number;
  centerY: number;
  /** Peak radial displacement in design pixels, already enveloped. */
  amplitude: number;
  /** Ring wavelength in design pixels. */
  wavelength: number;
  /** Phase advance in design pixels (`speed * local seconds`). */
  waveOffset: number;
  /** Spatial falloff coefficient (`exp(-damping * distance / 2203)`). */
  damping: number;
  /** Design-pixel width of the smooth centre taper (avoids the singularity). */
  taper: number;
}

/** Every shader channel at one playhead position; `null` means "no pass". */
export interface ShaderEffectFrame {
  ripple: RippleFrame | null;
  shockwave: ShockwaveFrame | null;
  glitch: GlitchFrame | null;
  colorGrade: ColorGradeFrame | null;
  focus: FocusFrame | null;
  chromaticAberration: ChromaticAberrationFrame | null;
}

export const EMPTY_SHADER_EFFECT_FRAME: ShaderEffectFrame = Object.freeze({
  ripple: null,
  shockwave: null,
  glitch: null,
  colorGrade: null,
  focus: null,
  chromaticAberration: null,
});

export function isShaderEffectFrameEmpty(frame: ShaderEffectFrame): boolean {
  return (
    frame.ripple === null &&
    frame.shockwave === null &&
    frame.glitch === null &&
    frame.colorGrade === null &&
    frame.focus === null &&
    frame.chromaticAberration === null
  );
}

export function evaluateChromaticAberration(
  spec: ChromaticAberrationSpec,
  elapsedMs: number,
  startMs: number,
  durationMs: number,
  options: ScreenEffectOptions = {},
): ChromaticAberrationFrame | null {
  const progress = normalizedEffectProgress(elapsedMs, startMs, durationMs);
  const intensity =
    spec.intensity *
    evaluateEffectEnvelope(progress, spec.fade_in, spec.fade_out) *
    (options.reducedMotion === true ? REDUCED_MOTION.chromaticScale : 1);
  if (!(intensity > 0)) return null;
  const angle = (spec.angle_deg * Math.PI) / 180;
  return {
    offsetX: Math.cos(angle) * intensity,
    offsetY: Math.sin(angle) * intensity,
    centerX: spec.center_x,
    centerY: spec.center_y,
    edgeWeight: Math.max(0, Math.min(1, spec.edge_weight)),
  };
}

/**
 * Glitch bands at one playhead position.
 *
 * Time is quantised into steps of `1 / frequency_hz`; within a step every band
 * is displaced with probability `density` by a seeded signed amount, and the
 * whole band grid shifts by a seeded phase so band edges do not stay put.
 * Seeking to any position reproduces exactly the same pattern.
 */
export function evaluateGlitch(
  spec: GlitchSpec,
  elapsedMs: number,
  startMs: number,
  durationMs: number,
  options: ScreenEffectOptions = {},
): GlitchFrame | null {
  const progress = normalizedEffectProgress(elapsedMs, startMs, durationMs);
  const reduced = options.reducedMotion === true;
  const amplitude =
    spec.displacement *
    evaluateEffectEnvelope(progress, spec.fade_in, spec.fade_out) *
    (reduced ? REDUCED_MOTION.glitchScale : 1);
  if (!(amplitude > 0)) return null;
  const frequency = reduced
    ? Math.min(spec.frequency_hz, REDUCED_MOTION.glitchFrequencyMaxHz)
    : spec.frequency_hz;
  const seconds = Math.max(0, elapsedMs - startMs) / 1000;
  const step = Math.floor(seconds * Math.max(0, frequency));
  const count = Math.max(
    1,
    Math.min(GLITCH_SLICE_COUNT_MAX, Math.round(spec.slice_count)),
  );
  const offsets: number[] = [];
  for (let band = 0; band < count; band += 1) {
    if (seededUnit(spec.seed, step, band * 3) >= spec.density) {
      offsets.push(0);
      continue;
    }
    const magnitude = 0.3 + 0.7 * seededUnit(spec.seed, step, band * 3 + 1);
    const sign = seededUnit(spec.seed, step, band * 3 + 2) < 0.5 ? -1 : 1;
    offsets.push(sign * magnitude * amplitude);
  }
  return {
    offsets,
    phase: seededUnit(spec.seed, step, GLITCH_SLICE_COUNT_MAX * 3),
  };
}

/**
 * Shockwave ring at one playhead position.
 *
 * The ring radius eases out to `max_radius` over the window while its
 * displacement fades linearly, so the wave lands hard and dissipates.
 */
export function evaluateShockwave(
  spec: ShockwaveSpec,
  elapsedMs: number,
  startMs: number,
  durationMs: number,
  options: ScreenEffectOptions = {},
): ShockwaveFrame | null {
  const progress = normalizedEffectProgress(elapsedMs, startMs, durationMs);
  if (Number.isNaN(progress)) return null;
  const strength =
    spec.strength *
    (1 - progress) *
    (options.reducedMotion === true ? REDUCED_MOTION.shockwaveScale : 1);
  if (!(strength > 0)) return null;
  return {
    centerX: spec.center_x,
    centerY: spec.center_y,
    radius: spec.max_radius * applyEasing(progress, "ease_out"),
    waveWidth: spec.wave_width,
    strength,
  };
}

/**
 * Normalised straight-RGB components of a `#RRGGBB`/`#RRGGBBAA` colour.
 *
 * Mirrors the renderer's colour convention (`parseColor`): the leading `#` is
 * optional, a malformed colour falls back to opaque white, and a six-digit
 * colour is fully opaque.
 */
export function parseHexRgb(color: string): {
  r: number;
  g: number;
  b: number;
  a: number;
} {
  const hex = color.startsWith("#") ? color.slice(1) : color;
  if (hex.length !== 6 && hex.length !== 8) return { r: 1, g: 1, b: 1, a: 1 };
  const value = Number.parseInt(hex.slice(0, 6), 16);
  if (Number.isNaN(value)) return { r: 1, g: 1, b: 1, a: 1 };
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 0xff;
  return {
    r: ((value >> 16) & 0xff) / 255,
    g: ((value >> 8) & 0xff) / 255,
    b: (value & 0xff) / 255,
    a: (Number.isNaN(alpha) ? 0xff : alpha) / 255,
  };
}

/**
 * Colour grading uniforms at one playhead position.
 *
 * The evaluator returns `null` for an identity grade (`brightness = 0`,
 * `contrast = 1`, `saturation = 1`, `tint_strength = 0`) or once the enveloped
 * intensity reaches zero, so an idle or neutral grade never installs a pass.
 * The grade itself is a pure straight-RGB transform of the neutral source;
 * `mix` blends the two and is what makes `intensity` and the fade window
 * visible.  Reduced motion keeps grading intact.
 */
export function evaluateColorGrade(
  spec: ColorGradeSpec,
  elapsedMs: number,
  startMs: number,
  durationMs: number,
  _options: ScreenEffectOptions = {},
): ColorGradeFrame | null {
  const progress = normalizedEffectProgress(elapsedMs, startMs, durationMs);
  const intensity =
    spec.intensity *
    evaluateEffectEnvelope(progress, spec.fade_in, spec.fade_out);
  if (!(intensity > 0)) return null;
  const identity =
    spec.brightness === 0 &&
    spec.contrast === 1 &&
    spec.saturation === 1 &&
    spec.tint_strength === 0;
  if (identity) return null;
  const tint = parseHexRgb(spec.tint);
  return {
    brightness: spec.brightness,
    contrast: spec.contrast,
    saturation: spec.saturation,
    tintR: tint.r,
    tintG: tint.g,
    tintB: tint.b,
    tintStrength: Math.max(0, Math.min(1, spec.tint_strength)),
    mix: Math.max(0, Math.min(1, intensity)),
  };
}

/**
 * Focus uniforms at one playhead position.
 *
 * `blur` is the design-pixel blur that the shader reaches at the full mask and
 * is scaled by the enveloped intensity; `darkness` is scaled the same way.
 * Reduced motion disables the blur but keeps the (optional) darkening, so the
 * focus beat survives without any motion.  The evaluator returns `null` when
 * the intensity is zero or when both blur and darkening are zero, which is the
 * zero-effect bypass.
 */
export function evaluateFocus(
  spec: FocusSpec,
  elapsedMs: number,
  startMs: number,
  durationMs: number,
  options: ScreenEffectOptions = {},
): FocusFrame | null {
  const progress = normalizedEffectProgress(elapsedMs, startMs, durationMs);
  const intensity =
    spec.intensity *
    evaluateEffectEnvelope(progress, spec.fade_in, spec.fade_out);
  if (!(intensity > 0)) return null;
  const blurScale =
    options.reducedMotion === true ? REDUCED_MOTION.focusBlurScale : 1;
  const maxBlur = spec.blur * intensity * blurScale;
  const darkness = spec.darkness * intensity;
  if (!(maxBlur > 0) && !(darkness > 0)) return null;
  return {
    centerX: spec.center_x,
    centerY: spec.center_y,
    radius: spec.radius,
    softness: spec.softness,
    maxBlur: Math.max(0, maxBlur),
    darkness: Math.max(0, Math.min(1, darkness)),
  };
}

/**
 * Ripple uniforms at one playhead position.
 *
 * The wave is a deterministic function of the local time
 * `t = max(0, elapsed - start) / 1000`: the shader displaces pixels along the
 * radial direction by a signed sinusoid whose phase advances at `speed`.  The
 * amplitude is scaled by the enveloped intensity, and reduced motion turns the
 * effect off (a concentric wave is the most vestibular of the channels).  A
 * zero amplitude, a zero intensity or a finished window all return `null`, so
 * an idle ripple installs no pass.
 */
export function evaluateRipple(
  spec: RippleSpec,
  elapsedMs: number,
  startMs: number,
  durationMs: number,
  options: ScreenEffectOptions = {},
): RippleFrame | null {
  const progress = normalizedEffectProgress(elapsedMs, startMs, durationMs);
  const intensity =
    spec.intensity *
    evaluateEffectEnvelope(progress, spec.fade_in, spec.fade_out);
  if (!(intensity > 0)) return null;
  const motionScale =
    options.reducedMotion === true ? REDUCED_MOTION.rippleScale : 1;
  const amplitude = spec.amplitude * intensity * motionScale;
  if (!(amplitude > 0)) return null;
  const seconds = Math.max(0, elapsedMs - startMs) / 1000;
  const wavelength = Math.max(0.0001, spec.wavelength);
  return {
    centerX: spec.center_x,
    centerY: spec.center_y,
    amplitude,
    wavelength,
    waveOffset: spec.speed * seconds,
    damping: Math.max(0, spec.damping),
    taper: wavelength * 0.25,
  };
}

/** The shader channels of the active effects, one window per channel. */
export interface ActiveShaderEffectsLike {
  chromatic_aberration: ActiveScreenEffectLike | null;
  glitch: ActiveScreenEffectLike | null;
  shockwave: ActiveScreenEffectLike | null;
  color_grade: ActiveScreenEffectLike | null;
  focus: ActiveScreenEffectLike | null;
  ripple: ActiveScreenEffectLike | null;
}

/**
 * All shader channels at one playhead position.
 *
 * Like flash and shake, the channels are independent and stack; a window whose
 * spec does not match its channel is ignored.
 */
export function evaluateShaderEffectFrame(
  elapsedMs: number,
  active: ActiveShaderEffectsLike,
  options: ScreenEffectOptions = {},
): ShaderEffectFrame {
  const {
    chromatic_aberration: chromatic,
    glitch,
    shockwave,
    color_grade: colorGrade,
    focus,
    ripple,
  } = active;
  return {
    ripple:
      ripple !== null && ripple.effect.type === "ripple"
        ? evaluateRipple(
            ripple.effect,
            elapsedMs,
            ripple.startMs,
            ripple.durationMs,
            options,
          )
        : null,
    shockwave:
      shockwave !== null && shockwave.effect.type === "shockwave"
        ? evaluateShockwave(
            shockwave.effect,
            elapsedMs,
            shockwave.startMs,
            shockwave.durationMs,
            options,
          )
        : null,
    glitch:
      glitch !== null && glitch.effect.type === "glitch"
        ? evaluateGlitch(
            glitch.effect,
            elapsedMs,
            glitch.startMs,
            glitch.durationMs,
            options,
          )
        : null,
    colorGrade:
      colorGrade !== null && colorGrade.effect.type === "color_grade"
        ? evaluateColorGrade(
            colorGrade.effect,
            elapsedMs,
            colorGrade.startMs,
            colorGrade.durationMs,
            options,
          )
        : null,
    focus:
      focus !== null && focus.effect.type === "focus"
        ? evaluateFocus(
            focus.effect,
            elapsedMs,
            focus.startMs,
            focus.durationMs,
            options,
          )
        : null,
    chromaticAberration:
      chromatic !== null && chromatic.effect.type === "chromatic_aberration"
        ? evaluateChromaticAberration(
            chromatic.effect,
            elapsedMs,
            chromatic.startMs,
            chromatic.durationMs,
            options,
          )
        : null,
  };
}
