// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { DESIGN_WIDTH, worldPointToStage, type SceneFrame } from "./sceneFrame";
import { SceneSurface } from "./sceneSurface";
import {
  ANIMATIONS,
  BASE_TEXTURE,
  CAMERA,
  NEXT_TEXTURE,
  OTHER_TEXTURE,
  SHAKE,
  URLS,
  WIDE_SIZES,
  createSurface,
  cues,
  flushMicrotasks,
  frameAt,
  shownAssets,
  sprite,
  urlsOf,
} from "./sceneSurfaceHarness";
import {
  createFramePump,
  createMemoryKit,
  createMemoryTextureLoader,
  MemorySprite,
  type MemoryTexture,
} from "./sceneTestKit";
import type { SceneTextureLike } from "./sceneTextures";
import type { TimelineTrack } from "./types";
import { LEGACY_BACKGROUND_ID } from "./visual";

const heroWorld = (asset = "base") => ({ sprites: { hero: sprite(asset) } });

describe("SceneSurface world preparation", () => {
  it("never commits a stale preparation and keeps the old visuals", async () => {
    const h = await createSurface();
    await h.commit(heroWorld("base"));
    expect(shownAssets(h)).toEqual({ hero: "base" });

    const pending = h.prepare(heroWorld("next"));
    // Old visuals stay on screen while the replacement still decodes.
    expect(shownAssets(h)).toEqual({ hero: "base" });
    const second = await pending;
    const third = await h.prepare(heroWorld("other"));
    expect(second?.stale).toBe(true);
    expect(h.surface.applyWorld(second)).toBe(false);
    // The superseded request released the pixels it had acquired.
    expect(urlsOf(h.destroyed)).toEqual([NEXT_TEXTURE]);
    expect(shownAssets(h)).toEqual({ hero: "base" });
    expect(h.surface.applyWorld(third)).toBe(true);
    expect(shownAssets(h)).toEqual({ hero: "other" });
    h.surface.dispose();
  });

  it("releases a discarded preparation", async () => {
    const h = await createSurface();
    const preparation = await h.prepare(heroWorld());
    if (preparation !== null) h.surface.discardPreparation(preparation);
    expect(urlsOf(h.destroyed)).toEqual([BASE_TEXTURE]);
    expect(shownAssets(h)).toEqual({});
    h.surface.dispose();
  });

  it("releases a pending preparation on reset", async () => {
    const h = await createSurface();
    const preparation = await h.prepare(heroWorld());
    h.surface.reset();
    expect(preparation?.stale).toBe(true);
    expect(h.surface.applyWorld(preparation)).toBe(false);
    expect(urlsOf(h.destroyed)).toEqual([BASE_TEXTURE]);
    h.surface.dispose();
  });

  it("shares one decoded texture between instances and refcounts it", async () => {
    const h = await createSurface();
    await h.commit({
      sprites: { hero: sprite("base"), friend: sprite("base", { x: 500 }) },
    });
    expect(h.loaded).toHaveLength(1);
    expect(h.characters()).toHaveLength(2);

    await h.commit({ sprites: { friend: sprite("base", { x: 500 }) } });
    // One instance left, so the shared texture is still alive for it.
    expect(h.characters()).toHaveLength(1);
    expect(h.destroyed).toEqual([]);
    expect(h.surface.readFrame().objects).toEqual([]);
    await h.commit();
    expect(urlsOf(h.destroyed)).toEqual([BASE_TEXTURE]);
    h.surface.dispose();
  });
});

