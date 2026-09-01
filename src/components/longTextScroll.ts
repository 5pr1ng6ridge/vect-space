export const LONG_TEXT_SCROLL_TRIGGER_LINE = 785;
const LONG_TEXT_SCROLL_RESET_LINE = 560;

export interface LongTextScrollInput {
  initialPositioned: boolean;
  manuallyBrowsing: boolean;
  stepStartY: number;
  cursorY: number;
  currentOffset: number;
  maxScroll: number;
}

export interface LongTextScrollDecision {
  offset: number;
  instant: boolean;
}

/**
 * Long text moves in discrete reading-sized jumps rather than chasing every
 * revealed character. A new step is placed immediately; a very long step only
 * moves again after its cursor crosses the lower reading boundary.
 */
export function resolveLongTextScroll(
  input: LongTextScrollInput,
): LongTextScrollDecision | null {
  if (!input.initialPositioned) {
    return {
      offset: clamp(
        input.stepStartY - LONG_TEXT_SCROLL_RESET_LINE,
        0,
        input.maxScroll,
      ),
      instant: true,
    };
  }
  if (
    input.manuallyBrowsing ||
    input.cursorY - input.currentOffset < LONG_TEXT_SCROLL_TRIGGER_LINE
  ) {
    return null;
  }
  const offset = clamp(
    input.cursorY - LONG_TEXT_SCROLL_RESET_LINE,
    0,
    input.maxScroll,
  );
  return Math.abs(offset - input.currentOffset) < 1
    ? null
    : { offset, instant: false };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
