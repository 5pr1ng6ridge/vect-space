import { describe, expect, it } from "vitest";

import { calculateViewportMetrics } from "./viewport";

describe("fixed design viewport", () => {
  it("letterboxes a wide window with one scale", () => {
    const metrics = calculateViewportMetrics(2560, 1080);
    expect(metrics.scale).toBe(1);
    expect(metrics.offsetX).toBe(320);
    expect(metrics.offsetY).toBe(0);
  });
});
