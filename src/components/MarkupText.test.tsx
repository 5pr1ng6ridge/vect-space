import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkupText } from "./MarkupText";

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
});
