import type {
  BackgroundTransitionSpec,
  ButtonFile,
  ConditionExpression,
  ContentManifest,
  CurtainTransitionSpec,
  EditorLayout,
  EditorProject,
  EditorSceneFile,
  LongTextNode,
  NodeType,
  NodePosition,
  MutationValue,
  ScalarValue,
  SceneDefinition,
  SceneNode,
  ScreenEffectSpec,
  TimelineChannels,
  TransitionDirection,
  TimelineNode,
  TimelinePreviewSettings,
  WindowRole,
} from "./types";
import { scalarText } from "./scalars";
import { spritePreset } from "@vectspace/presentation-core/visual";
import {
  defaultBackgroundTransition,
  defaultCurtainFill,
  defaultCurtainTransition,
  defaultFlashEffect,
} from "./presentationDefaults";
import {
  countTemplateVariable,
  removeUnknownTemplateVariables,
  renameTemplateVariable,
} from "./textTemplate";
import { renameNodeInGroups } from "./components/graphGroups";
import {
  EFFECT_HANDLE,
  effectReferences,
  setEffectReferenceTarget,
  WINDOW_ROLE_LABELS,
  WINDOW_TITLE_VARIABLES,
} from "./windowInteraction";
import {
  DEFAULT_WINDOW_MOVE_MS,
  defaultPlacementFor,
  describeWindowGeometry,
  describeWindowLayer,
} from "./windowLayout";

export const NODE_TYPES: { type: NodeType; label: string; group: string }[] = [
  { type: "say", label: "对话", group: "叙事" },
  { type: "long_text", label: "长文本", group: "叙事" },
  { type: "long_text_control", label: "文稿控制", group: "叙事" },
  { type: "choice", label: "选择", group: "逻辑" },
  { type: "condition", label: "条件分支", group: "逻辑" },
  { type: "playback", label: "播放控制", group: "流程" },
  { type: "action", label: "Sprite 动作", group: "画面" },
  { type: "set", label: "设置变量", group: "逻辑" },
  { type: "jump", label: "跳转", group: "逻辑" },
  { type: "open_window", label: "打开副窗口", group: "逻辑" },
  { type: "window_title", label: "设置窗口标题", group: "逻辑" },
  { type: "window_control", label: "窗口控制", group: "逻辑" },
  { type: "window_geometry", label: "窗口位置/大小", group: "逻辑" },
  { type: "window_layer", label: "窗口层级", group: "逻辑" },
  { type: "timer", label: "计时器", group: "流程" },
  { type: "background", label: "背景", group: "画面" },
  { type: "curtain", label: "幕布", group: "画面" },
  { type: "sprite", label: "Sprite", group: "画面" },
  { type: "particle", label: "图片粒子", group: "画面" },
  { type: "clear", label: "清除画面", group: "画面" },
  { type: "camera", label: "镜头", group: "画面" },
  { type: "screen_effect", label: "屏幕效果", group: "画面" },
  { type: "timeline", label: "关键帧时间线", group: "画面" },
  { type: "dialogue_ui", label: "对话框", group: "画面" },
  { type: "ui_motion_set", label: "设置 UI 动效", group: "画面" },
  { type: "ui_motion_play", label: "播放 UI 动效", group: "画面" },
  { type: "button_create", label: "创建按钮", group: "交互" },
  { type: "button_update", label: "更新按钮", group: "交互" },
  { type: "button_remove", label: "移除按钮", group: "交互" },
  { type: "bgm", label: "BGM", group: "声音" },
  { type: "ambience", label: "环境声", group: "声音" },
  { type: "sfx", label: "音效", group: "声音" },
  { type: "wait", label: "等待", group: "流程" },
  { type: "end", label: "结束", group: "流程" },
];

export interface OutputPort {
  id: string;
  label: string;
  target: string;
  targetScene: string | null;
}

export type InsertSide = "left" | "right";

export type InsertNodeResult =
  | { ok: true; project: EditorProject; nodeId: string }
  | { ok: false; error: string };

export function nodeLabel(type: NodeType): string {
  return NODE_TYPES.find((candidate) => candidate.type === type)?.label ?? type;
}

export function outputPorts(node: SceneNode): OutputPort[] {
  switch (node.type) {
    case "choice":
      return node.choices.map((choice) => ({
        id: `choice:${choice.id}`,
        label: choice.label || choice.id,
        target: choice.next,
        targetScene: null,
      }));
    case "condition":
      return [
        { id: "then", label: "成立", target: node.then, targetScene: null },
        {
          id: "otherwise",
          label: "否则",
          target: node.otherwise,
          targetScene: null,
        },
      ];
    case "jump":
      return [
        {
          id: "jump",
          label: node.scene === null ? "跳转" : `跳转 ${node.scene}`,
          target: node.target,
          targetScene: node.scene,
        },
      ];
    case "end":
      return [];
    default:
      return [
        { id: "next", label: "下一步", target: node.next, targetScene: null },
      ];
  }
}

export function setPortTarget(
  node: SceneNode,
  handle: string,
  target: string,
): SceneNode {
  if (handle === "next" && "next" in node) {
    return { ...node, next: target };
  }
  if (
    node.type === "condition" &&
    (handle === "then" || handle === "otherwise")
  ) {
    return { ...node, [handle]: target };
  }
  if (node.type === "jump" && handle === "jump") {
    return { ...node, scene: null, target };
  }
  if (handle === EFFECT_HANDLE) {
    return setEffectReferenceTarget(node, handle, target);
  }
  if (node.type === "choice" && handle.startsWith("choice:")) {
    const choiceId = handle.slice("choice:".length);
    return {
      ...node,
      choices: node.choices.map((choice) =>
        choice.id === choiceId ? { ...choice, next: target } : choice,
      ),
    };
  }
  return node;
}

/**
 * Sprite instance ids a scene can refer to: every `sprite` node's `sprite_id`
 * and every timeline sprite track, de-duplicated and sorted.
 */
export function sceneSpriteIds(scene: SceneDefinition): string[] {
  const ids = new Set<string>();
  for (const node of Object.values(scene.nodes)) {
    if (node.type === "sprite") ids.add(node.sprite_id);
    if (node.type === "timeline") {
      for (const track of node.tracks) {
        if (track.type === "sprite") ids.add(track.sprite_id);
      }
    }
  }
  ids.delete("");
  return [...ids].sort();
}

