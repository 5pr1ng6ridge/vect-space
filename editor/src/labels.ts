/**
 * The single Chinese label dictionary for every enum an author can see.
 *
 * Raw YAML values (`ease_in_out`, `slot_1`, `rotation_deg`, `background`…)
 * never appear as UI text; controls and summaries look them up here.  Ids
 * stay visible only as secondary monospace detail.
 */
import type {
  AmbienceSlot,
  AssetKind,
  NodeType,
  TimelineEasing,
  VariableScope,
  VariableType,
  WindowLayerAction,
} from "./types";

export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  background: "背景",
  sprite: "立绘",
  gui: "界面图",
  bgm: "背景音乐",
  ambience: "环境声",
  sfx: "音效",
  font: "字体",
  video: "视频",
};

export const VARIABLE_TYPE_LABELS: Record<VariableType, string> = {
  boolean: "开关（是/否）",
  integer: "整数",
  number: "小数",
  string: "文本",
};

export const VARIABLE_SCOPE_LABELS: Record<VariableScope, string> = {
  save: "随存档",
  profile: "全局（跨存档）",
};

export const EASING_LABELS: Record<Exclude<TimelineEasing, object>, string> = {
  step: "阶跃（瞬间跳变）",
  linear: "线性",
  ease_in: "缓入",
  ease_out: "缓出",
  ease_in_out: "缓入缓出",
};

/** Keyframe channels across sprites, camera, buttons, video, audio and UI. */
export const CHANNEL_LABELS: Record<string, string> = {
  x: "X 位置",
  y: "Y 位置",
  z: "层级",
  width: "宽度",
  height: "高度",
  scale: "缩放",
  scale_x: "水平缩放",
  scale_y: "垂直缩放",
  rotation_deg: "旋转",
  opacity: "不透明度",
  zoom: "镜头缩放",
  volume: "音量",
  offset_x: "水平偏移",
  offset_y: "垂直偏移",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

/** Short names of a `window_layer` action (summaries, graph cards). */
export const WINDOW_LAYER_ACTION_LABELS: Record<WindowLayerAction, string> = {
  raise: "提到最前",
  focus: "聚焦",
  top: "置顶",
  bottom: "置底",
  normal: "恢复普通层级",
};

/** Longer names of the same actions for the inspector dropdown. */
export const WINDOW_LAYER_ACTION_OPTION_LABELS: Record<
  WindowLayerAction,
  string
> = {
  raise: "提到最前（不抢焦点）",
  focus: "聚焦（抢焦点）",
  top: "置顶（始终在其他窗口上方）",
  bottom: "置底（始终在其他窗口下方）",
  normal: "恢复普通层级",
};

export const AMBIENCE_SLOT_LABELS: Record<AmbienceSlot, string> = {
  slot_1: "环境声 1",
  slot_2: "环境声 2",
  slot_3: "环境声 3",
  slot_4: "环境声 4",
};

export const SPRITE_ACTION_LABELS = {
  show: "登场",
  move: "移动",
  hide: "退场",
} as const;

export const FIT_LABELS = {
  stretch: "拉伸填满",
  contain: "完整显示",
  cover: "裁剪填满",
} as const;

export const COMPARISON_LABELS = {
  eq: "等于",
  ne: "不等于",
  lt: "小于",
  le: "小于等于",
  gt: "大于",
  ge: "大于等于",
} as const;

export const LOGIC_LABELS = {
  and: "全部满足",
  or: "任一满足",
  not: "不满足",
} as const;

export const MUTATION_LABELS = {
  assign: "设为",
  add: "加上",
  sub: "减去",
  mul: "乘以",
  mod: "取余",
  append: "追加文本",
  toggle: "切换开关",
} as const;

/** Broad node families; each has an icon and a colour token. */
type NodeCategory =
  "narrative" | "logic" | "visual" | "audio" | "interaction" | "flow" | "end";

export const NODE_CATEGORY_LABELS: Record<NodeCategory, string> = {
  narrative: "叙事",
  logic: "逻辑",
  visual: "画面",
  audio: "声音",
  interaction: "交互",
  flow: "流程",
  end: "结束",
};

export const NODE_CATEGORY: Record<NodeType, NodeCategory> = {
  say: "narrative",
  long_text: "narrative",
  long_text_control: "narrative",
  choice: "logic",
  condition: "logic",
  set: "logic",
  jump: "logic",
  open_window: "logic",
  window_title: "logic",
  window_control: "logic",
  window_geometry: "logic",
  window_layer: "logic",
  timer: "flow",
  playback: "flow",
  wait: "flow",
  end: "end",
  action: "visual",
  background: "visual",
  curtain: "visual",
  sprite: "visual",
  particle: "visual",
  clear: "visual",
  camera: "visual",
  screen_effect: "visual",
  timeline: "visual",
  dialogue_ui: "interaction",
  ui_motion_set: "interaction",
  ui_motion_play: "interaction",
  button_create: "interaction",
  button_update: "interaction",
  button_remove: "interaction",
  bgm: "audio",
  ambience: "audio",
  sfx: "audio",
};

/** Display order of node categories in menus. */
export const NODE_CATEGORY_ORDER: NodeCategory[] = [
  "narrative",
  "logic",
  "visual",
  "audio",
  "interaction",
  "flow",
  "end",
];
