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
import {
  evaluateActiveScreenEffects,
  evaluateTimelineFrame,
} from "./timelineEvaluator";
import { BoundedLedger } from "./ledger";
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
  kind: "sprite" | "video" | "button";
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
export class SceneSurface {
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
  #playbackRate = 1;
  #frame = 0;
  #lastFrameAt = 0;
  #onFrame: ((frame: TimelinePreviewFrame) => void) | null = null;
  #onPlayingChange: ((playing: boolean) => void) | null = null;
  #objectOverrides = new Map<string, PreviewObjectPatch>();
  #cameraOverride: Partial<TimelinePreviewFrame["camera"]> = {};
  #flashView: Graphics | null = null;
  #shakeEffect: { startMs: number; durationMs: number } | null = null;
  #effectElapsedMs = 0;
  #destroyed = false;
  #seekGeneration = 0;
  #seekAbort: AbortController | null = null;
  #audioActivationAbort: AbortController | null = null;
  #loadGeneration = 0;
  #loadAbort: AbortController | null = null;
  readonly #timelineEventLedger = new BoundedLedger<string>(4_096);

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
    this.#audio = new AudioManager(MUTED_PREVIEW_SETTINGS, {
      deferUntilUnmuted: true,
    });
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
    // Cancel an earlier load before even validating this request.  Otherwise
    // a malformed replacement update could leave the old asynchronous load
    // alive and allow it to win the race later.
    this.stop();
    const cue = update.cues.find(
      (
        candidate,
      ): candidate is Extract<typeof candidate, { type: "timeline" }> =>
        candidate.type === "timeline",
    );
    if (cue === undefined) {
      // `stop()` cancels the old asynchronous work but deliberately keeps
      // the shared audio graph alive for a normal replacement.  A malformed
      // replacement has no later reconcile step, so explicitly clear the
      // previous BGM before surfacing the validation error.
      await this.#audio
        .reconcile({ bgm: null }, this.#assets)
        .catch(() => undefined);
      throw new Error("目标 update 不包含 timeline Cue");
    }
    // Browser image/media promises are not uniformly abortable.  Pair an
    // AbortController with a monotonically increasing generation so a stale
    // load can never install objects after a newer target has taken over.
    const loadGeneration = this.#loadGeneration;
    const loadAbort = new AbortController();
    this.#loadAbort = loadAbort;
    const isCurrentLoad = (): boolean =>
      !this.#destroyed &&
      !loadAbort.signal.aborted &&
      this.#loadGeneration === loadGeneration &&
      this.#loadAbort === loadAbort;
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
    this.#timelineEventLedger.clear();
    this.#objectOverrides.clear();
    this.#cameraOverride = {};
    try {
      if (!isCurrentLoad()) return;
      if (!(await this.#reconcile(start, isCurrentLoad, loadAbort.signal)))
        return;
      if (!isCurrentLoad()) return;
      this.#spriteBases.clear();
      for (const track of cue.tracks) {
        if (track.type === "sprite") {
          const effectiveAsset =
            track.asset ?? start.world.sprites[track.sprite_id]?.asset;
          if (effectiveAsset === undefined)
            throw new Error(`立绘 ${track.sprite_id} 没有可继承的素材`);
          if (!isCurrentLoad()) return;
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
            if (!isCurrentLoad()) {
              view.destroy();
              return;
            }
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
      if (videoTrack !== undefined) {
        if (!(await this.#prepareVideo(videoTrack, loadGeneration, loadAbort)))
          return;
      }
      if (!isCurrentLoad()) return;
      await this.seek(0, false);
      if (!isCurrentLoad()) return;
      if (this.#video !== null) {
        await waitForPresentedVideoFrame(this.#video, loadAbort.signal);
        if (!isCurrentLoad()) return;
        this.#videoSource?.update();
        this.#application.render();
      }
    } catch (error) {
      // A superseded load must not tear down the newer context.  Its own
      // helpers release any local image/video resources before returning.
      if (!isCurrentLoad()) return;
      this.stop();
      // A partially restored context must not leave its BGM running after the
      // preview reports an image/video/WebGL error.
      await this.#audio
        .reconcile({ bgm: null }, this.#assets)
        .catch(() => undefined);
      throw error;
    } finally {
      if (this.#loadAbort === loadAbort) this.#loadAbort = null;
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

  async seek(elapsedMs: number, fireEvents = false): Promise<void> {
    if (this.#cue === null) return Promise.resolve();
    const generation = ++this.#seekGeneration;
    this.#seekAbort?.abort();
    const controller = new AbortController();
    this.#seekAbort = controller;
    const elapsed = Math.max(0, Math.min(this.#cue.duration_ms, elapsedMs));
    // Any backwards seek starts a fresh event ledger. Forward scrubbing does
    // not emit events, but playback after a rewind must be able to replay the
    // events that occur after the new playhead position.
    if (elapsed < this.#lastElapsed) {
      for (const event of this.#cue.events) {
        if (event.at_ms >= elapsed) this.#timelineEventLedger.delete(event.id);
      }
      this.#clearTransientEffects();
    }
    this.#applyFrame(this.frameAt(elapsed));
    await this.#syncVideo(elapsed, controller.signal, generation);
    if (controller.signal.aborted || generation !== this.#seekGeneration)
      return;
    if (fireEvents) {
      for (const event of this.#cue.events) {
        if (
          event.at_ms >= this.#lastElapsed &&
          event.at_ms <= elapsed &&
          this.#timelineEventLedger.consume(event.id)
        ) {
          if (event.type === "sfx" && !this.#muted)
            void this.#audio
              .playSfx(
                event.asset,
                event.volume,
                this.#assets,
                controller.signal,
              )
              .catch((error: unknown) =>
                this.#diagnostic(`预览 SFX 失败：${errorMessage(error)}`),
              );
          // Screen effects are rebuilt from timeline time below.  This keeps
          // normal playback and scrubbing identical and avoids starting a
          // wall-clock animation that would drift when the rate changes.
        }
      }
    }
    this.#lastElapsed = elapsed;
    this.#rebuildTransientEffects(elapsed);
    if (elapsed >= this.#cue.duration_ms) this.#clearTransientEffects();
    this.#application.render();
    this.#emitFrame(elapsed);
    if (this.#seekAbort === controller) this.#seekAbort = null;
  }

  async play(): Promise<void> {
    if (this.#cue === null || this.#playing) return;
    this.#playing = true;
    this.#onPlayingChange?.(true);
    await this.#audio.unlock().catch(() => undefined);
    if (!this.#playing || this.#cue === null) return;
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
    if (!this.#playing || this.#cue === null) return;
    this.#lastFrameAt = performance.now();
    const tick = (now: number): void => {
      if (!this.#playing || this.#cue === null) return;
      const delta = now - this.#lastFrameAt;
      this.#lastFrameAt = now;
      void this.seek(this.#lastElapsed + delta * this.#playbackRate, true)
        .catch((error: unknown) => {
          this.#diagnostic(`时间轴定位失败：${errorMessage(error)}`);
        })
        .finally(() => {
          if (
            this.#cue !== null &&
            this.#lastElapsed >= this.#cue.duration_ms
          ) {
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

  /** Change virtual time speed without jumping the current playhead. */
  setRate(rate: number): void {
    this.#playbackRate =
      Number.isFinite(rate) && rate > 0 ? Math.min(16, rate) : 1;
    this.#audio.setPlaybackRate(this.#playbackRate);
  }

  stop(): void {
    this.pause();
    this.#playbackRate = 1;
    this.#audio.setPlaybackRate(1);
    this.#audioActivationAbort?.abort();
    this.#audioActivationAbort = null;
    this.#seekAbort?.abort();
    this.#seekAbort = null;
    this.#loadAbort?.abort();
    this.#loadAbort = null;
    this.#loadGeneration += 1;
    this.#seekGeneration += 1;
    this.#lastElapsed = -1;
    this.#timelineEventLedger.clear();
    this.#clearTransientEffects();
    this.#destroyVideo();
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    this.#audio.applySettings({
      ...DEFAULT_SETTINGS,
      master_volume: muted ? 0 : 1,
    });
    this.#audioActivationAbort?.abort();
    this.#audioActivationAbort = null;
    if (!muted) {
      const activation = new AbortController();
      this.#audioActivationAbort = activation;
      void this.#audio
        .activateDeferred(activation.signal)
        .catch((error: unknown) =>
          this.#diagnostic(`预览音频初始化失败: ${String(error)}`),
        )
        .finally(() => {
          if (this.#audioActivationAbort === activation)
            this.#audioActivationAbort = null;
        });
    }
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
    const startButtons = this.#start?.world.buttons ?? {};
    const evaluated =
      this.#cue === null
        ? null
        : evaluateTimelineFrame(
            { duration_ms: this.#cue.duration_ms, tracks: this.#cue.tracks },
            {
              sprites: startSprites,
              buttons: startButtons,
              camera: this.#cameraStart,
              bgm_volume: this.#bgmStartVolume,
            },
            elapsed,
          );
    const camera = evaluated?.camera ?? { ...this.#cameraStart };
    if (this.#cue !== null) {
      for (const track of this.#cue.tracks) {
        if (track.type === "sprite") {
          represented.add(track.sprite_id);
          const base =
            this.#spriteBases.get(track.sprite_id) ?? defaultSpriteFrame();
          const evaluatedSprite = evaluated?.sprites.find(
            (sprite) => sprite.id === track.sprite_id,
          );
          const state = {
            scale: evaluatedSprite?.scale ?? base.scale,
            scale_x: evaluatedSprite?.scale_x ?? base.scale_x,
            scale_y: evaluatedSprite?.scale_y ?? base.scale_y,
          };
          const dimensions = this.#spriteDimensions(track.sprite_id, state);
          objects.push({
            id: track.sprite_id,
            kind: "sprite",
            x: evaluatedSprite?.x ?? base.x,
            y: evaluatedSprite?.y ?? base.y,
            width: dimensions.width,
            height: dimensions.height,
            scale: state.scale,
            scale_x: state.scale_x,
            scale_y: state.scale_y,
            rotation_deg: evaluatedSprite?.rotation_deg ?? base.rotation_deg,
            opacity: evaluatedSprite?.opacity ?? base.opacity,
            z: evaluatedSprite?.z ?? base.z,
            asset:
              track.asset ??
              this.#start?.world.sprites[track.sprite_id]?.asset ??
              "",
          });
        } else if (track.type === "video") {
          const evaluatedVideo = evaluated?.videos.find(
            (video) => video.asset === track.asset,
          );
          objects.push({
            id: `video:${track.asset}`,
            kind: "video",
            x: evaluatedVideo?.x ?? 0,
            y: evaluatedVideo?.y ?? 0,
            width: evaluatedVideo?.width ?? DESIGN_WIDTH,
            height: evaluatedVideo?.height ?? DESIGN_HEIGHT,
            scale: 1,
            scale_x: 1,
            scale_y: 1,
            rotation_deg: 0,
            opacity: evaluatedVideo?.opacity ?? 1,
            z: evaluatedVideo?.z ?? 0,
            asset: track.asset,
          });
        }
      }
      const buttonIds = new Set([
        ...Object.keys(startButtons),
        ...this.#cue.tracks
          .filter(
            (track): track is Extract<TimelineTrack, { type: "button" }> =>
              track.type === "button",
          )
          .map((track) => track.instance_id),
      ]);
      for (const id of buttonIds) {
        const base = startButtons[id];
        const state = evaluated?.buttons.find((button) => button.id === id);
        if (state === undefined && base === undefined) continue;
        const fallback = base ?? {
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          scale_x: 1,
          scale_y: 1,
          rotation_deg: 0,
          opacity: 1,
          z: 0,
        };
        objects.push({
          id,
          kind: "button",
          x: state?.x ?? fallback.x,
          y: state?.y ?? fallback.y,
          width: state?.width ?? fallback.width,
          height: state?.height ?? fallback.height,
          scale: 1,
          scale_x: state?.scale_x ?? fallback.scale_x,
          scale_y: state?.scale_y ?? fallback.scale_y,
          rotation_deg: state?.rotation_deg ?? fallback.rotation_deg,
          opacity: state?.opacity ?? fallback.opacity,
          z: state?.z ?? fallback.z,
          asset: base?.normal ?? "",
        });
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
      // preserveDrawingBuffer is deliberately disabled for normal rendering.
      // Extracting the stage into an offscreen canvas keeps thumbnails
      // reliable without imposing a GPU readback cost on every frame.
      const source = this.#application.renderer.extract.canvas(
        this.#application.stage,
      );
      context.drawImage(source as unknown as CanvasImageSource, 0, 0, 320, 180);
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

  /** Explicit lifecycle name used by the shared TimelineSession contract. */
  dispose(): void {
    this.destroy();
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

  async #reconcile(
    snapshot: RuntimeSnapshot,
    isCurrentLoad: () => boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (snapshot.world.background === null) {
      for (const child of this.#backgrounds.removeChildren()) child.destroy();
      this.#background = null;
    } else if (
      this.#background?.label !== this.#assets[snapshot.world.background]
    ) {
      const background = await this.#makeBackground(snapshot.world.background);
      if (!isCurrentLoad()) {
        background.destroy();
        return false;
      }
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
        if (!isCurrentLoad()) {
          view.destroy();
          return false;
        }
        view.label = this.#assets[state.asset] ?? state.asset;
        this.#world.addChild(view);
        this.#spriteViews.set(id, view);
      }
      applySprite(view, state);
    }
    this.#cameraStart = { ...snapshot.world.camera };
    this.#camera = { ...snapshot.world.camera };
    this.#applyCamera();
    await this.#audio.reconcile(snapshot.audio, this.#assets, signal);
    return isCurrentLoad();
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
    loadGeneration: number,
    loadAbort: AbortController,
  ): Promise<boolean> {
    this.#destroyVideo();
    const video = document.createElement("video");
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    video.playsInline = true;
    // Keep the element silent until the user explicitly unmutes the preview;
    // audio-enabled video is routed through AudioManager after that gesture.
    video.muted = true;
    video.src = requireAssetUrl(this.#assets, track.asset);
    let source: VideoSource | null = null;
    let view: Sprite | null = null;
    const isCurrentLoad = (): boolean =>
      !this.#destroyed &&
      !loadAbort.signal.aborted &&
      this.#loadGeneration === loadGeneration &&
      this.#loadAbort === loadAbort;
    try {
      await waitForVideoMetadata(video, loadAbort.signal);
      if (!isCurrentLoad()) {
        disposeVideoElements(video);
        return false;
      }
      // Register the listener before assigning currentTime so a fast decoder
      // cannot complete the initial seek before we start waiting for it.  A
      // zero clip start is already the media's initial position; in that case
      // waiting for the first presented frame below is sufficient.
      if (track.clip_start_ms > 0) {
        const seek = waitForVideoSeek(video, loadAbort.signal);
        video.currentTime = track.clip_start_ms / 1000;
        await seek;
        if (!isCurrentLoad()) {
          disposeVideoElements(video);
          return false;
        }
      }
      await waitForPresentedVideoFrame(video, loadAbort.signal);
      if (!isCurrentLoad()) {
        disposeVideoElements(video);
        return false;
      }
      source = new VideoSource({
        resource: video,
        autoLoad: false,
        autoPlay: false,
        updateFPS: 0,
      });
      await source.load();
      if (!isCurrentLoad()) {
        disposeVideoElements(video, source);
        return false;
      }
      source.autoUpdate = false;
      source.update();
      view = new Sprite(new Texture({ source }));
      view.anchor.set(0, 0);
      this.#video = video;
      this.#videoSource = source;
      this.#videoView = view;
      this.#world.addChild(view);
      if (track.audio_enabled && !this.#muted) {
        this.#audio.attachVideo(video, 1);
        this.#videoAudioAttached = true;
        video.muted = false;
      }
      return true;
    } catch (error) {
      disposeVideoElements(video, source, view);
      if (!isCurrentLoad()) return false;
      throw error;
    }
  }

  async #syncVideo(
    elapsedMs: number,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
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
    if (Math.abs(video.currentTime - desired) > 0.04) {
      video.currentTime = desired;
      try {
        await waitForVideoSeek(video, signal);
        if (signal.aborted || generation !== this.#seekGeneration) return;
        await waitForPresentedVideoFrame(video, signal);
      } catch (error) {
        if (!signal.aborted) {
          this.#diagnostic(
            `视频定位失败（${track.asset} @ ${elapsedMs}ms）：${errorMessage(error)}`,
          );
        }
        return;
      }
      if (signal.aborted || generation !== this.#seekGeneration) return;
    }
    if (this.#playing && video.paused) void video.play().catch(() => undefined);
    this.#videoSource?.update();
  }

  #applyFrame(frame: TimelinePreviewFrame): void {
    this.#camera = { ...frame.camera };
    this.#applyCamera();
    for (const object of frame.objects) {
      if (object.kind === "sprite") {
        const view = this.#spriteViews.get(object.id);
        if (view === undefined) continue;
        applySprite(view, {
          asset: object.asset,
          x: object.x,
          y: object.y,
          scale: object.scale,
          scale_x: object.scale_x,
          scale_y: object.scale_y,
          rotation_deg: object.rotation_deg,
          opacity: object.opacity,
          z: object.z,
        });
        continue;
      }
      if (this.#videoView === null || this.#video === null) continue;
      const track = this.#cue?.tracks.find(
        (candidate): candidate is Extract<TimelineTrack, { type: "video" }> =>
          candidate.type === "video" && candidate.asset === object.asset,
      );
      if (track === undefined) continue;
      applyVideoFrame(this.#videoView, this.#video, track, object);
      const evaluated = this.#evaluateFrame(frame.elapsed_ms);
      const videoState = evaluated?.videos.find(
        (candidate) => candidate.asset === object.asset,
      );
      if (track.audio_enabled && !this.#muted && videoState !== undefined)
        this.#audio.setVideoVolume(this.#video, videoState.volume);
    }
    const evaluated = this.#evaluateFrame(frame.elapsed_ms);
    if (evaluated !== null)
      this.#audio.setBgmTimelineVolume(evaluated.bgm_volume);
  }

  #evaluateFrame(elapsedMs: number) {
    if (this.#cue === null) return null;
    return evaluateTimelineFrame(
      { duration_ms: this.#cue.duration_ms, tracks: this.#cue.tracks },
      {
        sprites: this.#start?.world.sprites ?? {},
        buttons: this.#start?.world.buttons ?? {},
        camera: this.#cameraStart,
        bgm_volume: this.#bgmStartVolume,
      },
      elapsedMs,
    );
  }

  #applyCamera(): void {
    let shakeX = 0;
    let shakeY = 0;
    const shake = this.#shakeEffect;
    if (shake !== null) {
      const progress = Math.max(
        0,
        Math.min(
          1,
          (this.#effectElapsedMs - shake.startMs) /
            Math.max(1, shake.durationMs),
        ),
      );
      const strength = (1 - progress) * 16;
      shakeX = Math.sin(progress * Math.PI * 18) * strength;
      shakeY = Math.cos(progress * Math.PI * 22) * strength * 0.6;
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
    this.#applyFrame(this.frameAt(elapsed));
  }

  #rebuildTransientEffects(elapsedMs: number): void {
    this.#effectElapsedMs = elapsedMs;
    const { flash, shake } = evaluateActiveScreenEffects(
      this.#cue?.events ?? [],
      elapsedMs,
    );
    this.#shakeEffect = shake;
    if (flash === null) {
      this.#flashView?.destroy();
      this.#flashView = null;
    } else {
      if (this.#flashView === null) {
        this.#flashView = new Graphics()
          .rect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT)
          .fill(0xffffff);
        this.#effects.addChild(this.#flashView);
      }
      const progress = Math.max(
        0,
        Math.min(
          1,
          (elapsedMs - flash.startMs) / Math.max(1, flash.durationMs),
        ),
      );
      this.#flashView.alpha = 0.88 * (1 - progress);
    }
    this.#applyCamera();
  }

  #clearTransientEffects(): void {
    this.#flashView?.destroy();
    this.#flashView = null;
    this.#shakeEffect = null;
    this.#effectElapsedMs = 0;
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

// Compatibility name for callers from the first editor timeline milestone.
// There is only one implementation; both game and editor now instantiate
// SceneSurface through the shared package.
export { SceneSurface as TimelinePreviewSurface };

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

function applyVideoFrame(
  view: Sprite,
  video: HTMLVideoElement,
  track: Extract<TimelineTrack, { type: "video" }>,
  frame: PreviewObjectFrame,
): void {
  const naturalWidth = Math.max(1, video.videoWidth);
  const naturalHeight = Math.max(1, video.videoHeight);
  if (track.fit === "stretch") {
    view.position.set(frame.x, frame.y);
    view.width = frame.width;
    view.height = frame.height;
  } else {
    const factor =
      track.fit === "cover"
        ? Math.max(frame.width / naturalWidth, frame.height / naturalHeight)
        : Math.min(frame.width / naturalWidth, frame.height / naturalHeight);
    view.width = naturalWidth * factor;
    view.height = naturalHeight * factor;
    view.position.set(
      frame.x + (frame.width - view.width) / 2,
      frame.y + (frame.height - view.height) / 2,
    );
  }
  view.alpha = frame.opacity;
  view.zIndex = Math.round(frame.z);
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

function waitForVideoMetadata(
  video: HTMLVideoElement,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
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
    const aborted = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      video.removeEventListener("loadedmetadata", loaded);
      video.removeEventListener("error", failed);
      signal?.removeEventListener("abort", aborted);
    };
    video.addEventListener("loadedmetadata", loaded, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
    video.load();
  });
}

function disposeVideoElements(
  video: HTMLVideoElement,
  source?: VideoSource | null,
  view?: Sprite | null,
): void {
  video.pause();
  view?.destroy({ texture: true, textureSource: true });
  source?.destroy();
  video.removeAttribute("src");
  video.load();
}

function waitForVideoSeek(
  video: HTMLVideoElement,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let timer = 0;
    const finish = (): void => {
      cleanup();
      resolve();
    };
    const failed = (): void => {
      cleanup();
      reject(new Error("视频 seek 失败"));
    };
    const aborted = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      video.removeEventListener("seeked", finish);
      video.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
      window.clearTimeout(timer);
    };
    video.addEventListener("seeked", finish, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("超过 2 秒"));
    }, 2_000);
  });
}

function waitForPresentedVideoFrame(
  video: HTMLVideoElement,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  if (typeof video.requestVideoFrameCallback === "function") {
    return new Promise<void>((resolve) => {
      let settled = false;
      let timer = 0;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== 0) window.clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      video.requestVideoFrameCallback(() => finish());
      signal?.addEventListener("abort", finish, { once: true });
      timer = window.setTimeout(finish, 250);
    });
  }
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
    return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      video.removeEventListener("seeked", finish);
      video.removeEventListener("canplay", finish);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    video.addEventListener("seeked", finish, { once: true });
    video.addEventListener("canplay", finish, { once: true });
    signal?.addEventListener("abort", finish, { once: true });
    window.setTimeout(finish, 250);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