describe("SceneSurface frames", () => {
  it("applies a frame synchronously and reports it through readFrame", async () => {
    const h = await createSurface();
    await h.commit({ sprites: { hero: sprite("base", { z: 4 }) } });
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
    h.surface.applyFrame(
      frameAt(h, { hero: sprite("base", { z: 4 }) }, 500, tracks),
      { phase: "playhead" },
    );
    const frame = h.surface.readFrame();
    expect(frame.elapsed_ms).toBe(500);
    expect(frame.camera.zoom).toBeCloseTo(1.5);
    expect(frame.objects[0]?.x).toBeCloseTo(300);
    const node = h.characters()[0];
    expect(node?.position.x).toBeCloseTo(300);
    expect(node?.zIndex).toBe(7);
    h.surface.dispose();
  });

  it("composes anchor, flip and z onto the view", async () => {
    const h = await createSurface();
    await h.commit({
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
    });
    const node = h.characters()[0];
    expect(node?.anchor.x).toBe(0);
    expect(node?.scale.x).toBe(-3);
    expect(node?.zIndex).toBe(3);
    h.surface.dispose();
  });

  it("is deterministic for the same playhead and freezes while paused", async () => {
    const h = await createSurface();
    await h.commit(heroWorld("walk"));
    const node = h.characters()[0];
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
    const first = frameAt(h, sprites, 250, tracks);
    expect(frameAt(h, sprites, 250, tracks)).toEqual(first);

    // The playhead selects the same frame no matter how often it is applied.
    const shown = () => (node?.texture as MemoryTexture | undefined)?.url;
    h.surface.applyFrame(first, { phase: "playhead" });
    const scrubbed = shown();
    h.surface.applyFrame(frameAt(h, sprites, 250, tracks), {
      phase: "playhead",
    });
    expect(shown()).toBe(scrubbed);
    expect(scrubbed).toBe("/assets/walk/c.png");

    h.surface.setPaused(true);
    h.run(400);
    expect(shown()).toBe(scrubbed);
    h.surface.setPaused(false);
    h.run(200);
    expect(shown()).not.toBe(scrubbed);
    h.surface.dispose();
  });

  it("suspends wall-clock decoration while a preview scrubs", async () => {
    const h = await createSurface();
    await h.commit(heroWorld("walk"));
    h.surface.setDecorativeRunning(false);
    h.run(500);
    expect(h.characters()[0]?.textures).toHaveLength(1);
    h.surface.dispose();
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
    const h = await createSurface();
    await h.commit(heroWorld());
    h.surface.applyFrame(heroFrame(), { phase: "playhead" });
    h.surface.setObjectOverride("hero", { x: 400, scale: 2 });
    let frame = h.surface.readFrame();
    expect(frame.objects[0]?.x).toBe(400);
    expect(frame.objects[0]?.width).toBe(128);

    h.surface.setCameraOverride({ zoom: 2 });
    expect(h.surface.readFrame().camera.zoom).toBe(2);
    h.surface.clearOverrides();
    frame = h.surface.readFrame();
    expect(frame.objects[0]?.x).toBe(100);
    expect(frame.objects[0]?.width).toBe(64);
    expect(frame.camera.zoom).toBe(1);
    h.surface.dispose();
  });

  it("hits the topmost object under a design-space point", async () => {
    const h = await createSurface();
    await h.commit(heroWorld());
    const frame = heroFrame();
    frame.objects.push({ ...heroFrame().objects[0]!, id: "front", z: 10 });
    h.surface.applyFrame(frame, { phase: "playhead" });
    expect(h.surface.hitTest(100, 150)?.id).toBe("front");
    expect(h.surface.hitTest(900, 100)).toBeNull();
    // The camera transform is inverted before the test, so a zoomed camera
    // hits the object at its projected stage position instead.
    h.surface.setOverrides({ objects: new Map(), camera: { zoom: 2 } });
    const projected = worldPointToStage(
      { x: 100, y: 150 },
      { x: 0, y: 0, zoom: 2, rotation_deg: 0 },
    );
    expect(h.surface.hitTest(projected.x, projected.y)?.id).toBe("front");
    expect(h.surface.hitTest(100, 150)).toBeNull();
    h.surface.dispose();
  });
});

