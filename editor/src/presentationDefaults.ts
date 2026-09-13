/**
 * Authoring defaults for the canonical presentation specs.
 *
 * The Rust loader normalises legacy one-word YAML into these shapes with the
 * same shipped values, so every editor creator (a new node, a new timeline
 * event, or an inspector type switch) must hand out exactly those values; one
 * source keeps them from drifting apart.  Factories return fresh objects
 * because specs are copied on edit, and the wire shape is unchanged.
 */

import type {
  BackgroundTransitionSpec,
  CurtainTransitionSpec,
  ScreenEffectSpec,
} from "./types";

/** Default transition of a new `background` node (legacy `cross_fade`). */
export function defaultBackgroundTransition(): BackgroundTransitionSpec {
  return { type: "cross_fade" };
}

/** Default fill of a new `curtain` cover: opaque black. */
export function defaultCurtainFill(): { color: string } {
  return { color: "#000000" };
}

/** Default open/close animation of a new `curtain` node. */
export function defaultCurtainTransition(): CurtainTransitionSpec {
  return { type: "fade" };
}

/** Default effect of a new `screen_effect` node / timeline event (legacy `flash`). */
export function defaultFlashEffect(): ScreenEffectSpec {
  return { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 };
}

/** Shipped shake parameters (legacy `shake`): 16×9.6, 18 Hz, decay 1, seed 0. */
export function defaultShakeEffect(): ScreenEffectSpec {
  return {
    type: "shake",
    amplitude_x: 16,
    amplitude_y: 9.6,
    frequency_hz: 18,
    decay: 1,
    seed: 0,
  };
}
