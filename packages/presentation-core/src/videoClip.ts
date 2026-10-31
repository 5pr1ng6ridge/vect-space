/**
 * Pure media-window math of `TimelineSession`.
 *
 * A video track presents a window of one media element:
 *
 * - `clip_start_ms` is where the window begins,
 * - `clip_end_ms` ends the window explicitly, otherwise the media's own
 *   duration does,
 * - `loop: true` wraps the playhead inside the window; `loop: false` freezes
 *   at the effective end.
 *
 * `atEnd` exists so the session can tell "the non-loop playhead consumed the
 * whole window" apart from "still inside it": that is the boundary where it
 * must pause once and hold the final frame instead of seeking the tail every
 * frame.  Authored data is never rewritten; an authored clip end beyond the
 * real media length is simply presented up to the media end.
 */
export interface VideoClipSpec {
  clip_start_ms: number;
  /** Optional so the editor's authored track shape (which omits it) fits. */
  clip_end_ms?: number | null;
  loop: boolean;
}

export interface VideoClipPosition {
  /** Media time (seconds) the playhead currently targets. */
  desiredSeconds: number;
  /**
   * Effective window end in seconds, or `null` when neither an explicit clip
   * end nor a finite media duration is known.
   */
  endSeconds: number | null;
  /** Window length in seconds, floored to 1 ms so the wrap never divides by 0. */
  windowSeconds: number;
  /** Non-loop playback has consumed the whole (finite) window. */
  atEnd: boolean;
}

/**
 * Resolves the media time a playhead position targets.
 *
 * `mediaDurationSeconds` may be `NaN`/`Infinity` while metadata is pending or
 * for live sources; the window is then open-ended and `atEnd` stays `false`,
 * so an unknown length never freezes playback on a guess.
 */
export function evaluateVideoClip(
  spec: VideoClipSpec,
  elapsedMs: number,
  mediaDurationSeconds: number,
): VideoClipPosition | null {
  const mediaEnd =
    Number.isFinite(mediaDurationSeconds) && mediaDurationSeconds >= 0
      ? mediaDurationSeconds
      : null;
  const explicitEnd =
    spec.clip_end_ms === null || spec.clip_end_ms === undefined
      ? null
      : spec.clip_end_ms / 1_000;
  // The media cannot supply more than it has: an authored clip end past the
  // real length is presented up to the media end. Authored data is untouched.
  const endSeconds =
    explicitEnd === null
      ? mediaEnd
      : mediaEnd === null
        ? explicitEnd
        : Math.min(explicitEnd, mediaEnd);
  const clipStart = spec.clip_start_ms / 1_000;
  const raw = clipStart + elapsedMs / 1_000;
  const effectiveEnd = endSeconds ?? raw;
  const windowSeconds = Math.max(0.001, effectiveEnd - clipStart);
  const desiredSeconds = spec.loop
    ? clipStart +
      ((((raw - clipStart) % windowSeconds) + windowSeconds) % windowSeconds)
    : Math.min(effectiveEnd, raw);
  if (!Number.isFinite(desiredSeconds)) return null;
  return {
    desiredSeconds,
    endSeconds,
    windowSeconds,
    atEnd: !spec.loop && endSeconds !== null && raw >= endSeconds,
  };
}
