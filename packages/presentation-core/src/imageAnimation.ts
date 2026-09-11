/**
 * Shared loop-image-animation rules for the Pixi surface and the React image
 * components.
 *
 * The milestone decision this module encodes: a frame loop is a *decorative*
 * animation.  It is driven by an accumulated presentation clock that stops
 * when the presentation stops, so
 *
 * - Ctrl fast forward never speeds it up,
 * - pausing (menu, hidden page, unfocused window) freezes it without
 *   accruing a debt that would be repaid on resume,
 * - loading a save starts again from the first frame, because a snapshot only
 *   stores the asset id and a fresh instance starts at elapsed `0`.
 *
 * Frame choice is a pure function of elapsed time and the frame list, so two
 * hosts with the same clock value pick the same frame no matter their refresh
 * rate, and the editor can seek to an exact time without emitting events.
 */

export interface AnimationFrameSource {
  /** Logical asset id of the frame image. */
  asset: string;
  /** Resolved url for that static image. */
  url: string;
  duration_ms: number;
}

export interface AnimationSource {
  id: string;
  width: number;
  height: number;
  total_duration_ms: number;
  frames: readonly AnimationFrameSource[];
}

/**
 * One resolved image asset.  Static and animated assets share this shape so a
 * caller never branches on "is this dynamic": only `animation` differs.
 */
export interface ImageAssetSource {
  asset: string;
  /** Layout size.  Constant for the whole loop, never the current frame's. */
  width: number;
  height: number;
  /** Static image url, or the first frame's url for an animated asset. */
  url: string;
  animation?: AnimationSource;
}

export type AnimationMap = Readonly<Record<string, AnimationSource>>;

/** Stable lifecycle key that changes when an editor replaces any frame,
 * duration, or measured geometry while keeping the same logical asset id. */
export function imageAssetSourceVersion(
  source: ImageAssetSource | null | undefined,
): string {
  if (source === null || source === undefined) return "";
  const animation = source.animation;
  if (animation === undefined) return `${source.asset}\0${source.url}`;
  return [
    source.asset,
    source.url,
    animation.id,
    String(animation.width),
    String(animation.height),
    ...animation.frames.flatMap((frame) => [
      frame.asset,
      frame.url,
      String(frame.duration_ms),
    ]),
  ].join("\0");
}

/**
 * Frame index at a decorative timestamp.
 *
 * Returns `-1` only for an empty frame list.  Negative timestamps wrap into
 * the loop so a caller cannot produce an out-of-range frame.
 */
export function frameIndexAt(
  elapsedMs: number,
  frames: readonly Pick<AnimationFrameSource, "duration_ms">[],
): number {
  if (frames.length === 0) return -1;
  let total = 0;
  for (const frame of frames) {
    total += frame.duration_ms;
  }
  if (!(total > 0)) return 0;
  let remaining = elapsedMs % total;
  if (remaining < 0) remaining += total;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (frame === undefined) break;
    if (remaining < frame.duration_ms) return index;
    remaining -= frame.duration_ms;
  }
  // Only reachable through floating point residue on the final frame.
  return frames.length - 1;
}

/**
 * Monotonic decorative presentation clock.
 *
 * `advance` is the only way time passes, and it is ignored while paused, so a
 * host that pauses on blur simply stops calling it (or keeps calling it with
 * real deltas) and playback resumes where it stopped.
 */
export class DecorativeFrameClock {
  #elapsedMs = 0;
  #paused = false;

  static startAt(elapsedMs = 0): DecorativeFrameClock {
    const clock = new DecorativeFrameClock();
    clock.seek(elapsedMs);
    return clock;
  }

  elapsedMs(): number {
    return this.#elapsedMs;
  }

  isPaused(): boolean {
    return this.#paused;
  }