export function summarizeNode(node: SceneNode): string {
  switch (node.type) {
    case "say":
      return `${node.mode === "append" ? "接续 · " : ""}${node.speaker ?? "旁白"}：${node.text}`;
    case "long_text":
      return `${node.mode === "continue" ? "接续" : "开始"} · ${node.document ?? "节点文稿"} · ${node.steps.length} 段`;
    case "long_text_control":
      return `${node.action === "show" ? "显示" : node.action === "hide" ? "隐藏" : "关闭"} · ${node.document}`;
    case "choice":
      return node.presentation == null
        ? `${node.choices.length} 个选项`
        : `${node.choices.length} 个选项 · ${node.presentation.direction === "horizontal" ? "横向" : "纵向"} · ${node.presentation.anchor_x},${node.presentation.anchor_y}`;
    case "set":
      return `${node.variable} ${node.op ?? "assign"} ${summarizeMutationValue(node.value)}`;
    case "condition":
      return summarizeCondition(node.condition);
    case "playback":
      return `${node.auto === "forced" ? "强制自动" : "普通自动"} · Ctrl ${node.ctrl_fast_forward === "block" ? "禁止" : "允许"}`;
    case "action":
      return `${node.action} · ${node.sprite_id}${node.duration_ms ? ` · ${node.duration_ms} ms` : ""}`;
    case "jump":
      return `${node.scene ?? "本场景"} / ${node.target}`;
    case "open_window":
      return `副窗口 · ${node.scene}`;
    case "window_title":
      return `${WINDOW_ROLE_LABELS[node.target]}标题 · ${node.title}`;
    case "window_control":
      return summarizeWindowControl(node);
    case "window_geometry":
      return describeWindowGeometry(node);
    case "window_layer":
      return describeWindowLayer(node);
    case "timer":
      return summarizeTimer(node);
    case "background":
      return node.background ?? "清除背景";
    case "curtain": {
      const action = node.action === "cover" ? "落下" : "收起";
      const fill =
        node.fill == null
          ? "当前幕布"
          : "color" in node.fill
            ? node.fill.color
            : node.fill.asset;
      return `${action}幕布 · ${fill} · ${summarizeTransitionSpec(node.transition)}`;
    }
    case "sprite":
      return `${node.action} ${node.sprite_id}`;
    case "particle":
      return `${node.action} ${node.emitter_id}${node.particle ? ` · ${node.particle}` : ""}`;
    case "clear":
      return `淡出全部内容 · ${node.duration_ms} ms`;
    case "wait":
      return `${node.duration_ms} ms`;
    case "bgm":
      return `${node.action} ${node.asset ?? ""}`.trim();
    case "ambience":
      return `${node.slot} · ${node.action} ${node.asset ?? ""}`.trim();
    case "sfx":
      return node.asset;
    case "camera":
      return `(${node.x}, ${node.y}) ×${node.zoom}`;
    case "screen_effect":
      return summarizeScreenEffect(node.effect);
    case "dialogue_ui":
      return `${node.visible ? "显示" : "隐藏"} · ${node.motion ?? "默认动效"}`;
    case "ui_motion_set":
      return `${node.slot} = ${node.motion ?? "关闭"}`;
    case "ui_motion_play":
      return node.motion || "未选择动效";
    case "button_create":
      return `创建 ${node.instance_id} · ${node.template}`;
    case "button_update":
      return `更新 ${node.instance_id}`;
    case "button_remove":
      return `移除 ${node.instance_id}`;
    case "timeline":
      return `${node.duration_ms} ms · ${node.tracks.length} 轨 · ${node.events.length} 事件`;
    case "end":
      return "剧情终点";
  }
}

function summarizeWindowControl(
  node: Extract<SceneNode, { type: "window_control" }>,
): string {
  const window = WINDOW_ROLE_LABELS[node.target];
  switch (node.action) {
    case "block":
      return `阻挡${window}翻页 · ${node.id ?? ""}`;
    case "unblock":
      return `解除${window}阻挡 · ${node.id ?? ""}`;
    case "advance":
      return `推进${window}一页`;
  }
}

function summarizeTimer(node: Extract<SceneNode, { type: "timer" }>): string {
  if (node.action === "stop") return `停止计时器 ${node.id}`;
  const delay = node.delay_ms ?? 0;
  const repeat =
    node.interval_ms == null ? "单次" : `每 ${node.interval_ms} ms`;
  return `启动 ${node.id} · ${delay} ms 后 · ${repeat} → ${node.target ?? "（未选目标）"}`;
}

/** `#RRGGBB` or `#RRGGBBAA`, matching the Rust loader's accepted colors. */
export const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/;

/** Short author-facing description of one canonical background transition. */
export function summarizeTransitionSpec(
  transition: BackgroundTransitionSpec | CurtainTransitionSpec,
): string {
  switch (transition.type) {
    case "cut":
      return "直接切换";
    case "cross_fade":
      return "交叉淡化";
    case "fade":
      return "淡入淡出";
    case "fade_through_color":
      return `淡过 ${transition.color}`;
    case "wipe":
      return `划像 ${directionLabel(transition.direction)}`;
    case "push":
      return `推入 ${directionLabel(transition.direction)}`;
    case "split_horizontal":
      return "水平对开";
    case "split_vertical":
      return "垂直对开";
  }
}

/** Short author-facing description of one canonical screen effect. */
export function summarizeScreenEffect(effect: ScreenEffectSpec): string {
  switch (effect.type) {
    case "flash":
      return `闪光 ${effect.color}`;
    case "shake":
      return `震动 ${effect.amplitude_x}×${effect.amplitude_y} · ${effect.frequency_hz}Hz · seed ${effect.seed}`;
    case "chromatic_aberration":
      return `色差 ${effect.intensity}px · ${effect.angle_deg}°`;
    case "glitch":
      return `故障 ${effect.displacement}px · ${effect.slice_count} 切片 · ${effect.frequency_hz}Hz · seed ${effect.seed}`;
    case "shockwave":
      return `冲击波 (${effect.center_x}, ${effect.center_y}) · 半径 ${effect.max_radius}px`;
    case "color_grade":
      return `色彩修正 亮度 ${effect.brightness} · 对比度 ${effect.contrast} · 饱和度 ${effect.saturation}`;
    case "focus":
      return `聚焦 (${effect.center_x}, ${effect.center_y}) · 清晰半径 ${effect.radius}px · 模糊 ${effect.blur}px`;
    case "ripple":
      return `波纹 (${effect.center_x}, ${effect.center_y}) · 振幅 ${effect.amplitude}px · 波长 ${effect.wavelength}px`;
  }
}

export function directionLabel(direction: TransitionDirection): string {
  switch (direction) {
    case "left_to_right":
      return "从左到右";
    case "right_to_left":
      return "从右到左";
    case "top_to_bottom":
      return "从上到下";
    case "bottom_to_top":
      return "从下到上";
  }
}

function emitterInstanceIds(
  scenes: readonly SceneDefinition[],
  copies: readonly SceneNode[] = [],
): Set<string> {
  const used = new Set<string>();
  for (const node of [
    ...scenes.flatMap((scene) => Object.values(scene.nodes)),
    ...copies,
  ]) {
    if (node.type === "particle") used.add(node.emitter_id);
    if (node.type === "timeline") {
      for (const track of node.tracks) {
        if (track.type === "emitter") used.add(track.emitter_id);
      }
    }
  }
  return used;
}

function uniqueEmitterId(used: ReadonlySet<string>, prefix = "emitter"): string {
  let id = prefix;
  let index = 2;
  while (used.has(id)) id = `${prefix}_${index++}`;
  return id;
}

/** Remap detached copies as one batch so their internal emitter controls stay together. */
export function remapCopiedEmitterInstances(
  nodes: readonly SceneNode[],
  scenes: readonly SceneDefinition[],
): void {
  const used = emitterInstanceIds(scenes, nodes);
  const copiedIds = new Map<string, string>();
  for (const node of nodes) {
    if (node.type !== "particle" || node.action !== "start") continue;
    if (copiedIds.has(node.emitter_id)) continue;
    const id = uniqueEmitterId(used, node.emitter_id || "emitter");
    copiedIds.set(node.emitter_id, id);
    used.add(id);
  }
  for (const node of nodes) {
    if (node.type === "particle") {
      node.emitter_id = copiedIds.get(node.emitter_id) ?? node.emitter_id;
    } else if (node.type === "timeline") {
      for (const track of node.tracks) {
        if (track.type === "emitter") {
          track.emitter_id = copiedIds.get(track.emitter_id) ?? track.emitter_id;
        }
      }
    }
  }
}

