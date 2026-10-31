/**
 * Shared Pixi scene surface for the game renderer and the editor preview.
 *
 * This is the single implementation of "draw a VECTSPACE scene": the fixed
 * 1920x1080 application, the background/character/video/camera/effect layers,
 * object creation and release, per-instance frame loops, camera/shake
 * composition, thumbnails and the render scheduler.  Self-contained parts live
 * in collaborators: `SceneAssets` (reference-counted textures),
 * `SceneEmitters`, `SceneScreenEffects`, `SceneCurtain`, `SceneSessionCurtain`
 * and `BackgroundTransitionVisuals`.
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

import { Rectangle } from "pixi.js";

import { errorMessage } from "./errorMessage";
import {
  FrameLoopRegistry,
  type AnimationMap,
  type FrameSequencePlayer,
} from "./imageAnimation";
import { mix } from "./motion";
import type { EmitterSnapshot, ParticleMap } from "./particles";
import { SceneAssets, type PreparedAsset } from "./sceneAssets";
import { BackgroundTransitionVisuals } from "./sceneBackgroundTransition";
import { SceneCueLifecycle } from "./sceneCueLifecycle";
import { SceneCurtain, curtainAssetOf } from "./sceneCurtain";
import { SceneEmitters } from "./sceneEmitters";
import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  EMPTY_SCENE_OVERRIDES,
  ENTRY_TWEEN_SCALE,
  composeWorldTransform,
  entryTweenPose,
  hitTestSceneFrame,
  mergeSceneOverrides,
  type SceneFrame,
  type SceneObjectFrame,
  type SceneObjectPatch,
  type SceneOverrides,
  type SceneSpriteGeometry,
} from "./sceneFrame";
import {
  pixiSceneKit,
  type SceneApplicationLike,
  type SceneKit,
  type SceneNodeLike,
  type SceneSpriteLike,
  type SceneVideoSourceLike,
} from "./sceneKit";
import {
  SceneRenderLoop,
  type SceneFrameCancel,
  type SceneFrameRequest,
} from "./sceneRenderLoop";
import { SceneScreenEffects } from "./sceneScreenEffects";
import {
  SESSION_CURTAIN_FRAME_TIMEOUT_MS,
  SESSION_CURTAIN_MS,
  SceneSessionCurtain,
} from "./sceneSessionCurtain";
import {
  poseSpriteView,
  readSpriteView,
  showFrame,
  type SceneSpriteView,
} from "./sceneSpriteView";
import type {
  SceneActiveEffects,
  SceneBases,
  SceneCharacterRequest,
  SceneCueContext,
  SceneFrameApplyOptions,
  ScenePreparation,
  ScenePreparationRequest,
  SceneSurfaceOptions,
  SceneVideoHandle,
  SceneVisualCue,
} from "./sceneSurfaceTypes";
import { evaluateBackgroundTransition } from "./sceneTransitions";
import type { TextBlockMap } from "./textBlock";
import type {
  AssetUrlMap,
  CameraSnapshot,
  Easing,
  SpriteSnapshot,
  TimelineTrack,
} from "./types";
import { normalizeVisualWorld, spritePreset, spriteResourceId } from "./visual";

export * from "./sceneKit";
export type { SceneFrameCancel, SceneFrameRequest } from "./sceneRenderLoop";
export type * from "./sceneSurfaceTypes";

type VideoTrack = Extract<TimelineTrack, { type: "video" }>;
const BACKGROUND_ID = "__background__";
/** Cue-conflict key for background transitions; the newest one owns the view. */
const BACKGROUND_CUE = "background";
/** Cue-conflict key prefix for one sprite instance. */
const SPRITE_CUE = "sprite:";

