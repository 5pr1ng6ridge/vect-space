import type { ReactElement } from "react";
import { sceneRole, WINDOW_ROLE_LABELS } from "../../windowInteraction";
import {
  belowMinimumSize,
  defaultPlacementFor,
  defaultWindowSize,
  detectPlacementPreset,
  otherWindow,
  PLACEMENT_PRESET_GROUP_LABELS,
  PLACEMENT_PRESETS,
  presetPlacement,
  resolvePlacement,
  WINDOW_LAYER_ACTIONS,
  WINDOW_MIN_SIZE,
  WINDOW_REFERENCE_LABELS,
  WINDOW_SIZE_UNIT_LABELS,
  type PlacementPresetGroup,
  type PlacementPresetId,
} from "../../windowLayout";
import type {
  SceneDefinition,
  SceneNode,
  WindowGeometryNode,
  WindowLayerAction,
  WindowLayerNode,
  WindowPlacement,
  WindowReference,
  WindowRole,
  WindowSizeUnit,
} from "../../types";
import { Field, NumberField } from "../Fields";
import { EASING_LABELS, WINDOW_LAYER_ACTION_OPTION_LABELS } from "../../labels";
import { BooleanField } from "./fieldControls";

/**
 * `<option>`s for the real Scene ids (never derived from file names) that a
 * node may point at.  A reference that no longer fits is kept visible so the
 * author sees what is wrong instead of a silently empty select.
 */
export function SceneOptions({
  current,
  role,
  scenes,
}: {
  current: string | null;
  role: WindowRole;
  scenes: readonly SceneDefinition[];
}): ReactElement {
  const candidates = scenes.filter(
    (candidate) => sceneRole(candidate) === role,
  );
  const stale =
    current !== null &&
    current !== "" &&
    !candidates.some((candidate) => candidate.id === current);
  return (
    <>
      {stale && (
        <option value={current}>
          {current}
          {scenes.some((candidate) => candidate.id === current)
            ? `（用途不符：需要${WINDOW_ROLE_LABELS[role]}专用）`
            : "（场景不存在）"}
        </option>
      )}
      {candidates.map((candidate) => (
        <option key={candidate.id} value={candidate.id}>
          {candidate.id}
        </option>
      ))}
    </>
  );
}

const PLACEMENT_GROUPS: readonly PlacementPresetGroup[] = [
  "screen",
  "window",
  "current",
];

/** Easings a window move can use (no timeline-only `step`). */
const WINDOW_EASINGS = [
  "linear",
  "ease_in",
  "ease_out",
  "ease_in_out",
] as const;

