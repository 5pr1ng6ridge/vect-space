import "pixi.js/unsafe-eval";

import {
  Application,
  Container,
  Graphics,
  Sprite,
  Texture,
  VideoSource,
} from "pixi.js";

import { AudioManager } from "@vectspace/presentation-core/audio";
import { BoundedLedger } from "@vectspace/presentation-core/ledger";
import { evaluateTimelineFrame } from "@vectspace/presentation-core/timeline-evaluator";
import type {
  AssetUrlMap,
  CameraSnapshot,
  Easing,
  PresentationCue,
  PresentationOutcome,
  RuntimeSnapshot,
  RuntimeUpdate,
  Settings,
  SpriteSnapshot,
  TimelineEvent,
  TimelineTrack,
  UiMotionPreset,
} from "./types";
import { TimelineClock } from "@vectspace/presentation-core/timeline";
import { UiMotionHost } from "@vectspace/presentation-core/ui-motion";
import { advanceVirtualElapsed } from "@vectspace/presentation-core/virtual-clock";
import {
  FrameSequencePlayer,
  resolveImageAsset,
  type AnimationMap,
  type ImageAssetSource,
} from "@vectspace/presentation-core/image-animation";
import { DESIGN_HEIGHT, DESIGN_WIDTH } from "../viewport/viewport";

// Texture budget for one game session.  Content validation allows a single
// frame animation to hold hundreds of images, so a fixed count can never be
// reconciled with "every legal harness must load": the budget is instead
// derived from the resolved animation map (see `#textureBudget`) and this value
// is only the floor for projects that declare no animations at all.
const MIN_SESSION_TEXTURES = 512;
/** Headroom for backgrounds, sprites, GUI art and buttons beside the frames. */
const TEXTURE_BUDGET_HEADROOM = 128;

