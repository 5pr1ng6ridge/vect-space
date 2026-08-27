import { describe, expect, it } from "vitest";
import corpus from "../../shared/timeline-conformance.json";
import { evaluateChannel } from "./timeline";
import type { TimelineEasing } from "./types";

describe("editor timeline evaluator conformance", () => {
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
});