export function defaultNode(
  type: NodeType,
  fallback: string,
  scenes: readonly SceneDefinition[] = [],
): SceneNode {
  switch (type) {
    case "background":
      return {
        type,
        background: null,
        transition: defaultBackgroundTransition(),
        duration_ms: 500,
        easing: "ease_in_out",
        await: false,
        next: fallback,
      };
    case "curtain":
      return {
        type,
        action: "cover",
        fill: defaultCurtainFill(),
        transition: defaultCurtainTransition(),
        duration_ms: 500,
        easing: "ease_in_out",
        await: false,
        next: fallback,
      };
    case "action":
      return {
        type,
        sprite_id: "character",
        action: "action.id",
        duration_ms: null,
        await: true,
        parameters: {},
        end: null,
        next: fallback,
      };
    case "sprite":
      return {
        type,
        sprite_id: "character",
        action: "show",
        asset: null,
        x: 960,
        y: 1080,
        scale: 1,
        opacity: 1,
        z: 0,
        duration_ms: 500,
        easing: "ease_in_out",
        await: false,
        next: fallback,
      };
    case "particle":
      return {
        type,
        emitter_id: uniqueEmitterId(emitterInstanceIds(scenes)),
        action: "start",
        particle: null,
        seed: null,
        space: "world",
        x: 960,
        y: 540,
        scale: 1,
        rotation_deg: 0,
        opacity: 1,
        z: 0,
        next: fallback,
      };
    case "clear":
      return {
        type,
        duration_ms: 500,
        easing: "ease_in_out",
        await: true,
        next: fallback,
      };
    case "say":
      return {
        type,
        speaker: null,
        text: "新对话",
        mode: "start",
        page_id: null,
        speed_cps: null,
        reveal_animation: null,
        next: fallback,
      };
    case "long_text":
      return {
        type,
        document: null,
        mode: "start",
        on_exit: "close",
        paper: null,
        pagination: "auto",
        font_size: 32,
        text_color: "#212533",
        layout: {
          x: 340,
          y: 0,
          width: 1240,
          height: 1080,
          padding_x: 118,
          padding_y: 112,
          page_height: 1340,
          page_gap: 92,
        },
        steps: [
          { id: "step_1", text: "新的长文本内容。", page_break_before: false },
        ],
        speed_cps: null,
        reveal_animation: null,
        next: fallback,
      };
    case "long_text_control":
      return {
        type,
        document: "lecture",
        action: "show",
        next: fallback,
      };
    case "choice":
      return {
        type,
        choices: [
          { id: "option_1", label: "选项一", next: fallback },
          { id: "option_2", label: "选项二", next: fallback },
        ],
      };
    case "set":
      return {
        type,
        variable: "flag",
        op: "assign",
        value: true,
        next: fallback,
      };
    case "condition":
      return {
        type,
        condition: defaultCondition(),
        then: fallback,
        otherwise: fallback,
      };
    case "playback":
      return {
        type,
        auto: "normal",
        ctrl_fast_forward: "allow",
        next: fallback,
      };
    case "jump":
      return { type, scene: null, target: fallback };
    case "open_window":
      return { type, scene: "", next: fallback };
    case "window_title":
      return { type, target: "main", title: "新标题", next: fallback };
    case "window_control":
      return {
        type,
        target: "secondary",
        action: "block",
        id: "gate",
        message: "",
        next: fallback,
      };
    case "window_geometry":
      // Dock the secondary window beside the main one: legal wherever it is
      // added, and visibly does something without further editing.
      return {
        type,
        target: "secondary",
        position: defaultPlacementFor("secondary"),
        duration_ms: DEFAULT_WINDOW_MOVE_MS,
        easing: "ease_in_out",
        await: false,
        next: fallback,
      };
    case "window_layer":
      return { type, target: "main", action: "raise", next: fallback };
    case "timer":
      return {
        type,
        id: "timer_1",
        action: "start",
        delay_ms: 1000,
        interval_ms: null,
        target: null,
        next: fallback,
      };
    case "wait":
      return { type, duration_ms: 500, next: fallback };
    case "bgm":
      return {
        type,
        action: "start",
        asset: null,
        volume: 1,
        duration_ms: 500,
        await: false,
        next: fallback,
      };
    case "ambience":
      return {
        type,
        slot: "slot_1",
        action: "start",
        asset: null,
        volume: 0.8,
        duration_ms: 500,
        await: false,
        next: fallback,
      };
    case "sfx":
      return { type, asset: "", volume: 1, next: fallback };
    case "camera":
      return {
        type,
        x: 0,
        y: 0,
        zoom: 1,
        duration_ms: 500,
        easing: "ease_in_out",
        await: false,
        next: fallback,
      };
    case "screen_effect":
      return {
        type,
        effect: defaultFlashEffect(),
        duration_ms: 200,
        await: false,
        next: fallback,
      };
    case "dialogue_ui":
      return {
        type,
        visible: true,
        motion: null,
        duration_ms: null,
        await: false,
        next: fallback,
      };
    case "ui_motion_set":
      return {
        type,
        slot: "dialogue_show",
        motion: null,
        next: fallback,
      };
    case "ui_motion_play":
      return {
        type,
        motion: "",
        duration_ms: null,
        await: false,
        next: fallback,
      };
    case "button_create":
      return {
        type,
        instance_id: "button_1",
        template: "button.default",
        x: 860,
        y: 900,
        width: 200,
        height: 80,
        rotation_deg: 0,
        scale_x: 1,
        scale_y: 1,
        opacity: 1,
        z: 10,
        visible: true,
        enabled: true,
        action: { sets: [], next: null },
        next: fallback,
      };
    case "button_update":
      return {
        type,
        instance_id: "button_1",
        template: null,
        x: null,
        y: null,
        width: null,
        height: null,
        rotation_deg: null,
        scale_x: null,
        scale_y: null,
        opacity: null,
        z: null,
        visible: null,
        enabled: null,
        action: null,
        next: fallback,
      };
    case "button_remove":
      return { type, instance_id: "button_1", next: fallback };
    case "timeline":
      return {
        type,
        duration_ms: 2400,
        await: true,
        skippable: true,
        tracks: [],
        events: [],
        next: fallback,
      };
    case "end":
      return { type };
  }
}

export function canConvertToTimeline(node: SceneNode): boolean {
  return ["sprite", "camera", "screen_effect", "wait", "sfx"].includes(
    node.type,
  );
}

/**
 * Resolve the artwork a sprite node will use at runtime.  A node may omit
 * `asset` when its character and expression point to a registered portrait;
 * keeping this lookup in one place prevents the editor from treating that
 * valid form as an incomplete direct-sprite node.
 */
