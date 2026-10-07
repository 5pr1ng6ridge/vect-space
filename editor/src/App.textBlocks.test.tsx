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
import { defaultNode } from "./story";
import { installDomStubs, renderOpenedApp } from "./test/appHarness";
import { visualProject, type VisualProject } from "./test/visualFixtures";
import type { SaveProjectRequest, SceneNode } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(() => Promise.reject(new Error("host unavailable in tests"))),
}));

// The real workspace needs canvas/WebGL; only the route contract matters here.
vi.mock("./components/VisualWorkspace", () => ({
  VisualWorkspace: (props: {
    kind: string;
    file: { definition: { id: string } };
    onBack(): void;
  }) => (
    <div>
      <p>visual workspace {props.kind}/{props.file.definition.id}</p>
      <button onClick={props.onBack} type="button">
        返回剧情图
      </button>
    </div>
  ),
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

/** `main` (active, empty) and `side`, whose Sprite already uses `label`. */
function legacyProject(): VisualProject {
  const project = visualProject();
  const side = structuredClone(project.scenes[0]);
  side.path = "scenes/side.yaml";
  side.definition.id = "side";
  side.definition.nodes.caption = {
    ...(defaultNode("sprite", "finish") as Extract<SceneNode, { type: "sprite" }>),
    source: { type: "text", text_block: "label" },
  };
  project.scenes.push(side);
  project.manifest.scenes.push(side.path);
  project.layout.scenes.side = {
    nodes: { start: { x: 0, y: 0 }, caption: { x: 320, y: 0 }, finish: { x: 640, y: 0 } },
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  return project;
}

let opened: () => VisualProject = legacyProject;

beforeEach(() => {
  installDomStubs();
  localStorage.clear();
  opened = legacyProject;
  api.pickProjectDirectory.mockResolvedValue("C:/work/game");
  api.openProject.mockImplementation(() => Promise.resolve(structuredClone(opened())));
  api.validateProject.mockResolvedValue(undefined as never);
  // Echo the saved documents back like the host so a reopen sees them.
  api.saveProject.mockImplementation((request: SaveProjectRequest) =>
    Promise.resolve({
      project: {
        ...structuredClone(opened()),
        manifest: request.manifest,
        scenes: request.scenes,
        ui_motions: request.ui_motions,
        text_blocks: request.text_blocks,
        particles: request.particles,
        layout: request.layout,
      },
      changed_paths: ["manifest.yaml"],
      deleted_paths: [],
      warnings: [],
      transaction_id: null,
    } as never),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const shellVisible = (): boolean =>
  screen.queryByRole("button", { name: "保存项目" }) !== null;

function sidebar(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".project-sidebar");
  if (element === null) throw new Error("missing sidebar");
  return element;
}

function groupOf(sceneId: string): HTMLElement {
  const toggle = within(sidebar()).getByRole("button", { name: `场景 ${sceneId} 的固定文本块` });
  const region = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
  if (region === null) throw new Error("missing group region");
  return region;
}

function activeSceneRow(): string {
  return document.querySelector(".scene-row.active .scene-text strong")?.textContent ?? "";
}

async function createTextIn(sceneId: string, id: string): Promise<void> {
  fireEvent.click(within(sidebar()).getByRole("button", { name: `在场景 ${sceneId} 新建固定文本块` }));
  const input = await screen.findByRole("textbox", { name: "新固定文本块 ID" });
  fireEvent.change(input, { target: { value: id } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
}

async function backFromWorkspace(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "返回剧情图" }));
  await waitFor(() => expect(shellVisible()).toBe(true));
}

describe("App scene text blocks", () => {
  it("returns to the origin scene, not the one that was active, after editing a text", async () => {
    await renderOpenedApp(<App />);
    expect(activeSceneRow()).toBe("main");

    fireEvent.click(within(groupOf("side")).getByRole("button", { name: "编辑固定文本块 label" }));
    await screen.findByText("visual workspace textBlock/label");
    expect(shellVisible()).toBe(false);

    await backFromWorkspace();
    expect(activeSceneRow()).toBe("side");
  });

  it("opens empty inactive scene groups with one click and remembers the choice", async () => {
    opened = () => {
      const project = legacyProject();
      const extra = structuredClone(project.scenes[0]);
      extra.path = "scenes/epilogue.yaml";
      extra.definition.id = "epilogue";
      project.scenes.push(extra);
      project.manifest.scenes.push(extra.path);
      return project;
    };
    await renderOpenedApp(<App />);
    const toggle = (): HTMLElement =>
      within(sidebar()).getByRole("button", { name: "场景 epilogue 的固定文本块" });
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");

    // The choice survives a workspace round trip that unmounts the sidebar.
    fireEvent.click(within(groupOf("side")).getByRole("button", { name: "编辑固定文本块 label" }));
    await screen.findByText("visual workspace textBlock/label");
    await backFromWorkspace();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the active scene when the text came from a fallback group", async () => {
    opened = () => {
      const project = legacyProject();
      project.scenes[1].definition.nodes.caption = { type: "end" };
      return project;
    };
    await renderOpenedApp(<App />);
    fireEvent.click(
      within(sidebar()).getByRole("button", { name: "编辑固定文本块 label" }),
    );
    await screen.findByText("visual workspace textBlock/label");
    await backFromWorkspace();
    expect(activeSceneRow()).toBe("main");
  });

  it("creates a text in a scene as one undoable step with no graph node, then redoes it", async () => {
    await renderOpenedApp(<App />);
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
    const flowNodes = (): number => document.querySelectorAll(".react-flow__node").length;
    await waitFor(() => expect(flowNodes()).toBeGreaterThan(0));
    const nodesBefore = flowNodes();

    await createTextIn("main", "main.title");
    await screen.findByText("visual workspace textBlock/main.title");
    await backFromWorkspace();

    expect(
      within(groupOf("main")).getByRole("button", { name: "编辑固定文本块 main.title" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(flowNodes()).toBe(nodesBefore));
    expect(screen.queryByRole("button", { name: /未归属文本块/ })).toBeNull();

    // A single undo removes the definition and its pin together.
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() =>
      expect(within(sidebar()).queryByRole("button", { name: "编辑固定文本块 main.title" })).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: /未归属文本块/ })).toBeNull();
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    await waitFor(() =>
      expect(
        within(groupOf("main")).getByRole("button", { name: "编辑固定文本块 main.title" }),
      ).toBeInTheDocument(),
    );
  });

  it("saves an unused new text with its scene pin and finds it again after reopening", async () => {
    await renderOpenedApp(<App />);
    await createTextIn("side", "side.note");
    await screen.findByText("visual workspace textBlock/side.note");
    await backFromWorkspace();
    expect(activeSceneRow()).toBe("side");

    fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
    await waitFor(() => expect(api.saveProject).toHaveBeenCalledTimes(1));
    const request = api.saveProject.mock.calls[0][0];
    expect(request.text_blocks?.map((file) => file.definition.id)).toContain("side.note");
    expect(request.layout.scenes.side.text_block_ids).toEqual(["side.note"]);
    // No Sprite was authored: the scene graph is exactly the saved document.
    expect(Object.keys(request.scenes[1].definition.nodes)).not.toContain("side.note");

    // Reopen from what the host echoed back.
    const saved = (await api.saveProject.mock.results[0].value) as { project: VisualProject };
    cleanup();
    opened = () => structuredClone(saved.project);
    await renderOpenedApp(<App />);
    // `side` holds texts, so its group is open without any click.
    expect(
      within(sidebar()).getByRole("button", { name: "编辑固定文本块 side.note" }),
    ).toBeInTheDocument();
  });

  it("copies next to the source and restores a removed unused copy with undo", async () => {
    await renderOpenedApp(<App />);
    const row = within(groupOf("side"))
      .getByRole("button", { name: "编辑固定文本块 label" })
      .closest(".library-row") as HTMLElement;
    const menuAction = (name: string): void => {
      fireEvent.keyDown(within(row).getByRole("button", { name: "更多操作" }), { key: "Enter" });
      fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name }));
    };

    menuAction("创建副本");
    await waitFor(() =>
      expect(
        within(groupOf("side")).getByRole("button", { name: "编辑固定文本块 label_copy" }),
      ).toBeInTheDocument(),
    );
    // Both stay one definition each in the same scene group.
    expect(within(groupOf("side")).getAllByRole("button", { name: /^编辑固定文本块 / })).toHaveLength(2);

    // The pinned copy is deletable (no Sprite uses it) and one undo restores it.
    const copyRow = within(groupOf("side"))
      .getByRole("button", { name: "编辑固定文本块 label_copy" })
      .closest(".library-row") as HTMLElement;
    fireEvent.keyDown(within(copyRow).getByRole("button", { name: "更多操作" }), { key: "Enter" });
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "从项目移除" }));
    await waitFor(() =>
      expect(within(sidebar()).queryByRole("button", { name: "编辑固定文本块 label_copy" })).toBeNull(),
    );
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() =>
      expect(
        within(groupOf("side")).getByRole("button", { name: "编辑固定文本块 label_copy" }),
      ).toBeInTheDocument(),
    );
  });

  it("renames a pinned unused text without leaving its scene group", async () => {
    await renderOpenedApp(<App />);
    await createTextIn("side", "side.note");
    await screen.findByText("visual workspace textBlock/side.note");
    await backFromWorkspace();

    const row = within(groupOf("side"))
      .getByRole("button", { name: "编辑固定文本块 side.note" })
      .closest(".library-row") as HTMLElement;
    fireEvent.keyDown(within(row).getByRole("button", { name: "更多操作" }), { key: "Enter" });
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "重命名 ID…" }));
    const input = await screen.findByRole("textbox", { name: "新的固定文本块 ID" });
    fireEvent.change(input, { target: { value: "side.memo" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() =>
      expect(
        within(groupOf("side")).getByRole("button", { name: "编辑固定文本块 side.memo" }),
      ).toBeInTheDocument(),
    );
    expect(within(sidebar()).queryByRole("button", { name: "编辑固定文本块 side.note" })).toBeNull();
    expect(screen.queryByRole("button", { name: /未归属文本块/ })).toBeNull();

    fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
    await waitFor(() => expect(api.saveProject).toHaveBeenCalledTimes(1));
    expect(api.saveProject.mock.calls[0][0].layout.scenes.side.text_block_ids).toEqual(["side.memo"]);
  });

  it("still refuses to delete a text a Sprite uses, and keeps the group", async () => {
    await renderOpenedApp(<App />);
    const row = within(groupOf("side"))
      .getByRole("button", { name: "编辑固定文本块 label" })
      .closest(".library-row") as HTMLElement;
    fireEvent.keyDown(within(row).getByRole("button", { name: "更多操作" }), { key: "Enter" });
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "从项目移除" }));
    await screen.findByText(/仍被 1 处引用/);
    expect(
      within(groupOf("side")).getByRole("button", { name: "编辑固定文本块 label" }),
    ).toBeInTheDocument();
  });

  it("keeps a text and falls back to the unassigned group when its only scene is deleted", async () => {
    await renderOpenedApp(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "删除场景" })[1]);
    await waitFor(() =>
      expect(within(sidebar()).queryByRole("button", { name: "场景 side 的固定文本块" })).toBeNull(),
    );
    // The Sprite went with the scene; the text resource itself is untouched.
    const fallback = await screen.findByRole("button", { name: "未归属文本块 · 1" });
    const region = document.getElementById(fallback.getAttribute("aria-controls") ?? "");
    expect(region).not.toBeNull();
    expect(
      within(region as HTMLElement).getByRole("button", { name: "编辑固定文本块 label" }),
    ).toBeInTheDocument();
  });
});
