// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { DESIGN_HEIGHT, DESIGN_WIDTH } from "./sceneFrame";
import {
  SESSION_CURTAIN_FRAME_TIMEOUT_MS,
  SESSION_CURTAIN_MS,
  SceneSurface,
} from "./sceneSurface";
import { evaluateBackgroundTransition, wipeRect } from "./sceneTransitions";
import {
  MemoryGraphics,
  MemorySprite,
  createFramePump,
  createMemoryKit,
  createMemoryTextureLoader,
  type FramePump,
  type MemoryKit,
  type MemoryTexture,
} from "./sceneTestKit";
import { evaluateFlashAlpha } from "./sceneEffects";
import type { AssetUrlMap, TransitionDirection } from "./types";

const URLS: AssetUrlMap = {
  base: "/assets/base.png",
  next: "/assets/next.png",
  other: "/assets/other.png",
};
const BASE_TEXTURE = "/assets/base.png";
const CAMERA = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };

function backgroundCueContext(): {
  assets: AssetUrlMap;
  signal: AbortSignal;
  getRate: () => number;
} {
  return {
    assets: URLS,
    signal: new AbortController().signal,
    getRate: () => 1,
  };
}

interface Harness {
  surface: SceneSurface;
  kit: MemoryKit;
  pump: FramePump;
  destroyed: MemoryTexture[];
  messages: string[];
  run(ms?: number): void;
  backgrounds(): MemorySprite[];
  effects(): MemoryGraphics[];
  transitionLayer(): MemoryGraphics[];
  curtainLayer(): (MemorySprite | MemoryGraphics)[];
}

async function createSurface(): Promise<Harness> {
  const kit = createMemoryKit();
  const loader = createMemoryTextureLoader({
    [BASE_TEXTURE]: { width: 100, height: 50 },
    "/assets/next.png": { width: 100, height: 50 },
    "/assets/other.png": { width: 100, height: 50 },
  });
  const pump = createFramePump();
  const messages: string[] = [];
  const surface = new SceneSurface({
    canvas: document.createElement("canvas"),
    kit: kit.kit,
    textureLoader: loader.load,
    requestFrame: pump.request,
    cancelFrame: pump.cancel,
    diagnostic: (message) => messages.push(message),
  });
  await surface.init();
  pump.step(0);
  return {
    surface,
    kit,
    pump,
    destroyed: loader.destroyed,
    messages,
    run: (ms = 16) => {
      let remaining = ms;
      while (remaining > 0) {
        const slice = Math.min(16, remaining);
        pump.step(slice);
        remaining -= slice;
      }
    },
    backgrounds: () =>
      (kit.applications[0]?.stage.children[0]?.children[0]?.children ??
        []) as MemorySprite[],
    featherStrips: () =>
      (
        (kit.applications[0]?.stage.children[0]?.children[0]?.children ??
          []) as MemorySprite[]
      ).filter((child) => child.label.endsWith("#feather")),
    effects: () =>
      (kit.applications[0]?.stage.children[1]?.children ??
        []) as MemoryGraphics[],
    transitionLayer: () =>
      (kit.applications[0]?.stage.children[2]?.children ??
        []) as MemoryGraphics[],
    curtainLayer: () =>
      (kit.applications[0]?.stage.children[3]?.children ?? []) as (
        MemorySprite | MemoryGraphics
      )[],
    sessionLayer: () =>
      (kit.applications[0]?.stage.children[4]?.children ?? []) as (
        MemorySprite | MemoryGraphics
      )[],
  };
}

