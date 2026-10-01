// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  evaluateSceneFrame,
  worldPointToStage,
  type SceneFrame,
} from "./sceneFrame";
import { SceneSurface } from "./sceneSurface";
import type { SceneKit, SceneTextureLike } from "./sceneSurface";
import {
  MemoryGraphics,
  MemorySprite,
  createFramePump,
  createMemoryKit,
  createMemoryTextureLoader,
  type FramePump,
  type MemoryKit,
  type MemoryShaderHost,
  type MemoryTexture,
} from "./sceneTestKit";
import type { AnimationMap } from "./imageAnimation";
import type { AssetUrlMap, SpriteSnapshot, TimelineTrack } from "./types";

const URLS: AssetUrlMap = {
  base: "/assets/base.png",
  next: "/assets/next.png",
  other: "/assets/other.png",
  walk: "/assets/walk.png",
};

const ANIMATIONS: AnimationMap = {
  walk: {
    id: "walk",
    width: 100,
    height: 50,
    total_duration_ms: 400,
    frames: [
      { asset: "walk_a", url: "/assets/walk/a.png", duration_ms: 100 },
      { asset: "walk_b", url: "/assets/walk/b.png", duration_ms: 100 },
      { asset: "walk_c", url: "/assets/walk/c.png", duration_ms: 100 },
      { asset: "walk_d", url: "/assets/walk/d.png", duration_ms: 100 },
    ],
  },
  // A ping-pong animation repeats frame urls by design; the store must decode
  // and reference each distinct url once while the frame order is preserved.
  pingpong: {
    id: "pingpong",
    width: 120,
    height: 60,
    total_duration_ms: 400,
    frames: [
      { asset: "pp_a", url: "/assets/pp/a.png", duration_ms: 100 },
      { asset: "pp_b", url: "/assets/pp/b.png", duration_ms: 100 },
      { asset: "pp_a", url: "/assets/pp/a.png", duration_ms: 100 },
      { asset: "pp_b", url: "/assets/pp/b.png", duration_ms: 100 },
    ],
  },
};

const CAMERA = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
const BASE_TEXTURE = "/assets/base.png";

function sprite(
  asset: string,
  overrides: Partial<SpriteSnapshot> = {},
): SpriteSnapshot {
  return {
    asset,
    x: 960,
    y: 1080,
    scale: 1,
    scale_x: 1,
    scale_y: 1,
    rotation_deg: 0,
    opacity: 1,
    z: 0,
    ...overrides,
  };
}

interface Harness {
  surface: SceneSurface;
  kit: MemoryKit;
  pump: FramePump;
  loaded: MemoryTexture[];
  destroyed: MemoryTexture[];
  run(ms?: number): void;
  characters(): MemorySprite[];
  backgrounds(): MemorySprite[];
  effects(): MemorySprite[] | MemoryGraphics[];
}

function assetsOf(harness: Harness): Record<string, string> {
  return Object.fromEntries(
    Object.entries(harness.surface.captureBases().sprites).map(
      ([id, state]) => [id, state.asset],
    ),
  );
}

async function createSurface(
  sizes: Readonly<Record<string, { width: number; height: number }>> = {},
  failures: ReadonlySet<string> = new Set<string>(),
): Promise<Harness> {
  const kit = createMemoryKit();
  const loader = createMemoryTextureLoader(sizes, failures);
  const pump = createFramePump();
  const surface = new SceneSurface({
    canvas: document.createElement("canvas"),
    kit: kit.kit,
    animations: ANIMATIONS,
    textureLoader: loader.load,
    requestFrame: pump.request,
    cancelFrame: pump.cancel,
  });
  await surface.init();
  // The loop starts with no elapsed time yet, exactly like a browser's first
  // animation frame; prime it so a later step advances real time.
  pump.step(0);
  const layer = (index: number): MemorySprite[] =>
    (kit.applications[0]?.stage.children[0]?.children[index]?.children ??
      []) as MemorySprite[];
  return {
    surface,
    kit,
    pump,
    loaded: loader.loaded,
    destroyed: loader.destroyed,
    run: (ms = 16) => {
      let remaining = ms;
      while (remaining > 0) {
        const slice = Math.min(16, remaining);
        pump.step(slice);
        remaining -= slice;
      }
    },
    characters: () => layer(1),
    backgrounds: () => layer(0),
    effects: () =>
      (kit.applications[0]?.stage.children[1]?.children ?? []) as never,
  };
}

/** Lets the surface's asynchronous preparation settle. */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

function frameAt(
  surface: SceneSurface,
  tracks: TimelineTrack[],
  sprites: Record<string, SpriteSnapshot>,
  elapsedMs: number,
  durationMs = 1_000,
): SceneFrame {
  return evaluateSceneFrame(
    { duration_ms: durationMs, tracks, sprites, camera: CAMERA, bgm_volume: 1 },
    elapsedMs,
    surface.geometry,
  );
}

