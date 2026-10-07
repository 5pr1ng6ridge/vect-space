import { renderMarkupFormula } from "@vectspace/presentation-core/static-markup";
import { memo, useMemo, type ReactElement } from "react";

import { parseMarkup, type MarkupUnit } from "@vectspace/text";

/**
 * Plain, screen-reader-usable text of a markup label.
 *
 * The rendered label hides its characters and KaTeX output from the
 * accessibility tree, so a host that needs an accessible name (a native choice
 * button) must derive one from the shared markup parser instead of guessing:
 * control tags (`[pause]`, `[speed]`, `[fx]`) are dropped, math delimiters are
 * stripped and hard breaks become spaces.  This never exposes raw `$`
 * delimiters or aria-hidden KaTeX-only content as the button name.
 */
export function markupAccessibleLabel(source: string): string {
  const parts: string[] = [];
  for (const unit of parseMarkup(source)) {
    if (unit.kind === "character") parts.push(unit.value);
    else if (unit.kind === "math") parts.push(unit.latex);
    else if (unit.kind === "hard_break") parts.push(" ");
  }
  return parts.join("").replace(/\s+/gu, " ").trim();
}

export interface MarkupLabelProps {
  source: string;
  className?: string;
  /**
   * Accessible name override.  The static markup itself stays hidden from the
   * accessibility tree, exactly like the animated dialogue surface.
   */
  ariaLabel?: string;
}

/**
 * The static shared markup label.
 *
 * Choice labels are already interpolated by the runtime and are never
 * revealed character by character, so they need the KaTeX/markup pipeline
 * without a reveal clock.  The unit classes match the animated surfaces
 * (`markup-unit character-unit` / `markup-unit math-unit`) so both hosts style
 * labels with the same typography and formula rules.
 */
export const MarkupLabel = memo(function MarkupLabel({
  source,
  className,
  ariaLabel,
}: MarkupLabelProps): ReactElement {
  const units = useMemo(() => parseMarkup(source), [source]);
  return (
    <span aria-label={ariaLabel} className={className}>
      {units.map((unit, index) => renderUnit(unit, index))}
    </span>
  );
});

function renderUnit(unit: MarkupUnit, index: number): ReactElement | null {
  if (unit.kind === "character") {
    return (
      <span
        aria-hidden="true"
        className="markup-unit character-unit"
        key={`text-${index}-${unit.value}`}
      >
        <span className="markup-reveal-content">{unit.value}</span>
        <wbr />
      </span>
    );
  }
  if (unit.kind === "math") {
    return (
      <span
        aria-hidden="true"
        className={`markup-unit math-unit${unit.display ? " display-math" : ""}`}
        dangerouslySetInnerHTML={{
          __html: renderMarkupFormula(unit.latex, unit.display),
        }}
        key={`math-${index}-${unit.latex}`}
      />
    );
  }
  if (unit.kind === "hard_break") {
    return <br aria-hidden="true" key={`break-${index}`} />;
  }
  return null;
}
