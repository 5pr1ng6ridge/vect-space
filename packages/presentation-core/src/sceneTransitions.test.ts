import { describe, expect, it } from "vitest";

import {
  FEATHER_STEPS,
  evaluateBackgroundTransition,
  evaluateCurtainTransition,
  featherBand,
  featherRamp,
  featherStepRect,
  featherSteps,
  fullStageRect,
  maskOpaqueRect,
  pushOffsets,
  splitRects,
  wipeRect,
  type StageMask,
} from "./sceneTransitions";
import { DESIGN_HEIGHT, DESIGN_WIDTH } from "./sceneFrame";
import type { TransitionDirection } from "./types";

/** Mask of one wipe instant, the way the surface consumes it. */
function stageMaskFor(
  direction: TransitionDirection,
  progress: number,
  softness: number,
): StageMask {
  const mask = evaluateBackgroundTransition(
    { type: "wipe", direction, softness },
    progress,
    "linear",
  ).mask;
  if (mask === null) throw new Error("wipe 必须返回蒙版");
  return mask;
}

describe("evaluateBackgroundTransition", () => {
  it("cuts instantly", () => {
    const frame = evaluateBackgroundTransition({ type: "cut" }, 0.5);
    expect(frame.incomingAlpha).toBe(1);
    expect(frame.outgoingAlpha).toBe(0);
    expect(frame.mask).toBeNull();
    expect(frame.overlay).toBeNull();
  });

  it("applies the cue easing to cross_fade", () => {
    const linear = evaluateBackgroundTransition(
      { type: "cross_fade" },
      0.25,
      "linear",
    );
    expect(linear.incomingAlpha).toBeCloseTo(0.25);
    expect(linear.outgoingAlpha).toBeCloseTo(0.75);
    const eased = evaluateBackgroundTransition(
      { type: "cross_fade" },
      0.25,
      "ease_out",
    );
    // The authored easing is actually used, not a hard-coded ease_in_out.
    expect(eased.incomingAlpha).not.toBeCloseTo(0.25);
  });

  it("fully covers with the fade-through colour at the midpoint", () => {
    const start = evaluateBackgroundTransition(
      { type: "fade_through_color", color: "#112233" },
      0,
    );
    expect(start.overlay).toEqual({ color: "#112233", alpha: 0 });
    expect(start.incomingAlpha).toBe(0);
    expect(start.outgoingAlpha).toBe(1);

    const middle = evaluateBackgroundTransition(
      { type: "fade_through_color", color: "#112233" },
      0.5,
    );
    expect(middle.overlay?.alpha).toBeCloseTo(1);

    const end = evaluateBackgroundTransition(
      { type: "fade_through_color", color: "#112233" },
      1,
    );
    expect(end.incomingAlpha).toBe(1);
    expect(end.outgoingAlpha).toBe(0);
    expect(end.overlay?.alpha).toBe(0);
  });

  it("masks the incoming background for a wipe", () => {
    const frame = evaluateBackgroundTransition(
      { type: "wipe", direction: "right_to_left", softness: 0.25 },
      0.5,
      "linear",
    );
    expect(frame.mask).toEqual({
      direction: "right_to_left",
      progress: 0.5,
      softness: 0.25,
      // The feather is a band centred on the authored edge, not an
      // accelerated hard edge; `ramp` is the same band in design pixels.
      feather: { start: 0.375, end: 0.625 },
      ramp: {
        axis: "x",
        startPx: DESIGN_WIDTH * 0.375,
        endPx: DESIGN_WIDTH * 0.625,
        widthPx: DESIGN_WIDTH * 0.25,
      },
    });
    expect(frame.incomingAlpha).toBe(1);
    expect(frame.outgoingAlpha).toBe(1);
  });

  it("keeps the wipe edge at the authored progress for every softness", () => {
    const hard = evaluateBackgroundTransition(
      { type: "wipe", direction: "left_to_right", softness: 0 },
      0.25,
      "linear",
    );
    expect(hard.mask?.progress).toBe(0.25);
    expect(hard.mask?.feather).toBeNull();
    expect(hard.mask?.ramp).toBeNull();

    const soft = evaluateBackgroundTransition(
      { type: "wipe", direction: "left_to_right", softness: 0.5 },
      0.25,
      "linear",
    );
    // Softness only describes the band around the edge: the covered fraction
    // stays `0.25`, so a soft wipe never leads a hard one, and the band is
    // centred on the authored edge instead of sliding along it.
    expect(soft.mask?.progress).toBe(0.25);
    expect(soft.mask?.feather).toEqual({ start: 0, end: 0.5 });
    expect(soft.mask?.ramp).toEqual({
      axis: "x",
      startPx: 0,
      endPx: DESIGN_WIDTH * 0.5,
      widthPx: DESIGN_WIDTH * 0.5,
    });
  });

  it("derives the feather band from progress and softness only", () => {
    expect(featherBand(0.5, 0)).toBeNull();
    expect(featherBand(0.5, -1)).toBeNull();
    expect(featherBand(0.5, 0.4)).toEqual({ start: 0.3, end: 0.7 });
    // A band that would leave the stage is clipped by compressing it towards
    // the boundary, never by sliding it along the edge: the authored edge
    // stays exactly at `progress` and the first/last frame is the hard path.
    expect(featherBand(0.05, 0.4)).toEqual({ start: 0, end: 0.1 });
    const nearEnd = featherBand(0.95, 0.4);
    expect(nearEnd?.start).toBeCloseTo(0.9);
    expect(nearEnd?.end).toBe(1);
    expect(featherBand(2, 0.4)).toBeNull();
    expect(featherBand(0, 0.4)).toBeNull();
  });

  it("draws the opaque region in front of the band", () => {
    // Horizontal, opened from the left: everything left of the band is fully
    // revealed; the band itself is drawn by the stepped strips.
    expect(maskOpaqueRect(stageMaskFor("left_to_right", 0.5, 0.4))).toEqual({
      x: 0,
      y: 0,
      width: DESIGN_WIDTH * 0.3,
      height: DESIGN_HEIGHT,
    });
    // Opened from the right: everything right of the band.
    expect(maskOpaqueRect(stageMaskFor("right_to_left", 0.5, 0.4))).toEqual({
      x: DESIGN_WIDTH * 0.7,
      y: 0,
      width: DESIGN_WIDTH * 0.3,
      height: DESIGN_HEIGHT,
    });
    // Vertical directions mirror on the y axis.
    expect(maskOpaqueRect(stageMaskFor("top_to_bottom", 0.5, 0.4))).toEqual({
      x: 0,
      y: 0,
      width: DESIGN_WIDTH,
      height: DESIGN_HEIGHT * 0.3,
    });
    expect(maskOpaqueRect(stageMaskFor("bottom_to_top", 0.5, 0.4))).toEqual({
      x: 0,
      y: DESIGN_HEIGHT * 0.7,
      width: DESIGN_WIDTH,
      height: DESIGN_HEIGHT * 0.3,
    });
    // The hard path is exactly the historic wipe rectangle.
    expect(maskOpaqueRect(stageMaskFor("left_to_right", 0.25, 0))).toEqual(
      wipeRect("left_to_right", 0.25),
    );
  });

  it("turns strips into stage rectangles along the mask axis", () => {
    const horizontal = stageMaskFor("left_to_right", 0.5, 0.4);
    const [firstHorizontal] = featherSteps(horizontal, 4);
    if (firstHorizontal === undefined) throw new Error("缺少条带");
    expect(featherStepRect(horizontal, firstHorizontal)).toEqual({
      x: firstHorizontal.startPx,
      y: 0,
      width: firstHorizontal.endPx - firstHorizontal.startPx,
      height: DESIGN_HEIGHT,
    });
    const vertical = stageMaskFor("bottom_to_top", 0.5, 0.4);
    const [firstVertical] = featherSteps(vertical, 4);
    if (firstVertical === undefined) throw new Error("缺少条带");
    expect(featherStepRect(vertical, firstVertical)).toEqual({
      x: 0,
      y: firstVertical.startPx,
      width: DESIGN_WIDTH,
      height: firstVertical.endPx - firstVertical.startPx,
    });
  });

  it("clips the feather ramp to the stage in design pixels", () => {
    const mid = featherRamp("left_to_right", 0.5, 0.4);
    expect(mid).toEqual({
      axis: "x",
      startPx: DESIGN_WIDTH * 0.3,
      endPx: DESIGN_WIDTH * 0.7,
      widthPx: DESIGN_WIDTH * 0.4,
    });
    // Half a band from the left boundary: the ramp is compressed towards the
    // boundary but the band still ends at the authored edge + half width.
    const nearStart = featherRamp("left_to_right", 0.05, 0.4);
    expect(nearStart?.startPx).toBe(0);
    expect(nearStart?.endPx).toBeCloseTo(DESIGN_WIDTH * 0.1, 6);
    expect(nearStart?.widthPx).toBeCloseTo(DESIGN_WIDTH * 0.1, 6);
    // Exactly on a boundary the ramp collapses: the transition's first and
    // last frame is the exact hard edge.
    expect(featherRamp("left_to_right", 0, 0.4)).toBeNull();
    expect(featherRamp("left_to_right", 1, 0.4)).toBeNull();
    // Vertical directions use the stage height.
    expect(featherRamp("top_to_bottom", 0.5, 0.2)?.widthPx).toBe(
      DESIGN_HEIGHT * 0.2,
    );
    expect(featherRamp("top_to_bottom", 0.5, 0)?.widthPx).toBeUndefined();
  });

  it("derives deterministic stepped strips from one ramp", () => {
    const mask = stageMaskFor("left_to_right", 0.5, 0.4);
    const steps = featherSteps(mask, 4);
    expect(steps).toHaveLength(4);
    expect(steps[0]?.alpha).toBeCloseTo(0.875);
    expect(steps[3]?.alpha).toBeCloseTo(0.125);
    // Contiguous, ordered along the axis and spanning the whole ramp.
    expect(steps[0]?.startPx).toBeCloseTo(mask.ramp?.startPx ?? -1);
    expect(steps[3]?.endPx).toBeCloseTo(mask.ramp?.endPx ?? -1);
    for (let index = 1; index < steps.length; index += 1) {
      expect(steps[index]?.startPx).toBeCloseTo(steps[index - 1]?.endPx ?? -1);
    }
    // A reversed direction flips the ramp instead of the strip order.
    const reverse = featherSteps(stageMaskFor("right_to_left", 0.5, 0.4), 4);
    expect(reverse[0]?.alpha).toBeCloseTo(0.125);
    expect(reverse[3]?.alpha).toBeCloseTo(0.875);
    // The hard path has no strips at all.
    expect(featherSteps(stageMaskFor("left_to_right", 0.5, 0), 4)).toHaveLength(
      0,
    );
  });

  it("never lets the strips leave the stage for any direction", () => {
    const directions = [
      "left_to_right",
      "right_to_left",
      "top_to_bottom",
      "bottom_to_top",
    ] as const;
    const dimension = (direction: (typeof directions)[number]): number =>
      direction === "left_to_right" || direction === "right_to_left"
        ? DESIGN_WIDTH
        : DESIGN_HEIGHT;
    for (const direction of directions) {
      for (const progress of [0, 0.05, 0.5, 0.95, 1]) {
        const mask = stageMaskFor(direction, progress, 0.3);
        for (const step of featherSteps(mask)) {
          expect(step.startPx).toBeGreaterThanOrEqual(0);
          expect(step.endPx).toBeLessThanOrEqual(dimension(direction));
          expect(step.alpha).toBeGreaterThan(0);
          expect(step.alpha).toBeLessThan(1);
        }
      }
    }
  });

  it("slides both backgrounds for a push", () => {
    const frame = evaluateBackgroundTransition(
      { type: "push", direction: "left_to_right", softness: 0 },
      0.5,
      "linear",
    );
    expect(frame.incomingOffset.x).toBeCloseTo(-DESIGN_WIDTH / 2);
    expect(frame.outgoingOffset.x).toBeCloseTo(DESIGN_WIDTH / 2);
    // Without softness the push stays the exact hard-edge slide.
    expect(frame.mask).toBeNull();
  });

  it("overlaps the push images by the feather width so the ramp blends into pixels", () => {
    const frame = evaluateBackgroundTransition(
      { type: "push", direction: "left_to_right", softness: 0.25 },
      0.5,
      "linear",
    );
    const half = (DESIGN_WIDTH * 0.25) / 2;
    expect(frame.mask?.ramp).toEqual({
      axis: "x",
      startPx: DESIGN_WIDTH * 0.5 - half,
      endPx: DESIGN_WIDTH * 0.5 + half,
      widthPx: DESIGN_WIDTH * 0.25,
    });
    // The incoming leads by half a feather and the outgoing lags by half, so
    // both images cover the whole band underneath/above each other.
    expect(frame.incomingOffset.x).toBeCloseTo(-DESIGN_WIDTH / 2 + half, 6);
    expect(frame.outgoingOffset.x).toBeCloseTo(DESIGN_WIDTH / 2 - half, 6);
    // The band stays centred on the authored eased edge.
    expect(frame.mask?.progress).toBe(0.5);
  });

  it("keeps the soft push on the hard path at both ends", () => {
    const start = evaluateBackgroundTransition(
      { type: "push", direction: "top_to_bottom", softness: 0.4 },
      0,
      "linear",
    );
    expect(start.mask).toBeNull();
    expect(start.incomingOffset).toEqual({ x: 0, y: -DESIGN_HEIGHT });
    expect(start.outgoingOffset).toEqual({ x: 0, y: 0 });
    const end = evaluateBackgroundTransition(
      { type: "push", direction: "top_to_bottom", softness: 0.4 },
      1,
      "linear",
    );
    expect(end.mask).toBeNull();
    expect(end.incomingOffset).toEqual({ x: 0, y: 0 });
    expect(end.outgoingOffset).toEqual({ x: 0, y: DESIGN_HEIGHT });
  });
});

