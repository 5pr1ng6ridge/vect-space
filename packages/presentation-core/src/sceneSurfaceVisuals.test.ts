// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Texture } from "pixi.js";
import { SceneSurface } from "./sceneSurface";
import { createFramePump, createMemoryKit, createMemoryTextureLoader, MemorySprite } from "./sceneTestKit";
import { TextBlockRasterizer } from "./textBlock";
import { ParticleEvaluator, PARTICLE_STRIDE } from "./particles";
import { spritePreset } from "./visual";
import { EMITTER_FIXTURE, PARTICLE_FIXTURE, TEXT_FIXTURE } from "./visualTestKit";
import { evaluateSceneFrame, hitTestSceneFrame } from "./sceneFrame";

const CAMERA = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
const ASSETS = { dot: "/dot.png" };
const world = (generation = 1) => ({ sprites: {}, camera: CAMERA, emitters: { snow: { ...EMITTER_FIXTURE, generation } } });

afterEach(() => vi.restoreAllMocks());

async function harness() {
  const kit = createMemoryKit();
  const pump = createFramePump();
  const loader = createMemoryTextureLoader({ "/dot.png": { width: 16, height: 16 }, "/large.png": { width: 1024, height: 1024 } });
  const surface = new SceneSurface({ canvas: document.createElement("canvas"), kit: kit.kit,
    textureLoader: loader.load, requestFrame: pump.request, cancelFrame: pump.cancel, particles: { snow: PARTICLE_FIXTURE } });
  await surface.init();
  pump.step(0);
  const run = (ms: number) => { for (let remaining = ms; remaining > 0; remaining -= 16) pump.step(Math.min(16, remaining)); };
  return { kit, pump, loader, surface, run };
}

function particleData(data: Float32Array | null, count: number) {
  return Array.from(data?.subarray(0, count * PARTICLE_STRIDE) ?? []);
}

