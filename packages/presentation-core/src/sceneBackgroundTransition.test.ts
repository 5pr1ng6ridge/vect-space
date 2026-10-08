// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { DESIGN_HEIGHT, DESIGN_WIDTH } from "./sceneFrame";
import {
  BASE_TEXTURE,
  NEXT_TEXTURE,
  OTHER_TEXTURE,
  WIDE_SIZES,
  createSurface,
  cues,
  flushMicrotasks,
  type Harness,
} from "./sceneSurfaceHarness";
import {
  MemoryGraphics,
  type MemorySprite,
  type MemoryTexture,
} from "./sceneTestKit";
import { evaluateBackgroundTransition, wipeRect } from "./sceneTransitions";
import type { TransitionDirection } from "./types";

const LAYOUT_MASK = "layout:__background__";
const CENTER_X = DESIGN_WIDTH / 2;

const wipe = (
  softness: number,
  direction: TransitionDirection = "left_to_right",
) => ({ type: "wipe", direction, softness }) as const;
const push = (
  softness: number,
  direction: TransitionDirection = "left_to_right",
) => ({ type: "push", direction, softness }) as const;

/** A harness showing `base`, with the three stills at a non-square size. */
async function withBase(): Promise<Harness> {
  const h = await createSurface({ sizes: WIDE_SIZES });
  await h.commit({ background: "base" });
  return h;
}

const view = (h: Harness, texture: string): MemorySprite | undefined =>
  h.backgrounds().find((background) => background.label === texture);

/** The mask rectangle of a live (non-layout) wipe mask, if any. */
function liveMask(h: Harness, texture: string): MemoryGraphics | null {
  const mask = view(h, texture)?.mask;
  return mask == null || mask.label.startsWith("layout:")
    ? null
    : (mask as MemoryGraphics);
}

/** Min/max extent of the feather strips along `axis` (0 = x, 1 = y). */
function stripBand(h: Harness, axis: 0 | 1): [number, number] {
  const rects = h
    .featherStrips()
    .map((strip) => (strip.mask as MemoryGraphics).rects[0] ?? [0, 0, 0, 0]);
  const length = axis === 0 ? 2 : 3;
  return [
    Math.min(...rects.map((rect) => rect[axis] ?? 0)),
    Math.max(...rects.map((rect) => (rect[axis] ?? 0) + (rect[length] ?? 0))),
  ];
}

