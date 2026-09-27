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

function requireElement<T extends Element>(element: T | null): T {
  if (element === null) throw new Error("missing element");
  return element;
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

beforeEach(() => {
  installDomStubs();
  localStorage.clear();
  api.pickProjectDirectory.mockResolvedValue("C:/work/game");
  api.openProject.mockImplementation(() =>
    Promise.resolve(structuredClone(fixtureProject())),
  );
  api.validateProject.mockResolvedValue(undefined as never);
  api.saveProject.mockImplementation(() =>
    Promise.resolve({
      project: structuredClone(fixtureProject()),
      changed_paths: ["scenes/main.yaml"],
      deleted_paths: [],
      warnings: [],
    } as never),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
