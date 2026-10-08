// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ContentManifest, SceneDefinition } from "../types";
import { ScriptView } from "./ScriptView";

const manifest: ContentManifest = {
  schema_version: 2,
  content_version: "test",
  entry_scene: "main",
  default_locale: "zh-CN",
  variables: {},
  characters: {},
  assets: {},
  scenes: ["scenes/main.yaml"],
  ui_motions: [],
  ui_motion_defaults: {},
};

const scene: SceneDefinition = {
  schema_version: 2,
  id: "main",
  entry: "choice",
  nodes: {
    choice: {
      type: "choice",
      choices: [
        { id: "left", label: "左分支", next: "left" },
        { id: "right", label: "右分支", next: "right" },
      ],
    },
    left: {
      type: "say",
      speaker: null,
      text: "左",
      speed_cps: null,
      next: "finish",
    },
    right: {
      type: "say",
      speaker: null,
      text: "右",
      speed_cps: null,
      next: "finish",
    },
    finish: { type: "end" },
  },
};

type ScriptViewProps = ComponentProps<typeof ScriptView>;

function scriptProps(
  overrides: Partial<ScriptViewProps> = {},
): ScriptViewProps {
  return {
    manifest,
    onChange: () => undefined,
    onDelete: () => undefined,
    onInsertAfter: () => undefined,
    onInsertBatch: () => undefined,
    onOpenGraph: () => undefined,
    onSelect: () => undefined,
    scene,
    selectedNodeId: null,
    ...overrides,
  };
}

function scriptRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>(".script-view");
  if (root === null) throw new Error("missing script view root");
  return root;
}

/** Renders the list with the graph-style selection already applied. */
function renderList(
  selectedNodeId: string | null,
  overrides: Partial<ScriptViewProps> = {},
) {
  const onDelete = vi.fn();
  const view = render(
    <ScriptView {...scriptProps({ onDelete, selectedNodeId, ...overrides })} />,
  );
  return { onDelete, root: scriptRoot(view.container), view };
}

describe("ScriptView long-text rows", () => {
  it("shows ordered step bodies and page breaks, searches their text, and links to graph editing", () => {
    const longTextScene: SceneDefinition = {
      schema_version: 2,
      id: "main",
      entry: "document",
      nodes: {
        document: {
          type: "long_text",
          steps: [
            {
              id: "opening",
              text: "第一行\n仍是第一段",
              page_break_before: false,
            },
            { id: "second", text: "全文独特词语", page_break_before: true },
          ],
          speed_cps: null,
          next: "finish",
        },
        finish: { type: "end" },
      },
    };
    const onOpenGraph = vi.fn();
    render(
      <ScriptView {...scriptProps({ onOpenGraph, scene: longTextScene })} />,
    );

    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    const firstStep = within(list).getByText(/第一行/);
    expect(firstStep.textContent).toBe("第一行\n仍是第一段");
    expect(within(list).getByText("全文独特词语")).toBeTruthy();
    expect(within(list).getByText("分页符")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "document 正文" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "在剧情图中打开以进入长文本编辑器" }),
    );
    expect(onOpenGraph).toHaveBeenCalledWith("document");

    fireEvent.change(screen.getByLabelText("搜索脚本"), {
      target: { value: "全文独特词语" },
    });
    expect(within(list).getByText("全文独特词语")).toBeTruthy();
    expect(document.querySelectorAll(".script-row")).toHaveLength(1);
  });
});

describe("ScriptView branch insertion", () => {
  it("offers branch outlets and inserts into the selected outlet", () => {
    const onInsertAfter = vi.fn();
    render(
      <ScriptView
        {...scriptProps({ onInsertAfter, selectedNodeId: "choice" })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "在 choice 后插入对话" }),
    );
    const menu = screen.getByLabelText("choice 插入出口");
    fireEvent.click(
      within(menu).getByRole("button", { name: "右分支 → right" }),
    );

    expect(onInsertAfter).toHaveBeenCalledTimes(1);
    expect(onInsertAfter).toHaveBeenCalledWith("choice", "choice:right");
  });
});

