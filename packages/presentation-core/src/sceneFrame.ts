/**
 * Pure scene-frame model shared by the game renderer and the editor preview.
 *
 * The surface owns Pixi objects and the session owns the clock, but both agree
 * on this plain description of "what the stage shows at one instant": object
 * geometry, camera and derived sprite dimensions.  Everything in this module is
 * a pure function of its inputs, so it can be tested without a renderer and
 * makes scrubbing deterministic.
 */

import {
  evaluateFlashAlpha,
  evaluateShakeOffset,
  type ScreenEffectOptions,
} from "./sceneEffects";
import {
  evaluateTimelineFrame,
  type ActiveScreenEffect,
  type TimelineFrame,
} from "./timelineEvaluator";
import type {
  ButtonSnapshot,
  CameraSnapshot,
  SpriteSnapshot,
  TimelineTrack,
} from "./types";

export const DESIGN_WIDTH = 1920;
export const DESIGN_HEIGHT = 1080;

/** Fallback sprite layout used before an asset's real pixels are known. */
export const DEFAULT_SPRITE_WIDTH = 240;
export const DEFAULT_SPRITE_HEIGHT = 480;

/**
 * Visual offset applied to the *entry* pose of a character tween.
 *
 * The game shipped with a small rise-and-scale entrance for `show` tweens; the
 * migration keeps the player-visible behaviour and makes it shared instead of
 * duplicating it per host.
 */
export const ENTRY_TWEEN_Y_OFFSET = 48;
export const ENTRY_TWEEN_SCALE = 0.96;

export interface SceneObjectFrame {
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
  anchor_x: number;
  anchor_y: number;
  flip_x: boolean;
  /** Evaluated video channel volume; videos only. */
  volume?: number;
}

export type SceneObjectPatch = Partial<
  Pick<
    SceneObjectFrame,
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

export interface SceneFrame {
  elapsed_ms: number;
  camera: CameraSnapshot;
  objects: SceneObjectFrame[];
  /** Evaluated background-music channel volume at this position. */
  bgm_volume: number;
}

export interface SceneOverrides {
  objects: ReadonlyMap<string, SceneObjectPatch>;
  camera: Partial<CameraSnapshot>;
}

export const EMPTY_SCENE_OVERRIDES: SceneOverrides = {
  objects: new Map<string, SceneObjectPatch>(),
  camera: {},
};

export function isEmptySceneOverrides(overrides: SceneOverrides): boolean {
  return (
    overrides.objects.size === 0 && Object.keys(overrides.camera).length === 0
  );
}

/** Layout knowledge the surface has about the pixels behind an asset id. */
export interface SceneSpriteGeometry {
  spriteSize(asset: string): { width: number; height: number };
}

export interface SceneFrameInput {
  duration_ms: number;
  tracks: readonly TimelineTrack[];
  sprites: Readonly<Record<string, SpriteSnapshot>>;
  buttons?: Readonly<Record<string, ButtonSnapshot>>;
  camera: CameraSnapshot;
  bgm_volume: number;
}

/**
 * Evaluates one instant of a timeline into a scene frame.
 *
 * The evaluator is the same shared implementation used before the migration,
 * so keyframe, `inherit`, easing and button semantics stay identical; this
 * function only adds the pixel geometry (sprite boxes, video rectangle) that
 * the Pixi surface and the editor gizmo both need.
 */
export function evaluateSceneFrame(
  input: SceneFrameInput,
  elapsedMs: number,
  geometry: SceneSpriteGeometry,
): SceneFrame {
  const evaluated = evaluateTimelineFrame(
    { duration_ms: input.duration_ms, tracks: input.tracks },
    {
      sprites: input.sprites,
      buttons: input.buttons ?? {},
      camera: input.camera,
      bgm_volume: input.bgm_volume,
    },
    elapsedMs,
  );
  return sceneFrameFromTimeline(evaluated, geometry);
}

