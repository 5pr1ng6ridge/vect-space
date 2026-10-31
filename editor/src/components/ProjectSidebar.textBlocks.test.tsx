// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState, type ComponentProps, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultNode } from "../story";
import { visualProject, type VisualProject } from "../test/visualFixtures";
import type { SceneNode } from "../types";
import { ProjectSidebar } from "./ProjectSidebar";
import { createProjectSectionState } from "./projectSections";
import { SIDEBAR_CALLBACKS } from "./sidebar/testProps";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));

afterEach(cleanup);

function library() {
  return {
    onCreate: vi.fn(() => true),
    onRename: vi.fn(() => true),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onEdit: vi.fn(),
  };
}

/** `main`, `side` and `epilogue`; `label` (text) and `snow` (particle). */
function threeScenes(): VisualProject {
  const project = visualProject();
  for (const id of ["side", "epilogue"]) {
    const scene = structuredClone(project.scenes[0]);
    scene.path = `scenes/${id}.yaml`;
    scene.definition.id = id;
    project.scenes.push(scene);
    project.manifest.scenes.push(scene.path);
  }
  return project;
}

function useText(project: VisualProject, sceneId: string, textBlock: string): void {
  const scene = project.scenes.find((file) => file.definition.id === sceneId);
  if (scene === undefined) throw new Error(`missing scene ${sceneId}`);
  scene.definition.nodes[`use_${textBlock}`] = {
    ...(defaultNode("sprite", "finish") as Extract<SceneNode, { type: "sprite" }>),
    source: { type: "text", text_block: textBlock },
  };
}

function addText(project: VisualProject, id: string): void {
  const source = project.text_blocks[0];
  project.text_blocks.push({
    path: `texts/${id}.yaml`,
    definition: { ...structuredClone(source.definition), id },
  });
  project.manifest.text_blocks?.push(`texts/${id}.yaml`);
}

/** Mimics App: the host keeps the saved expand / collapse choices. */
function Harness({
  project,
  activeSceneId = "main",
  activeTab = "scenes",
  handlers = library(),
  overrides,
}: {
  project: VisualProject;
  activeSceneId?: string;
  activeTab?: "scenes" | "project";
  handlers?: ReturnType<typeof library>;
  overrides?: Partial<ComponentProps<typeof ProjectSidebar>>;
}): ReactElement {
  const [sections, setSections] = useState(createProjectSectionState);
  const [itemsOpen, setItemsOpen] = useState<Record<string, boolean>>({});
  return (
    <ProjectSidebar
      {...SIDEBAR_CALLBACKS}
      activeSceneId={activeSceneId}
      activeTab={activeTab}
      diagnostics={[]}
      onToggleSection={(id) =>
        setSections((current) => ({ ...current, [id]: !current[id] }))
      }
      onToggleSidebarItem={(key, defaultOpen = true) =>
        setItemsOpen((current) => ({ ...current, [key]: !(current[key] ?? defaultOpen) }))
      }
      project={project}
      sectionOpen={sections}
      sidebarItemOpen={itemsOpen}
      visualLibrary={handlers}
      {...overrides}
    />
  );
}

function groupToggle(sceneId: string): HTMLElement {
  return screen.getByRole("button", { name: `场景 ${sceneId} 的固定文本块` });
}

function groupRegion(toggle: HTMLElement): HTMLElement {
  const region = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
  if (region === null) throw new Error("missing group region");
  return region;
}