  /** Adds wall-clock time.  Ignored while paused or for non-positive deltas. */
  advance(deltaMs: number): void {
    if (this.#paused) return;
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    this.#elapsedMs += deltaMs;
  }

  /** Deterministic positioning, used by editor scrubbing. */
  seek(elapsedMs: number): void {
    this.#elapsedMs =
      Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  }

  setPaused(paused: boolean): void {
    this.#paused = paused;
  }

  /** Back to the first frame, as a load or a fresh instance must. */
  restart(): void {
    this.#elapsedMs = 0;
  }
}

/**
 * Owns one instance's frame position.
 *
 * Instances that share an animation share the decoded frame list but never the
 * position, because every player keeps its own clock.  A player is created
 * once per displayed instance and is *not* recreated when the instance moves,
 * scales, or receives a snapshot it already had.
 */
export class FrameSequencePlayer {
  readonly source: ImageAssetSource;
  readonly clock: DecorativeFrameClock;
  #listeners = new Set<(player: FrameSequencePlayer) => void>();

  constructor(source: ImageAssetSource, clock = new DecorativeFrameClock()) {
    this.source = source;
    this.clock = clock;
  }

  /** True when the asset has more than the trivial single frame. */
  get isAnimated(): boolean {
    return (this.source.animation?.frames.length ?? 0) > 1;
  }

  frameIndex(): number {
    const frames = this.source.animation?.frames;
    if (frames === undefined) return 0;
    return frameIndexAt(this.clock.elapsedMs(), frames);
  }

  frame(): AnimationFrameSource | undefined {
    const frames = this.source.animation?.frames;
    if (frames === undefined || frames.length === 0) return undefined;
    return frames[Math.max(0, this.frameIndex())];
  }

  /** Current frame url, falling back to the static url before resolution. */
  url(): string {
    return this.frame()?.url ?? this.source.url;
  }

  advance(deltaMs: number): boolean {
    const before = this.frameIndex();
    this.clock.advance(deltaMs);
    return this.#settle(before);
  }

  seek(elapsedMs: number): boolean {
    const before = this.frameIndex();
    this.clock.seek(elapsedMs);
    return this.#settle(before);
  }

  setPaused(paused: boolean): void {
    this.clock.setPaused(paused);
  }

  /** Starts the loop again only when this asset actually changed. */
  resetToFirstFrame(): boolean {
    const before = this.frameIndex();
    this.clock.restart();
    return this.#settle(before);
  }

  subscribe(listener: (player: FrameSequencePlayer) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Releases listeners so a destroyed instance cannot keep ticking. */
  dispose(): void {
    this.#listeners.clear();
  }

  #settle(previousIndex: number): boolean {
    const index = this.frameIndex();
    if (index === previousIndex) return false;
    for (const listener of this.#listeners) listener(this);
    return true;
  }
}

/**
 * Resolves a logical asset id to its pixels.
 *
 * `urls` keeps the historical id -> url map, `animations` carries the frame
 * lists for animated assets.  An id that is animated but missing from
 * `animations` still yields its first frame, so a partially loaded host shows
 * the static frame instead of nothing.
 */
export function resolveImageAsset(
  assetId: string,
  urls: Readonly<Record<string, string>>,
  animations: AnimationMap,
): ImageAssetSource | undefined {
  const animation = animations[assetId];
  const url = urls[assetId];
  if (animation === undefined) {
    if (url === undefined) return undefined;
    return { asset: assetId, url, width: 0, height: 0 };
  }
  const first = animation.frames[0];
  if (first === undefined) return undefined;
  return {
    asset: assetId,
    url: url ?? first.url,
    width: animation.width,
    height: animation.height,
    animation,
  };
}

/**
 * Frame index for an asset at a given decorative time, or `-1` when the asset
 * is unknown.  The editor uses this to place frames deterministically while
 * dragging a playhead.
 */
export function frameIndexForAssetAt(
  assetId: string,
  elapsedMs: number,
  animations: AnimationMap,
): number {
  const animation = animations[assetId];
  if (animation === undefined) return -1;
  return frameIndexAt(elapsedMs, animation.frames);
}
