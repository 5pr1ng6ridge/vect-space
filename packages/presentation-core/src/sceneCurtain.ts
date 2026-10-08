/**
 * The persistent story curtain of a scene surface.
 *
 * The transition geometry comes from the pure evaluator in
 * `sceneTransitions.ts`; this class owns the fill view (colour or `gui`
 * artwork), its mask and the lifetime of a `curtain_transition` cue.  The
 * host-only session curtain lives in `sceneSessionCurtain.ts`.
 */

import { errorMessage } from "./errorMessage";
import type { PreparedAsset, SceneAssets } from "./sceneAssets";
import type { SceneCueLifecycle } from "./sceneCueLifecycle";
import { parseColor } from "./sceneEffects";
import { DESIGN_HEIGHT, DESIGN_WIDTH } from "./sceneFrame";
import type { SceneGraphicsLike, SceneKit, SceneNodeLike } from "./sceneKit";
import type { SceneCueContext, SceneVisualCue } from "./sceneSurfaceTypes";
import {
  evaluateCurtainTransition,
  fullStageRect,
  type CurtainTransitionFrame,
} from "./sceneTransitions";
import type { CurtainFill, CurtainSnapshot } from "./types";

/** Cue-conflict key for the persistent curtain layer. */
const CURTAIN_CUE = "curtain";

export interface SceneCurtainOptions {
  kit: SceneKit;
  assets: SceneAssets;
  lifecycle: SceneCueLifecycle;
  /** Layer above the world and below the screen effects. */
  layer: SceneNodeLike;
  diagnostic(message: string): void;
  requestRender(): void;
}

/** `gui` asset a curtain snapshot covers with, or `null` for colour/hidden. */
export function curtainAssetOf(curtain: CurtainSnapshot | null): string | null {
  if (curtain === null || !curtain.covered) return null;
  const fill = curtain.fill;
  if (fill === undefined || fill === null) return null;
  return "asset" in fill ? fill.asset : null;
}

/** Human-readable identity of a curtain fill, for diagnostics. */
function describeCurtainFill(fill: CurtainFill): string {
  return "asset" in fill ? fill.asset : fill.color;
}

export class SceneCurtain {
  readonly #options: SceneCurtainOptions;
  /** Current fill descriptor, so a cue only rebuilds on a real change. */
  #fillKey: string | null = null;
  #fill: SceneNodeLike | null = null;
  /** Alpha multiplier carried by a colour fill (`#RRGGBBAA`). */
  #fillAlpha = 1;
  #fillRefs: string[] = [];
  #mask: SceneGraphicsLike | null = null;

  constructor(options: SceneCurtainOptions) {
    this.#options = options;
  }