describe("SceneSurface world preparation", () => {
  it("never commits a stale preparation and keeps the old visuals", async () => {
    const harness = await createSurface();
    const first = await harness.surface.prepare({
      world: {
        background: null,
        sprites: { hero: sprite("base") },
        camera: CAMERA,
      },
      assets: URLS,
    });
    expect(harness.surface.applyWorld(first)).toBe(true);
    expect(assetsOf(harness)).toEqual({ hero: "base" });

    const second = await harness.surface.prepare({
      world: {
        background: null,
        sprites: { hero: sprite("next") },
        camera: CAMERA,
      },
      assets: URLS,
    });
    const third = await harness.surface.prepare({
      world: {
        background: null,
        sprites: { hero: sprite("other") },
        camera: CAMERA,
      },
      assets: URLS,
    });
    expect(second?.stale).toBe(true);
    expect(harness.surface.applyWorld(second)).toBe(false);
    // The superseded request released the pixels it had acquired.
    expect(harness.destroyed.map((texture) => texture.url)).toEqual([
      "/assets/next.png",
    ]);
    expect(assetsOf(harness)).toEqual({ hero: "base" });
    expect(harness.surface.applyWorld(third)).toBe(true);
    expect(assetsOf(harness)).toEqual({ hero: "other" });
    harness.surface.dispose();
  });

  it("keeps the previous instance while the replacement decodes", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("base") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    const pending = harness.surface.prepare({
      world: {
        background: null,
        sprites: { hero: sprite("next") },
        camera: CAMERA,
      },
      assets: URLS,
    });
    expect(assetsOf(harness)).toEqual({ hero: "base" });
    expect(harness.surface.applyWorld(await pending)).toBe(true);
    expect(assetsOf(harness)).toEqual({ hero: "next" });
    harness.surface.dispose();
  });

  it("releases a discarded preparation", async () => {
    const harness = await createSurface();
    const preparation = await harness.surface.prepare({
      world: {
        background: null,
        sprites: { hero: sprite("base") },
        camera: CAMERA,
      },
      assets: URLS,
    });
    if (preparation !== null) harness.surface.discardPreparation(preparation);
    expect(harness.destroyed.map((texture) => texture.url)).toEqual([
      BASE_TEXTURE,
    ]);
    expect(assetsOf(harness)).toEqual({});
    harness.surface.dispose();
  });

  it("releases a pending preparation on reset", async () => {
    const harness = await createSurface();
    const preparation = await harness.surface.prepare({
      world: {
        background: null,
        sprites: { hero: sprite("base") },
        camera: CAMERA,
      },
      assets: URLS,
    });
    harness.surface.reset();
    expect(preparation?.stale).toBe(true);
    expect(harness.surface.applyWorld(preparation)).toBe(false);
    expect(harness.destroyed.map((texture) => texture.url)).toEqual([
      BASE_TEXTURE,
    ]);
    harness.surface.dispose();
  });

  it("shares one decoded texture between instances and refcounts it", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("base"), friend: sprite("base", { x: 500 }) },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    expect(harness.loaded).toHaveLength(1);
    expect(harness.characters()).toHaveLength(2);

    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { friend: sprite("base", { x: 500 }) },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    // One instance left, so the shared texture is still alive for it.
    expect(harness.characters()).toHaveLength(1);
    expect(harness.destroyed).toEqual([]);
    expect(harness.surface.readFrame().objects).toEqual([]);
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: { background: null, sprites: {}, camera: CAMERA },
        assets: URLS,
      }),
    );
    expect(harness.destroyed.map((texture) => texture.url)).toEqual([
      BASE_TEXTURE,
    ]);
    harness.surface.dispose();
  });

  it("renders a sprite that shares its logical asset with the background and refcounts both roles", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: "base",
          sprites: { hero: sprite("base") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    // One decode serves both roles and both objects are on screen.
    expect(harness.loaded.map((texture) => texture.url)).toEqual([
      BASE_TEXTURE,
    ]);
    expect(harness.backgrounds()).toHaveLength(1);
    expect(harness.characters()).toHaveLength(1);
    expect(harness.backgrounds()[0]?.anchor.x).toBe(0);
    expect(harness.backgrounds()[0]?.anchor.y).toBe(0);
    expect(harness.characters()[0]?.anchor.x).toBe(0.5);
    expect(harness.characters()[0]?.anchor.y).toBe(1);
    expect(harness.destroyed).toEqual([]);

    // Releasing one role keeps the shared pixels for the other one.
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("base") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    expect(harness.backgrounds()).toHaveLength(0);
    expect(harness.characters()).toHaveLength(1);
    expect(harness.destroyed).toEqual([]);

    // The last owner releases the pixels exactly once.
    harness.surface.reset();
    expect(harness.characters()).toHaveLength(0);
    expect(harness.destroyed.map((texture) => texture.url)).toEqual([
      BASE_TEXTURE,
    ]);
    harness.surface.dispose();
    expect(harness.destroyed.map((texture) => texture.url)).toEqual([
      BASE_TEXTURE,
    ]);
  });

  it("shares an animation's decoded frames between the background and a sprite", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: "walk",
          sprites: { hero: sprite("walk") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    // Four frames decoded once; both roles render the animation with their
    // own loop phase.
    expect(harness.loaded.map((texture) => texture.url)).toEqual(
      ANIMATIONS.walk?.frames.map((frame) => frame.url),
    );
    expect(harness.backgrounds()).toHaveLength(1);
    expect(harness.characters()).toHaveLength(1);
    expect(harness.surface.loopIds).toHaveLength(2);
    expect(harness.destroyed).toEqual([]);

    // Releasing the background keeps every frame alive for the sprite.
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("walk") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    expect(harness.backgrounds()).toHaveLength(0);
    expect(harness.characters()).toHaveLength(1);
    expect(harness.destroyed).toEqual([]);

    harness.surface.reset();
    expect(harness.destroyed.map((texture) => texture.url)).toEqual(
      ANIMATIONS.walk?.frames.map((frame) => frame.url),
    );
    harness.surface.dispose();
  });

  it("retains a loop phase for the same asset and restarts on a new one", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("walk") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    const hero = () => harness.characters()[0];
    expect(hero()?.textures).toHaveLength(1);
    harness.run(150);
    const advanced = hero()?.textures.length ?? 0;
    expect(advanced).toBeGreaterThan(1);

    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("walk") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    expect(hero()?.textures).toHaveLength(advanced);

    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("base") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    expect(hero()?.textures).toHaveLength(1);
    expect(harness.surface.geometry.spriteSize("walk")).toEqual({
      width: 100,
      height: 50,
    });
    harness.surface.dispose();
  });

  it("replaces a view when the animation behind an asset is revised", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("walk") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    harness.run(150);
    expect(harness.characters()[0]?.textures.length ?? 0).toBeGreaterThan(1);

    // The same logical asset id now resolves to an edited animation: the view
    // must be replaced and restarted at the new revision's first frame instead
    // of silently keeping the old decoded frames and phase.
    harness.surface.setAnimations({
      walk: {
        id: "walk",
        width: 100,
        height: 50,
        total_duration_ms: 200,
        frames: [
          { asset: "walk_a", url: "/assets/walk/a2.png", duration_ms: 100 },
          { asset: "walk_b", url: "/assets/walk/b2.png", duration_ms: 100 },
        ],
      },
    });
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("walk") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    const hero = harness.characters()[0];
    expect(hero?.textures).toHaveLength(1);
    expect(hero?.textures[0]).toBe(
      harness.loaded.find((texture) => texture.url === "/assets/walk/a2.png"),
    );
    harness.surface.dispose();
  });

  it("reports a broken animation frame and substitutes the nearest usable one", async () => {
    const harness = await createSurface({}, new Set(["/assets/walk/b.png"]));
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("walk") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    expect(harness.characters()).toHaveLength(1);
    expect(harness.loaded.map((texture) => texture.url)).not.toContain(
      "/assets/walk/b.png",
    );
    harness.run(120);
    harness.surface.dispose();
  });

  it("fails when an animation has no usable frame at all", async () => {
    const harness = await createSurface(
      {},
      new Set([
        "/assets/walk/a.png",
        "/assets/walk/b.png",
        "/assets/walk/c.png",
        "/assets/walk/d.png",
      ]),
    );
    await expect(
      harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("walk") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    ).rejects.toThrow("没有可用帧");
    harness.surface.dispose();
  });

  it("fails on an unresolved asset", async () => {
    const harness = await createSurface();
    await expect(
      harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("missing") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    ).rejects.toThrow("素材尚未解析: missing");
    harness.surface.dispose();
  });

  /** Urls the instance actually displayed, in the order it displayed them. */
  function appliedFrameUrls(sprite: MemorySprite | undefined): string[] {
    return (sprite?.textures ?? []).map(
      (texture) => (texture as MemoryTexture).url,
    );
  }

  it("decodes a repeated-frame (ping-pong) animation once per distinct url and releases it to zero", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("pingpong") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    // Two distinct urls were decoded once each, not once per frame occurrence.
    expect(harness.loaded.map((texture) => texture.url)).toEqual([
      "/assets/pp/a.png",
      "/assets/pp/b.png",
    ]);
    // Seeking the decorative loop applies the authored ping-pong frame order.
    const hero = harness.characters()[0];
    for (const elapsed of [100, 200, 300]) {
      harness.surface.applyFrame(
        frameAt(
          harness.surface,
          [],
          { hero: sprite("pingpong") },
          elapsed,
          400,
        ),
        { phase: "playhead" },
      );
    }
    expect(appliedFrameUrls(hero)).toEqual([
      "/assets/pp/a.png",
      "/assets/pp/b.png",
      "/assets/pp/a.png",
      "/assets/pp/b.png",
    ]);
    expect(harness.loaded).toHaveLength(2);
    expect(harness.destroyed).toEqual([]);

    harness.surface.reset();
    // The last owner returned both references to zero, so the pixels are
    // destroyed instead of leaking a stray reference per repeated frame.
    expect(harness.destroyed.map((texture) => texture.url).sort()).toEqual([
      "/assets/pp/a.png",
      "/assets/pp/b.png",
    ]);
    harness.surface.dispose();
    expect(harness.destroyed).toHaveLength(2);
  });

  it("shares a repeated-frame animation across background and sprite aliases and releases to zero", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: "pingpong",
          sprites: { hero: sprite("pingpong") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    expect(harness.loaded.map((texture) => texture.url)).toEqual([
      "/assets/pp/a.png",
      "/assets/pp/b.png",
    ]);
    expect(harness.backgrounds()).toHaveLength(1);
    expect(harness.characters()).toHaveLength(1);

    // Dropping the background role keeps the frames alive for the sprite.
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("pingpong") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    expect(harness.destroyed).toEqual([]);

    harness.surface.reset();
    expect(harness.destroyed.map((texture) => texture.url).sort()).toEqual([
      "/assets/pp/a.png",
      "/assets/pp/b.png",
    ]);
    expect(harness.backgrounds()).toHaveLength(0);
    expect(harness.characters()).toHaveLength(0);
    harness.surface.dispose();
  });

  it("keeps frame order and nearest-frame fallback for repeated frames", async () => {
    const harness = await createSurface({}, new Set(["/assets/pp/b.png"]));
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("pingpong") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    expect(harness.loaded.map((texture) => texture.url)).toEqual([
      "/assets/pp/a.png",
    ]);
    // Every position of the broken url falls back to the nearest usable frame,
    // so the loop stays renderable and keep its declared animation geometry.
    const hero = harness.characters()[0];
    for (const elapsed of [100, 200, 300]) {
      harness.surface.applyFrame(
        frameAt(
          harness.surface,
          [],
          { hero: sprite("pingpong") },
          elapsed,
          400,
        ),
        { phase: "playhead" },
      );
    }
    expect(appliedFrameUrls(hero)).toEqual(["/assets/pp/a.png"]);
    expect(harness.surface.geometry.spriteSize("pingpong")).toEqual({
      width: 120,
      height: 60,
    });
    expect(harness.surface.loopIds).toEqual(["hero"]);
    harness.surface.reset();
    expect(harness.destroyed.map((texture) => texture.url)).toEqual([
      "/assets/pp/a.png",
    ]);
    harness.surface.dispose();
  });

  it("keeps a retried frame alive when the failed preparation's view is released", async () => {
    const failures = new Set(["/assets/pp/b.png"]);
    const harness = await createSurface({}, failures);
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("pingpong") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    // The failed frame is not referenced: the view renders its nearest usable
    // neighbour instead, and owns only the acquired url.
    expect(harness.loaded.map((texture) => texture.url)).toEqual([
      "/assets/pp/a.png",
    ]);

    // The retry succeeds and installs an instance that really owns frame b.
    failures.delete("/assets/pp/b.png");
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { understudy: sprite("pingpong") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    // Releasing the failed preparation's view must not release the retry's
    // frames.
    expect(harness.destroyed).toEqual([]);
    const understudy = harness.characters()[0];
    harness.surface.applyFrame(
      frameAt(
        harness.surface,
        [],
        { understudy: sprite("pingpong") },
        100,
        400,
      ),
      { phase: "playhead" },
    );
    expect(appliedFrameUrls(understudy)).toEqual([
      "/assets/pp/a.png",
      "/assets/pp/b.png",
    ]);

    // Zero references exactly when the true last owner goes away.
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: { background: null, sprites: {}, camera: CAMERA },
        assets: URLS,
      }),
    );
    expect(harness.destroyed.map((texture) => texture.url).sort()).toEqual([
      "/assets/pp/a.png",
      "/assets/pp/b.png",
    ]);
    expect(harness.characters()).toHaveLength(0);
    harness.surface.dispose();
  });

  it("discards a failed preparation without touching the alias view that retried its frames", async () => {
    const failures = new Set(["/assets/pp/b.png"]);
    const harness = await createSurface({}, failures);
    // The first preparation fails frame b and is superseded before it commits.
    const first = await harness.surface.prepare({
      world: {
        background: "pingpong",
        sprites: { hero: sprite("pingpong") },
        camera: CAMERA,
      },
      assets: URLS,
    });
    expect(first).not.toBeNull();
    failures.delete("/assets/pp/b.png");
    // The retry shares the asset between the background and a sprite alias.
    const second = await harness.surface.prepare({
      world: {
        background: "pingpong",
        sprites: { understudy: sprite("pingpong") },
        camera: CAMERA,
      },
      assets: URLS,
    });
    expect(harness.surface.applyWorld(second)).toBe(true);
    // Discarding the failed token must not drop the retry's references.
    if (first !== null) harness.surface.discardPreparation(first);
    expect(harness.destroyed).toEqual([]);
    expect(harness.backgrounds()).toHaveLength(1);
    expect(harness.characters()).toHaveLength(1);
    harness.surface.applyFrame(
      frameAt(
        harness.surface,
        [],
        { understudy: sprite("pingpong") },
        100,
        400,
      ),
      { phase: "playhead" },
    );
    expect(appliedFrameUrls(harness.characters()[0])).toEqual([
      "/assets/pp/a.png",
      "/assets/pp/b.png",
    ]);

    // Both roles release at reset, exactly once, and only now.
    harness.surface.reset();
    expect(harness.destroyed.map((texture) => texture.url).sort()).toEqual([
      "/assets/pp/a.png",
      "/assets/pp/b.png",
    ]);
    expect(harness.backgrounds()).toHaveLength(0);
    expect(harness.characters()).toHaveLength(0);
    expect(harness.surface.loopIds).toEqual([]);
    harness.surface.dispose();
  });
});

