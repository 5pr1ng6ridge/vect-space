import { describe, expect, it } from "vitest";

import type { DialoguePrompt, PlaybackSnapshot } from "./types";
import { canFastForwardPrompt } from "./playback";

const normal: PlaybackSnapshot = {
  auto: "normal",
  ctrl_fast_forward: "allow",
};
const dialogue = (is_read: boolean): DialoguePrompt => ({
  kind: "dialogue",
  prompt_id: "scene/line",
  speaker: null,
  text: "line",
  is_read,
});

describe("Ctrl fast-forward policy", () => {
  it("implements disabled, read-only and all modes", () => {
    expect(canFastForwardPrompt(normal, "disabled", dialogue(true))).toBe(
      false,
    );
    expect(canFastForwardPrompt(normal, "read_only", dialogue(false))).toBe(
      false,
    );
    expect(canFastForwardPrompt(normal, "read_only", dialogue(true))).toBe(
      true,
    );
    expect(canFastForwardPrompt(normal, "all", dialogue(false))).toBe(true);
  });

  it("stops at choices and honors script blocking immediately", () => {
    expect(
      canFastForwardPrompt(normal, "all", {
        kind: "choice",
        prompt_id: "scene/choice",
        choices: [],
      }),
    ).toBe(false);
    expect(
      canFastForwardPrompt(
        { ...normal, auto: "forced" },
        "all",
        dialogue(true),
      ),
    ).toBe(false);
    expect(
      canFastForwardPrompt({ ...normal, ctrl_fast_forward: "block" }, "all", {
        kind: "none",
      }),
    ).toBe(false);
    expect(canFastForwardPrompt(normal, "read_only", { kind: "none" })).toBe(
      true,
    );
  });
});
