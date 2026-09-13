/**
 * Shared timeline presentation session.
 *
 * The session owns *time*: when a timeline plays, how far it has advanced, which
 * events it has crossed, how a scrub positions the playhead, how the video
 * element follows it and when a play promise settles.  The surface owns
 * *pixels* (objects, textures, camera, effects) and the injected audio session
 * owns *sound*.  The game and the editor both drive this one implementation:
 *
 * - the game loads a cue on top of the live scene (`world: "continue"`),
 * - the editor restores a start snapshot first (`world: "restore"`).
 *
 * Agreed semantics the migration unifies:
 *
 * - `play()` settles only at the end, on skip, cancel or failure,
 * - scrubbing is silent and deterministic; playback consumes crossed events,
 * - a backwards seek re-arms the target-and-later events,
 * - a zero-time event fires once on the first play; equal times keep array order,
 * - stale callbacks (a superseded load, an older video seek) never touch the
 *   replacement session, audio graph or video element,
 * - continuous video corrects drift above 50 ms; scrubbing waits for `seeked`
 *   plus a presented frame with a diagnostic timeout, and the latest seek wins.
 */

import { evaluateActiveScreenEffects } from "./timelineEvaluator";
import {
  evaluateSceneFrame,
  mergeSceneOverrides,
  type SceneFrame,
  type SceneOverrides,
  type SceneSpriteGeometry,
} from "./sceneFrame";
import { TimelineClock, type TimelineOutcome } from "./timeline";
import type {
  SceneActiveEffects,
  SceneBases,
  SceneCharacterRequest,
  SceneFrameApplyOptions,
  ScenePreparation,
  ScenePreparationRequest,
  SceneVideoHandle,
} from "./sceneSurface";
import type { AnimationMap } from "./imageAnimation";
import type {
  AssetUrlMap,
  AudioSnapshot,
  Settings,
  TimelineTrack,
  RuntimeSnapshot,
  RuntimeUpdate,
} from "./types";

/** Read-only media state for host diagnostics and the parity harness. */
export interface TimelineVideoState {
  muted: boolean;
  paused: boolean;
  currentTime: number;
  /** Media time the playhead currently targets, using the same formula as sync. */
  targetTime: number;
  duration: number;
  readyState: number;
  /** Decoded frame size; zero until real pixels are available. */
  videoWidth: number;
  videoHeight: number;
}

export type TimelineLoadStatus = "loaded" | "stale";
export type TimelineSeekMode = "scrub" | "playback";

/** Drift above which continuous playback re-seeks the media element. */
export const VIDEO_DRIFT_THRESHOLD_MS = 50;
/** Diagnostic bound for a scrub seek on the media element. */
const VIDEO_SCRUB_TIMEOUT_MS = 2_000;
const VIDEO_METADATA_TIMEOUT_MS = 15_000;
const VIDEO_LOAD_SEEK_TIMEOUT_MS = 8_000;
const PRESENTED_FRAME_TIMEOUT_MS = 250;
const MAX_TIMELINE_RATE = 8;

export type VideoTrack = Extract<TimelineTrack, { type: "video" }>;

/**
 * Everything the session needs from a scene surface.
 *
 * `SceneSurface` satisfies this contract; tests provide an in-memory stand-in.
 */
export interface TimelineSurfacePort {
  readonly geometry: SceneSpriteGeometry;
  setAnimations(animations: AnimationMap): void;
  prepare(
    request: ScenePreparationRequest,
    signal?: AbortSignal,
  ): Promise<ScenePreparation | null>;
  applyWorld(preparation: ScenePreparation | null): boolean;
  /** Releases a preparation the session decided not to commit. */
  discardPreparation(preparation: ScenePreparation): void;
  ensureCharacters(
    requests: readonly SceneCharacterRequest[],
    assets: AssetUrlMap,
    isCurrent: () => boolean,
  ): Promise<boolean>;
  captureBases(): SceneBases;
  applyFrame(frame: SceneFrame, options?: SceneFrameApplyOptions): void;
  readFrame(): SceneFrame;
  readOverrides(): SceneOverrides;
  setActiveEffects(effects: SceneActiveEffects | null): void;
  setDecorativeRunning(running: boolean): void;
  setPaused(paused: boolean): void;
  attachVideo(
    element: HTMLVideoElement,
    track: VideoTrack,
  ): Promise<SceneVideoHandle>;
  captureThumbnail(): string | null;
}