describe("background transitions", () => {
  it("applies the authored easing exactly once for a cross_fade", async () => {
    const h = await withBase();
    const pending = h.cue(
      cues.background("next", { type: "cross_fade" }, 160, "ease_in"),
    );
    await flushMicrotasks();
    // 96 ms of pump time leaves 80 ms of animation time after the origin
    // frame, so the raw progress is exactly 0.5.
    h.run(96);
    // ease_in(0.5) = 0.25 applied once.  Easing the callback progress and then
    // handing the authored easing to the evaluator would give 0.0625.
    expect(view(h, NEXT_TEXTURE)?.alpha).toBeCloseTo(0.25, 6);
    h.run(200);
    await pending;
    expect(view(h, NEXT_TEXTURE)?.alpha).toBe(1);
    h.surface.dispose();
  });

  it("overlays a fade-through colour with the authored alpha and clears it afterwards", async () => {
    const h = await withBase();
    const pending = h.cue(
      cues.background(
        "next",
        { type: "fade_through_color", color: "#11223344" },
        160,
      ),
    );
    await flushMicrotasks();
    // Midpoint: the evaluator asks for a fully covering overlay, scaled by the
    // authored colour alpha instead of being drawn opaque.
    h.run(96);
    expect(h.transitionLayer()[0]).toBeInstanceOf(MemoryGraphics);
    expect(h.transitionLayer()[0]?.alpha).toBeCloseTo(68 / 255, 5);
    h.run(200);
    await pending;
    expect(h.transitionLayer()).toHaveLength(0);
    h.surface.dispose();
  });

  it("slides both backgrounds for a push and restores the hard path", async () => {
    const h = await withBase();
    const pending = h.cue(cues.background("next", push(0), 200));
    await flushMicrotasks();
    h.run(100);
    expect(view(h, NEXT_TEXTURE)?.position.x).toBeLessThan(CENTER_X);
    h.run(150);
    await pending;
    expect(view(h, NEXT_TEXTURE)?.position.x).toBeCloseTo(CENTER_X);
    h.surface.dispose();
  });

  it("masks a hard wipe without strips and clears the mask when the cue ends", async () => {
    const h = await withBase();
    const pending = h.cue(cues.background("next", wipe(0), 160));
    await flushMicrotasks();
    h.run(96);
    expect(liveMask(h, NEXT_TEXTURE)).not.toBeNull();
    expect(h.featherStrips()).toHaveLength(0);
    h.run(200);
    await pending;
    expect(view(h, NEXT_TEXTURE)?.mask?.label).toBe(LAYOUT_MASK);
    expect(view(h, NEXT_TEXTURE)?.alpha).toBe(1);
    h.surface.dispose();
  });

  it("keeps a soft wipe at the authored edge and draws a descending stepped feather ramp", async () => {
    const h = await withBase();
    const pending = h.cue(cues.background("next", wipe(0.25), 160));
    await flushMicrotasks();
    h.run(96);
    // Mid-transition the authored edge is at 0.5 * DESIGN_WIDTH and the
    // feather band spans softness * DESIGN_WIDTH around it: the binary stencil
    // draws the fully revealed part in front of the band, so a soft wipe never
    // leads or lags the hard edge.
    const half = (DESIGN_WIDTH * 0.25) / 2;
    expect(liveMask(h, NEXT_TEXTURE)?.rects[0]?.[2]).toBeCloseTo(
      CENTER_X - half,
      6,
    );
    const strips = h.featherStrips();
    expect(strips.length).toBeGreaterThan(1);
    const [bandStart, bandEnd] = stripBand(h, 0);
    expect(bandStart).toBeCloseTo(CENTER_X - half, 6);
    expect(bandEnd).toBeCloseTo(CENTER_X + half, 6);
    // Steps descend from the opaque side to the transparent side.
    const alphas = strips.map((strip) => strip.alpha);
    for (let index = 1; index < alphas.length; index += 1) {
      expect(alphas[index]).toBeLessThan(alphas[index - 1] ?? 0);
    }
    expect(alphas[0]).toBeLessThan(1);
    expect(alphas.at(-1)).toBeGreaterThan(0);
    h.run(200);
    await pending;
    // Every strip and its mask is released when the cue settles.
    expect(h.featherStrips()).toHaveLength(0);
    expect(view(h, NEXT_TEXTURE)?.mask?.label).toBe(LAYOUT_MASK);
    h.surface.dispose();
  });

  it("slides a soft push with an overlapping feather and releases it", async () => {
    const h = await withBase();
    const pending = h.cue(cues.background("next", push(0.25), 160));
    await flushMicrotasks();
    h.run(96);
    const half = (DESIGN_WIDTH * 0.25) / 2;
    // The incoming leads by half a feather; the outgoing lags by the same
    // amount so the ramp always blends into the outgoing's pixels.
    expect(view(h, NEXT_TEXTURE)?.position.x).toBeCloseTo(
      CENTER_X - DESIGN_WIDTH / 2 + half,
      6,
    );
    expect(view(h, BASE_TEXTURE)?.position.x).toBeCloseTo(
      CENTER_X + DESIGN_WIDTH / 2 - half,
      6,
    );
    expect(h.featherStrips().length).toBeGreaterThan(1);
    h.run(200);
    await pending;
    // The exact hard path is restored at the end of a soft push.
    expect(view(h, NEXT_TEXTURE)?.position.x).toBeCloseTo(CENTER_X, 6);
    expect(h.featherStrips()).toHaveLength(0);
    h.surface.dispose();
  });

  it("feathers a wipe and a push in all four directions", async () => {
    const h = await createSurface({ sizes: WIDE_SIZES });
    const directions = [
      "left_to_right",
      "right_to_left",
      "top_to_bottom",
      "bottom_to_top",
    ] as const;
    for (const direction of directions) {
      const horizontal =
        direction === "left_to_right" || direction === "right_to_left";
      const dimension = horizontal ? DESIGN_WIDTH : DESIGN_HEIGHT;
      const half = (dimension * 0.25) / 2;
      for (const type of ["wipe", "push"] as const) {
        await h.commit({ background: "base" });
        const pending = h.cue(
          cues.background("next", { type, direction, softness: 0.25 }, 160),
        );
        await flushMicrotasks();
        h.run(96);
        const [bandStart, bandEnd] = stripBand(h, horizontal ? 0 : 1);
        expect(bandStart).toBeCloseTo(dimension * 0.5 - half, 6);
        expect(bandEnd).toBeCloseTo(dimension * 0.5 + half, 6);
        h.run(300);
        await pending;
        expect(h.featherStrips()).toHaveLength(0);
      }
    }
    h.surface.dispose();
  });
});

