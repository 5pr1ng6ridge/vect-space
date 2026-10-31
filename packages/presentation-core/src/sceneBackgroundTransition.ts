/**
 * Transient visuals of a background transition: the fade-through-colour
 * overlay, the wipe/soft-push mask and its feather strips.
 *
 * The geometry comes from the pure evaluator in `sceneTransitions.ts`; this
 * class only owns the Pixi nodes, so a superseded or cancelled transition can
 * always release exactly what it installed.
 */

import { parseColor } from "./sceneEffects";
import { DESIGN_HEIGHT, DESIGN_WIDTH } from "./sceneFrame";
import type {
  SceneGraphicsLike,
  SceneKit,
  SceneNodeLike,
  SceneSpriteLike,
} from "./sceneKit";
import type { SceneSpriteView } from "./sceneSpriteView";
import {
  featherStepRect,
  featherSteps,
  maskOpaqueRect,
  type StageMask,
} from "./sceneTransitions";

/** Label suffix of the deterministic feather strips, for diagnostics/tests. */
const FEATHER_STRIP_LABEL = "#feather";

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

export interface BackgroundTransitionVisualsOptions {
  kit: SceneKit;
  /**
   * The camera layer.  The mask and strips are siblings of the background
   * view inside it, so their design-space rectangles line up with the
   * background and follow camera transforms.
   */
  backgrounds: SceneNodeLike;
  /** Screen-space layer of the fade-through-colour overlay. */
  overlayLayer: SceneNodeLike;
  requestRender(): void;
}

export class BackgroundTransitionVisuals {
  readonly #options: BackgroundTransitionVisualsOptions;
  /** Fade-through-colour overlay in the transition layer. */
  #overlay: SceneGraphicsLike | null = null;
  /** Alpha multiplier carried by the overlay colour (`#RRGGBBAA`). */
  #overlayAlpha = 1;
  #mask: SceneGraphicsLike | null = null;
  #maskOwner: SceneSpriteView | null = null;
  /** Deterministic stepped strips of the live soft wipe/push feather. */
  #strips: SceneFeatherStrip[] = [];

  constructor(options: BackgroundTransitionVisualsOptions) {
    this.#options = options;
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
  reset(): void {
    this.clearMask();
    this.clearOverlay();
  }

  /** Destroys the fade-through-colour overlay of an in-flight transition. */
  clearOverlay(): void {
    const overlay = this.#overlay;
    this.#overlay = null;
    this.#overlayAlpha = 1;
    if (overlay === null) return;
    this.#options.overlayLayer.removeChild(overlay);
    overlay.destroy();
  }

  /** Detaches and destroys the background mask and its feather strips. */
  clearMask(): void {
    const owner = this.#maskOwner;
    this.#maskOwner = null;
    if (owner !== null) owner.sprite.mask = owner.layoutMask ?? null;
    this.#clearStrips();
    const mask = this.#mask;
    this.#mask = null;
    if (mask === null) return;
    this.#options.backgrounds.removeChild(mask);
    mask.destroy();
  }

  /** Creates (or recolours) the fade-through-colour overlay. */
  ensureOverlay(color: string): void {
    const parsed = parseColor(color);
    if (this.#overlay !== null) {
      this.#options.overlayLayer.removeChild(this.#overlay);
      this.#overlay.destroy();
      this.#overlay = null;
    }
    const overlay = this.#options.kit.graphics();
    overlay.rect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT).fill(parsed.color);
    overlay.alpha = 0;
    this.#options.overlayLayer.addChild(overlay);
    this.#overlay = overlay;
    this.#overlayAlpha = parsed.alpha;
  }

  setOverlay(alpha: number): void {
    const overlay = this.#overlay;
    if (overlay === null) return;
    const scaled = alpha * this.#overlayAlpha;
    overlay.visible = scaled > 0;
    overlay.alpha = scaled;
  }