describe("feather direction geometry", () => {
  const DIRECTIONS = [
    "left_to_right",
    "right_to_left",
    "top_to_bottom",
    "bottom_to_top",
  ] as const;
  /** Progress values where the mirrored and unmirrored edges differ. */
  const NON_MIDPOINT = [0.2, 0.25, 0.75, 0.8];
  const SOFTNESS = 0.25;

  function axisLength(direction: TransitionDirection): number {
    return direction === "left_to_right" || direction === "right_to_left"
      ? DESIGN_WIDTH
      : DESIGN_HEIGHT;
  }

  /** Leading edge of the hard wipe rectangle along the mask axis. */
  function hardEdgeOf(
    direction: TransitionDirection,
    progress: number,
  ): number {
    const rect = wipeRect(direction, progress);
    switch (direction) {
      case "left_to_right":
        return rect.x + rect.width;
      case "right_to_left":
        return rect.x;
      case "top_to_bottom":
        return rect.y + rect.height;
      case "bottom_to_top":
        return rect.y;
    }
  }

  it("centres the soft edge on the exact hard edge for all four directions", () => {
    for (const direction of DIRECTIONS) {
      const dimension = axisLength(direction);
      for (const progress of NON_MIDPOINT) {
        const mask = stageMaskFor(direction, progress, SOFTNESS);
        const ramp = mask.ramp;
        if (ramp === null) throw new Error("软 wipe 必须返回 ramp");
        const hardEdge = hardEdgeOf(direction, progress);
        const half = Math.min(
          (SOFTNESS * dimension) / 2,
          hardEdge,
          dimension - hardEdge,
        );
        // Softness only widens the band around the authored edge: the centre
        // stays exactly on the edge of the `softness 0` hard path (the
        // historic `wipeRect`), mirrored for the reversed directions.
        expect(ramp.startPx + ramp.endPx).toBeCloseTo(2 * hardEdge, 6);
        expect(ramp.endPx - ramp.startPx).toBeCloseTo(2 * half, 6);
        expect(ramp.startPx).toBeGreaterThanOrEqual(0);
        expect(ramp.endPx).toBeLessThanOrEqual(dimension);
        // The normalised `feather` field is the same band in stage fractions.
        expect(mask.feather?.start).toBeCloseTo(ramp.startPx / dimension, 6);
        expect(mask.feather?.end).toBeCloseTo(ramp.endPx / dimension, 6);
      }
    }
  });

  it("keeps the opaque region inside the hard rectangle and preserves coverage", () => {
    for (const direction of DIRECTIONS) {
      const dimension = axisLength(direction);
      const horizontal =
        direction === "left_to_right" || direction === "right_to_left";
      const forward =
        direction === "left_to_right" || direction === "top_to_bottom";
      const cross = horizontal ? DESIGN_HEIGHT : DESIGN_WIDTH;
      for (const progress of NON_MIDPOINT) {
        const mask = stageMaskFor(direction, progress, SOFTNESS);
        const ramp = mask.ramp;
        if (ramp === null) throw new Error("软 wipe 必须返回 ramp");
        const hard = wipeRect(direction, progress);
        const opaque = maskOpaqueRect(mask);
        // Flush with the anchored stage edge and closed by the band boundary.
        if (horizontal) {
          expect(opaque.y).toBe(0);
          expect(opaque.height).toBe(DESIGN_HEIGHT);
          expect(opaque.x).toBeCloseTo(forward ? 0 : ramp.endPx, 6);
          expect(opaque.x + opaque.width).toBeCloseTo(
            forward ? ramp.startPx : DESIGN_WIDTH,
            6,
          );
        } else {
          expect(opaque.x).toBe(0);
          expect(opaque.width).toBe(DESIGN_WIDTH);
          expect(opaque.y).toBeCloseTo(forward ? 0 : ramp.endPx, 6);
          expect(opaque.y + opaque.height).toBeCloseTo(
            forward ? ramp.startPx : DESIGN_HEIGHT,
            6,
          );
        }
        // A soft wipe never reveals anything outside the same instant's hard
        // rectangle; only the band spends part of its width.
        expect(opaque.x).toBeGreaterThanOrEqual(hard.x - 1e-6);
        expect(opaque.y).toBeGreaterThanOrEqual(hard.y - 1e-6);
        expect(opaque.x + opaque.width).toBeLessThanOrEqual(
          hard.x + hard.width + 1e-6,
        );
        expect(opaque.y + opaque.height).toBeLessThanOrEqual(
          hard.y + hard.height + 1e-6,
        );
        // The stepped strips plus the opaque region integrate to exactly the
        // hard-path coverage (the ramp is linear and centred on the edge).
        let softArea = opaque.width * opaque.height;
        for (const step of featherSteps(mask)) {
          softArea += (step.endPx - step.startPx) * cross * step.alpha;
        }
        const hardArea = hard.width * hard.height;
        expect(Math.abs(softArea - hardArea) / hardArea).toBeLessThan(1e-9);
      }
    }
  });

  it("keeps the soft push band covered by both images at non-midpoint progress", () => {
    for (const direction of DIRECTIONS) {
      const horizontal =
        direction === "left_to_right" || direction === "right_to_left";
      const dimension = axisLength(direction);
      for (const progress of NON_MIDPOINT) {
        const frame = evaluateBackgroundTransition(
          { type: "push", direction, softness: SOFTNESS },
          progress,
          "linear",
        );
        const ramp = frame.mask?.ramp;
        if (ramp === null || ramp === undefined) {
          throw new Error("软 push 必须返回 ramp");
        }
        const incoming = horizontal
          ? frame.incomingOffset.x
          : frame.incomingOffset.y;
        const outgoingEnd =
          (horizontal ? frame.outgoingOffset.x : frame.outgoingOffset.y) +
          dimension;
        // The band must lie inside the overlap of the two shifted images, so
        // every strip blends into real outgoing pixels instead of exposing the
        // bare canvas between the outgoing tail and the incoming lead.
        expect(ramp.startPx).toBeGreaterThanOrEqual(incoming - 1e-6);
        expect(ramp.endPx).toBeLessThanOrEqual(outgoingEnd + 1e-6);
        // The reversed directions lead with the incoming edge exactly on the
        // side where the outgoing image ends (mirror of the forward slide).
        if (direction === "right_to_left" || direction === "bottom_to_top") {
          expect(ramp.startPx).toBeCloseTo(incoming, 6);
          expect(ramp.endPx).toBeCloseTo(outgoingEnd, 6);
        }
      }
    }
  });

  it("ramps the strip alpha from the opaque side into the transparent one", () => {
    for (const direction of DIRECTIONS) {
      const mask = stageMaskFor(direction, 0.25, 0.4);
      const steps = featherSteps(mask, FEATHER_STEPS);
      expect(steps).toHaveLength(FEATHER_STEPS);
      const forward =
        direction === "left_to_right" || direction === "top_to_bottom";
      for (let index = 1; index < steps.length; index += 1) {
        const previous = steps[index - 1];
        const current = steps[index];
        if (previous === undefined || current === undefined) {
          throw new Error("缺少条带");
        }
        // Forward directions are opaque at the low side, reversed ones at the
        // high side; the band must never flip its alpha ramp.
        if (forward) {
          expect(current.alpha).toBeLessThan(previous.alpha);
        } else {
          expect(current.alpha).toBeGreaterThan(previous.alpha);
        }
      }
    }
  });
});

