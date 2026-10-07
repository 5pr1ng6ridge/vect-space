/**
 * Pure geometry for the particle generation point and generation area.
 *
 * The inspector and the particle workspace draw a point marker (and, for a
 * rectangle definition, a resizable area) above the shared stage canvas.  The
 * overlay only wires pointer events; every rule that turns pointer positions
 * into a coordinate or a size lives here so it can be unit tested without
 * React or Pixi:
 *
 * - all points are design-space stage points (1920x1080), the same space
 *   `stagePointFromClientPoint` produces,
 * - a world-space emitter is shown through the camera and dragged through the
 *   inverse camera, a screen-space emitter ignores the camera (the same rule
 *   the Sprite drag uses, see `stageEdit.ts`),
 * - the rectangle area is centred on the generation point, so dragging one
 *   edge changes the full side length by twice the pointer displacement.
 */

import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  worldPointToStage,
} from "@vectspace/presentation-core/scene-frame";
import type { CameraSnapshot } from "@vectspace/presentation-core/types";
import type { CoordinateSpace } from "@vectspace/presentation-core/visual";

import { dragWorldPosition, type StagePoint } from "../stageEdit";

/** Largest side the particle validator accepts (`validateParticleDefinition`). */
export const MAX_AREA_SIDE = 16384;

export interface AreaSize {
  width: number;
  height: number;
}

export interface StageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type AreaHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** Corners last, so a corner stays on top when a zero side stacks handles. */
export const AREA_HANDLES: readonly AreaHandle[] = [
  "n",
  "s",
  "w",
  "e",
  "nw",
  "ne",
  "sw",
  "se",
];

export const AREA_HANDLE_LABELS: Record<AreaHandle, string> = {
  n: "上边",
  s: "下边",
  w: "左边",
  e: "右边",
  nw: "左上角",
  ne: "右上角",
  sw: "左下角",
  se: "右下角",
};

/** Which sides a handle moves: `-1` the low edge, `1` the high edge. */
export function handleAxes(handle: AreaHandle): {
  x: -1 | 0 | 1;
  y: -1 | 0 | 1;
} {
  return {
    x: handle.includes("w") ? -1 : handle.includes("e") ? 1 : 0,
    y: handle.includes("n") ? -1 : handle.includes("s") ? 1 : 0,
  };
}

/** The area rectangle on the stage; it is centred on the generation point. */
export function areaStageBox(
  center: StagePoint,
  area: AreaSize,
  scale = 1,
): StageBox {
  const width = area.width * scale;
  const height = area.height * scale;
  return {
    left: center.x - width / 2,
    top: center.y - height / 2,
    width,
    height,
  };
}

/** Stage position of one resize handle (edge midpoint or corner). */
export function areaHandlePoint(
  center: StagePoint,
  area: AreaSize,
  handle: AreaHandle,
  scale = 1,
): StagePoint {
  const axes = handleAxes(handle);
  return {
    x: center.x + (axes.x * area.width * scale) / 2,
    y: center.y + (axes.y * area.height * scale) / 2,
  };
}

function clampSide(value: number): number {
  return Math.min(MAX_AREA_SIDE, Math.max(0, Math.round(value)));
}

/**
 * Area size after dragging `handle` from `pointerDown` to `pointerNow`.
 *
 * The handle keeps its grab offset (only the displacement counts), an edge
 * handle leaves the other side untouched, and a side may legitimately reach
 * zero (a vertical line or a horizontal band is a valid emitter).  Sides are
 * whole design pixels inside the validator's `0..16384` range, so a drag can
 * never author a value the project would reject.
 */
export function resizeAreaFromHandle(input: {
  handle: AreaHandle;
  area: AreaSize;
  /** Emitter scale on the stage; the area is shown multiplied by it. */
  scale?: number;
  pointerDown: StagePoint;
  pointerNow: StagePoint;
}): AreaSize {
  const scale = input.scale === undefined || input.scale <= 0 ? 1 : input.scale;
  const axes = handleAxes(input.handle);
  const dx = (input.pointerNow.x - input.pointerDown.x) / scale;
  const dy = (input.pointerNow.y - input.pointerDown.y) / scale;
  return {
    width:
      axes.x === 0
        ? input.area.width
        : clampSide(input.area.width + 2 * axes.x * dx),
    height:
      axes.y === 0
        ? input.area.height
        : clampSide(input.area.height + 2 * axes.y * dy),
  };
}

export function sameAreaSize(left: AreaSize, right: AreaSize): boolean {
  return left.width === right.width && left.height === right.height;
}

/** Where an emitter's generation point appears on the stage. */
export function emitterStagePoint(
  emitter: { space: CoordinateSpace; x: number; y: number },
  camera: CameraSnapshot,
): StagePoint {
  return emitter.space === "screen"
    ? { x: emitter.x, y: emitter.y }
    : worldPointToStage({ x: emitter.x, y: emitter.y }, camera);
}

/**
 * Authored position an emitter lands on after a drag.
 *
 * A screen-space emitter moves by the raw design-pixel displacement; a
 * world-space emitter moves by the *world* displacement of the pointer, which
 * the inverse camera turns from design pixels (zoom and rotation included).
 */
export function emitterDragPosition(input: {
  space: CoordinateSpace;
  origin: StagePoint;
  pointerDown: StagePoint;
  pointerNow: StagePoint;
  camera: CameraSnapshot;
}): StagePoint {
  if (input.space === "screen") {
    return {
      x: input.origin.x + input.pointerNow.x - input.pointerDown.x,
      y: input.origin.y + input.pointerNow.y - input.pointerDown.y,
    };
  }
  return dragWorldPosition({
    origin: input.origin,
    pointerDown: input.pointerDown,
    pointerNow: input.pointerNow,
    camera: input.camera,
  });
}

/** Whole design pixels, the precision every authored x/y is stored at. */
export function roundedPosition(point: StagePoint): StagePoint {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

export function clampToStage(point: StagePoint): StagePoint {
  return {
    x: Math.min(DESIGN_WIDTH, Math.max(0, point.x)),
    y: Math.min(DESIGN_HEIGHT, Math.max(0, point.y)),
  };
}

/** CSS percentage placement of a stage point inside the 16:9 overlay layer. */
export function stagePercent(point: StagePoint): { left: string; top: string } {
  return {
    left: `${(point.x / DESIGN_WIDTH) * 100}%`,
    top: `${(point.y / DESIGN_HEIGHT) * 100}%`,
  };
}

/** CSS percentage box of a stage rectangle inside the 16:9 overlay layer. */
export function stageBoxPercent(box: StageBox): {
  left: string;
  top: string;
  width: string;
  height: string;
} {
  return {
    left: `${(box.left / DESIGN_WIDTH) * 100}%`,
    top: `${(box.top / DESIGN_HEIGHT) * 100}%`,
    width: `${(box.width / DESIGN_WIDTH) * 100}%`,
    height: `${(box.height / DESIGN_HEIGHT) * 100}%`,
  };
}
