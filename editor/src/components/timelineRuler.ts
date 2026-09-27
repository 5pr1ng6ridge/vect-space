/** Horizontal zoom and ruler ticks of the shared keyframe surface. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 32;

export function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

const TICK_STEPS_MS = [
  10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000,
];

/** Ruler ticks: roughly ten per visible width, labelled in seconds. */
export function rulerTicks(
  durationMs: number,
  zoom: number,
): { at: number; label: string }[] {
  const duration = Math.max(1, durationMs);
  const wanted = duration / (10 * zoom);
  const step =
    TICK_STEPS_MS.find((candidate) => candidate >= wanted) ??
    TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
  const decimals = step < 100 ? 2 : step < 1000 ? 1 : 0;
  const ticks: { at: number; label: string }[] = [];
  for (let at = 0; at <= duration + 0.5; at += step) {
    ticks.push({ at, label: `${(at / 1000).toFixed(decimals)}s` });
  }
  return ticks;
}