describe("pushOffsets", () => {
  it("moves both images edge to edge for all four directions", () => {
    const half = pushOffsets("left_to_right", 0.5);
    expect(half.incomingOffset).toEqual({ x: -DESIGN_WIDTH / 2, y: 0 });
    expect(half.outgoingOffset).toEqual({ x: DESIGN_WIDTH / 2, y: 0 });

    const reverse = pushOffsets("right_to_left", 0.5);
    expect(reverse.incomingOffset.x).toBeCloseTo(DESIGN_WIDTH / 2);
    expect(reverse.outgoingOffset.x).toBeCloseTo(-DESIGN_WIDTH / 2);

    const down = pushOffsets("top_to_bottom", 0.5);
    expect(down.incomingOffset.y).toBeCloseTo(-DESIGN_HEIGHT / 2);
    expect(down.outgoingOffset.y).toBeCloseTo(DESIGN_HEIGHT / 2);

    const up = pushOffsets("bottom_to_top", 0.5);
    expect(up.incomingOffset.y).toBeCloseTo(DESIGN_HEIGHT / 2);
    expect(up.outgoingOffset.y).toBeCloseTo(-DESIGN_HEIGHT / 2);
  });
});

describe("wipeRect", () => {
  it("anchors the covered region on the named edge", () => {
    expect(wipeRect("left_to_right", 0.5)).toEqual({
      x: 0,
      y: 0,
      width: DESIGN_WIDTH / 2,
      height: DESIGN_HEIGHT,
    });
    expect(wipeRect("right_to_left", 0.5)).toEqual({
      x: DESIGN_WIDTH / 2,
      y: 0,
      width: DESIGN_WIDTH / 2,
      height: DESIGN_HEIGHT,
    });
    expect(wipeRect("top_to_bottom", 0.5)).toEqual({
      x: 0,
      y: 0,
      width: DESIGN_WIDTH,
      height: DESIGN_HEIGHT / 2,
    });
    expect(wipeRect("bottom_to_top", 0.5)).toEqual({
      x: 0,
      y: DESIGN_HEIGHT / 2,
      width: DESIGN_WIDTH,
      height: DESIGN_HEIGHT / 2,
    });
  });
});

