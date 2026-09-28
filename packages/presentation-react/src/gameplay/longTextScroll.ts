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

export interface LongTextRevealThresholdInput {
  startOffset: number;
  targetOffset: number;
  currentOffset: number;
  fraction?: number;
}

/**
 * Places a complete paragraph before its reveal begins. Short paragraphs use
 * the smallest movement that fits them between the two reading guards. A
 * paragraph taller than the safe area is aligned to the upper guard; the
 * cursor follower takes over once its reveal starts.
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

/** Releases paragraph reveal after a stable fraction of its planned scroll. */
export function hasReachedLongTextRevealThreshold({
  startOffset,
  targetOffset,
  currentOffset,
  fraction = 0.5,
}: LongTextRevealThresholdInput): boolean {
  const distance = Math.abs(targetOffset - startOffset);
  if (distance <= 0.5) return true;
  const direction = Math.sign(targetOffset - startOffset);
  const travelled = (currentOffset - startOffset) * direction;
  return travelled + 0.5 >= distance * clamp(fraction, 0, 1);
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