export function resolveSpriteAsset(
  node: Extract<SceneNode, { type: "sprite" }>,
  manifest?: ContentManifest,
): string | null {
  if (node.source !== undefined)
    return node.source.type === "image" ? node.source.asset : null;
  if (node.asset != null && node.asset !== "") return node.asset;
  if (node.character == null || node.character === "") return null;
  if (manifest === undefined) return null;
  const character = manifest.characters[node.character];
  if (character === undefined) return null;
  const expressionId = node.expression ?? character.default_expression;
  return expressionId == null
    ? null
    : ((character.expressions ?? {})[expressionId]?.asset ?? null);
}

/**
 * Expand one compact presentation node into an editable Timeline node. Move,
 * hide and camera channels explicitly inherit the runtime value at 0ms, so
 * conversion is independent of the route used to reach the node.
 */
export function convertToTimeline(
  node: SceneNode,
  manifest?: ContentManifest,
): TimelineNode {
  const timeline = (
    duration_ms: number,
    awaitCompletion: boolean,
  ): TimelineNode => ({
    type: "timeline",
    duration_ms: Math.max(1, duration_ms),
    await: awaitCompletion,
    skippable: false,
    tracks: [],
    events: [],
    next: "next" in node ? node.next : "",
  });

  if (node.type === "wait") return timeline(node.duration_ms, true);
  if (node.type === "sfx") {
    return {
      ...timeline(1, false),
      events: [
        {
          type: "sfx",
          id: "quick_sfx",
          at_ms: 0,
          asset: node.asset,
          volume: node.volume,
        },
      ],
    };
  }
  if (node.type === "screen_effect") {
    const result = timeline(node.duration_ms, node.await);
    result.events = [
      {
        type: "screen_effect",
        id: "quick_effect",
        at_ms: 0,
        effect: node.effect,
        duration_ms: node.duration_ms,
      },
    ];
    return result;
  }
  if (node.type === "camera") {
    const result = timeline(node.duration_ms, node.await);
    result.tracks = [
      {
        type: "camera",
        channels: inheritedChannels(
          {
            x: node.x,
            y: node.y,
            zoom: node.zoom,
          },
          result.duration_ms,
          node.easing,
        ),
      },
    ];
    return result;
  }
  if (node.type === "sprite") {
    const result = timeline(node.duration_ms, node.await);
    const resolvedAsset =
      node.action === "hide"
        ? (node.asset ?? null)
        : resolveSpriteAsset(node, manifest);
    let channels: TimelineChannels;
    if (node.action === "show") {
      const source =
        node.source ??
        (resolvedAsset === null
          ? null
          : { type: "image" as const, asset: resolvedAsset });
      if (source === null) {
        throw new Error("显示 Sprite 缺少图片、文本块或有效角色表情，无法转换。");
      }
      const preset = spritePreset(
        node.sprite_kind ?? (source.type === "text" ? "text" : "character"),
        source,
      );
      const target = {
        x: node.x ?? preset.x,
        y: node.y ?? preset.y,
        scale: node.scale ?? preset.scale,
        scale_x: node.scale_x ?? preset.scale_x,
        scale_y: node.scale_y ?? preset.scale_y,
        rotation_deg: node.rotation_deg ?? preset.rotation_deg,
        opacity: node.opacity ?? preset.opacity,
        z: node.z ?? preset.z,
      };
      channels = pairedChannels(
        { ...target, y: target.y + 48, scale: target.scale * 0.96, opacity: 0 },
        target,
        result.duration_ms,
        node.easing,
      );
    } else if (node.action === "hide") {
      channels = inheritedChannels(
        { opacity: 0 },
        result.duration_ms,
        node.easing,
      );
    } else {
      channels = inheritedChannels(
        Object.fromEntries(
          Object.entries({
            x: node.x,
            y: node.y,
            scale: node.scale,
            scale_x: node.scale_x,
            scale_y: node.scale_y,
            rotation_deg: node.rotation_deg,
            opacity: node.opacity,
            z: node.z,
          }).filter((entry): entry is [string, number] => entry[1] != null),
        ),
        result.duration_ms,
        node.easing,
      );
    }
    result.tracks = [
      {
        type: "sprite",
        sprite_id: node.sprite_id,
        ...(node.source === undefined ? { asset: resolvedAsset } : { source: node.source }),
        ...(node.sprite_kind === undefined ? {} : { sprite_kind: node.sprite_kind }),
        ...(node.space === undefined ? {} : { space: node.space }),
        ...(node.layout === undefined ? {} : { layout: node.layout }),
        remove_at_end: node.action === "hide",
        channels,
      },
    ];
    return result;
  }
  throw new Error(`${nodeLabel(node.type)}节点不能无损转换为关键帧时间线。`);
}

function pairedChannels(
  start: Record<string, number>,
  end: Record<string, number>,
  durationMs: number,
  easing: "linear" | "ease_in" | "ease_out" | "ease_in_out",
): TimelineChannels {
  return Object.fromEntries(
    Object.keys(end).map((channel) => [
      channel,
      [
        {
          at_ms: 0,
          value: start[channel] ?? end[channel] ?? 0,
          easing: channel === "z" ? "step" : easing,
        },
        {
          at_ms: durationMs,
          value: end[channel] ?? 0,
          easing: "linear",
        },
      ],
    ]),
  );
}

function inheritedChannels(
  end: Record<string, number>,
  durationMs: number,
  easing: "linear" | "ease_in" | "ease_out" | "ease_in_out",
): TimelineChannels {
  return Object.fromEntries(
    Object.entries(end).map(([channel, value]) => [
      channel,
      [
        {
          at_ms: 0,
          value: "inherit" as const,
          easing: channel === "z" ? ("step" as const) : easing,
        },
        { at_ms: durationMs, value, easing: "linear" as const },
      ],
    ]),
  );
}

export function uniqueNodeId(scene: SceneDefinition, prefix: string): string {
  const cleaned = prefix.replace(/[^A-Za-z0-9._-]/g, "_") || "node";
  if (scene.nodes[cleaned] === undefined) {
    return cleaned;
  }
  let index = 2;
  while (scene.nodes[`${cleaned}_${index}`] !== undefined) {
    index += 1;
  }
  return `${cleaned}_${index}`;
}

export function splitDialogueAt(
  scene: SceneDefinition,
  nodeId: string,
  offset: number,
): { first: SceneNode; continuation: SceneNode; continuationId: string } {
  const node = scene.nodes[nodeId];
  if (node?.type !== "say") throw new Error("只能拆分对话节点。");
  const before = node.text.slice(0, offset);
  const after = node.text.slice(offset);
  if (before.trim() === "" || after.trim() === "") {
    throw new Error("请把光标放在对话正文内部；分段前后都必须有文本。");
  }
  const continuationId = uniqueNodeId(scene, `${nodeId}_continue`);
  const pageId =
    node.page_id === null || node.page_id === undefined || node.page_id === ""
      ? nodeId
      : node.page_id;
  return {
    continuationId,
    first: {
      ...node,
      text: before,
      mode: node.mode ?? "start",
      page_id: pageId,
      next: continuationId,
    },
    continuation: {
      ...node,
      text: after,
      mode: "append",
      page_id: pageId,
      next: node.next,
    },
  };
}

export interface SplitLongTextResult {
  first: LongTextNode;
  continuation: LongTextNode;
  continuationId: string;
  previousDocument: string;
  document: string;
}

/**
 * Rewrite references to a long-text document within one scene.  This is
 * intentionally shared by normal document edits and the split command so an
 * implicit document (whose ID is the start node ID) cannot leave controls or
 * continuation nodes dangling.
 */
