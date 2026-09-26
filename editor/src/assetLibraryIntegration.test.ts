// @vitest-environment node
/**
 * Integration: drive the *real* editor mutation seam (`editorReducer`) with
 * the asset-library helpers, exactly the way `App.commit` does
 * (`draft.layout = mutate(draft.layout)`), and prove the layout metadata and
 * a staged replacement stay undoable without touching a manifest path.
 */
import { describe, expect, it } from "vitest";

import {
  activeImportTokens,
  applyStagedAsset,
  assetDisplayName,
  assetFolderId,
  isAssetHidden,
  moveAssetFolder,
  moveAssetToFolder,
  registerPendingImports,
  setAssetDisplayName,
  setAssetHidden,
} from "./assetLibrary";
import {
  editorReducer,
  INITIAL_EDITOR_STATE,
  type EditorState,
} from "./editorHistory";
import type { ContentManifest, EditorProject, ImportedAsset } from "./types";

const MANIFEST: ContentManifest = {
  schema_version: 2,
  content_version: "1",
  entry_scene: "main",
  default_locale: "zh-CN",
  variables: {},
  characters: {},
  assets: {
    "bg.room": { kind: "background", path: "backgrounds/room.png" },
  },
  scenes: [],
  ui_motions: [],
  ui_motion_defaults: {},
};

function project(): EditorProject {
  return {
    root: "C:/game",
    manifest: MANIFEST,
    scenes: [],
    ui_motions: [],
    layout: {
      version: 1,
      scenes: {},
      asset_folders: { bg: { parent_id: null, name: "背景", order: 0 } },
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
    ],
    diagnostics: [],
    fingerprint: "fp",
  };
}

function commit(
  state: EditorState,
  mutate: (draft: EditorProject) => void,
  label = "编辑项目",
): EditorState {
  return editorReducer(state, {
    type: "edit",
    label,
    history: true,
    mutation: (draft) => {
      mutate(draft);
    },
  });
}

it("keeps edits made while a save was in flight and rebases the fingerprint", () => {
  const baseline = project();
  const before = editorReducer(INITIAL_EDITOR_STATE, {
    type: "load",
    project: baseline,
  });
  const edited = commit(before, (draft) => {
    draft.manifest.content_version = "2";
  });
  const snapshot = edited.project;
  if (snapshot === null) throw new Error("missing project after edit");
  const later = commit(edited, (draft) => {
    draft.manifest.content_version = "3";
  });
  const saved = { ...snapshot, fingerprint: "saved-fp" };
  const result = editorReducer(later, {
    type: "mark_saved",
    project: saved,
    snapshot,
    revision: edited.currentRevision,
  });
  expect(result.project?.manifest.content_version).toBe("3");
  expect(result.project?.fingerprint).toBe("saved-fp");
  expect(result.savedRevision).toBe(edited.currentRevision);
  expect(result.dirty).toBe(true);
});

function layoutCommit(
  state: EditorState,
  mutate: (layout: EditorProject["layout"]) => EditorProject["layout"],
): EditorState {
  return commit(
    state,
    (draft) => {
      draft.layout = mutate(draft.layout);
    },
    "编辑素材库",
  );
}

