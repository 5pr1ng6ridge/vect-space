/**
 * The shared, renderer-independent representation of VECTSPACE text.
 *
 * Positions are UTF-16 offsets, matching JavaScript's string indexing and the
 * ranges used by the editor.  A visible unit is atomic: a grapheme is never
 * split and a TeX expression is never split.
 */

export type TextEffect = "shake" | "wave" | "glow";

export interface SourceSpan {
  start: number;
  end: number;
}

interface UnitBase {
  span: SourceSpan;
}

interface VisibleUnitBase extends UnitBase {
  effect: TextEffect | null;
}

export interface CharacterUnit extends VisibleUnitBase {
  kind: "character";
  value: string;
}

export interface HardBreakUnit extends VisibleUnitBase {
  kind: "hard_break";
  value: "\n";
}

export interface MathUnit extends VisibleUnitBase {
  kind: "math";
  latex: string;
  display: boolean;
}

export interface PauseUnit extends UnitBase {
  kind: "pause";
  durationMs: number;
}

export interface SpeedUnit extends UnitBase {
  kind: "speed";
  cps: number | null;
}

export interface AutoAdvanceUnit extends UnitBase {
  kind: "auto_advance";
}

/** Markup controls are kept in the source map, while fx tags affect units. */
export type MarkupUnit =
  | CharacterUnit
  | HardBreakUnit
  | MathUnit
  | PauseUnit
  | SpeedUnit
  | AutoAdvanceUnit;

export type RevealUnit = CharacterUnit | MathUnit;
export type LayoutUnit = CharacterUnit | HardBreakUnit | MathUnit;

export interface PauseWindow {
  startMs: number;
  endMs: number;
  /** Source range of the pause marker, useful for editor diagnostics. */
  span: SourceSpan;
}

export interface RevealTimingOptions {
  /** Inline math can animate concurrently with following characters. */
  waitForInlineMath?: boolean;
}

export interface RevealScheduleOptions extends RevealTimingOptions {
  mathRevealDurations?: ReadonlyMap<number, number>;
}

const OPEN_FX = /^\[fx=(shake|wave|glow)\]/;
const CLOSE_FX = /^\[\/fx\]/;
const PAUSE = /^\[pause=(\d+)ms\]/;
const SPEED = /^\[speed=(default|\d+(?:\.\d+)?cps)\]/;
const AUTO_ADVANCE = /^\[auto\]/;
const MIN_FORMULA_REVEAL_DURATION_MS = 100;

/**
 * Parses the supported text markup without ever treating input as HTML.
 * Unknown or malformed bracket text remains ordinary text.  This is
 * intentional: authors can write prose containing square brackets safely.
 */
export function parseMarkup(source: string): MarkupUnit[] {
  const units: MarkupUnit[] = [];
  const effects: TextEffect[] = [];
  let index = 0;

  while (index < source.length) {
    const remaining = source.slice(index);

    const pause = PAUSE.exec(remaining);
    if (pause?.[1] !== undefined) {
      units.push({
        kind: "pause",
        durationMs: Number(pause[1]),
        span: span(index, index + pause[0].length),
      });
      index += pause[0].length;
      continue;
    }

    const speed = SPEED.exec(remaining);
    if (speed?.[1] !== undefined) {
      units.push({
        kind: "speed",
        cps: speed[1] === "default" ? null : Number(speed[1].slice(0, -3)),
        span: span(index, index + speed[0].length),
      });
      index += speed[0].length;
      continue;
    }

    if (AUTO_ADVANCE.test(remaining)) {
      units.push({
        kind: "auto_advance",
        span: span(index, index + "[auto]".length),
      });
      index += "[auto]".length;
      continue;
    }

    const openFx = OPEN_FX.exec(remaining);
    if (openFx?.[1] !== undefined) {
      effects.push(openFx[1] as TextEffect);
      index += openFx[0].length;
      continue;
    }

    if (CLOSE_FX.test(remaining) && effects.length > 0) {
      effects.pop();
      index += "[/fx]".length;
      continue;
    }

    if (remaining.startsWith("\\") && remaining.length >= 2) {
      const escaped = remaining[1];
      if (escaped === "$" || escaped === "[" || escaped === "\\") {
        units.push(character(escaped, effects, index, index + 2));
        index += 2;
        continue;
      }
    }

    if (remaining.startsWith("\r\n")) {
      units.push(hardBreak(effects, index, index + 2));
      index += 2;
      continue;
    }
    if (remaining.startsWith("\r") || remaining.startsWith("\n")) {
      units.push(hardBreak(effects, index, index + 1));
      index += 1;
      continue;
    }

    if (remaining.startsWith("$$")) {
      const end = findUnescaped(source, "$$", index + 2);
      if (end >= 0) {
        units.push({
          kind: "math",
          latex: source.slice(index + 2, end),
          display: true,
          effect: currentEffect(effects),
          span: span(index, end + 2),
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
          span: span(index, end + 1),
        });
        index = end + 1;
        continue;
      }
    }

    const grapheme = nextGrapheme(source, index);
    if (grapheme === "") break;
    units.push(character(grapheme, effects, index, index + grapheme.length));
    index += grapheme.length;
  }

  return units;
}