describe("SceneSurface rendering and lifecycle", () => {
  it("stacks world, transition overlay, curtain and effects", async () => {
    const h = await createSurface();
    const stage = h.kit.applications[0]?.stage;
    expect(stage?.sortableChildren).toBe(true);
    // camera(0) < fade-through overlay(5) < curtain(10) < effects(20) <
    // host-only session curtain(30); the screen layer sorts at 1.
    expect((stage?.children ?? []).map((child) => child.zIndex)).toEqual([
      0, 20, 5, 10, 30, 1,
    ]);
    h.surface.dispose();
  });

  it("renders at most once per browser frame", async () => {
    const h = await createSurface();
    await h.commit(heroWorld());
    h.run();
    const before = h.kit.renderCount();
    h.surface.setObjectOverride("hero", { x: 10 });
    h.surface.setObjectOverride("hero", { x: 20 });
    h.surface.setActiveEffects(null);
    h.run();
    expect(h.kit.renderCount() - before).toBe(1);
    h.surface.dispose();
  });

  it("captures a 320x180 PNG thumbnail without preserveDrawingBuffer", async () => {
    const h = await createSurface();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ drawImage: () => undefined } as never);
    const toDataURL = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/png;base64,AAA");
    expect(h.surface.captureThumbnail()).toBe("data:image/png;base64,AAA");
    expect(toDataURL).toHaveBeenCalledWith("image/png", 0.86);
    getContext.mockRestore();
    toDataURL.mockRestore();
    h.surface.dispose();
  });

  it("reports a failed thumbnail instead of throwing", async () => {
    const h = await createSurface();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => {
        throw new Error("no canvas");
      });
    expect(h.surface.captureThumbnail()).toBeNull();
    getContext.mockRestore();
    consoleError.mockRestore();
    h.surface.dispose();
  });

  it("keeps the application across reset, and disposes without leaking textures", async () => {
    const h = await createSurface();
    await h.commit({
      background: "other",
      sprites: { hero: sprite("base"), walker: sprite("walk") },
    });
    h.surface.reset();
    h.surface.reset();
    expect(h.kit.applications).toHaveLength(1);
    expect(h.kit.applications[0]?.destroyed).toBe(false);

    await h.commit({
      background: "other",
      sprites: { hero: sprite("base"), walker: sprite("walk") },
    });
    const loadedCount = h.loaded.length;
    h.surface.dispose();
    h.surface.dispose();
    expect(h.destroyed).toHaveLength(loadedCount);
    expect(h.kit.applications[0]?.destroyed).toBe(true);
  });

  it("interleaves backgrounds and other Sprites by object z in one world layer", async () => {
    const h = await createSurface();
    await h.commit({
      background: "base",
      sprites: { hero: sprite("next", { z: -20000 }) },
    });
    const cameraLayer = h.cameraLayer();
    expect(cameraLayer.sortableChildren).toBe(true);
    expect(h.backgrounds()[0]?.parent).toBe(cameraLayer);
    expect(h.characters()[0]?.parent).toBe(cameraLayer);
    expect(h.backgrounds()[0]?.zIndex).toBe(-10000);
    expect(h.characters()[0]?.zIndex).toBe(-20000);
    expect(Object.keys(h.surface.captureBases().sprites).sort()).toEqual([
      LEGACY_BACKGROUND_ID,
      "hero",
    ]);
    h.surface.dispose();
  });
});