describe("overlapping background transitions", () => {
  it("keeps the newer wipe's mask alive when the superseded wipe settles", async () => {
    const h = await withBase();
    const older = h.cue(cues.background("next", wipe(0), 240));
    await flushMicrotasks();
    h.run(96);

    const newer = h.cue(cues.background("other", wipe(0), 480));
    await flushMicrotasks();
    expect(liveMask(h, OTHER_TEXTURE)).not.toBeNull();

    // The older wipe finishes while the newer one is still running.  Its
    // cleanup must not detach or destroy the mask the newer cue installed.
    h.run(160);
    await older;
    await flushMicrotasks();
    const mask = liveMask(h, OTHER_TEXTURE);
    expect(mask).not.toBeNull();
    expect(mask?.destroyed).toBe(false);
    expect(mask?.rects[0]?.[2]).toBeCloseTo(DESIGN_WIDTH * 0.3, 6);

    // The newer wipe keeps revealing; a torn-down mask would freeze it hard.
    h.run(160);
    expect(liveMask(h, OTHER_TEXTURE)?.rects[0]?.[2]).toBeCloseTo(
      DESIGN_WIDTH * (304 / 480),
      6,
    );
    h.run(300);
    await newer;
    expect(liveMask(h, OTHER_TEXTURE)).toBeNull();
    h.surface.dispose();
  });

  it("keeps the newer fade-through overlay alive when the superseded one settles", async () => {
    const h = await withBase();
    const fade = { type: "fade_through_color", color: "#112233" } as const;
    const older = h.cue(cues.background("next", fade, 240));
    await flushMicrotasks();
    h.run(96);
    const newer = h.cue(cues.background("other", fade, 480));
    await flushMicrotasks();

    h.run(160);
    await older;
    await flushMicrotasks();
    // The newer cue replaced the overlay; the older cue's cleanup must leave
    // the newer overlay alone instead of blanking the transition.
    expect(h.transitionLayer()[0]).toBeInstanceOf(MemoryGraphics);
    expect(h.transitionLayer()[0]?.alpha).toBeGreaterThan(0);
    h.run(400);
    await newer;
    expect(h.transitionLayer()).toHaveLength(0);
    h.surface.dispose();
  });

  it("detaches a superseded wipe's mask before a push takes over", async () => {
    const h = await withBase();
    const older = h.cue(cues.background("next", wipe(0.2), 480));
    await flushMicrotasks();
    h.run(96);
    const olderIncoming = view(h, NEXT_TEXTURE);
    expect(olderIncoming?.mask).not.toBeNull();
    expect(h.featherStrips().length).toBeGreaterThan(0);

    // A different kind of transition takes the layer over.  The shared mask
    // must be detached from the superseded view before the push creates its
    // own (maskless) resources, otherwise the sliding-out background would
    // still be clipped by the wipe mask.
    const newer = h.cue(cues.background("other", push(0), 480));
    await flushMicrotasks();
    expect(olderIncoming?.mask?.label).toBe(LAYOUT_MASK);
    expect(h.featherStrips()).toHaveLength(0);

    // The superseded cue's own cleanup must not tear the newer push down.
    h.run(400);
    await older;
    await flushMicrotasks();
    const incoming = view(h, OTHER_TEXTURE);
    const positionBefore = incoming?.position.x ?? CENTER_X;
    expect(positionBefore).toBeLessThan(CENTER_X);
    await h.runAsync(64);
    expect(incoming?.position.x).toBeGreaterThan(positionBefore);
    h.run(300);
    await newer;
    expect(view(h, OTHER_TEXTURE)?.position.x).toBeCloseTo(CENTER_X, 6);
    h.surface.dispose();
  });

  it("replaces a superseded fade-through overlay before a soft wipe takes over", async () => {
    const h = await withBase();
    const older = h.cue(
      cues.background(
        "next",
        { type: "fade_through_color", color: "#112233" },
        480,
      ),
    );
    await flushMicrotasks();
    h.run(96);
    expect(h.transitionLayer()).toHaveLength(1);

    const newer = h.cue(cues.background("other", wipe(0.2), 480));
    await flushMicrotasks();
    // The take-over clears the old overlay and installs the newer mask.
    expect(h.transitionLayer()).toHaveLength(0);
    const incoming = view(h, OTHER_TEXTURE);
    expect(incoming?.mask).not.toBeNull();
    // The old cue's settle neither restores its overlay nor clears the mask.
    h.run(400);
    await older;
    await flushMicrotasks();
    expect(h.transitionLayer()).toHaveLength(0);
    expect(incoming?.mask).not.toBeNull();
    h.run(400);
    await newer;
    expect(h.featherStrips()).toHaveLength(0);
    expect(incoming?.mask?.label).toBe(LAYOUT_MASK);
    h.surface.dispose();
  });

  it("releases a live feather when a reset ends the generation", async () => {
    const h = await withBase();
    const pending = h.cue(cues.background("next", wipe(0.2), 480));
    await flushMicrotasks();
    h.run(96);
    expect(h.featherStrips().length).toBeGreaterThan(0);

    // A reset (host cancel) ends the generation: the strips, their masks and
    // the view mask must all be released, and the aborted cue must not
    // recreate any of them afterwards.
    h.surface.reset();
    h.run(600);
    await pending;
    expect(h.featherStrips()).toHaveLength(0);
    expect(
      h.backgrounds().every((background) => background.mask === null),
    ).toBe(true);
    h.surface.dispose();
  });
});