export class PresentationController {
  readonly #application = new Application();
  readonly #world = new Container();
  readonly #backgrounds = new Container();
  readonly #effects = new Container();
  readonly #spriteViews = new Map<string, Sprite>();
  readonly #audio: AudioManager;
  readonly #canvas: HTMLCanvasElement;
  readonly #diagnostic: (message: string) => void;
  readonly #uiMotionHost: UiMotionHost;
  readonly #oneShotLedger = new BoundedLedger<string>(4_096);
  readonly #texturePromises = new Map<string, Promise<Texture>>();
  /** Decoded frame textures per animated asset; shared by every instance. */
  readonly #animationFrames = new Map<string, Promise<Texture[]>>();
  /** One loop position per displayed instance; never shared between them. */
  readonly #spritePlayers = new Map<string, FrameSequencePlayer>();
  /** Resolved frame lists for animated assets, keyed by logical asset id. */
  #animations: AnimationMap = {};
  #backgroundPlayer: FrameSequencePlayer | null = null;
  #background: Sprite | null = null;
  #camera: CameraSnapshot = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
  #generation = 0;
  #abort = new AbortController();
  #textureBudget = MIN_SESSION_TEXTURES;
  #currentUpdateId: string | null = null;
  #currentPromise: Promise<PresentationOutcome> | null = null;
  #playbackRate = 1;
  #suppressOneShots = false;
  #paused = false;
  #timelineClock: TimelineClock | null = null;
  #timelineSkippable = false;
  #skipSuppressTimelineEvents = false;
  #activeVideo: HTMLVideoElement | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    settings: Settings,
    diagnostic: (message: string) => void,
    uiMotionHost: UiMotionHost,
  ) {
    this.#canvas = canvas;
    this.#audio = new AudioManager(settings);
    this.#diagnostic = diagnostic;
    this.#uiMotionHost = uiMotionHost;
  }

  async init(): Promise<void> {
    await this.#application.init({
      canvas: this.#canvas,
      width: DESIGN_WIDTH,
      height: DESIGN_HEIGHT,
      resolution: 1,
      autoDensity: false,
      antialias: true,
      backgroundColor: 0x05070c,
      preference: "webgl",
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
    this.#world.sortableChildren = true;
    this.#backgrounds.zIndex = -1_000_000;
    this.#world.addChild(this.#backgrounds);
    this.#application.stage.addChild(this.#world, this.#effects);
    this.#applyCamera();
    this.#application.render();
    // Frame loops are decorative: they advance with real elapsed time, never
    // with the fast-forward rate, and stop while the presentation is paused.
    this.#application.ticker.add(this.#tickFrameLoops);
  }

  /**
   * Replaces the frame lists used for animated assets.
   *
   * Called whenever the host re-resolves the project's assets (bootstrap,
   * scene switch, editor-driven reload).  Existing players keep their position
   * unless the asset they display actually changed, so re-resolving assets
   * never restarts a running loop.
   */
  setAnimationAssets(animations: AnimationMap): void {
    this.#animations = animations;
    this.#animationFrames.clear();
    this.#textureBudget = Math.max(
      MIN_SESSION_TEXTURES,
      countAnimationFrames(animations) + TEXTURE_BUDGET_HEADROOM,
    );
  }

  #tickFrameLoops = (): void => {
    if (this.#paused) return;
    const delta = this.#application.ticker.deltaMS;
    if (!Number.isFinite(delta) || delta <= 0) return;
    const players = [
      ...(this.#backgroundPlayer === null ? [] : [this.#backgroundPlayer]),
      ...this.#spritePlayers.values(),
    ];
    let changed = false;
    for (const player of players) {
      if (player.advance(delta) && !player.clock.isPaused()) changed = true;
    }
    if (changed) this.#application.render();
  };

  unlockAudio(): Promise<void> {
    return this.#audio.unlock();
  }

  applySettings(settings: Settings): void {
    this.#audio.applySettings(settings);
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
    this.#audio.setPlaybackRate(this.#playbackRate);
  }

  setPaused(paused: boolean): void {
    this.#paused = paused;
    this.#timelineClock?.setPaused(paused);
    // Decoration rules: a paused presentation freezes frame loops without
    // accruing time, so resuming continues on the same frame.
    this.#backgroundPlayer?.setPaused(paused);
    for (const player of this.#spritePlayers.values()) {
      player.setPaused(paused);
    }
    if (paused) this.#activeVideo?.pause();
    else void this.#activeVideo?.play().catch(() => undefined);
    void this.#audio.setPaused(paused);
  }

  skipCurrentPresentation(): boolean {
    if (!this.#timelineSkippable || this.#timelineClock === null) return false;
    this.#skipSuppressTimelineEvents = true;
    return this.#timelineClock.skip();
  }

  /** Cancels the active presentation without changing the authoritative world. */
  cancelCurrentPresentation(): void {
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#generation += 1;
    this.#currentUpdateId = null;
    this.#currentPromise = null;
    this.#timelineClock = null;
    this.#timelineSkippable = false;
    this.#activeVideo?.pause();
    this.#activeVideo = null;
    this.#audio.resetSession();
    for (const child of this.#backgrounds.removeChildren()) child.destroy();
    this.#background = null;
    for (const view of this.#spriteViews.values()) view.destroy();
    this.#spriteViews.clear();
    for (const effect of this.#effects.removeChildren()) effect.destroy();
    this.#camera = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
    this.#applyCamera();
    this.#uiMotionHost.reconcileDialogueVisible(false);
    this.#oneShotLedger.clear();
    this.#application.render();
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
    const signal = this.#abort.signal;
    const generation = ++this.#generation;
    this.#currentUpdateId = update.update_id;
    const operation = (async () => {
      if (update.cues.length === 0) {
        await this.#reconcile(update.snapshot, assets, signal);
        return "completed" as const;
      }
      // Most cues are independent and should start together (for example a
      // background cross-fade and a camera move).  Sprite transforms are the
      // exception: a non-blocking move followed by a reusable sprite action
      // must finish the previous transform before the next one samples the
      // pose.  Build a small per-update dependency graph instead of making
      // every cue serial, preserving authored concurrency while guaranteeing
      // same-instance ordering.
      const lastBySprite = new Map<string, Promise<PresentationOutcome>>();
      const tasks = update.cues.map((cue) => {
        const spriteIds = cueSpriteResourceIds(cue);
        const predecessors = spriteIds
          .map((id) => lastBySprite.get(id))
          .filter(
            (task): task is Promise<PresentationOutcome> => task !== undefined,
          );
        const task = (async (): Promise<PresentationOutcome> => {
          // A failed predecessor is reconciled at the end of this update, but
          // must not prevent the later cue from attempting to establish its
          // own final pose.
          await Promise.allSettled(predecessors);
          return this.#executeCue(update.update_id, cue, assets, signal);
        })();
        for (const id of spriteIds) lastBySprite.set(id, task);
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
      if (generation === this.#generation && !signal.aborted) {
        await this.#reconcile(update.snapshot, assets, signal);
      }
      return outcome;
    })();
    this.#currentPromise = operation;
    return this.#currentPromise;
  }

  async applySnapshotImmediately(
    snapshot: RuntimeSnapshot,
    assets: AssetUrlMap,
  ): Promise<void> {
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#generation += 1;
    this.#currentUpdateId = null;
    this.#currentPromise = null;
    this.#timelineClock = null;
    this.#timelineSkippable = false;
    await this.#reconcile(snapshot, assets, this.#abort.signal);
  }

  captureThumbnail(): string | null {
    try {
      const source = this.#application.renderer.extract.canvas(
        this.#application.stage,
      );
      const thumbnail = document.createElement("canvas");
      thumbnail.width = 320;
      thumbnail.height = 180;
      const context = thumbnail.getContext("2d");
      if (context === null) {
        return null;
      }
      context.drawImage(source as CanvasImageSource, 0, 0, 320, 180);
      return thumbnail.toDataURL("image/png", 0.86);
    } catch (error) {
      console.error("Could not capture save thumbnail", error);
      return null;
    }
  }

  destroy(): void {
    this.#abort.abort();
    this.#audio.destroy();
    this.#backgroundPlayer?.dispose();
    this.#backgroundPlayer = null;
    for (const player of this.#spritePlayers.values()) player.dispose();
    this.#spritePlayers.clear();
    this.#application.ticker.remove(this.#tickFrameLoops);
    this.#application.destroy({ removeView: false }, { children: true });
    for (const texture of this.#texturePromises.values()) {
      void texture
        .then((resolved) => resolved.destroy(true))
        .catch(() => undefined);
    }
    this.#texturePromises.clear();
    this.#oneShotLedger.clear();
  }

  async #executeCue(
    updateId: string,
    cue: PresentationCue,
    assets: AssetUrlMap,
    signal: AbortSignal,
  ): Promise<PresentationOutcome> {
    const key = `${updateId}:${cue.cue_id}`;
    switch (cue.type) {
      case "background_transition":
        await this.#transitionBackground(
          cue.background,
          cue.transition,
          cue.duration_ms,
          assets,
          signal,
        );
        break;
      case "sprite_tween":
        await this.#tweenSprite(
          cue.sprite_id,
          cue.to,
          cue.duration_ms,
          cue.easing,
          cue.crossfade_ms,
          assets,
          signal,
        );
        break;
      case "clear_scene":
        await this.#clearScene(cue.duration_ms, cue.easing, signal);
        break;
      case "camera_tween":
        await this.#tweenCamera(cue.to, cue.duration_ms, cue.easing, signal);
        break;
      case "screen_effect":
        await this.#screenEffect(cue.effect, cue.duration_ms, signal);
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
      case "delay":
        await animate(
          cue.duration_ms,
          "linear",
          () => undefined,
          signal,
          () => (this.#paused ? 0 : this.#playbackRate),
        );
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
        return this.#runTimeline(cue, assets, signal);
      default:
        cue satisfies never;
    }
    return "completed";
  }

  async #transitionBackground(
    asset: string | null,
    transition: "cut" | "cross_fade",
    durationMs: number,
    assets: AssetUrlMap,
    signal: AbortSignal,
  ): Promise<void> {
    if (asset === null) {
      this.#clearBackgrounds();
      return;
    }
    const next = await this.#makeBackground(asset, assets);
    if (signal.aborted) {
      next.destroy();
      return;
    }
    const previous = this.#background;
    next.alpha = transition === "cut" ? 1 : 0;
    this.#backgrounds.addChild(next);
    this.#background = next;
    if (transition !== "cut") {
      await this.#animate(
        durationMs,
        "ease_in_out",
        (progress) => {
          next.alpha = progress;
          if (previous !== null) {
            previous.alpha = 1 - progress;
          }
        },
        signal,
      );
    }
    if (!signal.aborted) {
      for (const child of this.#backgrounds.removeChildren()) {
        if (child !== next) {
          child.destroy();
        }
      }
      this.#backgrounds.addChild(next);
      next.alpha = 1;
    }
  }

  async #tweenSprite(
    id: string,
    target: SpriteSnapshot | null,
    durationMs: number,
    easing: Easing,
    crossfadeMs: number | null | undefined,
    assets: AssetUrlMap,
    signal: AbortSignal,
  ): Promise<void> {
    let view = this.#spriteViews.get(id);
    if (target === null) {
      if (view === undefined) {
        return;
      }
      const initialAlpha = view.alpha;
      await this.#animate(
        durationMs,
        easing,
        (progress) => {
          if (view !== undefined) {
            view.alpha = initialAlpha * (1 - progress);
          }
        },
        signal,
      );
      if (!signal.aborted && view !== undefined) {
        this.#spriteViews.delete(id);
        // A hidden instance releases its loop position along with the view.
        this.#spritePlayers.get(id)?.dispose();
        this.#spritePlayers.delete(id);
        view.destroy();
      }
      return;
    }

    const targetSource = this.#resolveImage(target.asset, assets);
    const targetLabel = assetLabel(targetSource);
    const replacing = view !== undefined && view.label !== targetLabel;
    const previousView = replacing ? view : undefined;
    const previousPlayer = replacing ? this.#spritePlayers.get(id) : undefined;
    const previousAlpha = previousView?.alpha ?? 0;
    if (view === undefined || replacing) {
      if (!replacing) {
        view?.destroy();
        this.#spritePlayers.get(id)?.dispose();
        this.#spritePlayers.delete(id);
      }
      view = await this.#makeSprite(id, target, assets, replacing);
      if (signal.aborted) {
        view.destroy();
        return;
      }
      view.label = targetLabel;
      view.x = target.x;
      view.y = target.y + 48;
      view.scale.set(
        target.scale * target.scale_x * 0.96,
        target.scale * target.scale_y * 0.96,
      );
      view.alpha = 0;
      this.#world.addChild(view);
      this.#spriteViews.set(id, view);
    }
    if (signal.aborted) return;
    const start =
      replacing && previousView !== undefined
        ? readSprite(previousView)
        : readSprite(view);
    const fadeDuration =
      crossfadeMs === undefined || crossfadeMs === null
        ? 0
        : Math.max(0, crossfadeMs);
    const animationDuration = Math.max(durationMs, fadeDuration);
    await this.#animate(
      animationDuration,
      easing,
      (progress) => {
        if (view === undefined) {
          return;
        }
        const transformProgress =
          durationMs <= 0
            ? 1
            : Math.min(1, (progress * animationDuration) / durationMs);
        view.x = mix(start.x, target.x, transformProgress);
        view.y = mix(start.y, target.y, transformProgress);
        view.anchor.set(target.anchor_x ?? 0.5, target.anchor_y ?? 1);
        view.scale.set(
          (target.flip_x ? -1 : 1) *
            mix(
              start.scale * start.scale_x,
              target.scale * target.scale_x,
              transformProgress,
            ),
          mix(
            start.scale * start.scale_y,
            target.scale * target.scale_y,
            transformProgress,
          ),
        );
        view.rotation =
          (mix(start.rotation_deg, target.rotation_deg, transformProgress) *
            Math.PI) /
          180;
        view.alpha =
          replacing && fadeDuration > 0
            ? mix(
                0,
                target.opacity,
                Math.min(1, (progress * animationDuration) / fadeDuration),
              )
            : mix(start.opacity, target.opacity, transformProgress);
        view.zIndex = transformProgress < 1 ? start.z : target.z;
        if (replacing && previousView !== undefined) {
          const fadeProgress =
            fadeDuration <= 0
              ? 1
              : Math.min(1, (progress * animationDuration) / fadeDuration);
          previousView.alpha = previousAlpha * (1 - fadeProgress);
        }
      },
      signal,
    );
    if (replacing && previousView !== undefined && !signal.aborted) {
      previousPlayer?.dispose();
      previousView.destroy();
    }
  }

  /** Fade every scene-owned Pixi view, then remove it. The authoritative
   * snapshot is reconciled immediately afterwards, so this method never has
   * to guess which new scene content should be created. */
  async #clearScene(
    durationMs: number,
    easing: Easing,
    signal: AbortSignal,
  ): Promise<void> {
    const backgrounds = [...this.#backgrounds.children];
    const sprites = [...this.#spriteViews.entries()];
    const backgroundAlpha = new Map(
      backgrounds.map((view) => [view, view.alpha]),
    );
    const spriteAlpha = new Map(sprites.map(([id, view]) => [id, view.alpha]));

    if (durationMs > 0 && (backgrounds.length > 0 || sprites.length > 0)) {
      await this.#animate(
        durationMs,
        easing,
        (progress) => {
          for (const view of backgrounds) {
            view.alpha = (backgroundAlpha.get(view) ?? 1) * (1 - progress);
          }
          for (const [id, view] of sprites) {
            view.alpha = (spriteAlpha.get(id) ?? 1) * (1 - progress);
          }
        },
        signal,
      );
    }
    if (signal.aborted) return;

    for (const view of backgrounds) {
      if (view.parent === this.#backgrounds)
        this.#backgrounds.removeChild(view);
      view.destroy();
    }
    if (
      this.#background !== null &&
      !this.#backgrounds.children.includes(this.#background)
    ) {
      this.#background = null;
    }
    for (const [id, view] of sprites) {
      if (this.#spriteViews.get(id) === view) {
        this.#spriteViews.delete(id);
        this.#spritePlayers.get(id)?.dispose();
        this.#spritePlayers.delete(id);
        if (view.parent === this.#world) this.#world.removeChild(view);
        view.destroy();
      }
    }
    for (const effect of this.#effects.removeChildren()) effect.destroy();
    this.#application.render();
  }

  async #tweenCamera(
    target: CameraSnapshot,
    durationMs: number,
    easing: Easing,
    signal: AbortSignal,
  ): Promise<void> {
    const start = { ...this.#camera };
    await this.#animate(
      durationMs,
      easing,
      (progress) => {
        this.#camera = {
          x: mix(start.x, target.x, progress),
          y: mix(start.y, target.y, progress),
          zoom: mix(start.zoom, target.zoom, progress),
          rotation_deg: mix(start.rotation_deg, target.rotation_deg, progress),
        };
        this.#applyCamera();
      },
      signal,
    );
  }

  async #screenEffect(
    effect: "shake" | "flash",
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (effect === "flash") {
      const flash = new Graphics()
        .rect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT)
        .fill(0xffffff);
      flash.alpha = 0.88;
      this.#effects.addChild(flash);
      await this.#animate(
        durationMs,
        "ease_out",
        (progress) => {
          flash.alpha = 0.88 * (1 - progress);
        },
        signal,
      );
      flash.destroy();
      return;
    }
    await this.#animate(
      durationMs,
      "linear",
      (progress) => {
        const strength = (1 - progress) * 16;
        this.#world.position.set(
          DESIGN_WIDTH / 2 + Math.sin(progress * Math.PI * 18) * strength,
          DESIGN_HEIGHT / 2 +
            Math.cos(progress * Math.PI * 22) * strength * 0.6,
        );
      },
      signal,
    );
    this.#applyCamera();
  }

  async #runTimeline(
    cue: Extract<PresentationCue, { type: "timeline" }>,
    assets: AssetUrlMap,
    signal: AbortSignal,
  ): Promise<PresentationOutcome> {
    const firedEvents = new Set<string>();
    const spriteTracks = cue.tracks.filter(
      (track): track is Extract<TimelineTrack, { type: "sprite" }> =>
        track.type === "sprite",
    );
    for (const track of spriteTracks) {
      let view = this.#spriteViews.get(track.sprite_id);
      if (track.asset === null && view === undefined) {
        throw new Error(`立绘 ${track.sprite_id} 没有可继承的素材`);
      }
      const label =
        track.asset === null
          ? ((view as Sprite).label ?? "")
          : assetLabel(this.#resolveImage(track.asset, assets));
      if (
        track.asset !== null &&
        (view === undefined || view.label !== label)
      ) {
        view?.destroy();
        this.#spritePlayers.get(track.sprite_id)?.dispose();
        this.#spritePlayers.delete(track.sprite_id);
        view = await this.#makeSprite(
          track.sprite_id,
          {
            asset: track.asset,
            x: 960,
            y: 1080,
            scale: 1,
            scale_x: 1,
            scale_y: 1,
            rotation_deg: 0,
            opacity: 1,
            z: 0,
          },
          assets,
        );
        if (signal.aborted) {
          view.destroy();
          return "failed";
        }
        view.label = label;
        this.#world.addChild(view);
        this.#spriteViews.set(track.sprite_id, view);
      }
      if (view === undefined) {
        throw new Error(`立绘 ${track.sprite_id} 无法建立时间轴对象`);
      }
    }

    const videoTrack = cue.tracks.find(
      (track): track is Extract<TimelineTrack, { type: "video" }> =>
        track.type === "video",
    );
    let video: HTMLVideoElement | null = null;
    let videoView: Sprite | null = null;
    let videoSource: VideoSource | null = null;
    let buffering = false;
    // A timeline may be cancelled while its media is still waiting for
    // metadata/seek.  Those awaits happen before the clock's `finally` block
    // below is installed, so keep one idempotent cleanup path for every early
    // return and setup failure as well.  In particular, clearing the active
    // video reference alone is not enough: the element must release its src
    // and the Pixi VideoSource must be destroyed or WebView keeps decoding it
    // after leaving a replay or loading a save.
    const cleanupVideo = (): void => {
      if (video !== null) video.pause();
      if (this.#activeVideo === video) this.#activeVideo = null;
      if (videoView !== null) {
        videoView.destroy({ texture: true, textureSource: true });
        videoView = null;
        videoSource = null;
      } else if (videoSource !== null) {
        videoSource.destroy();
        videoSource = null;
      }
      if (video !== null) {
        video.removeAttribute("src");
        video.load();
        video = null;
      }
    };
    const setBuffering = (value: boolean): void => {
      buffering = value;
      this.#timelineClock?.setBuffering(value);
    };
    if (videoTrack !== undefined) {
      try {
        video = document.createElement("video");
        this.#activeVideo = video;
        video.preload = "auto";
        video.crossOrigin = "anonymous";
        video.playsInline = true;
        video.autoplay = false;
        video.loop = false;
        video.controls = false;
        video.disablePictureInPicture = true;
        video.src = requireAssetUrl(assets, videoTrack.asset);
        video.muted = !videoTrack.audio_enabled;
        await waitForVideoFrameData(video, signal);
        if (signal.aborted) {
          cleanupVideo();
          return "failed";
        }
        await seekVideo(video, videoTrack.clip_start_ms / 1_000, signal);
        if (signal.aborted) {
          cleanupVideo();
          return "failed";
        }
        if (videoTrack.audio_enabled) this.#audio.attachVideo(video, 1);
        video.addEventListener("waiting", () => setBuffering(true));
        video.addEventListener("stalled", () => setBuffering(true));
        video.addEventListener("playing", () => setBuffering(false));
        video.addEventListener("canplay", () => setBuffering(false));
        videoSource = new VideoSource({
          resource: video,
          autoLoad: false,
          autoPlay: false,
          updateFPS: 0,
        });
        await videoSource.load();
        videoSource.autoUpdate = false;
        videoSource.update();
        videoView = new Sprite(new Texture({ source: videoSource }));
        videoView.anchor.set(0, 0);
        this.#world.addChild(videoView);
        await startVideoPlayback(video, signal);
        await waitForPresentedVideoFrame(video, signal);
        if (!signal.aborted) videoSource.update();
      } catch (error) {
        cleanupVideo();
        throw error;
      }
    }

    // Capture every starting value once, after all timeline assets have been
    // prepared and immediately before the first draw. Feeding the rendered
    // transform back into the evaluator on every frame compounds animation
    // and makes `inherit` tracks drift.
    const cameraBase = { ...this.#camera };
    const bgmBase = this.#audio.currentBgmVolume() ?? 1;
    const spriteBases = Object.fromEntries(
      [...this.#spriteViews.entries()].map(([id, view]) => [
        id,
        { asset: view.label, ...readSprite(view) },
      ]),
    );

    let previousElapsed = -1;
    const render = (elapsedMs: number): void => {
      // Keep the game's transform math identical to the editor's timeline
      // surface.  The evaluator is pure; this adapter only applies its frame
      // to Pixi/media objects and handles side effects such as audio volume.
      const evaluated = evaluateTimelineFrame(
        { duration_ms: cue.duration_ms, tracks: cue.tracks },
        {
          sprites: spriteBases,
          camera: cameraBase,
          bgm_volume: bgmBase,
        },
        elapsedMs,
      );
      for (const sprite of evaluated.sprites) {
        const view = this.#spriteViews.get(sprite.id);
        if (view === undefined) continue;
        view.x = sprite.x;
        view.y = sprite.y;
        view.scale.set(
          (sprite.flip_x ? -1 : 1) * sprite.scale * sprite.scale_x,
          sprite.scale * sprite.scale_y,
        );
        view.anchor.set(sprite.anchor_x ?? 0.5, sprite.anchor_y ?? 1);
        view.rotation = (sprite.rotation_deg * Math.PI) / 180;
        view.alpha = sprite.opacity;
        view.zIndex = sprite.z;
      }
      this.#camera = evaluated.camera;
      this.#applyCamera();
      this.#audio.setBgmTimelineVolume(evaluated.bgm_volume);
      const evaluatedVideo = evaluated.videos[0];
      if (
        video !== null &&
        videoView !== null &&
        evaluatedVideo !== undefined
      ) {
        const videoTrack = cue.tracks.find(
          (track): track is Extract<TimelineTrack, { type: "video" }> =>
            track.type === "video",
        );
        if (videoTrack !== undefined) {
          const naturalWidth = Math.max(1, video.videoWidth);
          const naturalHeight = Math.max(1, video.videoHeight);
          if (videoTrack.fit === "stretch") {
            videoView.position.set(evaluatedVideo.x, evaluatedVideo.y);
            videoView.width = evaluatedVideo.width;
            videoView.height = evaluatedVideo.height;
          } else {
            const factor =
              videoTrack.fit === "cover"
                ? Math.max(
                    evaluatedVideo.width / naturalWidth,
                    evaluatedVideo.height / naturalHeight,
                  )
                : Math.min(
                    evaluatedVideo.width / naturalWidth,
                    evaluatedVideo.height / naturalHeight,
                  );
            videoView.width = naturalWidth * factor;
            videoView.height = naturalHeight * factor;
            videoView.position.set(
              evaluatedVideo.x + (evaluatedVideo.width - videoView.width) / 2,
              evaluatedVideo.y + (evaluatedVideo.height - videoView.height) / 2,
            );
          }
          videoView.alpha = evaluatedVideo.opacity;
          videoView.zIndex = evaluatedVideo.z;
        }
      }
      if (!this.#skipSuppressTimelineEvents) {
        for (const event of cue.events) {
          if (
            event.at_ms <= elapsedMs &&
            event.at_ms > previousElapsed &&
            !firedEvents.has(event.id)
          ) {
            firedEvents.add(event.id);
            this.#fireTimelineEvent(cue.cue_id, event, assets, signal);
          }
        }
      }
      if (video !== null && videoTrack !== undefined) {
        const clipStart = videoTrack.clip_start_ms / 1_000;
        const clipEnd =
          (videoTrack.clip_end_ms ?? video.duration * 1_000) / 1_000;
        const clipDuration = Math.max(0.001, clipEnd - clipStart);
        const rawTime = clipStart + elapsedMs / 1_000;
        const desired = videoTrack.loop
          ? clipStart + ((rawTime - clipStart) % clipDuration)
          : Math.min(clipEnd, rawTime);
        const rate = Math.max(0.25, Math.min(8, this.#playbackRate));
        video.playbackRate = rate;
        if (videoTrack.audio_enabled) {
          this.#audio.setVideoVolume(
            video,
            this.#playbackRate >= 8 ? 0 : (evaluatedVideo?.volume ?? 1),
          );
        }
        if (!buffering && Math.abs(video.currentTime - desired) > 0.08) {
          video.currentTime = desired;
        }
        videoSource?.update();
      }
      previousElapsed = elapsedMs;
      this.#application.render();
    };
    const clock = new TimelineClock(
      cue.duration_ms,
      () => (this.#paused ? 0 : this.#playbackRate),
      render,
    );
    this.#timelineClock = clock;
    this.#timelineSkippable = cue.skippable;
    this.#skipSuppressTimelineEvents = false;
    clock.setPaused(this.#paused);
    clock.setBuffering(buffering);
    try {
      return await clock.run(signal);
    } finally {
      if (this.#timelineClock === clock) {
        this.#timelineClock = null;
        this.#timelineSkippable = false;
        this.#skipSuppressTimelineEvents = false;
      }
      cleanupVideo();
    }
  }

  #fireTimelineEvent(
    cueId: string,
    event: TimelineEvent,
    assets: AssetUrlMap,
    signal: AbortSignal,
  ): void {
    const key = `timeline:${cueId}:${event.id}`;
    if (!this.#oneShotLedger.consume(key)) return;
    if (event.type === "sfx") {
      if (!this.#suppressOneShots) {
        void this.#audio
          .playSfx(event.asset, event.volume, assets, signal)
          .catch((error: unknown) =>
            this.#diagnostic(`时间线 SFX 失败：${errorMessage(error)}`),
          );
      }
    } else {
      void this.#screenEffect(event.effect, event.duration_ms, signal).catch(
        (error: unknown) =>
          this.#diagnostic(`时间线屏幕效果失败：${errorMessage(error)}`),
      );
    }
  }

  async #reconcile(
    snapshot: RuntimeSnapshot,
    assets: AssetUrlMap,
    signal: AbortSignal,
  ): Promise<void> {
    this.#uiMotionHost.reconcileDialogueVisible(
      snapshot.world.dialogue_ui_visible,
    );
    await this.#setBackground(snapshot.world.background, assets, signal);
    if (signal.aborted) {
      return;
    }
    const wanted = new Set(Object.keys(snapshot.world.sprites));
    for (const [id, view] of this.#spriteViews) {
      if (!wanted.has(id)) {
        view.destroy();
        this.#spriteViews.delete(id);
        // An instance that no longer exists must not keep a frame loop alive.
        this.#spritePlayers.get(id)?.dispose();
        this.#spritePlayers.delete(id);
      }
    }
    for (const [id, state] of Object.entries(snapshot.world.sprites)) {
      let view = this.#spriteViews.get(id);
      const source = this.#resolveImage(state.asset, assets);
      const label = assetLabel(source);
      if (view === undefined || view.label !== label) {
        view?.destroy();
        // A different asset - including another animation - starts at the
        // first frame; merely moving or re-applying the same snapshot does not.
        this.#spritePlayers.get(id)?.dispose();
        this.#spritePlayers.delete(id);
        view = await this.#makeSprite(id, state, assets);
        if (signal.aborted) {
          view.destroy();
          return;
        }
        view.label = label;
        this.#world.addChild(view);
        this.#spriteViews.set(id, view);
      }
      applySprite(view, state);
    }
    this.#camera = { ...snapshot.world.camera };
    this.#applyCamera();
    this.#application.render();
    await this.#audio.reconcile(snapshot.audio, assets, signal);
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
      () => (this.#paused ? 0 : this.#playbackRate),
    );
  }

  async #setBackground(
    asset: string | null,
    assets: AssetUrlMap,
    signal: AbortSignal,
  ): Promise<void> {
    if (asset === null) {
      this.#clearBackgrounds();
      return;
    }
    const source = this.#resolveImage(asset, assets);
    const label = assetLabel(source);
    if (this.#background?.label === label) {
      // Re-applying the same snapshot must not restart the loop.
      this.#background.alpha = 1;
      return;
    }
    const background = await this.#makeBackground(asset, assets);
    if (signal.aborted) {
      background.destroy();
      return;
    }
    this.#clearBackgrounds();
    this.#background = background;
    this.#backgrounds.addChild(background);
  }

  async #makeBackground(asset: string, assets: AssetUrlMap): Promise<Sprite> {
    const source = this.#resolveImage(asset, assets);
    const textures = await this.#texturesFor(source);
    const texture = textures[0] ?? (await this.#loadTexture(source.url));
    const sprite = new Sprite(texture);
    sprite.label = assetLabel(source);
    // An animated asset keeps one layout size for the whole loop, so it uses
    // the measured animation size instead of the current frame's texture.
    const width = source.animation === undefined ? texture.width : source.width;
    const height =
      source.animation === undefined ? texture.height : source.height;
    const scale = Math.max(DESIGN_WIDTH / width, DESIGN_HEIGHT / height);
    sprite.scale.set(scale);
    sprite.position.set(
      (DESIGN_WIDTH - width * scale) / 2,
      (DESIGN_HEIGHT - height * scale) / 2,
    );
    this.#backgroundPlayer = this.#installFrameLoop(
      sprite,
      source,
      textures,
      this.#backgroundPlayer,
    );
    return sprite;
  }

  async #makeSprite(
    id: string,
    state: SpriteSnapshot,
    assets: AssetUrlMap,
    preservePreviousLoop = false,
  ): Promise<Sprite> {
    const source = this.#resolveImage(state.asset, assets);
    const textures = await this.#texturesFor(source);
    const texture = textures[0] ?? (await this.#loadTexture(source.url));
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5, 1);
    sprite.label = assetLabel(source);
    applySprite(sprite, state);
    const player = this.#installFrameLoop(
      sprite,
      source,
      textures,
      preservePreviousLoop ? null : (this.#spritePlayers.get(id) ?? null),
    );
    this.#spritePlayers.set(id, player);
    return sprite;
  }

  /**
   * Resolves a logical asset id to pixels through the shared resolver, so the
   * game and the editor agree on frame selection for the same input.
   */
  #resolveImage(asset: string, assets: AssetUrlMap): ImageAssetSource {
    const source = resolveImageAsset(asset, assets, this.#animations);
    if (source === undefined) {
      throw new Error(`素材尚未解析: ${asset}`);
    }
    return source;
  }

  /**
   * Prepares every frame of an animated asset before its first display.
   *
   * A frame that cannot be decoded is reported with its position and replaced
   * by the nearest usable frame, so one broken file can never block a story
   * gate.  Only an animation with no usable frame at all fails.
   */
  async #texturesFor(source: ImageAssetSource): Promise<Texture[]> {
    const animation = source.animation;
    if (animation === undefined) return [await this.#loadTexture(source.url)];
    const cached = this.#animationFrames.get(source.asset);
    if (cached !== undefined) return cached;
    const loading = (async (): Promise<Texture[]> => {
      const textures: (Texture | null)[] = [];
      const successful: number[] = [];
      for (const [index, frame] of animation.frames.entries()) {
        try {
          const texture = await this.#loadTexture(frame.url);
          textures.push(texture);
          successful.push(index);
        } catch (error) {
          const message = errorMessage(error);
          this.#diagnostic(
            `图片动画 ${animation.id} 第 ${index + 1} 帧（素材 ${frame.asset}）加载失败：${message}`,
          );
          textures.push(null);
        }
      }
      if (successful.length === 0) {
        throw new Error(`图片动画 ${animation.id} 没有可用帧`);
      }
      const firstSuccessful = successful[0];
      if (firstSuccessful === undefined) {
        throw new Error(`图片动画 ${animation.id} 没有可用帧`);
      }
      const usable = textures as Texture[];
      for (let index = 0; index < usable.length; index += 1) {
        if (usable[index] !== null) continue;
        let nearest = firstSuccessful;
        for (const candidate of successful) {
          if (Math.abs(candidate - index) < Math.abs(nearest - index)) {
            nearest = candidate;
          }
        }
        usable[index] = usable[nearest] as Texture;
      }
      return usable;
    })();
    this.#animationFrames.set(source.asset, loading);
    void loading.catch(() => this.#animationFrames.delete(source.asset));
    return loading;
  }

  /**
   * Binds one view to one loop position.
   *
   * A player is created per displayed instance, so two objects showing the
   * same animation share decoded textures but never a frame index.
   */
  #installFrameLoop(
    view: Sprite,
    source: ImageAssetSource,
    textures: Texture[],
    previous: FrameSequencePlayer | null,
  ): FrameSequencePlayer {
    previous?.dispose();
    const player = new FrameSequencePlayer(source);
    player.setPaused(this.#paused);
    player.subscribe(() => {
      const texture = textures[player.frameIndex()] ?? textures[0];
      if (texture !== undefined) view.texture = texture;
    });
    const first = player.frame();
    if (first !== undefined) {
      const texture = textures[player.frameIndex()] ?? textures[0];
      if (texture !== undefined) view.texture = texture;
    }
    return player;
  }

  #clearBackgrounds(): void {
    this.#backgroundPlayer?.dispose();
    this.#backgroundPlayer = null;
    for (const child of this.#backgrounds.removeChildren()) {
      child.destroy();
    }
    this.#background = null;
  }

  #applyCamera(): void {
    this.#world.position.set(DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2);
    this.#world.pivot.set(
      DESIGN_WIDTH / 2 + this.#camera.x,
      DESIGN_HEIGHT / 2 + this.#camera.y,
    );
    this.#world.scale.set(this.#camera.zoom);
    this.#world.rotation = (this.#camera.rotation_deg * Math.PI) / 180;
  }

  #animate(
    durationMs: number,
    easing: Easing,
    apply: (progress: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return animate(
      durationMs,
      easing,
      (progress) => {
        apply(progress);
        this.#application.render();
      },
      signal,
      () => (this.#paused ? 0 : this.#playbackRate),
    );
  }

  #loadTexture(url: string): Promise<Texture> {
    const existing = this.#texturePromises.get(url);
    if (existing !== undefined) return existing;
    if (this.#texturePromises.size >= this.#textureBudget) {
      return Promise.reject(
        new Error(`单次游戏会话纹理数量超过 ${this.#textureBudget} 个`),
      );
    }
    const loading = withTimeout(
      new Promise<Texture>((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.decoding = "async";
        image.onload = () => resolve(Texture.from(image));
        image.onerror = () => reject(new Error(`图像解码失败: ${url}`));
        image.src = url;
      }),
      8_000,
      `图像加载超时: ${url}`,
    );
    this.#texturePromises.set(url, loading);
    void loading.catch(() => this.#texturePromises.delete(url));
    return loading;
  }
}

