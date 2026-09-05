import { describe, expect, it } from "vitest";

import {
  buildPauseWindows,
  buildRevealSchedule,
  formulaRevealDurationForUnit,
  parseMarkup,
  revealUnits,
  visibleUnits,
} from "./markup";

describe("shared text markup", () => {
  it("keeps grapheme clusters atomic and records UTF-16 source spans", () => {
    const units = revealUnits(parseMarkup("A👩‍🔬e\u0301"));
    expect(units.map((unit) => unit.kind === "character" ? unit.value : "")).toEqual([
      "A",
      "👩‍🔬",
      "é",
    ]);
    expect(units.map((unit) => unit.span)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 6 },
      { start: 6, end: 8 },
    ]);
  });

  it("normalizes all line endings into hard-break units", () => {
    const units = visibleUnits(parseMarkup("甲\r\n乙\r丙\n丁"));
    expect(units.map((unit) => unit.kind === "hard_break" ? unit.value : unit.kind === "character" ? unit.value : "math")).toEqual([
      "甲",
      "\n",
      "乙",
      "\n",
      "丙",
      "\n",
      "丁",
    ]);
  });

  it("keeps controls out of visible output while retaining their source spans", () => {
    const units = parseMarkup("A[pause=500ms][speed=10cps][auto]B");
    expect(revealUnits(units).map((unit) => unit.kind === "character" ? unit.value : "")).toEqual(["A", "B"]);
    expect(units.filter((unit) => unit.kind === "pause")).toMatchObject([
      { kind: "pause", durationMs: 500, span: { start: 1, end: 14 } },
    ]);
  });

  it("supports escaped markers and keeps unknown brackets as text", () => {
    const units = revealUnits(parseMarkup("\\$ \\[ \\\\ [unknown]"));
    expect(units.map((unit) => unit.kind === "character" ? unit.value : "").join("")).toBe("$ [ \\ [unknown]");
  });

  it("pauses before subsequent units and allows inline math to overlap", () => {
    const units = parseMarkup("A[pause=500ms]$x$B");
    expect(buildRevealSchedule(units, 20, 20, new Map([[1, 200]]), { waitForInlineMath: false })).toEqual([50, 600, 650]);
    expect(buildPauseWindows(units, 20, 20, new Map([[1, 200]]), { waitForInlineMath: false })).toEqual([
      { startMs: 50, endMs: 550, span: { start: 1, end: 14 } },
    ]);
  });

  it("keeps display math blocking and enforces a one-character minimum", () => {
    const unit = revealUnits(parseMarkup("$$x$$"))[0];
    expect(unit?.kind).toBe("math");
    if (unit?.kind !== "math") return;
    expect(formulaRevealDurationForUnit(unit, 20, 20)).toBe(120);
    expect(buildRevealSchedule(parseMarkup("$$x$$B"), 20, 20, new Map([[0, 240]]), { waitForInlineMath: false })).toEqual([50, 388]);
  });
});
