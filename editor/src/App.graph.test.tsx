// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { editorApi } from "./api";
import {
  fixtureProject,
  installDomStubs,
  renderOpenedApp,
} from "./test/appHarness";
import type { SaveProjectRequest } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    editorApi: {
      ...actual.editorApi,
      pickProjectDirectory: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn(),
      validateProject: vi.fn(),
    },
  };
});

const api = vi.mocked(editorApi);

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function requireElement<T extends Element>(element: T | null): T {
  if (element === null) throw new Error("missing element");
  return element;
}

function graphPane(): HTMLElement {
  const shell = document.querySelector<HTMLElement>(".graph-shell");
  if (shell === null) throw new Error("missing graph pane");
  return shell;
}

beforeEach(() => {
  installDomStubs();
  localStorage.clear();
  api.pickProjectDirectory.mockResolvedValue("C:/work/game");
  api.openProject.mockImplementation(() =>
    Promise.resolve(structuredClone(fixtureProject())),
  );
  api.validateProject.mockResolvedValue(undefined as never);
  // Echo the request back like the real backend: `mark_saved` replaces the doc
  // with this result, so a fixed fixture would silently undo layout edits.
  api.saveProject.mockImplementation((request: SaveProjectRequest) => {
    const project = structuredClone(fixtureProject());
    return Promise.resolve({
      project: {
        ...project,
        manifest: request.manifest,
        scenes: request.scenes,
        ui_motions: request.ui_motions,
        layout: request.layout,
      },
      changed_paths: ["scenes/main.yaml"],
      deleted_paths: [],
      warnings: [],
    } as never);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("App nested layout groups", () => {
  it("duplicates from the graph menu, renders/selects the copy, and supports undo/redo", async () => {
    await renderOpenedApp(<App />);
    const original = await screen.findByText("你好", {
      selector: ".story-node-summary",
    });
    const card = original.closest(".react-flow__node");
    if (card === null) throw new Error("missing original graph node");
    fireEvent.contextMenu(card);
    fireEvent.click(await screen.findByRole("menuitem", { name: "创建副本" }));

    await waitFor(() =>
      expect(document.querySelector('[data-id="start_copy"]')).not.toBeNull(),
    );
    const copyCard = document.querySelector<HTMLElement>(
      '[data-id="start_copy"] .story-node-summary',
    );
    if (copyCard === null)
      throw new Error("duplicate summary was not rendered");
    fireEvent.click(copyCard);
    expect(copyCard.closest(".react-flow__node")).toHaveClass("selected");

    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() =>
      expect(document.querySelector('[data-id*="_copy"]')).toBeNull(),
    );
    fireEvent.keyDown(document.body, { key: "y", ctrlKey: true });
    await waitFor(() =>
      expect(document.querySelector('[data-id*="_copy"]')).not.toBeNull(),
    );
    expect(
      screen.getAllByText("你好", { selector: ".story-node-summary" }),
    ).toHaveLength(2);
  });

  it("copies and pastes a multi-node selection as one undoable edit with internal links", async () => {
    await renderOpenedApp(<App />);
    fireEvent.click(
      await screen.findByText("你好", { selector: ".story-node-summary" }),
    );
    fireEvent.click(
      await screen.findByText("第二句", { selector: ".story-node-summary" }),
      {
        ctrlKey: true,
      },
    );
    const endCard = document.querySelector<HTMLElement>(
      '[data-id="finish"] .story-node',
    );
    if (endCard === null) throw new Error("missing end node");
    fireEvent.click(endCard, { ctrlKey: true });
    fireEvent.keyDown(graphPane(), { key: "c", ctrlKey: true });
    fireEvent.keyDown(graphPane(), { key: "v", ctrlKey: true });
    await waitFor(() =>
      expect(document.querySelector('[data-id="second_copy"]')).not.toBeNull(),
    );
    fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
    await waitFor(() => expect(api.saveProject).toHaveBeenCalledTimes(1));
    const scene = api.saveProject.mock.calls[0][0].scenes[0].definition;
    expect(scene.nodes.start_copy).toMatchObject({ next: "second_copy" });
    expect(scene.nodes.second_copy).toMatchObject({ next: "finish_copy" });
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() =>
      expect(document.querySelector('[data-id="start_copy"]')).toBeNull(),
    );
  });

  it("duplicates a selected nested group with its hierarchy and connections", async () => {
    api.openProject.mockImplementation(() => {
      const project = structuredClone(fixtureProject());
      project.layout.scenes.main.groups = [
        { id: "inner", children: [{ node: "start" }, { node: "second" }] },
        { id: "outer", children: [{ group: "inner" }, { node: "finish" }] },
      ];
      return Promise.resolve(project);
    });
    await renderOpenedApp(<App />);
    const outer = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '.story-group-frame[data-group-id="outer"] .story-group-header',
      );
      if (element === null) throw new Error("missing outer group");
      return element;
    });
    fireEvent.pointerDown(outer, { button: 0, pointerId: 1 });
    fireEvent.contextMenu(outer);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "为所选项创建副本" }),
    );
    await waitFor(() =>
      expect(document.querySelector('[data-id="start_copy"]')).not.toBeNull(),
    );
    fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
    await waitFor(() => expect(api.saveProject).toHaveBeenCalledTimes(1));
    const request = api.saveProject.mock.calls[0][0];
    expect(request.scenes[0].definition.nodes.start_copy).toMatchObject({
      next: "second_copy",
    });
    expect(request.layout.scenes.main.groups).toEqual([
      { id: "inner", children: [{ node: "start" }, { node: "second" }] },
      { id: "outer", children: [{ group: "inner" }, { node: "finish" }] },
      {
        id: "group-0",
        children: [{ node: "start_copy" }, { node: "second_copy" }],
      },
      {
        id: "group-1",
        children: [{ group: "group-0" }, { node: "finish_copy" }],
      },
    ]);
  });

  it("creates a nested group with Ctrl+L, persists it, and survives undo/redo", async () => {
    await renderOpenedApp(<App />);
    fireEvent.click(
      await screen.findByText("你好", { selector: ".story-node-summary" }),
    );
    fireEvent.click(
      await screen.findByText("第二句", { selector: ".story-node-summary" }),
      { ctrlKey: true },
    );

    fireEvent.keyDown(graphPane(), { key: "l", ctrlKey: true });
    await waitFor(() =>
      expect(document.querySelector(".story-group-frame")).not.toBeNull(),
    );

    fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
    await waitFor(() => expect(api.saveProject).toHaveBeenCalledTimes(1));
    const payload = serialize(api.saveProject.mock.calls[0][0]);
    expect(payload).toContain('"groups"');
    expect(payload).toContain('"node":"start"');
    expect(payload).toContain('"node":"second"');

    // Undo drops the whole layer, redo restores the same hierarchy.
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() =>
      expect(document.querySelector(".story-group-frame")).toBeNull(),
    );
    fireEvent.keyDown(document.body, { key: "y", ctrlKey: true });
    await waitFor(() =>
      expect(document.querySelector(".story-group-frame")).not.toBeNull(),
    );
  });

  it("keeps unrelated node positions through a group drag, save, and undo/redo", async () => {
    api.openProject.mockImplementation(() => {
      const project = structuredClone(fixtureProject());
      // A non-default position for a node outside the dragged group.
      project.layout.scenes.main.nodes.finish = { x: 811, y: 137 };
      return Promise.resolve(project);
    });
    await renderOpenedApp(<App />);
    fireEvent.click(
      await screen.findByText("你好", { selector: ".story-node-summary" }),
    );
    fireEvent.click(
      await screen.findByText("第二句", { selector: ".story-node-summary" }),
      { ctrlKey: true },
    );
    fireEvent.keyDown(graphPane(), { key: "l", ctrlKey: true });
    const frame = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".story-group-frame");
      if (element === null) throw new Error("missing group frame");
      return element;
    });
    const header = frame.querySelector<HTMLElement>(".story-group-header");
    if (header === null) throw new Error("missing group header");

    fireEvent.pointerDown(header, {
      button: 0,
      pointerId: 7,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(header, { pointerId: 7, clientX: 64, clientY: 32 });
    fireEvent.pointerUp(header, { pointerId: 7, clientX: 64, clientY: 32 });

    const savedNodes = async (): Promise<
      Record<string, { x: number; y: number }>
    > => {
      const before = api.saveProject.mock.calls.length;
      fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
      await waitFor(() =>
        expect(api.saveProject.mock.calls.length).toBeGreaterThan(before),
      );
      const last = api.saveProject.mock.calls.at(-1)?.[0] as
        | {
            layout: {
              scenes: Record<
                string,
                { nodes: Record<string, { x: number; y: number }> }
              >;
            };
          }
        | undefined;
      if (last === undefined) throw new Error("save request missing");
      return last.layout.scenes.main.nodes;
    };

    // The unrelated node survives the partial batch, and only the dragged
    // descendants moved.
    const afterDrag = await savedNodes();
    expect(afterDrag.finish).toEqual({ x: 811, y: 137 });
    expect(afterDrag.start.x).toBe(64);
    expect(afterDrag.second.x).toBe(384);

    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    const afterUndo = await savedNodes();
    expect(afterUndo.finish).toEqual({ x: 811, y: 137 });
    expect(afterUndo.start).toEqual({ x: 0, y: 0 });

    fireEvent.keyDown(document.body, { key: "y", ctrlKey: true });
    const afterRedo = await savedNodes();
    expect(afterRedo.finish).toEqual({ x: 811, y: 137 });
    expect(afterRedo.start.x).toBe(64);
  });
});

