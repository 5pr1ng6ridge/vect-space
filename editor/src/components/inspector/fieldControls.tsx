import { useContext, useId, useMemo, type ReactElement } from "react";
import { nodeLabel } from "../../story";
import { assetUrl } from "../../api";
import { animationSourceId } from "../../imageAnimation";
import { AssetChooser } from "../AssetChooser";
import { FrameSequencePreview } from "../FrameSequencePreview";
import type {
  AnimationFile,
  AssetKind,
  ContentManifest,
  EditorAsset,
  SceneNode,
  UiMotionFile,
} from "../../types";
import { DeferredInput, Field, NumberField } from "../Fields";
import { Crosshair } from "lucide-react";
import { IconButton } from "../../ui/Button";
import { describeNode } from "../../nodeSummary";
import { InspectorSceneContext } from "./sceneContext";

export function AnimationFields({
  node,
  onChange,
}: {
  node: Extract<
    SceneNode,
    { type: "background" | "curtain" | "sprite" | "clear" | "camera" }
  >;
  onChange(node: SceneNode): void;
}): ReactElement {
  return (
    <>
      <AwaitFields node={node} onChange={onChange} />
      <Field label="缓动">
        <select
          value={node.easing}
          onChange={(event) =>
            onChange({
              ...node,
              easing: event.currentTarget.value as typeof node.easing,
            })
          }
        >
          <option value="linear">linear</option>
          <option value="ease_in">ease in</option>
          <option value="ease_out">ease out</option>
          <option value="ease_in_out">ease in/out</option>
        </select>
      </Field>
    </>
  );
}

export function AwaitFields({
  node,
  onChange,
}: {
  node: Extract<SceneNode, { duration_ms: number; await: boolean }>;
  onChange(node: SceneNode): void;
}): ReactElement {
  return (
    <div className="field-grid">
      <NumberField
        label="时长 ms"
        max={60000}
        min={0}
        onChange={(duration_ms) => onChange({ ...node, duration_ms })}
        step={50}
        value={node.duration_ms}
      />
      <BooleanField
        label="等待完成"
        onChange={(awaitCompletion) =>
          onChange({ ...node, await: awaitCompletion })
        }
        value={node.await}
      />
    </div>
  );
}

export function OptionalDurationField({
  value,
  onChange,
}: {
  value: number | null;
  onChange(value: number | null): void;
}): ReactElement {
  return (
    <Field label="时长覆盖">
      <label className="checkbox-field">
        <input
          checked={value !== null}
          onChange={(event) =>
            onChange(event.currentTarget.checked ? 200 : null)
          }
          type="checkbox"
        />
        使用节点时长
      </label>
      {value !== null && (
        <DeferredInput
          aria-label="时长覆盖 ms"
          max={60_000}
          min={0}
          onCommit={(raw) => {
            const duration = Number(raw);
            if (raw.trim() === "" || !Number.isFinite(duration) || duration < 0)
              return false;
            onChange(duration);
          }}
          step={10}
          type="number"
          value={String(value)}
        />
      )}
      <small>关闭时使用预设自身时长</small>
    </Field>
  );
}

