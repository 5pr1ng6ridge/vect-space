/**
 * Author-facing description of a story node: an optional title line (the
 * speaker of a line of dialogue) and a one-line summary.  Graph cards, the
 * script view and search results all use this, so a node reads the same
 * everywhere and never shows raw YAML enum values.
 */
import {
  AMBIENCE_SLOT_LABELS,
  COMPARISON_LABELS,
  LOGIC_LABELS,
  MUTATION_LABELS,
  SPRITE_ACTION_LABELS,
} from "./labels";
import { summarizeScreenEffect, summarizeTransitionSpec } from "./story";
import { nonEmpty, WINDOW_ROLE_LABELS } from "./windowInteraction";
import { describeWindowGeometry, describeWindowLayer } from "./windowLayout";
import type {
  ConditionExpression,
  ContentManifest,
  MutationValue,
  ScalarValue,
  SceneNode,
} from "./types";

export interface NodeDescription {
  /** Emphasised first line, e.g. the speaker's display name. */
  title: string | null;
  summary: string;
}

interface DescribeContext {
  /** Only the character table is needed (for speaker display names). */
  manifest?: Pick<ContentManifest, "characters">;
  proofs?: import("./types").ProofFile[];
}

function scalar(value: ScalarValue): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string") return `“${value}”`;
  return String(value);
}

function mutationValue(value: MutationValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "object" && value !== null && "variable" in value)
    return value.variable;
  return scalar(value);
}

function describeCondition(condition: ConditionExpression): string {
  switch (condition.op) {
    case "eq":
    case "ne":
    case "lt":
    case "le":
    case "gt":
    case "ge": {
      const operand = (
        side: { variable: string } | { value: ScalarValue },
      ): string => ("variable" in side ? side.variable : scalar(side.value));
      return `${operand(condition.left)} ${COMPARISON_LABELS[condition.op]} ${operand(condition.right)}`;
    }
    case "and":
    case "or":
      return condition.conditions.length === 0
        ? LOGIC_LABELS[condition.op]
        : condition.conditions
            .map((child) => describeCondition(child))
            .join(condition.op === "and" ? " 且 " : " 或 ");
    case "not":
      return `并非（${describeCondition(condition.condition)}）`;
  }
}

/** Display name of a speaker id: character name, temporary name or 旁白. */
function speakerName(
  speaker: string | null,
  manifest: Pick<ContentManifest, "characters"> | undefined,
): string {
  if (speaker === null) return "旁白";
  return manifest?.characters[speaker]?.display_name ?? speaker;
}

