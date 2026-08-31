import { evaluateChannel, type SharedTimelineChannels } from "./timeline";

export type UiMotionTarget =
  | "dialogue_root"
  | "dialogue_frame"
  | "dialogue_nameplate"
  | "dialogue_text"
  | "dialogue_advance_indicator";

export interface UiMotionPresetLike {
  duration_ms: number;
  tracks: { target: UiMotionTarget; channels: SharedTimelineChannels }[];
}

const TARGETS: UiMotionTarget[] = [
  "dialogue_root",
  "dialogue_frame",
  "dialogue_nameplate",
  "dialogue_text",
  "dialogue_advance_indicator",
];

/** Applies deterministic motion without changing DOM layout. */
export class UiMotionHost {
  readonly #elements = new Map<UiMotionTarget, HTMLElement>();
  #dialogueVisible = true;

  register(target: UiMotionTarget, element: HTMLElement | null): void {
    if (element === null) {
      this.#elements.delete(target);
      return;
    }
    this.#elements.set(target, element);
    this.#applyCanonical(element);
    if (target === "dialogue_root") {
      element.style.visibility = this.#dialogueVisible ? "visible" : "hidden";
    }
  }

  beginDialogueTransition(): void {
    const root = this.#elements.get("dialogue_root");
    if (root !== undefined) root.style.visibility = "visible";
  }

  apply(
    preset: UiMotionPresetLike,
    elapsedMs: number,
    durationMs: number,
  ): void {
    const sourceTime =
      durationMs <= 0
        ? preset.duration_ms
        : Math.max(
            0,
            Math.min(
              preset.duration_ms,
              (elapsedMs / durationMs) * preset.duration_ms,
            ),
          );
    for (const track of preset.tracks) {
      const element = this.#elements.get(track.target);
      if (element === undefined) continue;
      const offsetX = evaluateChannel(
        track.channels,
        "offset_x",
        sourceTime,
        0,
      );
      const offsetY = evaluateChannel(
        track.channels,
        "offset_y",
        sourceTime,
        0,
      );
      const scaleX = evaluateChannel(track.channels, "scale_x", sourceTime, 1);
      const scaleY = evaluateChannel(track.channels, "scale_y", sourceTime, 1);
      const rotation = evaluateChannel(
        track.channels,
        "rotation_deg",
        sourceTime,
        0,
      );
      element.style.transform = `translate3d(${offsetX}px, ${offsetY}px, 0) rotate(${rotation}deg) scale(${scaleX}, ${scaleY})`;
      element.style.opacity = String(
        evaluateChannel(track.channels, "opacity", sourceTime, 1),
      );
      element.style.willChange = "transform, opacity";
    }
  }

  reconcileDialogueVisible(visible: boolean): void {
    this.#dialogueVisible = visible;
    this.clearMotion();
    const root = this.#elements.get("dialogue_root");
    if (root !== undefined)
      root.style.visibility = visible ? "visible" : "hidden";
  }

  clearMotion(): void {
    for (const target of TARGETS) {
      const element = this.#elements.get(target);
      if (element !== undefined) this.#applyCanonical(element);
    }
  }

  #applyCanonical(element: HTMLElement): void {
    element.style.transform = "translate3d(0, 0, 0) rotate(0deg) scale(1, 1)";
    element.style.opacity = "1";
    element.style.willChange = "auto";
    element.style.transformOrigin = "center";
  }
}
