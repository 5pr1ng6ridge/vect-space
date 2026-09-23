import { describe, expect, it } from "vitest";

import {
  FALLBACK_LOOP_END_MS,
  MIN_LOOP_GAP_MS,
  defaultLoopBounds,
  markerMs,
  msToRatio,
  parseMetadataDurationMs,
  ratioToMs,
  resolveMarkerMs,
  sameLoopValues,
  toIntegerMs,
  withMarker,
  type AudioLoopValues,
} from "./audioLoop";

const BASE: AudioLoopValues = {
  loopEndMs: 3000,
  loopStartMs: 1000,
  startMs: 500,
};

describe("toIntegerMs", () => {
  it("rounds to the nearest integer millisecond", () => {
    expect(toIntegerMs(12.4)).toBe(12);
    expect(toIntegerMs(12.6)).toBe(13);
    expect(toIntegerMs(0)).toBe(0);
  });

  it("rejects negative and non-finite input", () => {
    expect(toIntegerMs(-1)).toBeNull();
    expect(toIntegerMs(Number.NaN)).toBeNull();
    expect(toIntegerMs(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("parseMetadataDurationMs", () => {
  it("parses canonical WireU64 durations", () => {
    expect(parseMetadataDurationMs("1234")).toBe(1234);
    expect(parseMetadataDurationMs("0")).toBe(0);
    expect(parseMetadataDurationMs(String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("returns null for non-canonical or unsafe values", () => {
    expect(parseMetadataDurationMs("")).toBeNull();
    expect(parseMetadataDurationMs("007")).toBeNull();
    expect(parseMetadataDurationMs("-5")).toBeNull();
    expect(parseMetadataDurationMs("1.5")).toBeNull();
    expect(parseMetadataDurationMs("abc")).toBeNull();
    expect(parseMetadataDurationMs("99999999999999999999")).toBeNull();
    expect(parseMetadataDurationMs(null)).toBeNull();
    expect(parseMetadataDurationMs(undefined)).toBeNull();
  });
});

describe("ms/ratio mapping", () => {
  it("maps milliseconds onto a bounded 0..1 axis", () => {
    expect(msToRatio(2000, 4000)).toBe(0.5);
    expect(msToRatio(5000, 4000)).toBe(1);
    expect(msToRatio(-10, 4000)).toBe(0);
    expect(msToRatio(10, null)).toBeNull();
    expect(msToRatio(10, 0)).toBeNull();
  });

  it("maps a pointer ratio back to exact integer milliseconds", () => {
    expect(ratioToMs(0.25, 4000)).toBe(1000);
    expect(ratioToMs(1.5, 4000)).toBe(4000);
    expect(ratioToMs(-1, 4000)).toBe(0);
    expect(ratioToMs(Number.NaN, 4000)).toBeNull();
  });
});

describe("defaultLoopBounds", () => {
  it("uses the media duration when the host knows it", () => {
    expect(defaultLoopBounds(4000, 500)).toEqual({
      loopEndMs: 4000,
      loopStartMs: 0,
    });
  });

  it("falls back to a fixed end when the duration is unknown", () => {
    expect(defaultLoopBounds(null, 500)).toEqual({
      loopEndMs: FALLBACK_LOOP_END_MS,
      loopStartMs: 0,
    });
    expect(defaultLoopBounds(0, 500)).toEqual({
      loopEndMs: FALLBACK_LOOP_END_MS,
      loopStartMs: 0,
    });
  });

  it("keeps loop_start strictly before loop_end for a late start_ms", () => {
    const bounds = defaultLoopBounds(100, 500);
    expect(bounds.loopStartMs).toBe(0);
    expect(bounds.loopEndMs).toBe(501);
    expect(bounds.loopEndMs - bounds.loopStartMs).toBeGreaterThanOrEqual(
      MIN_LOOP_GAP_MS,
    );
  });
});

describe("resolveMarkerMs", () => {
  it("keeps an in-range start marker exactly", () => {
    expect(resolveMarkerMs("start", 1500, BASE, 4000)).toBe(1500);
  });

  it("clamps the start marker to the custom loop end", () => {
    expect(resolveMarkerMs("start", 9000, BASE, 4000)).toBe(3000);
  });

  it("clamps the start marker to the media duration without a custom loop", () => {
    const noLoop: AudioLoopValues = {
      loopEndMs: null,
      loopStartMs: null,
      startMs: 0,
    };
    expect(resolveMarkerMs("start", 9000, noLoop, 4000)).toBe(4000);
  });

  it("does not clamp the start marker against an unknown duration", () => {
    const noLoop: AudioLoopValues = {
      loopEndMs: null,
      loopStartMs: null,
      startMs: 0,
    };
    expect(resolveMarkerMs("start", 9000, noLoop, null)).toBe(9000);
  });

  it("rejects invalid start input", () => {
    expect(resolveMarkerMs("start", -5, BASE, 4000)).toBeNull();
    expect(resolveMarkerMs("start", Number.NaN, BASE, 4000)).toBeNull();
  });

  it("prevents the loop start from crossing the loop end", () => {
    expect(resolveMarkerMs("loop_start", 5000, BASE, 4000)).toBe(2999);
    expect(resolveMarkerMs("loop_start", 200, BASE, 4000)).toBe(200);
  });

  it("keeps the loop end after the loop start and after start_ms", () => {
    expect(resolveMarkerMs("loop_end", 0, BASE, 4000)).toBe(1001);
    const lateStart: AudioLoopValues = {
      loopEndMs: 2000,
      loopStartMs: 100,
      startMs: 900,
    };
    expect(resolveMarkerMs("loop_end", 0, lateStart, 4000)).toBe(900);
  });

  it("bounds the loop end by a known duration but not by a guessed one", () => {
    expect(resolveMarkerMs("loop_end", 9000, BASE, 4000)).toBe(4000);
    expect(resolveMarkerMs("loop_end", 9000, BASE, null)).toBe(9000);
  });
});

describe("marker helpers", () => {
  it("reads and writes one marker without touching the others", () => {
    expect(markerMs(BASE, "loop_end")).toBe(3000);
    const next = withMarker(BASE, "loop_start", 250);
    expect(next).toEqual({ loopEndMs: 3000, loopStartMs: 250, startMs: 500 });
    expect(sameLoopValues(next, BASE)).toBe(false);
    expect(sameLoopValues(BASE, { ...BASE })).toBe(true);
  });
});
