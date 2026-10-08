import type { ReactElement } from "react";
import type { SceneObjectFrame } from "@vectspace/presentation-core/scene-frame";

type NumericChannel =
  | "x"
  | "y"
  | "width"
  | "height"
  | "scale"
  | "scale_x"
  | "scale_y"
  | "rotation_deg"
  | "opacity"
  | "z";

interface ChannelSpec {
  label: string;
  channel: NumericChannel;
  step: string;
  min?: string;
  max?: string;
  /** Applied to the typed number before it is written. */
  coerce?(value: number): number;
}

const POSITION: ChannelSpec[] = [
  { label: "X", channel: "x", step: "0.1" },
  { label: "Y", channel: "y", step: "0.1" },
];
const VIDEO_SIZE: ChannelSpec[] = [
  {
    label: "Width",
    channel: "width",
    step: "1",
    min: "16",
    coerce: (v) => Math.max(16, v),
  },
  {
    label: "Height",
    channel: "height",
    step: "1",
    min: "16",
    coerce: (v) => Math.max(16, v),
  },
];
const BUTTON_SIZE: ChannelSpec[] = [
  {
    label: "Width",
    channel: "width",
    step: "1",
    min: "1",
    coerce: (v) => Math.max(1, v),
  },
  {
    label: "Height",
    channel: "height",
    step: "1",
    min: "1",
    coerce: (v) => Math.max(1, v),
  },
];
const UNIFORM_SCALE: ChannelSpec = {
  label: "Scale",
  channel: "scale",
  step: "0.01",
  min: "0.01",
};
const AXIS_SCALE: ChannelSpec[] = [
  { label: "Scale X", channel: "scale_x", step: "0.01", min: "0.01" },
  { label: "Scale Y", channel: "scale_y", step: "0.01", min: "0.01" },
];
const ROTATION: ChannelSpec = {
  label: "Rotation",
  channel: "rotation_deg",
  step: "0.1",
};
const OPACITY: ChannelSpec = {
  label: "Opacity",
  channel: "opacity",
  step: "0.01",
  min: "0",
  max: "1",
  coerce: (v) => Math.max(0, Math.min(1, v)),
};
const LAYER: ChannelSpec = {
  label: "Z",
  channel: "z",
  step: "1",
  coerce: Math.round,
};

function channelSpecs(object: SceneObjectFrame): ChannelSpec[] {
  if (object.kind === "video")
    return [...POSITION, ...VIDEO_SIZE, OPACITY, LAYER];
  return [
    ...POSITION,
    ...(object.kind === "sprite" || object.kind === "emitter"
      ? [UNIFORM_SCALE]
      : []),
    ...(object.kind === "button" ? BUTTON_SIZE : []),
    ...(object.kind !== "emitter" ? AXIS_SCALE : []),
    ROTATION,
    OPACITY,
    LAYER,
  ];
}

/** Numeric channel editor for the object selected in the preview. */
export function ObjectInspector({
  object,
  onEditChannel,
}: {
  object: SceneObjectFrame;
  onEditChannel(
    object: SceneObjectFrame,
    channel: keyof SceneObjectFrame,
    value: number,
  ): void;
}): ReactElement {
  return (
    <div className="timeline-object-inspector">
      <strong>选中对象</strong>
      {channelSpecs(object).map(
        ({ channel, coerce, label, max, min, step }) => (
          <label key={channel}>
            {label}
            <input
              max={max}
              min={min}
              onChange={(event) => {
                const typed = Number(event.currentTarget.value);
                onEditChannel(object, channel, coerce?.(typed) ?? typed);
              }}
              step={step}
              type="number"
              value={channel === "z" ? Math.round(object.z) : object[channel]}
            />
          </label>
        ),
      )}
      <p className="timeline-selection-hint">
        拖动画布对象移动；角点缩放，顶部手柄旋转。当前播放头会作为关键帧时间。
      </p>
    </div>
  );
}
