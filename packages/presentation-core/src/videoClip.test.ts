import { describe, expect, it } from "vitest";

import { evaluateVideoClip, type VideoClipSpec } from "./videoClip";

function spec(overrides: Partial<VideoClipSpec> = {}): VideoClipSpec {
  return { clip_start_ms: 0, clip_end_ms: null, loop: false, ...overrides };
}

describe("evaluateVideoClip", () => {
  it("tracks the playhead while inside an open window", () => {
    const position = evaluateVideoClip(spec(), 1_500, 10);
    expect(position?.desiredSeconds).toBeCloseTo(1.5, 6);
    expect(position?.atEnd).toBe(false);
  });

  it("clamps a non-loop playhead at an explicit clip end and reports it", () => {
    const clip = spec({ clip_end_ms: 2_000 });
    const inside = evaluateVideoClip(clip, 1_000, 10);
    expect(inside?.desiredSeconds).toBeCloseTo(1, 6);
    expect(inside?.atEnd).toBe(false);

    const past = evaluateVideoClip(clip, 3_000, 10);
    expect(past?.desiredSeconds).toBeCloseTo(2, 6);
    expect(past?.atEnd).toBe(true);
    expect(past?.endSeconds).toBeCloseTo(2, 6);
  });

  it("honours a clip start offset for both clamp and loop", () => {
    const clamp = evaluateVideoClip(
      spec({ clip_start_ms: 1_000, clip_end_ms: 3_000 }),
      5_000,
      10,
    );
    expect(clamp?.desiredSeconds).toBeCloseTo(3, 6);
    expect(clamp?.atEnd).toBe(true);

    const looped = evaluateVideoClip(
      spec({ clip_start_ms: 1_000, clip_end_ms: 3_000, loop: true }),
      3_500,
      10,
    );
    // raw = 1 + 3.5 = 4.5, window [1, 3): 1 + ((4.5 - 1) % 2) = 2.5
    expect(looped?.desiredSeconds).toBeCloseTo(2.5, 6);
    expect(looped?.atEnd).toBe(false);
  });

  it("falls back to the media duration when no clip end is authored", () => {
    const past = evaluateVideoClip(spec(), 5_000, 4);
    expect(past?.desiredSeconds).toBeCloseTo(4, 6);
    expect(past?.atEnd).toBe(true);
    expect(past?.endSeconds).toBeCloseTo(4, 6);
  });

  it("keeps an unknown media duration open-ended instead of freezing on a guess", () => {
    const position = evaluateVideoClip(spec(), 5_000, Number.NaN);
    expect(position?.desiredSeconds).toBeCloseTo(5, 6);
    expect(position?.atEnd).toBe(false);
    expect(position?.endSeconds).toBeNull();
  });

  it("presents an authored clip end beyond the media length up to the media end", () => {
    // 5s authored on a 2s file: the media cannot supply more, so the window
    // ends where the real file does and the session never seeks past EOF.
    const position = evaluateVideoClip(spec({ clip_end_ms: 5_000 }), 3_000, 2);
    expect(position?.endSeconds).toBeCloseTo(2, 6);
    expect(position?.desiredSeconds).toBeCloseTo(2, 6);
    expect(position?.atEnd).toBe(true);
  });

  it("wraps a looping window inside the explicit bounds", () => {
    const loop = evaluateVideoClip(
      spec({ clip_end_ms: 1_000, loop: true }),
      2_500,
      10,
    );
    expect(loop?.desiredSeconds).toBeCloseTo(0.5, 6);
    expect(loop?.atEnd).toBe(false);
  });

  it("wraps a looping window at the media duration", () => {
    const loop = evaluateVideoClip(spec({ loop: true }), 2_500, 2);
    expect(loop?.desiredSeconds).toBeCloseTo(0.5, 6);
    expect(loop?.atEnd).toBe(false);
  });

  it("never reports atEnd for a looping window", () => {
    const loop = evaluateVideoClip(
      spec({ clip_end_ms: 1_000, loop: true }),
      50_000,
      10,
    );
    expect(loop?.atEnd).toBe(false);
  });
});
