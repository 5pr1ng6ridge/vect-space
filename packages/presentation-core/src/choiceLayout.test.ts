import { describe, expect, it } from "vitest";

import sharedCases from "../../../fixtures/choice-layout-cases.json";
import {
  CHOICE_DEFAULT_ANCHOR_X,
  CHOICE_DEFAULT_ANCHOR_Y,
  CHOICE_DEFAULT_GAP,
  CHOICE_FALLBACK_BUTTON_HEIGHT,
  CHOICE_FALLBACK_BUTTON_WIDTH,
  CHOICE_FALLBACK_PANEL_X,
  CHOICE_FALLBACK_PANEL_Y,
  CHOICE_STAGE_HEIGHT,
  CHOICE_STAGE_WIDTH,
  layoutChoiceItems,
  legacyChoiceAnchor,
  resolveChoiceItemSize,
} from "./choiceLayout";
import type {
  ChoiceItemSize,
  ChoiceItemRect,
  ChoiceLayoutRequest,
  ChoiceLayoutResult,
} from "./choiceLayout";

interface LayoutCase {
  name: string;
  direction: "vertical" | "horizontal";
  anchor_x: number;
  anchor_y: number;
  gap: number;
  items: ChoiceItemSize[];
  expected: ChoiceLayoutResult;
}

const cases = sharedCases as LayoutCase[];

const fallbackItem: ChoiceItemSize = {
  width: CHOICE_FALLBACK_BUTTON_WIDTH,
  height: CHOICE_FALLBACK_BUTTON_HEIGHT,
};

function fallbackGroup(count: number): ChoiceItemSize[] {
  return Array.from({ length: count }, () => ({ ...fallbackItem }));
}

describe("choice layout conformance", () => {
  it("matches the shared Rust corpus", () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const testCase of cases) {
      const request: ChoiceLayoutRequest = {
        direction: testCase.direction,
        anchor_x: testCase.anchor_x,
        anchor_y: testCase.anchor_y,
        gap: testCase.gap,
      };
      expect(layoutChoiceItems(testCase.items, request), testCase.name).toEqual(
        testCase.expected,
      );
    }
  });

  it("uses design-pixel defaults at the stage centre", () => {
    expect(CHOICE_DEFAULT_ANCHOR_X).toBe(960);
    expect(CHOICE_DEFAULT_ANCHOR_Y).toBe(540);
    expect(CHOICE_FALLBACK_PANEL_X).toBe(470);
    expect(CHOICE_FALLBACK_PANEL_Y).toBe(360);
    expect(CHOICE_STAGE_WIDTH).toBe(1920);
    expect(CHOICE_STAGE_HEIGHT).toBe(1080);
  });

  it("centres an explicit default group on 960/540 for one to three options", () => {
    const expectedTops: [number, number][] = [
      [1, 494],
      [2, 438],
      [3, 382],
    ];
    for (const [count, expectedTop] of expectedTops) {
      const result = layoutChoiceItems(fallbackGroup(count), {
        direction: "vertical",
        anchor_x: CHOICE_DEFAULT_ANCHOR_X,
        anchor_y: CHOICE_DEFAULT_ANCHOR_Y,
        gap: CHOICE_DEFAULT_GAP,
      });
      expect(result.y, `${count} options`).toBe(expectedTop);
      expect(result.x).toBe(CHOICE_FALLBACK_PANEL_X);
      expect(result.items[0].y, `${count} options`).toBe(expectedTop);
      expect(result.y, `${count} options`).not.toBe(CHOICE_FALLBACK_PANEL_Y);
    }
  });

  it("keeps the shipped CSS panel top-left for legacy nodes", () => {
    const sizes = fallbackGroup(2);
    const anchor = legacyChoiceAnchor("vertical", CHOICE_DEFAULT_GAP, sizes);
    expect(anchor).toEqual({ anchor_x: 960, anchor_y: 462 });
    const result = layoutChoiceItems(sizes, {
      direction: "vertical",
      anchor_x: anchor.anchor_x,
      anchor_y: anchor.anchor_y,
      gap: CHOICE_DEFAULT_GAP,
    });
    expect(result).toEqual({
      x: CHOICE_FALLBACK_PANEL_X,
      y: CHOICE_FALLBACK_PANEL_Y,
      width: CHOICE_FALLBACK_BUTTON_WIDTH,
      height: 204,
      items: [
        { x: 470, y: 360, width: 980, height: 92 },
        { x: 470, y: 472, width: 980, height: 92 },
      ],
    });
  });

  it("is axis-aware so a horizontal legacy group keeps the panel origin", () => {
    // The shipped CSS panel is a vertical stack, but the public helper must
    // not silently re-anchor a horizontal flow: the returned anchor has to
    // reproduce the documented panel top-left for either direction.
    const sizes: ChoiceItemSize[] = [
      { width: 240, height: 72 },
      { width: 320, height: 88 },
    ];
    const anchor = legacyChoiceAnchor("horizontal", 16, sizes);
    expect(anchor).toEqual({ anchor_x: 758, anchor_y: 404 });
    const result = layoutChoiceItems(sizes, {
      direction: "horizontal",
      anchor_x: anchor.anchor_x,
      anchor_y: anchor.anchor_y,
      gap: 16,
    });
    expect(result).toEqual({
      x: CHOICE_FALLBACK_PANEL_X,
      y: CHOICE_FALLBACK_PANEL_Y,
      width: 576,
      height: 88,
      items: [
        { x: 470, y: 368, width: 240, height: 72 },
        { x: 726, y: 360, width: 320, height: 88 },
      ],
    });
  });

  it("places an off-centre pixel anchor exactly where authored", () => {
    const result = layoutChoiceItems([{ width: 240, height: 72 }], {
      direction: "vertical",
      anchor_x: 480,
      anchor_y: 810,
      gap: 20,
    });
    expect(result).toEqual({
      x: 360,
      y: 774,
      width: 240,
      height: 72,
      items: [{ x: 360, y: 774, width: 240, height: 72 }],
    });
  });

  it("does not mutate the caller's sizes", () => {
    const sizes: ChoiceItemSize[] = [{ width: 240, height: 72 }];
    const before = structuredClone(sizes);
    const result = layoutChoiceItems(sizes, {
      direction: "vertical",
      anchor_x: CHOICE_DEFAULT_ANCHOR_X,
      anchor_y: CHOICE_DEFAULT_ANCHOR_Y,
      gap: CHOICE_DEFAULT_GAP,
    });
    expect(sizes).toEqual(before);
    expect(result.items).toHaveLength(1);
  });

  it("collapses an empty group onto the anchor point", () => {
    const result = layoutChoiceItems([], {
      direction: "horizontal",
      anchor_x: 480,
      anchor_y: 810,
      gap: 20,
    });
    expect(result).toEqual({
      x: 480,
      y: 810,
      width: 0,
      height: 0,
      items: [],
    });
  });
});