async function flushMicrotasks(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

/**
 * Steps the frame pump while letting promise continuations run.
 *
 * A multi-stage lifecycle (for example "wait one drawn frame, then start a
 * fade") only advances when the microtask queue is drained between frames, so
 * synchronous `harness.run` calls alone would leave the next stage unpumped.
 */
async function runAsync(harness: Harness, ms: number): Promise<void> {
  let remaining = ms;
  while (remaining > 0) {
    const slice = Math.min(16, remaining);
    harness.run(slice);
    remaining -= slice;
    await flushMicrotasks(2);
  }
}

describe("SceneSurface layer order", () => {
  it("stacks world, transition overlay, curtain and effects", async () => {
    const harness = await createSurface();
    const stage = harness.kit.applications[0]?.stage;
    expect(stage?.sortableChildren).toBe(true);
    const z = (stage?.children ?? []).map((child) => child.zIndex);
    // camera(0) < fade-through overlay(5) < curtain(10) < effects(20) <
    // host-only session curtain(30)
    expect(z).toEqual([0, 20, 5, 10, 30]);
    harness.surface.dispose();
  });
});

describe("SceneSurface curtain cue", () => {
  it("covers with a colour and reveals again", async () => {
    const harness = await createSurface();
    const context = {
      assets: URLS,
      signal: new AbortController().signal,
      getRate: () => 1,
    };
    const cover = harness.surface.runCue(
      {
        cue_id: "curtain-cover",
        gate: "runtime",
        type: "curtain_transition",
        action: "cover",
        fill: { color: "#000000" },
        transition: { type: "fade" },
        duration_ms: 100,
        easing: "linear",
      },
      context,
    );
    harness.run(120);
    await cover;
    const curtain = harness.curtainLayer();
    expect(curtain.length).toBeGreaterThanOrEqual(1);
    expect(curtain[0]?.alpha).toBe(1);
    expect(curtain[0]?.visible).toBe(true);

    const reveal = harness.surface.runCue(
      {
        cue_id: "curtain-reveal",
        gate: "runtime",
        type: "curtain_transition",
        action: "reveal",
        fill: null,
        transition: { type: "fade" },
        duration_ms: 100,
        easing: "linear",
      },
      context,
    );
    harness.run(120);
    await reveal;
    expect(harness.curtainLayer()).toHaveLength(0);
    harness.surface.dispose();
  });

  it("shows a prepared gui asset as the cover fill", async () => {
    const harness = await createSurface();
    const preparation = await harness.surface.prepare({
      world: {
        background: null,
        sprites: {},
        camera: CAMERA,
        curtain: { covered: true, fill: { asset: "gui.curtain" } },
      },
      assets: { ...URLS, "gui.curtain": "/assets/curtain.png" },
    });
    expect(harness.surface.applyWorld(preparation)).toBe(true);
    const curtain = harness.curtainLayer();
    expect(curtain[0]).toBeInstanceOf(MemorySprite);
    expect(curtain[0]?.alpha).toBe(1);
    harness.surface.dispose();
  });

  it("splits the curtain horizontally on cover", async () => {
    const harness = await createSurface();
    const context = {
      assets: URLS,
      signal: new AbortController().signal,
      getRate: () => 1,
    };
    const cover = harness.surface.runCue(
      {
        cue_id: "curtain-split",
        gate: "runtime",
        type: "curtain_transition",
        action: "cover",
        fill: { color: "#111111" },
        transition: { type: "split_horizontal" },
        duration_ms: 50,
        easing: "linear",
      },
      context,
    );
    harness.run(70);
    await cover;
    const mask = harness
      .curtainLayer()
      .filter((child) => child instanceof MemoryGraphics)
      .at(-1) as MemoryGraphics | undefined;
    // Two halves that meet in the middle (the first Graphics is the fill).
    expect(mask?.rects).toHaveLength(2);
    expect(mask?.rects[0]?.[3]).toBeCloseTo(DESIGN_HEIGHT / 2);
    harness.surface.dispose();
  });
});

describe("SceneSurface hard curtain reconcile", () => {
  it("restores a covered curtain without replaying a cue", async () => {
    const harness = await createSurface();
    const preparation = await harness.surface.prepare({
      world: {
        background: "base",
        sprites: {},
        camera: CAMERA,
        curtain: { covered: true, fill: { color: "#000000" } },
      },
      assets: URLS,
    });
    expect(harness.surface.applyWorld(preparation)).toBe(true);
    expect(harness.curtainLayer().length).toBeGreaterThanOrEqual(1);
    expect(harness.curtainLayer()[0]?.alpha).toBe(1);

    const hidden = await harness.surface.prepare({
      world: {
        background: "base",
        sprites: {},
        camera: CAMERA,
        curtain: { covered: false, fill: null },
      },
      assets: URLS,
    });
    expect(harness.surface.applyWorld(hidden)).toBe(true);
    expect(harness.curtainLayer()).toHaveLength(0);
    harness.surface.dispose();
  });

  it("drops the curtain on reset", async () => {
    const harness = await createSurface();
    const preparation = await harness.surface.prepare({
      world: {
        background: "base",
        sprites: {},
        camera: CAMERA,
        curtain: { covered: true, fill: { color: "#000000" } },
      },
      assets: URLS,
    });
    harness.surface.applyWorld(preparation);
    expect(harness.curtainLayer().length).toBeGreaterThan(0);
    harness.surface.reset();
    expect(harness.curtainLayer()).toHaveLength(0);
    harness.surface.dispose();
  });
});

describe("SceneSurface background transitions", () => {
  it("uses the cue easing for cross_fade", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: { background: "base", sprites: {}, camera: CAMERA },
        assets: URLS,
      }),
    );
    const pending = harness.surface.runCue(
      {
        cue_id: "cross-fade-step",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "cross_fade" },
        duration_ms: 200,
        easing: "step",
      },
      { assets: URLS, signal: new AbortController().signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    harness.run(100);
    const incoming = harness
      .backgrounds()
      .find((view) => view.label === "/assets/next.png");
    // `step` keeps the eased progress at zero mid-animation; a hard-coded
    // ease_in_out would already show ~50% here.
    expect(incoming?.alpha).toBe(0);
    harness.run(150);
    await pending;
    expect(
      harness.backgrounds().find((view) => view.label === "/assets/next.png")
        ?.alpha,
    ).toBe(1);
    harness.surface.dispose();
  });

  it("overlays a fade-through colour and clears it afterwards", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: { background: "base", sprites: {}, camera: CAMERA },
        assets: URLS,
      }),
    );
    const pending = harness.surface.runCue(
      {
        cue_id: "fade-through",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "fade_through_color", color: "#112233" },
        duration_ms: 200,
        easing: "linear",
      },
      { assets: URLS, signal: new AbortController().signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    harness.run(100);
    const overlay = harness.transitionLayer()[0];
    expect(overlay).toBeInstanceOf(MemoryGraphics);
    expect(overlay?.alpha).toBeGreaterThan(0);
    harness.run(150);
    await pending;
    expect(harness.transitionLayer()).toHaveLength(0);
    harness.surface.dispose();
  });

  it("masks a wipe and clears the mask when the cue ends", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: { background: "base", sprites: {}, camera: CAMERA },
        assets: URLS,
      }),
    );
    const pending = harness.surface.runCue(
      {
        cue_id: "wipe",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "wipe", direction: "left_to_right", softness: 0.2 },
        duration_ms: 100,
        easing: "linear",
      },
      { assets: URLS, signal: new AbortController().signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    harness.run(50);
    const incoming = harness
      .backgrounds()
      .find((view) => view.label === "/assets/next.png");
    expect(incoming?.mask).not.toBeNull();
    harness.run(80);
    await pending;
    const settled = harness
      .backgrounds()
      .find((view) => view.label === "/assets/next.png");
    expect(settled?.mask).toBeNull();
    expect(settled?.alpha).toBe(1);
    harness.surface.dispose();
  });

  it("slides both backgrounds for a push", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: { background: "base", sprites: {}, camera: CAMERA },
        assets: URLS,
      }),
    );
    const pending = harness.surface.runCue(
      {
        cue_id: "push",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "push", direction: "left_to_right", softness: 0 },
        duration_ms: 200,
        easing: "linear",
      },
      { assets: URLS, signal: new AbortController().signal, getRate: () => 1 },
    );
    await flushMicrotasks();
    harness.run(100);
    const incoming = harness
      .backgrounds()
      .find((view) => view.label === "/assets/next.png");
    const baseX = -120;
    expect(incoming).toBeDefined();
    expect(incoming?.position.x).toBeLessThan(baseX);
    harness.run(150);
    await pending;
    const settled = harness
      .backgrounds()
      .find((view) => view.label === "/assets/next.png");
    expect(settled?.position.x).toBeCloseTo(baseX);
    harness.surface.dispose();
  });
});

