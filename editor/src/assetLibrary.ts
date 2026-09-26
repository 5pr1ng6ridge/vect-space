import type {
  AssetFolderLayout,
  AssetKind,
  AssetLayoutMetadata,
  AssetMetadata,
  ContentManifest,
  EditorAsset,
  EditorLayout,
  ImportedAsset,
} from "./types";

/**
 * Editor-only asset library metadata.
 *
 * Virtual folders, display names and the hidden flag live exclusively in
 * `.vectspace/layout-v1.json` (`EditorLayout.asset_folders` /
 * `EditorLayout.asset_metadata`).  They are keyed by stable ids, so grouping,
 * renaming and hiding never touch a manifest path, a runtime reference or a
 * binary on disk.  Every function here is pure: it returns a new
 * `EditorLayout` value with structural sharing and never mutates its input, so
 * an Immer history commit can assign the result and stay undoable.
 *
 * The Rust host mirrors the same defaults and repairs a hand-edited layout
 * (`normalize_asset_layout` in `editor/src-tauri/src/lib.rs`); the helpers
 * below are the editor's authority for interactive validation.
 */

export const ASSET_FOLDER_NAME_MAX_CHARS = 120;
export const ASSET_FOLDER_MAX_DEPTH = 16;
export const ASSET_FOLDER_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Pinned collator: folder and chooser ordering must not depend on the host
 * locale (`Intl.Collator()` would resolve to `zh-CN` on the author's machine
 * and to `en-US` in CI, producing a different list order).
 */
const assetNameCollator = new Intl.Collator("en", { sensitivity: "base" });

/** One virtual folder in tree order. */
export interface AssetFolderNode {
  id: string;
  name: string;
  parentId: string | null;
  /** Full *name* path from the root, e.g. `["背景", "旧版本"]`. */
  path: string[];
  /** Full *id* path from the root, including this folder. */
  pathIds: string[];
  order: number;
  depth: number;
  children: AssetFolderNode[];
}

export interface AssetFileLike {
  id: string;
  kind: AssetKind;
  path?: string;
  animation?: string;
}

export interface AssetChoiceOption {
  id: string;
  kind: AssetKind;
  /** Preferred list label: the display name when set, else the stable id. */
  label: string;
  displayName: string | null;
  path: string | null;
  folderId: string | null;
  /** Folder name path joined with `/`; `""` means the root. */
  folderPath: string;
  hidden: boolean;
  /** The option is hidden but kept because it is the current value. */
  selectedHidden: boolean;
  /** The option is one of the currently selected/picked values. */
  selected: boolean;
}

export interface AssetChoiceQuery {
  assets: readonly AssetFileLike[];
  layout: EditorLayout | null | undefined;
  /** Restrict to one kind or a set of kinds.  Omit for every kind. */
  kind?: AssetKind | readonly AssetKind[];
  /** Currently selected/picked ids.  `null`/`undefined` entries are ignored. */
  selectedIds?: readonly (string | null | undefined)[];
  /** Case-insensitive search over display name, id, path and folder. */
  query?: string;
  /**
   * Restrict to a folder and its descendants.  `null` means "the root
   * folder" only when `folderId` is explicitly `null`; `undefined` means "no
   * folder filter".
   */
  folderId?: string | null;
  /** Manager mode: keep hidden assets in the list (for unhide/edit). */
  includeHidden?: boolean;
}

export type AssetFolderMoveCheck = { ok: true } | { ok: false; reason: string };

export type AssetFolderCreation =
  | { ok: true; layout: EditorLayout; folderId: string }
  | { ok: false; reason: string };

export function assetFolderMap(
  layout: EditorLayout | null | undefined,
): Record<string, AssetFolderLayout> {
  return layout?.asset_folders ?? {};
}

export function assetMetadataMap(
  layout: EditorLayout | null | undefined,
): Record<string, AssetLayoutMetadata> {
  return layout?.asset_metadata ?? {};
}

