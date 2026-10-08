/**
 * Game presentation host.
 *
 * The controller owns no Pixi object, texture, camera matrix or media
 * element: it sequences the runtime's cues, routes audio and UI concerns
 * to the shared audio graph and the React motion host, and keeps the update
 * generation bookkeeping that guards presentation acknowledgements.
 *
 * - ordinary visual cues go to the shared surface executors,
 * - `timeline` cues go to the shared timeline session,
 * - audio and UI cues stay here because they are host concerns, not pixels.
 */

import { errorMessage } from "./errorMessage";
import { AudioManager, type AudioDiagnostics } from "./audio";
import { BoundedLedger } from "./ledger";
import { animate } from "./motion";
import {
  SceneSurface,
  type SceneFrameCancel,
  type SceneFrameRequest,
  type SceneKit,
  type SceneVisualCue,
} from "./sceneSurface";
import type { SceneFrame } from "./sceneFrame";
import type { SceneTextureLike } from "./sceneTextures";
import {
  browserTimelineDom,
  TimelineSession,
  type TimelineDomAdapter,
  type TimelineVideoState,
} from "./timelineSession";
import { UiMotionHost } from "./uiMotion";
import type { AnimationMap } from "./imageAnimation";
import type { TextBlockMap } from "./textBlock";
import type { ParticleMap } from "./particles";
import type {
  AssetUrlMap,
  PresentationCue,
  PresentationOutcome,
  RuntimeSnapshot,
  RuntimeUpdate,
  Settings,
  UiMotionPreset,
} from "./types";

/**
 * Host ports for integration tests.
 *
 * Production call sites pass nothing: the defaults are the real Pixi kit, the
 * browser media adapter and the shared Web Audio manager.  Tests inject the
 * in-memory render kit so the real controller/session/surface ownership code
 * runs without WebGL.
 */
export interface PresentationHostPorts {
  kit?: SceneKit;
  requestFrame?: SceneFrameRequest;
  cancelFrame?: SceneFrameCancel;
  textureLoader?: (url: string) => Promise<SceneTextureLike>;
  textureBudget?: number;
  dom?: TimelineDomAdapter;
}

