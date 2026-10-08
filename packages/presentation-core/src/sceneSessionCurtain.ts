/**
 * The host-only session curtain of a scene surface.
 *
 * The host covers the canvas with it before it replaces the whole world (new
 * game, load, replay start, controller reset).  It shares the pure curtain
 * evaluator with the story `curtain_transition` cue, but it never enters
 * `WorldSnapshot` or a story cue, so a later hard snapshot alignment can never
 * replay it.
 */

import type { SceneCueLifecycle } from "./sceneCueLifecycle";
import { DESIGN_HEIGHT, DESIGN_WIDTH } from "./sceneFrame";
import type { SceneKit, SceneNodeLike } from "./sceneKit";
import { evaluateCurtainTransition } from "./sceneTransitions";
import type { CurtainAction } from "./types";

/** Duration of the host-only session curtain's cover and reveal fades. */
export const SESSION_CURTAIN_MS = 250;
/**
 * Upper bound on the session curtain's wait for rendering.
 *
 * A hidden or suspended host may stop pumping frames at all; the reveal
 * falls back to one best-effort render instead of holding the host busy
 * forever, and the cover/reveal fades are bounded by their duration plus this
 * grace so a suspended host still reaches a fully covered / fully revealed
 * state.
 */
export const SESSION_CURTAIN_FRAME_TIMEOUT_MS = 250;

export interface SceneSessionCurtainOptions {
  kit: SceneKit;
  lifecycle: SceneCueLifecycle;
  /** Layer above every story layer. */
  layer: SceneNodeLike;
  isDisposed(): boolean;
  requestRender(): void;
  /** Resolves once the next frame is actually drawn (bounded wait). */
  nextFrame(): Promise<void>;
}

export class SceneSessionCurtain {
  readonly #options: SceneSessionCurtainOptions;
  /** True while the curtain fully covers the canvas. */
  #covered = false;
  /** Black full-stage fill of the curtain layer. */
  #fill: SceneNodeLike | null = null;
  /** Newest transition; repeated calls coalesce onto it. */
  #token = 0;
  #action: CurtainAction | null = null;
  #promise: Promise<void> | null = null;
  /** In-flight reveal (including its wait for a drawn frame). */
  #reveal: Promise<void> | null = null;
  /**
   * Identity of the current reveal operation.  A newer reveal request (or a
   * reset/dispose) advances it, so a replaced operation stops at its next
   * checkpoint instead of running a second reveal.
   */
  #revealToken = 0;
  /**
   * Epoch the parked reveal currently follows, or `-1` when no reveal is
   * parked.  A newer transition advances `#epoch`, so the two differ exactly
   * while a superseded reveal is still parked: a reveal call in that window
   * must start a fresh operation instead of sharing the doomed no-op promise.
   */
  #revealEpoch = -1;
  /**
   * Ownership epoch of the curtain.
   *
   * Every transition and every reset/dispose bumps it.  A parked reveal
   * captured the epoch when it became the newest request; once the epoch has
   * moved on, a newer cover (or a session boundary) owns the curtain and the
   * parked reveal must stop instead of adopting the newer operation.
   */
  #epoch = 0;

  constructor(options: SceneSessionCurtainOptions) {
    this.#options = options;
  }

  /** True while the curtain fully covers the canvas. */
  get covered(): boolean {
    return this.#covered;
  }