  /**
   * Attaches the wipe/soft-push mask to the incoming background.
   *
   * It is attached to the incoming view only, so the seam never touches any
   * other object, the curtain/effect layers or the DOM.  A new owner detaches
   * the previous one first: a shared mask must never clip a view that belongs
   * to a newer cue.
   */
  attachMask(view: SceneSpriteView): void {
    if (this.#mask === null) {
      this.#mask = this.#options.kit.graphics();
      this.#options.backgrounds.addChild(this.#mask);
    }
    const previous = this.#maskOwner;
    if (previous !== null && previous !== view)
      previous.sprite.mask = previous.layoutMask ?? null;
    this.#maskOwner = view;
    view.sprite.mask = this.#mask;
  }

  /**
   * Rebuilds the background mask geometry from one pure frame.
   *
   * `null` means the transition has no mask at all (cross-fade, cut, push
   * without softness).  A mask without a ramp is the exact hard edge: the
   * binary stencil draws the authored wipe rectangle, so `softness 0` is the
   * hard-edge path.  A ramped mask draws the fully revealed region with the
   * same stencil and overlays the deterministic stepped feather strips derived
   * from the pure evaluator, which is how a Pixi stencil mask renders a soft
   * edge without an alpha-mask port.
   */
  applyMask(mask: StageMask | null, view: SceneSpriteView): void {
    if (mask === null) {
      // Only this view's own mask is transient here; the take-over release
      // already cleared anything that belonged to a previous cue.
      if (this.#maskOwner === view) this.clearMask();
      return;
    }
    this.attachMask(view);
    const graphics = this.#mask;
    if (graphics === null) return;
    graphics.clear();
    const rect = maskOpaqueRect(mask);
    if (rect.width > 0 && rect.height > 0) {
      graphics.rect(rect.x, rect.y, rect.width, rect.height);
    }
    graphics.fill(0xffffff);
    this.#applyStrips(mask, view);
    this.#options.requestRender();
  }

  /**
   * Keeps the strips on the frame an animated incoming background now shows
   * (a soft edge draws copies of it).
   */
  syncStripTextures(view: SceneSpriteView): void {
    if (view !== this.#maskOwner) return;
    for (const strip of this.#strips) {
      strip.sprite.texture = view.sprite.texture;
    }
  }

  /**
   * Draws (or clears) the stepped feather strips of one mask frame.
   *
   * The strips are copies of the incoming view sharing its texture and pose,
   * clipped to their own stage-space rectangles; only their alpha steps
   * through the pure ramp, so no extra texture is decoded and nothing leaks
   * when the cue settles, is superseded, or the surface resets.
   */
  #applyStrips(mask: StageMask, view: SceneSpriteView): void {
    const steps = featherSteps(mask);
    if (steps.length === 0) {
      this.#clearStrips();
      return;
    }
    this.#ensureStrips(view, steps.length);
    for (const [index, strip] of this.#strips.entries()) {
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
  #ensureStrips(view: SceneSpriteView, count: number): void {
    while (this.#strips.length > count) {
      const strip = this.#strips.pop();
      if (strip === undefined) break;
      strip.sprite.mask = null;
      strip.sprite.destroy();
      strip.mask.destroy();
    }
    while (this.#strips.length < count) {
      const sprite = this.#options.kit.sprite(view.sprite.texture);
      sprite.label = `${view.label}${FEATHER_STRIP_LABEL}`;
      const stripMask = this.#options.kit.graphics();
      this.#options.backgrounds.addChild(stripMask);
      this.#options.backgrounds.addChild(sprite);
      this.#strips.push({ sprite, mask: stripMask });
    }
  }

  /** Destroys every feather strip (sprites and their rect masks) once. */
  #clearStrips(): void {
    for (const strip of this.#strips) {
      strip.sprite.mask = null;
      strip.sprite.destroy();
      strip.mask.destroy();
    }
    this.#strips.length = 0;
  }
}
