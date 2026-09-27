import { describe, expect, it } from "vitest";

import { clampZoom, rulerTicks } from "./timelineRuler";

describe("timeline ruler", () => {
  it("labels about ten ticks per view in seconds", () => {
    const ticks = rulerTicks(2400, 1);
    expect(ticks[0]).toEqual({ at: 0, label: "0.0s" });
    expect(ticks.at(1)?.at).toBe(250);
    expect(ticks.length).toBeGreaterThanOrEqual(8);
    expect(ticks.length).toBeLessThanOrEqual(12);
  });

  it("uses finer steps when zoomed in", () => {
    const coarse = rulerTicks(10_000, 1);
    const fine = rulerTicks(10_000, 8);
    expect(fine.length).toBeGreaterThan(coarse.length * 4);
    expect(fine.at(1)?.label).toBe("0.2s");
  });

  it("keeps the zoom between fit and 32×", () => {
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(64)).toBe(32);
  });
});
