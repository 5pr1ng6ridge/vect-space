// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SceneDefinition } from "../types";
import { StoryGraph, type StoryGraphProps } from "./StoryGraph";

// React Flow needs two browser APIs jsdom does not provide; both stubs are inert
// (the graph is rendered, not measured) and keep the pane's own key handling
// testable.
class ResizeObserverStub {
  observe(): void {
    /* no-op: the graph is rendered, never measured, in jsdom. */
  }
  unobserve(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
}

// React Flow reads the viewport transform through `DOMMatrixReadOnly`; an
// identity zoom is enough because nothing is measured here.
class DOMMatrixReadOnlyStub {
  m22 = 1;
}

const scene: SceneDefinition = {
  schema_version: 2,
  id: "main",
  entry: "a",
  nodes: {
    a: { type: "say", speaker: null, text: "A", speed_cps: null, next: "b" },
    b: { type: "say", speaker: null, text: "B", speed_cps: null, next: "c" },
    c: { type: "end" },
  },
};

beforeEach(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  });
  Object.defineProperty(window, "DOMMatrixReadOnly", {
    configurable: true,
    value: DOMMatrixReadOnlyStub,
  });
});

afterEach(cleanup);

function renderGraph(overrides: Partial<StoryGraphProps> = {}) {
  const onDelete = vi.fn();
  const onSelect = vi.fn();
  const onQuickInsert = vi.fn();
  const onPreview = vi.fn();
  const props: StoryGraphProps = {
    deleteDisabled: false,
    diagnostics: [],
    layout: undefined,
    onConnect: vi.fn(),
    onCopy: vi.fn(),
    onDelete,
    onMoveMany: vi.fn(),
    onMoveNode: vi.fn(),
    onOpen: vi.fn(),
    onPaste: vi.fn(),
    onPreview,
    onQuickInsert,
    onSelect,
    onViewport: vi.fn(),
    scene,
    selectedNodeId: "a",
    ...overrides,
  };
  const view = render(<StoryGraph {...props} />);
  return { onDelete, onPreview, onQuickInsert, onSelect, props, view };
}

function pane(view: { container: HTMLElement }): HTMLElement {
  const shell = view.container.querySelector<HTMLElement>(".graph-shell");
  if (shell === null) throw new Error("missing graph pane");
  return shell;
}

async function nodeElement(nodeId: string): Promise<HTMLElement> {
  await waitFor(() =>
    expect(
      document.querySelectorAll(".react-flow__node").length,
    ).toBeGreaterThan(0),
  );
  const node = document.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${nodeId}"]`,
  );
  if (node === null) throw new Error(`missing node ${nodeId}`);
  return node;
}

/** The card element itself, so a dispatched gesture bubbles to its handler. */
async function nodeCard(nodeId: string): Promise<HTMLElement> {
  const card = (await nodeElement(nodeId)).querySelector<HTMLElement>(
    ".story-node",
  );
  if (card === null) throw new Error(`missing card ${nodeId}`);
  return card;
}

const mixedScene: SceneDefinition = {
  schema_version: 2,
  id: "main",
  entry: "say",
  nodes: {
    say: { type: "say", speaker: null, text: "A", speed_cps: null, next: "tl" },
    tl: {
      type: "timeline",
      duration_ms: 0,
      await: false,
      skippable: true,
      tracks: [],
      events: [],
      next: "lt",
    },
    lt: { type: "long_text", steps: [], speed_cps: null, next: "done" },
    done: { type: "end" },
  },
};

describe("StoryGraph node deletion shortcut", () => {
  it("deletes the selected node exactly once on Delete", async () => {
    const { onDelete, view } = renderGraph();
    const node = await nodeElement("a");

    // The key press bubbles from the focused React Flow node to the pane's
    // scoped handler; event bubbling must not fire the deletion twice.
    fireEvent.keyDown(node, { key: "Delete" });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("a");
    // A second, independent press on the pane itself stays one deletion.
    fireEvent.keyDown(pane(view), { key: "Delete" });
    expect(onDelete).toHaveBeenCalledTimes(2);
  });

  it("keeps Backspace out of the graph", async () => {
    const { onDelete, view } = renderGraph();
    const node = await nodeElement("a");
    fireEvent.keyDown(node, { key: "Backspace" });
    fireEvent.keyDown(pane(view), { key: "Backspace" });
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("does nothing without a selected node", async () => {
    const { onDelete, view } = renderGraph({ selectedNodeId: null });
    await nodeElement("a");
    fireEvent.keyDown(pane(view), { key: "Delete" });
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("does nothing while an App dialog owns the interaction", async () => {
    const { onDelete } = renderGraph({ deleteDisabled: true });
    const node = await nodeElement("a");
    fireEvent.keyDown(node, { key: "Delete" });
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("does nothing while the quick-insert menu is open", async () => {
    const { onDelete, onSelect, view } = renderGraph();
    const node = await nodeElement("a");
    // jsdom never measures the node, so React Flow leaves it `visibility:
    // hidden` and role queries skip it; address the control directly.
    const insert = node.querySelector<HTMLButtonElement>(
      'button[aria-label="在左侧插入节点"]',
    );
    if (insert === null) throw new Error("missing insert control");
    fireEvent.click(insert);
    expect(onSelect).toHaveBeenCalledWith("a");

    await waitFor(() =>
      expect(view.container.querySelector('[role="menu"]')).not.toBeNull(),
    );
    fireEvent.keyDown(node, { key: "Delete" });
    expect(onDelete).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("ignores Delete from editable fields inside the pane", () => {
    const { onDelete, view } = renderGraph();
    const shell = pane(view);
    const input = document.createElement("input");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const inner = document.createElement("span");
    editable.appendChild(inner);
    shell.append(input, editable);

    fireEvent.keyDown(input, { key: "Delete" });
    fireEvent.keyDown(inner, { key: "Delete" });
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("ignores auto-repeat and an IME composition", () => {
    const { onDelete, view } = renderGraph();
    const shell = pane(view);
    fireEvent.keyDown(shell, { key: "Delete", repeat: true });
    fireEvent.keyDown(shell, { key: "Delete", keyCode: 229 });
    fireEvent.keyDown(shell, { key: "Delete", isComposing: true });
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("does not delete from the pane's own toolbar chrome", async () => {
    const { onDelete } = renderGraph();
    await nodeElement("a");
    // Focus a toolbar control, then press Delete: a focused control inside the
    // pane must not double as a destructive shortcut.
    const autolayout = screen.getByRole("button", { name: "自动布局" });
    autolayout.focus();
    fireEvent.keyDown(autolayout, { key: "Delete" });
    expect(onDelete).not.toHaveBeenCalled();
  });
});

describe("StoryGraph node double-click", () => {
  it("opens the gameplay preview from an ordinary node", async () => {
    const onPreview = vi.fn();
    renderGraph({ onPreview, scene: mixedScene });
    fireEvent.doubleClick(await nodeCard("say"));
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith("say");
  });

  it("keeps the specialized workspace for timeline and long_text nodes", async () => {
    const onOpen = vi.fn();
    const onPreview = vi.fn();
    renderGraph({ onOpen, onPreview, scene: mixedScene });

    fireEvent.doubleClick(await nodeCard("tl"));
    fireEvent.doubleClick(await nodeCard("lt"));

    expect(onOpen).toHaveBeenCalledWith("tl");
    expect(onOpen).toHaveBeenCalledWith("lt");
    expect(onPreview).not.toHaveBeenCalled();
  });
});