export function rewriteLongTextDocumentReferences(
  scene: SceneDefinition,
  from: string,
  to: string,
  excludedNodeId?: string,
): void {
  if (from === to) return;
  for (const [candidateId, candidate] of Object.entries(scene.nodes)) {
    if (
      candidateId === excludedNodeId ||
      (candidate.type !== "long_text" &&
        candidate.type !== "long_text_control") ||
      candidate.document !== from
    ) {
      continue;
    }
    candidate.document = to;
  }
}

/**
 * Split a long-text node before `stepIndex`.  The returned continuation only
 * carries fields that are legal on a `continue` node; presentation fields are
 * inherited from the first node at runtime and must not be serialized again.
 */
export function splitLongTextAt(
  scene: SceneDefinition,
  nodeId: string,
  stepIndex: number,
): SplitLongTextResult {
  const source = scene.nodes[nodeId];
  if (source?.type !== "long_text") {
    throw new Error("只能拆分长文本节点。");
  }
  if (stepIndex <= 0 || stepIndex >= source.steps.length) {
    throw new Error("只能在第二段及之后拆分长文本。");
  }

  const continuationId = uniqueNodeId(scene, `${nodeId}_continue`);
  const usedDocuments = new Set(
    Object.entries(scene.nodes).flatMap(([id, node]) =>
      node.type === "long_text" ? [node.document ?? id] : [],
    ),
  );
  const previousDocument = source.document ?? nodeId;
  let document = source.document ?? `${nodeId}_document`;
  let suffix = 2;
  while (usedDocuments.has(document) && document !== source.document) {
    document = `${nodeId}_document_${suffix}`;
    suffix += 1;
  }

  const first: LongTextNode = {
    ...source,
    document,
    mode: source.mode ?? "start",
    on_exit: "keep_visible",
    steps: source.steps.slice(0, stepIndex),
    next: continuationId,
  };
  const continuation: LongTextNode = {
    ...source,
    document,
    mode: "continue",
    steps: source.steps.slice(stepIndex),
    next: source.next,
  };
  delete continuation.paper;
  delete continuation.pagination;
  delete continuation.font_size;
  delete continuation.text_color;
  delete continuation.layout;

  return {
    first,
    continuation,
    continuationId,
    previousDocument,
    document,
  };
}

/**
 * Prepare one copied node for insertion as an independent graph node.
 * Flow edges never cross the clipboard boundary. References that no longer
 * exist in the destination project are intentionally emptied so the editor can
 * surface them as ordinary, fixable diagnostics.
 */
export function preparePastedNode(
  source: SceneNode,
  manifest: ContentManifest,
  sourceCharacterId: string | null = null,
  buttons: readonly ButtonFile[] = [],
): SceneNode {
  const node = structuredClone(source);
  // Variables a template or condition operand may read (the read-only window
  // title variables are always available); `set` still writes manifest ones.
  const writableVariables = new Set(Object.keys(manifest.variables));
  const variables = new Set([...writableVariables, ...WINDOW_TITLE_VARIABLES]);
  const hasAsset = (id: string | null | undefined, kind: string): boolean =>
    id != null && manifest.assets[id]?.kind === kind;
  const hasButton = (id: string | null | undefined): boolean =>
    id != null && buttons.some((file) => file.definition.id === id);
  const clearOperand = (
    operand: { variable: string } | { value: ScalarValue },
  ): { variable: string } | { value: ScalarValue } =>
    "variable" in operand && !variables.has(operand.variable)
      ? { variable: "" }
      : operand;
  const clearCondition = (
    condition: ConditionExpression,
  ): ConditionExpression => {
    switch (condition.op) {
      case "eq":
      case "ne":
      case "lt":
      case "le":
      case "gt":
      case "ge":
        return {
          ...condition,
          left: clearOperand(condition.left),
          right: clearOperand(condition.right),
        };
      case "and":
      case "or":
        return {
          ...condition,
          conditions: condition.conditions.map(clearCondition),
        };
      case "not":
        return { ...condition, condition: clearCondition(condition.condition) };
    }
  };

  if ("next" in node) node.next = "";
  switch (node.type) {
    case "background":
      if (node.background !== null && !hasAsset(node.background, "background"))
        node.background = null;
      if (
        node.transition.type === "fade_through_color" &&
        !COLOR_PATTERN.test(node.transition.color)
      ) {
        node.transition = defaultBackgroundTransition();
      }
      break;
    case "curtain":
      if (
        node.fill != null &&
        "asset" in node.fill &&
        !hasAsset(node.fill.asset, "gui")
      ) {
        node.fill = null;
      }
      break;
    case "sprite":
      if (node.asset != null && !hasAsset(node.asset, "sprite"))
        node.asset = null;
      break;
    case "say":
      if (
        sourceCharacterId !== null &&
        manifest.characters[sourceCharacterId] === undefined
      ) {
        node.speaker = null;
      }
      node.text = removeUnknownTemplateVariables(node.text, variables);
      break;
    case "choice":
      node.choices = node.choices.map((choice) => ({
        ...choice,
        label: removeUnknownTemplateVariables(choice.label, variables),
        next: "",
        ...(hasButton(choice.template) ? {} : { template: null }),
        ...(hasAsset(choice.icon, "gui") ? {} : { icon: null }),
        ...(choice.visible_if === undefined
          ? {}
          : { visible_if: clearCondition(choice.visible_if) }),
        ...(choice.enabled_if === undefined
          ? {}
          : { enabled_if: clearCondition(choice.enabled_if) }),
      }));
      if (node.presentation != null && !hasButton(node.presentation.template)) {
        node.presentation = { ...node.presentation, template: null };
      }
      break;
    case "set":
      if (!writableVariables.has(node.variable)) node.variable = "";
      if (
        typeof node.value === "object" &&
        node.value !== null &&
        !variables.has(node.value.variable)
      ) {
        node.value = { variable: "" };
      }
      break;
    case "condition":
      node.condition = clearCondition(node.condition);
      node.then = "";
      node.otherwise = "";
      break;
    case "jump":
      node.scene = null;
      node.target = "";
      break;
    case "open_window":
      node.scene = "";
      break;
    case "window_title":
      node.title = removeUnknownTemplateVariables(node.title, variables);
      break;
    case "window_control":
      if (node.message !== undefined && node.message !== "") {
        node.message = removeUnknownTemplateVariables(node.message, variables);
      }
      break;
    case "timer":
      // The effect target is a node of the *source* Scene; like flow edges it
      // never crosses the clipboard boundary on its own.
      if (node.target != null) node.target = null;
      break;
    case "bgm":
      if (node.asset !== null && !hasAsset(node.asset, "bgm"))
        node.asset = null;
      break;
    case "ambience":
      if (node.asset != null && !hasAsset(node.asset, "ambience"))
        node.asset = null;
      break;
    case "sfx":
      if (!hasAsset(node.asset, "sfx")) node.asset = "";
      break;
    case "timeline":
      node.tracks = node.tracks.map((track) => {
        if (
          track.type === "sprite" &&
          track.asset !== null &&
          !hasAsset(track.asset, "sprite")
        )
          return { ...track, asset: null };
        if (track.type === "video" && !hasAsset(track.asset, "video"))
          return { ...track, asset: "" };
        return track;
      });
      node.events = node.events.map((event) =>
        event.type === "sfx" && !hasAsset(event.asset, "sfx")
          ? { ...event, asset: "" }
          : event,
      );
      break;
    case "playback":
    case "wait":
    case "clear":
    case "camera":
    case "screen_effect":
    case "dialogue_ui":
    case "ui_motion_set":
    case "ui_motion_play":
    case "end":
      break;
  }
  return node;
}