export function visibleUnits(units: MarkupUnit[]): LayoutUnit[] {
  return units.filter(
    (unit): unit is LayoutUnit =>
      unit.kind === "character" ||
      unit.kind === "hard_break" ||
      unit.kind === "math",
  );
}

export function revealUnits(units: MarkupUnit[]): RevealUnit[] {
  return units.filter(
    (unit): unit is RevealUnit =>
      unit.kind === "character" || unit.kind === "math",
  );
}

export function buildVisibleUnitCps(
  units: MarkupUnit[],
  initialCps: number,
  defaultCps: number,
): number[] {
  const result: number[] = [];
  let cps = validCps(initialCps, defaultCps);
  for (const unit of units) {
    if (unit.kind === "speed") {
      cps = unit.cps === null ? validCps(defaultCps, 30) : validCps(unit.cps, defaultCps);
    } else if (unit.kind === "character" || unit.kind === "math") {
      result.push(cps);
    }
  }
  return result;
}

/**
 * Returns one start time per reveal unit.  The time is the point at which the
 * unit becomes visible; a blocking formula adds its measured animation time.
 */
export function buildRevealSchedule(
  units: MarkupUnit[],
  initialCps: number,
  defaultCps: number,
  mathRevealDurations: ReadonlyMap<number, number> = new Map(),
  options: RevealTimingOptions = {},
): number[] {
  const schedule: number[] = [];
  let elapsed = 0;
  let cps = validCps(initialCps, defaultCps);
  let revealIndex = 0;
  for (const unit of units) {
    if (unit.kind === "pause") elapsed += unit.durationMs;
    else if (unit.kind === "speed") {
      cps = unit.cps === null ? validCps(defaultCps, 30) : validCps(unit.cps, defaultCps);
    } else if (unit.kind === "character" || unit.kind === "math") {
      elapsed += 1_000 / cps;
      schedule.push(elapsed);
      if (unit.kind === "math" && shouldWaitForMath(unit, options)) {
        elapsed += formulaRevealDurationForUnit(unit, mathRevealDurations.get(revealIndex), cps);
      }
      revealIndex += 1;
    }
  }
  return schedule;
}

export function buildPauseWindows(
  units: MarkupUnit[],
  initialCps: number,
  defaultCps: number,
  mathRevealDurations: ReadonlyMap<number, number> = new Map(),
  options: RevealTimingOptions = {},
): PauseWindow[] {
  const windows: PauseWindow[] = [];
  let elapsed = 0;
  let cps = validCps(initialCps, defaultCps);
  let revealIndex = 0;
  for (const unit of units) {
    if (unit.kind === "pause") {
      windows.push({
        startMs: elapsed,
        endMs: elapsed + unit.durationMs,
        span: unit.span,
      });
      elapsed += unit.durationMs;
    } else if (unit.kind === "speed") {
      cps = unit.cps === null ? validCps(defaultCps, 30) : validCps(unit.cps, defaultCps);
    } else if (unit.kind === "character" || unit.kind === "math") {
      elapsed += 1_000 / cps;
      if (unit.kind === "math" && shouldWaitForMath(unit, options)) {
        elapsed += formulaRevealDurationForUnit(unit, mathRevealDurations.get(revealIndex), cps);
      }
      revealIndex += 1;
    }
  }
  return windows;
}

