/**
 * Screen-space effects of a scene surface: the flash overlay, the shake
 * offset and the shader passes that post-process the world layer.
 *
 * Two sources feed every channel: the timeline playhead
 * (`setActive`) and node cues (`cue`).  A timeline window owns its shader
 * channel while it is active; a node cue fills the channel otherwise.  Shake
 * is composed into the camera transform by the surface, never applied here.
 */

import type { SceneCueLifecycle } from "./sceneCueLifecycle";
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
  parseColor,
  type ScreenEffectOptions,
  type ShaderEffectFrame,
} from "./sceneEffects";
import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  shakeOffset,
  stagePointToWorld,
} from "./sceneFrame";
import type { SceneGraphicsLike, SceneKit, SceneNodeLike } from "./sceneKit";
import type { SceneRect, SceneShaderHostLike } from "./sceneShaders";
import type { SceneActiveEffects, SceneCueContext } from "./sceneSurfaceTypes";
import type {
  CameraSnapshot,
  ScreenEffectSpec,
  ShaderScreenEffectType,
} from "./types";

/** Cue-conflict key prefix for one shader screen-effect channel. */
const SHADER_CUE = "shader:";

export interface SceneScreenEffectsOptions {
  kit: SceneKit;
  lifecycle: SceneCueLifecycle;
  /** The camera layer: shader passes post-process it, and only it. */
  worldLayer: SceneNodeLike;
  /** Screen-space layer the flash nodes are added to. */
  layer: SceneNodeLike;
  isDisposed(): boolean;
  camera(): CameraSnapshot;
  /** Re-composes camera and shake after the shake offset changed. */
  applyCamera(): void;
  requestRender(): void;
}

