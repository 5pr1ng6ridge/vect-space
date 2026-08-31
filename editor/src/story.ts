import type {
  ConditionExpression,
  ContentManifest,
  EditorLayout,
  EditorProject,
  EditorSceneFile,
  NodeType,
  NodePosition,
  ScalarValue,
  SceneDefinition,
  SceneNode,
  TimelineChannels,
  TimelineNode,
  TimelinePreviewSettings,
} from "./types";
import {
  countTemplateVariable,
  removeUnknownTemplateVariables,
  renameTemplateVariable,
} from "./textTemplate";

export const NODE_TYPES: { type: NodeType; label: string; group: string }[] = [
  { type: "say", label: "对话", group: "叙事" },
  { type: "choice", label: "选择", group: "逻辑" },
  { type: "condition", label: "条件分支", group: "逻辑" },
  { type: "playback", label: "播放控制", group: "流程" },
  { type: "set", label: "设置变量", group: "逻辑" },
  { type: "jump", label: "跳转", group: "逻辑" },
  { type: "background", label: "背景", group: "画面" },
  { type: "sprite", label: "立绘", group: "画面" },
  { type: "clear", label: "清除画面", group: "画面" },
  { type: "camera", label: "镜头", group: "画面" },
  { type: "screen_effect", label: "屏幕效果", group: "画面" },
  { type: "timeline", label: "关键帧时间线", group: "画面" },
  { type: "dialogue_ui", label: "对话框", group: "画面" },
  { type: "ui_motion_set", label: "设置 UI 动效", group: "画面" },
  { type: "ui_motion_play", label: "播放 UI 动效", group: "画面" },
  { type: "bgm", label: "BGM", group: "声音" },
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

export function summarizeNode(node: SceneNode): string {
  switch (node.type) {
    case "say":
      return `${node.mode === "append" ? "接续 · " : ""}${node.speaker ?? "旁白"}：${node.text}`;
    case "choice":
      return `${node.choices.length} 个选项`;
    case "set":
      return `${node.variable} ${node.op ?? "assign"} ${summarizeMutationValue(node.value)}`;
    case "condition":
      return summarizeCondition(node.condition);
    case "playback":
      return `${node.auto === "forced" ? "强制自动" : "普通自动"} · Ctrl ${node.ctrl_fast_forward === "block" ? "禁止" : "允许"}`;
    case "jump":
      return `${node.scene ?? "本场景"} / ${node.target}`;
    case "background":
      return node.background ?? "清除背景";
    case "sprite":
      return `${node.action} ${node.sprite_id}`;
    case "clear":
      return `淡出全部内容 · ${node.duration_ms} ms`;
    case "wait":
      return `${node.duration_ms} ms`;
    case "bgm":
      return `${node.action} ${node.asset ?? ""}`.trim();
    case "sfx":
      return node.asset;
    case "camera":
      return `(${node.x}, ${node.y}) ×${node.zoom}`;
    case "screen_effect":
      return node.effect;
    case "dialogue_ui":
      return `${node.visible ? "显示" : "隐藏"} · ${node.motion ?? "默认动效"}`;
    case "ui_motion_set":
      return `${node.slot} = ${node.motion ?? "关闭"}`;
    case "ui_motion_play":
      return node.motion || "未选择动效";
    case "timeline":
      return `${node.duration_ms} ms · ${node.tracks.length} 轨 · ${node.events.length} 事件`;
    case "end":
      return "剧情终点";
  }
}

export function defaultNode(type: NodeType, fallback: string): SceneNode {
  switch (type) {
    case "background":
      return {
        type,
        background: null,
        transition: "cross_fade",
        duration_ms: 500,
        easing: "ease_in_out",
        await: false,
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
        effect: "flash",
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
 * Expand one compact presentation node into an editable Timeline node. Move,
 * hide and camera channels explicitly inherit the runtime value at 0ms, so
 * conversion is independent of the route used to reach the node.
 */
export function convertToTimeline(node: SceneNode): TimelineNode {
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
    let channels: TimelineChannels;
    if (node.action === "show") {
      if (node.asset === null) throw new Error("显示立绘缺少素材，无法转换。");
      const target = {
        x: node.x ?? 960,
        y: node.y ?? 1080,
        scale: node.scale ?? 1,
        scale_x: 1,
        scale_y: 1,
        rotation_deg: 0,
        opacity: node.opacity ?? 1,
        z: node.z ?? 0,
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
            opacity: node.opacity,
            z: node.z,
          }).filter((entry): entry is [string, number] => entry[1] !== null),
        ),
        result.duration_ms,
        node.easing,
      );
    }
    result.tracks = [
      {
        type: "sprite",
        sprite_id: node.sprite_id,
        asset: node.asset,
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
): SceneNode {
  const node = structuredClone(source);
  const variables = new Set(Object.keys(manifest.variables));
  const hasAsset = (id: string | null, kind: string): boolean =>
    id !== null && manifest.assets[id]?.kind === kind;
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
      break;
    case "sprite":
      if (node.asset !== null && !hasAsset(node.asset, "sprite"))
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
        ...(choice.visible_if === undefined
          ? {}
          : { visible_if: clearCondition(choice.visible_if) }),
        ...(choice.enabled_if === undefined
          ? {}
          : { enabled_if: clearCondition(choice.enabled_if) }),
      }));
      break;
    case "set":
      if (!variables.has(node.variable)) node.variable = "";
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
    case "bgm":
      if (node.asset !== null && !hasAsset(node.asset, "bgm"))
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
  if (side === "right") {
    if (sourcePorts.length === 0) {
      return { ok: false, error: "结束节点没有后续出口，无法在右侧插入。" };
    }
    if (sourcePorts.length !== 1) {
      return {
        ok: false,
        error: "该节点有多个分支出口，右侧插入会改变分支语义；请改用左侧插入。",
      };
    }
    const targetScene = sourcePorts[0].targetScene;
    if (targetScene !== null && targetScene !== sceneId) {
      return {
        ok: false,
        error: "跨场景跳转不能直接在右侧插入，请先改成本场景节点。",
      };
    }
  }

  const originalTarget =
    side === "right" ? (sourcePorts[0]?.target ?? sourceId) : sourceId;
  const template = defaultNode(type, originalTarget);
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
    file.definition.nodes[sourceId] = setPortTarget(
      source,
      sourcePorts[0].id,
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
  return "variable" in operand
    ? operand.variable
    : JSON.stringify(operand.value);
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
    }
  }
  return count;
}

