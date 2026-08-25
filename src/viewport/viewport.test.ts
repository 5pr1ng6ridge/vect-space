import { describe, expect, it } from "vitest";

import { calculateViewportMetrics, screenToDesign } from "./viewport";

describe("fixed design viewport", () => {
  it("letterboxes a wide window with one scale", () => {
    const metrics = calculateViewportMetrics(2560, 1080);
    expect(metrics.scale).toBe(1);
    expect(metrics.offsetX).toBe(320);
    expect(metrics.offsetY).toBe(0);
  });

  it("maps screen input back to exact design coordinates", () => {
    const metrics = calculateViewportMetrics(1280, 800);
    const center = screenToDesign(640, 400, metrics);
    expect(center.x).toBeCloseTo(960);
    expect(center.y).toBeCloseTo(540);
  });
});
