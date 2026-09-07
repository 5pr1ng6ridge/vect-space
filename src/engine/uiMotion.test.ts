import { describe, expect, it } from "vitest";

import type { UiMotionPreset } from "./types";
import { UiMotionHost } from "@vectspace/presentation-core/ui-motion";

const preset: UiMotionPreset = {
  schema_version: 1,
  id: "ui.test",
  duration_ms: 200,
  tracks: [
    {
      target: "dialogue_root",
      channels: {
        offset_y: [
          { at_ms: 0, value: 40, easing: "linear" },
          { at_ms: 200, value: 0, easing: "linear" },
        ],
        opacity: [
          { at_ms: 0, value: 0, easing: "linear" },
          { at_ms: 200, value: 1, easing: "linear" },
        ],
      },
    },
  ],
};

describe("UiMotionHost", () => {
  it("evaluates the same preset at an overridden cue duration", () => {
    const element = document.createElement("section");
    const host = new UiMotionHost();
    host.register("dialogue_root", element);

    host.apply(preset, 200, 400);

    expect(element.style.transform).toContain("20px");
    expect(element.style.opacity).toBe("0.5");
  });

  it("keeps the root visible during a hide transition and reconciles after it", () => {
    const element = document.createElement("section");
    const host = new UiMotionHost();
    host.register("dialogue_root", element);
    host.reconcileDialogueVisible(false);
    expect(element.style.visibility).toBe("hidden");

    host.beginDialogueTransition();
    expect(element.style.visibility).toBe("visible");

    host.apply(preset, 200, 200);
    host.reconcileDialogueVisible(false);
    expect(element.style.visibility).toBe("hidden");
    expect(element.style.opacity).toBe("1");
    expect(element.style.transform).toContain("translate3d(0, 0, 0)");
  });
});
