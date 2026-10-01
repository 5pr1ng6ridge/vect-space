import { describe, expect, it } from "vitest";

import {
  GLITCH_SLICE_COUNT_MAX,
  REDUCED_MOTION,
  RIPPLE_FALLOFF_DISTANCE,
  SHAKE_SEED_MAX,
  evaluateChromaticAberration,
  evaluateColorGrade,
  evaluateEffectEnvelope,
  evaluateFlashAlpha,
  evaluateFocus,
  evaluateGlitch,
  evaluateRipple,
  evaluateScreenEffectFrame,
  evaluateShaderEffectFrame,
  evaluateShakeOffset,
  evaluateShockwave,
  isShaderEffectFrameEmpty,
  normalizedEffectProgress,
  parseHexRgb,
  seededUnit,
  shakeSeedPhase,
  type ActiveScreenEffectLike,
} from "./sceneEffects";
import type { ScreenEffectSpec } from "./types";

const FLASH: Extract<ScreenEffectSpec, { type: "flash" }> = {
  type: "flash",
  color: "#FFFFFF",
  peak_alpha: 0.88,
};

const SHAKE: Extract<ScreenEffectSpec, { type: "shake" }> = {
  type: "shake",
  amplitude_x: 16,
  amplitude_y: 9.6,
  frequency_hz: 18,
  decay: 1,
  seed: 0,
};

function shakeWith(overrides: Partial<typeof SHAKE>): typeof SHAKE {
  return { ...SHAKE, ...overrides };
}

describe("normalizedEffectProgress", () => {
  it("is neutral outside the window and normalised inside", () => {
    expect(Number.isNaN(normalizedEffectProgress(50, 100, 400))).toBe(true);
    expect(normalizedEffectProgress(100, 100, 400)).toBe(0);
    expect(normalizedEffectProgress(300, 100, 400)).toBe(0.5);
    expect(Number.isNaN(normalizedEffectProgress(500, 100, 400))).toBe(true);
  });
});

describe("evaluateFlashAlpha", () => {
  it("uses the authored peak and the shipped ease-out decay", () => {
    expect(evaluateFlashAlpha(FLASH, 0, 0, 400)).toBeCloseTo(0.88);
    expect(evaluateFlashAlpha(FLASH, 200, 0, 400)).toBeLessThan(0.88);
    expect(evaluateFlashAlpha(FLASH, 400, 0, 400)).toBe(0);
    expect(evaluateFlashAlpha(FLASH, 100, 200, 400)).toBe(0);
  });

  it("scales with the authored peak", () => {
    const dim = { ...FLASH, peak_alpha: 0.4 };
    expect(evaluateFlashAlpha(dim, 0, 0, 400)).toBeCloseTo(0.4);
  });
});

