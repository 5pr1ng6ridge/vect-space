/**
 * Frame source owned by the inspector cue preview.
 *
 * The shared `SceneSurface` accepts a frame source seam; this clock implements
 * it so the preview can both run a cue on a real browser clock and step the
 * cue to an exact virtual time for a deterministic seek.  It is deliberately
 * outside the React component module: it is not a component, and Fast Refresh
 * must be able to treat that file as components-only.
 */

import { advanceVirtualElapsed } from "@vectspace/presentation-core/virtual-clock";

export class PreviewFrameClock {
  #auto = false;
  #now = 0;
  #lastWall = 0;
  #scheduled: (() => void) | null = null;
  #nextId = 1;
  #pending = new Map<number, (now: number) => void>();

  /** Called after every `step`; the component mirrors `now` into its UI. */
  onStep: (() => void) | null = null;

  get auto(): boolean {
    return this.#auto;
  }

  get now(): number {
    return this.#now;
  }

  /** Pending frame callbacks; tests use it to wait for an animation start. */
  pendingCount(): number {
    return this.#pending.size;
  }

  request = (callback: (now: number) => void): number => {
    const id = this.#nextId++;
    this.#pending.set(id, callback);
    this.#schedule();
    return id;
  };

  cancel = (id: number): void => {
    this.#pending.delete(id);
  };

  /**
   * Advances virtual time by `deltaMs` and delivers every pending frame once.
   *
   * Time is monotonic in the shared virtual clock; the delivered timestamp is
   * the clock's own, so stepping to an exact duration always produces the same
   * animation progress regardless of wall time.
   */
  step(deltaMs: number): void {
    this.#now = advanceVirtualElapsed(
      this.#now,
      Math.max(0, deltaMs),
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const callback of pending) callback(this.#now);
    this.onStep?.();
  }

  /** Restarts at zero; a rebuild must not inherit the previous run's time. */
  reset(): void {
    this.#now = 0;
    this.#lastWall = 0;
  }

  pause(): void {
    this.#auto = false;
    this.#scheduled?.();
    this.#scheduled = null;
  }

  resume(): void {
    if (this.#auto) return;
    this.#auto = true;
    this.#lastWall = 0;
    this.#schedule();
  }

  dispose(): void {
    this.pause();
    this.#pending.clear();
    this.onStep = null;
  }

  #schedule(): void {
    if (!this.#auto || this.#scheduled !== null || this.#pending.size === 0)
      return;
    // A host without `requestAnimationFrame` (jsdom without visual mode) still
    // gets a working auto clock; only the deterministic seek needs manual
    // stepping, and that never uses the auto timer.
    if (typeof requestAnimationFrame === "function") {
      const handle = requestAnimationFrame(this.#tick);
      this.#scheduled = () => cancelAnimationFrame(handle);
    } else {
      const handle = setTimeout(() => this.#tick(Date.now()), 16);
      this.#scheduled = () => clearTimeout(handle);
    }
  }

  #tick = (wall: number): void => {
    this.#scheduled = null;
    const delta = this.#lastWall === 0 ? 0 : Math.max(0, wall - this.#lastWall);
    this.#lastWall = wall;
    this.step(delta);
    this.#schedule();
  };
}
