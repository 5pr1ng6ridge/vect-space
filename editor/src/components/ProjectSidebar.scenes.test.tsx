// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditorProject } from "../types";
import { ProjectSidebar } from "./ProjectSidebar";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));

afterEach(cleanup);

function project(): EditorProject {
  const scene = (id: string, role?: "secondary") => ({
    path: `scenes/${id}.yaml`,
    definition: {
      ...(role === undefined ? {} : { window_role: role }),
      schema_version: 2,
      id,
      entry: "s",
      nodes: { s: { type: "end" as const } },
    },
  });
  return {
    root: "C:/game",
    manifest: {
      schema_version: 2,
      content_version: "test",
      entry_scene: "main",
      default_locale: "zh-CN",
      variables: {},
      characters: {},
      assets: {},
      scenes: ["scenes/main.yaml", "scenes/side.yaml", "scenes/two.yaml"],
      ui_motions: [],
      ui_motion_defaults: {},
    },
    scenes: [scene("main"), scene("side", "secondary"), scene("two")],
    ui_motions: [],
    layout: { version: 1, scenes: {} },
    assets: [],
    diagnostics: [],
    fingerprint: "test",
  };
}

const NOOP = {
  onAddCharacter: () => true,
  onAddScene: () => true,
  onAddVariable: () => true,
  onChangeCharacter: () => undefined,
  onChangeVariable: () => undefined,
  onCreateAction: () => true,
  onCreateButtonTemplate: () => undefined,
  onCreateImageAnimation: () => true,
  onCreateUiMotion: () => undefined,
  onDeleteAction: () => undefined,
  onDeleteButtonTemplate: () => undefined,
  onDeleteCharacter: () => undefined,
  onDeleteScene: () => undefined,
  onDeleteUiMotion: () => undefined,
  onDeleteVariable: () => undefined,
  onDuplicateAction: () => undefined,
  onDuplicateButtonTemplate: () => undefined,
  onEditActionKeyframes: () => undefined,
  onEditButtonTemplate: () => undefined,
  onEditUiMotion: () => undefined,
  onImportAssets: () => Promise.resolve(),
  onManifestChange: () => undefined,
  onNavigate: () => undefined,
  onRemoveAsset: () => false,
  onRenameAction: () => true,
  onRenameCharacter: () => true,
  onRenameScene: () => true,
  onRenameVariable: () => true,
  onSelectAsset: () => undefined,
  onSelectScene: () => undefined,
};

describe("scene purpose in the project panel", () => {
  it("marks secondary Scenes and switches a Scene's purpose", () => {
    const onSetSceneRole = vi.fn();
    render(
      <ProjectSidebar
        {...NOOP}
        activeSceneId="main"
        activeTab="scenes"
        diagnostics={[]}
        hideTabs
        onSetSceneRole={onSetSceneRole}
        project={project()}
      />,
    );
    expect(screen.getByText(/副窗口专用/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "设为主窗口专用" }));
    expect(onSetSceneRole).toHaveBeenCalledWith("side", "main");
    fireEvent.click(
      screen.getAllByRole("button", { name: "设为副窗口专用" })[1],
    );
    expect(onSetSceneRole).toHaveBeenCalledWith("two", "secondary");
  });

  it("creates a secondary Scene from its own button", () => {
    const onAddScene = vi.fn(() => true);
    render(
      <ProjectSidebar
        {...NOOP}
        activeSceneId="main"
        activeTab="scenes"
        diagnostics={[]}
        hideTabs
        onAddScene={onAddScene}
        project={project()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "添加副窗口场景" }));
    fireEvent.click(screen.getByRole("button", { name: /确定|创建|确认/ }));
    expect(onAddScene).toHaveBeenCalledWith("new_side_scene", "secondary");
  });

  it("does not offer a secondary Scene as the project entry", () => {
    render(
      <ProjectSidebar
        {...NOOP}
        activeSceneId="main"
        activeTab="project"
        diagnostics={[]}
        hideTabs
        project={project()}
      />,
    );
    const select = screen.getByLabelText("项目入口场景");
    const ids = Array.from(select.querySelectorAll("option")).map(
      (option) => option.value,
    );
    expect(ids).toEqual(["main", "two"]);
  });
});
