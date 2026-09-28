import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import { PersonStanding } from "lucide-react";
import { WorkspaceHeader } from "../shell/WorkspaceHeader";

import { TimelineEditor } from "./TimelineEditor";
import { DeferredInput } from "./Fields";
import { AssetChooser, useAssetLayout } from "./AssetChooser";
import { firstVisibleAssetId } from "../assetLibrary";
import { ActionPreview, type ActionPreviewHandle } from "./ActionPreview";
import type { EditorPreviewEnvironment } from "./timelinePreview";
import {
  SPRITE_ACTION_CHANNELS,
  SPRITE_ACTION_PREVIEW_BASE,
  spriteActionToTimelineNode,
  timelineNodeToSpriteAction,
} from "../timeline";
import type {
  EditorAsset,
  SpriteActionDefinition,
  SpriteSnapshot,
  TimelineNode,
} from "../types";

const CHANNEL_LABELS: Record<string, string> = {
  x: "X 偏移",
  y: "Y 偏移",
  scale: "整体缩放倍率",
  scale_x: "X 缩放倍率",
  scale_y: "Y 缩放倍率",
  rotation_deg: "旋转偏移",
  opacity: "透明度倍率",
};

const PREVIEW_SPRITE_ID = "action.preview";

/**
 * Full-screen keyframe workspace for one reusable sprite action.
 *
 * The action library deliberately owns no keyframe UI of its own: an action is
 * projected into a single-sprite {@link TimelineNode}, edited with the same
 * {@link TimelineEditor} the story timelines use (ruler, snapping, marquee
 * selection, easing curves, copy/paste), and folded back into relative,
 * parameter-aware channels.  The only action-specific surface is the parameter
 * table, the end policy and the preview pose the relative channels are
 * measured against.
 */