describe("SceneSurface background transition easing", () => {
  it("applies the authored easing exactly once for a cross_fade", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: { background: "base", sprites: {}, camera: CAMERA },
        assets: URLS,
      }),
    );
    const pending = harness.surface.runCue(
      {
        cue_id: "cross-fade-ease-in",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "cross_fade" },
        duration_ms: 160,
        easing: "ease_in",
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();
    // 96 ms of pump time leaves 80 ms of animation time after the origin
    // frame, so the raw progress is exactly 0.5.
    harness.run(96);
    const incoming = harness
      .backgrounds()
      .find((view) => view.label === "/assets/next.png");
    // ease_in(0.5) = 0.25 applied once.  Easing the callback progress and then
    // handing the authored easing to the evaluator would give
    // ease_in(ease_in(0.5)) = 0.0625.
    expect(incoming?.alpha).toBeCloseTo(0.25, 6);
    harness.run(200);
    await pending;
    harness.surface.dispose();
  });

  it("keeps a soft wipe at the authored edge instead of accelerating it", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: { background: "base", sprites: {}, camera: CAMERA },
        assets: URLS,
      }),
    );
    const pending = harness.surface.runCue(
      {
        cue_id: "soft-wipe",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: {
          type: "wipe",
          direction: "left_to_right",
          softness: 0.5,
        },
        duration_ms: 160,
        easing: "linear",
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();
    harness.run(96);
    const incoming = harness
      .backgrounds()
      .find((view) => view.label === "/assets/next.png");
    const mask = incoming?.mask as MemoryGraphics | null;
    // Mid-transition the authored edge is at 0.5 * DESIGN_WIDTH and the
    // feather band spans softness * DESIGN_WIDTH around it: the binary stencil
    // draws the fully revealed part in front of the band, so a soft wipe never
    // leads or lags the hard edge.
    const edge = DESIGN_WIDTH * 0.5;
    const half = (DESIGN_WIDTH * 0.5) / 2;
    expect(mask?.rects[0]?.[2]).toBeCloseTo(edge - half, 6);
    harness.run(200);
    await pending;
    harness.surface.dispose();
  });

  it("draws a stepped feather ramp for a soft wipe and none for a hard one", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: { background: "base", sprites: {}, camera: CAMERA },
        assets: URLS,
      }),
    );
    const hard = harness.surface.runCue(
      {
        cue_id: "hard-wipe",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "wipe", direction: "left_to_right", softness: 0 },
        duration_ms: 160,
        easing: "linear",
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();
    harness.run(96);
    // The hard path is exactly the binary stencil rectangle.
    expect(harness.featherStrips()).toHaveLength(0);
    harness.run(200);
    await hard;

    const soft = harness.surface.runCue(
      {
        cue_id: "soft-wipe",
        gate: "runtime",
        type: "background_transition",
        background: "other",
        transition: {
          type: "wipe",
          direction: "left_to_right",
          softness: 0.25,
        },
        duration_ms: 160,
        easing: "linear",
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();
    harness.run(96);
    const strips = harness.featherStrips();
    expect(strips.length).toBeGreaterThan(1);
    // The band spans exactly softness * DESIGN_WIDTH around the authored edge.
    const bandStart = Math.min(
      ...strips.map(
        (strip) => (strip.mask as MemoryGraphics).rects[0]?.[0] ?? 0,
      ),
    );
    const bandEnd = Math.max(
      ...strips.map(
        (strip) =>
          ((strip.mask as MemoryGraphics).rects[0]?.[0] ?? 0) +
          ((strip.mask as MemoryGraphics).rects[0]?.[2] ?? 0),
      ),
    );
    expect(bandStart).toBeCloseTo(
      DESIGN_WIDTH * 0.5 - (DESIGN_WIDTH * 0.25) / 2,
      6,
    );
    expect(bandEnd).toBeCloseTo(
      DESIGN_WIDTH * 0.5 + (DESIGN_WIDTH * 0.25) / 2,
      6,
    );
    // Steps descend from the opaque side to the transparent side.
    const alphas = strips.map((strip) => strip.alpha);
    for (let index = 1; index < alphas.length; index += 1) {
      expect(alphas[index]).toBeLessThan(alphas[index - 1] ?? 0);
    }
    expect(alphas[0]).toBeLessThan(1);
    expect(alphas.at(-1)).toBeGreaterThan(0);
    harness.run(200);
    await soft;
    // Every strip and its mask is released when the cue settles.
    expect(harness.featherStrips()).toHaveLength(0);
    const settled = harness
      .backgrounds()
      .find((view) => view.label === "/assets/other.png");
    expect(settled?.mask).toBeNull();
    harness.surface.dispose();
  });

  it("slides a soft push with an overlapping feather and releases it", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: { background: "base", sprites: {}, camera: CAMERA },
        assets: URLS,
      }),
    );
    const pending = harness.surface.runCue(
      {
        cue_id: "soft-push",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: {
          type: "push",
          direction: "left_to_right",
          softness: 0.25,
        },
        duration_ms: 160,
        easing: "linear",
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();
    harness.run(96);
    const incoming = harness
      .backgrounds()
      .find((view) => view.label === "/assets/next.png");
    const baseX = -120;
    const half = (DESIGN_WIDTH * 0.25) / 2;
    // The incoming leads by half a feather; the outgoing lags by the same
    // amount so the ramp always blends into the outgoing's pixels.
    expect(incoming?.position.x).toBeCloseTo(
      baseX - DESIGN_WIDTH / 2 + half,
      6,
    );
    const outgoing = harness
      .backgrounds()
      .find((view) => view.label === "/assets/base.png");
    expect(outgoing?.position.x).toBeCloseTo(
      baseX + DESIGN_WIDTH / 2 - half,
      6,
    );
    expect(harness.featherStrips().length).toBeGreaterThan(1);

    harness.run(200);
    await pending;
    // The exact hard path is restored at the end of a soft push.
    expect(
      harness.backgrounds().find((view) => view.label === "/assets/next.png")
        ?.position.x,
    ).toBeCloseTo(baseX, 6);
    expect(harness.featherStrips()).toHaveLength(0);
    harness.surface.dispose();
  });
});

