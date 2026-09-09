import { describe, expect, it } from "vitest";

import { LongTextScrollController } from "./scroll";

describe("LongTextScrollController", () => {
  it("keeps velocity when the target changes", () => {
    const controller = new LongTextScrollController({
      position: 0,
      target: 1_000,
      maxScroll: 2_000,
    });
    controller.advance(50);
    const before = controller.getState();
    controller.setTarget(200);
    const after = controller.getState();
    expect(after.position).toBe(before.position);
    expect(after.velocity).toBe(before.velocity);
    expect(after.target).toBe(200);
  });

  it("converges at different frame rates without overshooting", () => {
    const at60 = new LongTextScrollController({
      target: 900,
      maxScroll: 1_000,
    });
    const at30 = new LongTextScrollController({
      target: 900,
      maxScroll: 1_000,
    });
    for (let index = 0; index < 60; index += 1) at60.advance(1000 / 60);
    for (let index = 0; index < 30; index += 1) at30.advance(1000 / 30);
    expect(at60.getState().position).toBeCloseTo(at30.getState().position, 3);
    expect(at60.getState().position).toBeLessThanOrEqual(900);
  });

  it("clamps bounds and removes outward velocity", () => {
    const controller = new LongTextScrollController({
      position: 500,
      target: 1_000,
      maxScroll: 500,
    });
    controller.setPosition(500, true);
    expect(controller.getState().position).toBe(500);
    expect(controller.getState().velocity).toBe(0);
    controller.setTarget(-100);
    expect(controller.getState().target).toBe(0);
    controller.advance(50);
    expect(controller.getState().position).toBeGreaterThanOrEqual(0);
  });

  it("limits a stalled frame and settles by snapping the final epsilon", () => {
    const controller = new LongTextScrollController({
      target: 100,
      maxScroll: 200,
    });
    controller.advance(2_000);
    expect(controller.getState().position).toBeLessThan(100);
    for (let index = 0; index < 100; index += 1) controller.advance(16);
    expect(controller.getState()).toMatchObject({
      position: 100,
      velocity: 0,
      settled: true,
    });
  });
});
