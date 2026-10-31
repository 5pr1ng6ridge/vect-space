import { useMemo, useState } from "react";
import { editorApi } from "../../api";
import type { AssetKind, ContentManifest, EditorAsset } from "../../types";
import type { ImportDraft } from "./types";
import {
  assetFolder,
  collisionKey,
  extensionFamily,
  inferAssetKind,
  replacementError,
  suggestReplacementFileName,
  supportedImportExtension,
  uniqueAssetId,
} from "./assetUtils";
import { errorMessage } from "../errorMessage";

/**
 * Import / replace flow of the asset panel: picks files, inspects them through
 * the host and keeps the editable draft queue until the author confirms.
 */
export function useAssetImport({
  assets,
  manifest,
  onImportAssets,
  onImported,
  reservedAssetPaths,
}: {
  assets: readonly EditorAsset[];
  manifest: ContentManifest;
  onImportAssets(items: ImportDraft[]): Promise<void>;
  /** Called with the id of the last imported asset once the host accepted the batch. */
  onImported(lastId: string | null): void;
  reservedAssetPaths: Readonly<Record<string, readonly string[]>> | undefined;
}) {
  const [importing, setImporting] = useState(false);
  const [importQueue, setImportQueue] = useState<ImportDraft[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  // Every destination the host already reserves: all currently registered
  // asset paths (including the row's current staged path) plus the editor-only
  // "original + earlier staged" list.  A replacement may not reuse any of them.
  const replacementReserved = useMemo(() => {
    const keys = new Set<string>();
    for (const asset of assets)
      if (asset.path) keys.add(collisionKey(asset.path));
    for (const definition of Object.values(manifest.assets))
      if (definition.path) keys.add(collisionKey(definition.path));
    for (const paths of Object.values(reservedAssetPaths ?? {}))
      for (const path of paths) keys.add(collisionKey(path));
    return keys;
  }, [assets, manifest, reservedAssetPaths]);
  const queuePaths = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return;
    setImportError(null);
    setInspecting(true);
    try {
      const inspections = await editorApi.inspectAssetImports(paths);
      const reserved = [...assets];
      const drafts = paths.map((sourcePath, index) => {
        const inspection = inspections[index];
        const fileName =
          inspection?.source_name ??
          sourcePath.split(/[\\/]/).at(-1) ??
          "asset";
        const stem = fileName.replace(/\.[^.]+$/, "");
        const suggested = inspection?.suggested_kind as
          AssetKind | null | undefined;
        const kind = suggested ?? inferAssetKind(fileName);
        const id = uniqueAssetId(stem, kind, reserved);
        reserved.push({
          id,
          kind,
          path: "",
          absolute_path: "",
        });
        const inspectionError = inspection?.diagnostics
          .filter((diagnostic) => diagnostic.severity === "error")
          .map((diagnostic) => diagnostic.message)
          .join("；");
        return {
          sourcePath,
          fileName,
          id,
          kind,
          inspectionId: inspection?.inspection_id,
          inspection,
          error: inspectionError || undefined,
        };
      });
      setImportQueue(drafts);
    } catch (reason) {
      setImportError(errorMessage(reason));
    } finally {
      setInspecting(false);
    }
  };
  const pickAndQueue = async (): Promise<void> => {
    try {
      const paths = await editorApi.pickAssetFiles();
      void queuePaths(paths);
    } catch (reason) {
      setImportError(errorMessage(reason));
    }
  };
  /**
   * Same-ID / new-path replacement.  The logical id and kind are locked, the
   * destination must differ from the registered path and the actual format
   * family must match the old binary; the host re-validates all of it, so this
   * is a friendly pre-check rather than the authority.
   */
  const queueReplacement = async (asset: EditorAsset): Promise<void> => {
    setImportError(null);
    setInspecting(true);
    try {
      const paths = await editorApi.pickAssetFiles();
      if (paths.length === 0) return;
      const sourcePath = paths[0];
      const instructions = await editorApi.inspectAssetImports([sourcePath]);
      const inspection = instructions[0];
      const fileName =
        inspection?.source_name ?? sourcePath.split(/[\\/]/).at(-1) ?? "asset";
      // Never prefill a destination the host would reject: the original
      // binary and every earlier staged replacement path are reserved, so a
      // colliding pick gets a free `_vN` suggestion up front.
      const suggested = suggestReplacementFileName(
        asset,
        fileName,
        replacementReserved,
      );
      const error = replacementError(
        asset,
        suggested,
        inspection,
        replacementReserved,
      );
      setImportQueue([
        {
          sourcePath,
          fileName: suggested,
          id: asset.id,
          kind: asset.kind,
          inspectionId: inspection?.inspection_id,
          inspection,
          replaceId: asset.id,
          error,
        },
      ]);
    } catch (reason) {
      setImportError(errorMessage(reason));
    } finally {
      setInspecting(false);
    }
  };
  const updateImport = (index: number, update: Partial<ImportDraft>): void => {
    setImportQueue((current) =>
      current === null
        ? null
        : current.map((item, candidate) => {
            if (candidate !== index) return item;
            const merged: ImportDraft = { ...item, ...update };
            if (merged.replaceId === undefined)
              return { ...merged, error: undefined };
            // A replacement error must follow the file-name edit live, so the
            // dialog explains a same-path or different-format pick immediately.
            const target = assets.find((asset) => asset.id === merged.id);
            return {
              ...merged,
              error:
                target === undefined
                  ? "清单中不存在要替换的素材"
                  : replacementError(
                      target,
                      merged.fileName,
                      merged.inspection,
                      replacementReserved,
                    ),
            };
          }),
    );
  };
  const submitImport = async (): Promise<void> => {
    if (importQueue === null) return;
    setImportError(null);
    const ids = new Map<string, number[]>();
    const paths = new Map<string, number[]>();
    for (const [index, item] of importQueue.entries()) {
      const idKey = item.id;
      ids.set(idKey, [...(ids.get(idKey) ?? []), index]);
      const pathKey =
        `${assetFolder(item.kind)}/${item.fileName}`.toLowerCase();
      paths.set(pathKey, [...(paths.get(pathKey) ?? []), index]);
    }
    const nextQueue = importQueue.map((item) => {
      const errors: string[] = [];
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(item.id))
        errors.push("ID 只能包含字母、数字、点、下划线或连字符");
      if (!/^[^\\/:*?"<>|]{1,200}$/.test(item.fileName))
        errors.push("文件名不是安全的单个文件名");
      // A replacement intentionally reuses an existing logical id; only a
      // brand-new registration may not collide with the current manifest.
      if (item.replaceId === undefined && item.id in manifest.assets)
        errors.push("ID 已存在");
      if (item.replaceId !== undefined && item.replaceId !== item.id)
        errors.push("替换目标与逻辑 ID 不一致");
      if ((ids.get(item.id)?.length ?? 0) > 1) errors.push("清单中 ID 重复");
      const destination = `${assetFolder(item.kind)}/${item.fileName}`;
      if ((paths.get(destination.toLowerCase())?.length ?? 0) > 1)
        errors.push("目标路径重复");
      if (!supportedImportExtension(item.kind, item.fileName))
        errors.push("文件扩展名与素材类型不匹配");
      if (item.replaceId !== undefined) {
        const existing = assets.find((asset) => asset.id === item.id);
        if (existing === undefined) errors.push("清单中不存在要替换的素材");
        else if (existing.animation !== undefined)
          errors.push("合成动画素材不能直接替换，请替换它的帧图片");
        else {
          const oldPath = existing.path ?? "";
          if (collisionKey(oldPath) === collisionKey(destination))
            errors.push("新文件路径必须与当前登记路径不同");
          else if (replacementReserved.has(collisionKey(destination)))
            errors.push("该目标路径已被原始文件或先前暂存的替换保留");
          if (extensionFamily(item.fileName) !== extensionFamily(oldPath))
            errors.push("新文件格式必须与旧文件一致");
        }
      }
      return {
        ...item,
        error: errors.length > 0 ? errors.join("；") : undefined,
      };
    });
    setImportQueue(nextQueue);
    if (
      nextQueue.some(
        (item) => item.error !== undefined || item.inspectionId === undefined,
      )
    ) {
      setImportError("请先修正清单中标出的错误。");
      return;
    }
    setImporting(true);
    try {
      // Use the validated snapshot we just built rather than the render's
      // stale queue.  React may batch a last inspector edit with this click;
      // the validated values are the ones that must cross the IPC boundary.
      await onImportAssets(nextQueue);
      onImported(nextQueue.at(-1)?.id ?? null);
      setImportQueue(null);
    } catch (reason) {
      setImportError(errorMessage(reason));
    } finally {
      setImporting(false);
    }
  };
  return {
    importing,
    inspecting,
    importQueue,
    importError,
    queuePaths,
    pickAndQueue,
    queueReplacement,
    updateImport,
    submitImport,
    cancelImport: (): void => setImportQueue(null),
    removeDraft: (index: number): void =>
      setImportQueue(
        (current) =>
          current?.filter((_, candidate) => candidate !== index) ?? null,
      ),
  };
}