describe("SceneSurface screen-effect cue", () => {
  it("matches the timeline evaluator at the same elapsed time", async () => {
    const harness = await createSurface();
    const effect = {
      type: "flash",
      color: "#FFFFFF",
      peak_alpha: 0.88,
    } as const;
    const pending = harness.surface.runCue(
      {
        cue_id: "flash",
        gate: "runtime",
        type: "screen_effect",
        effect,
        duration_ms: 160,
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();
    harness.run(96);
    const cueFlash = harness.effects()[0];
    // 80 ms into a 160 ms flash is the midpoint: the shipped ease-out decay is
    // applied once, so the cue path equals the pure evaluator.
    expect(cueFlash?.alpha).toBeCloseTo(
      evaluateFlashAlpha(effect, 80, 0, 160),
      6,
    );
    expect(cueFlash?.alpha).toBeCloseTo(0.22, 6);
    // The timeline path at the same playhead must agree with the cue path.
    harness.surface.setActiveEffects({
      flash: { startMs: 0, durationMs: 160, effect },
      shake: null,
      elapsedMs: 80,
    });
    expect(harness.effects()[1]?.alpha).toBeCloseTo(cueFlash?.alpha ?? -1, 6);
    harness.run(200);
    await pending;
    harness.surface.dispose();
  });
});

describe("SceneSurface overlapping background transitions", () => {
  const baseWorld = {
    world: { background: "base", sprites: {}, camera: CAMERA },
    assets: URLS,
  };

  it("keeps the newer wipe's mask alive when the superseded wipe settles", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(await harness.surface.prepare(baseWorld));
    const older = harness.surface.runCue(
      {
        cue_id: "older-wipe",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "wipe", direction: "left_to_right", softness: 0 },
        duration_ms: 240,
        easing: "linear",
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();
    harness.run(96);

    const newer = harness.surface.runCue(
      {
        cue_id: "newer-wipe",
        gate: "runtime",
        type: "background_transition",
        background: "other",
        transition: { type: "wipe", direction: "left_to_right", softness: 0 },
        duration_ms: 480,
        easing: "linear",
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();
    const liveMask = (): MemoryGraphics | null =>
      (harness.backgrounds().find((view) => view.label === "/assets/other.png")
        ?.mask ?? null) as MemoryGraphics | null;
    expect(liveMask()).not.toBeNull();

    // The older wipe finishes while the newer one is still running.  Its
    // cleanup must not detach or destroy the mask the newer cue installed.
    harness.run(160);
    await older;
    await flushMicrotasks();
    const mask = liveMask();
    expect(mask).not.toBeNull();
    expect(mask?.destroyed).toBe(false);
    expect(mask?.rects[0]?.[2]).toBeCloseTo(DESIGN_WIDTH * 0.3, 6);

    // The newer wipe keeps revealing; a torn-down mask would freeze it hard.
    harness.run(160);
    expect(liveMask()?.rects[0]?.[2]).toBeCloseTo(
      DESIGN_WIDTH * (304 / 480),
      6,
    );
    harness.run(300);
    await newer;
    expect(liveMask()).toBeNull();
    harness.surface.dispose();
  });

  it("keeps the newer fade-through overlay alive when the superseded one settles", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(await harness.surface.prepare(baseWorld));
    const older = harness.surface.runCue(
      {
        cue_id: "older-fade-through",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "fade_through_color", color: "#112233" },
        duration_ms: 240,
        easing: "linear",
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();
    harness.run(96);

    const newer = harness.surface.runCue(
      {
        cue_id: "newer-fade-through",
        gate: "runtime",
        type: "background_transition",
        background: "other",
        transition: { type: "fade_through_color", color: "#112233" },
        duration_ms: 480,
        easing: "linear",
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();

    harness.run(160);
    await older;
    await flushMicrotasks();
    // The newer cue replaced the overlay; the older cue's cleanup must leave
    // the newer overlay alone instead of blanking the transition.
    const overlay = harness.transitionLayer()[0];
    expect(overlay).toBeInstanceOf(MemoryGraphics);
    expect(overlay?.alpha).toBeGreaterThan(0);
    harness.run(400);
    await newer;
    expect(harness.transitionLayer()).toHaveLength(0);
    harness.surface.dispose();
  });
});

describe("SceneSurface cue shake lifetime", () => {
  it("clears a cue-owned shake offset when a world commit starts a generation", async () => {
    const harness = await createSurface();
    const world = {
      world: { background: "base", sprites: {}, camera: CAMERA },
      assets: URLS,
    };
    harness.surface.applyWorld(await harness.surface.prepare(world));
    const cameraLayer = harness.kit.applications[0]?.stage.children[0];
    const resting = {
      x: cameraLayer?.position.x ?? 0,
      y: cameraLayer?.position.y ?? 0,
    };

    const pending = harness.surface.runCue(
      {
        cue_id: "shake",
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
        duration_ms: 480,
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();
    harness.run(96);
    const shaken = {
      x: cameraLayer?.position.x ?? 0,
      y: cameraLayer?.position.y ?? 0,
    };
    expect(shaken.x === resting.x && shaken.y === resting.y).toBe(false);

    // A world commit ends the generation the shake belonged to; its last
    // sampled offset must not stay composed into the camera.
    harness.surface.applyWorld(await harness.surface.prepare(world));
    expect(cameraLayer?.position.x).toBe(resting.x);
    expect(cameraLayer?.position.y).toBe(resting.y);
    harness.run(500);
    await pending;
    harness.surface.dispose();
  });
});

describe("SceneSurface colour alpha", () => {
  it("keeps the alpha of a curtain colour fill", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: "base",
          sprites: {},
          camera: CAMERA,
          curtain: { covered: true, fill: { color: "#000000AA" } },
        },
        assets: URLS,
      }),
    );
    expect(harness.curtainLayer()[0]?.alpha).toBeCloseTo(170 / 255, 5);
    harness.surface.dispose();
  });

  it("keeps the alpha of a fade-through overlay", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: { background: "base", sprites: {}, camera: CAMERA },
        assets: URLS,
      }),
    );
    const pending = harness.surface.runCue(
      {
        cue_id: "fade-through-alpha",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "fade_through_color", color: "#11223344" },
        duration_ms: 160,
        easing: "linear",
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();
    // Midpoint: the evaluator asks for a fully covering overlay, scaled by the
    // authored colour alpha instead of being drawn opaque.
    harness.run(96);
    expect(harness.transitionLayer()[0]?.alpha).toBeCloseTo(68 / 255, 5);
    harness.run(200);
    await pending;
    harness.surface.dispose();
  });

  it("keeps the alpha of a flash cue and of a timeline flash", async () => {
    const harness = await createSurface();
    const effect = {
      type: "flash",
      color: "#FFFFFF80",
      peak_alpha: 1,
    } as const;
    const pending = harness.surface.runCue(
      {
        cue_id: "flash-alpha",
        gate: "runtime",
        type: "screen_effect",
        effect,
        duration_ms: 160,
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();
    expect(harness.effects()[0]?.alpha).toBeCloseTo(128 / 255, 5);
    harness.run(200);
    await pending;

    harness.surface.setActiveEffects({
      flash: { startMs: 0, durationMs: 160, effect },
      shake: null,
      elapsedMs: 0,
    });
    expect(harness.effects()[0]?.alpha).toBeCloseTo(128 / 255, 5);
    // An alpha-only colour edit keeps the RGB node but must still repaint the
    // new opacity.
    harness.surface.setActiveEffects({
      flash: {
        startMs: 0,
        durationMs: 160,
        effect: { ...effect, color: "#FFFFFF40" },
      },
      shake: null,
      elapsedMs: 0,
    });
    expect(harness.effects()[0]?.alpha).toBeCloseTo(64 / 255, 5);
    harness.surface.dispose();
  });
});

describe("SceneSurface curtain fill contract", () => {
  it("treats an omitted curtain fill as no new fill", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: "base",
          sprites: {},
          camera: CAMERA,
          curtain: { covered: true, fill: { color: "#000000" } },
        },
        assets: URLS,
      }),
    );
    const reveal = harness.surface.runCue(
      {
        cue_id: "reveal-omitted-fill",
        gate: "runtime",
        type: "curtain_transition",
        action: "reveal",
        // The runtime skips `fill` when serialising a reveal cue, so the wire
        // payload can arrive without the key.
        fill: undefined as unknown as null,
        transition: { type: "fade" },
        duration_ms: 100,
        easing: "linear",
      },
      backgroundCueContext(),
    );
    harness.run(120);
    await reveal;
    expect(harness.curtainLayer()).toHaveLength(0);
    harness.surface.dispose();
  });

  it("refreshes a curtain asset when the same id gains a new revision", async () => {
    const harness = await createSurface();
    const scene = (url: string) => ({
      world: {
        background: "base",
        sprites: {},
        camera: CAMERA,
        curtain: { covered: true, fill: { asset: "gui.curtain" } },
      },
      assets: { ...URLS, "gui.curtain": url },
    });
    harness.surface.applyWorld(
      await harness.surface.prepare(scene("/assets/curtain-a.png")),
    );
    const first = harness.curtainLayer()[0] as MemorySprite;
    expect((first.texture as unknown as MemoryTexture).url).toBe(
      "/assets/curtain-a.png",
    );
    harness.surface.applyWorld(
      await harness.surface.prepare(scene("/assets/curtain-b.png")),
    );
    const second = harness.curtainLayer()[0] as MemorySprite;
    expect(second).not.toBe(first);
    expect((second.texture as unknown as MemoryTexture).url).toBe(
      "/assets/curtain-b.png",
    );
    harness.surface.dispose();
  });

  it("reports a diagnostic before falling back when the asset has no pixels", async () => {
    const harness = await createSurface();
    await harness.surface.runCue(
      {
        cue_id: "cover-missing-asset",
        gate: "runtime",
        type: "curtain_transition",
        action: "cover",
        fill: { asset: "gui.missing" },
        transition: { type: "fade" },
        duration_ms: 0,
        easing: "linear",
      },
      backgroundCueContext(),
    );
    // The world must stay covered, and the silent black fallback must be
    // discoverable instead of hiding a broken asset.
    const fill = harness.curtainLayer()[0] as MemoryGraphics;
    expect(fill).toBeInstanceOf(MemoryGraphics);
    expect(fill.fills).toEqual([0x000000]);
    expect(fill.alpha).toBe(1);
    expect(
      harness.messages.some(
        (message) =>
          message.includes("已回退为纯色幕布") &&
          message.includes("gui.missing"),
      ),
    ).toBe(true);
    harness.surface.dispose();
  });
});