export function sceneFrameFromTimeline(
  evaluated: TimelineFrame,
  geometry: SceneSpriteGeometry,
): SceneFrame {
  const objects: SceneObjectFrame[] = [];
  for (const sprite of evaluated.sprites) {
    objects.push({
      id: sprite.id,
      kind: "sprite",
      x: sprite.x,
      y: sprite.y,
      ...spriteBox(
        geometry,
        sprite.asset,
        sprite.scale,
        sprite.scale_x,
        sprite.scale_y,
      ),
      scale: sprite.scale,
      scale_x: sprite.scale_x,
      scale_y: sprite.scale_y,
      rotation_deg: sprite.rotation_deg,
      opacity: sprite.opacity,
      z: sprite.z,
      asset: sprite.asset,
      anchor_x: sprite.anchor_x ?? 0.5,
      anchor_y: sprite.anchor_y ?? 1,
      flip_x: sprite.flip_x ?? false,
    });
  }
  for (const video of evaluated.videos) {
    objects.push({
      id: video.id,
      kind: "video",
      x: video.x,
      y: video.y,
      width: Math.max(1, video.width),
      height: Math.max(1, video.height),
      scale: 1,
      scale_x: 1,
      scale_y: 1,
      rotation_deg: 0,
      opacity: video.opacity,
      z: video.z,
      asset: video.asset,
      anchor_x: 0,
      anchor_y: 0,
      flip_x: false,
      volume: video.volume,
    });
  }
  for (const button of evaluated.buttons) {
    objects.push({
      id: button.id,
      kind: "button",
      x: button.x,
      y: button.y,
      width: Math.max(1, button.width),
      height: Math.max(1, button.height),
      scale: 1,
      scale_x: button.scale_x,
      scale_y: button.scale_y,
      rotation_deg: button.rotation_deg,
      opacity: button.opacity,
      z: button.z,
      asset: "",
      anchor_x: 0,
      anchor_y: 0,
      flip_x: false,
    });
  }
  return {
    elapsed_ms: evaluated.elapsed_ms,
    camera: evaluated.camera,
    objects,
    bgm_volume: evaluated.bgm_volume,
  };
}

/**
 * Sprite layout box for one evaluated pose.
 *
 * Dimensions already include the evaluated scale channels, exactly like the
 * editor gizmo (and the game view) need them; buttons instead apply their
 * scale channels in the DOM overlay, so they keep their layout box.
 */
export function spriteBox(
  geometry: SceneSpriteGeometry,
  asset: string,
  scale: number,
  scale_x: number,
  scale_y: number,
): { width: number; height: number } {
  const size =
    asset === ""
      ? { width: DEFAULT_SPRITE_WIDTH, height: DEFAULT_SPRITE_HEIGHT }
      : geometry.spriteSize(asset);
  return {
    width: Math.max(1, Math.abs(size.width * scale * scale_x)),
    height: Math.max(1, Math.abs(size.height * scale * scale_y)),
  };
}

/**
 * Merges interactive overrides over an evaluated frame.
 *
 * Overrides never mutate the evaluated value: clearing them restores exactly
 * what the timeline evaluates at the same playhead.  Sprite boxes are
 * recomputed after a scale override so a pending gesture keeps the gizmo and
 * the Pixi view aligned.
 */
export function mergeSceneOverrides(
  frame: SceneFrame,
  overrides: SceneOverrides,
  geometry?: SceneSpriteGeometry,
): SceneFrame {
  if (isEmptySceneOverrides(overrides)) return frame;
  const objects = frame.objects.map((object) => {
    const patch = overrides.objects.get(object.id);
    if (patch === undefined) return object;
    const merged = { ...object, ...patch };
    if (merged.kind === "sprite" && geometry !== undefined) {
      return {
        ...merged,
        ...spriteBox(
          geometry,
          merged.asset,
          merged.scale,
          merged.scale_x,
          merged.scale_y,
        ),
      };
    }
    return merged;
  });
  return {
    elapsed_ms: frame.elapsed_ms,
    camera: { ...frame.camera, ...overrides.camera },
    objects,
    bgm_volume: frame.bgm_volume,
  };
}

