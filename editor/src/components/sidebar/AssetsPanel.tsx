import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ASSET_DRAG_TYPE } from "../../assetDrag";
import { editorApi } from "../../api";
import { frameCandidates, type AnimationDraft } from "../../imageAnimation";
import type { SidebarScrollStore } from "../projectSections";
import { findAssetReferences } from "../assetReferences";
import {
  assetChoiceOptions,
  assetDisplayName,
  assetFolderId,
  buildAssetFolderTree,
  createAssetFolder,
  folderDisplayPath,
  isAssetHidden,
  isValidAssetFolderName,
  moveAssetFolder,
  moveAssetsToFolder,
  removeAssetFolder,
  renameAssetFolder,
  setAssetDisplayName,
  setAssetHidden,
  validateFolderMove,
  type AssetFolderNode,
  type AssetChoiceOption,
} from "../../assetLibrary";
import { FolderInput, Pencil, Plus, Trash2 } from "lucide-react";
import { IconButton } from "../../ui/Button";
import { ASSET_KIND_ICONS } from "../../ui/assetIcons";
import { ASSET_KIND_LABELS } from "../../labels";
import { ImageAnimationPanel } from "../ImageAnimationPanel";
import type { AssetKind, EditorLayout, EditorProject } from "../../types";
import type { ImportDraft, SidebarTab } from "./types";
import {
  ASSET_KINDS,
  assetDescription,
  findFolderNode,
  flattenAssetFolders,
  formatAssetMetadata,
  formatAssetSize,
  readAssetDragPayload,
} from "./assetUtils";
import { useSidebarScroller } from "./useSidebarScroller";
import { TextEntryDialog } from "./TextEntryDialog";
import { FolderMoveDialog } from "./FolderMoveDialog";
import { AssetImportDialog } from "./AssetImportDialog";
import { AssetContextMenu } from "./AssetContextMenu";
import { AssetDetail } from "./AssetDetail";
import { useAssetImport } from "./useAssetImport";
import { errorMessage } from "../errorMessage";

