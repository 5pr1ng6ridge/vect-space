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
  defaultScreenEffect,
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
              defaultScreenEffect(
                event.currentTarget.value as ScreenEffectSpec["type"],
              ),
            )
          }
        >
          <optgroup label="基础">
            <option value="flash">闪光</option>
            <option value="shake">震动</option>
          </optgroup>
          <optgroup label="着色器（仅作用于场景画面）">
            <option value="chromatic_aberration">色差</option>
            <option value="glitch">故障</option>
            <option value="shockwave">冲击波</option>
            <option value="color_grade">色彩修正</option>
            <option value="focus">聚焦模糊</option>
            <option value="ripple">波纹</option>
          </optgroup>
        </select>
      </Field>
      <ScreenEffectParameters onChange={onChange} value={value} />
    </>
  );
}

function ScreenEffectParameters({
  onChange,
  value,
}: {
  onChange(value: ScreenEffectSpec): void;
  value: ScreenEffectSpec;
}): ReactElement {
  switch (value.type) {
    case "flash":
      return (
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
      );
    case "shake":
      return (
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
          <SeedField
            onChange={(seed) => onChange({ ...value, seed })}
            value={value.seed}
          />
        </>
      );
    case "chromatic_aberration":
      return (
        <>
          <div className="field-grid">
            <NumberField
              label="强度 px（0–128）"
              max={128}
              min={0}
              onChange={(intensity) => onChange({ ...value, intensity })}
              step={1}
              value={value.intensity}
            />
            <NumberField
              label="方向角度（-360–360）"
              max={360}
              min={-360}
              onChange={(angle_deg) => onChange({ ...value, angle_deg })}
              step={1}
              value={value.angle_deg}
            />
          </div>
          <EffectCenterFields
            onChange={(center) => onChange({ ...value, ...center })}
            value={value}
          />
          <NumberField
            label="边缘权重（0 = 全屏均匀，1 = 中心无偏移）"
            max={1}
            min={0}
            onChange={(edge_weight) => onChange({ ...value, edge_weight })}
            step={0.01}
            value={value.edge_weight}
          />
          <EffectFadeFields
            onChange={(fades) => onChange({ ...value, ...fades })}
            value={value}
          />
        </>
      );
    case "glitch":
      return (
        <>
          <div className="field-grid">
            <NumberField
              label="位移 px（0–512）"
              max={512}
              min={0}
              onChange={(displacement) => onChange({ ...value, displacement })}
              step={1}
              value={value.displacement}
            />
            <NumberField
              label="切片数（1–32）"
              max={32}
              min={1}
              onChange={(slice_count) => onChange({ ...value, slice_count })}
              step={1}
              value={value.slice_count}
            />
          </div>
          <div className="field-grid">
            <NumberField
              label="切片密度（0–1）"
              max={1}
              min={0}
              onChange={(density) => onChange({ ...value, density })}
              step={0.01}
              value={value.density}
            />
            <NumberField
              label="变化频率 Hz（0.1–60）"
              max={60}
              min={0.1}
              onChange={(frequency_hz) => onChange({ ...value, frequency_hz })}
              step={0.1}
              value={value.frequency_hz}
            />
          </div>
          <SeedField
            onChange={(seed) => onChange({ ...value, seed })}
            value={value.seed}
          />
          <EffectFadeFields
            onChange={(fades) => onChange({ ...value, ...fades })}
            value={value}
          />
        </>
      );
    case "shockwave":
      return (
        <>
          <EffectCenterFields
            onChange={(center) => onChange({ ...value, ...center })}
            value={value}
          />
          <div className="field-grid">
            <NumberField
              label="最大半径 px（1–4096）"
              max={4096}
              min={1}
              onChange={(max_radius) => onChange({ ...value, max_radius })}
              step={10}
              value={value.max_radius}
            />
            <NumberField
              label="波宽 px（1–1024）"
              max={1024}
              min={1}
              onChange={(wave_width) => onChange({ ...value, wave_width })}
              step={1}
              value={value.wave_width}
            />
          </div>
          <NumberField
            label="扭曲强度 px（0–256）"
            max={256}
            min={0}
            onChange={(strength) => onChange({ ...value, strength })}
            step={1}
            value={value.strength}
          />
        </>
      );
    case "color_grade":
      return (
        <>
          <div className="field-grid">
            <NumberField
              label="亮度偏移（-1–1）"
              max={1}
              min={-1}
              onChange={(brightness) => onChange({ ...value, brightness })}
              step={0.01}
              value={value.brightness}
            />
            <NumberField
              label="对比度（0–2）"
              max={2}
              min={0}
              onChange={(contrast) => onChange({ ...value, contrast })}
              step={0.01}
              value={value.contrast}
            />
          </div>
          <div className="field-grid">
            <NumberField
              label="饱和度（0–2）"
              max={2}
              min={0}
              onChange={(saturation) => onChange({ ...value, saturation })}
              step={0.01}
              value={value.saturation}
            />
            <NumberField
              label="着色强度（0–1）"
              max={1}
              min={0}
              onChange={(tint_strength) =>
                onChange({ ...value, tint_strength })
              }
              step={0.01}
              value={value.tint_strength}
            />
          </div>
          <ColorField
            label="着色颜色"
            onChange={(tint) => onChange({ ...value, tint })}
            value={value.tint}
          />
          <EffectIntensityField
            onChange={(intensity) => onChange({ ...value, intensity })}
            value={value.intensity}
          />
          <EffectFadeFields
            onChange={(fades) => onChange({ ...value, ...fades })}
            value={value}
          />
        </>
      );
    case "focus":
      return (
        <>
          <EffectCenterFields
            onChange={(center) => onChange({ ...value, ...center })}
            value={value}
          />
          <div className="field-grid">
            <NumberField
              label="清晰半径 px（0–2203）"
              max={2203}
              min={0}
              onChange={(radius) => onChange({ ...value, radius })}
              step={1}
              value={value.radius}
            />
            <NumberField
              label="边缘过渡 px（1–2203）"
              max={2203}
              min={1}
              onChange={(softness) => onChange({ ...value, softness })}
              step={1}
              value={value.softness}
            />
          </div>
          <div className="field-grid">
            <NumberField
              label="最大模糊 px（0–24）"
              max={24}
              min={0}
              onChange={(blur) => onChange({ ...value, blur })}
              step={0.5}
              value={value.blur}
            />
            <NumberField
              label="边缘压暗（0–1）"
              max={1}
              min={0}
              onChange={(darkness) => onChange({ ...value, darkness })}
              step={0.01}
              value={value.darkness}
            />
          </div>
          <EffectIntensityField
            onChange={(intensity) => onChange({ ...value, intensity })}
            value={value.intensity}
          />
          <EffectFadeFields
            onChange={(fades) => onChange({ ...value, ...fades })}
            value={value}
          />
        </>
      );
    case "ripple":
      return (
        <>
          <EffectCenterFields
            onChange={(center) => onChange({ ...value, ...center })}
            value={value}
          />
          <div className="field-grid">
            <NumberField
              label="振幅 px（0–64）"
              max={64}
              min={0}
              onChange={(amplitude) => onChange({ ...value, amplitude })}
              step={1}
              value={value.amplitude}
            />
            <NumberField
              label="波长 px（8–2203）"
              max={2203}
              min={8}
              onChange={(wavelength) => onChange({ ...value, wavelength })}
              step={1}
              value={value.wavelength}
            />
          </div>
          <div className="field-grid">
            <NumberField
              label="速度 px/s（0–2000）"
              max={2000}
              min={0}
              onChange={(speed) => onChange({ ...value, speed })}
              step={10}
              value={value.speed}
            />
            <NumberField
              label="衰减（0–8）"
              max={8}
              min={0}
              onChange={(damping) => onChange({ ...value, damping })}
              step={0.1}
              value={value.damping}
            />
          </div>
          <EffectIntensityField
            onChange={(intensity) => onChange({ ...value, intensity })}
            value={value.intensity}
          />
          <EffectFadeFields
            onChange={(fades) => onChange({ ...value, ...fades })}
            value={value}
          />
        </>
      );
  }
}

