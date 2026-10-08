import type { ReactElement } from "react";
import { Trash2 } from "lucide-react";
import { IconButton } from "../../ui/Button";
import { ASSET_KIND_LABELS } from "../../labels";
import type { AssetKind } from "../../types";
import { ASSET_KINDS, formatInspectionSize } from "./assetUtils";
import type { ImportDraft } from "./types";

/** Editable import / replace manifest shown before assets reach the project. */
export function AssetImportDialog({
  error,
  importing,
  onCancel,
  onRemove,
  onSubmit,
  onUpdate,
  queue,
}: {
  error: string | null;
  importing: boolean;
  onCancel(): void;
  onRemove(index: number): void;
  onSubmit(): void;
  onUpdate(index: number, update: Partial<ImportDraft>): void;
  queue: readonly ImportDraft[];
}): ReactElement {
  return (
    <div
      className="asset-import-dialog"
      role="dialog"
      aria-label={
        queue.some((item) => item.replaceId !== undefined)
          ? "替换素材文件"
          : "导入素材"
      }
    >
      <header>
        <strong>
          {queue.some((item) => item.replaceId !== undefined)
            ? `替换素材文件（${queue.length}）`
            : `导入素材 (${queue.length})`}
        </strong>
        <button onClick={() => onCancel()} type="button">
          取消
        </button>
      </header>
      <p>确认素材 ID、类型和文件名后导入；保存项目时才会正式写入。</p>
      {queue.some((item) => item.replaceId !== undefined) && (
        <p className="muted">
          替换保留逻辑 ID
          与引用关系，但必须写入一个不同路径的新文件；旧文件不会被
          覆盖或删除，仍留在 assets 目录作为恢复副本。
        </p>
      )}
      {error !== null && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="asset-import-list">
        {queue.map((item, index) => (
          <div className="asset-import-row" key={`${item.sourcePath}-${index}`}>
            <small title={item.sourcePath}>
              {item.sourcePath.split(/[\\/]/).at(-1)}
            </small>
            {item.error !== undefined && (
              <small className="inline-error">{item.error}</small>
            )}
            {item.error === undefined && item.inspection !== undefined && (
              <small className="asset-inspection-meta">
                {item.inspection.detected_format} ·{" "}
                {formatInspectionSize(item.inspection.size_bytes)}
              </small>
            )}
            {item.replaceId !== undefined ? (
              <>
                <small className="asset-id-chip">
                  {item.id}（{item.kind}）
                </small>
                <input
                  aria-label={`${item.fileName} 文件名`}
                  onChange={(event) =>
                    onUpdate(index, {
                      fileName: event.currentTarget.value,
                    })
                  }
                  value={item.fileName}
                />
              </>
            ) : (
              <>
                <input
                  aria-label={`${item.fileName} 逻辑 ID`}
                  onChange={(event) =>
                    onUpdate(index, {
                      id: event.currentTarget.value.trim(),
                    })
                  }
                  value={item.id}
                />
                <select
                  aria-label={`${item.fileName} 类型`}
                  onChange={(event) =>
                    onUpdate(index, {
                      kind: event.currentTarget.value as AssetKind,
                    })
                  }
                  value={item.kind}
                >
                  {ASSET_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {ASSET_KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`${item.fileName} 文件名`}
                  onChange={(event) =>
                    onUpdate(index, {
                      fileName: event.currentTarget.value,
                    })
                  }
                  value={item.fileName}
                />
              </>
            )}
            <IconButton
              onClick={() => onRemove(index)}
              icon={Trash2}
              label={`移除 ${item.fileName}`}
              size="sm"
            />
          </div>
        ))}
      </div>
      <button
        className="primary-action"
        disabled={importing || queue.length === 0}
        onClick={() => onSubmit()}
        type="button"
      >
        {importing ? "导入中…" : "导入清单"}
      </button>
    </div>
  );
}
