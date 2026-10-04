/**
 * Authoring rules for the window layout nodes: `window_geometry` (move and
 * resize a game window) and `window_layer` (restack it).
 *
 * The bounds mirror `vectspace-core` (`interaction::validate_window_geometry`)
 * so the editor can explain a problem while the author is still typing; the
 * Rust loader remains the authority.  The placement presets only fill in the
 * placement fields: the form keeps every field editable afterwards.
 */
import { WINDOW_LAYER_ACTION_LABELS } from "./labels";
import { WINDOW_ROLE_LABELS } from "./windowInteraction";
import type {
  WindowGeometryNode,
  WindowLayerAction,
  WindowLayerNode,
  WindowPlacement,
  WindowReference,
  WindowRole,
  WindowSize,
  WindowSizeUnit,
} from "./types";

/** `x` / `y` reference points may overshoot the reference rect by this much. */
export const MAX_WINDOW_POINT = 4;
export const MAX_WINDOW_OFFSET = 10_000;
export const MAX_WINDOW_LOGICAL_SIZE = 10_000;
/** Default length of a freshly added move/resize. */
export const DEFAULT_WINDOW_MOVE_MS = 600;

/** Smallest client area (logical px) the host lets each window shrink to. */
export const WINDOW_MIN_SIZE: Readonly<
  Record<WindowRole, { width: number; height: number }>
> = {
  main: { width: 960, height: 540 },
  secondary: { width: 480, height: 270 },
};

/** Every `window_layer` action, in the order the dropdown lists them. */
export const WINDOW_LAYER_ACTIONS: readonly WindowLayerAction[] = [
  "raise",
  "focus",
  "top",
  "bottom",
  "normal",
];

export const WINDOW_REFERENCE_LABELS: Record<WindowReference, string> = {
  work_area: "屏幕工作区",
  window: "另一个游戏窗口",
  current: "自身当前位置",
};

export const WINDOW_SIZE_UNIT_LABELS: Record<WindowSizeUnit, string> = {
  logical: "逻辑像素（客户区）",
  work_area: "工作区比例（含边框）",
};

export function otherWindow(target: WindowRole): WindowRole {
  return target === "main" ? "secondary" : "main";
}

export type PlacementPresetId =
  | "screen_center"
  | "screen_top_left"
  | "screen_top_right"
  | "screen_bottom_left"
  | "screen_bottom_right"
  | "screen_top"
  | "screen_bottom"
  | "screen_left"
  | "screen_right"
  | "dock_right"
  | "dock_left"
  | "dock_top"
  | "dock_bottom"
  | "nudge";

export type PlacementPresetGroup = "screen" | "window" | "current";

export const PLACEMENT_PRESET_GROUP_LABELS: Record<
  PlacementPresetGroup,
  string
> = {
  screen: "屏幕（工作区）",
  window: "另一个游戏窗口",
  current: "自身",
};

export interface PlacementPreset {
  id: PlacementPresetId;
  group: PlacementPresetGroup;
  /** Dropdown label. */
  label: string;
  /** Summary text; `other` names the other game window. */
  summary(other: string): string;
  placement: Required<WindowPlacement>;
}

function screen(
  id: PlacementPresetId,
  label: string,
  x: number,
  y: number,
): PlacementPreset {
  return {
    id,
    group: "screen",
    label,
    summary: () => label,
    // The window's own anchor is the same corner/edge point it is pinned to.
    placement: {
      relative_to: "work_area",
      x,
      y,
      anchor_x: x,
      anchor_y: y,
      offset_x: 0,
      offset_y: 0,
    },
  };
}

function dock(
  id: PlacementPresetId,
  label: string,
  side: string,
  placement: Pick<
    Required<WindowPlacement>,
    "x" | "y" | "anchor_x" | "anchor_y" | "offset_x" | "offset_y"
  >,
): PlacementPreset {
  return {
    id,
    group: "window",
    label,
    summary: (other) => `贴${other}${side}`,
    placement: { relative_to: "window", ...placement },
  };
}

/** Gap kept between docked windows, in logical pixels. */
const DOCK_GAP = 16;