describe("SceneSurface image load timeout", () => {
  interface FakeImage {
    crossOrigin: string;
    decoding: string;
    onload: (() => void) | null;
    onerror: (() => void) | null;
    src: string;
  }

  it("never creates a texture for an image that decodes after its load timed out", async () => {
    vi.useFakeTimers();
    try {
      const images: FakeImage[] = [];
      const created: SceneTextureLike[] = [];
      class StubImage implements FakeImage {
        crossOrigin = "";
        decoding = "";
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        src = "";
        constructor() {
          images.push(this);
        }
      }
      vi.stubGlobal("Image", StubImage);
      const base = createMemoryKit();
      const kit: SceneKit = {
        ...base.kit,
        textureFromImage: (image) => {
          const texture: SceneTextureLike = {
            width: image.width,
            height: image.height,
            destroy: () => undefined,
          };
          created.push(texture);
          return texture;
        },
      };
      const diagnostics: string[] = [];
      const pump = createFramePump();
      const surface = new SceneSurface({
        canvas: document.createElement("canvas"),
        kit,
        animations: ANIMATIONS,
        requestFrame: pump.request,
        cancelFrame: pump.cancel,
        diagnostic: (message) => diagnostics.push(message),
      });
      await surface.init();
      const pending = surface.prepare({
        world: { background: "base", sprites: {}, camera: CAMERA },
        assets: URLS,
      });
      await flushMicrotasks();
      expect(images).toHaveLength(1);

      // Attach the rejection handler before the timer fires so the timeout
      // rejection is never reported as an unhandled promise.
      const rejection = expect(pending).rejects.toThrow("没有可用帧");
      await vi.advanceTimersByTimeAsync(8_001);
      await rejection;
      expect(diagnostics).toEqual([expect.stringContaining("图像加载超时")]);

      // The abandoned request now decodes: it must not create an unreferenced
      // Pixi texture, and its listener, timer and source are already gone.
      const image = images[0];
      image?.onload?.();
      expect(created).toHaveLength(0);
      expect(image?.onload).toBeNull();
      expect(image?.onerror).toBeNull();
      expect(image?.src).toBe("");
      surface.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SceneSurface frames", () => {
  it("applies a frame synchronously and reports it through readFrame", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("base", { z: 4 }) },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    const tracks: TimelineTrack[] = [
      {
        type: "sprite",
        sprite_id: "hero",
        asset: null,
        remove_at_end: false,
        channels: {
          x: [
            { at_ms: 0, value: 100, easing: "linear" },
            { at_ms: 1000, value: 500, easing: "linear" },
          ],
          z: [
            { at_ms: 0, value: 4, easing: "linear" },
            { at_ms: 1000, value: 9, easing: "linear" },
          ],
        },
      },
      {
        type: "camera",
        channels: {
          zoom: [
            { at_ms: 0, value: 1, easing: "linear" },
            { at_ms: 1000, value: 2, easing: "linear" },
          ],
        },
      },
    ];
    harness.surface.applyFrame(
      frameAt(harness.surface, tracks, { hero: sprite("base", { z: 4 }) }, 500),
      { phase: "playhead" },
    );
    const frame = harness.surface.readFrame();
    expect(frame.elapsed_ms).toBe(500);
    expect(frame.camera.zoom).toBeCloseTo(1.5);
    expect(frame.objects[0]?.x).toBeCloseTo(300);
    const node = harness.characters()[0];
    expect(node?.position.x).toBeCloseTo(300);
    expect(node?.zIndex).toBe(7);
    harness.surface.dispose();
  });

  it("composes anchor, flip and z onto the view", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: {
            hero: sprite("base", {
              flip_x: true,
              anchor_x: 0,
              anchor_y: 0,
              scale: 2,
              scale_x: 1.5,
              z: 3,
            }),
          },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    const node = harness.characters()[0];
    expect(node?.anchor.x).toBe(0);
    expect(node?.scale.x).toBe(-3);
    expect(node?.zIndex).toBe(3);
    harness.surface.dispose();
  });

  it("shares decoded textures between instances but not their phases", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("walk"), friend: sprite("walk", { x: 300 }) },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    // Four frames loaded once, shared by both instances.
    expect(
      harness.loaded.filter((texture) => texture.url.includes("walk/")),
    ).toHaveLength(4);
    const tracks: TimelineTrack[] = [
      {
        type: "sprite",
        sprite_id: "hero",
        asset: null,
        remove_at_end: false,
        channels: {},
      },
      {
        type: "sprite",
        sprite_id: "friend",
        asset: null,
        remove_at_end: false,
        channels: {},
      },
    ];
    const sprites = {
      hero: sprite("walk"),
      friend: sprite("walk", { x: 300 }),
    };
    harness.surface.applyFrame(frameAt(harness.surface, tracks, sprites, 250), {
      phase: "playhead",
    });
    const [hero, friend] = harness.characters();
    expect(hero?.texture).toBe(friend?.texture);
    harness.surface.dispose();
  });

  it("is deterministic for the same playhead and freezes while paused", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("walk") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    const node = harness.characters()[0];
    const tracks: TimelineTrack[] = [
      {
        type: "sprite",
        sprite_id: "hero",
        asset: null,
        remove_at_end: false,
        channels: {},
      },
    ];
    const sprites = { hero: sprite("walk") };
    const first = frameAt(harness.surface, tracks, sprites, 250);
    expect(frameAt(harness.surface, tracks, sprites, 250)).toEqual(first);

    // The playhead selects the same frame no matter how often it is applied.
    harness.surface.applyFrame(first, { phase: "playhead" });
    const scrubbed = (node?.texture as MemoryTexture | undefined)?.url;
    harness.surface.applyFrame(frameAt(harness.surface, tracks, sprites, 250), {
      phase: "playhead",
    });
    expect((node?.texture as MemoryTexture | undefined)?.url).toBe(scrubbed);
    expect(scrubbed).toBe("/assets/walk/c.png");

    harness.surface.setPaused(true);
    harness.run(400);
    expect((node?.texture as MemoryTexture | undefined)?.url).toBe(scrubbed);
    harness.surface.setPaused(false);
    harness.run(200);
    expect((node?.texture as MemoryTexture | undefined)?.url).not.toBe(
      scrubbed,
    );
    harness.surface.dispose();
  });

  it("suspends wall-clock decoration while a preview scrubs", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("walk") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    const node = harness.characters()[0];
    harness.surface.setDecorativeRunning(false);
    harness.run(500);
    expect(node?.textures).toHaveLength(1);
    harness.surface.dispose();
  });
});

describe("SceneSurface overrides and hit testing", () => {
  function heroFrame(
    overrides: Partial<SceneFrame["objects"][number]> = {},
  ): SceneFrame {
    return {
      elapsed_ms: 0,
      camera: CAMERA,
      bgm_volume: 1,
      objects: [
        {
          id: "hero",
          kind: "sprite",
          x: 100,
          y: 200,
          width: 64,
          height: 64,
          scale: 1,
          scale_x: 1,
          scale_y: 1,
          rotation_deg: 0,
          opacity: 1,
          z: 0,
          asset: "base",
          anchor_x: 0.5,
          anchor_y: 1,
          flip_x: false,
          ...overrides,
        },
      ],
    };
  }

  it("merges overrides and clears back to the evaluated state", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("base") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    harness.surface.applyFrame(heroFrame(), { phase: "playhead" });
    harness.surface.setObjectOverride("hero", { x: 400, scale: 2 });
    let frame = harness.surface.readFrame();
    expect(frame.objects[0]?.x).toBe(400);
    expect(frame.objects[0]?.width).toBe(128);

    harness.surface.setCameraOverride({ zoom: 2 });
    expect(harness.surface.readFrame().camera.zoom).toBe(2);
    harness.surface.clearOverrides();
    frame = harness.surface.readFrame();
    expect(frame.objects[0]?.x).toBe(100);
    expect(frame.objects[0]?.width).toBe(64);
    expect(frame.camera.zoom).toBe(1);
    harness.surface.dispose();
  });

  it("hits the topmost object under a design-space point", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("base") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    const frame = heroFrame();
    frame.objects.push({
      ...heroFrame().objects[0]!,
      id: "front",
      z: 10,
    });
    harness.surface.applyFrame(frame, { phase: "playhead" });
    expect(harness.surface.hitTest(100, 150)?.id).toBe("front");
    expect(harness.surface.hitTest(900, 100)).toBeNull();
    // The camera transform is inverted before the test, so a zoomed camera
    // hits the object at its projected stage position instead.
    harness.surface.setOverrides({ objects: new Map(), camera: { zoom: 2 } });
    const projected = worldPointToStage(
      { x: 100, y: 150 },
      {
        x: 0,
        y: 0,
        zoom: 2,
        rotation_deg: 0,
      },
    );
    expect(harness.surface.hitTest(projected.x, projected.y)?.id).toBe("front");
    expect(harness.surface.hitTest(100, 150)).toBeNull();
    harness.surface.dispose();
  });
});

