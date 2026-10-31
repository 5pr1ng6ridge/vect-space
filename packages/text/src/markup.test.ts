import { describe, expect, it } from "vitest";

import {
  autoReadingDelay,
  buildVisibleUnitCps,
  formulaPresentationDurationMs,
  formulaRevealDurationForUnit,
  formulaRevealDurationMs,
  hasImmediateAutoAdvance,
  mathRevealDurationMs,
  parseMarkup,
  revealUnits,
  visibleUnits,
} from "./markup";

describe("shared text markup", () => {
  it("keeps grapheme clusters atomic and records UTF-16 source spans", () => {
    const units = revealUnits(parseMarkup("A👩‍🔬é"));
    expect(
      units.map((unit) => (unit.kind === "character" ? unit.value : "")),
    ).toEqual(["A", "👩‍🔬", "é"]);
    expect(units.map((unit) => unit.span)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 6 },
      { start: 6, end: 8 },
    ]);
  });

  it("normalizes all line endings into hard-break units", () => {
    const units = visibleUnits(parseMarkup("甲\r\n乙\r丙\n丁"));
    expect(
      units.map((unit) =>
        unit.kind === "hard_break"
          ? unit.value
          : unit.kind === "character"
            ? unit.value
            : "math",
      ),
    ).toEqual(["甲", "\n", "乙", "\n", "丙", "\n", "丁"]);
  });

  it("keeps controls out of visible output while retaining their source spans", () => {
    const units = parseMarkup("A[pause=500ms][speed=10cps][auto]B");
    expect(
      revealUnits(units).map((unit) =>
        unit.kind === "character" ? unit.value : "",
      ),
    ).toEqual(["A", "B"]);
    expect(units.filter((unit) => unit.kind === "pause")).toMatchObject([
      { kind: "pause", durationMs: 500, span: { start: 1, end: 14 } },
    ]);
  });

  it("supports escaped markers and keeps unknown brackets as text", () => {
    const units = revealUnits(parseMarkup("\\$ \\[ \\\\ [unknown]"));
    expect(
      units
        .map((unit) => (unit.kind === "character" ? unit.value : ""))
        .join(""),
    ).toBe("$ [ \\ [unknown]");
  });

  it("treats a formula as one atomic unit", () => {
    const units = visibleUnits(parseMarkup("甲$V=\\mathbb R^2$乙"));
    expect(units).toHaveLength(3);
    expect(units[1]).toMatchObject({ kind: "math", latex: "V=\\mathbb R^2" });
  });
});

describe("formula and pacing helpers", () => {
  it("scales formula duration with rendered width and CPS, between one and twelve characters", () => {
    expect(formulaRevealDurationMs(1, 34, 20)).toBe(50);
    expect(formulaRevealDurationMs(680, 34, 30)).toBe(400);
    expect(formulaRevealDurationMs(680, 34, 5)).toBe(2_400);
    expect(formulaRevealDurationMs(0, 0, Number.NaN)).toBeGreaterThan(0);
    expect(mathRevealDurationMs(20, 20)).toBe(50);
  });

  it("gives display formulas the extended presentation and a one-character minimum", () => {
    const unit = revealUnits(parseMarkup("$$x$$"))[0];
    expect(unit?.kind).toBe("math");
    if (unit?.kind !== "math") return;
    expect(formulaRevealDurationForUnit(unit, 20, 20)).toBe(120);
    expect(formulaPresentationDurationMs(100, true)).toBe(120);
  });

  it("tracks speed controls for each visible unit", () => {
    expect(
      buildVisibleUnitCps(
        parseMarkup("A[speed=10cps]$x$[speed=default]B"),
        20,
        30,
      ),
    ).toEqual([20, 10, 30]);
  });

  it("recognizes a terminal immediate-auto marker without rendering it", () => {
    expect(hasImmediateAutoAdvance("这一句显示完后立刻继续。[auto]")).toBe(
      true,
    );
    expect(visibleUnits(parseMarkup("这一句。[auto]"))).toHaveLength(4);
    expect(hasImmediateAutoAdvance("[auto] 这一句仍要显示")).toBe(false);
    expect(hasImmediateAutoAdvance("\\[auto]")).toBe(false);
  });

  it("calculates auto wait from visible text and atomic formulas only", () => {
    expect(
      autoReadingDelay("甲乙$z$[pause=999ms]$$x+y$$[fx=glow]丙[/fx]"),
    ).toBe(1_755);
    expect(autoReadingDelay("短")).toBe(800);
    expect(autoReadingDelay("长".repeat(500))).toBe(5_000);
  });
});
