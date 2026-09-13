/**
 * Pure background/curtain transition evaluation.
 *
 * The surface only applies the returned geometry; every formula (easing,
 * ramps, offsets, the fade-through-colour overlay) lives here so the game and
 * the editor preview are guaranteed to derive identical state from the same
 * playhead.
 */

import { DESIGN_HEIGHT, DESIGN_WIDTH } from "./sceneFrame";
import { applyEasing } from "./timeline";
import type {
  BackgroundTransitionSpec,
  CurtainAction,
  CurtainTransitionSpec,
  Easing,
  TransitionDirection,
} from "./types";

/** Deterministic step count of the stepped feather ramp. */
export const FEATHER_STEPS = 8;

export interface StageOffset {
  x: number;
  y: number;
}

/** Feather band of one wipe/push edge in design pixels. */
export interface StageFeatherRamp {
  axis: "x" | "y";
  /** Start of the ramp along the axis, design px. */
  startPx: number;
  /** End of the ramp along the axis, design px. */
  endPx: number;
  /** `softness * the stage dimension`, clipped by the stage boundaries. */
  widthPx: number;
}

export interface StageMask {
  direction: TransitionDirection;
  /** Position of the leading edge of the revealed region, `0..1`. */
  progress: number;
  /** Normalised feather width requested by the author, `0..1`. */
  softness: number;
  /**
   * Deterministic feather band centred on the authored hard edge, or `null`
   * for a hard edge.  The hard edge is mirrored for `right_to_left` and
   * `bottom_to_top`, so a soft transition stays on exactly the same edge as
   * `softness 0`.  This is pure geometry: the renderer decides how much of the
   * band it can actually draw, and the edge itself never moves.
   */
  feather: { start: number; end: number } | null;
  /**
   * The same band in design pixels plus the axis it runs along.  `null` on the
   * hard edge (`softness 0`, or an edge exactly on a stage boundary where the
   * band would have to leave the stage).
   */
  ramp: StageFeatherRamp | null;
}

export interface BackgroundTransitionFrame {
  incomingAlpha: number;
  outgoingAlpha: number;
  incomingOffset: StageOffset;
  outgoingOffset: StageOffset;
  /**
   * Wipe/soft-push mask; `null` when the transition is purely alpha/offset or
   * a push without softness (which is the exact hard-edge path).
   */
  mask: StageMask | null;
  /** `fade_through_color` overlay; `null` for every other transition. */
  overlay: { color: string; alpha: number } | null;
}

export interface CurtainRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CurtainTransitionFrame {
  /** Alpha of the curtain fill; used by `fade`. */
  alpha: number;
  /** Screen-space regions currently covered by the curtain. */
  rects: CurtainRect[];
}

/** One strip of the stepped feather ramp. */
export interface StageFeatherStep {
  /** Strip start along the mask axis, design px. */
  startPx: number;
  /** Strip end along the mask axis, design px. */
  endPx: number;
  /** Incoming alpha for this strip: the ramp value at the strip midpoint. */
  alpha: number;
}

const NO_OFFSET: StageOffset = { x: 0, y: 0 };

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function axisOf(direction: TransitionDirection): "x" | "y" {
  return direction === "left_to_right" || direction === "right_to_left"
    ? "x"
    : "y";
}

/** True when the low-coordinate side of the mask axis is the opaque side. */
function opaqueLow(direction: TransitionDirection): boolean {
  return direction === "left_to_right" || direction === "top_to_bottom";
}

/**
 * Normalised position of the authored hard edge along the mask axis.
 *
 * The hard path anchors the revealed region on the named edge (see
 * `wipeRect`), so `right_to_left` and `bottom_to_top` measure the edge from
 * the opposite boundary.  Mirroring the edge here is what keeps a soft
 * wipe/push on the exact same edge as `softness 0`.
 */
function edgeFraction(
  direction: TransitionDirection,
  progress: number,
): number {
  const p = clamp01(progress);
  return opaqueLow(direction) ? p : 1 - p;
}

/**
 * One instant of a background transition.
 *
 * `rawProgress` is the untransformed `0..1` position; `easing` is applied
 * inside so `cross_fade` honours the authored `cue.easing` exactly like every
 * other timed cue.
 */