export function AssetsPanel({
  project,
  onImportAssets,
  onRemoveAsset,
  onChangeAssetLayout,
  pendingAssetIds = [],
  reservedAssetPaths,
  onCreateImageAnimation,
  onScrollOffset,
  onSelectAsset,
  selectedAssetId,
  scrollStore,
}: {
  project: EditorProject;
  onImportAssets(items: ImportDraft[]): Promise<void>;
  onSelectAsset?(id: string | null): void;
  onRemoveAsset(id: string): boolean;
  onChangeAssetLayout?(
    mutate: (layout: EditorLayout) => EditorLayout,
    label: string,
  ): void;
  pendingAssetIds?: readonly string[];
  reservedAssetPaths?: Readonly<Record<string, readonly string[]>>;
  onCreateImageAnimation(draft: AnimationDraft): boolean;
  onScrollOffset?(tab: SidebarTab, offset: number): void;
  selectedAssetId?: string | null;
  scrollStore?: SidebarScrollStore;
}): ReactElement {
  const { assets, manifest } = project;
  const layout = project.layout;
  const animations = project.animations ?? [];
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [contextMenu, setContextMenu] = useState<{
    kind: "asset" | "folder" | "root";
    id: string | null;
    x: number;
    y: number;
  } | null>(null);
  const [selectionBox, setSelectionBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const explorerRef = useRef<HTMLDivElement>(null);
  const [showHidden, setShowHidden] = useState(true);
  const [folderFilter, setFolderFilter] = useState<string | null>("all");
  const [collapsedFolders, setCollapsedFolders] = useState<readonly string[]>(
    [],
  );
  const [folderDialog, setFolderDialog] = useState<
    | { mode: "create"; parentId: string | null }
    | { mode: "rename"; folderId: string }
    | null
  >(null);
  const [folderMoveTarget, setFolderMoveTarget] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [animationPanel, setAnimationPanel] = useState(false);
  const references = useMemo(
    () =>
      new Map(
        assets.map((asset) => [
          asset.id,
          findAssetReferences(project, asset.id),
        ]),
      ),
    [assets, project],
  );
  const shown = useMemo(
    () =>
      assetChoiceOptions({
        assets,
        layout,
        kind: kindFilter === "all" ? undefined : kindFilter,
        query,
        // Rows live under their own folder in the tree; selecting a folder
        // expands it rather than filtering all other folders away.
        // The asset manager is manager mode: hidden assets stay visible so
        // they can be unhidden, renamed or edited.  The toggle only narrows
        // that list for authors who want to see the runtime-effective set.
        includeHidden: showHidden,
        selectedIds,
      }),
    [assets, layout, kindFilter, query, showHidden, selectedIds],
  );
  const folderTree = useMemo(() => buildAssetFolderTree(layout), [layout]);
  const folderOptions = useMemo(() => flattenAssetFolders(layout), [layout]);
  const selectedAsset = assets.find((asset) => asset.id === selected);
  const selectedHidden =
    selectedAsset !== undefined && isAssetHidden(layout, selectedAsset.id);
  const selectedFolderId =
    selectedAsset === undefined
      ? null
      : assetFolderId(layout, selectedAsset.id);
  const selectedDisplayName =
    selectedAsset === undefined
      ? null
      : assetDisplayName(layout, selectedAsset.id);
  const selectedPending =
    selectedAsset !== undefined && pendingAssetIds.includes(selectedAsset.id);
  const commitLayout = useCallback(
    (mutate: (current: EditorLayout) => EditorLayout, label: string): void => {
      if (onChangeAssetLayout === undefined) return;
      onChangeAssetLayout(mutate, label);
    },
    [onChangeAssetLayout],
  );
  const moveAsset = (assetId: string, folderId: string | null): void => {
    setFolderError(null);
    commitLayout(
      (current) =>
        moveAssetsToFolder(
          current,
          selectedIds.includes(assetId) ? selectedIds : [assetId],
          folderId,
        ),
      "移动素材到文件夹",
    );
  };
  const commitDisplayName = (value: string | null): void => {
    if (selectedAsset === undefined) return;
    commitLayout(
      (current) => setAssetDisplayName(current, selectedAsset.id, value),
      "重命名素材显示名称",
    );
    setNameDraft(null);
  };
  const moveFolder = (folderId: string, parentId: string | null): void => {
    const check = validateFolderMove(layout, folderId, parentId);
    if (!check.ok) {
      setFolderError(check.reason);
      return;
    }
    setFolderError(null);
    commitLayout(
      (current) => moveAssetFolder(current, folderId, parentId),
      "移动素材文件夹",
    );
  };
  const handleDrop = (
    event: { preventDefault(): void; dataTransfer: DataTransfer | null },
    folderId: string | null,
  ): void => {
    event.preventDefault();
    const payload = readAssetDragPayload(event);
    const draggedAssets = payload.assetIds;
    if (draggedAssets !== undefined) {
      setFolderError(null);
      commitLayout(
        (current) => moveAssetsToFolder(current, draggedAssets, folderId),
        "批量移动素材",
      );
    } else if (payload.assetId !== undefined)
      moveAsset(payload.assetId, folderId);
    else if (payload.folderId !== undefined && payload.folderId !== folderId)
      moveFolder(payload.folderId, folderId);
  };
  const assetById = useMemo(
    () => new Map(assets.map((asset) => [asset.id, asset])),
    [assets],
  );
  const selectAsset = (id: string, additive = false, range = false): void => {
    const index = shown.findIndex((item) => item.id === id);
    const anchor = shown.findIndex((item) => item.id === selected);
    if (range && anchor >= 0) {
      const ids = shown
        .slice(Math.min(anchor, index), Math.max(anchor, index) + 1)
        .map((item) => item.id);
      setSelectedIds((current) => [...new Set([...current, ...ids])]);
    } else if (additive) {
      setSelectedIds((current) =>
        current.includes(id)
          ? current.filter((item) => item !== id)
          : [...current, id],
      );
    } else setSelectedIds([id]);
    setSelected(id);
    onSelectAsset?.(id);
  };
  const revealAsset = (id: string): void => {
    void editorApi.revealAsset(id).catch((reason: unknown) => {
      setFolderError(errorMessage(reason));
    });
  };
  useEffect(() => {
    if (contextMenu === null) return;
    const dismiss = (): void => setContextMenu(null);
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [contextMenu]);
  const renderAsset = (
    option: AssetChoiceOption,
    depth: number,
  ): ReactElement => {
    const asset = assetById.get(option.id);
    const pending = pendingAssetIds.includes(option.id);
    return (
      <button
        className={`asset-explorer-file${selectedIds.includes(option.id) ? " active" : ""}`}
        data-allow-context-menu="true"
        data-explorer-asset-id={option.id}
        draggable
        key={option.id}
        onClick={(event) =>
          selectAsset(option.id, event.ctrlKey || event.metaKey, event.shiftKey)
        }
        onContextMenu={(event) => {
          event.preventDefault();
          if (!selectedIds.includes(option.id)) selectAsset(option.id);
          setContextMenu({
            kind: "asset",
            id: option.id,
            x: event.clientX,
            y: event.clientY,
          });
        }}
        onDragStart={(event) => {
          event.dataTransfer.setData(ASSET_DRAG_TYPE, option.id);
          if (selectedIds.includes(option.id) && selectedIds.length > 1) {
            event.dataTransfer.setData(
              "application/x-vect-assets",
              JSON.stringify(selectedIds),
            );
          }
          event.dataTransfer.effectAllowed = "copyMove";
        }}
        style={{ paddingLeft: `${(depth + 1) * 14 + 6}px` }}
        type="button"
      >
        <AssetKindIcon kind={option.kind} />
        <span>
          <strong>
            {option.label}
            {option.label !== option.id && (
              <small className="asset-id-chip">{option.id}</small>
            )}
            {asset?.animation !== undefined && (
              <span className="animation-badge">动画</span>
            )}
            {option.hidden && (
              <span className="asset-hidden-badge">已隐藏</span>
            )}
            {pending && <span className="asset-pending-badge">待保存</span>}
          </strong>
          <small>
            {option.folderPath !== "" ? `目录：${option.folderPath} · ` : ""}
            {asset === undefined
              ? option.path
              : assetDescription(asset, manifest)}{" "}
            · {formatAssetSize(asset?.size_bytes)} ·{" "}
            {formatAssetMetadata(asset?.metadata)} ·{" "}
            {references.get(option.id)?.length ?? 0} 处引用
          </small>
        </span>
      </button>
    );
  };
  // "全部" shows everything; "未分组" only root-level assets; a folder only
  // the assets inside its own subtree.  Folder rows always stay visible so
  // the tree remains the navigation for the filter.
  const filterFolderIds = useMemo(() => {
    if (folderFilter === "all" || folderFilter === null) return null;
    const ids = new Set<string>();
    const collect = (node: AssetFolderNode | undefined): void => {
      if (node === undefined) return;
      ids.add(node.id);
      node.children.forEach(collect);
    };
    collect(findFolderNode(folderTree, folderFilter));
    return ids;
  }, [folderFilter, folderTree]);
  const folderAssetsVisible = (folderId: string): boolean =>
    folderFilter === "all" ||
    (filterFolderIds !== null && filterFolderIds.has(folderId));
  const renderFolder = (node: AssetFolderNode): ReactElement => {
    const isCollapsed = collapsedFolders.includes(node.id);
    const count = assets.filter(
      (asset) => assetFolderId(layout, asset.id) === node.id,
    ).length;
    const hasChildren = node.children.length > 0;
    return (
      <div className="asset-folder-branch" key={node.id}>
        <div
          className={`asset-folder-row${folderFilter === node.id ? " active" : ""}`}
          data-allow-context-menu="true"
          onContextMenu={(event) => {
            event.preventDefault();
            setContextMenu({
              kind: "folder",
              id: node.id,
              x: event.clientX,
              y: event.clientY,
            });
          }}
          style={{ paddingLeft: `${node.depth * 14}px` }}
        >
          <button
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? "展开" : "折叠"}文件夹 ${node.name}`}
            className="asset-folder-toggle"
            disabled={!hasChildren && count === 0}
            onClick={() =>
              setCollapsedFolders((current) =>
                isCollapsed
                  ? current.filter((id) => id !== node.id)
                  : [...current, node.id],
              )
            }
            type="button"
          >
            {hasChildren || count > 0 ? (isCollapsed ? "▸" : "▾") : "·"}
          </button>
          <button
            className="asset-folder-name"
            draggable
            onClick={() => {
              // Selecting a folder filters the list to its subtree and makes
              // sure that subtree is visible; the chevron toggles collapse.
              setFolderFilter(node.id);
              setCollapsedFolders((current) =>
                current.filter((id) => id !== node.id),
              );
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragStart={(event) => {
              event.dataTransfer.setData("application/x-vect-folder", node.id);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDrop={(event) => handleDrop(event, node.id)}
            title={node.name}
            type="button"
          >
            {node.name}
          </button>
          <span className="asset-folder-count">{count}</span>
          <IconButton
            onClick={() => {
              setFolderError(null);
              setFolderDialog({ mode: "rename", folderId: node.id });
            }}
            icon={Pencil}
            label={`重命名文件夹 ${node.name}`}
            size="sm"
            variant="ghost"
          />
          <IconButton
            onClick={() => {
              setFolderError(null);
              setFolderDialog({ mode: "create", parentId: node.id });
            }}
            icon={Plus}
            label={`在 ${node.name} 下新建子文件夹`}
            size="sm"
            variant="ghost"
          />
          <IconButton
            onClick={() => {
              // Folders are editor-only grouping: removing one moves its
              // contents up a level and is undoable, so it needs no prompt.
              commitLayout(
                (current) => removeAssetFolder(current, node.id),
                "删除素材文件夹",
              );
              if (folderFilter === node.id)
                setFolderFilter(node.parentId ?? "all");
            }}
            icon={Trash2}
            label={`删除文件夹 ${node.name}`}
            size="sm"
          />
          <IconButton
            onClick={() => {
              setFolderError(null);
              setFolderMoveTarget(node.id);
            }}
            icon={FolderInput}
            label={`移动文件夹 ${node.name}`}
            size="sm"
            variant="ghost"
          />
        </div>
        {!isCollapsed && (
          <>
            {node.children.map(renderFolder)}
            {shown
              .filter(
                (option) =>
                  option.folderId === node.id && folderAssetsVisible(node.id),
              )
              .map((option) => renderAsset(option, node.depth))}
            {node.children.length === 0 && count === 0 && (
              <p
                className="asset-folder-empty muted"
                style={{ paddingLeft: `${(node.depth + 1) * 14 + 22}px` }}
              >
                （空文件夹）
              </p>
            )}
          </>
        )}
      </div>
    );
  };
  const { onScroll: onAssetListScroll, ref: assetListRef } = useSidebarScroller(
    "assets",
    scrollStore,
    onScrollOffset,
  );
  const setExplorerRef = useCallback(
    (element: HTMLDivElement | null) => {
      explorerRef.current = element;
      assetListRef(element);
    },
    [assetListRef],
  );
  useEffect(() => {
    if (
      selectedAssetId !== null &&
      selectedAssetId !== undefined &&
      assets.some((asset) => asset.id === selectedAssetId)
    ) {
      // Search results can target an asset while the panel is mounted but
      // hidden behind another sidebar tab.  Keep the detail view in sync when
      // the caller explicitly requests that asset.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelected(selectedAssetId);
    }
  }, [assets, selectedAssetId]);
  const {
    importing,
    inspecting,
    importQueue,
    importError,
    queuePaths,
    pickAndQueue,
    queueReplacement,
    updateImport,
    submitImport,
    cancelImport,
    removeDraft,
  } = useAssetImport({
    assets,
    manifest,
    onImportAssets,
    onImported: setSelected,
    reservedAssetPaths,
  });
  const menuAssetId = contextMenu?.id ?? "";
  const mountDetail = (detail: ReactElement): ReactNode => {
    const target = document.getElementById("asset-detail-column");
    return target === null ? detail : createPortal(detail, target);
  };
  return (
    <div
      className="sidebar-body asset-sidebar"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        // An internal asset/folder drag has no OS files; a real file drop
        // carries a FileList.  Guard both so a synthetic drop never throws.
        const files = event.dataTransfer?.files;
        const paths = Array.from(files ?? [])
          .map((file) => (file as File & { path?: string }).path)
          .filter(
            (path): path is string =>
              typeof path === "string" && path.length > 0,
          );
        void queuePaths(paths);
      }}
    >
      <div className="sidebar-search-row">
        <input
          aria-label="搜索素材"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="搜索素材…"
          value={query}
        />
        <select
          aria-label="素材类型筛选"
          onChange={(event) =>
            setKindFilter(event.currentTarget.value as AssetKind | "all")
          }
          value={kindFilter}
        >
          <option value="all">全部</option>
          {ASSET_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {ASSET_KIND_LABELS[kind]}
            </option>
          ))}
        </select>
        <button
          disabled={importing || inspecting}
          onClick={() => void pickAndQueue()}
          title="导入素材"
          type="button"
        >
          {inspecting ? "检查中…" : "＋"}
        </button>
      </div>
      <button
        className="animation-create-entry"
        disabled={frameCandidates(assets).length === 0}
        onClick={() => setAnimationPanel(true)}
        title="把多张静态图片登记为一个循环帧动画素材"
        type="button"
      >
        创建帧动画
      </button>
      <div className="asset-folder-tree">
        <div className="asset-folder-toolbar">
          <button
            aria-label="新建根文件夹"
            onClick={() => {
              setFolderError(null);
              setFolderDialog({ mode: "create", parentId: null });
            }}
            type="button"
          >
            ＋ 新建文件夹
          </button>
          {selectedIds.length > 1 && (
            <label>
              已选 {selectedIds.length} 项 · 移动到
              <select
                aria-label="批量移动到文件夹"
                onChange={(event) => {
                  const destination = event.currentTarget.value;
                  setFolderError(null);
                  commitLayout(
                    (current) =>
                      moveAssetsToFolder(
                        current,
                        selectedIds,
                        destination === "" ? null : destination,
                      ),
                    "批量移动素材",
                  );
                }}
                value="__choose__"
              >
                <option disabled value="__choose__">
                  选择文件夹…
                </option>
                <option value="">未分组</option>
                {folderOptions.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.path}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="asset-hidden-toggle">
            <input
              checked={showHidden}
              onChange={(event) => setShowHidden(event.currentTarget.checked)}
              type="checkbox"
            />
            显示已隐藏
          </label>
        </div>
        <small className="muted">
          当前文件夹是虚拟分组；移动素材不会移动磁盘文件。
        </small>
        <div className="asset-folder-roots">
          <button
            className={folderFilter === "all" ? "active" : ""}
            onClick={() => {
              setFolderFilter("all");
              setCollapsedFolders([]);
            }}
            type="button"
          >
            全部素材
            <span className="asset-folder-count">{assets.length}</span>
          </button>
          <button
            aria-label="未分组（根目录）"
            className={folderFilter === null ? "active" : ""}
            data-allow-context-menu="true"
            onClick={() => setFolderFilter(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu({
                kind: "root",
                id: null,
                x: event.clientX,
                y: event.clientY,
              });
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => handleDrop(event, null)}
            type="button"
          >
            未分组
          </button>
        </div>
      </div>
      {folderError !== null && (
        <p className="inline-error" role="alert">
          {folderError}
        </p>
      )}
      <div
        className="asset-list asset-explorer-tree"
        data-allow-context-menu="true"
        data-sidebar-scroller="assets"
        onScroll={onAssetListScroll}
        onContextMenu={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("button,.asset-folder-row")
          )
            return;
          event.preventDefault();
          setContextMenu({
            kind: "root",
            id: null,
            x: event.clientX,
            y: event.clientY,
          });
        }}
        onPointerDown={(event) => {
          if (
            event.button !== 0 ||
            (event.target instanceof Element &&
              event.target.closest("button,input,select"))
          )
            return;
          const container = explorerRef.current;
          if (container === null) return;
          const startX = event.clientX;
          const startY = event.clientY;
          let moved = false;
          const move = (pointer: PointerEvent): void => {
            if (
              Math.abs(pointer.clientX - startX) +
                Math.abs(pointer.clientY - startY) <
              4
            )
              return;
            moved = true;
            const rect = container.getBoundingClientRect();
            const left = Math.max(rect.left, Math.min(startX, pointer.clientX));
            const right = Math.min(
              rect.right,
              Math.max(startX, pointer.clientX),
            );
            const top = Math.max(rect.top, Math.min(startY, pointer.clientY));
            const bottom = Math.min(
              rect.bottom,
              Math.max(startY, pointer.clientY),
            );
            setSelectionBox({
              left: left - rect.left,
              top: top - rect.top + container.scrollTop,
              width: Math.max(0, right - left),
              height: Math.max(0, bottom - top),
            });
            const ids = Array.from(
              container.querySelectorAll<HTMLElement>(
                "[data-explorer-asset-id]",
              ),
            )
              .filter((row) => {
                const bounds = row.getBoundingClientRect();
                return (
                  bounds.right >= left &&
                  bounds.left <= right &&
                  bounds.bottom >= top &&
                  bounds.top <= bottom
                );
              })
              .map((row) => row.dataset.explorerAssetId)
              .filter((id): id is string => id !== undefined);
            setSelectedIds(ids);
            setSelected(ids.at(-1) ?? null);
          };
          const finish = (): void => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", finish);
            window.removeEventListener("pointercancel", finish);
            setSelectionBox(null);
            onSelectAsset?.(null);
            if (!moved) {
              setSelectedIds([]);
              setSelected(null);
            }
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", finish, { once: true });
          window.addEventListener("pointercancel", finish, { once: true });
        }}
        ref={setExplorerRef}
      >
        {folderTree.map(renderFolder)}
        {assets.length === 0 && (
          <p className="muted">将文件拖到这里，或点击 ＋ 批量导入</p>
        )}
        {assets.length > 0 && shown.length === 0 && (
          <p className="muted">当前筛选没有素材。</p>
        )}
        {(folderFilter === "all" || folderFilter === null) &&
          shown
            .filter((option) => option.folderId === null)
            .map((option) => renderAsset(option, 0))}
        {selectionBox !== null && (
          <div
            aria-hidden="true"
            className="asset-selection-box"
            style={selectionBox}
          />
        )}
      </div>
      {contextMenu !== null && (
        <AssetContextMenu
          folderExists={
            contextMenu.id !== null &&
            layout.asset_folders?.[contextMenu.id] !== undefined
          }
          hidden={
            contextMenu.id !== null && isAssetHidden(layout, contextMenu.id)
          }
          onClose={() => setContextMenu(null)}
          onCopyId={(id) => void navigator.clipboard?.writeText(id)}
          onCreateFolder={(parentId) =>
            setFolderDialog({ mode: "create", parentId })
          }
          onDeleteFolder={(id) =>
            commitLayout(
              (current) => removeAssetFolder(current, id),
              "删除素材文件夹",
            )
          }
          onRemove={(id) => {
            if (onRemoveAsset(id)) {
              setSelected(null);
              setSelectedIds([]);
              onSelectAsset?.(null);
            }
          }}
          onRenameFolder={(folderId) =>
            setFolderDialog({ mode: "rename", folderId })
          }
          onReveal={revealAsset}
          onToggleHidden={(id) =>
            commitLayout(
              (current) =>
                setAssetHidden(current, id, !isAssetHidden(current, id)),
              "切换素材隐藏状态",
            )
          }
          onViewDetails={(id) => selectAsset(id)}
          pending={pendingAssetIds.includes(menuAssetId)}
          referenced={(references.get(menuAssetId)?.length ?? 0) > 0}
          target={contextMenu}
        />
      )}
      {selectedAsset !== undefined &&
        mountDetail(
          <AssetDetail
            animations={animations}
            asset={selectedAsset}
            assets={assets}
            busy={inspecting || importing}
            displayName={selectedDisplayName}
            folderId={selectedFolderId}
            folderLabel={
              folderDisplayPath(layout, selectedFolderId) || "（根目录）"
            }
            folderOptions={folderOptions}
            hidden={selectedHidden}
            nameDraft={nameDraft}
            onClose={() => {
              setSelected(null);
              setSelectedIds([]);
              onSelectAsset?.(null);
            }}
            onCommitName={commitDisplayName}
            onMoveToFolder={(folderId) => moveAsset(selectedAsset.id, folderId)}
            onNameDraftChange={setNameDraft}
            onRemove={() => {
              if (onRemoveAsset(selectedAsset.id)) {
                setSelected(null);
                onSelectAsset?.(null);
              }
            }}
            onReplace={() => void queueReplacement(selectedAsset)}
            onReveal={() => revealAsset(selectedAsset.id)}
            onToggleHidden={() =>
              commitLayout(
                (current) =>
                  setAssetHidden(current, selectedAsset.id, !selectedHidden),
                selectedHidden ? "取消隐藏素材" : "隐藏素材",
              )
            }
            pending={selectedPending}
            references={references.get(selectedAsset.id) ?? []}
          />,
        )}
      {importQueue !== null && (
        <AssetImportDialog
          error={importError}
          importing={importing}
          onCancel={cancelImport}
          onRemove={removeDraft}
          onSubmit={() => void submitImport()}
          onUpdate={updateImport}
          queue={importQueue}
        />
      )}
      {folderDialog !== null && folderDialog.mode === "create" && (
        <TextEntryDialog
          initialValue="新文件夹"
          onCancel={() => setFolderDialog(null)}
          onSubmit={(value) => {
            const result = createAssetFolder(layout, {
              name: value,
              parentId: folderDialog.parentId,
            });
            if (!result.ok) {
              setFolderError(result.reason);
              return false;
            }
            setFolderError(null);
            commitLayout(() => result.layout, "新建素材文件夹");
            setFolderDialog(null);
            return true;
          }}
          title="新建文件夹"
        />
      )}
      {folderDialog !== null && folderDialog.mode === "rename" && (
        <TextEntryDialog
          initialValue={
            (layout.asset_folders ?? {})[folderDialog.folderId]?.name ?? ""
          }
          onCancel={() => setFolderDialog(null)}
          onSubmit={(value) => {
            if (!isValidAssetFolderName(value)) {
              setFolderError("文件夹名称必须为 1–120 个非控制字符。");
              return false;
            }
            setFolderError(null);
            commitLayout(
              (current) =>
                renameAssetFolder(current, folderDialog.folderId, value),
              "重命名素材文件夹",
            );
            setFolderDialog(null);
            return true;
          }}
          title="重命名文件夹"
        />
      )}
      {folderMoveTarget !== null && (
        <FolderMoveDialog
          folderId={folderMoveTarget}
          layout={layout}
          onCancel={() => setFolderMoveTarget(null)}
          onSubmit={(parentId) => {
            moveFolder(folderMoveTarget, parentId);
            setFolderMoveTarget(null);
          }}
        />
      )}
      {animationPanel && (
        <ImageAnimationPanel
          assets={assets}
          existingAnimationIds={
            new Set(animations.map((file) => file.definition.id))
          }
          existingAnimationPaths={new Set(animations.map((file) => file.path))}
          existingAssetIds={new Set(Object.keys(manifest.assets))}
          onClose={() => setAnimationPanel(false)}
          onCreate={onCreateImageAnimation}
        />
      )}
    </div>
  );
}

function AssetKindIcon({ kind }: { kind: AssetKind }): ReactElement {
  const Icon = ASSET_KIND_ICONS[kind];
  return (
    <span
      className={`asset-kind asset-kind-${kind}`}
      title={ASSET_KIND_LABELS[kind]}
    >
      <Icon aria-hidden="true" />
    </span>
  );
}