export function revealCompletionTime(
  units: MarkupUnit[],
  schedule: readonly number[],
  mathRevealDurations: ReadonlyMap<number, number> = new Map(),
  animation: "line_sweep" | "typewriter" | "drop_fade" = "typewriter",
  unitCps: readonly number[] = [],
  options: RevealTimingOptions = {},
): number {
  const visible = revealUnits(units);
  if (visible.length === 0) return 0;
  const finalIndex = visible.length - 1;
  const finalUnit = visible[finalIndex];
  const finalAt = schedule[finalIndex] ?? 0;
  const formulaBlocks = finalUnit?.kind === "math" && shouldWaitForMath(finalUnit, options);
  const animationMs =
    finalUnit?.kind === "math" && formulaBlocks
      ? formulaRevealDurationForUnit(finalUnit, mathRevealDurations.get(finalIndex), unitCps[finalIndex] ?? 30)
      : animation === "drop_fade"
        ? 160
        : animation === "line_sweep"
          ? characterRevealDuration(unitCps[finalIndex] ?? 30)
          : 0;
  const lastBlockingMathEnd = visible.reduce((latest, unit, index) => {
    if (unit.kind !== "math" || !shouldWaitForMath(unit, options)) return latest;
    const at = schedule[index] ?? 0;
    return Math.max(latest, at + formulaRevealDurationForUnit(unit, mathRevealDurations.get(index), unitCps[index] ?? 30));
  }, 0);
  return Math.max(finalAt + animationMs, lastBlockingMathEnd, totalTimelineMs(units, schedule, mathRevealDurations, options, unitCps));
}

export function formulaRevealDurationMs(widthPx: number, fontSizePx: number, cps: number): number {
  const safeCps = validCps(cps, 30);
  const safeFontSize = Number.isFinite(fontSizePx) && fontSizePx > 0 ? fontSizePx : 34;
  const safeWidth = Number.isFinite(widthPx) && widthPx > 0 ? widthPx : safeFontSize;
  const equivalentCharacters = Math.min(48, Math.max(1, safeWidth / safeFontSize));
  const characterDuration = characterRevealDuration(safeCps);
  return Math.round(Math.max(MIN_FORMULA_REVEAL_DURATION_MS, characterDuration, characterDuration * equivalentCharacters));
}

export function formulaPresentationDurationMs(durationMs: number, display: boolean): number {
  return display ? Math.round(Math.max(120, durationMs * 1.2)) : durationMs;
}

export function mathRevealDurationMs(value: number | undefined, cps: number): number {
  return validMathRevealDuration(value, cps);
}

export function formulaRevealDurationForUnit(unit: MathUnit, value: number | undefined, cps: number): number {
  return formulaPresentationDurationMs(validMathRevealDuration(value, cps), unit.display);
}

export function hasImmediateAutoAdvance(source: string): boolean {
  const units = parseMarkup(source.trimEnd());
  return units[units.length - 1]?.kind === "auto_advance";
}

export function autoReadingDelay(source: string): number {
  let characters = 0;
  let inlineMath = 0;
  let blockMath = 0;
  for (const unit of parseMarkup(source)) {
    if (unit.kind === "character") characters += 1;
    else if (unit.kind === "math") unit.display ? (blockMath += 1) : (inlineMath += 1);
  }
  return Math.min(5_000, Math.max(800, 600 + characters * 35 + inlineMath * 350 + blockMath * 700));
}

