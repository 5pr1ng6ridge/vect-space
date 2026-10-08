import { validateSpriteAuthoring } from "../visualValidation";
import { validateEmitter } from "@vectspace/presentation-core/particles";
import {
  isWindowVariable,
  MAX_TIMER_DURATION_MS,
  MIN_TIMER_INTERVAL_MS,
  sceneRole,
  timerTargetProblem,
  WINDOW_ROLE_LABELS,
  windowTitleProblem,
} from "../windowInteraction";
import { WINDOW_LAYER_ACTIONS, windowGeometryProblem } from "../windowLayout";
import {
  CHOICE_STAGE_HEIGHT,
  CHOICE_STAGE_WIDTH,
} from "@vectspace/presentation-core/choice-layout";
import type {
  AssetKind,
  ChoiceNode,
  EditorDiagnostic,
  EditorProject,
  SceneNode,
  LongTextNode,
} from "../types";
import {
  AMBIENCE_SLOTS,
  ID_PATTERN,
  type IssueSink,
  error,
  validateColorValue,
  validateDisplayName,
} from "./shared";
import { validateBackgroundTransition, validateScreenEffect } from "./effects";
import {
  validateCondition,
  validateMutation,
  validateTextTemplate,
} from "./expressions";
import { validateButtonAction, validateButtonLayout } from "./buttons";
import { validateTimelineNode } from "./timeline";

/** A choice option or node template must reference a declared button file. */
function checkChoiceTemplate(
  project: EditorProject,
  templateId: string,
  label: string,
  issue: IssueSink,
): void {
  const known = (project.buttons ?? []).some(
    (file) => file.definition.id === templateId,
  );
  if (!known) {
    issue(
      "unknown_choice_template",
      `${label} 引用了未知按钮模板：${templateId}`,
    );
  }
}

function checkChoiceIcon(
  project: EditorProject,
  iconId: string,
  label: string,
  issue: IssueSink,
): void {
  const asset = project.manifest.assets[iconId];
  if (asset === undefined) {
    issue("missing_choice_icon", `${label} 的图标素材未登记：${iconId}`);
    return;
  }
  if (asset.kind !== "gui") {
    issue(
      "invalid_choice_icon_kind",
      `${label} 的图标必须是 gui 素材：${iconId}`,
    );
  }
}

/**
 * Live diagnostics for an opted-in choice presentation.
 *
 * The runtime never locks on an invalid value: it falls back to a documented
 * default and reports a `ChoiceDiagnostic`.  The editor mirrors those rules so
 * the author sees the same problem while typing, before a preview is built.
 */
function validateChoicePresentation(
  project: EditorProject,
  node: ChoiceNode,
  issue: IssueSink,
): void {
  const presentation = node.presentation;
  if (presentation === null || presentation === undefined) return;
  if (presentation.template != null && presentation.template !== "") {
    checkChoiceTemplate(project, presentation.template, "选择节点", issue);
  }
  if (
    !Number.isFinite(presentation.anchor_x) ||
    presentation.anchor_x < 0 ||
    presentation.anchor_x > CHOICE_STAGE_WIDTH
  ) {
    issue(
      "invalid_choice_anchor",
      `anchor_x 必须是 0–${CHOICE_STAGE_WIDTH} 之间的设计像素`,
    );
  }
  if (
    !Number.isFinite(presentation.anchor_y) ||
    presentation.anchor_y < 0 ||
    presentation.anchor_y > CHOICE_STAGE_HEIGHT
  ) {
    issue(
      "invalid_choice_anchor",
      `anchor_y 必须是 0–${CHOICE_STAGE_HEIGHT} 之间的设计像素`,
    );
  }
  if (
    presentation.direction !== "vertical" &&
    presentation.direction !== "horizontal"
  ) {
    issue("invalid_choice_direction", "方向必须是 vertical 或 horizontal");
  }
  if (!Number.isFinite(presentation.gap) || presentation.gap < 0) {
    issue("invalid_choice_gap", "选项间距必须是非负数");
  }
  for (const [side, value] of [
    ["width", presentation.button_width],
    ["height", presentation.button_height],
  ] as const) {
    if (value != null && (!Number.isFinite(value) || value <= 0)) {
      issue("invalid_choice_size", `button_${side} 必须是正数`);
    }
  }
}