/** Narrow audio contract so the session can be exercised without Web Audio. */
export interface PresentationAudioPort {
  playSfx(
    asset: string,
    volume: number,
    assets: AssetUrlMap,
    signal?: AbortSignal,
  ): Promise<void>;
  attachVideo(element: HTMLVideoElement, volume: number): void;
  setVideoVolume(element: HTMLVideoElement, volume: number): void;
  setBgmTimelineVolume(volume: number): void;
  currentBgmVolume(): number | undefined;
  setPlaybackRate(rate: number): void;
  reconcile(
    snapshot: AudioSnapshot,
    assets: AssetUrlMap,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Preview policy only; the game owns its master volume. */
  applySettings(settings: Settings): void;
  activateDeferred(signal?: AbortSignal): Promise<void>;
  unlock(): Promise<void>;
  destroy(): void;
}

/** DOM seam: the session never touches `document` directly. */
export interface TimelineDomAdapter {
  createVideo(): HTMLVideoElement;
  requestFrame(callback: (nowMs: number) => void): number;
  cancelFrame(handle: number): void;
}

export const browserTimelineDom: TimelineDomAdapter = {
  createVideo: () => document.createElement("video"),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
};

export interface TimelineLoadRequest {
  update: RuntimeUpdate;
  assets: AssetUrlMap;
  /**
   * Start state of the presentation.  Required for `restore`, which applies it
   * to the surface before the timeline starts; `continue` reads the live scene
   * instead, so an in-flight cue sequence keeps its pose.
   */
  snapshot?: RuntimeSnapshot;
  /** `restore` replaces the scene with the snapshot world (editor entry). */
  world?: "continue" | "restore";
  animations?: AnimationMap;
}

export interface TimelineSessionOptions {
  surface: TimelineSurfacePort;
  audio: PresentationAudioPort;
  dom?: TimelineDomAdapter;
  diagnostic?: (message: string) => void;
  /**
   * `host` starts audible and keeps the master volume under the host's control
   * (game); `preview` starts silent, keeps the master volume at zero until
   * `setMuted(false)` and activates the deferred Web Audio graph on that
   * gesture (editor).
   */
  audioPolicy?: "host" | "preview";
  /**
   * `while-playing` positions decorative frame loops from the playhead while
   * idle, which is what a deterministic preview needs; `always` lets them run
   * on wall-clock time like the shipped game presentation.
   */
  decorations?: "always" | "while-playing";
  /** `release` drops the media element once the timeline ends (game). */
  videoAtEnd?: "release" | "hold";
}

interface SessionVideo {
  handle: SceneVideoHandle;
  element: HTMLVideoElement;
  track: VideoTrack;
  listeners: Array<() => void>;
  audioAttached: boolean;
}

type TimelineCue = Extract<RuntimeUpdate["cues"][number], { type: "timeline" }>;

const DEFAULT_SETTINGS: Settings = {
  master_volume: 1,
  bgm_volume: 1,
  sfx_volume: 1,
  video_volume: 1,
  text_speed_cps: 30,
  text_reveal_animation: "typewriter",
  skip_mode: "disabled",
};

export class TimelineSession {
  readonly #surface: TimelineSurfacePort;
  readonly #audio: PresentationAudioPort;
  readonly #dom: TimelineDomAdapter;
  readonly #diagnostic: (message: string) => void;
  readonly #audioPolicy: "host" | "preview";
  readonly #decorations: "always" | "while-playing";
  readonly #videoAtEnd: "release" | "hold";
  readonly #firedEvents = new Set<string>();
  #cue: TimelineCue | null = null;
  #assets: AssetUrlMap = {};
  #bases: SceneBases = {
    sprites: {},
    buttons: {},
    camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
    bgmVolume: 1,
  };
  #clock: TimelineClock | null = null;
  #settle: ((outcome: TimelineOutcome) => void) | null = null;
  #playPromise: Promise<TimelineOutcome> | null = null;
  #playing = false;
  #paused = false;
  /** Silence gate: a host session starts audible, a preview starts silent. */
  #muted: boolean;
  #rate = 1;
  #elapsed = 0;
  #lastCursor = -1;
  #suppressEvents = false;
  #suppressOneShots = false;
  #buffering = false;
  #video: SessionVideo | null = null;
  #runAbort: AbortController | null = null;
  #loadGeneration = 0;
  #loadAbort: AbortController | null = null;
  #seekAbort: AbortController | null = null;
  #seekGeneration = 0;
  #activationAbort: AbortController | null = null;
  #onFrame: ((frame: SceneFrame) => void) | null = null;
  #onPlayingChange: ((playing: boolean) => void) | null = null;
  #disposed = false;

  constructor(options: TimelineSessionOptions) {
    this.#surface = options.surface;
    this.#audio = options.audio;
    this.#dom = options.dom ?? browserTimelineDom;
    this.#diagnostic = options.diagnostic ?? ((): void => undefined);
    this.#audioPolicy = options.audioPolicy ?? "host";
    this.#decorations = options.decorations ?? "always";
    this.#videoAtEnd = options.videoAtEnd ?? "release";
    // Deriving the initial gate from the policy keeps the two contracts apart:
    // a host session plays its one-shot voices and video audio unless the host
    // mutes it, a preview stays silent until an explicit unmute.
    this.#muted = this.#audioPolicy === "preview";
  }

  get playing(): boolean {
    return this.#playing;
  }

  get elapsedMs(): number {
    return this.#elapsed;
  }

  get durationMs(): number {
    return this.#cue?.duration_ms ?? 0;
  }

  /**
   * Read-only diagnostic seam: the timeline's media element state.
   *
   * The parity harness uses it to record whether a deterministically seeked
   * video landed on its target time; `null` means the timeline has no media.
   */
  get videoState(): TimelineVideoState | null {
    const video = this.#video;
    if (video === null) return null;
    const target = this.#desiredVideoTime(video, this.#elapsed);
    return {
      muted: video.element.muted,
      paused: video.element.paused,
      currentTime: video.element.currentTime,
      targetTime: target ?? video.element.currentTime,
      duration: video.element.duration,
      readyState: video.element.readyState,
      videoWidth: video.element.videoWidth,
      videoHeight: video.element.videoHeight,
    };
  }

