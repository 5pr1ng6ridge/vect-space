import { describe, expect, it } from "vitest";

import {
  LONG_TEXT_STEP_GAP,
  paginateLongTextVisualSteps,
  resolveLongTextPageWindow,
} from "./longTextPagination";

describe("visual-line long-text pagination", () => {
  it("splits one story step across pages without moving its existing lines", () => {
    const pages = paginateLongTextVisualSteps(
      [
        {
          step_id: "proof",
          text: "第一行\n第二行\n第三行",
          page_break_before: false,
        },
      ],
      {
        proof: {
          contentHeight: 125,
          lines: [
            { unitIndices: [0], top: 0, bottom: 40, left: 0, right: 200 },
            { unitIndices: [1], top: 42, bottom: 82, left: 0, right: 200 },
            { unitIndices: [2], top: 84, bottom: 125, left: 0, right: 200 },
          ],
        },
      },
      "auto",
      120,
      10,
    );
    expect(pages).toHaveLength(2);
    expect(pages[0]?.fragments).toMatchObject([
      { step: { step_id: "proof" }, firstLine: 0, lastLine: 1 },
    ]);
    expect(pages[1]?.fragments).toMatchObject([
      { step: { step_id: "proof" }, firstLine: 2, lastLine: 2 },
    ]);
    expect(pages[1]?.fragments[0]?.top).toBe(0);
  });

  it("honors explicit breaks without adding an inter-step gap to the new page", () => {
    const pages = paginateLongTextVisualSteps(
      [
        { step_id: "a", text: "a", page_break_before: false },
        { step_id: "b", text: "b", page_break_before: true },
      ],
      {
        a: {
          contentHeight: 40,
          lines: [{ unitIndices: [0], top: 0, bottom: 40, left: 0, right: 20 }],
        },
        b: {
          contentHeight: 40,
          lines: [{ unitIndices: [0], top: 0, bottom: 40, left: 0, right: 20 }],
        },
      },
      "auto",
      500,
      20,
    );
    expect(pages).toHaveLength(2);
    expect(pages[0]?.fragments[0]?.top).toBe(0);
    expect(pages[1]?.fragments[0]?.top).toBe(0);
    expect(LONG_TEXT_STEP_GAP).toBeGreaterThan(0);
  });

  it("keeps continuous documents in one surface and bounds the mounted page window", () => {
    const pages = paginateLongTextVisualSteps(
      [
        { step_id: "a", text: "a", page_break_before: false },
        { step_id: "b", text: "b", page_break_before: false },
      ],
      {
        a: {
          contentHeight: 40,
          lines: [{ unitIndices: [0], top: 0, bottom: 40, left: 0, right: 20 }],
        },
        b: {
          contentHeight: 40,
          lines: [{ unitIndices: [0], top: 0, bottom: 40, left: 0, right: 20 }],
        },
      },
      "continuous",
      500,
      20,
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]?.fragments).toHaveLength(2);
    const manyPages = Array.from({ length: 1_024 }, () => ({ height: 1_340 }));
    const offsets = manyPages.map((_page, index) => index * 1_432);
    const window = resolveLongTextPageWindow(
      manyPages,
      offsets,
      offsets[500] ?? 0,
      1_080,
    );
    expect(window.start).toBeGreaterThanOrEqual(498);
    expect(window.end - window.start).toBeLessThanOrEqual(6);
    expect(window.start).toBeLessThanOrEqual(500);
    expect(window.end).toBeGreaterThan(500);
  });
});