describe("SceneSurface particle ownership", () => {
  it("keeps one batch, texture, buffer, scheduler and phase across ordinary snapshot alignment", async () => {
    const h = await harness();
    h.surface.applyWorld(await h.surface.prepare({ world: world(), assets: ASSETS }));
    h.surface.seekParticles(1000);
    const batch = h.kit.particleBatches[0]!;
    const buffer = batch.data;
    const expected = particleData(batch.data, batch.count);
    h.surface.applyWorld(await h.surface.prepare({ world: world(), assets: ASSETS }));
    expect(h.kit.particleBatches).toHaveLength(1);
    expect(batch.data).toBe(buffer);
    expect(particleData(batch.data, batch.count)).toEqual(expected);
    expect(h.pump.pending()).toBe(1);
    expect(h.loader.loaded).toHaveLength(1);
    expect(batch.bounds.width).toBeGreaterThan(400);
    expect(batch.node.scale.x).toBe(batch.node.scale.y);
    h.surface.applyWorld(await h.surface.prepare({ world: world(2), assets: ASSETS }));
    expect(batch.node.destroyCount).toBe(1);
    expect(h.kit.particleBatches).toHaveLength(2);
    expect(h.kit.particleBatches[1]?.count).toBe(1);
    h.surface.dispose();
    expect(h.pump.pending()).toBe(0);
    expect(h.loader.destroyed).toHaveLength(1);
    expect(h.surface.particleStats).toEqual({ emitters: 0, live: 0, capacity: 0, textures: 0 });
  });

  it("starts a second persistent effect without replacing the first and stops only its own instance", async () => {
    const h = await harness();
    const second = { ...EMITTER_FIXTURE, particle: "sparks", x: 500 };
    h.surface.setVisualResources({}, {
      snow: PARTICLE_FIXTURE,
      sparks: { ...PARTICLE_FIXTURE, id: "sparks", velocity_y: { min: -100, max: -100 } },
    });
    const firstWorld = { sprites: {}, camera: CAMERA, emitters: { emitter: EMITTER_FIXTURE } };
    h.surface.applyWorld(await h.surface.prepare({ world: firstWorld, assets: ASSETS }));
    h.surface.seekParticles(1000);
    const firstBatch = h.kit.particleBatches[0]!;
    const before = particleData(firstBatch.data, firstBatch.count);
    const context = { assets: ASSETS, signal: new AbortController().signal, getRate: () => 1 };
    await h.surface.runCue({ cue_id: "second", gate: "none", type: "particle_state",
      emitter_id: "emitter_2", emitter: second, burst: false }, context);
    expect(h.surface.particleStats.emitters).toBe(2);
    expect(firstBatch.node.destroyed).toBe(false);
    expect(particleData(firstBatch.data, firstBatch.count)).toEqual(before);

    h.surface.applyWorld(await h.surface.prepare({
      world: { ...firstWorld, emitters: { ...firstWorld.emitters, emitter_2: second } }, assets: ASSETS,
    }));
    expect(h.kit.particleBatches).toHaveLength(2);
    h.run(16);
    expect(particleData(firstBatch.data, firstBatch.count)).not.toEqual(before);
    await h.surface.runCue({ cue_id: "stop-second", gate: "none", type: "particle_state",
      emitter_id: "emitter_2", emitter: null, burst: false }, context);
    expect(h.surface.particleStats.emitters).toBe(1);
    expect(firstBatch.node.destroyed).toBe(false);
    expect(h.kit.particleBatches[1]?.node.destroyed).toBe(true);
    h.surface.dispose();
  });

  it("animates/selects a whole emitter without rebuilding particles or capturing transient bursts", async () => {
    const h = await harness();
    h.surface.applyWorld(await h.surface.prepare({ world: world(), assets: ASSETS }));
    await h.surface.runCue({ cue_id: "burst", gate: "none", type: "particle_state", emitter_id: "snow", emitter: EMITTER_FIXTURE, burst: true },
      { assets: ASSETS, signal: new AbortController().signal, getRate: () => 1 });
    expect(Object.keys(h.surface.captureBases().emitters ?? {})).toEqual(["snow"]);
    const frame = evaluateSceneFrame({ ...world(), duration_ms: 1000, tracks: [{ type: "emitter", emitter_id: "snow", remove_at_end: false,
      channels: { x: [{ at_ms: 0, value: "inherit", easing: "linear" }, { at_ms: 1000, value: 1160, easing: "linear" }], scale: [{ at_ms: 0, value: 2, easing: "linear" }] } }], bgm_volume: 1 }, 500, h.surface.geometry);
    h.surface.applyFrame(frame, { phase: "playhead" });
    const batch = h.kit.particleBatches[0]!;
    expect(batch.node.position.x).toBe(1060);
    expect(batch.node.scale.x).toBe(2);
    expect(frame.objects).toHaveLength(1);
    expect(frame.objects[0]).toMatchObject({ id: "emitter:snow", kind: "emitter", width: 800, height: 200 });
    expect(hitTestSceneFrame(frame, { x: 1060, y: 100 })?.id).toBe("emitter:snow");
    expect(h.kit.particleBatches).toHaveLength(2);
    expect(batch.node.destroyCount).toBe(0);
    h.surface.setObjectOverride("emitter:snow", { x: 1200, scale: 3 });
    expect(h.surface.readFrame().objects[0]).toMatchObject({ x: 1200, width: 1200 });
    h.surface.clearOverrides();
    expect(batch.node.position.x).toBe(1060);
    h.surface.dispose();
  });

  it("freezes on pause without catch-up and seeks deterministically", async () => {
    const h = await harness();
    h.surface.applyWorld(await h.surface.prepare({ world: world(), assets: ASSETS }));
    h.surface.seekParticles(1000);
    const batch = h.kit.particleBatches[0]!;
    const before = particleData(batch.data, batch.count);
    h.surface.setPaused(true);
    h.run(5000);
    expect(particleData(batch.data, batch.count)).toEqual(before);
    h.surface.setPaused(false);
    h.run(16);
    const evaluator = new ParticleEvaluator(PARTICLE_FIXTURE, EMITTER_FIXTURE.seed);
    const count = evaluator.evaluate(1016);
    expect(particleData(batch.data, batch.count)).toEqual(particleData(evaluator.data, count));
    h.surface.seekParticles(2000);
    const seek = particleData(batch.data, batch.count);
    h.surface.seekParticles(500);
    h.surface.seekParticles(2000);
    expect(particleData(batch.data, batch.count)).toEqual(seek);
    h.surface.dispose();
  });

  it("keeps bursts through ordinary reconciliation and releases each expired burst", async () => {
    const h = await harness();
    const context = { assets: ASSETS, signal: new AbortController().signal, getRate: () => 1 };
    await Promise.all(["burst-a", "burst-b"].map((cue_id) => h.surface.runCue({ cue_id, gate: "none", type: "particle_state", emitter_id: "snow", emitter: EMITTER_FIXTURE, burst: true }, context)));
    expect(h.surface.particleStats.emitters).toBe(2);
    h.surface.applyWorld(await h.surface.prepare({ world: { sprites: {}, camera: CAMERA }, assets: ASSETS }));
    expect(h.surface.particleStats.emitters).toBe(2);
    h.run(3000);
    expect(h.surface.particleStats.emitters).toBe(0);
    expect(h.loader.destroyed).toHaveLength(1);
    expect(h.kit.particleBatches.every((batch) => batch.node.destroyCount === 1)).toBe(true);
    h.surface.dispose();
  });

  it("isolates clocks, batches and textures on simultaneous surfaces", async () => {
    const left = await harness(), right = await harness();
    await Promise.all([left, right].map(async (h) => h.surface.applyWorld(await h.surface.prepare({ world: world(), assets: ASSETS }))));
    left.surface.seekParticles(1000);
    right.surface.seekParticles(1500);
    const rightBatch = right.kit.particleBatches[0]!;
    const rightData = particleData(rightBatch.data, rightBatch.count);
    left.run(500);
    left.surface.reset();
    left.surface.dispose();
    expect(rightBatch.node.destroyed).toBe(false);
    expect(particleData(rightBatch.data, rightBatch.count)).toEqual(rightData);
    expect(right.loader.destroyed).toHaveLength(0);
    expect(right.pump.pending()).toBe(1);
    right.surface.dispose();
  });

  it("rejects invalid texture/configuration/budget before committing any replacement view", async () => {
    const h = await harness();
    const base = { sprites: { dot: spritePreset("item", { type: "image", asset: "dot" }) }, camera: CAMERA };
    h.surface.applyWorld(await h.surface.prepare({ world: base, assets: ASSETS }));
    const sprite = h.kit.applications[0]?.stage.children[0]?.children.find((node) => node instanceof MemorySprite);
    h.surface.setVisualResources({}, { snow: { ...PARTICLE_FIXTURE, max_particles: 5000 } });
    const emitters = Object.fromEntries(["one", "two", "three"].map((id) => [id, EMITTER_FIXTURE]));
    await expect(h.surface.prepare({ world: { ...base, emitters }, assets: ASSETS })).rejects.toThrow("预算");
    h.surface.setVisualResources({}, { snow: { ...PARTICLE_FIXTURE, image: "large" } });
    // Explicitly exercise a too-large decode, not only authoring validation.
    await expect(h.surface.prepare({ world: world(), assets: { large: "/large.png" } })).rejects.toThrow("512");
    expect(h.loader.destroyed.map((texture) => texture.url)).toEqual(["/large.png"]);
    expect(sprite?.destroyed).toBe(false);
    expect(h.kit.particleBatches).toHaveLength(0);
    h.surface.dispose();
  });
});

