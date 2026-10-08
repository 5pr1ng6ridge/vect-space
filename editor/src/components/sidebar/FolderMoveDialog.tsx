import { useState, type ReactElement } from "react";
import { validateFolderMove } from "../../assetLibrary";
import type { EditorLayout } from "../../types";
import { flattenAssetFolders } from "./assetUtils";

/** Keyboard-accessible folder reparenting (the drag/drop alternative). */
export function FolderMoveDialog({
  layout,
  folderId,
  onCancel,
  onSubmit,
}: {
  layout: EditorLayout;
  folderId: string;
  onCancel(): void;
  onSubmit(parentId: string | null): void;
}): ReactElement {
  const [parent, setParent] = useState<string>(
    () => (layout.asset_folders ?? {})[folderId]?.parent_id ?? "",
  );
  const options = flattenAssetFolders(layout).filter(
    (folder) =>
      folder.id !== folderId &&
      validateFolderMove(layout, folderId, folder.id).ok,
  );
  return (
    <div
      className="editor-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <form
        className="editor-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(parent === "" ? null : parent);
        }}
      >
        <h3>移动文件夹</h3>
        <label>
          目标父文件夹
          <select
            aria-label="目标父文件夹"
            onChange={(event) => setParent(event.currentTarget.value)}
            value={parent}
          >
            <option value="">（根目录）</option>
            {options.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.path}
              </option>
            ))}
          </select>
        </label>
        <div className="editor-dialog-actions">
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button className="primary-button" type="submit">
            确定
          </button>
        </div>
      </form>
    </div>
  );
}
