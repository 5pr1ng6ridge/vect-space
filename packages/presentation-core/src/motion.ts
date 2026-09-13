/**
 * Shared cue animation helper.
 *
 * Visual cues (background cross-fades, sprite tweens, camera tweens, delayed
 * presentation steps) animate through this function so the game and the editor
 * agree on easing, fast-forward rate and pause behaviour.  The caller decides
 * *what* the progress does; this module only owns the clock.
 */

import { applyEasing } from "./timeline";
import { advanceVirtualElapsed } from "./virtualClock";
import type { Easing } from "./types";

export interface AnimateFrameSource {
  request(callback: (nowMs: number) => void): number;
  cancel(handle: number): void;
}

export interface AnimateOptions {
  /** Rate provider; `0` freezes progress without losing already elapsed time. */
  getRate?: () => number;
  /** Frame source; defaults to `requestAnimationFrame`. */
  frame?: AnimateFrameSource;
}

export function animate(
  durationMs: number,
  easing: Easing,
  apply: (progress: number) => void,
  signal: AbortSignal,
  options: AnimateOptions = {},
): Promise<void> {
  const getRate = options.getRate ?? (() => 1);
  const requestFrame =
    options.frame?.request ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame =
    options.frame?.cancel ?? ((handle) => cancelAnimationFrame(handle));
  if (durationMs <= 0 || signal.aborted) {
    if (!signal.aborted) apply(1);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    // The first frame only establishes the time origin, so an injected frame
    // source with its own clock never produces a negative delta.
    let previous: number | null = null;
    let virtualElapsed = 0;
    let frame = 0;
    const abort = (): void => {
      cancelFrame(frame);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
    const tick = (now: number): void => {
      if (signal.aborted) return;
      const rate = getRate();
      if (rate > 0 && previous !== null) {
        virtualElapsed = advanceVirtualElapsed(
          virtualElapsed,
          now - previous,
          rate,
          durationMs,
        );
      }
      previous = now;
      const raw = Math.min(1, virtualElapsed / durationMs);
      apply(applyEasing(raw, easing));
      if (raw >= 1) {
        signal.removeEventListener("abort", abort);
        resolve();
      } else {
        frame = requestFrame(tick);
      }
    };
    frame = requestFrame(tick);
  });
}

export function mix(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}