describe("evaluateCurtainTransition", () => {
  it("fades the cover in and out", () => {
    expect(
      evaluateCurtainTransition({ type: "fade" }, "cover", 0.5),
    ).toMatchObject({ alpha: 0.5, rects: [fullStageRect()] });
    expect(
      evaluateCurtainTransition({ type: "fade" }, "reveal", 0.5).alpha,
    ).toBeCloseTo(0.5);
    expect(evaluateCurtainTransition({ type: "fade" }, "reveal", 0).alpha).toBe(
      1,
    );
  });

  it("grows a wipe for cover and shrinks it for reveal", () => {
    const cover = evaluateCurtainTransition(
      { type: "wipe", direction: "bottom_to_top" },
      "cover",
      0.5,
    );
    expect(cover.alpha).toBe(1);
    expect(cover.rects[0]?.height).toBeCloseTo(DESIGN_HEIGHT / 2);

    const reveal = evaluateCurtainTransition(
      { type: "wipe", direction: "bottom_to_top" },
      "reveal",
      0.25,
    );
    // Reveal keeps the remaining 75% covered.
    expect(reveal.rects[0]?.height).toBeCloseTo(DESIGN_HEIGHT * 0.75);
  });

  it("closes and opens from the middle for the split transitions", () => {
    const horizontal = evaluateCurtainTransition(
      { type: "split_horizontal" },
      "cover",
      1,
    );
    expect(horizontal.rects).toHaveLength(2);
    expect(horizontal.rects[0]?.height).toBeCloseTo(DESIGN_HEIGHT / 2);

    const half = evaluateCurtainTransition(
      { type: "split_vertical" },
      "cover",
      0.5,
    );
    expect(half.rects[0]?.width).toBeCloseTo(DESIGN_WIDTH / 4);
    expect(splitRects(false, 1)[1]?.x).toBeCloseTo(DESIGN_WIDTH / 2);
  });

  it("clamps out-of-range progress", () => {
    expect(evaluateCurtainTransition({ type: "fade" }, "cover", 5).alpha).toBe(
      1,
    );
    expect(evaluateCurtainTransition({ type: "fade" }, "cover", -1).alpha).toBe(
      0,
    );
  });
});
