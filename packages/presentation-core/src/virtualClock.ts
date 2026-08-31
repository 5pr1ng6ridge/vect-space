/** Advances deterministic presentation time using a dynamic playback rate. */
export function advanceVirtualElapsed(
  elapsedMs: number,
  wallDeltaMs: number,
  rate: number,
  durationMs: number,
): number {
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return Math.min(
    Math.max(0, durationMs),
    elapsedMs + Math.max(0, wallDeltaMs) * safeRate,
  );
}
