import { describe, expect, it } from "vitest";
import corpus from "../../shared/timeline-conformance.json";
import { evaluateChannel } from "./timeline";
import type { TimelineEasing } from "./types";

describe("timeline evaluator conformance", () => {
  for (const sample of corpus) {
    it(sample.name, () => {
      expect(
        evaluateChannel(
          {
            value: [
              { at_ms: 0, value: 0, easing: sample.easing as TimelineEasing },
              { at_ms: 1000, value: 10, easing: "linear" },
            ],
          },
          "value",
          sample.time,
          -1,
        ),
      ).toBeCloseTo(sample.expected, 3);
    });
  }

  it("resolves an inherited first frame against each timeline entry state", () => {
    const channels = {
      x: [
        { at_ms: 0, value: "inherit" as const, easing: "linear" as const },
        { at_ms: 1000, value: 700, easing: "linear" as const },
      ],
    };
    expect(evaluateChannel(channels, "x", 0, 200)).toBe(200);
    expect(evaluateChannel(channels, "x", 500, 200)).toBe(450);
    expect(evaluateChannel(channels, "x", 500, 500)).toBe(600);
    expect(evaluateChannel(channels, "x", 1000, 500)).toBe(700);
  });
});
