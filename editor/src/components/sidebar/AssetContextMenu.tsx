import type { ReactElement } from "react";

export interface AssetContextMenuTarget {
  kind: "asset" | "folder" | "root";
  id: string | null;
  x: number;
  y: number;
}

/** Right-click menu of the asset explorer (asset rows, folder rows, empty area). */
export function AssetContextMenu({
  folderExists,
  hidden,
  onClose,
  onCopyId,
  onCreateFolder,
  onDeleteFolder,
  onRemove,
  onRenameFolder,
  onReveal,
  onToggleHidden,
  onViewDetails,
  pending,
  referenced,
  target,
}: {
  /** The right-clicked folder still exists in the layout. */
  folderExists: boolean;
  hidden: boolean;
  onClose(): void;
  onCopyId(id: string): void;
  onCreateFolder(parentId: string | null): void;
  onDeleteFolder(id: string): void;
  onRemove(id: string): void;
  onRenameFolder(id: string): void;
  onReveal(id: string): void;
  onToggleHidden(id: string): void;
  onViewDetails(id: string): void;
  /** The asset binary is staged but not saved yet. */
  pending: boolean;
  /** The asset is still referenced somewhere and cannot be removed. */
  referenced: boolean;
  target: AssetContextMenuTarget;
}): ReactElement {
  const id = target.id ?? "";
  const run = (action: () => void) => () => {
    action();
    onClose();
  };
  return (
    <div
      aria-label="素材操作"
      className="asset-context-menu"
      onPointerDown={(event) => event.stopPropagation()}
      role="menu"
      style={{
        left: Math.min(target.x, window.innerWidth - 205),
        top: Math.min(target.y, window.innerHeight - 230),
      }}
    >
      {target.kind === "asset" && target.id !== null && (
        <>
          <button
            disabled={pending}
            onClick={run(() => onReveal(id))}
            role="menuitem"
            type="button"
          >
            打开文件所在位置
          </button>
          <button
            onClick={run(() => onCopyId(id))}
            role="menuitem"
            type="button"
          >
            复制素材 ID
          </button>
          <button
            onClick={run(() => onViewDetails(id))}
            role="menuitem"
            type="button"
          >
            查看／编辑详情
          </button>
          <button
            onClick={run(() => onToggleHidden(id))}
            role="menuitem"
            type="button"
          >
            {hidden ? "取消隐藏" : "隐藏素材"}
          </button>
          <button
            disabled={referenced}
            onClick={run(() => onRemove(id))}
            role="menuitem"
            title={
              referenced ? "该素材仍被引用，需先解除引用才能移除" : undefined
            }
            type="button"
          >
            从清单移除
          </button>
        </>
      )}
      {target.kind !== "asset" && (
        <>
          <button
            onClick={run(() => onCreateFolder(target.id))}
            role="menuitem"
            type="button"
          >
            新建文件夹
          </button>
          {target.kind === "folder" && target.id !== null && (
            <>
              <button
                onClick={run(() => {
                  if (folderExists) onRenameFolder(id);
                })}
                role="menuitem"
                type="button"
              >
                重命名文件夹
              </button>
              <button
                onClick={run(() => onDeleteFolder(id))}
                role="menuitem"
                type="button"
              >
                删除文件夹
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