  /** Replaces the frame lists used for animated artwork. */
  setAnimations(animations: AnimationMap): void {
    this.#surface.setAnimations(animations);
  }

  setFrameListener(listener: ((frame: SceneFrame) => void) | null): void {
    this.#onFrame = listener;
  }

  setPlayingListener(listener: ((playing: boolean) => void) | null): void {
    this.#onPlayingChange = listener;
  }

  /**
   * Abortable, generation-safe load.
   *
   * Everything the replacement target needs is prepared before anything is
   * committed; a superseded load returns `stale` and leaves both the newer
   * target and the old visuals untouched.
   */
  async load(
    request: TimelineLoadRequest,
    signal?: AbortSignal,
  ): Promise<TimelineLoadStatus> {
    if (this.#disposed) return "stale";
    const generation = ++this.#loadGeneration;
    this.#loadAbort?.abort();
    const controller = new AbortController();
    this.#loadAbort = controller;
    const isCurrent = (): boolean =>
      !this.#disposed &&
      !controller.signal.aborted &&
      !(signal?.aborted ?? false) &&
      this.#loadGeneration === generation;
    const cue = findTimelineCue(request.update);
    if (cue === undefined) {
      throw new Error("目标 update 不包含 timeline Cue");
    }
    // A replacement timeline supersedes the running one: end the old pass
    // before anything is prepared or committed, so its clock (bound to the old
    // cue's duration) can never drive the replacement's frames and a host's
    // "playing" state cannot stay stuck on the superseded promise.
    this.#endRun("failed");
    if (request.animations !== undefined) {
      this.#surface.setAnimations(request.animations);
    }
    this.#assets = request.assets;
    try {
      if ((request.world ?? "continue") === "restore") {
        const snapshot = request.snapshot;
        if (snapshot === undefined) {
          throw new Error("恢复模式需要起始快照");
        }
        const preparation = await this.#surface.prepare(
          { world: snapshot.world, assets: request.assets },
          controller.signal,
        );
        if (!isCurrent()) {
          // A superseded load may still have decoded its pixels before it
          // noticed: release the completed token instead of holding the
          // textures (and the texture budget) until a reset.
          if (preparation !== null) {
            this.#surface.discardPreparation(preparation);
          }
          return "stale";
        }
        if (preparation === null || !this.#surface.applyWorld(preparation)) {
          return "stale";
        }
        await this.#audio.reconcile(
          snapshot.audio,
          request.assets,
          controller.signal,
        );
        if (!isCurrent()) return "stale";
        this.#bases = {
          sprites: { ...snapshot.world.sprites },
          buttons: { ...(snapshot.world.buttons ?? {}) },
          camera: { ...snapshot.world.camera },
          bgmVolume: snapshot.audio.bgm?.volume ?? 1,
        };
      } else {
        this.#bases = {
          ...this.#surface.captureBases(),
          bgmVolume: this.#audio.currentBgmVolume() ?? 1,
        };
      }
      this.#cue = cue;
      this.#firedEvents.clear();
      this.#lastCursor = -1;
      this.#elapsed = 0;
      if (!(await this.#ensureTrackSprites(cue, isCurrent))) return "stale";
      const video = await this.#prepareVideo(cue, isCurrent, controller.signal);
      if (video === "stale") return "stale";
      await this.seek(0, "scrub");
      if (!isCurrent()) return "stale";
      return "loaded";
    } catch (error) {
      if (!isCurrent()) return "stale";
      this.#releaseVideo();
      this.#cue = null;
      await this.#audio
        .reconcile({ bgm: null }, request.assets)
        .catch(() => undefined);
      throw error;
    } finally {
      if (this.#loadAbort === controller) this.#loadAbort = null;
    }
  }

  /**
   * Applies an edited timeline without re-preparing the scene.
   *
   * Ordinary keyframe, easing, duration and event edits only change what the
   * evaluator produces, so the playhead is simply re-evaluated.  Returns
   * `false` when the edit changes *which* assets the timeline needs (a new
   * video or a different character artwork), because that is a resource
   * dependency and the host must `load()` so the pixels are prepared before
   * anything is committed.
   */
  applyTimelineEdit(update: RuntimeUpdate): boolean {
    if (this.#disposed) return false;
    const cue = findTimelineCue(update);
    if (cue === undefined || this.#cue === null) return false;
    if (
      timelineResourceSignature(cue) !== timelineResourceSignature(this.#cue)
    ) {
      return false;
    }
    const previousCue = this.#cue;
    this.#cue = cue;
    const elapsed = Math.max(0, Math.min(cue.duration_ms, this.#elapsed));
    const cursor = Math.max(0, Math.min(cue.duration_ms, this.#lastCursor));
    // An edit is not a rewind: the ledger keeps every consumed event the edit
    // did not touch, so an event exactly at the cursor is not re-armed (and
    // re-fired) by the next playback frame after a keyframe or duration edit.
    // Events the edit moved, removed or typed differently are re-armed, and a
    // shortened duration that pulls the cursor back re-arms the
    // target-and-later events exactly like a backwards seek.
    const previousEvents = new Map(
      previousCue.events.map((event) => [event.id, event] as const),
    );
    for (const id of [...this.#firedEvents]) {
      const event = cue.events.find((candidate) => candidate.id === id);
      const before = previousEvents.get(id);
      if (
        event === undefined ||
        before === undefined ||
        event.at_ms !== before.at_ms ||
        event.type !== before.type ||
        (cursor < this.#lastCursor && event.at_ms >= cursor)
      ) {
        this.#firedEvents.delete(id);
      }
    }
    this.#lastCursor = cursor;
    this.#elapsed = elapsed;
    // A duration edit can extend or shorten a timeline that is still running;
    // the live clock must adopt the edited bound instead of finishing against
    // the obsolete one.
    this.#clock?.setDuration(cue.duration_ms);
    this.#clock?.setElapsed(elapsed);
    return true;
  }

  /**
   * Starts or resumes playback.
   *
   * The returned promise settles only at the end of the timeline, on skip, on
   * cancellation or on failure; `pause()` does not settle it.
   */
  async play(): Promise<TimelineOutcome> {
    const cue = this.#cue;
    if (this.#disposed || cue === null) return "failed";
    this.#playing = true;
    this.#onPlayingChange?.(true);
    if (this.#decorations === "while-playing") {
      this.#surface.setDecorativeRunning(true);
    }
    const existing = this.#clock;
    if (this.#settle !== null && existing !== null) {
      existing.setPaused(this.#paused);
      existing.setBuffering(this.#buffering);
      await this.#startVideoPlayback();
      return this.#playPromise ?? "failed";
    }
    const runAbort = new AbortController();
    this.#runAbort = runAbort;
    const clock = new TimelineClock(
      cue.duration_ms,
      () => (this.#paused ? 0 : this.#rate),
      (elapsedMs) => this.#render(elapsedMs, "playback"),
    );
    // A preview may have scrubbed before pressing play; the clock continues
    // from that position instead of restarting the timeline.  A host pause
    // applied before the clock existed is this session's policy, so the new
    // clock starts frozen instead of running under a paused host.
    clock.setElapsed(this.#elapsed);
    clock.setPaused(this.#paused);
    clock.setBuffering(this.#buffering);
    this.#clock = clock;
    const run = new Promise<TimelineOutcome>((resolve) => {
      this.#settle = resolve;
    });
    this.#playPromise = run;
    void (async (): Promise<void> => {
      // A preview host plays from a user gesture, so it may unlock the shared
      // Web Audio graph here; the game unlocks on its own first gesture and
      // must never block playback on an AudioContext that a headless runner
      // keeps suspended.
      if (this.#audioPolicy === "preview") {
        await this.#audio.unlock().catch(() => undefined);
      }
      if (!this.#playing || this.#clock !== clock) return;
      await this.#startVideoPlayback();
      if (!this.#playing || this.#clock !== clock) return;
      const outcome = await clock.run(runAbort.signal);
      if (this.#clock !== clock) return;
      this.#clock = null;
      this.#playing = false;
      this.#onPlayingChange?.(false);
      this.#finishRun();
      const settle = this.#settle;
      this.#settle = null;
      settle?.(outcome);
    })();
    return run;
  }

  /** Pauses playback without settling the play promise. */
  pause(): void {
    this.#playing = false;
    this.#onPlayingChange?.(false);
    this.#clock?.setPaused(true);
    this.#video?.element.pause();
    if (this.#decorations === "while-playing") {
      this.#surface.setDecorativeRunning(false);
      this.#applyFrame(this.#elapsed, "playhead");
    }
  }

  /** Host pause (menu, hidden page): freezes without losing the playhead. */
  setPaused(paused: boolean): void {
    this.#paused = paused;
    this.#clock?.setPaused(paused);
    this.#surface.setPaused(paused);
    const video = this.#video;
    if (video !== null) {
      if (paused) video.element.pause();
      else void video.element.play().catch(() => undefined);
    }
  }

  /** Dynamic rate: clock, audio graph and video all follow. */
  setRate(rate: number): void {
    this.#rate = Number.isFinite(rate) && rate > 0 ? Math.min(16, rate) : 1;
    this.#audio.setPlaybackRate(this.#rate);
    this.#video?.handle.updateFrame();
  }

  /**
   * Host fast-forward policy: crossed one-shot timeline SFX are consumed but
   * not played, the way the shipped game suppressed them while Ctrl was held.
   * Other event types (screen effects) are unaffected.
   */
  setOneShotSuppression(suppress: boolean): void {
    this.#suppressOneShots = suppress;
  }

  /**
   * Preview/host silence policy.
   *
   * `preview` also keeps the master volume at zero and re-activates the
   * deferred Web Audio graph on the first unmute; `host` only gates the effect
   * and video voices, leaving the master volume to the host settings.
   */
  setMuted(muted: boolean): void {
    this.#muted = muted;
    if (this.#audioPolicy === "preview") {
      this.#activationAbort?.abort();
      this.#activationAbort = null;
      this.#audio.applySettings({
        ...DEFAULT_SETTINGS,
        master_volume: muted ? 0 : 1,
      });
      if (!muted) {
        const activation = new AbortController();
        this.#activationAbort = activation;
        void this.#audio
          .activateDeferred(activation.signal)
          .catch((error: unknown) =>
            this.#diagnostic(`预览音频初始化失败：${errorMessage(error)}`),
          )
          .finally(() => {
            if (this.#activationAbort === activation) {
              this.#activationAbort = null;
            }
          });
      }
    }
    this.#syncVideoAudio();
  }

  /**
   * Positions the playhead.
   *
   * `scrub` is silent and deterministic: no sound, no event consumption, the
   * decorative loops follow the playhead, and the video seeks with a bounded
   * wait.  `playback` consumes the events the playhead crossed.
   */
  async seek(
    elapsedMs: number,
    mode: TimelineSeekMode = "scrub",
  ): Promise<void> {
    const cue = this.#cue;
    if (cue === null) return;
    const elapsed = Math.max(0, Math.min(cue.duration_ms, elapsedMs));
    const generation = ++this.#seekGeneration;
    this.#seekAbort?.abort();
    const controller = new AbortController();
    this.#seekAbort = controller;
    const isCurrent = (): boolean =>
      !this.#disposed &&
      !controller.signal.aborted &&
      this.#seekGeneration === generation;
    if (elapsed < this.#elapsed || elapsed < this.#lastCursor) {
      // A backwards seek re-arms every event at or after the new position.
      for (const event of cue.events) {
        if (event.at_ms >= elapsed) this.#firedEvents.delete(event.id);
      }
    }
    this.#clock?.setElapsed(elapsed);
    // Every seek positions the decorative loops from the playhead, so the same
    // position always shows the same frame (scrubbing determinism).  Only the
    // clock's own playback frames keep the loops on the wall clock.
    this.#applyFrame(elapsed, "playhead");
    if (mode === "playback" && !this.#suppressEvents) {
      this.#fireCrossedEvents(elapsed, controller.signal);
    }
    this.#lastCursor = elapsed;
    this.#elapsed = elapsed;
    await this.#syncVideo(elapsed, mode, controller.signal, generation);
    if (!isCurrent()) return;
  }

  /** Skips to the end of the timeline, suppressing the remaining events. */
  skip(): boolean {
    const clock = this.#clock;
    if (clock === null || this.#settle === null) return false;
    this.#suppressEvents = true;
    try {
      return clock.skip();
    } finally {
      this.#suppressEvents = false;
    }
  }

  /**
   * Cancels the active presentation without changing the authoritative world.
   *
   * The play promise settles with `failed`, every listener is released, and a
   * late media callback can no longer reach a replacement session.
   */
  cancel(): void {
    this.#loadGeneration += 1;
    this.#loadAbort?.abort();
    this.#loadAbort = null;
    this.#seekGeneration += 1;
    this.#seekAbort?.abort();
    this.#seekAbort = null;
    this.#activationAbort?.abort();
    this.#activationAbort = null;
    this.#runAbort?.abort();
    this.#runAbort = null;
    this.#clock = null;
    this.#playing = false;
    this.#paused = false;
    this.#onPlayingChange?.(false);
    this.#releaseVideo();
    this.#firedEvents.clear();
    this.#lastCursor = -1;
    this.#cue = null;
    this.#elapsed = 0;
    this.#suppressEvents = false;
    this.#buffering = false;
    const settle = this.#settle;
    this.#settle = null;
    this.#playPromise = null;
    settle?.("failed");
    if (this.#decorations === "while-playing") {
      this.#surface.setDecorativeRunning(false);
    }
  }

  /** Current frame with interactive overrides merged in. */
  readFrame(): SceneFrame {
    return this.#surface.readFrame();
  }

  /** Evaluated frame at a position, without moving the playhead. */
  frameAt(elapsedMs: number): SceneFrame {
    return mergeSceneOverrides(
      this.#evaluate(elapsedMs),
      this.#surface.readOverrides(),
      this.#surface.geometry,
    );
  }

  readOverrides(): SceneOverrides {
    return this.#surface.readOverrides();
  }

  captureThumbnail(): string | null {
    return this.#surface.captureThumbnail();
  }

  /** Idempotent teardown of everything the session owns. */
  dispose(): void {
    if (this.#disposed) return;
    this.cancel();
    this.#disposed = true;
    this.#audio.destroy();
    this.#onFrame = null;
    this.#onPlayingChange = null;
  }

  // -- internals -------------------------------------------------------------

  /**
   * Ends the active pass without changing the loaded cue or the visual world.
   *
   * A replacement timeline supersedes the running one, so the stale clock is
   * invalidated, its media released, decorations stopped and the play promise
   * settled (`failed`, the same outcome a cancel reports).  The cue itself is
   * left to the caller so `load()` can keep preparing the replacement while
   * the old pass no longer ticks.
   */
  #endRun(outcome: TimelineOutcome): void {
    // An in-flight scrub seek is invalidated *before* the media element is
    // released, exactly like `cancel()` and `dispose()` do: an abandoned seek
    // must not fire its diagnostic timeout (or reach a released handle) once
    // the pass that owned it has ended, even when the replacement is still
    // preparing its pixels.
    this.#seekGeneration += 1;
    this.#seekAbort?.abort();
    this.#seekAbort = null;
    if (this.#clock === null && this.#settle === null) return;
    this.#runAbort?.abort();
    this.#runAbort = null;
    this.#clock = null;
    if (this.#playing) {
      this.#playing = false;
      this.#onPlayingChange?.(false);
    }
    this.#releaseVideo();
    if (this.#decorations === "while-playing") {
      this.#surface.setDecorativeRunning(false);
    }
    const settle = this.#settle;
    this.#settle = null;
    this.#playPromise = null;
    settle?.(outcome);
  }

  #evaluate(elapsedMs: number): SceneFrame {
    const cue = this.#cue;
    if (cue === null) return this.#surface.readFrame();
    return evaluateSceneFrame(
      {
        duration_ms: cue.duration_ms,
        tracks: cue.tracks,
        sprites: this.#bases.sprites,
        buttons: this.#bases.buttons,
        camera: this.#bases.camera,
        bgm_volume: this.#bases.bgmVolume,
      },
      elapsedMs,
      this.#surface.geometry,
    );
  }

  #applyFrame(elapsedMs: number, phase: "playhead" | "keep"): void {
    const frame = mergeSceneOverrides(
      this.#evaluate(elapsedMs),
      this.#surface.readOverrides(),
      this.#surface.geometry,
    );
    this.#surface.applyFrame(frame, { phase });
    const { flash, shake } = evaluateActiveScreenEffects(
      this.#cue?.events ?? [],
      elapsedMs,
    );
    // Effects are derived from the playhead in both modes, so scrubbing and
    // playback cannot drift apart and flash/shake can coexist.
    this.#surface.setActiveEffects({ flash, shake, elapsedMs });
    this.#audio.setBgmTimelineVolume(frame.bgm_volume);
    this.#onFrame?.(frame);
  }

  #render(elapsedMs: number, mode: TimelineSeekMode): void {
    const cue = this.#cue;
    if (cue === null) return;
    const elapsed = Math.max(0, Math.min(cue.duration_ms, elapsedMs));
    this.#applyFrame(elapsed, mode === "scrub" ? "playhead" : "keep");
    if (mode === "playback" && !this.#suppressEvents) {
      this.#fireCrossedEvents(elapsed, this.#runAbort?.signal ?? null);
    }
    this.#lastCursor = elapsed;
    this.#elapsed = elapsed;
    this.#syncVideoContinuous(elapsed);
  }

  /**
   * Consumes every event the playhead crossed since the previous position.
   *
   * The window is closed at the start position, so an event exactly on the
   * playhead still fires (a zero-time event fires on the first play even though
   * the load positioned the playhead at zero).  One ledger entry per event
   * keeps it from firing twice while the playhead rests on it, events at the
   * same timestamp fire in array order, and a backwards seek re-arms the
   * target-and-later events by deleting their entries.
   */
  #fireCrossedEvents(elapsedMs: number, signal: AbortSignal | null): void {
    const cue = this.#cue;
    if (cue === null) return;
    const previous = this.#lastCursor;
    for (const event of cue.events) {
      if (event.at_ms < previous || event.at_ms > elapsedMs) continue;
      if (this.#firedEvents.has(event.id)) continue;
      this.#firedEvents.add(event.id);
      if (event.type !== "sfx" || this.#muted || this.#suppressOneShots)
        continue;
      void this.#audio
        .playSfx(event.asset, event.volume, this.#assets, signal ?? undefined)
        .catch((error: unknown) =>
          this.#diagnostic(`时间线 SFX 失败：${errorMessage(error)}`),
        );
    }
  }

  #finishRun(): void {
    const cue = this.#cue;
    const elapsed =
      cue === null ? this.#elapsed : Math.min(cue.duration_ms, this.#elapsed);
    // A preview keeps the terminal frame on screen; the game releases the
    // media element because the following snapshot is authoritative.
    if (this.#decorations === "while-playing") {
      this.#surface.setDecorativeRunning(false);
      this.#applyFrame(elapsed, "playhead");
    }
    if (this.#videoAtEnd === "release") {
      this.#releaseVideo();
    } else {
      this.#video?.element.pause();
    }
  }

  async #ensureTrackSprites(
    cue: TimelineCue,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    const requests: SceneCharacterRequest[] = [];
    for (const track of cue.tracks) {
      if (track.type !== "sprite") continue;
      const asset =
        track.asset ?? this.#bases.sprites[track.sprite_id]?.asset ?? null;
      if (asset === null) {
        throw new Error(`立绘 ${track.sprite_id} 没有可继承的素材`);
      }
      requests.push({ id: track.sprite_id, asset });
    }
    if (requests.length === 0) return true;
    return this.#surface.ensureCharacters(requests, this.#assets, isCurrent);
  }

  async #prepareVideo(
    cue: TimelineCue,
    isCurrent: () => boolean,
    signal: AbortSignal,
  ): Promise<"prepared" | "none" | "stale"> {
    const track = cue.tracks.find(
      (candidate): candidate is VideoTrack => candidate.type === "video",
    );
    if (track === undefined) {
      this.#releaseVideo();
      return "none";
    }
    this.#releaseVideo();
    const url = this.#assets[track.asset];
    if (url === undefined) throw new Error(`素材尚未解析: ${track.asset}`);
    const element = this.#dom.createVideo();
    element.preload = "auto";
    element.crossOrigin = "anonymous";
    element.playsInline = true;
    element.autoplay = false;
    element.loop = false;
    element.controls = false;
    element.disablePictureInPicture = true;
    // Keep the element silent until the host's audio policy says otherwise.
    element.muted = true;
    element.src = url;
    let handle: SceneVideoHandle | null = null;
    try {
      await waitForVideoMetadata(element, signal);
      if (!isCurrent()) {
        releaseElement(element);
        return "stale";
      }
      if (track.clip_start_ms > 0) {
        await seekElement(
          element,
          track.clip_start_ms / 1_000,
          signal,
          VIDEO_LOAD_SEEK_TIMEOUT_MS,
        );
        if (!isCurrent()) {
          releaseElement(element);
          return "stale";
        }
      }
      await waitForPresentedFrame(element, signal);
      if (!isCurrent()) {
        releaseElement(element);
        return "stale";
      }
      handle = await this.#surface.attachVideo(element, track);
      if (!isCurrent()) {
        handle.release();
        releaseElement(element);
        return "stale";
      }
    } catch (error) {
      handle?.release();
      releaseElement(element);
      throw error;
    }
    const listeners: Array<() => void> = [];
    const setBuffering = (value: boolean): void => {
      this.#buffering = value;
      this.#clock?.setBuffering(value);
    };
    const onWaiting = (): void => setBuffering(true);
    const onPlaying = (): void => setBuffering(false);
    for (const [name, handler] of [
      ["waiting", onWaiting],
      ["stalled", onWaiting],
      ["playing", onPlaying],
      ["canplay", onPlaying],
    ] as const) {
      element.addEventListener(name, handler);
      listeners.push(() => element.removeEventListener(name, handler));
    }
    this.#video = {
      handle,
      element,
      track,
      listeners,
      audioAttached: false,
    };
    this.#buffering = false;
    this.#syncVideoAudio();
    return "prepared";
  }

  #syncVideoAudio(): void {
    const video = this.#video;
    if (video === null) return;
    const wanted = video.track.audio_enabled && !this.#muted;
    video.element.muted = !wanted;
    if (wanted && !video.audioAttached) {
      this.#audio.attachVideo(video.element, 1);
      video.audioAttached = true;
    }
    if (video.audioAttached) {
      this.#audio.setVideoVolume(video.element, this.#videoVolume());
    }
  }

  /** Video channel volume follows the evaluated frame; fast-forward silences it. */
  #videoVolume(): number {
    if (this.#rate >= MAX_TIMELINE_RATE) return 0;
    const video = this.#video;
    if (video === null) return 1;
    const frame = this.#surface.readFrame();
    const evaluated = frame.objects.find(
      (object) => object.kind === "video" && object.asset === video.track.asset,
    );
    return evaluated?.volume ?? 1;
  }

  async #startVideoPlayback(): Promise<void> {
    const video = this.#video;
    if (video === null) return;
    this.#syncVideoAudio();
    video.element.playbackRate = this.#videoPlaybackRate();
    try {
      await video.element.play();
    } catch (error) {
      this.#diagnostic(`视频无法开始播放：${errorMessage(error)}`);
    }
  }

  #videoPlaybackRate(): number {
    return Math.max(0.25, Math.min(MAX_TIMELINE_RATE, this.#rate));
  }

  #releaseVideo(): void {
    const video = this.#video;
    if (video === null) return;
    this.#video = null;
    for (const remove of video.listeners) remove();
    video.element.pause();
    video.handle.release();
    releaseElement(video.element);
    this.#buffering = false;
  }

  /** Continuous playback correction: only beyond the drift threshold. */
  #syncVideoContinuous(elapsedMs: number): void {
    const video = this.#video;
    if (video === null) return;
    const desired = this.#desiredVideoTime(video, elapsedMs);
    if (desired === null) return;
    const element = video.element;
    element.playbackRate = this.#videoPlaybackRate();
    if (
      !this.#buffering &&
      Math.abs(element.currentTime - desired) > VIDEO_DRIFT_THRESHOLD_MS / 1_000
    ) {
      element.currentTime = desired;
    }
    if (video.audioAttached) {
      this.#audio.setVideoVolume(element, this.#videoVolume());
    }
    video.handle.updateFrame();
  }

  /**
   * Scrubbing: wait for `seeked` plus a presented frame, bounded by a
   * diagnostic timeout.  A newer seek always wins over an in-flight one.
   */
  async #syncVideo(
    elapsedMs: number,
    mode: TimelineSeekMode,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    const video = this.#video;
    if (video === null) return;
    const desired = this.#desiredVideoTime(video, elapsedMs);
    if (desired === null) return;
    const element = video.element;
    if (Math.abs(element.currentTime - desired) > 0.001) {
      if (mode === "playback") {
        element.currentTime = desired;
      } else {
        try {
          await seekElement(element, desired, signal, VIDEO_SCRUB_TIMEOUT_MS);
          if (
            !isCurrentSeek(
              this.#seekGeneration,
              generation,
              signal,
              this.#disposed,
            )
          ) {
            return;
          }
          await waitForPresentedFrame(element, signal);
        } catch (error) {
          if (!signal.aborted) {
            this.#diagnostic(
              `视频定位失败（${video.track.asset} @ ${elapsedMs}ms）：${errorMessage(error)}`,
            );
          }
          return;
        }
        if (
          !isCurrentSeek(
            this.#seekGeneration,
            generation,
            signal,
            this.#disposed,
          )
        ) {
          return;
        }
      }
    }
    if (this.#playing && element.paused) {
      void element.play().catch(() => undefined);
    }
    video.handle.updateFrame();
  }

  #desiredVideoTime(video: SessionVideo, elapsedMs: number): number | null {
    const duration = video.element.duration;
    const clipStart = video.track.clip_start_ms / 1_000;
    const fallbackEnd = clipStart + elapsedMs / 1_000;
    const clipEnd =
      (video.track.clip_end_ms ??
        (Number.isFinite(duration) ? duration * 1_000 : fallbackEnd * 1_000)) /
      1_000;
    const span = Math.max(0.001, clipEnd - clipStart);
    const raw = clipStart + elapsedMs / 1_000;
    const desired = video.track.loop
      ? clipStart + ((((raw - clipStart) % span) + span) % span)
      : Math.min(clipEnd, raw);
    return Number.isFinite(desired) ? desired : null;
  }
}

function findTimelineCue(update: RuntimeUpdate): TimelineCue | undefined {
  return update.cues.find(
    (candidate): candidate is TimelineCue => candidate.type === "timeline",
  );
}

/**
 * Asset signature of a timeline: everything the surface must prepare before a
 * commit.  Keyframes, easing and events are intentionally excluded.
 */
function timelineResourceSignature(cue: TimelineCue): string {
  const parts: string[] = [];
  for (const track of cue.tracks) {
    if (track.type === "sprite") {
      parts.push(`sprite:${track.sprite_id}:${track.asset ?? "inherit"}`);
    } else if (track.type === "video") {
      parts.push(`video:${track.asset}`);
    }
  }
  return parts.sort().join("|");
}

function isCurrentSeek(
  current: number,
  generation: number,
  signal: AbortSignal,
  disposed: boolean,
): boolean {
  return !disposed && !signal.aborted && current === generation;
}

function releaseElement(element: HTMLVideoElement): void {
  element.removeAttribute("src");
  element.load();
}

function waitForVideoMetadata(
  element: HTMLVideoElement,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  if (element.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve();
  }
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        element.removeEventListener("loadedmetadata", loaded);
        element.removeEventListener("error", failed);
        signal.removeEventListener("abort", aborted);
      };
      const loaded = (): void => {
        cleanup();
        resolve();
      };
      const failed = (): void => {
        cleanup();
        reject(new Error(videoErrorMessage(element, "视频元数据加载失败")));
      };
      const aborted = (): void => {
        cleanup();
        resolve();
      };
      element.addEventListener("loadedmetadata", loaded, { once: true });
      element.addEventListener("error", failed, { once: true });
      signal.addEventListener("abort", aborted, { once: true });
      element.load();
    }),
    VIDEO_METADATA_TIMEOUT_MS,
    "视频元数据加载超时",
  );
}

function seekElement(
  element: HTMLVideoElement,
  targetSeconds: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const target = Math.max(0, targetSeconds);
  if (signal.aborted) return Promise.resolve();
  if (Math.abs(element.currentTime - target) < 0.001) return Promise.resolve();
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        element.removeEventListener("seeked", seeked);
        element.removeEventListener("error", failed);
        signal.removeEventListener("abort", aborted);
      };
      const seeked = (): void => {
        cleanup();
        resolve();
      };
      const failed = (): void => {
        cleanup();
        reject(new Error(videoErrorMessage(element, "视频定位失败")));
      };
      const aborted = (): void => {
        cleanup();
        resolve();
      };
      element.addEventListener("seeked", seeked, { once: true });
      element.addEventListener("error", failed, { once: true });
      signal.addEventListener("abort", aborted, { once: true });
      element.currentTime = target;
    }),
    timeoutMs,
    "视频定位超时",
  );
}

