// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { ParticleEvaluator, PARTICLE_STRIDE } from "./particles";
import { evaluateSceneFrame, hitTestSceneFrame } from "./sceneFrame";
import { SceneSurface } from "./sceneSurface";
import {
  MemorySprite,
  createFramePump,
  createMemoryKit,
  createMemoryTextureLoader,
} from "./sceneTestKit";
import { spritePreset } from "./visual";
import { EMITTER_FIXTURE, PARTICLE_FIXTURE } from "./visualTestKit";

const CAMERA = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
const ASSETS = { dot: "/dot.png" };
const world = (generation = 1) => ({
  sprites: {},
  camera: CAMERA,
  emitters: { snow: { ...EMITTER_FIXTURE, generation } },
});
const emptyWorld = { sprites: {}, camera: CAMERA };
const itemSprite = spritePreset("item", { type: "image", asset: "dot" });
const cueContext = () => ({
  assets: ASSETS,
  signal: new AbortController().signal,
  getRate: () => 1,
});
const particleCue = (
  cue_id: string,
  emitter_id: string,
  emitter: typeof EMITTER_FIXTURE | null,
  burst: boolean,
) =>
  ({
    cue_id,
    gate: "none",
    type: "particle_state",
    emitter_id,
    emitter,
    burst,
  }) as const;

async function harness() {
  const kit = createMemoryKit();
  const pump = createFramePump();
  const loader = createMemoryTextureLoader({
    "/dot.png": { width: 16, height: 16 },
    "/large.png": { width: 1024, height: 1024 },
  });
  const surface = new SceneSurface({
    canvas: document.createElement("canvas"),
    kit: kit.kit,
    textureLoader: loader.load,
    requestFrame: pump.request,
    cancelFrame: pump.cancel,
    particles: { snow: PARTICLE_FIXTURE },
  });
  await surface.init();
  pump.step(0);
  const run = (ms: number) => {
    for (let remaining = ms; remaining > 0; remaining -= 16)
      pump.step(Math.min(16, remaining));
  };
  const commit = async (
    worldInput: Parameters<SceneSurface["prepare"]>[0]["world"],
  ) =>
    surface.applyWorld(
      await surface.prepare({ world: worldInput, assets: ASSETS }),
    );
  return { kit, pump, loader, surface, run, commit };
}

function particleData(data: Float32Array | null, count: number) {
  return Array.from(data?.subarray(0, count * PARTICLE_STRIDE) ?? []);
}

