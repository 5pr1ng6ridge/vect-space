import type { VisibleUnit } from "../engine/markup";

export interface LineSweepUnitTiming {
  /** The first unit that starts this visual row. */
  readonly lineStartIndex: number;
  /** The duration of this row's continuous left-to-right reveal. */
  readonly durationMs: number;
  /** Width of the full visual row in unscaled CSS layout pixels. */
  readonly lineWidthPx: number;
  /** This unit's left edge within the visual row. */
  readonly unitOffsetPx: number;
}

export interface LineSweepUnitGeometry {
  readonly lineWidthPx: number;
  readonly unitOffsetPx: number;
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
  geometry: ReadonlyMap<number, LineSweepUnitGeometry>,
): ReadonlyMap<number, LineSweepUnitTiming> {
  const result = new Map<number, LineSweepUnitTiming>();
  for (const group of groups) {
    const lineStartIndex = group[0];
    if (lineStartIndex === undefined) continue;
    const lineStartMs = schedule[lineStartIndex] ?? 0;
    const lastIndex = group[group.length - 1];
    if (lastIndex === undefined) continue;
    const lastUnit = units[lastIndex];
    if (lastUnit === undefined) continue;
    const lastCps = unitCps[lastIndex] ?? 30;
    const lastUnitDuration =
      lastUnit.kind === "math"
        ? resolveMathDuration(mathRevealDurations.get(lastIndex), lastCps)
        : characterRevealDuration(lastCps);
    const lineDurationMs = Math.max(
      characterRevealDuration(unitCps[lineStartIndex] ?? 30),
      (schedule[lastIndex] ?? lineStartMs) - lineStartMs + lastUnitDuration,
    );
    for (const index of group) {
      const unit = units[index];
      if (unit === undefined) continue;
      const unitGeometry = geometry.get(index);
      if (unitGeometry === undefined) continue;
      result.set(index, {
        lineStartIndex,
        durationMs: Math.round(lineDurationMs),
        lineWidthPx: unitGeometry.lineWidthPx,
        unitOffsetPx: unitGeometry.unitOffsetPx,
      });
    }
  }
  return result;
}

/** Captures geometry outside React render, in the unscaled CSS layout space. */
export function buildLineSweepGeometry(
  groups: readonly (readonly number[])[],
  elements: ReadonlyMap<number, HTMLElement>,
): ReadonlyMap<number, LineSweepUnitGeometry> {
  const result = new Map<number, LineSweepUnitGeometry>();
  for (const group of groups) {
    const laidOutUnits = group.flatMap((index) => {
      const element = elements.get(index);
      if (element === undefined) return [];
      return [
        {
          index,
          leftPx: element.offsetLeft,
          rightPx: element.offsetLeft + element.offsetWidth,
        },
      ];
    });
    if (laidOutUnits.length !== group.length) continue;
    const lineLeftPx = Math.min(...laidOutUnits.map((unit) => unit.leftPx));
    const lineRightPx = Math.max(...laidOutUnits.map((unit) => unit.rightPx));
    const lineWidthPx = Math.max(1, lineRightPx - lineLeftPx);
    for (const unit of laidOutUnits) {
      result.set(unit.index, {
        lineWidthPx,
        unitOffsetPx: unit.leftPx - lineLeftPx,
      });
    }
  }
  return result;
}

function characterRevealDuration(cps: number): number {
  return 1_000 / Math.max(1, cps);
}

function resolveMathDuration(value: number | undefined, cps: number): number {
  return Math.max(
    characterRevealDuration(cps),
    Number.isFinite(value) && (value ?? 0) > 0
      ? (value ?? characterRevealDuration(cps))
      : characterRevealDuration(cps),
  );
}