/**
 * Insert a node immediately before or after another node while preserving the
 * existing local flow wherever that can be represented by a single edge.
 */
export function insertNode(
  project: EditorProject,
  sceneId: string,
  sourceId: string,
  side: InsertSide,
  type: NodeType,
  portId?: string,
): InsertNodeResult {
  const updated = cloneProject(project);
  const file = findScene(updated, sceneId);
  if (file === undefined) {
    return { ok: false, error: `找不到场景 ${sceneId}。` };
  }
  const source = file.definition.nodes[sourceId];
  if (source === undefined) {
    return { ok: false, error: `找不到节点 ${sourceId}。` };
  }

  const sourcePorts = outputPorts(source);
  const selectedPort =
    side === "right"
      ? portId === undefined
        ? sourcePorts.length === 1
          ? sourcePorts[0]
          : undefined
        : sourcePorts.find((port) => port.id === portId)
      : undefined;
  if (side === "right") {
    if (sourcePorts.length === 0) {
      return { ok: false, error: "结束节点没有后续出口，无法在右侧插入。" };
    }
    if (sourcePorts.length !== 1 && portId === undefined) {
      return {
        ok: false,
        error: "该节点有多个分支出口，请先选择要插入的出口。",
      };
    }
    if (selectedPort === undefined) {
      return { ok: false, error: `找不到出口 ${portId ?? ""}。` };
    }
    const targetScene = selectedPort.targetScene;
    if (targetScene !== null && targetScene !== sceneId) {
      return {
        ok: false,
        error: "跨场景跳转不能直接在右侧插入，请先改成本场景节点。",
      };
    }
  }

  const originalTarget =
    side === "right" ? (selectedPort?.target ?? sourceId) : sourceId;
  const template = defaultNode(
    type,
    originalTarget,
    updated.scenes.map((scene) => scene.definition),
  );
  const templatePorts = outputPorts(template);
  if (templatePorts.length === 0 && !(side === "right" && type === "end")) {
    return { ok: false, error: "结束节点没有出口，不能作为中间插入节点。" };
  }

  const nodeId = uniqueNodeId(file.definition, `${type}_${sourceId}`);
  if (side === "left") {
    for (const candidateFile of updated.scenes) {
      for (const [candidateId, candidate] of Object.entries(
        candidateFile.definition.nodes,
      )) {
        let changed = candidate;
        for (const port of outputPorts(changed)) {
          const pointsToSource =
            port.target === sourceId &&
            (port.targetScene === null
              ? candidateFile.definition.id === sceneId
              : port.targetScene === sceneId);
          if (pointsToSource) {
            changed =
              changed.type === "jump" && port.id === "jump"
                ? { ...changed, target: nodeId }
                : setPortTarget(changed, port.id, nodeId);
          }
        }
        if (
          changed.type === "jump" &&
          (changed.scene ?? candidateFile.definition.id) === sceneId &&
          changed.target === sourceId
        ) {
          changed = { ...changed, target: nodeId };
        }
        candidateFile.definition.nodes[candidateId] = changed;
      }
    }
    if (file.definition.entry === sourceId) {
      file.definition.entry = nodeId;
    }
    file.definition.nodes[nodeId] = setPortTarget(
      template,
      templatePorts[0].id,
      sourceId,
    );
  } else {
    // `selectedPort` is guaranteed above for a right insertion, including
    // Choice/Condition branches selected by the script-view outlet picker.
    const rightPort = selectedPort ?? sourcePorts[0];
    if (rightPort === undefined) {
      return { ok: false, error: "节点没有可用的后续出口。" };
    }
    file.definition.nodes[sourceId] = setPortTarget(
      source,
      rightPort.id,
      nodeId,
    );
    file.definition.nodes[nodeId] =
      templatePorts.length === 0
        ? template
        : setPortTarget(template, templatePorts[0].id, originalTarget);
  }

  const sceneLayout = ensureSceneLayout(updated.layout, sceneId);
  const origin: NodePosition = sceneLayout.nodes[sourceId] ?? {
    x: 120,
    y: 120,
  };
  const position: NodePosition = {
    x: origin.x + (side === "right" ? 340 : -340),
    y: origin.y,
  };
  const occupied = Object.entries(sceneLayout.nodes).filter(
    ([candidateId]) => candidateId !== sourceId,
  );
  let attempts = 0;
  while (
    occupied.some(
      ([, candidate]) =>
        Math.abs(candidate.x - position.x) < 280 &&
        Math.abs(candidate.y - position.y) < 150,
    ) &&
    attempts < 24
  ) {
    position.y += 180;
    attempts += 1;
  }
  sceneLayout.nodes[nodeId] = position;

  return { ok: true, project: updated, nodeId };
}

export function parseScalar(
  value: string,
  kind: "text" | "number" | "boolean",
): ScalarValue {
  if (kind === "boolean") {
    return value === "true";
  }
  if (kind === "number") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }
  return value;
}

export function scalarKind(value: ScalarValue): "text" | "number" | "boolean" {
  return typeof value === "string"
    ? "text"
    : typeof value === "boolean"
      ? "boolean"
      : "number";
}

export function defaultCondition(variable = "flag"): ConditionExpression {
  return {
    op: "eq",
    left: { variable },
    right: { value: true },
  };
}

export function summarizeCondition(condition: ConditionExpression): string {
  switch (condition.op) {
    case "eq":
    case "ne":
    case "lt":
    case "le":
    case "gt":
    case "ge":
      return `${summarizeOperand(condition.left)} ${condition.op} ${summarizeOperand(condition.right)}`;
    case "and":
    case "or":
      return condition.conditions
        .map((child) => `(${summarizeCondition(child)})`)
        .join(` ${condition.op} `);
    case "not":
      return `not (${summarizeCondition(condition.condition)})`;
  }
}

function summarizeOperand(
  operand: { variable: string } | { value: ScalarValue },
): string {
  if ("variable" in operand) return operand.variable;
  if (typeof operand.value === "string") return JSON.stringify(operand.value);
  return scalarText(operand.value);
}

