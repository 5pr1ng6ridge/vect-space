import type { TimelineChannels, TimelineEasing } from "./types";

export function evaluateChannel(
  channels: TimelineChannels,
  name: string,
  elapsedMs: number,
  fallback: number,
): number {
  const frames = channels[name];
  if (frames === undefined || frames.length === 0) return fallback;
  const first = firstItem(frames);
  const last = lastItem(frames);
  if (first === undefined || last === undefined) return fallback;
  if (elapsedMs <= first.at_ms) return first.value;
  if (elapsedMs >= last.at_ms) return last.value;
  for (let index = 0; index < frames.length - 1; index += 1) {
    const left = frames[index];
    const right = frames[index + 1];
    if (left === undefined || right === undefined) continue;
    if (elapsedMs <= right.at_ms) {
      const progress = (elapsedMs - left.at_ms) / (right.at_ms - left.at_ms);
      return (
        left.value + (right.value - left.value) * ease(progress, left.easing)
      );
    }
  }
  return last.value;
}

export function ease(value: number, easing: TimelineEasing): number {
  const x = Math.max(0, Math.min(1, value));
  if (typeof easing === "object") {
    const [x1, y1, x2, y2] = easing.cubic_bezier;
    const sample = (t: number, a: number, b: number): number =>
      3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
    let low = 0;
    let high = 1;
    let t = x;
    for (let index = 0; index < 14; index += 1) {
      if (sample(t, x1, x2) < x) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return sample(t, y1, y2);
  }
  if (easing === "step") return x < 1 ? 0 : 1;
  if (easing === "ease_in") return x * x;
  if (easing === "ease_out") return 1 - (1 - x) ** 2;
  if (easing === "ease_in_out")
    return x < 0.5 ? 2 * x ** 2 : 1 - (-2 * x + 2) ** 2 / 2;
  return x;
}

function firstItem<T>(values: readonly T[]): T | undefined {
  for (const value of values) return value;
  return undefined;
}

function lastItem<T>(values: readonly T[]): T | undefined {
  let result: T | undefined;
  for (const value of values) result = value;
  return result;
}