  /**
   * Applies a curtain snapshot without replaying a cue.
   *
   * This is the hard-reconcile path used by `applyWorld`, so a restored save
   * shows exactly the curtain it stored.
   */
  commit(
    prepared: PreparedAsset | null,
    snapshot: CurtainSnapshot | null,
  ): void {
    const fill = snapshot?.covered ? (snapshot.fill ?? null) : null;
    if (fill === null) {
      this.destroy();
      return;
    }
    if (!this.#ensureFill(fill, prepared)) {
      // Missing pixels must never reveal the world behind a covered curtain;
      // fall back to an opaque cover so the stable state stays trustworthy.
      // The fallback is silent to the player, so it is reported here.
      this.#options.diagnostic(
        `幕布素材缺失或加载失败，已回退为纯色幕布：${describeCurtainFill(fill)}`,
      );
      this.#ensureFill({ color: "#000000" }, null);
    }
    this.#applyFrame({ alpha: 1, rects: [fullStageRect()] });
  }

  /**
   * Covers or reveals the curtain.
   *
   * Re-revealing an already revealed curtain is a no-op the runtime never
   * emits, so a stray cue cannot leave a half-drawn layer behind either.
   */
  async transition(
    cue: Extract<SceneVisualCue, { type: "curtain_transition" }>,
    context: SceneCueContext,
  ): Promise<void> {
    const { assets, lifecycle } = this.#options;
    const generation = lifecycle.generation;
    const token = lifecycle.begin(CURTAIN_CUE);
    let prepared: PreparedAsset | null = null;
    // `fill` is optional on the wire (the runtime omits it for a reveal), so an
    // absent field means "no new fill", never an `undefined` lookup.
    const fill = cue.fill ?? null;
    if (fill !== null && "asset" in fill) {
      try {
        prepared = await assets.acquire(fill.asset, context.assets);
      } catch (error) {
        this.#options.diagnostic(`幕布素材加载失败：${errorMessage(error)}`);
        prepared = null;
      }
      if (
        context.signal.aborted ||
        !lifecycle.isLatest(generation, CURTAIN_CUE, token)
      ) {
        if (prepared !== null) assets.releasePrepared(prepared);
        return;
      }
    }
    if (cue.action === "cover") {
      const cover = fill ?? { color: "#000000" };
      if (!this.#ensureFill(cover, prepared)) {
        // The fallback keeps the world hidden; make it discoverable.
        this.#options.diagnostic(
          `幕布素材缺失或加载失败，已回退为纯色幕布：${describeCurtainFill(cover)}`,
        );
        this.#ensureFill({ color: "#000000" }, null);
      }
    } else if (this.#fill === null) {
      if (prepared !== null) assets.releasePrepared(prepared);
      return;
    }
    const applyFrame = (progress: number): void => {
      if (!lifecycle.isCurrent(generation)) return;
      if (!lifecycle.isLatest(generation, CURTAIN_CUE, token)) return;
      this.#applyFrame(
        evaluateCurtainTransition(cue.transition, cue.action, progress),
      );
      this.#options.requestRender();
    };
    if (cue.duration_ms > 0) {
      await lifecycle.run(cue.duration_ms, cue.easing, applyFrame, context);
    }
    if (lifecycle.isLatest(generation, CURTAIN_CUE, token)) {
      applyFrame(1);
      if (cue.action === "reveal") this.destroy();
    }
    if (prepared !== null) assets.releasePrepared(prepared);
  }

  /** Drops the curtain fill, its mask and the texture references it owns. */
  destroy(): void {
    const { layer, assets } = this.#options;
    const fill = this.#fill;
    this.#fill = null;
    this.#fillKey = null;
    this.#fillAlpha = 1;
    if (fill !== null) {
      fill.mask = null;
      layer.removeChild(fill);
      fill.destroy({ children: true });
    }
    const mask = this.#mask;
    this.#mask = null;
    if (mask !== null) {
      layer.removeChild(mask);
      mask.destroy();
    }
    assets.store.releaseAll(this.#fillRefs);
    this.#fillRefs = [];
  }

  /**
   * Ensures the curtain fill view matches `fill`.
   *
   * Returns `false` when an asset fill has no prepared pixels yet, so the
   * caller can fall back instead of showing an empty layer.
   */
  #ensureFill(fill: CurtainFill, prepared: PreparedAsset | null): boolean {
    const { kit, assets, layer } = this.#options;
    // The asset revision is part of the identity: an edited `gui` asset keeps
    // its id but changes its pixels, and the curtain must follow it.
    const key =
      "asset" in fill
        ? `asset:${fill.asset}:${prepared?.version ?? ""}`
        : `color:${fill.color}`;
    if (this.#fillKey === key && this.#fill !== null) return true;
    this.destroy();
    if (!("asset" in fill)) {
      const parsed = parseColor(fill.color);
      const graphics = kit.graphics();
      graphics.rect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT).fill(parsed.color);
      layer.addChild(graphics);
      this.#fill = graphics;
      this.#fillKey = key;
      this.#fillAlpha = parsed.alpha;
      return true;
    }
    const texture = prepared?.textures[0];
    if (texture === undefined) return false;
    const sprite = kit.sprite(texture);
    const width = texture.width;
    const height = texture.height;
    const scale = Math.max(DESIGN_WIDTH / width, DESIGN_HEIGHT / height);
    sprite.anchor.set(0, 0);
    sprite.scale.set(scale);
    sprite.position.set(
      (DESIGN_WIDTH - width * scale) / 2,
      (DESIGN_HEIGHT - height * scale) / 2,
    );
    layer.addChild(sprite);
    this.#fill = sprite;
    this.#fillKey = key;
    this.#fillAlpha = 1;
    if (prepared !== null) this.#fillRefs = assets.claim(prepared);
    return true;
  }

  /** Applies one pure curtain frame (alpha + covered rectangles). */
  #applyFrame(frame: CurtainTransitionFrame): void {
    const { kit, layer } = this.#options;
    const fill = this.#fill;
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
    fill.alpha = frame.alpha * this.#fillAlpha;
    const mask = this.#mask ?? kit.graphics();
    if (this.#mask === null) {
      layer.addChild(mask);
      this.#mask = mask;
    }
    mask.clear();
    for (const rect of visibleRects) {
      mask.rect(rect.x, rect.y, rect.width, rect.height);
    }
    mask.fill(0xffffff);
    fill.mask = mask;
  }
}