describe("SceneSurface cue executors", () => {
  it("finishes an instant show tween at the target pose", async () => {
    const h = await createSurface();
    await h.cue(cues.tween("hero", sprite("base", { x: 400, y: 700 })));
    const node = h.characters()[0];
    expect(node?.position.x).toBe(400);
    expect(node?.position.y).toBe(700);
    expect(node?.alpha).toBe(1);
    h.surface.dispose();
  });

  it("starts a show tween from the entry offset", async () => {
    const h = await createSurface();
    const pending = h.cue(
      cues.tween("hero", sprite("base", { x: 0, y: 0 }), 100),
    );
    await flushMicrotasks();
    const node = h.characters()[0];
    expect(node?.position.x).toBe(0);
    expect(node?.position.y).toBeCloseTo(48);
    expect(node?.scale.y).toBeCloseTo(0.96);
    h.run(200);
    await pending;
    expect(node?.position.y).toBeCloseTo(0);
    expect(node?.scale.y).toBeCloseTo(1);
    h.surface.dispose();
  });

  it("cross-fades to a replacement asset and releases the outgoing instance", async () => {
    const h = await createSurface();
    await h.cue(cues.tween("hero", sprite("base", { x: 100 })));
    const pending = h.cue(
      cues.tween("hero", sprite("next", { x: 300 }), 100, {
        crossfade_ms: 100,
      }),
    );
    await flushMicrotasks();
    // Both the outgoing and the incoming instance exist during the fade.
    expect(h.characters()).toHaveLength(2);
    h.run(30);
    expect(h.characters()[0]?.alpha).toBeLessThan(1);
    h.run(300);
    await pending;
    expect(h.characters()).toHaveLength(1);
    expect(urlsOf(h.destroyed)).toContain(BASE_TEXTURE);
    h.surface.dispose();
  });

  it("settles a cancelled entrance tween on the new instance", async () => {
    const h = await createSurface();
    const abort = new AbortController();
    const pending = h.cue(
      cues.tween("hero", sprite("base", { x: 0, y: 0 }), 500),
      abort.signal,
    );
    await flushMicrotasks();
    abort.abort();
    await pending;
    // The cancelled cue settles on the instance it already installed instead
    // of leaving an invisible node at the entry offset behind.
    expect(h.characters()).toHaveLength(1);
    const node = h.characters()[0];
    expect(node?.position.x).toBe(0);
    expect(node?.position.y).toBe(0);
    expect(node?.alpha).toBe(1);
    expect(shownAssets(h)).toEqual({ hero: "base" });
    h.surface.dispose();
    expect(urlsOf(h.destroyed)).toEqual([BASE_TEXTURE]);
  });

  it("lays out a background with the cover fit", async () => {
    const h = await createSurface({ sizes: WIDE_SIZES });
    await h.cue(cues.background("base", { type: "cut" }, 0));
    const node = h.backgrounds()[0];
    expect(node?.scale.x).toBeCloseTo(21.6);
    expect(node?.position.x).toBeCloseTo(DESIGN_WIDTH / 2);
    expect(node?.anchor.x).toBe(0.5);
    expect(node?.mask?.label).toBe(`layout:${LEGACY_BACKGROUND_ID}`);
    h.surface.dispose();
  });

  it("tweens the camera and restores the base camera after a cue shake", async () => {
    const h = await createSurface();
    await h.cue({
      cue_id: "camera",
      gate: "runtime",
      type: "camera_tween",
      from: CAMERA,
      to: { x: 50, y: 0, zoom: 2, rotation_deg: 10 },
      duration_ms: 0,
      easing: "linear",
    });
    const layer = h.cameraLayer();
    expect(layer.scale.x).toBe(2);
    expect(layer.pivot.x).toBe(DESIGN_WIDTH / 2 + 50);

    await h.cue(cues.effect(SHAKE, 0));
    expect(layer.position.x).toBe(DESIGN_WIDTH / 2);
    expect(layer.scale.x).toBe(2);
    h.surface.dispose();
  });

  it("clears background, characters and effects", async () => {
    const h = await createSurface();
    await h.commit({ background: "base", ...heroWorld() });
    await h.cue({
      cue_id: "clear",
      gate: "runtime",
      type: "clear_scene",
      duration_ms: 0,
      easing: "linear",
    });
    expect(h.characters()).toHaveLength(0);
    expect(h.backgrounds()).toHaveLength(0);
    h.surface.dispose();
  });

  it("creates the character instances a timeline inherits", async () => {
    const h = await createSurface();
    expect(
      await h.surface.ensureCharacters(
        [{ id: "hero", asset: "base" }],
        URLS,
        () => true,
      ),
    ).toBe(true);
    expect(h.characters()[0]?.position.y).toBe(1080);
    expect(shownAssets(h)).toEqual({ hero: "base" });

    // A superseded request releases what it acquired and keeps the scene.
    expect(
      await h.surface.ensureCharacters(
        [{ id: "other", asset: "next" }],
        URLS,
        () => false,
      ),
    ).toBe(false);
    expect(shownAssets(h)).toEqual({ hero: "base" });
    h.surface.dispose();
  });
});

