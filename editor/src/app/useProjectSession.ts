import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ActionDispatch,
} from "react";

import { editorApi } from "../api";
import {
  activeImportTokens as collectActiveImportTokens,
  activePendingAssetIds as collectActivePendingAssetIds,
  applyStagedAsset,
  registerPendingImports,
  type PendingAssetImport,
} from "../assetLibrary";
import type { ImportDraft } from "../components/ProjectSidebar";
import type { EditorAction } from "../editorHistory";
import { rememberRecentProject } from "../shell/recentProjects";
import { projectRequest } from "../story";
import type { EditorProject } from "../types";
import { useConfirm, useToast } from "../ui/feedbackContext";
import { isComposing, isTextEntryTarget } from "../ui/keyboard";
import { validateLive } from "../validation";
import type { EditorHistory } from "./useEditorHistory";

function contentDocumentFingerprint(project: EditorProject): string {
  // Editor scalar integers are bigint so that i64 values never pass through
  // a lossy JavaScript number.  Fingerprints are only used for change
  // detection, but must still be deterministic and must not throw when a
  // project contains a bigint default/value.
  return JSON.stringify(
    {
      manifest: project.manifest,
      scenes: project.scenes,
      ui_motions: project.ui_motions,
      buttons: project.buttons ?? [],
      animations: project.animations ?? [],
      actions: project.actions ?? [],
      chapter_map: project.chapter_map,
    },
    (_key, value: unknown) =>
      typeof value === "bigint"
        ? { __vectspace_integer__: value.toString() }
        : value,
  );
}

/**
 * Open, save and asset-import lifecycle of the project, plus the window-level
 * Ctrl+S / Ctrl+Z / Ctrl+Y shortcuts and the unsaved-changes guard.
 */
