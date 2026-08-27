import "pixi.js/unsafe-eval";

import {
  Application,
  Container,
  Graphics,
  Sprite,
  Texture,
  VideoSource,
} from "pixi.js";

import { AudioManager } from "./audio";
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
} from "./types";
import { evaluateChannel, TimelineClock } from "./timeline";
import { advanceVirtualElapsed } from "./virtualClock";

const WIDTH = 1920;
const HEIGHT = 1080;
const oneShotLedger = new Set<string>();
const texturePromises = new Map<string, Promise<Texture>>();

export class PresentationController {
  readonly #application = new Application();
  readonly #world = new Container();
  readonly #backgrounds = new Container();
  readonly #effects = new Container();
  readonly #spriteViews = new Map<string, Sprite>();
  readonly #audio: AudioManager;
  readonly #canvas: HTMLCanvasElement;
  readonly #diagnostic: (message: string) => void;
  #background: Sprite | null = null;
  #camera: CameraSnapshot = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
  #generation = 0;
  #abort = new AbortController();
  #currentUpdateId: number | null = null;
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
  ) {
    this.#canvas = canvas;
    this.#audio = new AudioManager(settings);
    this.#diagnostic = diagnostic;
  }

  async init(): Promise<void> {
    await this.#application.init({
      canvas: this.#canvas,
      width: WIDTH,
      height: HEIGHT,
      resolution: 1,
      autoDensity: false,
      antialias: true,
      backgroundColor: 0x05070c,
      preference: "webgl",
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
    this.#world.sortableChildren = true;
    this.#backgrounds.zIndex = -1_000_000;
    this.#world.addChild(this.#backgrounds);
    this.#application.stage.addChild(this.#world, this.#effects);
    this.#applyCamera();
    this.#application.render();
  }

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
    if (paused) this.#activeVideo?.pause();
    else void this.#activeVideo?.play().catch(() => undefined);
    void this.#audio.setPaused(paused);
  }

  skipCurrentPresentation(): boolean {
    if (!this.#timelineSkippable || this.#timelineClock === null) return false;
    this.#skipSuppressTimelineEvents = true;
    return this.#timelineClock.skip();
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
      const results = await Promise.allSettled(
        update.cues.map((cue) =>
          this.#executeCue(update.update_id, cue, assets, signal),
        ),
      );
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
      const thumbnail = document.createElement("canvas");
      thumbnail.width = 320;
      thumbnail.height = 180;
      const context = thumbnail.getContext("2d");
      if (context === null) {
        return null;
      }
      context.drawImage(this.#canvas, 0, 0, 320, 180);
      return thumbnail.toDataURL("image/png", 0.86);
    } catch (error) {
      console.error("Could not capture save thumbnail", error);
      return null;
    }
  }

  destroy(): void {
    this.#abort.abort();
    this.#audio.destroy();
    this.#application.destroy({ removeView: false }, { children: true });
  }

  async #executeCue(
    updateId: number,
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
          assets,
          signal,
        );
        break;
      case "camera_tween":
        await this.#tweenCamera(cue.to, cue.duration_ms, cue.easing, signal);
        break;
      case "screen_effect":
        await this.#screenEffect(cue.effect, cue.duration_ms, signal);
        break;
      case "play_sfx":
        if (!oneShotLedger.has(key)) {
          oneShotLedger.add(key);
          trimLedger();
          if (!this.#suppressOneShots) {
            await this.#audio.playSfx(cue.asset, cue.volume, assets);
          }
        }
        break;
      case "bgm_transition":
        if (!oneShotLedger.has(key)) {
          oneShotLedger.add(key);
          trimLedger();
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
      case "dialogue_ui_transition":
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
        view.destroy();
      }
      return;
    }

    const targetUrl = requireAssetUrl(assets, target.asset);
    if (view === undefined || view.label !== targetUrl) {
      view?.destroy();
      view = await this.#makeSprite(target, assets);
      view.label = targetUrl;
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
    if (signal.aborted) {
      return;
    }
    const start = readSprite(view);
    await this.#animate(
      durationMs,
      easing,
      (progress) => {
        if (view === undefined) {
          return;
        }
        view.x = mix(start.x, target.x, progress);
        view.y = mix(start.y, target.y, progress);
        view.scale.set(
          mix(
            start.scale * start.scale_x,
            target.scale * target.scale_x,
            progress,
          ),
          mix(
            start.scale * start.scale_y,
            target.scale * target.scale_y,
            progress,
          ),
        );
        view.rotation =
          (mix(start.rotation_deg, target.rotation_deg, progress) * Math.PI) /
          180;
        view.alpha = mix(start.opacity, target.opacity, progress);
        view.zIndex = progress < 1 ? start.z : target.z;
      },
      signal,
    );
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
      const flash = new Graphics().rect(0, 0, WIDTH, HEIGHT).fill(0xffffff);
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
          WIDTH / 2 + Math.sin(progress * Math.PI * 18) * strength,
          HEIGHT / 2 + Math.cos(progress * Math.PI * 22) * strength * 0.6,
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
    const spriteBases = new Map<string, Omit<SpriteSnapshot, "asset">>();
    const spriteTracks = cue.tracks.filter(
      (track): track is Extract<TimelineTrack, { type: "sprite" }> =>
        track.type === "sprite",
    );
    for (const track of spriteTracks) {
      const url = requireAssetUrl(assets, track.asset);
      let view = this.#spriteViews.get(track.sprite_id);
      if (view === undefined || view.label !== url) {
        view?.destroy();
        view = await this.#makeSprite(
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
        view.label = url;
        this.#world.addChild(view);
        this.#spriteViews.set(track.sprite_id, view);
      }
      spriteBases.set(track.sprite_id, readSprite(view));
    }

    const videoTrack = cue.tracks.find(
      (track): track is Extract<TimelineTrack, { type: "video" }> =>
        track.type === "video",
    );
    let video: HTMLVideoElement | null = null;
    let videoView: Sprite | null = null;
    let videoSource: VideoSource | null = null;
    let buffering = false;
    const setBuffering = (value: boolean): void => {
      buffering = value;
      this.#timelineClock?.setBuffering(value);
    };
    if (videoTrack !== undefined) {
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
      if (signal.aborted) return "failed";
      await seekVideo(video, videoTrack.clip_start_ms / 1_000, signal);
      if (signal.aborted) return "failed";
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
      videoSource.update();
    }

    let previousElapsed = -1;
    const render = (elapsedMs: number): void => {
      for (const track of cue.tracks) {
        this.#applyTimelineTrack(
          track,
          elapsedMs,
          video,
          videoView,
          spriteBases,
        );
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
          const volume = evaluateChannel(
            videoTrack.channels,
            "volume",
            elapsedMs,
            1,
          );
          this.#audio.setVideoVolume(
            video,
            this.#playbackRate >= 8 ? 0 : volume,
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
      this.#timelineClock = null;
      this.#timelineSkippable = false;
      this.#skipSuppressTimelineEvents = false;
      if (video !== null) {
        video.pause();
      }
      this.#activeVideo = null;
      if (videoView !== null) {
        videoView.destroy({ texture: true, textureSource: true });
      } else {
        videoSource?.destroy();
        if (video !== null) {
          video.removeAttribute("src");
          video.load();
        }
      }
    }
  }

  #applyTimelineTrack(
    track: TimelineTrack,
    elapsedMs: number,
    video: HTMLVideoElement | null,
    videoView: Sprite | null,
    spriteBases: ReadonlyMap<string, Omit<SpriteSnapshot, "asset">>,
  ): void {
    switch (track.type) {
      case "sprite": {
        const view = this.#spriteViews.get(track.sprite_id);
        if (view === undefined) return;
        const base = spriteBases.get(track.sprite_id) ?? readSprite(view);
        const scale = evaluateChannel(
          track.channels,
          "scale",
          elapsedMs,
          base.scale,
        );
        view.x = evaluateChannel(track.channels, "x", elapsedMs, base.x);
        view.y = evaluateChannel(track.channels, "y", elapsedMs, base.y);
        view.scale.set(
          scale *
            evaluateChannel(track.channels, "scale_x", elapsedMs, base.scale_x),
          scale *
            evaluateChannel(track.channels, "scale_y", elapsedMs, base.scale_y),
        );
        view.rotation =
          (evaluateChannel(
            track.channels,
            "rotation_deg",
            elapsedMs,
            base.rotation_deg,
          ) *
            Math.PI) /
          180;
        view.alpha = evaluateChannel(
          track.channels,
          "opacity",
          elapsedMs,
          base.opacity,
        );
        view.zIndex = Math.round(
          evaluateChannel(track.channels, "z", elapsedMs, base.z),
        );
        break;
      }
      case "camera":
        this.#camera = {
          x: evaluateChannel(track.channels, "x", elapsedMs, this.#camera.x),
          y: evaluateChannel(track.channels, "y", elapsedMs, this.#camera.y),
          zoom: evaluateChannel(
            track.channels,
            "zoom",
            elapsedMs,
            this.#camera.zoom,
          ),
          rotation_deg: evaluateChannel(
            track.channels,
            "rotation_deg",
            elapsedMs,
            this.#camera.rotation_deg,
          ),
        };
        this.#applyCamera();
        break;
      case "video": {
        if (video === null || videoView === null) return;
        const x = evaluateChannel(track.channels, "x", elapsedMs, 0);
        const y = evaluateChannel(track.channels, "y", elapsedMs, 0);
        const width = evaluateChannel(
          track.channels,
          "width",
          elapsedMs,
          WIDTH,
        );
        const height = evaluateChannel(
          track.channels,
          "height",
          elapsedMs,
          HEIGHT,
        );
        const naturalWidth = Math.max(1, video.videoWidth);
        const naturalHeight = Math.max(1, video.videoHeight);
        if (track.fit === "stretch") {
          videoView.position.set(x, y);
          videoView.width = width;
          videoView.height = height;
        } else {
          const factor =
            track.fit === "cover"
              ? Math.max(width / naturalWidth, height / naturalHeight)
              : Math.min(width / naturalWidth, height / naturalHeight);
          videoView.width = naturalWidth * factor;
          videoView.height = naturalHeight * factor;
          videoView.position.set(
            x + (width - videoView.width) / 2,
            y + (height - videoView.height) / 2,
          );
        }
        videoView.alpha = evaluateChannel(
          track.channels,
          "opacity",
          elapsedMs,
          1,
        );
        videoView.zIndex = Math.round(
          evaluateChannel(track.channels, "z", elapsedMs, 0),
        );
        break;
      }
      case "bgm":
        this.#audio.setBgmTimelineVolume(
          evaluateChannel(
            track.channels,
            "volume",
            elapsedMs,
            this.#audio.currentBgmVolume() ?? 1,
          ),
        );
        break;
    }
  }

  #fireTimelineEvent(
    cueId: number,
    event: TimelineEvent,
    assets: AssetUrlMap,
    signal: AbortSignal,
  ): void {
    const key = `timeline:${cueId}:${event.id}`;
    if (oneShotLedger.has(key)) return;
    oneShotLedger.add(key);
    trimLedger();
    if (event.type === "sfx") {
      if (!this.#suppressOneShots) {
        void this.#audio
          .playSfx(event.asset, event.volume, assets)
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
    await this.#setBackground(snapshot.world.background, assets, signal);
    if (signal.aborted) {
      return;
    }
    const wanted = new Set(Object.keys(snapshot.world.sprites));
    for (const [id, view] of this.#spriteViews) {
      if (!wanted.has(id)) {
        view.destroy();
        this.#spriteViews.delete(id);
      }
    }
    for (const [id, state] of Object.entries(snapshot.world.sprites)) {
      let view = this.#spriteViews.get(id);
      const url = requireAssetUrl(assets, state.asset);
      if (view === undefined || view.label !== url) {
        view?.destroy();
        view = await this.#makeSprite(state, assets);
        if (signal.aborted) {
          view.destroy();
          return;
        }
        view.label = url;
        this.#world.addChild(view);
        this.#spriteViews.set(id, view);
      }
      applySprite(view, state);
    }
    this.#camera = { ...snapshot.world.camera };
    this.#applyCamera();
    this.#application.render();
    await this.#audio.reconcile(snapshot.audio, assets);
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
    const url = requireAssetUrl(assets, asset);
    if (this.#background?.label === url) {
      this.#background.alpha = 1;
      return;
    }
    const background = await this.#makeBackground(asset, assets);
    if (signal.aborted) {
      background.destroy();
      return;
    }
    background.label = url;
    this.#clearBackgrounds();
    this.#background = background;
    this.#backgrounds.addChild(background);
  }

  async #makeBackground(asset: string, assets: AssetUrlMap): Promise<Sprite> {
    const url = requireAssetUrl(assets, asset);
    const texture = await loadTexture(url);
    const sprite = new Sprite(texture);
    sprite.label = url;
    const scale = Math.max(WIDTH / texture.width, HEIGHT / texture.height);
    sprite.scale.set(scale);
    sprite.position.set(
      (WIDTH - texture.width * scale) / 2,
      (HEIGHT - texture.height * scale) / 2,
    );
    return sprite;
  }

  async #makeSprite(
    state: SpriteSnapshot,
    assets: AssetUrlMap,
  ): Promise<Sprite> {
    const url = requireAssetUrl(assets, state.asset);
    const texture = await loadTexture(url);
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5, 1);
    sprite.label = url;
    applySprite(sprite, state);
    return sprite;
  }

  #clearBackgrounds(): void {
    for (const child of this.#backgrounds.removeChildren()) {
      child.destroy();
    }
    this.#background = null;
  }

  #applyCamera(): void {
    this.#world.position.set(WIDTH / 2, HEIGHT / 2);
    this.#world.pivot.set(
      WIDTH / 2 + this.#camera.x,
      HEIGHT / 2 + this.#camera.y,
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
}

function applySprite(view: Sprite, state: SpriteSnapshot): void {
  view.position.set(state.x, state.y);
  view.scale.set(state.scale * state.scale_x, state.scale * state.scale_y);
  view.rotation = (state.rotation_deg * Math.PI) / 180;
  view.alpha = state.opacity;
  view.zIndex = state.z;
}

function readSprite(view: Sprite): Omit<SpriteSnapshot, "asset"> {
  return {
    x: view.x,
    y: view.y,
    scale: view.scale.x,
    scale_x: 1,
    scale_y: view.scale.x === 0 ? 1 : view.scale.y / view.scale.x,
    rotation_deg: (view.rotation * 180) / Math.PI,
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

function trimLedger(): void {
  if (oneShotLedger.size <= 10_000) {
    return;
  }
  for (const key of oneShotLedger) {
    oneShotLedger.delete(key);
    if (oneShotLedger.size <= 5_000) {
      break;
    }
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function loadTexture(url: string): Promise<Texture> {
  const existing = texturePromises.get(url);
  if (existing !== undefined) {
    return existing;
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
  texturePromises.set(url, loading);
  loading.catch(() => texturePromises.delete(url));
  return loading;
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
