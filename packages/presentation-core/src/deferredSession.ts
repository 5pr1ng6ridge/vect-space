/**
 * Strict-Mode-safe deferred session lifecycle shared by the game canvas and
 * the editor preview.
 *
 * The WebGL session is created inside an effect, and cleanup defers destruction
 * by one task so React's Strict Mode probe (setup → cleanup → setup) can
 * reclaim the very same initialized application instead of tearing down a live
 * WebGL context.  Both hosts therefore reap timers, listeners and GPU
 * resources the same way, including after an initialization failure.
 */

export interface DeferredSessionSchedule {
  /** Runs `callback` after the current task; returns a cancel function. */
  (callback: () => void): () => void;
}

export interface DeferredSessionHandle<T> {
  readonly session: T;
  readonly initialized: Promise<T>;
}

export interface DeferredSessionOptions<T> {
  create(): { session: T; initialized: Promise<unknown> };
  dispose(session: T): void;
  /** Test seam; defaults to a `setTimeout(..., 0)` task. */
  schedule?: DeferredSessionSchedule;
}

export class DeferredSession<T> {
  readonly #options: DeferredSessionOptions<T>;
  readonly #schedule: DeferredSessionSchedule;
  #handle: { session: T; initialized: Promise<T> } | null = null;
  #cancelDisposal: (() => void) | null = null;
  #availabilities = 0;

  constructor(options: DeferredSessionOptions<T>) {
    this.#options = options;
    this.#schedule = options.schedule ?? defaultSchedule;
  }

  /** Number of hosts currently holding the session. */
  get availabilities(): number {
    return this.#availabilities;
  }

  /** Current session instance, even while it is still initializing. */
  peek(): T | null {
    return this.#handle?.session ?? null;
  }

  /**
   * Returns the live session, creating it on first use.
   *
   * An `acquire` that immediately follows a `release` cancels the pending
   * disposal and reclaims the same initialized application.
   */
  acquire(): DeferredSessionHandle<T> {
    this.#availabilities += 1;
    this.#cancelDisposal?.();
    this.#cancelDisposal = null;
    if (this.#handle === null) {
      const created = this.#options.create();
      const handle = {
        session: created.session,
        initialized: Promise.resolve(created.initialized).then(
          () => created.session,
        ),
      };
      this.#handle = handle;
      // An initialization failure must not leak: the session is dropped, and
      // `dispose` is only called for a session that actually came up.
      void handle.initialized.catch(() => {
        if (this.#handle === handle) this.#handle = null;
      });
    }
    return this.#handle;
  }

  /**
   * Releases one holder.  The session is destroyed one task later unless a new
   * host claims it first.
   */
  release(): void {
    this.#availabilities = Math.max(0, this.#availabilities - 1);
    if (this.#cancelDisposal !== null) return;
    this.#cancelDisposal = this.#schedule(() => {
      this.#cancelDisposal = null;
      const handle = this.#handle;
      if (handle === null) return;
      void handle.initialized
        .then(
          (session) => {
            if (this.#handle === handle) this.#handle = null;
            this.#options.dispose(session);
          },
          () => undefined,
        )
        .catch(() => undefined);
    });
  }

  /** Destroys the session now; used by hosts that unmount for good. */
  disposeNow(): void {
    this.#cancelDisposal?.();
    this.#cancelDisposal = null;
    const handle = this.#handle;
    if (handle === null) return;
    this.#handle = null;
    void handle.initialized
      .then(
        (session) => this.#options.dispose(session),
        () => undefined,
      )
      .catch(() => undefined);
  }
}

function defaultSchedule(callback: () => void): () => void {
  const timer = window.setTimeout(callback, 0);
  return () => window.clearTimeout(timer);
}
