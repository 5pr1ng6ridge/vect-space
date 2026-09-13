import { describe, expect, it } from "vitest";

import {
  CHOICE_DEFAULT_GAP,
  CHOICE_FALLBACK_BUTTON_HEIGHT,
  CHOICE_FALLBACK_BUTTON_WIDTH,
  CHOICE_FALLBACK_PANEL_X,
  CHOICE_FALLBACK_PANEL_Y,
  layoutChoiceItems,
} from "@vectspace/presentation-core/choice-layout";

import {
  defaultChoicePresentation,
  emptyChoicePresentation,
  legacyChoicePresentationAnchor,
  reseedChoicePresentationAnchor,
  resolveChoiceOptionSize,
  resolveChoiceOptionSizes,
} from "./choicePresentation";
import type { ChoicePrompt } from "@vectspace/presentation-core/types";
import type { ButtonFile, ChoiceNode } from "./types";

function button(id: string, width: number, height: number): ButtonFile {
  return {
    path: `ui/buttons/${id}.yaml`,
    definition: {
      schema_version: 1,
      id,
      width,
      height,
      asset_mode: "separate",
      fit: "stretch",
      normal: null,
      hover: null,
      pressed: null,
      animations: {},
    },
  };
}

function choiceNode(
  overrides: Partial<ChoiceNode> = {},
  optionCount = 2,
): ChoiceNode {
  return {
    type: "choice",
    choices: Array.from({ length: optionCount }, (_value, index) => ({
      id: `option_${index}`,
      label: `选项 ${index}`,
      next: "",
    })),
    ...overrides,
  };
}

const buttons = [
  button("choice.primary", 320, 88),
  button("choice.wide", 500, 120),
];

