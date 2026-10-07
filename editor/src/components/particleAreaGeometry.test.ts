import { describe, expect, it } from "vitest";
import { worldPointToStage } from "@vectspace/presentation-core/scene-frame";

import {
  AREA_HANDLES,
  MAX_AREA_SIDE,
  areaHandlePoint,
  areaStageBox,
  clampToStage,
  emitterDragPosition,
  emitterStagePoint,
  handleAxes,
  resizeAreaFromHandle,
  roundedPosition,
  sameAreaSize,
  stageBoxPercent,
  stagePercent,
} from "./particleAreaGeometry";

const IDENTITY = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
const CAMERA = { x: 120, y: -60, zoom: 1.6, rotation_deg: 30 };

describe("particle area geometry", () => {
  it("maps each handle to the sides it moves", () => {
    expect(handleAxes("e")).toEqual({ x: 1, y: 0 });
    expect(handleAxes("w")).toEqual({ x: -1, y: 0 });
    expect(handleAxes("s")).toEqual({ x: 0, y: 1 });
    expect(handleAxes("n")).toEqual({ x: 0, y: -1 });
    expect(handleAxes("nw")).toEqual({ x: -1, y: -1 });
    expect(handleAxes("se")).toEqual({ x: 1, y: 1 });
    // Corners come last so they stay on top when a zero side stacks handles.
    expect(AREA_HANDLES.slice(-4)).toEqual(["nw", "ne", "sw", "se"]);
  });

  it("centres the area box and its handles on the generation point", () => {
    const center = { x: 960, y: 540 };
    const area = { width: 400, height: 100 };
    expect(areaStageBox(center, area)).toEqual({
      left: 760,
      top: 490,
      width: 400,
      height: 100,
    });
    expect(areaStageBox(center, area, 2)).toEqual({
      left: 560,
      top: 440,
      width: 800,
      height: 200,
    });
    expect(areaHandlePoint(center, area, "e")).toEqual({ x: 1160, y: 540 });
    expect(areaHandlePoint(center, area, "nw")).toEqual({ x: 760, y: 490 });
    expect(areaHandlePoint(center, area, "s", 2)).toEqual({ x: 960, y: 640 });
  });

  it("resizes symmetrically: one edge moves the full side by twice the drag", () => {
    const base = {
      area: { width: 400, height: 100 },
      pointerDown: { x: 1160, y: 540 },
    };
    expect(
      resizeAreaFromHandle({
        ...base,
        handle: "e",
        pointerNow: { x: 1260, y: 700 },
      }),
    ).toEqual({ width: 600, height: 100 });
    // The west handle grows the same side when dragged outwards (left).
    expect(
      resizeAreaFromHandle({
        ...base,
        handle: "w",
        pointerNow: { x: 1060, y: 540 },
      }),
    ).toEqual({ width: 600, height: 100 });
    expect(
      resizeAreaFromHandle({
        ...base,
        handle: "s",
        pointerNow: { x: 0, y: 590 },
      }),
    ).toEqual({ width: 400, height: 200 });
    expect(
      resizeAreaFromHandle({
        ...base,
        handle: "se",
        pointerNow: { x: 1210, y: 560 },
      }),
    ).toEqual({ width: 500, height: 140 });
  });

  it("keeps the grab offset: only the displacement counts", () => {
    // Grabbing 7px inside the handle and not moving changes nothing.
    expect(
      resizeAreaFromHandle({
        handle: "e",
        area: { width: 400, height: 100 },
        pointerDown: { x: 1153, y: 543 },
        pointerNow: { x: 1153, y: 543 },
      }),
    ).toEqual({ width: 400, height: 100 });
  });

  it("allows a side to reach exactly zero and never goes negative", () => {
    const base = {
      area: { width: 400, height: 100 },
      pointerDown: { x: 1160, y: 540 },
    };
    expect(
      resizeAreaFromHandle({
        ...base,
        handle: "e",
        pointerNow: { x: 960, y: 540 },
      }),
    ).toEqual({ width: 0, height: 100 });
    expect(
      resizeAreaFromHandle({
        ...base,
        handle: "e",
        pointerNow: { x: 100, y: 540 },
      }),
    ).toEqual({ width: 0, height: 100 });
    expect(
      resizeAreaFromHandle({
        ...base,
        handle: "se",
        pointerNow: { x: 0, y: 0 },
      }),
    ).toEqual({ width: 0, height: 0 });
  });

  it("clamps to the validator's range and rounds to whole pixels", () => {
    expect(
      resizeAreaFromHandle({
        handle: "e",
        area: { width: 400, height: 100 },
        pointerDown: { x: 0, y: 0 },
        pointerNow: { x: 99999, y: 0 },
      }).width,
    ).toBe(MAX_AREA_SIDE);
    expect(
      resizeAreaFromHandle({
        handle: "e",
        area: { width: 400, height: 100 },
        pointerDown: { x: 0, y: 0 },
        pointerNow: { x: 10.3, y: 0 },
      }).width,
    ).toBe(421);
  });

  it("divides the drag by the emitter scale", () => {
    expect(
      resizeAreaFromHandle({
        handle: "e",
        area: { width: 100, height: 100 },
        scale: 2,
        pointerDown: { x: 0, y: 0 },
        pointerNow: { x: 100, y: 0 },
      }),
    ).toEqual({ width: 200, height: 100 });
  });

  it("compares sizes", () => {
    expect(sameAreaSize({ width: 1, height: 2 }, { width: 1, height: 2 })).toBe(
      true,
    );
    expect(sameAreaSize({ width: 1, height: 2 }, { width: 1, height: 3 })).toBe(
      false,
    );
  });

  it("shows a world emitter through the camera and a screen emitter untouched", () => {
    const world = { space: "world" as const, x: 900, y: 500 };
    const screen = { space: "screen" as const, x: 900, y: 500 };
    expect(emitterStagePoint(world, CAMERA)).toEqual(
      worldPointToStage({ x: 900, y: 500 }, CAMERA),
    );
    expect(emitterStagePoint(world, IDENTITY)).toEqual({ x: 900, y: 500 });
    expect(emitterStagePoint(screen, CAMERA)).toEqual({ x: 900, y: 500 });
  });

  it("drags a world emitter through the inverse camera", () => {
    // 100 design pixels right under a 1.6x camera turned 30 degrees is
    // (62.5*cos30, -62.5*sin30) = (+54.13, -31.25) world pixels.
    const start = worldPointToStage({ x: 900, y: 500 }, CAMERA);
    const dropped = emitterDragPosition({
      space: "world",
      origin: { x: 900, y: 500 },
      pointerDown: start,
      pointerNow: { x: start.x + 100, y: start.y },
      camera: CAMERA,
    });
    expect(dropped.x).toBeCloseTo(954.1266, 3);
    expect(dropped.y).toBeCloseTo(468.75, 3);
    expect(roundedPosition(dropped)).toEqual({ x: 954, y: 469 });
  });

  it("drags a screen emitter by the raw design-pixel displacement", () => {
    expect(
      emitterDragPosition({
        space: "screen",
        origin: { x: 900, y: 500 },
        pointerDown: { x: 10, y: 10 },
        pointerNow: { x: 90, y: 50 },
        camera: CAMERA,
      }),
    ).toEqual({ x: 980, y: 540 });
  });

  it("keeps the preview centre on the stage and places overlays by percentage", () => {
    expect(clampToStage({ x: -5, y: 5000 })).toEqual({ x: 0, y: 1080 });
    expect(stagePercent({ x: 960, y: 540 })).toEqual({
      left: "50%",
      top: "50%",
    });
    expect(
      stageBoxPercent({ left: 480, top: 270, width: 960, height: 540 }),
    ).toEqual({ left: "25%", top: "25%", width: "50%", height: "50%" });
  });
});
