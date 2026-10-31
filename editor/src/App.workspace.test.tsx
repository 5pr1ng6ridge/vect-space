// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
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
  installDomStubs,
  renderOpenedApp,
  workspaceFixtureProject,
} from "./test/appHarness";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(() => Promise.reject(new Error("host unavailable in tests"))),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    editorApi: {
      ...actual.editorApi,
      pickProjectDirectory: vi.fn(),
      openProject: vi.fn(),
    },
  };
});

const api = vi.mocked(editorApi);

beforeEach(() => {
  installDomStubs();
  localStorage.clear();
  api.pickProjectDirectory.mockResolvedValue("C:/work/game");
  api.openProject.mockImplementation(() =>
    Promise.resolve(structuredClone(workspaceFixtureProject())),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const shell = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>(".app-shell");
  if (element === null) throw new Error("missing app shell");
  return element;
};

const leftHandle = (): HTMLElement =>
  screen.getByRole("separator", { name: /左侧栏/ });
const rightHandle = (): HTMLElement =>
  screen.getByRole("separator", { name: /右侧栏/ });

const width = (side: "left" | "right"): string =>
  shell().style.getPropertyValue(`--${side}-panel-width`);

const savedWidth = (side: "left" | "right"): number | undefined => {
  const stored = JSON.parse(
    localStorage.getItem("vectspace-editor:panel-sizes") ?? "{}",
  ) as Partial<Record<"left" | "right", number>>;
  return stored[side];
};

/** A pointer drag along the x axis: press, move through `xs`, release. */
function drag(handle: HTMLElement, startX: number, ...xs: number[]): void {
  fireEvent.pointerDown(handle, { button: 0, clientX: startX, pointerId: 1 });
  for (const clientX of xs) {
    fireEvent.pointerMove(window, { clientX, pointerId: 1 });
  }
  fireEvent.pointerUp(window, { pointerId: 1 });
}

describe("side panel handles", () => {
  it("collapses the left panel when dragged well past the minimum", async () => {
    await renderOpenedApp(<App />);
    expect(width("left")).toBe("280px");

    fireEvent.pointerDown(leftHandle(), { button: 0, clientX: 300 });
    expect(document.body).toHaveClass("panel-resizing");

    fireEvent.pointerMove(window, { clientX: 250 });
    expect(width("left")).toBe("230px");
    expect(shell()).not.toHaveClass("left-hidden");

    // The minimum is 220; 56px further in is the last width that still holds.
    fireEvent.pointerMove(window, { clientX: 300 - 280 + 164 });
    expect(width("left")).toBe("220px");
    expect(shell()).not.toHaveClass("left-hidden");

    fireEvent.pointerMove(window, { clientX: 100 });
    expect(shell()).toHaveClass("left-hidden");
    // Collapsing leaves the remembered width alone.
    expect(width("left")).toBe("280px");

    fireEvent.pointerUp(window);
    expect(document.body).not.toHaveClass("panel-resizing");
    expect(shell()).toHaveClass("left-hidden");
    expect(savedWidth("left")).toBe(280);
    expect(
      screen.getByRole("separator", { name: "拖出左侧栏" }),
    ).toHaveAttribute("title", "拖出左侧栏，或单击展开");
  });

  it("pulls the collapsed left panel out and follows the pointer", async () => {
    await renderOpenedApp(<App />);
    drag(leftHandle(), 300, 100);
    expect(shell()).toHaveClass("left-hidden");

    const rail = screen.getByRole("separator", { name: "拖出左侧栏" });
    fireEvent.pointerDown(rail, { button: 0, clientX: 60 });
    fireEvent.pointerMove(window, { clientX: 100 });
    expect(shell()).not.toHaveClass("left-hidden");
    // Starts from the minimum width...
    expect(width("left")).toBe("220px");

    fireEvent.pointerMove(window, { clientX: 60 + 350 });
    // ...then tracks the pointer.
    expect(width("left")).toBe("350px");

    fireEvent.pointerUp(window);
    expect(shell()).not.toHaveClass("left-hidden");
    expect(width("left")).toBe("350px");
    expect(savedWidth("left")).toBe(350);
    expect(screen.getByRole("separator", { name: "调整左侧栏宽度" })).toBe(
      rail,
    );
  });

  it("reopens at the remembered width on a single click", async () => {
    await renderOpenedApp(<App />);
    drag(leftHandle(), 300, 380);
    expect(width("left")).toBe("360px");

    fireEvent.click(screen.getByRole("button", { name: "隐藏左侧面板" }));
    expect(shell()).toHaveClass("left-hidden");

    const rail = leftHandle();
    // A press that wiggles inside the click slop is still a click.
    drag(rail, 60, 62);
    expect(shell()).not.toHaveClass("left-hidden");
    expect(width("left")).toBe("360px");
  });

  it("stays collapsed when a pulled-out panel is dragged back in", async () => {
    await renderOpenedApp(<App />);
    fireEvent.click(screen.getByRole("button", { name: "隐藏左侧面板" }));

    drag(leftHandle(), 60, 160, 61);
    expect(shell()).toHaveClass("left-hidden");
    expect(width("left")).toBe("280px");
  });

  it("collapses and pulls out the right panel", async () => {
    await renderOpenedApp(<App />);
    expect(width("right")).toBe("340px");

    drag(rightHandle(), 1000, 1050);
    expect(width("right")).toBe("300px");
    expect(shell()).not.toHaveClass("right-hidden");

    drag(rightHandle(), 1000, 1200);
    expect(shell()).toHaveClass("right-hidden");
    // The remembered width is the one the panel had before the collapse drag.
    expect(width("right")).toBe("300px");

    // The rail sits on the right edge; pulling left widens the panel.
    drag(
      screen.getByRole("separator", { name: "拖出右侧栏" }),
      1200,
      1100,
      800,
    );
    expect(shell()).not.toHaveClass("right-hidden");
    expect(width("right")).toBe("400px");
    expect(savedWidth("right")).toBe(400);
  });

  it("collapses and reopens from the keyboard", async () => {
    await renderOpenedApp(<App />);
    const handle = leftHandle();
    handle.focus();

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(width("left")).toBe("292px");
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(width("left")).toBe("220px");
    expect(shell()).not.toHaveClass("left-hidden");

    // Held-down repeats stop at the minimum; a fresh press collapses.
    fireEvent.keyDown(handle, { key: "ArrowLeft", repeat: true });
    expect(shell()).not.toHaveClass("left-hidden");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(shell()).toHaveClass("left-hidden");
    expect(width("left")).toBe("220px");
    // The same element keeps focus through the collapse.
    expect(handle).toHaveFocus();
    expect(handle).toHaveAccessibleName("拖出左侧栏");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(shell()).toHaveClass("left-hidden");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(shell()).not.toHaveClass("left-hidden");
    expect(width("left")).toBe("220px");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(shell()).toHaveClass("left-hidden");
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(shell()).not.toHaveClass("left-hidden");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(shell()).toHaveClass("left-hidden");
    fireEvent.keyDown(handle, { key: " " });
    expect(shell()).not.toHaveClass("left-hidden");
    expect(handle).toHaveFocus();
  });

  it("collapses the right panel with the inward arrow", async () => {
    await renderOpenedApp(<App />);
    const handle = rightHandle();

    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(width("right")).toBe("308px");
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(width("right")).toBe("300px");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(shell()).toHaveClass("right-hidden");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(shell()).not.toHaveClass("right-hidden");
    expect(width("right")).toBe("300px");
  });

  it("stays consistent with the toolbar and activity bar toggles", async () => {
    await renderOpenedApp(<App />);
    drag(leftHandle(), 300, 340);
    expect(width("left")).toBe("320px");

    fireEvent.click(screen.getByRole("button", { name: "隐藏左侧面板" }));
    expect(shell()).toHaveClass("left-hidden");
    expect(leftHandle()).toHaveAccessibleName("拖出左侧栏");

    // An activity-bar item reopens the panel at the remembered width.
    fireEvent.click(screen.getByRole("button", { name: "资源库" }));
    expect(shell()).not.toHaveClass("left-hidden");
    expect(width("left")).toBe("320px");
    expect(leftHandle()).toHaveAccessibleName("调整左侧栏宽度");

    fireEvent.click(screen.getByRole("button", { name: "隐藏检查器" }));
    expect(shell()).toHaveClass("right-hidden");
    expect(rightHandle()).toHaveAccessibleName("拖出右侧栏");
    fireEvent.click(screen.getByRole("button", { name: "显示检查器" }));
    expect(shell()).not.toHaveClass("right-hidden");
    expect(width("right")).toBe("340px");
  });
});

const shellVisible = (): boolean =>
  screen.queryByRole("button", { name: "保存项目" }) !== null;

async function leaveWith(name: string | RegExp): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name }));
  await waitFor(() => expect(shellVisible()).toBe(true));
}

