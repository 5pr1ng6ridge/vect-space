/** Frame-scheduling primitives of the shared scene surface. */

export interface SceneFrameRequest {
  (callback: (nowMs: number) => void): number;
}

export interface SceneFrameCancel {
  (handle: number): void;
}

export interface SceneRenderLoopOptions {
  render(): void;
  /** Decoration tick; returns `true` when it changed pixels. */
  tick(deltaMs: number): boolean;
  request?: SceneFrameRequest;
  cancel?: SceneFrameCancel;
}

/**
 * One render loop per surface.
 *
 * Every visual mutation asks the loop to draw; multiple mutations inside the
 * same browser frame collapse into a single `render()`.  Decoration (frame
 * loops) is ticked here as well so it shares the same frame budget.
 */
export class SceneRenderLoop {
  readonly #options: SceneRenderLoopOptions;
  readonly #request: SceneFrameRequest;
  readonly #cancel: SceneFrameCancel;
  #handle = 0;
  #running = false;
  #dirty = false;
  #lastTick: number | null = null;
  #disposed = false;

  constructor(options: SceneRenderLoopOptions) {
    this.#options = options;
    this.#request =
      options.request ?? ((callback) => requestAnimationFrame(callback));
    this.#cancel = options.cancel ?? ((handle) => cancelAnimationFrame(handle));
  }

  start(): void {
    if (this.#disposed || this.#running) return;
    this.#running = true;
    this.#lastTick = null;
    this.#handle = this.#request(this.#frame);
  }

  stop(): void {
    if (this.#handle !== 0) this.#cancel(this.#handle);
    this.#handle = 0;
    this.#running = false;
  }

  /** Marks the surface dirty; draws on the next browser frame. */
  schedule(): void {
    if (this.#disposed) return;
    this.#dirty = true;
    if (!this.#running) this.flush();
  }

  /** Draws immediately when a change is pending. */
  flush(): void {
    if (!this.#dirty || this.#disposed) return;
    this.#dirty = false;
    this.#options.render();
  }

  dispose(): void {
    this.stop();
    this.#disposed = true;
    this.#dirty = false;
  }

  #frame = (now: number): void => {
    this.#handle = 0;
    if (this.#disposed || !this.#running) return;
    // The first frame after `start()` only establishes the time origin; a
    // timestamp of zero must not be mistaken for "no frame yet".
    const delta =
      this.#lastTick === null ? 0 : Math.max(0, now - this.#lastTick);
    this.#lastTick = now;
    const changed = this.#options.tick(delta);
    if (changed) this.#dirty = true;
    this.flush();
    this.#handle = this.#request(this.#frame);
  };
}