describe("evaluateShakeOffset", () => {
  it("is deterministic for a fixed seed and playhead", () => {
    const first = evaluateShakeOffset(SHAKE, 200, 100, 400);
    const second = evaluateShakeOffset(SHAKE, 200, 100, 400);
    expect(second).toEqual(first);
    expect(evaluateShakeOffset(SHAKE, 300, 100, 400)).not.toEqual(first);
  });

  it("keeps the default seed 0 deterministic", () => {
    const shake: typeof SHAKE = { ...SHAKE, seed: 0 };
    expect(evaluateShakeOffset(shake, 200, 0, 400)).toEqual(
      evaluateShakeOffset(shake, 200, 0, 400),
    );
    expect(shakeSeedPhase(0, 0)).toBeGreaterThanOrEqual(0);
    expect(shakeSeedPhase(0, 0)).toBeLessThan(Math.PI * 2);
    expect(shakeSeedPhase(0, 0)).not.toBe(shakeSeedPhase(0, 1));
  });

  it("changes phase when the seed changes", () => {
    expect(shakeSeedPhase(42, 0)).not.toBe(shakeSeedPhase(0, 0));
    expect(
      evaluateShakeOffset({ ...SHAKE, seed: 42 }, 200, 0, 400),
    ).not.toEqual(evaluateShakeOffset(SHAKE, 200, 0, 400));
  });

  it("stays bounded by the per-axis amplitude", () => {
    for (let elapsed = 0; elapsed < 400; elapsed += 7) {
      const offset = evaluateShakeOffset(SHAKE, elapsed, 0, 400);
      expect(Math.abs(offset.x)).toBeLessThanOrEqual(SHAKE.amplitude_x + 1e-6);
      expect(Math.abs(offset.y)).toBeLessThanOrEqual(SHAKE.amplitude_y + 1e-6);
    }
  });

  it("honours the decay envelope", () => {
    const constant = shakeWith({ decay: 0, seed: 7 });
    let maxNormalized = 0;
    for (let elapsed = 0; elapsed < 400; elapsed += 1) {
      const offset = evaluateShakeOffset(constant, elapsed, 0, 400);
      maxNormalized = Math.max(
        maxNormalized,
        Math.abs(offset.x) / constant.amplitude_x,
        Math.abs(offset.y) / constant.amplitude_y,
      );
    }
    // No decay: the envelope stays 1, so the sinusoid reaches its amplitude.
    expect(maxNormalized).toBeGreaterThan(0.9);

    const full = shakeWith({ decay: 1, seed: 7 });
    // At the very end of the window the envelope is (almost) zero.
    const end = evaluateShakeOffset(full, 399.999, 0, 400);
    expect(Math.abs(end.x)).toBeLessThan(0.05);
    expect(Math.abs(end.y)).toBeLessThan(0.05);
  });

  it("is neutral outside the window", () => {
    expect(evaluateShakeOffset(SHAKE, 50, 100, 400)).toEqual({ x: 0, y: 0 });
    expect(evaluateShakeOffset(SHAKE, 500, 100, 400)).toEqual({ x: 0, y: 0 });
  });
});

describe("evaluateScreenEffectFrame", () => {
  const flash: ActiveScreenEffectLike = {
    startMs: 0,
    durationMs: 400,
    effect: FLASH,
  };
  const shake: ActiveScreenEffectLike = {
    startMs: 0,
    durationMs: 400,
    effect: SHAKE,
  };

  it("stacks flash and shake at one playhead", () => {
    const frame = evaluateScreenEffectFrame(100, flash, shake);
    expect(frame.flash?.alpha).toBeGreaterThan(0);
    expect(frame.shake.x === 0 && frame.shake.y === 0).toBe(false);
  });

  it("holds only the matching channel", () => {
    const wrong = evaluateScreenEffectFrame(100, shake, flash);
    expect(wrong.flash).toBeNull();
    expect(wrong.shake).toEqual({ x: 0, y: 0 });
  });

  it("reports no flash once its window ends", () => {
    expect(evaluateScreenEffectFrame(400, flash, shake).flash).toBeNull();
  });
});

describe("seed bounds", () => {
  it("documents the JavaScript-safe upper bound", () => {
    expect(SHAKE_SEED_MAX).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(shakeSeedPhase(SHAKE_SEED_MAX, 0)).toBeGreaterThanOrEqual(0);
  });
});

const CHROMATIC: Extract<ScreenEffectSpec, { type: "chromatic_aberration" }> = {
  type: "chromatic_aberration",
  intensity: 12,
  angle_deg: 0,
  center_x: 960,
  center_y: 540,
  edge_weight: 0.6,
  fade_in: 0,
  fade_out: 1,
};

const GLITCH: Extract<ScreenEffectSpec, { type: "glitch" }> = {
  type: "glitch",
  displacement: 48,
  slice_count: 16,
  density: 0.35,
  frequency_hz: 12,
  seed: 0,
  fade_in: 0,
  fade_out: 0,
};

const SHOCKWAVE: Extract<ScreenEffectSpec, { type: "shockwave" }> = {
  type: "shockwave",
  center_x: 960,
  center_y: 540,
  max_radius: 1100,
  wave_width: 140,
  strength: 28,
};

const COLOR_GRADE: Extract<ScreenEffectSpec, { type: "color_grade" }> = {
  type: "color_grade",
  brightness: 0.25,
  contrast: 1.4,
  saturation: 1.5,
  tint: "#ff8000",
  tint_strength: 0.6,
  intensity: 1,
  fade_in: 0,
  fade_out: 0,
};

