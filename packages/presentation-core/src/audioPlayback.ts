// Awaitable gain fades and media start helpers shared by `AudioManager`.
import { advanceVirtualElapsed } from "./virtualClock";

export function setGain(node: GainNode, value: number): void {
  node.gain.setValueAtTime(
    Math.max(0, Math.min(1, value)),
    node.context.currentTime,
  );
}

export function dynamicFade(
  durationMs: number,
  getRate: () => number,
  apply: (progress: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (durationMs <= 0 || signal?.aborted) {
    if (!signal?.aborted) apply(1);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let previous = performance.now();
    let elapsed = 0;
    let frame = 0;
    let settled = false;
    const abort = (): void => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frame);
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const tick = (now: number): void => {
      if (settled || signal?.aborted) return;
      const rate = getRate();
      if (rate > 0) {
        elapsed = advanceVirtualElapsed(
          elapsed,
          now - previous,
          rate,
          durationMs,
        );
      }
      previous = now;
      const progress = Math.min(1, elapsed / durationMs);
      apply(progress);
      if (progress >= 1) {
        settled = true;
        signal?.removeEventListener("abort", abort);
        resolve();
      } else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  });
}

export function playBgm(
  element: HTMLAudioElement,
  signal: AbortSignal,
  shouldPauseLatePlay: () => boolean,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    try {
      void element.play().then(() => {
        if (signal.aborted && shouldPauseLatePlay()) element.pause();
        finish();
      }, finish);
    } catch {
      finish();
    }
  });
}

/** Ambience transitions report media start failures to their awaited cue. */
export function playAmbience(
  element: HTMLAudioElement,
  signal: AbortSignal,
  shouldPauseLatePlay: () => boolean,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(error);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      void element.play().then(() => {
        if (signal.aborted && shouldPauseLatePlay()) element.pause();
        finish();
      }, fail);
    } catch (error) {
      fail(error);
    }
  });
}
