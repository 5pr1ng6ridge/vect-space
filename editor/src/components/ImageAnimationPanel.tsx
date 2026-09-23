import { useMemo, useState, type ReactElement } from "react";
import { assetUrl } from "../api";
import {
  DEFAULT_FRAME_DURATION_MS,
  IMAGE_ANIMATION_MAX_FRAMES,
  IDENTIFIER_PATTERN,
  animationFilePath,
  deriveAnimationId,
  deriveAnimationAssetId,
  frameCandidates,
  frameSortKey,
  naturalSortFrameAssets,
  naturalSortFrameIds,
  totalDurationMs,
  validateAnimationDraft,
  ANIMATION_FRAME_KINDS,
  type AnimationDraft,
} from "../imageAnimation";
import { assetChoiceOptions } from "../assetLibrary";
import type { AnimationFrame, AssetKind, EditorAsset } from "../types";
import { useAssetLayout } from "./AssetChooser";
import { FrameSequencePreview } from "./FrameSequencePreview";

const ANIMATION_KINDS: readonly AssetKind[] = ["sprite", "background", "gui"];

export interface ImageAnimationPanelProps {
  /** Registered and session-staged logical assets. */
  assets: readonly EditorAsset[];
  /** Manifest asset ids, for the id conflict checks. */
  existingAssetIds: ReadonlySet<string>;
  existingAnimationIds: ReadonlySet<string>;
  existingAnimationPaths: ReadonlySet<string>;
  /** Returns false when the host rejected the draft; the panel stays open. */
  onCreate(draft: AnimationDraft): boolean;
  onClose(): void;
}

/**
 * 「创建帧动画」editor: pick static images, order them, set the hold time,
 * preview the loop and register the document as one logical asset.
 *
 * The whole gesture is a local draft: nothing enters the project (and therefore
 * no undo entry exists) until 创建, so a drag reorder or a text session can
 * never produce more than the single history entry the confirm creates.
 */