const FOCUS: Extract<ScreenEffectSpec, { type: "focus" }> = {
  type: "focus",
  center_x: 960,
  center_y: 540,
  radius: 280,
  softness: 160,
  blur: 8,
  darkness: 0.3,
  intensity: 1,
  fade_in: 0,
  fade_out: 0,
};

const RIPPLE: Extract<ScreenEffectSpec, { type: "ripple" }> = {
  type: "ripple",
  center_x: 960,
  center_y: 540,
  amplitude: 12,
  wavelength: 160,
  speed: 240,
  damping: 1,
  intensity: 1,
  fade_in: 0,
  fade_out: 0,
};

describe("evaluateEffectEnvelope", () => {
  it("ramps in and out over the authored fractions", () => {
    expect(evaluateEffectEnvelope(0, 0, 0)).toBe(1);
    expect(evaluateEffectEnvelope(0.99, 0, 0)).toBe(1);
    expect(evaluateEffectEnvelope(0.1, 0.2, 0)).toBeCloseTo(0.5);
    expect(evaluateEffectEnvelope(0.5, 0.2, 0.2)).toBe(1);
    expect(evaluateEffectEnvelope(0.9, 0.2, 0.2)).toBeCloseTo(0.5);
    // fade_in = 1 rises across the whole window.
    expect(evaluateEffectEnvelope(0.25, 1, 0)).toBeCloseTo(0.25);
  });

  it("is zero outside the window", () => {
    expect(evaluateEffectEnvelope(Number.NaN, 0, 0)).toBe(0);
  });
});

describe("evaluateChromaticAberration", () => {
  it("points the split along the authored angle and decays by default", () => {
    const start = evaluateChromaticAberration(CHROMATIC, 0, 0, 400);
    expect(start).toMatchObject({
      centerX: 960,
      centerY: 540,
      edgeWeight: 0.6,
    });
    expect(start?.offsetX).toBeCloseTo(12);
    expect(start?.offsetY).toBeCloseTo(0);
    const vertical = evaluateChromaticAberration(
      { ...CHROMATIC, angle_deg: 90 },
      0,
      0,
      400,
    );
    expect(vertical?.offsetX).toBeCloseTo(0);
    expect(vertical?.offsetY).toBeCloseTo(12);
    const half = evaluateChromaticAberration(CHROMATIC, 200, 0, 400);
    expect(half?.offsetX).toBeCloseTo(6);
  });

  it("produces no pass outside the window or at zero intensity", () => {
    expect(evaluateChromaticAberration(CHROMATIC, 400, 0, 400)).toBeNull();
    expect(evaluateChromaticAberration(CHROMATIC, -1, 0, 400)).toBeNull();
    expect(
      evaluateChromaticAberration({ ...CHROMATIC, intensity: 0 }, 10, 0, 400),
    ).toBeNull();
    // A fade-in starts from nothing.
    expect(
      evaluateChromaticAberration(
        { ...CHROMATIC, fade_in: 1, fade_out: 0 },
        0,
        0,
        400,
      ),
    ).toBeNull();
  });
});

describe("evaluateGlitch", () => {
  it("is a pure function of the seed and the playhead", () => {
    const first = evaluateGlitch(GLITCH, 250, 0, 1_000);
    expect(evaluateGlitch(GLITCH, 250, 0, 1_000)).toEqual(first);
    expect(first?.offsets).toHaveLength(16);
    // 12 Hz steps last 83.3 ms: a nearby playhead keeps the same pattern.
    expect(evaluateGlitch(GLITCH, 251, 0, 1_000)).toEqual(first);
  });

  it("changes pattern with the step and the seed", () => {
    const base = evaluateGlitch(GLITCH, 10, 0, 1_000);
    expect(evaluateGlitch(GLITCH, 100, 0, 1_000)).not.toEqual(base);
    expect(evaluateGlitch({ ...GLITCH, seed: 7 }, 10, 0, 1_000)).not.toEqual(
      base,
    );
  });

  it("keeps displacement bounded and honours density", () => {
    for (let elapsed = 0; elapsed < 1_000; elapsed += 37) {
      const frame = evaluateGlitch(GLITCH, elapsed, 0, 1_000);
      for (const offset of frame?.offsets ?? []) {
        expect(Math.abs(offset)).toBeLessThanOrEqual(48);
      }
      expect(frame?.phase).toBeGreaterThanOrEqual(0);
      expect(frame?.phase).toBeLessThan(1);
    }
    const none = evaluateGlitch({ ...GLITCH, density: 0 }, 10, 0, 1_000);
    expect(none?.offsets.every((offset) => offset === 0)).toBe(true);
    const all = evaluateGlitch({ ...GLITCH, density: 1 }, 10, 0, 1_000);
    expect(
      all?.offsets.every((offset) => Math.abs(offset) >= 48 * 0.3 - 1e-9),
    ).toBe(true);
  });

  it("clamps the band count to the shader table", () => {
    const frame = evaluateGlitch({ ...GLITCH, slice_count: 99 }, 10, 0, 1_000);
    expect(frame?.offsets).toHaveLength(GLITCH_SLICE_COUNT_MAX);
  });

  it("stops at the end of the window", () => {
    expect(evaluateGlitch(GLITCH, 1_000, 0, 1_000)).toBeNull();
  });
});

