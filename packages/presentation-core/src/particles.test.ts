import { describe, expect, it } from "vitest";
import { ParticleEvaluator, PARTICLE_STRIDE, validateParticleDefinition, validateEmitter } from "./particles";
import { PARTICLE_FIXTURE } from "./visualTestKit";

function pixels(evaluator: ParticleEvaluator, elapsed: number): number[] {
  const count = evaluator.evaluate(elapsed);
  return Array.from(evaluator.data.subarray(0, count * PARTICLE_STRIDE));
}

describe("analytic image particles", () => {
  it("matches direct seek, incremental playback and backwards seek without allocating a new buffer", () => {
    const direct = new ParticleEvaluator(PARTICLE_FIXTURE, 17);
    const playback = new ParticleEvaluator(PARTICLE_FIXTURE, 17);
    const buffer = playback.data;
    for (let at = 0; at < 4000; at += 16) playback.evaluate(at);
    expect(pixels(playback, 4000)).toEqual(pixels(direct, 4000));
    playback.evaluate(7000);
    expect(pixels(playback, 4000)).toEqual(pixels(direct, 4000));
    expect(playback.data).toBe(buffer);
    expect(pixels(new ParticleEvaluator(PARTICLE_FIXTURE, 18), 4000)).not.toEqual(pixels(direct, 4000));
  });

  it("integrates position, rotation and alpha analytically", () => {
    const constant = (value: number) => ({ min: value, max: value });
    const evaluator = new ParticleEvaluator({ ...PARTICLE_FIXTURE,
      area: { type: "point" }, lifetime_ms: constant(2000), velocity_x: constant(10), velocity_y: constant(20),
      gravity_x: 4, gravity_y: -8, size: constant(2), rotation_deg: constant(90), angular_velocity_deg: constant(90),
      burst_count: 1,
    }, 17, true);
    expect(pixels(evaluator, 1000)).toEqual([12, 16, 2, Math.fround(Math.PI), 0.5]);
    expect(evaluator.evaluate(2000)).toBe(0);
  });

  it("bounds huge seeks and saturates by retaining only the newest emission slots", () => {
    const saturated = { ...PARTICLE_FIXTURE, rate: 10000, max_particles: 5000,
      lifetime_ms: { min: 30000, max: 30000 } };
    const evaluator = new ParticleEvaluator(saturated, 17);
    expect(evaluator.evaluate(10 ** 12)).toBe(5000);
    expect(evaluator.data).toHaveLength(5000 * PARTICLE_STRIDE);
    expect(Array.from(evaluator.data).every(Number.isFinite)).toBe(true);
    expect(evaluator.evaluate(0)).toBe(1);
    expect(new ParticleEvaluator({ ...PARTICLE_FIXTURE, rate: 0 }, 17).evaluate(1000)).toBe(0);
  });

  it("bounds burst counts and expires all burst particles without replay", () => {
    const evaluator = new ParticleEvaluator(PARTICLE_FIXTURE, 17, true);
    expect(evaluator.evaluate(0)).toBe(20);
    expect(evaluator.evaluate(3000)).toBe(0);
    expect(evaluator.evaluate(9000)).toBe(0);
  });

  it("rejects invalid ranges, budgets, seeds, areas and non-finite time", () => {
    for (const change of [
      { max_particles: 5001 }, { max_particles: 0 }, { rate: NaN }, { rate: -1 },
      { lifetime_ms: { min: 0, max: 100 } }, { velocity_x: { min: 2, max: 1 } },
      { burst_count: 201 }, { size: { min: 0, max: 1 } }, { seed: -1 },
      { area: { type: "rectangle" as const, width: Infinity, height: 1 } },
    ]) expect(() => validateParticleDefinition({ ...PARTICLE_FIXTURE, ...change })).toThrow();
    const evaluator = new ParticleEvaluator(PARTICLE_FIXTURE, 17);
    for (const at of [-1, NaN, Infinity, Number.MAX_VALUE]) expect(() => evaluator.evaluate(at)).toThrow();
    expect(() => validateEmitter({ particle: "snow", seed: 17, generation: 0, space: "world", x: 0, y: 0, scale: 0, rotation_deg: 0, opacity: 1, z: 0 })).toThrow();
  });
});