export function renameVariable(
  project: EditorProject,
  previousId: string,
  nextId: string,
): EditorProject {
  if (
    project.manifest.variables[previousId] === undefined ||
    project.manifest.variables[nextId] !== undefined
  ) {
    return project;
  }
  const updated = cloneProject(project);
  const definition = updated.manifest.variables[previousId];
  Reflect.deleteProperty(updated.manifest.variables, previousId);
  updated.manifest.variables[nextId] = definition;
  for (const file of updated.scenes) {
    for (const node of Object.values(file.definition.nodes)) {
      if (node.type === "set" && node.variable === previousId) {
        node.variable = nextId;
      }
      if (
        node.type === "set" &&
        typeof node.value === "object" &&
        node.value !== null &&
        node.value.variable === previousId
      ) {
        node.value.variable = nextId;
      }
      if (node.type === "say") {
        node.text = renameTemplateVariable(node.text, previousId, nextId);
      }
      if (node.type === "window_title") {
        node.title = renameTemplateVariable(node.title, previousId, nextId);
      }
      if (node.type === "window_control" && node.message !== undefined) {
        node.message = renameTemplateVariable(node.message, previousId, nextId);
      }
      if (node.type === "condition") {
        node.condition = mapConditionVariables(
          node.condition,
          previousId,
          nextId,
        );
      }
      if (node.type === "choice") {
        for (const choice of node.choices) {
          choice.label = renameTemplateVariable(
            choice.label,
            previousId,
            nextId,
          );
          if (choice.visible_if !== undefined) {
            choice.visible_if = mapConditionVariables(
              choice.visible_if,
              previousId,
              nextId,
            );
          }
          if (choice.enabled_if !== undefined) {
            choice.enabled_if = mapConditionVariables(
              choice.enabled_if,
              previousId,
              nextId,
            );
          }
        }
      }
    }
  }
  for (const settings of Object.values(
    updated.layout.timeline_previews ?? {},
  )) {
    if (
      Object.prototype.hasOwnProperty.call(
        settings.variable_overrides,
        previousId,
      )
    ) {
      settings.variable_overrides[nextId] =
        settings.variable_overrides[previousId];
      Reflect.deleteProperty(settings.variable_overrides, previousId);
    }
  }
  return updated;
}

export function countVariableReferences(
  project: EditorProject,
  variableId: string,
): number {
  let count = 0;
  for (const file of project.scenes) {
    for (const node of Object.values(file.definition.nodes)) {
      if (node.type === "set" && node.variable === variableId) count += 1;
      if (
        node.type === "set" &&
        typeof node.value === "object" &&
        node.value !== null &&
        node.value.variable === variableId
      ) {
        count += 1;
      }
      if (node.type === "say") {
        count += countTemplateVariable(node.text, variableId);
      }
      if (node.type === "window_title") {
        count += countTemplateVariable(node.title, variableId);
      }
      if (node.type === "window_control" && node.message !== undefined) {
        count += countTemplateVariable(node.message, variableId);
      }
      if (node.type === "condition") {
        count += countConditionReferences(node.condition, variableId);
      }
      if (node.type === "choice") {
        for (const choice of node.choices) {
          count += countTemplateVariable(choice.label, variableId);
          if (choice.visible_if !== undefined) {
            count += countConditionReferences(choice.visible_if, variableId);
          }
          if (choice.enabled_if !== undefined) {
            count += countConditionReferences(choice.enabled_if, variableId);
          }
        }
      }
    }
  }
  return count;
}

export function renameCharacter(
  project: EditorProject,
  previousId: string,
  nextId: string,
): EditorProject {
  if (
    project.manifest.characters[previousId] === undefined ||
    project.manifest.characters[nextId] !== undefined
  ) {
    return project;
  }
  const updated = cloneProject(project);
  const definition = updated.manifest.characters[previousId];
  Reflect.deleteProperty(updated.manifest.characters, previousId);
  updated.manifest.characters[nextId] = definition;
  for (const file of updated.scenes) {
    for (const node of Object.values(file.definition.nodes)) {
      if (node.type === "say" && node.speaker === previousId) {
        node.speaker = nextId;
      }
      if (node.type === "sprite" && node.character === previousId) {
        node.character = nextId;
      }
    }
  }
  return updated;
}

export function countCharacterReferences(
  project: EditorProject,
  characterId: string,
): number {
  let count = 0;
  for (const file of project.scenes) {
    for (const node of Object.values(file.definition.nodes)) {
      if (node.type === "say" && node.speaker === characterId) count += 1;
      if (node.type === "sprite" && node.character === characterId) count += 1;
    }
  }
  return count;
}

function summarizeMutationValue(value: MutationValue | undefined): string {
  if (value === undefined) return "";
  return typeof value === "object" && value !== null
    ? value.variable
    : String(value);
}

function mapConditionVariables(
  condition: ConditionExpression,
  previousId: string,
  nextId: string,
): ConditionExpression {
  switch (condition.op) {
    case "eq":
    case "ne":
    case "lt":
    case "le":
    case "gt":
    case "ge":
      return {
        ...condition,
        left: renameOperand(condition.left, previousId, nextId),
        right: renameOperand(condition.right, previousId, nextId),
      };
    case "and":
    case "or":
      return {
        ...condition,
        conditions: condition.conditions.map((child) =>
          mapConditionVariables(child, previousId, nextId),
        ),
      };
    case "not":
      return {
        ...condition,
        condition: mapConditionVariables(
          condition.condition,
          previousId,
          nextId,
        ),
      };
  }
}

function renameOperand(
  operand: { variable: string } | { value: ScalarValue },
  previousId: string,
  nextId: string,
) {
  return "variable" in operand && operand.variable === previousId
    ? { variable: nextId }
    : operand;
}

function countConditionReferences(
  condition: ConditionExpression,
  variableId: string,
): number {
  switch (condition.op) {
    case "eq":
    case "ne":
    case "lt":
    case "le":
    case "gt":
    case "ge":
      return [condition.left, condition.right].filter(
        (operand) => "variable" in operand && operand.variable === variableId,
      ).length;
    case "and":
    case "or":
      return condition.conditions.reduce(
        (total, child) => total + countConditionReferences(child, variableId),
        0,
      );
    case "not":
      return countConditionReferences(condition.condition, variableId);
  }
}

export function cloneProject(project: EditorProject): EditorProject {
  return structuredClone(project);
}

export function findScene(
  project: EditorProject,
  sceneId: string,
): EditorSceneFile | undefined {
  return project.scenes.find((scene) => scene.definition.id === sceneId);
}

export function renameNode(
  project: EditorProject,
  sceneId: string,
  previousId: string,
  nextId: string,
): EditorProject {
  const updated = cloneProject(project);
  const targetScene = findScene(updated, sceneId);
  if (targetScene === undefined) {
    return project;
  }
  const node = targetScene.definition.nodes[previousId];
  if (
    node === undefined ||
    targetScene.definition.nodes[nextId] !== undefined
  ) {
    return project;
  }
  Reflect.deleteProperty(targetScene.definition.nodes, previousId);
  targetScene.definition.nodes[nextId] = node;
  if (targetScene.definition.entry === previousId) {
    targetScene.definition.entry = nextId;
  }

  // An unnamed start long-text uses its node ID as the document ID. Renaming
  // that node therefore changes the document's effective ID; keep local
  // continuation/control references valid instead of leaving a hidden stale
  // document reference behind.
  if (
    node.type === "long_text" &&
    (node.mode ?? "start") === "start" &&
    (node.document === undefined || node.document === null)
  ) {
    for (const [candidateId, candidate] of Object.entries(
      targetScene.definition.nodes,
    )) {
      if (candidateId === nextId) continue;
      if (
        (candidate.type === "long_text" ||
          candidate.type === "long_text_control") &&
        candidate.document === previousId
      ) {
        targetScene.definition.nodes[candidateId] = {
          ...candidate,
          document: nextId,
        };
      }
    }
  }

  for (const file of updated.scenes) {
    for (const [nodeId, candidate] of Object.entries(file.definition.nodes)) {
      let changed = candidate;
      if (file.definition.id === sceneId) {
        for (const port of outputPorts(candidate)) {
          if (port.targetScene === null && port.target === previousId) {
            changed = setPortTarget(changed, port.id, nextId);
          }
        }
        // Timer effect targets are references, not flow edges.
        for (const reference of effectReferences(changed)) {
          if (reference.target === previousId) {
            changed = setEffectReferenceTarget(changed, reference.id, nextId);
          }
        }
      }
      if (
        changed.type === "jump" &&
        (changed.scene ?? file.definition.id) === sceneId &&
        changed.target === previousId
      ) {
        changed = { ...changed, target: nextId };
      }
      file.definition.nodes[nodeId] = changed;
    }
  }

  const sceneLayout = updated.layout.scenes[sceneId];
  if (sceneLayout?.nodes[previousId] !== undefined) {
    sceneLayout.nodes[nextId] = sceneLayout.nodes[previousId];
    Reflect.deleteProperty(sceneLayout.nodes, previousId);
  }
  if (sceneLayout?.groups !== undefined)
    sceneLayout.groups = renameNodeInGroups(
      sceneLayout.groups,
      previousId,
      nextId,
      new Set(Object.keys(targetScene.definition.nodes)),
    );
  const previews = updated.layout.timeline_previews;
  if (previews !== undefined) {
    const oldKey = `${sceneId}/${previousId}`;
    const newKey = `${sceneId}/${nextId}`;
    if (previews[oldKey] !== undefined) {
      previews[newKey] = previews[oldKey];
      Reflect.deleteProperty(previews, oldKey);
    }
    migratePreviewChoices(previews, (choice) =>
      choice.scene_id === sceneId && choice.node_id === previousId
        ? { ...choice, node_id: nextId }
        : choice,
    );
  }
  return updated;
}

