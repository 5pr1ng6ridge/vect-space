import type { CSSProperties } from "react";
import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  stagePointToWorld,
  type SceneObjectFrame,
  type SceneFrame,
} from "@vectspace/presentation-core/scene-frame";
import type { ButtonSnapshot } from "@vectspace/presentation-core/types";

export type Tool = "select" | "camera";

export type TransformHandle =
  | "move"
  | "scale"
  | "scale_tl"
  | "scale_tr"
  | "scale_bl"
  | "scale_br"
  | "scale_x"
  | "scale_y"
  | "rotate";

export type CameraHandle = "move" | "zoom" | "rotate";

/**
 * Evaluated placement merged onto the runtime button definition.
 *
 * A timeline cue animates only the placement channels (`x`/`y`/`width`/
 * `height`/`scale_x`/`scale_y`/`rotation_deg`/`opacity`/`z`); the artwork,
 * `asset_mode`, `fit` and the per-state animations stay the template's.  The
 * session-evaluated frame is authoritative for every channel it owns, so
 * scrubbing reproduces exactly what the game would show at that playhead.
 */
export function evaluatedButtonSnapshot(
  base: ButtonSnapshot,
  object: SceneObjectFrame,
): ButtonSnapshot {
  return {
    ...base,
    id: object.id,
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
    scale_x: object.scale_x,
    scale_y: object.scale_y,
    rotation_deg: object.rotation_deg,
    opacity: object.opacity,
    z: object.z,
  };
}

/**
 * Placement for one evaluated button inside the scaled design layer.
 *
 * The layer keeps the 16:9 aspect of the 1920x1080 design surface, so
 * percentage units map design pixels exactly and the shared `scene-button`
 * layout stays identical to `ButtonLayer`'s design-pixel placement.  The
 * preview never intercepts pointer events; the gizmo layer above owns the
 * authoring gestures.
 */
export function buttonPreviewStyle(object: SceneObjectFrame): CSSProperties {
  return {
    left: `${(object.x / DESIGN_WIDTH) * 100}%`,
    top: `${(object.y / DESIGN_HEIGHT) * 100}%`,
    width: `${(object.width / DESIGN_WIDTH) * 100}%`,
    height: `${(object.height / DESIGN_HEIGHT) * 100}%`,
    opacity: object.opacity,
    transform: `translate3d(0, 0, 0) rotate(${object.rotation_deg}deg) scale(${object.scale_x}, ${object.scale_y})`,
    zIndex: Math.round(object.z),
    pointerEvents: "none",
  };
}

export function gizmoStyle(
  object: SceneObjectFrame,
  camera: SceneFrame["camera"] | undefined,
): React.CSSProperties {
  const screen = object.kind === "button" || object.space === "screen";
  const anchored = object.kind === "sprite" || object.kind === "emitter";
  const anchorX = anchored
    ? object.flip_x
      ? 1 - object.anchor_x
      : object.anchor_x
    : 0;
  const anchorY = anchored ? (object.anchor_y ?? 1) : 0;
  const projected = screen
    ? { x: object.x, y: object.y }
    : projectPoint(object.x, object.y, camera);
  const zoom = screen ? 1 : (camera?.zoom ?? 1);
  // Sprite dimensions already include their evaluated scale in
  // SceneSurface.#spriteDimensions. Button dimensions are layout values, so
  // their outer scale channels must be applied here.
  const scaleX = object.kind === "button" ? object.scale_x : 1;
  const scaleY = object.kind === "button" ? object.scale_y : 1;
  const width = Math.max(40, object.width * scaleX * zoom);
  const height = Math.max(56, object.height * scaleY * zoom);
  const rotation =
    (screen ? 0 : (camera?.rotation_deg ?? 0)) + object.rotation_deg;
  return {
    left: `${(projected.x / DESIGN_WIDTH) * 100}%`,
    top: `${(projected.y / DESIGN_HEIGHT) * 100}%`,
    width: `${(width / DESIGN_WIDTH) * 100}%`,
    height: `${(height / DESIGN_HEIGHT) * 100}%`,
    transform: `translate(${-anchorX * 100}%, ${-anchorY * 100}%) rotate(${rotation}deg)`,
    transformOrigin: `${anchorX * 100}% ${anchorY * 100}%`,
  };
}