describe("scene text block groups", () => {
  it("lists a legacy single-scene text under the scene that uses it, with no layout pin", () => {
    const project = threeScenes();
    useText(project, "side", "label");
    render(<Harness project={project} />);

    const side = groupRegion(groupToggle("side"));
    expect(within(side).getByRole("button", { name: "编辑固定文本块 label" })).toBeInTheDocument();
    expect(within(groupRegion(groupToggle("main"))).queryByText("label")).toBeNull();
    // Particles stay in the project panel; neither fallback group is needed.
    expect(screen.queryByRole("button", { name: "snow" })).toBeNull();
    expect(screen.queryByText(/共享文本块/)).toBeNull();
    expect(screen.queryByText(/未归属文本块/)).toBeNull();
    expect(project.layout.scenes.side).toBeUndefined();
  });

  it("shows pinned unused texts in their scene and keeps shared / unassigned texts apart", () => {
    const project = threeScenes();
    addText(project, "intro");
    addText(project, "loose");
    project.layout.scenes.epilogue = { nodes: {}, viewport: null, text_block_ids: ["intro"] };
    useText(project, "main", "label");
    useText(project, "side", "label");
    render(<Harness project={project} />);

    expect(
      within(groupRegion(groupToggle("epilogue"))).getByRole("button", { name: "编辑固定文本块 intro" }),
    ).toBeInTheDocument();

    const shared = screen.getByRole("button", { name: "共享文本块 · 1" });
    const sharedRegion = groupRegion(shared);
    expect(within(sharedRegion).getByRole("button", { name: "编辑固定文本块 label" })).toBeInTheDocument();
    // One definition, listed once, with the scenes that use it.
    expect(within(sharedRegion).getByText(/main、side/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "编辑固定文本块 label" })).toHaveLength(1);

    const unassigned = screen.getByRole("button", { name: "未归属文本块 · 1" });
    expect(
      within(groupRegion(unassigned)).getByRole("button", { name: "编辑固定文本块 loose" }),
    ).toBeInTheDocument();
  });

  it("hides the fallback groups while filtering scenes", () => {
    const project = threeScenes();
    addText(project, "loose");
    render(<Harness project={project} />);
    expect(screen.getByRole("button", { name: "未归属文本块 · 2" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索场景" }), { target: { value: "side" } });
    expect(screen.queryByRole("button", { name: /未归属文本块/ })).toBeNull();
    expect(screen.getByRole("button", { name: "场景 side 的固定文本块" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "场景 main 的固定文本块" })).toBeNull();
  });

  it("opens only the active scene and scenes with texts by default, and the author's choice wins", () => {
    const project = threeScenes();
    useText(project, "side", "label");
    const { rerender } = render(<Harness project={project} />);

    // main is active (empty) and side holds a text: open; epilogue is empty: closed.
    expect(groupToggle("main")).toHaveAttribute("aria-expanded", "true");
    expect(groupToggle("side")).toHaveAttribute("aria-expanded", "true");
    expect(groupToggle("epilogue")).toHaveAttribute("aria-expanded", "false");
    expect(groupRegion(groupToggle("epilogue"))).toHaveAttribute("hidden");
    // Collapsed groups keep their create button reachable.
    expect(screen.getByRole("button", { name: "在场景 epilogue 新建固定文本块" })).toBeInTheDocument();

    // The first click on a default-closed group opens it...
    fireEvent.click(groupToggle("epilogue"));
    expect(groupToggle("epilogue")).toHaveAttribute("aria-expanded", "true");
    // ...and a default-open group that was collapsed stays collapsed when the
    // active scene moves elsewhere.
    fireEvent.click(groupToggle("main"));
    expect(groupToggle("main")).toHaveAttribute("aria-expanded", "false");
    rerender(<Harness activeSceneId="epilogue" project={project} />);
    expect(groupToggle("main")).toHaveAttribute("aria-expanded", "false");
    expect(groupToggle("epilogue")).toHaveAttribute("aria-expanded", "true");
  });

  it("creates a text from a scene's button through the validated dialog", () => {
    const handlers = library();
    render(<Harness handlers={handlers} project={threeScenes()} />);

    fireEvent.click(screen.getByRole("button", { name: "在场景 side 新建固定文本块" }));
    const input = screen.getByRole("textbox", { name: "新固定文本块 ID" });
    expect((input as HTMLInputElement).value).toBe("text_2");

    // An id owned by another resource is refused inline and nothing is created.
    fireEvent.change(input, { target: { value: "dot" } });
    expect(screen.getByRole("alert")).toHaveTextContent("已被素材使用");
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(handlers.onCreate).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "side.title" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(handlers.onCreate).toHaveBeenCalledExactlyOnceWith("textBlock", "side.title", "side");
    expect(screen.queryByRole("textbox", { name: "新固定文本块 ID" })).toBeNull();
  });

  it("opens a text with the scene it was listed under, and none for fallback groups", () => {
    const handlers = library();
    const project = threeScenes();
    addText(project, "loose");
    useText(project, "side", "label");
    render(<Harness handlers={handlers} project={project} />);

    fireEvent.click(screen.getByRole("button", { name: "编辑固定文本块 label" }));
    expect(handlers.onEdit).toHaveBeenLastCalledWith("textBlock", "label", "side");
    fireEvent.click(screen.getByRole("button", { name: "编辑固定文本块 loose" }));
    expect(handlers.onEdit).toHaveBeenLastCalledWith("textBlock", "loose", undefined);
  });

  it("renames, copies and removes through each row's menu", () => {
    const handlers = library();
    const project = threeScenes();
    useText(project, "main", "label");
    render(<Harness handlers={handlers} project={project} />);

    const row = (): HTMLElement => {
      const element = screen
        .getByRole("button", { name: "编辑固定文本块 label" })
        .closest(".library-row");
      if (!(element instanceof HTMLElement)) throw new Error("missing row");
      return element;
    };
    const openMenu = (): HTMLElement => {
      fireEvent.keyDown(within(row()).getByRole("button", { name: "更多操作" }), { key: "Enter" });
      return screen.getByRole("menu");
    };

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "创建副本" }));
    expect(handlers.onDuplicate).toHaveBeenCalledWith("textBlock", "label");

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "从项目移除" }));
    expect(handlers.onDelete).toHaveBeenCalledWith("textBlock", "label");

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "重命名 ID…" }));
    const input = screen.getByRole("textbox", { name: "新的固定文本块 ID" });
    expect((input as HTMLInputElement).value).toBe("label");
    fireEvent.change(input, { target: { value: "headline" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(handlers.onRename).toHaveBeenCalledExactlyOnceWith("textBlock", "label", "headline");
  });

  it("keeps the original dialog open when the host refuses the id", () => {
    const handlers = library();
    handlers.onCreate.mockReturnValue(false);
    render(<Harness handlers={handlers} project={threeScenes()} />);
    fireEvent.click(screen.getByRole("button", { name: "在场景 main 新建固定文本块" }));
    const input = screen.getByRole("textbox", { name: "新固定文本块 ID" });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(handlers.onCreate).toHaveBeenCalledTimes(1);
    // The host reports why (toast); the dialog stays so the id can be fixed.
    expect(screen.getByRole("textbox", { name: "新固定文本块 ID" })).toBeInTheDocument();
  });

  it("omits every text group when the host provides no visual library", () => {
    render(<Harness overrides={{ visualLibrary: undefined }} project={threeScenes()} />);
    expect(screen.queryByRole("button", { name: /固定文本块/ })).toBeNull();
  });
});

describe("particles in the project panel", () => {
  it("lists particles as a global resource, not texts", () => {
    const project = threeScenes();
    render(<Harness activeTab="project" project={project} />);
    expect(screen.getByRole("button", { name: "粒子效果" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑粒子效果 snow" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "固定文本块" })).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑固定文本块 label" })).toBeNull();
  });
});
