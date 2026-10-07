import katex from "katex";
import { parseMarkup } from "@vectspace/text";

export function renderMarkupFormula(latex: string, display: boolean): string {
  return katex.renderToString(latex, {
    displayMode: display,
    throwOnError: false,
    strict: "ignore",
    trust: false,
    output: "html",
  });
}

export function escapeMarkupHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

/** Controls and animated glyph effects have no clock in a fixed label. */
export function renderStaticMarkup(source: string): string {
  return parseMarkup(source).map((unit) => {
    if (unit.kind === "character") return escapeMarkupHtml(unit.value);
    if (unit.kind === "hard_break") return "<br/>";
    if (unit.kind === "math") return renderMarkupFormula(unit.latex, unit.display);
    return "";
  }).join("");
}