async function openLibraryPanel(): Promise<HTMLElement> {
  const library = screen.getByRole("button", { name: "资源库" });
  // The activity bar toggles the panel closed when its item is already open.
  if (library.getAttribute("aria-pressed") !== "true") fireEvent.click(library);
  return await waitFor(() => {
    const sidebar = document.querySelector<HTMLElement>(".project-sidebar");
    if (sidebar === null) throw new Error("missing sidebar");
    return sidebar;
  });
}

describe("App routes", () => {
  it("enters and leaves the chapter map and the game preview", async () => {
    await renderOpenedApp(<App />);

    fireEvent.click(screen.getByRole("button", { name: "章节地图" }));
    await waitFor(() => expect(shellVisible()).toBe(false));
    await leaveWith("返回剧情图");

    fireEvent.click(screen.getByRole("button", { name: "游戏预览" }));
    await waitFor(() => expect(shellVisible()).toBe(false));
    await leaveWith("返回编辑器");
  });

  it("enters and leaves the timeline and long-text workspaces from the graph", async () => {
    await renderOpenedApp(<App />);

    const timelineCard = await screen.findByText("cam");
    fireEvent.doubleClick(timelineCard);
    await screen.findByText("main / cam");
    await leaveWith("返回剧情图");

    const longTextCard = await screen.findByText("lecture");
    fireEvent.doubleClick(longTextCard);
    await waitFor(() => expect(shellVisible()).toBe(false));
    await leaveWith("返回剧情图");
  });

  it("enters and leaves the library workspaces from the project tab", async () => {
    await renderOpenedApp(<App />);

    let sidebar = await openLibraryPanel();
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "编辑 UI 动效 ui.fade" }),
    );
    await waitFor(() => expect(shellVisible()).toBe(false));
    await leaveWith("返回剧情图");

    sidebar = await openLibraryPanel();
    fireEvent.click(
      within(sidebar).getByRole("button", {
        name: "编辑按钮模板 button.main",
      }),
    );
    await waitFor(() => expect(shellVisible()).toBe(false));
    await leaveWith("返回剧情图");

    sidebar = await openLibraryPanel();
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "编辑立绘动作 sprite.hop" }),
    );
    await waitFor(() => expect(shellVisible()).toBe(false));
    await leaveWith("返回剧情图");
  });
});
