// @vitest-environment jsdom
/**
 * Authoring forms of the two-window nodes: Scene pickers list real Scene ids
 * filtered by purpose, window controls reshape their fields per action, and a
 * timer can only be pointed at an effect that is legal to run on its own.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContentManifest, SceneDefinition, SceneNode } from "../types";
import { NodeInspector } from "./NodeInspector";

afterEach(cleanup);

const MANIFEST: ContentManifest = {
  schema_version: 2,
  content_version: "test",
  entry_scene: "main",
  default_locale: "zh-CN",
  variables: { score: { scope: "save", type: "integer", default: 0 } },
  characters: {},
  assets: {},
  // File names deliberately differ from the Scene ids they contain.
  scenes: ["scenes/main.yaml", "scenes/file_a.yaml", "scenes/file_b.yaml"],
  ui_motions: [],
  ui_motion_defaults: {},
};

const say = (next: string): SceneNode => ({
  type: "say",
  speaker: null,
  text: "你好",
  speed_cps: null,
  next,
});

const SCENES: SceneDefinition[] = [
  {
    schema_version: 2,
    id: "main",
    entry: "a",
    nodes: {
      a: say("b"),
      b: { type: "end" },
      sfx_node: { type: "sfx", asset: "", volume: 1, next: "b" },
      title_node: {
        type: "window_title",
        target: "main",
        title: "t",
        next: "b",
      },
      awaited: {
        type: "action",
        sprite_id: "x",
        action: "y",
        await: true,
        next: "b",
      },
      free_action: {
        type: "action",
        sprite_id: "x",
        action: "y",
        await: false,
        next: "b",
      },
    },
  },
  {
    window_role: "secondary",
    schema_version: 2,
    id: "side_scene",
    entry: "s",
    nodes: { s: { type: "end" } },
  },
  {
    schema_version: 2,
    id: "other_main",
    entry: "s",
    nodes: { s: { type: "end" } },
  },
];

function renderNode(node: SceneNode, onChange = vi.fn()) {
  const scene: SceneDefinition = {
    ...SCENES[0],
    nodes: { ...SCENES[0].nodes, subject: node },
  };
  render(
    <NodeInspector
      assets={[]}
      buttons={[]}
      manifest={MANIFEST}
      nodeId="subject"
      onChange={onChange}
      onConvertToTimeline={() => undefined}
      onDelete={() => undefined}
      onDuplicate={() => undefined}
      onOpenLongTextWorkspace={() => undefined}
      onRename={() => undefined}
      onSetEntry={() => undefined}
      onSplitDialogue={() => undefined}
      onSplitLongText={() => undefined}
      scene={scene}
      scenes={[scene, SCENES[1], SCENES[2]]}
      uiMotions={[]}
    />,
  );
  return onChange;
}

const optionTexts = (select: HTMLElement): string[] =>
  Array.from(select.querySelectorAll("option")).map(
    (option) => option.textContent ?? "",
  );

describe("open_window and jump scene pickers", () => {
  it("offers only secondary Scenes, by their real id, for open_window", () => {
    renderNode({ type: "open_window", scene: "", next: "b" });
    const select = screen.getByLabelText(/副窗口场景/);
    expect(optionTexts(select)).toEqual(["请选择场景", "side_scene"]);
  });

  it("keeps a stale reference visible and flags the wrong purpose", () => {
    renderNode({ type: "open_window", scene: "other_main", next: "b" });
    const select = screen.getByLabelText(/副窗口场景/);
    expect(optionTexts(select)[1]).toContain("用途不符");
  });

  it("limits a jump to Scenes written for the same window", () => {
    renderNode({ type: "jump", scene: null, target: "b" });
    const select = screen.getByLabelText(/目标场景/);
    expect(optionTexts(select)).toEqual(["当前场景", "main", "other_main"]);
    expect(optionTexts(select)).not.toContain("side_scene");
  });
});

describe("window_control form", () => {
  it("drops the block id and hint for a script advance", () => {
    const onChange = renderNode({
      type: "window_control",
      target: "secondary",
      action: "block",
      id: "gate",
      message: "等一下",
      next: "b",
    });
    expect(screen.getByLabelText("阻挡 ID")).toBeInTheDocument();
    expect(screen.getByLabelText(/提示文本/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("操作"), {
      target: { value: "advance" },
    });
    expect(onChange).toHaveBeenCalledWith(
      "subject",
      expect.objectContaining({ action: "advance", id: "", message: "" }),
    );
  });

  it("explains that advance never unblocks or picks a choice", () => {
    renderNode({
      type: "window_control",
      target: "main",
      action: "advance",
      id: "",
      next: "b",
    });
    expect(screen.getByText(/不会替玩家选择选项/)).toBeInTheDocument();
    expect(screen.queryByLabelText("阻挡 ID")).toBeNull();
  });
});

describe("timer form", () => {
  it("lists only effect nodes that are legal timer targets", () => {
    renderNode({
      type: "timer",
      id: "pulse",
      action: "start",
      delay_ms: 500,
      interval_ms: null,
      target: null,
      next: "b",
    });
    const select = screen.getByLabelText("触发时运行的效果节点");
    const ids = optionTexts(select).map((text) => text.split(" · ")[0]);
    expect(ids).toEqual(
      expect.arrayContaining([
        "— 缺少目标 —",
        "free_action",
        "sfx_node",
        "title_node",
      ]),
    );
    expect(ids).not.toContain("awaited");
    expect(ids).not.toContain("a");
    expect(ids).not.toContain("b");
  });

  it("states the stop/exit lifecycle and the minimum interval", () => {
    renderNode({
      type: "timer",
      id: "pulse",
      action: "start",
      delay_ms: 0,
      interval_ms: 1000,
      target: "free_action",
      next: "b",
    });
    expect(screen.getByText(/显式停止|「停止」节点停止/)).toBeInTheDocument();
    expect(screen.getByText(/场景退出/)).toBeInTheDocument();
    expect(screen.getByLabelText("重复间隔 ms")).toHaveAttribute("min", "50");
  });

  it("clears delay, interval and target when switched to stop", () => {
    const onChange = renderNode({
      type: "timer",
      id: "pulse",
      action: "start",
      delay_ms: 500,
      interval_ms: 1000,
      target: "free_action",
      next: "b",
    });
    fireEvent.change(screen.getByLabelText("操作"), {
      target: { value: "stop" },
    });
    expect(onChange).toHaveBeenCalledWith(
      "subject",
      expect.objectContaining({
        action: "stop",
        delay_ms: 0,
        interval_ms: null,
        target: null,
      }),
    );
  });
});

describe("window title variables in operands", () => {
  it("are offered, read-only, to a condition operand", () => {
    renderNode({
      type: "condition",
      condition: {
        op: "eq",
        left: { variable: "window.main.title" },
        right: { value: "x" },
      },
      then: "b",
      otherwise: "b",
    });
    const select = screen.getByDisplayValue(/window\.main\.title/);
    const labels = optionTexts(select);
    expect(labels.some((text) => text.includes("只读"))).toBe(true);
    expect(labels.some((text) => text.startsWith("score"))).toBe(true);
  });
});