export function ImageAnimationPanel({
  assets,
  existingAssetIds,
  existingAnimationIds,
  existingAnimationPaths,
  onCreate,
  onClose,
}: ImageAnimationPanelProps): ReactElement {
  const byId = useMemo(
    () => new Map(assets.map((asset) => [asset.id, asset] as const)),
    [assets],
  );
  const layout = useAssetLayout();
  const [picked, setPicked] = useState<string[]>([]);
  const candidates = useMemo(() => {
    // Hidden assets are not offered as new frames, but a frame that is
    // already picked keeps its place (selectedHidden retention).
    const allowed = new Set(
      assetChoiceOptions({
        assets,
        layout,
        kind: ANIMATION_FRAME_KINDS,
        selectedIds: picked,
      }).map((option) => option.id),
    );
    return naturalSortFrameAssets(
      frameCandidates(assets).filter((asset) => allowed.has(asset.id)),
    );
  }, [assets, layout, picked]);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [unifiedText, setUnifiedText] = useState(
    String(DEFAULT_FRAME_DURATION_MS),
  );
  const [kind, setKind] = useState<AssetKind>("sprite");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [assetId, setAssetId] = useState("");
  const [assetIdTouched, setAssetIdTouched] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const unified = Number(unifiedText);
  const takenIdentifiers = useMemo(() => {
    const taken = new Set(existingAssetIds);
    for (const candidate of existingAnimationIds) taken.add(candidate);
    return taken;
  }, [existingAnimationIds, existingAssetIds]);
  const firstPicked = picked.length === 0 ? undefined : byId.get(picked[0]);
  const effectiveId = idTouched
    ? id
    : deriveAnimationId(firstPicked, takenIdentifiers);
  const effectiveAssetId = assetIdTouched
    ? assetId
    : deriveAnimationAssetId(effectiveId, existingAssetIds);

  const durationOf = (frameAssetId: string): number =>
    durations[frameAssetId] ?? (Number.isInteger(unified) ? unified : 0);
  const frames: AnimationFrame[] = picked.map((asset) => ({
    asset,
    duration_ms: durationOf(asset),
  }));
  const draft: AnimationDraft = {
    id: effectiveId,
    assetId: effectiveAssetId,
    kind,
    frames,
  };
  const validation = validateAnimationDraft(draft, {
    existingAssetIds,
    existingAnimationIds,
    existingAnimationPaths,
    sizeOf: (frameAssetId) => sizeOf(byId.get(frameAssetId)),
  });
  const previewFrames = frames.map((frame) => ({
    asset: frame.asset,
    url: assetUrl(byId.get(frame.asset)?.absolute_path ?? ""),
    duration_ms: frame.duration_ms,
  }));
  const firstSize = sizeOf(byId.get(picked[0] ?? ""));
  const remaining = candidates.filter((asset) => !picked.includes(asset.id));

  const addFrame = (assetId: string): void => {
    setNotice(null);
    setPicked((current) =>
      current.includes(assetId) ? current : [...current, assetId],
    );
    setDurations((current) =>
      current[assetId] === undefined
        ? {
            ...current,
            [assetId]: Number.isInteger(unified) ? unified : 0,
          }
        : current,
    );
  };
  const removeFrame = (assetId: string): void => {
    setPicked((current) =>
      current.filter((candidate) => candidate !== assetId),
    );
    setDurations((current) => {
      const next = { ...current };
      Reflect.deleteProperty(next, assetId);
      return next;
    });
  };
  const moveFrame = (from: number, to: number): void => {
    if (to < 0 || to >= picked.length || from === to) return;
    setPicked((current) => {
      const next = [...current];
      const [moved] = next.splice(from, 1);
      if (moved === undefined) return current;
      next.splice(to, 0, moved);
      return next;
    });
  };
  const applyUnifiedDuration = (text: string): void => {
    setUnifiedText(text);
    // An empty input is a transient edit state, not a 0 ms hold; keep the
    // frames as they are until the author types a number.
    if (text.trim() === "") return;
    const value = Number(text);
    if (!Number.isInteger(value)) return;
    setDurations(Object.fromEntries(picked.map((asset) => [asset, value])));
  };

  return (
    <div
      aria-label="创建帧动画"
      className="asset-import-dialog asset-animation-dialog"
      role="dialog"
    >
      <header>
        <strong>创建帧动画</strong>
        <button onClick={onClose} type="button">
          取消
        </button>
      </header>
      <p>
        从已登记的静态图片素材（含本次会话暂存的导入）中多选帧。同一动画的所有帧必须像素尺寸一致。
      </p>

      <div className="animation-panel">
        <section className="animation-candidates">
          <h4>可选图片（{remaining.length}）</h4>
          {candidates.length === 0 && (
            <small className="muted">
              没有可用的静态图片素材，请先在素材面板导入。
            </small>
          )}
          <div className="animation-candidate-list">
            {remaining.map((asset) => (
              <button
                key={asset.id}
                onClick={() => addFrame(asset.id)}
                title={asset.path ?? asset.id}
                type="button"
              >
                ＋ {frameSortKey(asset)}
                <small>{asset.id}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="animation-frames">
          <header className="animation-frames-header">
            <h4>帧顺序（{picked.length}）</h4>
            <button
              disabled={picked.length < 2}
              onClick={() =>
                setPicked((current) => naturalSortFrameIds(current, byId))
              }
              type="button"
            >
              按文件名自然排序
            </button>
            <label>
              统一帧时长
              <input
                aria-label="统一帧时长"
                min={1}
                onChange={(event) =>
                  applyUnifiedDuration(event.currentTarget.value)
                }
                type="number"
                value={unifiedText}
              />
              ms
            </label>
          </header>
          {picked.length === 0 && (
            <small className="muted">还没有选择任何帧。</small>
          )}
          <ol className="animation-frame-list">
            {picked.map((frameAssetId, index) => {
              const asset = byId.get(frameAssetId);
              const size = sizeOf(asset);
              return (
                <li
                  draggable
                  key={frameAssetId}
                  onDragEnd={() => setDragIndex(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDragStart={() => setDragIndex(index)}
                  onDrop={() => {
                    if (dragIndex !== null) moveFrame(dragIndex, index);
                    setDragIndex(null);
                  }}
                >
                  <span className="animation-frame-order">{index + 1}</span>
                  <span className="animation-frame-name">
                    <strong>
                      {asset === undefined ? frameAssetId : frameSortKey(asset)}
                    </strong>
                    <small>
                      {frameAssetId} ·{" "}
                      {size === undefined
                        ? "尺寸未知"
                        : `${size.width} × ${size.height}`}
                    </small>
                  </span>
                  <input
                    aria-label={`第 ${index + 1} 帧时长`}
                    min={1}
                    onChange={(event) => {
                      const value = Number(event.currentTarget.value);
                      setDurations((current) => ({
                        ...current,
                        [frameAssetId]: value,
                      }));
                    }}
                    type="number"
                    value={frames[index]?.duration_ms ?? 0}
                  />
                  {durationOf(frameAssetId) !== unified && (
                    <small className="muted">覆盖</small>
                  )}
                  <button
                    aria-label={`第 ${index + 1} 帧上移`}
                    disabled={index === 0}
                    onClick={() => moveFrame(index, index - 1)}
                    type="button"
                  >
                    ↑
                  </button>
                  <button
                    aria-label={`第 ${index + 1} 帧下移`}
                    disabled={index === picked.length - 1}
                    onClick={() => moveFrame(index, index + 1)}
                    type="button"
                  >
                    ↓
                  </button>
                  <button
                    aria-label={`移除第 ${index + 1} 帧`}
                    className="danger-text"
                    onClick={() => removeFrame(frameAssetId)}
                    type="button"
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ol>
          <small className="muted">
            约 {totalDurationMs(frames)} ms 循环一次；帧数上限{" "}
            {IMAGE_ANIMATION_MAX_FRAMES}。
          </small>
        </section>

        <section className="animation-preview">
          <h4>预览</h4>
          <FrameSequencePreview
            frames={previewFrames}
            height={firstSize?.height}
            label="帧动画预览"
            width={firstSize?.width}
          />
        </section>
      </div>

      <div className="animation-identifiers">
        <label>
          动画 ID
          <input
            aria-label="动画 ID"
            onChange={(event) => {
              setIdTouched(true);
              setId(event.currentTarget.value.trim());
            }}
            value={effectiveId}
          />
        </label>
        <label>
          素材 ID
          <input
            aria-label="素材 ID"
            onChange={(event) => {
              setAssetIdTouched(true);
              setAssetId(event.currentTarget.value.trim());
            }}
            value={effectiveAssetId}
          />
        </label>
        <label>
          素材类型
          <select
            aria-label="素材类型"
            onChange={(event) =>
              setKind(event.currentTarget.value as AssetKind)
            }
            value={kind}
          >
            {ANIMATION_KINDS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        </label>
        <label>
          描述文件
          <code>{animationFilePath(effectiveId)}</code>
        </label>
      </div>

      {validation.errors.length > 0 && (
        <ul className="inline-error animation-issues" role="alert">
          {validation.errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {validation.warnings.map((message) => (
        <p className="animation-warning" key={message}>
          {message}
        </p>
      ))}
      {notice !== null && (
        <p className="inline-error" role="alert">
          {notice}
        </p>
      )}

      <div className="editor-dialog-actions">
        <button onClick={onClose} type="button">
          取消
        </button>
        <button
          className="primary-button"
          disabled={
            validation.errors.length > 0 ||
            !IDENTIFIER_PATTERN.test(effectiveId) ||
            !IDENTIFIER_PATTERN.test(effectiveAssetId)
          }
          onClick={() => {
            if (!onCreate(draft)) {
              setNotice("创建失败，请检查 ID 是否已经被占用。");
              return;
            }
            onClose();
          }}
          type="button"
        >
          创建动画素材
        </button>
      </div>
    </div>
  );
}

function sizeOf(
  asset: EditorAsset | undefined,
): { width: number; height: number } | undefined {
  const metadata = asset?.metadata;
  if (metadata === undefined || metadata === null) return undefined;
  if (metadata.width === null || metadata.height === null) return undefined;
  return { width: metadata.width, height: metadata.height };
}
