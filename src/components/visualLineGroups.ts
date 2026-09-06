import {
  formulaPresentationDurationMs,
  mathRevealDurationMs,
  type VisibleUnit,
} from "../engine/markup";

export interface LineSweepUnitTiming {
  /** The first unit that starts this visual row. */
  readonly lineStartIndex: number;
  /** The duration of this row's continuous left-to-right reveal. */
  readonly durationMs: number;
  /** Width of the full visual row in unscaled CSS layout pixels. */
  readonly lineWidthPx: number;
  /** This unit's left edge within the visual row. */
  readonly unitOffsetPx: number;
  /** Absolute reveal-clock bounds for this row, including explicit pauses. */
  readonly startMs: number;
  readonly endMs: number;
}

export interface LineSweepUnitGeometry {
  readonly lineWidthPx: number;
  readonly unitOffsetPx: number;
}

export function isHardLineBreak(unit: VisibleUnit): boolean {
  return (
    unit.kind === "hard_break" ||
    (unit.kind === "character" && unit.value === "\n")
  );
}

/** Pauses split a visual row into independently revealed segments. */
export function splitLinesAtPauses(
  groups: readonly (readonly number[])[],
  schedule: readonly number[],
  pauses: readonly { startMs: number; endMs: number }[],
): readonly (readonly number[])[] {
  return groups.flatMap((group) => {
    const segments: number[][] = [];
    for (const index of group) {
      const lastSegment = segments[segments.length - 1];
      const previous = lastSegment?.[lastSegment.length - 1];
      if (
        previous === undefined ||
        pauses.some(
          (pause) =>
            pause.startMs >= (schedule[previous] ?? 0) &&
            pause.endMs < (schedule[index] ?? 0),
        )
      )
        segments.push([]);
      segments[segments.length - 1]?.push(index);
    }
    return segments;
  });
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
  let forceNextLine = false;
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (unit === undefined) return [];
    if (isHardLineBreak(unit)) {
      forceNextLine = true;
      previousWasDisplayMath = false;
      continue;
    }
    const element = elements.get(index);
    if (element === undefined) return [];
    const rect = element.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    const tolerance = Math.max(4, Math.max(lastHeight, rect.height) * 0.45);
    const isDisplayMath = unit.kind === "math" && unit.display;
    const startsLine =
      lastCenter === null ||
      forceNextLine ||
      previousWasDisplayMath ||
      isDisplayMath ||
      Math.abs(center - lastCenter) > tolerance;
    if (startsLine) groups.push([]);
    groups[groups.length - 1]?.push(index);
    lastCenter = center;
    lastHeight = rect.height;
    previousWasDisplayMath = isDisplayMath;
    forceNextLine = false;
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
  pauseWindows: readonly { startMs: number; endMs: number }[] = [],
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
        ? formulaPresentationDurationMs(
            mathRevealDurationMs(mathRevealDurations.get(lastIndex), lastCps),
            lastUnit.display,
          )
        : characterRevealDuration(lastCps);
    const lineEndMs = (schedule[lastIndex] ?? lineStartMs) + lastUnitDuration;
    const lineDurationMs = Math.max(
      characterRevealDuration(unitCps[lineStartIndex] ?? 30),
      lineEndMs -
        lineStartMs -
        pauseDurationWithin(pauseWindows, lineStartMs, lineEndMs),
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
        startMs: lineStartMs,
        endMs: lineEndMs,
      });
    }
  }
  return result;
}

/**
 * Resolves the mask entirely from the story clock.  Unlike pausing a CSS
 * animation, this never leaves its antialiased feather part-way over a later
 * glyph while a `[pause]` is active.
 */
export function lineSweepMaskPositionPx(
  timing: LineSweepUnitTiming,
  elapsedMs: number,
  pauseWindows: readonly { startMs: number; endMs: number }[],
  featherPx = 51,
): number {
  const boundedElapsed = Math.min(
    timing.endMs,
    Math.max(timing.startMs, elapsedMs),
  );
  const spentMs = Math.max(
    0,
    boundedElapsed -
      timing.startMs -
      pauseDurationWithin(pauseWindows, timing.startMs, boundedElapsed),
  );
  const progress = clamp(spentMs / Math.max(1, timing.durationMs), 0, 1);
  const sweepWidth = timing.lineWidthPx + featherPx;
  // Move one feather-width beyond the nominal row end.  The gradient's tail
  // is transparent, so stopping at `-unitOffset` leaves the final glyphs
  // partially masked.  That was especially visible as tiny gaps between
  // adjacent Chinese characters after a completed sweep.
  return (
    -timing.unitOffsetPx - sweepWidth + (sweepWidth + featherPx) * progress
  );
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
      const box = visibleElementBox(element);
      return [{ index, leftPx: box.leftPx, rightPx: box.rightPx }];
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

function pauseDurationWithin(
  windows: readonly { startMs: number; endMs: number }[],
  startMs: number,
  endMs: number,
): number {
  return windows.reduce((total, window) => {
    const overlapStart = Math.max(startMs, window.startMs);
    const overlapEnd = Math.min(endMs, window.endMs);
    return total + Math.max(0, overlapEnd - overlapStart);
  }, 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function visibleElementBox(element: HTMLElement): {
  leftPx: number;
  rightPx: number;
} {
  const fallback = {
    leftPx: element.offsetLeft,
    rightPx: element.offsetLeft + element.offsetWidth,
  };
  if (!element.classList.contains("math-unit")) return fallback;
  const katex = element.querySelector<HTMLElement>(".katex");
  if (katex === null || element.offsetWidth <= 0) return fallback;

  // A display formula's .math-unit is a full-width block.  Its actual KaTeX
  // content is normally centered within that block, so using the outer box
  // makes a row mask sweep across empty space and hides the real animation.
  const outerRect = element.getBoundingClientRect();
  const katexRect = katex.getBoundingClientRect();
  const scale = outerRect.width / element.offsetWidth;
  if (!Number.isFinite(scale) || scale <= 0 || katexRect.width <= 0) {
    return fallback;
  }
  const leftPx = element.offsetLeft + (katexRect.left - outerRect.left) / scale;
  const widthPx = katexRect.width / scale;
  return {
    leftPx,
    rightPx: leftPx + widthPx,
  };
}