describe("SceneSurface rendering and thumbnails", () => {
  it("renders at most once per browser frame", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("base") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    harness.run();
    const before = harness.kit.renderCount();
    harness.surface.setObjectOverride("hero", { x: 10 });
    harness.surface.setObjectOverride("hero", { x: 20 });
    harness.surface.setActiveEffects(null);
    harness.run();
    expect(harness.kit.renderCount() - before).toBe(1);
    harness.surface.dispose();
  });

  it("captures a 320x180 PNG thumbnail without preserveDrawingBuffer", async () => {
    const harness = await createSurface();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ drawImage: () => undefined } as never);
    const toDataURL = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/png;base64,AAA");
    expect(harness.surface.captureThumbnail()).toBe(
      "data:image/png;base64,AAA",
    );
    expect(toDataURL).toHaveBeenCalledWith("image/png", 0.86);
    getContext.mockRestore();
    toDataURL.mockRestore();
    harness.surface.dispose();
  });

  it("reports a failed thumbnail instead of throwing", async () => {
    const harness = await createSurface();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => {
        throw new Error("no canvas");
      });
    expect(harness.surface.captureThumbnail()).toBeNull();
    getContext.mockRestore();
    consoleError.mockRestore();
    harness.surface.dispose();
  });

  it("renders and disposes a scene without leaking textures", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: "other",
          sprites: { hero: sprite("base"), walker: sprite("walk") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    const loadedCount = harness.loaded.length;
    harness.surface.dispose();
    harness.surface.dispose();
    expect(harness.destroyed).toHaveLength(loadedCount);
    expect(harness.kit.applications).toHaveLength(1);
    expect(harness.kit.applications[0]?.destroyed).toBe(true);
  });

  it("keeps the application across reset but not across dispose", async () => {
    const harness = await createSurface();
    harness.surface.reset();
    harness.surface.reset();
    expect(harness.kit.applications).toHaveLength(1);
    expect(harness.kit.applications[0]?.destroyed).toBe(false);
    harness.surface.dispose();
    expect(harness.kit.applications[0]?.destroyed).toBe(true);
  });

  it("orders the camera layer above the background layer", async () => {
    const harness = await createSurface();
    const cameraLayer = harness.kit.applications[0]?.stage.children[0];
    expect(cameraLayer?.sortableChildren).toBe(true);
    expect(cameraLayer?.children[0]?.zIndex).toBe(-1_000_000);
    harness.surface.dispose();
  });
});

describe("SceneSurface effects", () => {
  it("combines the base camera and shake once and keeps both effects", async () => {
    const harness = await createSurface();
    harness.surface.applyFrame(
      {
        elapsed_ms: 100,
        camera: { x: 40, y: -20, zoom: 1.5, rotation_deg: 0 },
        objects: [],
        bgm_volume: 1,
      },
      { phase: "playhead" },
    );
    harness.surface.setActiveEffects({
      flash: {
        startMs: 0,
        durationMs: 400,
        effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 },
      },
      shake: {
        startMs: 0,
        durationMs: 400,
        effect: {
          type: "shake",
          amplitude_x: 16,
          amplitude_y: 9.6,
          frequency_hz: 18,
          decay: 1,
          seed: 0,
        },
      },
      elapsedMs: 100,
    });
    const cameraLayer = harness.kit.applications[0]?.stage.children[0];
    expect(cameraLayer?.pivot.x).toBe(DESIGN_WIDTH / 2 + 40);
    expect(cameraLayer?.pivot.y).toBe(DESIGN_HEIGHT / 2 - 20);
    expect(cameraLayer?.scale.x).toBe(1.5);
    // Shake is composed into the same transform instead of replacing it.
    expect(cameraLayer?.position.x).not.toBe(DESIGN_WIDTH / 2);
    const flash = harness.effects()[0] as MemoryGraphics | undefined;
    expect(flash).toBeInstanceOf(MemoryGraphics);
    expect(flash?.alpha).toBeGreaterThan(0);
    expect(flash?.alpha).toBeLessThanOrEqual(0.88);
    harness.surface.dispose();
  });

  it("does not write the destroyed camera when an aborted shake finishes", async () => {
    const harness = await createSurface();
    const controller = new AbortController();
    const cue = harness.surface.runCue(
      {
        cue_id: "7",
        gate: "runtime",
        type: "screen_effect",
        effect: {
          type: "shake",
          amplitude_x: 16,
          amplitude_y: 9.6,
          frequency_hz: 18,
          decay: 1,
          seed: 0,
        },
        duration_ms: 400,
      },
      { assets: URLS, signal: controller.signal, getRate: () => 1 },
    );
    harness.run(100);
    const cameraLayer = harness.kit.applications[0]?.stage.children[0];
    const shaken = {
      x: cameraLayer?.position.x ?? 0,
      y: cameraLayer?.position.y ?? 0,
    };
    expect(
      shaken.x !== DESIGN_WIDTH / 2 || shaken.y !== DESIGN_HEIGHT / 2,
    ).toBe(true);
    // The host unmounts while the cue is in flight: its `finally` resumes after
    // `dispose()` destroyed the layer, which throws on a real Pixi node.
    controller.abort();
    harness.surface.dispose();
    await cue;
    expect(cameraLayer?.position.x).toBe(shaken.x);
    expect(cameraLayer?.position.y).toBe(shaken.y);
  });

  it("clears the flash view when the effect ends", async () => {
    const harness = await createSurface();
    harness.surface.setActiveEffects({
      flash: {
        startMs: 0,
        durationMs: 100,
        effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 },
      },
      shake: null,
      elapsedMs: 50,
    });
    expect(harness.effects()).toHaveLength(1);
    harness.surface.setActiveEffects(null);
    expect(harness.effects()).toHaveLength(0);
    const cameraLayer = harness.kit.applications[0]?.stage.children[0];
    expect(cameraLayer?.position.x).toBe(DESIGN_WIDTH / 2);
    harness.surface.dispose();
  });
});

