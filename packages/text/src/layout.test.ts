import { describe, expect, it } from "vitest";

import {
  isValidTextMeasurementScale,
  normalizeTextContentHeight,
  normalizeTextUnitBox,
  paginateTextLayouts,
  resolveTextPageWindow,
} from "./layout";

describe("text measurement normalization", () => {
  it("rejects non-positive and non-finite measurement scales", () => {
    expect(isValidTextMeasurementScale(0)).toBe(false);
    expect(isValidTextMeasurementScale(-1)).toBe(false);
    expect(isValidTextMeasurementScale(Number.NaN)).toBe(false);
    expect(isValidTextMeasurementScale(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidTextMeasurementScale(0.75)).toBe(true);
  });

  it("converts transformed browser rectangles to design pixels", () => {
    const box = normalizeTextUnitBox(
      3,
      { top: 120, bottom: 180, left: 240, right: 440 },
      { top: 60, left: 40 },
      0.5,
    );
    expect(box).toEqual({
      index: 3,
      top: 120,
      bottom: 240,
      left: 400,
      right: 800,
    });
  });

  it("uses the largest normalized row boundary for inline roots", () => {
    const boxes = new Map([
      [0, { index: 0, top: 0, bottom: 42, left: 0, right: 10 }],
      [1, { index: 1, top: 40, bottom: 96, left: 0, right: 10 }],
    ]);
    expect(normalizeTextContentHeight(0, 30, boxes, 0.5)).toBe(96);
  });
});

describe("paginateTextLayouts", () => {
  it("keeps only the visible pages and two viewports of overscan mounted", () => {
    const pages = [
      { height: 100 },
      { height: 100 },
      { height: 100 },
      { height: 100 },
    ];
    expect(resolveTextPageWindow(pages, [0, 100, 200, 300], 200, 100)).toEqual({
      start: 0,
      end: 4,
    });
    expect(
      resolveTextPageWindow(pages, [0, 100, 200, 300], 300, 100, 50),
    ).toEqual({ start: 2, end: 4 });
  });

  it("splits one measured item only at visual-row boundaries", () => {
    const pages = paginateTextLayouts(
      [
        {
          id: "proof",
          pageBreakBefore: false,
          layout: {
            contentHeight: 125,
            lines: [
              { unitIndices: [0], top: 0, bottom: 40, left: 0, right: 200 },
              { unitIndices: [1], top: 42, bottom: 82, left: 0, right: 200 },
              { unitIndices: [2], top: 84, bottom: 125, left: 0, right: 200 },
            ],
          },
        },
      ],
      "auto",
      120,
      10,
    );

    expect(pages).toHaveLength(2);
    expect(pages[0]?.fragments).toMatchObject([
      {
        itemId: "proof",
        firstLine: 0,
        lastLine: 1,
        top: 0,
        // The slice continues to the next visual row's top instead of the
        // last glyph's bottom, so the preceding row cannot be cropped.
        height: 84,
      },
    ]);
    expect(pages[1]?.fragments).toMatchObject([
      { itemId: "proof", firstLine: 2, lastLine: 2, top: 0 },
    ]);
  });

  it("keeps overlapping rows together as one atomic fragment", () => {
    const pages = paginateTextLayouts(
      [
        {
          id: "overlap",
          pageBreakBefore: false,
          layout: {
            contentHeight: 100,
            lines: [
              { unitIndices: [0], top: 0, bottom: 60, left: 0, right: 20 },
              { unitIndices: [1], top: 55, bottom: 100, left: 0, right: 20 },
            ],
          },
        },
      ],
      "auto",
      100,
      10,
    );

    expect(pages).toHaveLength(1);
    expect(pages[0]?.fragments[0]).toMatchObject({
      sourceTop: 0,
      height: 100,
      firstLine: 0,
      lastLine: 1,
    });
  });

  it("moves an overlapping row group together when the current page is full", () => {
    const pages = paginateTextLayouts(
      [
        {
          id: "overlap",
          pageBreakBefore: false,
          layout: {
            contentHeight: 120,
            lines: [
              { unitIndices: [0], top: 0, bottom: 30, left: 0, right: 20 },
              { unitIndices: [1], top: 55, bottom: 90, left: 0, right: 20 },
              { unitIndices: [2], top: 85, bottom: 120, left: 0, right: 20 },
            ],
          },
        },
      ],
      "auto",
      100,
      10,
    );
    expect(pages).toHaveLength(2);
    expect(pages[0]?.fragments[0]).toMatchObject({
      firstLine: 0,
      lastLine: 0,
      sourceTop: 0,
      height: 55,
    });
    expect(pages[1]?.fragments[0]).toMatchObject({
      firstLine: 1,
      lastLine: 2,
      sourceTop: 55,
      height: 65,
    });
    const ownership = pages.flatMap((page) =>
      page.fragments.flatMap((fragment) =>
        Array.from(
          { length: fragment.lastLine - fragment.firstLine + 1 },
          (_value, offset) => fragment.firstLine + offset,
        ),
      ),
    );
    expect(ownership).toEqual([0, 1, 2]);
    expect(
      pages
        .flatMap((page) => page.fragments)
        .every((fragment, index, fragments) => {
          const next = fragments[index + 1];
          return (
            next === undefined ||
            fragment.sourceTop + fragment.height <= next.sourceTop
          );
        }),
    ).toBe(true);
  });

  it("keeps manual overflow on one paper and honors explicit breaks", () => {
    const pages = paginateTextLayouts(
      [
        {
          id: "first",
          pageBreakBefore: false,
          layout: { contentHeight: 160, lines: [] },
        },
        {
          id: "second",
          pageBreakBefore: true,
          layout: { contentHeight: 40, lines: [] },
        },
      ],
      "manual",
      120,
      10,
    );

    expect(pages).toHaveLength(2);
    expect(pages[0]?.height).toBe(180);
    expect(pages[1]?.fragments[0]?.top).toBe(0);
  });

  it("keeps continuous content on one surface", () => {
    const pages = paginateTextLayouts(
      [
        {
          id: "a",
          pageBreakBefore: false,
          layout: { contentHeight: 40, lines: [] },
        },
        {
          id: "b",
          pageBreakBefore: true,
          layout: { contentHeight: 40, lines: [] },
        },
      ],
      "continuous",
      120,
      10,
    );

    expect(pages).toHaveLength(1);
    expect(pages[0]?.fragments.map((fragment) => fragment.itemId)).toEqual([
      "a",
      "b",
    ]);
  });
});