export function ActionWorkspace({
  definition,
  path,
  assets,
  animationMap,
  dirty,
  onBack,
  onChange,
  onSave,
  onValidate,
  onUndo,
  onRedo,
  undoAvailable = true,
  redoAvailable = true,
  previewEnvironment,
}: {
  definition: SpriteActionDefinition;
  path: string;
  assets: EditorAsset[];
  animationMap: AnimationMap;
  dirty: boolean;
  onBack(): void;
  onChange(definition: SpriteActionDefinition): void;
  onSave(): void;
  onValidate(): void;
  onUndo(): void;
  onRedo(): void;
  undoAvailable?: boolean;
  redoAvailable?: boolean;
  previewEnvironment?: EditorPreviewEnvironment;
}): ReactElement {
  // The preview pose is author-facing state: relative channels are only
  // meaningful against an explicit starting pose, so it is shown and editable
  // instead of being hidden inside the conversion.
  const assetLayout = useAssetLayout();
  const [base, setBase] = useState<SpriteSnapshot>(SPRITE_ACTION_PREVIEW_BASE);
  const [previewAsset, setPreviewAsset] = useState<string | null>(
    () =>
      firstVisibleAssetId(assets, assetLayout, "sprite") ??
      firstVisibleAssetId(assets, assetLayout, "gui"),
  );
  const [playhead, setPlayhead] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<ActionPreviewHandle>(null);

  const imageAssets = useMemo(
    () => [
      ...assets.filter((asset) => asset.kind === "sprite"),
      ...assets.filter((asset) => asset.kind === "gui"),
    ],
    [assets],
  );
  const selectedPreviewAsset = imageAssets.some(
    (asset) => asset.id === previewAsset,
  )
    ? previewAsset
    : (firstVisibleAssetId(assets, assetLayout, "sprite") ??
      firstVisibleAssetId(assets, assetLayout, "gui"));
  const node = useMemo(
    () =>
      spriteActionToTimelineNode({
        definition,
        base,
        previewSpriteId: PREVIEW_SPRITE_ID,
        previewAsset: selectedPreviewAsset,
      }),
    [base, definition, selectedPreviewAsset],
  );

  const handlePreviewError = useCallback((message: string): void => {
    setError(message);
  }, []);

  const applyNode = (next: TimelineNode): void => {
    try {
      const folded = timelineNodeToSpriteAction(next, definition, base);
      setError(null);
      onChange(folded);
    } catch (reason) {
      // Keep the author's edit visible and explain the refusal instead of
      // silently reverting the keyframe they just changed.
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const parameters = definition.parameters ?? {};
  const parameterIds = Object.keys(parameters);
  const updateParameter = (
    id: string,
    patch: Partial<{ default: number; min: number; max: number }>,
  ): void => {
    const current = parameters[id];
    if (current === undefined) return;
    onChange({
      ...definition,
      parameters: { ...parameters, [id]: { ...current, ...patch } },
    });
  };
  const removeParameter = (id: string): void => {
    const nextParameters = Object.fromEntries(
      Object.entries(parameters).filter(([candidate]) => candidate !== id),
    );
    // A keyframe that referenced the removed parameter falls back to its
    // literal value so the action never points at a missing parameter.
    const channels: SpriteActionDefinition["channels"] = {};
    for (const [channel, keyframes] of Object.entries(
      definition.channels ?? {},
    )) {
      channels[channel] = keyframes.map((keyframe) =>
        keyframe.parameter === id
          ? {
              at_ms: keyframe.at_ms,
              value: keyframe.value,
              easing: keyframe.easing,
            }
          : keyframe,
      );
    }
    onChange({ ...definition, parameters: nextParameters, channels });
  };

  return (
    <main className="action-workspace">
      <WorkspaceHeader
        dirty={dirty}
        icon={PersonStanding}
        kind="立绘动作"
        onBack={onBack}
        onRedo={onRedo}
        onSave={onSave}
        onUndo={onUndo}
        onValidate={onValidate}
        redoAvailable={redoAvailable}
        title={<span title={path}>{definition.name || definition.id}</span>}
        undoAvailable={undoAvailable}
      />
      <section className="action-workspace-body">
        <aside className="action-side-panel">
          <h3>动作属性</h3>
          <label>
            名称
            <DeferredInput
              maxLength={128}
              onCommit={(name) => onChange({ ...definition, name })}
              value={definition.name}
            />
          </label>
          <label>
            默认时长 ms
            <DeferredInput
              min={1}
              onCommit={(raw) => {
                const value = Number(raw);
                if (!Number.isInteger(value) || value < 1) {
                  setError("动作时长必须是大于 0 的整数毫秒");
                  return false;
                }
                setError(null);
                onChange({ ...definition, duration_ms: value });
              }}
              type="number"
              value={String(definition.duration_ms)}
            />
          </label>
          <label>
            结束姿态
            <select
              onChange={(event) =>
                onChange({
                  ...definition,
                  end: event.currentTarget.value as "hold" | "restore",
                })
              }
              value={definition.end ?? "hold"}
            >
              <option value="hold">保持最后一帧</option>
              <option value="restore">恢复动作前姿态</option>
            </select>
          </label>
          <p className="field-note">
            位置与旋转是相对基准姿态的偏移，缩放与透明度是倍率。修改会立即影响所有引用该动作的节点。
          </p>

          <h3>预览基准姿态</h3>
          <label>
            立绘素材
            <AssetChooser
              assets={imageAssets}
              kind={["sprite", "gui"]}
              label="立绘素材"
              onChange={(value) => setPreviewAsset(value)}
              value={selectedPreviewAsset}
            />
          </label>
          <div className="action-base-row">
            <label>
              X
              <input
                onChange={(event) =>
                  setBase((current) => ({
                    ...current,
                    x: Number(event.currentTarget.value),
                  }))
                }
                type="number"
                value={base.x}
              />
            </label>
            <label>
              Y
              <input
                onChange={(event) =>
                  setBase((current) => ({
                    ...current,
                    y: Number(event.currentTarget.value),
                  }))
                }
                type="number"
                value={base.y}
              />
            </label>
            <label>
              缩放
              <input
                min={0.01}
                onChange={(event) =>
                  setBase((current) => ({
                    ...current,
                    scale: Number(event.currentTarget.value),
                  }))
                }
                step={0.01}
                type="number"
                value={base.scale}
              />
            </label>
          </div>
          <button
            onClick={() => setBase(SPRITE_ACTION_PREVIEW_BASE)}
            type="button"
          >
            恢复默认基准
          </button>
          <p className="field-note">
            基准姿态只影响编辑器预览与相对值换算，不写入动作文件。
          </p>

          <h3>参数</h3>
          <button
            onClick={() => {
              let index = parameterIds.length + 1;
              let id = `amount_${index}`;
              while (parameters[id] !== undefined) {
                index += 1;
                id = `amount_${index}`;
              }
              onChange({
                ...definition,
                parameters: {
                  ...parameters,
                  [id]: { default: 1, min: -10, max: 10 },
                },
              });
            }}
            type="button"
          >
            ＋ 添加参数
          </button>
          {parameterIds.length === 0 && (
            <p className="field-note">
              参数让同一动作按节点覆盖不同幅度。关键帧在时间线里显示为参数的默认值；直接改数值即解除该帧的参数绑定。
            </p>
          )}
          {parameterIds.map((id) => (
            <div className="action-parameter-row" key={id}>
              <code>{id}</code>
              <input
                aria-label={`${id} 默认值`}
                onChange={(event) =>
                  updateParameter(id, {
                    default: Number(event.currentTarget.value),
                  })
                }
                step={0.01}
                type="number"
                value={parameters[id].default}
              />
              <input
                aria-label={`${id} 最小值`}
                onChange={(event) =>
                  updateParameter(id, {
                    min: Number(event.currentTarget.value),
                  })
                }
                step={0.01}
                type="number"
                value={parameters[id].min ?? -10}
              />
              <input
                aria-label={`${id} 最大值`}
                onChange={(event) =>
                  updateParameter(id, {
                    max: Number(event.currentTarget.value),
                  })
                }
                step={0.01}
                type="number"
                value={parameters[id].max ?? 10}
              />
              <button
                className="danger-text"
                onClick={() => removeParameter(id)}
                type="button"
              >
                ×
              </button>
            </div>
          ))}

          <h3>通道</h3>
          <p className="field-note">
            {SPRITE_ACTION_CHANNELS.map(
              (channel) => CHANNEL_LABELS[channel] ?? channel,
            ).join(" · ")}
          </p>
          <p className="field-note">
            在下方关键帧区域拖动即可编辑；一次拖动只产生一条撤销记录。
          </p>
        </aside>
        <div className="action-keyframe-pane">
          <ActionPreview
            animations={animationMap}
            asset={selectedPreviewAsset}
            assets={assets}
            base={base}
            environment={previewEnvironment}
            node={node}
            onError={handlePreviewError}
            onPlayheadChange={setPlayhead}
            playhead={playhead}
            ref={previewRef}
          />
          {error !== null && <p className="inline-error">{error}</p>}
          <TimelineEditor
            assets={assets}
            hideTransport
            onChange={applyNode}
            onPlayheadChange={(value) => previewRef.current?.seek(value)}
            onSelectionChange={() => undefined}
            node={node}
            playheadOverride={playhead}
            playbackStartOverride={playhead}
          />
        </div>
      </section>
    </main>
  );
}
