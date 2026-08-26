import { describe, expect, it } from "vitest";

import {
  buildPauseWindows,
  buildRevealSchedule,
  autoReadingDelay,
  parseMarkup,
  visibleUnits,
} from "./markup";

describe("VN markup", () => {
  it("treats a formula as one atomic reveal unit", () => {
    const units = visibleUnits(parseMarkup("甲$V=\\mathbb R^2$乙"));
    expect(units).toHaveLength(3);
    expect(units[1]).toMatchObject({ kind: "math", latex: "V=\\mathbb R^2" });
  });

  it("supports literal escapes without accepting HTML", () => {
    const units = visibleUnits(parseMarkup("\\$ \\[ \\\\"));
    expect(
      units
        .map((unit) => (unit.kind === "character" ? unit.value : ""))
        .join(""),
    ).toBe("$ [ \\");
  });

  it("accounts for pause and speed controls", () => {
    const units = parseMarkup("A[pause=500ms][speed=10cps]B");
    const schedule = buildRevealSchedule(units, 20, 30);
    expect(schedule[0]).toBe(50);
    expect(schedule[1]).toBe(650);

    expect(buildPauseWindows(units, 20, 30)).toEqual([
      { startMs: 50, endMs: 550 },
    ]);
  });

  it("does not treat normal reveal pacing as an explicit pause", () => {
    expect(buildPauseWindows(parseMarkup("ABC"), 20, 30)).toEqual([]);
  });

  it("calculates auto wait from visible text and atomic formulas only", () => {
    expect(
      autoReadingDelay("甲乙$z$[pause=999ms]$$x+y$$[fx=glow]丙[/fx]"),
    ).toBe(1_755);
    expect(autoReadingDelay("短")).toBe(800);
    expect(autoReadingDelay("长".repeat(500))).toBe(5_000);
  });
});