export function UiMotionSelect({
  allowDefault = false,
  label,
  motions,
  value,
  onChange,
}: {
  allowDefault?: boolean;
  label: string;
  motions: UiMotionFile[];
  value: string | null;
  onChange(value: string | null): void;
}): ReactElement {
  return (
    <Field label={label}>
      <select
        onChange={(event) => onChange(event.currentTarget.value || null)}
        value={value ?? ""}
      >
        <option value="">
          {allowDefault ? "使用当前默认绑定" : "关闭 / 未选择"}
        </option>
        {motions.map(({ definition }) => (
          <option key={definition.id} value={definition.id}>
            {definition.id}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function AssetSelect({
  allowNone = false,
  animations = [],
  assets: imageAssets = [],
  disabled = false,
  kind,
  label,
  manifest,
  onChange,
  value,
}: {
  allowNone?: boolean;
  /** Animation documents used to preview an animated selection. */
  animations?: readonly AnimationFile[];
  /** Registered assets, for the animated preview's frame urls and size. */
  assets?: readonly EditorAsset[];
  disabled?: boolean;
  kind: AssetKind;
  label: string;
  manifest: ContentManifest;
  onChange(value: string | null): void;
  value: string | null | undefined;
}): ReactElement {
  const assets = useMemo(
    () =>
      Object.entries(manifest.assets).map(([id, asset]) => ({
        id,
        kind: asset.kind,
        path: asset.path,
        animation: asset.animation,
      })),
    [manifest.assets],
  );
  const selectedDefinition = value == null ? undefined : manifest.assets[value];
  const animation =
    selectedDefinition?.animation === undefined
      ? undefined
      : animationSourceId(selectedDefinition.animation, animations);
  const selectedAsset = imageAssets.find((asset) => asset.id === value);
  const metadata = selectedAsset?.metadata;
  const size =
    metadata === undefined ||
    metadata === null ||
    metadata.width === null ||
    metadata.height === null
      ? undefined
      : { width: metadata.width, height: metadata.height };
  return (
    <Field label={label}>
      <AssetChooser
        allowEmpty={allowNone}
        assets={assets}
        disabled={disabled}
        kind={kind}
        label={label}
        onChange={onChange}
        value={value ?? null}
      />
      {animation !== undefined && (
        <FrameSequencePreview
          frames={animation.definition.frames.map((frame) => ({
            asset: frame.asset,
            url: assetUrl(
              imageAssets.find((asset) => asset.id === frame.asset)
                ?.absolute_path ?? "",
            ),
            duration_ms: frame.duration_ms,
          }))}
          height={size?.height}
          label={`素材 ${value ?? ""}`}
          width={size?.width}
        />
      )}
    </Field>
  );
}

export function TextField({
  allowEmpty = false,
  disabled = false,
  label,
  onChange,
  suggestions,
  value,
}: {
  allowEmpty?: boolean;
  disabled?: boolean;
  label: string;
  onChange(value: string): void;
  /** Offer existing values (e.g. sprite ids) while still allowing new ones. */
  suggestions?: readonly string[];
  value: string;
}): ReactElement {
  const listId = useId();
  return (
    <Field label={label}>
      <DeferredInput
        disabled={disabled}
        list={suggestions === undefined ? undefined : listId}
        onCommit={(raw) => onChange(raw)}
        required={!allowEmpty}
        spellCheck={false}
        value={value}
      />
      {suggestions !== undefined && (
        <datalist id={listId}>
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      )}
    </Field>
  );
}

export function OptionalNumber({
  label,
  max,
  min,
  onChange,
  step = 1,
  value,
}: {
  label: string;
  max?: number;
  min?: number;
  onChange(value: number | null): void;
  step?: number;
  value: number | null;
}): ReactElement {
  return (
    <Field label={label}>
      <DeferredInput
        max={max}
        min={min}
        onCommit={(raw) => {
          if (raw.trim() === "") {
            if (value !== null) onChange(null);
            return;
          }
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) return false;
          if (parsed !== value) onChange(parsed);
        }}
        placeholder="保持不变"
        step={step}
        type="number"
        value={value === null ? "" : String(value)}
      />
    </Field>
  );
}

export function BooleanField({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange(value: boolean): void;
  value: boolean;
}): ReactElement {
  return (
    <label className="boolean-field">
      <input
        checked={value}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  );
}

export function TargetSelect({
  label,
  onChange,
  targets,
  value,
}: {
  label: string;
  onChange(value: string): void;
  targets: string[];
  value: string;
}): ReactElement {
  const context = useContext(InspectorSceneContext);
  const optionLabel = (id: string): string => {
    const target = context?.scene.nodes[id];
    if (target === undefined) return id;
    const { title, summary } = describeNode(target, {
      manifest: context?.manifest,
    });
    const text = `${title === null ? "" : `${title}：`}${summary}`;
    return `${id} · ${nodeLabel(target.type)} · ${
      text.length > 24 ? `${text.slice(0, 24)}…` : text
    }`;
  };
  return (
    <Field label={label}>
      <div className="inline-field">
        <select
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          {!targets.includes(value) && (
            <option value={value}>{value || "— 缺少目标 —"}</option>
          )}
          {targets.map((target) => (
            <option key={target} value={target}>
              {optionLabel(target)}
            </option>
          ))}
        </select>
        {context?.onLocate !== undefined && targets.includes(value) && (
          <IconButton
            icon={Crosshair}
            label={`在剧情图中定位 ${value}`}
            onClick={() => context.onLocate?.(value)}
            size="sm"
            tooltip="在剧情图中定位"
          />
        )}
      </div>
    </Field>
  );
}