/**
 * Unique frame urls across every resolved animation.
 *
 * Two animations may legally share a frame image, so the raw frame count would
 * over-report the budget; only distinct urls occupy a texture slot.
 */
function countAnimationFrames(animations: AnimationMap): number {
  const urls = new Set<string>();
  for (const animation of Object.values(animations)) {
    for (const frame of animation.frames) urls.add(frame.url);
  }
  return urls.size;
}

function applySprite(view: Sprite, state: SpriteSnapshot): void {
  view.anchor.set(state.anchor_x ?? 0.5, state.anchor_y ?? 1);
  view.position.set(state.x, state.y);
  const direction = state.flip_x ? -1 : 1;
  view.scale.set(
    direction * state.scale * state.scale_x,
    state.scale * state.scale_y,
  );
  view.rotation = (state.rotation_deg * Math.PI) / 180;
  view.alpha = state.opacity;
  view.zIndex = state.z;
}

function readSprite(view: Sprite): Omit<SpriteSnapshot, "asset"> {
  // `scale.x` carries the horizontal flip sign.  Dividing the vertical scale
  // by that signed value would turn a flipped sprite's Y scale negative and
  // make a later action/tween drift through the origin.  Read the two axes
  // independently so a round-trip preserves both pose and flip state.
  const horizontalScale = Math.abs(view.scale.x);
  const verticalScale = Math.abs(view.scale.y);
  return {
    x: view.x,
    y: view.y,
    scale: horizontalScale,
    scale_x: 1,
    scale_y: horizontalScale === 0 ? 1 : verticalScale / horizontalScale,
    rotation_deg: (view.rotation * 180) / Math.PI,
    flip_x: view.scale.x < 0,
    anchor_x: view.anchor.x,
    anchor_y: view.anchor.y,
    opacity: view.alpha,
    z: view.zIndex,
  };
}

