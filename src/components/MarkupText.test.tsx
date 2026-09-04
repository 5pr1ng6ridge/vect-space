import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { parseMarkup, visibleUnits } from "../engine/markup";
import { MarkupText } from "./MarkupText";
import {
  buildLineSweepGeometry,
  buildLineSweepTimings,
  lineSweepMaskPositionPx,
  resolveVisualLineGroups,
} from "./visualLineGroups";

describe("MarkupText math reveal", () => {
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
    const element = (top: number, height: number): HTMLElement =>
      ({
        getBoundingClientRect: () => ({ top, height }) as DOMRect,
      }) as HTMLElement;
    const groups = resolveVisualLineGroups(
      units,
      new Map([
        [0, element(100, 34)],
        [1, element(100, 34)],
        [2, element(100, 34)],
        // KaTeX is taller and vertically aligned above nearby characters,
        // but its center belongs to the same visual row.
        [3, element(92, 50)],
      ]),
    );
    expect(groups).toEqual([[0, 1, 2, 3]]);
  });

  it("keeps explicit source line breaks in separate visual rows", () => {
    const units = visibleUnits(parseMarkup("甲\n乙"));
    const element = (top: number): HTMLElement =>
      ({
        getBoundingClientRect: () => ({ top, height: 34 }) as DOMRect,
      }) as HTMLElement;
    const groups = resolveVisualLineGroups(
      units,
      new Map([
        [0, element(100)],
        [2, element(100)],
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