export const PLACEMENT_PRESETS: readonly PlacementPreset[] = [
  screen("screen_center", "屏幕居中", 0.5, 0.5),
  screen("screen_top_left", "屏幕左上角", 0, 0),
  screen("screen_top_right", "屏幕右上角", 1, 0),
  screen("screen_bottom_left", "屏幕左下角", 0, 1),
  screen("screen_bottom_right", "屏幕右下角", 1, 1),
  screen("screen_top", "屏幕上边缘居中", 0.5, 0),
  screen("screen_bottom", "屏幕下边缘居中", 0.5, 1),
  screen("screen_left", "屏幕左边缘居中", 0, 0.5),
  screen("screen_right", "屏幕右边缘居中", 1, 0.5),
  dock("dock_right", "贴在另一窗口右侧", "右侧", {
    x: 1,
    y: 0.5,
    anchor_x: 0,
    anchor_y: 0.5,
    offset_x: DOCK_GAP,
    offset_y: 0,
  }),
  dock("dock_left", "贴在另一窗口左侧", "左侧", {
    x: 0,
    y: 0.5,
    anchor_x: 1,
    anchor_y: 0.5,
    offset_x: -DOCK_GAP,
    offset_y: 0,
  }),
  dock("dock_top", "贴在另一窗口上方", "上方", {
    x: 0.5,
    y: 0,
    anchor_x: 0.5,
    anchor_y: 1,
    offset_x: 0,
    offset_y: -DOCK_GAP,
  }),
  dock("dock_bottom", "贴在另一窗口下方", "下方", {
    x: 0.5,
    y: 1,
    anchor_x: 0.5,
    anchor_y: 0,
    offset_x: 0,
    offset_y: DOCK_GAP,
  }),
  {
    id: "nudge",
    group: "current",
    label: "相对当前位置偏移",
    summary: () => "相对当前位置偏移",
    // Pin the window's top-left corner to its own top-left corner: only the
    // offset moves it.
    placement: {
      relative_to: "current",
      x: 0,
      y: 0,
      anchor_x: 0,
      anchor_y: 0,
      offset_x: 24,
      offset_y: 0,
    },
  },
];

const PRESET_BY_ID = new Map(
  PLACEMENT_PRESETS.map((preset) => [preset.id, preset] as const),
);

export function placementPreset(id: PlacementPresetId): PlacementPreset {
  const preset = PRESET_BY_ID.get(id);
  if (preset === undefined) throw new Error(`unknown placement preset ${id}`);
  return preset;
}

/** A fresh, fully explicit copy of a preset's placement. */
export function presetPlacement(id: PlacementPresetId): WindowPlacement {
  return { ...placementPreset(id).placement };
}

/**
 * Where enabling "move" starts from: the secondary window docks beside the
 * main one, the main window centres on the screen.
 */
export function defaultPlacementFor(target: WindowRole): WindowPlacement {
  return presetPlacement(
    target === "secondary" ? "dock_right" : "screen_center",
  );
}

/** The placement with every optional field filled in. */
export function resolvePlacement(
  placement: WindowPlacement,
): Required<WindowPlacement> {
  return {
    relative_to: placement.relative_to ?? "work_area",
    x: placement.x,
    y: placement.y,
    anchor_x: placement.anchor_x,
    anchor_y: placement.anchor_y,
    offset_x: placement.offset_x ?? 0,
    offset_y: placement.offset_y ?? 0,
  };
}

const EPSILON = 1e-6;

const near = (left: number, right: number): boolean =>
  Math.abs(left - right) < EPSILON;

/**
 * The preset whose reference, point and anchor match `placement`, or `null`
 * for a custom placement.  Offsets are deliberately ignored: they are the
 * gap / fine-tuning of a preset, not part of what makes it that preset.
 */
export function detectPlacementPreset(
  placement: WindowPlacement,
): PlacementPresetId | null {
  const resolved = resolvePlacement(placement);
  const match = PLACEMENT_PRESETS.find(
    (preset) =>
      preset.placement.relative_to === resolved.relative_to &&
      near(preset.placement.x, resolved.x) &&
      near(preset.placement.y, resolved.y) &&
      near(preset.placement.anchor_x, resolved.anchor_x) &&
      near(preset.placement.anchor_y, resolved.anchor_y),
  );
  return match?.id ?? null;
}

export const DEFAULT_LOGICAL_SIZE: Required<WindowSize> = {
  unit: "logical",
  width: 960,
  height: 540,
};

export const DEFAULT_WORK_AREA_SIZE: Required<WindowSize> = {
  unit: "work_area",
  width: 0.5,
  height: 0.5,
};

/** The size a freshly enabled (or re-united) size field starts from. */
export function defaultWindowSize(unit: WindowSizeUnit): WindowSize {
  return {
    ...(unit === "logical" ? DEFAULT_LOGICAL_SIZE : DEFAULT_WORK_AREA_SIZE),
  };
}

const REFERENCES: readonly WindowReference[] = [
  "work_area",
  "window",
  "current",
];
const SIZE_UNITS: readonly WindowSizeUnit[] = ["logical", "work_area"];

const POSITION_PROBLEM =
  "窗口位置无效：x/y 在 -4..4，锚点在 0..1，偏移不超过 ±10000";