describe("evaluateShockwave", () => {
  it("expands the ring while its strength fades", () => {
    const early = evaluateShockwave(SHOCKWAVE, 70, 0, 700);
    const late = evaluateShockwave(SHOCKWAVE, 560, 0, 700);
    expect(early?.radius).toBeLessThan(late?.radius ?? 0);
    expect(early?.strength).toBeGreaterThan(late?.strength ?? 0);
    expect(late?.radius).toBeLessThanOrEqual(1_100);
    expect(evaluateShockwave(SHOCKWAVE, 0, 0, 700)).toMatchObject({
      radius: 0,
      strength: 28,
      waveWidth: 140,
      centerX: 960,
      centerY: 540,
    });
    expect(evaluateShockwave(SHOCKWAVE, 700, 0, 700)).toBeNull();
  });
});

describe("evaluateColorGrade", () => {
  it("passes the grade and the enveloped neutral mix", () => {
    const frame = evaluateColorGrade(COLOR_GRADE, 0, 0, 400);
    expect(frame).toMatchObject({
      brightness: 0.25,
      contrast: 1.4,
      saturation: 1.5,
      tintStrength: 0.6,
      mix: 1,
    });
    // `#ff8000` → straight RGB.
    expect(frame?.tintR).toBeCloseTo(1);
    expect(frame?.tintG).toBeCloseTo(128 / 255);
    expect(frame?.tintB).toBeCloseTo(0);
    // The window ramp scales only the neutral mix, never the authored grade.
    const faded = evaluateColorGrade(COLOR_GRADE, 0, 0, 400, {})!;
    expect(faded.mix).toBeCloseTo(1);
  });

  it("scales the neutral mix by intensity and the fade envelope", () => {
    const half = evaluateColorGrade(
      { ...COLOR_GRADE, intensity: 0.5 },
      0,
      0,
      400,
    );
    expect(half?.mix).toBeCloseTo(0.5);
    const ramped = evaluateColorGrade(
      { ...COLOR_GRADE, fade_in: 0.5, fade_out: 0 },
      100,
      0,
      400,
    );
    expect(ramped?.mix).toBeCloseTo(0.5);
  });

  it("bypasses an identity grade and a zero influence", () => {
    expect(
      evaluateColorGrade(
        {
          ...COLOR_GRADE,
          brightness: 0,
          contrast: 1,
          saturation: 1,
          tint_strength: 0,
        },
        0,
        0,
        400,
      ),
    ).toBeNull();
    expect(
      evaluateColorGrade({ ...COLOR_GRADE, intensity: 0 }, 0, 0, 400),
    ).toBeNull();
    expect(evaluateColorGrade(COLOR_GRADE, 400, 0, 400)).toBeNull();
    expect(evaluateColorGrade(COLOR_GRADE, -1, 0, 400)).toBeNull();
  });

  it("keeps a tint-only edit and reduced motion intact", () => {
    const tintOnly = {
      ...COLOR_GRADE,
      brightness: 0,
      contrast: 1,
      saturation: 1,
    };
    expect(evaluateColorGrade(tintOnly, 0, 0, 400)?.tintStrength).toBeCloseTo(
      0.6,
    );
    expect(
      evaluateColorGrade(COLOR_GRADE, 0, 0, 400, { reducedMotion: true })?.mix,
    ).toBeCloseTo(1);
  });
});