  /**
   * Covers the canvas.
   *
   * Repeated calls while a cover is already in flight share that one
   * transition — React Strict Mode's double setup therefore performs no
   * duplicate work.  A cover that interrupts a running reveal continues from
   * the alpha that is on screen instead of snapping the curtain transparent.
   * A cover issued while a reveal is parked waiting for its stable frame
   * supersedes that reveal: the newest request owns the curtain, so the cover
   * is never swallowed as redundant.
   */
  cover(durationMs: number = SESSION_CURTAIN_MS): Promise<void> {
    if (this.#options.isDisposed()) return Promise.resolve();
    if (this.#action === "cover") {
      return this.#promise ?? Promise.resolve();
    }
    if (this.#covered && this.#action === null && this.#reveal === null) {
      return Promise.resolve();
    }
    return this.#run("cover", durationMs);
  }

  /**
   * Reveals the curtain again.
   *
   * Waits one drawn frame first, so the replacement is on screen before the
   * cover starts fading.  The curtain is released even when the reveal is
   * superseded, cancelled or the surface is reset/destroyed, and duplicate
   * calls share the one reveal.  A reveal requested while a cover is still in
   * flight waits for that cover instead of being silently dropped.  A reveal
   * requested after a newer cover has already superseded a parked reveal does
   * not reuse that parked no-op: it starts a fresh operation that observes the
   * newest cover.
   */
  reveal(durationMs: number = SESSION_CURTAIN_MS): Promise<void> {
    if (this.#options.isDisposed()) return Promise.resolve();
    if (this.#reveal !== null) {
      // A parked reveal still following the newest transition is the shared
      // promise every duplicate call receives.  Once a newer cover (or a
      // session boundary) has moved the epoch on, that promise is a doomed
      // no-op for this newer request, so fall through and start a fresh one.
      if (this.#revealEpoch === this.#epoch) {
        return this.#reveal;
      }
    } else {
      if (this.#action === "reveal") {
        return this.#promise ?? Promise.resolve();
      }
      if (!this.#covered && this.#action !== "cover") {
        return Promise.resolve();
      }
    }
    const token = ++this.#revealToken;
    const operation = (async (): Promise<void> => {
      while (!this.#options.isDisposed()) {
        // A cover in flight owns the curtain, but a reveal requested during it
        // must not be dropped: wait for the cover and keep asking.  Waiting
        // still follows the newest request, so duplicate calls keep sharing
        // this operation.
        const action = this.#action;
        if (action === "cover") {
          this.#revealEpoch = this.#epoch;
          await (this.#promise ?? Promise.resolve());
          // A newer reveal request replaced this operation while it waited;
          // the replacement owns the caller's promise now.
          if (token !== this.#revealToken) return;
          continue;
        }
        // Nothing is running, so this request is the newest owner of the
        // curtain.  Remember the ownership epoch: a cover that starts (or a
        // reset/dispose that aborts the session) before this reveal fades is a
        // newer request and supersedes the parked reveal.
        const epoch = this.#epoch;
        this.#revealEpoch = epoch;
        // The replacement must be on screen before the cover starts fading.
        await this.#options.nextFrame();
        if (this.#options.isDisposed()) return;
        if (token !== this.#revealToken) return;
        if (epoch !== this.#epoch) return;
        if (!this.#covered) return;
        const run = this.#run("reveal", durationMs);
        // The running fade owns the newest epoch; callers arriving during it
        // share this operation instead of starting a second reveal.
        this.#revealEpoch = this.#epoch;
        await run;
        return;
      }
    })().finally(() => {
      if (this.#revealToken === token) {
        this.#reveal = null;
      }
    });
    this.#reveal = operation;
    return operation;
  }

  /**
   * A session boundary (reset/dispose): the curtain never survives the world
   * it was covering, and neither does the operation that was running it (a
   * later cover must never coalesce onto the aborted promise).
   */
  reset(): void {
    this.#destroyFill();
    this.#covered = false;
    // Bumping the token also stops the superseded run's `finally` from
    // clearing the state of a newer operation, and bumping the epoch stops a
    // parked reveal from surviving the session boundary.
    this.#token += 1;
    this.#epoch += 1;
    this.#action = null;
    this.#promise = null;
    this.#reveal = null;
    this.#revealToken += 1;
    this.#revealEpoch = -1;
  }

  /**
   * Runs one cover/reveal transition.
   *
   * A newer request (or a reset/dispose that aborts the cue generation)
   * supersedes this one; the superseded run never writes a frame and the
   * curtain stays owned by whoever superseded it.
   */
  #run(action: CurtainAction, durationMs: number): Promise<void> {
    const { lifecycle } = this.#options;
    const token = ++this.#token;
    // Every transition opens a new ownership epoch; a reveal parked on an
    // older epoch stops as soon as it resumes.
    this.#epoch += 1;
    const generation = lifecycle.generation;
    this.#action = action;
    const operation = (async (): Promise<void> => {
      if (action === "cover") {
        // The host curtain is always a fixed opaque black on its own layer, so
        // a story curtain's colour/asset fill and the world's curtain state
        // are never touched by a session switch.
        this.#ensureFill();
      } else if (this.#fill === null) {
        this.#covered = false;
        return;
      }
      // A newer transition supersedes a running fade; it continues from the
      // alpha that is actually on screen instead of snapping transparent (a
      // cover that interrupts a reveal must not flash the world through).
      const from = this.#fill?.alpha ?? 0;
      const applyFrame = (progress: number): void => {
        if (!lifecycle.isCurrent(generation) || token !== this.#token) return;
        const frame = evaluateCurtainTransition(
          { type: "fade" },
          action,
          progress,
        );
        const fill = this.#fill;
        if (fill === null) return;
        const alpha =
          action === "cover"
            ? from + (1 - from) * frame.alpha
            : from * frame.alpha;
        fill.visible = alpha > 0;
        fill.alpha = alpha;
        this.#options.requestRender();
      };
      if (durationMs > 0) {
        // The fade clock is frame-driven, so a hidden or suspended host would
        // otherwise leave it (and any host command awaiting the cover)
        // pending forever.  Once the duration plus grace has passed the fade
        // snaps to its final state instead of hanging the host.
        const fade = new AbortController();
        const watchdog = setTimeout(
          () => fade.abort(),
          durationMs + SESSION_CURTAIN_FRAME_TIMEOUT_MS,
        );
        try {
          await lifecycle.run(durationMs, "linear", applyFrame, {
            signal: fade.signal,
            getRate: () => 1,
          });
        } finally {
          clearTimeout(watchdog);
        }
      }
      if (!lifecycle.isCurrent(generation) || token !== this.#token) {
        return;
      }
      applyFrame(1);
      if (action === "cover") {
        this.#covered = true;
      } else {
        this.#destroyFill();
        this.#covered = false;
      }
    })().finally(() => {
      if (token === this.#token) {
        this.#action = null;
        this.#promise = null;
      }
    });
    this.#promise = operation;
    return operation;
  }

  /** Creates the fixed black full-stage cover. */
  #ensureFill(): void {
    if (this.#fill !== null) return;
    const fill = this.#options.kit.graphics();
    fill.rect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT).fill(0x000000);
    fill.alpha = 0;
    this.#options.layer.addChild(fill);
    this.#fill = fill;
  }

  /** Drops the cover and its layer contents, exactly once. */
  #destroyFill(): void {
    const fill = this.#fill;
    this.#fill = null;
    if (fill === null) return;
    this.#options.layer.removeChild(fill);
    fill.destroy();
  }
}
