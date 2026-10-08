/**
 * Ordering rules of the cue executors of one scene surface.
 *
 * - A visual **generation** ends with every reset, dispose, world commit and
 *   full clear.  An executor captures it before awaiting and refuses to write
 *   or commit once the surface has moved on, so a late callback can never
 *   modify the next generation or a destroyed object.
 * - Cues of one kind or instance resolve as "latest start wins": an older cue
 *   never settles state a newer one owns.
 */

import { animate } from "./motion";
import type { SceneFrameCancel, SceneFrameRequest } from "./sceneRenderLoop";
import type { SceneCueContext } from "./sceneSurfaceTypes";
import type { Easing } from "./types";

export interface SceneCueLifecycleOptions {
  isDisposed(): boolean;
  /** Called after every animation step. */
  requestRender(): void;
  requestFrame?: SceneFrameRequest | undefined;
  cancelFrame?: SceneFrameCancel | undefined;
}

export class SceneCueLifecycle {
  readonly #options: SceneCueLifecycleOptions;
  #generation = 0;
  /** Aborts the frame loop of in-flight cue animations when a generation ends. */
  #abort = new AbortController();
  /** Latest writer per cue kind/instance: an older cue never settles state. */
  readonly #tokens = new Map<string, number>();
  /**
   * Latest *request* per cue kind, taken before a replacement resource is
   * awaited.  A request superseded while its pixels still decode must never
   * commit, even when the newer request turns out to be a same-asset no-op
   * that never starts an animation of its own.
   */
  readonly #requestTokens = new Map<string, number>();

  constructor(options: SceneCueLifecycleOptions) {
    this.#options = options;
  }

  get generation(): number {
    return this.#generation;
  }

  /**
   * Starts a new generation and stops the in-flight cue animations (their
   * pending frames are cancelled).
   */
  advance(): number {
    this.#generation += 1;
    this.#abort.abort();
    this.#abort = new AbortController();
    return this.#generation;
  }

  isCurrent(generation: number): boolean {
    return !this.#options.isDisposed() && generation === this.#generation;
  }

  /** Registers a cue of one kind and returns its "latest writer" token. */
  begin(key: string): number {
    const token = (this.#tokens.get(key) ?? 0) + 1;
    this.#tokens.set(key, token);
    return token;
  }

  /**
   * Registers the *start* of a cue request and returns its token.
   *
   * Taking this before the resource await makes start order decide the winner
   * instead of completion order, so a slower older cue can never commit over a
   * newer request (including a null clear or a same-asset no-op).
   */
  beginRequest(key: string): number {
    const token = (this.#requestTokens.get(key) ?? 0) + 1;
    this.#requestTokens.set(key, token);
    return token;
  }

  /** True while this request is still the newest of its kind. */
  isLatestRequest(generation: number, key: string, token: number): boolean {
    return this.isCurrent(generation) && this.#requestTokens.get(key) === token;
  }

  /**
   * True while this cue is still the newest writer of its kind and no newer
   * visual generation started.  Overlapping cues of the same kind therefore
   * resolve as "latest start wins", with an equal start decided by the order
   * the cues actually began.
   */
  isLatest(generation: number, key: string, token: number): boolean {
    return this.isCurrent(generation) && this.#tokens.get(key) === token;
  }

  /** Drives `apply` with eased progress until the duration ends or either signal aborts. */
  run(
    durationMs: number,
    easing: Easing,
    apply: (progress: number) => void,
    context: Pick<SceneCueContext, "signal" | "getRate">,
  ): Promise<void> {
    // The cue animation is aborted by its own signal and by the surface ending
    // the current visual generation (reset, dispose, world commit, clear), so
    // its pending frame is always cancelled even when the host never aborts.
    const lifecycle = new AbortController();
    const lifecycleSignal = this.#abort.signal;
    const abort = (): void => lifecycle.abort();
    context.signal.addEventListener("abort", abort, { once: true });
    lifecycleSignal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted || lifecycleSignal.aborted) abort();
    return animate(
      durationMs,
      easing,
      (progress) => {
        apply(progress);
        this.#options.requestRender();
      },
      lifecycle.signal,
      {
        getRate: context.getRate,
        // Cue animations share the surface's frame source, so a host can pump
        // them deterministically in tests and never renders twice per frame.
        frame: {
          request:
            this.#options.requestFrame ??
            ((callback) => requestAnimationFrame(callback)),
          cancel:
            this.#options.cancelFrame ??
            ((handle) => cancelAnimationFrame(handle)),
        },
      },
    ).finally(() => {
      context.signal.removeEventListener("abort", abort);
      lifecycleSignal.removeEventListener("abort", abort);
    });
  }
}
