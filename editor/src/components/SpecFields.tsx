/**
 * Editors for the presentation specs.
 *
 * Keeping the editors here means the node inspector and the timeline event
 * editor expose exactly the same type-safe parameters and ranges.
 */

import type { ReactElement } from "react";

import { ColorField, Field, NumberField } from "./Fields";
import { AssetChooser } from "./AssetChooser";
import {
  defaultCurtainFill,
  defaultFlashEffect,
  defaultShakeEffect,
} from "../presentationDefaults";
import type {
  BackgroundTransitionSpec,
  ContentManifest,
  CurtainFill,
  CurtainTransitionSpec,
  ScreenEffectSpec,
  TransitionDirection,
} from "../types";

const DIRECTION_OPTIONS: { value: TransitionDirection; label: string }[] = [
  { value: "left_to_right", label: "从左到右" },
  { value: "right_to_left", label: "从右到左" },
  { value: "top_to_bottom", label: "从上到下" },
  { value: "bottom_to_top", label: "从下到上" },
];

/** Canonical transition picker with the type-relevant parameters. */
export function TransitionSpecFields({
  onChange,
  value,
}: {
  onChange(value: BackgroundTransitionSpec): void;
  value: BackgroundTransitionSpec;
}): ReactElement {
  return (
    <>
      <Field label="转场类型">
        <select
          value={value.type}
          onChange={(event) =>
            onChange(
              defaultTransitionSpec(
                event.currentTarget.value as BackgroundTransitionSpec["type"],
                value,
              ),
            )
          }
        >
          <option value="cut">直接切换</option>
          <option value="cross_fade">交叉淡化</option>
          <option value="fade_through_color">淡过颜色</option>
          <option value="wipe">划像</option>
          <option value="push">推入</option>
        </select>
      </Field>
      {value.type === "fade_through_color" && (
        <ColorField
          label="中间颜色"
          onChange={(color) => onChange({ ...value, color })}
          value={value.color}
        />
      )}
      {(value.type === "wipe" || value.type === "push") && (
        <>
          <DirectionField
            label="方向"
            onChange={(direction) => onChange({ ...value, direction })}
            value={value.direction}
          />
          <NumberField
            label="软边（0–1）"
            max={1}
            min={0}
            onChange={(softness) => onChange({ ...value, softness })}
            step={0.01}
            value={value.softness}
          />
        </>
      )}
    </>
  );
}

function defaultTransitionSpec(
  type: BackgroundTransitionSpec["type"],
  previous: BackgroundTransitionSpec,
): BackgroundTransitionSpec {
  const direction =
    previous.type === "wipe" || previous.type === "push"
      ? previous.direction
      : "left_to_right";
  const softness =
    previous.type === "wipe" || previous.type === "push"
      ? previous.softness
      : 0;
  switch (type) {
    case "cut":
      return { type };
    case "cross_fade":
      return { type };
    case "fade_through_color":
      return {
        type,
        color:
          previous.type === "fade_through_color" ? previous.color : "#000000",
      };
    case "wipe":
      return { type, direction, softness };
    case "push":
      return { type, direction, softness };
  }
}

/** Curtain fill: a solid colour or a `gui` asset (mirrors the Rust loader). */
export function CurtainFillFields({
  manifest,
  onChange,
  value,
}: {
  manifest: ContentManifest;
  onChange(value: CurtainFill | null): void;
  value: CurtainFill | null;
}): ReactElement {
  const mode = value !== null && "asset" in value ? "asset" : "color";
  return (
    <>
      <Field label="幕布填充">
        <select
          value={mode}
          onChange={(event) =>
            onChange(
              event.currentTarget.value === "asset"
                ? { asset: "" }
                : defaultCurtainFill(),
            )
          }
        >
          <option value="color">颜色</option>
          <option value="asset">gui 素材</option>
        </select>
      </Field>
      {mode === "color" ? (
        <ColorField
          label="幕布颜色"
          onChange={(color) => onChange({ color })}
          value={
            value !== null && "color" in value
              ? value.color
              : defaultCurtainFill().color
          }
        />
      ) : (
        <Field label="gui 素材">
          <AssetChooser
            assets={Object.entries(manifest.assets).map(([id, asset]) => ({
              id,
              kind: asset.kind,
              path: asset.path,
              animation: asset.animation,
            }))}
            kind="gui"
            label="gui 素材"
            onChange={(asset) => onChange({ asset: asset ?? "" })}
            value={
              value !== null && "asset" in value ? value.asset || null : null
            }
          />
        </Field>
      )}
    </>
  );
}

