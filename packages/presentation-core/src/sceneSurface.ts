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
  ImageSource,
  Rectangle,
  Particle,
  ParticleContainer,
  Sprite,
  Texture,
  VideoSource,
  type TextureSource,
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
  hitTestSceneFrame,
  mergeSceneOverrides,
  shakeOffset,
  stagePointToWorld,
  type SceneFrame,
  type SceneObjectFrame,
  type SceneObjectPatch,
  type SceneOverrides,
  type SceneSpriteGeometry,
} from "./sceneFrame";
import { SceneTextureStore, type SceneTextureLike } from "./sceneTextures";
import { normalizeVisualWorld, spritePreset, spriteResourceId, spriteFit, textBlockId } from "./visual";
import { TextBlockRasterizer, textBlockVersion, type TextBlockMap, type TextBlockSource } from "./textBlock";
import { ParticleEvaluator, PARTICLE_STRIDE, MAX_SURFACE_PARTICLES, validateEmitter, validateParticleDefinition, type EmitterSnapshot, type ParticleDefinition, type ParticleMap } from "./particles";
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
import {
  EMPTY_SHADER_EFFECT_FRAME,
  evaluateChromaticAberration,
  evaluateColorGrade,
  evaluateFlashAlpha,
  evaluateFocus,
  evaluateGlitch,
  evaluateRipple,
  evaluateScreenEffectFrame,
  evaluateShaderEffectFrame,
  evaluateShakeOffset,
  evaluateShockwave,
  isShaderEffectFrameEmpty,
  type ScreenEffectOptions,
  type ShaderEffectFrame,
} from "./sceneEffects";
import {
  createPixiShaderHost,
  type SceneRect,
  type SceneShaderHostLike,
} from "./sceneShaders";
import {
  evaluateBackgroundTransition,
  evaluateCurtainTransition,
  featherSteps,
  featherStepRect,
  fullStageRect,
  maskOpaqueRect,
  type CurtainTransitionFrame,
  type StageMask,
} from "./sceneTransitions";
import type {
  AssetUrlMap,
  ButtonSnapshot,
  CameraSnapshot,
  CurtainAction,
  CurtainFill,
  CurtainSnapshot,
  Easing,
  PresentationCue,
  ScreenEffectSpec,
  ShaderScreenEffectType,
  SpriteSnapshot,
  TimelineTrack,
} from "./types";

/** Texture budget floor for a host that declares no animations at all. */
export const MIN_SESSION_TEXTURES = 512;
/** Headroom for backgrounds, sprites, GUI art and buttons beside the frames. */
export const TEXTURE_BUDGET_HEADROOM = 128;
const IMAGE_LOAD_TIMEOUT_MS = 8_000;
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
/** Label suffix of the deterministic feather strips, for diagnostics/tests. */
const FEATHER_STRIP_LABEL = "#feather";

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
  /** Render mask; every host object supports it, the memory kit mirrors Pixi. */
  mask: SceneNodeLike | null;
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
  /** Drops every accumulated shape so a mask can be rebuilt per frame. */
  clear(): SceneGraphicsLike;
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
    readonly htmlText?: ConstructorParameters<typeof TextBlockRasterizer>[0];
    readonly extract: {
      canvas(
        target:
          | SceneNodeLike
          | { readonly target: SceneNodeLike; readonly frame?: unknown },
      ): unknown;
    };
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

export interface SceneParticleBatchLike {
  readonly node: SceneNodeLike;
  update(data: Float32Array, count: number): void;
  destroy(): void;
}

export interface SceneKit {
  application(): SceneApplicationLike;
  /**
   * Nearest-sampling copy of an already decoded texture, for particles only.
   *
   * It owns an isolated sampler (and GPU upload) over the same decoded pixels
   * at the same dimensions, so the shared texture that Sprites draw keeps its
   * own filtering.  Destroying it never destroys `base`.
   */
  particleTexture(base: SceneTextureLike): SceneTextureLike;
  particles(texture: SceneTextureLike, capacity: number, blend: "normal" | "add", bounds: SceneRect): SceneParticleBatchLike;
  container(): SceneNodeLike;
  sprite(texture: SceneTextureLike): SceneSpriteLike;
  graphics(): SceneGraphicsLike;
  textureFromImage(image: HTMLImageElement): SceneTextureLike;
  videoSource(element: HTMLVideoElement): SceneVideoSourceLike;
  videoSprite(source: SceneVideoSourceLike): SceneSpriteLike;
  /** Post-processing host for the shader screen effects of one container. */
  shaderHost(target: SceneNodeLike): SceneShaderHostLike;
}

/**
 * Nearest-sampling texture over its own `ImageSource`.
 *
 * The source is exclusively owned, so destroying the texture always destroys
 * it (after `unbind` ran) and never touches the shared texture it was copied
 * from.
 */
class ParticleTexture extends Texture {
  readonly #unbind: (source: TextureSource) => void;

  constructor(source: ImageSource, unbind: (source: TextureSource) => void) {
    super({ source, label: "particle-nearest" });
    this.#unbind = unbind;
  }

  override destroy(): void {
    this.#unbind(this.source);
    super.destroy(true);
  }
}

