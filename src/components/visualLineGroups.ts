import type { VisibleUnit } from "../engine/markup";

export interface LineSweepUnitTiming {
  /** The first unit that starts this visual row. */
  readonly lineStartIndex: number;
  /** Milliseconds after that first unit before this unit begins its fade. */
  readonly delayMs: number;
  /** The duration of this unit's soft horizontal reveal. */
  readonly durationMs: number;
}

/**
 * Groups inline markup into visual rows without mistaking KaTeX baseline
 * alignment for a line break. Display formulae deliberately form their own
 * row before and after surrounding text.
 */
export function resolveVisualLineGroups(
  units: readonly VisibleUnit[],
  elements: ReadonlyMap<number, HTMLElement>,
): readonly (readonly number[])[] {
  const groups: number[][] = [];
  let lastCenter: number | null = null;
  let lastHeight = 0;
  let previousWasDisplayMath = false;
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    const element = elements.get(index);
    if (unit === undefined || element === undefined) return [];
    const rect = element.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    const tolerance = Math.max(4, Math.max(lastHeight, rect.height) * 0.45);
    const isDisplayMath = unit.kind === "math" && unit.display;
    const startsLine =
      lastCenter === null ||
      previousWasDisplayMath ||
      isDisplayMath ||
      Math.abs(center - lastCenter) > tolerance;
    if (startsLine) groups.push([]);
    groups[groups.length - 1]?.push(index);
    lastCenter = center;
    lastHeight = rect.height;
    previousWasDisplayMath = isDisplayMath;
  }
  return groups;
}

/**
 * Keep the text DOM in its natural inline layout.  A previous implementation
 * rebuilt the measured rows as block elements, which changed wrapping after
 * measurement and could make every remaining row animate at once.  This plan
 * instead gives each already-laid-out unit a time window in its own row.
 */
export function buildLineSweepTimings(
  units: readonly VisibleUnit[],
  groups: readonly (readonly number[])[],
  schedule: readonly number[],
  unitCps: readonly number[],
  mathRevealDurations: ReadonlyMap<number, number>,
): ReadonlyMap<number, LineSweepUnitTiming> {
  const result = new Map<number, LineSweepUnitTiming>();
  for (const group of groups) {
    const lineStartIndex = group[0];
    if (lineStartIndex === undefined) continue;
    const lineStartMs = schedule[lineStartIndex] ?? 0;
    for (const index of group) {
      const unit = units[index];
      if (unit === undefined) continue;
      const cps = unitCps[index] ?? 30;
      const characterDuration = Math.round(
        Math.min(220, Math.max(80, 2_500 / Math.max(1, cps))),
      );
      result.set(index, {
        lineStartIndex,
        delayMs: Math.max(0, (schedule[index] ?? lineStartMs) - lineStartMs),
        durationMs:
          unit.kind === "math"
            ? Math.max(80, mathRevealDurations.get(index) ?? 120)
            : characterDuration,
      });
    }
  }
  return result;
}