/** World-space point behind a design-space stage point, inverted camera. */
export function stagePointToWorld(
  point: { x: number; y: number },
  camera: CameraSnapshot,
  shake: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  const zoom = camera.zoom === 0 ? 1 : camera.zoom;
  const angle = (camera.rotation_deg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = (point.x - DESIGN_WIDTH / 2 - shake.x) / zoom;
  const dy = (point.y - DESIGN_HEIGHT / 2 - shake.y) / zoom;
  return {
    x: DESIGN_WIDTH / 2 + camera.x + (dx * cos + dy * sin),
    y: DESIGN_HEIGHT / 2 + camera.y + (-dx * sin + dy * cos),
  };
}

/** Design-space point for a world-space point, matching the surface camera. */
export function worldPointToStage(
  point: { x: number; y: number },
  camera: CameraSnapshot,
  shake: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  const angle = (camera.rotation_deg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - (DESIGN_WIDTH / 2 + camera.x);
  const dy = point.y - (DESIGN_HEIGHT / 2 + camera.y);
  return {
    x: DESIGN_WIDTH / 2 + shake.x + (dx * cos - dy * sin) * camera.zoom,
    y: DESIGN_HEIGHT / 2 + shake.y + (dx * sin + dy * cos) * camera.zoom,
  };
}

/**
 * Topmost object under a design-space point.
 *
 * Sprites are anchored (`anchor_x`/`anchor_y`), videos and buttons are laid out
 * from their top-left corner.  Rotation is intentionally ignored: the
 * interactive hit area of an authoring gesture is the axis-aligned box of the
 * object, which is also what the editor's DOM gizmo shows while dragging.
 */
export function hitTestSceneFrame(
  frame: SceneFrame,
  point: { x: number; y: number },
  shake: { x: number; y: number } = { x: 0, y: 0 },
): SceneObjectFrame | null {
  const world = stagePointToWorld(point, frame.camera, shake);
  const ordered = [...frame.objects].sort((left, right) => left.z - right.z);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const object = ordered[index];
    if (object === undefined) continue;
    const left =
      object.kind === "sprite"
        ? object.x - object.anchor_x * object.width
        : object.x;
    const top =
      object.kind === "sprite"
        ? object.y - object.anchor_y * object.height
        : object.y;
    if (
      world.x >= left &&
      world.x <= left + object.width &&
      world.y >= top &&
      world.y <= top + object.height
    ) {
      return object;
    }
  }
  return null;
}

/** Container transform for a camera snapshot plus one composed shake offset. */
export interface SceneWorldTransform {
  positionX: number;
  positionY: number;
  pivotX: number;
  pivotY: number;
  scale: number;
  rotation: number;
}

/**
 * Base camera and shake are combined exactly once, so a shake can never be
 * overwritten by a later camera application and both effects coexist.
 */
export function composeWorldTransform(
  camera: CameraSnapshot,
  shake: { x: number; y: number } = { x: 0, y: 0 },
): SceneWorldTransform {
  return {
    positionX: DESIGN_WIDTH / 2 + shake.x,
    positionY: DESIGN_HEIGHT / 2 + shake.y,
    pivotX: DESIGN_WIDTH / 2 + camera.x,
    pivotY: DESIGN_HEIGHT / 2 + camera.y,
    scale: camera.zoom,
    rotation: (camera.rotation_deg * Math.PI) / 180,
  };
}

/**
 * Flash alpha at one playhead position.
 *
 * The formula lives in the shared pure effect evaluator, so both hosts derive
 * the same alpha from the same playhead and the authored spec.
 */
export function flashAlpha(
  elapsedMs: number,
  flash: ActiveScreenEffect | null,
  options: ScreenEffectOptions = {},
): number {
  if (flash === null || flash.effect.type !== "flash") return 0;
  return evaluateFlashAlpha(
    flash.effect,
    elapsedMs,
    flash.startMs,
    flash.durationMs,
    options,
  );
}

/** Shake offset at one playhead position, composed into the camera transform. */
export function shakeOffset(
  elapsedMs: number,
  shake: ActiveScreenEffect | null,
  options: ScreenEffectOptions = {},
): { x: number; y: number } {
  if (shake === null || shake.effect.type !== "shake") return { x: 0, y: 0 };
  return evaluateShakeOffset(
    shake.effect,
    elapsedMs,
    shake.startMs,
    shake.durationMs,
    options,
  );
}

/**
 * Entry pose for a character that a `show` tween introduces.
 *
 * `flip_x` semantics live in the scale sign, so the entry pose keeps the
 * requested horizontal direction while only shrinking the magnitude.
 */
export function entryTweenPose(state: SpriteSnapshot): SpriteSnapshot {
  return {
    ...state,
    y: state.y + ENTRY_TWEEN_Y_OFFSET,
    scale: state.scale * ENTRY_TWEEN_SCALE,
  };
}