/** Curtain open/close animation picker (fade, four wipes, two splits). */
export function CurtainTransitionFields({
  onChange,
  value,
}: {
  onChange(value: CurtainTransitionSpec): void;
  value: CurtainTransitionSpec;
}): ReactElement {
  return (
    <>
      <Field label="幕布动画">
        <select
          value={value.type}
          onChange={(event) =>
            onChange(
              defaultCurtainTransitionSpec(
                event.currentTarget.value as CurtainTransitionSpec["type"],
                value,
              ),
            )
          }
        >
          <option value="fade">淡入 / 淡出</option>
          <option value="wipe">划像</option>
          <option value="split_horizontal">水平对开</option>
          <option value="split_vertical">垂直对开</option>
        </select>
      </Field>
      {value.type === "wipe" && (
        <DirectionField
          label="划像方向"
          onChange={(direction) => onChange({ type: "wipe", direction })}
          value={value.direction}
        />
      )}
    </>
  );
}

function defaultCurtainTransitionSpec(
  type: CurtainTransitionSpec["type"],
  previous: CurtainTransitionSpec,
): CurtainTransitionSpec {
  switch (type) {
    case "fade":
      return { type };
    case "wipe":
      return {
        type,
        direction:
          previous.type === "wipe" ? previous.direction : "left_to_right",
      };
    case "split_horizontal":
      return { type };
    case "split_vertical":
      return { type };
  }
}

/** Type-safe parameter editor for the canonical screen-effect spec. */
export function ScreenEffectFields({
  onChange,
  value,
}: {
  onChange(value: ScreenEffectSpec): void;
  value: ScreenEffectSpec;
}): ReactElement {
  return (
    <>
      <Field label="效果类型">
        <select
          value={value.type}
          onChange={(event) =>
            onChange(
              event.currentTarget.value === "flash"
                ? defaultFlashEffect()
                : defaultShakeEffect(),
            )
          }
        >
          <option value="flash">闪光</option>
          <option value="shake">震动</option>
        </select>
      </Field>
      {value.type === "flash" ? (
        <>
          <ColorField
            label="闪光颜色"
            onChange={(color) => onChange({ ...value, color })}
            value={value.color}
          />
          <NumberField
            label="峰值透明度（0–1）"
            max={1}
            min={0}
            onChange={(peak_alpha) => onChange({ ...value, peak_alpha })}
            step={0.01}
            value={value.peak_alpha}
          />
        </>
      ) : (
        <>
          <div className="field-grid">
            <NumberField
              label="横向振幅（0–256）"
              max={256}
              min={0}
              onChange={(amplitude_x) => onChange({ ...value, amplitude_x })}
              step={1}
              value={value.amplitude_x}
            />
            <NumberField
              label="纵向振幅（0–256）"
              max={256}
              min={0}
              onChange={(amplitude_y) => onChange({ ...value, amplitude_y })}
              step={1}
              value={value.amplitude_y}
            />
          </div>
          <div className="field-grid">
            <NumberField
              label="频率 Hz（0.1–60）"
              max={60}
              min={0.1}
              onChange={(frequency_hz) => onChange({ ...value, frequency_hz })}
              step={0.1}
              value={value.frequency_hz}
            />
            <NumberField
              label="衰减（0–1）"
              max={1}
              min={0}
              onChange={(decay) => onChange({ ...value, decay })}
              step={0.01}
              value={value.decay}
            />
          </div>
          <NumberField
            label="seed（0–4294967295）"
            max={0xffff_ffff}
            min={0}
            onChange={(seed) => onChange({ ...value, seed })}
            step={1}
            value={value.seed}
          />
        </>
      )}
    </>
  );
}

export function DirectionField({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange(value: TransitionDirection): void;
  value: TransitionDirection;
}): ReactElement {
  return (
    <Field label={label}>
      <select
        value={value}
        onChange={(event) =>
          onChange(event.currentTarget.value as TransitionDirection)
        }
      >
        {DIRECTION_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
