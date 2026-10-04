// @vitest-environment jsdom
/**
 * Authoring forms of the two-window nodes: Scene pickers list real Scene ids
 * filtered by purpose, window controls reshape their fields per action, and a
 * timer can only be pointed at an effect that is legal to run on its own.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ContentManifest,
  SceneDefinition,
  SceneNode,
  WindowGeometryNode,
} from "../types";
import { defaultNode } from "../story";
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
      move_free: defaultNode("window_geometry", "b"),
      move_wait: {
        ...(defaultNode("window_geometry", "b") as WindowGeometryNode),
        await: true,
      },
      layer_node: defaultNode("window_layer", "b"),
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

describe("window_geometry form", () => {
  const geometry = (patch: Record<string, unknown> = {}): SceneNode =>
    ({
      ...(defaultNode("window_geometry", "b") as object),
      ...patch,
    }) as unknown as SceneNode;

  const lastNode = (onChange: ReturnType<typeof vi.fn>): SceneNode =>
    onChange.mock.calls[onChange.mock.calls.length - 1][1] as SceneNode;

  const number = (label: string, value: string): void => {
    const input = screen.getByLabelText(label);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  };

  it("shows the docking default as a preset with its numbers filled in", () => {
    renderNode(geometry());
    expect(screen.getByLabelText("目标窗口")).toHaveValue("secondary");
    expect(screen.getByLabelText("改变位置")).toBeChecked();
    expect(screen.getByLabelText("位置预设")).toHaveValue("dock_right");
    expect(screen.getByLabelText("参考对象")).toHaveValue("window");
    expect(screen.getByLabelText("参考点 X")).toHaveValue(1);
    expect(screen.getByLabelText("参考点 Y")).toHaveValue(0.5);
    expect(screen.getByLabelText("窗口锚点 X")).toHaveValue(0);
    expect(screen.getByLabelText("窗口锚点 Y")).toHaveValue(0.5);
    expect(screen.getByLabelText("偏移 X px")).toHaveValue(16);
    expect(screen.getByLabelText("偏移 Y px")).toHaveValue(0);
    expect(screen.getByLabelText("改变大小")).not.toBeChecked();
    expect(screen.getByLabelText("时长 ms")).toHaveValue(600);
    expect(screen.getByLabelText("缓动")).toHaveValue("ease_in_out");
    expect(screen.getByLabelText("等待完成")).not.toBeChecked();
  });

  it("groups the presets and ends with a custom entry", () => {
    renderNode(geometry());
    const select = screen.getByLabelText("位置预设");
    expect(
      Array.from(select.querySelectorAll("optgroup")).map((group) =>
        group.getAttribute("label"),
      ),
    ).toEqual(["屏幕（工作区）", "另一个游戏窗口", "自身"]);
    expect(optionTexts(select)).toEqual([
      "屏幕居中",
      "屏幕左上角",
      "屏幕右上角",
      "屏幕左下角",
      "屏幕右下角",
      "屏幕上边缘居中",
      "屏幕下边缘居中",
      "屏幕左边缘居中",
      "屏幕右边缘居中",
      "贴在另一窗口右侧",
      "贴在另一窗口左侧",
      "贴在另一窗口上方",
      "贴在另一窗口下方",
      "相对当前位置偏移",
      "自定义",
    ]);
  });

  it("a preset only fills the placement fields", () => {
    const onChange = renderNode(
      geometry({ size: { width: 960, height: 540 }, duration_ms: 250 }),
    );
    fireEvent.change(screen.getByLabelText("位置预设"), {
      target: { value: "screen_bottom_right" },
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastNode(onChange)).toMatchObject({
      type: "window_geometry",
      position: {
        relative_to: "work_area",
        x: 1,
        y: 1,
        anchor_x: 1,
        anchor_y: 1,
        offset_x: 0,
        offset_y: 0,
      },
      size: { width: 960, height: 540 },
      duration_ms: 250,
      next: "b",
    });
  });

  it("choosing the custom entry changes nothing", () => {
    const onChange = renderNode(geometry());
    fireEvent.change(screen.getByLabelText("位置预设"), {
      target: { value: "custom" },
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("calls a hand-edited placement custom and keeps it editable", () => {
    const onChange = renderNode(
      geometry({
        target: "main",
        position: {
          relative_to: "work_area",
          x: 0.27,
          y: 0.5,
          anchor_x: 0.5,
          anchor_y: 0.5,
        },
      }),
    );
    expect(screen.getByLabelText("位置预设")).toHaveValue("custom");
    number("参考点 X", "0.3");
    expect(lastNode(onChange)).toMatchObject({
      position: { x: 0.3, y: 0.5, anchor_x: 0.5, anchor_y: 0.5 },
    });
  });

  it("fine-tunes a preset field by field, anchor and offset included", () => {
    const onChange = renderNode(geometry());
    number("偏移 X px", "40");
    expect(lastNode(onChange)).toMatchObject({
      position: { relative_to: "window", x: 1, anchor_x: 0, offset_x: 40 },
    });
    number("窗口锚点 Y", "0");
    expect(lastNode(onChange)).toMatchObject({
      position: { anchor_y: 0, offset_x: 16 },
    });
    fireEvent.change(screen.getByLabelText("参考对象"), {
      target: { value: "current" },
    });
    expect(lastNode(onChange)).toMatchObject({
      position: { relative_to: "current", x: 1 },
    });
  });

  it("starts the position of the main window at the screen centre", () => {
    const onChange = renderNode(
      geometry({
        target: "main",
        position: null,
        size: { width: 960, height: 540 },
      }),
    );
    expect(screen.queryByLabelText("位置预设")).toBeNull();
    fireEvent.click(screen.getByLabelText("改变位置"));
    expect(lastNode(onChange)).toMatchObject({
      position: { relative_to: "work_area", x: 0.5, y: 0.5 },
    });
  });

  it("starts the position of the secondary window docked to the main one", () => {
    const onChange = renderNode(
      geometry({ position: null, size: { width: 960, height: 540 } }),
    );
    fireEvent.click(screen.getByLabelText("改变位置"));
    expect(lastNode(onChange)).toMatchObject({
      position: { relative_to: "window", x: 1, anchor_x: 0, offset_x: 16 },
    });
  });

  it("turns the position off and warns when nothing would change", () => {
    const onChange = renderNode(geometry());
    expect(screen.queryByText(/至少要改变一项/)).toBeNull();
    fireEvent.click(screen.getByLabelText("改变位置"));
    expect(lastNode(onChange)).toMatchObject({ position: null });
    cleanup();
    renderNode(geometry({ position: null, size: null }));
    expect(screen.getByText(/至少要改变一项/)).toBeInTheDocument();
  });

  it("enables a logical size and resets to the new unit's default when switched", () => {
    const onChange = renderNode(geometry());
    expect(screen.queryByLabelText("宽度")).toBeNull();
    fireEvent.click(screen.getByLabelText("改变大小"));
    expect(lastNode(onChange)).toMatchObject({
      size: { unit: "logical", width: 960, height: 540 },
    });
    cleanup();
    const switched = renderNode(
      geometry({ size: { unit: "logical", width: 1280, height: 720 } }),
    );
    expect(screen.getByLabelText("大小单位")).toHaveValue("logical");
    fireEvent.change(screen.getByLabelText("大小单位"), {
      target: { value: "work_area" },
    });
    expect(lastNode(switched)).toMatchObject({
      size: { unit: "work_area", width: 0.5, height: 0.5 },
    });
  });

  it("edits width and height in the chosen unit", () => {
    const onChange = renderNode(
      geometry({ size: { unit: "work_area", width: 0.5, height: 0.5 } }),
    );
    expect(screen.getByLabelText("宽度")).toHaveAttribute("max", "1");
    number("宽度", "0.8");
    expect(lastNode(onChange)).toMatchObject({
      size: { unit: "work_area", width: 0.8, height: 0.5 },
    });
  });

  it("warns about a logical size under the target's minimum", () => {
    renderNode(geometry({ target: "main", size: { width: 800, height: 600 } }));
    expect(
      screen.getByText(/小于主窗口的最小尺寸 960×540/),
    ).toBeInTheDocument();
    cleanup();
    renderNode(geometry({ size: { width: 800, height: 600 } }));
    expect(screen.queryByText(/最小尺寸/)).toBeNull();
    cleanup();
    renderNode(geometry({ size: { width: 400, height: 600 } }));
    expect(
      screen.getByText(/小于副窗口的最小尺寸 480×270/),
    ).toBeInTheDocument();
  });

  it("edits duration, easing and waiting", () => {
    const onChange = renderNode(geometry());
    number("时长 ms", "0");
    expect(lastNode(onChange)).toMatchObject({ duration_ms: 0 });
    fireEvent.change(screen.getByLabelText("缓动"), {
      target: { value: "linear" },
    });
    expect(lastNode(onChange)).toMatchObject({ easing: "linear" });
    fireEvent.click(screen.getByLabelText("等待完成"));
    expect(lastNode(onChange)).toMatchObject({ await: true });
    expect(optionTexts(screen.getByLabelText("缓动"))).toEqual([
      "线性",
      "缓入",
      "缓出",
      "缓入缓出",
    ]);
  });

  it("retargets the window without touching the rest", () => {
    const onChange = renderNode(geometry());
    fireEvent.change(screen.getByLabelText("目标窗口"), {
      target: { value: "main" },
    });
    expect(lastNode(onChange)).toMatchObject({
      target: "main",
      position: { relative_to: "window", x: 1 },
      duration_ms: 600,
    });
  });

  it("explains skipping, restoring, minimum sizes and the preview limit", () => {
    renderNode(geometry());
    const notes = Array.from(document.querySelectorAll(".field-note"))
      .map((note) => note.textContent ?? "")
      .join("\n");
    expect(notes).toMatch(/全屏或最大化的窗口会跳过移动和缩放/);
    expect(notes).toMatch(/主窗口最小\s*960×540/);
    expect(notes).toMatch(/副窗口最小\s*480×270/);
    expect(notes).toMatch(/回到标题或退出重演时主窗口会自动复原/);
    expect(notes).toMatch(/存档不记录窗口位置和大小/);
    expect(notes).toMatch(/预览不会移动真实窗口/);
    expect(notes).toMatch(/「另一个游戏窗口」指主窗口/);
  });

  it("names the other window from the target's side", () => {
    renderNode(geometry({ target: "main" }));
    expect(
      Array.from(document.querySelectorAll(".field-note"))
        .map((note) => note.textContent ?? "")
        .join("\n"),
    ).toMatch(/「另一个游戏窗口」指副窗口/);
  });

  it("keeps the next node picker", () => {
    const onChange = renderNode(geometry());
    fireEvent.change(screen.getByLabelText("下一节点"), {
      target: { value: "a" },
    });
    expect(lastNode(onChange)).toMatchObject({ next: "a" });
  });
});

describe("window_layer form", () => {
  const layer = (action = "raise"): SceneNode =>
    ({
      type: "window_layer",
      target: "main",
      action,
      next: "b",
    }) as SceneNode;

  it("lists the five actions with their focus behaviour spelled out", () => {
    renderNode(layer());
    expect(optionTexts(screen.getByLabelText("层级操作"))).toEqual([
      "提到最前（不抢焦点）",
      "聚焦（抢焦点）",
      "置顶（始终在其他窗口上方）",
      "置底（始终在其他窗口下方）",
      "恢复普通层级",
    ]);
    expect(screen.getByLabelText("层级操作")).toHaveValue("raise");
    expect(screen.getByLabelText("目标窗口")).toHaveValue("main");
  });

  it("writes the chosen action and target", () => {
    const onChange = renderNode(layer());
    fireEvent.change(screen.getByLabelText("层级操作"), {
      target: { value: "top" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      "subject",
      expect.objectContaining({ type: "window_layer", action: "top" }),
    );
    fireEvent.change(screen.getByLabelText("目标窗口"), {
      target: { value: "secondary" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      "subject",
      expect.objectContaining({ target: "secondary" }),
    );
  });

  it("explains focus stealing and the preview limit", () => {
    renderNode(layer());
    const note = document.querySelector(".field-note")?.textContent ?? "";
    expect(note).toMatch(/不抢键盘焦点/);
    expect(note).toMatch(/抢走键盘焦点/);
    expect(note).toMatch(/恢复普通层级/);
    expect(note).toMatch(/预览不会改变真实窗口层级/);
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
        "layer_node",
        "move_free",
        "sfx_node",
        "title_node",
      ]),
    );
    expect(ids).not.toContain("awaited");
    expect(ids).not.toContain("move_wait");
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
