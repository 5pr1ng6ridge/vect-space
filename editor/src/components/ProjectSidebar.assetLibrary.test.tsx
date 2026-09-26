// @vitest-environment jsdom
/**
 * Asset library UI: virtual folders, display names, hidden policy, the
 * searchable shared chooser seams and same-ID/new-path replacement.
 *
 * The harness mimics the App shell: `onChangeAssetLayout` is applied to a
 * stateful project exactly like `App.commit` (`draft.layout = mutate(...)`)
 * and an explicit undo button restores the previous layout, so these tests
 * exercise the real mutation/undo contract rather than a stub.
 */
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useRef, useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { editorApi } from "../api";
import type { AssetInspection, EditorLayout, EditorProject } from "../types";
import { ProjectSidebar, type ImportDraft } from "./ProjectSidebar";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function assetProject(): EditorProject {
  return {
    root: "C:/game",
    manifest: {
      schema_version: 2,
      content_version: "test",
      entry_scene: "main",
      default_locale: "zh-CN",
      variables: {},
      characters: {},
      assets: {
        "bg.room": { kind: "background", path: "backgrounds/room.png" },
        "bg.old": { kind: "background", path: "backgrounds/old.png" },
        "anim.blink": { kind: "sprite", animation: "blink" },
      },
      scenes: [],
      ui_motions: [],
      ui_motion_defaults: {},
    },
    scenes: [],
    ui_motions: [],
    layout: {
      version: 1,
      scenes: {},
      asset_folders: {
        archive: { parent_id: null, name: "归档", order: 0 },
      },
      asset_metadata: {
        "bg.old": {
          hidden: true,
          folder_id: "archive",
          display_name: "旧客厅",
        },
      },
    },
    assets: [
      {
        id: "bg.room",
        kind: "background",
        path: "backgrounds/room.png",
        absolute_path: "C:/game/assets/backgrounds/room.png",
        size_bytes: "10",
        metadata: null,
      },
      {
        id: "bg.old",
        kind: "background",
        path: "backgrounds/old.png",
        absolute_path: "C:/game/assets/backgrounds/old.png",
        size_bytes: "10",
        metadata: null,
      },
      {
        id: "anim.blink",
        kind: "sprite",
        animation: "blink",
        absolute_path: "C:/game/assets/sprites/frame0.png",
        size_bytes: "10",
        metadata: null,
      },
    ],
    diagnostics: [],
    fingerprint: "fp",
  };
}

