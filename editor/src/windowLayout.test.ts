import { describe, expect, it } from "vitest";

import { describeNode } from "./nodeSummary";
import type {
  WindowGeometryNode,
  WindowLayerNode,
  WindowPlacement,
} from "./types";
import {
  belowMinimumSize,
  defaultPlacementFor,
  defaultWindowSize,
  describePlacement,
  describeWindowGeometry,
  describeWindowLayer,
  detectPlacementPreset,
  PLACEMENT_PRESETS,
  presetPlacement,
  resolvePlacement,
  windowGeometryProblem,
} from "./windowLayout";

const geometry = (
  patch: Partial<WindowGeometryNode> = {},
): WindowGeometryNode => ({
  type: "window_geometry",
  target: "secondary",
  position: presetPlacement("dock_right"),
  duration_ms: 600,
  easing: "ease_in_out",
  await: false,
  next: "a",
  ...patch,
});

describe("placement presets", () => {
  it("fill a fully explicit placement and never alias the shared preset", () => {
    for (const preset of PLACEMENT_PRESETS) {
      const placement = presetPlacement(preset.id);
      expect(Object.keys(placement).sort(), preset.id).toEqual([
        "anchor_x",
        "anchor_y",
        "offset_x",
        "offset_y",
        "relative_to",
        "x",
        "y",
      ]);
      expect(windowGeometryProblem({ position: placement }), preset.id).toBe(
        null,
      );
      expect(detectPlacementPreset(placement), preset.id).toBe(preset.id);
    }
    const copy = presetPlacement("screen_center");
    copy.x = 0.9;
    expect(presetPlacement("screen_center").x).toBe(0.5);
  });

  it("pin the screen corners and edges with the matching window anchor", () => {
    expect(presetPlacement("screen_center")).toMatchObject({
      relative_to: "work_area",
      x: 0.5,
      y: 0.5,
      anchor_x: 0.5,
      anchor_y: 0.5,
    });
    expect(presetPlacement("screen_top_right")).toMatchObject({
      x: 1,
      y: 0,
      anchor_x: 1,
      anchor_y: 0,
    });
    expect(presetPlacement("screen_bottom")).toMatchObject({
      x: 0.5,
      y: 1,
      anchor_x: 0.5,
      anchor_y: 1,
    });
    expect(presetPlacement("screen_left")).toMatchObject({
      x: 0,
      y: 0.5,
      anchor_x: 0,
      anchor_y: 0.5,
    });
  });

  it("dock beside the other window with a gap on the facing axis", () => {
    expect(presetPlacement("dock_right")).toEqual({
      relative_to: "window",
      x: 1,
      y: 0.5,
      anchor_x: 0,
      anchor_y: 0.5,
      offset_x: 16,
      offset_y: 0,
    });
    expect(presetPlacement("dock_left")).toMatchObject({
      x: 0,
      anchor_x: 1,
      offset_x: -16,
    });
    expect(presetPlacement("dock_top")).toMatchObject({
      y: 0,
      anchor_y: 1,
      offset_y: -16,
    });
    expect(presetPlacement("dock_bottom")).toMatchObject({
      y: 1,
      anchor_y: 0,
      offset_y: 16,
    });
  });

  it("nudge keeps the window pinned to its own corner and moves by the offset", () => {
    expect(presetPlacement("nudge")).toMatchObject({
      relative_to: "current",
      x: 0,
      y: 0,
      anchor_x: 0,
      anchor_y: 0,
    });
  });

  it("are detected ignoring offsets and defaults, else custom", () => {
    expect(
      detectPlacementPreset({
        ...presetPlacement("dock_right"),
        offset_x: 40,
      }),
    ).toBe("dock_right");
    // `relative_to` defaults to the work area; omitted offsets are zero.
    expect(
      detectPlacementPreset({ x: 0.5, y: 0.5, anchor_x: 0.5, anchor_y: 0.5 }),
    ).toBe("screen_center");
    expect(
      detectPlacementPreset({ x: 0.27, y: 0.5, anchor_x: 0.5, anchor_y: 0.5 }),
    ).toBeNull();
    // The same numbers against another reference are not the screen preset.
    expect(
      detectPlacementPreset({
        relative_to: "window",
        x: 0.5,
        y: 0.5,
        anchor_x: 0.5,
        anchor_y: 0.5,
      }),
    ).toBeNull();
  });

  it("start from the sensible placement for each window", () => {
    expect(detectPlacementPreset(defaultPlacementFor("secondary"))).toBe(
      "dock_right",
    );
    expect(detectPlacementPreset(defaultPlacementFor("main"))).toBe(
      "screen_center",
    );
  });

  it("resolve optional fields", () => {
    expect(resolvePlacement({ x: 0, y: 1, anchor_x: 0, anchor_y: 1 })).toEqual({
      relative_to: "work_area",
      x: 0,
      y: 1,
      anchor_x: 0,
      anchor_y: 1,
      offset_x: 0,
      offset_y: 0,
    });
  });
});

