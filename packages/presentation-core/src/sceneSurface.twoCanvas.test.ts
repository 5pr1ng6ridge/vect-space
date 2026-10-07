// @vitest-environment jsdom
//
// Simultaneous two-canvas ownership regression.
//
// One surface per canvas is the shipped shape (game canvas + editor preview).
// This suite keeps two real `SceneSurface` instances alive at the same time on
// separate canvases, driven by the in-memory kit, and proves that they own
// independent applications, texture stores, render loops and media sessions:
// resetting or disposing one must not destroy, re-decode, re-phase or
// re-target the other.  It deliberately does not reuse the single-surface
// "many views share one decode" contract — the point here is that nothing is
// shared *across* surfaces.

import { describe, expect, it } from "vitest";

import { evaluateSceneFrame, type SceneFrame } from "./sceneFrame";
import { SceneSurface } from "./sceneSurface";
import {
  createFramePump,
  createMemoryKit,
  createMemoryTextureLoader,
  type FramePump,
  type MemoryApplication,
  type MemoryKit,
  type MemoryNode,
  MemorySprite,
  type MemoryTexture,
} from "./sceneTestKit";
import { createFakeMediaDom, type FakeMediaDom } from "./sessionTestKit";
import type { AnimationMap } from "./imageAnimation";
import type { AssetUrlMap, SpriteSnapshot, TimelineTrack } from "./types";

const URLS: AssetUrlMap = {
  base: "/assets/base.png",
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
};

const VIDEO_TRACK: Extract<TimelineTrack, { type: "video" }> = {
  type: "video",
  asset: "clip",
  clip_start_ms: 0,
  clip_end_ms: null,
  loop: false,
  fit: "contain",
  audio_enabled: true,
  channels: {},
};

const CAMERA = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };

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

const WORLD = {
  background: null,
  sprites: { hero: sprite("walk") },
  camera: CAMERA,
};

interface OwnedCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly surface: SceneSurface;
  readonly pump: FramePump;
  readonly application: MemoryApplication;
  characters(): MemorySprite[];
  videoSprite(): MemorySprite | null;
  run(ms?: number): void;
}

interface TwoCanvasFixture {
  readonly kit: MemoryKit;
  readonly loader: ReturnType<typeof createMemoryTextureLoader>;
  /** Canvases each application was initialized with, in creation order. */
  readonly initCanvases: HTMLCanvasElement[];
  readonly dom: FakeMediaDom;
  readonly left: OwnedCanvas;
  readonly right: OwnedCanvas;
}

/**
 * Creates two live surfaces from one shared kit.
 *
 * Sharing the kit (and the texture loader function) is the adversarial case:
 * even then each surface must create its own `Application`, decode its own
 * pixels and drive its own frame source.
 */
async function createTwoCanvases(): Promise<TwoCanvasFixture> {
  const kit = createMemoryKit();
  const initCanvases: HTMLCanvasElement[] = [];
  const createApplication = kit.kit.application;
  kit.kit.application = () => {
    const application = createApplication();
    const init = application.init.bind(application);
    application.init = async (options) => {
      initCanvases.push(options.canvas);
      await init(options);
    };
    return application;
  };
  const loader = createMemoryTextureLoader();
  const create = async (): Promise<OwnedCanvas> => {
    const canvas = document.createElement("canvas");
    const pump = createFramePump();
    const surface = new SceneSurface({
      canvas,
      kit: kit.kit,
      animations: ANIMATIONS,
      textureLoader: loader.load,
      requestFrame: pump.request,
      cancelFrame: pump.cancel,
    });
    await surface.init();
    pump.step(0);
    const application = kit.applications[kit.applications.length - 1];
    if (application === undefined) {
      throw new Error("内存 kit 没有创建 application");
    }
    const container = (index: number): MemoryNode[] =>
      (application.stage.children[0]?.children ?? []).filter((node) =>
        node instanceof MemorySprite && (index === 2
          ? node.anchor.y === 0 && node.zIndex !== -10000
          : node.anchor.y !== 0 && node.zIndex !== -10000));
    return {
      canvas,
      surface,
      pump,
      application,
      run: (ms = 16) => {
        let remaining = ms;
        while (remaining > 0) {
          const slice = Math.min(16, remaining);
          pump.step(slice);
          remaining -= slice;
        }
      },
      characters: () => container(1) as MemorySprite[],
      videoSprite: () => (container(2)[0] ?? null) as MemorySprite | null,
    };
  };
  const left = await create();
  const right = await create();
  return { kit, loader, initCanvases, dom: createFakeMediaDom(), left, right };
}

