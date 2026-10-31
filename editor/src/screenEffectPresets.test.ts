import { describe, expect, it } from "vitest";

import {
  findScreenEffectPreset,
  presetTimelineEvents,
} from "./screenEffectPresets";

function preset(id: string) {
  const found = findScreenEffectPreset(id);
  if (found === undefined) throw new Error(`missing preset ${id}`);
  return found;
}

describe("screen effect presets", () => {
  it("places events at the playhead with unique ids", () => {
    const events = presetTimelineEvents(
      preset("spatial_impact"),
      1_000,
      5_000,
      ["shake_1", "flash_1"],
    );
    expect(events.map((event) => event.id)).toEqual([
      "shockwave_1",
      "shake_2",
      "flash_2",
    ]);
    expect(events.every((event) => event.at_ms === 1_000)).toBe(true);
    const twice = presetTimelineEvents(
      preset("anomaly_escalation"),
      0,
      5_000,
      [],
    );
    expect(new Set(twice.map((event) => event.id)).size).toBe(twice.length);
    expect(twice.map((event) => event.at_ms)).toEqual([0, 900, 1_600, 2_100]);
  });

  it("fits every event into the remaining timeline", () => {
    const events = presetTimelineEvents(
      preset("anomaly_escalation"),
      500,
      2_000,
      [],
    );
    // The glitch at +1600 ms would start past the end and is dropped.
    expect(events.map((event) => event.at_ms)).toEqual([500, 1_400]);
    for (const event of events) {
      expect(event.at_ms + event.duration_ms).toBeLessThanOrEqual(2_000);
      expect(event.duration_ms).toBeGreaterThanOrEqual(1);
    }
    expect(
      presetTimelineEvents(preset("reasoning_break"), 2_000, 2_000, []),
    ).toEqual([]);
  });

  it("stages the composable effects with a non-neutral colour grade", () => {
    const steps = preset("correction_focus").steps;
    expect(steps.map((step) => step.effect.type)).toEqual([
      "color_grade",
      "focus",
      "ripple",
    ]);
    const grade = steps[0]?.effect;
    if (grade?.type !== "color_grade") throw new Error("expected a grade");
    // The demo must not insert the canonical identity grade; it has to be
    // visibly non-neutral so the preset is a usable staging building block.
    expect(grade).toMatchObject({ tint: "#8fb8ff" });
    expect(grade.tint_strength).toBeGreaterThan(0);
    expect(
      grade.brightness !== 0 || grade.contrast !== 1 || grade.saturation !== 1,
    ).toBe(true);
    const focus = steps[1]?.effect;
    expect(focus).toMatchObject({ type: "focus", blur: 10, darkness: 0.35 });
    const ripple = steps[2]?.effect;
    expect(ripple).toMatchObject({ type: "ripple", amplitude: 14 });

    const events = presetTimelineEvents(
      preset("correction_focus"),
      1_000,
      6_000,
      [],
    );
    expect(events.map((event) => event.id)).toEqual([
      "grade_1",
      "focus_1",
      "ripple_1",
    ]);
    expect(events.map((event) => event.at_ms)).toEqual([1_000, 1_000, 1_300]);
    for (const event of events) {
      expect(event.at_ms + event.duration_ms).toBeLessThanOrEqual(6_000);
    }
  });
});