function totalTimelineMs(
  units: MarkupUnit[],
  schedule: readonly number[],
  durations: ReadonlyMap<number, number>,
  options: RevealTimingOptions,
  unitCps: readonly number[],
): number {
  let elapsed = 0;
  let revealIndex = 0;
  for (const unit of units) {
    if (unit.kind === "pause") {
      elapsed += unit.durationMs;
      continue;
    }
    if (unit.kind === "speed") continue;
    if (unit.kind !== "character" && unit.kind !== "math") continue;
    elapsed = Math.max(elapsed, schedule[revealIndex] ?? elapsed);
    if (unit.kind === "math" && shouldWaitForMath(unit, options)) {
      elapsed += formulaRevealDurationForUnit(
        unit,
        durations.get(revealIndex),
        unitCps[revealIndex] ?? 30,
      );
    }
    revealIndex += 1;
  }
  return Math.max(elapsed, schedule[schedule.length - 1] ?? 0);
}

function validMathRevealDuration(value: number | undefined, cps: number): number {
  return Math.max(MIN_FORMULA_REVEAL_DURATION_MS, characterRevealDuration(cps), Number.isFinite(value) && (value ?? 0) > 0 ? (value as number) : characterRevealDuration(cps));
}

function characterRevealDuration(cps: number): number {
  return 1_000 / validCps(cps, 30);
}

function shouldWaitForMath(unit: MathUnit, options: RevealTimingOptions): boolean {
  return unit.display || options.waitForInlineMath !== false;
}

function character(value: string, effects: TextEffect[], start: number, end: number): CharacterUnit {
  return { kind: "character", value, effect: currentEffect(effects), span: span(start, end) };
}

function hardBreak(effects: TextEffect[], start: number, end: number): HardBreakUnit {
  return { kind: "hard_break", value: "\n", effect: currentEffect(effects), span: span(start, end) };
}

function currentEffect(effects: TextEffect[]): TextEffect | null {
  return effects[effects.length - 1] ?? null;
}

function span(start: number, end: number): SourceSpan {
  return { start, end };
}

function validCps(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function findUnescaped(source: string, marker: string, from: number): number {
  let index = from;
  while (index < source.length) {
    const found = source.indexOf(marker, index);
    if (found < 0) return -1;
    let slashCount = 0;
    for (let cursor = found - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashCount += 1;
    if (slashCount % 2 === 0) return found;
    index = found + marker.length;
  }
  return -1;
}

function nextGrapheme(source: string, start: number): string {
  const segmenter = getSegmenter();
  if (segmenter !== null) {
    const first = segmenter.segment(source.slice(start))[Symbol.iterator]().next().value as { segment?: string } | undefined;
    if (first?.segment !== undefined) return first.segment;
  }
  return fallbackGrapheme(source, start);
}

interface SegmenterLike {
  segment(input: string): Iterable<{ segment: string }>;
}

let cachedSegmenter: SegmenterLike | null | undefined;

function getSegmenter(): SegmenterLike | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter;
  const intl = Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => SegmenterLike };
  cachedSegmenter = intl.Segmenter === undefined ? null : new intl.Segmenter(undefined, { granularity: "grapheme" });
  return cachedSegmenter;
}

function fallbackGrapheme(source: string, start: number): string {
  let end = start;
  let codePoint = source.codePointAt(end);
  if (codePoint === undefined) return "";
  end += codePoint > 0xffff ? 2 : 1;
  let regional = isRegionalIndicator(codePoint);
  while (end < source.length) {
    codePoint = source.codePointAt(end);
    if (codePoint === undefined) break;
    const length = codePoint > 0xffff ? 2 : 1;
    if (isCombining(codePoint) || isVariationSelector(codePoint) || isEmojiModifier(codePoint)) {
      end += length;
      continue;
    }
    if (codePoint === 0x200d) {
      const next = source.codePointAt(end + 1);
      if (next === undefined) break;
      end += 1 + (next > 0xffff ? 2 : 1);
      continue;
    }
    if (regional && isRegionalIndicator(codePoint)) {
      end += length;
      regional = false;
      continue;
    }
    break;
  }
  return source.slice(start, end);
}

function isCombining(codePoint: number): boolean {
  return /\p{Mark}/u.test(String.fromCodePoint(codePoint));
}

function isVariationSelector(codePoint: number): boolean {
  return (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef);
}

function isEmojiModifier(codePoint: number): boolean {
  return codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}