export function validateNode(
  project: EditorProject,
  sceneId: string,
  nodeId: string,
  node: SceneNode,
  output: EditorDiagnostic[],
): void {
  const scene = project.scenes.find(
    (candidate) => candidate.definition.id === sceneId,
  );
  const issue = (code: string, message: string) =>
    output.push(error(code, message, sceneId, nodeId));
  const checkDuration = (duration: number) => {
    if (!Number.isInteger(duration) || duration < 0 || duration > 60_000) {
      issue("invalid_duration", "时长必须在 0–60000 ms 之间");
    }
  };
  const checkTimestamp = (timestamp: number, label: string) => {
    if (!Number.isInteger(timestamp) || timestamp < 0) {
      issue("invalid_timestamp", `${label} 必须是非负整数毫秒数`);
    }
  };
  const checkVolume = (volume: number) => {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      issue("invalid_volume", "音量必须在 0–1 之间");
    }
  };
  const checkAsset = (
    id: string | null | undefined,
    kind: AssetKind,
    required: boolean,
  ) => {
    if (id == null || id === "") {
      if (required) issue("missing_asset", `必须选择 ${kind} 素材`);
      return;
    }
    const asset = project.manifest.assets[id];
    if (asset === undefined) {
      issue("unknown_asset", `素材未登记：${id}`);
    } else if (asset.kind !== kind) {
      issue("wrong_asset_kind", `素材 ${id} 的类型应为 ${kind}`);
    }
  };

  const check: NodeCheck = {
    project,
    sceneId,
    issue,
    checkDuration,
    checkTimestamp,
    checkVolume,
    checkAsset,
  };

  switch (node.type) {
    case "background":
      checkAsset(node.background, "background", false);
      checkDuration(node.duration_ms);
      validateBackgroundTransition(node.transition, issue);
      break;
    case "curtain":
      if (node.action === "cover") {
        if (node.fill == null) {
          issue("missing_curtain_fill", "cover 幕布必须填写颜色或 gui 素材");
        } else if ("asset" in node.fill) {
          checkAsset(node.fill.asset, "gui", true);
        } else {
          validateColorValue(node.fill.color, "幕布颜色", issue);
        }
      } else if (node.fill != null) {
        issue("invalid_curtain_fill", "reveal 幕布不能指定 fill");
      }
      checkDuration(node.duration_ms);
      break;
    case "sprite":
      if (!ID_PATTERN.test(node.sprite_id))
        issue("invalid_sprite_id", "Sprite 实例 ID 非法");
      validateSpriteAuthoring(project, node, issue);
      checkAsset(
        node.asset,
        "sprite",
        node.action === "show" &&
          node.character == null &&
          node.source === undefined,
      );
      if (node.character != null) {
        const character = project.manifest.characters[node.character];
        if (character === undefined) {
          issue("unknown_character", `角色未登记：${node.character}`);
        } else if (
          node.expression != null &&
          (character.expressions ?? {})[node.expression] === undefined
        ) {
          issue(
            "unknown_character_expression",
            `角色 ${node.character} 未定义表情：${node.expression}`,
          );
        } else if (
          node.expression == null &&
          node.asset == null &&
          character.default_expression == null &&
          node.action !== "hide"
        ) {
          issue("missing_character_expression", "角色没有可用表情或素材");
        }
      } else if (node.expression != null) {
        issue("expression_without_character", "表情必须与角色一起使用");
      }
      if (
        node.crossfade_ms != null &&
        (!Number.isInteger(node.crossfade_ms) ||
          node.crossfade_ms < 0 ||
          node.crossfade_ms > 60_000)
      ) {
        issue("invalid_crossfade", "交叉淡化时长必须在 0–60000 ms 之间");
      }
      checkDuration(node.duration_ms);
      if (
        (node.x !== null && !Number.isFinite(node.x)) ||
        (node.y !== null && !Number.isFinite(node.y))
      ) {
        issue("invalid_sprite_position", "立绘坐标必须是有限数");
      }
      if (
        node.scale !== null &&
        (!Number.isFinite(node.scale) || node.scale <= 0)
      ) {
        issue("invalid_scale", "缩放必须是正数");
      }
      if (
        node.opacity !== null &&
        (!Number.isFinite(node.opacity) || node.opacity < 0 || node.opacity > 1)
      ) {
        issue("invalid_opacity", "透明度必须在 0–1 之间");
      }
      break;
    case "particle":
      if (!ID_PATTERN.test(node.emitter_id))
        issue("invalid_emitter_id", "发射器实例 ID 非法");
      if (
        node.action !== "stop" &&
        !(project.particles ?? []).some(
          (file) => file.definition.id === node.particle,
        )
      )
        issue(
          "unknown_particle_definition",
          "start / burst 必须引用有效粒子定义",
        );
      try {
        validateEmitter({
          ...node,
          particle: node.particle ?? "",
          seed: node.seed ?? 0,
          generation: 0,
        });
        if (!Number.isInteger(node.z)) throw new Error("层级 Z 必须是整数");
      } catch (reason) {
        issue(
          "invalid_emitter_transform",
          reason instanceof Error ? reason.message : String(reason),
        );
      }
      break;
    case "clear":
      checkDuration(node.duration_ms);
      break;
    case "say":
      if (node.text.trim() === "") issue("empty_dialogue", "对话文本不能为空");
      if (node.page_id != null && !ID_PATTERN.test(node.page_id)) {
        issue("invalid_dialogue_page", "对话页 ID 非法");
      }
      if (node.mode === "append" && !node.page_id) {
        issue("missing_dialogue_page", "接续对话必须指定对话页 ID");
      }
      if (
        node.speaker !== null &&
        project.manifest.characters[node.speaker] === undefined
      ) {
        validateDisplayName(node.speaker).forEach((message) =>
          issue("invalid_temporary_speaker", message),
        );
      }
      validateTextTemplate(project, node.text, issue);
      if (
        node.speed_cps !== null &&
        (!Number.isFinite(node.speed_cps) || node.speed_cps <= 0)
      ) {
        issue("invalid_speed", "文字速度必须是正数");
      }
      break;
    case "long_text":
      validateLongTextNode(node, check);
      break;
    case "long_text_control":
      if (!ID_PATTERN.test(node.document))
        issue("invalid_long_text_document", "文稿 ID 非法");
      if (
        node.action !== "show" &&
        node.action !== "hide" &&
        node.action !== "close"
      )
        issue("invalid_long_text_action", "文稿控制操作无效");
      break;
    case "choice": {
      if (node.choices.length === 0) issue("empty_choice", "至少需要一个选项");
      const ids = new Set<string>();
      for (const choice of node.choices) {
        if (!ID_PATTERN.test(choice.id))
          issue("invalid_choice_id", `非法选项 ID：${choice.id}`);
        if (ids.has(choice.id))
          issue("duplicate_choice_id", `选项 ID 重复：${choice.id}`);
        if (choice.label.trim() === "")
          issue("empty_choice_label", "选项文本不能为空");
        validateTextTemplate(project, choice.label, issue);
        if (choice.visible_if !== undefined)
          validateCondition(project, choice.visible_if, issue);
        if (choice.enabled_if !== undefined)
          validateCondition(project, choice.enabled_if, issue);
        if (choice.template != null && choice.template !== "") {
          checkChoiceTemplate(
            project,
            choice.template,
            `选项 ${choice.id}`,
            issue,
          );
        }
        if (choice.icon != null && choice.icon !== "") {
          checkChoiceIcon(project, choice.icon, `选项 ${choice.id}`, issue);
        }
        ids.add(choice.id);
      }
      validateChoicePresentation(project, node, issue);
      break;
    }
    case "set":
      if (!ID_PATTERN.test(node.variable))
        issue("invalid_variable", "变量名非法");
      if (isWindowVariable(node.variable)) {
        issue(
          "readonly_window_variable",
          `${node.variable} 是只读的窗口标题变量，不能用「设置变量」修改；请使用「设置窗口标题」节点`,
        );
      } else if (project.manifest.variables[node.variable] === undefined) {
        issue("unknown_variable", `变量未声明：${node.variable}`);
      } else validateMutation(project, node, issue);
      break;
    case "condition":
      validateCondition(project, node.condition, issue);
      break;
    case "playback":
      break;
    case "action": {
      if (!ID_PATTERN.test(node.sprite_id))
        issue("invalid_action_sprite", "动作目标立绘实例 ID 非法");
      if (
        !scene ||
        !Object.values(scene.definition.nodes).some(
          (candidate) =>
            candidate.type === "sprite" &&
            candidate.sprite_id === node.sprite_id,
        )
      ) {
        issue(
          "unknown_action_sprite",
          `动作引用了未声明的立绘实例：${node.sprite_id}`,
        );
      }
      const actionDefinition = project.actions?.find(
        (file) => file.definition.id === node.action,
      )?.definition;
      if (actionDefinition === undefined)
        issue("unknown_action", `未知立绘动作：${node.action}`);
      if (node.duration_ms != null) checkDuration(node.duration_ms);
      if (node.parameters != null) {
        for (const [parameter, value] of Object.entries(node.parameters)) {
          const definition = actionDefinition?.parameters?.[parameter];
          if (definition === undefined) {
            issue("unknown_action_parameter", `动作参数未声明：${parameter}`);
          } else if (
            !Number.isFinite(value) ||
            (definition.min != null && value < definition.min) ||
            (definition.max != null && value > definition.max)
          ) {
            issue(
              "invalid_action_parameter",
              `动作参数 ${parameter} 超出声明范围`,
            );
          }
        }
      }
      break;
    }
    case "wait":
      checkDuration(node.duration_ms);
      break;
    case "bgm":
      checkAsset(node.asset, "bgm", node.action === "start");
      checkVolume(node.volume);
      checkDuration(node.duration_ms);
      checkTimestamp(node.start_ms ?? 0, "BGM 起始点");
      if ((node.loop_start_ms == null) !== (node.loop_end_ms == null)) {
        issue("invalid_bgm_loop", "BGM 循环起止点必须同时提供");
      } else if (node.loop_start_ms != null && node.loop_end_ms != null) {
        checkTimestamp(node.loop_start_ms, "BGM 循环起点");
        checkTimestamp(node.loop_end_ms, "BGM 循环终点");
        if (
          node.loop_start_ms >= node.loop_end_ms ||
          (node.start_ms ?? 0) > node.loop_end_ms
        ) {
          issue("invalid_bgm_loop", "BGM 循环点顺序无效");
        }
      }
      break;
    case "ambience":
      if (!AMBIENCE_SLOTS.includes(node.slot))
        issue("invalid_ambience_slot", "环境声槽位必须是 slot_1 到 slot_4");
      checkAsset(node.asset, "ambience", node.action === "start");
      if (node.action === "stop" && node.asset != null) {
        issue("invalid_ambience_stop_asset", "ambience stop 不能提供 asset");
      }
      checkVolume(node.volume);
      checkDuration(node.duration_ms);
      checkTimestamp(node.start_ms ?? 0, "ambience 起始点");
      if ((node.loop_start_ms == null) !== (node.loop_end_ms == null)) {
        issue("invalid_ambience_loop", "ambience 循环起止点必须同时提供");
      } else if (node.loop_start_ms != null && node.loop_end_ms != null) {
        checkTimestamp(node.loop_start_ms, "ambience 循环起点");
        checkTimestamp(node.loop_end_ms, "ambience 循环终点");
        if (
          node.loop_start_ms >= node.loop_end_ms ||
          (node.start_ms ?? 0) > node.loop_end_ms
        ) {
          issue("invalid_ambience_loop", "ambience 循环点顺序无效");
        }
      }
      break;
    case "sfx":
      checkAsset(node.asset, "sfx", true);
      checkVolume(node.volume);
      break;
    case "camera":
      checkDuration(node.duration_ms);
      if (
        ![node.x, node.y, node.zoom].every(Number.isFinite) ||
        node.zoom <= 0
      ) {
        issue("invalid_camera", "镜头坐标必须有限，缩放必须为正数");
      }
      break;
    case "screen_effect":
      checkDuration(node.duration_ms);
      validateScreenEffect(node.effect, issue);
      break;
    case "dialogue_ui":
      if (node.duration_ms !== null) checkDuration(node.duration_ms);
      if (
        node.motion !== null &&
        !project.ui_motions.some((file) => file.definition.id === node.motion)
      )
        issue("unknown_ui_motion", `未知 UI 动效：${node.motion}`);
      break;
    case "ui_motion_set":
      if (
        node.motion !== null &&
        !project.ui_motions.some((file) => file.definition.id === node.motion)
      )
        issue("unknown_ui_motion", `未知 UI 动效：${node.motion}`);
      break;
    case "ui_motion_play":
      if (
        !project.ui_motions.some((file) => file.definition.id === node.motion)
      )
        issue("unknown_ui_motion", `未知 UI 动效：${node.motion}`);
      if (node.duration_ms !== null) checkDuration(node.duration_ms);
      break;
    case "button_create":
      if (!ID_PATTERN.test(node.instance_id))
        issue("invalid_button_instance", "按钮实例 ID 非法");
      if (
        !project.buttons?.some((file) => file.definition.id === node.template)
      )
        issue("unknown_button_template", `未知按钮模板：${node.template}`);
      validateButtonLayout(node, issue);
      validateButtonAction(project, node.action, sceneId, issue);
      break;
    case "button_update":
      if (!ID_PATTERN.test(node.instance_id))
        issue("invalid_button_instance", "按钮实例 ID 非法");
      if (
        node.template != null &&
        !project.buttons?.some((file) => file.definition.id === node.template)
      )
        issue("unknown_button_template", `未知按钮模板：${node.template}`);
      validateButtonLayout(node, issue);
      if (node.action != null)
        validateButtonAction(project, node.action, sceneId, issue);
      break;
    case "button_remove":
      if (!ID_PATTERN.test(node.instance_id))
        issue("invalid_button_instance", "按钮实例 ID 非法");
      break;
    case "timeline":
      validateTimelineNode(node, check);
      break;
    case "end":
      break;
    case "jump": {
      // A Scene belongs to one window: a jump never changes which window the
      // story is written for.
      const destination =
        node.scene === null
          ? undefined
          : project.scenes.find(
              (candidate) => candidate.definition.id === node.scene,
            );
      if (
        destination !== undefined &&
        scene !== undefined &&
        sceneRole(destination.definition) !== sceneRole(scene.definition)
      ) {
        issue(
          "window_role_mismatch",
          `不能从${WINDOW_ROLE_LABELS[sceneRole(scene.definition)]}专用 Scene 跳转到${WINDOW_ROLE_LABELS[sceneRole(destination.definition)]}专用 Scene ${node.scene}；跳转只能在相同用途的 Scene 之间进行`,
        );
      }
      break;
    }
    case "open_window": {
      // Non-blocking: the story continues to `next` in this Scene. The named
      // window Scene is resolved across scenes and must exist.
      const destination = project.scenes.find(
        (candidate) => candidate.definition.id === node.scene,
      );
      if (node.scene.length === 0) {
        issue("missing_window_scene", "副窗口必须指定目标场景");
      } else if (destination === undefined) {
        issue("unknown_window_scene", `副窗口指向未声明的场景 ${node.scene}`);
      } else if (sceneRole(destination.definition) !== "secondary") {
        issue(
          "window_scene_not_secondary",
          `场景 ${node.scene} 不是副窗口专用 Scene；请在场景列表中把它的用途设置为「副窗口」`,
        );
      }
      if (scene !== undefined && sceneRole(scene.definition) !== "main") {
        issue(
          "secondary_opens_window",
          "只有主窗口 Scene 可以打开副窗口；副窗口 Scene 不能再打开窗口",
        );
      }
      if (
        scene === undefined ||
        scene.definition.nodes[node.next] === undefined
      ) {
        issue("missing_next_node", "open_window 的 next 节点不存在");
      }
      break;
    }
    case "window_title": {
      const problem = windowTitleProblem(node.title);
      if (problem !== null) issue("invalid_window_title", problem);
      validateTextTemplate(project, node.title, issue);
      break;
    }
    case "window_control": {
      if (node.target !== "main" && node.target !== "secondary") {
        issue("invalid_window_target", "目标窗口必须是主窗口或副窗口");
      }
      if (node.action !== "advance" && !ID_PATTERN.test(node.id ?? "")) {
        issue(
          "invalid_block_id",
          "阻挡 ID 不能为空，且只能使用字母、数字、点、下划线和连字符",
        );
      }
      const message = node.message ?? "";
      const problem = windowTitleProblem(message);
      if (problem !== null)
        issue("invalid_block_message", problem.replace("窗口标题", "阻挡提示"));
      validateTextTemplate(project, message, issue);
      break;
    }
    case "window_geometry": {
      if (node.target !== "main" && node.target !== "secondary") {
        issue("invalid_window_target", "目标窗口必须是主窗口或副窗口");
      }
      const problem = windowGeometryProblem(node);
      if (problem !== null) issue("invalid_window_geometry", problem);
      checkDuration(node.duration_ms);
      break;
    }
    case "window_layer": {
      if (node.target !== "main" && node.target !== "secondary") {
        issue("invalid_window_target", "目标窗口必须是主窗口或副窗口");
      }
      if (!WINDOW_LAYER_ACTIONS.includes(node.action)) {
        issue(
          "invalid_window_layer_action",
          "窗口层级操作必须是提到最前、聚焦、置顶、置底或恢复普通",
        );
      }
      break;
    }
    case "timer": {
      if (!ID_PATTERN.test(node.id)) {
        issue(
          "invalid_timer_id",
          "计时器 ID 非法（字母、数字、点、下划线、连字符）",
        );
      }
      if (node.action !== "start" && node.action !== "stop") {
        issue("invalid_timer_action", "计时器操作必须是启动或停止");
      }
      if (node.action === "start") {
        const delay = node.delay_ms ?? 0;
        if (
          !Number.isInteger(delay) ||
          delay < 0 ||
          delay > MAX_TIMER_DURATION_MS
        ) {
          issue(
            "invalid_timer_delay",
            `计时器延迟必须在 0–${MAX_TIMER_DURATION_MS} ms 之间`,
          );
        }
        if (node.interval_ms != null) {
          if (
            !Number.isInteger(node.interval_ms) ||
            node.interval_ms < MIN_TIMER_INTERVAL_MS ||
            node.interval_ms > MAX_TIMER_DURATION_MS
          ) {
            issue(
              "invalid_timer_interval",
              `重复间隔必须在 ${MIN_TIMER_INTERVAL_MS}–${MAX_TIMER_DURATION_MS} ms 之间`,
            );
          }
        }
        if (node.target == null || node.target === "") {
          issue("missing_timer_target", "启动计时器必须选择一个效果节点");
        } else {
          const problem = timerTargetProblem(
            scene?.definition.nodes[node.target],
          );
          if (problem !== null) {
            issue(
              "invalid_timer_target",
              `计时器目标 ${node.target} 无效：${problem}`,
            );
          }
        }
      }
      break;
    }
  }
}