export function renameScene(
  project: EditorProject,
  previousId: string,
  nextId: string,
): EditorProject {
  const updated = cloneProject(project);
  const scene = findScene(updated, previousId);
  if (scene === undefined || findScene(updated, nextId) !== undefined) {
    return project;
  }
  scene.definition.id = nextId;
  const oldPath = scene.path;
  const newPath = `scenes/${nextId}.yaml`;
  scene.path = newPath;
  updated.manifest.scenes = updated.manifest.scenes.map((path) =>
    path === oldPath ? newPath : path,
  );
  if (updated.manifest.entry_scene === previousId) {
    updated.manifest.entry_scene = nextId;
  }
  for (const file of updated.scenes) {
    for (const node of Object.values(file.definition.nodes)) {
      if (node.type === "jump" && node.scene === previousId) {
        node.scene = nextId;
      }
      if (node.type === "open_window" && node.scene === previousId) {
        node.scene = nextId;
      }
    }
  }
  if (updated.layout.scenes[previousId] !== undefined) {
    updated.layout.scenes[nextId] = updated.layout.scenes[previousId];
    Reflect.deleteProperty(updated.layout.scenes, previousId);
  }
  if (updated.chapter_map !== null && updated.chapter_map !== undefined) {
    for (const hotspot of updated.chapter_map.definition.hotspots) {
      if (hotspot.scene_id === previousId) hotspot.scene_id = nextId;
    }
  }
  const previews = updated.layout.timeline_previews;
  if (previews !== undefined) {
    for (const key of Object.keys(previews)) {
      if (key.startsWith(`${previousId}/`)) {
        previews[`${nextId}/${key.slice(previousId.length + 1)}`] =
          previews[key];
        Reflect.deleteProperty(previews, key);
      }
    }
    migratePreviewChoices(previews, (choice) =>
      choice.scene_id === previousId ? { ...choice, scene_id: nextId } : choice,
    );
  }
  return updated;
}

/** Rename a reusable sprite action and keep every scene reference/file path in
 * sync.  The caller performs user-facing validation; returning the original
 * project makes this helper safe to use from an editor reducer when a race
 * caused the source action to disappear. */
export function renameSpriteAction(
  project: EditorProject,
  previousId: string,
  nextId: string,
): EditorProject {
  const updated = cloneProject(project);
  const action = (updated.actions ?? []).find(
    (file) => file.definition.id === previousId,
  );
  if (
    action === undefined ||
    previousId === nextId ||
    (updated.actions ?? []).some((file) => file.definition.id === nextId) ||
    updated.manifest.assets[nextId] !== undefined ||
    (updated.animations ?? []).some((file) => file.definition.id === nextId)
  ) {
    return project;
  }
  const oldPath = action.path;
  const newPath = `actions/${nextId.replaceAll(".", "_")}.yaml`;
  if (
    (updated.actions ?? []).some(
      (file) => file !== action && file.path === newPath,
    )
  ) {
    return project;
  }
  action.definition.id = nextId;
  action.path = newPath;
  updated.manifest.actions = (updated.manifest.actions ?? []).map((path) =>
    path === oldPath ? newPath : path,
  );
  for (const scene of updated.scenes) {
    for (const node of Object.values(scene.definition.nodes)) {
      if (node.type === "action" && node.action === previousId) {
        node.action = nextId;
      }
    }
  }
  return updated;
}

function migratePreviewChoices(
  previews: Record<string, TimelinePreviewSettings>,
  migrate: (
    choice: TimelinePreviewSettings["choices"][number],
  ) => TimelinePreviewSettings["choices"][number],
): void {
  for (const settings of Object.values(previews)) {
    settings.choices = settings.choices.map(migrate);
  }
}

export function projectRequest(
  project: EditorProject,
  importTokens: string[] = [],
) {
  return {
    manifest: project.manifest,
    scenes: project.scenes,
    ui_motions: project.ui_motions,
    buttons: project.buttons ?? [],
    animations: project.animations ?? [],
    actions: project.actions ?? [],
    text_blocks: project.text_blocks ?? [],
    particles: project.particles ?? [],
    chapter_map: project.chapter_map ?? null,
    layout: project.layout,
    expected_fingerprint: project.fingerprint,
    import_tokens: importTokens,
  };
}

export function newSceneFile(
  id: string,
  windowRole: WindowRole = "main",
): EditorSceneFile {
  return {
    path: `scenes/${id}.yaml`,
    definition: {
      // `main` is the file default and stays implicit.
      ...(windowRole === "main" ? {} : { window_role: windowRole }),
      schema_version: 2,
      id,
      entry: "start",
      nodes: { start: { type: "end" } },
    },
  };
}

/**
 * Change which window a Scene is written for.  Existing references are not
 * rewritten (that would guess intent); the live diagnostics list every
 * `open_window` / `jump` / entry that no longer fits.
 */
export function setSceneWindowRole(
  project: EditorProject,
  sceneId: string,
  role: WindowRole,
): EditorProject {
  const file = findScene(project, sceneId);
  if (file === undefined || (file.definition.window_role ?? "main") === role)
    return project;
  const updated = cloneProject(project);
  const scene = findScene(updated, sceneId);
  if (scene === undefined) return project;
  if (role === "main") Reflect.deleteProperty(scene.definition, "window_role");
  else scene.definition.window_role = role;
  return updated;
}

export function ensureSceneLayout(layout: EditorLayout, sceneId: string) {
  layout.scenes[sceneId] ??= { nodes: {}, viewport: null };
  return layout.scenes[sceneId];
}

export function updateManifest(
  project: EditorProject,
  manifest: ContentManifest,
): EditorProject {
  return { ...project, manifest };
}