describe("choice item size resolution", () => {
  it("uses the built-in fallback without a template", () => {
    expect(resolveChoiceItemSize({})).toEqual({
      width: CHOICE_FALLBACK_BUTTON_WIDTH,
      height: CHOICE_FALLBACK_BUTTON_HEIGHT,
    });
  });

  it("prefers template dimensions over the fallback", () => {
    expect(
      resolveChoiceItemSize({ template: { width: 320, height: 88 } }),
    ).toEqual({ width: 320, height: 88 });
  });

  it("lets the node override win over template dimensions", () => {
    expect(
      resolveChoiceItemSize({
        template: { width: 320, height: 88 },
        button_width: 500,
        button_height: 120,
      }),
    ).toEqual({ width: 500, height: 120 });
  });

  it("ignores invalid overrides the same way the runtime does", () => {
    expect(
      resolveChoiceItemSize({
        template: { width: 240, height: 72 },
        button_width: 0,
        button_height: Number.NaN,
      }),
    ).toEqual({ width: 240, height: 72 });
    expect(
      resolveChoiceItemSize({
        button_width: -10,
        button_height: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      width: CHOICE_FALLBACK_BUTTON_WIDTH,
      height: CHOICE_FALLBACK_BUTTON_HEIGHT,
    });
  });
});

describe("choice item rect shape", () => {
  it("exposes the resolved rects in reading order", () => {
    const result = layoutChoiceItems(
      [
        { width: 240, height: 72 },
        { width: 320, height: 88 },
      ],
      {
        direction: "vertical",
        anchor_x: CHOICE_DEFAULT_ANCHOR_X,
        anchor_y: CHOICE_DEFAULT_ANCHOR_Y,
        gap: 20,
      },
    );
    const rects: ChoiceItemRect[] = result.items;
    expect(rects.map((rect) => rect.y)).toEqual([450, 542]);
    expect(rects.map((rect) => rect.x)).toEqual([840, 800]);
  });
});