describe("parseHexRgb", () => {
  it("parses both hex lengths and falls back to opaque white", () => {
    expect(parseHexRgb("#ffffff")).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseHexRgb("000000")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    const translucent = parseHexRgb("#ff800080");
    expect(translucent.r).toBeCloseTo(1);
    expect(translucent.a).toBeCloseTo(128 / 255);
    expect(parseHexRgb("nope")).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });
});

describe("evaluateFocus", () => {
  it("scales blur and darkening by the enveloped intensity", () => {
    expect(evaluateFocus(FOCUS, 0, 0, 400)).toEqual({
      centerX: 960,
      centerY: 540,
      radius: 280,
      softness: 160,
      maxBlur: 8,
      darkness: 0.3,
    });
    const faded = evaluateFocus(FOCUS, 0, 0, 400, {})!;
    expect(faded.maxBlur).toBeCloseTo(8);
    const half = evaluateFocus({ ...FOCUS, intensity: 0.5 }, 0, 0, 400)!;
    expect(half.maxBlur).toBeCloseTo(4);
    expect(half.darkness).toBeCloseTo(0.15);
  });

  it("bypasses zero intensity and a blur/darkness both at zero", () => {
    expect(evaluateFocus({ ...FOCUS, intensity: 0 }, 0, 0, 400)).toBeNull();
    expect(evaluateFocus(FOCUS, 400, 0, 400)).toBeNull();
    expect(
      evaluateFocus({ ...FOCUS, blur: 0, darkness: 0 }, 0, 0, 400),
    ).toBeNull();
    // Blur zero but darkening authored keeps a darken-only pass.
    const darkenOnly = evaluateFocus({ ...FOCUS, blur: 0 }, 0, 0, 400)!;
    expect(darkenOnly.maxBlur).toBe(0);
    expect(darkenOnly.darkness).toBeCloseTo(0.3);
  });

  it("disables the blur but keeps the darkening under reduced motion", () => {
    const frame = evaluateFocus(FOCUS, 0, 0, 400, { reducedMotion: true })!;
    expect(frame.maxBlur).toBe(0);
    expect(frame.darkness).toBeCloseTo(0.3);
    // With no darkening left either, the channel is fully bypassed.
    expect(
      evaluateFocus({ ...FOCUS, darkness: 0 }, 0, 0, 400, {
        reducedMotion: true,
      }),
    ).toBeNull();
  });
});

describe("evaluateRipple", () => {
  it("is a deterministic function of the local time", () => {
    const first = evaluateRipple(RIPPLE, 250, 0, 2_000);
    expect(evaluateRipple(RIPPLE, 250, 0, 2_000)).toEqual(first);
    expect(first).toMatchObject({
      centerX: 960,
      centerY: 540,
      amplitude: 12,
      wavelength: 160,
      damping: 1,
    });
    // speed 240 px/s at 0.25 s → 60 design px of phase.
    expect(first?.waveOffset).toBeCloseTo(60);
    expect(first?.taper).toBeCloseTo(40);
  });

  it("starts the wave at rest and scales with intensity", () => {
    // At the window start the local time (and so the phase advance) is zero.
    expect(evaluateRipple(RIPPLE, 0, 0, 2_000)?.waveOffset).toBeCloseTo(0);
    expect(evaluateRipple(RIPPLE, 0, 500, 2_000)).toBeNull();
    expect(
      evaluateRipple({ ...RIPPLE, intensity: 0.25 }, 0, 0, 2_000)?.amplitude,
    ).toBeCloseTo(3);
  });

  it("is off at zero amplitude, zero intensity and under reduced motion", () => {
    expect(evaluateRipple({ ...RIPPLE, amplitude: 0 }, 0, 0, 2_000)).toBeNull();
    expect(evaluateRipple({ ...RIPPLE, intensity: 0 }, 0, 0, 2_000)).toBeNull();
    expect(evaluateRipple(RIPPLE, 2_000, 0, 2_000)).toBeNull();
    expect(
      evaluateRipple(RIPPLE, 500, 0, 2_000, { reducedMotion: true }),
    ).toBeNull();
  });

  it("documents the shared falloff distance", () => {
    expect(RIPPLE_FALLOFF_DISTANCE).toBe(2203);
  });
});

