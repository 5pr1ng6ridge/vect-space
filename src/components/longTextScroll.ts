export const LONG_TEXT_BOTTOM_BROWSING_SPACE = 240;

export interface LongTextScrollTargetInput {
  cursorY: number;
  viewportHeight: number;
  maxScroll: number;
}

export interface LongTextParagraphTargetInput {
  stepStartY: number;
  stepHeight: number;
  currentOffset: number;
  viewportHeight: number;
  maxScroll: number;
}

/**
 * Places a complete paragraph before its reveal begins. Short paragraphs use
 * the smallest movement that fits them between the two reading guards. A
 * paragraph taller than the safe area is aligned to the upper guard and is
 * not followed again while it is typing.
 */
export function longTextParagraphTarget({
  stepStartY,
  stepHeight,
  currentOffset,
  viewportHeight,
  maxScroll,
}: LongTextParagraphTargetInput): number {
  const safeTop = Math.min(96, viewportHeight * 0.16);
  const safeBottom = viewportHeight * 0.76;
  const visibleTop = stepStartY - currentOffset;
  const visibleBottom = visibleTop + stepHeight;
  if (visibleTop >= safeTop && visibleBottom <= safeBottom) {
    return clamp(currentOffset, 0, maxScroll);
  }
  const safeHeight = safeBottom - safeTop;
  const desired =
    stepHeight > safeHeight || visibleTop < safeTop
      ? stepStartY - safeTop
      : stepStartY + stepHeight - safeBottom;
  return clamp(desired, 0, maxScroll);
}

/**
 * The reader only starts following once the active glyph reaches the lower
 * guard. The target stays ahead of it, so a new page never needs a discrete
 * corrective jump.
 */
export function longTextFollowTarget({
  cursorY,
  viewportHeight,
  maxScroll,
}: LongTextScrollTargetInput): number | null {
  const guard = viewportHeight * 0.76;
  if (cursorY < guard) return null;
  const anchor = viewportHeight * 0.62;
  return clamp(cursorY - anchor, 0, maxScroll);
}

export function longTextMaxScroll(
  surfaceHeight: number,
  viewportHeight = 1_080,
): number {
  return Math.max(
    0,
    surfaceHeight - viewportHeight + LONG_TEXT_BOTTOM_BROWSING_SPACE,
  );
}

/** Legacy pure helper retained for older callers; new rendering uses the
 * frame-rate-independent controller above. */
export interface LongTextScrollInput {
  initialPositioned: boolean;
  initialPlacementInstant?: boolean;
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

export function resolveLongTextScroll(
  input: LongTextScrollInput,
): LongTextScrollDecision | null {
  if (!input.initialPositioned) {
    return {
      offset: clamp(input.stepStartY - 560, 0, input.maxScroll),
      instant: input.initialPlacementInstant ?? true,
    };
  }
  if (input.manuallyBrowsing || input.cursorY - input.currentOffset < 785) {
    return null;
  }
  const offset = clamp(input.cursorY - 560, 0, input.maxScroll);
  return Math.abs(offset - input.currentOffset) < 1
    ? null
    : { offset, instant: false };
}

/** Frame-rate-independent, bounded first-order follower. */
export function advanceLongTextScroll(
  current: number,
  target: number,
  elapsedMs: number,
  fastForward: boolean,
): number {
  const dt = Math.min(50, Math.max(0, elapsedMs)) / 1_000;
  const halfLife = fastForward ? 0.025 : 0.16;
  const maximumSpeed = fastForward ? 12_000 : 2_400;
  const alpha = 1 - Math.pow(0.5, dt / halfLife);
  const desired = (target - current) * alpha;
  const maximumDelta = maximumSpeed * dt;
  return current + clamp(desired, -maximumDelta, maximumDelta);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
