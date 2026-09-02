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
import { evaluateChannel } from "./timeline";
import type {
  AssetUrlMap,
  RuntimeSnapshot,
  RuntimeUpdate,
  Settings,
  SpriteSnapshot,
  TimelineTrack,
} from "./types";

export const DESIGN_WIDTH = 1920;
export const DESIGN_HEIGHT = 1080;

export interface PreviewObjectFrame {
  id: string;
  kind: "sprite" | "video";
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  scale_x: number;
  scale_y: number;
  rotation_deg: number;
  opacity: number;
  z: number;
  asset: string;
}

export interface TimelinePreviewFrame {
  elapsed_ms: number;
  camera: { x: number; y: number; zoom: number; rotation_deg: number };
  objects: PreviewObjectFrame[];
}

export type PreviewObjectPatch = Partial<
  Pick<
    PreviewObjectFrame,
    | "x"
    | "y"
    | "width"
    | "height"
    | "scale"
    | "scale_x"
    | "scale_y"
    | "rotation_deg"
    | "opacity"
    | "z"
  >
>;

const DEFAULT_SETTINGS: Settings = {
  master_volume: 1,
  bgm_volume: 1,
  sfx_volume: 1,
  video_volume: 1,
  text_speed_cps: 30,
  text_reveal_animation: "typewriter",
  skip_mode: "disabled",
};

const MUTED_PREVIEW_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  master_volume: 0,
};

/**
 * Pixi-backed timeline surface shared by the game renderer and the editor.
 * The editor uses the seek/interaction methods; the game can use the same
 * frame application semantics when it receives a Timeline cue.
 */
export class TimelinePreviewSurface {
  readonly #application = new Application();
  readonly #world = new Container();
  readonly #backgrounds = new Container();
  readonly #effects = new Container();
  readonly #spriteViews = new Map<string, Sprite>();
  readonly #audio: AudioManager;
  readonly #canvas: HTMLCanvasElement;
  readonly #diagnostic: (message: string) => void;
  #background: Sprite | null = null;
  #camera = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
  #cameraStart = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
  #bgmStartVolume = 1;
  #assets: AssetUrlMap = {};
  #cue: Extract<RuntimeUpdate["cues"][number], { type: "timeline" }> | null =
    null;
  #start: RuntimeSnapshot | null = null;
  #video: HTMLVideoElement | null = null;
  #videoSource: VideoSource | null = null;
  #videoView: Sprite | null = null;
  #videoAudioAttached = false;
  #spriteBases = new Map<string, Omit<SpriteSnapshot, "asset">>();
  #lastElapsed = -1;
  #muted = true;
  #playing = false;
  #frame = 0;
  #lastFrameAt = 0;
  #onFrame: ((frame: TimelinePreviewFrame) => void) | null = null;
  #onPlayingChange: ((playing: boolean) => void) | null = null;
  #objectOverrides = new Map<string, PreviewObjectPatch>();
  #cameraOverride: Partial<TimelinePreviewFrame["camera"]> = {};
  #flashView: Graphics | null = null;
  #flashStartedAt = 0;
  #flashDuration = 0;
  #shakeStartedAt = 0;
  #shakeDuration = 0;
  #destroyed = false;

  constructor(
    canvas: HTMLCanvasElement,
    diagnostic: (message: string) => void,
    onFrame?: (frame: TimelinePreviewFrame) => void,
  ) {
    this.#canvas = canvas;
    this.#diagnostic = diagnostic;
    this.#onFrame = onFrame ?? null;
    // Timeline previews are silent until the user explicitly unmutes them.
    // Applying this before the first snapshot reconcile prevents an entry BGM
    // from becoming audible while the context is still loading (or failing).
    this.#audio = new AudioManager(MUTED_PREVIEW_SETTINGS);
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
  }

