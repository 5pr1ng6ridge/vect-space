// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SceneDefinition, SceneGroup, SceneLayout } from "../types";
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

function graphProps(overrides: Partial<StoryGraphProps> = {}): StoryGraphProps {
  return {
    deleteDisabled: false,
    diagnostics: [],
    layout: undefined,
    onConnect: vi.fn(),
    onCopy: vi.fn(),
    onDelete: vi.fn(),
    onMoveMany: vi.fn(),
    onMoveNode: vi.fn(),
    onSetGroups: vi.fn(),
    onOpen: vi.fn(),
    onPaste: vi.fn(),
    onPreview: vi.fn(),
    onQuickInsert: vi.fn(),
    onSelect: vi.fn(),
    onViewport: vi.fn(),
    scene,
    selectedNodeId: "a",
    ...overrides,
  };
}

function renderGraph(overrides: Partial<StoryGraphProps> = {}) {
  const props = graphProps(overrides);
  const view = render(<StoryGraph {...props} />);
  const onDelete = props.onDelete as ReturnType<typeof vi.fn>;
  const onSelect = props.onSelect as ReturnType<typeof vi.fn>;
  const onQuickInsert = props.onQuickInsert as ReturnType<typeof vi.fn>;
  const onPreview = props.onPreview as ReturnType<typeof vi.fn>;
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

async function groupFrame(
  container: HTMLElement,
  groupId: string,
): Promise<HTMLElement> {
  return waitFor(() => {
    const frame = container.querySelector<HTMLElement>(
      `.story-group-frame[data-group-id="${groupId}"]`,
    );
    if (frame === null) throw new Error(`missing group frame ${groupId}`);
    return frame;
  });
}

function groupHeader(frame: HTMLElement): HTMLElement {
  const header = frame.querySelector<HTMLElement>(".story-group-header");
  if (header === null) throw new Error("missing group header");
  return header;
}

function translateOf(element: HTMLElement): { x: number; y: number } {
  const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(
    element.style.transform,
  );
  if (match === null)
    throw new Error(`missing transform: ${element.style.transform}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

function pressGroupHeader(frame: HTMLElement, pointerId = 1): HTMLElement {
  const header = groupHeader(frame);
  fireEvent.pointerDown(header, { button: 0, pointerId });
  return header;
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

  it("lets an open insert menu own the Delete key", async () => {
    const { onDelete, onSelect } = renderGraph();
    const node = await nodeElement("a");
    // jsdom never measures the node, so React Flow leaves it `visibility:
    // hidden` and role queries skip it; address the control directly.
    const insert = node.querySelector<HTMLButtonElement>(
      'button[aria-label="在前面插入节点"]',
    );
    if (insert === null) throw new Error("missing insert control");
    fireEvent.click(node.querySelector("article") ?? node);
    expect(onSelect).toHaveBeenCalledWith("a");
    fireEvent.pointerDown(insert, { button: 0, ctrlKey: false });
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Delete" });
    expect(onDelete).not.toHaveBeenCalled();
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

describe("StoryGraph nested groups", () => {
  it("imports Shift marquee selection before a right-click grouping action", async () => {
    const onSetGroups = vi.fn();
    const { view } = renderGraph({ onSetGroups, selectedNodeId: null });
    await nodeElement("c");
    const canvas =
      view.container.querySelector<HTMLElement>(".react-flow__pane");
    if (canvas === null) throw new Error("missing selection pane");
    fireEvent.keyDown(window, {
      key: "Shift",
      code: "ShiftLeft",
      shiftKey: true,
    });
    fireEvent.pointerDown(canvas, {
      button: 0,
      pointerId: 1,
      isPrimary: true,
      pointerType: "mouse",
      clientX: 0,
      clientY: 0,
      shiftKey: true,
    });
    fireEvent.pointerMove(canvas, {
      button: 0,
      pointerId: 1,
      isPrimary: true,
      pointerType: "mouse",
      clientX: 1200,
      clientY: 500,
      shiftKey: true,
    });
    fireEvent.pointerUp(canvas, {
      button: 0,
      pointerId: 1,
      isPrimary: true,
      pointerType: "mouse",
      clientX: 1200,
      clientY: 500,
      shiftKey: true,
    });
    fireEvent.keyUp(window, { key: "Shift", code: "ShiftLeft" });
    const first = await nodeCard("a");
    const second = await nodeCard("b");
    const third = await nodeCard("c");
    await waitFor(() => expect(first).toHaveClass("is-selected"));
    expect(second).toHaveClass("is-selected");
    expect(third).toHaveClass("is-selected");
    // The author may right-click empty canvas after drawing the marquee.
    fireEvent.contextMenu(canvas, { clientX: 30, clientY: 40 });
    const item = await screen.findByRole("menuitem", {
      name: /将所选项组成父组/,
    });
    expect(item).toBeEnabled();
    fireEvent.click(item);
    expect(onSetGroups).toHaveBeenCalledTimes(1);
    expect((onSetGroups.mock.calls[0][0] as SceneGroup[])[0].children).toEqual([
      { node: "a" },
      { node: "b" },
      { node: "c" },
    ]);
  });

  it("retains multi-selection on right-click and groups it from the menu", async () => {
    const onSetGroups = vi.fn();
    renderGraph({ onSetGroups });
    const first = await nodeCard("a");
    fireEvent.click(first);
    const second = await nodeCard("b");
    fireEvent.click(second, { ctrlKey: true });
    fireEvent.pointerDown(second, { button: 2, pointerId: 2 });
    fireEvent.contextMenu(second, { clientX: 30, clientY: 40 });
    const item = await screen.findByRole("menuitem", {
      name: /将所选项组成父组/,
    });
    expect(item).toBeEnabled();
    fireEvent.click(item);
    expect(onSetGroups).toHaveBeenCalledWith([
      expect.objectContaining({ children: [{ node: "a" }, { node: "b" }] }),
    ]);
  });

  it("keeps a group plus node selected when opening their context menu", async () => {
    const layout: SceneLayout = {
      nodes: {
        a: { x: 100, y: 30 },
        b: { x: 230, y: 60 },
        c: { x: 400, y: 30 },
      },
      viewport: null,
      groups: [{ id: "g1", children: [{ node: "a" }, { node: "b" }] }],
    };
    const onSetGroups = vi.fn();
    const { view } = renderGraph({ layout, onSetGroups, selectedNodeId: null });
    const frame = await groupFrame(view.container, "g1");
    pressGroupHeader(frame);
    fireEvent.click(await nodeCard("c"), { ctrlKey: true });
    const header = frame.querySelector<HTMLElement>(".story-group-header");
    if (header === null) throw new Error("missing group header");
    fireEvent.contextMenu(header, { clientX: 30, clientY: 40 });
    const item = await screen.findByRole("menuitem", {
      name: /将所选项组成父组/,
    });
    fireEvent.click(item);
    const groups = onSetGroups.mock.calls[0][0] as SceneGroup[];
    expect(groups.find((group) => group.id !== "g1")?.children).toEqual([
      { group: "g1" },
      { node: "c" },
    ]);
  });

  it("moves only the selected nested node up one level from its context menu", async () => {
    const layout: SceneLayout = {
      nodes: {
        a: { x: 100, y: 30 },
        b: { x: 230, y: 60 },
        c: { x: 400, y: 30 },
      },
      viewport: null,
      groups: [
        { id: "inner", children: [{ node: "a" }, { node: "b" }] },
        { id: "outer", children: [{ group: "inner" }, { node: "c" }] },
      ],
    };
    const onSetGroups = vi.fn();
    renderGraph({ layout, onSetGroups, selectedNodeId: null });
    const selected = await nodeCard("a");
    fireEvent.click(selected);
    fireEvent.contextMenu(selected, { clientX: 30, clientY: 40 });
    const item = await screen.findByRole("menuitem", {
      name: /移出此组（上移一级）/,
    });
    fireEvent.click(item);
    expect(onSetGroups).toHaveBeenCalledWith([
      { id: "outer", children: [{ node: "b" }, { node: "a" }, { node: "c" }] },
    ]);
  });

  it("does not offer detach for a root entity", async () => {
    const onSetGroups = vi.fn();
    renderGraph({ onSetGroups });
    const root = await nodeCard("a");
    fireEvent.contextMenu(root, { clientX: 30, clientY: 40 });
    expect(
      screen.queryByRole("menuitem", { name: /移出此组（上移一级）/ }),
    ).toBeNull();
  });

  it("right-clicks a selected group to dissolve only that layer", async () => {
    const layout: SceneLayout = {
      nodes: {
        a: { x: 100, y: 30 },
        b: { x: 230, y: 60 },
        c: { x: 400, y: 30 },
      },
      viewport: null,
      groups: [
        { id: "g1", children: [{ node: "a" }, { node: "b" }] },
        { id: "g0", children: [{ group: "g1" }, { node: "c" }] },
      ],
    };
    const onSetGroups = vi.fn();
    const { view } = renderGraph({ layout, onSetGroups, selectedNodeId: null });
    const outer = await groupFrame(view.container, "g0");
    const header = outer.querySelector<HTMLElement>(".story-group-header");
    if (header === null) throw new Error("missing group header");
    fireEvent.contextMenu(header, { clientX: 30, clientY: 40 });
    const item = await screen.findByRole("menuitem", { name: /解散此组/ });
    fireEvent.click(item);
    expect(onSetGroups).toHaveBeenCalledWith([
      { id: "g1", children: [{ node: "a" }, { node: "b" }] },
    ]);
  });

  it("restores canvas focus after clicking a node from the toolbar", async () => {
    const { view } = renderGraph();
    const toolbar = screen.getByRole("button", { name: "自动布局" });
    toolbar.focus();
    fireEvent.click(await nodeCard("a"));
    expect(document.activeElement).toBe(pane(view));
  });

  it("Ctrl+Shift+L also groups when Ctrl+L is reserved by the browser", async () => {
    const onSetGroups = vi.fn();
    const { view } = renderGraph({ onSetGroups });
    fireEvent.click(await nodeCard("a"));
    fireEvent.click(await nodeCard("b"), { ctrlKey: true });
    fireEvent.keyDown(pane(view), { key: "L", ctrlKey: true, shiftKey: true });
    expect(onSetGroups).toHaveBeenCalledTimes(1);
  });

  it("captures Ctrl+L after the WebView browser guard and a Flow descendant", async () => {
    const browserGuard = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.key.toLowerCase() !== "l") return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", browserGuard, true);
    try {
      const { view, props } = renderGraph();
      fireEvent.click(await nodeCard("a"));
      fireEvent.click(await nodeCard("b"), { ctrlKey: true });
      const target = await nodeCard("b");
      target.addEventListener("keydown", (event) => event.stopPropagation());
      expect(fireEvent.keyDown(target, { key: "l", ctrlKey: true })).toBe(
        false,
      );
      expect(props.onSetGroups).toHaveBeenCalledTimes(1);
      const updated = (props.onSetGroups as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as SceneGroup[];
      expect(updated[0].children).toEqual([{ node: "a" }, { node: "b" }]);
      expect(pane(view)).toBeInTheDocument();
    } finally {
      window.removeEventListener("keydown", browserGuard, true);
    }
  });

  it("copies and duplicates the full selection from keyboard and the selected node menu", async () => {
    const onCopySelection = vi.fn();
    const onDuplicateSelection = vi.fn(() => [
      { node: "a_copy" },
      { node: "b_copy" },
    ]);
    renderGraph({
      onCopySelection,
      onDuplicateSelection,
      onDuplicate: vi.fn(),
    });
    fireEvent.click(await nodeCard("a"));
    fireEvent.click(await nodeCard("b"), { ctrlKey: true });
    expect(
      fireEvent.keyDown(await nodeCard("b"), { key: "c", ctrlKey: true }),
    ).toBe(false);
    expect(onCopySelection).toHaveBeenCalledWith([
      { node: "a" },
      { node: "b" },
    ]);

    fireEvent.contextMenu(await nodeCard("b"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "为所选项创建副本" }),
    );
    expect(onDuplicateSelection).toHaveBeenCalledWith([
      { node: "a" },
      { node: "b" },
    ]);
  });

  it("copies a selected group as a whole from its context menu", async () => {
    const onCopySelection = vi.fn();
    const layout: SceneLayout = {
      nodes: {
        a: { x: 100, y: 30 },
        b: { x: 230, y: 60 },
        c: { x: 400, y: 30 },
      },
      viewport: null,
      groups: [
        { id: "g1", children: [{ node: "a" }, { node: "b" }] },
        { id: "g0", children: [{ group: "g1" }, { node: "c" }] },
      ],
    };
    const { view } = renderGraph({
      layout,
      onCopySelection,
      selectedNodeId: null,
    });
    const frame = await groupFrame(view.container, "g0");
    fireEvent.contextMenu(groupHeader(frame), { clientX: 30, clientY: 40 });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /复制所选项/ }),
    );
    expect(onCopySelection).toHaveBeenCalledWith([{ group: "g0" }]);
  });

  it("Ctrl-click selects multiple nodes and Ctrl+L wraps them in a parent group", async () => {
    const onSetGroups = vi.fn();
    const { view } = renderGraph({ onSetGroups });
    fireEvent.click(await nodeCard("a"));
    fireEvent.click(await nodeCard("b"), { ctrlKey: true });
    fireEvent.keyDown(pane(view), { key: "l", ctrlKey: true });

    expect(onSetGroups).toHaveBeenCalledTimes(1);
    const groups = onSetGroups.mock.calls[0][0] as SceneGroup[];
    expect(groups).toHaveLength(1);
    expect(groups[0].children).toEqual([{ node: "a" }, { node: "b" }]);
    expect(groups[0].id).toMatch(/^group-/);
  });

  it("renders a persisted nested group and selects it from the frame header", async () => {
    const layout: SceneLayout = {
      nodes: {
        a: { x: 100, y: 30 },
        b: { x: 230, y: 60 },
        c: { x: 400, y: 30 },
      },
      viewport: null,
      groups: [{ id: "g1", children: [{ node: "a" }, { node: "b" }] }],
    };
    const onSelect = vi.fn();
    const { view } = renderGraph({ layout, onSelect, selectedNodeId: null });
    const frame = await groupFrame(view.container, "g1");

    pressGroupHeader(frame);

    expect(frame.className).toContain("is-selected");
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("selects a group from its border as well as its header", async () => {
    const layout: SceneLayout = {
      nodes: {
        a: { x: 100, y: 30 },
        b: { x: 230, y: 60 },
        c: { x: 400, y: 30 },
      },
      viewport: null,
      groups: [{ id: "g1", children: [{ node: "a" }, { node: "b" }] }],
    };
    const { view } = renderGraph({ layout, selectedNodeId: null });
    const frame = await groupFrame(view.container, "g1");
    const border = frame.querySelector<HTMLElement>(".story-group-edge-top");
    if (border === null) throw new Error("missing group border strip");

    fireEvent.pointerDown(border, { button: 0, pointerId: 1 });

    expect(frame.className).toContain("is-selected");
  });

  it("wraps a group plus an additively selected node on Ctrl+L", async () => {
    const layout: SceneLayout = {
      nodes: {
        a: { x: 100, y: 30 },
        b: { x: 230, y: 60 },
        c: { x: 400, y: 30 },
      },
      viewport: null,
      groups: [{ id: "g1", children: [{ node: "a" }, { node: "b" }] }],
    };
    const onSetGroups = vi.fn();
    const { view } = renderGraph({ layout, onSetGroups, selectedNodeId: null });
    const frame = await groupFrame(view.container, "g1");
    pressGroupHeader(frame);
    fireEvent.click(await nodeCard("c"), { ctrlKey: true });
    fireEvent.keyDown(pane(view), { key: "l", ctrlKey: true });

    const groups = onSetGroups.mock.calls[0][0] as SceneGroup[];
    expect(groups).toHaveLength(2);
    const parent = groups.find((group) =>
      group.children.some((ref) => "group" in ref && ref.group === "g1"),
    );
    expect(parent?.children).toContainEqual({ group: "g1" });
    expect(parent?.children).toContainEqual({ node: "c" });
  });

  it("Ctrl+L on one selected group dissolves only that layer", async () => {
    const layout: SceneLayout = {
      nodes: {
        a: { x: 100, y: 30 },
        b: { x: 230, y: 60 },
        c: { x: 400, y: 30 },
      },
      viewport: null,
      groups: [
        { id: "g1", children: [{ node: "a" }, { node: "b" }] },
        { id: "g0", children: [{ group: "g1" }, { node: "c" }] },
      ],
    };
    const onSetGroups = vi.fn();
    const { view } = renderGraph({ layout, onSetGroups, selectedNodeId: null });
    const outer = await groupFrame(view.container, "g0");
    pressGroupHeader(outer);
    fireEvent.keyDown(pane(view), { key: "l", ctrlKey: true });

    expect(onSetGroups).toHaveBeenCalledWith([
      { id: "g1", children: [{ node: "a" }, { node: "b" }] },
    ]);
  });

  it("frames nested groups so a parent encloses its child frame", async () => {
    const layout: SceneLayout = {
      nodes: {
        a: { x: 100, y: 30 },
        b: { x: 230, y: 60 },
        c: { x: 400, y: 30 },
      },
      viewport: null,
      groups: [
        { id: "g1", children: [{ node: "a" }, { node: "b" }] },
        { id: "g0", children: [{ group: "g1" }, { node: "c" }] },
      ],
    };
    const onSelect = vi.fn();
    const { view } = renderGraph({ layout, onSelect, selectedNodeId: null });
    const outer = await groupFrame(view.container, "g0");
    const inner = await groupFrame(view.container, "g1");

    expect(translateOf(inner).x - translateOf(outer).x).toBe(24);
    expect(translateOf(inner).y - translateOf(outer).y).toBe(24);
    expect(Number.parseFloat(outer.style.width)).toBeGreaterThan(
      Number.parseFloat(inner.style.width),
    );
    // The frames are chrome; the cards underneath still take their own clicks.
    fireEvent.click(await nodeCard("a"));
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("consumes Delete while a group is selected rather than deleting a stale node", async () => {
    const layout: SceneLayout = {
      nodes: {
        a: { x: 100, y: 30 },
        b: { x: 230, y: 60 },
        c: { x: 400, y: 30 },
      },
      viewport: null,
      groups: [{ id: "g1", children: [{ node: "a" }, { node: "b" }] }],
    };
    // The App inspector still points at `c`, which must never be the target.
    const { onDelete, view } = renderGraph({ layout, selectedNodeId: "c" });
    pressGroupHeader(await groupFrame(view.container, "g1"));
    fireEvent.keyDown(pane(view), { key: "Delete" });

    expect(onDelete).not.toHaveBeenCalled();
  });

  it("deletes the actually selected node after a canvas click", async () => {
    const { onDelete, view } = renderGraph({ selectedNodeId: "c" });
    fireEvent.click(await nodeCard("a"));
    fireEvent.keyDown(pane(view), { key: "Delete" });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("a");
  });

  it("does not delete when two nodes are selected without a group", async () => {
    const { onDelete, view } = renderGraph({ selectedNodeId: null });
    fireEvent.click(await nodeCard("a"));
    fireEvent.click(await nodeCard("b"), { ctrlKey: true });
    fireEvent.keyDown(pane(view), { key: "Delete" });

    expect(onDelete).not.toHaveBeenCalled();
  });

  it("auto layout keeps a nested group rigid and preserves its offsets", async () => {
    const onMoveMany = vi.fn();
    const layout: SceneLayout = {
      nodes: {
        a: { x: 100, y: 30 },
        b: { x: 430, y: 80 },
        c: { x: 900, y: 20 },
      },
      viewport: null,
      groups: [
        { id: "g1", children: [{ node: "a" }, { node: "b" }] },
        { id: "g0", children: [{ group: "g1" }, { node: "c" }] },
      ],
    };
    renderGraph({ layout, onMoveMany, selectedNodeId: null });
    await nodeElement("c");
    fireEvent.click(screen.getByRole("button", { name: "自动布局" }));
    await waitFor(() => expect(onMoveMany).toHaveBeenCalledTimes(1));

    const moved = onMoveMany.mock.calls[0][0] as Record<
      string,
      { x: number; y: number }
    >;
    expect(moved.b.x - moved.a.x).toBe(330);
    expect(moved.b.y - moved.a.y).toBe(50);
    expect(moved.c).toBeDefined();
  });

  it("drags a whole group rigidly and commits exactly once at an off-grid zoom", async () => {
    const layout: SceneLayout = {
      nodes: {
        a: { x: 103, y: 37 },
        b: { x: 333, y: 87 },
        c: { x: 900, y: 20 },
      },
      viewport: { x: 120, y: 45, zoom: 0.5 },
      groups: [{ id: "g1", children: [{ node: "a" }, { node: "b" }] }],
    };
    const onMoveMany = vi.fn();
    const onMoveNode = vi.fn();
    const { view } = renderGraph({
      layout,
      onMoveMany,
      onMoveNode,
      selectedNodeId: null,
    });
    const header = pressGroupHeader(await groupFrame(view.container, "g1"), 3);
    fireEvent.pointerMove(header, { pointerId: 3, clientX: 32, clientY: 16 });
    fireEvent.pointerUp(header, { pointerId: 3, clientX: 32, clientY: 16 });

    expect(onMoveMany).toHaveBeenCalledTimes(1);
    expect(onMoveNode).not.toHaveBeenCalled();
    const moved = onMoveMany.mock.calls[0][0] as Record<
      string,
      { x: number; y: number }
    >;
    expect(moved.c).toBeUndefined();
    // Both descendants move by the same delta, so every offset is preserved.
    expect(moved.b.x - moved.a.x).toBe(230);
    expect(moved.b.y - moved.a.y).toBe(50);
    expect(moved.a.x).not.toBe(103);
  });

  it("restores the drag baseline when the pointer returns to its origin", async () => {
    const layout: SceneLayout = {
      nodes: {
        a: { x: 103, y: 37 },
        b: { x: 333, y: 87 },
        c: { x: 900, y: 20 },
      },
      viewport: { x: 0, y: 0, zoom: 1 },
      groups: [{ id: "g1", children: [{ node: "a" }, { node: "b" }] }],
    };
    const onMoveMany = vi.fn();
    const { view } = renderGraph({ layout, onMoveMany, selectedNodeId: null });
    const header = pressGroupHeader(await groupFrame(view.container, "g1"), 3);

    fireEvent.pointerMove(header, { pointerId: 3, clientX: 32, clientY: 16 });
    fireEvent.pointerMove(header, { pointerId: 3, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(header, { pointerId: 3, clientX: 0, clientY: 0 });

    // Out-and-back is a zero delta: nothing is committed and the cards return
    // to their original absolute positions.
    expect(onMoveMany).not.toHaveBeenCalled();
    const cardA = view.container.querySelector<HTMLElement>(
      '.react-flow__node[data-id="a"]',
    );
    if (cardA === null) throw new Error("missing node a");
    expect(translateOf(cardA)).toEqual({ x: 103, y: 37 });
  });

  it("commits the final pointer-up delta even without a pointermove event", async () => {
    const layout: SceneLayout = {
      nodes: {
        a: { x: 103, y: 37 },
        b: { x: 333, y: 87 },
        c: { x: 900, y: 20 },
      },
      viewport: { x: 0, y: 0, zoom: 1 },
      groups: [{ id: "g1", children: [{ node: "a" }, { node: "b" }] }],
    };
    const onMoveMany = vi.fn();
    const { view } = renderGraph({ layout, onMoveMany, selectedNodeId: null });
    const header = pressGroupHeader(await groupFrame(view.container, "g1"), 4);

    // Pointer-up alone carries the authoritative final position.
    fireEvent.pointerUp(header, { pointerId: 4, clientX: 32, clientY: 16 });

    expect(onMoveMany).toHaveBeenCalledTimes(1);
    const moved = onMoveMany.mock.calls[0][0] as Record<
      string,
      { x: number; y: number }
    >;
    expect(moved.a).toEqual({ x: 135, y: 53 });
    expect(moved.b).toEqual({ x: 365, y: 103 });
  });

  it("restores the baseline and commits nothing when the drag is cancelled", async () => {
    const layout: SceneLayout = {
      nodes: {
        a: { x: 103, y: 37 },
        b: { x: 333, y: 87 },
        c: { x: 900, y: 20 },
      },
      viewport: { x: 0, y: 0, zoom: 1 },
      groups: [{ id: "g1", children: [{ node: "a" }, { node: "b" }] }],
    };
    const onMoveMany = vi.fn();
    const { view } = renderGraph({ layout, onMoveMany, selectedNodeId: null });
    const header = pressGroupHeader(await groupFrame(view.container, "g1"), 5);

    fireEvent.pointerMove(header, { pointerId: 5, clientX: 48, clientY: 32 });
    fireEvent.pointerCancel(header, { pointerId: 5 });

    expect(onMoveMany).not.toHaveBeenCalled();
    const cardA = view.container.querySelector<HTMLElement>(
      '.react-flow__node[data-id="a"]',
    );
    if (cardA === null) throw new Error("missing node a");
    expect(translateOf(cardA)).toEqual({ x: 103, y: 37 });
  });

  it("resets the canvas selection when the scene changes", async () => {
    const layout: SceneLayout = {
      nodes: {
        a: { x: 100, y: 30 },
        b: { x: 230, y: 60 },
        c: { x: 400, y: 30 },
      },
      viewport: null,
      groups: [{ id: "g1", children: [{ node: "a" }, { node: "b" }] }],
    };
    const onDelete = vi.fn();
    const { view } = renderGraph({ layout, onDelete, selectedNodeId: null });
    pressGroupHeader(await groupFrame(view.container, "g1"));
    expect(
      view.container.querySelector(".story-group-frame")?.className,
    ).toContain("is-selected");

    view.rerender(
      <StoryGraph
        {...graphProps({
          layout,
          onDelete,
          scene: secondScene,
          selectedNodeId: null,
        })}
      />,
    );
    await waitFor(() =>
      expect(
        view.container.querySelector(".story-group-frame")?.className,
      ).not.toContain("is-selected"),
    );
    // With the selection cleared, Delete has no canvas target at all.
    fireEvent.keyDown(pane(view), { key: "Delete" });
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("ignores a stale ELK callback after the scene changes", async () => {
    const onMoveMany = vi.fn();
    const { view } = renderGraph({ onMoveMany });
    await nodeElement("c");
    fireEvent.click(screen.getByRole("button", { name: "自动布局" }));
    view.rerender(
      <StoryGraph {...graphProps({ onMoveMany, scene: secondScene })} />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    expect(onMoveMany).not.toHaveBeenCalled();
  });

  it("ignores grouping from an input or a toolbar control", () => {
    const onSetGroups = vi.fn();
    const { view } = renderGraph({ onSetGroups });
    const shell = pane(view);
    const input = document.createElement("input");
    shell.append(input);
    fireEvent.keyDown(input, { key: "l", ctrlKey: true });
    fireEvent.keyDown(screen.getByRole("button", { name: "自动布局" }), {
      key: "l",
      ctrlKey: true,
    });
    expect(onSetGroups).not.toHaveBeenCalled();
  });
});

const secondScene: SceneDefinition = { ...scene, id: "other" };

describe("StoryGraph node double-click", () => {
  it("edits an ordinary node instead of leaving the graph", async () => {
    const onPreview = vi.fn();
    const onEditNode = vi.fn();
    renderGraph({ onEditNode, onPreview, scene: mixedScene });
    fireEvent.doubleClick(await nodeCard("say"));
    expect(onEditNode).toHaveBeenCalledWith("say");
    expect(onPreview).not.toHaveBeenCalled();
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

describe("timer effect references", () => {
  const timerScene: SceneDefinition = {
    schema_version: 2,
    id: "main",
    entry: "arm",
    nodes: {
      arm: {
        type: "timer",
        id: "pulse",
        action: "start",
        delay_ms: 500,
        interval_ms: null,
        target: "fx",
        next: "end",
      },
      fx: { type: "sfx", asset: "", volume: 1, next: "end" },
      end: { type: "end" },
    },
  };

  it("draws a connectable effect port and a dashed reference edge", async () => {
    const view = renderGraph({ scene: timerScene, selectedNodeId: null });
    const card = await nodeCard("arm");
    expect(card.querySelector(".story-port-effect")).not.toBeNull();
    expect(card.querySelector(".story-handle-effect")).not.toBeNull();
    // The reference is not a story step: no flow edge leaves through it.
    await waitFor(() =>
      expect(
        view.view.container.querySelector(
          '.react-flow__handle[data-handleid="effect"]',
        ),
      ).not.toBeNull(),
    );
  });

  it("offers the port even before a target is chosen, and not for stop", async () => {
    const unset = {
      ...timerScene,
      nodes: {
        ...timerScene.nodes,
        arm: { ...timerScene.nodes.arm, target: null },
      },
    } as SceneDefinition;
    renderGraph({ scene: unset, selectedNodeId: null });
    expect(await screen.findByText(/触发效果（未选）/)).toBeInTheDocument();
    cleanup();
    const stopped = {
      ...timerScene,
      nodes: {
        ...timerScene.nodes,
        arm: { ...timerScene.nodes.arm, action: "stop", target: null },
      },
    } as SceneDefinition;
    renderGraph({ scene: stopped, selectedNodeId: null });
    await nodeCard("arm");
    expect(screen.queryByText(/触发效果/)).toBeNull();
  });
});
