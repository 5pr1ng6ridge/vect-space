import katex from "katex";
import { useMemo, type CSSProperties, type ReactElement } from "react";

import { parseMarkup, visibleUnits } from "../engine/markup";

interface MarkupTextProps {
  source: string;
  visibleCount?: number;
  className?: string;
}

export function MarkupText({
  source,
  visibleCount = Number.POSITIVE_INFINITY,
  className,
}: MarkupTextProps): ReactElement {
  const units = useMemo(() => visibleUnits(parseMarkup(source)), [source]);
  return (
    <span className={className} aria-label={source}>
      {units.map((unit, index) => {
        const visible = index < visibleCount;
        const style = {
          visibility: visible ? "visible" : "hidden",
          "--unit-index": index,
        } as CSSProperties;
        const effectClass =
          unit.effect === null ? "" : ` text-fx-${unit.effect}`;
        if (unit.kind === "math") {
          const html = katex.renderToString(unit.latex, {
            displayMode: unit.display,
            throwOnError: false,
            strict: "ignore",
            trust: false,
            output: "html",
          });
          return (
            <span
              aria-hidden="true"
              className={`markup-unit math-unit${unit.display ? " display-math" : ""}${effectClass}`}
              dangerouslySetInnerHTML={{ __html: html }}
              key={`${index}-math`}
              style={style}
            />
          );
        }
        return (
          <span
            aria-hidden="true"
            className={`markup-unit character-unit${effectClass}`}
            key={`${index}-${unit.value}`}
            style={style}
          >
            {unit.value}
          </span>
        );
      })}
    </span>
  );
}
