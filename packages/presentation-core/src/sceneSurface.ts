/**
 * Shared Pixi scene surface for the game renderer and the editor preview.
 *
 * This is the single implementation of "draw a VECTSPACE scene": the fixed
 * 1920x1080 application, the background/character/video/camera/effect layers,
 * object creation and release, the reference-counted texture cache, per-instance
 * frame loops, camera/shake composition, screen-space effects, thumbnails and
 * the render scheduler.
 *
 * Two invariants drive the design:
 *
 * - **prepared before committed** — `prepare()` decodes every replacement
 *   resource off-stage and returns a token; only `applyWorld()` touches the
 *   display list, and a stale token never commits.  Old visuals therefore stay
 *   on screen while a scene switch is still loading.
 * - **at most one regular render per browser frame** — one scheduler owns all
 *   rendering: Pixi's automatic ticker is disabled and every visual mutation
 *   only marks the surface dirty.
 *
 * The host owns the clock and audio (see `timelineSession.ts`); the surface
 * owns pixels, objects and cue executors for ordinary visual cues.
 */

import "pixi.js/unsafe-eval";

import {
  Application,
  Container,
  Graphics,
  Sprite,
  Texture,
  VideoSource,
} from "pixi.js";

import {
  DEFAULT_SPRITE_HEIGHT,
  DEFAULT_SPRITE_WIDTH,
  EMPTY_SCENE_OVERRIDES,
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  ENTRY_TWEEN_SCALE,
  composeWorldTransform,
  entryTweenPose,
  flashAlpha,
  hitTestSceneFrame,
  mergeSceneOverrides,
  shakeOffset,
  type SceneFrame,
  type SceneObjectFrame,
  type SceneObjectPatch,
  type SceneOverrides,
  type SceneSpriteGeometry,
} from "./sceneFrame";
import { SceneTextureStore, type SceneTextureLike } from "./sceneTextures";
import { animate, mix } from "./motion";
import {
  FrameLoopRegistry,
  imageAssetSourceVersion,
  resolveImageAsset,
  type AnimationMap,
  type FrameSequencePlayer,
  type ImageAssetSource,
} from "./imageAnimation";
import type { ActiveScreenEffect } from "./timelineEvaluator";
import type {
  AssetUrlMap,
  ButtonSnapshot,
  CameraSnapshot,
  Easing,
  PresentationCue,
  SpriteSnapshot,
  TimelineTrack,
} from "./types";

/** Texture budget floor for a host that declares no animations at all. */
export const MIN_SESSION_TEXTURES = 512;
/** Headroom for backgrounds, sprites, GUI art and buttons beside the frames. */
export const TEXTURE_BUDGET_HEADROOM = 128;
const IMAGE_LOAD_TIMEOUT_MS = 8_000;

// ---------------------------------------------------------------------------
// Renderer ports
//
// The surface talks to Pixi through this small port so the same object,
// texture and scheduling logic can be exercised in unit tests with an
// in-memory kit.  `pixiSceneKit()` is the only place that knows about Pixi.
// ---------------------------------------------------------------------------

export interface ScenePointLike {
  x: number;
  y: number;
  set(x: number, y?: number): void;
}

export interface SceneDestroyOptions {
  children?: boolean;
  texture?: boolean;
  textureSource?: boolean;
  context?: boolean;
}

export interface SceneNodeLike {
  label: string;
  visible: boolean;
  zIndex: number;
  alpha: number;
  rotation: number;
  x: number;
  y: number;
  width: number;
  height: number;
  sortableChildren: boolean;
  position: ScenePointLike;
  pivot: ScenePointLike;
  scale: ScenePointLike;
  addChild(child: SceneNodeLike): SceneNodeLike;
  removeChild(child: SceneNodeLike): void;
  removeChildren(): SceneNodeLike[];
  readonly children: readonly SceneNodeLike[];
  destroy(options?: boolean | SceneDestroyOptions): void;
}

export interface SceneSpriteLike extends SceneNodeLike {
  anchor: ScenePointLike;
  texture: SceneTextureLike;
}

export interface SceneGraphicsLike extends SceneNodeLike {
  rect(x: number, y: number, width: number, height: number): SceneGraphicsLike;
  fill(color: number): SceneGraphicsLike;
}

export interface SceneVideoSourceLike {
  autoUpdate: boolean;
  load(): Promise<unknown>;
  update(): void;
  destroy(): void;
}

export interface SceneApplicationLike {
  init(options: SceneApplicationInit): Promise<void>;
  readonly stage: SceneNodeLike;
  readonly renderer: {
    readonly extract: { canvas(target: SceneNodeLike): unknown };
  };
  render(): void;
  destroy(
    rendererOptions?: { removeView?: boolean },
    destroyOptions?: SceneDestroyOptions,
  ): void;
}

export interface SceneApplicationInit {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  resolution: number;
  autoDensity: boolean;
  antialias: boolean;
  backgroundColor: number;
  preference: string;
  powerPreference: string;
  preserveDrawingBuffer: boolean;
  autoStart: boolean;
}

export interface SceneKit {
  application(): SceneApplicationLike;
  container(): SceneNodeLike;
  sprite(texture: SceneTextureLike): SceneSpriteLike;
  graphics(): SceneGraphicsLike;
  textureFromImage(image: HTMLImageElement): SceneTextureLike;
  videoSource(element: HTMLVideoElement): SceneVideoSourceLike;
  videoSprite(source: SceneVideoSourceLike): SceneSpriteLike;
}

/** Default kit backed by the real Pixi renderer. */
export function pixiSceneKit(): SceneKit {
  return {
    application: () => {
      const application = new Application();
      return {
        get stage(): SceneNodeLike {
          return application.stage as unknown as SceneNodeLike;
        },
        get renderer(): SceneApplicationLike["renderer"] {
          return application.renderer as unknown as SceneApplicationLike["renderer"];
        },
        init: (options) =>
          application.init({
            canvas: options.canvas,
            width: options.width,
            height: options.height,
            resolution: options.resolution,
            autoDensity: options.autoDensity,
            antialias: options.antialias,
            backgroundColor: options.backgroundColor,
            preference: options.preference as "webgl",
            powerPreference: options.powerPreference as "high-performance",
            preserveDrawingBuffer: options.preserveDrawingBuffer,
            autoStart: options.autoStart,
          }),
        render: () => application.render(),
        destroy: (rendererOptions, destroyOptions) =>
          application.destroy(rendererOptions ?? {}, destroyOptions ?? {}),
      } satisfies SceneApplicationLike;
    },
    container: () => new Container() as unknown as SceneNodeLike,
    sprite: (texture) =>
      new Sprite(texture as unknown as Texture) as unknown as SceneSpriteLike,
    graphics: () => new Graphics() as unknown as SceneGraphicsLike,
    textureFromImage: (image) => Texture.from(image) as SceneTextureLike,
    videoSource: (element) =>
      new VideoSource({
        resource: element,
        autoLoad: false,
        autoPlay: false,
        updateFPS: 0,
      }) as unknown as SceneVideoSourceLike,
    videoSprite: (source) =>
      new Sprite(
        new Texture({ source: source as unknown as VideoSource }),
      ) as unknown as SceneSpriteLike,
  };
}

// ---------------------------------------------------------------------------
// Render scheduler
// ---------------------------------------------------------------------------

export interface SceneFrameRequest {
  (callback: (nowMs: number) => void): number;
}

export interface SceneFrameCancel {
  (handle: number): void;
}

export interface SceneRenderLoopOptions {
  render(): void;
  /** Decoration tick; returns `true` when it changed pixels. */
  tick(deltaMs: number): boolean;
  request?: SceneFrameRequest;
  cancel?: SceneFrameCancel;
}

/**
 * One render loop per surface.
 *
 * Every visual mutation asks the loop to draw; multiple mutations inside the
 * same browser frame collapse into a single `render()`.  Decoration (frame
 * loops) is ticked here as well so it shares the same frame budget.
 */
export class SceneRenderLoop {
  readonly #options: SceneRenderLoopOptions;
  readonly #request: SceneFrameRequest;
  readonly #cancel: SceneFrameCancel;
  #handle = 0;
  #running = false;
  #dirty = false;
  #lastTick: number | null = null;
  #disposed = false;

