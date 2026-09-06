import { describe, expect, it } from "vitest";

import { paginateTextLayouts } from "./layout";

describe("paginateTextLayouts", () => {
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

  it("keeps a row's lower glyph bounds when rows overlap", () => {
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

    expect(pages).toHaveLength(2);
    expect(pages[0]?.fragments[0]).toMatchObject({
      sourceTop: 0,
      height: 60,
      firstLine: 0,
      lastLine: 0,
    });
    expect(pages[1]?.fragments[0]).toMatchObject({
      sourceTop: 55,
      height: 45,
      firstLine: 1,
      lastLine: 1,
    });
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