function summarizeMutationValue(
  value: import("./types").MutationValue | undefined,
): string {
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

  for (const file of updated.scenes) {
    for (const [nodeId, candidate] of Object.entries(file.definition.nodes)) {
      let changed = candidate;
      if (file.definition.id === sceneId) {
        for (const port of outputPorts(candidate)) {
          if (port.targetScene === null && port.target === previousId) {
            changed = setPortTarget(changed, port.id, nextId);
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
    }
  }
  if (updated.layout.scenes[previousId] !== undefined) {
    updated.layout.scenes[nextId] = updated.layout.scenes[previousId];
    Reflect.deleteProperty(updated.layout.scenes, previousId);
  }
  if (
    updated.story_flow !== null &&
    updated.story_flow.definition.nodes[previousId] !== undefined
  ) {
    updated.story_flow.definition.nodes[nextId] =
      updated.story_flow.definition.nodes[previousId];
    Reflect.deleteProperty(updated.story_flow.definition.nodes, previousId);
    for (const edge of updated.story_flow.definition.edges) {
      if (edge.from === previousId) edge.from = nextId;
      if (edge.to === previousId) edge.to = nextId;
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

export function projectRequest(project: EditorProject) {
  return {
    manifest: project.manifest,
    scenes: project.scenes,
    ui_motions: project.ui_motions,
    story_flow: project.story_flow,
    layout: project.layout,
    expected_fingerprint: project.fingerprint,
  };
}

export function newSceneFile(id: string): EditorSceneFile {
  return {
    path: `scenes/${id}.yaml`,
    definition: {
      schema_version: 2,
      id,
      entry: "start",
      nodes: { start: { type: "end" } },
    },
  };
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