export class PresentationController {
  readonly #surface: SceneSurface;
  readonly #session: TimelineSession;
  readonly #audio: AudioManager;
  readonly #diagnostic: (message: string) => void;
  readonly #uiMotionHost: UiMotionHost;
  readonly #oneShotLedger = new BoundedLedger<string>(4_096);
  #generation = 0;
  #abort = new AbortController();
  #currentUpdateId: string | null = null;
  #currentPromise: Promise<PresentationOutcome> | null = null;
  #playbackRate = 1;
  #suppressOneShots = false;
  #paused = false;
  #timelineSkippable = false;
  /**
   * Timer effects run beside the story, never instead of it.  Each owns an
   * abort controller and the resources it touches so a newer effect on the same
   * resource can supersede it without cancelling the story or other effects.
   */
  readonly #effects = new Map<number, EffectRun>();
  #effectSequence = 0;
  /** Generation of the story update whose cues/reconcile are still running. */
  #activeStory: number | null = null;
  /** Newest authoritative snapshot (story or effect), the reconcile target. */
  #latestSnapshot: RuntimeSnapshot | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    settings: Settings,
    diagnostic: (message: string) => void,
    uiMotionHost: UiMotionHost,
    ports: PresentationHostPorts = {},
  ) {
    this.#diagnostic = diagnostic;
    this.#uiMotionHost = uiMotionHost;
    this.#audio = new AudioManager(settings);
    this.#surface = new SceneSurface({
      canvas,
      diagnostic,
      ...(ports.kit === undefined ? {} : { kit: ports.kit }),
      ...(ports.requestFrame === undefined
        ? {}
        : { requestFrame: ports.requestFrame }),
      ...(ports.cancelFrame === undefined
        ? {}
        : { cancelFrame: ports.cancelFrame }),
      ...(ports.textureLoader === undefined
        ? {}
        : { textureLoader: ports.textureLoader }),
      ...(ports.textureBudget === undefined
        ? {}
        : { textureBudget: ports.textureBudget }),
    });
    this.#session = new TimelineSession({
      surface: this.#surface,
      audio: this.#audio,
      dom: ports.dom ?? browserTimelineDom,
      diagnostic,
      // The game owns the master volume and lets decorative frame loops run on
      // wall-clock time; the media element is released when a timeline ends.
      audioPolicy: "host",
      decorations: "always",
      videoAtEnd: "release",
    });
    // The session starts audible in host mode; a muted host (master volume
    // zero) silences the one-shot voices and the media element up front.
    this.#session.setMuted(settings.master_volume <= 0);
    this.#surface.setReducedMotion(settings.reduce_motion ?? false);
  }

  async init(): Promise<void> {
    await this.#surface.init();
  }

  /**
   * Replaces the frame lists used for animated assets.
   *
   * Called whenever the host re-resolves the project's assets (bootstrap,
   * scene switch, editor-driven reload).  Existing instances keep their phase
   * unless the asset they display actually changed, so re-resolving assets
   * never restarts a running loop.
   */
  setAnimationAssets(animations: AnimationMap): void {
    this.#surface.setAnimations(animations);
  }

  setVisualResources(textBlocks: TextBlockMap, particles: ParticleMap): void {
    this.#surface.setVisualResources(textBlocks, particles);
  }

  unlockAudio(): Promise<void> {
    return this.#audio.unlock();
  }

  applySettings(settings: Settings): void {
    this.#audio.applySettings(settings);
    // Zero master volume is a host mute: the timeline session must not start
    // one-shot voices or unmute the media element behind the graph.
    this.#session.setMuted(settings.master_volume <= 0);
    this.#surface.setReducedMotion(settings.reduce_motion ?? false);
  }

  setTypingSfx(
    active: boolean,
    assets: AssetUrlMap,
    cps: number,
  ): Promise<void> {
    return this.#audio.setTypingSfx(active, assets, cps);
  }

  setPlaybackMode(rate: number, suppressOneShots: boolean): void {
    this.#playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    this.#suppressOneShots = suppressOneShots;
    this.#session.setRate(this.#playbackRate);
    // Fast-forward consumes the crossed timeline events without playing their
    // one-shot SFX, exactly like the shipped game did.
    this.#session.setOneShotSuppression(suppressOneShots);
  }

  setPaused(paused: boolean): void {
    this.#paused = paused;
    this.#session.setPaused(paused);
    void this.#audio.setPaused(paused);
  }

  skipCurrentPresentation(): boolean {
    if (!this.#timelineSkippable) return false;
    return this.#session.skip();
  }

  /** Cancels the active presentation without changing the authoritative world. */
  cancelCurrentPresentation(): void {
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#cancelEffects();
    this.#generation += 1;
    this.#activeStory = null;
    this.#latestSnapshot = null;
    this.#currentUpdateId = null;
    this.#currentPromise = null;
    this.#timelineSkippable = false;
    this.#session.cancel();
    this.#surface.reset();
    this.#audio.resetSession();
    this.#uiMotionHost.reconcileDialogueVisible(false);
    this.#oneShotLedger.clear();
  }

  /** Whether a presentation callback is still allowed to settle its update. */
  isPresentationCurrent(updateId: string): boolean {
    return (
      this.#currentUpdateId === updateId &&
      this.#currentPromise !== null &&
      !this.#abort.signal.aborted
    );
  }

  present(
    update: RuntimeUpdate,
    assets: AssetUrlMap,
  ): Promise<PresentationOutcome> {
    if (
      this.#currentUpdateId === update.update_id &&
      this.#currentPromise !== null
    ) {
      return this.#currentPromise;
    }
    this.#abort.abort();
    this.#abort = new AbortController();
    // A story update is a boundary: it supersedes timer effects too, because
    // its snapshot already contains everything they committed.
    this.#cancelEffects();
    // Aborting the previous update stops every signal-aware cue, but an
    // already-loaded timeline keeps ticking on the session clock.  The new
    // update is authoritative, so release the stale timeline here; otherwise
    // its frames keep writing over the snapshot this update commits.  The
    // host pause is a controller-owned policy, so carry it across the cancel.
    this.#session.cancel();
    if (this.#paused) this.#session.setPaused(true);
    const signal = this.#abort.signal;
    const generation = ++this.#generation;
    this.#activeStory = generation;
    this.#latestSnapshot = update.snapshot;
    this.#currentUpdateId = update.update_id;
    const storyGuard = (): boolean => this.#effects.size === 0;
    const operation = (async () => {
      if (update.cues.length === 0) {
        await this.#reconcile(
          this.#latestSnapshot ?? update.snapshot,
          assets,
          signal,
          storyGuard,
        );
        return "completed" as const;
      }
      // Most cues are independent and should start together (for example a
      // background cross-fade and a camera move).  Sprite transforms and
      // ambience slots are the exceptions: requests on one resource must stay
      // ordered, while different resources remain concurrent.  Build one
      // small per-update dependency graph instead of making every cue serial.
      const lastByResource = new Map<string, Promise<PresentationOutcome>>();
      const tasks = update.cues.map((cue) => {
        const resourceIds = cueResourceIds(cue);
        const predecessors = resourceIds
          .map((id) => lastByResource.get(id))
          .filter(
            (task): task is Promise<PresentationOutcome> => task !== undefined,
          );
        const task = (async (): Promise<PresentationOutcome> => {
          // A failed predecessor is reconciled at the end of this update, but
          // must not prevent the later cue from attempting to establish its
          // own final pose.
          await Promise.allSettled(predecessors);
          return this.#executeCue(update, cue, assets, signal);
        })();
        for (const id of resourceIds) lastByResource.set(id, task);
        return task;
      });
      const results = await Promise.allSettled(tasks);
      let outcome: PresentationOutcome = "completed";
      for (const result of results) {
        if (result.status === "rejected") {
          console.error(
            "Presentation cue failed; reconciling to snapshot",
            result.reason,
          );
          this.#diagnostic(`表现 Cue 失败：${errorMessage(result.reason)}`);
          outcome = "failed";
        } else if (result.value === "failed") {
          outcome = "failed";
        } else if (result.value === "skipped" && outcome !== "failed") {
          outcome = "skipped";
        }
      }
      // Signal-aware audio cues resolve quietly when aborted so their owned
      // media can roll back. The presentation itself must still report the
      // lifecycle cancellation as failed; otherwise an audio-only ambience
      // update appears completed after cancelCurrentPresentation().
      if (signal.aborted || generation !== this.#generation) outcome = "failed";
      if (generation === this.#generation && !signal.aborted) {
        await this.#reconcile(
          this.#latestSnapshot ?? update.snapshot,
          assets,
          signal,
          storyGuard,
        );
      }
      return outcome;
    })().finally(() => {
      if (this.#activeStory === generation) this.#activeStory = null;
    });
    this.#currentPromise = operation;
    return this.#currentPromise;
  }

  /**
   * Runs a timer effect beside the current story presentation.
   *
   * It reuses the story's cue executors but never cancels the story, never
   * replaces the story's update identity and never acknowledges anything: the
   * caller settles an effect (if the host asked for an acknowledgement) with the
   * returned outcome.  Resource arbitration is per effect: a newer effect that
   * touches the same sprite / audio slot supersedes an older one, and a
   * superseded or cancelled effect never reconciles, so a late completion can
   * not write an older snapshot over newer state.  The final world alignment
   * always targets the newest snapshot and is skipped while any other
   * presentation work is still running (its last finisher aligns instead).
   */
  async runEffect(
    update: RuntimeUpdate,
    assets: AssetUrlMap,
    owner: string | null = update.effect_timer ?? null,
  ): Promise<PresentationOutcome> {
    this.#latestSnapshot = update.snapshot;
    if (update.cues.length === 0) return "completed";
    const resources = new Set(update.cues.flatMap(cueResourceIds));
    for (const [otherId, other] of [...this.#effects]) {
      if ([...resources].some((resource) => other.resources.has(resource))) {
        other.abort.abort();
        this.#effects.delete(otherId);
      }
    }
    const run: EffectRun = { abort: new AbortController(), resources, owner };
    const id = ++this.#effectSequence;
    this.#effects.set(id, run);
    const signal = run.abort.signal;
    try {
      const lastByResource = new Map<string, Promise<PresentationOutcome>>();
      const tasks = update.cues.map((cue) => {
        const cueResources = cueResourceIds(cue);
        const predecessors = cueResources
          .map((resource) => lastByResource.get(resource))
          .filter(
            (task): task is Promise<PresentationOutcome> => task !== undefined,
          );
        const task = (async (): Promise<PresentationOutcome> => {
          await Promise.allSettled(predecessors);
          return this.#executeCue(update, cue, assets, signal);
        })();
        for (const resource of cueResources) lastByResource.set(resource, task);
        return task;
      });
      const results = await Promise.allSettled(tasks);
      let outcome: PresentationOutcome = "completed";
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("Effect cue failed; reconciling", result.reason);
          this.#diagnostic(`表现 Cue 失败：${errorMessage(result.reason)}`);
          outcome = "failed";
        } else if (result.value === "failed") {
          outcome = "failed";
        } else if (result.value === "skipped" && outcome !== "failed") {
          outcome = "skipped";
        }
      }
      if (signal.aborted) return "failed";
      // This effect's cues are done, so the guard below only sees *other* work.
      this.#effects.delete(id);
      await this.#reconcile(
        this.#latestSnapshot ?? update.snapshot,
        assets,
        signal,
        () => this.#activeStory === null && this.#effects.size === 0,
      );
      return outcome;
    } finally {
      this.#effects.delete(id);
    }
  }

  /**
   * Cancels the in-flight effects one timer started, leaving the story and the
   * other timers' effects alone.  Used when that timer was stopped.
   */
  cancelEffectsOf(owner: string): void {
    for (const [id, run] of [...this.#effects]) {
      if (run.owner !== owner) continue;
      run.abort.abort();
      this.#effects.delete(id);
    }
  }

  #cancelEffects(): void {
    for (const run of this.#effects.values()) run.abort.abort();
    this.#effects.clear();
  }

  async applySnapshotImmediately(
    snapshot: RuntimeSnapshot,
    assets: AssetUrlMap,
  ): Promise<void> {
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#cancelEffects();
    this.#generation += 1;
    this.#activeStory = null;
    this.#latestSnapshot = snapshot;
    this.#currentUpdateId = null;
    this.#currentPromise = null;
    this.#timelineSkippable = false;
    this.#session.cancel();
    await this.#reconcile(snapshot, assets, this.#abort.signal);
  }

  /**
   * Covers the canvas with the host-only session curtain.
   *
   * The host calls this before it replaces the whole world; the cover is a
   * fixed opaque black fade owned by the presentation surface, never a cue and
   * never part of `WorldSnapshot`, so a hard snapshot alignment can never
   * replay it.  Duplicate calls while a cover is in flight share the one
   * transition (React Strict Mode performs no duplicate work).
   */
  coverSession(): Promise<void> {
    return this.#surface.coverSession();
  }

  /** Reveals the session curtain after the replacement is on screen. */
  revealSession(): Promise<void> {
    return this.#surface.revealSession();
  }

  /**
   * Replaces the whole world behind the host-only session curtain.
   *
   * Covers (250 ms), hard aligns the snapshot while the cover is fully black —
   * no cue is replayed — and reveals (250 ms) after the replacement's first
   * stable frame.  A failure, cancellation or destroy always releases the
   * curtain, so a failed session switch cannot leave the player in the dark.
   */
  async applySessionSnapshot(
    snapshot: RuntimeSnapshot,
    assets: AssetUrlMap,
  ): Promise<void> {
    try {
      await this.coverSession();
      await this.applySnapshotImmediately(snapshot, assets);
    } finally {
      await this.revealSession();
    }
  }

  captureThumbnail(): string | null {
    return this.#surface.captureThumbnail();
  }

  /**
   * Read-only diagnostic seams used by the parity harness: the active
   * timeline's media state and the live scene frame (object geometry).
   * Neither accessor changes the presentation.
   */
  get videoState(): TimelineVideoState | null {
    return this.#session.videoState;
  }

  /** Shared read-only audio state used by editor/game parity diagnostics. */
  get audioDiagnostics(): AudioDiagnostics {
    return this.#audio.diagnostics;
  }

  /** True while the host-only session curtain fully covers the canvas. */
  get sessionCovered(): boolean {
    return this.#surface.sessionCovered;
  }

  readFrame(): SceneFrame {
    return this.#surface.readFrame();
  }

  destroy(): void {
    this.#abort.abort();
    this.#cancelEffects();
    this.#session.dispose();
    this.#surface.dispose();
    this.#oneShotLedger.clear();
  }

  // -- cue dispatch ----------------------------------------------------------

  async #executeCue(
    update: RuntimeUpdate,
    cue: PresentationCue,
    assets: AssetUrlMap,
    signal: AbortSignal,
  ): Promise<PresentationOutcome> {
    const key = `${update.update_id}:${cue.cue_id}`;
    switch (cue.type) {
      case "background_transition":
      case "sprite_tween":
      case "clear_scene":
      case "camera_tween":
      case "screen_effect":
      case "curtain_transition":
        await this.#surface.runCue(cue satisfies SceneVisualCue, {
          assets,
          signal,
          getRate: () => (this.#paused ? 0 : this.#playbackRate),
        });
        break;
      case "particle_state":
        if (this.#oneShotLedger.consume(key)) {
          await this.#surface.runCue(cue, { assets, signal, getRate: () => this.#paused ? 0 : this.#playbackRate });
        }
        break;
      case "play_sfx":
        if (this.#oneShotLedger.consume(key)) {
          if (!this.#suppressOneShots) {
            await this.#audio.playSfx(cue.asset, cue.volume, assets, signal);
          }
        }
        break;
      case "bgm_transition":
        if (this.#oneShotLedger.consume(key)) {
          await this.#audio.transitionBgm(
            cue.to,
            cue.duration_ms,
            assets,
            signal,
          );
        }
        break;
      case "ambience_transition":
        if (this.#oneShotLedger.consume(key)) {
          await this.#audio.transitionAmbience(
            cue.slot,
            cue.to,
            cue.duration_ms,
            assets,
            signal,
          );
        }
        break;
      case "delay":
        await animate(cue.duration_ms, "linear", () => undefined, signal, {
          getRate: () => (this.#paused ? 0 : this.#playbackRate),
        });
        break;
      case "dialogue_reveal":
      case "long_text_reveal":
        break;
      case "dialogue_ui_transition":
        this.#uiMotionHost.beginDialogueTransition();
        if (cue.motion !== null) {
          await this.#runUiMotion(cue.motion, cue.duration_ms, signal);
        }
        this.#uiMotionHost.reconcileDialogueVisible(cue.visible);
        break;
      case "ui_motion":
        await this.#runUiMotion(cue.motion, cue.duration_ms, signal);
        break;
      case "button_system_action":
        // The React shell opens the requested system panel when it receives
        // the authoritative RuntimeUpdate. There is no visual work for Pixi.
        break;
      case "timeline":
        return this.#runTimeline(update, assets, signal);
      default:
        cue satisfies never;
    }
    return "completed";
  }

  async #runTimeline(
    update: RuntimeUpdate,
    assets: AssetUrlMap,
    signal: AbortSignal,
  ): Promise<PresentationOutcome> {
    const cue = update.cues.find(
      (
        candidate,
      ): candidate is Extract<typeof candidate, { type: "timeline" }> =>
        candidate.type === "timeline",
    );
    if (cue === undefined) return "failed";
    const loaded = await this.#session.load(
      { update, assets, world: "continue" },
      signal,
    );
    if (loaded === "stale" || signal.aborted) return "failed";
    this.#timelineSkippable = cue.skippable;
    try {
      return await this.#session.play();
    } finally {
      this.#timelineSkippable = false;
    }
  }

  #runUiMotion(
    motion: UiMotionPreset,
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    return animate(
      durationMs,
      "linear",
      (progress) =>
        this.#uiMotionHost.apply(motion, progress * durationMs, durationMs),
      signal,
      { getRate: () => (this.#paused ? 0 : this.#playbackRate) },
    );
  }

  /**
   * Restores an authoritative snapshot.
   *
   * Every resource the replacement needs is decoded before the display list is
   * touched, so the previous visuals stay on screen while a scene switch is
   * still loading and a superseded request never commits.
   */
  async #reconcile(
    snapshot: RuntimeSnapshot,
    assets: AssetUrlMap,
    signal: AbortSignal,
    mayCommit: () => boolean = () => true,
  ): Promise<void> {
    this.#uiMotionHost.reconcileDialogueVisible(
      snapshot.world.dialogue_ui_visible,
    );
    const preparation = await this.#surface.prepare(
      { world: snapshot.world, assets },
      signal,
    );
    if (preparation === null || signal.aborted || !mayCommit()) {
      // Committing a world starts a new visual generation and would silence a
      // cue another presentation is still running, so a reconcile that is not
      // the last one yields to the work that is.
      if (preparation !== null) this.#surface.discardPreparation(preparation);
      return;
    }
    this.#surface.applyWorld(preparation);
    await this.#audio.reconcile(snapshot.audio, assets, signal);
  }
}

interface EffectRun {
  abort: AbortController;
  resources: ReadonlySet<string>;
  owner: string | null;
}

function cueResourceIds(cue: PresentationCue): string[] {
  const ids = new Set<string>();
  if (cue.type === "sprite_tween") {
    ids.add(`sprite:${cue.sprite_id}`);
  } else if (cue.type === "timeline") {
    for (const track of cue.tracks) {
      if (track.type === "sprite") ids.add(`sprite:${track.sprite_id}`);
      else if (track.type === "emitter") ids.add(`emitter:${track.emitter_id}`);
      else if (track.type === "bgm") ids.add("bgm");
      else if (track.type === "ambience") ids.add(`ambience:${track.slot}`);
    }
  } else if (cue.type === "particle_state" && !cue.burst) {
    ids.add(`emitter:${cue.emitter_id}`);
  } else if (cue.type === "bgm_transition") {
    ids.add("bgm");
  } else if (cue.type === "ambience_transition") {
    ids.add(`ambience:${cue.slot}`);
  }
  return [...ids];
}