describe("asset-library layout metadata through the App reducer", () => {
  it("groups, renames and hides without touching the manifest, and undoes", () => {
    let state = editorReducer(INITIAL_EDITOR_STATE, {
      type: "load",
      project: project(),
    });
    state = layoutCommit(state, (layout) =>
      moveAssetToFolder(layout, "bg.room", "bg"),
    );
    state = layoutCommit(state, (layout) =>
      setAssetDisplayName(layout, "bg.room", "客厅"),
    );
    state = layoutCommit(state, (layout) =>
      setAssetHidden(layout, "bg.room", true),
    );

    const current = state.project as EditorProject;
    expect(assetFolderId(current.layout, "bg.room")).toBe("bg");
    expect(assetDisplayName(current.layout, "bg.room")).toBe("客厅");
    expect(isAssetHidden(current.layout, "bg.room")).toBe(true);
    // Hidden/in-folder is editor-only: the runtime manifest is unchanged.
    expect(current.manifest.assets["bg.room"]).toEqual({
      kind: "background",
      path: "backgrounds/room.png",
    });
    expect(state.past).toHaveLength(3);
    expect(state.dirty).toBe(true);

    // Undo the hide only, then the rename, then the grouping.
    state = editorReducer(state, { type: "undo" });
    expect(
      isAssetHidden((state.project as EditorProject).layout, "bg.room"),
    ).toBe(false);
    expect(
      assetDisplayName((state.project as EditorProject).layout, "bg.room"),
    ).toBe("客厅");
    state = editorReducer(state, { type: "undo" });
    state = editorReducer(state, { type: "undo" });
    const undone = state.project as EditorProject;
    expect(assetFolderId(undone.layout, "bg.room")).toBeNull();
    expect(assetDisplayName(undone.layout, "bg.room")).toBeNull();

    // Redo re-applies the whole chain (durable grouping survives reopen).
    state = editorReducer(state, { type: "redo" });
    state = editorReducer(state, { type: "redo" });
    state = editorReducer(state, { type: "redo" });
    expect(
      assetFolderId((state.project as EditorProject).layout, "bg.room"),
    ).toBe("bg");
  });

  it("moves a folder and rejects a cycle before any history entry", () => {
    let state = editorReducer(INITIAL_EDITOR_STATE, {
      type: "load",
      project: project(),
    });
    state = layoutCommit(state, (layout) =>
      moveAssetFolder(layout, "bg", null),
    );
    // Moving a folder into its own child is a no-op → no new patch.
    const scened = layoutCommit(state, (layout) =>
      moveAssetFolder(layout, "bg", "bg"),
    );
    expect(scened.past).toHaveLength(state.past.length);
  });
});

describe("staged same-ID replacement through the App reducer", () => {
  const imported: ImportedAsset = {
    id: "bg.room",
    kind: "background",
    path: "backgrounds/room_v2.png",
    absolute_path: ".vectspace/tmp/imports/import-1/room_v2.png",
    size_bytes: "42",
    token: "import-1",
    replaced_from: "backgrounds/room.png",
  };

  it("replaces one row in place, keeps a usable token and undoes cleanly", () => {
    let state = editorReducer(INITIAL_EDITOR_STATE, {
      type: "load",
      project: project(),
    });
    const pending = registerPendingImports({}, [imported]);
    state = commit(
      state,
      (draft) => applyStagedAsset(draft, imported, null),
      "替换素材",
    );

    const staged = state.project as EditorProject;
    // One logical id, one row, a new path — the old binary is never touched.
    expect(staged.assets).toHaveLength(1);
    expect(staged.assets[0].absolute_path).toContain("room_v2.png");
    expect(staged.manifest.assets["bg.room"]).toEqual({
      kind: "background",
      path: "backgrounds/room_v2.png",
    });
    expect(activeImportTokens(pending, staged.manifest)).toEqual(["import-1"]);

    // Undo restores the old registration, so the obsolete token is dropped
    // instead of being submitted with a path-mismatched capability.
    state = editorReducer(state, { type: "undo" });
    const undone = state.project as EditorProject;
    expect(undone.manifest.assets["bg.room"]).toEqual({
      kind: "background",
      path: "backgrounds/room.png",
    });
    expect(undone.assets).toHaveLength(1);
    expect(activeImportTokens(pending, undone.manifest)).toEqual([]);

    // Redo re-applies without a duplicate row, and the token is usable again.
    state = editorReducer(state, { type: "redo" });
    const redone = state.project as EditorProject;
    expect(redone.assets).toHaveLength(1);
    expect(activeImportTokens(pending, redone.manifest)).toEqual(["import-1"]);
  });
});
