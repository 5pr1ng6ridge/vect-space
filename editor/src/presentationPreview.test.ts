import { describe, expect, it } from "vitest";

import {
  buildBackgroundPreviewRequest,
  buildCurtainPreviewRequest,
  buildScreenEffectPreviewRequest,
  storyVisualStateAtNode,
} from "./presentationPreview";
import type {
  BackgroundNode,
  CurtainNode,
  SceneDefinition,
  SceneNode,
  ScreenEffectNode,
} from "./types";

function scene(
  nodes: Record<string, SceneNode>,
  entry = "start",
): SceneDefinition {
  return { schema_version: 2, id: "scene", entry, nodes };
}

const BACKGROUND_A: BackgroundNode = {
  type: "background",
  background: "bg.a",
  transition: { type: "cut" },
  duration_ms: 0,
  easing: "linear",
  await: false,
  next: "target",
};

const BACKGROUND_B: BackgroundNode = {
  type: "background",
  background: "bg.b",
  transition: {
    type: "wipe",
    direction: "right_to_left",
    softness: 0.25,
  },
  duration_ms: 700,
  easing: "ease_in_out",
  await: false,
  next: "after",
};

describe("storyVisualStateAtNode", () => {
  it("returns the background in effect on the first path into the node", () => {
    const definition = scene({
      start: BACKGROUND_A,
      target: BACKGROUND_B,
      after: { type: "end" },
    });
    expect(storyVisualStateAtNode(definition, "target")).toEqual({
      background: "bg.a",
      curtain: { covered: false, fill: null },
    });
  });

  it("follows the breadth-first order deterministically across branches", () => {
    const definition = scene({
      start: {
        type: "condition",
        condition: { op: "eq", left: { variable: "x" }, right: { value: 1 } },
        then: "left_bg",
        otherwise: "right_bg",
      },
      left_bg: {
        type: "background",
        background: "bg.left",
        transition: { type: "cut" },
        duration_ms: 0,
        easing: "linear",
        await: false,
        next: "target",
      },
      right_bg: {
        type: "background",
        background: "bg.right",
        transition: { type: "cut" },
        duration_ms: 0,
        easing: "linear",
        await: false,
        next: "target",
      },
      target: { type: "end" },
    });
    // `then` is the first port of a condition, so the first visit wins.
    expect(storyVisualStateAtNode(definition, "target").background).toBe(
      "bg.left",
    );
  });

  it("tracks the curtain cover a reveal node closes", () => {
    const definition = scene({
      start: {
        type: "curtain",
        action: "cover",
        fill: { asset: "gui.black" },
        transition: { type: "fade" },
        duration_ms: 500,
        easing: "ease_in_out",
        await: false,
        next: "target",
      },
      target: {
        type: "curtain",
        action: "reveal",
        transition: { type: "split_horizontal" },
        duration_ms: 500,
        easing: "ease_in_out",
        await: false,
        next: "after",
      },
      after: { type: "end" },
    });
    expect(storyVisualStateAtNode(definition, "target").curtain).toEqual({
      covered: true,
      fill: { asset: "gui.black" },
    });
  });

  it("returns an empty state for unreachable nodes", () => {
    const definition = scene({
      start: { type: "end" },
      orphan: BACKGROUND_A,
    });
    expect(storyVisualStateAtNode(definition, "orphan")).toEqual({
      background: null,
      curtain: { covered: false, fill: null },
    });
  });
});

describe("preview request builders", () => {
  const state = {
    background: "bg.before",
    curtain: { covered: false, fill: null },
  } as const;

  it("builds a background transition cue from the canonical node", () => {
    const request = buildBackgroundPreviewRequest(BACKGROUND_B, state);
    expect(request.world.background).toBe("bg.before");
    expect(request.world.curtain).toEqual({ covered: false, fill: null });
    expect(request.duration_ms).toBe(700);
    expect(request.cue).toEqual({
      cue_id: "preview",
      gate: "none",
      type: "background_transition",
      background: "bg.b",
      transition: {
        type: "wipe",
        direction: "right_to_left",
        softness: 0.25,
      },
      duration_ms: 700,
      easing: "ease_in_out",
    });
  });

  it("carries the cover fill and drops it from a reveal cue", () => {
    const cover: CurtainNode = {
      type: "curtain",
      action: "cover",
      fill: { color: "#112233" },
      transition: { type: "wipe", direction: "bottom_to_top" },
      duration_ms: 600,
      easing: "ease_out",
      await: false,
      next: "end",
    };
    const coverRequest = buildCurtainPreviewRequest(cover, state);
    expect(coverRequest.cue).toMatchObject({
      type: "curtain_transition",
      action: "cover",
      fill: { color: "#112233" },
      transition: { type: "wipe", direction: "bottom_to_top" },
      duration_ms: 600,
      easing: "ease_out",
    });

    const reveal: CurtainNode = {
      ...cover,
      action: "reveal",
      fill: null,
      transition: { type: "split_vertical" },
    };
    const revealRequest = buildCurtainPreviewRequest(reveal, {
      background: null,
      curtain: { covered: true, fill: { color: "#112233" } },
    });
    expect(revealRequest.world.curtain).toEqual({
      covered: true,
      fill: { color: "#112233" },
    });
    expect(revealRequest.cue).toMatchObject({
      type: "curtain_transition",
      action: "reveal",
      fill: null,
      transition: { type: "split_vertical" },
    });
  });

  it("keeps the canonical screen-effect spec untouched", () => {
    const node: ScreenEffectNode = {
      type: "screen_effect",
      effect: {
        type: "shake",
        amplitude_x: 24,
        amplitude_y: 12,
        frequency_hz: 22,
        decay: 0.75,
        seed: 42,
      },
      duration_ms: 200,
      await: true,
      next: "end",
    };
    const request = buildScreenEffectPreviewRequest(node, state);
    expect(request.cue).toEqual({
      cue_id: "preview",
      gate: "none",
      type: "screen_effect",
      effect: node.effect,
      duration_ms: 200,
    });
    expect(request.duration_ms).toBe(200);
  });
});