describe("reduced motion", () => {
  const reduced = { reducedMotion: true };

  it("caps flashes and scales shakes", () => {
    expect(evaluateFlashAlpha(FLASH, 0, 0, 400, reduced)).toBeCloseTo(
      REDUCED_MOTION.flashPeakAlphaMax,
    );
    const full = evaluateShakeOffset(SHAKE, 30, 0, 400);
    const soft = evaluateShakeOffset(SHAKE, 30, 0, 400, reduced);
    expect(soft.x).toBeCloseTo(full.x * REDUCED_MOTION.shakeScale);
  });

  it("softens every shader effect and slows the glitch", () => {
    expect(
      evaluateChromaticAberration(CHROMATIC, 0, 0, 400, reduced)?.offsetX,
    ).toBeCloseTo(12 * REDUCED_MOTION.chromaticScale);
    expect(
      evaluateShockwave(SHOCKWAVE, 0, 0, 700, reduced)?.strength,
    ).toBeCloseTo(28 * REDUCED_MOTION.shockwaveScale);
    const fast = { ...GLITCH, frequency_hz: 60, density: 1 };
    // Capped at 4 Hz, the pattern holds for 250 ms.
    const held = evaluateGlitch(fast, 10, 0, 1_000, reduced);
    expect(evaluateGlitch(fast, 240, 0, 1_000, reduced)).toEqual(held);
    for (const offset of held?.offsets ?? []) {
      expect(Math.abs(offset)).toBeLessThanOrEqual(
        48 * REDUCED_MOTION.glitchScale,
      );
    }
  });
});

describe("evaluateShaderEffectFrame", () => {
  it("stacks independent channels and ignores mismatched specs", () => {
    const frame = evaluateShaderEffectFrame(100, {
      chromatic_aberration: { startMs: 0, durationMs: 400, effect: CHROMATIC },
      glitch: { startMs: 0, durationMs: 400, effect: GLITCH },
      shockwave: { startMs: 0, durationMs: 700, effect: SHOCKWAVE },
      color_grade: null,
      focus: null,
      ripple: null,
    });
    expect(frame.chromaticAberration).not.toBeNull();
    expect(frame.glitch).not.toBeNull();
    expect(frame.shockwave).not.toBeNull();
    const wrong = evaluateShaderEffectFrame(100, {
      chromatic_aberration: { startMs: 0, durationMs: 400, effect: GLITCH },
      glitch: null,
      shockwave: { startMs: 0, durationMs: 400, effect: FLASH },
      color_grade: { startMs: 0, durationMs: 400, effect: SHOCKWAVE },
      focus: { startMs: 0, durationMs: 400, effect: SHOCKWAVE },
      ripple: { startMs: 0, durationMs: 400, effect: SHOCKWAVE },
    });
    expect(isShaderEffectFrameEmpty(wrong)).toBe(true);
  });

  it("stacks every new channel beside the shipped passes", () => {
    const frame = evaluateShaderEffectFrame(100, {
      chromatic_aberration: null,
      glitch: null,
      shockwave: null,
      color_grade: {
        startMs: 0,
        durationMs: 400,
        effect: COLOR_GRADE,
      },
      focus: { startMs: 0, durationMs: 400, effect: FOCUS },
      ripple: { startMs: 0, durationMs: 400, effect: RIPPLE },
    });
    expect(frame.colorGrade).not.toBeNull();
    expect(frame.focus).not.toBeNull();
    expect(frame.ripple).not.toBeNull();
    expect(isShaderEffectFrameEmpty(frame)).toBe(false);
  });
});

describe("seededUnit", () => {
  it("stays in [0, 1) and is stable", () => {
    for (let step = 0; step < 50; step += 1) {
      const value = seededUnit(SHAKE_SEED_MAX, step, step * 3);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      expect(seededUnit(SHAKE_SEED_MAX, step, step * 3)).toBe(value);
    }
  });
});
