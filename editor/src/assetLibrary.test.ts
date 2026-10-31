import { describe, expect, it } from "vitest";
import {
  activeImportTokens,
  activePendingAssetIds,
  applyStagedAsset,
  assetChoiceOptions,
  assetDisplayName,
  assetFolderId,
  assetLabel,
  buildAssetFolderTree,
  createAssetFolder,
  folderDisplayPath,
  folderPathIds,
  folderPathNames,
  isAssetHidden,
  moveAssetFolder,
  moveAssetToFolder,
  registerPendingImports,
  renameAssetFolder,
  setAssetDisplayName,
  setAssetHidden,
  validateFolderMove,
} from "./assetLibrary";
import type {
  AssetKind,
  ContentManifest,
  EditorAsset,
  EditorLayout,
} from "./types";

function layoutWith(
  folders: EditorLayout["asset_folders"],
  metadata: EditorLayout["asset_metadata"] = {},
): EditorLayout {
  return {
    version: 1,
    scenes: { demo: { nodes: { start: { x: 0, y: 0 } }, viewport: null } },
    timeline_previews: {
      "demo/start": { variable_overrides: {}, choices: [] },
    },
    asset_folders: folders,
    asset_metadata: metadata,
  };
}

function asset(
  id: string,
  kind: AssetKind,
  path?: string,
  animation?: string,
): EditorAsset {
  return {
    id,
    kind,
    path,
    animation,
    absolute_path: `C:/project/assets/${path ?? id}`,
  };
}

const MANIFEST: ContentManifest = {
  schema_version: 2,
  content_version: "1",
  entry_scene: "demo",
  default_locale: "zh-CN",
  default_font: null,
  variables: {},
  characters: {},
  assets: {
    "bg.room": { kind: "background", path: "backgrounds/room.png" },
    "bg.old": { kind: "background", path: "backgrounds/old.png" },
  },
  scenes: [],
  ui_motions: [],
  ui_motion_defaults: {},
  buttons: [],
  animations: [],
  actions: [],
  chapter_map: null,
};