export function evaluateBackgroundTransition(
  spec: BackgroundTransitionSpec,
  rawProgress: number,
  easing: Easing = "ease_in_out",
): BackgroundTransitionFrame {
  const progress = applyEasing(clamp01(rawProgress), easing);
  switch (spec.type) {
    case "cut":
      return {
        incomingAlpha: 1,
        outgoingAlpha: 0,
        incomingOffset: NO_OFFSET,
        outgoingOffset: NO_OFFSET,
        mask: null,
        overlay: null,
      };
    case "cross_fade":
      return {
        incomingAlpha: progress,
        outgoingAlpha: 1 - progress,
        incomingOffset: NO_OFFSET,
        outgoingOffset: NO_OFFSET,
        mask: null,
        overlay: null,
      };
    case "fade_through_color":
      return {
        // The colour fully covers the stage at the midpoint, so the outgoing
        // image is hidden before the incoming one starts to show.
        incomingAlpha: clamp01(2 * progress - 1),
        outgoingAlpha: clamp01(1 - 2 * progress),
        incomingOffset: NO_OFFSET,
        outgoingOffset: NO_OFFSET,
        mask: null,
        overlay: { color: spec.color, alpha: 1 - Math.abs(2 * progress - 1) },
      };
    case "wipe":
      return {
        incomingAlpha: 1,
        outgoingAlpha: 1,
        incomingOffset: NO_OFFSET,
        outgoingOffset: NO_OFFSET,
        mask: stageMask(spec.direction, progress, spec.softness),
        overlay: null,
      };
    case "push": {
      const mask = stageMask(spec.direction, progress, spec.softness);
      // A soft push lets the two images overlap by the feather width so the
      // ramp always blends into real pixels of the outgoing image instead of
      // into the empty canvas.  The overlap is zero at both ends, so the first
      // and last frame stay exactly on the hard path.
      const overlap = mask?.ramp?.widthPx ?? 0;
      const { incomingOffset, outgoingOffset } = pushOffsets(
        spec.direction,
        progress,
        overlap,
      );
      return {
        incomingAlpha: 1,
        outgoingAlpha: 1,
        incomingOffset,
        outgoingOffset,
        // Without a band the push is the plain hard-edge slide.
        mask: mask.ramp === null ? null : mask,
        overlay: null,
      };
    }
  }
}

/** Mask of one wipe/push edge, band included. */
function stageMask(
  direction: TransitionDirection,
  progress: number,
  softness: number,
): StageMask {
  const ramp = featherRamp(direction, progress, softness);
  return {
    direction,
    progress,
    softness: clamp01(softness),
    // Same edge and clipping as `featherRamp` (both are derived from the
    // mirrored edge fraction and the stage boundary distances), just
    // normalised for the pure tests.
    feather: featherBand(edgeFraction(direction, progress), softness),
    ramp,
  };
}

/**
 * Feather band of one wipe edge.
 *
 * `edge` is the normalised position of the authored hard edge along the mask
 * axis (`progress` for `left_to_right`/`top_to_bottom`, `1 - progress` for
 * the reversed directions); `softness` is the total normalised width of the
 * ramp and the edge sits at its centre.  The band is clipped by the stage
 * instead of being slid along it: when the edge is closer to a boundary than
 * half the authored width, the ramp compresses towards that boundary and
 * collapses exactly on it.  The incoming image therefore never bleeds in
 * before the transition starts and never leaves a blended strip behind when
 * it ends, while the edge itself always stays at `edge`.  Returns `null` on
 * the hard edge.
 */
export function featherBand(
  edge: number,
  softness: number,
): { start: number; end: number } | null {
  const width = clamp01(softness);
  if (width <= 0) return null;
  const center = clamp01(edge);
  const half = Math.min(width / 2, center, 1 - center);
  if (half <= 0) return null;
  return { start: center - half, end: center + half };
}