function projectPoint(
  x: number,
  y: number,
  camera: SceneFrame["camera"] | undefined,
): { x: number; y: number } {
  if (camera === undefined) return { x, y };
  const angle = (camera.rotation_deg * Math.PI) / 180;
  const dx = x - (DESIGN_WIDTH / 2 + camera.x);
  const dy = y - (DESIGN_HEIGHT / 2 + camera.y);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: DESIGN_WIDTH / 2 + (dx * cos - dy * sin) * camera.zoom,
    y: DESIGN_HEIGHT / 2 + (dx * sin + dy * cos) * camera.zoom,
  };
}

/**
 * Transform patch for dragging `handle` by (dx, dy) design pixels from the
 * pose `initial`.  Moves are converted through the camera for world objects.
 */
export function dragTransform(
  handle: TransformHandle,
  object: SceneObjectFrame,
  initial: SceneObjectFrame,
  dx: number,
  dy: number,
  camera: SceneFrame["camera"] | undefined,
): Partial<SceneObjectFrame> {
  const screen = object.kind === "button" || object.space === "screen";
  const down =
    !screen && camera !== undefined
      ? stagePointToWorld({ x: 0, y: 0 }, camera)
      : { x: 0, y: 0 };
  const now =
    !screen && camera !== undefined
      ? stagePointToWorld({ x: dx, y: dy }, camera)
      : { x: dx, y: dy };
  const corner =
    handle === "scale_tl" ||
    handle === "scale_tr" ||
    handle === "scale_bl" ||
    handle === "scale_br";
  const outwardDelta = corner
    ? (dx * (handle.endsWith("l") ? -1 : 1) +
        dy * (handle.startsWith("scale_t") ? -1 : 1)) /
      2
    : dy;
  if (handle === "move")
    return { x: initial.x + now.x - down.x, y: initial.y + now.y - down.y };
  if (handle === "rotate")
    return { rotation_deg: initial.rotation_deg + dx * 0.35 };
  if (handle === "scale_x")
    return object.kind === "video"
      ? { width: Math.max(16, initial.width + dx) }
      : { scale_x: Math.max(0.05, initial.scale_x + dx / 450) };
  if (handle === "scale_y")
    return object.kind === "video"
      ? { height: Math.max(16, initial.height + dy) }
      : { scale_y: Math.max(0.05, initial.scale_y - dy / 450) };
  if (object.kind === "video")
    return {
      width: Math.max(16, initial.width + dx),
      height: Math.max(16, initial.height + dy),
    };
  if (object.kind === "button")
    return {
      scale_x: Math.max(0.05, initial.scale_x + dy / 450),
      scale_y: Math.max(0.05, initial.scale_y + dy / 450),
    };
  return { scale: Math.max(0.05, initial.scale + outwardDelta / 450) };
}

/** The channels `handle` edits, read back from the session-evaluated pose. */
export function releasedTransform(
  handle: TransformHandle,
  object: SceneObjectFrame,
  finalObject: SceneObjectFrame,
): Partial<SceneObjectFrame> {
  if (handle === "move") return { x: finalObject.x, y: finalObject.y };
  if (handle === "rotate") return { rotation_deg: finalObject.rotation_deg };
  if (handle === "scale_x")
    return object.kind === "video"
      ? { width: finalObject.width }
      : { scale_x: finalObject.scale_x };
  if (handle === "scale_y")
    return object.kind === "video"
      ? { height: finalObject.height }
      : { scale_y: finalObject.scale_y };
  if (object.kind === "video")
    return { width: finalObject.width, height: finalObject.height };
  if (object.kind === "button")
    return { scale_x: finalObject.scale_x, scale_y: finalObject.scale_y };
  return { scale: finalObject.scale };
}

/** Channels a timeline track of this object kind can key. */
export function objectChannels(kind: SceneObjectFrame["kind"]): string[] {
  switch (kind) {
    case "video":
      return ["x", "y", "width", "height", "opacity", "z"];
    case "emitter":
      return ["x", "y", "scale", "rotation_deg", "opacity", "z"];
    case "button":
      return [
        "x",
        "y",
        "width",
        "height",
        "scale_x",
        "scale_y",
        "rotation_deg",
        "opacity",
        "z",
      ];
    default:
      return [
        "x",
        "y",
        "scale",
        "scale_x",
        "scale_y",
        "rotation_deg",
        "opacity",
        "z",
      ];
  }
}
