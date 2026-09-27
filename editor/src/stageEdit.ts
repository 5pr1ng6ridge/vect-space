/**
 * Pure geometry for direct stage editing in the node inspector.
 *
 * The inspector shows the real design-space stage (1920×1080) and lets the
 * author drag the sprite a `sprite` node will show.  Every rule that turns a
 * pointer position into an authored value lives here so the gesture component
 * only wires browser events and the coordinate/offset semantics stay unit
 * tested without Pixi:
 *
 * - a client point becomes a design point through the canvas rect,
 * - a design point becomes a world point through the shared inverse camera
 *   (`stagePointToWorld`), so a zoomed or rotated camera cannot skew a drag,
 * - the runtime adds the resolved expression offset to the authored `x`/`y`
 *   (`resolve_character_asset` in the Rust core), so a dropped world position
 *   must have that offset subtracted again before it is written to the node.
 */

import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  stagePointToWorld,
} from "@vectspace/presentation-core/scene-frame";
import type { CameraSnapshot } from "@vectspace/presentation-core/types";

import type { ContentManifest, SceneNode } from "./types";

export interface StagePoint {
  x: number;
  y: number;
}

type SpriteNode = Extract<SceneNode, { type: "sprite" }>;

/**
 * Movement below this many design pixels is a click, not a drag.
 *
 * A plain click must never write the node (and therefore never create a
 * history entry); the threshold is far below one authored pixel at any normal
 * stage scale, so a real drag is never mistaken for a click.
 */
export const DRAG_THRESHOLD_PX = 0.5;

/** The visible rectangle of the stage canvas, in CSS pixels. */
export interface StageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Design-space point behind a pointer position.
 *
 * The canvas is the design surface scaled to its CSS box, so the pointer must
 * be mapped through that box before any camera math; client coordinates (or
 * the canvas' intrinsic size) are never written to a node.  A canvas without a
 * measured box (an environment that reports a zero rect) falls back to one CSS
 * pixel per design pixel, which fails closed: the hit test simply finds
 * nothing instead of inventing a scaled position.
 */
export function stagePointFromClientPoint(
  rect: StageRect,
  clientX: number,
  clientY: number,
): StagePoint {
  const scaleX = rect.width === 0 ? 1 : DESIGN_WIDTH / rect.width;
  const scaleY = rect.height === 0 ? 1 : DESIGN_HEIGHT / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

export function movedEnough(from: StagePoint, to: StagePoint): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) > DRAG_THRESHOLD_PX;
}

/**
 * World position a dragged sprite lands on.
 *
 * The sprite keeps its grab offset: only the *world* displacement of the
 * pointer is added to its original position, and both pointer positions are
 * projected through the same camera, so zoom and rotation change the mapping
 * without changing the authored value.
 */
export function dragWorldPosition(input: {
  /** Sprite world position when the gesture started. */
  origin: StagePoint;
  /** Design-space pointer position when the gesture started. */
  pointerDown: StagePoint;
  /** Design-space pointer position now. */
  pointerNow: StagePoint;
  camera: CameraSnapshot;
}): StagePoint {
  const down = stagePointToWorld(input.pointerDown, input.camera);
  const now = stagePointToWorld(input.pointerNow, input.camera);
  return {
    x: input.origin.x + (now.x - down.x),
    y: input.origin.y + (now.y - down.y),
  };
}

/** The sprite instance a stage gesture may grab; `hide` has no target. */
export function spriteDragTarget(node: SpriteNode): string | null {
  return node.action === "hide" ? null : node.sprite_id;
}

/**
 * Offset the runtime adds between authored `x`/`y` and the world position.
 *
 * Mirrors `resolve_character_asset` in the Rust core: the offset comes from
 * the expression that is actually resolved (the node's own expression, or the
 * character default), and a node without character/expression has no offset.
 * Unknown ids resolve to no offset instead of a guess, so an authoring-only
 * project state can never silently shift a written coordinate.
 */
export function spritePositionOffset(
  node: SpriteNode,
  manifest?: ContentManifest,
): StagePoint {
  const characterId = node.character ?? null;
  if (characterId === null || characterId === "") return { x: 0, y: 0 };
  const character = manifest?.characters[characterId];
  if (character === undefined) return { x: 0, y: 0 };
  const expressionId = node.expression ?? character.default_expression ?? null;
  if (expressionId === null || expressionId === "") return { x: 0, y: 0 };
  const expression = character.expressions?.[expressionId];
  if (expression === undefined) return { x: 0, y: 0 };
  return { x: expression.offset_x ?? 0, y: expression.offset_y ?? 0 };
}

/**
 * Authored `x`/`y` for a world position on the stage.
 *
 * The stage shows the runtime pose (`authored + expression offset`), so the
 * offset has to be removed before the value is written back.  The result is
 * rounded to whole design pixels: canvas drags are inherently sub-pixel, and
 * integral coordinates keep the saved scene readable and diffs stable.
 */
export function authoredSpritePosition(
  node: SpriteNode,
  manifest: ContentManifest | undefined,
  world: StagePoint,
): StagePoint {
  const offset = spritePositionOffset(node, manifest);
  return {
    x: Math.round(world.x - offset.x),
    y: Math.round(world.y - offset.y),
  };
}