const SIDEBAR_CALLBACKS = {
  onAddCharacter: () => true,
  onAddScene: () => true,
  onAddVariable: () => true,
  onChangeAction: () => undefined,
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

interface HarnessOptions {
  onImportAssets?: (items: ImportDraft[]) => Promise<void>;
  onRemoveAsset?: (id: string) => boolean;
  pendingAssetIds?: readonly string[];
  onLayoutCommit?: (label: string) => void;
  /**
   * Mimic App.importAssets by applying a staged row to the stateful project
   * (path + absolute_path) so a *second* replacement sees the current state.
   */
  stageImports?: boolean;
}

/** Mimics App: layout metadata commits and their undo stack. */
function AssetLibraryHarness({
  overrides,
  project: initial,
}: {
  overrides?: HarnessOptions;
  project: EditorProject;
}): ReactElement {
  const [project, setProject] = useState(initial);
  const [reserved, setReserved] = useState<Record<string, string[]>>({});
  const history = useRef<EditorLayout[]>([]);
  return (
    <>
      <button
        onClick={() => {
          const previous = history.current.pop();
          if (previous !== undefined)
            setProject((current) => ({ ...current, layout: previous }));
        }}
        type="button"
      >
        撤销布局
      </button>
      <ProjectSidebar
        {...SIDEBAR_CALLBACKS}
        activeSceneId="main"
        activeTab="assets"
        diagnostics={[]}
        onChangeAssetLayout={(mutate, label) => {
          history.current.push(project.layout);
          overrides?.onLayoutCommit?.(label);
          setProject((current) => ({
            ...current,
            layout: mutate(current.layout),
          }));
        }}
        onImportAssets={async (items) => {
          await overrides?.onImportAssets?.(items);
          if (overrides?.stageImports !== true) return;
          // Mirror App: remember the original and every staged destination so a
          // later replacement cannot reuse any of them.
          const reservedAdds: Record<string, string[]> = {};
          for (const item of items) {
            const existing = project.assets.find(
              (asset) => asset.id === item.id,
            );
            const paths = new Set<string>(reserved[item.id] ?? []);
            const oldPath =
              existing?.path ??
              project.manifest.assets[item.id]?.path ??
              undefined;
            if (oldPath !== undefined) paths.add(oldPath);
            paths.add(`backgrounds/${item.fileName}`);
            reservedAdds[item.id] = [...paths];
          }
          setReserved((current) => ({ ...current, ...reservedAdds }));
          setProject((current) => {
            const next: EditorProject = {
              ...current,
              manifest: {
                ...current.manifest,
                assets: { ...current.manifest.assets },
              },
              assets: current.assets.map((asset) => ({ ...asset })),
            };
            for (const item of items) {
              // The host publishes the staged binary under the kind folder;
              // the absolute path is a temp path until save.
              const path = `backgrounds/${item.fileName}`;
              next.manifest.assets[item.id] = { kind: item.kind, path };
              const index = next.assets.findIndex(
                (asset) => asset.id === item.id,
              );
              const row = {
                id: item.id,
                kind: item.kind,
                path,
                absolute_path: `C:/tmp/imports/${item.fileName}`,
                size_bytes: "1",
              };
              if (index === -1) next.assets.push(row);
              else next.assets[index] = { ...next.assets[index], ...row };
            }
            return next;
          });
        }}
        onRemoveAsset={overrides?.onRemoveAsset ?? (() => false)}
        pendingAssetIds={overrides?.pendingAssetIds}
        reservedAssetPaths={reserved}
        project={project}
      />
    </>
  );
}

function renderAssets(overrides?: HarnessOptions): void {
  render(
    <AssetLibraryHarness overrides={overrides} project={assetProject()} />,
  );
}

function fakeDataTransfer(): {
  data: Record<string, string>;
  getData(type: string): string;
  setData(type: string, value: string): void;
  effectAllowed: string;
} {
  const data: Record<string, string> = {};
  return {
    data,
    getData: (type: string) => data[type] ?? "",
    setData: (type: string, value: string) => {
      data[type] = value;
    },
    effectAllowed: "none",
  };
}

function assetRow(id: string): HTMLElement {
  return screen.getByRole("button", {
    name: new RegExp(id.replace(".", "\\.")),
  });
}

describe("asset explorer interactions", () => {
  it("rubber-band selects visible rows from the tree background", () => {
    const { container } = render(
      <AssetLibraryHarness project={assetProject()} />,
    );
    const tree = container.querySelector<HTMLElement>(".asset-explorer-tree");
    if (tree === null) throw new Error("missing explorer");
    const rect = (top: number, bottom: number): DOMRect => ({
      left: 0,
      top,
      right: 200,
      bottom,
      width: 200,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    });
    vi.spyOn(tree, "getBoundingClientRect").mockReturnValue(rect(0, 200));
    vi.spyOn(assetRow("bg.room"), "getBoundingClientRect").mockReturnValue(
      rect(20, 40),
    );
    vi.spyOn(assetRow("anim.blink"), "getBoundingClientRect").mockReturnValue(
      rect(60, 80),
    );
    fireEvent.pointerDown(tree, { button: 0, clientX: 3, clientY: 3 });
    fireEvent.pointerMove(window, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(window);
    expect(screen.getByLabelText("批量移动到文件夹")).toBeInTheDocument();
    expect(assetRow("bg.room")).toHaveClass("active");
    expect(assetRow("anim.blink")).toHaveClass("active");
  });

  it("opens a context menu and reveals a registered file by ID", async () => {
    const reveal = vi.spyOn(editorApi, "revealAsset").mockResolvedValue();
    renderAssets();
    fireEvent.contextMenu(assetRow("bg.room"), { clientX: 20, clientY: 30 });
    const menu = screen.getByRole("menu", { name: "素材操作" });
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "打开文件所在位置" }),
    );
    await waitFor(() => expect(reveal).toHaveBeenCalledWith("bg.room"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("mounts a closable detail as a sibling panel when the shell provides one", () => {
    const { container } = render(
      <>
        <aside id="asset-detail-column" />
        <AssetLibraryHarness project={assetProject()} />
      </>,
    );
    fireEvent.click(assetRow("bg.room"));
    const column = container.querySelector("#asset-detail-column");
    expect(column).toHaveTextContent("素材详情");
    expect(column).toHaveTextContent("bg.room");
    fireEvent.click(screen.getByRole("button", { name: "关闭素材详情" }));
    expect(column).toBeEmptyDOMElement();
  });
});

describe("virtual asset folders", () => {
  it("creates a root folder and a nested subfolder", () => {
    const onLayoutCommit = vi.fn();
    renderAssets({ onLayoutCommit });

    fireEvent.click(screen.getByRole("button", { name: "新建根文件夹" }));
    fireEvent.change(screen.getByLabelText("新建文件夹"), {
      target: { value: "  背景  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));

    const folderButton = screen.getByRole("button", { name: "背景" });
    expect(folderButton).toBeInTheDocument();
    expect(onLayoutCommit).toHaveBeenLastCalledWith("新建素材文件夹");

    fireEvent.click(
      screen.getByRole("button", { name: "在 背景 下新建子文件夹" }),
    );
    fireEvent.change(screen.getByLabelText("新建文件夹"), {
      target: { value: "旧版本" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.getByRole("button", { name: "旧版本" })).toBeInTheDocument();

    // Collapsing hides the child, expanding brings it back.
    fireEvent.click(screen.getByRole("button", { name: "折叠文件夹 背景" }));
    expect(screen.queryByRole("button", { name: "旧版本" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开文件夹 背景" }));
    expect(screen.getByRole("button", { name: "旧版本" })).toBeInTheDocument();
  });

  it("renames a folder and the change is undoable", () => {
    renderAssets();
    fireEvent.click(screen.getByRole("button", { name: "重命名文件夹 归档" }));
    fireEvent.change(screen.getByLabelText("重命名文件夹"), {
      target: { value: "已归档" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.getByRole("button", { name: "已归档" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "归档" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "撤销布局" }));
    expect(screen.getByRole("button", { name: "归档" })).toBeInTheDocument();
  });

  it("moves an asset between folders through the keyboard-accessible select", () => {
    const onLayoutCommit = vi.fn();
    renderAssets({ onLayoutCommit });
    fireEvent.click(assetRow("bg.room"));
    fireEvent.change(screen.getByLabelText("移动到文件夹"), {
      target: { value: "archive" },
    });
    expect(onLayoutCommit).toHaveBeenLastCalledWith("移动素材到文件夹");
    // The row now reports its virtual folder without touching the path.
    expect(assetRow("bg.room")).toHaveTextContent("目录：归档");

    fireEvent.click(screen.getByRole("button", { name: "撤销布局" }));
    expect(assetRow("bg.room")).not.toHaveTextContent("目录：归档");
  });

  it("moves an asset with drag and drop and refuses a folder cycle", () => {
    const onLayoutCommit = vi.fn();
    renderAssets({ onLayoutCommit });

    fireEvent.click(
      screen.getByRole("button", { name: "在 归档 下新建子文件夹" }),
    );
    fireEvent.change(screen.getByLabelText("新建文件夹"), {
      target: { value: "子级" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));

    const dt = fakeDataTransfer();
    fireEvent.dragStart(assetRow("bg.room"), { dataTransfer: dt });
    fireEvent.drop(screen.getByRole("button", { name: "子级" }), {
      dataTransfer: dt,
    });
    expect(onLayoutCommit).toHaveBeenLastCalledWith("移动素材到文件夹");
    expect(assetRow("bg.room")).toHaveTextContent("目录：归档/子级");

    // Reparenting 归档 under its own child would create a cycle.
    const folderDt = fakeDataTransfer();
    fireEvent.dragStart(screen.getByRole("button", { name: "归档" }), {
      dataTransfer: folderDt,
    });
    fireEvent.drop(screen.getByRole("button", { name: "子级" }), {
      dataTransfer: folderDt,
    });
    expect(screen.getByRole("alert")).toHaveTextContent("子文件夹");
  });

  it("dissolves a folder without deleting its registered assets", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAssets();
    fireEvent.click(screen.getByRole("button", { name: "删除文件夹 归档" }));
    expect(screen.queryByRole("button", { name: "归档" })).toBeNull();
    expect(assetRow("bg.old")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "撤销布局" }));
    expect(screen.getByRole("button", { name: "归档" })).toBeInTheDocument();
  });

  it("drags multiple selected assets as one layout edit", () => {
    const onLayoutCommit = vi.fn();
    renderAssets({ onLayoutCommit });
    fireEvent.click(assetRow("bg.room"));
    fireEvent.click(assetRow("bg.old"), { ctrlKey: true });
    const dt = fakeDataTransfer();
    fireEvent.dragStart(assetRow("bg.old"), { dataTransfer: dt });
    fireEvent.drop(screen.getByRole("button", { name: "归档" }), {
      dataTransfer: dt,
    });
    expect(onLayoutCommit).toHaveBeenLastCalledWith("批量移动素材");
    expect(assetRow("bg.room")).toHaveTextContent("目录：归档");
    expect(assetRow("bg.old")).toHaveTextContent("目录：归档");
  });

  it("moves a folder through the parent dialog", () => {
    renderAssets();
    fireEvent.click(
      screen.getByRole("button", { name: "在 归档 下新建子文件夹" }),
    );
    fireEvent.change(screen.getByLabelText("新建文件夹"), {
      target: { value: "子级" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));

    fireEvent.click(screen.getByRole("button", { name: "移动文件夹 子级" }));
    fireEvent.change(screen.getByLabelText("目标父文件夹"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.getByRole("button", { name: "子级" })).toBeInTheDocument();
    // Root-level folders have no ancestor row indentation.
  });
});

describe("display name, hidden policy and search", () => {
  it("renames the display name while keeping the source path visible", () => {
    const onLayoutCommit = vi.fn();
    renderAssets({ onLayoutCommit });
    fireEvent.click(assetRow("bg.room"));
    fireEvent.change(screen.getByLabelText("显示名称"), {
      target: { value: "客厅" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存显示名称" }));
    expect(onLayoutCommit).toHaveBeenLastCalledWith("重命名素材显示名称");
    expect(screen.getAllByText("客厅").length).toBeGreaterThan(0);
    // The stable id and the source path stay visible for disambiguation.
    expect(screen.getAllByText("backgrounds/room.png").length).toBeGreaterThan(
      0,
    );
  });

  it("searches by display name and by stable id", () => {
    renderAssets();
    const search = screen.getByLabelText("搜索素材");
    fireEvent.change(search, { target: { value: "旧客厅" } });
    expect(assetRow("bg.old")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /anim\.blink/ })).toBeNull();

    fireEvent.change(search, { target: { value: "anim.blink" } });
    expect(
      screen.getByRole("button", { name: /anim\.blink/ }),
    ).toBeInTheDocument();
  });

  it("keeps a hidden asset manageable and toggles its hidden flag", () => {
    const onLayoutCommit = vi.fn();
    renderAssets({ onLayoutCommit });
    // Hidden assets stay in the manager and are marked.
    expect(assetRow("bg.old")).toHaveTextContent("已隐藏");

    fireEvent.click(assetRow("bg.old"));
    fireEvent.click(screen.getByRole("button", { name: "取消隐藏" }));
    expect(onLayoutCommit).toHaveBeenLastCalledWith("取消隐藏素材");
    expect(assetRow("bg.old")).not.toHaveTextContent("已隐藏");

    fireEvent.click(screen.getByRole("button", { name: "隐藏素材" }));
    expect(onLayoutCommit).toHaveBeenLastCalledWith("隐藏素材");
    expect(assetRow("bg.old")).toHaveTextContent("已隐藏");
  });

  it("hides hidden assets when the manager filter is off, but never the selection", () => {
    renderAssets();
    fireEvent.click(assetRow("bg.old"));
    fireEvent.click(screen.getByLabelText("显示已隐藏"));
    // The currently selected hidden asset stays visible/valid...
    expect(assetRow("bg.old")).toBeInTheDocument();
    // ...while any other hidden asset drops out of the list once selection
    // moves away.
    fireEvent.click(assetRow("bg.room"));
    expect(screen.queryByRole("button", { name: /bg\.old/ })).toBeNull();
    fireEvent.click(screen.getByLabelText("显示已隐藏"));
    expect(assetRow("bg.old")).toBeInTheDocument();
  });

  it("shows a pending badge for a staged replacement", () => {
    renderAssets({ pendingAssetIds: ["bg.room"] });
    expect(assetRow("bg.room")).toHaveTextContent("待保存");
  });

  it("expands folders in the explorer while keeping root assets visible", () => {
    renderAssets();
    expect(assetRow("bg.old")).toBeInTheDocument();
    expect(assetRow("bg.room")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /折叠文件夹 归档/ }));
    expect(screen.queryByRole("button", { name: /bg\.old/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    expect(assetRow("bg.old")).toBeInTheDocument();
  });
});

describe("same-ID / new-path replacement", () => {
  function inspection(
    overrides: Partial<AssetInspection> = {},
  ): AssetInspection {
    return {
      inspection_id: "inspection-1",
      source_name: "room_v2.png",
      detected_format: "Png",
      suggested_kind: "background",
      size_bytes: "42",
      sha256: "deadbeef",
      metadata: {
        format: "Png",
        width: 64,
        height: 64,
        duration_ms: null,
        channels: null,
        sample_rate: null,
        font_family: null,
        font_style: null,
      },
      reuse_candidates: [],
      diagnostics: [],
      ...overrides,
    };
  }

  it("stages a replacement that keeps the logical id on a new path", async () => {
    vi.spyOn(editorApi, "pickAssetFiles").mockResolvedValue([
      "C:/incoming/room_v2.png",
    ]);
    vi.spyOn(editorApi, "inspectAssetImports").mockResolvedValue([
      inspection(),
    ]);
    const imported: ImportDraft[] = [];
    renderAssets({
      onImportAssets: (items) => {
        imported.push(...items);
        return Promise.resolve();
      },
    });

    fireEvent.click(assetRow("bg.room"));
    fireEvent.click(screen.getByRole("button", { name: "替换二进制文件…" }));
    const dialog = await screen.findByRole("dialog", {
      name: "替换素材二进制",
    });
    // Logical id and kind are locked; only the file name can change.
    expect(
      within(dialog).getByText("bg.room（background）"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("room_v2.png 逻辑 ID")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "导入清单" }));

    await waitFor(() => expect(imported).toHaveLength(1));
    expect(imported[0]).toMatchObject({
      id: "bg.room",
      kind: "background",
      fileName: "room_v2.png",
      replaceId: "bg.room",
      inspectionId: "inspection-1",
    });
  });

  it("rejects a same-path or different-format file with an explanation", async () => {
    vi.spyOn(editorApi, "pickAssetFiles").mockResolvedValue([
      "C:/incoming/room.jpg",
    ]);
    vi.spyOn(editorApi, "inspectAssetImports").mockResolvedValue([
      inspection({ source_name: "room.jpg", detected_format: "Jpeg" }),
    ]);
    renderAssets();
    fireEvent.click(assetRow("bg.room"));
    fireEvent.click(screen.getByRole("button", { name: "替换二进制文件…" }));
    const dialog = await screen.findByRole("dialog", {
      name: "替换素材二进制",
    });
    expect(
      within(dialog).getByText(/新文件必须与旧文件格式一致/),
    ).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("room.jpg 文件名"), {
      target: { value: "room.png" },
    });
    expect(
      within(dialog).getByText(/新文件路径必须与当前登记路径不同/),
    ).toBeInTheDocument();
  });

  it("forbids the original and earlier staged paths on a repeated replacement", async () => {
    const pick = vi.spyOn(editorApi, "pickAssetFiles");
    const inspect = vi.spyOn(editorApi, "inspectAssetImports");
    const imported: ImportDraft[] = [];
    renderAssets({
      stageImports: true,
      onImportAssets: (items) => {
        imported.push(...items);
        return Promise.resolve();
      },
    });

    // First replacement: backgrounds/room.png -> backgrounds/room_v2.png.
    pick.mockResolvedValue(["C:/incoming/room_v2.png"]);
    inspect.mockResolvedValue([inspection({ source_name: "room_v2.png" })]);
    fireEvent.click(assetRow("bg.room"));
    fireEvent.click(screen.getByRole("button", { name: "替换二进制文件…" }));
    let dialog = await screen.findByRole("dialog", {
      name: "替换素材二进制",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "导入清单" }));
    await waitFor(() => expect(imported).toHaveLength(1));
    await waitFor(() =>
      expect(assetRow("bg.room")).toHaveTextContent("room_v2.png"),
    );

    // The original path stays reserved after the row moved to the staged path.
    // Picking the original name must NOT be accepted (the host reserves it),
    // and the picker prefills a free `_vN` suggestion instead.
    pick.mockResolvedValue(["C:/incoming/room.png"]);
    inspect.mockResolvedValue([inspection({ source_name: "room.png" })]);
    fireEvent.click(screen.getByRole("button", { name: "替换二进制文件…" }));
    dialog = await screen.findByRole("dialog", { name: "替换素材二进制" });
    const fileName =
      within(dialog).getByLabelText<HTMLInputElement>("room_v3.png 文件名");
    expect(fileName).toHaveValue("room_v3.png");
    expect(within(dialog).queryByText(/先前暂存的替换保留/)).toBeNull();

    // Typing the original or the earlier staged name reports the collision
    // before applying (the same rule the host enforces).
    fireEvent.change(fileName, { target: { value: "room.png" } });
    expect(
      within(dialog).getByText(/原始文件或先前暂存的替换保留/),
    ).toBeInTheDocument();
    fireEvent.change(fileName, { target: { value: "room_v2.png" } });
    // The staged name is also the current registration, so the "current path"
    // rule reports it.
    expect(
      within(dialog).getByText(/新文件路径必须与当前登记路径不同/),
    ).toBeInTheDocument();

    fireEvent.change(fileName, { target: { value: "room_v3.png" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "导入清单" }));
    await waitFor(() => expect(imported).toHaveLength(2));
    expect(imported[1]).toMatchObject({
      id: "bg.room",
      replaceId: "bg.room",
      fileName: "room_v3.png",
    });
    await waitFor(() =>
      expect(assetRow("bg.room")).toHaveTextContent("room_v3.png"),
    );

    // After staging room_v3.png, the current registration is room_v3.png and
    // the picker still avoids it (and every earlier reserved path).
    fireEvent.click(screen.getByRole("button", { name: "替换二进制文件…" }));
    dialog = await screen.findByRole("dialog", { name: "替换素材二进制" });
    const finalName =
      within(dialog).getByLabelText<HTMLInputElement>("room_v4.png 文件名");
    expect(finalName).toHaveValue("room_v4.png");
    fireEvent.change(finalName, { target: { value: "room_v3.png" } });
    expect(
      within(dialog).getByText(/新文件路径必须与当前登记路径不同/),
    ).toBeInTheDocument();
  });

  it("refuses to replace a composite animated asset", () => {
    renderAssets();
    fireEvent.click(assetRow("anim.blink"));
    expect(
      screen.getByRole("button", { name: "替换二进制文件…" }),
    ).toBeDisabled();
    expect(screen.getByText(/合成动画素材不能直接替换/)).toBeInTheDocument();
  });
});
