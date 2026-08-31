export type SharedTimelineEasing =
  | "step"
  | "linear"
  | "ease_in"
  | "ease_out"
  | "ease_in_out"
  | { cubic_bezier: [number, number, number, number] };

export interface SharedTimelineKeyframe {
  at_ms: number;
  value: number | "inherit";
  easing: SharedTimelineEasing;
}

export type SharedTimelineChannels = Record<
  string,
  SharedTimelineKeyframe[] | undefined
>;

export type TimelineOutcome = "completed" | "skipped" | "failed";

export class TimelineClock {
  #elapsed = 0;
  #frame = 0;
  #paused = false;
  #buffering = false;
  #settle: ((outcome: TimelineOutcome) => void) | null = null;

  constructor(
    readonly durationMs: number,
    readonly getRate: () => number,
    readonly render: (elapsedMs: number) => void,
  ) {}

  run(signal: AbortSignal): Promise<TimelineOutcome> {
    if (signal.aborted) return Promise.resolve("failed");
    this.render(0);
    return new Promise((resolve) => {
      this.#settle = resolve;
      let previous = performance.now();
      const finish = (outcome: TimelineOutcome): void => {
        cancelAnimationFrame(this.#frame);
        signal.removeEventListener("abort", abort);
        const settle = this.#settle;
        this.#settle = null;
        settle?.(outcome);
      };
      const abort = (): void => finish("failed");
      signal.addEventListener("abort", abort, { once: true });
      const tick = (now: number): void => {
        if (signal.aborted || this.#settle === null) return;
        if (!this.#paused && !this.#buffering) {
          const rate = Math.max(0.01, this.getRate());
          this.#elapsed = Math.min(
            this.durationMs,
            this.#elapsed + Math.max(0, now - previous) * rate,
          );
          this.render(this.#elapsed);
        }
        previous = now;
        if (this.#elapsed >= this.durationMs) finish("completed");
        else this.#frame = requestAnimationFrame(tick);
      };
      this.#frame = requestAnimationFrame(tick);
    });
  }

  setPaused(paused: boolean): void {
    this.#paused = paused;
  }

  setBuffering(buffering: boolean): void {
    this.#buffering = buffering;
  }

  skip(): boolean {
    if (this.#settle === null) return false;
    this.#elapsed = this.durationMs;
    this.render(this.#elapsed);
    const settle = this.#settle;
    this.#settle = null;
    cancelAnimationFrame(this.#frame);
    settle("skipped");
    return true;
  }
}

export function evaluateChannel(
  channels: SharedTimelineChannels,
  name: string,
  elapsedMs: number,
  fallback: number,
): number {
  const frames = channels[name];
  if (frames === undefined || frames.length === 0) return fallback;
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (first === undefined || last === undefined) return fallback;
  if (elapsedMs <= first.at_ms) return resolveValue(first.value, fallback);
  if (elapsedMs >= last.at_ms) return resolveValue(last.value, fallback);
  for (let index = 0; index < frames.length - 1; index += 1) {
    const left = frames[index];
    const right = frames[index + 1];
    if (left === undefined || right === undefined) continue;
    if (elapsedMs <= right.at_ms) {
      const span = right.at_ms - left.at_ms;
      const progress = span <= 0 ? 1 : (elapsedMs - left.at_ms) / span;
      return mix(
        resolveValue(left.value, fallback),
        resolveValue(right.value, fallback),
        applyEasing(progress, left.easing),
      );
    }
  }
  return resolveValue(last.value, fallback);
}

export function applyEasing(
  value: number,
  easing: SharedTimelineEasing,
): number {
  const x = Math.max(0, Math.min(1, value));
  if (typeof easing === "object") {
    return cubicBezierAtX(x, easing.cubic_bezier);
  }
  switch (easing) {
    case "step":
      return x < 1 ? 0 : 1;
    case "linear":
      return x;
    case "ease_in":
      return x * x;
    case "ease_out":
      return 1 - (1 - x) * (1 - x);
    case "ease_in_out":
      return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
  }
}

function resolveValue(value: number | "inherit", fallback: number): number {
  return value === "inherit" ? fallback : value;
}

function cubicBezierAtX(
  x: number,
  [x1, y1, x2, y2]: [number, number, number, number],
): number {
  const sample = (t: number, a: number, b: number): number => {
    const inverse = 1 - t;
    return 3 * inverse * inverse * t * a + 3 * inverse * t * t * b + t ** 3;
  };
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

function mix(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}
