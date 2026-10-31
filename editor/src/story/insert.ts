import type { EditorProject, NodeType, NodePosition } from "../types";
import {
  cloneProject,
  ensureSceneLayout,
  findScene,
  uniqueNodeId,
} from "./project";
import { outputPorts, setPortTarget } from "./ports";
import { defaultNode } from "./defaults";

export type InsertSide = "left" | "right";

type InsertNodeResult =
  | { ok: true; project: EditorProject; nodeId: string }
  | { ok: false; error: string };

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
    updated.proofs,
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
