// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";

import { App } from "./App";
import { editorApi } from "./api";
import type { StoryGraphProps } from "./components/StoryGraph";
import { defaultNode } from "./story";
import { installDomStubs, renderOpenedApp } from "./test/appHarness";
import { visualProject } from "./test/visualFixtures";
import type { SceneNode } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(() => Promise.reject(new Error("host unavailable in tests"))),
}));

// Exercise the App authoring/history callbacks without relying on canvas geometry.
vi.mock("./components/StoryGraph", () => ({
  StoryGraph: (props: StoryGraphProps) => {
    const source = Object.keys(props.scene.nodes).find(
      (id) => props.scene.nodes[id].type === "particle",
    ) ?? "start";
    return (
      <div>
        <button type="button" onClick={() => props.onAddNode?.("particle", { x: 0, y: 0 })}>
          新建测试粒子
        </button>
        <button type="button" onClick={() => props.onDuplicate?.(source)}>复制测试粒子</button>
        <button type="button" onClick={() => props.onDuplicateSelection?.([{ node: source }])}>复制测试粒子组</button>
        <button type="button" onClick={() => props.onCopy(source)}>拷贝测试粒子</button>
        <button type="button" onClick={() => props.onCopySelection?.([{ node: source }])}>拷贝测试粒子组</button>
        <button type="button" onClick={() => props.onPaste({ x: 0, y: 0 })}>粘贴测试粒子</button>
        <button type="button" onClick={() => {
          for (const [id, node] of Object.entries(props.scene.nodes)) {
            if (node.type === "particle" && node.next === "")
              props.onConnect(id, "next", "finish");
          }
        }}>连接测试粒子</button>
        <output data-testid="particle-instances">
          {Object.values(props.scene.nodes)
            .filter((node) => node.type === "particle")
            .map((node) => node.emitter_id).join(",")}
        </output>
      </div>
    );
  },
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    editorApi: {
      ...actual.editorApi,
      pickProjectDirectory: vi.fn(),
      openProject: vi.fn(),
      validateProject: vi.fn(),
      saveProject: vi.fn(),
    },
  };
});

beforeEach(() => {
  installDomStubs();
  localStorage.clear();
  vi.mocked(editorApi.pickProjectDirectory).mockResolvedValue("C:/work/game");
  vi.mocked(editorApi.openProject).mockResolvedValue(visualProject());
  vi.mocked(editorApi.validateProject).mockResolvedValue(undefined as never);
  vi.mocked(editorApi.saveProject).mockImplementation((request) => Promise.resolve({
    project: { ...visualProject(), manifest: request.manifest, scenes: request.scenes, layout: request.layout },
    changed_paths: [], deleted_paths: [], warnings: [], transaction_id: null,
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("App particle instance creation", () => {
  it("creates independent persistent instances and preserves IDs through undo/redo", async () => {
    await renderOpenedApp(<StrictMode><App /></StrictMode>);
    const add = screen.getByRole("button", { name: "新建测试粒子" });
    fireEvent.click(add);
    expect(screen.getByTestId("particle-instances")).toHaveTextContent(/^emitter$/);
    fireEvent.click(add);
    expect(screen.getByTestId("particle-instances")).toHaveTextContent(/^emitter,emitter_2$/);

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(screen.getByTestId("particle-instances")).toHaveTextContent(/^emitter$/);
    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    expect(screen.getByTestId("particle-instances")).toHaveTextContent(/^emitter,emitter_2$/);
  });

  it("avoids emitter identities reserved in another scene when duplicating a selection", async () => {
    const project = visualProject();
    const start = {
      ...(defaultNode("particle", "finish") as Extract<SceneNode, { type: "particle" }>),
      emitter_id: "snow", particle: "snow",
    };
    project.scenes[0].definition.nodes.start = start;
    project.manifest.scenes.push("scenes/other.yaml");
    project.scenes.push({
      path: "scenes/other.yaml",
      definition: {
        schema_version: 2, id: "other", entry: "stop",
        nodes: { stop: { ...start, emitter_id: "snow_2", action: "stop", next: "finish" }, finish: { type: "end" } },
      },
    });
    vi.mocked(editorApi.openProject).mockResolvedValue(project);
    await renderOpenedApp(<StrictMode><App /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: "复制测试粒子组" }));
    expect(screen.getByTestId("particle-instances")).toHaveTextContent(/^snow,snow_3$/);
  });

  it.each([
    { copy: null, action: "复制测试粒子" },
    { copy: null, action: "复制测试粒子组" },
    { copy: "拷贝测试粒子", action: "粘贴测试粒子" },
    { copy: "拷贝测试粒子组", action: "粘贴测试粒子" },
  ])("allocates copied instances through $copy / $action, history and save", async ({ copy, action }) => {
    const project = visualProject();
    project.scenes[0].definition.nodes.start = {
      ...(defaultNode("particle", "finish") as Extract<SceneNode, { type: "particle" }>),
      emitter_id: "snow", particle: "snow",
    };
    vi.mocked(editorApi.openProject).mockResolvedValue(project);
    await renderOpenedApp(<StrictMode><App /></StrictMode>);
    if (copy !== null) fireEvent.click(screen.getByRole("button", { name: copy }));
    const duplicate = screen.getByRole("button", { name: action });
    fireEvent.click(duplicate);
    fireEvent.click(duplicate);
    expect(screen.getByTestId("particle-instances")).toHaveTextContent(/^snow,snow_2,snow_3$/);
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(screen.getByTestId("particle-instances")).toHaveTextContent(/^snow,snow_2$/);
    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    expect(screen.getByTestId("particle-instances")).toHaveTextContent(/^snow,snow_2,snow_3$/);
    fireEvent.click(screen.getByRole("button", { name: "连接测试粒子" }));
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(editorApi.saveProject).toHaveBeenCalledOnce());
    const request = vi.mocked(editorApi.saveProject).mock.calls[0][0];
    expect(Object.values(request.scenes[0].definition.nodes)
      .filter((node) => node.type === "particle")
      .map((node) => node.emitter_id)).toEqual(["snow", "snow_2", "snow_3"]);
  });
});