/** Screen-space z-order: world < curtain < screen effects < session curtain. */
const CAMERA_LAYER_Z = 0;
const TRANSITION_LAYER_Z = 5;
const CURTAIN_LAYER_Z = 10;
const EFFECTS_LAYER_Z = 20;
/** The host-only session curtain covers every story layer while it is up. */
const SESSION_CURTAIN_LAYER_Z = 30;

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
  readonly #screenLayer: SceneNodeLike;
  // Legacy transition names alias the same sortable world parent, not layers.
  readonly #backgrounds: SceneNodeLike;
  readonly #videos: SceneNodeLike;
  readonly #effects: SceneNodeLike;
  /** Screen-space background-transition overlay (fade-through-colour). */
  readonly #transition: SceneNodeLike;
  /** Persistent curtain layer, above the world and below screen effects. */
  readonly #curtainLayer: SceneNodeLike;
  /** Host-only session curtain, above every story layer. */
  readonly #sessionCurtainLayer: SceneNodeLike;
  readonly #loops = new FrameLoopRegistry();
  readonly #sprites = new Map<string, SceneSpriteView>();
  readonly #geometry: SceneSpriteGeometry;
  readonly #assets: SceneAssets;
  readonly #emitters: SceneEmitters;
  readonly #lifecycle: SceneCueLifecycle;
  readonly #screenEffects: SceneScreenEffects;
  readonly #backgroundTransition: BackgroundTransitionVisuals;
  readonly #curtain: SceneCurtain;
  readonly #sessionCurtain: SceneSessionCurtain;
  get #background(): SceneSpriteView | null {
    return this.#sprites.get(BACKGROUND_ID) ?? null;
  }
  set #background(view: SceneSpriteView | null) {
    if (view === null) this.#sprites.delete(BACKGROUND_ID);
    else this.#sprites.set(BACKGROUND_ID, view);
  }
  #video: SceneVideoState | null = null;
  /** Callbacks waiting for the next drawn frame (reveal-after-stable-frame). */
  #frameWaiters: (() => void)[] = [];
  #camera: CameraSnapshot = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
  #evaluated: SceneFrame | null = null;
  #current: SceneFrame | null = null;
  #overrides: SceneOverrides = EMPTY_SCENE_OVERRIDES;
  #resources = 0;
  #preparations = new Map<number, ScenePreparation>();
  #prepareGeneration = 0;
  #prepareAbort: AbortController | null = null;
  /** Outgoing views of in-flight cross-fades, released exactly once. */
  readonly #stagedViews = new Set<SceneSpriteView>();
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
    this.#application = this.#kit.application();
    this.#cameraLayer = this.#kit.container();
    this.#backgrounds = this.#videos = this.#cameraLayer;
    this.#screenLayer = this.#kit.container();
    this.#effects = this.#kit.container();
    this.#transition = this.#kit.container();
    this.#curtainLayer = this.#kit.container();
    this.#sessionCurtainLayer = this.#kit.container();
    this.#requestFrame = options.requestFrame;
    this.#cancelFrame = options.cancelFrame;
    this.#lifecycle = new SceneCueLifecycle({
      isDisposed: () => this.#disposed,
      requestRender: () => this.#requestRender(),
      requestFrame: this.#requestFrame,
      cancelFrame: this.#cancelFrame,
    });
    this.#screenEffects = new SceneScreenEffects({
      kit: this.#kit,
      lifecycle: this.#lifecycle,
      worldLayer: this.#cameraLayer,
      layer: this.#effects,
      isDisposed: () => this.#disposed,
      camera: () => this.#camera,
      applyCamera: () => this.#applyCamera(),
      requestRender: () => this.#requestRender(),
    });
    this.#assets = new SceneAssets({
      kit: this.#kit,
      diagnostic: this.#diagnostic,
      animations: options.animations ?? {},
      textBlocks: options.textBlocks ?? {},
      textureLoader: options.textureLoader,
      textureBudget: options.textureBudget,
    });
    this.#emitters = new SceneEmitters({
      kit: this.#kit,
      assets: this.#assets,
      lifecycle: this.#lifecycle,
      particles: options.particles ?? {},
      parentOf: (space) => this.#objectParent(space),
      requestRender: () => this.#requestRender(),
    });
    this.#backgroundTransition = new BackgroundTransitionVisuals({
      kit: this.#kit,
      backgrounds: this.#backgrounds,
      overlayLayer: this.#transition,
      requestRender: () => this.#requestRender(),
    });
    this.#curtain = new SceneCurtain({
      kit: this.#kit,
      assets: this.#assets,
      lifecycle: this.#lifecycle,
      layer: this.#curtainLayer,
      diagnostic: this.#diagnostic,
      requestRender: () => this.#requestRender(),
    });
    this.#sessionCurtain = new SceneSessionCurtain({
      kit: this.#kit,
      lifecycle: this.#lifecycle,
      layer: this.#sessionCurtainLayer,
      isDisposed: () => this.#disposed,
      requestRender: () => this.#requestRender(),
      nextFrame: () => this.#nextFrame(),
    });
    this.#geometry = {
      spriteSize: (asset) => this.#assets.spriteSize(asset),
      emitterSize: (particle) => this.#emitters.emitterSize(particle),
    };
  }

  /** True after `init()` resolved and before `dispose()`. */
  get initialized(): boolean {
    return this.#initialization !== null && !this.#disposed;
  }

  get animations(): AnimationMap {
    return this.#assets.animations;
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
      this.#screenLayer.sortableChildren = true;
      this.#screenLayer.zIndex = 1;
      const htmlText = this.#application.renderer.htmlText;
      if (htmlText !== undefined) this.#assets.attachRasterizer(htmlText);
      // Screen-space stack: world < background-transition overlay < curtain <
      // screen effects.  `sortableChildren` keeps the render order explicit
      // even though the DOM/dialogue layer lives outside this surface.
      this.#application.stage.sortableChildren = true;
      this.#cameraLayer.zIndex = CAMERA_LAYER_Z;
      this.#transition.zIndex = TRANSITION_LAYER_Z;
      this.#curtainLayer.zIndex = CURTAIN_LAYER_Z;
      this.#effects.zIndex = EFFECTS_LAYER_Z;
      this.#sessionCurtainLayer.zIndex = SESSION_CURTAIN_LAYER_Z;
      this.#application.stage.addChild(this.#cameraLayer);
      // Insertion order is the stage's child order (the test kit reads
      // `stage.children[1]` for screen effects); `zIndex` decides the actual
      // render order, so the curtain still draws below the effects and the
      // host session curtain covers everything.
      this.#application.stage.addChild(this.#effects);
      this.#application.stage.addChild(this.#transition);
      this.#application.stage.addChild(this.#curtainLayer);
      this.#application.stage.addChild(this.#sessionCurtainLayer);
      this.#application.stage.addChild(this.#screenLayer);
      this.#applyCamera();
      this.#application.render();
      const loop = new SceneRenderLoop({
        render: () => this.#renderFrame(),
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
    this.#assets.setAnimations(animations);
  }

  setVisualResources(textBlocks: TextBlockMap, particles: ParticleMap): void {
    if (
      this.#assets.textBlocks === textBlocks &&
      this.#emitters.particles === particles
    )
      return;
    this.#prepareAbort?.abort();
    this.#prepareGeneration += 1;
    this.#startVisualGeneration();
    this.#assets.textBlocks = textBlocks;
    this.#emitters.particles = particles;
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
    const world = normalizeVisualWorld(request.world);
    this.#emitters.validateWorld(world.emitters ?? {});
    const preparation: ScenePreparation = {
      generation,
      world,
      assets: request.assets,
      resourceId,
      resources: new Map<string, PreparedAsset>(),
      background: null,
      curtain: null,
      get stale(): boolean {
        return isStale();
      },
    };
    const acquired: PreparedAsset[] = [];
    const releaseAcquired = (): void => {
      for (const asset of acquired) this.#assets.releasePrepared(asset);
      acquired.length = 0;
    };
    try {
      const wanted = new Set<string>(
        Object.values(world.sprites).map(spriteResourceId),
      );
      for (const emitter of Object.values(world.emitters ?? {})) {
        wanted.add(this.#emitters.particles[emitter.particle]!.image);
      }
      const curtainAsset = curtainAssetOf(world.curtain ?? null);
      if (curtainAsset !== null) wanted.add(curtainAsset);
      for (const asset of wanted) {
        if (aborted()) {
          releaseAcquired();
          return null;
        }
        const prepared = await this.#assets.prepare(asset, request.assets);
        if (prepared === null) continue;
        acquired.push(prepared);
        if (aborted()) {
          releaseAcquired();
          return null;
        }
        preparation.resources.set(asset, prepared);
        if (curtainAsset === asset) {
          (preparation as { curtain: PreparedAsset | null }).curtain = prepared;
        }
      }
      for (const state of Object.values(world.emitters ?? {})) {
        this.#emitters.validateResource(
          state,
          preparation.resources.get(
            this.#emitters.particles[state.particle]!.image,
          ),
        );
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
    const world = preparation.world;
    try {
      // Bursts can arrive while a snapshot decodes; check the final budget again
      // before changing any view, rather than fail halfway through a commit.
      this.#emitters.validateWorld(world.emitters ?? {});
    } catch (error) {
      this.discardPreparation(preparation);
      throw error;
    }
    // A committed world is a new visual generation: cues that are still in
    // flight release what they detached and give up settling their pose.
    this.#startVisualGeneration();
    this.#assets.urls = preparation.assets;
    const wanted = new Set(Object.keys(world.sprites));
    for (const [id, view] of [...this.#sprites]) {
      if (wanted.has(id)) continue;
      this.#releaseView(view);
      this.#sprites.delete(id);
    }
    for (const [id, state] of Object.entries(world.sprites)) {
      const view = this.#sprites.get(id);
      const resource = spriteResourceId(state);
      const prepared = preparation.resources.get(resource);
      // A view is only reused for the *same revision* of its asset: an edited
      // animation under the same logical id must replace the view and restart
      // its loop instead of silently keeping the old frames and phase.
      const keepsView =
        view !== undefined &&
        (prepared === undefined
          ? view.label === this.#assets.labelOf(resource, preparation.assets)
          : view.version === prepared.version);
      if (keepsView) {
        // Same asset revision: keep the loop position and apply the pose.
        this.#poseView(view, state);
        continue;
      }
      if (view !== undefined) {
        this.#releaseView(view);
        this.#sprites.delete(id);
      }
      if (prepared === undefined) continue;
      const next = this.#createView(
        id,
        prepared,
        this.#objectParent(state.space),
      );
      if (next === null) continue;
      this.#poseView(next, state);
      this.#sprites.set(id, next);
    }
    this.#emitters.reconcile(world.emitters ?? {}, preparation.resources);
    this.#camera = { ...world.camera };
    this.#curtain.commit(preparation.curtain, world.curtain ?? null);
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
      ...(preparation.curtain === null ? [] : [preparation.curtain]),
    ];
    for (const asset of assets) this.#assets.releasePrepared(asset);
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
    this.#curtain.destroy();
    this.#backgroundTransition.clearOverlay();
    for (const view of this.#sprites.values()) this.#releaseView(view);
    this.#sprites.clear();
    this.#emitters.clear();
    this.#loops.clear();
    this.#screenEffects.clear();
    this.#overrides = EMPTY_SCENE_OVERRIDES;
    this.#evaluated = null;
    this.#current = null;
    this.#camera = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
    // A reset is a session boundary: the host curtain never survives the
    // world it was covering.
    this.#sessionCurtain.reset();
    this.#flushFrameWaiters();
    this.#applyCamera();
    this.#applyZOrder();
    this.#requestRender();
  }

  /** Releases every pending "next drawn frame" waiter. */
  #flushFrameWaiters(): void {
    const waiters = this.#frameWaiters;
    if (waiters.length === 0) return;
    this.#frameWaiters = [];
    for (const waiter of waiters) waiter();
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
      this.seekParticles(frame.elapsed_ms);
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
    return hitTestSceneFrame(
      this.readFrame(),
      { x, y },
      this.#screenEffects.shake(),
    );
  }

  // -- effects ---------------------------------------------------------------

  /** Sets the timeline-derived screen effects for the current playhead. */
  setActiveEffects(effects: SceneActiveEffects | null): void {
    this.#screenEffects.setActive(effects);
  }

  clearActiveEffects(): void {
    this.setActiveEffects(null);
  }

  get reducedMotion(): boolean {
    return this.#screenEffects.reducedMotion;
  }

  /**
   * Player accessibility preference: attenuates flashes, shakes and shader
   * effects on both the timeline and the cue path, from the next frame on.
   */
  setReducedMotion(enabled: boolean): void {
    this.#screenEffects.setReducedMotion(enabled);
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
      case "particle_state":
        await this.#emitters.cue(cue, context);
        return;
      case "clear_scene":
        await this.#clearScene(cue.duration_ms, cue.easing, context);
        return;
      case "camera_tween":
        await this.#tweenCamera(cue.to, cue.duration_ms, cue.easing, context);
        return;
      case "screen_effect":
        await this.#screenEffects.cue(cue.effect, cue.duration_ms, context);
        return;
      case "curtain_transition":
        await this.#curtain.transition(cue, context);
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
      sprites[view.id] = readSpriteView(view);
    }
    const emitters: Record<string, EmitterSnapshot> = this.#emitters.capture();
    return {
      sprites,
      ...(Object.keys(emitters).length === 0 ? {} : { emitters }),
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
          this.#assets.showsRevision(current, request.asset, assets)
        ) {
          continue;
        }
        if (!isCurrent()) {
          for (const item of pending)
            this.#assets.releasePrepared(item.prepared);
          return false;
        }
        const prepared = await this.#assets.acquire(request.asset, assets);
        if (!isCurrent()) {
          this.#assets.releasePrepared(prepared);
          for (const item of pending)
            this.#assets.releasePrepared(item.prepared);
          return false;
        }
        pending.push({ request, prepared });
      }
    } catch (error) {
      for (const item of pending) this.#assets.releasePrepared(item.prepared);
      throw error;
    }
    this.#assets.urls = assets;
    for (const { request, prepared } of pending) {
      const current = this.#sprites.get(request.id);
      if (current !== undefined) {
        this.#sprites.delete(request.id);
        this.#releaseView(current);
      }
      const state =
        request.state ??
        spritePreset("character", { type: "image", asset: request.asset });
      const view = this.#createView(
        request.id,
        prepared,
        this.#objectParent(state.space),
      );
      if (view === null) {
        this.#assets.releasePrepared(prepared);
        continue;
      }
      this.#poseView(view, state);
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

  /** Deterministic editor decoration preview; no wall clock is consulted. */
  seekParticles(elapsedMs: number): void {
    this.#emitters.seek(elapsedMs);
  }

  /** Nearest-sampling particle copies resident on this surface and their emitter references. */
  get particleTextures(): { resident: number; refs: number } {
    return this.#emitters.textures;
  }

  get particleStats(): {
    emitters: number;
    live: number;
    capacity: number;
    textures: number;
  } {
    return { ...this.#emitters.stats(), textures: this.#assets.textureCount };
  }

  // -- host-only session curtain ---------------------------------------------

  /** True while the host-only session curtain fully covers the canvas. */
  get sessionCovered(): boolean {
    return this.#sessionCurtain.covered;
  }

  /** Covers the canvas with the host-only session curtain; see `SceneSessionCurtain`. */
  coverSession(durationMs: number = SESSION_CURTAIN_MS): Promise<void> {
    return this.#sessionCurtain.cover(durationMs);
  }

  /** Reveals the session curtain again once the replacement is on screen. */
  revealSession(durationMs: number = SESSION_CURTAIN_MS): Promise<void> {
    return this.#sessionCurtain.reveal(durationMs);
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
      // readback on every frame.  The explicit stage frame keeps the extract
      // render transform an identity (Pixi otherwise crops to the content
      // bounds with a translate), so the post-processing passes see the same
      // camera/world transform as the live canvas and a camera-translated
      // scene anchors its effects to the same design pixel in both paths.
      const source = this.#application.renderer.extract.canvas({
        target: this.#application.stage,
        frame: new Rectangle(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT),
      });
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
    this.#curtain.destroy();
    this.#backgroundTransition.clearOverlay();
    for (const view of this.#sprites.values()) this.#releaseView(view);
    this.#sprites.clear();
    this.#emitters.clear();
    this.#loops.clear();
    this.#screenEffects.clear();
    this.#sessionCurtain.reset();
    this.#flushFrameWaiters();
    this.#loop?.dispose();
    this.#loop = null;
    this.#assets.destroy();
    this.#screenEffects.destroy();
    this.#application.destroy({ removeView: false }, { children: true });
  }

  // -- internals: views ------------------------------------------------------

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
      refs: this.#assets.claim(prepared),
      player: this.#loops.ensure(id, prepared.source),
      unsubscribe: () => undefined,
      parent,
    };
    view.unsubscribe = view.player.subscribe((changed: FrameSequencePlayer) => {
      showFrame(view, changed.frameIndex());
    });
    showFrame(view, view.player.frameIndex());
    return view;
  }

  #createBackgroundView(prepared: PreparedAsset): SceneSpriteView | null {
    const view = this.#createView(BACKGROUND_ID, prepared, this.#backgrounds);
    if (view === null) return null;
    this.#poseView(
      view,
      spritePreset("background", { type: "image", asset: prepared.asset }),
    );
    return view;
  }

  #objectParent(space?: "world" | "screen"): SceneNodeLike {
    return space === "screen" ? this.#screenLayer : this.#cameraLayer;
  }

  #poseView(view: SceneSpriteView, state: SpriteSnapshot): void {
    poseSpriteView(this.#kit, view, state, this.#objectParent(state.space));
  }

  #refreshFrameTextures(ids: readonly string[]): void {
    for (const id of ids) {
      const view =
        id === BACKGROUND_ID
          ? this.#background
          : (this.#sprites.get(id) ?? null);
      if (view === null) continue;
      const player = this.#loops.player(id);
      showFrame(view, player?.frameIndex() ?? 0);
      // A soft edge on an animated incoming background draws copies of it;
      // keep them on the same frame the view now shows.
      this.#backgroundTransition.syncStripTextures(view);
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
    view.layoutMask?.destroy();
    this.#assets.releaseRefs(view.refs);
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
    const generation = this.#lifecycle.advance();
    this.#releaseStagedViews();
    // Cue-owned visuals belong to the generation that started them: a reset, a
    // world commit or a clear must not leave a half-drawn transition mask, a
    // fade-through overlay or a sampled shake offset behind.  A background cue
    // that is still in flight gives up its cleanup (its token is stale once
    // the generation moves on), so this is the only place that releases them.
    this.#screenEffects.resetCues();
    this.#backgroundTransition.clearOverlay();
    this.#backgroundTransition.clearMask();
    return generation;
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
    // Detach the wipe/soft-push mask before the view it clips is destroyed;
    // a released Pixi object must not be written to afterwards.
    this.#backgroundTransition.clearMask();
    const previous = this.#background;
    this.#background = null;
    if (previous !== null) this.#releaseView(previous);
    this.#releaseStagedViewsFor(BACKGROUND_ID);
    // A background that is gone cannot be covered by a transition overlay.
    this.#backgroundTransition.clearOverlay();
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
    this.#screenEffects.apply();
    this.#applyCamera();
    this.#applyZOrder();
    this.#requestRender();
  }

  #applyObject(object: SceneObjectFrame): void {
    if (object.kind === "sprite") {
      const view = this.#sprites.get(object.id);
      if (view === undefined) return;
      this.#poseView(view, { ...view.state, ...object });
      return;
    }
    if (object.kind === "emitter") {
      this.#emitters.applyFrameObject(object);
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
    // Each Sprite, video and emitter is a direct child of its coordinate space.
    this.#cameraLayer.sortableChildren = true;
    this.#screenLayer.sortableChildren = true;
  }

  #applyCamera(): void {
    // An aborted cue's `finally` (and any late host call) can run after
    // `dispose()` destroyed the camera layer; writing a destroyed node's
    // position throws in Pixi.
    if (this.#disposed) return;
    const shake = this.#screenEffects.shake();
    const transform = composeWorldTransform(this.#camera, shake);
    // Base camera and shake are combined once, here, so no later camera
    // application can silently drop an in-flight shake.
    this.#cameraLayer.position.set(transform.positionX, transform.positionY);
    this.#cameraLayer.pivot.set(transform.pivotX, transform.pivotY);
    this.#cameraLayer.scale.set(transform.scale);
    this.#cameraLayer.rotation = transform.rotation;
    // The filter area follows the camera, so every transform change re-syncs.
    this.#screenEffects.syncShaders(shake);
  }

  #tickDecorations(deltaMs: number): boolean {
    if (!this.#decorativeRunning || this.#paused || deltaMs <= 0) return false;
    const changed = this.#loops.advance(deltaMs);
    this.#refreshFrameTextures(changed);
    const hasParticles = this.#emitters.tick(deltaMs);
    return changed.length > 0 || hasParticles;
  }

  #requestRender(): void {
    if (this.#disposed) return;
    if (this.#loop === null) {
      if (this.#initialization !== null) this.#renderFrame();
      return;
    }
    this.#loop.schedule();
  }

  /** Draws one frame and releases callers waiting for a stable picture. */
  #renderFrame(): void {
    if (this.#disposed) return;
    this.#application.render();
    const waiters = this.#frameWaiters;
    if (waiters.length === 0) return;
    this.#frameWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /**
   * Resolves after the next frame is actually drawn.
   *
   * The session-curtain reveal waits for this so the replacement world is on
   * screen before the cover starts fading, and a test/pump host observes the
   * same ordering.  The wait is bounded: a hidden or suspended host can stop
   * drawing frames altogether, so after `SESSION_CURTAIN_FRAME_TIMEOUT_MS` the
   * surface renders once best-effort and stops waiting instead of holding the
   * host busy indefinitely.
   */
  #nextFrame(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    return new Promise((resolve) => {
      const settle = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (!this.#disposed) {
          try {
            this.#renderFrame();
          } catch (error) {
            this.#diagnostic(`停帧兜底渲染失败：${errorMessage(error)}`);
          }
        }
        settle();
      }, SESSION_CURTAIN_FRAME_TIMEOUT_MS);
      this.#frameWaiters.push(settle);
      this.#requestRender();
    });
  }

  // -- internals: visual cue executors ---------------------------------------

  async #transitionBackground(
    cue: Extract<SceneVisualCue, { type: "background_transition" }>,
    context: SceneCueContext,
  ): Promise<void> {
    const lifecycle = this.#lifecycle;
    const generation = lifecycle.generation;
    // The request token is taken *before* the decode: completion order must
    // not decide the winner.  A newer request therefore invalidates a slower
    // older one while its pixels are still loading, whether the newer request
    // commits new pixels, clears the background or is a same-asset no-op.
    const requestToken = lifecycle.beginRequest(BACKGROUND_CUE);
    if (cue.background === null) {
      // Clearing invalidates in-flight background cues so their late callbacks
      // cannot write into the views this releases.
      lifecycle.begin(BACKGROUND_CUE);
      this.#clearBackground();
      return;
    }
    const prepared = await this.#assets.acquire(cue.background, context.assets);
    if (
      context.signal.aborted ||
      !lifecycle.isLatestRequest(generation, BACKGROUND_CUE, requestToken)
    ) {
      this.#assets.releasePrepared(prepared);
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
      this.#assets.releasePrepared(prepared);
      return;
    }
    const token = lifecycle.begin(BACKGROUND_CUE);
    // A newer cue takes the layer over: release the previous cue's transient
    // mask/overlay *before* this cue creates its own resources, so the shared
    // nodes can never be inherited (or torn down) across cue kinds.
    this.#backgroundTransition.reset();
    const next = this.#createBackgroundView(prepared);
    if (next === null) {
      this.#assets.releasePrepared(prepared);
      return;
    }
    const previous = this.#background;
    this.#background = next;
    if (previous !== null) this.#stageView(previous);
    const spec = cue.transition;
    const settle = (): void => {
      if (
        lifecycle.isLatest(generation, BACKGROUND_CUE, token) &&
        this.#background === next
      ) {
        // The incoming instance owns the pixels; a cancelled cue settles the
        // visible transition instead of leaving a half-drawn mask behind.
        this.#poseView(next, next.state!);
        this.#requestRender();
      }
    };
    if (spec.type === "cut" || cue.duration_ms === 0) {
      next.sprite.alpha = 1;
      if (previous !== null) previous.sprite.alpha = 0;
    } else if (
      spec.type === "cross_fade" ||
      spec.type === "fade_through_color"
    ) {
      next.sprite.alpha = 0;
      if (spec.type === "fade_through_color") {
        this.#backgroundTransition.ensureOverlay(spec.color);
      }
      // The pure evaluator owns the authored easing; the animation only drives
      // raw progress, so the curve is applied exactly once (like every other
      // timed cue, where `lifecycle.run` eases and the callback consumes it).
      await lifecycle.run(
        cue.duration_ms,
        "linear",
        (progress) => {
          if (!lifecycle.isLatest(generation, BACKGROUND_CUE, token)) return;
          if (this.#background !== next) return;
          const frame = evaluateBackgroundTransition(
            spec,
            progress,
            cue.easing,
          );
          next.sprite.alpha = frame.incomingAlpha;
          if (previous !== null) previous.sprite.alpha = frame.outgoingAlpha;
          if (frame.overlay !== null)
            this.#backgroundTransition.setOverlay(frame.overlay.alpha);
        },
        context,
      );
    } else if (spec.type === "wipe") {
      next.sprite.alpha = 1;
      this.#backgroundTransition.attachMask(next);
      await lifecycle.run(
        cue.duration_ms,
        "linear",
        (progress) => {
          if (!lifecycle.isLatest(generation, BACKGROUND_CUE, token)) return;
          if (this.#background !== next) return;
          const frame = evaluateBackgroundTransition(
            spec,
            progress,
            cue.easing,
          );
          this.#backgroundTransition.applyMask(frame.mask, next);
        },
        context,
      );
    } else {
      next.sprite.alpha = 1;
      const nextBase = { x: next.sprite.position.x, y: next.sprite.position.y };
      const previousBase =
        previous === null
          ? null
          : { x: previous.sprite.position.x, y: previous.sprite.position.y };
      await lifecycle.run(
        cue.duration_ms,
        "linear",
        (progress) => {
          if (!lifecycle.isLatest(generation, BACKGROUND_CUE, token)) return;
          if (this.#background !== next) return;
          const frame = evaluateBackgroundTransition(
            spec,
            progress,
            cue.easing,
          );
          next.sprite.position.set(
            nextBase.x + frame.incomingOffset.x,
            nextBase.y + frame.incomingOffset.y,
          );
          if (previous !== null && previousBase !== null) {
            previous.sprite.position.set(
              previousBase.x + frame.outgoingOffset.x,
              previousBase.y + frame.outgoingOffset.y,
            );
          }
          // A push without softness carries no mask (the exact hard-edge
          // slide); a soft push feathers the incoming's leading edge.
          this.#backgroundTransition.applyMask(frame.mask, next);
        },
        context,
      );
      next.sprite.position.set(nextBase.x, nextBase.y);
      if (previous !== null && previousBase !== null) {
        previous.sprite.position.set(previousBase.x, previousBase.y);
      }
    }
    settle();
    // Only the newest background cue owns the shared overlay/mask; a
    // superseded cue must not tear down the resources the newer one installed
    // after it took over.  A generation change releases them itself (see
    // `#startVisualGeneration`), so a stale cue can safely leave them alone.
    if (lifecycle.isLatest(generation, BACKGROUND_CUE, token)) {
      this.#backgroundTransition.clearOverlay();
      this.#backgroundTransition.clearMask();
    }
    if (previous !== null) this.#releaseStagedView(previous);
  }

  async #tweenSprite(
    cue: Extract<SceneVisualCue, { type: "sprite_tween" }>,
    context: SceneCueContext,
  ): Promise<void> {
    const lifecycle = this.#lifecycle;
    const id = cue.sprite_id;
    const target = cue.to;
    const assets = context.assets;
    const key = `${SPRITE_CUE}${id}`;
    const generation = lifecycle.generation;
    let view = this.#sprites.get(id);
    if (target === null) {
      if (view === undefined) return;
      const fading = view;
      const token = lifecycle.begin(key);
      const initialAlpha = fading.sprite.alpha;
      await lifecycle.run(
        cue.duration_ms,
        cue.easing,
        (progress) => {
          if (!lifecycle.isLatest(generation, key, token)) return;
          if (this.#sprites.get(id) !== fading) return;
          fading.sprite.alpha = initialAlpha * (1 - progress);
        },
        context,
      );
      if (
        !context.signal.aborted &&
        lifecycle.isLatest(generation, key, token) &&
        this.#sprites.get(id) === fading
      ) {
        this.#sprites.delete(id);
        this.#releaseView(fading);
      }
      return;
    }

    const resource = spriteResourceId(target);
    const replacing =
      view !== undefined && !this.#assets.showsRevision(view, resource, assets);
    const previousView = replacing ? view : undefined;
    const previousAlpha = previousView?.sprite.alpha ?? 0;
    const previousPose =
      previousView === undefined ? null : readSpriteView(previousView);
    // The capture above and this token are one synchronous step, and the token
    // is taken *before* the decode: a newer cue can therefore never commit a
    // view that an older, still-decoding cue then strands at its entry pose.
    const token = lifecycle.begin(key);
    let created: SceneSpriteView | undefined;
    if (view === undefined || replacing) {
      const prepared = await this.#assets.acquire(resource, assets);
      // A newer cue (or another visual generation) may have taken this
      // instance while the pixels decoded; the late arrival must not clobber
      // either one.
      if (
        context.signal.aborted ||
        !lifecycle.isLatest(generation, key, token) ||
        this.#sprites.get(id) !== view
      ) {
        this.#assets.releasePrepared(prepared);
        return;
      }
      const next = this.#createView(
        id,
        prepared,
        this.#objectParent(target.space),
      );
      if (next === null) {
        this.#assets.releasePrepared(prepared);
        return;
      }
      view = next;
      created = next;
      this.#sprites.set(id, view);
      const character = (target.sprite_kind ?? "character") === "character";
      const entry = character ? entryTweenPose(target) : target;
      this.#poseView(view, {
        ...target,
        x: entry.x,
        y: entry.y,
        scale: target.scale * (character ? ENTRY_TWEEN_SCALE : 1),
        opacity: 0,
      });
      if (previousView !== undefined) this.#stageView(previousView);
    }
    if (view === undefined) return;
    const staged = view;
    const start = previousPose ?? readSpriteView(view);
    const fadeDuration =
      cue.crossfade_ms === undefined || cue.crossfade_ms === null
        ? 0
        : Math.max(0, cue.crossfade_ms);
    const animationDuration = Math.max(cue.duration_ms, fadeDuration);
    const applyProgress = (progress: number): void => {
      if (!lifecycle.isLatest(generation, key, token)) return;
      if (this.#sprites.get(id) !== staged) return;
      const transformProgress =
        cue.duration_ms <= 0
          ? 1
          : Math.min(1, (progress * animationDuration) / cue.duration_ms);
      this.#poseView(staged, {
        ...target,
        x: mix(start.x, target.x, transformProgress),
        y: mix(start.y, target.y, transformProgress),
        scale: 1,
        scale_x: mix(
          start.scale * start.scale_x,
          target.scale * target.scale_x,
          transformProgress,
        ),
        scale_y: mix(
          start.scale * start.scale_y,
          target.scale * target.scale_y,
          transformProgress,
        ),
        rotation_deg: mix(
          start.rotation_deg,
          target.rotation_deg,
          transformProgress,
        ),
        opacity:
          replacing && fadeDuration > 0
            ? mix(
                0,
                target.opacity,
                Math.min(1, (progress * animationDuration) / fadeDuration),
              )
            : mix(start.opacity, target.opacity, transformProgress),
        z: transformProgress < 1 ? start.z : Math.round(target.z),
      });
      if (replacing && previousView !== undefined) {
        const fadeProgress =
          fadeDuration <= 0
            ? 1
            : Math.min(1, (progress * animationDuration) / fadeDuration);
        previousView.sprite.alpha = previousAlpha * (1 - fadeProgress);
      }
    };
    await lifecycle.run(animationDuration, cue.easing, applyProgress, context);
    if (context.signal.aborted && created !== undefined) {
      // A cancelled cue settles the instance it installed instead of leaving
      // a faint node at the entry pose behind.
      applyProgress(1);
      if (lifecycle.isCurrent(generation)) this.#requestRender();
    }
    if (previousView !== undefined) this.#releaseStagedView(previousView);
    if (lifecycle.isCurrent(generation)) this.#applyZOrder();
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
    this.#screenEffects.releaseCueFlashes();
    const backgrounds = [
      ...this.#cameraLayer.children,
      ...this.#screenLayer.children,
    ];
    const sprites = [...this.#sprites.values()];
    const backgroundAlpha = new Map(
      backgrounds.map((view) => [view, view.alpha]),
    );
    const spriteAlpha = new Map(
      sprites.map((view) => [view.sprite, view.sprite.alpha]),
    );
    if (durationMs > 0 && (backgrounds.length > 0 || sprites.length > 0)) {
      await this.#lifecycle.run(
        durationMs,
        easing,
        (progress) => {
          if (!this.#lifecycle.isCurrent(generation)) return;
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
    if (context.signal.aborted || !this.#lifecycle.isCurrent(generation))
      return;
    this.#clearBackground();
    this.#curtain.destroy();
    this.#backgroundTransition.clearOverlay();
    for (const view of sprites) {
      if (this.#sprites.get(view.id) !== view) continue;
      this.#sprites.delete(view.id);
      this.#releaseView(view);
    }
    this.#emitters.clear();
    this.#releaseVideo();
    this.#screenEffects.clear();
    this.#requestRender();
  }

  async #tweenCamera(
    target: CameraSnapshot,
    durationMs: number,
    easing: Easing,
    context: SceneCueContext,
  ): Promise<void> {
    const generation = this.#lifecycle.generation;
    const start = { ...this.#camera };
    await this.#lifecycle.run(
      durationMs,
      easing,
      (progress) => {
        if (!this.#lifecycle.isCurrent(generation)) return;
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
}
