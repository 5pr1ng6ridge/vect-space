import { outputPorts } from "../story";
import { MAX_SCENE_TIMERS } from "../windowInteraction";
import type {
  EditorDiagnostic,
  EditorProject,
  SceneDefinition,
} from "../types";
import { ID_PATTERN, error } from "./shared";
import { validateNode } from "./nodes";

export function validateScenes(
  project: EditorProject,
  sceneById: ReadonlyMap<string, SceneDefinition>,
  diagnostics: EditorDiagnostic[],
): void {
  const seenScenes = new Set<string>();
  for (const file of project.scenes) {
    const scene = file.definition;
    if (scene.schema_version !== 2) {
      diagnostics.push(
        error(
          "invalid_scene_schema",
          "scene schema_version 必须为 2",
          scene.id,
        ),
      );
    }
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
    if (
      scene.window_role !== undefined &&
      scene.window_role !== "main" &&
      scene.window_role !== "secondary"
    ) {
      diagnostics.push(
        error(
          "invalid_window_role",
          "Scene 用途必须是 main（主窗口）或 secondary（副窗口）",
          scene.id,
        ),
      );
    }
    const timerIds = new Set(
      Object.values(scene.nodes)
        .filter((node) => node.type === "timer" && node.action === "start")
        .map((node) => (node.type === "timer" ? node.id : "")),
    );
    if (timerIds.size > MAX_SCENE_TIMERS) {
      diagnostics.push({
        severity: "warning",
        code: "too_many_timers",
        message: `Scene 里有 ${timerIds.size} 个不同的计时器 ID；同时活动的计时器最多 ${MAX_SCENE_TIMERS} 个，超出会在运行时停止`,
        scene_id: scene.id,
        node_id: null,
      });
    }
    if (scene.nodes[scene.entry] === undefined) {
      diagnostics.push(
        error(
          "missing_scene_entry",
          `入口节点不存在：${scene.entry}`,
          scene.id,
        ),
      );
    }

    const longTextDocuments = new Map<
      string,
      {
        hasStart: boolean;
        nodeId: string;
        stepIds: Map<string, string>;
        startPagination?: "continuous" | "auto" | "manual";
      }
    >();
    for (const [nodeId, candidate] of Object.entries(scene.nodes)) {
      if (candidate.type !== "long_text") continue;
      const documentId = candidate.document ?? nodeId;
      const existing = longTextDocuments.get(documentId);
      if (existing === undefined) {
        const stepIds = new Map<string, string>();
        for (const step of candidate.steps) {
          if (stepIds.has(step.id)) {
            diagnostics.push(
              error(
                "duplicate_long_text_step",
                `文稿 ${documentId} 的步骤 ID ${step.id} 在同一节点中重复`,
                scene.id,
                nodeId,
              ),
            );
          }
          stepIds.set(step.id, nodeId);
        }
        longTextDocuments.set(documentId, {
          hasStart: (candidate.mode ?? "start") === "start",
          nodeId,
          startPagination:
            (candidate.mode ?? "start") === "start"
              ? (candidate.pagination ?? "auto")
              : undefined,
          stepIds,
        });
      } else {
        if ((candidate.mode ?? "start") === "start" && existing.hasStart) {
          diagnostics.push(
            error(
              "duplicate_long_text_start",
              `文稿 ${documentId} 只能有一个开始节点`,
              scene.id,
              nodeId,
            ),
          );
        }
        if ((candidate.mode ?? "start") === "start") {
          existing.hasStart = true;
          existing.nodeId = nodeId;
          existing.startPagination = candidate.pagination ?? "auto";
        }
        for (const step of candidate.steps) {
          const previousNodeId = existing.stepIds.get(step.id);
          if (previousNodeId !== undefined) {
            const location =
              previousNodeId === nodeId
                ? "同一节点中重复"
                : `与节点 ${previousNodeId} 重复`;
            diagnostics.push(
              error(
                "duplicate_long_text_step",
                `文稿 ${documentId} 的步骤 ID ${step.id}${location}`,
                scene.id,
                nodeId,
              ),
            );
          }
          existing.stepIds.set(step.id, nodeId);
        }
      }
    }
    for (const [documentId, document] of longTextDocuments) {
      if (!document.hasStart) {
        diagnostics.push(
          error(
            "missing_long_text_start",
            `文稿 ${documentId} 缺少开始节点`,
            scene.id,
            document.nodeId,
          ),
        );
      }
    }

    for (const [nodeId, node] of Object.entries(scene.nodes)) {
      if (!ID_PATTERN.test(nodeId)) {
        diagnostics.push(
          error("invalid_node_id", `非法节点 ID：${nodeId}`, scene.id, nodeId),
        );
      }
      validateNode(project, scene.id, nodeId, node, diagnostics);
      if (
        (node.type === "button_update" || node.type === "button_remove") &&
        !Object.values(scene.nodes).some(
          (candidate) =>
            candidate.type === "button_create" &&
            candidate.instance_id === node.instance_id,
        )
      ) {
        diagnostics.push(
          error(
            "unknown_button_instance",
            `按钮实例不存在：${node.instance_id}`,
            scene.id,
            nodeId,
          ),
        );
      }
      if (node.type === "long_text" && node.mode === "continue") {
        const document = node.document ?? nodeId;
        if (
          longTextDocuments.get(document)?.startPagination === "continuous" &&
          node.steps.some((step) => step.page_break_before)
        ) {
          diagnostics.push(
            error(
              "continuous_long_text_break",
              "开始节点使用连续长卷时，接续段不能使用强制分页",
              scene.id,
              nodeId,
            ),
          );
        }
      }
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

    for (const [nodeId, node] of Object.entries(scene.nodes)) {
      if (
        node.type === "long_text_control" &&
        !longTextDocuments.has(node.document)
      ) {
        diagnostics.push(
          error(
            "unknown_long_text_document",
            `文稿控制引用了未知文稿：${node.document}`,
            scene.id,
            nodeId,
          ),
        );
      }
    }
  }
}