/**
 * The same feather band in design pixels.
 *
 * `widthPx` is `softness * the stage dimension` (the horizontal extent for a
 * left/right wipe, the vertical extent for a top/bottom one) clipped by the
 * stage; the band stays centred on the authored hard edge, which is mirrored
 * for the reversed directions so a soft transition never moves the edge.
 */
export function featherRamp(
  direction: TransitionDirection,
  progress: number,
  softness: number,
): StageFeatherRamp | null {
  const width = clamp01(softness);
  if (width <= 0) return null;
  const axis = axisOf(direction);
  const dimension = axis === "x" ? DESIGN_WIDTH : DESIGN_HEIGHT;
  const edge = edgeFraction(direction, progress) * dimension;
  const half = Math.min((width * dimension) / 2, edge, dimension - edge);
  if (half <= 0) return null;
  return {
    axis,
    startPx: edge - half,
    endPx: edge + half,
    widthPx: 2 * half,
  };
}

/**
 * Stepped approximation of one feather ramp.
 *
 * Pixi's stencil masks are binary, so the shared render kit draws the ramp as
 * a fixed number of strips whose alpha steps through it.  Deriving the strips
 * from this pure function (instead of from per-frame renderer state) keeps the
 * drawing reproducible from the playhead alone, and the two hosts agree on the
 * exact same bands.  The strips are ordered along the mask axis; `alpha` is the
 * incoming image's alpha inside the strip.
 */
export function featherSteps(
  mask: StageMask,
  steps: number = FEATHER_STEPS,
): StageFeatherStep[] {
  const ramp = mask.ramp;
  if (ramp === null || steps <= 0) return [];
  const size = ramp.widthPx / steps;
  if (!(size > 0)) return [];
  const low = opaqueLow(mask.direction);
  const result: StageFeatherStep[] = [];
  for (let index = 0; index < steps; index += 1) {
    const startPx = ramp.startPx + index * size;
    const endPx = index === steps - 1 ? ramp.endPx : startPx + size;
    // The authored ramp runs from the opaque side to the transparent side, so
    // the strip alpha is the linear ramp sampled at the strip midpoint.
    const t = (index + 0.5) / steps;
    result.push({ startPx, endPx, alpha: low ? 1 - t : t });
  }
  return result;
}

/**
 * Region of a wipe/soft-push mask that is fully revealed (incoming alpha 1).
 *
 * On the hard path this is the plain wipe rectangle; with a ramp it is the
 * region in front of the band, so the binary stencil draws exactly the opaque
 * part and the stepped strips draw the band on top.
 */
export function maskOpaqueRect(mask: StageMask): CurtainRect {
  const ramp = mask.ramp;
  if (ramp === null) return wipeRect(mask.direction, mask.progress);
  if (ramp.axis === "x") {
    return opaqueLow(mask.direction)
      ? { x: 0, y: 0, width: ramp.startPx, height: DESIGN_HEIGHT }
      : {
          x: ramp.endPx,
          y: 0,
          width: DESIGN_WIDTH - ramp.endPx,
          height: DESIGN_HEIGHT,
        };
  }
  return opaqueLow(mask.direction)
    ? { x: 0, y: 0, width: DESIGN_WIDTH, height: ramp.startPx }
    : {
        x: 0,
        y: ramp.endPx,
        width: DESIGN_WIDTH,
        height: DESIGN_HEIGHT - ramp.endPx,
      };
}

/** Stage-space rectangle of one feather strip. */
export function featherStepRect(
  mask: StageMask,
  step: StageFeatherStep,
): CurtainRect {
  const axis = mask.ramp?.axis ?? axisOf(mask.direction);
  const width = Math.max(0, step.endPx - step.startPx);
  if (axis === "x") {
    return { x: step.startPx, y: 0, width, height: DESIGN_HEIGHT };
  }
  return { x: 0, y: step.startPx, width: DESIGN_WIDTH, height: width };
}

/**
 * Offsets for one push instant; both images slide together edge-to-edge.
 *
 * `overlapPx` is the extra overlap of a soft push: the incoming leads by half
 * the feather and the outgoing lags by half, so the band is always backed by
 * the outgoing image.  `0` (the default) is the exact hard-edge slide.
 */