describe("choice presentation authoring helpers", () => {
  it("seeds the legacy panel centre so enabling presentation does not jump", () => {
    const node = choiceNode();
    const presentation = defaultChoicePresentation(node, buttons);
    // Two legacy fallback buttons (980x92 + gap 20) start at (470, 360), so
    // the equivalent centre is (470 + 490, 360 + 102).
    expect(presentation).toEqual({
      template: null,
      anchor_x: 960,
      anchor_y: 462,
      direction: "vertical",
      gap: CHOICE_DEFAULT_GAP,
      button_width: null,
      button_height: null,
    });

    const sizes = resolveChoiceOptionSizes(node, buttons);
    const seeded = legacyChoicePresentationAnchor(node, buttons);
    expect(seeded).toEqual({ anchor_x: 960, anchor_y: 462 });
    const result = layoutChoiceItems(sizes, {
      direction: "vertical",
      anchor_x: seeded.anchor_x,
      anchor_y: seeded.anchor_y,
      gap: CHOICE_DEFAULT_GAP,
    });
    expect(result).toEqual({
      x: CHOICE_FALLBACK_PANEL_X,
      y: CHOICE_FALLBACK_PANEL_Y,
      width: CHOICE_FALLBACK_BUTTON_WIDTH,
      height: 204,
      items: [
        {
          x: CHOICE_FALLBACK_PANEL_X,
          y: CHOICE_FALLBACK_PANEL_Y,
          width: CHOICE_FALLBACK_BUTTON_WIDTH,
          height: CHOICE_FALLBACK_BUTTON_HEIGHT,
        },
        {
          x: CHOICE_FALLBACK_PANEL_X,
          y: CHOICE_FALLBACK_PANEL_Y + 112,
          width: CHOICE_FALLBACK_BUTTON_WIDTH,
          height: CHOICE_FALLBACK_BUTTON_HEIGHT,
        },
      ],
    });
  });

  it("seeds from the option template sizes the runtime would resolve", () => {
    const node = choiceNode();
    node.choices[0].template = "choice.primary";
    node.choices[1].template = "choice.wide";
    const anchor = legacyChoicePresentationAnchor(node, buttons);
    // Widest item is 500, main extent is 88 + 20 + 120.
    expect(anchor).toEqual({ anchor_x: 470 + 250, anchor_y: 360 + 114 });
    const result = layoutChoiceItems(resolveChoiceOptionSizes(node, buttons), {
      direction: "vertical",
      anchor_x: anchor.anchor_x,
      anchor_y: anchor.anchor_y,
      gap: CHOICE_DEFAULT_GAP,
    });
    expect(result.x).toBe(CHOICE_FALLBACK_PANEL_X);
    expect(result.y).toBe(CHOICE_FALLBACK_PANEL_Y);
  });

  it("resolves sizes with the runtime priority", () => {
    const node = choiceNode({
      presentation: {
        ...emptyChoicePresentation(),
        template: "choice.primary",
        button_width: 400,
      },
    });
    expect(
      resolveChoiceOptionSize(node.choices[0], node.presentation, buttons),
    ).toEqual({
      width: 400,
      height: 88,
    });
    node.choices[0].template = "choice.wide";
    // Option template wins over the node template, but the node-wide width
    // override still wins over both.
    expect(
      resolveChoiceOptionSize(node.choices[0], node.presentation, buttons),
    ).toEqual({
      width: 400,
      height: 120,
    });
    expect(
      resolveChoiceOptionSize(
        { id: "x", label: "x", next: "", template: "missing.template" },
        { ...emptyChoicePresentation(), template: "choice.primary" },
        buttons,
      ),
    ).toEqual({ width: 320, height: 88 });
    expect(
      resolveChoiceOptionSize({ id: "x", label: "x", next: "" }, null, buttons),
    ).toEqual({
      width: CHOICE_FALLBACK_BUTTON_WIDTH,
      height: CHOICE_FALLBACK_BUTTON_HEIGHT,
    });
  });

  it("re-seeds anchors without losing authored skins or sizes", () => {
    const node = choiceNode({
      presentation: {
        template: "choice.primary",
        anchor_x: 10,
        anchor_y: 20,
        direction: "horizontal",
        gap: 8,
        button_width: 400,
        button_height: null,
      },
    });
    const reseeded = reseedChoicePresentationAnchor(node, buttons);
    expect(reseeded.template).toBe("choice.primary");
    expect(reseeded.direction).toBe("horizontal");
    expect(reseeded.gap).toBe(8);
    expect(reseeded.button_width).toBe(400);
    // Horizontal input puts the main-axis extent on x and keeps the authored
    // 8px gap: the two 400px items occupy 808px from x=470.
    expect(reseeded.anchor_x).toBe(470 + (400 + 8 + 400) / 2);
    expect(reseeded.anchor_y).toBe(360 + 88 / 2);
  });

  it("re-seeds horizontal placement from filtered Rust preview choices", () => {
    const node = choiceNode(
      {
        presentation: {
          ...emptyChoicePresentation(),
          direction: "horizontal",
          gap: 8,
        },
      },
      3,
    );
    node.choices[0].template = "choice.primary";
    node.choices[1].template = "choice.wide";
    node.choices[2].template = "choice.primary";
    const preview = filteredChoicePrompt("horizontal", 8, [
      { width: 320, height: 88 },
      { width: 320, height: 88 },
    ]);

    const reseeded = reseedChoicePresentationAnchor(node, buttons, preview);
    // The hidden 500x120 option is absent from the Rust-resolved prompt, so
    // it contributes neither horizontal extent nor cross-axis height.
    expect(reseeded.anchor_x).toBe(470 + (320 + 8 + 320) / 2);
    expect(reseeded.anchor_y).toBe(360 + 88 / 2);
  });

  it("re-seeds vertical placement from filtered Rust preview choices", () => {
    const node = choiceNode(
      {
        presentation: {
          ...emptyChoicePresentation(),
          direction: "vertical",
          gap: 8,
        },
      },
      3,
    );
    node.choices[0].template = "choice.primary";
    node.choices[1].template = "choice.wide";
    node.choices[2].template = "choice.primary";
    const preview = filteredChoicePrompt("vertical", 8, [
      { width: 320, height: 88 },
      { width: 320, height: 88 },
    ]);

    const reseeded = reseedChoicePresentationAnchor(node, buttons, preview);
    expect(reseeded.anchor_x).toBe(470 + 320 / 2);
    expect(reseeded.anchor_y).toBe(360 + (88 + 8 + 88) / 2);
  });

  it("uses a Rust-filtered prompt layout when first enabling presentation", () => {
    const node = choiceNode({ choices: [choiceNode().choices[0]] });
    const preview = {
      kind: "choice" as const,
      prompt_id: "main/route",
      layout: {
        stage_width: 1920,
        stage_height: 1080,
        anchor_x: 812,
        anchor_y: 404,
        direction: "horizontal" as const,
        gap: 12,
        x: 500,
        y: 350,
        width: 624,
        height: 88,
      },
      diagnostics: [],
      choices: [],
    };
    expect(defaultChoicePresentation(node, buttons, preview)).toMatchObject({
      anchor_x: 812,
      anchor_y: 404,
      direction: "horizontal",
      gap: 12,
    });
  });

  it("returns a fresh empty presentation per call", () => {
    const first = emptyChoicePresentation();
    const second = emptyChoicePresentation();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(first.anchor_x).toBe(960);
    expect(first.anchor_y).toBe(540);
  });
});

function filteredChoicePrompt(
  direction: ChoicePrompt["layout"]["direction"],
  gap: number,
  sizes: { width: number; height: number }[],
): ChoicePrompt {
  return {
    kind: "choice",
    prompt_id: "main/filtered-choice",
    layout: {
      stage_width: 1920,
      stage_height: 1080,
      anchor_x: 960,
      anchor_y: 540,
      direction,
      gap,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    },
    diagnostics: [],
    choices: sizes.map((size, index) => ({
      id: `visible_${index}`,
      label: `visible_${index}`,
      enabled: true,
      icon: null,
      template: { kind: "fallback" as const },
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
    })),
  };
}