function SeedField({
  onChange,
  value,
}: {
  onChange(value: number): void;
  value: number;
}): ReactElement {
  return (
    <NumberField
      label="seed（0–4294967295）"
      max={0xffff_ffff}
      min={0}
      onChange={onChange}
      step={1}
      value={value}
    />
  );
}

/** Shared 0–1 strength of the composable colour grade / focus / ripple passes. */
function EffectIntensityField({
  onChange,
  value,
}: {
  onChange(value: number): void;
  value: number;
}): ReactElement {
  return (
    <NumberField
      label="效果强度（0–1）"
      max={1}
      min={0}
      onChange={onChange}
      step={0.05}
      value={value}
    />
  );
}

/** Design-pixel centre shared by the positional shader effects. */
function EffectCenterFields({
  onChange,
  value,
}: {
  onChange(value: { center_x: number; center_y: number }): void;
  value: { center_x: number; center_y: number };
}): ReactElement {
  return (
    <div className="field-grid">
      <NumberField
        label="中心 X（0–1920）"
        max={1920}
        min={0}
        onChange={(center_x) =>
          onChange({ center_x, center_y: value.center_y })
        }
        step={1}
        value={value.center_x}
      />
      <NumberField
        label="中心 Y（0–1080）"
        max={1080}
        min={0}
        onChange={(center_y) =>
          onChange({ center_x: value.center_x, center_y })
        }
        step={1}
        value={value.center_y}
      />
    </div>
  );
}

/** Intensity envelope of a shader effect as fractions of its window. */
function EffectFadeFields({
  onChange,
  value,
}: {
  onChange(value: { fade_in: number; fade_out: number }): void;
  value: { fade_in: number; fade_out: number };
}): ReactElement {
  return (
    <div className="field-grid">
      <NumberField
        label="渐入比例（0–1）"
        max={1}
        min={0}
        onChange={(fade_in) => onChange({ fade_in, fade_out: value.fade_out })}
        step={0.05}
        value={value.fade_in}
      />
      <NumberField
        label="渐出比例（0–1）"
        max={1}
        min={0}
        onChange={(fade_out) => onChange({ fade_in: value.fade_in, fade_out })}
        step={0.05}
        value={value.fade_out}
      />
    </div>
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
