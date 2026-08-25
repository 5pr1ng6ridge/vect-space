import { describe, expect, it } from "vitest";

import { buildRevealSchedule, parseMarkup, visibleUnits } from "./markup";

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
    const schedule = buildRevealSchedule(
      parseMarkup("A[pause=500ms][speed=10cps]B"),
      20,
      30,
    );
    expect(schedule[0]).toBe(50);
    expect(schedule[1]).toBe(650);
  });
});
