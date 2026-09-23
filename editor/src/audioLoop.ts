/**
 * Pure geometry and constraint helpers for the per-node BGM/ambience loop
 * editor.
 *
 * The authored schema keeps `start_ms`, `loop_start_ms` and `loop_end_ms` as
 * integer milliseconds.  These helpers are the single place that turns a
 * pointer position or a raw numeric input into a persisted value, so the
 * waveform handles, the numeric fields and the keyboard nudges all enforce the
 * same ordering rules the validators already check:
 *
 *   - `start_ms >= 0` and `start_ms <= loop_end_ms` when a custom loop exists,
 *   - `0 <= loop_start_ms < loop_end_ms`.
 *
 * They are deliberately side-effect free and must never run during load:
 * opening a project may not silently normalise authored millisecond values.
 */

export type AudioLoopMarker = "start" | "loop_start" | "loop_end";

/** Minimum allowed `loop_end_ms - loop_start_ms` when a custom loop is set. */
export const MIN_LOOP_GAP_MS = 1;

/** Custom-loop end used only when the media duration is unknown. */
export const FALLBACK_LOOP_END_MS = 1000;

export interface AudioLoopValues {
  loopEndMs: number | null;
  loopStartMs: number | null;
  startMs: number;
}

/** Rounds a finite, non-negative number to integer milliseconds. */
export function toIntegerMs(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/**
 * Parses a host-probed `WireU64` duration into milliseconds.  Non-canonical
 * text or a value outside the safe-integer range returns `null` so a very long
 * container can never be silently rounded into a plausible duration.
 */
export function parseMetadataDurationMs(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return toIntegerMs(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

export function msToRatio(
  ms: number,
  durationMs: number | null,
): number | null {
  if (durationMs === null || durationMs <= 0) return null;
  return Math.min(Math.max(ms / durationMs, 0), 1);
}

export function ratioToMs(ratio: number, durationMs: number): number | null {
  if (!Number.isFinite(ratio)) return null;
  return toIntegerMs(Math.min(Math.max(ratio, 0), 1) * durationMs);
}

/**
 * Duration-aware custom-loop defaults.  The media duration is only used to
 * choose the end of a *newly enabled* loop; existing authored values are never
 * rewritten by rendering.
 */
export function defaultLoopBounds(
  durationMs: number | null,
  startMs: number,
): { loopEndMs: number; loopStartMs: number } {
  const end =
    durationMs !== null && durationMs >= MIN_LOOP_GAP_MS
      ? durationMs
      : FALLBACK_LOOP_END_MS;
  return {
    loopEndMs: Math.max(end, Math.max(startMs, 0) + MIN_LOOP_GAP_MS),
    loopStartMs: 0,
  };
}

/**
 * Resolves one edited marker into the ordered value the schema accepts.
 * Returns `null` when the raw value is not a finite non-negative number.
 * `durationMs` bounds the edited value only; it is never applied on load.
 */
export function resolveMarkerMs(
  marker: AudioLoopMarker,
  rawMs: number,
  values: AudioLoopValues,
  durationMs: number | null,
): number | null {
  const value = toIntegerMs(rawMs);
  if (value === null) return null;
  switch (marker) {
    case "start": {
      const upper = values.loopEndMs ?? durationMs;
      return upper === null ? value : Math.min(value, Math.max(upper, 0));
    }
    case "loop_start": {
      if (values.loopEndMs === null) return value;
      return Math.min(value, Math.max(values.loopEndMs - MIN_LOOP_GAP_MS, 0));
    }
    case "loop_end": {
      const lower =
        values.loopStartMs === null
          ? Math.max(values.startMs, 0)
          : Math.max(values.loopStartMs + MIN_LOOP_GAP_MS, values.startMs);
      const clamped = Math.max(value, lower);
      return durationMs === null
        ? clamped
        : Math.min(clamped, Math.max(durationMs, lower));
    }
  }
}

export function markerMs(
  values: AudioLoopValues,
  marker: AudioLoopMarker,
): number | null {
  switch (marker) {
    case "start":
      return values.startMs;
    case "loop_start":
      return values.loopStartMs;
    case "loop_end":
      return values.loopEndMs;
  }
}

export function withMarker(
  values: AudioLoopValues,
  marker: AudioLoopMarker,
  nextMs: number,
): AudioLoopValues {
  switch (marker) {
    case "start":
      return { ...values, startMs: nextMs };
    case "loop_start":
      return { ...values, loopStartMs: nextMs };
    case "loop_end":
      return { ...values, loopEndMs: nextMs };
  }
}

export function sameLoopValues(
  left: AudioLoopValues,
  right: AudioLoopValues,
): boolean {
  return (
    left.startMs === right.startMs &&
    left.loopStartMs === right.loopStartMs &&
    left.loopEndMs === right.loopEndMs
  );
}
