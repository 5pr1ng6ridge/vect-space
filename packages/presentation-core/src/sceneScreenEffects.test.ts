// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { evaluateFlashAlpha } from "./sceneEffects";
import { DESIGN_HEIGHT, DESIGN_WIDTH } from "./sceneFrame";
import {
  CAMERA,
  FLASH,
  SHAKE,
  createSurface,
  cues,
  flushMicrotasks,
  type Harness,
} from "./sceneSurfaceHarness";
import type { MemoryGraphics, MemoryShaderHost } from "./sceneTestKit";

const CENTER = { x: DESIGN_WIDTH / 2, y: DESIGN_HEIGHT / 2 };
const flashWindow = (durationMs: number, effect = FLASH) => ({
  startMs: 0,
  durationMs,
  effect,
});
const idleFrame = (elapsedMs: number, camera = CAMERA) => ({
  elapsed_ms: elapsedMs,
  camera,
  objects: [],
  bgm_volume: 1,
});

describe("flash and shake", () => {
  it("combines the base camera and shake once and keeps both effects", async () => {
    const h = await createSurface();
    h.surface.applyFrame(
      idleFrame(100, { x: 40, y: -20, zoom: 1.5, rotation_deg: 0 }),
      { phase: "playhead" },
    );
    h.surface.setActiveEffects({
      flash: flashWindow(400),
      shake: { startMs: 0, durationMs: 400, effect: SHAKE },
      elapsedMs: 100,
    });
    const layer = h.cameraLayer();
    expect(layer.pivot.x).toBe(DESIGN_WIDTH / 2 + 40);
    expect(layer.pivot.y).toBe(DESIGN_HEIGHT / 2 - 20);
    expect(layer.scale.x).toBe(1.5);
    // Shake is composed into the same transform instead of replacing it.
    expect(layer.position.x).not.toBe(CENTER.x);
    const flash = h.effects()[0];
    expect(flash?.alpha).toBeGreaterThan(0);
    expect(flash?.alpha).toBeLessThanOrEqual(0.88);
    h.surface.dispose();
  });

  it("clears the flash view when the effect ends", async () => {
    const h = await createSurface();
    h.surface.setActiveEffects({
      flash: flashWindow(100),
      shake: null,
      elapsedMs: 50,
    });
    expect(h.effects()).toHaveLength(1);
    h.surface.setActiveEffects(null);
    expect(h.effects()).toHaveLength(0);
    expect(h.cameraLayer().position.x).toBe(CENTER.x);
    h.surface.dispose();
  });

  it("fades a flash cue exactly like the timeline path and removes the node when it ends", async () => {
    const h = await createSurface();
    const pending = h.cue(cues.effect(FLASH, 160));
    await flushMicrotasks();
    const cueFlash = h.effects()[0];
    expect(cueFlash?.alpha).toBeCloseTo(0.88);
    // 80 ms into a 160 ms flash is the midpoint: the shipped ease-out decay is
    // applied once, so the cue path equals the pure evaluator.
    h.run(96);
    expect(cueFlash?.alpha).toBeCloseTo(
      evaluateFlashAlpha(FLASH, 80, 0, 160),
      6,
    );
    expect(cueFlash?.alpha).toBeCloseTo(0.22, 6);
    h.surface.setActiveEffects({
      flash: flashWindow(160),
      shake: null,
      elapsedMs: 80,
    });
    expect(h.effects()[1]?.alpha).toBeCloseTo(cueFlash?.alpha ?? -1, 6);
    h.run(200);
    await pending;
    expect(h.effects()).toHaveLength(1);
    h.surface.setActiveEffects(null);
    expect(h.effects()).toHaveLength(0);
    h.surface.dispose();
  });

  it("keeps the alpha of a flash colour on both paths", async () => {
    const h = await createSurface();
    const effect = { ...FLASH, color: "#FFFFFF80", peak_alpha: 1 };
    const pending = h.cue(cues.effect(effect, 160));
    await flushMicrotasks();
    expect(h.effects()[0]?.alpha).toBeCloseTo(128 / 255, 5);
    h.run(200);
    await pending;

    h.surface.setActiveEffects({
      flash: flashWindow(160, effect),
      shake: null,
      elapsedMs: 0,
    });
    expect(h.effects()[0]?.alpha).toBeCloseTo(128 / 255, 5);
    // An alpha-only colour edit keeps the RGB node but must repaint the opacity.
    h.surface.setActiveEffects({
      flash: flashWindow(160, { ...effect, color: "#FFFFFF40" }),
      shake: null,
      elapsedMs: 0,
    });
    expect(h.effects()[0]?.alpha).toBeCloseTo(64 / 255, 5);
    h.surface.dispose();
  });

  it("releases a flash cue that is still running when the surface resets", async () => {
    const h = await createSurface();
    const pending = h.cue(cues.effect(FLASH, 400));
    await flushMicrotasks();
    h.run(32);
    const flash = h.effects()[0];
    expect(flash).toBeDefined();

    h.surface.reset();
    await pending;
    // The reset owns the node now: the late cue must not destroy it twice.
    expect(h.effects()).toHaveLength(0);
    expect(flash?.destroyCount).toBe(1);
    expect(h.pump.pending()).toBe(1);
    h.surface.dispose();
    expect(h.pump.pending()).toBe(0);
  });

  it("does not write the destroyed camera when an aborted shake finishes", async () => {
    const h = await createSurface();
    const abort = new AbortController();
    const cue = h.cue(cues.effect(SHAKE, 400), abort.signal);
    h.run(100);
    const layer = h.cameraLayer();
    const shaken = { x: layer.position.x, y: layer.position.y };
    expect(shaken.x !== CENTER.x || shaken.y !== CENTER.y).toBe(true);
    // The host unmounts while the cue is in flight: its `finally` resumes after
    // `dispose()` destroyed the layer, which throws on a real Pixi node.
    abort.abort();
    h.surface.dispose();
    await cue;
    expect(layer.position.x).toBe(shaken.x);
    expect(layer.position.y).toBe(shaken.y);
  });

  it("clears a cue-owned shake offset when a world commit starts a generation", async () => {
    const h = await createSurface();
    await h.commit({ background: "base" });
    const layer = h.cameraLayer();
    const resting = { x: layer.position.x, y: layer.position.y };

    const pending = h.cue(cues.effect(SHAKE, 480));
    await flushMicrotasks();
    h.run(96);
    expect(
      layer.position.x === resting.x && layer.position.y === resting.y,
    ).toBe(false);

    // A world commit ends the generation the shake belonged to; its last
    // sampled offset must not stay composed into the camera.
    await h.commit({ background: "base" });
    expect(layer.position.x).toBe(resting.x);
    expect(layer.position.y).toBe(resting.y);
    h.run(500);
    await pending;
    h.surface.dispose();
  });
});