describe("SceneSurface shader effects", () => {
  const CHROMATIC = {
    type: "chromatic_aberration",
    intensity: 12,
    angle_deg: 0,
    center_x: 960,
    center_y: 540,
    edge_weight: 0.6,
    fade_in: 0,
    fade_out: 1,
  } as const;
  const SHOCKWAVE = {
    type: "shockwave",
    center_x: 400,
    center_y: 300,
    max_radius: 1100,
    wave_width: 140,
    strength: 28,
  } as const;
  const GLITCH = {
    type: "glitch",
    displacement: 48,
    slice_count: 16,
    density: 0.35,
    frequency_hz: 12,
    seed: 3,
    fade_in: 0,
    fade_out: 0,
  } as const;
  const COLOR_GRADE = {
    type: "color_grade",
    brightness: 0.2,
    contrast: 1.3,
    saturation: 1.4,
    tint: "#ff8000",
    tint_strength: 0.5,
    intensity: 1,
    fade_in: 0,
    fade_out: 0,
  } as const;
  const FOCUS = {
    type: "focus",
    center_x: 960,
    center_y: 540,
    radius: 280,
    softness: 160,
    blur: 8,
    darkness: 0.3,
    intensity: 1,
    fade_in: 0,
    fade_out: 0,
  } as const;
  const RIPPLE = {
    type: "ripple",
    center_x: 960,
    center_y: 540,
    amplitude: 12,
    wavelength: 160,
    speed: 240,
    damping: 1,
    intensity: 1,
    fade_in: 0,
    fade_out: 0,
  } as const;

  function shaderHost(harness: Harness): MemoryShaderHost {
    const host = harness.kit.shaderHosts[0];
    if (host === undefined) throw new Error("surface has no shader host");
    return host;
  }

  it("post-processes only the world layer over the whole stage", async () => {
    const harness = await createSurface();
    const host = shaderHost(harness);
    expect(host.target).toBe(harness.kit.applications[0]?.stage.children[0]);
    // An idle surface never installs a pass.
    expect(host.frames).toHaveLength(0);
    harness.surface.setActiveEffects({
      flash: null,
      shake: null,
      chromatic_aberration: { startMs: 0, durationMs: 400, effect: CHROMATIC },
      shockwave: { startMs: 0, durationMs: 700, effect: SHOCKWAVE },
      elapsedMs: 100,
    });
    expect(host.current?.chromaticAberration?.offsetX).toBeCloseTo(9);
    expect(host.current?.shockwave).toMatchObject({ centerX: 400 });
    expect(host.current?.glitch).toBeNull();
    const area = host.areas.at(-1);
    expect(area?.x).toBeLessThanOrEqual(0);
    expect(area?.y).toBeLessThanOrEqual(0);
    expect((area?.x ?? 0) + (area?.width ?? 0)).toBeGreaterThanOrEqual(
      DESIGN_WIDTH,
    );
    expect((area?.y ?? 0) + (area?.height ?? 0)).toBeGreaterThanOrEqual(
      DESIGN_HEIGHT,
    );
    // The flash layer is not post-processed.
    expect(harness.effects()).toHaveLength(0);
    harness.surface.dispose();
  });

  it("removes every pass exactly once when the windows end", async () => {
    const harness = await createSurface();
    const host = shaderHost(harness);
    const chromatic = { startMs: 0, durationMs: 400, effect: CHROMATIC };
    harness.surface.setActiveEffects({
      flash: null,
      shake: null,
      chromatic_aberration: chromatic,
      elapsedMs: 100,
    });
    harness.surface.setActiveEffects({
      flash: null,
      shake: null,
      chromatic_aberration: chromatic,
      elapsedMs: 400,
    });
    expect(host.current).toEqual({
      ripple: null,
      shockwave: null,
      glitch: null,
      colorGrade: null,
      focus: null,
      chromaticAberration: null,
    });
    const applied = host.frames.length;
    harness.surface.setActiveEffects(null);
    harness.surface.setCameraOverride({ zoom: 1.2 });
    expect(host.frames).toHaveLength(applied);
    harness.surface.dispose();
    expect(host.destroyed).toBe(true);
  });

  it("maps the stage into the zoomed camera layer", async () => {
    const harness = await createSurface();
    const host = shaderHost(harness);
    harness.surface.applyFrame(
      {
        elapsed_ms: 0,
        camera: { x: 100, y: 0, zoom: 2, rotation_deg: 0 },
        objects: [],
        bgm_volume: 1,
      },
      { phase: "playhead" },
    );
    harness.surface.setActiveEffects({
      flash: null,
      shake: null,
      shockwave: { startMs: 0, durationMs: 700, effect: SHOCKWAVE },
      elapsedMs: 0,
    });
    const area = host.areas.at(-1);
    // Half the stage around the camera centre, plus half a pixel of margin.
    expect(area?.width).toBeCloseTo(DESIGN_WIDTH / 2 + 1);
    expect(area?.x).toBeCloseTo(DESIGN_WIDTH / 4 + 100 - 0.5);
    harness.surface.dispose();
  });

  it("drives cue shader effects and lets the newest cue of a type own it", async () => {
    const harness = await createSurface();
    const host = shaderHost(harness);
    const context = {
      assets: URLS,
      signal: new AbortController().signal,
      getRate: () => 1,
    };
    const glitch = harness.surface.runCue(
      {
        cue_id: "g",
        gate: "runtime",
        type: "screen_effect",
        effect: GLITCH,
        duration_ms: 300,
      },
      context,
    );
    const first = harness.surface.runCue(
      {
        cue_id: "a",
        gate: "runtime",
        type: "screen_effect",
        effect: CHROMATIC,
        duration_ms: 400,
      },
      context,
    );
    harness.run(64);
    expect(host.current?.glitch?.offsets).toHaveLength(16);
    expect(host.current?.chromaticAberration).not.toBeNull();
    const second = harness.surface.runCue(
      {
        cue_id: "b",
        gate: "runtime",
        type: "screen_effect",
        effect: { ...CHROMATIC, intensity: 40, fade_out: 0 },
        duration_ms: 600,
      },
      context,
    );
    harness.run(32);
    expect(host.current?.chromaticAberration?.offsetX).toBeCloseTo(40);
    harness.run(400);
    await first;
    await glitch;
    // The older chromatic cue ended but did not clear the newer owner.
    expect(host.current?.chromaticAberration?.offsetX).toBeCloseTo(40);
    expect(host.current?.glitch).toBeNull();
    harness.run(300);
    await second;
    expect(host.current?.chromaticAberration).toBeNull();
    harness.surface.dispose();
  });

  it("releases cue shader effects on reset", async () => {
    const harness = await createSurface();
    const host = shaderHost(harness);
    const controller = new AbortController();
    const cue = harness.surface.runCue(
      {
        cue_id: "w",
        gate: "runtime",
        type: "screen_effect",
        effect: SHOCKWAVE,
        duration_ms: 700,
      },
      { assets: URLS, signal: controller.signal, getRate: () => 1 },
    );
    harness.run(48);
    expect(host.current?.shockwave).not.toBeNull();
    harness.surface.reset();
    expect(host.current?.shockwave).toBeNull();
    controller.abort();
    await cue;
    harness.surface.dispose();
  });

  it("attenuates flashes, shakes and shaders under reduced motion", async () => {
    const harness = await createSurface();
    const host = shaderHost(harness);
    const effects = {
      flash: {
        startMs: 0,
        durationMs: 400,
        effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 },
      },
      shake: null,
      chromatic_aberration: { startMs: 0, durationMs: 400, effect: CHROMATIC },
      elapsedMs: 0,
    } as const;
    harness.surface.setActiveEffects(effects);
    const flash = harness.effects()[0] as MemoryGraphics | undefined;
    expect(flash?.alpha).toBeCloseTo(0.88);
    expect(host.current?.chromaticAberration?.offsetX).toBeCloseTo(12);
    harness.surface.setReducedMotion(true);
    expect(harness.surface.reducedMotion).toBe(true);
    expect(
      (harness.effects()[0] as MemoryGraphics | undefined)?.alpha,
    ).toBeCloseTo(0.3);
    expect(host.current?.chromaticAberration?.offsetX).toBeCloseTo(6);
    harness.surface.dispose();
  });

  it("routes every new effect to the world layer, never to shake", async () => {
    const harness = await createSurface();
    const host = shaderHost(harness);
    const controller = new AbortController();
    const context = {
      assets: URLS,
      signal: controller.signal,
      getRate: () => 1,
    };
    const running = [COLOR_GRADE, FOCUS, RIPPLE].map((effect) =>
      harness.surface.runCue(
        {
          cue_id: effect.type,
          gate: "runtime",
          type: "screen_effect",
          effect,
          duration_ms: 400,
        },
        context,
      ),
    );
    harness.run(32);
    const frame = host.current;
    expect(frame?.colorGrade).not.toBeNull();
    expect(frame?.focus).not.toBeNull();
    expect(frame?.ripple).not.toBeNull();
    // The shake executor never ran: no flash node, a still camera layer.
    expect(harness.effects()).toHaveLength(0);
    expect(
      harness.kit.applications[0]?.stage.children[0]?.position,
    ).toMatchObject({ x: DESIGN_WIDTH / 2, y: DESIGN_HEIGHT / 2 });
    controller.abort();
    await Promise.all(running);
    harness.surface.dispose();
  });

  it("keeps a timeline window owning its channel at zero strength", async () => {
    const harness = await createSurface();
    const host = shaderHost(harness);
    const controller = new AbortController();
    const cued = { ...CHROMATIC, fade_out: 0 };
    const cue = harness.surface.runCue(
      {
        cue_id: "a",
        gate: "runtime",
        type: "screen_effect",
        effect: cued,
        duration_ms: 600,
      },
      { assets: URLS, signal: controller.signal, getRate: () => 1 },
    );
    harness.run(32);
    expect(host.current?.chromaticAberration?.offsetX).toBeCloseTo(12);
    // An active timeline window owns the channel for its whole interval, even
    // when the evaluated frame is null at zero intensity: the overlapping cue
    // must not show through at the boundary.
    harness.surface.setActiveEffects({
      flash: null,
      shake: null,
      chromatic_aberration: {
        startMs: 0,
        durationMs: 400,
        effect: { ...cued, intensity: 0 },
      },
      elapsedMs: 100,
    });
    expect(host.current?.chromaticAberration).toBeNull();
    // A fade-in boundary (progress 0, envelope 0) owns it just the same.
    harness.surface.setActiveEffects({
      flash: null,
      shake: null,
      chromatic_aberration: {
        startMs: 100,
        durationMs: 400,
        effect: { ...cued, intensity: 1, fade_in: 1 },
      },
      elapsedMs: 100,
    });
    expect(host.current?.chromaticAberration).toBeNull();
    // Only releasing the timeline lets the still-running cue fill it again.
    harness.surface.setActiveEffects(null);
    expect(host.current?.chromaticAberration?.offsetX).toBeCloseTo(12);
    controller.abort();
    await cue;
    harness.surface.dispose();
  });

  it("bypasses an identity or zero new-effect frame", async () => {
    const harness = await createSurface();
    const host = shaderHost(harness);
    harness.surface.setActiveEffects({
      flash: null,
      shake: null,
      color_grade: {
        startMs: 0,
        durationMs: 400,
        effect: {
          ...COLOR_GRADE,
          brightness: 0,
          contrast: 1,
          saturation: 1,
          tint_strength: 0,
        },
      },
      focus: {
        startMs: 0,
        durationMs: 400,
        effect: { ...FOCUS, blur: 0, darkness: 0 },
      },
      ripple: {
        startMs: 0,
        durationMs: 400,
        effect: { ...RIPPLE, amplitude: 0 },
      },
      elapsedMs: 100,
    });
    // Every channel bypassed, so the host installed no pass.
    expect(host.frames).toHaveLength(0);
    harness.surface.dispose();
  });

  it("keeps the grade but drops ripple and focus blur under reduced motion", async () => {
    const harness = await createSurface();
    const host = shaderHost(harness);
    harness.surface.setReducedMotion(true);
    harness.surface.setActiveEffects({
      flash: null,
      shake: null,
      color_grade: {
        startMs: 0,
        durationMs: 400,
        effect: COLOR_GRADE,
      },
      focus: { startMs: 0, durationMs: 400, effect: FOCUS },
      ripple: { startMs: 0, durationMs: 400, effect: RIPPLE },
      elapsedMs: 0,
    });
    const frame = host.current;
    expect(frame?.colorGrade).not.toBeNull();
    expect(frame?.ripple).toBeNull();
    expect(frame?.focus?.maxBlur).toBe(0);
    expect(frame?.focus?.darkness).toBeCloseTo(0.3);
    harness.surface.dispose();
  });

  it("maps the stage through a rotated camera for the new effects", async () => {
    const harness = await createSurface();
    const host = shaderHost(harness);
    harness.surface.applyFrame(
      {
        elapsed_ms: 0,
        camera: { x: 0, y: 0, zoom: 1, rotation_deg: 90 },
        objects: [],
        bgm_volume: 1,
      },
      { phase: "playhead" },
    );
    harness.surface.setActiveEffects({
      flash: null,
      shake: null,
      focus: { startMs: 0, durationMs: 700, effect: FOCUS },
      elapsedMs: 0,
    });
    const area = host.areas.at(-1);
    // A quarter turn swaps the stage bounding box, plus the one-pixel margin.
    expect(area?.width).toBeCloseTo(DESIGN_HEIGHT + 2);
    expect(area?.height).toBeCloseTo(DESIGN_WIDTH + 2);
    expect(host.current?.focus?.centerX).toBe(960);
    harness.surface.dispose();
  });
});

