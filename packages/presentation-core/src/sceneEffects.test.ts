import { describe, expect, it } from "vitest";

import {
  SHAKE_SEED_MAX,
  evaluateFlashAlpha,
  evaluateScreenEffectFrame,
  evaluateShakeOffset,
  normalizedEffectProgress,
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

  it("keeps legacy seed 0 deterministic", () => {
    const legacy: typeof SHAKE = { ...SHAKE, seed: 0 };
    expect(evaluateShakeOffset(legacy, 200, 0, 400)).toEqual(
      evaluateShakeOffset(legacy, 200, 0, 400),
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
    expect(SHAKE_SEED_MAX).toBe(0xffffffff);
    expect(shakeSeedPhase(SHAKE_SEED_MAX, 0)).toBeGreaterThanOrEqual(0);
  });
});