const SIZE_PROBLEM =
  "窗口大小无效：逻辑像素在 1..10000，工作区比例在 0..1（不含 0）";

/**
 * Problem with the placement/size of a geometry node, or `null`.  Mirrors
 * `interaction::validate_window_geometry`, including its messages.
 */
export function windowGeometryProblem(
  node: Pick<WindowGeometryNode, "position" | "size">,
): string | null {
  const position = node.position ?? null;
  const size = node.size ?? null;
  if (position === null && size === null) {
    return "window_geometry 至少要设置位置或大小";
  }
  if (position !== null) {
    const resolved = resolvePlacement(position);
    const finite = (value: number): boolean => Number.isFinite(value);
    if (
      !REFERENCES.includes(resolved.relative_to) ||
      [resolved.x, resolved.y].some(
        (value) => !finite(value) || Math.abs(value) > MAX_WINDOW_POINT,
      ) ||
      [resolved.anchor_x, resolved.anchor_y].some(
        (value) => !finite(value) || value < 0 || value > 1,
      ) ||
      [resolved.offset_x, resolved.offset_y].some(
        (value) => !finite(value) || Math.abs(value) > MAX_WINDOW_OFFSET,
      )
    ) {
      return POSITION_PROBLEM;
    }
  }
  if (size !== null) {
    const unit = size.unit ?? "logical";
    const dimensions = [size.width, size.height];
    const valid =
      SIZE_UNITS.includes(unit) &&
      (unit === "logical"
        ? dimensions.every(
            (value) =>
              Number.isFinite(value) &&
              value >= 1 &&
              value <= MAX_WINDOW_LOGICAL_SIZE,
          )
        : dimensions.every(
            (value) => Number.isFinite(value) && value > 0 && value <= 1,
          ));
    if (!valid) return SIZE_PROBLEM;
  }
  return null;
}

/** A logical size smaller than the host's minimum for `target`, if any. */
export function belowMinimumSize(
  target: WindowRole,
  size: WindowSize | null | undefined,
): boolean {
  if (size == null || (size.unit ?? "logical") !== "logical") return false;
  const minimum = WINDOW_MIN_SIZE[target];
  return size.width < minimum.width || size.height < minimum.height;
}

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const percent = (value: number): string => `${round(value * 100, 1)}%`;

/** Signed pixel pair for offsets, e.g. `+16, 0`. */
const signed = (value: number): string =>
  `${value > 0 ? "+" : ""}${round(value)}`;

/** Short description of where a placement puts the `target` window. */
export function describePlacement(
  placement: WindowPlacement,
  target: WindowRole,
): string {
  const resolved = resolvePlacement(placement);
  const other = WINDOW_ROLE_LABELS[otherWindow(target)];
  const hasOffset = resolved.offset_x !== 0 || resolved.offset_y !== 0;
  const offset = `${signed(resolved.offset_x)}, ${signed(resolved.offset_y)}`;
  const id = detectPlacementPreset(resolved);
  if (id !== null) {
    const preset = placementPreset(id);
    const base = preset.summary(other);
    if (preset.group === "current") return `${base}（${offset}）`;
    if (preset.group === "screen" && hasOffset)
      return `${base}（偏移 ${offset}）`;
    return base;
  }
  const where =
    resolved.relative_to === "work_area"
      ? "工作区"
      : resolved.relative_to === "window"
        ? `相对${other}`
        : "相对自身";
  return `自定义位置（${where} ${percent(resolved.x)}, ${percent(resolved.y)}${hasOffset ? `，偏移 ${offset}` : ""}）`;
}

/** Short description of a requested size. */
export function describeWindowSize(size: WindowSize): string {
  return (size.unit ?? "logical") === "logical"
    ? `大小 ${round(size.width)}×${round(size.height)}`
    : `大小 工作区 ${percent(size.width)}×${percent(size.height)}`;
}

/** One-line summary of a `window_geometry` node. */
export function describeWindowGeometry(node: WindowGeometryNode): string {
  const parts: string[] = [];
  if (node.position != null) {
    parts.push(describePlacement(node.position, node.target));
  }
  if (node.size != null) parts.push(describeWindowSize(node.size));
  if (parts.length === 0) parts.push("（未设置位置或大小）");
  parts.push(
    node.duration_ms > 0
      ? `${node.duration_ms} ms${node.await ? " · 等待完成" : ""}`
      : "瞬间完成",
  );
  return `${WINDOW_ROLE_LABELS[node.target]} → ${parts.join(" · ")}`;
}

/** One-line summary of a `window_layer` node. */
export function describeWindowLayer(node: WindowLayerNode): string {
  return `${WINDOW_ROLE_LABELS[node.target]} · ${WINDOW_LAYER_ACTION_LABELS[node.action]}`;
}