export function WindowGeometryFields({
  node,
  onChange,
}: {
  node: WindowGeometryNode;
  onChange(node: SceneNode): void;
}): ReactElement {
  const position = node.position ?? null;
  const size = node.size ?? null;
  const other = WINDOW_ROLE_LABELS[otherWindow(node.target)];
  const placement = position === null ? null : resolvePlacement(position);
  const presetId = position === null ? null : detectPlacementPreset(position);
  const minimum = WINDOW_MIN_SIZE[node.target];
  const patchPosition = (patch: Partial<WindowPlacement>): void => {
    if (position !== null)
      onChange({ ...node, position: { ...position, ...patch } });
  };
  const sizeUnit: WindowSizeUnit = size?.unit ?? "logical";
  return (
    <>
      <WindowRoleSelect
        label="目标窗口"
        onChange={(target) => onChange({ ...node, target })}
        value={node.target}
      />
      <BooleanField
        label="改变位置"
        onChange={(enabled) =>
          onChange({
            ...node,
            position: enabled ? defaultPlacementFor(node.target) : null,
          })
        }
        value={position !== null}
      />
      {placement !== null && (
        <>
          <Field label="位置预设">
            <select
              value={presetId ?? "custom"}
              onChange={(event) => {
                const value = event.currentTarget.value;
                // "Custom" is what any hand-edited placement already is.
                if (value !== "custom") {
                  onChange({
                    ...node,
                    position: presetPlacement(value as PlacementPresetId),
                  });
                }
              }}
            >
              {PLACEMENT_GROUPS.map((group) => (
                <optgroup
                  key={group}
                  label={PLACEMENT_PRESET_GROUP_LABELS[group]}
                >
                  {PLACEMENT_PRESETS.filter(
                    (preset) => preset.group === group,
                  ).map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </optgroup>
              ))}
              <option value="custom">自定义</option>
            </select>
          </Field>
          <Field label="参考对象">
            <select
              value={placement.relative_to}
              onChange={(event) =>
                patchPosition({
                  relative_to: event.currentTarget.value as WindowReference,
                })
              }
            >
              {(Object.keys(WINDOW_REFERENCE_LABELS) as WindowReference[]).map(
                (reference) => (
                  <option key={reference} value={reference}>
                    {WINDOW_REFERENCE_LABELS[reference]}
                  </option>
                ),
              )}
            </select>
          </Field>
          <div className="field-grid">
            <NumberField
              label="参考点 X"
              max={4}
              min={-4}
              onChange={(x) => patchPosition({ x })}
              step={0.05}
              value={placement.x}
            />
            <NumberField
              label="参考点 Y"
              max={4}
              min={-4}
              onChange={(y) => patchPosition({ y })}
              step={0.05}
              value={placement.y}
            />
            <NumberField
              label="窗口锚点 X"
              max={1}
              min={0}
              onChange={(anchor_x) => patchPosition({ anchor_x })}
              step={0.05}
              value={placement.anchor_x}
            />
            <NumberField
              label="窗口锚点 Y"
              max={1}
              min={0}
              onChange={(anchor_y) => patchPosition({ anchor_y })}
              step={0.05}
              value={placement.anchor_y}
            />
            <NumberField
              label="偏移 X px"
              max={10000}
              min={-10000}
              onChange={(offset_x) => patchPosition({ offset_x })}
              step={4}
              value={placement.offset_x}
            />
            <NumberField
              label="偏移 Y px"
              max={10000}
              min={-10000}
              onChange={(offset_y) => patchPosition({ offset_y })}
              step={4}
              value={placement.offset_y}
            />
          </div>
          <p className="field-note">
            窗口上的「锚点」会被放到参考对象上的「参考点」处，再平移「偏移」逻辑像素。参考点和锚点都是比例：0
            为左/上边缘，1 为右/下边缘，参考点可在 −4…4
            之间（超出表示落在参考对象之外）。例如参考点 (1, 0.5)、锚点 (0,
            0.5)、偏移 X 16 就是贴在右侧并留 16 像素间距。「另一个游戏窗口」指
            {other}
            ；「屏幕工作区」是窗口所在显示器去掉任务栏后的区域；「自身当前位置」用于相对当前位置的偏移（可被计时器反复触发做漂移、抖动）。选预设只是填好这些数值，之后仍可微调。
          </p>
        </>
      )}
      <BooleanField
        label="改变大小"
        onChange={(enabled) =>
          onChange({
            ...node,
            size: enabled ? defaultWindowSize("logical") : null,
          })
        }
        value={size !== null}
      />
      {size !== null && (
        <>
          <Field label="大小单位">
            <select
              value={sizeUnit}
              onChange={(event) =>
                // The two units are not convertible without the screen size,
                // so switching starts from that unit's default.
                onChange({
                  ...node,
                  size: defaultWindowSize(
                    event.currentTarget.value as WindowSizeUnit,
                  ),
                })
              }
            >
              {(Object.keys(WINDOW_SIZE_UNIT_LABELS) as WindowSizeUnit[]).map(
                (unit) => (
                  <option key={unit} value={unit}>
                    {WINDOW_SIZE_UNIT_LABELS[unit]}
                  </option>
                ),
              )}
            </select>
          </Field>
          <div className="field-grid">
            <NumberField
              label="宽度"
              max={sizeUnit === "logical" ? 10000 : 1}
              min={sizeUnit === "logical" ? 1 : 0}
              onChange={(width) =>
                onChange({ ...node, size: { ...size, width } })
              }
              step={sizeUnit === "logical" ? 10 : 0.05}
              value={size.width}
            />
            <NumberField
              label="高度"
              max={sizeUnit === "logical" ? 10000 : 1}
              min={sizeUnit === "logical" ? 1 : 0}
              onChange={(height) =>
                onChange({ ...node, size: { ...size, height } })
              }
              step={sizeUnit === "logical" ? 10 : 0.05}
              value={size.height}
            />
          </div>
          <p className="field-note">
            逻辑像素是窗口客户区（不含标题栏和边框）的大小；工作区比例按显示器去掉任务栏后的区域计算（0
            到 1，不含 0），包含边框。切换单位会重置为该单位的默认大小。
          </p>
          {belowMinimumSize(node.target, size) && (
            <p className="field-note field-note-warning">
              小于{WINDOW_ROLE_LABELS[node.target]}的最小尺寸 {minimum.width}×
              {minimum.height}，运行时会被放大到最小尺寸。
            </p>
          )}
        </>
      )}
      {position === null && size === null && (
        <p className="field-note field-note-warning">
          位置和大小至少要改变一项。
        </p>
      )}
      <div className="field-grid">
        <NumberField
          label="时长 ms"
          max={60000}
          min={0}
          onChange={(duration_ms) => onChange({ ...node, duration_ms })}
          step={50}
          value={node.duration_ms}
        />
        <Field label="缓动">
          <select
            value={node.easing}
            onChange={(event) =>
              onChange({
                ...node,
                easing: event.currentTarget
                  .value as WindowGeometryNode["easing"],
              })
            }
          >
            {WINDOW_EASINGS.map((easing) => (
              <option key={easing} value={easing}>
                {EASING_LABELS[easing]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <BooleanField
        label="等待完成"
        onChange={(awaitCompletion) =>
          onChange({ ...node, await: awaitCompletion })
        }
        value={node.await}
      />
      <p className="field-note">
        时长为 0 时瞬间到位；「等待完成」只在时长大于 0
        时让剧情等动画播完。不等待的移动/缩放可以被计时器反复触发。全屏或最大化的窗口会跳过移动和缩放；窗口始终限制在所在显示器内，主窗口最小
        {WINDOW_MIN_SIZE.main.width}×{WINDOW_MIN_SIZE.main.height}，副窗口最小
        {WINDOW_MIN_SIZE.secondary.width}×{WINDOW_MIN_SIZE.secondary.height}
        （逻辑像素）。存档不记录窗口位置和大小；回到标题或退出重演时主窗口会自动复原。预览不会移动真实窗口，请在桌面双窗口运行验证。
      </p>
    </>
  );
}

export function WindowLayerFields({
  node,
  onChange,
}: {
  node: WindowLayerNode;
  onChange(node: SceneNode): void;
}): ReactElement {
  return (
    <>
      <WindowRoleSelect
        label="目标窗口"
        onChange={(target) => onChange({ ...node, target })}
        value={node.target}
      />
      <Field label="层级操作">
        <select
          value={node.action}
          onChange={(event) =>
            onChange({
              ...node,
              action: event.currentTarget.value as WindowLayerAction,
            })
          }
        >
          {WINDOW_LAYER_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {WINDOW_LAYER_ACTION_OPTION_LABELS[action]}
            </option>
          ))}
        </select>
      </Field>
      <p className="field-note">
        「提到最前」只把窗口放到其他窗口上方，不抢键盘焦点；「聚焦」会激活窗口并抢走键盘焦点；「置顶」/「置底」让窗口始终在其他应用上方/下方，直到「恢复普通层级」。预览不会改变真实窗口层级，请在桌面双窗口运行验证。
      </p>
    </>
  );
}

export function WindowRoleSelect({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange(value: WindowRole): void;
  value: WindowRole;
}): ReactElement {
  return (
    <Field label={label}>
      <select
        onChange={(event) => onChange(event.currentTarget.value as WindowRole)}
        value={value}
      >
        <option value="main">{WINDOW_ROLE_LABELS.main}</option>
        <option value="secondary">{WINDOW_ROLE_LABELS.secondary}</option>
      </select>
    </Field>
  );
}