describe("reversed soft edges", () => {
  const SOFTNESS = 0.25;
  const DURATION_MS = 160;

  /** Steps one wipe/push cue to a non-midpoint sample and returns the run. */
  async function sampleCue(
    h: Harness,
    direction: TransitionDirection,
    type: "wipe" | "push",
    atMs: number,
  ): Promise<{ pending: Promise<void> }> {
    await h.commit({ background: "base" });
    const pending = h.cue(
      cues.background(
        "next",
        { type, direction, softness: SOFTNESS },
        DURATION_MS,
      ),
    );
    await flushMicrotasks();
    // The first tick only establishes the animation time origin, so the
    // second step lands exactly on `atMs / DURATION_MS` of progress.
    h.pump.step(0);
    await flushMicrotasks();
    h.pump.step(atMs);
    await flushMicrotasks();
    // The pending cue is handed over unwrapped: awaiting an async helper that
    // returns it directly would adopt the promise and deadlock the sample.
    return { pending };
  }

  /** Design-space span covered by one background view. */
  function imageSpan(background: MemorySprite, axis: 0 | 1): [number, number] {
    const position = axis === 0 ? background.position.x : background.position.y;
    const anchor = axis === 0 ? background.anchor.x : background.anchor.y;
    const texture = background.texture as MemoryTexture;
    const scale = axis === 0 ? background.scale.x : background.scale.y;
    const length = axis === 0 ? texture.width * scale : texture.height * scale;
    const start = position - anchor * length;
    return [start, start + length];
  }

  it("keeps a reversed wipe on the hard edge at a non-midpoint progress", async () => {
    const h = await createSurface({ sizes: WIDE_SIZES });
    const cases = [
      { direction: "right_to_left" as const, progress: 0.25, atMs: 40 },
      { direction: "bottom_to_top" as const, progress: 0.8, atMs: 128 },
    ];
    for (const { direction, progress, atMs } of cases) {
      const horizontal = direction === "right_to_left";
      const axis: 0 | 1 = horizontal ? 0 : 1;
      const dimension = horizontal ? DESIGN_WIDTH : DESIGN_HEIGHT;
      const { pending } = await sampleCue(h, direction, "wipe", atMs);
      const hard = wipeRect(direction, progress);
      const hardEdge = axis === 0 ? hard.x : hard.y;
      const half = Math.min(
        (SOFTNESS * dimension) / 2,
        hardEdge,
        dimension - hardEdge,
      );
      const [bandStart, bandEnd] = stripBand(h, axis);
      // The band is centred on the hard edge of the same instant (mirrored for
      // this direction): softness may only widen the edge, never move it.
      expect(bandStart).toBeCloseTo(hardEdge - half, 6);
      expect(bandEnd).toBeCloseTo(hardEdge + half, 6);
      // The opaque stencil region sits behind the band, flush with the
      // anchored stage boundary, so incoming pixels are fully opaque there.
      const incoming = view(h, NEXT_TEXTURE);
      const opaque = (incoming?.mask as MemoryGraphics).rects[0] ?? [
        0, 0, 0, 0,
      ];
      expect(opaque[axis]).toBeCloseTo(bandEnd, 6);
      expect(opaque[axis === 0 ? 2 : 3]).toBeCloseTo(dimension - bandEnd, 6);
      // The stepped alpha ramp points from the transparent low side to the
      // opaque high side of the reversed direction.
      const sorted = [...h.featherStrips()].sort(
        (a, b) =>
          ((a.mask as MemoryGraphics).rects[0]?.[axis] ?? 0) -
          ((b.mask as MemoryGraphics).rects[0]?.[axis] ?? 0),
      );
      expect(sorted[0]?.alpha).toBeLessThan(0.5);
      expect(sorted.at(-1)?.alpha).toBeGreaterThan(0.5);
      h.run(300);
      await pending;
      expect(h.featherStrips()).toHaveLength(0);
      expect(incoming?.mask?.label).toBe(LAYOUT_MASK);
    }
    h.surface.dispose();
  });

  it("keeps a reversed soft push covered at a non-midpoint progress", async () => {
    const h = await createSurface({ sizes: WIDE_SIZES });
    const cases = [
      { direction: "right_to_left" as const, progress: 0.75, atMs: 120 },
      { direction: "bottom_to_top" as const, progress: 0.2, atMs: 32 },
    ];
    for (const { direction, progress, atMs } of cases) {
      const horizontal = direction === "right_to_left";
      const axis: 0 | 1 = horizontal ? 0 : 1;
      const { pending } = await sampleCue(h, direction, "push", atMs);
      const frame = evaluateBackgroundTransition(
        { type: "push", direction, softness: SOFTNESS },
        progress,
        "linear",
      );
      const ramp = frame.mask?.ramp;
      if (ramp === null || ramp === undefined)
        throw new Error("软 push 必须返回 ramp");
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
      const incoming = view(h, NEXT_TEXTURE);
      const outgoing = view(h, BASE_TEXTURE);
      if (incoming === undefined || outgoing === undefined)
        throw new Error("缺少背景视图");
      const [incomingStart, incomingEnd] = imageSpan(incoming, axis);
      const [outgoingStart, outgoingEnd] = imageSpan(outgoing, axis);
      expect(ramp.startPx).toBeGreaterThanOrEqual(incomingStart - 1e-6);
      expect(ramp.startPx).toBeLessThanOrEqual(incomingEnd);
      expect(ramp.endPx).toBeGreaterThanOrEqual(outgoingStart);
      expect(ramp.endPx).toBeLessThanOrEqual(outgoingEnd + 1e-6);
      h.run(300);
      await pending;
      expect(h.featherStrips()).toHaveLength(0);
    }
    h.surface.dispose();
  });
});