  constructor(options: SceneRenderLoopOptions) {
    this.#options = options;
    this.#request =
      options.request ?? ((callback) => requestAnimationFrame(callback));
    this.#cancel = options.cancel ?? ((handle) => cancelAnimationFrame(handle));
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#disposed || this.#running) return;
    this.#running = true;
    this.#lastTick = null;
    this.#handle = this.#request(this.#frame);
  }

  stop(): void {
    if (this.#handle !== 0) this.#cancel(this.#handle);
    this.#handle = 0;
    this.#running = false;
  }

  /** Marks the surface dirty; draws on the next browser frame. */
  schedule(): void {
    if (this.#disposed) return;
    this.#dirty = true;
    if (!this.#running) this.flush();
  }

  /** Draws immediately when a change is pending. */
  flush(): void {
    if (!this.#dirty || this.#disposed) return;
    this.#dirty = false;
    this.#options.render();
  }

  dispose(): void {
    this.stop();
    this.#disposed = true;
    this.#dirty = false;
  }

  #frame = (now: number): void => {
    this.#handle = 0;
    if (this.#disposed || !this.#running) return;
    // The first frame after `start()` only establishes the time origin; a
    // timestamp of zero must not be mistaken for "no frame yet".
    const delta =
      this.#lastTick === null ? 0 : Math.max(0, now - this.#lastTick);
    this.#lastTick = now;
    const changed = this.#options.tick(delta);
    if (changed) this.#dirty = true;
    this.flush();
    this.#handle = this.#request(this.#frame);
  };
}

// ---------------------------------------------------------------------------
// World preparation and frames
// ---------------------------------------------------------------------------

export interface SceneWorldSnapshot {
  background: string | null;
  sprites: Record<string, SpriteSnapshot>;
  camera: CameraSnapshot;
}

export interface ScenePreparationRequest {
  world: SceneWorldSnapshot;
  assets: AssetUrlMap;
}

interface PreparedAsset {
  asset: string;
  label: string;
  /** Full source revision: changes when frames, durations or geometry change
   * even though the logical asset id (and therefore the label) stays the same. */
  version: string;
  source: ImageAssetSource;
  urls: string[];
  textures: SceneTextureLike[];
  /**
   * True once a view took ownership of `urls`.  A preparation may be shared by
   * several views (two sprites showing the same asset), so only the first
   * ownership transfer is free; later ones retain the resident textures.
   */
  claimed?: boolean;
}

export interface ScenePreparation {
  readonly generation: number;
  readonly world: SceneWorldSnapshot;
  readonly assets: AssetUrlMap;
  readonly stale: boolean;
  /** Internal bookkeeping consumed by the surface. */
  readonly resourceId: number;
  readonly resources: Map<string, PreparedAsset>;
  readonly background: PreparedAsset | null;
}

export interface SceneFrameApplyOptions {
  /**
   * `playhead` positions every decorative loop from the frame's elapsed time
   * (deterministic scrubbing); `keep` leaves the loops on their own clock,
   * which is what playback needs so fast-forward never speeds them up.
   */
  phase?: "playhead" | "keep";
}

export interface SceneActiveEffects {
  flash: ActiveScreenEffect | null;
  shake: ActiveScreenEffect | null;
  elapsedMs: number;
}

export interface SceneVideoHandle {
  readonly element: HTMLVideoElement;
  updateFrame(): void;
  setFrame(frame: SceneObjectFrame): void;
  release(): void;
}

/** One character instance a timeline needs before it can start. */
export interface SceneCharacterRequest {
  id: string;
  asset: string;
}

/** Inheritance seed for a timeline: what the scene currently shows. */
export interface SceneBases {
  sprites: Record<string, SpriteSnapshot>;
  buttons: Record<string, ButtonSnapshot>;
  camera: CameraSnapshot;
  bgmVolume: number;
}

export type SceneVisualCue = Extract<
  PresentationCue,
  {
    type:
      | "background_transition"
      | "sprite_tween"
      | "clear_scene"
      | "camera_tween"
      | "screen_effect";
  }
>;

export interface SceneCueContext {
  assets: AssetUrlMap;
  signal: AbortSignal;
  getRate(): number;
}

export interface SceneSurfaceOptions {
  canvas: HTMLCanvasElement;
  diagnostic?: (message: string) => void;
  animations?: AnimationMap;
  /** Test seam; defaults to the real Pixi kit. */
  kit?: SceneKit;
  /** Test seam for the render loop clock. */
  requestFrame?: SceneFrameRequest;
  cancelFrame?: SceneFrameCancel;
  /** Test seam for image decoding. */
  textureLoader?: (url: string) => Promise<SceneTextureLike>;
  textureBudget?: number;
}

type VideoTrack = Extract<TimelineTrack, { type: "video" }>;
const BACKGROUND_ID = "__background__";
/** Cue-conflict key for background transitions; the newest one owns the view. */
const BACKGROUND_CUE = "background";
/** Cue-conflict key prefix for one sprite instance. */
const SPRITE_CUE = "sprite:";

interface SceneSpriteView {
  id: string;
  label: string;
  /** Revision of `source` the view was created from. */
  version: string;
  source: ImageAssetSource;
  sprite: SceneSpriteLike;
  /** Decoded pixels in frame order; one entry for a static asset. */
  textures: SceneTextureLike[];
  /** Urls this instance keeps referenced in the texture store. */
  refs: string[];
  player: FrameSequencePlayer;
  unsubscribe: () => void;
}

interface SceneVideoState {
  element: HTMLVideoElement;
  source: SceneVideoSourceLike;
  view: SceneSpriteLike;
  track: VideoTrack;
}

export class SceneSurface {
  readonly #kit: SceneKit;
  readonly #canvas: HTMLCanvasElement;
  readonly #diagnostic: (message: string) => void;
  readonly #application: SceneApplicationLike;
  readonly #cameraLayer: SceneNodeLike;
  readonly #backgrounds: SceneNodeLike;
  readonly #characters: SceneNodeLike;
  readonly #videos: SceneNodeLike;
  readonly #effects: SceneNodeLike;
  readonly #loops = new FrameLoopRegistry();
  readonly #sprites = new Map<string, SceneSpriteView>();
  readonly #store: SceneTextureStore;
  readonly #geometry: SceneSpriteGeometry;
  #background: SceneSpriteView | null = null;
  #video: SceneVideoState | null = null;
  #flash: SceneGraphicsLike | null = null;
  #effectsState: SceneActiveEffects | null = null;
  #cueShake = { x: 0, y: 0 };
  #camera: CameraSnapshot = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
  #evaluated: SceneFrame | null = null;
  #current: SceneFrame | null = null;
  #overrides: SceneOverrides = EMPTY_SCENE_OVERRIDES;
  #assets: AssetUrlMap = {};
  #animations: AnimationMap = {};
  #resources = 0;
  #preparations = new Map<number, ScenePreparation>();
  #prepareGeneration = 0;
  #prepareAbort: AbortController | null = null;
  /**
   * Lifecycle generation.
   *
   * Bumped by every reset, dispose, world commit and full clear.  A cue
   * executor captures it before awaiting and refuses to write or commit once
   * the surface has moved on, so a late callback can never modify the next
   * generation or a destroyed object.
   */
  #sceneGeneration = 0;
  /** Aborts the frame loop of in-flight cue animations when a generation ends. */
  #cueAbort = new AbortController();
  /** Latest writer per cue kind/instance: an older cue never settles state. */
  readonly #cueTokens = new Map<string, number>();
  /**
   * Latest *request* per cue kind, taken before a replacement resource is
   * awaited.  A request superseded while its pixels still decode must never
   * commit, even when the newer request turns out to be a same-asset no-op
   * that never starts an animation of its own.
   */
  readonly #cueRequestTokens = new Map<string, number>();
  /** Outgoing views of in-flight cross-fades, released exactly once. */
  readonly #stagedViews = new Set<SceneSpriteView>();
  /** Cue-owned flash nodes, released exactly once. */
  readonly #cueFlashes = new Set<SceneGraphicsLike>();
  #loop: SceneRenderLoop | null = null;
  #initialization: Promise<void> | null = null;
  readonly #requestFrame: SceneFrameRequest | undefined;
  readonly #cancelFrame: SceneFrameCancel | undefined;
  #paused = false;
  #decorativeRunning = true;
  #disposed = false;

  constructor(options: SceneSurfaceOptions) {
    this.#kit = options.kit ?? pixiSceneKit();
    this.#canvas = options.canvas;
    this.#diagnostic = options.diagnostic ?? ((): void => undefined);
    this.#animations = options.animations ?? {};
    this.#application = this.#kit.application();
    this.#cameraLayer = this.#kit.container();
    this.#backgrounds = this.#kit.container();
    this.#characters = this.#kit.container();
    this.#videos = this.#kit.container();
    this.#effects = this.#kit.container();
    this.#store = new SceneTextureStore({
      load: options.textureLoader ?? ((url) => this.#loadTexture(url)),
      budget:
        options.textureBudget ??
        textureBudgetFor(MIN_SESSION_TEXTURES, this.#animations),
    });
    this.#geometry = {
      spriteSize: (asset) => this.#spriteSize(asset),
    };
    this.#requestFrame = options.requestFrame;
    this.#cancelFrame = options.cancelFrame;
  }

  /** True after `init()` resolved and before `dispose()`. */
  get initialized(): boolean {
    return this.#initialization !== null && !this.#disposed;
  }

  get animations(): AnimationMap {
    return this.#animations;
  }

  /**
   * Ids of the decorative frame loops this surface currently owns.
   *
   * Read-only diagnostic seam: tests use it to prove that a cancelled cue and
   * a reset leave no player behind in the registry.
   */
  get loopIds(): readonly string[] {
    return this.#loops.ids();
  }

  /** Frame geometry provider used by the timelines that evaluate frames. */
  get geometry(): SceneSpriteGeometry {
    return this.#geometry;
  }

  get camera(): CameraSnapshot {
    return this.#camera;
  }

  async init(): Promise<void> {
    if (this.#disposed) throw new Error("SceneSurface 已销毁");
    if (this.#initialization !== null) return this.#initialization;
    this.#initialization = (async (): Promise<void> => {
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
        // Exactly one scheduler renders this application; Pixi's automatic
        // ticker would draw a second time per browser frame.
        autoStart: false,
      });
      this.#cameraLayer.sortableChildren = true;
      this.#backgrounds.zIndex = -1_000_000;
      this.#cameraLayer.addChild(this.#backgrounds);
      this.#cameraLayer.addChild(this.#characters);
      this.#cameraLayer.addChild(this.#videos);
      this.#application.stage.addChild(this.#cameraLayer);
      this.#application.stage.addChild(this.#effects);
      this.#applyCamera();
      this.#application.render();
      const loop = new SceneRenderLoop({
        render: () => this.#application.render(),
        tick: (deltaMs) => this.#tickDecorations(deltaMs),
        ...(this.#requestFrame === undefined
          ? {}
          : { request: this.#requestFrame }),
        ...(this.#cancelFrame === undefined
          ? {}
          : { cancel: this.#cancelFrame }),
      });
      this.#loop = loop;
      loop.start();
    })();
    return this.#initialization;
  }

  setAnimations(animations: AnimationMap): void {
    this.#animations = animations;
    this.#store.setBudget(textureBudgetFor(MIN_SESSION_TEXTURES, animations));
  }

  // -- world -----------------------------------------------------------------

  /**
   * Decodes every resource a replacement world needs, without touching the
   * display list.  Returns a token that `applyWorld` can commit; the returned
   * token reports `stale` as soon as a newer preparation or a reset supersedes
   * it, and callers may discard it instead of committing.
   */
  async prepare(
    request: ScenePreparationRequest,
    signal?: AbortSignal,
  ): Promise<ScenePreparation | null> {
    if (this.#disposed) return null;
    this.#prepareAbort?.abort();
    const abort = new AbortController();
    this.#prepareAbort = abort;
    const generation = ++this.#prepareGeneration;
    const aborted = (): boolean =>
      this.#disposed ||
      abort.signal.aborted ||
      (signal?.aborted ?? false) ||
      generation !== this.#prepareGeneration;
    const isStale = (): boolean => generation !== this.#prepareGeneration;
    const resourceId = ++this.#resources;
    const preparation: ScenePreparation = {
      generation,
      world: request.world,
      assets: request.assets,
      resourceId,
      resources: new Map<string, PreparedAsset>(),
      background: null,
      get stale(): boolean {
        return isStale();
      },
    };
    const acquired: PreparedAsset[] = [];
    const releaseAcquired = (): void => {
      for (const asset of acquired) this.#releasePrepared(asset);
      acquired.length = 0;
    };
    try {
      const wanted = new Set<string>(
        Object.values(request.world.sprites).map((s) => s.asset),
      );
      // A logical asset can hold more than one role in the same world: a
      // background id may also be a sprite's artwork.  Remember which ids are
      // sprite-owned so the preparation carries them under `resources` as
      // well as `background`; otherwise `applyWorld` finds no pixels for the
      // sprite and silently skips it.
      const spriteAssets = new Set(wanted);
      if (request.world.background !== null)
        wanted.add(request.world.background);
      for (const asset of wanted) {
        if (aborted()) {
          releaseAcquired();
          return null;
        }
        const prepared = await this.#prepareAsset(asset, request.assets);
        if (prepared === null) continue;
        acquired.push(prepared);
        if (aborted()) {
          releaseAcquired();
          return null;
        }
        if (spriteAssets.has(asset)) {
          preparation.resources.set(asset, prepared);
        }
        if (request.world.background === asset) {
          (preparation as { background: PreparedAsset | null }).background =
            prepared;
        }
      }
    } catch (error) {
      releaseAcquired();
      throw error;
    }
    this.#preparations.set(resourceId, preparation);
    return preparation;
  }

  /**
   * Commits a preparation synchronously.
   *
   * Returns `false` when the token is stale: a superseded request never
   * replaces what is currently on screen.
   */
  applyWorld(preparation: ScenePreparation | null): boolean {
    if (this.#disposed) return false;
    if (preparation === null || preparation.stale) {
      if (preparation !== null) this.discardPreparation(preparation);
      return false;
    }
    // A committed world is a new visual generation: cues that are still in
    // flight release what they detached and give up settling their pose.
    this.#startVisualGeneration();
    const world = preparation.world;
    this.#assets = preparation.assets;
    this.#commitBackground(preparation.background);
    const wanted = new Set(Object.keys(world.sprites));
    for (const [id, view] of [...this.#sprites]) {
      if (wanted.has(id)) continue;
      this.#releaseView(view);
      this.#sprites.delete(id);
    }
    for (const [id, state] of Object.entries(world.sprites)) {
      const view = this.#sprites.get(id);
      const prepared = preparation.resources.get(state.asset);
      // A view is only reused for the *same revision* of its asset: an edited
      // animation under the same logical id must replace the view and restart
      // its loop instead of silently keeping the old frames and phase.
      const keepsView =
        view !== undefined &&
        (prepared === undefined
          ? view.label === this.#assetLabel(state.asset, preparation.assets)
          : view.version === prepared.version);
      if (keepsView) {
        // Same asset revision: keep the loop position and apply the pose.
        applySprite(view.sprite, state);
        continue;
      }
      if (view !== undefined) {
        this.#releaseView(view);
        this.#sprites.delete(id);
      }
      if (prepared === undefined) continue;
      const next = this.#createView(id, prepared, this.#characters);
      if (next === null) continue;
      applySprite(next.sprite, state);
      this.#sprites.set(id, next);
    }
    this.#camera = { ...world.camera };
    this.discardPreparation(preparation);
    this.#applyCamera();
    this.#applyZOrder();
    this.#requestRender();
    return true;
  }

  /**
   * Releases the parts of a preparation that no committed view claimed.
   *
   * Resources a view took over stay alive with that view; everything else
   * (a superseded request, or assets that were not needed after all) is
   * released here so a stale request can never leak a texture.
   */
  discardPreparation(preparation: ScenePreparation): void {
    this.#preparations.delete(preparation.resourceId);
    const assets = [
      ...preparation.resources.values(),
      ...(preparation.background === null ? [] : [preparation.background]),
    ];
    for (const asset of assets) this.#releasePrepared(asset);
    preparation.resources.clear();
  }

  /**
   * Drops every object, media element and pending screen effect while keeping
   * the initialized Pixi application, so a host can reuse the same canvas for
   * the next session cheaply.
   */
  reset(): void {
    if (this.#disposed) return;
    this.#startVisualGeneration();
    this.#prepareGeneration += 1;
    this.#prepareAbort?.abort();
    this.#prepareAbort = null;
    for (const preparation of [...this.#preparations.values()]) {
      this.discardPreparation(preparation);
    }
    this.#releaseVideo();
    this.#clearBackground();
    for (const view of this.#sprites.values()) this.#releaseView(view);
    this.#sprites.clear();
    this.#loops.clear();
    this.#clearEffects();
    this.#overrides = EMPTY_SCENE_OVERRIDES;
    this.#evaluated = null;
    this.#current = null;
    this.#camera = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
    this.#applyCamera();
    this.#applyZOrder();
    this.#requestRender();
  }

  // -- frames ----------------------------------------------------------------

  /**
   * Applies one evaluated frame synchronously.
   *
   * Reconstruction is deterministic: the same frame and the same overrides
   * always produce the same pixels, which is what editor scrubbing and the
   * parity harness rely on.
   */
  applyFrame(frame: SceneFrame, options: SceneFrameApplyOptions = {}): void {
    if (this.#disposed) return;
    this.#evaluated = frame;
    if (options.phase === "playhead") {
      this.#refreshFrameTextures(this.#loops.seek(frame.elapsed_ms));
    }
    this.#applyCurrent();
  }

  /** Current frame with interactive overrides merged in. */
  readFrame(): SceneFrame {
    if (this.#current !== null) return this.#current;
    return {
      elapsed_ms: this.#evaluated?.elapsed_ms ?? 0,
      camera: { ...this.#camera },
      objects: [],
      bgm_volume: this.#evaluated?.bgm_volume ?? 1,
    };
  }

  setOverrides(overrides: SceneOverrides | null): void {
    this.#overrides = overrides ?? EMPTY_SCENE_OVERRIDES;
    this.#applyCurrent();
  }

  readOverrides(): SceneOverrides {
    return this.#overrides;
  }

  setObjectOverride(id: string, patch: SceneObjectPatch): void {
    const objects = new Map(this.#overrides.objects);
    objects.set(id, { ...(objects.get(id) ?? {}), ...patch });
    this.#overrides = { objects, camera: this.#overrides.camera };
    this.#applyCurrent();
  }

  setCameraOverride(patch: Partial<CameraSnapshot>): void {
    this.#overrides = {
      objects: this.#overrides.objects,
      camera: { ...this.#overrides.camera, ...patch },
    };
    this.#applyCurrent();
  }

  /** Clears every interactive override back to the evaluated state. */
  clearOverrides(): void {
    this.setOverrides(null);
  }

  /** Topmost object under a design-space point of the current frame. */
  hitTest(x: number, y: number): SceneObjectFrame | null {
    return hitTestSceneFrame(this.readFrame(), { x, y }, this.#currentShake());
  }

  // -- effects ---------------------------------------------------------------

  /**
   * Sets the timeline-derived screen effects for the current playhead.
   *
   * Flash and shake are both derived from the same position, so scrubbing,
   * pausing and playing all agree, and the two effects coexist because shake is
   * composed into the camera transform instead of overwriting it.
   */
  setActiveEffects(effects: SceneActiveEffects | null): void {
    this.#effectsState = effects;
    this.#applyEffects();
    this.#applyCamera();
    this.#requestRender();
  }

  clearActiveEffects(): void {
    this.setActiveEffects(null);
  }

  // -- cues ------------------------------------------------------------------

  /** Executes one ordinary visual cue on the shared object model. */
  async runCue(cue: SceneVisualCue, context: SceneCueContext): Promise<void> {
    switch (cue.type) {
      case "background_transition":
        await this.#transitionBackground(cue, context);
        return;
      case "sprite_tween":
        await this.#tweenSprite(cue, context);
        return;
      case "clear_scene":
        await this.#clearScene(cue.duration_ms, cue.easing, context);
        return;
      case "camera_tween":
        await this.#tweenCamera(cue.to, cue.duration_ms, cue.easing, context);
        return;
      case "screen_effect":
        await this.#screenEffect(cue.effect, cue.duration_ms, context);
        return;
      default:
        cue satisfies never;
    }
  }

  // -- media -----------------------------------------------------------------

  /** Builds the Pixi side of a timeline video. */
  async attachVideo(
    element: HTMLVideoElement,
    track: VideoTrack,
  ): Promise<SceneVideoHandle> {
    this.#releaseVideo();
    const source = this.#kit.videoSource(element);
    try {
      await source.load();
    } catch (error) {
      source.destroy();
      throw error;
    }
    if (this.#disposed) {
      source.destroy();
      throw new Error("SceneSurface 已销毁");
    }
    source.autoUpdate = false;
    source.update();
    const view = this.#kit.videoSprite(source);
    view.anchor.set(0, 0);
    this.#videos.addChild(view);
    this.#video = { element, source, view, track };
    const handle: SceneVideoHandle = {
      element,
      updateFrame: () => source.update(),
      setFrame: (frame) => this.#applyVideoFrame(frame),
      release: () => this.#releaseVideo(handle),
    };
    return handle;
  }

  /**
   * What the live scene currently shows, used as a timeline's inheritance seed
   * when a cue sequence continues on the screen instead of restoring a
   * snapshot.
   */
  captureBases(): SceneBases {
    const sprites: Record<string, SpriteSnapshot> = {};
    for (const view of this.#sprites.values()) {
      sprites[view.id] = {
        asset: view.source.asset,
        ...readSprite(view.sprite),
      };
    }
    return {
      sprites,
      buttons: {},
      camera: { ...this.#camera },
      bgmVolume: 1,
    };
  }

  /**
   * Prepares the character instances a timeline inherits.
   *
   * Everything is decoded before the first replacement touches the display
   * list, and a superseded request releases what it acquired and returns
   * `false` without changing the scene.
   */
  async ensureCharacters(
    requests: readonly SceneCharacterRequest[],
    assets: AssetUrlMap,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    if (this.#disposed) return false;
    const pending: {
      request: SceneCharacterRequest;
      prepared: PreparedAsset;
    }[] = [];
    try {
      for (const request of requests) {
        const current = this.#sprites.get(request.id);
        if (
          current !== undefined &&
          this.#showsAssetRevision(current, request.asset, assets)
        ) {
          continue;
        }
        if (!isCurrent()) return false;
        const prepared = await this.#acquireAsset(request.asset, assets);
        if (!isCurrent()) {
          this.#releasePrepared(prepared);
          return false;
        }
        pending.push({ request, prepared });
      }
    } catch (error) {
      for (const item of pending) this.#releasePrepared(item.prepared);
      throw error;
    }
    this.#assets = assets;
    for (const { request, prepared } of pending) {
      const current = this.#sprites.get(request.id);
      if (current !== undefined) {
        this.#sprites.delete(request.id);
        this.#releaseView(current);
      }
      const view = this.#createView(request.id, prepared, this.#characters);
      if (view === null) {
        this.#releasePrepared(prepared);
        continue;
      }
      applySprite(view.sprite, {
        asset: request.asset,
        x: 960,
        y: 1080,
        scale: 1,
        scale_x: 1,
        scale_y: 1,
        rotation_deg: 0,
        opacity: 1,
        z: 0,
      });
      this.#sprites.set(request.id, view);
    }
    this.#applyZOrder();
    this.#requestRender();
    return true;
  }

  // -- host state ------------------------------------------------------------

  /**
   * Freezes or resumes decorative frame loops.
   *
   * A host pause freezes the loops in place; the accumulated clock is not
   * repaid on resume, matching the shipped decoration rules.
   */
  setPaused(paused: boolean): void {
    this.#paused = paused;
    this.#loops.setPaused(paused);
  }

  /** Suspends wall-clock decoration (used while a preview is scrubbing). */
  setDecorativeRunning(running: boolean): void {
    this.#decorativeRunning = running;
  }

  captureThumbnail(): string | null {
    try {
      const thumbnail = document.createElement("canvas");
      thumbnail.width = 320;
      thumbnail.height = 180;
      const context = thumbnail.getContext("2d");
      if (context === null) return null;
      // preserveDrawingBuffer is deliberately disabled for normal rendering;
      // extracting the stage keeps thumbnails reliable without forcing a GPU
      // readback on every frame.
      const source = this.#application.renderer.extract.canvas(
        this.#application.stage,
      );
      context.drawImage(source as unknown as CanvasImageSource, 0, 0, 320, 180);
      return thumbnail.toDataURL("image/png", 0.86);
    } catch (error) {
      console.error("Could not capture save thumbnail", error);
      return null;
    }
  }

  /** Idempotent teardown: objects, media, textures, scheduler and renderer. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#startVisualGeneration();
    this.#prepareGeneration += 1;
    this.#prepareAbort?.abort();
    this.#prepareAbort = null;
    for (const preparation of [...this.#preparations.values()]) {
      this.discardPreparation(preparation);
    }
    this.#releaseVideo();
    this.#clearBackground();
    for (const view of this.#sprites.values()) this.#releaseView(view);
    this.#sprites.clear();
    this.#loops.clear();
    this.#clearEffects();
    this.#loop?.dispose();
    this.#loop = null;
    this.#store.destroy();
    this.#application.destroy({ removeView: false }, { children: true });
  }

  // -- internals: world ------------------------------------------------------

  #commitBackground(prepared: PreparedAsset | null): void {
    if (prepared === null) {
      // A world without a background clears the previous scene's artwork; the
      // shipped host did the same, and leaving it on screen mixed two scenes.
      this.#clearBackground();
      return;
    }
    if (
      this.#background !== null &&
      this.#background.version === prepared.version
    ) {
      // Same pixels: keep the live instance and its frame phase, and heal a
      // cross-fade that was cancelled half-way.
      this.#background.sprite.alpha = 1;
      return;
    }
    const previous = this.#background;
    const view = this.#createBackgroundView(prepared);
    if (view === null) return;
    this.#background = view;
    if (previous !== null) this.#releaseView(previous);
  }

  /**
   * Decodes every frame of an asset, replacing a broken frame with the nearest
   * usable one so a single bad file can never block a story gate.  Only an
   * asset with no usable frame at all fails.
   */
  async #prepareAsset(
    asset: string,
    assets: AssetUrlMap,
  ): Promise<PreparedAsset | null> {
    const source = resolveImageAsset(asset, assets, this.#animations);
    if (source === undefined) {
      throw new Error(`素材尚未解析: ${asset}`);
    }
    const urls = animationUrls(source);
    // A ping-pong animation repeats frame urls by design.  Each distinct url is
    // decoded and referenced once, so the references the store holds equal the
    // references a view later releases; the displayed frame list still keeps
    // every occurrence in authored order.
    const distinct = [...new Set(urls)];
    const decoded = new Map<string, SceneTextureLike>();
    for (const url of distinct) {
      try {
        decoded.set(url, await this.#store.acquire(url));
      } catch (error) {
        const frames = source.animation?.frames ?? [];
        for (const [index, candidate] of urls.entries()) {
          if (candidate !== url) continue;
          this.#diagnostic(
            `图片动画 ${source.animation?.id ?? source.asset} 第 ${index + 1} 帧（素材 ${frames[index]?.asset ?? asset}）加载失败：${errorMessage(error)}`,
          );
        }
      }
    }
    const loaded: (SceneTextureLike | null)[] = urls.map(
      (url) => decoded.get(url) ?? null,
    );
    const successful: number[] = [];
    for (const [index, texture] of loaded.entries()) {
      if (texture !== null) successful.push(index);
    }
    const first = successful[0];
    if (first === undefined) {
      throw new Error(
        `图片动画 ${source.animation?.id ?? source.asset} 没有可用帧`,
      );
    }
    for (let index = 0; index < loaded.length; index += 1) {
      if (loaded[index] !== null) continue;
      let nearest = first;
      for (const candidate of successful) {
        if (Math.abs(candidate - index) < Math.abs(nearest - index)) {
          nearest = candidate;
        }
      }
      loaded[index] = loaded[nearest] ?? null;
    }
    const textures: SceneTextureLike[] = [];
    for (const texture of loaded) {
      if (texture !== null) textures.push(texture);
    }
    return {
      asset,
      label: assetLabel(source),
      version: imageAssetSourceVersion(source),
      source,
      // Only urls whose pixels were actually acquired.  A failed frame is
      // rendered from its nearest usable neighbour through `textures`, but no
      // reference is held for it: releasing this preparation must never drop
      // the reference of a later, successful retry of the same url.
      urls: distinct.filter((url) => decoded.has(url)),
      textures,
    };
  }

  #releasePrepared(prepared: PreparedAsset): void {
    if (prepared.claimed ?? false) return;
    prepared.claimed = true;
    this.#store.releaseAll(prepared.urls);
  }

  /**
   * Transfers the preparation's texture references to one view.
   *
   * The first owner reuses the references the preparation acquired; further
   * owners retain the already resident textures so every view releases exactly
   * the references it holds.
   */
  #claim(prepared: PreparedAsset): string[] {
    if (!(prepared.claimed ?? false)) {
      prepared.claimed = true;
      return prepared.urls;
    }
    return prepared.urls.filter((url) => this.#store.retain(url));
  }

  /** Acquires one asset's pixels for an immediate cue (not a world commit). */
  async #acquireAsset(
    asset: string,
    assets: AssetUrlMap,
  ): Promise<PreparedAsset> {
    const prepared = await this.#prepareAsset(asset, assets);
    if (prepared === null) throw new Error(`素材尚未解析: ${asset}`);
    return prepared;
  }

  #createView(
    id: string,
    prepared: PreparedAsset,
    parent: SceneNodeLike,
  ): SceneSpriteView | null {
    const texture = prepared.textures[0];
    if (texture === undefined) return null;
    const sprite = this.#kit.sprite(texture);
    sprite.anchor.set(0.5, 1);
    sprite.label = prepared.label;
    parent.addChild(sprite);
    const view: SceneSpriteView = {
      id,
      label: prepared.label,
      version: prepared.version,
      source: prepared.source,
      sprite,
      textures: prepared.textures,
      refs: this.#claim(prepared),
      player: this.#loops.ensure(id, prepared.source),
      unsubscribe: () => undefined,
    };
    view.unsubscribe = view.player.subscribe((changed: FrameSequencePlayer) => {
      this.#applyFrameTexture(view, changed.frameIndex());
    });
    this.#applyFrameTexture(view, view.player.frameIndex());
    return view;
  }

  #createBackgroundView(prepared: PreparedAsset): SceneSpriteView | null {
    const view = this.#createView(BACKGROUND_ID, prepared, this.#backgrounds);
    if (view === null) return null;
    // Character sprites use a centre-bottom anchor, while background cover
    // geometry below is expressed from the image's top-left corner.  Keeping
    // the character anchor here moves a 1920x1080 background almost entirely
    // outside the viewport (its centre/bottom would sit at 0,0).
    view.sprite.anchor.set(0, 0);
    const texture = view.textures[0];
    const width =
      prepared.source.animation === undefined
        ? (texture?.width ?? DESIGN_WIDTH)
        : prepared.source.width;
    const height =
      prepared.source.animation === undefined
        ? (texture?.height ?? DESIGN_HEIGHT)
        : prepared.source.height;
    const scale = Math.max(DESIGN_WIDTH / width, DESIGN_HEIGHT / height);
    view.sprite.scale.set(scale);
    view.sprite.position.set(
      (DESIGN_WIDTH - width * scale) / 2,
      (DESIGN_HEIGHT - height * scale) / 2,
    );
    return view;
  }

  #applyFrameTexture(view: SceneSpriteView, index: number): void {
    if (index < 0) return;
    const texture = view.textures[index] ?? view.textures[0];
    if (texture === undefined) return;
    view.sprite.texture = texture;
  }

  #refreshFrameTextures(ids: readonly string[]): void {
    for (const id of ids) {
      const view =
        id === BACKGROUND_ID
          ? this.#background
          : (this.#sprites.get(id) ?? null);
      if (view === null) continue;
      const player = this.#loops.player(id);
      this.#applyFrameTexture(view, player?.frameIndex() ?? 0);
    }
  }

  #releaseView(view: SceneSpriteView): void {
    view.unsubscribe();
    view.unsubscribe = () => undefined;
    // Only drop the loop when this view still owns it: a replacement view for
    // the same id has already installed its own player.
    if (this.#loops.player(view.id) === view.player)
      this.#loops.release(view.id);
    view.sprite.destroy();
    this.#store.releaseAll(view.refs);
  }

  // -- internals: lifecycle --------------------------------------------------

  /**
   * Starts a new visual generation.
   *
   * In-flight cue animations are stopped (their pending frames are cancelled)
   * and every view a cross-fade had detached is released, so a reset, a world
   * commit or a full clear can never race a cue that is still running.
   */
  #startVisualGeneration(): number {
    this.#sceneGeneration += 1;
    this.#cueAbort.abort();
    this.#cueAbort = new AbortController();
    this.#releaseStagedViews();
    return this.#sceneGeneration;
  }

  #isCurrent(generation: number): boolean {
    return !this.#disposed && generation === this.#sceneGeneration;
  }

  /** Registers a cue of one kind and returns its "latest writer" token. */
  #beginCue(key: string): number {
    const token = (this.#cueTokens.get(key) ?? 0) + 1;
    this.#cueTokens.set(key, token);
    return token;
  }

  /**
   * Registers the *start* of a cue request and returns its token.
   *
   * Taking this before the resource await makes start order decide the winner
   * instead of completion order, so a slower older cue can never commit over a
   * newer request (including a null clear or a same-asset no-op).
   */
  #beginCueRequest(key: string): number {
    const token = (this.#cueRequestTokens.get(key) ?? 0) + 1;
    this.#cueRequestTokens.set(key, token);
    return token;
  }

  /** True while this request is still the newest of its kind. */
  #isLatestCueRequest(generation: number, key: string, token: number): boolean {
    return (
      this.#isCurrent(generation) && this.#cueRequestTokens.get(key) === token
    );
  }

  /**
   * True while this cue is still the newest writer of its kind and no newer
   * visual generation started.  Overlapping cues of the same kind therefore
   * resolve as "latest start wins", with an equal start decided by the order
   * the cues actually began.
   */
  #isLatestCue(generation: number, key: string, token: number): boolean {
    return this.#isCurrent(generation) && this.#cueTokens.get(key) === token;
  }

  /** Takes ownership of an outgoing view a cross-fade detached. */
  #stageView(view: SceneSpriteView): void {
    this.#stagedViews.add(view);
  }

  /** Releases a staged outgoing view exactly once. */
  #releaseStagedView(view: SceneSpriteView): void {
    if (!this.#stagedViews.delete(view)) return;
    this.#releaseView(view);
  }

  #releaseStagedViews(): void {
    for (const view of [...this.#stagedViews]) this.#releaseStagedView(view);
  }

  /** Releases the staged outgoing views of one instance (the background). */
  #releaseStagedViewsFor(id: string): void {
    for (const view of [...this.#stagedViews]) {
      if (view.id === id) this.#releaseStagedView(view);
    }
  }

  #clearBackground(): void {
    const previous = this.#background;
    this.#background = null;
    if (previous !== null) this.#releaseView(previous);
    this.#releaseStagedViewsFor(BACKGROUND_ID);
  }

  #assetLabel(asset: string, assets: AssetUrlMap): string {
    const source = resolveImageAsset(asset, assets, this.#animations);
    if (source !== undefined) return assetLabel(source);
    return assets[asset] ?? asset;
  }

  /**
   * True when a view already shows exactly what an asset resolves to.
   *
   * The whole source revision is compared, not only the logical label, so an
   * edited animation (new frames, durations or measured geometry) under the
   * same asset id replaces the view instead of silently keeping its old
   * pixels.  Assets that do not resolve keep the label identity, so a missing
   * asset never forces a rebuild of a view that already shows it.
   */
  #showsAssetRevision(
    view: SceneSpriteView,
    asset: string,
    assets: AssetUrlMap,
  ): boolean {
    const source = resolveImageAsset(asset, assets, this.#animations);
    if (source === undefined) {
      return view.label === (assets[asset] ?? asset);
    }
    return view.version === imageAssetSourceVersion(source);
  }

  #spriteSize(asset: string): { width: number; height: number } {
    const source = resolveImageAsset(asset, this.#assets, this.#animations);
    if (source === undefined) {
      return { width: DEFAULT_SPRITE_WIDTH, height: DEFAULT_SPRITE_HEIGHT };
    }
    if (source.animation !== undefined) {
      // An animated asset keeps one layout size for the whole loop, so the
      // declared animation size is used instead of the current frame's.
      return { width: source.width, height: source.height };
    }
    const texture = this.#store.texture(source.url);
    if (texture !== undefined) {
      return { width: texture.width, height: texture.height };
    }
    return { width: DEFAULT_SPRITE_WIDTH, height: DEFAULT_SPRITE_HEIGHT };
  }

  // -- internals: frames -----------------------------------------------------

  #applyCurrent(): void {
    const evaluated = this.#evaluated;
    this.#current =
      evaluated === null
        ? null
        : mergeSceneOverrides(evaluated, this.#overrides, this.#geometry);
    const frame = this.#current;
    if (frame !== null) {
      this.#camera = { ...frame.camera };
      for (const object of frame.objects) this.#applyObject(object);
    }
    this.#applyEffects();
    this.#applyCamera();
    this.#applyZOrder();
    this.#requestRender();
  }

  #applyObject(object: SceneObjectFrame): void {
    if (object.kind === "sprite") {
      const view = this.#sprites.get(object.id);
      if (view === undefined) return;
      applySpriteTransform(view.sprite, object);
      return;
    }
    if (object.kind === "video") {
      this.#applyVideoFrame(object);
    }
  }

  #applyVideoFrame(frame: SceneObjectFrame): void {
    const video = this.#video;
    if (video === null) return;
    const view = video.view;
    const naturalWidth = Math.max(1, video.element.videoWidth);
    const naturalHeight = Math.max(1, video.element.videoHeight);
    if (video.track.fit === "stretch") {
      view.position.set(frame.x, frame.y);
      view.width = frame.width;
      view.height = frame.height;
    } else {
      const factor =
        video.track.fit === "cover"
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

  #applyZOrder(): void {
    // A cue that resumes after the surface was torn down must not write into
    // destroyed Pixi nodes.
    if (this.#disposed) return;
    let maxSpriteZ = 0;
    for (const view of this.#sprites.values()) {
      maxSpriteZ = Math.max(maxSpriteZ, Math.round(view.sprite.zIndex));
    }
    this.#characters.zIndex = maxSpriteZ;
    this.#videos.zIndex =
      this.#video === null ? 0 : Math.round(this.#video.view.zIndex);
  }

  // -- internals: effects and camera ----------------------------------------

  #currentShake(): { x: number; y: number } {
    const timeline = shakeOffset(
      this.#effectsState?.elapsedMs ?? 0,
      this.#effectsState?.shake ?? null,
    );
    return {
      x: timeline.x + this.#cueShake.x,
      y: timeline.y + this.#cueShake.y,
    };
  }

  #applyEffects(): void {
    const effects = this.#effectsState;
    const alpha =
      effects === null ? 0 : flashAlpha(effects.elapsedMs, effects.flash);
    if (alpha <= 0) {
      this.#flash?.destroy();
      this.#flash = null;
      return;
    }
    if (this.#flash === null) {
      this.#flash = this.#kit.graphics();
      this.#flash.rect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT).fill(0xffffff);
      this.#effects.addChild(this.#flash);
    }
    this.#flash.alpha = alpha;
  }

  #clearEffects(): void {
    this.#effectsState = null;
    this.#cueShake = { x: 0, y: 0 };
    this.#flash?.destroy();
    this.#flash = null;
    this.#releaseCueFlashes();
  }

  /** Destroys every flash node a cue still owns, exactly once. */
  #releaseCueFlashes(): void {
    for (const flash of [...this.#cueFlashes]) {
      this.#cueFlashes.delete(flash);
      flash.destroy();
    }
  }

  #applyCamera(): void {
    // An aborted cue's `finally` (and any late host call) can run after
    // `dispose()` destroyed the camera layer; writing a destroyed node's
    // position throws in Pixi.
    if (this.#disposed) return;
    const transform = composeWorldTransform(this.#camera, this.#currentShake());
    // Base camera and shake are combined once, here, so no later camera
    // application can silently drop an in-flight shake.
    this.#cameraLayer.position.set(transform.positionX, transform.positionY);
    this.#cameraLayer.pivot.set(transform.pivotX, transform.pivotY);
    this.#cameraLayer.scale.set(transform.scale);
    this.#cameraLayer.rotation = transform.rotation;
  }

  #tickDecorations(deltaMs: number): boolean {
    if (!this.#decorativeRunning || this.#paused || deltaMs <= 0) return false;
    const changed = this.#loops.advance(deltaMs);
    if (changed.length === 0) return false;
    this.#refreshFrameTextures(changed);
    return true;
  }

  #requestRender(): void {
    if (this.#disposed) return;
    if (this.#loop === null) {
      if (this.#initialization !== null) this.#application.render();
      return;
    }
    this.#loop.schedule();
  }

  #runAnimation(
    durationMs: number,
    easing: Easing,
    apply: (progress: number) => void,
    context: SceneCueContext,
  ): Promise<void> {
    // The cue animation is aborted by its own signal and by the surface ending
    // the current visual generation (reset, dispose, world commit, clear), so
    // its pending frame is always cancelled even when the host never aborts.
    const lifecycle = new AbortController();
    const lifecycleSignal = this.#cueAbort.signal;
    const abort = (): void => lifecycle.abort();
    context.signal.addEventListener("abort", abort, { once: true });
    lifecycleSignal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted || lifecycleSignal.aborted) abort();
    return animate(
      durationMs,
      easing,
      (progress) => {
        apply(progress);
        this.#requestRender();
      },
      lifecycle.signal,
      {
        getRate: context.getRate,
        // Cue animations share the surface's frame source, so a host can pump
        // them deterministically in tests and never renders twice per frame.
        frame: {
          request:
            this.#requestFrame ??
            ((callback) => requestAnimationFrame(callback)),
          cancel:
            this.#cancelFrame ?? ((handle) => cancelAnimationFrame(handle)),
        },
      },
    ).finally(() => {
      context.signal.removeEventListener("abort", abort);
      lifecycleSignal.removeEventListener("abort", abort);
    });
  }

  // -- internals: visual cue executors ---------------------------------------

  async #transitionBackground(
    cue: Extract<SceneVisualCue, { type: "background_transition" }>,
    context: SceneCueContext,
  ): Promise<void> {
    const generation = this.#sceneGeneration;
    // The request token is taken *before* the decode: completion order must
    // not decide the winner.  A newer request therefore invalidates a slower
    // older one while its pixels are still loading, whether the newer request
    // commits new pixels, clears the background or is a same-asset no-op.
    const requestToken = this.#beginCueRequest(BACKGROUND_CUE);
    if (cue.background === null) {
      // Clearing invalidates in-flight background cues so their late callbacks
      // cannot write into the views this releases.
      this.#beginCue(BACKGROUND_CUE);
      this.#clearBackground();
      return;
    }
    const prepared = await this.#acquireAsset(cue.background, context.assets);
    if (
      context.signal.aborted ||
      !this.#isLatestCueRequest(generation, BACKGROUND_CUE, requestToken)
    ) {
      this.#releasePrepared(prepared);
      return;
    }
    if (
      this.#background !== null &&
      this.#background.version === prepared.version
    ) {
      // Same pixels: keep the live instance and its frame phase instead of
      // stacking a second copy for a fade that cannot be seen.  This request
      // does not start an animation, so it leaves the commit token alone and a
      // cross-fade that is already live still settles itself.
      this.#releasePrepared(prepared);
      return;
    }
    const token = this.#beginCue(BACKGROUND_CUE);
    const next = this.#createBackgroundView(prepared);
    if (next === null) {
      this.#releasePrepared(prepared);
      return;
    }
    const previous = this.#background;
    next.sprite.alpha = cue.transition === "cut" ? 1 : 0;
    this.#background = next;
    if (previous !== null) this.#stageView(previous);
    if (cue.transition !== "cut") {
      await this.#runAnimation(
        cue.duration_ms,
        "ease_in_out",
        (progress) => {
          if (!this.#isLatestCue(generation, BACKGROUND_CUE, token)) return;
          if (this.#background !== next) return;
          next.sprite.alpha = progress;
          if (previous !== null) previous.sprite.alpha = 1 - progress;
        },
        context,
      );
    }
    if (
      this.#isLatestCue(generation, BACKGROUND_CUE, token) &&
      this.#background === next
    ) {
      // The incoming instance already owns the pixels; a cue that was
      // cancelled half-way settles the visible transition instead of leaving
      // a half-transparent background behind.
      next.sprite.alpha = 1;
      this.#requestRender();
    }
    if (previous !== null) this.#releaseStagedView(previous);
  }

  async #tweenSprite(
    cue: Extract<SceneVisualCue, { type: "sprite_tween" }>,
    context: SceneCueContext,
  ): Promise<void> {
    const id = cue.sprite_id;
    const target = cue.to;
    const assets = context.assets;
    const key = `${SPRITE_CUE}${id}`;
    const generation = this.#sceneGeneration;
    let view = this.#sprites.get(id);
    if (target === null) {
      if (view === undefined) return;
      const fading = view;
      const token = this.#beginCue(key);
      const initialAlpha = fading.sprite.alpha;
      await this.#runAnimation(
        cue.duration_ms,
        cue.easing,
        (progress) => {
          if (!this.#isLatestCue(generation, key, token)) return;
          if (this.#sprites.get(id) !== fading) return;
          fading.sprite.alpha = initialAlpha * (1 - progress);
        },
        context,
      );
      if (
        !context.signal.aborted &&
        this.#isLatestCue(generation, key, token) &&
        this.#sprites.get(id) === fading
      ) {
        this.#sprites.delete(id);
        this.#releaseView(fading);
      }
      return;
    }

    const targetSource = resolveImageAsset(
      target.asset,
      assets,
      this.#animations,
    );
    if (targetSource === undefined)
      throw new Error(`素材尚未解析: ${target.asset}`);
    const label = assetLabel(targetSource);
    const replacing = view !== undefined && view.label !== label;
    const previousView = replacing ? view : undefined;
    const previousAlpha = previousView?.sprite.alpha ?? 0;
    const previousPose =
      previousView === undefined ? null : readSprite(previousView.sprite);
    // The capture above and this token are one synchronous step, and the token
    // is taken *before* the decode: a newer cue can therefore never commit a
    // view that an older, still-decoding cue then strands at its entry pose.
    const token = this.#beginCue(key);
    let created: SceneSpriteView | undefined;
    if (view === undefined || replacing) {
      const prepared = await this.#acquireAsset(target.asset, assets);
      // A newer cue (or another visual generation) may have taken this
      // instance while the pixels decoded; the late arrival must not clobber
      // either one.
      if (
        context.signal.aborted ||
        !this.#isLatestCue(generation, key, token) ||
        this.#sprites.get(id) !== view
      ) {
        this.#releasePrepared(prepared);
        return;
      }
      const next = this.#createView(id, prepared, this.#characters);
      if (next === null) {
        this.#releasePrepared(prepared);
        return;
      }
      view = next;
      created = next;
      this.#sprites.set(id, view);
      const entry = entryTweenPose(target);
      view.sprite.position.set(entry.x, entry.y);
      view.sprite.scale.set(
        target.scale * target.scale_x * ENTRY_TWEEN_SCALE,
        target.scale * target.scale_y * ENTRY_TWEEN_SCALE,
      );
      view.sprite.alpha = 0;
      if (previousView !== undefined) this.#stageView(previousView);
    }
    if (view === undefined) return;
    const staged = view;
    const start = previousPose ?? readSprite(view.sprite);
    const fadeDuration =
      cue.crossfade_ms === undefined || cue.crossfade_ms === null
        ? 0
        : Math.max(0, cue.crossfade_ms);
    const animationDuration = Math.max(cue.duration_ms, fadeDuration);
    const applyProgress = (progress: number): void => {
      if (!this.#isLatestCue(generation, key, token)) return;
      if (this.#sprites.get(id) !== staged) return;
      const transformProgress =
        cue.duration_ms <= 0
          ? 1
          : Math.min(1, (progress * animationDuration) / cue.duration_ms);
      staged.sprite.position.set(
        mix(start.x, target.x, transformProgress),
        mix(start.y, target.y, transformProgress),
      );
      staged.sprite.anchor.set(target.anchor_x ?? 0.5, target.anchor_y ?? 1);
      staged.sprite.scale.set(
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
      staged.sprite.rotation =
        (mix(start.rotation_deg, target.rotation_deg, transformProgress) *
          Math.PI) /
        180;
      staged.sprite.alpha =
        replacing && fadeDuration > 0
          ? mix(
              0,
              target.opacity,
              Math.min(1, (progress * animationDuration) / fadeDuration),
            )
          : mix(start.opacity, target.opacity, transformProgress);
      staged.sprite.zIndex =
        transformProgress < 1 ? start.z : Math.round(target.z);
      if (replacing && previousView !== undefined) {
        const fadeProgress =
          fadeDuration <= 0
            ? 1
            : Math.min(1, (progress * animationDuration) / fadeDuration);
        previousView.sprite.alpha = previousAlpha * (1 - fadeProgress);
      }
    };
    await this.#runAnimation(
      animationDuration,
      cue.easing,
      applyProgress,
      context,
    );
    if (context.signal.aborted && created !== undefined) {
      // A cancelled cue settles the instance it installed instead of leaving
      // a faint node at the entry pose behind.
      applyProgress(1);
      if (this.#isCurrent(generation)) this.#requestRender();
    }
    if (previousView !== undefined) this.#releaseStagedView(previousView);
    if (this.#isCurrent(generation)) this.#applyZOrder();
  }

  async #clearScene(
    durationMs: number,
    easing: Easing,
    context: SceneCueContext,
  ): Promise<void> {
    // A clear is a new visual generation: cues that were still writing into
    // the objects it releases become inert and the views they had detached are
    // released now.
    const generation = this.#startVisualGeneration();
    this.#releaseCueFlashes();
    const backgrounds = [...this.#backgrounds.children];
    const sprites = [...this.#sprites.values()];
    const backgroundAlpha = new Map(
      backgrounds.map((view) => [view, view.alpha]),
    );
    const spriteAlpha = new Map(
      sprites.map((view) => [view.sprite, view.sprite.alpha]),
    );
    if (durationMs > 0 && (backgrounds.length > 0 || sprites.length > 0)) {
      await this.#runAnimation(
        durationMs,
        easing,
        (progress) => {
          if (!this.#isCurrent(generation)) return;
          for (const view of backgrounds) {
            view.alpha = (backgroundAlpha.get(view) ?? 1) * (1 - progress);
          }
          for (const view of sprites) {
            if (this.#sprites.get(view.id) !== view) continue;
            view.sprite.alpha =
              (spriteAlpha.get(view.sprite) ?? 1) * (1 - progress);
          }
        },
        context,
      );
    }
    if (context.signal.aborted || !this.#isCurrent(generation)) return;
    this.#clearBackground();
    for (const view of sprites) {
      if (this.#sprites.get(view.id) !== view) continue;
      this.#sprites.delete(view.id);
      this.#releaseView(view);
    }
    this.#clearEffects();
    this.#requestRender();
  }

  async #tweenCamera(
    target: CameraSnapshot,
    durationMs: number,
    easing: Easing,
    context: SceneCueContext,
  ): Promise<void> {
    const generation = this.#sceneGeneration;
    const start = { ...this.#camera };
    await this.#runAnimation(
      durationMs,
      easing,
      (progress) => {
        if (!this.#isCurrent(generation)) return;
        this.#camera = {
          x: mix(start.x, target.x, progress),
          y: mix(start.y, target.y, progress),
          zoom: mix(start.zoom, target.zoom, progress),
          rotation_deg: mix(start.rotation_deg, target.rotation_deg, progress),
        };
        this.#applyCamera();
      },
      context,
    );
  }

  async #screenEffect(
    effect: "shake" | "flash",
    durationMs: number,
    context: SceneCueContext,
  ): Promise<void> {
    const generation = this.#sceneGeneration;
    if (effect === "flash") {
      const flash = this.#kit.graphics();
      flash.rect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT).fill(0xffffff);
      flash.alpha = 0.88;
      this.#effects.addChild(flash);
      this.#cueFlashes.add(flash);
      try {
        await this.#runAnimation(
          durationMs,
          "ease_out",
          (progress) => {
            if (!this.#isCurrent(generation)) return;
            flash.alpha = 0.88 * (1 - progress);
          },
          context,
        );
      } finally {
        // A reset, clear or dispose already released the node; only the
        // executor that still owns it destroys it (exactly once).
        if (this.#cueFlashes.delete(flash)) flash.destroy();
        if (this.#isCurrent(generation)) this.#requestRender();
      }
      return;
    }
    try {
      await this.#runAnimation(
        durationMs,
        "linear",
        (progress) => {
          if (!this.#isCurrent(generation)) return;
          const strength = (1 - progress) * 16;
          this.#cueShake = {
            x: Math.sin(progress * Math.PI * 18) * strength,
            y: Math.cos(progress * Math.PI * 22) * strength * 0.6,
          };
          this.#applyCamera();
        },
        context,
      );
    } finally {
      if (this.#isCurrent(generation)) {
        this.#cueShake = { x: 0, y: 0 };
        this.#applyCamera();
        this.#requestRender();
      }
    }
  }

  // -- internals: media ------------------------------------------------------

  #releaseVideo(handle?: SceneVideoHandle): void {
    const video = this.#video;
    if (video === null) return;
    if (handle !== undefined && handle.element !== video.element) return;
    this.#video = null;
    video.view.destroy({ texture: true, children: true });
    video.source.destroy();
    video.element.pause();
    video.element.removeAttribute("src");
    video.element.load();
    this.#applyZOrder();
    this.#requestRender();
  }

  #loadTexture(url: string): Promise<SceneTextureLike> {
    return new Promise<SceneTextureLike>((resolve, reject) => {
      let settled = false;
      const image = new Image();
      const cleanup = (): void => {
        image.onload = null;
        image.onerror = null;
        window.clearTimeout(timer);
      };
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        // Abandon the in-flight decode.  A late `onload` must not create a
        // texture no store entry references, so the handler is removed and the
        // source dropped before the caller is told the load timed out.
        image.src = "";
        reject(new Error(`图像加载超时: ${url}`));
      }, IMAGE_LOAD_TIMEOUT_MS);
      image.crossOrigin = "anonymous";
      image.decoding = "async";
      image.onload = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(this.#kit.textureFromImage(image));
      };
      image.onerror = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`图像解码失败: ${url}`));
      };
      image.src = url;
    });
  }
}

function textureBudgetFor(minimum: number, animations: AnimationMap): number {
  const urls = new Set<string>();
  for (const animation of Object.values(animations)) {
    for (const frame of animation.frames) urls.add(frame.url);
  }
  return Math.max(minimum, urls.size + TEXTURE_BUDGET_HEADROOM);
}

function animationUrls(source: ImageAssetSource): string[] {
  const animation = source.animation;
  if (animation === undefined) return [source.url];
  return animation.frames.map((frame) => frame.url);
}

/**
 * Identity of the pixels a view currently shows.
 *
 * Static assets keep the historical url identity.  Animated assets use their
 * logical id, so switching between an animation and one of its frame images
 * (which can share a url) is still recognised as a real change.
 */
function assetLabel(source: ImageAssetSource): string {
  return source.animation === undefined ? source.url : `anim:${source.asset}`;
}

export function applySprite(
  view: SceneSpriteLike,
  state: SpriteSnapshot,
): void {
  view.anchor.set(state.anchor_x ?? 0.5, state.anchor_y ?? 1);
  view.position.set(state.x, state.y);
  const direction = state.flip_x ? -1 : 1;
  view.scale.set(
    direction * state.scale * state.scale_x,
    state.scale * state.scale_y,
  );
  view.rotation = (state.rotation_deg * Math.PI) / 180;
  view.alpha = state.opacity;
  view.zIndex = Math.round(state.z);
}

function applySpriteTransform(
  view: SceneSpriteLike,
  object: SceneObjectFrame,
): void {
  view.anchor.set(object.anchor_x, object.anchor_y);
  view.position.set(object.x, object.y);
  view.scale.set(
    (object.flip_x ? -1 : 1) * object.scale * object.scale_x,
    object.scale * object.scale_y,
  );
  view.rotation = (object.rotation_deg * Math.PI) / 180;
  view.alpha = object.opacity;
  view.zIndex = Math.round(object.z);
}

export function readSprite(
  view: SceneSpriteLike,
): Omit<SpriteSnapshot, "asset"> {
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

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