function waitForPresentedFrame(
  element: HTMLVideoElement,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  if (typeof element.requestVideoFrameCallback === "function") {
    return withTimeout(
      new Promise<void>((resolve) => {
        let handle = 0;
        const finish = (): void => {
          if (typeof element.cancelVideoFrameCallback === "function") {
            element.cancelVideoFrameCallback(handle);
          }
          signal.removeEventListener("abort", finish);
          resolve();
        };
        handle = element.requestVideoFrameCallback(() => finish());
        signal.addEventListener("abort", finish, { once: true });
      }),
      PRESENTED_FRAME_TIMEOUT_MS,
      "视频帧呈现超时",
    ).catch(() => undefined);
  }
  if (element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve();
  }
  return withTimeout(
    new Promise<void>((resolve) => {
      const finish = (): void => {
        element.removeEventListener("seeked", finish);
        element.removeEventListener("canplay", finish);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      element.addEventListener("seeked", finish, { once: true });
      element.addEventListener("canplay", finish, { once: true });
      signal.addEventListener("abort", finish, { once: true });
    }),
    PRESENTED_FRAME_TIMEOUT_MS,
    "视频帧呈现超时",
  ).catch(() => undefined);
}

function videoErrorMessage(element: HTMLVideoElement, prefix: string): string {
  const code = element.error?.code;
  return code === undefined
    ? prefix
    : `${prefix}（MediaError ${code}: ${element.error?.message ?? ""}）`;
}

function withTimeout<T>(
  promise: Promise<T>,
  durationMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(message)),
      durationMs,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        window.clearTimeout(timer);
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      },
    );
  });
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