/** A surface whose `url` decode only resolves when `release()` is called. */
function surfaceWithDeferredAsset(url: string) {
  const kit = createMemoryKit();
  const loader = createMemoryTextureLoader(WIDE_SIZES);
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
  const sprites = (): MemorySprite[] =>
    (kit.applications[0]?.stage.children[0]?.children ?? []).filter(
      (node): node is MemorySprite => node instanceof MemorySprite,
    );
  return {
    surface,
    pump,
    loader,
    backgrounds: () => sprites().filter((node) => node.zIndex === -10000),
    characters: () => sprites().filter((node) => node.zIndex !== -10000),
    release: () => {
      const startNow = start;
      start = null;
      startNow?.();
    },
  };
}

describe("SceneSurface cue races", () => {
  it("releases the outgoing expression when a cross-fade is cancelled", async () => {
    const h = await createSurface();
    await h.commit(heroWorld());
    const abort = new AbortController();
    const pending = h.cue(
      cues.tween("hero", sprite("next", { x: 300 }), 200, {
        crossfade_ms: 200,
      }),
      abort.signal,
    );
    await flushMicrotasks();
    h.run(32);
    // Both expressions are on screen while the fade runs.
    expect(h.characters()).toHaveLength(2);

    abort.abort();
    await pending;
    // Cancelling settles on the incoming expression and releases the outgoing
    // instance together with its last texture reference.
    expect(h.characters()).toHaveLength(1);
    expect(h.characters()[0]?.label).toBe(NEXT_TEXTURE);
    expect(h.characters()[0]?.alpha).toBe(1);
    expect(urlsOf(h.destroyed)).toEqual([BASE_TEXTURE]);
    expect(shownAssets(h)).toEqual({ hero: "next" });

    // An immediate authoritative replacement must not resurrect the released
    // instance or leave it orphaned.
    await h.commit(heroWorld("other"));
    expect(h.characters()).toHaveLength(1);
    expect(h.characters()[0]?.label).toBe(OTHER_TEXTURE);

    h.surface.reset();
    expect(h.characters()).toHaveLength(0);
    expect(h.surface.loopIds).toEqual([]);
    h.surface.dispose();
    expect(urlsOf(h.destroyed, true)).toEqual([
      BASE_TEXTURE,
      NEXT_TEXTURE,
      OTHER_TEXTURE,
    ]);
  });

  it("releases the outgoing background when a cross-fade is cancelled, and stays released after a replacement", async () => {
    const h = await createSurface({ sizes: WIDE_SIZES });
    await h.commit({ background: "base" });
    const abort = new AbortController();
    const pending = h.cue(cues.background("next"), abort.signal);
    await flushMicrotasks();
    h.run(32);
    expect(h.backgrounds()).toHaveLength(2);

    abort.abort();
    await pending;
    // The cancelled fade settles on the incoming background and releases the
    // outgoing one instead of leaving a half-transparent page behind.
    expect(h.backgrounds()).toHaveLength(1);
    expect(h.backgrounds()[0]?.label).toBe(NEXT_TEXTURE);
    expect(h.backgrounds()[0]?.alpha).toBe(1);
    expect(urlsOf(h.destroyed)).toEqual([BASE_TEXTURE]);
    expect(h.surface.loopIds).toEqual([LEGACY_BACKGROUND_ID]);

    // An immediate replacement must not resurrect the cancelled background.
    await h.commit({ background: "other" });
    expect(h.backgrounds()).toHaveLength(1);
    expect(h.backgrounds()[0]?.label).toBe(OTHER_TEXTURE);
    expect(h.surface.loopIds).toEqual([LEGACY_BACKGROUND_ID]);
    expect(urlsOf(h.destroyed, true)).toEqual([BASE_TEXTURE, NEXT_TEXTURE]);

    h.surface.reset();
    expect(h.backgrounds()).toHaveLength(0);
    expect(h.surface.loopIds).toEqual([]);
    h.surface.dispose();
    expect(urlsOf(h.destroyed, true)).toEqual([
      BASE_TEXTURE,
      NEXT_TEXTURE,
      OTHER_TEXTURE,
    ]);
  });

  it.each([
    [
      "reset",
      (h: ReturnType<typeof surfaceWithDeferredAsset>) => {
        h.surface.reset();
      },
    ],
    [
      "dispose",
      (h: ReturnType<typeof surfaceWithDeferredAsset>) => {
        h.surface.dispose();
      },
    ],
  ])(
    "keeps an asset that finishes decoding after %s out of the surface",
    async (_name, end) => {
      const h = surfaceWithDeferredAsset(NEXT_TEXTURE);
      await h.surface.init();
      const pending = h.surface.runCue(
        cues.tween("hero", sprite("next"), 100),
        {
          assets: URLS,
          signal: new AbortController().signal,
          getRate: () => 1,
        },
      );
      await flushMicrotasks();
      // The cue is parked on its decode; the session boundary alone must invalidate it.
      end(h);
      h.release();
      await pending;
      await flushMicrotasks();
      expect(h.characters()).toHaveLength(0);
      expect(h.surface.loopIds).toEqual([]);
      expect(urlsOf(h.loader.destroyed)).toEqual([NEXT_TEXTURE]);
      h.surface.dispose();
    },
  );

  it("returns nodes, references, loops and frames to baseline after 30 cancelled cross-fades", async () => {
    const h = await createSurface({ sizes: WIDE_SIZES });
    const captured: MemorySprite[] = [];
    for (let cycle = 0; cycle < 30; cycle += 1) {
      await h.commit({ background: "other", ...heroWorld() });
      const characterAbort = new AbortController();
      const backgroundAbort = new AbortController();
      const character = h.cue(
        cues.tween("hero", sprite("next", { x: 300 }), 200, {
          crossfade_ms: 200,
        }),
        characterAbort.signal,
      );
      const background = h.cue(cues.background("next"), backgroundAbort.signal);
      await flushMicrotasks();
      h.run(32);
      // Each cross-fade owns two instances while it runs.
      expect(h.characters()).toHaveLength(2);
      expect(h.backgrounds()).toHaveLength(2);
      captured.push(...h.characters(), ...h.backgrounds());

      characterAbort.abort();
      backgroundAbort.abort();
      await character;
      await background;
      // Cancelling settles each transition on its incoming instance.
      expect(h.characters()).toHaveLength(1);
      expect(h.backgrounds()).toHaveLength(1);

      h.surface.reset();
      expect(h.characters()).toHaveLength(0);
      expect(h.backgrounds()).toHaveLength(0);
      expect(h.surface.loopIds).toEqual([]);
      expect(h.pump.pending()).toBe(1);
    }
    // Every node the surface created was captured exactly once and destroyed
    // exactly once: no orphan survived a reset and nothing was released twice.
    expect(new Set(captured).size).toBe(captured.length);
    for (const node of captured) expect(node.destroyCount).toBe(1);
    // Every decoded texture was released exactly once by its last owner.
    expect(h.destroyed).toHaveLength(h.loaded.length);
    expect(new Set(h.destroyed).size).toBe(h.destroyed.length);
    expect(urlsOf(h.destroyed, true)).toEqual(urlsOf(h.loaded, true));
    h.surface.dispose();
    expect(h.pump.pending()).toBe(0);
  });

  it("keeps the newest same-sprite cue settled when an older replacement decodes late", async () => {
    const h = surfaceWithDeferredAsset(NEXT_TEXTURE);
    await h.surface.init();
    const run = (cue: ReturnType<typeof cues.tween>) =>
      h.surface.runCue(cue, {
        assets: URLS,
        signal: new AbortController().signal,
        getRate: () => 1,
      });
    h.surface.applyWorld(
      await h.surface.prepare({
        world: { background: null, ...heroWorld(), camera: CAMERA },
        assets: URLS,
      }),
    );
    // The older replacement is parked on its decode...
    const pendingOlder = run(
      cues.tween("hero", sprite("next", { x: 200 }), 400, { crossfade_ms: 0 }),
    );
    await flushMicrotasks();
    // ...and a newer tween of the same instance starts before it commits.  The
    // newer cue owns the live view and must settle it visibly.
    const pendingNewer = run(
      cues.tween("hero", sprite("base", { x: 700 }), 400, { crossfade_ms: 0 }),
    );
    await flushMicrotasks();
    h.pump.step(16);
    h.pump.step(500);
    await pendingNewer;
    const live = h.characters();
    expect(live).toHaveLength(1);
    expect(live[0]?.label).toBe(BASE_TEXTURE);
    expect(live[0]?.alpha).toBe(1);
    expect(live[0]?.x).toBeCloseTo(700);

    // The parked replacement now finishes decoding.  It is neither committed
    // nor able to strand or hide the settled view; its pixels are released.
    h.release();
    await pendingOlder;
    await flushMicrotasks();
    const after = h.characters();
    expect(after).toHaveLength(1);
    expect(after[0]).toBe(live[0]);
    expect(after[0]?.alpha).toBe(1);
    expect(after[0]?.destroyed).toBe(false);
    expect(urlsOf(h.loader.destroyed)).toEqual([NEXT_TEXTURE]);
    h.surface.dispose();
  });

  it("lets the newer tween own an instance and releases the superseded view", async () => {
    const h = await createSurface();
    await h.commit(heroWorld());
    const pendingFirst = h.cue(
      cues.tween("hero", sprite("next", { x: 200 }), 400, { crossfade_ms: 0 }),
    );
    await flushMicrotasks();
    h.run(32);
    const pendingSecond = h.cue(
      cues.tween("hero", sprite("other", { x: 400 }), 400, { crossfade_ms: 0 }),
    );
    await flushMicrotasks();
    h.run(500);
    await pendingFirst;
    await pendingSecond;
    const live = h.characters();
    expect(live).toHaveLength(1);
    expect(live[0]?.label).toBe(OTHER_TEXTURE);
    expect(live[0]?.destroyed).toBe(false);
    expect(urlsOf(h.destroyed, true)).toEqual([BASE_TEXTURE, NEXT_TEXTURE]);
    h.surface.dispose();
  });

  it("lets the newer background transition own the surface", async () => {
    const h = await createSurface({ sizes: WIDE_SIZES });
    await h.commit({ background: "base" });
    const first = h.cue(cues.background("next", { type: "cross_fade" }, 400));
    await flushMicrotasks();
    h.run(32);
    const second = h.cue(cues.background("other", { type: "cross_fade" }, 400));
    await flushMicrotasks();
    h.run(500);
    await first;
    await second;
    const live = h.backgrounds();
    expect(live).toHaveLength(1);
    expect(live[0]?.label).toBe(OTHER_TEXTURE);
    expect(live[0]?.destroyed).toBe(false);
    expect(live[0]?.alpha).toBe(1);
    expect(urlsOf(h.destroyed, true)).toEqual([BASE_TEXTURE, NEXT_TEXTURE]);
    expect(h.surface.loopIds).toEqual([LEGACY_BACKGROUND_ID]);
    h.surface.dispose();
  });

  it("does not let a slow older background overwrite a faster newer one", async () => {
    const h = surfaceWithDeferredAsset(NEXT_TEXTURE);
    await h.surface.init();
    const run = (cue: ReturnType<typeof cues.background>) =>
      h.surface.runCue(cue, {
        assets: URLS,
        signal: new AbortController().signal,
        getRate: () => 1,
      });
    const labels = () => h.backgrounds().map((view) => view.label);
    const pendingOlder = run(
      cues.background("next", { type: "cross_fade" }, 400),
    );
    await flushMicrotasks();

    // The newer request decodes immediately and owns the surface.
    const pendingNewer = run(
      cues.background("other", { type: "cross_fade" }, 400),
    );
    await flushMicrotasks();
    h.pump.step(16);
    h.pump.step(500);
    await pendingNewer;
    expect(labels()).toEqual([OTHER_TEXTURE]);

    // The older decode now finishes.  Start order, not completion order,
    // decides the winner: the newer picture stays on screen.
    h.release();
    await flushMicrotasks();
    expect(labels()).toEqual([OTHER_TEXTURE]);
    await pendingOlder;
    await flushMicrotasks();
    expect(labels()).toEqual([OTHER_TEXTURE]);
    expect(h.backgrounds()[0]?.destroyed).toBe(false);
    // The superseded request released exactly the pixels it acquired.
    expect(urlsOf(h.loader.destroyed)).toEqual([NEXT_TEXTURE]);
    h.surface.dispose();
  });

  it.each([
    ["a clear", null, cues.background(null, { type: "cut" }, 0), []],
    [
      "a same-asset no-op",
      "base",
      cues.background("base", { type: "cross_fade" }, 200),
      [BASE_TEXTURE],
    ],
  ])(
    "lets %s started later invalidate a background that is still decoding",
    async (_name, initial, newer, expected) => {
      const h = surfaceWithDeferredAsset(NEXT_TEXTURE);
      await h.surface.init();
      const context = {
        assets: URLS,
        signal: new AbortController().signal,
        getRate: () => 1,
      };
      h.surface.applyWorld(
        await h.surface.prepare({
          world: { background: initial, sprites: {}, camera: CAMERA },
          assets: URLS,
        }),
      );
      const older = h.surface.runCue(
        cues.background("next", { type: "cross_fade" }, 400),
        context,
      );
      await flushMicrotasks();
      // The newer request still owns the start order even though it changes nothing.
      await h.surface.runCue(newer, context);
      h.release();
      await flushMicrotasks();
      const labels = () => h.backgrounds().map((view) => view.label);
      expect(labels()).toEqual(expected);
      await older;
      await flushMicrotasks();
      expect(labels()).toEqual(expected);
      expect(urlsOf(h.loader.destroyed)).toEqual([NEXT_TEXTURE]);
      h.surface.dispose();
    },
  );

  it("keeps a live cross-fade settling when a newer same-asset request supersedes it", async () => {
    const h = await createSurface({ sizes: WIDE_SIZES });
    await h.commit({ background: "base" });
    const first = h.cue(cues.background("next", { type: "cross_fade" }, 400));
    await flushMicrotasks();
    h.run(32);
    const entering = h
      .backgrounds()
      .find((view) => view.label === NEXT_TEXTURE);
    expect(entering?.alpha).toBeLessThan(1);

    // A newer request for the pixels the fade is entering must not strand the
    // live fade at a half-transparent alpha: it is a no-op that leaves the
    // committed writer alone.
    await h.cue(cues.background("next", { type: "cross_fade" }, 200));
    h.run(500);
    await first;
    const live = h.backgrounds();
    expect(live).toHaveLength(1);
    expect(live[0]?.label).toBe(NEXT_TEXTURE);
    expect(live[0]?.alpha).toBe(1);
    expect(urlsOf(h.destroyed)).toEqual([BASE_TEXTURE]);
    h.surface.dispose();
  });
});