/**
 * The effect types the world-layer shader host owns.
 *
 * Every other type is geometry (flash, shake) and must never fall through to
 * the shake executor.  Keeping the test in one place keeps the dispatch
 * exhaustive.
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

export class SceneScreenEffects {
  readonly #options: SceneScreenEffectsOptions;
  /** Post-processing of the world layer (the shader screen effects). */
  readonly #shaderHost: SceneShaderHostLike;
  #flash: SceneGraphicsLike | null = null;
  #flashColor: number | null = null;
  /** Alpha multiplier carried by the flash colour (`#RRGGBBAA`). */
  #flashColorAlpha = 1;
  #state: SceneActiveEffects | null = null;
  #cueShake = { x: 0, y: 0 };
  /** Shader frames driven by node cues, one channel per effect type. */
  #cueShaders: ShaderEffectFrame = EMPTY_SHADER_EFFECT_FRAME;
  /** True while the shader host has at least one pass installed. */
  #shadersActive = false;
  /** Player accessibility preference; see `setReducedMotion`. */
  #reducedMotion = false;
  /** Cue-owned flash nodes, released exactly once. */
  readonly #cueFlashes = new Set<SceneGraphicsLike>();

  constructor(options: SceneScreenEffectsOptions) {
    this.#options = options;
    // Shader effects post-process the world only: like shake, they never
    // touch the curtain, the screen overlays, the host session curtain or the
    // DOM dialogue/UI above the canvas.
    this.#shaderHost = options.kit.shaderHost(options.worldLayer);
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
    this.apply();
    this.#options.applyCamera();
    this.#options.requestRender();
  }

  /**
   * Sets the timeline-derived screen effects for the current playhead.
   *
   * Every channel is derived from the same position, so scrubbing, pausing and
   * playing all agree.  The channels coexist: shake is composed into the
   * camera transform instead of overwriting it, and the shader passes stack in
   * their fixed order on top of the shaken world.
   */
  setActive(effects: SceneActiveEffects | null): void {
    this.#state = effects;
    this.apply();
    this.#options.applyCamera();
    this.#options.requestRender();
  }

  /** The shake offset of the playhead plus the one a running shake cue samples. */
  shake(): { x: number; y: number } {
    const timeline = shakeOffset(
      this.#state?.elapsedMs ?? 0,
      this.#state?.shake ?? null,
      this.#effectOptions(),
    );
    return {
      x: timeline.x + this.#cueShake.x,
      y: timeline.y + this.#cueShake.y,
    };
  }

  /** Redraws the flash overlay for the current playhead. */
  apply(): void {
    const effects = this.#state;
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
      this.#flash = this.#options.kit.graphics();
      this.#flash
        .rect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT)
        .fill(color ?? 0xffffff);
      this.#flashColor = color ?? 0xffffff;
      this.#options.layer.addChild(this.#flash);
    }
    // The evaluator owns the decay; the colour's own alpha only scales it.
    // Reading it on every frame keeps an alpha-only colour edit visible.
    this.#flashColorAlpha = parsed?.alpha ?? 1;
    this.#flash.alpha = alpha * this.#flashColorAlpha;
  }

  /** Drops the playhead state, every cue-driven effect and their nodes. */
  clear(): void {
    this.#state = null;
    this.resetCues();
    this.#flash?.destroy();
    this.#flash = null;
    this.#flashColorAlpha = 1;
    this.releaseCueFlashes();
  }

  /** Forgets the sampled shake offset and cue shader frames of a finished generation. */
  resetCues(): void {
    this.#cueShake = { x: 0, y: 0 };
    this.#cueShaders = EMPTY_SHADER_EFFECT_FRAME;
    this.syncShaders();
  }

  /** Destroys every flash node a cue still owns, exactly once. */
  releaseCueFlashes(): void {
    for (const flash of [...this.#cueFlashes]) {
      this.#cueFlashes.delete(flash);
      flash.destroy();
    }
  }

  /**
   * Installs the shader passes of the current playhead and cue state.
   *
   * A timeline window owns its channel while it is active; a node cue fills
   * the channel otherwise.  An idle frame removes every pass exactly once.
   */
  syncShaders(shake: { x: number; y: number } = this.shake()): void {
    if (this.#options.isDisposed()) return;
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

  destroy(): void {
    this.#shaderHost.destroy();
    this.#shadersActive = false;
  }

  /** Node-cue executor of one screen effect. */
  async cue(
    effect: ScreenEffectSpec,
    durationMs: number,
    context: SceneCueContext,
  ): Promise<void> {
    if (isShaderScreenEffect(effect)) {
      await this.#shaderCue(effect, durationMs, context);
      return;
    }
    const { kit, lifecycle, layer } = this.#options;
    const generation = lifecycle.generation;
    if (effect.type === "flash") {
      const parsed = parseColor(effect.color);
      const flash = kit.graphics();
      flash.rect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT).fill(parsed.color);
      flash.alpha =
        evaluateFlashAlpha(effect, 0, 0, durationMs, this.#effectOptions()) *
        parsed.alpha;
      layer.addChild(flash);
      this.#cueFlashes.add(flash);
      try {
        // `evaluateFlashAlpha` owns the shipped ease-out decay, so the
        // animation drives raw progress only and the cue path matches the
        // timeline path exactly at the same elapsed time.
        await lifecycle.run(
          durationMs,
          "linear",
          (progress) => {
            if (!lifecycle.isCurrent(generation)) return;
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
        if (lifecycle.isCurrent(generation)) this.#options.requestRender();
      }
      return;
    }
    try {
      await lifecycle.run(
        durationMs,
        "linear",
        (progress) => {
          if (!lifecycle.isCurrent(generation)) return;
          this.#cueShake = evaluateShakeOffset(
            effect,
            progress * durationMs,
            0,
            durationMs,
            this.#effectOptions(),
          );
          this.#options.applyCamera();
        },
        context,
      );
    } finally {
      if (lifecycle.isCurrent(generation)) {
        this.#cueShake = { x: 0, y: 0 };
        this.#options.applyCamera();
        this.#options.requestRender();
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
  async #shaderCue(
    effect: Extract<ScreenEffectSpec, { type: ShaderScreenEffectType }>,
    durationMs: number,
    context: SceneCueContext,
  ): Promise<void> {
    const { lifecycle } = this.#options;
    const generation = lifecycle.generation;
    const key = `${SHADER_CUE}${effect.type}`;
    const token = lifecycle.begin(key);
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
      this.syncShaders();
      this.#options.requestRender();
    };
    try {
      await lifecycle.run(
        durationMs,
        "linear",
        (progress) => {
          if (!lifecycle.isLatest(generation, key, token)) return;
          write(progress * durationMs);
        },
        context,
      );
    } finally {
      if (lifecycle.isLatest(generation, key, token)) write(null);
    }
  }

  #effectOptions(): ScreenEffectOptions {
    return { reducedMotion: this.#reducedMotion };
  }

  #shaderFrame(): ShaderEffectFrame {
    const effects = this.#state;
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
    const camera = this.#options.camera();
    const corners = [
      { x: -1, y: -1 },
      { x: DESIGN_WIDTH + 1, y: -1 },
      { x: -1, y: DESIGN_HEIGHT + 1 },
      { x: DESIGN_WIDTH + 1, y: DESIGN_HEIGHT + 1 },
    ].map((point) => stagePointToWorld(point, camera, shake));
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
}