export function useProjectSession({
  project,
  history,
  dispatchEditor,
  dirty,
  setError,
  setNotice,
  reportCommandError,
  onProjectLoaded,
  onSaveBlocked,
}: {
  project: EditorProject | null;
  history: EditorHistory;
  dispatchEditor: ActionDispatch<[EditorAction]>;
  dirty: boolean;
  setError(message: string | null): void;
  setNotice(message: string | null): void;
  reportCommandError(reason: unknown): void;
  /** Reset navigation state for a freshly opened project. */
  onProjectLoaded(project: EditorProject): void;
  /** Called when validation errors stop a save. */
  onSaveBlocked(): void;
}) {
  const {
    busyRef,
    commit,
    editorStateRef,
    flushEditorEdits,
    projectRef,
    redo,
    setEditorBusy,
    undo,
  } = history;
  const toast = useToast();
  const confirm = useConfirm();
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const savedContentRef = useRef("");
  const pendingImportsRef = useRef<Record<string, PendingAssetImport>>({});
  const [pendingImports, setPendingImports] = useState<
    Record<string, PendingAssetImport>
  >({});
  // Editor-only bookkeeping for replacement destinations.  The host forbids
  // writing over the original binary or any previously staged replacement
  // path, so the UI must apply the same rules: the original path is remembered
  // here even after the row starts pointing at a staged file (and it survives
  // undo/redo and save).
  const [reservedReplacementPaths, setReservedReplacementPaths] = useState<
    Record<string, string[]>
  >({});

  useLayoutEffect(() => {
    pendingImportsRef.current = pendingImports;
  }, [pendingImports]);

  // Keep staged import capabilities in every validation/preview request. A
  // newly imported asset is intentionally absent from the formal assets tree
  // until save, so omitting these tokens would make an otherwise valid
  // unsaved map/timeline preview fail with “missing asset”.  A token is only
  // sent while the manifest still registers the same id, kind and path: an
  // undo that restores a replaced asset's old path drops the obsolete
  // capability instead of failing the whole save.
  const activeImportTokens = useMemo(
    () =>
      project === null
        ? []
        : collectActiveImportTokens(pendingImports, project.manifest),
    [pendingImports, project],
  );

  // Logical ids whose staged binary has not been published by a save yet.
  // The asset library shows a "待保存" badge for these rows.  Only tokens that
  // still match the current manifest id/kind/path are "active": an undo that
  // restores a replaced asset's old path hides the badge, and a redo brings it
  // back (the registry keeps every token, so redo capabilities are never
  // discarded).
  const pendingAssetIds = useMemo(
    () =>
      project === null
        ? []
        : collectActivePendingAssetIds(pendingImports, project.manifest),
    [pendingImports, project],
  );

  const openProject = async (preferred?: string): Promise<void> => {
    if (savingRef.current) {
      setError("请等待当前项目保存完成后再打开其他项目。");
      return;
    }
    if (!flushEditorEdits()) return;
    if (
      (dirty ||
        (projectRef.current !== null &&
          contentDocumentFingerprint(projectRef.current) !==
            savedContentRef.current)) &&
      !(await confirm({
        title: "放弃未保存的更改？",
        description:
          "当前项目有尚未保存的修改。打开其他项目会丢弃这些修改，且无法撤销。",
        confirmLabel: "放弃更改并打开",
        danger: true,
      }))
    )
      return;
    let root = preferred;
    if (root === undefined) {
      try {
        const picked = await editorApi.pickProjectDirectory();
        if (picked === null) return;
        root = picked;
      } catch (reason) {
        reportCommandError(reason);
        return;
      }
    }
    setEditorBusy(true);
    setError(null);
    try {
      const loaded = await editorApi.openProject(root);
      dispatchEditor({ type: "load", project: loaded });
      setPendingImports({});
      setReservedReplacementPaths({});
      savedContentRef.current = contentDocumentFingerprint(loaded);
      onProjectLoaded(loaded);
      rememberRecentProject(loaded.root);
      setNotice(`已打开 ${loaded.root}`);
    } catch (reason) {
      reportCommandError(reason);
    } finally {
      setEditorBusy(false);
    }
  };

  const saveProject = useCallback(async (): Promise<void> => {
    if (savingRef.current || busyRef.current) return;
    if (!flushEditorEdits()) return;
    const currentProject = projectRef.current;
    if (currentProject === null) return;
    const currentDiagnostics = validateLive(currentProject);
    const errors = currentDiagnostics.filter(
      (diagnostic) => diagnostic.severity === "error",
    );
    if (errors.length > 0) {
      onSaveBlocked();
      setError(`存在 ${errors.length} 个错误，修复后才能保存。`);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    const snapshot = currentProject;
    const revision = editorStateRef.current.currentRevision;
    try {
      const requestTokens = collectActiveImportTokens(
        pendingImportsRef.current,
        currentProject.manifest,
      );
      const request = projectRequest(currentProject, requestTokens);
      await editorApi.validateProject(request);
      const result = await editorApi.saveProject(request);
      const saved = result.project;
      dispatchEditor({
        type: "mark_saved",
        project: saved,
        snapshot,
        revision,
      });
      setPendingImports((current) => {
        const next = { ...current };
        for (const token of requestTokens) Reflect.deleteProperty(next, token);
        pendingImportsRef.current = next;
        return next;
      });
      savedContentRef.current = contentDocumentFingerprint(saved);
      const changed = result.changed_paths.length;
      const warningText = result.warnings
        .map((warning) => warning.message)
        .filter((message) => message.length > 0)
        .join("；");
      const deleted = result.deleted_paths.length;
      const summary =
        changed === 0 && deleted === 0
          ? "项目没有需要写入的文件。"
          : `项目已安全保存（${changed} 个文件${deleted > 0 ? `，删除 ${deleted} 个` : ""}）。备份位于 .vectspace/backups。`;
      if (warningText.length > 0) {
        // Warnings stay until the author has read them.
        toast.show({
          tone: "warning",
          message: `${summary}\n警告：${warningText}`,
        });
      } else {
        setNotice(summary);
      }
    } catch (reason) {
      reportCommandError(reason);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [
    busyRef,
    dispatchEditor,
    editorStateRef,
    flushEditorEdits,
    onSaveBlocked,
    projectRef,
    reportCommandError,
    setError,
    setNotice,
    toast,
  ]);

  const importAssets = async (items: ImportDraft[]): Promise<void> => {
    // Importing adds manifest registrations, so it must not leap over an
    // active script/map draft.  Commit the same explicit edit session used by
    // Ctrl+S before minting host-side import capabilities.
    if (!flushEditorEdits()) {
      throw new Error("请先修正当前未提交的编辑内容，再导入素材。");
    }
    const importProject = editorStateRef.current.project;
    if (importProject === null) {
      throw new Error("项目已经关闭，无法导入素材。");
    }
    try {
      const imported = await editorApi.stageAssetImports(
        items.map((item) => ({
          id: item.id,
          kind: item.kind,
          file_name: item.fileName,
          inspection_id: item.inspectionId,
          replace_id: item.replaceId ?? null,
        })),
      );
      const latestProject = editorStateRef.current.project;
      if (latestProject === null || latestProject.root !== importProject.root) {
        throw new Error("项目已切换；本次素材导入未附加到其他项目。");
      }
      // A replacement intentionally reuses an existing logical id; only a
      // brand-new registration may not collide with the current manifest.
      const replacementIds = new Set(
        imported
          .filter(
            (asset) =>
              asset.replaced_from !== undefined && asset.replaced_from !== null,
          )
          .map((asset) => asset.id),
      );
      const conflicts = imported
        .map((asset) => asset.id)
        .filter((id) => !replacementIds.has(id))
        .filter((id) => latestProject.manifest.assets[id] !== undefined);
      if (conflicts.length > 0) {
        throw new Error(
          `导入期间素材 ID 已被占用：${conflicts.join("、")}。请重新检查导入清单。`,
        );
      }
      // A user may have opened an invalid draft while the file inspection was
      // running.  Re-run the shared commit gate before applying the result so
      // a staged token never becomes a manifest registration beside a broken
      // editor session.
      if (!flushEditorEdits()) {
        throw new Error("导入完成前出现无效编辑，未将素材加入项目。");
      }
      commit((draft) => {
        for (const asset of imported) {
          const sourceMetadata = items.find((item) => item.id === asset.id)
            ?.inspection?.metadata;
          // One asset row per logical id: a replacement updates the existing
          // row in place and never appends a duplicate.
          applyStagedAsset(draft, asset, sourceMetadata ?? null);
        }
      });
      if (
        imported.some(
          (asset) => asset.token !== undefined && asset.token !== null,
        )
      ) {
        setPendingImports((current) => {
          const next = registerPendingImports(current, imported);
          // A Ctrl+S dispatched in the same browser turn must use the newly
          // minted capabilities rather than wait for React's layout effect.
          pendingImportsRef.current = next;
          return next;
        });
      }
      // Remember every replaced destination so a later replacement cannot
      // reuse the original on-disk path or a superseded staged path, matching
      // the host's reservation of both.
      if (replacementIds.size > 0) {
        setReservedReplacementPaths((current) => {
          const next: Record<string, string[]> = { ...current };
          for (const asset of imported) {
            const paths = new Set(next[asset.id] ?? []);
            if (
              asset.replaced_from !== undefined &&
              asset.replaced_from !== null
            )
              paths.add(asset.replaced_from);
            if (asset.path !== "") paths.add(asset.path);
            next[asset.id] = [...paths];
          }
          return next;
        });
      }
      const reused = imported.filter(
        (asset) =>
          asset.reused_from !== undefined && asset.reused_from !== null,
      ).length;
      const replaced = replacementIds.size;
      if (replaced > 0) {
        setNotice(
          `已暂存 ${imported.length} 个素材（${replaced} 个替换原文件，旧文件保留在 assets 目录）；保存项目后才会正式加入项目。`,
        );
      } else {
        setNotice(
          reused > 0
            ? `已暂存 ${imported.length} 个素材（${reused} 个复用已有文件）；保存项目后才会正式加入项目。`
            : `已暂存 ${imported.length} 个素材；保存项目后才会正式加入项目。`,
        );
      }
    } catch (reason) {
      reportCommandError(reason);
      throw reason;
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || isComposing(event)) return;
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveProject();
        return;
      }
      // Undo/redo inside a text field is the field's own text history.
      if (isTextEntryTarget(event.target)) return;
      if (event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (
        event.key.toLowerCase() === "y" ||
        (event.key.toLowerCase() === "z" && event.shiftKey)
      ) {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [redo, saveProject, undo]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  return {
    saving,
    activeImportTokens,
    pendingAssetIds,
    reservedReplacementPaths,
    openProject,
    saveProject,
    importAssets,
  };
}