function textureUrl(canvas: OwnedCanvas): string | undefined {
  return (canvas.characters()[0]?.texture as MemoryTexture | undefined)?.url;
}

function frameAt(surface: SceneSurface, elapsedMs: number): SceneFrame {
  const tracks: TimelineTrack[] = [
    {
      type: "sprite",
      sprite_id: "hero",
      asset: null,
      remove_at_end: false,
      channels: {},
    },
  ];
  return evaluateSceneFrame(
    {
      duration_ms: 400,
      tracks,
      sprites: WORLD.sprites,
      camera: CAMERA,
      bgm_volume: 1,
    },
    elapsedMs,
    surface.geometry,
  );
}

describe("SceneSurface two-canvas ownership", () => {
  it("creates one application and one decode per canvas and ticks each render loop alone", async () => {
    const fixture = await createTwoCanvases();
    const { left, right, kit, loader } = fixture;
    try {
      expect(kit.applications).toHaveLength(2);
      expect(left.application).not.toBe(right.application);
      expect(left.canvas).not.toBe(right.canvas);
      expect(fixture.initCanvases).toHaveLength(2);
      expect(fixture.initCanvases[0]).toBe(left.canvas);
      expect(fixture.initCanvases[1]).toBe(right.canvas);

      const world = {
        background: null,
        sprites: { hero: sprite("base") },
        camera: CAMERA,
      };
      expect(
        left.surface.applyWorld(
          await left.surface.prepare({ world, assets: URLS }),
        ),
      ).toBe(true);
      expect(
        right.surface.applyWorld(
          await right.surface.prepare({ world, assets: URLS }),
        ),
      ).toBe(true);

      // The same logical asset is decoded once per canvas: independent stores,
      // not one shared decode.
      const decoded = loader.loaded.filter(
        (texture) => texture.url === URLS.base,
      );
      expect(decoded).toHaveLength(2);
      expect(decoded[0]).not.toBe(decoded[1]);
      expect(left.characters()[0]?.texture).toBe(decoded[0]);
      expect(right.characters()[0]?.texture).toBe(decoded[1]);

      left.run();
      right.run();
      const before = [left.application.renders, right.application.renders];

      // A change on the left only draws when the left frame source advances;
      // the right canvas's loop must not flush it.
      left.surface.setObjectOverride("hero", { x: 10 });
      right.run();
      expect([left.application.renders, right.application.renders]).toEqual(
        before,
      );
      left.run();
      expect(left.application.renders).toBe(before[0] + 1);
      expect(right.application.renders).toBe(before[1]);
    } finally {
      left.surface.dispose();
      right.surface.dispose();
    }
  });

  it("keeps the other canvas's application, pixels, phase, media and session intact across reset and dispose", async () => {
    const fixture = await createTwoCanvases();
    const { left, right, loader, dom } = fixture;
    try {
      // Same world on both canvases; the left one decodes first so its
      // textures can be told apart from the right one's.
      expect(
        left.surface.applyWorld(
          await left.surface.prepare({ world: WORLD, assets: URLS }),
        ),
      ).toBe(true);
      const leftTextures = [...loader.loaded];
      expect(leftTextures).toHaveLength(4);
      expect(
        right.surface.applyWorld(
          await right.surface.prepare({ world: WORLD, assets: URLS }),
        ),
      ).toBe(true);
      const rightTextures = loader.loaded.filter(
        (texture) => !leftTextures.includes(texture),
      );
      expect(rightTextures).toHaveLength(4);
      expect(leftTextures.every((texture) => texture.destroyed)).toBe(false);
      expect(rightTextures.every((texture) => texture.destroyed)).toBe(false);
      expect(left.surface.loopIds).toEqual(["hero"]);
      expect(right.surface.loopIds).toEqual(["hero"]);

      // Independent frame phases: each canvas seeks its own playhead and only
      // its own frame pump advances its animation.
      left.surface.applyFrame(frameAt(left.surface, 50), {
        phase: "playhead",
      });
      right.surface.applyFrame(frameAt(right.surface, 250), {
        phase: "playhead",
      });
      expect(textureUrl(left)).toBe("/assets/walk/a.png");
      expect(textureUrl(right)).toBe("/assets/walk/c.png");
      left.run(60);
      expect(textureUrl(left)).toBe("/assets/walk/b.png");
      expect(textureUrl(right)).toBe("/assets/walk/c.png");
      right.run(60);
      expect(textureUrl(right)).toBe("/assets/walk/d.png");
      expect(textureUrl(left)).toBe("/assets/walk/b.png");

      // Independent media sessions: one video element per canvas.
      const leftElement = dom.createVideo();
      const rightElement = dom.createVideo();
      const leftMedia = dom.videos[0];
      const rightMedia = dom.videos[1];
      await left.surface.attachVideo(leftElement, VIDEO_TRACK);
      await right.surface.attachVideo(rightElement, VIDEO_TRACK);
      const leftVideo = left.videoSprite();
      const rightVideo = right.videoSprite();
      expect(leftVideo).not.toBeNull();
      expect(rightVideo).not.toBeNull();
      expect(leftVideo).not.toBe(rightVideo);
      expect(leftMedia?.element).toBe(leftElement);
      expect(rightMedia?.element).toBe(rightElement);

      const leftHero = left.characters()[0];
      const rightHero = right.characters()[0];

      // Resetting one canvas releases exactly its own references; the other
      // canvas keeps its pixels, phase, media and live session.
      left.surface.reset();
      expect(leftTextures.every((texture) => texture.destroyed)).toBe(true);
      expect(rightTextures.some((texture) => texture.destroyed)).toBe(false);
      expect(leftHero?.destroyed).toBe(true);
      expect(rightHero?.destroyed).toBe(false);
      expect((rightHero?.texture as MemoryTexture).destroyed).toBe(false);
      expect(textureUrl(right)).toBe("/assets/walk/d.png");
      expect(left.videoSprite()).toBeNull();
      expect(leftVideo?.destroyed).toBe(true);
      expect(rightVideo?.destroyed).toBe(false);
      expect(leftMedia?.released).toBe(true);
      expect(rightMedia?.released).toBe(false);
      expect(left.application.destroyed).toBe(false);
      expect(right.application.destroyed).toBe(false);
      expect(left.surface.initialized).toBe(true);
      expect(right.surface.initialized).toBe(true);
      expect(left.surface.captureBases().sprites).toEqual({});
      expect(left.surface.loopIds).toEqual([]);
      expect(right.surface.loopIds).toEqual(["hero"]);
      expect(right.surface.captureBases().sprites.hero?.asset).toBe("walk");

      // Disposing the reset canvas destroys only its own application and loop.
      left.surface.dispose();
      left.surface.dispose();
      expect(left.application.destroyed).toBe(true);
      expect(right.application.destroyed).toBe(false);
      expect(left.pump.pending()).toBe(0);
      expect(right.pump.pending()).toBe(1);
      expect(left.surface.initialized).toBe(false);
      expect(right.surface.initialized).toBe(true);
      expect(rightMedia?.released).toBe(false);
      expect(rightHero?.destroyed).toBe(false);
      expect(left.surface.loopIds).toEqual([]);
      expect(right.surface.loopIds).toEqual(["hero"]);

      // Final disposal returns each canvas to its baseline exactly once.
      right.surface.dispose();
      expect(right.application.destroyed).toBe(true);
      expect(right.pump.pending()).toBe(0);
      expect(rightMedia?.released).toBe(true);
      expect(rightTextures.every((texture) => texture.destroyed)).toBe(true);
      expect(leftTextures.every((texture) => texture.destroyed)).toBe(true);
      expect(loader.destroyed).toHaveLength(loader.loaded.length);
      expect(left.surface.initialized).toBe(false);
      expect(right.surface.initialized).toBe(false);
    } finally {
      left.surface.dispose();
      right.surface.dispose();
    }
  });
});
