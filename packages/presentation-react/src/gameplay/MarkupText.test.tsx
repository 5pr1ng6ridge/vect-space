import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTextLayoutLineGroups } from "@vectspace/text";

import { parseMarkup, visibleUnits } from "@vectspace/text";
import { MarkupText } from "./MarkupText";
import {
  buildLineSweepGeometry,
  buildLineSweepTimings,
  lineSweepMaskPositionPx,
  splitLinesAtPauses,
} from "./visualLineGroups";

describe("MarkupText math reveal", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps default layout inputs stable across reveal updates", () => {
    const requestFrame = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockReturnValue(1);
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    const onTextLayout = vi.fn();
    const { rerender } = render(
      <MarkupText source="abc" visibleCount={1} onTextLayout={onTextLayout} />,
    );
    expect(requestFrame).toHaveBeenCalledTimes(1);

    rerender(
      <MarkupText source="abc" visibleCount={2} onTextLayout={onTextLayout} />,
    );
    expect(requestFrame).toHaveBeenCalledTimes(1);
  });

  it("measures formulas once across visibility changes and reports reveal indices", () => {
    const computedStyle = vi.spyOn(globalThis, "getComputedStyle");
    const onMathMetrics = vi.fn();
    const { rerender } = render(
      <MarkupText
        animateMath
        source={"a\n$x$bc"}
        visibleCount={1}
        onMathMetrics={onMathMetrics}
      />,
    );
    expect(computedStyle).toHaveBeenCalledTimes(1);
    expect(onMathMetrics).toHaveBeenCalledTimes(1);
    // The hard break has a layout index but consumes no reveal index.
    expect(onMathMetrics).toHaveBeenCalledWith(
      1,
      expect.any(Number),
      expect.any(Number),
    );

    for (const visibleCount of [2, 3, 4]) {
      rerender(
        <MarkupText
          animateMath
          source={"a\n$x$bc"}
          visibleCount={visibleCount}
          onMathMetrics={onMathMetrics}
        />,
      );
    }
    expect(computedStyle).toHaveBeenCalledTimes(1);
    expect(onMathMetrics).toHaveBeenCalledTimes(1);
  });

  it("does not start the post-pause segment when the visual row starts", () => {
    const segments = splitLinesAtPauses(
      [[0, 1, 2, 3]],
      [50, 100, 650, 700],
      [{ startMs: 100, endMs: 600 }],
    );
    expect(segments).toEqual([
      [0, 1],
      [2, 3],
    ]);
    const timings = buildLineSweepTimings(
      visibleUnits(parseMarkup("abcd")),
      segments,
      [50, 100, 650, 700],
      [20, 20, 20, 20],
      new Map(),
      new Map([
        [0, { lineWidthPx: 64, unitOffsetPx: 0 }],
        [1, { lineWidthPx: 64, unitOffsetPx: 32 }],
        [2, { lineWidthPx: 64, unitOffsetPx: 0 }],
        [3, { lineWidthPx: 64, unitOffsetPx: 32 }],
      ]),
      [{ startMs: 100, endMs: 600 }],
    );
    expect(timings.get(2)?.lineStartIndex).toBe(2);
    expect(timings.get(3)?.startMs).toBe(650);
  });
  it("keeps the complete KaTeX tree mounted while the formula is hidden", () => {
    const html = renderToStaticMarkup(
      <MarkupText animateMath source="甲$x+y$" visibleCount={1} />,
    );
    expect(html).toContain("visibility:hidden");
    expect(html).toContain("math-reveal-content");
    expect(html).toContain("x+y");
    expect(html).not.toContain("is-math-revealed");
  });

  it("animates natural reveals but marks skipped reveals as instant", () => {
    const animated = renderToStaticMarkup(
      <MarkupText animateMath source="$x$" visibleCount={1} />,
    );
    const instant = renderToStaticMarkup(
      <MarkupText
        animateMath
        instantMathReveal
        source="$x$"
        visibleCount={1}
      />,
    );
    expect(animated).toContain("is-math-revealed");
    expect(animated).not.toContain("is-math-instant");
    expect(instant).toContain("is-math-instant");
  });

  it("never gives completed static formulas a reveal animation class", () => {
    const html = renderToStaticMarkup(
      <MarkupText animateMath source="$x+y$" />,
    );
    expect(html).not.toContain("is-reveal-typewriter");
    expect(html).not.toContain("is-reveal-drop_fade");
    expect(html).not.toContain("is-reveal-line_sweep");
  });

  it("clears every reveal animation when the player completes a prompt", () => {
    const html = renderToStaticMarkup(
      <MarkupText
        animateMath
        instantReveal
        revealAnimation="line_sweep"
        source="甲$x$"
        visibleCount={2}
      />,
    );
    expect(html).toContain("is-reveal-instant");
  });

  it("puts a legal soft-wrap opportunity after every visible character", () => {
    const html = renderToStaticMarkup(<MarkupText source="123456" />);
    expect(html).toContain("<wbr");
  });

  it("renders an explicit hard line break instead of relying on whitespace inheritance", () => {
    const html = renderToStaticMarkup(<MarkupText source={"甲\r\n乙"} />);
    expect(html).toContain("<br");
  });

  it("keeps an inline formula with text that shares its visual baseline", () => {
    const units = visibleUnits(parseMarkup("示例：$A \\cong B$"));
    const box = (index: number, top: number, height: number) => ({
      index,
      top,
      bottom: top + height,
      left: index * 32,
      right: (index + 1) * 32,
    });
    const groups = resolveTextLayoutLineGroups(
      units,
      new Map([
        [0, box(0, 100, 34)],
        [1, box(1, 100, 34)],
        [2, box(2, 100, 34)],
        // KaTeX is taller and vertically aligned above nearby characters,
        // but its center belongs to the same visual row.
        [3, box(3, 92, 50)],
      ]),
    );
    expect(groups).toEqual([[0, 1, 2, 3]]);
  });

  it("keeps explicit source line breaks in separate visual rows", () => {
    const units = visibleUnits(parseMarkup("甲\n乙"));
    const groups = resolveTextLayoutLineGroups(
      units,
      new Map([
        [0, { index: 0, top: 100, bottom: 134, left: 0, right: 32 }],
        [2, { index: 2, top: 100, bottom: 134, left: 0, right: 32 }],
      ]),
    );
    expect(groups).toEqual([[0], [2]]);
  });

  it("keeps line-sweep timing on the original inline units", () => {
    const units = visibleUnits(parseMarkup("甲乙$x$丙"));
    const timings = buildLineSweepTimings(
      units,
      [[0, 1, 2], [3]],
      [40, 80, 120, 280],
      [25, 25, 25, 25],
      new Map([[2, 240]]),
      new Map([
        [0, { lineWidthPx: 96, unitOffsetPx: 0 }],
        [1, { lineWidthPx: 96, unitOffsetPx: 32 }],
        [2, { lineWidthPx: 96, unitOffsetPx: 64 }],
        [3, { lineWidthPx: 32, unitOffsetPx: 0 }],
      ]),
    );

    expect(timings.get(0)).toMatchObject({
      lineStartIndex: 0,
      durationMs: 320,
      lineWidthPx: 96,
      unitOffsetPx: 0,
    });
    expect(timings.get(2)).toMatchObject({
      lineStartIndex: 0,
      durationMs: 320,
      unitOffsetPx: 64,
    });
    expect(timings.get(3)).toMatchObject({
      lineStartIndex: 3,
      durationMs: 40,
    });
  });

  it("pauses a line sweep without spending the pause in its mask duration", () => {
    const units = visibleUnits(parseMarkup("甲乙"));
    const timings = buildLineSweepTimings(
      units,
      [[0, 1]],
      [50, 600],
      [20, 20],
      new Map(),
      new Map([
        [0, { lineWidthPx: 64, unitOffsetPx: 0 }],
        [1, { lineWidthPx: 64, unitOffsetPx: 32 }],
      ]),
      [{ startMs: 50, endMs: 550 }],
    );

    expect(timings.get(0)?.durationMs).toBe(100);
    expect(timings.get(1)?.durationMs).toBe(100);
    const timing = timings.get(0);
    expect(timing).toBeDefined();
    if (timing === undefined) return;
    expect(
      lineSweepMaskPositionPx(timing, 50, [{ startMs: 50, endMs: 550 }]),
    ).toBe(lineSweepMaskPositionPx(timing, 420, [{ startMs: 50, endMs: 550 }]));
    expect(
      lineSweepMaskPositionPx(timing, 600, [{ startMs: 50, endMs: 550 }]),
    ).toBeGreaterThan(
      lineSweepMaskPositionPx(timing, 50, [{ startMs: 50, endMs: 550 }]),
    );
    // The finished mask still covers the first glyph; moving it one feather
    // farther right would leave that glyph outside a non-repeating mask.
    expect(lineSweepMaskPositionPx(timing, timing.endMs, [], 16)).toBeCloseTo(
      -timing.unitOffsetPx,
    );
  });

  it("uses the actual KaTeX box for a centered display formula", () => {
    const katex = {
      getBoundingClientRect: () => ({ left: 350, width: 100 }) as DOMRect,
    } as HTMLElement;
    const displayMath = {
      classList: { contains: (name: string) => name === "math-unit" },
      getBoundingClientRect: () => ({ left: 100, width: 600 }) as DOMRect,
      offsetLeft: 0,
      offsetWidth: 1_200,
      querySelector: () => katex,
    } as unknown as HTMLElement;
    const geometry = buildLineSweepGeometry([[0]], new Map([[0, displayMath]]));

    expect(geometry.get(0)).toEqual({
      lineWidthPx: 200,
      unitOffsetPx: 0,
    });
  });
});
