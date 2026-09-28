/**
 * Pure, deterministic screen-effect evaluation shared by the game renderer and
 * the editor preview.
 *
 * Screen effects are presentation events rather than world state, so every
 * value here is a pure function of the playhead.  Scrubbing, pausing, playback
 * and both hosts therefore agree on the exact same pixels, and a fixed seed can
 * never drift between them.
 */

import { applyEasing } from "./timeline";
import type { ScreenEffectSpec } from "./types";

export type FlashSpec = Extract<ScreenEffectSpec, { type: "flash" }>;
export type ShakeSpec = Extract<ScreenEffectSpec, { type: "shake" }>;

/** A spec plus the authored interval it is active over. */
export interface ActiveScreenEffectLike {
  startMs: number;
  durationMs: number;
  effect: ScreenEffectSpec;
}

export interface ScreenEffectFrame {
  flash: { color: string; alpha: number } | null;
  shake: { x: number; y: number };
}

/**
 * Largest accepted seed.
 *
 * The seed crosses the Tauri IPC boundary as a JSON number, so it must stay
 * inside the JavaScript safe integer range; `0xffffffff` mirrors the Rust
 * `u32` and is exactly representable.
 */
export const SHAKE_SEED_MAX = 0xffff_ffff;

/**
 * Normalised progress of an effect window.
 *
 * Returns `NaN` outside the window so a stale playhead can never apply an
 * out-of-window flash or shake.
 */
export function normalizedEffectProgress(
  elapsedMs: number,
  startMs: number,
  durationMs: number,
): number {
  if (elapsedMs < startMs) return Number.NaN;
  const duration = Math.max(1, durationMs);
  const progress = (elapsedMs - startMs) / duration;
  if (progress >= 1) return Number.NaN;
  return Math.max(0, progress);
}

/**
 * Stable per-axis phase offset derived from the authored seed.
 *
 * A fixed integer hash (32-bit xorshift-style mixing) maps the seed to
 * `[0, 2π)` without touching floating point randomness, so the same seed
 * always produces the same offset on every engine, host and seek position.
 * Seed `0` (the default) is a valid, stable seed.
 */
export function shakeSeedPhase(seed: number, axis: 0 | 1): number {
  const salt = axis === 0 ? 0x9e37_79b9 : 0x85eb_ca6b;
  const normalized = Number.isFinite(seed) ? Math.max(0, Math.floor(seed)) : 0;
  let value = ((normalized & SHAKE_SEED_MAX) ^ salt) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9_f3b) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9_f3b) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  return (value / 0x1_0000_0000) * Math.PI * 2;
}

/**
 * Flash alpha at one playhead position.
 *
 * The shipped `ease_out` decay is kept; only colour and peak alpha are
 * parameterised.
 */
export function evaluateFlashAlpha(
  spec: FlashSpec,
  elapsedMs: number,
  startMs: number,
  durationMs: number,
): number {
  const progress = normalizedEffectProgress(elapsedMs, startMs, durationMs);
  if (Number.isNaN(progress)) return 0;
  const peak = Number.isFinite(spec.peak_alpha) ? spec.peak_alpha : 0;
  return peak * (1 - applyEasing(progress, "ease_out"));
}

/**
 * Shake offset at one playhead position.
 *
 * The offset is a sinusoid at `frequency_hz` against elapsed seconds, with a
 * per-axis phase derived from the seed, bounded by `amplitude_x`/`amplitude_y`
 * and scaled by the linear envelope `1 - decay * progress` (decay `0` never
 * decays, decay `1` reaches zero exactly at the end of the window).
 */
export function evaluateShakeOffset(
  spec: ShakeSpec,
  elapsedMs: number,
  startMs: number,
  durationMs: number,
): { x: number; y: number } {
  const progress = normalizedEffectProgress(elapsedMs, startMs, durationMs);
  if (Number.isNaN(progress)) return { x: 0, y: 0 };
  const envelope = 1 - spec.decay * progress;
  const seconds = Math.max(0, elapsedMs - startMs) / 1000;
  const omega = 2 * Math.PI * spec.frequency_hz;
  const phaseX = shakeSeedPhase(spec.seed, 0);
  const phaseY = shakeSeedPhase(spec.seed, 1);
  return {
    x: Math.sin(omega * seconds + phaseX) * spec.amplitude_x * envelope,
    y: Math.sin(omega * seconds + phaseY) * spec.amplitude_y * envelope,
  };
}

/**
 * Both screen effects at one playhead position.
 *
 * Flash and shake are independent channels, so they stack; a window whose spec
 * does not match the channel is ignored instead of being coerced.
 */
export function evaluateScreenEffectFrame(
  elapsedMs: number,
  flash: ActiveScreenEffectLike | null,
  shake: ActiveScreenEffectLike | null,
): ScreenEffectFrame {
  const flashFrame =
    flash !== null && flash.effect.type === "flash"
      ? {
          color: flash.effect.color,
          alpha: evaluateFlashAlpha(
            flash.effect,
            elapsedMs,
            flash.startMs,
            flash.durationMs,
          ),
        }
      : null;
  const shakeFrame =
    shake !== null && shake.effect.type === "shake"
      ? evaluateShakeOffset(
          shake.effect,
          elapsedMs,
          shake.startMs,
          shake.durationMs,
        )
      : { x: 0, y: 0 };
  return {
    flash: flashFrame !== null && flashFrame.alpha > 0 ? flashFrame : null,
    shake: shakeFrame,
  };
}
