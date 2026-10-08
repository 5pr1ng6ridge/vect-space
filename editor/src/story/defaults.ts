import type {
  ConditionExpression,
  NodeType,
  SceneDefinition,
  SceneNode,
} from "../types";
import {
  defaultBackgroundTransition,
  defaultCurtainFill,
  defaultCurtainTransition,
  defaultFlashEffect,
} from "../presentationDefaults";
import { DEFAULT_WINDOW_MOVE_MS, defaultPlacementFor } from "../windowLayout";
import { emitterInstanceIds, uniqueEmitterId } from "./paste";

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

export function nodeLabel(type: NodeType): string {
  return NODE_TYPES.find((candidate) => candidate.type === type)?.label ?? type;
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

export function defaultCondition(variable = "flag"): ConditionExpression {
  return {
    op: "eq",
    left: { variable },
    right: { value: true },
  };
}
