import { describe, expect, it } from "vitest";

import type {
  DialoguePrompt,
  LongTextPrompt,
  PlaybackSnapshot,
} from "@vectspace/presentation-core/types";
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
const longText = (is_read: boolean): LongTextPrompt => ({
  kind: "long_text",
  prompt_id: "scene/lecture/definition",
  document_id: "scene/lecture",
  step_id: "definition",
  step_index: 0,
  text: "definition",
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
        layout: {
          stage_width: 1920,
          stage_height: 1080,
          anchor_x: 960,
          anchor_y: 540,
          direction: "vertical",
          gap: 20,
          x: 960,
          y: 540,
          width: 0,
          height: 0,
        },
        diagnostics: [],
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

  it("applies the same read policy to every long-text step", () => {
    expect(canFastForwardPrompt(normal, "read_only", longText(false))).toBe(
      false,
    );
    expect(canFastForwardPrompt(normal, "read_only", longText(true))).toBe(
      true,
    );
    expect(canFastForwardPrompt(normal, "all", longText(false))).toBe(true);
  });
});