export function isValidAssetFolderId(value: string): boolean {
  return ASSET_FOLDER_ID_PATTERN.test(value);
}

export function isValidAssetFolderName(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= ASSET_FOLDER_NAME_MAX_CHARS &&
    !/[\u0000-\u001f\u007f]/.test(trimmed)
  );
}

/** Metadata for one asset, with the empty default materialised. */
export function assetMetadataFor(
  layout: EditorLayout | null | undefined,
  assetId: string,
): AssetLayoutMetadata {
  return assetMetadataMap(layout)[assetId] ?? {};
}

export function isAssetHidden(
  layout: EditorLayout | null | undefined,
  assetId: string,
): boolean {
  return assetMetadataFor(layout, assetId).hidden === true;
}

export function hiddenAssetIds(
  assets: readonly { id: string }[],
  layout: EditorLayout | null | undefined,
): string[] {
  return assets
    .filter((asset) => isAssetHidden(layout, asset.id))
    .map((asset) => asset.id);
}

export function assetDisplayName(
  layout: EditorLayout | null | undefined,
  assetId: string,
): string | null {
  const value = assetMetadataFor(layout, assetId).display_name;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** List label: the display name when present, otherwise the stable id. */
export function assetLabel(
  layout: EditorLayout | null | undefined,
  assetId: string,
): string {
  return assetDisplayName(layout, assetId) ?? assetId;
}

export function assetFolderId(
  layout: EditorLayout | null | undefined,
  assetId: string,
): string | null {
  return assetMetadataFor(layout, assetId).folder_id ?? null;
}

/**
 * Folder ids from a root down to `folderId`.  Unknown ids return `[]` and a
 * hand-edited cycle terminates instead of looping forever.
 */
export function folderPathIds(
  layout: EditorLayout | null | undefined,
  folderId: string | null,
): string[] {
  const folders = assetFolderMap(layout);
  if (folderId === null || folders[folderId] === undefined) return [];
  const seen = new Set<string>();
  const reversed: string[] = [];
  let current: string | null = folderId;
  while (current !== null) {
    const folder: AssetFolderLayout | undefined = folders[current];
    if (folder === undefined) break;
    if (seen.has(current) || reversed.length > ASSET_FOLDER_MAX_DEPTH) {
      // A hand-edited cycle (or an absurdly deep chain) is rendered as a
      // root folder rather than a bogus truncated path.
      return [folderId];
    }
    seen.add(current);
    reversed.push(current);
    current = folder.parent_id ?? null;
  }
  return reversed.reverse();
}

export function folderPathNames(
  layout: EditorLayout | null | undefined,
  folderId: string | null,
): string[] {
  const folders = assetFolderMap(layout);
  return folderPathIds(layout, folderId).map((id) => folders[id]?.name ?? id);
}

/** Display path used in list rows and the chooser breadcrumb. */
export function folderDisplayPath(
  layout: EditorLayout | null | undefined,
  folderId: string | null,
): string {
  return folderPathNames(layout, folderId).join("/");
}

export function folderDepth(
  layout: EditorLayout | null | undefined,
  folderId: string | null,
): number {
  return folderPathIds(layout, folderId).length;
}

/**
 * Folder-scope test used by the chooser's folder filter.
 *
 * `folderId === undefined` is handled by the caller ("no filter").  Here a
 * `null` scope means the **root / unassigned** bucket only (an asset with no
 * virtual folder), while a concrete id matches that folder and its
 * descendants.  This mirrors the asset manager's “未分组” row: selecting the
 * root must not silently include nested folders.
 */
export function folderIsWithin(
  layout: EditorLayout | null | undefined,
  folderId: string | null,
  candidate: string | null,
): boolean {
  if (folderId === null) return candidate === null;
  if (candidate === null) return false;
  return folderPathIds(layout, candidate).includes(folderId);
}

/** Direct children of `parentId` (or the roots) in deterministic order. */
export function folderChildIds(
  layout: EditorLayout | null | undefined,
  parentId: string | null,
): string[] {
  const folders = assetFolderMap(layout);
  return Object.entries(folders)
    .filter(([, folder]) => (folder.parent_id ?? null) === parentId)
    .sort(([leftId, left], [rightId, right]) => {
      if (left.order !== right.order) return left.order - right.order;
      const byName = assetNameCollator.compare(left.name, right.name);
      if (byName !== 0) return byName;
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    })
    .map(([id]) => id);
}

/** Whole forest; cyclic or dangling folders degrade to roots. */
export function buildAssetFolderTree(
  layout: EditorLayout | null | undefined,
): AssetFolderNode[] {
  const folders = assetFolderMap(layout);
  /** A folder is usable as a parent only when its own chain terminates. */
  const chainTerminates = (start: string): boolean => {
    const seen = new Set<string>();
    let current = start;
    for (let step = 0; step <= ASSET_FOLDER_MAX_DEPTH; step += 1) {
      const folder: AssetFolderLayout | undefined = folders[current];
      if (folder === undefined || seen.has(current)) return false;
      seen.add(current);
      const parent = folder.parent_id ?? null;
      if (parent === null) return true;
      current = parent;
    }
    return false;
  };
  const childrenOf = new Map<string | null, string[]>();
  for (const [id, folder] of Object.entries(folders)) {
    const parent = folder.parent_id ?? null;
    // A dangling parent or a cycle is treated as a root so the tree can
    // still be rendered (the host normalizer rewrites the stored file).
    const safeParent =
      parent !== null && parent !== id && chainTerminates(parent)
        ? parent
        : null;
    const bucket = childrenOf.get(safeParent) ?? [];
    bucket.push(id);
    childrenOf.set(safeParent, bucket);
  }
  const sortIds = (ids: string[]): string[] =>
    [...ids].sort((left, right) => {
      const leftOrder = folders[left]?.order ?? 0;
      const rightOrder = folders[right]?.order ?? 0;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      const byName = assetNameCollator.compare(
        folders[left]?.name ?? left,
        folders[right]?.name ?? right,
      );
      if (byName !== 0) return byName;
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const build = (parentId: string | null, path: string[]): AssetFolderNode[] =>
    sortIds(childrenOf.get(parentId) ?? []).map((id) => {
      const folder = folders[id];
      const name = folder?.name ?? id;
      const names = [...path, name];
      return {
        id,
        name,
        parentId,
        path: names,
        pathIds: folderPathIds(layout, id),
        order: folder?.order ?? 0,
        depth: names.length - 1,
        children: build(id, names),
      };
    });
  return build(null, []);
}

/**
 * Why a folder cannot be re-parented.  Moving a folder into itself or into
 * one of its own descendants would create a cycle, so it is rejected before
 * any layout edit is produced.
 */
export function validateFolderMove(
  layout: EditorLayout | null | undefined,
  folderId: string,
  parentId: string | null,
): AssetFolderMoveCheck {
  const folders = assetFolderMap(layout);
  if (folders[folderId] === undefined) {
    return { ok: false, reason: `文件夹不存在：${folderId}` };
  }
  if (parentId !== null && folders[parentId] === undefined) {
    return { ok: false, reason: `目标文件夹不存在：${parentId}` };
  }
  if (parentId === folderId) {
    return { ok: false, reason: "不能把文件夹移动到它自己里面。" };
  }
  if (parentId !== null && folderPathIds(layout, parentId).includes(folderId)) {
    return { ok: false, reason: "不能把文件夹移动到它的子文件夹里面。" };
  }
  const subtreeDepth = folderSubtreeDepth(layout, folderId);
  const parentDepth = parentId === null ? 0 : folderDepth(layout, parentId);
  if (parentDepth + 1 + subtreeDepth > ASSET_FOLDER_MAX_DEPTH) {
    return {
      ok: false,
      reason: `文件夹嵌套不能超过 ${ASSET_FOLDER_MAX_DEPTH} 层。`,
    };
  }
  return { ok: true };
}

function folderSubtreeDepth(
  layout: EditorLayout | null | undefined,
  folderId: string,
): number {
  const folders = assetFolderMap(layout);
  const visited = new Set<string>();
  let deepest = 0;
  const visit = (id: string, depth: number): void => {
    if (visited.has(id) || depth > ASSET_FOLDER_MAX_DEPTH) return;
    visited.add(id);
    deepest = Math.max(deepest, depth);
    for (const [childId, child] of Object.entries(folders)) {
      if ((child.parent_id ?? null) === id && childId !== id) {
        visit(childId, depth + 1);
      }
    }
  };
  visit(folderId, 0);
  return deepest;
}

/**
 * Immutable layout update: returns a new `EditorLayout` sharing every
 * untouched field.  Returns `layout` unchanged when the move is invalid.
 */
export function moveAssetFolder(
  layout: EditorLayout,
  folderId: string,
  parentId: string | null,
): EditorLayout {
  const check = validateFolderMove(layout, folderId, parentId);
  if (!check.ok) return layout;
  const folder = assetFolderMap(layout)[folderId];
  return {
    ...layout,
    asset_folders: {
      ...assetFolderMap(layout),
      [folderId]: { ...folder, parent_id: parentId },
    },
  };
}

/** Dissolve a folder without deleting assets or descendants. They move to its parent. */
export function removeAssetFolder(
  layout: EditorLayout,
  folderId: string,
): EditorLayout {
  const folders = assetFolderMap(layout);
  const folder = folders[folderId];
  if (folder === undefined) return layout;
  const parentId = folder.parent_id ?? null;
  const nextFolders = { ...folders };
  Reflect.deleteProperty(nextFolders, folderId);
  for (const [id, child] of Object.entries(nextFolders)) {
    if (child.parent_id === folderId)
      nextFolders[id] = { ...child, parent_id: parentId };
  }
  const nextMetadata = { ...assetMetadataMap(layout) };
  for (const [id, metadata] of Object.entries(nextMetadata)) {
    if (metadata.folder_id === folderId)
      nextMetadata[id] = { ...metadata, folder_id: parentId };
  }
  return {
    ...layout,
    asset_folders: nextFolders,
    asset_metadata: nextMetadata,
  };
}

export function renameAssetFolder(
  layout: EditorLayout,
  folderId: string,
  name: string,
): EditorLayout {
  const folder = assetFolderMap(layout)[folderId];
  if (folder === undefined) return layout;
  const trimmed = name.trim();
  if (!isValidAssetFolderName(trimmed)) return layout;
  return {
    ...layout,
    asset_folders: {
      ...assetFolderMap(layout),
      [folderId]: { ...folder, name: trimmed },
    },
  };
}

export function setAssetFolderOrder(
  layout: EditorLayout,
  folderId: string,
  order: number,
): EditorLayout {
  const folder = assetFolderMap(layout)[folderId];
  if (folder === undefined || !Number.isFinite(order)) return layout;
  return {
    ...layout,
    asset_folders: {
      ...assetFolderMap(layout),
      [folderId]: { ...folder, order },
    },
  };
}

/** Derives a stable, unused folder id from a name (or `folder`). */
export function deriveAssetFolderId(
  layout: EditorLayout | null | undefined,
  name?: string,
): string {
  const folders = assetFolderMap(layout);
  const cleaned = (name ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 120);
  const base = ASSET_FOLDER_ID_PATTERN.test(cleaned) ? cleaned : "folder";
  if (folders[base] === undefined) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}_${index}`;
    if (folders[candidate] === undefined) return candidate;
  }
}

export function createAssetFolder(
  layout: EditorLayout,
  options: {
    name: string;
    parentId?: string | null;
    id?: string;
    order?: number;
  },
): AssetFolderCreation {
  const name = options.name.trim();
  if (!isValidAssetFolderName(name)) {
    return {
      ok: false,
      reason: `文件夹名称必须为 1–${ASSET_FOLDER_NAME_MAX_CHARS} 个非控制字符。`,
    };
  }
  const parentId = options.parentId ?? null;
  if (parentId !== null && assetFolderMap(layout)[parentId] === undefined) {
    return { ok: false, reason: `目标文件夹不存在：${parentId}` };
  }
  const depth = (parentId === null ? 0 : folderDepth(layout, parentId)) + 1;
  if (depth > ASSET_FOLDER_MAX_DEPTH) {
    return {
      ok: false,
      reason: `文件夹嵌套不能超过 ${ASSET_FOLDER_MAX_DEPTH} 层。`,
    };
  }
  const requested = options.id ?? deriveAssetFolderId(layout, name);
  if (!isValidAssetFolderId(requested)) {
    return { ok: false, reason: `文件夹 ID 非法：${requested}` };
  }
  if (assetFolderMap(layout)[requested] !== undefined) {
    return { ok: false, reason: `文件夹 ID 已存在：${requested}` };
  }
  const order =
    options.order ??
    folderChildIds(layout, parentId).reduce(
      (highest, id) =>
        Math.max(highest, assetFolderMap(layout)[id]?.order ?? 0),
      -1,
    ) + 1;
  return {
    ok: true,
    folderId: requested,
    layout: {
      ...layout,
      asset_folders: {
        ...assetFolderMap(layout),
        [requested]: { parent_id: parentId, name, order },
      },
    },
  };
}

function withAssetMetadata(
  layout: EditorLayout,
  assetId: string,
  update: (metadata: AssetLayoutMetadata) => AssetLayoutMetadata,
): EditorLayout {
  const current = assetMetadataMap(layout);
  const existing = current[assetId];
  const next = update(existing ?? {});
  const normalized: AssetLayoutMetadata = {};
  if (typeof next.folder_id === "string" && next.folder_id !== "") {
    normalized.folder_id = next.folder_id;
  }
  if (
    typeof next.display_name === "string" &&
    next.display_name.trim() !== "" &&
    isValidAssetFolderName(next.display_name)
  ) {
    normalized.display_name = next.display_name.trim();
  }
  if (next.hidden === true) normalized.hidden = true;
  if (Object.keys(normalized).length === 0) {
    if (existing === undefined) return layout;
    const rest = Object.fromEntries(
      Object.entries(current).filter(([id]) => id !== assetId),
    );
    return { ...layout, asset_metadata: rest };
  }
  if (existing !== undefined && metadataEquals(existing, normalized)) {
    // No-op edits keep the same value so Immer records no patch.
    return layout;
  }
  return { ...layout, asset_metadata: { ...current, [assetId]: normalized } };
}

function metadataEquals(
  left: AssetLayoutMetadata,
  right: AssetLayoutMetadata,
): boolean {
  return (
    (left.folder_id ?? null) === (right.folder_id ?? null) &&
    (left.display_name ?? null) === (right.display_name ?? null) &&
    (left.hidden === true) === (right.hidden === true)
  );
}

/** Move one asset between virtual folders.  `null` means the root. */
export function moveAssetToFolder(
  layout: EditorLayout,
  assetId: string,
  folderId: string | null,
): EditorLayout {
  if (folderId !== null && assetFolderMap(layout)[folderId] === undefined) {
    return layout;
  }
  return withAssetMetadata(layout, assetId, (metadata) => ({
    ...metadata,
    folder_id: folderId,
  }));
}

/** One history entry for an entire multi-selection. */
export function moveAssetsToFolder(
  layout: EditorLayout,
  assetIds: readonly string[],
  folderId: string | null,
): EditorLayout {
  if (folderId !== null && assetFolderMap(layout)[folderId] === undefined)
    return layout;
  return [...new Set(assetIds)].reduce(
    (current, id) => moveAssetToFolder(current, id, folderId),
    layout,
  );
}

export function setAssetDisplayName(
  layout: EditorLayout,
  assetId: string,
  displayName: string | null,
): EditorLayout {
  const trimmed = displayName?.trim() ?? "";
  if (trimmed !== "" && !isValidAssetFolderName(trimmed)) return layout;
  return withAssetMetadata(layout, assetId, (metadata) => ({
    ...metadata,
    display_name: trimmed === "" ? null : trimmed,
  }));
}

export function setAssetHidden(
  layout: EditorLayout,
  assetId: string,
  hidden: boolean,
): EditorLayout {
  return withAssetMetadata(layout, assetId, (metadata) => ({
    ...metadata,
    hidden,
  }));
}

/**
 * Drop editor-only metadata whose asset no longer exists.  Removal is
 * explicit and never automatic: an old layout that still mentions a removed
 * asset must keep loading, and the host keeps those entries harmless.
 */
export function pruneAssetLayoutMetadata(
  layout: EditorLayout,
  liveAssetIds: ReadonlySet<string>,
): EditorLayout {
  const metadata = assetMetadataMap(layout);
  const kept = Object.fromEntries(
    Object.entries(metadata).filter(([id]) => liveAssetIds.has(id)),
  );
  if (Object.keys(kept).length === Object.keys(metadata).length) return layout;
  return { ...layout, asset_metadata: kept };
}

function matchesKinds(
  asset: AssetFileLike,
  kind: AssetKind | readonly AssetKind[] | undefined,
): boolean {
  if (kind === undefined) return true;
  return Array.isArray(kind) ? kind.includes(asset.kind) : asset.kind === kind;
}

function matchesQuery(
  terms: readonly string[],
  haystacks: readonly (string | null)[],
): boolean {
  if (terms.length === 0) return true;
  const joined = haystacks
    .filter((value): value is string => typeof value === "string")
    .join("\u0000")
    .toLowerCase();
  return terms.every((term) => joined.includes(term));
}

/**
 * First asset of one or more kinds that is not hidden, in the caller's own
 * order.  Used for *default* picks (new track, new decoration, action preview,
 * new character expression): a hidden asset must never be chosen silently.
 * Returns `null` when nothing visible exists — callers surface an empty state
 * instead of falling back to a hidden asset.
 */
export function firstVisibleAssetId(
  assets: readonly AssetFileLike[],
  layout: EditorLayout | null | undefined,
  kind: AssetKind | readonly AssetKind[],
): string | null {
  const kinds = typeof kind === "string" ? [kind] : kind;
  for (const asset of assets) {
    if (!kinds.includes(asset.kind)) continue;
    if (isAssetHidden(layout, asset.id)) continue;
    return asset.id;
  }
  return null;
}

/**
 * The single candidate function behind every asset chooser.
 *
 * Hidden assets are excluded for *new* choices, but a hidden id that is
 * currently selected/picked stays in the list (marked `selectedHidden`) so
 * editing a node can never silently clear its value.  `includeHidden` is the
 * asset-manager mode used to unhide and edit hidden assets.
 */
export function assetChoiceOptions(
  input: AssetChoiceQuery,
): AssetChoiceOption[] {
  const { assets, layout } = input;
  const selected = new Set(
    (input.selectedIds ?? []).filter(
      (id): id is string => typeof id === "string" && id !== "",
    ),
  );
  const terms = (input.query ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "");
  const restrictFolder = "folderId" in input && input.folderId !== undefined;
  const options: AssetChoiceOption[] = [];
  for (const asset of assets) {
    if (!matchesKinds(asset, input.kind)) continue;
    const metadata = assetMetadataFor(layout, asset.id);
    const hidden = metadata.hidden === true;
    const isSelected = selected.has(asset.id);
    if (hidden && !isSelected && input.includeHidden !== true) continue;
    const folderId = metadata.folder_id ?? null;
    if (
      restrictFolder &&
      !folderIsWithin(layout, input.folderId ?? null, folderId)
    ) {
      continue;
    }
    const displayName = assetDisplayName(layout, asset.id);
    const folderPath = folderDisplayPath(layout, folderId);
    if (
      !matchesQuery(terms, [
        displayName,
        asset.id,
        asset.path ?? null,
        folderPath === "" ? null : folderPath,
      ])
    ) {
      continue;
    }
    options.push({
      id: asset.id,
      kind: asset.kind,
      label: displayName ?? asset.id,
      displayName,
      path: asset.path ?? null,
      folderId,
      folderPath,
      hidden,
      selectedHidden: hidden && isSelected,
      selected: isSelected,
    });
  }
  return options.sort((left, right) => {
    const byLabel = assetNameCollator.compare(left.label, right.label);
    if (byLabel !== 0) return byLabel;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/* ------------------------------------------------------------------ *
 * Staged import / replacement plumbing (host API contracts).
 * ------------------------------------------------------------------ */

/**
 * One live import capability.  A token is only usable while the manifest
 * still registers the same id, kind **and** path; an undo that restores a
 * different path therefore drops the obsolete token instead of submitting a
 * path-mismatched capability (the host would reject the whole save).
 */
export interface PendingAssetImport {
  id: string;
  kind: AssetKind;
  path: string;
}

export function pendingImportRecord(
  imported: ImportedAsset,
): PendingAssetImport {
  return { id: imported.id, kind: imported.kind, path: imported.path };
}

export function registerPendingImports(
  current: Readonly<Record<string, PendingAssetImport>>,
  imported: readonly ImportedAsset[],
): Record<string, PendingAssetImport> {
  const next: Record<string, PendingAssetImport> = { ...current };
  for (const asset of imported) {
    if (asset.token === undefined || asset.token === null) continue;
    next[asset.token] = pendingImportRecord(asset);
  }
  return next;
}

/** Tokens that still match the current manifest registration. */
export function activeImportTokens(
  pending: Readonly<Record<string, PendingAssetImport>>,
  manifest: ContentManifest,
): string[] {
  return Object.entries(pending)
    .filter(([, record]) => {
      const definition = manifest.assets[record.id];
      return (
        definition !== undefined &&
        definition.kind === record.kind &&
        (definition.path ?? null) === record.path
      );
    })
    .map(([token]) => token);
}

/**
 * Logical ids that currently have an *active* staged import.
 *
 * The asset library's "待保存" badge uses this: a token whose manifest
 * id/kind/path no longer matches (for example after an undo restored a
 * replaced asset's old path) drops out of the badge list, while its record is
 * kept so a redo re-activates it.  Never deletes a capability.
 */
export function activePendingAssetIds(
  pending: Readonly<Record<string, PendingAssetImport>>,
  manifest: ContentManifest,
): string[] {
  const active = new Set(activeImportTokens(pending, manifest));
  return Object.entries(pending)
    .filter(([token]) => active.has(token))
    .map(([, record]) => record.id);
}

export interface StagedAssetDraft {
  manifest: ContentManifest;
  assets: EditorAsset[];
}

/**
 * Apply one staged asset result to an Immer draft.  An existing id is
 * replaced **in place**: replacement never appends a second `EditorAsset`
 * row, and the manifest keeps the same logical id while its path moves to the
 * new staged destination.  The refreshed metadata/absolute path is what makes
 * every derived URL and the preview cache pick up the staged binary
 * immediately.
 */
export function applyStagedAsset(
  draft: StagedAssetDraft,
  imported: ImportedAsset,
  metadata?: AssetMetadata | null,
): void {
  draft.manifest.assets[imported.id] = {
    kind: imported.kind,
    path: imported.path,
  };
  const index = draft.assets.findIndex((asset) => asset.id === imported.id);
  const row: EditorAsset = {
    id: imported.id,
    kind: imported.kind,
    path: imported.path,
    absolute_path: imported.absolute_path,
    size_bytes: imported.size_bytes,
    metadata: metadata ?? null,
  };
  if (index === -1) {
    draft.assets.push(row);
    return;
  }
  draft.assets[index] = { ...draft.assets[index], ...row };
}