describe("SceneSurface particle sampling ownership", () => {
  const sprite = spritePreset("item", { type: "image", asset: "dot" });
  const two = (generation = 1) => ({ sprites: {}, camera: CAMERA,
    emitters: { left: { ...EMITTER_FIXTURE, generation }, right: { ...EMITTER_FIXTURE, x: 500, generation } } });
  const onlyLeft = { sprites: {}, camera: CAMERA, emitters: { left: EMITTER_FIXTURE } };

  it("draws particles from a nearest copy at native size while a Sprite keeps the shared texture", async () => {
    const h = await harness();
    h.surface.applyWorld(await h.surface.prepare({
      world: { sprites: { dot: sprite }, camera: CAMERA, emitters: { snow: EMITTER_FIXTURE } }, assets: ASSETS }));
    const shared = h.loader.loaded[0]!;
    const view = h.kit.applications[0]?.stage.children[0]?.children.find((node) => node instanceof MemorySprite) as MemorySprite;
    // One decode serves both; only the particle batch samples a different copy.
    expect(h.loader.loaded).toHaveLength(1);
    expect(view.texture).toBe(shared);
    const copy = h.kit.particleTextures[0]!;
    expect(h.kit.particleBatches[0]?.texture).toBe(copy);
    expect(copy).toMatchObject({ base: shared, sampling: "nearest", width: 16, height: 16, destroyed: false });
    expect(shared).toMatchObject({ width: 16, height: 16, destroyed: false });
    // Removing the emitter drops only the copy; the Sprite's pixels stay.
    h.surface.applyWorld(await h.surface.prepare({ world: { sprites: { dot: sprite }, camera: CAMERA }, assets: ASSETS }));
    expect(copy.destroyCount).toBe(1);
    expect(h.loader.destroyed).toEqual([]);
    expect(view.texture).toBe(shared);
    expect(h.surface.particleTextures).toEqual({ resident: 0, refs: 0 });
    h.surface.dispose();
    expect(copy.destroyCount).toBe(1);
  });

  it("shares one copy between emitters of the same image and releases it with the last one", async () => {
    const h = await harness();
    h.surface.applyWorld(await h.surface.prepare({ world: two(), assets: ASSETS }));
    expect(h.kit.particleBatches).toHaveLength(2);
    expect(h.kit.particleTextures).toHaveLength(1);
    expect(h.kit.particleBatches.map((batch) => batch.texture)).toEqual([h.kit.particleTextures[0], h.kit.particleTextures[0]]);
    expect(h.surface.particleTextures).toEqual({ resident: 1, refs: 2 });
    h.surface.applyWorld(await h.surface.prepare({ world: onlyLeft, assets: ASSETS }));
    expect(h.surface.particleTextures).toEqual({ resident: 1, refs: 1 });
    expect(h.kit.particleTextures[0]?.destroyCount).toBe(0);
    h.surface.applyWorld(await h.surface.prepare({ world: { sprites: {}, camera: CAMERA }, assets: ASSETS }));
    expect(h.kit.particleTextures[0]?.destroyCount).toBe(1);
    expect(h.surface.particleTextures).toEqual({ resident: 0, refs: 0 });
    expect(h.loader.destroyed).toHaveLength(1);
    h.surface.dispose();
    expect(h.kit.particleTextures).toHaveLength(1);
  });

  it("keeps the copy when a cue replaces an emitter of the same image", async () => {
    const h = await harness();
    h.surface.applyWorld(await h.surface.prepare({ world: world(1), assets: ASSETS }));
    const context = { assets: ASSETS, signal: new AbortController().signal, getRate: () => 1 };
    await h.surface.runCue({ cue_id: "again", gate: "none", type: "particle_state", emitter_id: "snow",
      emitter: { ...EMITTER_FIXTURE, generation: 2 }, burst: false }, context);
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
    h.surface.applyWorld(await h.surface.prepare({ world: world(1), assets: ASSETS }));
    h.surface.applyWorld(await h.surface.prepare({ world: world(2), assets: ASSETS }));
    expect(h.kit.particleBatches).toHaveLength(2);
    expect(h.kit.particleTextures.map((copy) => copy.destroyCount)).toEqual([1, 0]);
    expect(h.kit.particleBatches[1]?.texture).toBe(h.kit.particleTextures[1]);
    expect(h.surface.particleTextures).toEqual({ resident: 1, refs: 1 });
    h.surface.dispose();
    expect(h.kit.particleTextures.map((copy) => copy.destroyCount)).toEqual([1, 1]);
  });

  it("destroys every copy exactly once across repeated create and release cycles", async () => {
    const h = await harness();
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      h.surface.applyWorld(await h.surface.prepare({ world: world(cycle), assets: ASSETS }));
      expect(h.surface.particleTextures).toEqual({ resident: 1, refs: 1 });
      h.surface.reset();
      expect(h.surface.particleTextures).toEqual({ resident: 0, refs: 0 });
    }
    expect(h.kit.particleTextures).toHaveLength(5);
    expect(h.kit.particleTextures.map((copy) => copy.destroyCount)).toEqual([1, 1, 1, 1, 1]);
    expect(h.loader.destroyed).toHaveLength(5);
    h.surface.dispose();
    expect(h.kit.particleTextures.every((copy) => copy.destroyCount === 1)).toBe(true);
  });

  it("shares a copy between concurrent bursts and releases it when the last one expires", async () => {
    const h = await harness();
    const context = { assets: ASSETS, signal: new AbortController().signal, getRate: () => 1 };
    await Promise.all(["burst-a", "burst-b"].map((cue_id) => h.surface.runCue(
      { cue_id, gate: "none", type: "particle_state", emitter_id: "snow", emitter: EMITTER_FIXTURE, burst: true }, context)));
    expect(h.kit.particleBatches).toHaveLength(2);
    expect(h.kit.particleTextures).toHaveLength(1);
    expect(h.surface.particleTextures).toEqual({ resident: 1, refs: 2 });
    h.run(3000);
    expect(h.surface.particleStats.emitters).toBe(0);
    expect(h.kit.particleTextures[0]?.destroyCount).toBe(1);
    expect(h.surface.particleTextures).toEqual({ resident: 0, refs: 0 });
    h.surface.dispose();
  });

  it("gives each surface its own copy so one surface never releases another's", async () => {
    const left = await harness(), right = await harness();
    await Promise.all([left, right].map(async (h) => h.surface.applyWorld(await h.surface.prepare({ world: world(), assets: ASSETS }))));
    expect(left.kit.particleTextures[0]).not.toBe(right.kit.particleTextures[0]);
    left.surface.reset();
    left.surface.dispose();
    expect(left.kit.particleTextures[0]?.destroyCount).toBe(1);
    expect(right.kit.particleTextures[0]?.destroyCount).toBe(0);
    expect(right.surface.particleTextures).toEqual({ resident: 1, refs: 1 });
    right.surface.dispose();
    expect(right.kit.particleTextures[0]?.destroyCount).toBe(1);
  });

  it("releases a retained copy when the batch cannot be created", async () => {
    const memory = createMemoryKit();
    const kit = { ...memory.kit, particles: () => { throw new Error("batch failed"); } };
    const pump = createFramePump();
    const surface = new SceneSurface({ canvas: document.createElement("canvas"), kit, textureLoader: createMemoryTextureLoader().load,
      requestFrame: pump.request, cancelFrame: pump.cancel, particles: { snow: PARTICLE_FIXTURE } });
    await surface.init();
    await expect(async () => surface.applyWorld(await surface.prepare({ world: world(), assets: ASSETS }))).rejects.toThrow("batch failed");
    expect(memory.particleTextures.map((copy) => copy.destroyCount)).toEqual([1]);
    expect(surface.particleTextures).toEqual({ resident: 0, refs: 0 });
    surface.dispose();
  });
});