describe("virtual asset folders", () => {
  it("builds a deterministic nested tree from stable folder ids", () => {
    const layout = layoutWith(
      {
        root: { parent_id: null, name: "背景", order: 0 },
        childB: { parent_id: "root", name: "b", order: 1 },
        childA: { parent_id: "root", name: "a", order: 0 },
        grand: { parent_id: "childA", name: "旧版本", order: 0 },
      },
      {},
    );
    const tree = buildAssetFolderTree(layout);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe("root");
    expect(tree[0].path).toEqual(["背景"]);
    expect(tree[0].children.map((node) => node.id)).toEqual([
      "childA",
      "childB",
    ]);
    expect(tree[0].children[0].children.map((node) => node.id)).toEqual([
      "grand",
    ]);
    expect(tree[0].children[0].children[0].path).toEqual([
      "背景",
      "a",
      "旧版本",
    ]);
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });

  it("derives folder paths and stops at a hand-edited cycle", () => {
    const layout = layoutWith({
      a: { parent_id: "b", name: "A", order: 0 },
      b: { parent_id: "a", name: "B", order: 0 },
      ok: { parent_id: null, name: "OK", order: 0 },
    });
    expect(folderPathIds(layout, "ok")).toEqual(["ok"]);
    expect(folderPathNames(layout, "ok")).toEqual(["OK"]);
    // Cyclic links must terminate instead of looping forever.
    expect(folderPathIds(layout, "a")).toEqual(["a"]);
    expect(folderPathIds(layout, "b")).toEqual(["b"]);
    const tree = buildAssetFolderTree(layout);
    expect(tree.map((node) => node.id).sort()).toEqual(["a", "b", "ok"]);
  });

  it("rejects moves into self, into a descendant and to a missing parent", () => {
    const layout = layoutWith({
      root: { parent_id: null, name: "root", order: 0 },
      child: { parent_id: "root", name: "child", order: 0 },
      grand: { parent_id: "child", name: "grand", order: 0 },
    });
    expect(validateFolderMove(layout, "root", "root").ok).toBe(false);
    expect(validateFolderMove(layout, "root", "child").ok).toBe(false);
    expect(validateFolderMove(layout, "root", "grand").ok).toBe(false);
    expect(validateFolderMove(layout, "root", "missing").ok).toBe(false);
    expect(validateFolderMove(layout, "root", null)).toEqual({ ok: true });
    expect(validateFolderMove(layout, "child", "grand").ok).toBe(false);
    expect(validateFolderMove(layout, "grand", "root")).toEqual({ ok: true });
  });

  it("moves folders and assets without touching scenes or manifest paths", () => {
    const layout = layoutWith({
      root: { parent_id: null, name: "root", order: 0 },
      child: { parent_id: "root", name: "child", order: 0 },
    });
    const moved = moveAssetFolder(layout, "child", null);
    expect(moved.asset_folders?.child.parent_id).toBeNull();
    // Structural sharing: unrelated layout sections are reused untouched.
    expect(moved.scenes).toBe(layout.scenes);
    expect(moved.timeline_previews).toBe(layout.timeline_previews);
    // The original layout value is never mutated.
    expect(layout.asset_folders?.child.parent_id).toBe("root");

    // An invalid move returns the very same layout value.
    expect(moveAssetFolder(layout, "root", "child")).toBe(layout);
    expect(moveAssetFolder(layout, "missing", null)).toBe(layout);

    const grouped = moveAssetToFolder(moved, "bg.room", "child");
    expect(assetFolderId(grouped, "bg.room")).toBe("child");
    expect(assetFolderId(moved, "bg.room")).toBeNull();
    expect(moveAssetToFolder(grouped, "bg.room", "missing")).toBe(grouped);
    expect(moveAssetToFolder(grouped, "bg.room", null).asset_metadata).toEqual(
      {},
    );
    expect(MANIFEST.assets["bg.room"].path).toBe("backgrounds/room.png");
  });

  it("creates subfolders with a stable id and rejects invalid names", () => {
    const layout = layoutWith({
      root: { parent_id: null, name: "root", order: 0 },
    });
    const created = createAssetFolder(layout, {
      name: "  新文件夹  ",
      parentId: "root",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.folderId).toBe("folder");
    expect(created.layout.asset_folders?.folder).toEqual({
      parent_id: "root",
      name: "新文件夹",
      order: 0,
    });
    const second = createAssetFolder(created.layout, { name: "另一个" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.folderId).toBe("folder_2");
    expect(second.layout.asset_folders?.folder_2.order).toBe(1);
    expect(createAssetFolder(layout, { name: "   " }).ok).toBe(false);
    expect(createAssetFolder(layout, { name: "x" }).ok).toBe(true);
    const duplicate = createAssetFolder(layout, { name: "x", id: "root" });
    expect(duplicate.ok).toBe(false);
  });

  it("renames folders and keeps empty metadata out of the layout", () => {
    const layout = layoutWith({
      root: { parent_id: null, name: "root", order: 0 },
    });
    const renamed = renameAssetFolder(layout, "root", "  季节点  ");
    expect(renamed.asset_folders?.root.name).toBe("季节点");
    expect(renameAssetFolder(layout, "root", " ")).toBe(layout);
    expect(renameAssetFolder(layout, "missing", "x")).toBe(layout);
  });
});

describe("editor-only asset metadata", () => {
  it("updates display name and hidden immutably and round-trips through JSON", () => {
    const layout = layoutWith({});
    const named = setAssetDisplayName(layout, "bg.room", "  客厅背景  ");
    const hidden = setAssetHidden(named, "bg.room", true);
    expect(assetDisplayName(hidden, "bg.room")).toBe("客厅背景");
    expect(assetLabel(hidden, "bg.room")).toBe("客厅背景");
    expect(assetLabel(hidden, "bg.old")).toBe("bg.old");
    expect(isAssetHidden(hidden, "bg.room")).toBe(true);
    expect(isAssetHidden(hidden, "bg.old")).toBe(false);
    // Undo-compatible: the earlier values are untouched so an Immer patch can
    // restore them.
    expect(assetDisplayName(named, "bg.room")).toBe("客厅背景");
    expect(isAssetHidden(named, "bg.room")).toBe(false);
    expect(layout.asset_metadata).toEqual({});

    // Durable grouping: the metadata survives a save/reopen JSON round trip.
    const reopened = JSON.parse(JSON.stringify(hidden)) as EditorLayout;
    expect(isAssetHidden(reopened, "bg.room")).toBe(true);
    expect(folderDisplayPath(reopened, null)).toBe("");
    // An old layout without the new fields keeps loading.
    const old = JSON.parse(
      JSON.stringify({ version: 1, scenes: {}, timeline_previews: {} }),
    ) as EditorLayout;
    expect(assetFolderId(old, "bg.room")).toBeNull();
    expect(assetDisplayName(old, "bg.room")).toBeNull();
    expect(buildAssetFolderTree(old)).toEqual([]);
  });

  it("drops metadata that no longer carries any information", () => {
    const layout = layoutWith({});
    const hidden = setAssetHidden(layout, "bg.room", true);
    expect(setAssetHidden(hidden, "bg.room", false)).toEqual(layout);
    // A redundant edit keeps the same value so Immer records no patch.
    expect(setAssetHidden(hidden, "bg.room", true)).toBe(hidden);
    const named = setAssetDisplayName(layout, "bg.room", "客厅");
    expect(setAssetDisplayName(named, "bg.room", null)).toEqual(layout);
    expect(setAssetDisplayName(layout, "missing", null)).toBe(layout);
    expect(setAssetDisplayName(layout, "bg.room", "a\u0000b")).toBe(layout);
  });
});

describe("hidden policy for asset choosers", () => {
  const assets = [
    asset("bg.room", "background", "backgrounds/room.png"),
    asset("bg.old", "background", "backgrounds/old.png"),
    asset("sp.hero", "sprite", "sprites/hero.png"),
  ];
  const layout = layoutWith(
    { archive: { parent_id: null, name: "归档", order: 0 } },
    {
      "bg.old": { hidden: true, folder_id: "archive", display_name: "旧客厅" },
      "bg.room": { display_name: "客厅" },
    },
  );

  it("excludes hidden assets from new choices", () => {
    const options = assetChoiceOptions({ assets, layout });
    expect(options.map((option) => option.id)).toEqual(["sp.hero", "bg.room"]);
  });

  it("keeps a currently selected hidden id visible and marked", () => {
    const options = assetChoiceOptions({
      assets,
      layout,
      kind: "background",
      selectedIds: ["bg.old", null, undefined],
    });
    expect(options.map((option) => option.id)).toEqual(["bg.room", "bg.old"]);
    const hiddenOption = options.find((option) => option.id === "bg.old");
    expect(hiddenOption?.selectedHidden).toBe(true);
    expect(hiddenOption?.hidden).toBe(true);
    expect(hiddenOption?.label).toBe("旧客厅");
    expect(hiddenOption?.folderPath).toBe("归档");
  });

  it("keeps hidden assets manageable in the asset manager mode", () => {
    const options = assetChoiceOptions({
      assets,
      layout,
      includeHidden: true,
    });
    expect(options.map((option) => option.id)).toContain("bg.old");
    expect(
      options.find((option) => option.id === "bg.old")?.selectedHidden,
    ).toBe(false);
  });

  it("searches display name, id, path and folder case-insensitively", () => {
    const byDisplay = assetChoiceOptions({
      assets,
      layout,
      query: "客厅",
      includeHidden: true,
    });
    expect(byDisplay.map((option) => option.id)).toEqual(["bg.room", "bg.old"]);
    expect(
      assetChoiceOptions({ assets, layout, query: "BG.OLD" }).map(
        (option) => option.id,
      ),
    ).toEqual([]);
    expect(
      assetChoiceOptions({
        assets,
        layout,
        query: "bg.old",
        includeHidden: true,
      }).map((option) => option.id),
    ).toEqual(["bg.old"]);
    expect(
      assetChoiceOptions({ assets, layout, query: "sprites/hero" }).map(
        (option) => option.id,
      ),
    ).toEqual(["sp.hero"]);
    expect(
      assetChoiceOptions({
        assets,
        layout,
        query: "归档",
        includeHidden: true,
      }).map((option) => option.id),
    ).toEqual(["bg.old"]);
    expect(assetChoiceOptions({ assets, layout, query: "缺失" })).toEqual([]);
  });

  it("filters by kind and folder subtree", () => {
    expect(
      assetChoiceOptions({
        assets,
        layout,
        kind: ["background", "sprite"],
      }).map((option) => option.id),
    ).toEqual(["sp.hero", "bg.room"]);
    expect(
      assetChoiceOptions({ assets, layout, kind: "sprite" }).map(
        (option) => option.id,
      ),
    ).toEqual(["sp.hero"]);
    expect(
      assetChoiceOptions({
        assets,
        layout,
        folderId: "archive",
        includeHidden: true,
      }).map((option) => option.id),
    ).toEqual(["bg.old"]);
    expect(
      assetChoiceOptions({ assets, layout, folderId: null }).map(
        (option) => option.id,
      ),
    ).toEqual(["sp.hero", "bg.room"]);
  });
});

describe("root folder scope", () => {
  const scopedAssets = [
    asset("bg.root", "background", "backgrounds/root.png"),
    asset("bg.top", "background", "backgrounds/top.png"),
    asset("bg.deep", "background", "backgrounds/deep.png"),
  ];
  const scopedLayout = layoutWith(
    {
      top: { parent_id: null, name: "顶层", order: 0 },
      child: { parent_id: "top", name: "子级", order: 0 },
    },
    {
      "bg.top": { folder_id: "top" },
      "bg.deep": { folder_id: "child" },
    },
  );

  it("treats folderId null as root/unassigned only and a folder id as its subtree", () => {
    // Root-only scope: an asset in a nested folder is not "unassigned".
    expect(
      assetChoiceOptions({
        assets: scopedAssets,
        layout: scopedLayout,
        folderId: null,
      }).map((option) => option.id),
    ).toEqual(["bg.root"]);
    // Omitting folderId (or passing undefined) means "no folder filter".
    expect(
      assetChoiceOptions({ assets: scopedAssets, layout: scopedLayout })
        .map((option) => option.id)
        .sort(),
    ).toEqual(["bg.deep", "bg.root", "bg.top"]);
    expect(
      assetChoiceOptions({
        assets: scopedAssets,
        layout: scopedLayout,
        folderId: undefined,
      })
        .map((option) => option.id)
        .sort(),
    ).toEqual(["bg.deep", "bg.root", "bg.top"]);
    // A concrete folder still includes its descendants.
    expect(
      assetChoiceOptions({
        assets: scopedAssets,
        layout: scopedLayout,
        folderId: "top",
      })
        .map((option) => option.id)
        .sort(),
    ).toEqual(["bg.deep", "bg.top"]);
    expect(
      assetChoiceOptions({
        assets: scopedAssets,
        layout: scopedLayout,
        folderId: "child",
      }).map((option) => option.id),
    ).toEqual(["bg.deep"]);
  });
});

describe("staged import / replacement plumbing", () => {
  it("keeps a redo capability while the pending badge follows the active path", () => {
    const pending = registerPendingImports({}, [
      {
        id: "bg.room",
        kind: "background",
        path: "backgrounds/room_v2.png",
        absolute_path: "C:/tmp/room_v2.png",
        size_bytes: "10",
        token: "import-1",
        replaced_from: "backgrounds/room.png",
      },
    ]);
    const stagedManifest: ContentManifest = {
      ...MANIFEST,
      assets: {
        ...MANIFEST.assets,
        "bg.room": { kind: "background", path: "backgrounds/room_v2.png" },
      },
    };
    expect(activePendingAssetIds(pending, stagedManifest)).toEqual(["bg.room"]);
    // Undo restores the old path: the badge disappears but the token (and its
    // redo capability) is kept.
    expect(activePendingAssetIds(pending, MANIFEST)).toEqual([]);
    expect(Object.keys(pending)).toEqual(["import-1"]);
    // Redo re-activates the badge without re-registering anything.
    expect(activePendingAssetIds(pending, stagedManifest)).toEqual(["bg.room"]);
  });

  it("drops a token whose manifest path changed after an undo", () => {
    const pending = registerPendingImports({}, [
      {
        id: "bg.room",
        kind: "background",
        path: "backgrounds/room_v2.png",
        absolute_path: "C:/tmp/room_v2.png",
        size_bytes: "10",
        token: "import-1",
        replaced_from: "backgrounds/room.png",
      },
      {
        id: "bg.new",
        kind: "background",
        path: "backgrounds/new.png",
        absolute_path: "C:/tmp/new.png",
        size_bytes: "10",
        token: "import-2",
      },
    ]);
    expect(Object.keys(pending)).toEqual(["import-1", "import-2"]);
    const stagedManifest: ContentManifest = {
      ...MANIFEST,
      assets: {
        ...MANIFEST.assets,
        "bg.room": { kind: "background", path: "backgrounds/room_v2.png" },
        "bg.new": { kind: "background", path: "backgrounds/new.png" },
      },
    };
    expect(activeImportTokens(pending, stagedManifest)).toEqual([
      "import-1",
      "import-2",
    ]);
    // Undo restores the old path: the replacement token must no longer be
    // submitted, otherwise the host rejects the whole save.
    const undoneManifest: ContentManifest = {
      ...MANIFEST,
      assets: {
        ...MANIFEST.assets,
        "bg.new": { kind: "background", path: "backgrounds/new.png" },
      },
    };
    expect(activeImportTokens(pending, undoneManifest)).toEqual(["import-2"]);
    // A token without a host token is never registered.
    expect(
      registerPendingImports({}, [
        {
          id: "bg.x",
          kind: "background",
          path: "backgrounds/x.png",
          absolute_path: "C:/tmp/x.png",
          size_bytes: "1",
          token: null,
        },
      ]),
    ).toEqual({});
  });

  it("replaces one asset row in place and never appends a duplicate", () => {
    const draft = {
      manifest: { ...MANIFEST },
      assets: [
        asset("bg.room", "background", "backgrounds/room.png"),
        asset("bg.old", "background", "backgrounds/old.png"),
      ],
    };
    applyStagedAsset(
      draft,
      {
        id: "bg.room",
        kind: "background",
        path: "backgrounds/room_v2.png",
        absolute_path: "C:/project/.vectspace/tmp/imports/import-1/room_v2.png",
        size_bytes: "42",
        token: "import-1",
        replaced_from: "backgrounds/room.png",
      },
      {
        format: "Png",
        width: 64,
        height: 64,
        duration_ms: null,
        channels: null,
        sample_rate: null,
        font_family: null,
        font_style: null,
      },
    );
    expect(draft.manifest.assets["bg.room"]).toEqual({
      kind: "background",
      path: "backgrounds/room_v2.png",
    });
    expect(draft.assets).toHaveLength(2);
    expect(draft.assets[0].absolute_path).toContain("room_v2.png");
    expect(draft.assets[0].size_bytes).toBe("42");
    expect(draft.assets[0].metadata).toMatchObject({
      format: "Png",
      width: 64,
      height: 64,
    });

    applyStagedAsset(draft, {
      id: "bg.new",
      kind: "background",
      path: "backgrounds/new.png",
      absolute_path: "C:/project/assets/backgrounds/new.png",
      size_bytes: "1",
      token: "import-2",
    });
    expect(draft.assets).toHaveLength(3);
    expect(draft.manifest.assets["bg.new"]).toEqual({
      kind: "background",
      path: "backgrounds/new.png",
    });
  });
});