describe("particle emitters", () => {
  it("keeps one batch, texture, buffer, scheduler and phase across ordinary snapshot alignment", async () => {
    const h = await harness();
    await h.commit(world());
    h.surface.seekParticles(1000);
    const batch = h.kit.particleBatches[0]!;
    const buffer = batch.data;
    const expected = particleData(batch.data, batch.count);
    await h.commit(world());
    expect(h.kit.particleBatches).toHaveLength(1);
    expect(batch.data).toBe(buffer);
    expect(particleData(batch.data, batch.count)).toEqual(expected);
    expect(h.pump.pending()).toBe(1);
    expect(h.loader.loaded).toHaveLength(1);
    expect(batch.bounds.width).toBeGreaterThan(400);
    expect(batch.node.scale.x).toBe(batch.node.scale.y);
    await h.commit(world(2));
    expect(batch.node.destroyCount).toBe(1);
    expect(h.kit.particleBatches).toHaveLength(2);
    expect(h.kit.particleBatches[1]?.count).toBe(1);
    h.surface.dispose();
    expect(h.pump.pending()).toBe(0);
    expect(h.loader.destroyed).toHaveLength(1);
    expect(h.surface.particleStats).toEqual({
      emitters: 0,
      live: 0,
      capacity: 0,
      textures: 0,
    });
  });

  it("starts a second persistent effect without replacing the first and stops only its own instance", async () => {
    const h = await harness();
    const second = { ...EMITTER_FIXTURE, particle: "sparks", x: 500 };
    h.surface.setVisualResources(
      {},
      {
        snow: PARTICLE_FIXTURE,
        sparks: {
          ...PARTICLE_FIXTURE,
          id: "sparks",
          velocity_y: { min: -100, max: -100 },
        },
      },
    );
    const firstWorld = {
      sprites: {},
      camera: CAMERA,
      emitters: { emitter: EMITTER_FIXTURE },
    };
    await h.commit(firstWorld);
    h.surface.seekParticles(1000);
    const firstBatch = h.kit.particleBatches[0]!;
    const before = particleData(firstBatch.data, firstBatch.count);
    await h.surface.runCue(
      particleCue("second", "emitter_2", second, false),
      cueContext(),
    );
    expect(h.surface.particleStats.emitters).toBe(2);
    expect(firstBatch.node.destroyed).toBe(false);
    expect(particleData(firstBatch.data, firstBatch.count)).toEqual(before);

    await h.commit({
      ...firstWorld,
      emitters: { ...firstWorld.emitters, emitter_2: second },
    });
    expect(h.kit.particleBatches).toHaveLength(2);
    h.run(16);
    expect(particleData(firstBatch.data, firstBatch.count)).not.toEqual(before);
    await h.surface.runCue(
      particleCue("stop-second", "emitter_2", null, false),
      cueContext(),
    );
    expect(h.surface.particleStats.emitters).toBe(1);
    expect(firstBatch.node.destroyed).toBe(false);
    expect(h.kit.particleBatches[1]?.node.destroyed).toBe(true);
    h.surface.dispose();
  });

  it("animates and selects a whole emitter without rebuilding particles or capturing transient bursts", async () => {
    const h = await harness();
    await h.commit(world());
    await h.surface.runCue(
      particleCue("burst", "snow", EMITTER_FIXTURE, true),
      cueContext(),
    );
    expect(Object.keys(h.surface.captureBases().emitters ?? {})).toEqual([
      "snow",
    ]);
    const frame = evaluateSceneFrame(
      {
        ...world(),
        duration_ms: 1000,
        tracks: [
          {
            type: "emitter",
            emitter_id: "snow",
            remove_at_end: false,
            channels: {
              x: [
                { at_ms: 0, value: "inherit", easing: "linear" },
                { at_ms: 1000, value: 1160, easing: "linear" },
              ],
              scale: [{ at_ms: 0, value: 2, easing: "linear" }],
            },
          },
        ],
        bgm_volume: 1,
      },
      500,
      h.surface.geometry,
    );
    h.surface.applyFrame(frame, { phase: "playhead" });
    const batch = h.kit.particleBatches[0]!;
    expect(batch.node.position.x).toBe(1060);
    expect(batch.node.scale.x).toBe(2);
    expect(frame.objects).toHaveLength(1);
    expect(frame.objects[0]).toMatchObject({
      id: "emitter:snow",
      kind: "emitter",
      width: 800,
      height: 200,
    });
    expect(hitTestSceneFrame(frame, { x: 1060, y: 100 })?.id).toBe(
      "emitter:snow",
    );
    expect(h.kit.particleBatches).toHaveLength(2);
    expect(batch.node.destroyCount).toBe(0);
    h.surface.setObjectOverride("emitter:snow", { x: 1200, scale: 3 });
    expect(h.surface.readFrame().objects[0]).toMatchObject({
      x: 1200,
      width: 1200,
    });
    h.surface.clearOverrides();
    expect(batch.node.position.x).toBe(1060);
    h.surface.dispose();
  });

  it("freezes on pause without catch-up and seeks deterministically", async () => {
    const h = await harness();
    await h.commit(world());
    h.surface.seekParticles(1000);
    const batch = h.kit.particleBatches[0]!;
    const before = particleData(batch.data, batch.count);
    h.surface.setPaused(true);
    h.run(5000);
    expect(particleData(batch.data, batch.count)).toEqual(before);
    h.surface.setPaused(false);
    h.run(16);
    const evaluator = new ParticleEvaluator(
      PARTICLE_FIXTURE,
      EMITTER_FIXTURE.seed,
    );
    const count = evaluator.evaluate(1016);
    expect(particleData(batch.data, batch.count)).toEqual(
      particleData(evaluator.data, count),
    );
    h.surface.seekParticles(2000);
    const seek = particleData(batch.data, batch.count);
    h.surface.seekParticles(500);
    h.surface.seekParticles(2000);
    expect(particleData(batch.data, batch.count)).toEqual(seek);
    h.surface.dispose();
  });

  it("keeps concurrent bursts through ordinary reconciliation, sharing one copy until the last one expires", async () => {
    const h = await harness();
    const context = cueContext();
    await Promise.all(
      ["burst-a", "burst-b"].map((id) =>
        h.surface.runCue(
          particleCue(id, "snow", EMITTER_FIXTURE, true),
          context,
        ),
      ),
    );
    expect(h.surface.particleStats.emitters).toBe(2);
    expect(h.kit.particleTextures).toHaveLength(1);
    expect(h.surface.particleTextures).toEqual({ resident: 1, refs: 2 });
    await h.commit(emptyWorld);
    expect(h.surface.particleStats.emitters).toBe(2);
    h.run(3000);
    expect(h.surface.particleStats.emitters).toBe(0);
    expect(h.loader.destroyed).toHaveLength(1);
    expect(
      h.kit.particleBatches.every((batch) => batch.node.destroyCount === 1),
    ).toBe(true);
    expect(h.kit.particleTextures[0]?.destroyCount).toBe(1);
    expect(h.surface.particleTextures).toEqual({ resident: 0, refs: 0 });
    h.surface.dispose();
  });

  it("isolates clocks, batches and nearest copies on simultaneous surfaces", async () => {
    const left = await harness(),
      right = await harness();
    await Promise.all([left, right].map((h) => h.commit(world())));
    expect(left.kit.particleTextures[0]).not.toBe(
      right.kit.particleTextures[0],
    );
    left.surface.seekParticles(1000);
    right.surface.seekParticles(1500);
    const rightBatch = right.kit.particleBatches[0]!;
    const rightData = particleData(rightBatch.data, rightBatch.count);
    left.run(500);
    left.surface.reset();
    left.surface.dispose();
    expect(left.kit.particleTextures[0]?.destroyCount).toBe(1);
    expect(rightBatch.node.destroyed).toBe(false);
    expect(particleData(rightBatch.data, rightBatch.count)).toEqual(rightData);
    expect(right.loader.destroyed).toHaveLength(0);
    expect(right.kit.particleTextures[0]?.destroyCount).toBe(0);
    expect(right.surface.particleTextures).toEqual({ resident: 1, refs: 1 });
    expect(right.pump.pending()).toBe(1);
    right.surface.dispose();
    expect(right.kit.particleTextures[0]?.destroyCount).toBe(1);
  });

  it("rejects invalid texture, configuration and budget before committing any replacement view", async () => {
    const h = await harness();
    const base = { sprites: { dot: itemSprite }, camera: CAMERA };
    await h.commit(base);
    const sprite = h.kit.applications[0]?.stage.children[0]?.children.find(
      (node) => node instanceof MemorySprite,
    );
    h.surface.setVisualResources(
      {},
      { snow: { ...PARTICLE_FIXTURE, max_particles: 5000 } },
    );
    const emitters = Object.fromEntries(
      ["one", "two", "three"].map((id) => [id, EMITTER_FIXTURE]),
    );
    await expect(
      h.surface.prepare({ world: { ...base, emitters }, assets: ASSETS }),
    ).rejects.toThrow("预算");
    h.surface.setVisualResources(
      {},
      { snow: { ...PARTICLE_FIXTURE, image: "large" } },
    );
    // Explicitly exercise a too-large decode, not only authoring validation.
    await expect(
      h.surface.prepare({ world: world(), assets: { large: "/large.png" } }),
    ).rejects.toThrow("512");
    expect(h.loader.destroyed.map((texture) => texture.url)).toEqual([
      "/large.png",
    ]);
    expect(sprite?.destroyed).toBe(false);
    expect(h.kit.particleBatches).toHaveLength(0);
    h.surface.dispose();
  });
});

