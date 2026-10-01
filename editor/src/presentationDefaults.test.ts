import { describe, expect, it } from "vitest";

import {
  defaultColorGradeEffect,
  defaultCurtainFill,
  defaultFocusEffect,
  defaultRippleEffect,
  defaultScreenEffect,
  defaultShakeEffect,
} from "./presentationDefaults";

describe("editor presentation defaults", () => {
  it("returns a fresh object per call so callers can copy-on-edit", () => {
    const first = defaultShakeEffect();
    const second = defaultShakeEffect();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(defaultCurtainFill()).not.toBe(defaultCurtainFill());
  });

  it("mirrors the canonical Rust defaults of the composable effects", () => {
    // These mirror `default_color_grade_*` / `default_focus_*` /
    // `default_ripple_*` in `crates/vectspace-core/src/model.rs`; a drift here
    // would make a newly inserted node disagree with a spec parsed from YAML
    // without the field.
    expect(defaultColorGradeEffect()).toEqual({
      type: "color_grade",
      brightness: 0,
      contrast: 1,
      saturation: 1,
      tint: "#ffffff",
      tint_strength: 0,
      intensity: 1,
      fade_in: 0.1,
      fade_out: 0.2,
    });
    expect(defaultFocusEffect()).toEqual({
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
    });
    expect(defaultRippleEffect()).toEqual({
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
    });
  });

  it("hands out fresh colours through the type switch", () => {
    for (const type of ["color_grade", "focus", "ripple"] as const) {
      const first = defaultScreenEffect(type);
      const second = defaultScreenEffect(type);
      expect(first).not.toBe(second);
      expect(first).toEqual(second);
      expect(first.type).toBe(type);
    }
  });
});
