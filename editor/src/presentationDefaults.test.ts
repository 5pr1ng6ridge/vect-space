import { describe, expect, it } from "vitest";

import { defaultCurtainFill, defaultShakeEffect } from "./presentationDefaults";

describe("editor presentation defaults", () => {
  it("returns a fresh object per call so callers can copy-on-edit", () => {
    const first = defaultShakeEffect();
    const second = defaultShakeEffect();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(defaultCurtainFill()).not.toBe(defaultCurtainFill());
  });
});