/** Default kit backed by the real Pixi renderer. */
export function pixiSceneKit(): SceneKit {
  let owner: Application | undefined;
  // Pixi's shared particle shader keeps the last drawn source bound; restore
  // its default before that source goes away so nothing destroyed stays bound.
  const unbindParticleSource = (source: TextureSource): void => {
    const pipes = owner?.renderer as unknown as
      | { renderPipes?: { particle?: { defaultShader?: { resources?: Record<string, unknown> } } } }
      | undefined;
    const resources = pipes?.renderPipes?.particle?.defaultShader?.resources;
    if (resources !== undefined && resources.uTexture === source)
      resources.uTexture = Texture.WHITE.source;
  };
  return {
    application: () => {
      const application = new Application();
      owner = application;
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
    particleTexture: (base) => {
      const shared = (base as Texture).source;
      const resource: unknown = shared.resource;
      if (!ImageSource.test(resource)) throw new Error("粒子纹理需要已解码的位图");
      // Same decoded bitmap, own sampler: the style lives on the source, so a
      // second source is the only way to sample particles differently without
      // changing how Sprites draw the cached shared texture.
      const texture = new ParticleTexture(new ImageSource({
        resource, resolution: shared.resolution, alphaMode: shared.alphaMode,
        scaleMode: "nearest", label: "particle-nearest",
      }), unbindParticleSource);
      if (texture.width !== base.width || texture.height !== base.height) {
        texture.destroy();
        throw new Error("粒子纹理尺寸与原图不一致");
      }
      return texture;
    },
    particles: (texture, capacity, blend, bounds) => {
      const container = new ParticleContainer({
        texture: texture as Texture, blendMode: blend,
        dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: false },
        boundsArea: new Rectangle(bounds.x, bounds.y, bounds.width, bounds.height),
      });
      const pool = Array.from({ length: capacity }, () => new Particle({ texture: texture as Texture, anchorX: 0.5, anchorY: 0.5 }));
      return {
        node: container as unknown as SceneNodeLike,
        update: (data, count) => {
          const previousCount = container.particleChildren.length;
          container.particleChildren.length = count;
          for (let index = 0; index < count; index += 1) {
            const particle = pool[index]!;
            const offset = index * PARTICLE_STRIDE;
            particle.x = data[offset]!;
            particle.y = data[offset + 1]!;
            particle.scaleX = particle.scaleY = data[offset + 2]!;
            particle.rotation = data[offset + 3]!;
            particle.alpha = data[offset + 4]!;
            container.particleChildren[index] = particle;
          }
          if (previousCount !== count) container.update();
        },
        // The texture is shared by every emitter of the image and released by
        // the surface, so the batch never owns it.
        destroy: () => container.destroy({ texture: false, textureSource: false }),
      };
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
    shaderHost: (target) =>
      createPixiShaderHost(target as unknown as Container),
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
  background?: string | null;
  sprites: Record<string, SpriteSnapshot>;
  emitters?: Record<string, EmitterSnapshot>;
  camera: CameraSnapshot;
  /** Stable curtain state restored by a hard reconcile (never a cue). */
  curtain?: CurtainSnapshot | null;
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
  /** Prepared pixels for a `gui`-asset curtain fill, when one is covered. */
  readonly curtain: PreparedAsset | null;
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
  /** Shader channels; omitted means inactive. */
  chromatic_aberration?: ActiveScreenEffect | null;
  glitch?: ActiveScreenEffect | null;
  shockwave?: ActiveScreenEffect | null;
  color_grade?: ActiveScreenEffect | null;
  focus?: ActiveScreenEffect | null;
  ripple?: ActiveScreenEffect | null;
  elapsedMs: number;
}

export interface SceneVideoHandle {
  readonly element: HTMLVideoElement;
  updateFrame(): void;
  setFrame(frame: SceneObjectFrame): void;
  release(): void;
}

/** One Sprite instance a timeline needs before it can start. */
export interface SceneCharacterRequest {
  id: string;
  asset: string;
  state?: SpriteSnapshot;
}

/** Inheritance seed for a timeline: what the scene currently shows. */
export interface SceneBases {
  sprites: Record<string, SpriteSnapshot>;
  emitters?: Record<string, EmitterSnapshot>;
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
      | "particle_state"
      | "clear_scene"
      | "camera_tween"
      | "screen_effect"
      | "curtain_transition";
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
  textBlocks?: TextBlockMap;
  particles?: ParticleMap;
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
/** Cue-conflict key for the persistent curtain layer. */
const CURTAIN_CUE = "curtain";
/** Cue-conflict key prefix for one sprite instance. */
const SPRITE_CUE = "sprite:";
/** Cue-conflict key prefix for one shader screen-effect channel. */
const SHADER_CUE = "shader:";

/**
 * The effect types the world-layer shader host owns.
 *
 * Every other type is geometry (flash, shake) and must never fall through to
 * the shake executor.  Keeping the test in one place makes the dispatch
 * exhaustive for the newly added channels as well.
 */
function isShaderScreenEffect(
  effect: ScreenEffectSpec,
): effect is Extract<ScreenEffectSpec, { type: ShaderScreenEffectType }> {
  switch (effect.type) {
    case "chromatic_aberration":
    case "glitch":
    case "shockwave":
    case "color_grade":
    case "focus":
    case "ripple":
      return true;
    default:
      return false;
  }
}

/** Screen-space z-order: world < curtain < screen effects < session curtain. */
const CAMERA_LAYER_Z = 0;
const TRANSITION_LAYER_Z = 5;
const CURTAIN_LAYER_Z = 10;
const EFFECTS_LAYER_Z = 20;
/** The host-only session curtain covers every story layer while it is up. */
const SESSION_CURTAIN_LAYER_Z = 30;

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
  state?: SpriteSnapshot;
  layoutMask?: SceneGraphicsLike;
  parent: SceneNodeLike;
}

interface SceneEmitterView {
  state: EmitterSnapshot;
  version: string;
  evaluator: ParticleEvaluator;
  batch: SceneParticleBatchLike;
  /** Shared decoded texture whose nearest-sampling copy the batch draws. */
  particleBase: SceneTextureLike;
  refs: string[];
  elapsedMs: number;
  burst: boolean;
}

interface SceneVideoState {
  element: HTMLVideoElement;
  source: SceneVideoSourceLike;
  view: SceneSpriteLike;
  track: VideoTrack;
}

/**
 * One deterministic strip of a soft wipe/push feather.
 *
 * Pixi's stencil mask is binary, so a soft edge is drawn as a fixed number of
 * strips whose alpha steps through the pure ramp; the strip sprite shares the
 * incoming view's texture and pose (no extra decode) and is clipped to its own
 * stage-space rectangle.
 */
interface SceneFeatherStrip {
  sprite: SceneSpriteLike;
  mask: SceneGraphicsLike;
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
  readonly #store: SceneTextureStore;
  readonly #geometry: SceneSpriteGeometry;
  readonly #textStore: SceneTextureStore;
  readonly #textSources = new Map<string, TextBlockSource>();
  readonly #emitters = new Map<string, SceneEmitterView>();
  /**
   * Nearest-sampling copies of particle images, keyed by the shared decoded
   * texture.  Every emitter of the same image holds one reference, so the
   * surface keeps one copy per image however many emitters or bursts draw it.
   */
  readonly #particleTextures = new Map<SceneTextureLike, { texture: SceneTextureLike; refs: number }>();
  #textBlocks: TextBlockMap = {};
  #particles: ParticleMap = {};
  #rasterizer: TextBlockRasterizer | null = null;
  get #background(): SceneSpriteView | null { return this.#sprites.get(BACKGROUND_ID) ?? null; }
  set #background(view: SceneSpriteView | null) {
    if (view === null) this.#sprites.delete(BACKGROUND_ID);
    else this.#sprites.set(BACKGROUND_ID, view);
  }
  #video: SceneVideoState | null = null;
  #flash: SceneGraphicsLike | null = null;
  #flashColor: number | null = null;
  /** Alpha multiplier carried by the flash colour (`#RRGGBBAA`). */
  #flashColorAlpha = 1;
  #effectsState: SceneActiveEffects | null = null;
  #cueShake = { x: 0, y: 0 };
  /** Post-processing of the world layer (the shader screen effects). */
  readonly #shaderHost: SceneShaderHostLike;
  /** Shader frames driven by node cues, one channel per effect type. */
  #cueShaders: ShaderEffectFrame = EMPTY_SHADER_EFFECT_FRAME;
  /** True while the shader host has at least one pass installed. */
  #shadersActive = false;
  /** Player accessibility preference; see `setReducedMotion`. */
  #reducedMotion = false;
  /** Current curtain fill descriptor, so a cue only rebuilds on a real change. */
  #curtainFillKey: string | null = null;
  #curtainFill: SceneNodeLike | null = null;
  /** Alpha multiplier carried by a colour fill (`#RRGGBBAA`). */
  #curtainFillAlpha = 1;
  #curtainFillRefs: string[] = [];
  #curtainMask: SceneGraphicsLike | null = null;
  /** Fade-through-colour overlay in the transition layer. */
  #transitionOverlay: SceneGraphicsLike | null = null;
  /** Alpha multiplier carried by the overlay colour (`#RRGGBBAA`). */
  #transitionOverlayAlpha = 1;
  #backgroundMask: SceneGraphicsLike | null = null;
  #backgroundMaskOwner: SceneSpriteView | null = null;
  /** Deterministic stepped strips of the live soft wipe/push feather. */
  #featherStrips: SceneFeatherStrip[] = [];
  /** Host-only session curtain: true while it fully covers the canvas. */
  #sessionCovered = false;
  /** Black full-stage fill of the session curtain layer. */
  #sessionCurtainFill: SceneNodeLike | null = null;
  /** Newest session-curtain transition; repeated calls coalesce onto it. */
  #sessionCurtainToken = 0;
  #sessionCurtainAction: CurtainAction | null = null;
  #sessionCurtainPromise: Promise<void> | null = null;
  /** In-flight reveal (including its wait for a drawn frame). */
  #sessionCurtainReveal: Promise<void> | null = null;
  /**
   * Identity of the current reveal operation.  A newer reveal request (or a
   * reset/dispose) advances it, so a replaced operation stops at its next
   * checkpoint instead of running a second reveal.
   */
  #sessionCurtainRevealToken = 0;
  /**
   * Epoch the parked reveal currently follows, or `-1` when no reveal is
   * parked.  A newer transition advances `#sessionCurtainEpoch`, so the two
   * differ exactly while a superseded reveal is still parked: a reveal call in
   * that window must start a fresh operation instead of sharing the doomed
   * no-op promise.
   */
  #sessionCurtainRevealEpoch = -1;
  /**
   * Ownership epoch of the session curtain.
   *
   * Every transition and every reset/dispose bumps it.  A parked reveal
   * captured the epoch when it became the newest request; once the epoch has
   * moved on, a newer cover (or a session boundary) owns the curtain and the
   * parked reveal must stop instead of adopting the newer operation.
   */
  #sessionCurtainEpoch = 0;
  /** Callbacks waiting for the next drawn frame (reveal-after-stable-frame). */
  #frameWaiters: (() => void)[] = [];
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
    this.#backgrounds = this.#videos = this.#cameraLayer;
    this.#screenLayer = this.#kit.container();
    this.#textBlocks = options.textBlocks ?? {};
    this.#particles = options.particles ?? {};
    this.#effects = this.#kit.container();
    this.#transition = this.#kit.container();
    this.#curtainLayer = this.#kit.container();
    this.#sessionCurtainLayer = this.#kit.container();
    // Shader effects post-process the world only: like shake, they never
    // touch the curtain, the screen overlays, the host session curtain or the
    // DOM dialogue/UI above the canvas.
    this.#shaderHost = this.#kit.shaderHost(this.#cameraLayer);
    this.#store = new SceneTextureStore({
      load: options.textureLoader ?? ((url) => this.#loadTexture(url)),
      budget:
        options.textureBudget ??
        textureBudgetFor(MIN_SESSION_TEXTURES, this.#animations),
    });
    this.#textStore = new SceneTextureStore<SceneTextureLike>({
      budget: 64,
      load: async (key) => {
        const source = this.#textSources.get(key);
        if (source === undefined || this.#rasterizer === null) throw new Error("文本纹理生成器未初始化");
        return this.#rasterizer.create(source);
      },
      release: (texture) => this.#rasterizer?.release(texture as Texture),
    });
    this.#geometry = {
      spriteSize: (asset) => this.#spriteSize(asset),
      emitterSize: (particle) => {
        const area = this.#particles[particle]?.area;
        return area?.type === "rectangle" ? { width: Math.max(24, area.width), height: Math.max(24, area.height) } : { width: 24, height: 24 };
      },
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
      this.#screenLayer.sortableChildren = true;
      this.#screenLayer.zIndex = 1;
      const htmlText = this.#application.renderer.htmlText;
      if (htmlText !== undefined) this.#rasterizer = new TextBlockRasterizer(htmlText);
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
      // Insertion order keeps the historic array indices stable (the test kit
      // reads `stage.children[1]` for screen effects); `zIndex` decides the
      // actual render order, so the curtain still draws below the effects and
      // the host session curtain covers everything.
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
    this.#animations = animations;
    this.#store.setBudget(textureBudgetFor(MIN_SESSION_TEXTURES, animations));
  }

  setVisualResources(textBlocks: TextBlockMap, particles: ParticleMap): void {
    if (this.#textBlocks === textBlocks && this.#particles === particles) return;
    this.#prepareAbort?.abort();
    this.#prepareGeneration += 1;
    this.#startVisualGeneration();
    this.#textBlocks = textBlocks;
    this.#particles = particles;
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
    this.#validateEmitterWorld(world.emitters ?? {});
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
      for (const asset of acquired) this.#releasePrepared(asset);
      acquired.length = 0;
    };
    try {
      const wanted = new Set<string>(Object.values(world.sprites).map(spriteResourceId));
      for (const emitter of Object.values(world.emitters ?? {})) {
        wanted.add(this.#particles[emitter.particle]!.image);
      }
      const curtainAsset = curtainAssetOf(world.curtain ?? null);
      if (curtainAsset !== null) wanted.add(curtainAsset);
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
        preparation.resources.set(asset, prepared);
        if (curtainAsset === asset) {
          (preparation as { curtain: PreparedAsset | null }).curtain = prepared;
        }
      }
      for (const state of Object.values(world.emitters ?? {})) {
        this.#validateEmitterResource(state, preparation.resources.get(this.#particles[state.particle]!.image));
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
      this.#validateEmitterWorld(world.emitters ?? {});
    } catch (error) {
      this.discardPreparation(preparation);
      throw error;
    }
    // A committed world is a new visual generation: cues that are still in
    // flight release what they detached and give up settling their pose.
    this.#startVisualGeneration();
    this.#assets = preparation.assets;
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
          ? view.label === this.#assetLabel(resource, preparation.assets)
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
      const next = this.#createView(id, prepared, this.#objectParent(state.space));
      if (next === null) continue;
      this.#poseView(next, state);
      this.#sprites.set(id, next);
    }
    this.#reconcileEmitters(world.emitters ?? {}, preparation);
    this.#camera = { ...world.camera };
    this.#commitCurtain(preparation.curtain, world.curtain ?? null);
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
    this.#destroyCurtainFill();
    this.#clearTransitionOverlay();
    for (const view of this.#sprites.values()) this.#releaseView(view);
    this.#sprites.clear();
    this.#clearEmitters();
    this.#loops.clear();
    this.#clearEffects();
    this.#overrides = EMPTY_SCENE_OVERRIDES;
    this.#evaluated = null;
    this.#current = null;
    this.#camera = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
    // A reset is a session boundary: the host curtain never survives the
    // world it was covering, and neither does the operation that was running
    // it (a later cover must never coalesce onto the aborted promise).
    this.#destroySessionCurtainFill();
    this.#sessionCovered = false;
    this.#abortSessionCurtainOperations();
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
    return hitTestSceneFrame(this.readFrame(), { x, y }, this.#currentShake());
  }

  // -- effects ---------------------------------------------------------------

  /**
   * Sets the timeline-derived screen effects for the current playhead.
   *
   * Every channel is derived from the same position, so scrubbing, pausing and
   * playing all agree.  The channels coexist: shake is composed into the
   * camera transform instead of overwriting it, and the shader passes stack in
   * their fixed order on top of the shaken world.
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

  get reducedMotion(): boolean {
    return this.#reducedMotion;
  }

  /**
   * Player accessibility preference: attenuates flashes, shakes and shader
   * effects on both the timeline and the cue path, from the next frame on.
   */
  setReducedMotion(enabled: boolean): void {
    if (this.#reducedMotion === enabled) return;
    this.#reducedMotion = enabled;
    this.#applyEffects();
    this.#applyCamera();
    this.#requestRender();
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
        await this.#particleCue(cue, context);
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
      case "curtain_transition":
        await this.#transitionCurtain(cue, context);
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
      sprites[view.id] = this.#readView(view);
    }
    const emitters: Record<string, EmitterSnapshot> = {};
    for (const [id, view] of this.#emitters) if (!view.burst) emitters[id] = { ...view.state };
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
          this.#showsAssetRevision(current, request.asset, assets)
        ) {
          continue;
        }
        if (!isCurrent()) {
          for (const item of pending) this.#releasePrepared(item.prepared);
          return false;
        }
        const prepared = await this.#acquireAsset(request.asset, assets);
        if (!isCurrent()) {
          this.#releasePrepared(prepared);
          for (const item of pending) this.#releasePrepared(item.prepared);
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
      const state = request.state ?? spritePreset("character", { type: "image", asset: request.asset });
      const view = this.#createView(request.id, prepared, this.#objectParent(state.space));
      if (view === null) {
        this.#releasePrepared(prepared);
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

  // -- host-only session curtain ---------------------------------------------

  /** True while the host-only session curtain fully covers the canvas. */
  get sessionCovered(): boolean {
    return this.#sessionCovered;
  }

  /**
   * Covers the canvas with the host-only session curtain.
   *
   * The host uses this before it replaces the whole world (new game, load,
   * replay start, controller reset).  It shares the pure curtain evaluator and
   * the persistent curtain render primitive with the story `curtain_transition`
   * cue, but it never enters `WorldSnapshot` or a story cue, so a later hard
   * snapshot alignment can never replay it.  Repeated calls while a cover is
   * already in flight share that one transition — React Strict Mode's double
   * setup therefore performs no duplicate work.  A cover that interrupts a
   * running reveal continues from the alpha that is on screen instead of
   * snapping the curtain transparent.  A cover issued while a reveal is parked
   * waiting for its stable frame supersedes that reveal: the newest request
   * owns the curtain, so the cover is never swallowed as redundant.
   */
  coverSession(durationMs: number = SESSION_CURTAIN_MS): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#sessionCurtainAction === "cover") {
      return this.#sessionCurtainPromise ?? Promise.resolve();
    }
    if (
      this.#sessionCovered &&
      this.#sessionCurtainAction === null &&
      this.#sessionCurtainReveal === null
    ) {
      return Promise.resolve();
    }
    return this.#runSessionCurtain("cover", durationMs);
  }

  /**
   * Reveals the session curtain again.
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
  revealSession(durationMs: number = SESSION_CURTAIN_MS): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#sessionCurtainReveal !== null) {
      // A parked reveal still following the newest transition is the shared
      // promise every duplicate call receives.  Once a newer cover (or a
      // session boundary) has moved the epoch on, that promise is a doomed
      // no-op for this newer request, so fall through and start a fresh one.
      if (this.#sessionCurtainRevealEpoch === this.#sessionCurtainEpoch) {
        return this.#sessionCurtainReveal;
      }
    } else {
      if (this.#sessionCurtainAction === "reveal") {
        return this.#sessionCurtainPromise ?? Promise.resolve();
      }
      if (!this.#sessionCovered && this.#sessionCurtainAction !== "cover") {
        return Promise.resolve();
      }
    }
    const token = ++this.#sessionCurtainRevealToken;
    const operation = (async (): Promise<void> => {
      while (!this.#disposed) {
        // A cover in flight owns the curtain, but a reveal requested during it
        // must not be dropped: wait for the cover and keep asking.  Waiting
        // still follows the newest request, so duplicate calls keep sharing
        // this operation.
        const action = this.#sessionCurtainAction;
        if (action === "cover") {
          this.#sessionCurtainRevealEpoch = this.#sessionCurtainEpoch;
          await (this.#sessionCurtainPromise ?? Promise.resolve());
          // A newer reveal request replaced this operation while it waited;
          // the replacement owns the caller's promise now.
          if (token !== this.#sessionCurtainRevealToken) return;
          continue;
        }
        // Nothing is running, so this request is the newest owner of the
        // curtain.  Remember the ownership epoch: a cover that starts (or a
        // reset/dispose that aborts the session) before this reveal fades is a
        // newer request and supersedes the parked reveal.
        const epoch = this.#sessionCurtainEpoch;
        this.#sessionCurtainRevealEpoch = epoch;
        // The replacement must be on screen before the cover starts fading.
        await this.#nextFrame();
        if (this.#disposed) return;
        if (token !== this.#sessionCurtainRevealToken) return;
        if (epoch !== this.#sessionCurtainEpoch) return;
        if (!this.#sessionCovered) return;
        const run = this.#runSessionCurtain("reveal", durationMs);
        // The running fade owns the newest epoch; callers arriving during it
        // share this operation instead of starting a second reveal.
        this.#sessionCurtainRevealEpoch = this.#sessionCurtainEpoch;
        await run;
        return;
      }
    })().finally(() => {
      if (this.#sessionCurtainRevealToken === token) {
        this.#sessionCurtainReveal = null;
      }
    });
    this.#sessionCurtainReveal = operation;
    return operation;
  }

  /**
   * Runs one cover/reveal transition of the host curtain.
   *
   * A newer request (or a reset/dispose that aborts the cue generation)
   * supersedes this one; the superseded run never writes a frame and the
   * curtain stays owned by whoever superseded it.
   */
  #runSessionCurtain(action: CurtainAction, durationMs: number): Promise<void> {
    const token = ++this.#sessionCurtainToken;
    // Every transition opens a new ownership epoch; a reveal parked on an
    // older epoch stops as soon as it resumes.
    this.#sessionCurtainEpoch += 1;
    const generation = this.#sceneGeneration;
    this.#sessionCurtainAction = action;
    const operation = (async (): Promise<void> => {
      if (action === "cover") {
        // The host curtain is always a fixed opaque black on its own layer, so
        // a story curtain's colour/asset fill and the world's curtain state
        // are never touched by a session switch.
        this.#ensureSessionCurtainFill();
      } else if (this.#sessionCurtainFill === null) {
        this.#sessionCovered = false;
        return;
      }
      // A newer transition supersedes a running fade; it continues from the
      // alpha that is actually on screen instead of snapping transparent (a
      // cover that interrupts a reveal must not flash the world through).
      const from = this.#sessionCurtainFill?.alpha ?? 0;
      const applyFrame = (progress: number): void => {
        if (!this.#isCurrent(generation) || token !== this.#sessionCurtainToken)
          return;
        const frame = evaluateCurtainTransition(
          { type: "fade" },
          action,
          progress,
        );
        const fill = this.#sessionCurtainFill;
        if (fill === null) return;
        const alpha =
          action === "cover"
            ? from + (1 - from) * frame.alpha
            : from * frame.alpha;
        fill.visible = alpha > 0;
        fill.alpha = alpha;
        this.#requestRender();
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
          await this.#runAnimation(durationMs, "linear", applyFrame, {
            assets: this.#assets,
            signal: fade.signal,
            getRate: () => 1,
          });
        } finally {
          clearTimeout(watchdog);
        }
      }
      if (!this.#isCurrent(generation) || token !== this.#sessionCurtainToken) {
        return;
      }
      applyFrame(1);
      if (action === "cover") {
        this.#sessionCovered = true;
      } else {
        this.#destroySessionCurtainFill();
        this.#sessionCovered = false;
      }
    })().finally(() => {
      if (token === this.#sessionCurtainToken) {
        this.#sessionCurtainAction = null;
        this.#sessionCurtainPromise = null;
      }
    });
    this.#sessionCurtainPromise = operation;
    return operation;
  }

  /** Drops the session-curtain operation state after a reset/dispose. */
  #abortSessionCurtainOperations(): void {
    // Bumping the token also stops the superseded run's `finally` from
    // clearing the state of a newer operation, and bumping the epoch stops a
    // parked reveal from surviving the session boundary (reset/dispose).
    this.#sessionCurtainToken += 1;
    this.#sessionCurtainEpoch += 1;
    this.#sessionCurtainAction = null;
    this.#sessionCurtainPromise = null;
    this.#sessionCurtainReveal = null;
    this.#sessionCurtainRevealToken += 1;
    this.#sessionCurtainRevealEpoch = -1;
  }

  /** Creates the fixed black full-stage cover of the session curtain. */
  #ensureSessionCurtainFill(): void {
    if (this.#sessionCurtainFill !== null) return;
    const fill = this.#kit.graphics();
    fill.rect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT).fill(0x000000);
    fill.alpha = 0;
    this.#sessionCurtainLayer.addChild(fill);
    this.#sessionCurtainFill = fill;
  }

  /** Drops the session curtain cover and its layer contents, exactly once. */
  #destroySessionCurtainFill(): void {
    const fill = this.#sessionCurtainFill;
    this.#sessionCurtainFill = null;
    if (fill === null) return;
    this.#sessionCurtainLayer.removeChild(fill);
    fill.destroy();
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
    this.#destroyCurtainFill();
    this.#clearTransitionOverlay();
    for (const view of this.#sprites.values()) this.#releaseView(view);
    this.#sprites.clear();
    this.#clearEmitters();
    this.#loops.clear();
    this.#clearEffects();
    this.#destroySessionCurtainFill();
    this.#sessionCovered = false;
    this.#abortSessionCurtainOperations();
    this.#flushFrameWaiters();
    this.#loop?.dispose();
    this.#loop = null;
    this.#store.destroy();
    this.#textStore.destroy();
    this.#rasterizer?.destroy();
    this.#textSources.clear();
    this.#shaderHost.destroy();
    this.#shadersActive = false;
    this.#application.destroy({ removeView: false }, { children: true });
  }

  // -- internals: world ------------------------------------------------------

  /**
   * Decodes every frame of an asset, replacing a broken frame with the nearest
   * usable one so a single bad file can never block a story gate.  Only an
   * asset with no usable frame at all fails.
   */
  async #prepareAsset(
    asset: string,
    assets: AssetUrlMap,
  ): Promise<PreparedAsset | null> {
    const textId = textBlockId(asset);
    if (textId !== undefined) {
      const source = this.#textBlocks[textId];
      if (source === undefined) throw new Error(`固定文本块不存在: ${textId}`);
      const version = textBlockVersion(source);
      const key = `text-texture:${version}`;
      this.#textSources.set(key, source);
      let texture: SceneTextureLike;
      try { texture = await this.#textStore.acquire(key); }
      catch (error) { if (!this.#textStore.has(key)) this.#textSources.delete(key); throw error; }
      return {
        asset, label: key, version, urls: [key], textures: [texture],
        source: { asset, url: key, width: source.definition.width, height: source.definition.height },
      };
    }
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
    this.#releaseRefs(prepared.urls);
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
    return prepared.urls.filter((url) => this.#resourceStore(url).retain(url));
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
      parent,
    };
    view.unsubscribe = view.player.subscribe((changed: FrameSequencePlayer) => {
      this.#applyFrameTexture(view, changed.frameIndex());
    });
    this.#applyFrameTexture(view, view.player.frameIndex());
    return view;
  }

  #resourceStore(key: string): SceneTextureStore {
    return key.startsWith("text-texture:") ? this.#textStore : this.#store;
  }

  #releaseRefs(refs: readonly string[]): void {
    for (const key of new Set(refs)) {
      const store = this.#resourceStore(key);
      store.release(key);
      if (store === this.#textStore && !store.has(key)) this.#textSources.delete(key);
    }
  }

  #objectParent(space?: "world" | "screen"): SceneNodeLike {
    return space === "screen" ? this.#screenLayer : this.#cameraLayer;
  }

  #poseView(view: SceneSpriteView, state: SpriteSnapshot): void {
    const parent = this.#objectParent(state.space);
    if (view.parent !== parent) {
      view.parent.removeChild(view.sprite);
      if (view.layoutMask !== undefined) view.parent.removeChild(view.layoutMask);
      parent.addChild(view.sprite);
      if (view.layoutMask !== undefined) parent.addChild(view.layoutMask);
      view.parent = parent;
    }
    view.state = state;
    applySprite(view.sprite, state);
    if (state.layout?.fit === "cover") {
      const mask = view.layoutMask ?? this.#kit.graphics();
      if (view.layoutMask === undefined) { mask.label = `layout:${view.id}`; view.layoutMask = mask; parent.addChild(mask); }
      const fit = spriteFit(view.sprite.texture.width, view.sprite.texture.height, state.layout);
      const width = state.layout.width / fit.x, height = state.layout.height / fit.y;
      mask.clear().rect(-(state.anchor_x ?? 0.5) * width, -(state.anchor_y ?? 1) * height, width, height).fill(0xffffff);
      mask.position.set(state.x, state.y);
      mask.scale.set(view.sprite.scale.x, view.sprite.scale.y);
      mask.rotation = view.sprite.rotation;
      view.sprite.mask = mask;
    } else if (view.layoutMask !== undefined) {
      view.sprite.mask = null;
      view.layoutMask.destroy();
      delete view.layoutMask;
    }
  }

  #readView(view: SceneSpriteView): SpriteSnapshot {
    const state = view.state;
    const result = { ...state, ...readSprite(view.sprite) };
    const fit = spriteFit(view.sprite.texture.width, view.sprite.texture.height, state?.layout);
    result.scale /= fit.x;
    result.scale_y *= fit.x / fit.y;
    result.anchor_x = state?.anchor_x ?? result.anchor_x ?? 0.5;
    result.anchor_y = state?.anchor_y ?? result.anchor_y ?? 1;
    result.source ??= { type: "image", asset: view.source.asset };
    return result;
  }

  #releaseEmitter(id: string): void {
    const view = this.#emitters.get(id);
    if (view === undefined) return;
    this.#emitters.delete(id);
    view.batch.destroy();
    // The nearest-sampling copy shares the decoded bitmap of the base texture,
    // so it goes away before the references that keep the base resident.
    this.#releaseParticleTexture(view.particleBase);
    this.#releaseRefs(view.refs);
  }

  #retainParticleTexture(base: SceneTextureLike): SceneTextureLike {
    const existing = this.#particleTextures.get(base);
    if (existing !== undefined) {
      existing.refs += 1;
      return existing.texture;
    }
    const texture = this.#kit.particleTexture(base);
    this.#particleTextures.set(base, { texture, refs: 1 });
    return texture;
  }

  #releaseParticleTexture(base: SceneTextureLike): void {
    const entry = this.#particleTextures.get(base);
    if (entry === undefined) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.#particleTextures.delete(base);
    entry.texture.destroy(true);
  }

  #clearEmitters(): void {
    for (const id of this.#emitters.keys()) this.#releaseEmitter(id);
  }

  #emitterVersion(state: EmitterSnapshot, prepared: PreparedAsset): string {
    return JSON.stringify([this.#particles[state.particle], state.seed, state.generation, prepared.version]);
  }

  #poseEmitter(view: SceneEmitterView, state: EmitterSnapshot): void {
    const previous = this.#objectParent(view.state.space);
    const parent = this.#objectParent(state.space);
    if (previous !== parent) { previous.removeChild(view.batch.node); parent.addChild(view.batch.node); }
    view.state = state;
    view.batch.node.position.set(state.x, state.y);
    view.batch.node.scale.set(state.scale, state.scale);
    view.batch.node.rotation = state.rotation_deg * Math.PI / 180;
    view.batch.node.alpha = state.opacity;
    view.batch.node.zIndex = state.z;
  }

  #validateEmitterWorld(states: Record<string, EmitterSnapshot>): void {
    let budget = 0;
    for (const [id, state] of Object.entries(states)) {
      if (id.startsWith("burst:")) throw new Error("发射器实例 ID 使用了保留前缀");
      validateEmitter(state);
      const definition = this.#particles[state.particle];
      if (definition === undefined) throw new Error(`粒子效果不存在: ${state.particle}`);
      validateParticleDefinition(definition);
      budget += definition.max_particles;
    }
    for (const view of this.#emitters.values()) if (view.burst) budget += view.evaluator.definition.max_particles;
    if (budget > MAX_SURFACE_PARTICLES) throw new Error("粒子总量超过画布预算");
  }

  #validateEmitterResource(state: EmitterSnapshot, prepared?: PreparedAsset): ParticleDefinition {
    validateEmitter(state);
    const definition = this.#particles[state.particle];
    if (definition === undefined) throw new Error(`粒子效果不存在: ${state.particle}`);
    validateParticleDefinition(definition);
    const texture = prepared?.textures[0];
    if (texture === undefined || prepared?.source.animation !== undefined || texture.width > 512 || texture.height > 512) {
      throw new Error("粒子图片必须为不超过 512×512 的静态图片");
    }
    return definition;
  }

  #createEmitter(id: string, state: EmitterSnapshot, prepared: PreparedAsset, burst: boolean): void {
    const definition = this.#validateEmitterResource(state, prepared);
    let budget = definition.max_particles;
    for (const [otherId, view] of this.#emitters) if (otherId !== id) budget += view.evaluator.definition.max_particles;
    if (budget > MAX_SURFACE_PARTICLES) throw new Error("粒子总量超过画布预算");
    const evaluator = new ParticleEvaluator(definition, state.seed, burst);
    const texture = prepared.textures[0]!;
    const life = definition.lifetime_ms.max / 1000;
    const area = definition.area.type === "rectangle" ? definition.area : { width: 0, height: 0 };
    const extentX = area.width / 2 + Math.max(Math.abs(definition.velocity_x.min), Math.abs(definition.velocity_x.max)) * life
      + Math.abs(definition.gravity_x) * life ** 2 / 2 + Math.hypot(texture.width, texture.height) * definition.size.max;
    const extentY = area.height / 2 + Math.max(Math.abs(definition.velocity_y.min), Math.abs(definition.velocity_y.max)) * life
      + Math.abs(definition.gravity_y) * life ** 2 / 2 + Math.hypot(texture.width, texture.height) * definition.size.max;
    // Retained before the previous view of this id is released, so replacing an
    // emitter of the same image keeps its nearest-sampling copy alive.
    const sampled = this.#retainParticleTexture(texture);
    let batch: SceneParticleBatchLike;
    try {
      batch = this.#kit.particles(sampled, definition.max_particles, definition.blend,
        { x: -extentX, y: -extentY, width: extentX * 2, height: extentY * 2 });
    } catch (error) {
      this.#releaseParticleTexture(texture);
      throw error;
    }
    this.#releaseEmitter(id);
    const view: SceneEmitterView = { state, version: this.#emitterVersion(state, prepared), evaluator, batch,
      particleBase: texture, refs: this.#claim(prepared), elapsedMs: 0, burst };
    this.#emitters.set(id, view);
    this.#objectParent(state.space).addChild(batch.node);
    this.#poseEmitter(view, state);
    batch.update(evaluator.data, evaluator.evaluate(0));
  }

  #reconcileEmitters(states: Record<string, EmitterSnapshot>, preparation: ScenePreparation): void {
    for (const [id, view] of this.#emitters) {
      if (view.burst) continue;
      const state = states[id];
      const prepared = state === undefined ? undefined : preparation.resources.get(this.#particles[state.particle]!.image);
      if (state === undefined || prepared === undefined || view.version !== this.#emitterVersion(state, prepared)) this.#releaseEmitter(id);
    }
    for (const [id, state] of Object.entries(states)) {
      const prepared = preparation.resources.get(this.#particles[state.particle]!.image)!;
      const view = this.#emitters.get(id);
      if (view !== undefined && !view.burst && view.version === this.#emitterVersion(state, prepared)) {
        this.#poseEmitter(view, state);
      } else this.#createEmitter(id, state, prepared, false);
    }
  }

  async #particleCue(cue: Extract<SceneVisualCue, { type: "particle_state" }>, context: SceneCueContext): Promise<void> {
    const key = cue.burst ? `burst:${cue.cue_id}` : `emitter:${cue.emitter_id}`;
    const generation = this.#sceneGeneration;
    const token = this.#beginCueRequest(key);
    if (cue.emitter === null) { this.#releaseEmitter(cue.emitter_id); this.#requestRender(); return; }
    const definition = this.#particles[cue.emitter.particle];
    if (definition === undefined) throw new Error(`粒子效果不存在: ${cue.emitter.particle}`);
    const prepared = await this.#acquireAsset(definition.image, context.assets);
    try {
      if (context.signal.aborted || !this.#isLatestCueRequest(generation, key, token)) return;
      const id = cue.burst ? `burst:${cue.cue_id}` : cue.emitter_id;
      this.#createEmitter(id, cue.emitter, prepared, cue.burst);
      this.#requestRender();
    } finally { this.#releasePrepared(prepared); }
  }

  /** Deterministic editor decoration preview; no wall clock is consulted. */
  seekParticles(elapsedMs: number): void {
    for (const view of this.#emitters.values()) {
      view.elapsedMs = elapsedMs;
      view.batch.update(view.evaluator.data, view.evaluator.evaluate(elapsedMs));
    }
    this.#requestRender();
  }

  /** Nearest-sampling particle copies resident on this surface and their emitter references. */
  get particleTextures(): { resident: number; refs: number } {
    let refs = 0;
    for (const entry of this.#particleTextures.values()) refs += entry.refs;
    return { resident: this.#particleTextures.size, refs };
  }

  get particleStats(): { emitters: number; live: number; capacity: number; textures: number } {
    let live = 0, capacity = 0;
    for (const view of this.#emitters.values()) { live += view.evaluator.count; capacity += view.evaluator.definition.max_particles; }
    return { emitters: this.#emitters.size, live, capacity, textures: this.#store.size + this.#textStore.size };
  }

  #createBackgroundView(prepared: PreparedAsset): SceneSpriteView | null {
    const view = this.#createView(BACKGROUND_ID, prepared, this.#backgrounds);
    if (view === null) return null;
    this.#poseView(view, spritePreset("background", { type: "image", asset: prepared.asset }));
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
      // A soft edge on an animated incoming background draws copies of it;
      // keep them on the same frame the view now shows.
      if (view === this.#backgroundMaskOwner) {
        for (const strip of this.#featherStrips) {
          strip.sprite.texture = view.sprite.texture;
        }
      }
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
    this.#releaseRefs(view.refs);
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
    // Cue-owned visuals belong to the generation that started them: a reset, a
    // world commit or a clear must not leave a half-drawn transition mask, a
    // fade-through overlay or a sampled shake offset behind.  A background cue
    // that is still in flight gives up its cleanup (its token is stale once
    // the generation moves on), so this is the only place that releases them.
    this.#cueShake = { x: 0, y: 0 };
    this.#cueShaders = EMPTY_SHADER_EFFECT_FRAME;
    this.#syncShaders();
    this.#clearTransitionOverlay();
    this.#clearBackgroundMask();
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
    // Detach the wipe/soft-push mask before the view it clips is destroyed;
    // a released Pixi object must not be written to afterwards.
    this.#clearBackgroundMask();
    const previous = this.#background;
    this.#background = null;
    if (previous !== null) this.#releaseView(previous);
    this.#releaseStagedViewsFor(BACKGROUND_ID);
    // A background that is gone cannot be covered by a transition overlay.
    this.#clearTransitionOverlay();
  }

  // -- internals: persistent curtain -----------------------------------------

  /**
   * Applies a curtain snapshot without replaying a cue.
   *
   * This is the hard-reconcile path used by `applyWorld`, so a restored save
   * shows exactly the curtain it stored.
   */
  #commitCurtain(
    prepared: PreparedAsset | null,
    snapshot: CurtainSnapshot | null,
  ): void {
    const fill = snapshot?.covered ? (snapshot.fill ?? null) : null;
    if (fill === null) {
      this.#destroyCurtainFill();
      return;
    }
    if (!this.#ensureCurtainFill(fill, prepared)) {
      // Missing pixels must never reveal the world behind a covered curtain;
      // fall back to an opaque cover so the stable state stays trustworthy.
      // The fallback is silent to the player, so it is reported here.
      this.#diagnostic(
        `幕布素材缺失或加载失败，已回退为纯色幕布：${describeCurtainFill(fill)}`,
      );
      this.#ensureCurtainFill({ color: "#000000" }, null);
    }
    this.#applyCurtainFrame({ alpha: 1, rects: [fullStageRect()] });
  }

  /**
   * Ensures the curtain fill view matches `fill`.
   *
   * Returns `false` when an asset fill has no prepared pixels yet, so the
   * caller can fall back instead of showing an empty layer.
   */
  #ensureCurtainFill(
    fill: CurtainFill,
    prepared: PreparedAsset | null,
  ): boolean {
    // The asset revision is part of the identity: an edited `gui` asset keeps
    // its id but changes its pixels, and the curtain must follow it.
    const key =
      "asset" in fill
        ? `asset:${fill.asset}:${prepared?.version ?? ""}`
        : `color:${fill.color}`;
    if (this.#curtainFillKey === key && this.#curtainFill !== null) return true;
    this.#destroyCurtainFill();
    if (!("asset" in fill)) {
      const parsed = parseColor(fill.color);
      const graphics = this.#kit.graphics();
      graphics.rect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT).fill(parsed.color);
      this.#curtainLayer.addChild(graphics);
      this.#curtainFill = graphics;
      this.#curtainFillKey = key;
      this.#curtainFillAlpha = parsed.alpha;
      return true;
    }
    const texture = prepared?.textures[0];
    if (texture === undefined) return false;
    const sprite = this.#kit.sprite(texture);
    const width = texture.width;
    const height = texture.height;
    const scale = Math.max(DESIGN_WIDTH / width, DESIGN_HEIGHT / height);
    sprite.anchor.set(0, 0);
    sprite.scale.set(scale);
    sprite.position.set(
      (DESIGN_WIDTH - width * scale) / 2,
      (DESIGN_HEIGHT - height * scale) / 2,
    );
    this.#curtainLayer.addChild(sprite);
    this.#curtainFill = sprite;
    this.#curtainFillKey = key;
    this.#curtainFillAlpha = 1;
    if (prepared !== null) this.#curtainFillRefs = this.#claim(prepared);
    return true;
  }

  /** Applies one pure curtain frame (alpha + covered rectangles). */
  #applyCurtainFrame(frame: CurtainTransitionFrame): void {
    const fill = this.#curtainFill;
    const visibleRects = frame.rects.filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
    if (fill === null || frame.alpha <= 0 || visibleRects.length === 0) {
      if (fill !== null) fill.visible = false;
      return;
    }
    fill.visible = true;
    // The authored colour may carry its own `#RRGGBBAA` alpha; the transition
    // frame scales it rather than replacing it.
    fill.alpha = frame.alpha * this.#curtainFillAlpha;
    const mask = this.#curtainMask ?? this.#kit.graphics();
    if (this.#curtainMask === null) {
      this.#curtainLayer.addChild(mask);
      this.#curtainMask = mask;
    }
    mask.clear();
    for (const rect of visibleRects) {
      mask.rect(rect.x, rect.y, rect.width, rect.height);
    }
    mask.fill(0xffffff);
    fill.mask = mask;
  }

  /**
   * Drops the curtain fill, its mask and the texture references it owns.
   */
  #destroyCurtainFill(): void {
    const fill = this.#curtainFill;
    this.#curtainFill = null;
    this.#curtainFillKey = null;
    this.#curtainFillAlpha = 1;
    if (fill !== null) {
      fill.mask = null;
      this.#curtainLayer.removeChild(fill);
      fill.destroy({ children: true });
    }
    const mask = this.#curtainMask;
    this.#curtainMask = null;
    if (mask !== null) {
      this.#curtainLayer.removeChild(mask);
      mask.destroy();
    }
    this.#store.releaseAll(this.#curtainFillRefs);
    this.#curtainFillRefs = [];
  }

  /** Destroys the fade-through-colour overlay of an in-flight transition. */
  #clearTransitionOverlay(): void {
    const overlay = this.#transitionOverlay;
    this.#transitionOverlay = null;
    this.#transitionOverlayAlpha = 1;
    if (overlay === null) return;
    this.#transition.removeChild(overlay);
    overlay.destroy();
  }

  /**
   * Releases the transient resources of the previous background transition.
   *
   * A newer cue takes the background layer over before it installs its own
   * mask/overlay, so the old owner must be detached here: otherwise a
   * superseded wipe keeps masking the view a later push/cross-fade is sliding
   * out, and a later soft wipe would inherit the older cue's strips.  The
   * overlay belongs to one cue as well, so it is destroyed instead of
   * recoloured while the new cue owns it.
   */
  #resetBackgroundTransition(): void {
    this.#clearBackgroundMask();
    this.#clearTransitionOverlay();
  }

  /** Detaches and destroys the background mask and its feather strips. */
  #clearBackgroundMask(): void {
    const owner = this.#backgroundMaskOwner;
    this.#backgroundMaskOwner = null;
    if (owner !== null) owner.sprite.mask = owner.layoutMask ?? null;
    this.#clearFeatherStrips();
    const mask = this.#backgroundMask;
    this.#backgroundMask = null;
    if (mask === null) return;
    this.#backgrounds.removeChild(mask);
    mask.destroy();
  }

  /** Destroys every feather strip (sprites and their rect masks) once. */
  #clearFeatherStrips(): void {
    for (const strip of this.#featherStrips) {
      strip.sprite.mask = null;
      strip.sprite.destroy();
      strip.mask.destroy();
    }
    this.#featherStrips.length = 0;
  }

  /** Creates (or recolours) the fade-through-colour overlay. */
  #ensureTransitionOverlay(color: string): void {
    const parsed = parseColor(color);
    if (this.#transitionOverlay !== null) {
      this.#transition.removeChild(this.#transitionOverlay);
      this.#transitionOverlay.destroy();
      this.#transitionOverlay = null;
    }
    const overlay = this.#kit.graphics();
    overlay.rect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT).fill(parsed.color);
    overlay.alpha = 0;
    this.#transition.addChild(overlay);
    this.#transitionOverlay = overlay;
    this.#transitionOverlayAlpha = parsed.alpha;
  }

  #setTransitionOverlay(alpha: number): void {
    const overlay = this.#transitionOverlay;
    if (overlay === null) return;
    const scaled = alpha * this.#transitionOverlayAlpha;
    overlay.visible = scaled > 0;
    overlay.alpha = scaled;
  }

  /**
   * Attaches the wipe/soft-push mask to the incoming background.
   *
   * The mask is a sibling of the background view inside the camera layer, so
   * its design-space rectangles line up with the background and follow camera
   * transforms.  It is attached to the incoming view only, so the seam never
   * touches any other object, the curtain/effect layers or the DOM.  A new
   * owner detaches the previous one first: a shared mask must never clip a
   * view that belongs to a newer cue.
   */
  #attachBackgroundMask(view: SceneSpriteView): void {
    if (this.#backgroundMask === null) {
      this.#backgroundMask = this.#kit.graphics();
      this.#backgrounds.addChild(this.#backgroundMask);
    }
    const previous = this.#backgroundMaskOwner;
    if (previous !== null && previous !== view) previous.sprite.mask = previous.layoutMask ?? null;
    this.#backgroundMaskOwner = view;
    view.sprite.mask = this.#backgroundMask;
  }

  /**
   * Rebuilds the background mask geometry from one pure frame.
   *
   * `null` means the transition has no mask at all (cross-fade, cut, push
   * without softness).  A mask without a ramp is the exact hard edge: the
   * binary stencil draws the authored wipe rectangle, so `softness 0` is the
   * historic hard-edge path.  A ramped mask draws the fully revealed region
   * with the same stencil and overlays the deterministic stepped feather
   * strips derived from the pure evaluator, which is how a Pixi stencil mask
   * renders a soft edge without an alpha-mask port.
   */
  #applyBackgroundMask(mask: StageMask | null, view: SceneSpriteView): void {
    if (mask === null) {
      // Only this view's own mask is transient here; the take-over release
      // already cleared anything that belonged to a previous cue.
      if (this.#backgroundMaskOwner === view) this.#clearBackgroundMask();
      return;
    }
    this.#attachBackgroundMask(view);
    const graphics = this.#backgroundMask;
    if (graphics === null) return;
    graphics.clear();
    const rect = maskOpaqueRect(mask);
    if (rect.width > 0 && rect.height > 0) {
      graphics.rect(rect.x, rect.y, rect.width, rect.height);
    }
    graphics.fill(0xffffff);
    this.#applyFeatherStrips(mask, view);
    this.#requestRender();
  }

  /**
   * Draws (or clears) the stepped feather strips of one mask frame.
   *
   * The strips are copies of the incoming view sharing its texture and pose,
   * clipped to their own stage-space rectangles; only their alpha steps
   * through the pure ramp, so no extra texture is decoded and nothing leaks
   * when the cue settles, is superseded, or the surface resets.
   */
  #applyFeatherStrips(mask: StageMask, view: SceneSpriteView): void {
    const steps = featherSteps(mask);
    if (steps.length === 0) {
      this.#clearFeatherStrips();
      return;
    }
    this.#ensureFeatherStrips(view, steps.length);
    for (const [index, strip] of this.#featherStrips.entries()) {
      const step = steps[index];
      if (step === undefined) continue;
      const node = strip.sprite;
      // An animated incoming background keeps ticking during the transition;
      // copying the current texture keeps every strip on the same frame.
      node.texture = view.sprite.texture;
      node.anchor.set(view.sprite.anchor.x, view.sprite.anchor.y);
      node.position.set(view.sprite.position.x, view.sprite.position.y);
      node.scale.set(view.sprite.scale.x, view.sprite.scale.y);
      node.rotation = view.sprite.rotation;
      node.alpha = step.alpha;
      const rect = featherStepRect(mask, step);
      strip.mask.clear();
      if (rect.width > 0 && rect.height > 0) {
        strip.mask.rect(rect.x, rect.y, rect.width, rect.height);
      }
      strip.mask.fill(0xffffff);
      node.mask = strip.mask;
    }
  }

  /** Creates/reuses the fixed strip sprites and their rect masks. */
  #ensureFeatherStrips(view: SceneSpriteView, count: number): void {
    while (this.#featherStrips.length > count) {
      const strip = this.#featherStrips.pop();
      if (strip === undefined) break;
      strip.sprite.mask = null;
      strip.sprite.destroy();
      strip.mask.destroy();
    }
    while (this.#featherStrips.length < count) {
      const sprite = this.#kit.sprite(view.sprite.texture);
      sprite.label = `${view.label}${FEATHER_STRIP_LABEL}`;
      const stripMask = this.#kit.graphics();
      this.#backgrounds.addChild(stripMask);
      this.#backgrounds.addChild(sprite);
      this.#featherStrips.push({ sprite, mask: stripMask });
    }
  }

  #assetLabel(asset: string, assets: AssetUrlMap): string {
    const textId = textBlockId(asset);
    const text = textId === undefined ? undefined : this.#textBlocks[textId];
    if (text !== undefined) return `text-texture:${textBlockVersion(text)}`;
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
    const textId = textBlockId(asset);
    const text = textId === undefined ? undefined : this.#textBlocks[textId];
    if (text !== undefined) return view.version === textBlockVersion(text);
    const source = resolveImageAsset(asset, assets, this.#animations);
    if (source === undefined) {
      return view.label === (assets[asset] ?? asset);
    }
    return view.version === imageAssetSourceVersion(source);
  }

  #spriteSize(asset: string): { width: number; height: number } {
    const textId = textBlockId(asset);
    const text = textId === undefined ? undefined : this.#textBlocks[textId];
    if (text !== undefined) return { width: text.definition.width, height: text.definition.height };
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
      this.#poseView(view, { ...view.state, ...object });
      return;
    }
    if (object.kind === "emitter") {
      const view = this.#emitters.get(object.id.slice("emitter:".length));
      if (view !== undefined && !view.burst) this.#poseEmitter(view, {
        ...view.state, x: object.x, y: object.y, scale: object.scale,
        rotation_deg: object.rotation_deg, opacity: object.opacity, z: object.z,
        space: object.space ?? view.state.space,
      });
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

  // -- internals: effects and camera ----------------------------------------

  #effectOptions(): ScreenEffectOptions {
    return { reducedMotion: this.#reducedMotion };
  }

  #currentShake(): { x: number; y: number } {
    const timeline = shakeOffset(
      this.#effectsState?.elapsedMs ?? 0,
      this.#effectsState?.shake ?? null,
      this.#effectOptions(),
    );
    return {
      x: timeline.x + this.#cueShake.x,
      y: timeline.y + this.#cueShake.y,
    };
  }

  #applyEffects(): void {
    const effects = this.#effectsState;
    const frame =
      effects === null
        ? null
        : evaluateScreenEffectFrame(
            effects.elapsedMs,
            effects.flash,
            effects.shake,
            this.#effectOptions(),
          );
    const alpha = frame?.flash?.alpha ?? 0;
    const parsed =
      frame?.flash === null || frame?.flash === undefined
        ? null
        : parseColor(frame.flash.color);
    const color = parsed?.color ?? null;
    if (alpha <= 0) {
      this.#flash?.destroy();
      this.#flash = null;
      this.#flashColor = null;
      return;
    }
    if (this.#flash === null || this.#flashColor !== color) {
      this.#flash?.destroy();
      this.#flash = this.#kit.graphics();
      this.#flash
        .rect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT)
        .fill(color ?? 0xffffff);
      this.#flashColor = color ?? 0xffffff;
      this.#effects.addChild(this.#flash);
    }
    // The evaluator owns the decay; the colour's own alpha only scales it.
    // Reading it on every frame keeps an alpha-only colour edit visible.
    this.#flashColorAlpha = parsed?.alpha ?? 1;
    this.#flash.alpha = alpha * this.#flashColorAlpha;
  }

  #clearEffects(): void {
    this.#effectsState = null;
    this.#cueShake = { x: 0, y: 0 };
    this.#cueShaders = EMPTY_SHADER_EFFECT_FRAME;
    this.#syncShaders();
    this.#flash?.destroy();
    this.#flash = null;
    this.#flashColorAlpha = 1;
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
    const shake = this.#currentShake();
    const transform = composeWorldTransform(this.#camera, shake);
    // Base camera and shake are combined once, here, so no later camera
    // application can silently drop an in-flight shake.
    this.#cameraLayer.position.set(transform.positionX, transform.positionY);
    this.#cameraLayer.pivot.set(transform.pivotX, transform.pivotY);
    this.#cameraLayer.scale.set(transform.scale);
    this.#cameraLayer.rotation = transform.rotation;
    // The filter area follows the camera, so every transform change re-syncs.
    this.#syncShaders(shake);
  }

  /**
   * Installs the shader passes of the current playhead and cue state.
   *
   * A timeline window owns its channel while it is active; a node cue fills
   * the channel otherwise.  An idle frame removes every pass exactly once.
   */
  #syncShaders(shake: { x: number; y: number } = this.#currentShake()): void {
    if (this.#disposed) return;
    const frame = this.#shaderFrame();
    if (isShaderEffectFrameEmpty(frame)) {
      if (!this.#shadersActive) return;
      this.#shadersActive = false;
      this.#shaderHost.apply(frame, this.#stageAreaInWorld(shake));
      return;
    }
    this.#shadersActive = true;
    this.#shaderHost.apply(frame, this.#stageAreaInWorld(shake));
  }

  #shaderFrame(): ShaderEffectFrame {
    const effects = this.#effectsState;
    const cue = this.#cueShaders;
    if (effects === null) return cue;
    const timeline = evaluateShaderEffectFrame(
      effects.elapsedMs,
      {
        chromatic_aberration: effects.chromatic_aberration ?? null,
        glitch: effects.glitch ?? null,
        shockwave: effects.shockwave ?? null,
        color_grade: effects.color_grade ?? null,
        focus: effects.focus ?? null,
        ripple: effects.ripple ?? null,
      },
      this.#effectOptions(),
    );
    // An active timeline window owns its channel for its whole authored
    // interval, even when the evaluated frame is `null` at zero intensity or
    // at a fade boundary; only a channel with no active window lets a node cue
    // fill it.  Falling back on `null` alone would let an overlapping cue show
    // through at the exact start/end of a timeline effect.
    return {
      ripple: effects.ripple != null ? timeline.ripple : cue.ripple,
      shockwave: effects.shockwave != null ? timeline.shockwave : cue.shockwave,
      glitch: effects.glitch != null ? timeline.glitch : cue.glitch,
      colorGrade:
        effects.color_grade != null ? timeline.colorGrade : cue.colorGrade,
      focus: effects.focus != null ? timeline.focus : cue.focus,
      chromaticAberration:
        effects.chromatic_aberration != null
          ? timeline.chromaticAberration
          : cue.chromaticAberration,
    };
  }

  /**
   * The whole stage mapped into the camera layer's local space.
   *
   * Used as the filter area, so the passes cover every design pixel even when
   * the world is zoomed, rotated, shaken or does not fill the stage, and the
   * shaders can treat their input as stage coordinates.  One pixel of margin
   * absorbs rounding; Pixi clips the area to the viewport.
   */
  #stageAreaInWorld(shake: { x: number; y: number }): SceneRect {
    const corners = [
      { x: -1, y: -1 },
      { x: DESIGN_WIDTH + 1, y: -1 },
      { x: -1, y: DESIGN_HEIGHT + 1 },
      { x: DESIGN_WIDTH + 1, y: DESIGN_HEIGHT + 1 },
    ].map((point) => stagePointToWorld(point, this.#camera, shake));
    const xs = corners.map((point) => point.x);
    const ys = corners.map((point) => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return {
      x,
      y,
      width: Math.max(...xs) - x,
      height: Math.max(...ys) - y,
    };
  }

  #tickDecorations(deltaMs: number): boolean {
    if (!this.#decorativeRunning || this.#paused || deltaMs <= 0) return false;
    const changed = this.#loops.advance(deltaMs);
    this.#refreshFrameTextures(changed);
    const hasParticles = this.#emitters.size > 0;
    for (const [id, view] of this.#emitters) {
      view.elapsedMs += deltaMs;
      view.batch.update(view.evaluator.data, view.evaluator.evaluate(view.elapsedMs));
      if (view.burst && view.elapsedMs >= view.evaluator.definition.lifetime_ms.max) this.#releaseEmitter(id);
    }
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
    // A newer cue takes the layer over: release the previous cue's transient
    // mask/overlay *before* this cue creates its own resources, so the shared
    // nodes can never be inherited (or torn down) across cue kinds.
    this.#resetBackgroundTransition();
    const next = this.#createBackgroundView(prepared);
    if (next === null) {
      this.#releasePrepared(prepared);
      return;
    }
    const previous = this.#background;
    this.#background = next;
    if (previous !== null) this.#stageView(previous);
    const spec = cue.transition;
    const settle = (): void => {
      if (
        this.#isLatestCue(generation, BACKGROUND_CUE, token) &&
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
        this.#ensureTransitionOverlay(spec.color);
      }
      // The pure evaluator owns the authored easing; the animation only drives
      // raw progress, so the curve is applied exactly once (like every other
      // timed cue, where `#runAnimation` eases and the callback consumes it).
      await this.#runAnimation(
        cue.duration_ms,
        "linear",
        (progress) => {
          if (!this.#isLatestCue(generation, BACKGROUND_CUE, token)) return;
          if (this.#background !== next) return;
          const frame = evaluateBackgroundTransition(
            spec,
            progress,
            cue.easing,
          );
          next.sprite.alpha = frame.incomingAlpha;
          if (previous !== null) previous.sprite.alpha = frame.outgoingAlpha;
          if (frame.overlay !== null)
            this.#setTransitionOverlay(frame.overlay.alpha);
        },
        context,
      );
    } else if (spec.type === "wipe") {
      next.sprite.alpha = 1;
      this.#attachBackgroundMask(next);
      await this.#runAnimation(
        cue.duration_ms,
        "linear",
        (progress) => {
          if (!this.#isLatestCue(generation, BACKGROUND_CUE, token)) return;
          if (this.#background !== next) return;
          const frame = evaluateBackgroundTransition(
            spec,
            progress,
            cue.easing,
          );
          this.#applyBackgroundMask(frame.mask, next);
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
      await this.#runAnimation(
        cue.duration_ms,
        "linear",
        (progress) => {
          if (!this.#isLatestCue(generation, BACKGROUND_CUE, token)) return;
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
          this.#applyBackgroundMask(frame.mask, next);
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
    if (this.#isLatestCue(generation, BACKGROUND_CUE, token)) {
      this.#clearTransitionOverlay();
      this.#clearBackgroundMask();
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

    const resource = spriteResourceId(target);
    const replacing = view !== undefined && !this.#showsAssetRevision(view, resource, assets);
    const previousView = replacing ? view : undefined;
    const previousAlpha = previousView?.sprite.alpha ?? 0;
    const previousPose =
      previousView === undefined ? null : this.#readView(previousView);
    // The capture above and this token are one synchronous step, and the token
    // is taken *before* the decode: a newer cue can therefore never commit a
    // view that an older, still-decoding cue then strands at its entry pose.
    const token = this.#beginCue(key);
    let created: SceneSpriteView | undefined;
    if (view === undefined || replacing) {
      const prepared = await this.#acquireAsset(resource, assets);
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
      const next = this.#createView(id, prepared, this.#objectParent(target.space));
      if (next === null) {
        this.#releasePrepared(prepared);
        return;
      }
      view = next;
      created = next;
      this.#sprites.set(id, view);
      const character = (target.sprite_kind ?? "character") === "character";
      const entry = character ? entryTweenPose(target) : target;
      this.#poseView(view, { ...target, x: entry.x, y: entry.y,
        scale: target.scale * (character ? ENTRY_TWEEN_SCALE : 1), opacity: 0 });
      if (previousView !== undefined) this.#stageView(previousView);
    }
    if (view === undefined) return;
    const staged = view;
    const start = previousPose ?? this.#readView(view);
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
      this.#poseView(staged, {
        ...target,
        x: mix(start.x, target.x, transformProgress),
        y: mix(start.y, target.y, transformProgress),
        scale: 1,
        scale_x: mix(start.scale * start.scale_x, target.scale * target.scale_x, transformProgress),
        scale_y: mix(start.scale * start.scale_y, target.scale * target.scale_y, transformProgress),
        rotation_deg: mix(start.rotation_deg, target.rotation_deg, transformProgress),
        opacity: replacing && fadeDuration > 0
          ? mix(0, target.opacity, Math.min(1, progress * animationDuration / fadeDuration))
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
    const backgrounds = [...this.#cameraLayer.children, ...this.#screenLayer.children];
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
    this.#destroyCurtainFill();
    this.#clearTransitionOverlay();
    for (const view of sprites) {
      if (this.#sprites.get(view.id) !== view) continue;
      this.#sprites.delete(view.id);
      this.#releaseView(view);
    }
    this.#clearEmitters();
    this.#releaseVideo();
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
    effect: ScreenEffectSpec,
    durationMs: number,
    context: SceneCueContext,
  ): Promise<void> {
    if (isShaderScreenEffect(effect)) {
      await this.#shaderEffect(effect, durationMs, context);
      return;
    }
    const generation = this.#sceneGeneration;
    if (effect.type === "flash") {
      const parsed = parseColor(effect.color);
      const flash = this.#kit.graphics();
      flash.rect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT).fill(parsed.color);
      flash.alpha =
        evaluateFlashAlpha(effect, 0, 0, durationMs, this.#effectOptions()) *
        parsed.alpha;
      this.#effects.addChild(flash);
      this.#cueFlashes.add(flash);
      try {
        // `evaluateFlashAlpha` owns the shipped ease-out decay, so the
        // animation drives raw progress only and the cue path matches the
        // timeline path exactly at the same elapsed time.
        await this.#runAnimation(
          durationMs,
          "linear",
          (progress) => {
            if (!this.#isCurrent(generation)) return;
            flash.alpha =
              evaluateFlashAlpha(
                effect,
                progress * durationMs,
                0,
                durationMs,
                this.#effectOptions(),
              ) * parsed.alpha;
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
          this.#cueShake = evaluateShakeOffset(
            effect,
            progress * durationMs,
            0,
            durationMs,
            this.#effectOptions(),
          );
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

  /**
   * Node-cue executor of one shader effect.
   *
   * The cue owns its channel as the newest writer of that effect type (an
   * overlapping cue of the same type takes over, other types stack) and only
   * the owner clears the channel when it ends, is cancelled or its generation
   * moves on.
   */
  async #shaderEffect(
    effect: Extract<ScreenEffectSpec, { type: ShaderScreenEffectType }>,
    durationMs: number,
    context: SceneCueContext,
  ): Promise<void> {
    const generation = this.#sceneGeneration;
    const key = `${SHADER_CUE}${effect.type}`;
    const token = this.#beginCue(key);
    const write = (elapsedMs: number | null): void => {
      const options = this.#effectOptions();
      const current = this.#cueShaders;
      switch (effect.type) {
        case "shockwave":
          this.#cueShaders = {
            ...current,
            shockwave:
              elapsedMs === null
                ? null
                : evaluateShockwave(effect, elapsedMs, 0, durationMs, options),
          };
          break;
        case "glitch":
          this.#cueShaders = {
            ...current,
            glitch:
              elapsedMs === null
                ? null
                : evaluateGlitch(effect, elapsedMs, 0, durationMs, options),
          };
          break;
        case "chromatic_aberration":
          this.#cueShaders = {
            ...current,
            chromaticAberration:
              elapsedMs === null
                ? null
                : evaluateChromaticAberration(
                    effect,
                    elapsedMs,
                    0,
                    durationMs,
                    options,
                  ),
          };
          break;
        case "color_grade":
          this.#cueShaders = {
            ...current,
            colorGrade:
              elapsedMs === null
                ? null
                : evaluateColorGrade(effect, elapsedMs, 0, durationMs, options),
          };
          break;
        case "focus":
          this.#cueShaders = {
            ...current,
            focus:
              elapsedMs === null
                ? null
                : evaluateFocus(effect, elapsedMs, 0, durationMs, options),
          };
          break;
        case "ripple":
          this.#cueShaders = {
            ...current,
            ripple:
              elapsedMs === null
                ? null
                : evaluateRipple(effect, elapsedMs, 0, durationMs, options),
          };
          break;
        default:
          effect satisfies never;
      }
      this.#syncShaders();
      this.#requestRender();
    };
    try {
      await this.#runAnimation(
        durationMs,
        "linear",
        (progress) => {
          if (!this.#isLatestCue(generation, key, token)) return;
          write(progress * durationMs);
        },
        context,
      );
    } finally {
      if (this.#isLatestCue(generation, key, token)) write(null);
    }
  }

  /**
   * Covers or reveals the persistent curtain layer.
   *
   * The transition geometry comes from the pure evaluator; this method only
   * owns the fill view and the cue lifetime.  Re-revealing an already revealed
   * curtain is a no-op the runtime never emits, so a stray cue cannot leave a
   * half-drawn layer behind either.
   */
  async #transitionCurtain(
    cue: Extract<SceneVisualCue, { type: "curtain_transition" }>,
    context: SceneCueContext,
  ): Promise<void> {
    const generation = this.#sceneGeneration;
    const token = this.#beginCue(CURTAIN_CUE);
    let prepared: PreparedAsset | null = null;
    // `fill` is optional on the wire (the runtime omits it for a reveal), so an
    // absent field means "no new fill", never an `undefined` lookup.
    const fill = cue.fill ?? null;
    if (fill !== null && "asset" in fill) {
      try {
        prepared = await this.#acquireAsset(fill.asset, context.assets);
      } catch (error) {
        this.#diagnostic(`幕布素材加载失败：${errorMessage(error)}`);
        prepared = null;
      }
      if (
        context.signal.aborted ||
        !this.#isLatestCue(generation, CURTAIN_CUE, token)
      ) {
        if (prepared !== null) this.#releasePrepared(prepared);
        return;
      }
    }
    if (cue.action === "cover") {
      const cover = fill ?? { color: "#000000" };
      if (!this.#ensureCurtainFill(cover, prepared)) {
        // The fallback keeps the world hidden; make it discoverable.
        this.#diagnostic(
          `幕布素材缺失或加载失败，已回退为纯色幕布：${describeCurtainFill(cover)}`,
        );
        this.#ensureCurtainFill({ color: "#000000" }, null);
      }
    } else if (this.#curtainFill === null) {
      if (prepared !== null) this.#releasePrepared(prepared);
      return;
    }
    const applyFrame = (progress: number): void => {
      if (!this.#isCurrent(generation)) return;
      if (!this.#isLatestCue(generation, CURTAIN_CUE, token)) return;
      this.#applyCurtainFrame(
        evaluateCurtainTransition(cue.transition, cue.action, progress),
      );
      this.#requestRender();
    };
    if (cue.duration_ms > 0) {
      await this.#runAnimation(
        cue.duration_ms,
        cue.easing,
        applyFrame,
        context,
      );
    }
    if (this.#isLatestCue(generation, CURTAIN_CUE, token)) {
      applyFrame(1);
      if (cue.action === "reveal") this.#destroyCurtainFill();
    }
    if (prepared !== null) this.#releasePrepared(prepared);
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
  const fit = spriteFit(view.texture.width, view.texture.height, state.layout);
  const anchorX = state.anchor_x ?? 0.5, anchorY = state.anchor_y ?? 1;
  view.anchor.set(
    state.layout?.fit === "cover" ? 0.5 + (anchorX - 0.5) * state.layout.width / (view.texture.width * fit.x) : anchorX,
    state.layout?.fit === "cover" ? 0.5 + (anchorY - 0.5) * state.layout.height / (view.texture.height * fit.y) : anchorY,
  );
  view.position.set(state.x, state.y);
  const direction = state.flip_x ? -1 : 1;
  view.scale.set(
    direction * state.scale * state.scale_x * fit.x,
    state.scale * state.scale_y * fit.y,
  );
  view.rotation = (state.rotation_deg * Math.PI) / 180;
  view.alpha = state.opacity;
  view.zIndex = Math.round(state.z);
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

/** `gui` asset a curtain snapshot covers with, or `null` for colour/hidden. */
function curtainAssetOf(curtain: CurtainSnapshot | null): string | null {
  if (curtain === null || !curtain.covered) return null;
  const fill = curtain.fill;
  if (fill === undefined || fill === null) return null;
  return "asset" in fill ? fill.asset : null;
}

/** Human-readable identity of a curtain fill, for diagnostics. */
function describeCurtainFill(fill: CurtainFill): string {
  return "asset" in fill ? fill.asset : fill.color;
}

export interface ParsedColor {
  /** `0xRRGGBB`; invalid input falls back to opaque white. */
  color: number;
  /** `0..1`; `#RRGGBB` (and invalid input) is fully opaque. */
  alpha: number;
}

/**
 * Parses `#RRGGBB`/`#RRGGBBAA`.
 *
 * The content validator accepts both lengths, so every renderer path that
 * consumes an authored colour must keep the alpha instead of silently drawing
 * an 8-digit colour fully opaque.
 */
export function parseColor(color: string): ParsedColor {
  const hex = color.startsWith("#") ? color.slice(1) : color;
  if (hex.length !== 6 && hex.length !== 8)
    return { color: 0xffffff, alpha: 1 };
  const parsed = Number.parseInt(hex.slice(0, 6), 16);
  if (Number.isNaN(parsed)) return { color: 0xffffff, alpha: 1 };
  if (hex.length === 6) return { color: parsed, alpha: 1 };
  const parsedAlpha = Number.parseInt(hex.slice(6, 8), 16);
  return {
    color: parsed,
    alpha: Number.isNaN(parsedAlpha) ? 1 : parsedAlpha / 255,
  };
}
