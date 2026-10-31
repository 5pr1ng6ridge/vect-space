import { describe, expect, it } from "vitest";

import type {
  DialoguePrompt,
  PlaybackSnapshot,
  PromptSnapshot,
  RuntimeUpdate,
  SkipMode,
} from "@vectspace/presentation-core/types";
import { canFastForwardPrompt, fastForwardState } from "./playback";

const normal: PlaybackSnapshot = {
  auto: "normal",
  ctrl_fast_forward: "allow",
};
const dialogue = (is_read: boolean): PromptSnapshot => ({
  kind: "dialogue",
  prompt_id: "scene/line",
  speaker: null,
  text: "line",
  is_read,
});
const longText = (is_read: boolean): PromptSnapshot => ({
  kind: "long_text",
  prompt_id: "scene/lecture/definition",
  document_id: "scene/lecture",
  step_id: "definition",
  step_index: 0,
  text: "definition",
  is_read,
});
const choice: PromptSnapshot = {
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
};
const none: PromptSnapshot = { kind: "none" };

describe("Ctrl fast-forward policy", () => {
  it.each<[string, PlaybackSnapshot, SkipMode, PromptSnapshot, boolean]>([
    ["disabled mode", normal, "disabled", dialogue(true), false],
    [
      "read-only skips unread text",
      normal,
      "read_only",
      dialogue(false),
      false,
    ],
    ["read-only skips read text", normal, "read_only", dialogue(true), true],
    ["all mode skips unread text", normal, "all", dialogue(false), true],
    [
      "long text follows the same read policy",
      normal,
      "read_only",
      longText(false),
      false,
    ],
    ["long text, read", normal, "read_only", longText(true), true],
    ["stops at choices", normal, "all", choice, false],
    [
      "script block",
      { ...normal, ctrl_fast_forward: "block" },
      "all",
      none,
      false,
    ],
    [
      "forced auto",
      { ...normal, auto: "forced" },
      "all",
      dialogue(true),
      false,
    ],
    ["no prompt", normal, "read_only", none, true],
  ])("%s", (_name, playback, skipMode, prompt, expected) => {
    expect(canFastForwardPrompt(playback, skipMode, prompt)).toBe(expected);
  });
});

describe("fastForwardState", () => {
  const prompt = dialogue(true) as DialoguePrompt;
  const update = { snapshot: { prompt } } as RuntimeUpdate;
  const input = {
    ctrlHeld: true,
    enabled: true,
    playback: normal,
    skipMode: "read_only" as SkipMode,
    update,
    textPrompt: prompt,
    runtimeTimelineCue: undefined,
  };

  it("fast-forwards read text while Ctrl is held and the window is in play", () => {
    expect(fastForwardState(input)).toEqual({
      requested: true,
      dialogueAllowed: true,
      active: true,
    });
  });

  it("needs Ctrl, an enabled window and a policy that allows it", () => {
    expect(fastForwardState({ ...input, ctrlHeld: false }).requested).toBe(
      false,
    );
    expect(fastForwardState({ ...input, enabled: false }).active).toBe(false);
    expect(
      fastForwardState({
        ...input,
        playback: { ...normal, ctrl_fast_forward: "block" },
      }).requested,
    ).toBe(false);
  });

  it("does not skip an unseen runtime timeline in read-only mode", () => {
    expect(
      fastForwardState({ ...input, runtimeTimelineCue: { is_seen: false } })
        .active,
    ).toBe(false);
    expect(
      fastForwardState({ ...input, runtimeTimelineCue: { is_seen: true } })
        .active,
    ).toBe(true);
  });
});