/** A graph card's summary line (the speaker is shown separately). */
function findSummary(text: string): Promise<HTMLElement> {
  return screen.findByText(text, { selector: ".story-node-summary" });
}

async function selectStartNode(): Promise<HTMLTextAreaElement> {
  const summary = await findSummary("你好");
  fireEvent.click(summary);
  const inspector = await waitFor(() => {
    const element = document.querySelector<HTMLElement>("aside.inspector");
    if (element === null || element.classList.contains("empty-inspector"))
      throw new Error("inspector not ready");
    return element;
  });
  const textarea = within(inspector).getByLabelText(/^对话文本/);
  return textarea as HTMLTextAreaElement;
}

describe("App keyboard shortcuts with commit-on-blur fields", () => {
  it("Ctrl+S saves the value still being typed in an inspector field", async () => {
    await renderOpenedApp(<App />);
    const textarea = await selectStartNode();

    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "刚刚输入" } });
    fireEvent.keyDown(textarea, { key: "s", ctrlKey: true });

    await waitFor(() => expect(api.saveProject).toHaveBeenCalledTimes(1));
    expect(serialize(api.saveProject.mock.calls[0][0])).toContain("刚刚输入");
  });

  it("Ctrl+Z inside a text field is text undo, not project undo", async () => {
    await renderOpenedApp(<App />);
    const textarea = await selectStartNode();

    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "第一次修改" } });
    fireEvent.blur(textarea);
    await findSummary("第一次修改");

    // The node stays selected; the inspector remounts its textarea.
    const again = within(
      requireElement(document.querySelector<HTMLElement>("aside.inspector")),
    ).getByLabelText(/^对话文本/);
    fireEvent.focus(again);
    fireEvent.keyDown(again, { key: "z", ctrlKey: true });
    // Graph summaries refresh on the next animation frame.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(await findSummary("第一次修改")).toBeInTheDocument();

    fireEvent.blur(again);
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await findSummary("你好");
  });

  it("the game preview button commits the field being typed first", async () => {
    await renderOpenedApp(<App />);
    const textarea = await selectStartNode();

    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "预览前输入" } });
    fireEvent.click(screen.getByRole("button", { name: "游戏预览" }));
    fireEvent.click(await screen.findByRole("button", { name: "返回编辑器" }));

    expect(await findSummary("预览前输入")).toBeInTheDocument();
  });
});

describe("App full-screen workspaces", () => {
  it("shows validation errors raised inside the chapter map", async () => {
    api.validateProject.mockRejectedValue(new Error("地图校验失败"));
    await renderOpenedApp(<App />);

    fireEvent.click(screen.getByRole("button", { name: "章节地图" }));
    fireEvent.click(await screen.findByRole("button", { name: "校验" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("地图校验失败");
  });

  it("Esc inside a map text field does not leave the chapter map", async () => {
    await renderOpenedApp(<App />);
    fireEvent.click(screen.getByRole("button", { name: "章节地图" }));
    const back = await screen.findByRole("button", { name: "返回剧情图" });
    const field = document.querySelector<HTMLInputElement>(
      ".map-workspace input:not([type='checkbox']):not([type='color'])",
    );
    const input = requireElement(field);

    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Escape" });

    expect(back).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "返回剧情图" }),
    ).toBeInTheDocument();
  });
});
