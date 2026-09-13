import { describe, expect, it } from "vitest";

import {
  defaultBackgroundTransition,
  defaultCurtainFill,
  defaultCurtainTransition,
  defaultFlashEffect,
  defaultShakeEffect,
} from "./presentationDefaults";

describe("editor presentation defaults", () => {
  it("pins the values the Rust loader normalises legacy one-word specs to", () => {
    expect(defaultBackgroundTransition()).toEqual({ type: "cross_fade" });
    expect(defaultCurtainFill()).toEqual({ color: "#000000" });
    expect(defaultCurtainTransition()).toEqual({ type: "fade" });
    expect(defaultFlashEffect()).toEqual({
      type: "flash",
      color: "#FFFFFF",
      peak_alpha: 0.88,
    });
    expect(defaultShakeEffect()).toEqual({
      type: "shake",
      amplitude_x: 16,
      amplitude_y: 9.6,
      frequency_hz: 18,
      decay: 1,
      seed: 0,
    });
  });

  it("returns a fresh object per call so callers can copy-on-edit", () => {
    const first = defaultShakeEffect();
    const second = defaultShakeEffect();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(defaultCurtainFill()).not.toBe(defaultCurtainFill());
  });
});