describe("SceneSurface background cue take-over", () => {
  const baseWorld = {
    world: { background: "base", sprites: {}, camera: CAMERA },
    assets: URLS,
  };

  it("detaches a superseded wipe's mask before a push takes over", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(await harness.surface.prepare(baseWorld));
    const older = harness.surface.runCue(
      {
        cue_id: "older-wipe",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "wipe", direction: "left_to_right", softness: 0.2 },
        duration_ms: 480,
        easing: "linear",
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();
    harness.run(96);
    const olderIncoming = harness
      .backgrounds()
      .find((view) => view.label === "/assets/next.png");
    expect(olderIncoming?.mask).not.toBeNull();
    expect(harness.featherStrips().length).toBeGreaterThan(0);

    // A different kind of transition takes the layer over.  The shared mask
    // must be detached from the superseded view before the push creates its
    // own (maskless) resources, otherwise the sliding-out background would
    // still be clipped by the wipe mask.
    const newer = harness.surface.runCue(
      {
        cue_id: "newer-push",
        gate: "runtime",
        type: "background_transition",
        background: "other",
        transition: { type: "push", direction: "left_to_right", softness: 0 },
        duration_ms: 480,
        easing: "linear",
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();
    expect(olderIncoming?.mask).toBeNull();
    expect(harness.featherStrips()).toHaveLength(0);

    // The superseded cue's own cleanup must not tear the newer push down.
    harness.run(400);
    await older;
    await flushMicrotasks();
    const incoming = harness
      .backgrounds()
      .find((view) => view.label === "/assets/other.png");
    const baseX = -120;
    const positionBefore = incoming?.position.x ?? baseX;
    // The newer push is still running (it started after the older wipe) and
    // must keep sliding despite the older cue's settle.
    expect(positionBefore).toBeLessThan(baseX);
    await runAsync(harness, 64);
    expect(incoming?.position.x).toBeGreaterThan(positionBefore);
    harness.run(300);
    await newer;
    expect(
      harness.backgrounds().find((view) => view.label === "/assets/other.png")
        ?.position.x,
    ).toBeCloseTo(baseX, 6);
    harness.surface.dispose();
  });

  it("feathers a wipe and a push in all four directions", async () => {
    const harness = await createSurface();
    const directions = [
      "left_to_right",
      "right_to_left",
      "top_to_bottom",
      "bottom_to_top",
    ] as const;
    for (const direction of directions) {
      const horizontal =
        direction === "left_to_right" || direction === "right_to_left";
      const axis = horizontal ? 0 : 1;
      const dimension = horizontal ? DESIGN_WIDTH : DESIGN_HEIGHT;
      const half = (dimension * 0.25) / 2;
      const bandStart = dimension * 0.5 - half;
      const bandEnd = dimension * 0.5 + half;
      const bandOf = (): number[] => {
        const rects = harness
          .featherStrips()
          .map(
            (strip) => (strip.mask as MemoryGraphics).rects[0] ?? [0, 0, 0, 0],
          );
        return [
          Math.min(...rects.map((rect) => rect[axis] ?? 0)),
          Math.max(
            ...rects.map(
              (rect) => (rect[axis] ?? 0) + (rect[axis === 0 ? 2 : 3] ?? 0),
            ),
          ),
        ];
      };

      harness.surface.applyWorld(await harness.surface.prepare(baseWorld));
      const wipe = harness.surface.runCue(
        {
          cue_id: `wipe-${direction}`,
          gate: "runtime",
          type: "background_transition",
          background: "next",
          transition: { type: "wipe", direction, softness: 0.25 },
          duration_ms: 160,
          easing: "linear",
        },
        backgroundCueContext(),
      );
      await flushMicrotasks();
      harness.run(96);
      expect(bandOf()[0]).toBeCloseTo(bandStart, 6);
      expect(bandOf()[1]).toBeCloseTo(bandEnd, 6);
      harness.run(300);
      await wipe;
      expect(harness.featherStrips()).toHaveLength(0);

      harness.surface.applyWorld(await harness.surface.prepare(baseWorld));
      const push = harness.surface.runCue(
        {
          cue_id: `push-${direction}`,
          gate: "runtime",
          type: "background_transition",
          background: "next",
          transition: { type: "push", direction, softness: 0.25 },
          duration_ms: 160,
          easing: "linear",
        },
        backgroundCueContext(),
      );
      await flushMicrotasks();
      harness.run(96);
      expect(bandOf()[0]).toBeCloseTo(bandStart, 6);
      expect(bandOf()[1]).toBeCloseTo(bandEnd, 6);
      harness.run(300);
      await push;
      expect(harness.featherStrips()).toHaveLength(0);
    }
    harness.surface.dispose();
  });

  it("releases a live feather when a reset ends the generation", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(await harness.surface.prepare(baseWorld));
    const pending = harness.surface.runCue(
      {
        cue_id: "wipe-then-reset",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "wipe", direction: "left_to_right", softness: 0.2 },
        duration_ms: 480,
        easing: "linear",
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();
    harness.run(96);
    expect(harness.featherStrips().length).toBeGreaterThan(0);

    // A reset (host cancel) ends the generation: the strips, their masks and
    // the view mask must all be released, and the aborted cue must not recreate
    // any of them afterwards.
    harness.surface.reset();
    harness.run(600);
    await pending;
    expect(harness.featherStrips()).toHaveLength(0);
    const backgrounds = harness.backgrounds();
    expect(backgrounds.every((view) => view.mask === null)).toBe(true);
    expect(backgrounds.some((view) => view.label.endsWith("#feather"))).toBe(
      false,
    );
    harness.surface.dispose();
  });

  it("replaces a superseded fade-through overlay before a soft wipe takes over", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(await harness.surface.prepare(baseWorld));
    const older = harness.surface.runCue(
      {
        cue_id: "older-fade-through",
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type: "fade_through_color", color: "#112233" },
        duration_ms: 480,
        easing: "linear",
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();
    harness.run(96);
    expect(harness.transitionLayer()).toHaveLength(1);

    const newer = harness.surface.runCue(
      {
        cue_id: "newer-soft-wipe",
        gate: "runtime",
        type: "background_transition",
        background: "other",
        transition: { type: "wipe", direction: "left_to_right", softness: 0.2 },
        duration_ms: 480,
        easing: "linear",
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();
    // The take-over clears the old overlay and installs the newer mask.
    expect(harness.transitionLayer()).toHaveLength(0);
    const incoming = harness
      .backgrounds()
      .find((view) => view.label === "/assets/other.png");
    expect(incoming?.mask).not.toBeNull();
    // The old cue's settle neither restores its overlay nor clears the mask.
    harness.run(400);
    await older;
    await flushMicrotasks();
    expect(harness.transitionLayer()).toHaveLength(0);
    expect(incoming?.mask).not.toBeNull();
    harness.run(400);
    await newer;
    expect(harness.featherStrips()).toHaveLength(0);
    expect(incoming?.mask).toBeNull();
    harness.surface.dispose();
  });
});

describe("SceneSurface reversed soft edges", () => {
  const baseWorld = {
    world: { background: "base", sprites: {}, camera: CAMERA },
    assets: URLS,
  };
  const SOFTNESS = 0.25;
  const DURATION_MS = 160;

  /** Steps one wipe/push cue to a non-midpoint sample and returns the run. */
  async function sampleCue(
    harness: Harness,
    direction: TransitionDirection,
    type: "wipe" | "push",
    atMs: number,
  ): Promise<{ pending: Promise<void> }> {
    harness.surface.applyWorld(await harness.surface.prepare(baseWorld));
    const pending = harness.surface.runCue(
      {
        cue_id: `${type}-${direction}-${atMs}`,
        gate: "runtime",
        type: "background_transition",
        background: "next",
        transition: { type, direction, softness: SOFTNESS },
        duration_ms: DURATION_MS,
        easing: "linear",
      },
      backgroundCueContext(),
    );
    await flushMicrotasks();
    // The first tick only establishes the animation time origin, so the
    // second step lands exactly on `atMs / DURATION_MS` of progress.
    harness.pump.step(0);
    await flushMicrotasks();
    harness.pump.step(atMs);
    await flushMicrotasks();
    // The pending cue is handed over unwrapped: awaiting an async helper that
    // returns it directly would adopt the promise and deadlock the sample.
    return { pending };
  }

  function stripBand(harness: Harness, axis: 0 | 1): [number, number] {
    const rects = harness
      .featherStrips()
      .map((strip) => (strip.mask as MemoryGraphics).rects[0] ?? [0, 0, 0, 0]);
    return [
      Math.min(...rects.map((rect) => rect[axis] ?? 0)),
      Math.max(
        ...rects.map(
          (rect) => (rect[axis] ?? 0) + (rect[axis === 0 ? 2 : 3] ?? 0),
        ),
      ),
    ];
  }

  /** Design-space span covered by one background view. */
  function imageSpan(view: MemorySprite, axis: 0 | 1): [number, number] {
    const start = axis === 0 ? view.position.x : view.position.y;
    const texture = view.texture as MemoryTexture;
    // The surface sets a uniform cover scale through a single scalar; the
    // memory kit records it on x while Pixi would mirror it onto both axes.
    const scale = view.scale.x;
    const length = axis === 0 ? texture.width * scale : texture.height * scale;
    return [start, start + length];
  }

  it("keeps a reversed wipe on the hard edge at a non-midpoint progress", async () => {
    const harness = await createSurface();
    const cases = [
      { direction: "right_to_left" as const, progress: 0.25, atMs: 40 },
      { direction: "bottom_to_top" as const, progress: 0.8, atMs: 128 },
    ];
    for (const { direction, progress, atMs } of cases) {
      const horizontal = direction === "right_to_left";
      const axis: 0 | 1 = horizontal ? 0 : 1;
      const dimension = horizontal ? DESIGN_WIDTH : DESIGN_HEIGHT;
      const { pending } = await sampleCue(harness, direction, "wipe", atMs);
      const hard = wipeRect(direction, progress);
      const hardEdge = axis === 0 ? hard.x : hard.y;
      const half = Math.min(
        (SOFTNESS * dimension) / 2,
        hardEdge,
        dimension - hardEdge,
      );
      const [bandStart, bandEnd] = stripBand(harness, axis);
      // The band is centred on the hard edge of the same instant (mirrored for
      // this direction), not on the unmirrored `progress * dimension`:
      // softness may only widen the edge, never move or accelerate it.
      expect(bandStart).toBeCloseTo(hardEdge - half, 6);
      expect(bandEnd).toBeCloseTo(hardEdge + half, 6);
      expect((bandStart + bandEnd) / 2).toBeCloseTo(hardEdge, 6);
      // The opaque stencil region sits behind the band, flush with the
      // anchored stage boundary, so incoming pixels are fully opaque there.
      const incoming = harness
        .backgrounds()
        .find((view) => view.label === "/assets/next.png");
      const opaque = (incoming?.mask as MemoryGraphics).rects[0] ?? [
        0, 0, 0, 0,
      ];
      expect(opaque[axis]).toBeCloseTo(bandEnd, 6);
      expect(opaque[axis === 0 ? 2 : 3]).toBeCloseTo(dimension - bandEnd, 6);
      // The stepped alpha ramp points from the transparent low side to the
      // opaque high side of the reversed direction.
      const strips = harness.featherStrips();
      const sorted = [...strips].sort(
        (a, b) =>
          ((a.mask as MemoryGraphics).rects[0]?.[axis] ?? 0) -
          ((b.mask as MemoryGraphics).rects[0]?.[axis] ?? 0),
      );
      expect(sorted[0]?.alpha).toBeLessThan(0.5);
      expect(sorted.at(-1)?.alpha).toBeGreaterThan(0.5);
      harness.run(300);
      await pending;
      expect(harness.featherStrips()).toHaveLength(0);
      expect(incoming?.mask).toBeNull();
    }
    harness.surface.dispose();
  });

  it("keeps a reversed soft push covered at a non-midpoint progress", async () => {
    const harness = await createSurface();
    const cases = [
      { direction: "right_to_left" as const, progress: 0.75, atMs: 120 },
      { direction: "bottom_to_top" as const, progress: 0.2, atMs: 32 },
    ];
    for (const { direction, progress, atMs } of cases) {
      const horizontal = direction === "right_to_left";
      const axis: 0 | 1 = horizontal ? 0 : 1;
      const { pending } = await sampleCue(harness, direction, "push", atMs);
      const frame = evaluateBackgroundTransition(
        { type: "push", direction, softness: SOFTNESS },
        progress,
        "linear",
      );
      const ramp = frame.mask?.ramp;
      if (ramp === null || ramp === undefined) {
        throw new Error("软 push 必须返回 ramp");
      }
      // The seam of the shifted images is the same mirrored hard edge: the
      // incoming leads by half the band and the outgoing lags by half.
      expect(ramp.startPx).toBeCloseTo(
        horizontal ? frame.incomingOffset.x : frame.incomingOffset.y,
        6,
      );
      expect(ramp.endPx).toBeCloseTo(
        (horizontal ? frame.outgoingOffset.x : frame.outgoingOffset.y) +
          (horizontal ? DESIGN_WIDTH : DESIGN_HEIGHT),
        6,
      );
      const hard = wipeRect(direction, progress);
      expect((ramp.startPx + ramp.endPx) / 2).toBeCloseTo(
        axis === 0 ? hard.x : hard.y,
        6,
      );
      // Both real images cover the whole band, so no strip of the soft push
      // can blend into the empty canvas.
      const incoming = harness
        .backgrounds()
        .find((view) => view.label === "/assets/next.png");
      const outgoing = harness
        .backgrounds()
        .find((view) => view.label === "/assets/base.png");
      if (incoming === undefined || outgoing === undefined) {
        throw new Error("缺少背景视图");
      }
      const [incomingStart, incomingEnd] = imageSpan(incoming, axis);
      const [outgoingStart, outgoingEnd] = imageSpan(outgoing, axis);
      expect(ramp.startPx).toBeGreaterThanOrEqual(incomingStart - 1e-6);
      expect(ramp.startPx).toBeLessThanOrEqual(incomingEnd);
      expect(ramp.endPx).toBeGreaterThanOrEqual(outgoingStart);
      expect(ramp.endPx).toBeLessThanOrEqual(outgoingEnd + 1e-6);
      harness.run(300);
      await pending;
      expect(harness.featherStrips()).toHaveLength(0);
    }
    harness.surface.dispose();
  });
});

describe("SceneSurface host session curtain", () => {
  it("covers with fixed black and reveals on its own layer", async () => {
    const harness = await createSurface();
    const cover = harness.surface.coverSession(100);
    expect(harness.surface.sessionCovered).toBe(false);
    harness.run(50);
    expect(
      (harness.sessionLayer()[0] as MemoryGraphics | undefined)?.alpha,
    ).toBeGreaterThan(0);
    await runAsync(harness, 120);
    await cover;
    expect(harness.surface.sessionCovered).toBe(true);
    const fill = harness.sessionLayer()[0] as MemoryGraphics;
    expect(fill.alpha).toBe(1);
    expect(fill.fills).toEqual([0x000000]);

    const reveal = harness.surface.revealSession(100);
    await runAsync(harness, 300);
    await reveal;
    expect(harness.surface.sessionCovered).toBe(false);
    expect(harness.sessionLayer()).toHaveLength(0);
    harness.surface.dispose();
  });

  it("coalesces duplicate covers and reveals (React Strict Mode)", async () => {
    const harness = await createSurface();
    const first = harness.surface.coverSession(100);
    const second = harness.surface.coverSession(100);
    expect(second).toBe(first);
    await runAsync(harness, 200);
    await Promise.all([first, second]);
    // One cover animation, one fill node.
    expect(harness.sessionLayer()).toHaveLength(1);
    // Covering an already covered canvas is a no-op.
    expect(harness.surface.sessionCovered).toBe(true);
    await harness.surface.coverSession(100);
    expect(harness.sessionLayer()).toHaveLength(1);
    // A duplicate reveal call resolves once with the one reveal animation.
    const reveal = harness.surface.revealSession(100);
    const duplicate = harness.surface.revealSession(100);
    expect(duplicate).toBe(reveal);
    await runAsync(harness, 300);
    await Promise.all([reveal, duplicate]);
    expect(harness.sessionLayer()).toHaveLength(0);
    harness.surface.dispose();
  });

  it("reveals only after the replacement has been drawn once", async () => {
    const harness = await createSurface();
    await harness.surface.coverSession(0);
    expect(harness.surface.sessionCovered).toBe(true);
    let revealed = false;
    const reveal = harness.surface.revealSession(50).then(() => {
      revealed = true;
    });
    await flushMicrotasks();
    // No frame was pumped yet: the cover must still fully hide the world.
    expect(revealed).toBe(false);
    expect(
      (harness.sessionLayer()[0] as MemoryGraphics | undefined)?.alpha,
    ).toBe(1);
    await runAsync(harness, 200);
    await reveal;
    expect(revealed).toBe(true);
    expect(harness.sessionLayer()).toHaveLength(0);
    harness.surface.dispose();
  });

  it("always clears the curtain on reset and dispose", async () => {
    const harness = await createSurface();
    const cover = harness.surface.coverSession(1000);
    harness.run(64);
    harness.surface.reset();
    await cover;
    expect(harness.surface.sessionCovered).toBe(false);
    expect(harness.sessionLayer()).toHaveLength(0);
    harness.surface.dispose();
    expect(harness.sessionLayer()).toHaveLength(0);
  });

  it("starts a fresh cover after a reset aborts the in-flight one", async () => {
    const harness = await createSurface();
    const aborted = harness.surface.coverSession(1000);
    harness.run(64);
    expect(harness.sessionLayer().length).toBeGreaterThan(0);
    expect(harness.surface.sessionCovered).toBe(false);

    harness.surface.reset();
    // The reset clears the operation state synchronously, so a host that
    // covers again immediately gets a new transition instead of the aborted
    // promise of the curtain the reset just destroyed.
    const next = harness.surface.coverSession(1000);
    expect(next).not.toBe(aborted);
    await runAsync(harness, 1500);
    await next;
    expect(harness.surface.sessionCovered).toBe(true);
    expect((harness.sessionLayer()[0] as MemoryGraphics).alpha).toBe(1);
    await aborted;
    harness.surface.dispose();
  });

  it("continues a cover from the current reveal alpha instead of snapping transparent", async () => {
    const harness = await createSurface();
    await harness.surface.coverSession(0);
    const reveal = harness.surface.revealSession(200);
    await runAsync(harness, 112);
    const before =
      (harness.sessionLayer()[0] as MemoryGraphics | undefined)?.alpha ?? -1;
    expect(before).toBeGreaterThan(0.2);
    expect(before).toBeLessThan(1);

    // Covering mid-reveal must continue from the alpha on screen, not fade in
    // from transparent (which would flash the world back in).
    const cover = harness.surface.coverSession(200);
    harness.pump.step(0);
    await flushMicrotasks();
    expect(
      (harness.sessionLayer()[0] as MemoryGraphics | undefined)?.alpha,
    ).toBeCloseTo(before, 5);
    harness.pump.step(16);
    await flushMicrotasks();
    const after =
      (harness.sessionLayer()[0] as MemoryGraphics | undefined)?.alpha ?? -1;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(1);

    await runAsync(harness, 400);
    await cover;
    expect(harness.surface.sessionCovered).toBe(true);
    expect((harness.sessionLayer()[0] as MemoryGraphics).alpha).toBe(1);
    await reveal;
    harness.surface.dispose();
  });

  it("does not lose a reveal requested while a cover is in flight", async () => {
    const harness = await createSurface();
    const cover = harness.surface.coverSession(300);
    await runAsync(harness, 64);
    expect(harness.surface.sessionCovered).toBe(false);
    expect(harness.sessionLayer().length).toBeGreaterThan(0);

    const reveal = harness.surface.revealSession(100);
    await runAsync(harness, 1000);
    await Promise.all([cover, reveal]);
    // The reveal waited for the cover, then ran instead of being dropped: the
    // canvas is uncovered when the caller's promise resolves.
    expect(harness.surface.sessionCovered).toBe(false);
    expect(harness.sessionLayer()).toHaveLength(0);
    harness.surface.dispose();
  });

  it("supersedes a reveal parked behind its stable frame with a newer cover", async () => {
    const harness = await createSurface();
    await harness.surface.coverSession(0);
    expect(harness.surface.sessionCovered).toBe(true);

    // The reveal parks waiting for the replacement frame to be drawn once.
    const reveal = harness.surface.revealSession(200);
    await flushMicrotasks();
    expect(
      (harness.sessionLayer()[0] as MemoryGraphics | undefined)?.alpha,
    ).toBe(1);

    // A cover issued while the reveal is parked is the newest request and
    // owns the curtain; it must not be swallowed as "already covered" and
    // must stop the parked reveal from lowering it later.
    const cover = harness.surface.coverSession(200);
    expect(cover).not.toBe(reveal);
    await runAsync(harness, 600);
    await Promise.all([reveal, cover]);
    expect(harness.surface.sessionCovered).toBe(true);
    expect((harness.sessionLayer()[0] as MemoryGraphics).alpha).toBe(1);
    harness.surface.dispose();
  });

  it("observes the newest cover when a reveal follows a superseded parked reveal", async () => {
    const harness = await createSurface();
    await harness.surface.coverSession(0);
    expect(harness.surface.sessionCovered).toBe(true);

    // Park a reveal behind its stable frame.
    const parked = harness.surface.revealSession(200);
    await flushMicrotasks();
    expect(
      (harness.sessionLayer()[0] as MemoryGraphics | undefined)?.alpha,
    ).toBe(1);

    // A newer cover supersedes the parked reveal, and the next reveal request
    // arrives before that parked reveal notices.  The newer request must
    // observe the newest cover (wait for it, then reveal) instead of reusing
    // the parked promise, which is a doomed no-op.
    const cover = harness.surface.coverSession(200);
    const reveal = harness.surface.revealSession(200);
    expect(reveal).not.toBe(parked);

    await runAsync(harness, 1200);
    await Promise.all([parked, cover, reveal]);
    expect(harness.surface.sessionCovered).toBe(false);
    expect(harness.sessionLayer()).toHaveLength(0);
    harness.surface.dispose();
  });

  it("invalidates a reveal parked behind its stable frame on reset", async () => {
    const harness = await createSurface();
    await harness.surface.coverSession(0);
    const reveal = harness.surface.revealSession(200);
    await flushMicrotasks();

    // The reset is a session boundary: the parked reveal must stop instead of
    // surviving it and later lowering a cover started after the reset.
    harness.surface.reset();
    const cover = harness.surface.coverSession(0);
    await runAsync(harness, 300);
    await Promise.all([reveal, cover]);
    expect(harness.surface.sessionCovered).toBe(true);
    expect((harness.sessionLayer()[0] as MemoryGraphics).alpha).toBe(1);
    harness.surface.dispose();
  });

  it("finishes a bounded cover and reveal when the host suspends rendering", async () => {
    const harness = await createSurface();

    // A hidden/suspended host never draws another frame, so a real fade must
    // be ended by the watchdog instead of holding the host busy forever.
    vi.useFakeTimers();
    try {
      const cover = harness.surface.coverSession(1000);
      await vi.advanceTimersByTimeAsync(
        SESSION_CURTAIN_FRAME_TIMEOUT_MS + 1001,
      );
      await cover;
      expect(harness.surface.sessionCovered).toBe(true);
      expect((harness.sessionLayer()[0] as MemoryGraphics).alpha).toBe(1);

      const renders = harness.kit.renderCount();
      const reveal = harness.surface.revealSession(1000);
      // The reveal first waits a bounded time for a drawn frame and renders
      // once best-effort, then its own fade watchdog finishes the fade.
      await vi.advanceTimersByTimeAsync(
        2 * (SESSION_CURTAIN_FRAME_TIMEOUT_MS + 1001),
      );
      await reveal;
      expect(harness.kit.renderCount()).toBeGreaterThan(renders);
      expect(harness.surface.sessionCovered).toBe(false);
      expect(harness.sessionLayer()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
    harness.surface.dispose();
  });

  it("uses the 250ms default for both the cover and the reveal", async () => {
    expect(SESSION_CURTAIN_MS).toBe(250);
    const harness = await createSurface();
    // Cover: 240ms of virtual time is not enough, 250ms completes it.
    const coverStart = harness.pump.now();
    const cover = harness.surface.coverSession();
    harness.pump.step(0);
    await flushMicrotasks();
    harness.run(240);
    await flushMicrotasks();
    expect(harness.pump.now() - coverStart).toBe(240);
    expect(harness.surface.sessionCovered).toBe(false);
    expect(
      (harness.sessionLayer()[0] as MemoryGraphics | undefined)?.alpha,
    ).toBeCloseTo(240 / SESSION_CURTAIN_MS, 6);
    harness.run(10);
    await flushMicrotasks();
    await cover;
    expect(harness.pump.now() - coverStart).toBe(SESSION_CURTAIN_MS);
    expect(harness.surface.sessionCovered).toBe(true);
    expect((harness.sessionLayer()[0] as MemoryGraphics).alpha).toBe(1);

    // Reveal: the same 250ms default, measured from the fade's time origin.
    const reveal = harness.surface.revealSession();
    harness.pump.step(0);
    await flushMicrotasks();
    const revealStart = harness.pump.now();
    harness.pump.step(0);
    await flushMicrotasks();
    harness.pump.step(240);
    await flushMicrotasks();
    expect(harness.pump.now() - revealStart).toBe(240);
    expect(harness.sessionLayer()).toHaveLength(1);
    expect(
      (harness.sessionLayer()[0] as MemoryGraphics | undefined)?.alpha,
    ).toBeCloseTo(1 - 240 / SESSION_CURTAIN_MS, 6);
    harness.pump.step(10);
    await flushMicrotasks();
    await reveal;
    expect(harness.pump.now() - revealStart).toBe(SESSION_CURTAIN_MS);
    expect(harness.surface.sessionCovered).toBe(false);
    expect(harness.sessionLayer()).toHaveLength(0);
    harness.surface.dispose();
  });

  it("never touches the story curtain layer or a snapshot curtain", async () => {
    const harness = await createSurface();
    harness.surface.applyWorld(
      await harness.surface.prepare({
        world: {
          background: "base",
          sprites: {},
          camera: CAMERA,
          curtain: { covered: true, fill: { color: "#112233" } },
        },
        assets: URLS,
      }),
    );
    expect(harness.curtainLayer().length).toBeGreaterThanOrEqual(1);
    await harness.surface.coverSession(0);
    // The host cover lives on its own layer; the story curtain state and fill
    // are untouched (they are part of the world, the host cover is not).
    expect(harness.curtainLayer().length).toBeGreaterThanOrEqual(1);
    expect((harness.curtainLayer()[0] as MemoryGraphics).fills).toEqual([
      0x112233,
    ]);
    const reveal = harness.surface.revealSession(0);
    await runAsync(harness, 32);
    await reveal;
    expect(harness.curtainLayer().length).toBeGreaterThanOrEqual(1);
    expect(harness.sessionLayer()).toHaveLength(0);
    harness.surface.dispose();
  });
});
