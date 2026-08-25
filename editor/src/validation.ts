import { outputPorts } from "./story";
import type {
  AssetKind,
  EditorDiagnostic,
  EditorProject,
  SceneNode,
} from "./types";

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function validateLive(project: EditorProject): EditorDiagnostic[] {
  const diagnostics: EditorDiagnostic[] = [];
  const sceneById = new Map(
    project.scenes.map(
      (file) => [file.definition.id, file.definition] as const,
    ),
  );

  if (!sceneById.has(project.manifest.entry_scene)) {
    diagnostics.push(error("missing_entry_scene", "项目入口场景不存在"));
  }

  const seenScenes = new Set<string>();
  for (const file of project.scenes) {
    const scene = file.definition;
    if (!ID_PATTERN.test(scene.id)) {
      diagnostics.push(
        error("invalid_scene_id", `非法场景 ID：${scene.id}`, scene.id),
      );
    }
    if (seenScenes.has(scene.id)) {
      diagnostics.push(
        error("duplicate_scene_id", `场景 ID 重复：${scene.id}`, scene.id),
      );
    }
    seenScenes.add(scene.id);
    if (scene.nodes[scene.entry] === undefined) {
      diagnostics.push(
        error(
          "missing_scene_entry",
          `入口节点不存在：${scene.entry}`,
          scene.id,
        ),
      );
    }

    for (const [nodeId, node] of Object.entries(scene.nodes)) {
      if (!ID_PATTERN.test(nodeId)) {
        diagnostics.push(
          error("invalid_node_id", `非法节点 ID：${nodeId}`, scene.id, nodeId),
        );
      }
      validateNode(project, scene.id, nodeId, node, diagnostics);
      for (const port of outputPorts(node)) {
        const destinationScene = port.targetScene ?? scene.id;
        const destination = sceneById.get(destinationScene);
        if (destination === undefined) {
          diagnostics.push(
            error(
              "missing_target_scene",
              `端口“${port.label}”指向不存在的场景 ${destinationScene}`,
              scene.id,
              nodeId,
            ),
          );
        } else if (destination.nodes[port.target] === undefined) {
          diagnostics.push(
            error(
              "missing_target_node",
              `端口“${port.label}”指向不存在的节点 ${destinationScene}/${port.target}`,
              scene.id,
              nodeId,
            ),
          );
        }
      }
    }
  }

  diagnostics.push(...reachabilityWarnings(project, sceneById));
  return deduplicate([...diagnostics, ...project.diagnostics]);
}

function validateNode(
  project: EditorProject,
  sceneId: string,
  nodeId: string,
  node: SceneNode,
  output: EditorDiagnostic[],
): void {
  const issue = (code: string, message: string) =>
    output.push(error(code, message, sceneId, nodeId));
  const checkDuration = (duration: number) => {
    if (!Number.isFinite(duration) || duration < 0 || duration > 60_000) {
      issue("invalid_duration", "时长必须在 0–60000 ms 之间");
    }
  };
  const checkVolume = (volume: number) => {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      issue("invalid_volume", "音量必须在 0–1 之间");
    }
  };
  const checkAsset = (
    id: string | null,
    kind: AssetKind,
    required: boolean,
  ) => {
    if (id === null || id === "") {
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

  switch (node.type) {
    case "background":
      checkAsset(node.background, "background", false);
      checkDuration(node.duration_ms);
      break;
    case "sprite":
      if (!ID_PATTERN.test(node.sprite_id))
        issue("invalid_sprite_id", "立绘实例 ID 非法");
      checkAsset(node.asset, "sprite", node.action === "show");
      checkDuration(node.duration_ms);
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
    case "say":
      if (node.text.trim() === "") issue("empty_dialogue", "对话文本不能为空");
      if (
        node.speed_cps !== null &&
        (!Number.isFinite(node.speed_cps) || node.speed_cps <= 0)
      ) {
        issue("invalid_speed", "文字速度必须是正数");
      }
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
        ids.add(choice.id);
      }
      break;
    }
    case "set":
      if (!ID_PATTERN.test(node.variable))
        issue("invalid_variable", "变量名非法");
      break;
    case "branch":
      if (!ID_PATTERN.test(node.variable))
        issue("invalid_variable", "变量名非法");
      break;
    case "wait":
      checkDuration(node.duration_ms);
      break;
    case "bgm":
      checkAsset(node.asset, "bgm", node.action === "start");
      checkVolume(node.volume);
      checkDuration(node.duration_ms);
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
    case "dialogue_ui":
      checkDuration(node.duration_ms);
      break;
    case "jump":
    case "end":
      break;
  }
}

function reachabilityWarnings(
  project: EditorProject,
  sceneById: Map<string, EditorProject["scenes"][number]["definition"]>,
): EditorDiagnostic[] {
  const entry = sceneById.get(project.manifest.entry_scene);
  if (entry === undefined || entry.nodes[entry.entry] === undefined) return [];
  const reached = new Set<string>();
  const queue: [string, string][] = [[entry.id, entry.entry]];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    const [sceneId, nodeId] = next;
    const key = `${sceneId}\u0000${nodeId}`;
    if (reached.has(key)) continue;
    reached.add(key);
    const scene = sceneById.get(sceneId);
    const node = scene?.nodes[nodeId];
    if (node === undefined) continue;
    for (const port of outputPorts(node)) {
      queue.push([port.targetScene ?? sceneId, port.target]);
    }
  }
  const warnings: EditorDiagnostic[] = [];
  for (const file of project.scenes) {
    for (const nodeId of Object.keys(file.definition.nodes)) {
      if (!reached.has(`${file.definition.id}\u0000${nodeId}`)) {
        warnings.push({
          severity: "warning",
          code: "unreachable_node",
          message: "节点无法从项目入口到达",
          scene_id: file.definition.id,
          node_id: nodeId,
        });
      }
    }
  }
  return warnings;
}

function error(
  code: string,
  message: string,
  sceneId: string | null = null,
  nodeId: string | null = null,
): EditorDiagnostic {
  return {
    severity: "error",
    code,
    message,
    scene_id: sceneId,
    node_id: nodeId,
  };
}

function deduplicate(diagnostics: EditorDiagnostic[]): EditorDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = [
      diagnostic.severity,
      diagnostic.code,
      diagnostic.scene_id,
      diagnostic.node_id,
      diagnostic.message,
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
