/**
 * Staging presets that compose the screen-effect modules.
 *
 * A preset is not a new shader: it inserts ordinary `screen_effect` timeline
 * events (glitch, chromatic aberration, shockwave, colour grade, focus,
 * ripple, shake, flash) at the playhead.  Authors keep editing each event
 * afterwards, and the content format stays a flat list of canonical specs.
 */

import type { ScreenEffectSpec, TimelineEvent } from "./types";

export type ScreenEffectPresetId =
  | "reasoning_break"
  | "spatial_impact"
  | "anomaly_escalation"
  | "correction_focus";

export interface ScreenEffectPresetStep {
  /** Start relative to the insertion point. */
  offset_ms: number;
  duration_ms: number;
  effect: ScreenEffectSpec;
}

export interface ScreenEffectPreset {
  id: ScreenEffectPresetId;
  label: string;
  description: string;
  steps: readonly ScreenEffectPresetStep[];
}

const CENTER = { center_x: 960, center_y: 540 } as const;

export const SCREEN_EFFECT_PRESETS: readonly ScreenEffectPreset[] = [
  {
    id: "reasoning_break",
    label: "推理断裂",
    description: "短促故障 + 轻微色差",
    steps: [
      {
        offset_ms: 0,
        duration_ms: 260,
        effect: {
          type: "glitch",
          displacement: 72,
          slice_count: 18,
          density: 0.45,
          frequency_hz: 24,
          seed: 11,
          fade_in: 0,
          fade_out: 0.35,
        },
      },
      {
        offset_ms: 0,
        duration_ms: 420,
        effect: {
          type: "chromatic_aberration",
          intensity: 8,
          angle_deg: 0,
          ...CENTER,
          edge_weight: 0.4,
          fade_in: 0,
          fade_out: 1,
        },
      },
    ],
  },
  {
    id: "spatial_impact",
    label: "空间冲击",
    description: "冲击波 + 震动 + 弱闪光",
    steps: [
      {
        offset_ms: 0,
        duration_ms: 800,
        effect: {
          type: "shockwave",
          ...CENTER,
          max_radius: 1200,
          wave_width: 160,
          strength: 36,
        },
      },
      {
        offset_ms: 0,
        duration_ms: 420,
        effect: {
          type: "shake",
          amplitude_x: 18,
          amplitude_y: 10.8,
          frequency_hz: 20,
          decay: 1,
          seed: 0,
        },
      },
      {
        offset_ms: 0,
        duration_ms: 180,
        effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.35 },
      },
    ],
  },
  {
    id: "anomaly_escalation",
    label: "异常升级",
    description: "色差逐渐增强，间歇出现故障",
    steps: [
      {
        offset_ms: 0,
        duration_ms: 2400,
        effect: {
          type: "chromatic_aberration",
          intensity: 22,
          angle_deg: 0,
          ...CENTER,
          edge_weight: 0.7,
          fade_in: 1,
          fade_out: 0,
        },
      },
      {
        offset_ms: 900,
        duration_ms: 140,
        effect: {
          type: "glitch",
          displacement: 32,
          slice_count: 12,
          density: 0.3,
          frequency_hz: 18,
          seed: 3,
          fade_in: 0,
          fade_out: 0,
        },
      },
      {
        offset_ms: 1600,
        duration_ms: 180,
        effect: {
          type: "glitch",
          displacement: 56,
          slice_count: 16,
          density: 0.4,
          frequency_hz: 20,
          seed: 5,
          fade_in: 0,
          fade_out: 0,
        },
      },
      {
        offset_ms: 2100,
        duration_ms: 300,
        effect: {
          type: "glitch",
          displacement: 96,
          slice_count: 20,
          density: 0.55,
          frequency_hz: 24,
          seed: 8,
          fade_in: 0,
          fade_out: 0.3,
        },
      },
    ],
  },
  {
    id: "correction_focus",
    label: "修正聚焦",
    description: "冷调色彩修正 + 聚焦模糊 + 波纹",
    steps: [
      {
        offset_ms: 0,
        duration_ms: 2000,
        effect: {
          type: "color_grade",
          brightness: 0.04,
          contrast: 1.15,
          saturation: 0.85,
          tint: "#8fb8ff",
          tint_strength: 0.35,
          intensity: 1,
          fade_in: 0.15,
          fade_out: 0.25,
        },
      },
      {
        offset_ms: 0,
        duration_ms: 1600,
        effect: {
          type: "focus",
          ...CENTER,
          radius: 320,
          softness: 180,
          blur: 10,
          darkness: 0.35,
          intensity: 1,
          fade_in: 0.1,
          fade_out: 0.3,
        },
      },
      {
        offset_ms: 300,
        duration_ms: 1200,
        effect: {
          type: "ripple",
          ...CENTER,
          amplitude: 14,
          wavelength: 180,
          speed: 260,
          damping: 1,
          intensity: 1,
          fade_in: 0.1,
          fade_out: 0.2,
        },
      },
    ],
  },
];

const ID_PREFIX: Record<ScreenEffectSpec["type"], string> = {
  flash: "flash",
  shake: "shake",
  chromatic_aberration: "chromatic",
  glitch: "glitch",
  shockwave: "shockwave",
  color_grade: "grade",
  focus: "focus",
  ripple: "ripple",
};

export function findScreenEffectPreset(
  id: string,
): ScreenEffectPreset | undefined {
  return SCREEN_EFFECT_PRESETS.find((preset) => preset.id === id);
}

/**
 * The preset's events placed at `atMs` and fitted into the timeline.
 *
 * Steps that would start at or after the end are dropped and the remaining
 * durations are clipped, so every event satisfies the content rule
 * `at_ms + duration_ms <= timeline duration`.  Ids are unique against
 * `usedIds` and against each other.
 */
export function presetTimelineEvents(
  preset: ScreenEffectPreset,
  atMs: number,
  timelineDurationMs: number,
  usedIds: Iterable<string>,
): Extract<TimelineEvent, { type: "screen_effect" }>[] {
  const used = new Set(usedIds);
  const events: Extract<TimelineEvent, { type: "screen_effect" }>[] = [];
  for (const step of preset.steps) {
    const at = Math.max(0, Math.round(atMs + step.offset_ms));
    const room = timelineDurationMs - at;
    if (room < 1) continue;
    const prefix = ID_PREFIX[step.effect.type];
    let index = 1;
    while (used.has(`${prefix}_${index}`)) index += 1;
    const id = `${prefix}_${index}`;
    used.add(id);
    events.push({
      type: "screen_effect",
      id,
      at_ms: at,
      // Specs are flat, so a shallow copy keeps edits off the preset table.
      effect: { ...step.effect },
      duration_ms: Math.max(1, Math.min(step.duration_ms, room)),
    });
  }
  return events;
}
