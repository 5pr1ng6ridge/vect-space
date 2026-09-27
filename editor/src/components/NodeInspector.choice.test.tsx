// @vitest-environment jsdom
/**
 * Choice inspector authoring tests: enabling presentation must seed the
 * legacy panel centre (no jump), and the option template/icon fields must
 * write canonical values.
 */
import type { ReactElement } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChoicePrompt } from "@vectspace/presentation-core/types";
import type {
  ButtonFile,
  ChoiceNode,
  ContentManifest,
  SceneDefinition,
  SceneNode,
} from "../types";
import { ChoicePresentationFields } from "./ChoicePresentationFields";
import { NodeInspector } from "./NodeInspector";

afterEach(cleanup);

const MANIFEST: ContentManifest = {
  schema_version: 2,
  content_version: "test",
  entry_scene: "main",
  default_locale: "zh-CN",
  variables: {},
  characters: {},
  assets: {
    "gui.icon": { kind: "gui", path: "gui/icon.png" },
    "bg.a": { kind: "background", path: "backgrounds/a.png" },
  },
  scenes: ["scenes/main.yaml"],
  ui_motions: [],
  ui_motion_defaults: {},
};

const BUTTONS: ButtonFile[] = [
  {
    path: "ui/buttons/choice_primary.yaml",
    definition: {
      schema_version: 1,
      id: "choice.primary",
      width: 320,
      height: 88,
      asset_mode: "separate",
      fit: "stretch",
      normal: "gui.icon",
      hover: null,
      pressed: null,
      animations: {},
    },
  },
];

function choiceNode(): ChoiceNode {
  return {
    type: "choice",
    choices: [
      { id: "left", label: "左", next: "end" },
      { id: "right", label: "右", next: "end" },
    ],
  };
}

function sceneWith(node: SceneNode): SceneDefinition {
  return {
    schema_version: 2,
    id: "main",
    entry: "route",
    nodes: {
      route: node,
      end: { type: "end" },
    },
  };
}

function renderChoice(node: SceneNode, onChange = vi.fn()): ReactElement {
  const view = render(
    <NodeInspector
      assets={[]}
      buttons={BUTTONS}
      manifest={MANIFEST}
      nodeId="route"
      onChange={onChange}
      onConvertToTimeline={() => undefined}
      onDelete={() => undefined}
      onDuplicate={() => undefined}
      onOpenLongTextWorkspace={() => undefined}
      onRename={() => undefined}
      onSetEntry={() => undefined}
      onSplitDialogue={() => undefined}
      onSplitLongText={() => undefined}
      scene={sceneWith(node)}
      uiMotions={[]}
    />,
  );
  return view.container as unknown as ReactElement;
}

describe("choice inspector presentation fields", () => {
  it("seeds the legacy panel centre when presentation is first enabled", () => {
    const onChange = vi.fn();
    renderChoice(choiceNode(), onChange);
    const toggle = screen.getByLabelText(/使用自定义选项布局/);
    expect(toggle).not.toBeChecked();
    expect(screen.queryByLabelText("锚点 X（0–1920）")).toBeNull();

    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][1] as ChoiceNode;
    // Two fallback buttons (980x92, gap 20) keep the shipped CSS panel origin
    // at (470, 360), so the seeded centre is (960, 462).
    expect(next.presentation).toEqual({
      template: null,
      anchor_x: 960,
      anchor_y: 462,
      direction: "vertical",
      gap: 20,
      button_width: null,
      button_height: null,
    });
  });

  it("uses the available Rust-filtered prompt layout when first enabling", () => {
    const onChange = vi.fn<(next: ChoiceNode) => void>();
    const prompt: ChoicePrompt = {
      kind: "choice",
      prompt_id: "main/route",
      layout: {
        stage_width: 1920,
        stage_height: 1080,
        anchor_x: 814,
        anchor_y: 404,
        direction: "horizontal",
        gap: 12,
        x: 500,
        y: 360,
        width: 628,
        height: 88,
      },
      diagnostics: [],
      // Rust has already filtered the source options; React does not inspect
      // visible_if/enabled_if to construct this snapshot.
      choices: [],
    };
    render(
      <ChoicePresentationFields
        buttons={BUTTONS}
        node={choiceNode()}
        onChange={onChange}
        previewPrompt={prompt}
      />,
    );
    fireEvent.click(screen.getByLabelText(/使用自定义选项布局/));
    expect(onChange.mock.calls[0]?.[0].presentation).toMatchObject({
      anchor_x: 814,
      anchor_y: 404,
      direction: "horizontal",
      gap: 12,
    });
  });

  it("edits anchors, direction and optional sizes canonically", () => {
    const onChange = vi.fn();
    const node = choiceNode();
    node.presentation = {
      template: null,
      anchor_x: 960,
      anchor_y: 462,
      direction: "vertical",
      gap: 20,
      button_width: null,
      button_height: null,
    };
    renderChoice(node, onChange);

    const anchorX = screen.getByLabelText("锚点 X（0–1920）");
    fireEvent.change(anchorX, { target: { value: "480" } });
    fireEvent.blur(anchorX);
    let next = onChange.mock.calls.at(-1)?.[1] as ChoiceNode;
    expect(next.presentation?.anchor_x).toBe(480);

    fireEvent.change(screen.getByLabelText("排列方向"), {
      target: { value: "horizontal" },
    });
    next = onChange.mock.calls.at(-1)?.[1] as ChoiceNode;
    expect(next.presentation?.direction).toBe("horizontal");

    fireEvent.click(screen.getByLabelText(/覆盖模板宽度/));
    next = onChange.mock.calls.at(-1)?.[1] as ChoiceNode;
    expect(next.presentation?.button_width).toBe(320);
  });

  it("re-seeds anchors while keeping authored skins and sizes", () => {
    const onChange = vi.fn();
    const node = choiceNode();
    node.presentation = {
      template: "choice.primary",
      anchor_x: 10,
      anchor_y: 20,
      direction: "horizontal",
      gap: 8,
      button_width: 320,
      button_height: null,
    };
    renderChoice(node, onChange);
    fireEvent.click(screen.getByText("重新对齐到旧版面板中心"));
    const next = onChange.mock.calls.at(-1)?.[1] as ChoiceNode;
    expect(next.presentation).toEqual({
      template: "choice.primary",
      // Horizontal input uses the authored 8px gap on the x axis: two
      // 320px items occupy 648px from x=470 and are 88px tall.
      anchor_x: 794,
      anchor_y: 404,
      direction: "horizontal",
      gap: 8,
      button_width: 320,
      button_height: null,
    });
  });

  it("writes per-option template and gui icon references", () => {
    const onChange = vi.fn();
    renderChoice(choiceNode(), onChange);
    const templateSelects = screen.getAllByLabelText("按钮模板");
    fireEvent.change(templateSelects[0], {
      target: { value: "choice.primary" },
    });
    let next = onChange.mock.calls.at(-1)?.[1] as ChoiceNode;
    expect(next.choices[0].template).toBe("choice.primary");

    const iconChoosers = screen.getAllByRole("button", { name: "图标（gui）" });
    fireEvent.click(iconChoosers[1]);
    fireEvent.click(screen.getByRole("option", { name: /gui\.icon/ }));
    next = onChange.mock.calls.at(-1)?.[1] as ChoiceNode;
    expect(next.choices[1].icon).toBe("gui.icon");
  });
});