describe("SceneSurface cue executors", () => {
  it("finishes an instant show tween at the target pose", async () => {
    const harness = await createSurface();
    const signal = new AbortController();
    await harness.surface.runCue(
      {
        cue_id: "1",
        gate: "runtime",
        type: "sprite_tween",
        sprite_id: "hero",
        duration_ms: 0,
        easing: "linear",
        crossfade_ms: null,
        to: sprite("base", { x: 400, y: 700 }),
      },
      { assets: URLS, signal: signal.signal, getRate: () => 1 },
    );
    const node = harness.characters()[0];
    expect(node?.position.x).toBe(400);
    expect(node?.position.y).toBe(700);
    expect(node?.alpha).toBe(1);
    harness.surface.dispose();
  });

  it("starts a show tween from the entry offset", async () => {
    const harness = await createSurface();
    const signal = new AbortController();
    const pending = harness.surface.runCue(
      {
        cue_id: "2",
        gate: "runtime",
        type: "sprite_tween",
        sprite_id: "hero",
        duration_ms: 100,
        easing: "linear",
        crossfade_ms: null,
        to: sprite("base", { x: 0, y: 0 }),
      },
      { assets: URLS, signal: signal.signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    const node = harness.characters()[0];
    expect(node?.position.x).toBe(0);
    expect(node?.position.y).toBeCloseTo(48);
    expect(node?.scale.y).toBeCloseTo(0.96);
    harness.run(200);
    await pending;
    expect(node?.position.y).toBeCloseTo(0);
    expect(node?.scale.y).toBeCloseTo(1);
    harness.surface.dispose();
  });

  it("cross-fades to a replacement asset and releases the outgoing instance", async () => {
    const harness = await createSurface();
    const signal = new AbortController();
    await harness.surface.runCue(
      {
        cue_id: "3",
        gate: "runtime",
        type: "sprite_tween",
        sprite_id: "hero",
        duration_ms: 0,
        easing: "linear",
        crossfade_ms: null,
        to: sprite("base", { x: 100 }),
      },
      { assets: URLS, signal: signal.signal, getRate: () => 1 },
    );
    const pending = harness.surface.runCue(
      {
        cue_id: "4",
        gate: "runtime",
        type: "sprite_tween",
        sprite_id: "hero",
        duration_ms: 100,
        easing: "linear",
        crossfade_ms: 100,
        to: sprite("next", { x: 300 }),
      },
      { assets: URLS, signal: signal.signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    // Both the outgoing and the incoming instance exist during the fade.
    expect(harness.characters()).toHaveLength(2);
    harness.run(30);
    const outgoing = harness.characters()[0];
    expect(outgoing?.alpha).toBeLessThan(1);
    harness.run(300);
    await pending;
    expect(harness.characters()).toHaveLength(1);
    expect(harness.destroyed.map((texture) => texture.url)).toContain(
      BASE_TEXTURE,
    );
    harness.surface.dispose();
  });

  it("settles a cancelled entrance tween on the new instance", async () => {
    const harness = await createSurface();
    const signal = new AbortController();
    const pending = harness.surface.runCue(
      {
        cue_id: "5",
        gate: "runtime",
        type: "sprite_tween",
        sprite_id: "hero",
        duration_ms: 500,
        easing: "linear",
        crossfade_ms: null,
        to: sprite("base", { x: 0, y: 0 }),
      },
      { assets: URLS, signal: signal.signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    signal.abort();
    await pending;
    // The cancelled cue settles on the instance it already installed instead
    // of leaving an invisible node at the entry offset behind.
    expect(harness.characters()).toHaveLength(1);
    const node = harness.characters()[0];
    expect(node?.position.x).toBe(0);
    expect(node?.position.y).toBe(0);
    expect(node?.alpha).toBe(1);
    expect(assetsOf(harness)).toEqual({ hero: "base" });
    harness.surface.dispose();
    expect(harness.destroyed.map((texture) => texture.url)).toEqual([
      BASE_TEXTURE,
    ]);
  });

  it("cross-fades backgrounds and keeps the cover layout", async () => {
    const harness = await createSurface({
      [BASE_TEXTURE]: { width: 100, height: 50 },
    });
    const signal = new AbortController();
    await harness.surface.runCue(
      {
        cue_id: "6",
        gate: "runtime",
        type: "background_transition",
        background: "base",
        transition: { type: "cut" },
        duration_ms: 0,
        easing: "linear",
      },
      { assets: URLS, signal: signal.signal, getRate: () => 1 },
    );
    const node = harness.backgrounds()[0];
    expect(node?.scale.x).toBeCloseTo(21.6);
    expect(node?.position.x).toBeCloseTo((DESIGN_WIDTH - 100 * 21.6) / 2);
    harness.surface.dispose();
  });

  it("tweens the camera and restores the base camera after cue shake", async () => {
    const harness = await createSurface();
    const signal = new AbortController();
    await harness.surface.runCue(
      {
        cue_id: "7",
        gate: "runtime",
        type: "camera_tween",
        to: { x: 50, y: 0, zoom: 2, rotation_deg: 10 },
        duration_ms: 0,
        easing: "linear",
      },
      { assets: URLS, signal: signal.signal, getRate: () => 1 },
    );
    const layer = harness.kit.applications[0]?.stage.children[0];
    expect(layer?.scale.x).toBe(2);
    expect(layer?.pivot.x).toBe(DESIGN_WIDTH / 2 + 50);

    await harness.surface.runCue(
      {
        cue_id: "8",
        gate: "runtime",
        type: "screen_effect",
        effect: {
          type: "shake",
          amplitude_x: 16,
          amplitude_y: 9.6,
          frequency_hz: 18,
          decay: 1,
          seed: 0,
        },
        duration_ms: 0,
      },
      { assets: URLS, signal: signal.signal, getRate: () => 1 },
    );
    expect(layer?.position.x).toBe(DESIGN_WIDTH / 2);
    expect(layer?.scale.x).toBe(2);
    harness.surface.dispose();
  });

  it("fades a screen flash from the shipped peak", async () => {
    const harness = await createSurface();
    const signal = new AbortController();
    const pending = harness.surface.runCue(
      {
        cue_id: "9",
        gate: "runtime",
        type: "screen_effect",
        effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 },
        duration_ms: 100,
      },
      { assets: URLS, signal: signal.signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    const flash = harness.effects()[0] as MemoryGraphics | undefined;
    expect(flash?.alpha).toBeCloseTo(0.88);
    harness.run(30);
    expect(flash?.alpha).toBeLessThan(0.88);
    harness.run(300);
    await pending;
    expect(harness.effects()).toHaveLength(0);
    harness.surface.dispose();
  });

  it("clears background, characters and effects", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: "base",
          sprites: { hero: sprite("base") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    const signal = new AbortController();
    await harness.surface.runCue(
      {
        cue_id: "10",
        gate: "runtime",
        type: "clear_scene",
        duration_ms: 0,
        easing: "linear",
      },
      { assets: URLS, signal: signal.signal, getRate: () => 1 },
    );
    expect(harness.characters()).toHaveLength(0);
    expect(harness.backgrounds()).toHaveLength(0);
    harness.surface.dispose();
  });

  it("creates the character instances a timeline inherits", async () => {
    const harness = await createSurface();
    expect(
      await harness.surface.ensureCharacters(
        [{ id: "hero", asset: "base" }],
        URLS,
        () => true,
      ),
    ).toBe(true);
    const node = harness.characters()[0];
    expect(node?.position.y).toBe(1080);
    expect(assetsOf(harness)).toEqual({ hero: "base" });

    // A superseded request releases what it acquired and keeps the scene.
    expect(
      await harness.surface.ensureCharacters(
        [{ id: "other", asset: "next" }],
        URLS,
        () => false,
      ),
    ).toBe(false);
    expect(assetsOf(harness)).toEqual({ hero: "base" });
    harness.surface.dispose();
  });
});

describe("SceneSurface transition lifecycle", () => {
  function stageLayer(kit: MemoryKit, index: number): MemorySprite[] {
    return (kit.applications[0]?.stage.children[0]?.children[index]?.children ??
      []) as MemorySprite[];
  }

  /** A surface whose `url` decode only resolves when `release()` is called. */
  function surfaceWithDeferredAsset(url: string): {
    surface: SceneSurface;
    kit: MemoryKit;
    pump: FramePump;
    loader: ReturnType<typeof createMemoryTextureLoader>;
    release(): void;
  } {
    const kit = createMemoryKit();
    const loader = createMemoryTextureLoader();
    const pump = createFramePump();
    let start: (() => void) | null = null;
    const surface = new SceneSurface({
      canvas: document.createElement("canvas"),
      kit: kit.kit,
      animations: ANIMATIONS,
      textureLoader: (assetUrl) => {
        if (assetUrl !== url) return loader.load(assetUrl);
        return new Promise<SceneTextureLike>((resolve, reject) => {
          start = () => {
            void loader.load(assetUrl).then(resolve, reject);
          };
        });
      },
      requestFrame: pump.request,
      cancelFrame: pump.cancel,
    });
    return {
      surface,
      kit,
      pump,
      loader,
      release: () => {
        const startNow = start;
        start = null;
        startNow?.();
      },
    };
  }

  it("releases the outgoing expression when a cross-fade is cancelled", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("base") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    const signal = new AbortController();
    const pending = harness.surface.runCue(
      {
        cue_id: "cross-fade",
        gate: "runtime",
        type: "sprite_tween",
        sprite_id: "hero",
        duration_ms: 200,
        easing: "linear",
        crossfade_ms: 200,
        to: sprite("next", { x: 300 }),
      },
      { assets: URLS, signal: signal.signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    harness.run(32);
    // Both expressions are on screen while the fade runs.
    expect(harness.characters()).toHaveLength(2);

    signal.abort();
    await pending;
    // Cancelling settles on the incoming expression and releases the outgoing
    // instance together with its last texture reference.
    expect(harness.characters()).toHaveLength(1);
    expect(harness.characters()[0]?.label).toBe("/assets/next.png");
    expect(harness.characters()[0]?.alpha).toBe(1);
    expect(harness.destroyed.map((texture) => texture.url)).toEqual([
      BASE_TEXTURE,
    ]);
    expect(assetsOf(harness)).toEqual({ hero: "next" });

    // An immediate authoritative replacement on top of the cancelled cue must
    // not resurrect the released instance or leave it orphaned.
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("other") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    expect(harness.characters()).toHaveLength(1);
    expect(harness.characters()[0]?.label).toBe("/assets/other.png");

    harness.surface.reset();
    expect(harness.characters()).toHaveLength(0);
    expect(harness.surface.loopIds).toEqual([]);
    harness.surface.dispose();
    expect(harness.destroyed.map((texture) => texture.url).sort()).toEqual(
      [BASE_TEXTURE, "/assets/next.png", "/assets/other.png"].sort(),
    );
  });

  it("releases the outgoing background when a cross-fade is cancelled", async () => {
    const harness = await createSurface({
      [BASE_TEXTURE]: { width: 100, height: 50 },
    });
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: { background: "base", sprites: {}, camera: CAMERA },
        assets: URLS,
      }),
    );
    const signal = new AbortController();
    const pending = harness.surface.runCue(
      {
        cue_id: "cross-fade",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "cross_fade" },
        duration_ms: 200,
        easing: "linear",
      },
      { assets: URLS, signal: signal.signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    harness.run(32);
    expect(harness.backgrounds()).toHaveLength(2);

    signal.abort();
    await pending;
    // The cancelled fade settles on the incoming background and releases the
    // outgoing one instead of leaving a half-transparent page behind.
    expect(harness.backgrounds()).toHaveLength(1);
    expect(harness.backgrounds()[0]?.label).toBe("/assets/next.png");
    expect(harness.backgrounds()[0]?.alpha).toBe(1);
    expect(harness.destroyed.map((texture) => texture.url)).toEqual([
      BASE_TEXTURE,
    ]);
    expect(harness.surface.loopIds).toEqual(["__background__"]);

    harness.surface.reset();
    expect(harness.backgrounds()).toHaveLength(0);
    expect(harness.surface.loopIds).toEqual([]);
    harness.surface.dispose();
    expect(harness.destroyed.map((texture) => texture.url).sort()).toEqual([
      BASE_TEXTURE,
      "/assets/next.png",
    ]);
  });

  it("does not resurrect a cancelled background after an immediate replacement", async () => {
    const harness = await createSurface({
      [BASE_TEXTURE]: { width: 100, height: 50 },
    });
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: { background: "base", sprites: {}, camera: CAMERA },
        assets: URLS,
      }),
    );
    const signal = new AbortController();
    const pending = harness.surface.runCue(
      {
        cue_id: "cross-fade",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "cross_fade" },
        duration_ms: 200,
        easing: "linear",
      },
      { assets: URLS, signal: signal.signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    harness.run(20);
    signal.abort();
    await pending;
    expect(harness.backgrounds()).toHaveLength(1);
    expect(harness.destroyed.map((texture) => texture.url)).toEqual([
      BASE_TEXTURE,
    ]);

    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: { background: "other", sprites: {}, camera: CAMERA },
        assets: URLS,
      }),
    );
    expect(harness.backgrounds()).toHaveLength(1);
    expect(harness.backgrounds()[0]?.label).toBe("/assets/other.png");
    expect(harness.surface.loopIds).toEqual(["__background__"]);
    expect(harness.destroyed.map((texture) => texture.url).sort()).toEqual([
      BASE_TEXTURE,
      "/assets/next.png",
    ]);
    harness.surface.dispose();
  });

  it("keeps an asset that finishes decoding after reset out of the surface", async () => {
    const { surface, kit, loader, release } =
      surfaceWithDeferredAsset("/assets/next.png");
    await surface.init();
    const signal = new AbortController();
    const pending = surface.runCue(
      {
        cue_id: "late",
        gate: "runtime",
        type: "sprite_tween",
        sprite_id: "hero",
        duration_ms: 100,
        easing: "linear",
        crossfade_ms: null,
        to: sprite("next"),
      },
      { assets: URLS, signal: signal.signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    // The cue is parked on its decode; the reset alone must invalidate it.
    surface.reset();
    release();
    await pending;
    await flushMicrotasks();
    expect(stageLayer(kit, 1)).toHaveLength(0);
    expect(surface.loopIds).toEqual([]);
    expect(loader.destroyed.map((texture) => texture.url)).toEqual([
      "/assets/next.png",
    ]);
    surface.dispose();
  });

  it("destroys an asset that finishes decoding after dispose", async () => {
    const { surface, loader, release } =
      surfaceWithDeferredAsset("/assets/next.png");
    await surface.init();
    const signal = new AbortController();
    const pending = surface.runCue(
      {
        cue_id: "late",
        gate: "runtime",
        type: "sprite_tween",
        sprite_id: "hero",
        duration_ms: 100,
        easing: "linear",
        crossfade_ms: null,
        to: sprite("next"),
      },
      { assets: URLS, signal: signal.signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    surface.dispose();
    release();
    await pending;
    await flushMicrotasks();
    expect(loader.destroyed.map((texture) => texture.url)).toEqual([
      "/assets/next.png",
    ]);
  });

  it("returns nodes, references, loops and frames to baseline after 30 cancelled cross-fades", async () => {
    const harness = await createSurface({
      [BASE_TEXTURE]: { width: 100, height: 50 },
      "/assets/next.png": { width: 100, height: 50 },
      "/assets/other.png": { width: 100, height: 50 },
    });
    const captured: MemorySprite[] = [];
    for (let cycle = 0; cycle < 30; cycle += 1) {
      harness.surface.applyWorld(
        await harness.surface.prepare({
          world: {
            background: "other",
            sprites: { hero: sprite("base") },
            camera: CAMERA,
          },
          assets: URLS,
        }),
      );
      const characterSignal = new AbortController();
      const backgroundSignal = new AbortController();
      const character = harness.surface.runCue(
        {
          cue_id: `character-${cycle}`,
          gate: "runtime",
          type: "sprite_tween",
          sprite_id: "hero",
          duration_ms: 200,
          easing: "linear",
          crossfade_ms: 200,
          to: sprite("next", { x: 300 }),
        },
        { assets: URLS, signal: characterSignal.signal, getRate: () => 1 },
      );
      const background = harness.surface.runCue(
        {
          cue_id: `background-${cycle}`,
          gate: "runtime",
          type: "background_transition",
          background: "next",
          transition: { type: "cross_fade" },
          duration_ms: 200,
          easing: "linear",
        },
        { assets: URLS, signal: backgroundSignal.signal, getRate: () => 1 },
      );
      await flushMicrotasks();
      harness.run(32);
      // Each cross-fade owns two instances while it runs.
      expect(harness.characters()).toHaveLength(2);
      expect(harness.backgrounds()).toHaveLength(2);
      captured.push(...harness.characters(), ...harness.backgrounds());

      characterSignal.abort();
      backgroundSignal.abort();
      await character;
      await background;
      // Cancelling settles each transition on its incoming instance.
      expect(harness.characters()).toHaveLength(1);
      expect(harness.backgrounds()).toHaveLength(1);

      harness.surface.reset();
      expect(harness.characters()).toHaveLength(0);
      expect(harness.backgrounds()).toHaveLength(0);
      expect(harness.surface.loopIds).toEqual([]);
      expect(harness.pump.pending()).toBe(1);
    }
    // Every node the surface created was captured exactly once and destroyed
    // exactly once: no orphan survived a reset and nothing was released twice.
    expect(new Set(captured).size).toBe(captured.length);
    for (const node of captured) expect(node.destroyCount).toBe(1);
    // Every decoded texture was released exactly once by its last owner.
    expect(harness.destroyed).toHaveLength(harness.loaded.length);
    expect(new Set(harness.destroyed).size).toBe(harness.destroyed.length);
    const urls = (textures: MemoryTexture[]): string[] =>
      textures.map((texture) => texture.url).sort();
    expect(urls(harness.destroyed)).toEqual(urls(harness.loaded));
    harness.surface.dispose();
    expect(harness.pump.pending()).toBe(0);
  });

  it("releases a flash cue that is still running when the surface resets", async () => {
    const harness = await createSurface();
    const signal = new AbortController();
    const pending = harness.surface.runCue(
      {
        cue_id: "flash",
        gate: "runtime",
        type: "screen_effect",
        effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 },
        duration_ms: 400,
      },
      { assets: URLS, signal: signal.signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    harness.run(32);
    const flash = harness.effects()[0] as MemoryGraphics | undefined;
    expect(flash).toBeInstanceOf(MemoryGraphics);

    harness.surface.reset();
    await pending;
    // The reset owns the node now: the late cue must not destroy it twice.
    expect(harness.effects()).toHaveLength(0);
    expect(flash?.destroyCount).toBe(1);
    expect(harness.pump.pending()).toBe(1);
    harness.surface.dispose();
    expect(harness.pump.pending()).toBe(0);
  });

  it("keeps the newest same-sprite cue settled when an older replacement decodes late", async () => {
    const { surface, kit, pump, loader, release } =
      surfaceWithDeferredAsset("/assets/next.png");
    await surface.init();
    surface.applyWorld(
      await surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("base") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    // The older replacement is parked on its decode...
    const older = new AbortController();
    const pendingOlder = surface.runCue(
      {
        cue_id: "older-replacement",
        gate: "runtime",
        type: "sprite_tween",
        sprite_id: "hero",
        duration_ms: 400,
        easing: "linear",
        crossfade_ms: 0,
        to: sprite("next", { x: 200 }),
      },
      { assets: URLS, signal: older.signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    // ...and a newer tween of the same instance starts before it commits.  The
    // newer cue owns the live view and must settle it visibly.
    const newer = new AbortController();
    const pendingNewer = surface.runCue(
      {
        cue_id: "newer-tween",
        gate: "runtime",
        type: "sprite_tween",
        sprite_id: "hero",
        duration_ms: 400,
        easing: "linear",
        crossfade_ms: 0,
        to: sprite("base", { x: 700 }),
      },
      { assets: URLS, signal: newer.signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    pump.step(16);
    pump.step(500);
    await pendingNewer;
    const live = stageLayer(kit, 1);
    expect(live).toHaveLength(1);
    expect(live[0]?.label).toBe(BASE_TEXTURE);
    expect(live[0]?.alpha).toBe(1);
    expect(live[0]?.x).toBeCloseTo(700);

    // The parked replacement now finishes decoding.  It is neither committed
    // nor able to strand or hide the settled view; its pixels are released.
    release();
    await pendingOlder;
    await flushMicrotasks();
    const after = stageLayer(kit, 1);
    expect(after).toHaveLength(1);
    expect(after[0]).toBe(live[0]);
    expect(after[0]?.alpha).toBe(1);
    expect(after[0]?.destroyed).toBe(false);
    expect(loader.destroyed.map((texture) => texture.url)).toEqual([
      "/assets/next.png",
    ]);
    surface.dispose();
  });

  it("lets the newer background transition own the surface", async () => {
    const harness = await createSurface({
      [BASE_TEXTURE]: { width: 100, height: 50 },
    });
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: { background: "base", sprites: {}, camera: CAMERA },
        assets: URLS,
      }),
    );
    const first = new AbortController();
    const pendingFirst = harness.surface.runCue(
      {
        cue_id: "first",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "cross_fade" },
        duration_ms: 400,
        easing: "linear",
      },
      { assets: URLS, signal: first.signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    harness.run(32);
    const second = new AbortController();
    const pendingSecond = harness.surface.runCue(
      {
        cue_id: "second",
        gate: "runtime",
        type: "background_transition",
        background: "other",
        transition: { type: "cross_fade" },
        duration_ms: 400,
        easing: "linear",
      },
      { assets: URLS, signal: second.signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    harness.run(500);
    await pendingFirst;
    await pendingSecond;
    const live = harness.backgrounds();
    expect(live).toHaveLength(1);
    expect(live[0]?.label).toBe("/assets/other.png");
    expect(live[0]?.destroyed).toBe(false);
    expect(live[0]?.alpha).toBe(1);
    expect(harness.destroyed.map((texture) => texture.url).sort()).toEqual([
      BASE_TEXTURE,
      "/assets/next.png",
    ]);
    expect(harness.surface.loopIds).toEqual(["__background__"]);
    harness.surface.dispose();
  });

  it("does not let a slow older background overwrite a faster newer one", async () => {
    const { surface, kit, loader, pump, release } =
      surfaceWithDeferredAsset("/assets/next.png");
    await surface.init();
    const older = new AbortController();
    const pendingOlder = surface.runCue(
      {
        cue_id: "older",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "cross_fade" },
        duration_ms: 400,
        easing: "linear",
      },
      { assets: URLS, signal: older.signal, getRate: () => 1 },
    );
    await flushMicrotasks();

    // The newer request decodes immediately and owns the surface.
    const newer = new AbortController();
    const pendingNewer = surface.runCue(
      {
        cue_id: "newer",
        gate: "runtime",
        type: "background_transition",
        background: "other",
        transition: { type: "cross_fade" },
        duration_ms: 400,
        easing: "linear",
      },
      { assets: URLS, signal: newer.signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    pump.step(16);
    pump.step(500);
    await pendingNewer;
    expect(stageLayer(kit, 0).map((view) => view.label)).toEqual([
      "/assets/other.png",
    ]);

    // The older decode now finishes.  Start order, not completion order,
    // decides the winner: the newer picture stays on screen.
    release();
    await flushMicrotasks();
    expect(stageLayer(kit, 0).map((view) => view.label)).toEqual([
      "/assets/other.png",
    ]);
    await pendingOlder;
    await flushMicrotasks();
    expect(stageLayer(kit, 0).map((view) => view.label)).toEqual([
      "/assets/other.png",
    ]);
    expect(stageLayer(kit, 0)[0]?.destroyed).toBe(false);
    // The superseded request released exactly the pixels it acquired.
    expect(loader.destroyed.map((texture) => texture.url)).toEqual([
      "/assets/next.png",
    ]);
    surface.dispose();
  });

  it("lets a newer clear invalidate a background that is still decoding", async () => {
    const { surface, kit, loader, release } =
      surfaceWithDeferredAsset("/assets/next.png");
    await surface.init();
    const older = new AbortController();
    const pendingOlder = surface.runCue(
      {
        cue_id: "older",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "cross_fade" },
        duration_ms: 400,
        easing: "linear",
      },
      { assets: URLS, signal: older.signal, getRate: () => 1 },
    );
    await flushMicrotasks();

    await surface.runCue(
      {
        cue_id: "clear",
        gate: "runtime",
        type: "background_transition",
        background: null,
        transition: { type: "cut" },
        duration_ms: 0,
        easing: "linear",
      },
      {
        assets: URLS,
        signal: new AbortController().signal,
        getRate: () => 1,
      },
    );
    release();
    await flushMicrotasks();
    // A clear started later must not be undone by the slower decode.
    expect(stageLayer(kit, 0)).toHaveLength(0);
    await pendingOlder;
    await flushMicrotasks();
    expect(stageLayer(kit, 0)).toHaveLength(0);
    expect(loader.destroyed.map((texture) => texture.url)).toEqual([
      "/assets/next.png",
    ]);
    surface.dispose();
  });

  it("lets a newer same-asset no-op invalidate a background that is still decoding", async () => {
    const { surface, kit, loader, release } =
      surfaceWithDeferredAsset("/assets/next.png");
    await surface.init();
    surface.applyWorld(
      await surface.prepare({
        world: { background: "base", sprites: {}, camera: CAMERA },
        assets: URLS,
      }),
    );
    const older = new AbortController();
    const pendingOlder = surface.runCue(
      {
        cue_id: "older",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "cross_fade" },
        duration_ms: 400,
        easing: "linear",
      },
      { assets: URLS, signal: older.signal, getRate: () => 1 },
    );
    await flushMicrotasks();

    // The newer request asks for the pixels already on screen: a no-op that
    // still owns the start order.
    await surface.runCue(
      {
        cue_id: "same-asset",
        gate: "runtime",
        type: "background_transition",
        background: "base",
        transition: { type: "cross_fade" },
        duration_ms: 200,
        easing: "linear",
      },
      {
        assets: URLS,
        signal: new AbortController().signal,
        getRate: () => 1,
      },
    );
    release();
    await flushMicrotasks();
    expect(stageLayer(kit, 0).map((view) => view.label)).toEqual([
      BASE_TEXTURE,
    ]);
    await pendingOlder;
    await flushMicrotasks();
    expect(stageLayer(kit, 0).map((view) => view.label)).toEqual([
      BASE_TEXTURE,
    ]);
    expect(loader.destroyed.map((texture) => texture.url)).toEqual([
      "/assets/next.png",
    ]);
    surface.dispose();
  });

  it("keeps a live cross-fade settling when a newer same-asset request supersedes it", async () => {
    const harness = await createSurface({
      [BASE_TEXTURE]: { width: 100, height: 50 },
      "/assets/next.png": { width: 100, height: 50 },
    });
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: { background: "base", sprites: {}, camera: CAMERA },
        assets: URLS,
      }),
    );
    const first = new AbortController();
    const pendingFirst = harness.surface.runCue(
      {
        cue_id: "first",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "cross_fade" },
        duration_ms: 400,
        easing: "linear",
      },
      { assets: URLS, signal: first.signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    harness.run(32);
    const entering = harness
      .backgrounds()
      .find((view) => view.label === "/assets/next.png");
    expect(entering?.alpha).toBeLessThan(1);

    // A newer request for the pixels the fade is entering must not strand the
    // live fade at a half-transparent alpha: it is a no-op that leaves the
    // committed writer alone.
    await harness.surface.runCue(
      {
        cue_id: "same-asset",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "cross_fade" },
        duration_ms: 200,
        easing: "linear",
      },
      {
        assets: URLS,
        signal: new AbortController().signal,
        getRate: () => 1,
      },
    );
    harness.run(500);
    await pendingFirst;
    const live = harness.backgrounds();
    expect(live).toHaveLength(1);
    expect(live[0]?.label).toBe("/assets/next.png");
    expect(live[0]?.alpha).toBe(1);
    expect(harness.destroyed.map((texture) => texture.url)).toEqual([
      BASE_TEXTURE,
    ]);
    harness.surface.dispose();
  });

  it("lets the newer tween own an instance and releases the superseded view", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: null,
          sprites: { hero: sprite("base") },
          camera: CAMERA,
        },
        assets: URLS,
      }),
    );
    const first = new AbortController();
    const pendingFirst = harness.surface.runCue(
      {
        cue_id: "first",
        gate: "runtime",
        type: "sprite_tween",
        sprite_id: "hero",
        duration_ms: 400,
        easing: "linear",
        crossfade_ms: 0,
        to: sprite("next", { x: 200 }),
      },
      { assets: URLS, signal: first.signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    harness.run(32);
    const second = new AbortController();
    const pendingSecond = harness.surface.runCue(
      {
        cue_id: "second",
        gate: "runtime",
        type: "sprite_tween",
        sprite_id: "hero",
        duration_ms: 400,
        easing: "linear",
        crossfade_ms: 0,
        to: sprite("other", { x: 400 }),
      },
      { assets: URLS, signal: second.signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    harness.run(500);
    await pendingFirst;
    await pendingSecond;
    const live = harness.characters();
    expect(live).toHaveLength(1);
    expect(live[0]?.label).toBe("/assets/other.png");
    expect(live[0]?.destroyed).toBe(false);
    expect(harness.destroyed.map((texture) => texture.url).sort()).toEqual([
      BASE_TEXTURE,
      "/assets/next.png",
    ]);
    harness.surface.dispose();
  });
});
