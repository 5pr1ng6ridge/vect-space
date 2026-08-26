export type TextEffect = "shake" | "wave" | "glow";

interface VisibleUnitBase {
  effect: TextEffect | null;
}

export interface CharacterUnit extends VisibleUnitBase {
  kind: "character";
  value: string;
}

export interface MathUnit extends VisibleUnitBase {
  kind: "math";
  latex: string;
  display: boolean;
}

export interface PauseUnit {
  kind: "pause";
  durationMs: number;
}

export interface SpeedUnit {
  kind: "speed";
  cps: number | null;
}

export type MarkupUnit = CharacterUnit | MathUnit | PauseUnit | SpeedUnit;
export type VisibleUnit = CharacterUnit | MathUnit;

export interface PauseWindow {
  startMs: number;
  endMs: number;
}

const OPEN_FX = /^\[fx=(shake|wave|glow)\]/;
const PAUSE = /^\[pause=(\d+)ms\]/;
const SPEED = /^\[speed=(default|\d+(?:\.\d+)?cps)\]/;

export function parseMarkup(source: string): MarkupUnit[] {
  const units: MarkupUnit[] = [];
  const effects: TextEffect[] = [];
  let index = 0;

  while (index < source.length) {
    const remaining = source.slice(index);
    const pause = PAUSE.exec(remaining);
    if (pause?.[1] !== undefined) {
      units.push({ kind: "pause", durationMs: Number(pause[1]) });
      index += pause[0].length;
      continue;
    }
    const speed = SPEED.exec(remaining);
    if (speed?.[1] !== undefined) {
      units.push({
        kind: "speed",
        cps: speed[1] === "default" ? null : Number(speed[1].slice(0, -3)),
      });
      index += speed[0].length;
      continue;
    }
    const openFx = OPEN_FX.exec(remaining);
    if (openFx?.[1] !== undefined) {
      effects.push(openFx[1] as TextEffect);
      index += openFx[0].length;
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
        units.push(character(escaped, effects));
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
          effect: currentEffect(effects),
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
          effect: currentEffect(effects),
        });
        index = end + 1;
        continue;
      }
    }

    const codePoint = source.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const value = String.fromCodePoint(codePoint);
    units.push(character(value, effects));
    index += value.length;
  }

  return units;
}

export function buildRevealSchedule(
  units: MarkupUnit[],
  initialCps: number,
  defaultCps: number,
): number[] {
  const schedule: number[] = [];
  let elapsed = 0;
  let cps = validCps(initialCps, defaultCps);
  for (const unit of units) {
    if (unit.kind === "pause") {
      elapsed += unit.durationMs;
    } else if (unit.kind === "speed") {
      cps =
        unit.cps === null
          ? validCps(defaultCps, 30)
          : validCps(unit.cps, defaultCps);
    } else {
      elapsed += 1000 / cps;
      schedule.push(elapsed);
    }
  }
  return schedule;
}

/**
 * Returns the explicit pauses in the same absolute timeline as the reveal
 * schedule. Character-to-character gaps are intentionally not included: the
 * typing loop should continue playing during normal reveal pacing.
 */
export function buildPauseWindows(
  units: MarkupUnit[],
  initialCps: number,
  defaultCps: number,
): PauseWindow[] {
  const windows: PauseWindow[] = [];
  let elapsed = 0;
  let cps = validCps(initialCps, defaultCps);
  for (const unit of units) {
    if (unit.kind === "pause") {
      const startMs = elapsed;
      elapsed += unit.durationMs;
      windows.push({ startMs, endMs: elapsed });
    } else if (unit.kind === "speed") {
      cps =
        unit.cps === null
          ? validCps(defaultCps, 30)
          : validCps(unit.cps, defaultCps);
    } else {
      elapsed += 1000 / cps;
    }
  }
  return windows;
}

export function visibleUnits(units: MarkupUnit[]): VisibleUnit[] {
  return units.filter(
    (unit): unit is VisibleUnit =>
      unit.kind === "character" || unit.kind === "math",
  );
}

export function autoReadingDelay(source: string): number {
  let characters = 0;
  let inlineMath = 0;
  let blockMath = 0;
  for (const unit of parseMarkup(source)) {
    if (unit.kind === "character") {
      characters += 1;
    } else if (unit.kind === "math") {
      if (unit.display) {
        blockMath += 1;
      } else {
        inlineMath += 1;
      }
    }
  }
  return Math.min(
    5_000,
    Math.max(800, 600 + characters * 35 + inlineMath * 350 + blockMath * 700),
  );
}

function character(value: string, effects: TextEffect[]): CharacterUnit {
  return { kind: "character", value, effect: currentEffect(effects) };
}

function currentEffect(effects: TextEffect[]): TextEffect | null {
  return effects[effects.length - 1] ?? null;
}

function validCps(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function findUnescaped(source: string, marker: string, from: number): number {
  let index = from;
  while (index < source.length) {
    const found = source.indexOf(marker, index);
    if (found < 0) {
      return -1;
    }
    let slashCount = 0;
    for (
      let cursor = found - 1;
      cursor >= 0 && source[cursor] === "\\";
      cursor -= 1
    ) {
      slashCount += 1;
    }
    if (slashCount % 2 === 0) {
      return found;
    }
    index = found + marker.length;
  }
  return -1;
}