function waitForVideoFrameData(
  video: HTMLVideoElement,
  signal: AbortSignal,
): Promise<void> {
  if (
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  )
    return Promise.resolve();
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        video.removeEventListener("loadeddata", loaded);
        video.removeEventListener("canplay", loaded);
        video.removeEventListener("error", failed);
        signal.removeEventListener("abort", aborted);
      };
      const loaded = (): void => {
        if (video.videoWidth <= 0 || video.videoHeight <= 0) return;
        cleanup();
        resolve();
      };
      const failed = (): void => {
        cleanup();
        reject(new Error(videoErrorMessage(video, "视频帧加载失败")));
      };
      const aborted = (): void => {
        cleanup();
        resolve();
      };
      video.addEventListener("loadeddata", loaded);
      video.addEventListener("canplay", loaded);
      video.addEventListener("error", failed, { once: true });
      signal.addEventListener("abort", aborted, { once: true });
      video.load();
    }),
    15_000,
    "视频首帧加载超时",
  );
}

function seekVideo(
  video: HTMLVideoElement,
  targetSeconds: number,
  signal: AbortSignal,
): Promise<void> {
  const target = Math.max(0, targetSeconds);
  if (Math.abs(video.currentTime - target) < 0.001) return Promise.resolve();
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        video.removeEventListener("seeked", seeked);
        video.removeEventListener("error", failed);
        signal.removeEventListener("abort", aborted);
      };
      const seeked = (): void => {
        cleanup();
        resolve();
      };
      const failed = (): void => {
        cleanup();
        reject(new Error(videoErrorMessage(video, "视频定位失败")));
      };
      const aborted = (): void => {
        cleanup();
        resolve();
      };
      video.addEventListener("seeked", seeked, { once: true });
      video.addEventListener("error", failed, { once: true });
      signal.addEventListener("abort", aborted, { once: true });
      video.currentTime = target;
    }),
    8_000,
    "视频定位超时",
  );
}