  async load(
    start: RuntimeSnapshot,
    update: RuntimeUpdate,
    assets: AssetUrlMap,
  ): Promise<void> {
    const cue = update.cues.find(
      (
        candidate,
      ): candidate is Extract<typeof candidate, { type: "timeline" }> =>
        candidate.type === "timeline",
    );
    if (cue === undefined) throw new Error("目标 update 不包含 timeline Cue");
    this.stop();
    // A new context can contain timeline-only objects that did not exist in
    // the previous entry snapshot. Rebuild the display list from scratch so
    // stale tracks never leak into another target node.
    this.#clearSprites();
    this.#assets = assets;
    this.#start = start;
    this.#cue = cue;
    this.#cameraStart = { ...start.world.camera };
    this.#camera = { ...start.world.camera };
    this.#bgmStartVolume = start.audio.bgm?.volume ?? 1;
    this.#lastElapsed = -1;
    this.#objectOverrides.clear();
    this.#cameraOverride = {};
    try {
      await this.#reconcile(start);
      this.#spriteBases.clear();
      for (const track of cue.tracks) {
        if (track.type === "sprite") {
          const effectiveAsset =
            track.asset ?? start.world.sprites[track.sprite_id]?.asset;
          if (effectiveAsset === undefined)
            throw new Error(`立绘 ${track.sprite_id} 没有可继承的素材`);
          let view = this.#spriteViews.get(track.sprite_id);
          if (view === undefined || view.label !== assets[effectiveAsset]) {
            view?.destroy();
            view = await this.#makeSprite(effectiveAsset, {
              asset: effectiveAsset,
              x: 960,
              y: 1080,
              scale: 1,
              scale_x: 1,
              scale_y: 1,
              rotation_deg: 0,
              opacity: 1,
              z: 0,
            });
            view.label = assets[effectiveAsset] ?? effectiveAsset;
            this.#world.addChild(view);
            this.#spriteViews.set(track.sprite_id, view);
          }
          const startState = start.world.sprites[track.sprite_id];
          this.#spriteBases.set(
            track.sprite_id,
            startState === undefined
              ? defaultSpriteFrame()
              : omitSpriteAsset(startState),
          );
        }
      }
      const videoTrack = cue.tracks.find(
        (track): track is Extract<TimelineTrack, { type: "video" }> =>
          track.type === "video",
      );
      if (videoTrack !== undefined) await this.#prepareVideo(videoTrack);
      await this.seek(0, false);
      if (this.#video !== null) {
        await waitForPresentedVideoFrame(this.#video);
        this.#videoSource?.update();
        this.#application.render();
      }
    } catch (error) {
      this.stop();
      // A partially restored context must not leave its BGM running after the
      // preview reports an image/video/WebGL error.
      await this.#audio
        .reconcile({ bgm: null }, this.#assets)
        .catch(() => undefined);
      throw error;
    }
  }

  setOnFrame(onFrame: ((frame: TimelinePreviewFrame) => void) | null): void {
    this.#onFrame = onFrame;
  }

  setOnPlayingChange(
    onPlayingChange: ((playing: boolean) => void) | null,
  ): void {
    this.#onPlayingChange = onPlayingChange;
  }

  setObjectOverride(id: string, patch: PreviewObjectPatch): void {
    this.#objectOverrides.set(id, {
      ...(this.#objectOverrides.get(id) ?? {}),
      ...patch,
    });
    this.#applyOverrides();
    this.#application.render();
  }

  setCameraOverride(patch: Partial<TimelinePreviewFrame["camera"]>): void {
    this.#cameraOverride = { ...this.#cameraOverride, ...patch };
    this.#camera = { ...this.#camera, ...this.#cameraOverride };
    this.#applyCamera();
    this.#application.render();
  }

  clearOverrides(): void {
    this.#objectOverrides.clear();
    this.#cameraOverride = {};
    this.#applyOverrides();
    this.#application.render();
  }

  seek(elapsedMs: number, fireEvents = false): Promise<void> {
    if (this.#cue === null) return Promise.resolve();
    const elapsed = Math.max(0, Math.min(this.#cue.duration_ms, elapsedMs));
    // Any backwards seek starts a fresh event ledger. Forward scrubbing does
    // not emit events, but playback after a rewind must be able to replay the
    // events that occur after the new playhead position.
    if (elapsed < this.#lastElapsed) {
      this.#lastElapsed = -1;
      this.#clearTransientEffects();
    }
    for (const track of this.#cue.tracks) this.#applyTrack(track, elapsed);
    this.#syncVideo(elapsed);
    if (fireEvents) {
      for (const event of this.#cue.events) {
        if (event.at_ms > this.#lastElapsed && event.at_ms <= elapsed) {
          if (event.type === "sfx" && !this.#muted)
            void this.#audio
              .playSfx(event.asset, event.volume, this.#assets)
              .catch((error: unknown) =>
                this.#diagnostic(`预览 SFX 失败：${errorMessage(error)}`),
              );
          if (event.type === "screen_effect")
            this.#showEffect(event.effect, event.duration_ms);
        }
      }
    }
    // Keep the zero boundary armed so an event authored at 0 ms fires on the
    // first normal playback tick after loading or rewinding.
    this.#lastElapsed = elapsed === 0 ? -1 : elapsed;
    this.#updateTransientEffects(performance.now());
    if (elapsed >= this.#cue.duration_ms) this.#clearTransientEffects();
    this.#application.render();
    this.#emitFrame(elapsed);
    return Promise.resolve();
  }

  async play(): Promise<void> {
    if (this.#cue === null || this.#playing) return;
    this.#playing = true;
    this.#onPlayingChange?.(true);
    await this.#audio.unlock().catch(() => undefined);
    const videoTrack = this.#cue.tracks.find(
      (track): track is Extract<TimelineTrack, { type: "video" }> =>
        track.type === "video",
    );
    if (this.#video !== null && videoTrack?.audio_enabled && !this.#muted) {
      this.#audio.attachVideo(this.#video, 1);
      this.#videoAudioAttached = true;
      this.#video.muted = false;
    }
    // The Pixi VideoSource is driven by seek() so the playhead remains the
    // single clock. The media element is still played here to prime decoding;
    // seek() keeps it aligned and pauses it when the editor pauses.
    if (this.#video !== null) await this.#video.play().catch(() => undefined);
    this.#lastFrameAt = performance.now();
    const tick = (now: number): void => {
      if (!this.#playing || this.#cue === null) return;
      const delta = now - this.#lastFrameAt;
      this.#lastFrameAt = now;
      void this.seek(this.#lastElapsed + delta, true).finally(() => {
        if (this.#cue !== null && this.#lastElapsed >= this.#cue.duration_ms) {
          this.#playing = false;
          this.#onPlayingChange?.(false);
          return;
        }
        this.#frame = requestAnimationFrame(tick);
      });
    };
    this.#frame = requestAnimationFrame(tick);
  }

  pause(): void {
    const wasPlaying = this.#playing;
    this.#playing = false;
    if (wasPlaying) this.#onPlayingChange?.(false);
    if (this.#frame !== 0) cancelAnimationFrame(this.#frame);
    this.#video?.pause();
  }

  stop(): void {
    this.pause();
    this.#lastElapsed = -1;
    this.#clearTransientEffects();
    this.#destroyVideo();
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    this.#audio.applySettings({
      ...DEFAULT_SETTINGS,
      master_volume: muted ? 0 : 1,
    });
    if (this.#video !== null) {
      const track = this.#cue?.tracks.find(
        (candidate): candidate is Extract<TimelineTrack, { type: "video" }> =>
          candidate.type === "video",
      );
      if (track?.audio_enabled && !muted) {
        this.#audio.attachVideo(this.#video, 1);
        this.#videoAudioAttached = true;
        this.#video.muted = false;
        this.#audio.setVideoVolume(this.#video, 1);
      } else if (this.#videoAudioAttached) {
        this.#video.muted = false;
        this.#audio.setVideoVolume(this.#video, 0);
      } else {
        this.#video.muted = true;
      }
    }
  }

  isPlaying(): boolean {
    return this.#playing;
  }

  frameAt(elapsedMs: number): TimelinePreviewFrame {
    const elapsed = Math.max(
      0,
      Math.min(this.#cue?.duration_ms ?? Math.max(0, elapsedMs), elapsedMs),
    );
    const objects: PreviewObjectFrame[] = [];
    const represented = new Set<string>();
    const startSprites = this.#start?.world.sprites ?? {};
    const camera = { ...this.#cameraStart };
    if (this.#cue !== null) {
      for (const track of this.#cue.tracks) {
        if (track.type === "sprite") {
          represented.add(track.sprite_id);
          const base =
            this.#spriteBases.get(track.sprite_id) ?? defaultSpriteFrame();
          const state = {
            scale: evaluateChannel(
              track.channels,
              "scale",
              elapsed,
              base.scale,
            ),
            scale_x: evaluateChannel(
              track.channels,
              "scale_x",
              elapsed,
              base.scale_x,
            ),
            scale_y: evaluateChannel(
              track.channels,
              "scale_y",
              elapsed,
              base.scale_y,
            ),
          };
          const dimensions = this.#spriteDimensions(track.sprite_id, state);
          objects.push({
            id: track.sprite_id,
            kind: "sprite",
            x: evaluateChannel(track.channels, "x", elapsed, base.x),
            y: evaluateChannel(track.channels, "y", elapsed, base.y),
            width: dimensions.width,
            height: dimensions.height,
            scale: state.scale,
            scale_x: state.scale_x,
            scale_y: state.scale_y,
            rotation_deg: evaluateChannel(
              track.channels,
              "rotation_deg",
              elapsed,
              base.rotation_deg,
            ),
            opacity: evaluateChannel(
              track.channels,
              "opacity",
              elapsed,
              base.opacity,
            ),
            z: evaluateChannel(track.channels, "z", elapsed, base.z),
            asset:
              track.asset ??
              this.#start?.world.sprites[track.sprite_id]?.asset ??
              "",
          });
        } else if (track.type === "video") {
          objects.push({
            id: `video:${track.asset}`,
            kind: "video",
            x: evaluateChannel(track.channels, "x", elapsed, 0),
            y: evaluateChannel(track.channels, "y", elapsed, 0),
            width: evaluateChannel(
              track.channels,
              "width",
              elapsed,
              DESIGN_WIDTH,
            ),
            height: evaluateChannel(
              track.channels,
              "height",
              elapsed,
              DESIGN_HEIGHT,
            ),
            scale: 1,
            scale_x: 1,
            scale_y: 1,
            rotation_deg: 0,
            opacity: evaluateChannel(track.channels, "opacity", elapsed, 1),
            z: evaluateChannel(track.channels, "z", elapsed, 0),
            asset: track.asset,
          });
        } else if (track.type === "camera") {
          camera.x = evaluateChannel(track.channels, "x", elapsed, camera.x);
          camera.y = evaluateChannel(track.channels, "y", elapsed, camera.y);
          camera.zoom = evaluateChannel(
            track.channels,
            "zoom",
            elapsed,
            camera.zoom,
          );
          camera.rotation_deg = evaluateChannel(
            track.channels,
            "rotation_deg",
            elapsed,
            camera.rotation_deg,
          );
        }
      }
    }
    for (const [id, state] of Object.entries(startSprites)) {
      if (represented.has(id)) continue;
      objects.push({
        id,
        kind: "sprite",
        x: state.x,
        y: state.y,
        ...this.#spriteDimensions(id, state),
        scale: state.scale,
        scale_x: state.scale_x,
        scale_y: state.scale_y,
        rotation_deg: state.rotation_deg,
        opacity: state.opacity,
        z: state.z,
        asset: state.asset,
      });
    }
    for (const object of objects) {
      const override = this.#objectOverrides.get(object.id);
      if (override === undefined) continue;
      Object.assign(object, override);
      // Sprite dimensions are derived from scale channels. Recalculate them
      // after an interactive scale override so the React gizmo and inspector
      // stay aligned with the actual Pixi sprite while a gesture is pending.
      if (object.kind === "sprite") {
        Object.assign(object, this.#spriteDimensions(object.id, object));
      }
    }
    return {
      elapsed_ms: elapsed,
      camera: { ...camera, ...this.#cameraOverride },
      objects,
    };
  }

  captureThumbnail(): string | null {
    try {
      const thumbnail = document.createElement("canvas");
      thumbnail.width = 320;
      thumbnail.height = 180;
      const context = thumbnail.getContext("2d");
      if (context === null) return null;
      context.drawImage(this.#canvas, 0, 0, 320, 180);
      return thumbnail.toDataURL("image/png", 0.86);
    } catch {
      return null;
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.stop();
    this.#audio.destroy();
    this.#application.destroy({ removeView: false }, { children: true });
  }

  #emitFrame(elapsedMs: number): void {
    this.#onFrame?.(this.frameAt(elapsedMs));
  }

  #spriteDimensions(
    id: string,
    state: Pick<PreviewObjectFrame, "scale" | "scale_x" | "scale_y">,
  ): { width: number; height: number } {
    const view = this.#spriteViews.get(id);
    const textureWidth = view?.texture.width ?? 240;
    const textureHeight = view?.texture.height ?? 480;
    return {
      width: Math.max(1, Math.abs(textureWidth * state.scale * state.scale_x)),
      height: Math.max(
        1,
        Math.abs(textureHeight * state.scale * state.scale_y),
      ),
    };
  }

  async #reconcile(snapshot: RuntimeSnapshot): Promise<void> {
    if (snapshot.world.background === null) {
      for (const child of this.#backgrounds.removeChildren()) child.destroy();
      this.#background = null;
    } else if (
      this.#background?.label !== this.#assets[snapshot.world.background]
    ) {
      const background = await this.#makeBackground(snapshot.world.background);
      this.#background?.destroy();
      this.#background = background;
      this.#backgrounds.addChild(background);
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
      if (view === undefined || view.label !== this.#assets[state.asset]) {
        view?.destroy();
        view = await this.#makeSprite(state.asset, state);
        view.label = this.#assets[state.asset] ?? state.asset;
        this.#world.addChild(view);
        this.#spriteViews.set(id, view);
      }
      applySprite(view, state);
    }
    this.#cameraStart = { ...snapshot.world.camera };
    this.#camera = { ...snapshot.world.camera };
    this.#applyCamera();
    await this.#audio.reconcile(snapshot.audio, this.#assets);
  }

  async #makeBackground(asset: string): Promise<Sprite> {
    const texture = await loadTexture(requireAssetUrl(this.#assets, asset));
    const sprite = new Sprite(texture);
    const scale = Math.max(
      DESIGN_WIDTH / texture.width,
      DESIGN_HEIGHT / texture.height,
    );
    sprite.scale.set(scale);
    sprite.position.set(
      (DESIGN_WIDTH - texture.width * scale) / 2,
      (DESIGN_HEIGHT - texture.height * scale) / 2,
    );
    sprite.label = this.#assets[asset] ?? asset;
    return sprite;
  }

  async #makeSprite(asset: string, state: SpriteSnapshot): Promise<Sprite> {
    const sprite = new Sprite(
      await loadTexture(requireAssetUrl(this.#assets, asset)),
    );
    sprite.anchor.set(0.5, 1);
    applySprite(sprite, state);
    return sprite;
  }

  async #prepareVideo(
    track: Extract<TimelineTrack, { type: "video" }>,
  ): Promise<void> {
    this.#destroyVideo();
    const video = document.createElement("video");
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    video.playsInline = true;
    // Keep the element silent until the user explicitly unmutes the preview;
    // audio-enabled video is routed through AudioManager after that gesture.
    video.muted = true;
    video.src = requireAssetUrl(this.#assets, track.asset);
    await waitForVideoMetadata(video);
    video.currentTime = track.clip_start_ms / 1000;
    this.#video = video;
    if (track.audio_enabled && !this.#muted) {
      this.#audio.attachVideo(video, 1);
      this.#videoAudioAttached = true;
      video.muted = false;
    }
    this.#videoSource = new VideoSource({
      resource: video,
      autoLoad: false,
      autoPlay: false,
      updateFPS: 0,
    });
    await this.#videoSource.load();
    this.#videoSource.autoUpdate = false;
    this.#videoSource.update();
    this.#videoView = new Sprite(new Texture({ source: this.#videoSource }));
    this.#videoView.anchor.set(0, 0);
    this.#world.addChild(this.#videoView);
  }

  #syncVideo(elapsedMs: number): void {
    const video = this.#video;
    const view = this.#videoView;
    const cue = this.#cue;
    const track = cue?.tracks.find(
      (candidate): candidate is Extract<TimelineTrack, { type: "video" }> =>
        candidate.type === "video",
    );
    if (video === null || view === null || track === undefined) return;
    const clipStart = track.clip_start_ms / 1000;
    const clipEnd = (track.clip_end_ms ?? video.duration * 1000) / 1000;
    const duration = Math.max(0.001, clipEnd - clipStart);
    const raw = clipStart + elapsedMs / 1000;
    const desired = track.loop
      ? clipStart + ((raw - clipStart) % duration)
      : Math.min(clipEnd, raw);
    if (Math.abs(video.currentTime - desired) > 0.04)
      video.currentTime = desired;
    if (this.#playing && video.paused) void video.play().catch(() => undefined);
    this.#videoSource?.update();
  }

  #applyTrack(track: TimelineTrack, elapsedMs: number): void {
    if (track.type === "sprite") {
      const view = this.#spriteViews.get(track.sprite_id);
      if (view === undefined) return;
      const base =
        this.#spriteBases.get(track.sprite_id) ?? defaultSpriteFrame();
      const scale = evaluateChannel(
        track.channels,
        "scale",
        elapsedMs,
        base.scale,
      );
      applySprite(view, {
        asset:
          track.asset ??
          this.#start?.world.sprites[track.sprite_id]?.asset ??
          "",
        x: evaluateChannel(track.channels, "x", elapsedMs, base.x),
        y: evaluateChannel(track.channels, "y", elapsedMs, base.y),
        scale,
        scale_x: evaluateChannel(
          track.channels,
          "scale_x",
          elapsedMs,
          base.scale_x,
        ),
        scale_y: evaluateChannel(
          track.channels,
          "scale_y",
          elapsedMs,
          base.scale_y,
        ),
        rotation_deg: evaluateChannel(
          track.channels,
          "rotation_deg",
          elapsedMs,
          base.rotation_deg,
        ),
        opacity: evaluateChannel(
          track.channels,
          "opacity",
          elapsedMs,
          base.opacity,
        ),
        z: Math.round(evaluateChannel(track.channels, "z", elapsedMs, base.z)),
      });
      const override = this.#objectOverrides.get(track.sprite_id);
      if (override !== undefined) {
        if (override.x !== undefined) view.x = override.x;
        if (override.y !== undefined) view.y = override.y;
        if (
          override.scale !== undefined ||
          override.scale_x !== undefined ||
          override.scale_y !== undefined
        ) {
          const currentScale = override.scale ?? scale;
          const currentScaleX =
            override.scale_x ??
            evaluateChannel(track.channels, "scale_x", elapsedMs, base.scale_x);
          const currentScaleY =
            override.scale_y ??
            evaluateChannel(track.channels, "scale_y", elapsedMs, base.scale_y);
          view.scale.set(
            currentScale * currentScaleX,
            currentScale * currentScaleY,
          );
        }
        if (override.rotation_deg !== undefined)
          view.rotation = (override.rotation_deg * Math.PI) / 180;
        if (override.opacity !== undefined) view.alpha = override.opacity;
        if (override.z !== undefined) view.zIndex = Math.round(override.z);
      }
    } else if (track.type === "camera") {
      this.#camera = {
        x: evaluateChannel(track.channels, "x", elapsedMs, this.#cameraStart.x),
        y: evaluateChannel(track.channels, "y", elapsedMs, this.#cameraStart.y),
        zoom: evaluateChannel(
          track.channels,
          "zoom",
          elapsedMs,
          this.#cameraStart.zoom,
        ),
        rotation_deg: evaluateChannel(
          track.channels,
          "rotation_deg",
          elapsedMs,
          this.#cameraStart.rotation_deg,
        ),
      };
      this.#applyCamera();
    } else if (
      track.type === "video" &&
      this.#videoView !== null &&
      this.#video !== null
    ) {
      const x = evaluateChannel(track.channels, "x", elapsedMs, 0);
      const y = evaluateChannel(track.channels, "y", elapsedMs, 0);
      const width = evaluateChannel(
        track.channels,
        "width",
        elapsedMs,
        DESIGN_WIDTH,
      );
      const height = evaluateChannel(
        track.channels,
        "height",
        elapsedMs,
        DESIGN_HEIGHT,
      );
      const naturalWidth = Math.max(1, this.#video.videoWidth);
      const naturalHeight = Math.max(1, this.#video.videoHeight);
      if (track.fit === "stretch") {
        this.#videoView.position.set(x, y);
        this.#videoView.width = width;
        this.#videoView.height = height;
      } else {
        const factor =
          track.fit === "cover"
            ? Math.max(width / naturalWidth, height / naturalHeight)
            : Math.min(width / naturalWidth, height / naturalHeight);
        this.#videoView.width = naturalWidth * factor;
        this.#videoView.height = naturalHeight * factor;
        this.#videoView.position.set(
          x + (width - this.#videoView.width) / 2,
          y + (height - this.#videoView.height) / 2,
        );
      }
      this.#videoView.alpha = evaluateChannel(
        track.channels,
        "opacity",
        elapsedMs,
        1,
      );
      this.#videoView.zIndex = Math.round(
        evaluateChannel(track.channels, "z", elapsedMs, 0),
      );
      const override = this.#objectOverrides.get(`video:${track.asset}`);
      if (override !== undefined) {
        if (override.x !== undefined) this.#videoView.x = override.x;
        if (override.y !== undefined) this.#videoView.y = override.y;
        if (override.width !== undefined)
          this.#videoView.width = override.width;
        if (override.height !== undefined)
          this.#videoView.height = override.height;
        if (override.opacity !== undefined)
          this.#videoView.alpha = override.opacity;
        if (override.z !== undefined)
          this.#videoView.zIndex = Math.round(override.z);
      }
      if (track.audio_enabled && !this.#muted)
        this.#audio.setVideoVolume(
          this.#video,
          evaluateChannel(track.channels, "volume", elapsedMs, 1),
        );
    } else if (track.type === "bgm") {
      this.#audio.setBgmTimelineVolume(
        evaluateChannel(
          track.channels,
          "volume",
          elapsedMs,
          this.#bgmStartVolume,
        ),
      );
    }
  }

  #applyCamera(): void {
    const now = performance.now();
    let shakeX = 0;
    let shakeY = 0;
    if (this.#shakeDuration > 0) {
      const progress = (now - this.#shakeStartedAt) / this.#shakeDuration;
      if (progress >= 1) {
        this.#shakeDuration = 0;
      } else {
        const strength = (1 - Math.max(0, progress)) * 16;
        shakeX = Math.sin(progress * Math.PI * 18) * strength;
        shakeY = Math.cos(progress * Math.PI * 22) * strength * 0.6;
      }
    }
    this.#world.position.set(
      DESIGN_WIDTH / 2 + shakeX,
      DESIGN_HEIGHT / 2 + shakeY,
    );
    this.#world.pivot.set(
      DESIGN_WIDTH / 2 + this.#camera.x,
      DESIGN_HEIGHT / 2 + this.#camera.y,
    );
    this.#world.scale.set(this.#camera.zoom);
    this.#world.rotation = (this.#camera.rotation_deg * Math.PI) / 180;
  }

  #applyOverrides(): void {
    if (this.#cue === null) return;
    const elapsed = this.#lastElapsed < 0 ? 0 : this.#lastElapsed;
    for (const track of this.#cue.tracks) this.#applyTrack(track, elapsed);
    // A sprite can be present in the real entering snapshot without having a
    // timeline track yet. Keep temporary editor gestures visible for those
    // sprites too; the first committed gesture creates the track in YAML.
    const trackedSprites = new Set(
      this.#cue.tracks
        .filter(
          (track): track is Extract<TimelineTrack, { type: "sprite" }> =>
            track.type === "sprite",
        )
        .map((track) => track.sprite_id),
    );
    for (const [id, override] of this.#objectOverrides) {
      if (trackedSprites.has(id)) continue;
      const base = this.#start?.world.sprites[id];
      const view = this.#spriteViews.get(id);
      if (base === undefined || view === undefined) continue;
      applySprite(view, {
        ...base,
        ...override,
      });
    }
    this.#camera = { ...this.#camera, ...this.#cameraOverride };
    this.#applyCamera();
  }

  #showEffect(effect: "shake" | "flash", durationMs: number): void {
    const duration = Math.max(1, durationMs);
    if (effect === "flash") {
      this.#flashView?.destroy();
      const flash = new Graphics()
        .rect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT)
        .fill(0xffffff);
      flash.alpha = 0.88;
      this.#effects.addChild(flash);
      this.#flashView = flash;
      this.#flashStartedAt = performance.now();
      this.#flashDuration = duration;
      return;
    }
    this.#shakeStartedAt = performance.now();
    this.#shakeDuration = duration;
    this.#applyCamera();
  }

  #updateTransientEffects(now: number): void {
    if (this.#flashView !== null) {
      const progress = Math.max(
        0,
        Math.min(
          1,
          (now - this.#flashStartedAt) / Math.max(1, this.#flashDuration),
        ),
      );
      this.#flashView.alpha = 0.88 * (1 - progress);
      if (progress >= 1) {
        this.#flashView.destroy();
        this.#flashView = null;
        this.#flashDuration = 0;
      }
    }
    this.#applyCamera();
  }

  #clearTransientEffects(): void {
    this.#flashView?.destroy();
    this.#flashView = null;
    this.#flashDuration = 0;
    this.#shakeDuration = 0;
    this.#shakeStartedAt = 0;
    this.#applyCamera();
  }

  #clearSprites(): void {
    for (const view of this.#spriteViews.values()) view.destroy();
    this.#spriteViews.clear();
    this.#spriteBases.clear();
  }

  #destroyVideo(): void {
    this.#video?.pause();
    this.#videoView?.destroy({ texture: true, textureSource: true });
    this.#videoSource?.destroy();
    if (this.#video !== null) {
      this.#video.removeAttribute("src");
      this.#video.load();
    }
    this.#video = null;
    this.#videoView = null;
    this.#videoSource = null;
    this.#videoAudioAttached = false;
  }
}

function applySprite(view: Sprite, state: SpriteSnapshot): void {
  view.position.set(state.x, state.y);
  view.scale.set(state.scale * state.scale_x, state.scale * state.scale_y);
  view.rotation = (state.rotation_deg * Math.PI) / 180;
  view.alpha = state.opacity;
  view.zIndex = state.z;
}

function omitSpriteAsset(state: SpriteSnapshot): Omit<SpriteSnapshot, "asset"> {
  return {
    x: state.x,
    y: state.y,
    scale: state.scale,
    scale_x: state.scale_x,
    scale_y: state.scale_y,
    rotation_deg: state.rotation_deg,
    opacity: state.opacity,
    z: state.z,
  };
}

function defaultSpriteFrame(): Omit<SpriteSnapshot, "asset"> {
  return {
    x: 960,
    y: 1080,
    scale: 1,
    scale_x: 1,
    scale_y: 1,
    rotation_deg: 0,
    opacity: 1,
    z: 0,
  };
}

function requireAssetUrl(assets: AssetUrlMap, id: string): string {
  const url = assets[id];
  if (url === undefined) throw new Error(`预览缺少素材 ${id}`);
  return url;
}

function loadTexture(url: string): Promise<Texture> {
  return new Promise<Texture>((resolve, reject) => {
    const image = new Image();
    // convertFileSrc() uses Tauri's asset origin. Without an explicit
    // anonymous CORS request WebView2 may decode the image for <img>, but marks
    // it origin-dirty and WebGL rejects it in texImage2D().
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(Texture.from(image));
    image.onerror = () => reject(new Error(`图片加载失败：${url}`));
    image.src = url;
  });
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA)
    return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const loaded = (): void => {
      cleanup();
      resolve();
    };
    const failed = (): void => {
      cleanup();
      reject(new Error("视频元数据加载失败"));
    };
    const cleanup = (): void => {
      video.removeEventListener("loadedmetadata", loaded);
      video.removeEventListener("error", failed);
    };
    video.addEventListener("loadedmetadata", loaded, { once: true });
    video.addEventListener("error", failed, { once: true });
    video.load();
  });
}

function waitForPresentedVideoFrame(video: HTMLVideoElement): Promise<void> {
  if (typeof video.requestVideoFrameCallback === "function") {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      video.requestVideoFrameCallback(() => finish());
      window.setTimeout(finish, 250);
    });
  }
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
    return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      video.removeEventListener("seeked", finish);
      video.removeEventListener("canplay", finish);
      resolve();
    };
    video.addEventListener("seeked", finish, { once: true });
    video.addEventListener("canplay", finish, { once: true });
    window.setTimeout(finish, 250);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