export function describeNode(
  node: SceneNode,
  context: DescribeContext = {},
): NodeDescription {
  const plain = (summary: string): NodeDescription => ({
    title: null,
    summary,
  });
  switch (node.type) {
    case "say":
      return {
        title: speakerName(node.speaker, context.manifest),
        summary: node.text.trim() === "" ? "（空台词）" : node.text,
      };
    case "long_text":
      return plain(
        `${node.mode === "continue" ? "接续" : "新文稿"} · ${node.steps.length} 段${node.document ? ` · ${node.document}` : ""}`,
      );
    case "long_text_control":
      return plain(
        `${node.action === "show" ? "显示" : node.action === "hide" ? "隐藏" : "关闭"}文稿 ${node.document}`,
      );
    case "proof":
      return plain(
        context.proofs
          ?.flatMap((file) => file.definition.puzzles ?? [])
          .find((puzzle) => puzzle.id === node.puzzle)?.title ??
          (node.puzzle || "（未选择证明题）"),
      );
    case "choice":
      return plain(
        node.choices.length === 0
          ? "尚无选项"
          : node.choices.map((choice) => choice.label || choice.id).join(" / "),
      );
    case "set":
      return plain(
        node.op === "toggle"
          ? `切换 ${node.variable}`
          : `${node.variable} ${MUTATION_LABELS[node.op ?? "assign"]} ${mutationValue(node.value)}`.trim(),
      );
    case "condition":
      return plain(`如果 ${describeCondition(node.condition)}`);
    case "playback":
      return plain(
        `${node.auto === "forced" ? "强制自动播放" : "允许自动播放"} · ${node.ctrl_fast_forward === "block" ? "禁止快进" : "允许快进"}`,
      );
    case "action":
      return plain(
        `${node.sprite_id || "（未指定立绘）"} · ${node.action || "（未选择动作）"}`,
      );
    case "jump":
      return plain(
        node.scene === null
          ? `跳到 ${node.target}`
          : `跳到场景 ${node.scene} · ${node.target}`,
      );
    case "open_window":
      return plain(`打开副窗口 · ${node.scene}`);
    case "window_title":
      return plain(
        `${WINDOW_ROLE_LABELS[node.target]}标题 → ${node.title === "" ? "（空）" : node.title}`,
      );
    case "window_control":
      return plain(
        node.action === "advance"
          ? `推进${WINDOW_ROLE_LABELS[node.target]}一页`
          : `${node.action === "block" ? "阻挡" : "解除"}${WINDOW_ROLE_LABELS[node.target]}翻页 · ${nonEmpty(node.id, "（未命名）")}`,
      );
    case "window_geometry":
      return plain(describeWindowGeometry(node));
    case "window_layer":
      return plain(describeWindowLayer(node));
    case "timer":
      if (node.action === "stop") return plain(`停止计时器 ${node.id}`);
      return plain(
        `启动 ${node.id}：${node.delay_ms ?? 0} ms 后${node.interval_ms == null ? "触发一次" : `，每 ${node.interval_ms} ms 重复`} → ${nonEmpty(node.target, "（未选效果）")}`,
      );
    case "background":
      return plain(
        node.background === null
          ? `清除背景 · ${summarizeTransitionSpec(node.transition)}`
          : `${node.background} · ${summarizeTransitionSpec(node.transition)}`,
      );
    case "curtain": {
      const fill =
        node.fill == null
          ? ""
          : "color" in node.fill
            ? ` · ${node.fill.color}`
            : ` · ${node.fill.asset}`;
      return plain(
        `${node.action === "cover" ? "落下幕布" : "收起幕布"}${fill} · ${summarizeTransitionSpec(node.transition)}`,
      );
    }
    case "sprite":
      return plain(
        `${SPRITE_ACTION_LABELS[node.action]} ${node.sprite_id}${node.asset ? ` · ${node.asset}` : ""}`,
      );
    case "particle":
      return plain(
        `${node.action === "start" ? "持续发射" : node.action === "stop" ? "清除发射器" : "单次爆发"} ${node.emitter_id}${node.particle ? ` · ${node.particle}` : ""}`,
      );
    case "clear":
      return plain(`清除画面 · ${node.duration_ms} ms`);
    case "wait":
      return plain(`等待 ${node.duration_ms} ms`);
    case "bgm":
      return plain(
        node.action === "stop"
          ? "停止背景音乐"
          : `播放 ${node.asset ?? "（未选择）"}`,
      );
    case "ambience":
      return plain(
        `${AMBIENCE_SLOT_LABELS[node.slot]} · ${node.action === "stop" ? "停止" : `播放 ${node.asset ?? "（未选择）"}`}`,
      );
    case "sfx":
      return plain(node.asset ? `播放 ${node.asset}` : "（未选择音效）");
    case "camera":
      return plain(`移动到 (${node.x}, ${node.y}) · 缩放 ×${node.zoom}`);
    case "screen_effect":
      return plain(summarizeScreenEffect(node.effect));
    case "dialogue_ui":
      return plain(
        `${node.visible ? "显示" : "隐藏"}对话框${node.motion ? ` · ${node.motion}` : ""}`,
      );
    case "ui_motion_set":
      return plain(
        `${node.slot === "dialogue_show" ? "对话框出现" : "对话框收起"} → ${node.motion ?? "无动效"}`,
      );
    case "ui_motion_play":
      return plain(node.motion ? `播放 ${node.motion}` : "（未选择动效）");
    case "button_create":
      return plain(`创建按钮 ${node.instance_id} · ${node.template}`);
    case "button_update":
      return plain(`更新按钮 ${node.instance_id}`);
    case "button_remove":
      return plain(`移除按钮 ${node.instance_id}`);
    case "timeline":
      return plain(
        `${(node.duration_ms / 1000).toFixed(node.duration_ms % 1000 === 0 ? 0 : 1)} 秒 · ${node.tracks.length} 条轨道 · ${node.events.length} 个事件`,
      );
    case "end":
      return plain("剧情在此结束");
  }
}