/** Closures shared by the per-node validators; each reports against one node. */
export interface NodeCheck {
  project: EditorProject;
  sceneId: string;
  issue: IssueSink;
  checkDuration(duration: number): void;
  checkTimestamp(timestamp: number, label: string): void;
  checkVolume(volume: number): void;
  checkAsset(
    id: string | null | undefined,
    kind: AssetKind,
    required: boolean,
  ): void;
}

function validateLongTextNode(
  node: LongTextNode,
  { project, issue, checkAsset }: NodeCheck,
): void {
  if (node.document !== undefined && node.document !== null) {
    if (!ID_PATTERN.test(node.document))
      issue("invalid_long_text_document", "文稿 ID 非法");
  }
  if (
    node.mode !== undefined &&
    node.mode !== "start" &&
    node.mode !== "continue"
  ) {
    issue("invalid_long_text_mode", "长文本模式无效");
  }
  if (node.mode === "continue" && !node.document) {
    issue("missing_long_text_document", "接续长文本必须指定文稿 ID");
  }
  if (
    node.mode === "continue" &&
    (node.paper != null ||
      node.pagination !== undefined ||
      node.font_size !== undefined ||
      node.text_color !== undefined ||
      node.layout !== undefined)
  ) {
    issue(
      "long_text_inherited_style",
      "接续长文本不能重复定义纸张、分页、字号、颜色或布局",
    );
  }
  if (
    node.on_exit !== undefined &&
    node.on_exit !== "close" &&
    node.on_exit !== "hide" &&
    node.on_exit !== "keep_visible"
  ) {
    issue("invalid_long_text_exit", "长文本离开行为无效");
  }
  checkAsset(node.paper ?? null, "gui", false);
  if (
    node.pagination !== undefined &&
    node.pagination !== "continuous" &&
    node.pagination !== "auto" &&
    node.pagination !== "manual"
  ) {
    issue("invalid_long_text_pagination", "长文本分页方式无效");
  }
  if (
    node.font_size !== undefined &&
    (!Number.isFinite(node.font_size) ||
      node.font_size < 16 ||
      node.font_size > 72)
  ) {
    issue("invalid_long_text_font_size", "长文本字号必须在 16 到 72 之间");
  }
  if (
    node.text_color !== undefined &&
    !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(node.text_color)
  ) {
    issue("invalid_long_text_color", "长文本颜色必须是 #RRGGBB 或 #RRGGBBAA");
  }
  if (node.layout !== undefined) {
    const layout = node.layout;
    const values = Object.values(layout);
    if (
      values.some((value) => !Number.isFinite(value)) ||
      layout.x < 0 ||
      layout.y < 0 ||
      layout.width < 160 ||
      layout.height < 240 ||
      layout.x + layout.width > 1920 ||
      layout.y + layout.height > 1080 ||
      layout.padding_x < 0 ||
      layout.padding_y < 0 ||
      layout.width <= layout.padding_x * 2 + 80 ||
      layout.height <= layout.padding_y * 2 + 80 ||
      layout.page_height <= layout.padding_y * 2 + 80 ||
      layout.page_gap < 0
    ) {
      issue("invalid_long_text_layout", "长文本位置、边距或页尺寸无效");
    }
  }
  if (node.steps.length === 0 || node.steps.length > 1024) {
    issue("invalid_long_text_steps", "长文本必须包含 1 到 1024 个步骤");
  }
  const ids = new Set<string>();
  for (const [index, step] of node.steps.entries()) {
    if (!ID_PATTERN.test(step.id)) {
      issue("invalid_long_text_step", `第 ${index + 1} 段的 ID 非法`);
    }
    if (ids.has(step.id)) {
      issue("duplicate_long_text_step", `步骤 ID 重复：${step.id}`);
    }
    if (step.text.trim() === "") {
      issue("empty_long_text_step", `第 ${index + 1} 段不能为空`);
    }
    if (
      (node.mode ?? "start") === "start" &&
      index === 0 &&
      step.page_break_before
    ) {
      issue("leading_long_text_break", "第一段不应在前方强制分页");
    }
    if (node.pagination === "continuous" && step.page_break_before) {
      issue("continuous_long_text_break", "连续长卷不能使用强制分页");
    }
    validateTextTemplate(project, step.text, issue);
    ids.add(step.id);
  }
  if (
    node.speed_cps !== null &&
    (!Number.isFinite(node.speed_cps) || node.speed_cps <= 0)
  ) {
    issue("invalid_long_text_speed", "文字速度必须是正数");
  }
}