describe("shader effects", () => {
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

  const shaderHost = (h: Harness): MemoryShaderHost => {
    const host = h.kit.shaderHosts[0];
    if (host === undefined) throw new Error("surface has no shader host");
    return host;
  };
  const channel = <T>(effect: T, durationMs = 400) => ({
    startMs: 0,
    durationMs,
    effect,
  });
  const timeline = (elapsedMs: number, channels: Record<string, unknown>) =>
    ({ flash: null, shake: null, elapsedMs, ...channels }) as never;

  it("post-processes only the world layer over the whole stage", async () => {
    const h = await createSurface();
    const host = shaderHost(h);
    expect(host.target).toBe(h.cameraLayer());
    // An idle surface never installs a pass.
    expect(host.frames).toHaveLength(0);
    h.surface.setActiveEffects(
      timeline(100, {
        chromatic_aberration: channel(CHROMATIC),
        shockwave: channel(SHOCKWAVE, 700),
      }),
    );
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
    expect(h.effects()).toHaveLength(0);
    h.surface.dispose();
  });

  it("removes every pass exactly once when the windows end", async () => {
    const h = await createSurface();
    const host = shaderHost(h);
    h.surface.setActiveEffects(
      timeline(100, { chromatic_aberration: channel(CHROMATIC) }),
    );
    h.surface.setActiveEffects(
      timeline(400, { chromatic_aberration: channel(CHROMATIC) }),
    );
    expect(host.current).toEqual({
      ripple: null,
      shockwave: null,
      glitch: null,
      colorGrade: null,
      focus: null,
      chromaticAberration: null,
    });
    const applied = host.frames.length;
    h.surface.setActiveEffects(null);
    h.surface.setCameraOverride({ zoom: 1.2 });
    expect(host.frames).toHaveLength(applied);
    h.surface.dispose();
    expect(host.destroyed).toBe(true);
  });

  it.each([
    [
      "a zoomed camera",
      { x: 100, y: 0, zoom: 2, rotation_deg: 0 },
      { shockwave: channel(SHOCKWAVE, 700) },
      (
        area:
          { x: number; y: number; width: number; height: number } | undefined,
      ) => {
        // Half the stage around the camera centre, plus half a pixel of margin.
        expect(area?.width).toBeCloseTo(DESIGN_WIDTH / 2 + 1);
        expect(area?.x).toBeCloseTo(DESIGN_WIDTH / 4 + 100 - 0.5);
      },
    ],
    [
      "a quarter-turn camera",
      { x: 0, y: 0, zoom: 1, rotation_deg: 90 },
      { focus: channel(FOCUS, 700) },
      (
        area:
          { x: number; y: number; width: number; height: number } | undefined,
      ) => {
        // A quarter turn swaps the stage bounding box, plus the one-pixel margin.
        expect(area?.width).toBeCloseTo(DESIGN_HEIGHT + 2);
        expect(area?.height).toBeCloseTo(DESIGN_WIDTH + 2);
      },
    ],
  ])("maps the stage through %s", async (_name, camera, channels, check) => {
    const h = await createSurface();
    const host = shaderHost(h);
    h.surface.applyFrame(idleFrame(0, camera), { phase: "playhead" });
    h.surface.setActiveEffects(timeline(0, channels));
    check(host.areas.at(-1));
    h.surface.dispose();
  });

  it("drives cue shader effects and lets the newest cue of a type own it", async () => {
    const h = await createSurface();
    const host = shaderHost(h);
    const glitch = h.cue(cues.effect(GLITCH, 300));
    const first = h.cue(cues.effect(CHROMATIC, 400));
    h.run(64);
    expect(host.current?.glitch?.offsets).toHaveLength(16);
    expect(host.current?.chromaticAberration).not.toBeNull();
    const second = h.cue(
      cues.effect({ ...CHROMATIC, intensity: 40, fade_out: 0 }, 600),
    );
    h.run(32);
    expect(host.current?.chromaticAberration?.offsetX).toBeCloseTo(40);
    h.run(400);
    await first;
    await glitch;
    // The older chromatic cue ended but did not clear the newer owner.
    expect(host.current?.chromaticAberration?.offsetX).toBeCloseTo(40);
    expect(host.current?.glitch).toBeNull();
    h.run(300);
    await second;
    expect(host.current?.chromaticAberration).toBeNull();
    h.surface.dispose();
  });

  it("releases cue shader effects on reset", async () => {
    const h = await createSurface();
    const host = shaderHost(h);
    const abort = new AbortController();
    const cue = h.cue(cues.effect(SHOCKWAVE, 700), abort.signal);
    h.run(48);
    expect(host.current?.shockwave).not.toBeNull();
    h.surface.reset();
    expect(host.current?.shockwave).toBeNull();
    abort.abort();
    await cue;
    h.surface.dispose();
  });

  it("routes every new effect to the world layer, never to shake", async () => {
    const h = await createSurface();
    const host = shaderHost(h);
    const abort = new AbortController();
    const running = [COLOR_GRADE, FOCUS, RIPPLE].map((effect) =>
      h.cue(cues.effect(effect, 400), abort.signal),
    );
    h.run(32);
    expect(host.current?.colorGrade).not.toBeNull();
    expect(host.current?.focus).not.toBeNull();
    expect(host.current?.ripple).not.toBeNull();
    // The shake executor never ran: no flash node, a still camera layer.
    expect(h.effects()).toHaveLength(0);
    expect(h.cameraLayer().position).toMatchObject(CENTER);
    abort.abort();
    await Promise.all(running);
    h.surface.dispose();
  });

  it("keeps a timeline window owning its channel at zero strength", async () => {
    const h = await createSurface();
    const host = shaderHost(h);
    const abort = new AbortController();
    const cued = { ...CHROMATIC, fade_out: 0 };
    const cue = h.cue(cues.effect(cued, 600), abort.signal);
    h.run(32);
    expect(host.current?.chromaticAberration?.offsetX).toBeCloseTo(12);
    // An active timeline window owns the channel for its whole interval, even
    // when the evaluated frame is null at zero intensity: the overlapping cue
    // must not show through at the boundary.
    h.surface.setActiveEffects(
      timeline(100, {
        chromatic_aberration: channel({ ...cued, intensity: 0 }),
      }),
    );
    expect(host.current?.chromaticAberration).toBeNull();
    // A fade-in boundary (progress 0, envelope 0) owns it just the same.
    h.surface.setActiveEffects(
      timeline(100, {
        chromatic_aberration: {
          startMs: 100,
          durationMs: 400,
          effect: { ...cued, intensity: 1, fade_in: 1 },
        },
      }),
    );
    expect(host.current?.chromaticAberration).toBeNull();
    // Only releasing the timeline lets the still-running cue fill it again.
    h.surface.setActiveEffects(null);
    expect(host.current?.chromaticAberration?.offsetX).toBeCloseTo(12);
    abort.abort();
    await cue;
    h.surface.dispose();
  });

  it("bypasses an identity or zero new-effect frame", async () => {
    const h = await createSurface();
    const host = shaderHost(h);
    h.surface.setActiveEffects(
      timeline(100, {
        color_grade: channel({
          ...COLOR_GRADE,
          brightness: 0,
          contrast: 1,
          saturation: 1,
          tint_strength: 0,
        }),
        focus: channel({ ...FOCUS, blur: 0, darkness: 0 }),
        ripple: channel({ ...RIPPLE, amplitude: 0 }),
      }),
    );
    // Every channel bypassed, so the host installed no pass.
    expect(host.frames).toHaveLength(0);
    h.surface.dispose();
  });

  it("attenuates flashes, shakes and shaders under reduced motion", async () => {
    const h = await createSurface();
    const host = shaderHost(h);
    h.surface.setActiveEffects(
      timeline(0, {
        flash: flashWindow(400),
        chromatic_aberration: channel(CHROMATIC),
      }),
    );
    expect(h.effects()[0]?.alpha).toBeCloseTo(0.88);
    expect(host.current?.chromaticAberration?.offsetX).toBeCloseTo(12);
    h.surface.setReducedMotion(true);
    expect(h.surface.reducedMotion).toBe(true);
    expect((h.effects()[0] as MemoryGraphics | undefined)?.alpha).toBeCloseTo(
      0.3,
    );
    expect(host.current?.chromaticAberration?.offsetX).toBeCloseTo(6);
    h.surface.dispose();
  });

  it("keeps the grade but drops ripple and focus blur under reduced motion", async () => {
    const h = await createSurface();
    const host = shaderHost(h);
    h.surface.setReducedMotion(true);
    h.surface.setActiveEffects(
      timeline(0, {
        color_grade: channel(COLOR_GRADE),
        focus: channel(FOCUS),
        ripple: channel(RIPPLE),
      }),
    );
    const frame = host.current;
    expect(frame?.colorGrade).not.toBeNull();
    expect(frame?.ripple).toBeNull();
    expect(frame?.focus?.maxBlur).toBe(0);
    expect(frame?.focus?.darkness).toBeCloseTo(0.3);
    h.surface.dispose();
  });
});
