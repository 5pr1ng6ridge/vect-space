import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { parseMarkup, visibleUnits } from "../engine/markup";
import { MarkupText } from "./MarkupText";
import { resolveVisualLineGroups } from "./visualLineGroups";

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
});
