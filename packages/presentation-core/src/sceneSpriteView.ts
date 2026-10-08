/** One Sprite instance of a scene surface and the pose math that drives it. */

import type { FrameSequencePlayer, ImageAssetSource } from "./imageAnimation";
import type {
  SceneGraphicsLike,
  SceneKit,
  SceneNodeLike,
  SceneSpriteLike,
} from "./sceneKit";
import type { SceneTextureLike } from "./sceneTextures";
import type { SpriteSnapshot } from "./types";
import { spriteFit } from "./visual";

export interface SceneSpriteView {
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

/** Shows the loop frame `index` (the first frame when it is out of range). */
export function showFrame(view: SceneSpriteView, index: number): void {
  if (index < 0) return;
  const texture = view.textures[index] ?? view.textures[0];
  if (texture === undefined) return;
  view.sprite.texture = texture;
}

/** Re-parents the view when needed and applies `state`, including a cover mask. */
export function poseSpriteView(
  kit: SceneKit,
  view: SceneSpriteView,
  state: SpriteSnapshot,
  parent: SceneNodeLike,
): void {
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
    const mask = view.layoutMask ?? kit.graphics();
    if (view.layoutMask === undefined) {
      mask.label = `layout:${view.id}`;
      view.layoutMask = mask;
      parent.addChild(mask);
    }
    const fit = spriteFit(
      view.sprite.texture.width,
      view.sprite.texture.height,
      state.layout,
    );
    const width = state.layout.width / fit.x,
      height = state.layout.height / fit.y;
    mask
      .clear()
      .rect(
        -(state.anchor_x ?? 0.5) * width,
        -(state.anchor_y ?? 1) * height,
        width,
        height,
      )
      .fill(0xffffff);
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

/** The pose the view currently shows, as an authored-space snapshot. */
export function readSpriteView(view: SceneSpriteView): SpriteSnapshot {
  const state = view.state;
  const result = { ...state, ...readSprite(view.sprite) };
  const fit = spriteFit(
    view.sprite.texture.width,
    view.sprite.texture.height,
    state?.layout,
  );
  result.scale /= fit.x;
  result.scale_y *= fit.x / fit.y;
  result.anchor_x = state?.anchor_x ?? result.anchor_x ?? 0.5;
  result.anchor_y = state?.anchor_y ?? result.anchor_y ?? 1;
  result.source ??= { type: "image", asset: view.source.asset };
  return result;
}

function applySprite(view: SceneSpriteLike, state: SpriteSnapshot): void {
  const fit = spriteFit(view.texture.width, view.texture.height, state.layout);
  const anchorX = state.anchor_x ?? 0.5,
    anchorY = state.anchor_y ?? 1;
  view.anchor.set(
    state.layout?.fit === "cover"
      ? 0.5 +
          ((anchorX - 0.5) * state.layout.width) / (view.texture.width * fit.x)
      : anchorX,
    state.layout?.fit === "cover"
      ? 0.5 +
          ((anchorY - 0.5) * state.layout.height) /
            (view.texture.height * fit.y)
      : anchorY,
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

function readSprite(view: SceneSpriteLike): Omit<SpriteSnapshot, "asset"> {
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