describe("particle sampling copies", () => {
  const two = (generation = 1) => ({
    sprites: {},
    camera: CAMERA,
    emitters: {
      left: { ...EMITTER_FIXTURE, generation },
      right: { ...EMITTER_FIXTURE, x: 500, generation },
    },
  });
  const onlyLeft = {
    sprites: {},
    camera: CAMERA,
    emitters: { left: EMITTER_FIXTURE },
  };

  it("draws particles from a nearest copy at native size while a Sprite keeps the shared texture", async () => {
    const h = await harness();
    await h.commit({
      sprites: { dot: itemSprite },
      camera: CAMERA,
      emitters: { snow: EMITTER_FIXTURE },
    });
    const shared = h.loader.loaded[0]!;
    const view = h.kit.applications[0]?.stage.children[0]?.children.find(
      (node) => node instanceof MemorySprite,
    ) as MemorySprite;
    // One decode serves both; only the particle batch samples a different copy.
    expect(h.loader.loaded).toHaveLength(1);
    expect(view.texture).toBe(shared);
    const copy = h.kit.particleTextures[0]!;
    expect(h.kit.particleBatches[0]?.texture).toBe(copy);
    expect(copy).toMatchObject({
      base: shared,
      sampling: "nearest",
      width: 16,
      height: 16,
      destroyed: false,
    });
    expect(shared).toMatchObject({ width: 16, height: 16, destroyed: false });
    // Removing the emitter drops only the copy; the Sprite's pixels stay.
    await h.commit({ sprites: { dot: itemSprite }, camera: CAMERA });
    expect(copy.destroyCount).toBe(1);
    expect(h.loader.destroyed).toEqual([]);
    expect(view.texture).toBe(shared);
    expect(h.surface.particleTextures).toEqual({ resident: 0, refs: 0 });
    h.surface.dispose();
    expect(copy.destroyCount).toBe(1);
  });

  it("shares one copy between emitters of the same image and releases it with the last one", async () => {
    const h = await harness();
    await h.commit(two());
    expect(h.kit.particleBatches).toHaveLength(2);
    expect(h.kit.particleTextures).toHaveLength(1);
    expect(h.kit.particleBatches.map((batch) => batch.texture)).toEqual([
      h.kit.particleTextures[0],
      h.kit.particleTextures[0],
    ]);
    expect(h.surface.particleTextures).toEqual({ resident: 1, refs: 2 });
    await h.commit(onlyLeft);
    expect(h.surface.particleTextures).toEqual({ resident: 1, refs: 1 });
    expect(h.kit.particleTextures[0]?.destroyCount).toBe(0);
    await h.commit(emptyWorld);
    expect(h.kit.particleTextures[0]?.destroyCount).toBe(1);
    expect(h.surface.particleTextures).toEqual({ resident: 0, refs: 0 });
    expect(h.loader.destroyed).toHaveLength(1);
    h.surface.dispose();
    expect(h.kit.particleTextures).toHaveLength(1);
  });

  it("keeps the copy when a cue replaces an emitter of the same image", async () => {
    const h = await harness();
    await h.commit(world(1));
    await h.surface.runCue(
      particleCue(
        "again",
        "snow",
        { ...EMITTER_FIXTURE, generation: 2 },
        false,
      ),
      cueContext(),
    );
    expect(h.kit.particleBatches).toHaveLength(2);
    expect(h.kit.particleBatches[0]?.node.destroyCount).toBe(1);
    expect(h.kit.particleTextures).toHaveLength(1);
    expect(h.kit.particleTextures[0]?.destroyCount).toBe(0);
    expect(h.kit.particleBatches[1]?.texture).toBe(h.kit.particleTextures[0]);
    expect(h.surface.particleTextures).toEqual({ resident: 1, refs: 1 });
    h.surface.dispose();
    expect(h.kit.particleTextures[0]?.destroyCount).toBe(1);
  });

  it("releases the previous copy once when a world commit replaces the emitter", async () => {
    const h = await harness();
    await h.commit(world(1));
    await h.commit(world(2));
    expect(h.kit.particleBatches).toHaveLength(2);
    expect(h.kit.particleTextures.map((copy) => copy.destroyCount)).toEqual([
      1, 0,
    ]);
    expect(h.kit.particleBatches[1]?.texture).toBe(h.kit.particleTextures[1]);
    expect(h.surface.particleTextures).toEqual({ resident: 1, refs: 1 });
    h.surface.dispose();
    expect(h.kit.particleTextures.map((copy) => copy.destroyCount)).toEqual([
      1, 1,
    ]);
  });

  it("destroys every copy exactly once across repeated create and release cycles", async () => {
    const h = await harness();
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      await h.commit(world(cycle));
      expect(h.surface.particleTextures).toEqual({ resident: 1, refs: 1 });
      h.surface.reset();
      expect(h.surface.particleTextures).toEqual({ resident: 0, refs: 0 });
    }
    expect(h.kit.particleTextures).toHaveLength(5);
    expect(h.kit.particleTextures.map((copy) => copy.destroyCount)).toEqual([
      1, 1, 1, 1, 1,
    ]);
    expect(h.loader.destroyed).toHaveLength(5);
    h.surface.dispose();
    expect(
      h.kit.particleTextures.every((copy) => copy.destroyCount === 1),
    ).toBe(true);
  });

  it("releases a retained copy when the batch cannot be created", async () => {
    const memory = createMemoryKit();
    const kit = {
      ...memory.kit,
      particles: () => {
        throw new Error("batch failed");
      },
    };
    const pump = createFramePump();
    const surface = new SceneSurface({
      canvas: document.createElement("canvas"),
      kit,
      textureLoader: createMemoryTextureLoader().load,
      requestFrame: pump.request,
      cancelFrame: pump.cancel,
      particles: { snow: PARTICLE_FIXTURE },
    });
    await surface.init();
    await expect(async () =>
      surface.applyWorld(
        await surface.prepare({ world: world(), assets: ASSETS }),
      ),
    ).rejects.toThrow("batch failed");
    expect(memory.particleTextures.map((copy) => copy.destroyCount)).toEqual([
      1,
    ]);
    expect(surface.particleTextures).toEqual({ resident: 0, refs: 0 });
    surface.dispose();
  });
});