describe("SceneSurface pooled text textures", () => {
  it("rasterizes a shared version once, reuses it for transforms and releases every version exactly once", async () => {
    vi.spyOn(TextBlockRasterizer.prototype, "html").mockResolvedValue("<div>safe static text</div>");
    const kit = createMemoryKit();
    const create = kit.kit.application;
    const textures: Texture[] = [];
    const returned: Promise<Texture>[] = [];
    const createTexture = vi.fn(() => {
      const texture = { width: 400, height: 100, destroy: vi.fn() } as unknown as Texture;
      textures.push(texture);
      return Promise.resolve(texture);
    });
    kit.kit.application = () => {
      const app = create();
      Object.assign(app.renderer, { htmlText: { getTexturePromise: createTexture, returnTexturePromise: (promise: Promise<Texture>) => returned.push(promise) } });
      return app;
    };
    const surface = new SceneSurface({ canvas: document.createElement("canvas"), kit: kit.kit, textBlocks: { label: { definition: TEXT_FIXTURE, font_version: "1" } } });
    await surface.init();
    const state = spritePreset("text", { type: "text", text_block: "label" });
    surface.applyWorld(await surface.prepare({ world: { camera: CAMERA, sprites: { first: state, second: { ...state, x: 300 } } }, assets: {} }));
    expect(createTexture).toHaveBeenCalledTimes(1);
    surface.applyWorld(await surface.prepare({ world: { camera: CAMERA, sprites: { first: { ...state, scale: 2, rotation_deg: 10 } } }, assets: {} }));
    expect(createTexture).toHaveBeenCalledTimes(1);
    expect(returned).toHaveLength(0);
    surface.setVisualResources({ label: { definition: TEXT_FIXTURE, font_version: "2" } }, {});
    surface.applyWorld(await surface.prepare({ world: { camera: CAMERA, sprites: { first: state } }, assets: {} }));
    expect(createTexture).toHaveBeenCalledTimes(2);
    expect(returned).toHaveLength(1);
    surface.reset();
    surface.dispose();
    expect(returned).toHaveLength(2);
    expect(new Set(returned).size).toBe(2);
    expect(textures.every((texture) => !(texture.destroy as ReturnType<typeof vi.fn>).mock.calls.length)).toBe(true);
  });

  it("rejects an oversize project font while streaming instead of buffering the whole body", async () => {
    let pulls = 0;
    const chunk = new Uint8Array(1024 * 1024);
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url === "font://big"
      ? new Response(new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.enqueue(chunk); } }))
      : new Response(new Uint8Array([0, 1, 2])))));
    try {
      const rasterizer = new TextBlockRasterizer({ getTexturePromise: vi.fn(), returnTexturePromise: vi.fn() });
      await expect(rasterizer.html({ definition: TEXT_FIXTURE, font_url: "font://big", font_version: "1" }))
        .rejects.toThrow("16 MiB");
      expect(pulls).toBeLessThan(24);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns a late pooled texture after disposal rather than committing or destroying its source", async () => {
    vi.spyOn(TextBlockRasterizer.prototype, "html").mockResolvedValue("<div>safe</div>");
    let resolve!: (texture: Texture) => void;
    const pending = new Promise<Texture>((done) => { resolve = done; });
    const returned = vi.fn();
    const rasterizer = new TextBlockRasterizer({ getTexturePromise: () => pending, returnTexturePromise: returned });
    const created = rasterizer.create({ definition: TEXT_FIXTURE });
    await Promise.resolve();
    rasterizer.destroy();
    const texture = { destroy: vi.fn() } as unknown as Texture;
    resolve(texture);
    await expect(created).rejects.toThrow("已释放");
    expect(returned).toHaveBeenCalledExactlyOnceWith(pending);
    expect(texture.destroy).not.toHaveBeenCalled();
  });
});