describe("ScriptView choice summary", () => {
  it("summarises a choice by its option labels", () => {
    const single: SceneDefinition = {
      ...scene,
      nodes: {
        ...scene.nodes,
        choice: {
          type: "choice",
          choices: [{ id: "left", label: "左分支", next: "left" }],
        },
      },
    };
    const first = render(<ScriptView {...scriptProps({ scene: single })} />);
    expect(screen.getByText("左分支")).toBeTruthy();
    first.unmount();

    const presented: SceneDefinition = {
      ...scene,
      nodes: {
        ...scene.nodes,
        choice: {
          type: "choice",
          presentation: {
            template: "choice.primary",
            anchor_x: 960,
            anchor_y: 540,
            direction: "horizontal",
            gap: 20,
            button_width: null,
            button_height: null,
          },
          choices: [
            { id: "left", label: "左分支", next: "left" },
            { id: "right", label: "右分支", next: "right" },
          ],
        },
      },
    };
    render(<ScriptView {...scriptProps({ scene: presented })} />);
    expect(screen.getAllByText("左分支 / 右分支").length).toBeGreaterThan(0);
  });
});

describe("ScriptView node deletion shortcut", () => {
  it("focuses the scoped root, adopts the graph selection and deletes with Delete or Backspace", () => {
    const { onDelete, root } = renderList("left");
    expect(document.activeElement).toBe(root);

    fireEvent.keyDown(root, { key: "Delete" });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("left");
    fireEvent.keyDown(root, { key: "Backspace" });
    expect(onDelete).toHaveBeenCalledTimes(2);
  });

  it("deletes once per key press and stops the event from bubbling", () => {
    const outer = vi.fn();
    const onDelete = vi.fn();
    const view = render(
      <div onKeyDown={outer}>
        <ScriptView {...scriptProps({ onDelete, selectedNodeId: "left" })} />
      </div>,
    );
    const list = view.container.querySelector<HTMLElement>(".script-list");
    if (list === null) throw new Error("missing script list");
    fireEvent.keyDown(list, { key: "Delete" });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it("does nothing without a selection", () => {
    const { onDelete, root } = renderList(null);
    fireEvent.keyDown(root, { key: "Delete" });
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe("ScriptView interactive-control and dialog guards", () => {
  it("ignores Delete and Backspace from row, summary and menu controls", () => {
    const { onDelete, root, view } = renderList("left");
    const container = view.container;
    const rowDelete = within(container).getByLabelText("删除 left");
    const rowInsert = within(container).getByLabelText("在 left 后插入对话");
    const summary =
      container.querySelector<HTMLButtonElement>(".script-summary");
    if (summary === null) throw new Error("missing row summary button");

    for (const [control, key] of [
      [rowDelete, "Delete"],
      [rowDelete, "Backspace"],
      [rowInsert, "Delete"],
      [summary, "Delete"],
      [summary, "Backspace"],
    ] as const) {
      control.focus();
      fireEvent.keyDown(control, { key });
      expect(onDelete).not.toHaveBeenCalled();
    }

    // The scoped list itself still deletes exactly once.
    fireEvent.keyDown(root, { key: "Delete" });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("left");
  });

  it("ignores destructive keys from an open insert menu", () => {
    const { onDelete, view } = renderList("choice");
    fireEvent.click(
      within(view.container).getByLabelText("在 choice 后插入对话"),
    );
    const menu = within(view.container).getByLabelText("choice 插入出口");
    const option = within(menu).getByRole("button", { name: /左分支/ });
    option.focus();
    fireEvent.keyDown(option, { key: "Delete" });
    fireEvent.keyDown(option, { key: "Backspace" });
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("ignores destructive keys while an App dialog owns the interaction", () => {
    const onDelete = vi.fn();
    const props = scriptProps({ onDelete, selectedNodeId: "left" });
    const view = render(<ScriptView {...props} deleteDisabled />);
    const root = scriptRoot(view.container);
    root.focus();
    fireEvent.keyDown(root, { key: "Delete" });
    expect(onDelete).not.toHaveBeenCalled();

    // Closing the dialog re-enables the shortcut for the same selection.
    view.rerender(<ScriptView {...props} deleteDisabled={false} />);
    fireEvent.keyDown(root, { key: "Delete" });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("left");
  });

  it("ignores destructive keys while the paste preview is open", () => {
    const { onDelete, root, view } = renderList("left");
    fireEvent.paste(root, {
      clipboardData: {
        getData: () => "旁白\t第一句\n旁白\t第二句",
        types: ["text/plain"],
      },
    });
    expect(within(view.container).getByLabelText("批量粘贴预览")).toBeDefined();

    fireEvent.keyDown(root, { key: "Delete" });
    expect(onDelete).not.toHaveBeenCalled();
  });
});
