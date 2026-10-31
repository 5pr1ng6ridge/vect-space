import type { ReactElement } from "react";
import type { AnimationFile, EditorAsset } from "../../types";
import { AssetPreview } from "./AssetPreview";
import {
  animationSummary,
  formatAssetMetadata,
  formatAssetSize,
} from "./assetUtils";
import type { AssetFolderChoice } from "./types";

/** Detail column for the selected asset: metadata, rename, move, hide, replace, remove. */
export function AssetDetail({
  animations,
  asset,
  assets,
  busy,
  displayName,
  folderId,
  folderLabel,
  folderOptions,
  hidden,
  nameDraft,
  onClose,
  onCommitName,
  onMoveToFolder,
  onNameDraftChange,
  onRemove,
  onReplace,
  onReveal,
  onToggleHidden,
  pending,
  references,
}: {
  animations: readonly AnimationFile[];
  asset: EditorAsset;
  assets: readonly EditorAsset[];
  /** An import or inspection is in flight. */
  busy: boolean;
  displayName: string | null;
  folderId: string | null;
  folderLabel: string;
  folderOptions: readonly AssetFolderChoice[];
  hidden: boolean;
  nameDraft: string | null;
  onClose(): void;
  onCommitName(value: string | null): void;
  onMoveToFolder(folderId: string | null): void;
  onNameDraftChange(value: string | null): void;
  onRemove(): void;
  onReplace(): void;
  onReveal(): void;
  onToggleHidden(): void;
  pending: boolean;
  references: readonly string[];
}): ReactElement {
  return (
    <div className="asset-detail">
      <header className="asset-detail-header">
        <span>素材详情</span>
        <button aria-label="关闭素材详情" onClick={onClose} type="button">
          ✕
        </button>
      </header>
      <AssetPreview animations={animations} asset={asset} assets={assets} />
      <strong>
        {displayName ?? asset.id}
        {asset.animation !== undefined && (
          <span className="animation-badge">动画</span>
        )}
        {hidden && <span className="asset-hidden-badge">已隐藏</span>}
        {pending && <span className="asset-pending-badge">待保存</span>}
      </strong>
      {displayName !== null && (
        <small className="asset-id-chip">{asset.id}</small>
      )}
      <code>
        {asset.animation === undefined
          ? asset.path
          : `动画：${asset.animation}`}
      </code>
      {asset.animation !== undefined && (
        <small>{animationSummary(asset, assets, animations)}</small>
      )}
      {displayName !== null && (
        <small className="muted">
          源文件路径（显示名称仅用于编辑器）：
          {asset.path ?? "（未登记）"}
        </small>
      )}
      <small>
        {formatAssetMetadata(asset.metadata)} · 大小：
        {formatAssetSize(asset.size_bytes)} · 引用：
        {references.length} 处
      </small>
      <small className="muted">文件夹：{folderLabel}</small>
      <div className="asset-display-name">
        <input
          aria-label="显示名称"
          onChange={(event) => onNameDraftChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onCommitName(nameDraft);
            }
            if (event.key === "Escape") onNameDraftChange(null);
          }}
          placeholder={asset.id}
          value={nameDraft ?? displayName ?? ""}
        />
        <button
          aria-label="保存显示名称"
          disabled={nameDraft === null}
          onClick={() => onCommitName(nameDraft)}
          type="button"
        >
          保存名称
        </button>
      </div>
      <label className="asset-folder-select">
        移动到文件夹
        <select
          aria-label="移动到文件夹"
          onChange={(event) => {
            const value = event.currentTarget.value;
            onMoveToFolder(value === "" ? null : value);
          }}
          value={folderId ?? ""}
        >
          <option value="">（根目录）</option>
          {folderOptions.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.path}
            </option>
          ))}
        </select>
      </label>
      <div className="asset-detail-actions">
        <button disabled={pending} onClick={onReveal} type="button">
          打开文件所在位置
        </button>
        <button aria-pressed={hidden} onClick={onToggleHidden} type="button">
          {hidden ? "取消隐藏" : "隐藏素材"}
        </button>
        <button
          disabled={asset.animation !== undefined || busy}
          onClick={onReplace}
          title="导入一个同格式文件，保留逻辑 ID，新文件写入新路径，旧文件不会被覆盖或删除"
          type="button"
        >
          替换文件…
        </button>
      </div>
      {asset.animation !== undefined && (
        <small className="muted">
          合成动画素材不能直接替换，请替换它的帧图片。
        </small>
      )}
      {references.length > 0 && (
        <>
          <details className="asset-references">
            <summary>使用位置</summary>
            <ul>
              {references.map((location) => (
                <li key={location}>{location}</li>
              ))}
            </ul>
          </details>
          <small className="inline-error">
            该素材仍被引用（可展开上方“使用位置”查看，帧动画也会列入），需先解除引用才能移除。
          </small>
        </>
      )}
      <button
        className="danger-button"
        disabled={references.length > 0}
        onClick={onRemove}
        type="button"
      >
        从清单移除
      </button>
    </div>
  );
}