describe("window geometry bounds (mirror of the core validator)", () => {
  const placement = (patch: Partial<WindowPlacement>): WindowPlacement => ({
    x: 0.5,
    y: 0.5,
    anchor_x: 0.5,
    anchor_y: 0.5,
    ...patch,
  });

  it("needs a position or a size", () => {
    expect(windowGeometryProblem({})).toMatch(/至少要设置位置或大小/);
    expect(windowGeometryProblem({ position: null, size: null })).toMatch(
      /至少要设置位置或大小/,
    );
    expect(windowGeometryProblem({ position: placement({}) })).toBeNull();
    expect(
      windowGeometryProblem({ size: { width: 960, height: 540 } }),
    ).toBeNull();
  });

  it("bounds the reference point, anchor and offset", () => {
    expect(windowGeometryProblem({ position: placement({ x: 4 }) })).toBeNull();
    expect(
      windowGeometryProblem({ position: placement({ y: -4 }) }),
    ).toBeNull();
    for (const bad of [
      { x: 4.01 },
      { y: -5 },
      { x: Number.NaN },
      { anchor_x: -0.1 },
      { anchor_y: 1.5 },
      { offset_x: 10_001 },
      { offset_y: -10_001 },
      { offset_x: Number.POSITIVE_INFINITY },
    ]) {
      expect(
        windowGeometryProblem({ position: placement(bad) }),
        JSON.stringify(bad),
      ).toMatch(/窗口位置无效/);
    }
    expect(
      windowGeometryProblem({ position: placement({ offset_x: 10_000 }) }),
    ).toBeNull();
  });

  it("bounds logical sizes to 1..10000 and work-area sizes to (0,1]", () => {
    for (const ok of [
      { width: 1, height: 1 },
      { width: 10_000, height: 10_000 },
      { unit: "logical" as const, width: 960, height: 540 },
      { unit: "work_area" as const, width: 1, height: 0.25 },
    ]) {
      expect(
        windowGeometryProblem({ size: ok }),
        JSON.stringify(ok),
      ).toBeNull();
    }
    for (const bad of [
      { width: 0.5, height: 540 },
      { width: 20_000, height: 300 },
      { width: Number.NaN, height: 300 },
      { unit: "work_area" as const, width: 0, height: 0.5 },
      { unit: "work_area" as const, width: 0.5, height: 1.01 },
      { unit: "work_area" as const, width: 960, height: 540 },
    ]) {
      expect(windowGeometryProblem({ size: bad }), JSON.stringify(bad)).toMatch(
        /窗口大小无效/,
      );
    }
  });

  it("defaults a switched unit to a legal size", () => {
    for (const unit of ["logical", "work_area"] as const) {
      const size = defaultWindowSize(unit);
      expect(size.unit).toBe(unit);
      expect(windowGeometryProblem({ size })).toBeNull();
    }
  });

  it("flags only logical sizes below the host minimum", () => {
    expect(belowMinimumSize("main", { width: 959, height: 540 })).toBe(true);
    expect(belowMinimumSize("main", { width: 960, height: 540 })).toBe(false);
    expect(belowMinimumSize("secondary", { width: 960, height: 200 })).toBe(
      true,
    );
    expect(belowMinimumSize("secondary", { width: 480, height: 270 })).toBe(
      false,
    );
    expect(
      belowMinimumSize("main", { unit: "work_area", width: 0.1, height: 0.1 }),
    ).toBe(false);
    expect(belowMinimumSize("main", null)).toBe(false);
  });
});

