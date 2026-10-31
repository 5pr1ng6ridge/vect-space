// @vitest-environment jsdom
//
// Simultaneous two-canvas ownership.
//
// One surface per canvas is the shipped shape (game canvas + editor preview).
// Two live `SceneSurface` instances on separate canvases, driven by one shared
// in-memory kit, must own independent applications, texture stores, render
// loops and media sessions: resetting or disposing one must not destroy,
// re-decode, re-phase or re-target the other.

import { describe, expect, it } from "vitest";

import { SceneSurface } from "./sceneSurface";
import {
  ANIMATIONS,
  CAMERA,
  URLS,
  frameAt,
  sprite,
} from "./sceneSurfaceHarness";
import {
  MemorySprite,
  createFramePump,
  createMemoryKit,
  createMemoryTextureLoader,
  type FramePump,
  type MemoryApplication,
  type MemoryTexture,
} from "./sceneTestKit";
import { createFakeMediaDom } from "./sessionTestKit";
import type { TimelineTrack } from "./types";

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
  run(ms: number): void;
}

/**
 * Creates two live surfaces from one shared kit and texture loader: the
 * adversarial case, since each surface must still create its own
 * `Application`, decode its own pixels and drive its own frame source.
 */
async function createTwoCanvases() {
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
    if (application === undefined)
      throw new Error("内存 kit 没有创建 application");
    const sprites = (): MemorySprite[] =>
      (application.stage.children[0]?.children ?? []).filter(
        (node): node is MemorySprite =>
          node instanceof MemorySprite && node.zIndex !== -10000,
      );
    return {
      canvas,
      surface,
      pump,
      application,
      run: (ms) => {
        for (let remaining = ms; remaining > 0; remaining -= 16)
          pump.step(Math.min(16, remaining));
      },
      // A video is the only sprite anchored at the top-left corner.
      characters: () => sprites().filter((node) => node.anchor.y !== 0),
      videoSprite: () => sprites().find((node) => node.anchor.y === 0) ?? null,
    };
  };
  const left = await create();
  const right = await create();
  return { kit, loader, initCanvases, dom: createFakeMediaDom(), left, right };
}

const textureUrl = (canvas: OwnedCanvas): string | undefined =>
  (canvas.characters()[0]?.texture as MemoryTexture | undefined)?.url;

const frameOf = (canvas: OwnedCanvas, elapsedMs: number) =>
  frameAt(
    canvas,
    WORLD.sprites,
    elapsedMs,
    [
      {
        type: "sprite",
        sprite_id: "hero",
        asset: null,
        remove_at_end: false,
        channels: {},
      },
    ],
    400,
  );

describe("SceneSurface two-canvas ownership", () => {
  it("creates one application and one decode per canvas and ticks each render loop alone", async () => {
    const { left, right, kit, loader, initCanvases } =
      await createTwoCanvases();
    try {
      expect(kit.applications).toHaveLength(2);
      expect(left.application).not.toBe(right.application);
      expect(initCanvases).toEqual([left.canvas, right.canvas]);

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

      // The same logical asset is decoded once per canvas: independent stores.
      const decoded = loader.loaded.filter(
        (texture) => texture.url === URLS.base,
      );
      expect(decoded).toHaveLength(2);
      expect(left.characters()[0]?.texture).toBe(decoded[0]);
      expect(right.characters()[0]?.texture).toBe(decoded[1]);

      left.run(16);
      right.run(16);
      const before = [left.application.renders, right.application.renders];
      // A change on the left only draws when the left frame source advances.
      left.surface.setObjectOverride("hero", { x: 10 });
      right.run(16);
      expect([left.application.renders, right.application.renders]).toEqual(
        before,
      );
      left.run(16);
      expect(left.application.renders).toBe((before[0] ?? 0) + 1);
      expect(right.application.renders).toBe(before[1]);
    } finally {
      left.surface.dispose();
      right.surface.dispose();
    }
  });

  it("keeps the other canvas's application, pixels, phase, media and session intact across reset and dispose", async () => {
    const { left, right, loader, dom } = await createTwoCanvases();
    try {
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
      expect(left.surface.loopIds).toEqual(["hero"]);
      expect(right.surface.loopIds).toEqual(["hero"]);

      // Independent frame phases: each canvas seeks its own playhead and only
      // its own frame pump advances its animation.
      left.surface.applyFrame(frameOf(left, 50), { phase: "playhead" });
      right.surface.applyFrame(frameOf(right, 250), { phase: "playhead" });
      expect(textureUrl(left)).toBe("/assets/walk/a.png");
      expect(textureUrl(right)).toBe("/assets/walk/c.png");
      left.run(60);
      expect(textureUrl(left)).toBe("/assets/walk/b.png");
      expect(textureUrl(right)).toBe("/assets/walk/c.png");

      // Independent media sessions: one video element per canvas.
      const leftElement = dom.createVideo();
      const rightElement = dom.createVideo();
      await left.surface.attachVideo(leftElement, VIDEO_TRACK);
      await right.surface.attachVideo(rightElement, VIDEO_TRACK);
      const leftVideo = left.videoSprite();
      const rightVideo = right.videoSprite();
      expect(leftVideo).not.toBeNull();
      expect(rightVideo).not.toBeNull();
      expect(leftVideo).not.toBe(rightVideo);
      const [leftMedia, rightMedia] = dom.videos;
      const rightHero = right.characters()[0];

      // Resetting one canvas releases exactly its own references.
      left.surface.reset();
      expect(leftTextures.every((texture) => texture.destroyed)).toBe(true);
      expect(rightTextures.some((texture) => texture.destroyed)).toBe(false);
      expect(rightHero?.destroyed).toBe(false);
      expect(textureUrl(right)).toBe("/assets/walk/c.png");
      expect(left.videoSprite()).toBeNull();
      expect(leftVideo?.destroyed).toBe(true);
      expect(rightVideo?.destroyed).toBe(false);
      expect(leftMedia?.released).toBe(true);
      expect(rightMedia?.released).toBe(false);
      expect(left.application.destroyed).toBe(false);
      expect(left.surface.initialized).toBe(true);
      expect(left.surface.loopIds).toEqual([]);
      expect(right.surface.loopIds).toEqual(["hero"]);

      // Disposing the reset canvas destroys only its own application and loop.
      left.surface.dispose();
      left.surface.dispose();
      expect(left.application.destroyed).toBe(true);
      expect(right.application.destroyed).toBe(false);
      expect(left.pump.pending()).toBe(0);
      expect(right.pump.pending()).toBe(1);
      expect(rightMedia?.released).toBe(false);
      expect(right.surface.initialized).toBe(true);

      // Final disposal returns each canvas to its baseline exactly once.
      right.surface.dispose();
      expect(right.application.destroyed).toBe(true);
      expect(right.pump.pending()).toBe(0);
      expect(rightMedia?.released).toBe(true);
      expect(loader.destroyed).toHaveLength(loader.loaded.length);
    } finally {
      left.surface.dispose();
      right.surface.dispose();
    }
  });
});
