// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Texture } from "pixi.js";

import { SceneSurface } from "./sceneSurface";
import {
  ANIMATIONS,
  BASE_TEXTURE,
  CAMERA,
  URLS,
  createSurface,
  flushMicrotasks,
  frameAt,
  sprite,
  urlsOf,
} from "./sceneSurfaceHarness";
import {
  createFramePump,
  createMemoryKit,
  type MemorySprite,
  type MemoryTexture,
} from "./sceneTestKit";
import type { SceneKit } from "./sceneKit";
import type { SceneTextureLike } from "./sceneTextures";
import { TextBlockRasterizer } from "./textBlock";
import { TEXT_FIXTURE } from "./visualTestKit";
import { spritePreset } from "./visual";

const WALK_URLS = (ANIMATIONS.walk?.frames ?? []).map((frame) => frame.url);
const PP_A = "/assets/pp/a.png";
const PP_B = "/assets/pp/b.png";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Urls the instance actually displayed, in the order it displayed them. */
function displayedUrls(node: MemorySprite | undefined): string[] {
  return (node?.textures ?? []).map(
    (texture) => (texture as MemoryTexture).url,
  );
}

describe("SceneSurface texture sharing", () => {
  it.each([
    ["a still", "base", [BASE_TEXTURE]],
    ["a four-frame animation", "walk", WALK_URLS],
    ["a repeated-frame (ping-pong) animation", "pingpong", [PP_A, PP_B]],
  ])(
    "decodes %s once for a background and a sprite and releases it with the last owner",
    async (_name, asset, urls) => {
      const h = await createSurface();
      await h.commit({ background: asset, sprites: { hero: sprite(asset) } });
      // One decode serves both roles, each with its own loop phase.
      expect(urlsOf(h.loaded)).toEqual(urls);
      expect(h.backgrounds()).toHaveLength(1);
      expect(h.characters()).toHaveLength(1);
      expect(h.backgrounds()[0]?.anchor).toMatchObject({ x: 0.5, y: 0.5 });
      expect(h.characters()[0]?.anchor).toMatchObject({ x: 0.5, y: 1 });
      expect(h.surface.loopIds).toHaveLength(2);
      expect(h.destroyed).toEqual([]);

      // Releasing one role keeps every frame alive for the other.
      await h.commit({ sprites: { hero: sprite(asset) } });
      expect(h.backgrounds()).toHaveLength(0);
      expect(h.characters()).toHaveLength(1);
      expect(h.destroyed).toEqual([]);

      // The last owner releases each distinct url exactly once.
      h.surface.reset();
      expect(urlsOf(h.destroyed, true)).toEqual([...urls].sort());
      expect(h.backgrounds()).toHaveLength(0);
      expect(h.characters()).toHaveLength(0);
      h.surface.dispose();
      expect(h.destroyed).toHaveLength(urls.length);
    },
  );

  it("retains a loop phase for the same asset and restarts on a new one", async () => {
    const h = await createSurface();
    const walk = { sprites: { hero: sprite("walk") } };
    await h.commit(walk);
    const hero = () => h.characters()[0];
    expect(hero()?.textures).toHaveLength(1);
    h.run(150);
    const advanced = hero()?.textures.length ?? 0;
    expect(advanced).toBeGreaterThan(1);

    await h.commit(walk);
    expect(hero()?.textures).toHaveLength(advanced);

    await h.commit({ sprites: { hero: sprite("base") } });
    expect(hero()?.textures).toHaveLength(1);
    expect(h.surface.geometry.spriteSize("walk")).toEqual({
      width: 100,
      height: 50,
    });
    h.surface.dispose();
  });

  it("replaces a view when the animation behind an asset is revised", async () => {
    const h = await createSurface();
    const walk = { sprites: { hero: sprite("walk") } };
    await h.commit(walk);
    h.run(150);
    expect(h.characters()[0]?.textures.length ?? 0).toBeGreaterThan(1);

    // The same logical asset id now resolves to an edited animation: the view
    // must restart at the new revision's first frame instead of keeping the
    // old decoded frames and phase.
    h.surface.setAnimations({
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
    await h.commit(walk);
    const hero = h.characters()[0];
    expect(hero?.textures).toHaveLength(1);
    expect(hero?.textures[0]).toBe(
      h.loaded.find((texture) => texture.url === "/assets/walk/a2.png"),
    );
    h.surface.dispose();
  });
});

describe("SceneSurface broken frames", () => {
  it("decodes a repeated-frame animation once per distinct url and keeps the authored frame order", async () => {
    const h = await createSurface();
    await h.commit({ sprites: { hero: sprite("pingpong") } });
    expect(urlsOf(h.loaded)).toEqual([PP_A, PP_B]);
    const hero = h.characters()[0];
    for (const elapsed of [100, 200, 300]) {
      h.surface.applyFrame(
        frameAt(h, { hero: sprite("pingpong") }, elapsed, [], 400),
        { phase: "playhead" },
      );
    }
    expect(displayedUrls(hero)).toEqual([PP_A, PP_B, PP_A, PP_B]);
    expect(h.destroyed).toEqual([]);
  });

  it("reports a broken frame and substitutes the nearest usable one, keeping the animation geometry", async () => {
    const h = await createSurface({ failures: new Set([PP_B]) });
    await h.commit({ sprites: { hero: sprite("pingpong") } });
    // The failed url is not referenced: the view renders its nearest usable
    // neighbour instead, at every position that used it.
    expect(urlsOf(h.loaded)).toEqual([PP_A]);
    expect(h.messages).toEqual([
      expect.stringContaining("第 2 帧"),
      expect.stringContaining("第 4 帧"),
    ]);
    const hero = h.characters()[0];
    for (const elapsed of [100, 200, 300]) {
      h.surface.applyFrame(
        frameAt(h, { hero: sprite("pingpong") }, elapsed, [], 400),
        { phase: "playhead" },
      );
    }
    expect(displayedUrls(hero)).toEqual([PP_A]);
    expect(h.surface.geometry.spriteSize("pingpong")).toEqual({
      width: 120,
      height: 60,
    });
    h.surface.reset();
    expect(urlsOf(h.destroyed)).toEqual([PP_A]);
    h.surface.dispose();
  });

  it("keeps a retried frame alive when the failed preparation's view is released", async () => {
    const failures = new Set([PP_B]);
    const h = await createSurface({ failures });
    await h.commit({ sprites: { hero: sprite("pingpong") } });
    expect(urlsOf(h.loaded)).toEqual([PP_A]);

    // The retry succeeds and installs an instance that really owns frame b.
    failures.delete(PP_B);
    await h.commit({ sprites: { understudy: sprite("pingpong") } });
    // Releasing the failed preparation's view must not release the retry's frames.
    expect(h.destroyed).toEqual([]);
    h.surface.applyFrame(
      frameAt(h, { understudy: sprite("pingpong") }, 100, [], 400),
      { phase: "playhead" },
    );
    expect(displayedUrls(h.characters()[0])).toEqual([PP_A, PP_B]);

    // Zero references exactly when the true last owner goes away.
    await h.commit();
    expect(urlsOf(h.destroyed, true)).toEqual([PP_A, PP_B]);
    expect(h.characters()).toHaveLength(0);
    h.surface.dispose();
  });

  it("discards a failed preparation without touching the alias view that retried its frames", async () => {
    const failures = new Set([PP_B]);
    const h = await createSurface({ failures });
    // The first preparation fails frame b and is superseded before it commits.
    const first = await h.prepare({
      background: "pingpong",
      sprites: { hero: sprite("pingpong") },
    });
    expect(first).not.toBeNull();
    failures.delete(PP_B);
    // The retry shares the asset between the background and a sprite alias.
    const second = await h.prepare({
      background: "pingpong",
      sprites: { understudy: sprite("pingpong") },
    });
    expect(h.surface.applyWorld(second)).toBe(true);
    if (first !== null) h.surface.discardPreparation(first);
    expect(h.destroyed).toEqual([]);
    expect(h.backgrounds()).toHaveLength(1);
    expect(h.characters()).toHaveLength(1);
    h.surface.applyFrame(
      frameAt(h, { understudy: sprite("pingpong") }, 100, [], 400),
      { phase: "playhead" },
    );
    expect(displayedUrls(h.characters()[0])).toEqual([PP_A, PP_B]);

    h.surface.reset();
    expect(urlsOf(h.destroyed, true)).toEqual([PP_A, PP_B]);
    expect(h.surface.loopIds).toEqual([]);
    h.surface.dispose();
  });

  it.each([
    [
      "an animation with no usable frame",
      { sprites: { hero: sprite("walk") } },
      new Set(WALK_URLS),
      "没有可用帧",
    ],
    [
      "an unresolved asset",
      { sprites: { hero: sprite("missing") } },
      new Set<string>(),
      "素材尚未解析: missing",
    ],
  ])("fails preparing %s", async (_name, world, failures, message) => {
    const h = await createSurface({ failures });
    await expect(h.prepare(world)).rejects.toThrow(message);
    h.surface.dispose();
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

describe("SceneSurface pooled text textures", () => {
  it("rasterizes a shared version once, reuses it for transforms and returns every version exactly once", async () => {
    vi.spyOn(TextBlockRasterizer.prototype, "html").mockResolvedValue(
      "<div>safe static text</div>",
    );
    const kit = createMemoryKit();
    const create = kit.kit.application;
    const textures: Texture[] = [];
    const returned: Promise<Texture>[] = [];
    const createTexture = vi.fn(() => {
      const texture = {
        width: 400,
        height: 100,
        destroy: vi.fn(),
      } as unknown as Texture;
      textures.push(texture);
      return Promise.resolve(texture);
    });
    kit.kit.application = () => {
      const app = create();
      Object.assign(app.renderer, {
        htmlText: {
          getTexturePromise: createTexture,
          returnTexturePromise: (promise: Promise<Texture>) =>
            returned.push(promise),
        },
      });
      return app;
    };
    const surface = new SceneSurface({
      canvas: document.createElement("canvas"),
      kit: kit.kit,
      textBlocks: { label: { definition: TEXT_FIXTURE, font_version: "1" } },
    });
    await surface.init();
    const state = spritePreset("text", { type: "text", text_block: "label" });
    surface.applyWorld(
      await surface.prepare({
        world: {
          camera: CAMERA,
          sprites: { first: state, second: { ...state, x: 300 } },
        },
        assets: {},
      }),
    );
    expect(createTexture).toHaveBeenCalledTimes(1);
    surface.applyWorld(
      await surface.prepare({
        world: {
          camera: CAMERA,
          sprites: { first: { ...state, scale: 2, rotation_deg: 10 } },
        },
        assets: {},
      }),
    );
    expect(createTexture).toHaveBeenCalledTimes(1);
    expect(returned).toHaveLength(0);
    surface.setVisualResources(
      { label: { definition: TEXT_FIXTURE, font_version: "2" } },
      {},
    );
    surface.applyWorld(
      await surface.prepare({
        world: { camera: CAMERA, sprites: { first: state } },
        assets: {},
      }),
    );
    expect(createTexture).toHaveBeenCalledTimes(2);
    expect(returned).toHaveLength(1);
    surface.reset();
    surface.dispose();
    expect(returned).toHaveLength(2);
    expect(new Set(returned).size).toBe(2);
    expect(
      textures.every(
        (texture) =>
          !(texture.destroy as ReturnType<typeof vi.fn>).mock.calls.length,
      ),
    ).toBe(true);
  });
});
