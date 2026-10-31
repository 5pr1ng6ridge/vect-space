import type {
  RuntimeUpdate,
  ScreenEffectSpec,
  TimelineEvent,
} from "@vectspace/presentation-core/types";
import type { ParityTarget, TimelineCue } from "./types";

export const COMPOSABLE_SHADER_TYPES = [
  "color_grade",
  "focus",
  "ripple",
] as const;
export type ComposableShaderType = (typeof COMPOSABLE_SHADER_TYPES)[number];
export type ScreenEffectEvent = Extract<
  TimelineEvent,
  { type: "screen_effect" }
>;
type ComposableEffect = Extract<
  ScreenEffectSpec,
  { type: ComposableShaderType }
>;

function isComposableShaderType(type: string): type is ComposableShaderType {
  return (COMPOSABLE_SHADER_TYPES as readonly string[]).includes(type);
}

export function isComposableEffect(
  effect: ScreenEffectSpec,
): effect is ComposableEffect {
  return isComposableShaderType(effect.type);
}

/** Timeline events that drive one of the composable world-layer passes. */
export function composableEffectEvents(
  update: RuntimeUpdate,
): ScreenEffectEvent[] {
  const cue = findTimelineCue(update);
  if (cue === null) return [];
  return cue.events.filter(
    (event): event is ScreenEffectEvent =>
      event.type === "screen_effect" &&
      isComposableShaderType(event.effect.type),
  );
}

function zeroedEffect(
  effect: ScreenEffectSpec,
  zeroed: ReadonlySet<ComposableShaderType>,
): ScreenEffectSpec {
  switch (effect.type) {
    case "color_grade":
    case "focus":
    case "ripple":
      return zeroed.has(effect.type) ? { ...effect, intensity: 0 } : effect;
    default:
      return effect;
  }
}

/**
 * The authored update with the named passes either zeroed or removed.
 *
 * Both are valid references: a `0` intensity is the shared identity bypass,
 * and a removed event means the channel simply never opens, so the two frames
 * must match pixel for pixel.
 */
export function referenceUpdate(
  update: RuntimeUpdate,
  zeroed: ReadonlySet<ComposableShaderType>,
  remove = false,
): RuntimeUpdate {
  return {
    ...update,
    cues: update.cues.map((cue) => {
      if (cue.type !== "timeline") return cue;
      return {
        ...cue,
        events: cue.events
          .filter(
            (event) =>
              !(
                remove &&
                event.type === "screen_effect" &&
                isComposableShaderType(event.effect.type) &&
                zeroed.has(event.effect.type)
              ),
          )
          .map((event) =>
            event.type === "screen_effect"
              ? { ...event, effect: zeroedEffect(event.effect, zeroed) }
              : event,
          ),
      };
    }),
  };
}

/**
 * The authored update with every `focus` event's parameters patched.
 *
 * Used to isolate the blur from the darkening: `darkness: 0` leaves a blur-only
 * pass, `maxBlur: 0` leaves a darken-only pass, and `maxBlur: 0, darkness: 0`
 * leaves no pass at all — the sharp reference the blur must change.
 */
export function focusPatchedUpdate(
  update: RuntimeUpdate,
  patch: Partial<Extract<ScreenEffectSpec, { type: "focus" }>>,
): RuntimeUpdate {
  return {
    ...update,
    cues: update.cues.map((cue) => {
      if (cue.type !== "timeline") return cue;
      return {
        ...cue,
        events: cue.events.map((event) =>
          event.type === "screen_effect" && event.effect.type === "focus"
            ? { ...event, effect: { ...event.effect, ...patch } }
            : event,
        ),
      };
    }),
  };
}

export function findTimelineCue(update: RuntimeUpdate): TimelineCue | null {
  return (
    update.cues.find(
      (candidate): candidate is TimelineCue => candidate.type === "timeline",
    ) ?? null
  );
}

/** TimelineSession is intentionally a timeline host; non-timeline ambience
 * nodes still need a zero-duration compatibility cue for preview reloads. */
export function editorCompatibleUpdate(target: ParityTarget): RuntimeUpdate {
  if (findTimelineCue(target.update) !== null) return target.update;
  return {
    ...target.update,
    cues: [
      {
        cue_id: `${target.update.update_id}:editor-timeline`,
        gate: "runtime",
        type: "timeline",
        presentation_id: `${target.scene_id}/${target.node_id}:editor`,
        duration_ms: 0,
        skippable: false,
        is_seen: true,
        tracks: [],
        events: [],
      },
    ],
  };
}