describe("window node summaries", () => {
  it("describes docking the secondary window beside the main one", () => {
    const node = geometry();
    expect(describeWindowGeometry(node)).toBe("副窗口 → 贴主窗口右侧 · 600 ms");
    expect(describeNode(node).summary).toBe("副窗口 → 贴主窗口右侧 · 600 ms");
  });

  it("names the other window from the target's point of view", () => {
    expect(describeWindowGeometry(geometry({ target: "main" }))).toBe(
      "主窗口 → 贴副窗口右侧 · 600 ms",
    );
  });

  it("describes screen presets, size, instant moves and waiting", () => {
    expect(
      describeWindowGeometry(
        geometry({
          target: "main",
          position: presetPlacement("screen_center"),
          size: { unit: "logical", width: 960, height: 540 },
          duration_ms: 0,
        }),
      ),
    ).toBe("主窗口 → 屏幕居中 · 大小 960×540 · 瞬间完成");
    expect(
      describeWindowGeometry(
        geometry({
          position: null,
          size: { unit: "work_area", width: 0.5, height: 0.25 },
          await: true,
        }),
      ),
    ).toBe("副窗口 → 大小 工作区 50%×25% · 600 ms · 等待完成");
  });

  it("does not claim to wait when the move is instant", () => {
    expect(
      describeWindowGeometry(geometry({ duration_ms: 0, await: true })),
    ).toBe("副窗口 → 贴主窗口右侧 · 瞬间完成");
  });

  it("describes custom placements and nudges", () => {
    expect(
      describePlacement(
        { x: 0.27, y: 0.5, anchor_x: 0.5, anchor_y: 0.5 },
        "main",
      ),
    ).toBe("自定义位置（工作区 27%, 50%）");
    expect(
      describePlacement(
        {
          relative_to: "window",
          x: 0.25,
          y: 0.5,
          anchor_x: 0.5,
          anchor_y: 0.5,
          offset_y: 12,
        },
        "secondary",
      ),
    ).toBe("自定义位置（相对主窗口 25%, 50%，偏移 0, +12）");
    expect(
      describePlacement(
        { ...presetPlacement("nudge"), offset_x: 8, offset_y: -4 },
        "main",
      ),
    ).toBe("相对当前位置偏移（+8, -4）");
    expect(
      describePlacement(
        { ...presetPlacement("screen_center"), offset_y: 20 },
        "main",
      ),
    ).toBe("屏幕居中（偏移 0, +20）");
  });

  it("says so when a geometry node changes nothing", () => {
    expect(
      describeWindowGeometry(geometry({ position: null, size: null })),
    ).toContain("未设置位置或大小");
  });

  it("describes every layer action in plain language", () => {
    const layer = (action: WindowLayerNode["action"]): string =>
      describeWindowLayer({
        type: "window_layer",
        target: "main",
        action,
        next: "a",
      });
    expect(layer("raise")).toBe("主窗口 · 提到最前");
    expect(layer("focus")).toBe("主窗口 · 聚焦");
    expect(layer("top")).toBe("主窗口 · 置顶");
    expect(layer("bottom")).toBe("主窗口 · 置底");
    expect(layer("normal")).toBe("主窗口 · 恢复普通层级");
    expect(
      describeNode({
        type: "window_layer",
        target: "secondary",
        action: "top",
        next: "a",
      }).summary,
    ).toBe("副窗口 · 置顶");
  });
});
