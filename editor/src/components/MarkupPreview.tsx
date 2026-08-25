import katex from "katex";
import { Fragment, type ReactElement } from "react";

type Effect = "shake" | "wave" | "glow";
type Unit =
  | { kind: "text"; value: string; effect: Effect | null }
  | { kind: "math"; latex: string; display: boolean; effect: Effect | null }
  | { kind: "control"; label: string };

export function MarkupPreview({ source }: { source: string }): ReactElement {
  const units = parse(source);
  return (
    <div className="markup-preview">
      {units.map((unit, index) => {
        if (unit.kind === "control") {
          return (
            <span className="markup-control" key={`${unit.label}-${index}`}>
              {unit.label}
            </span>
          );
        }
        const className =
          unit.effect === null
            ? undefined
            : `markup-fx markup-fx-${unit.effect}`;
        if (unit.kind === "text") {
          return (
            <span className={className} key={index}>
              {unit.value}
            </span>
          );
        }
        return (
          <Fragment key={index}>
            <span
              className={`${className ?? ""} ${unit.display ? "markup-display-math" : ""}`}
              dangerouslySetInnerHTML={{
                __html: katex.renderToString(unit.latex, {
                  displayMode: unit.display,
                  throwOnError: false,
                  strict: "warn",
                  trust: false,
                }),
              }}
            />
          </Fragment>
        );
      })}
    </div>
  );
}

function parse(source: string): Unit[] {
  const units: Unit[] = [];
  const effects: Effect[] = [];
  let index = 0;
  while (index < source.length) {
    const remaining = source.slice(index);
    const control =
      /^\[(pause=\d+ms|speed=(?:default|\d+(?:\.\d+)?cps))\]/.exec(remaining);
    if (control?.[1] !== undefined) {
      units.push({ kind: "control", label: control[1] });
      index += control[0].length;
      continue;
    }
    const fx = /^\[fx=(shake|wave|glow)\]/.exec(remaining);
    if (fx?.[1] !== undefined) {
      effects.push(fx[1] as Effect);
      index += fx[0].length;
      continue;
    }
    if (remaining.startsWith("[/fx]") && effects.length > 0) {
      effects.pop();
      index += 5;
      continue;
    }
    if (remaining.startsWith("\\") && remaining.length >= 2) {
      const escaped = remaining[1];
      if (escaped === "$" || escaped === "[" || escaped === "\\") {
        units.push({
          kind: "text",
          value: escaped,
          effect: effects.at(-1) ?? null,
        });
        index += 2;
        continue;
      }
    }
    if (remaining.startsWith("$$")) {
      const end = findUnescaped(source, "$$", index + 2);
      if (end >= 0) {
        units.push({
          kind: "math",
          latex: source.slice(index + 2, end),
          display: true,
          effect: effects.at(-1) ?? null,
        });
        index = end + 2;
        continue;
      }
    }
    if (remaining.startsWith("$")) {
      const end = findUnescaped(source, "$", index + 1);
      if (end >= 0) {
        units.push({
          kind: "math",
          latex: source.slice(index + 1, end),
          display: false,
          effect: effects.at(-1) ?? null,
        });
        index = end + 1;
        continue;
      }
    }
    const codePoint = source.codePointAt(index);
    if (codePoint === undefined) break;
    const value = String.fromCodePoint(codePoint);
    units.push({ kind: "text", value, effect: effects.at(-1) ?? null });
    index += value.length;
  }
  return units;
}

function findUnescaped(source: string, marker: string, from: number): number {
  let index = from;
  while (index < source.length) {
    const found = source.indexOf(marker, index);
    if (found < 0) return -1;
    let slashCount = 0;
    for (
      let cursor = found - 1;
      cursor >= 0 && source[cursor] === "\\";
      cursor -= 1
    ) {
      slashCount += 1;
    }
    if (slashCount % 2 === 0) return found;
    index = found + marker.length;
  }
  return -1;
}
