/** Request, result and option types of `SceneSurface`. */

import type { AnimationMap } from "./imageAnimation";
import type { EmitterSnapshot, ParticleMap } from "./particles";
import type { PreparedAsset } from "./sceneAssets";
import type { SceneObjectFrame } from "./sceneFrame";
import type { SceneKit } from "./sceneKit";
import type { SceneFrameCancel, SceneFrameRequest } from "./sceneRenderLoop";
import type { SceneTextureLike } from "./sceneTextures";
import type { TextBlockMap } from "./textBlock";
import type { ActiveScreenEffect } from "./timelineEvaluator";
import type {
  AssetUrlMap,
  ButtonSnapshot,
  CameraSnapshot,
  CurtainSnapshot,
  PresentationCue,
  SpriteSnapshot,
} from "./types";

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