async function startVideoPlayback(
  video: HTMLVideoElement,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  try {
    await video.play();
  } catch (error) {
    throw new Error(`视频无法开始播放：${errorMessage(error)}`);
  }
}

function waitForPresentedVideoFrame(
  video: HTMLVideoElement,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  if (typeof video.requestVideoFrameCallback !== "function") {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return withTimeout(
    new Promise<void>((resolve) => {
      let handle = 0;
      const cleanup = (): void => {
        video.cancelVideoFrameCallback(handle);
        signal.removeEventListener("abort", aborted);
      };
      const presented = (): void => {
        cleanup();
        resolve();
      };
      const aborted = (): void => {
        cleanup();
        resolve();
      };
      handle = video.requestVideoFrameCallback(presented);
      signal.addEventListener("abort", aborted, { once: true });
    }),
    5_000,
    "视频首帧呈现超时",
  );
}

function videoErrorMessage(video: HTMLVideoElement, prefix: string): string {
  const code = video.error?.code;
  const suffix =
    code === undefined ? "" : `（MediaError ${code}: ${video.error?.message}）`;
  return `${prefix}${suffix}`;
}

function requireAssetUrl(assets: AssetUrlMap, id: string): string {
  const url = assets[id];
  if (url === undefined) {
    throw new Error(`素材尚未解析: ${id}`);
  }
  return url;
}

/**
 * Identity of the pixels a view currently shows.
 *
 * Static assets keep the historical url identity.  Animated assets use their
 * logical id, so switching between the animation and one of its frame images
 * (which can share a url) is still recognised as a real change.
 */
function assetLabel(source: ImageAssetSource): string {
  return source.animation === undefined ? source.url : `anim:${source.asset}`;
}

function cueSpriteResourceIds(cue: PresentationCue): string[] {
  const ids = new Set<string>();
  if (cue.type === "sprite_tween") {
    ids.add(`sprite:${cue.sprite_id}`);
  } else if (cue.type === "timeline") {
    for (const track of cue.tracks) {
      if (track.type === "sprite") ids.add(`sprite:${track.sprite_id}`);
    }
  }
  return [...ids];
}

function animate(
  durationMs: number,
  easing: Easing,
  apply: (progress: number) => void,
  signal: AbortSignal,
  getRate: () => number = () => 1,
): Promise<void> {
  if (durationMs <= 0 || signal.aborted) {
    if (!signal.aborted) {
      apply(1);
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let previous = performance.now();
    let virtualElapsed = 0;
    let frame = 0;
    const abort = (): void => {
      cancelAnimationFrame(frame);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
    const tick = (now: number): void => {
      if (signal.aborted) {
        return;
      }
      const rate = getRate();
      if (rate > 0) {
        virtualElapsed = advanceVirtualElapsed(
          virtualElapsed,
          now - previous,
          rate,
          durationMs,
        );
      }
      previous = now;
      const raw = Math.min(1, virtualElapsed / durationMs);
      apply(ease(raw, easing));
      if (raw >= 1) {
        signal.removeEventListener("abort", abort);
        resolve();
      } else {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
  });
}

function ease(value: number, easing: Easing): number {
  switch (easing) {
    case "linear":
      return value;
    case "ease_in":
      return value * value;
    case "ease_out":
      return 1 - (1 - value) * (1 - value);
    case "ease_in_out":
      return value < 0.5 ? 2 * value * value : 1 - (-2 * value + 2) ** 2 / 2;
  }
}

function mix(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
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
