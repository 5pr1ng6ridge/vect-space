import { parseMarkup, type MarkupUnit, type TextEffect } from "@vectspace/text";
import katex from "katex";
import { type ReactElement } from "react";

/**
 * Static editor rendering for authored text.
 *
 * Markup controls are deliberately not represented by DOM nodes. They are
 * timing metadata and must not affect line wrapping or long-text pagination.
 * This keeps the editor's measured body identical to the game's static text
 * renderer.
 */
export function MarkupPreview({ source }: { source: string }): ReactElement {
  const units = parseMarkup(source);
  return (
    <div className="markup-preview">
      {units.map((unit, index) => renderUnit(unit, index))}
    </div>
  );
}

function renderUnit(
  unit: MarkupUnit,
  index: number,
): ReactElement | string | null {
  if (
    unit.kind === "pause" ||
    unit.kind === "speed" ||
    unit.kind === "auto_advance"
  ) {
    return null;
  }
  if (unit.kind === "hard_break") return <br key={`break-${index}`} />;

  const className = effectClass(unit.effect);
  if (unit.kind === "character") {
    return (
      <span className={className} key={`text-${unit.span.start}`}>
        {unit.value}
      </span>
    );
  }

  return (
    <span
      className={`${className ?? ""} ${unit.display ? "markup-display-math" : ""}`.trim()}
      dangerouslySetInnerHTML={{
        __html: katex.renderToString(unit.latex, {
          displayMode: unit.display,
          throwOnError: false,
          strict: "warn",
          trust: false,
        }),
      }}
      key={`math-${unit.span.start}`}
    />
  );
}

function effectClass(effect: TextEffect | null): string | undefined {
  return effect === null ? undefined : `markup-fx markup-fx-${effect}`;
}
