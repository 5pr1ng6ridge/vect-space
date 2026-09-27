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
