import type {
  ContentManifest,
  EditorLayout,
  EditorProject,
  EditorSceneFile,
  NodeType,
  ScalarValue,
  SceneDefinition,
  SceneNode,
} from "./types";

export const NODE_TYPES: { type: NodeType; label: string; group: string }[] = [
  { type: "say", label: "对话", group: "叙事" },
  { type: "choice", label: "选择", group: "逻辑" },
  { type: "branch", label: "条件分支", group: "逻辑" },
  { type: "set", label: "设置变量", group: "逻辑" },
  { type: "jump", label: "跳转", group: "逻辑" },
  { type: "background", label: "背景", group: "画面" },
  { type: "sprite", label: "立绘", group: "画面" },
  { type: "camera", label: "镜头", group: "画面" },
  { type: "screen_effect", label: "屏幕效果", group: "画面" },
  { type: "dialogue_ui", label: "对话框", group: "画面" },
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
    case "branch":
      return [
        { id: "then", label: "相等", target: node.then, targetScene: null },
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
  if (node.type === "branch" && (handle === "then" || handle === "otherwise")) {
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
      return `${node.speaker ?? "旁白"}：${node.text}`;
    case "choice":
      return `${node.choices.length} 个选项`;
    case "set":
      return `${node.variable} = ${String(node.value)}`;
    case "branch":
      return `${node.variable} == ${String(node.equals)}`;
    case "jump":
      return `${node.scene ?? "本场景"} / ${node.target}`;
    case "background":
      return node.background ?? "清除背景";
    case "sprite":
      return `${node.action} ${node.sprite_id}`;
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
      return node.visible ? "显示" : "隐藏";
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
    case "say":
      return {
        type,
        speaker: null,
        text: "新对话",
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
      return { type, variable: "flag", value: true, next: fallback };
    case "branch":
      return {
        type,
        variable: "flag",
        equals: true,
        then: fallback,
        otherwise: fallback,
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
        duration_ms: 200,
        await: false,
        next: fallback,
      };
    case "end":
      return { type };
  }
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
  return updated;
}

export function projectRequest(project: EditorProject) {
  return {
    manifest: project.manifest,
    scenes: project.scenes,
    layout: project.layout,
    expected_fingerprint: project.fingerprint,
  };
}

export function newSceneFile(id: string): EditorSceneFile {
  return {
    path: `scenes/${id}.yaml`,
    definition: {
      schema_version: 1,
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
