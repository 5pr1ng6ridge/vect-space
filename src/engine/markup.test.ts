import { describe, expect, it } from "vitest";

import {
  buildPauseWindows,
  buildRevealSchedule,
  buildVisibleUnitCps,
  DEFAULT_MATH_REVEAL_DURATION_MS,
  formulaRevealDurationMs,
  autoReadingDelay,
  hasImmediateAutoAdvance,
  parseMarkup,
  revealCompletionTime,
  resolveInstantRevealPromptId,
  visibleUnits,
} from "./markup";

describe("VN markup", () => {
  it("keeps a skipped formula instant when its measurements refresh", () => {
    expect(
      resolveInstantRevealPromptId(
        "scene/formula",
        "scene/formula",
        "scene/formula",
        false,
      ),
    ).toBe("scene/formula");
    expect(
      resolveInstantRevealPromptId(
        "scene/formula",
        "scene/next",
        "scene/formula",
        false,
      ),
    ).toBeNull();
  });

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

  it("leaves a short visual reveal window after formulas", () => {
    const schedule = buildRevealSchedule(parseMarkup("甲$x$乙"), 20, 20);
    expect(schedule).toEqual([50, 100, 150 + DEFAULT_MATH_REVEAL_DURATION_MS]);
  });

  it("uses measured formula duration in the following text timeline", () => {
    const schedule = buildRevealSchedule(
      parseMarkup("甲$x$乙"),
      20,
      20,
      new Map([[1, 240]]),
    );
    expect(schedule).toEqual([50, 100, 390]);
  });

  it("waits for a final formula animation before completing the reveal", () => {
    const units = parseMarkup("甲$x$");
    const durations = new Map([[1, 240]]);
    const schedule = buildRevealSchedule(units, 20, 20, durations);
    expect(revealCompletionTime(units, schedule, durations)).toBe(340);
  });

  it("scales formula reveal duration with rendered width and CPS", () => {
    const normal = formulaRevealDurationMs(340, 34, 40);
    expect(formulaRevealDurationMs(680, 34, 40)).toBeGreaterThan(normal);
    expect(formulaRevealDurationMs(340, 34, 20)).toBeGreaterThan(normal);
    expect(formulaRevealDurationMs(0, 0, Number.NaN)).toBeGreaterThan(0);
  });

  it("gives a long formula enough reveal time without unbounded delays", () => {
    // Formulae are a single reveal unit.  Their visual width contributes at
    // most twelve equivalent characters, so a wide display formula never
    // stalls the next prompt for several seconds.
    expect(formulaRevealDurationMs(680, 34, 30)).toBe(400);
    expect(formulaRevealDurationMs(680, 34, 5)).toBe(600);
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

  it("does not treat normal reveal pacing as an explicit pause", () => {
    expect(buildPauseWindows(parseMarkup("ABC"), 20, 30)).toEqual([]);
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