export function pushOffsets(
  direction: TransitionDirection,
  progress: number,
  overlapPx = 0,
): { incomingOffset: StageOffset; outgoingOffset: StageOffset } {
  const shift = Number.isFinite(overlapPx) ? Math.max(0, overlapPx) / 2 : 0;
  switch (direction) {
    case "left_to_right":
      return {
        incomingOffset: { x: (progress - 1) * DESIGN_WIDTH + shift, y: 0 },
        outgoingOffset: { x: progress * DESIGN_WIDTH - shift, y: 0 },
      };
    case "right_to_left":
      return {
        incomingOffset: { x: (1 - progress) * DESIGN_WIDTH - shift, y: 0 },
        outgoingOffset: { x: -progress * DESIGN_WIDTH + shift, y: 0 },
      };
    case "top_to_bottom":
      return {
        incomingOffset: { x: 0, y: (progress - 1) * DESIGN_HEIGHT + shift },
        outgoingOffset: { x: 0, y: progress * DESIGN_HEIGHT - shift },
      };
    case "bottom_to_top":
      return {
        incomingOffset: { x: 0, y: (1 - progress) * DESIGN_HEIGHT - shift },
        outgoingOffset: { x: 0, y: -progress * DESIGN_HEIGHT + shift },
      };
  }
}

/**
 * One instant of a curtain cover/reveal.
 *
 * `action` decides whether the covered fraction grows or shrinks, so the same
 * `split_horizontal` covers from the middle outwards and reveals back towards
 * the middle without a second spec.
 */
export function evaluateCurtainTransition(
  spec: CurtainTransitionSpec,
  action: CurtainAction,
  rawProgress: number,
): CurtainTransitionFrame {
  const progress = clamp01(rawProgress);
  const covered = action === "cover" ? progress : 1 - progress;
  switch (spec.type) {
    case "fade":
      return { alpha: covered, rects: [fullStageRect()] };
    case "wipe":
      return { alpha: 1, rects: [wipeRect(spec.direction, covered)] };
    case "split_horizontal":
      return { alpha: 1, rects: splitRects(true, covered) };
    case "split_vertical":
      return { alpha: 1, rects: splitRects(false, covered) };
  }
}

export function fullStageRect(): CurtainRect {
  return { x: 0, y: 0, width: DESIGN_WIDTH, height: DESIGN_HEIGHT };
}

/** Anchored wipe rectangle for one covered fraction. */
export function wipeRect(
  direction: TransitionDirection,
  covered: number,
): CurtainRect {
  const fraction = clamp01(covered);
  switch (direction) {
    case "left_to_right":
      return {
        x: 0,
        y: 0,
        width: DESIGN_WIDTH * fraction,
        height: DESIGN_HEIGHT,
      };
    case "right_to_left":
      return {
        x: DESIGN_WIDTH * (1 - fraction),
        y: 0,
        width: DESIGN_WIDTH * fraction,
        height: DESIGN_HEIGHT,
      };
    case "top_to_bottom":
      return {
        x: 0,
        y: 0,
        width: DESIGN_WIDTH,
        height: DESIGN_HEIGHT * fraction,
      };
    case "bottom_to_top":
      return {
        x: 0,
        y: DESIGN_HEIGHT * (1 - fraction),
        width: DESIGN_WIDTH,
        height: DESIGN_HEIGHT * fraction,
      };
  }
}

/** Two rectangles that close on / open from the middle of one axis. */
export function splitRects(
  horizontal: boolean,
  covered: number,
): CurtainRect[] {
  const fraction = clamp01(covered);
  if (horizontal) {
    const half = (DESIGN_HEIGHT / 2) * fraction;
    return [
      { x: 0, y: 0, width: DESIGN_WIDTH, height: half },
      { x: 0, y: DESIGN_HEIGHT - half, width: DESIGN_WIDTH, height: half },
    ];
  }
  const half = (DESIGN_WIDTH / 2) * fraction;
  return [
    { x: 0, y: 0, width: half, height: DESIGN_HEIGHT },
    { x: DESIGN_WIDTH - half, y: 0, width: half, height: DESIGN_HEIGHT },
  ];
}
