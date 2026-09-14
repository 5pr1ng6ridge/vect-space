// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { editorApi } from "../api";
import type { EditorProject } from "../types";
import { ProjectSidebar, type ImportDraft } from "./ProjectSidebar";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function projectWith(asset: "none" | "ambience" = "none"): EditorProject {
  const hasAsset = asset === "ambience";
  return {
    root: "C:/game",
    manifest: {
      schema_version: 2,
      content_version: "test",
      entry_scene: "main",
      default_locale: "zh-CN",
      variables: {},
      characters: {},
      assets: hasAsset
        ? {
            "ambience.forest": {
              kind: "ambience",
              path: "audio/ambience.forest.ogg",
            },
          }
        : {},
      scenes: ["scenes/main.yaml"],
      ui_motions: [],
      ui_motion_defaults: {},
    },
    scenes: [
      {
        path: "scenes/main.yaml",
        definition: {
          schema_version: 2,
          id: "main",
          entry: "start",
          nodes: hasAsset
            ? {
                start: {
                  type: "ambience",
                  slot: "slot_2",
                  action: "start",
                  asset: "ambience.forest",
                  volume: 0.6,
                  duration_ms: 0,
                  await: false,
                  next: "end",
                },
              }
            : {},
        },
      },
    ],
    ui_motions: [],
    layout: { version: 1, scenes: {} },
    assets: hasAsset
      ? [
          {
            id: "ambience.forest",
            kind: "ambience",
            path: "audio/ambience.forest.ogg",
            absolute_path: "C:/game/audio/ambience.forest.ogg",
            size_bytes: "12",
            metadata: {
              format: "audio/ogg",
              width: null,
              height: null,
              duration_ms: "1000",
              channels: 2,
              sample_rate: 44_100,
              font_family: null,
              font_style: null,
            },
          },
        ]
      : [],
    diagnostics: [],
    fingerprint: "fingerprint",
  };
}

function renderSidebar(
  project: EditorProject,
  onImportAssets: (items: ImportDraft[]) => Promise<void> = () =>
    Promise.resolve(),
  onRemoveAsset: (id: string) => boolean = () => false,
) {
  return render(
    <ProjectSidebar
      activeSceneId="main"
      activeTab="assets"
      diagnostics={[]}
      onAddCharacter={() => true}
      onAddScene={() => true}
      onAddVariable={() => true}
      onChangeAction={() => undefined}
      onChangeCharacter={() => undefined}
      onChangeVariable={() => undefined}
      onCreateAction={() => true}
      onCreateButtonTemplate={() => undefined}
      onCreateImageAnimation={() => true}
      onCreateUiMotion={() => undefined}
      onDeleteAction={() => undefined}
      onDeleteButtonTemplate={() => undefined}
      onDeleteCharacter={() => undefined}
      onDeleteScene={() => undefined}
      onDeleteUiMotion={() => undefined}
      onDeleteVariable={() => undefined}
      onDuplicateAction={() => undefined}
      onDuplicateButtonTemplate={() => undefined}
      onEditActionKeyframes={() => undefined}
      onEditButtonTemplate={() => undefined}
      onEditUiMotion={() => undefined}
      onImportAssets={onImportAssets}
      onManifestChange={() => undefined}
      onNavigate={() => undefined}
      onRemoveAsset={onRemoveAsset}
      onRenameAction={() => true}
      onRenameCharacter={() => true}
      onRenameScene={() => true}
      onRenameVariable={() => true}
      onSelectScene={() => undefined}
      onSelectAsset={() => undefined}
      project={project}
    />,
  );
}

describe("ambience editor interactions", () => {
  it("lets the host inspect, explicitly choose ambience, and stage an audio import", async () => {
    const inspected = {
      inspection_id: "inspection-1",
      source_name: "ambience.forest.ogg",
      detected_format: "audio/ogg",
      suggested_kind: null,
      size_bytes: "12",
      sha256: "hash",
      metadata: {
        format: "audio/ogg",
        width: null,
        height: null,
        duration_ms: "1000",
        channels: 2,
        sample_rate: 44_100,
        font_family: null,
        font_style: null,
      },
      reuse_candidates: [],
      diagnostics: [],
    };
    vi.spyOn(editorApi, "pickAssetFiles").mockResolvedValue([
      "C:/incoming/ambience.forest.ogg",
    ]);
    vi.spyOn(editorApi, "inspectAssetImports").mockResolvedValue([inspected]);
    const imported: ImportDraft[] = [];
    renderSidebar(projectWith(), (items) => {
      imported.push(...items);
      return Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "＋" }));
    await screen.findByRole("dialog", { name: "导入素材" });
    fireEvent.change(
      screen.getByRole("combobox", { name: "ambience.forest.ogg 类型" }),
      { target: { value: "ambience" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "导入清单" }));

    await waitFor(() => expect(imported).toHaveLength(1));
    expect(imported[0]).toMatchObject({
      kind: "ambience",
      fileName: "ambience.forest.ogg",
      inspectionId: "inspection-1",
      sourcePath: "C:/incoming/ambience.forest.ogg",
    });
  });

  it("shows the ambience reference and leaves deletion to the host guard", () => {
    const remove = vi.fn(() => false);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderSidebar(projectWith("ambience"), undefined, remove);

    fireEvent.click(screen.getByRole("button", { name: /ambience\.forest/ }));
    expect(screen.getByText(/该素材仍被引用/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "从清单移除" }));

    expect(confirm).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("ambience.forest");
    expect(screen.getAllByText("ambience.forest").length).toBeGreaterThan(0);
  });
});
