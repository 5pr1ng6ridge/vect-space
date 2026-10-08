import { useMemo, useRef } from "react";
import { flushSync } from "react-dom";

import { editorApi } from "../api";
import { expandSpriteActionNode } from "../timeline";
import {
  convertToTimeline as convertQuickNodeToTimeline,
  defaultNode,
  ensureSceneLayout,
  findScene,
  insertNode,
  nodeLabel,
  preparePastedNode,
  projectRequest,
  remapCopiedEmitterInstances,
  renameNode,
  rewriteLongTextDocumentReferences,
  setPortTarget,
  splitDialogueAt,
  splitLongTextAt,
  uniqueNodeId,
} from "../story";
import type {
  EditorViewport,
  GroupChildRef,
  NodePosition,
  NodeType,
  SceneDefinition,
  SceneGroup,
  SceneNode,
  SpriteSnapshot,
} from "../types";
import { currentPlainProject, type ActionContext } from "./actionContext";
import {
  captureGraphSelection,
  placeGraphSelection,
  type GraphSelectionClipboard,
} from "./graphSelectionClipboard";
import { idUnavailableReason } from "./ids";
import {
  deleteNodes as deleteNodesMutation,
  planChainDeletion,
  planNodeDeletion,
} from "./nodeCommands";
import { routeShowsNode, STORY_ROUTE } from "./routes";

type NodeClipboard =
  | {
      kind: "node";
      node: SceneNode;
      sourceNodeId: string;
      sourceCharacterId: string | null;
    }
  | { kind: "selection"; graph: GraphSelectionClipboard };

/** The app-wide node clipboard; it survives scene changes. */
export function useNodeClipboard() {
  const ref = useRef<NodeClipboard | null>(null);
  return useMemo(
    () => ({
      get: (): NodeClipboard | null => ref.current,
      set: (value: NodeClipboard): void => {
        ref.current = value;
      },
    }),
    [],
  );
}

type NodeClipboardStore = ReturnType<typeof useNodeClipboard>;

export interface DeleteRequest {
  nodeIds: string[];
  options: { id: string; label: string }[];
}

interface NodeActionContext extends ActionContext {
  activeScene: SceneDefinition | undefined;
  activeImportTokens: string[];
  clipboard: NodeClipboardStore;
  setDeleteRequest(request: DeleteRequest | null): void;
}

/**
 * Graph and script-view edits on the active scene: node insertion, splitting,
 * deletion, duplication and the copy/paste clipboard.  Every action plans its
 * change from `latestProject()` inside the commit so batched gestures never
 * overwrite each other.
 */
export function createNodeActions(ctx: NodeActionContext) {
  const {
    project,
    latestProject,
    activeSceneId,
    activeScene,
    route,
    activeImportTokens,
    commit,
    commitUndoable,
    setError,
    setNotice,
    reportCommandError,
    setSelectedNodeId,
    setRoute,
    setDeleteRequest,
    clipboard: clipboardStore,
  } = ctx;

  const changeNode = (nodeId: string, node: SceneNode): void => {
    commit((draft) => {
      const scene = findScene(draft, activeSceneId);
      if (scene === undefined) return;
      const previous = scene.definition.nodes[nodeId];
      const previousDocument =
        previous?.type === "long_text" && (previous.mode ?? "start") === "start"
          ? (previous.document ?? nodeId)
          : null;
      const nextDocument =
        node.type === "long_text" && (node.mode ?? "start") === "start"
          ? (node.document ?? nodeId)
          : null;
      scene.definition.nodes[nodeId] = node;
      if (
        previousDocument !== null &&
        nextDocument !== null &&
        previousDocument !== nextDocument
      ) {
        rewriteLongTextDocumentReferences(
          scene.definition,
          previousDocument,
          nextDocument,
          nodeId,
        );
      }
    });
  };

  const convertNodeToTimeline = (nodeId: string): void => {
    const sceneId = activeSceneId;
    const currentProject = latestProject();
    const sourceNode = findScene(currentProject, sceneId)?.definition.nodes[
      nodeId
    ];
    if (sourceNode === undefined) return;
    setError(null);
    try {
      const converted = convertQuickNodeToTimeline(
        sourceNode,
        currentProject.manifest,
      );
      commit((draft) => {
        const scene = findScene(draft, sceneId);
        if (scene === undefined) return;
        scene.definition.nodes[nodeId] = converted;
      });
      setNotice(
        `已将 ${nodeLabel(sourceNode.type)}节点展开为关键帧时间线；起始通道继承真实入口值。`,
      );
      setRoute({ kind: "timeline", sceneId, nodeId });
    } catch (reason) {
      reportCommandError(reason);
    }
  };

  const convertActionNodeToTimeline = async (nodeId: string): Promise<void> => {
    const scene = findScene(latestProject(), activeSceneId)?.definition;
    const sourceNode = scene?.nodes[nodeId];
    if (scene === undefined || sourceNode?.type !== "action") return;
    const action = latestProject().actions?.find(
      (file) => file.definition.id === sourceNode.action,
    )?.definition;
    if (action === undefined) {
      setError(`未找到立绘动作 ${sourceNode.action}。`);
      return;
    }
    const currentProject = latestProject();
    try {
      const previewSettings = currentProject.layout.timeline_previews?.[
        `${activeSceneId}/${nodeId}`
      ] ?? { variable_overrides: {}, choices: [] };
      const preview = await editorApi.buildNodePreview({
        project: projectRequest(currentProject, activeImportTokens),
        target: { scene_id: activeSceneId, node_id: nodeId },
        variable_overrides: previewSettings.variable_overrides,
        choices: previewSettings.choices,
      });
      if (preview.status === "needs_choice") {
        setError(
          `解除引用需要唯一的真实进入状态；请先补充 ${preview.location.scene_id}/${preview.location.node_id} 的预览路径选择。`,
        );
        return;
      }
      if (preview.status === "unreachable") {
        setError(`无法构造动作节点的真实进入状态：${preview.message}`);
        return;
      }
      const base: SpriteSnapshot | undefined =
        preview.start_snapshot.world.sprites[sourceNode.sprite_id];
      if (base === undefined) {
        setError(
          `动作节点进入时不存在立绘 ${sourceNode.sprite_id}，无法安全解除引用。`,
        );
        return;
      }
      const converted = expandSpriteActionNode({
        node: sourceNode,
        action,
        base,
      });
      commit((draft) => {
        const target = findScene(draft, activeSceneId);
        const latest = target?.definition.nodes[nodeId];
        if (
          target !== undefined &&
          latest?.type === "action" &&
          latest.action === sourceNode.action &&
          latest.sprite_id === sourceNode.sprite_id
        ) {
          target.definition.nodes[nodeId] = converted;
        }
      });
      setNotice(
        `已将动作 ${sourceNode.action} 解除引用为关键帧时间线；通道已按当前立绘姿态展开。`,
      );
      setRoute({ kind: "timeline", sceneId: activeSceneId, nodeId });
    } catch (reason) {
      reportCommandError(reason);
    }
  };

  const splitDialogue = (
    nodeId: string,
    offset: number,
    textOverride?: string,
  ): void => {
    const scene =
      findScene(latestProject(), activeSceneId)?.definition ?? activeScene;
    if (scene === undefined) return;
    const sourceScene =
      textOverride === undefined
        ? scene
        : {
            ...scene,
            nodes: {
              ...scene.nodes,
              [nodeId]:
                scene.nodes[nodeId]?.type === "say"
                  ? { ...scene.nodes[nodeId], text: textOverride }
                  : scene.nodes[nodeId],
            },
          };
    let result: ReturnType<typeof splitDialogueAt>;
    try {
      result = splitDialogueAt(sourceScene, nodeId, offset);
    } catch (reason) {
      reportCommandError(reason);
      return;
    }
    let committed = false;
    let continuationId = result.continuationId;
    flushSync(() =>
      commit((draft) => {
        const base = structuredClone(currentPlainProject(draft));
        const file = findScene(base, activeSceneId);
        if (file === undefined) return undefined;
        const latestScene = file.definition;
        const latestSource =
          textOverride === undefined
            ? latestScene
            : {
                ...latestScene,
                nodes: {
                  ...latestScene.nodes,
                  [nodeId]:
                    latestScene.nodes[nodeId]?.type === "say"
                      ? { ...latestScene.nodes[nodeId], text: textOverride }
                      : latestScene.nodes[nodeId],
                },
              };
        let latest: ReturnType<typeof splitDialogueAt>;
        try {
          latest = splitDialogueAt(latestSource, nodeId, offset);
        } catch {
          return undefined;
        }
        file.definition.nodes[nodeId] = latest.first;
        file.definition.nodes[latest.continuationId] = latest.continuation;
        const layout = ensureSceneLayout(base.layout, activeSceneId);
        const origin = layout.nodes[nodeId] ?? { x: 0, y: 0 };
        layout.nodes[latest.continuationId] = {
          x: origin.x + 320,
          y: origin.y,
        };
        committed = true;
        continuationId = latest.continuationId;
        return base;
      }),
    );
    if (!committed) {
      setError("拆分失败：节点已发生变化，请重新尝试。");
      return;
    }
    setSelectedNodeId(continuationId);
    setNotice("已拆成两个对话段；可在它们之间插入动画节点。");
  };

  const splitLongText = (nodeId: string, stepIndex: number): void => {
    const scene =
      findScene(latestProject(), activeSceneId)?.definition ?? activeScene;
    const source = scene?.nodes[nodeId];
    if (scene === undefined || source?.type !== "long_text") return;
    let result: ReturnType<typeof splitLongTextAt>;
    try {
      result = splitLongTextAt(scene, nodeId, stepIndex);
    } catch (reason) {
      reportCommandError(reason);
      return;
    }
    let committed = false;
    let continuationId = result.continuationId;
    flushSync(() =>
      commit((draft) => {
        const base = structuredClone(currentPlainProject(draft));
        const file = findScene(base, activeSceneId);
        if (file === undefined) return undefined;
        let latest: ReturnType<typeof splitLongTextAt>;
        try {
          latest = splitLongTextAt(file.definition, nodeId, stepIndex);
        } catch {
          return undefined;
        }
        file.definition.nodes[nodeId] = latest.first;
        file.definition.nodes[latest.continuationId] = latest.continuation;
        rewriteLongTextDocumentReferences(
          file.definition,
          latest.previousDocument,
          latest.document,
          nodeId,
        );
        const layout = ensureSceneLayout(base.layout, activeSceneId);
        const origin = layout.nodes[nodeId] ?? { x: 0, y: 0 };
        layout.nodes[latest.continuationId] = {
          x: origin.x + 320,
          y: origin.y,
        };
        committed = true;
        continuationId = latest.continuationId;
        return base;
      }),
    );
    if (!committed) {
      setError("拆分失败：节点已发生变化，请重新尝试。");
      return;
    }
    setSelectedNodeId(continuationId);
    setNotice("已拆成长文稿接续节点；可在两段之间插入对话或动画。");
  };

  const addNode = (type: NodeType, position: NodePosition): void => {
    const currentProject = latestProject();
    const currentScene = findScene(currentProject, activeSceneId)?.definition;
    if (currentScene === undefined) return;
    let insertedId = "";
    let committed = false;
    flushSync(() =>
      commit(
        (draft) => {
          const base = structuredClone(currentPlainProject(draft));
          const file = findScene(base, activeSceneId);
          if (file === undefined) return undefined;
          insertedId = uniqueNodeId(file.definition, type);
          const fallback =
            file.definition.entry ||
            Object.keys(file.definition.nodes)[0] ||
            insertedId;
          file.definition.nodes[insertedId] = defaultNode(
            type,
            fallback,
            base.scenes.map((scene) => scene.definition),
          );
          ensureSceneLayout(base.layout, activeSceneId).nodes[insertedId] = {
            x: Math.round(position.x / 16) * 16,
            y: Math.round(position.y / 16) * 16,
          };
          committed = true;
          return base;
        },
        true,
        `添加${nodeLabel(type)}节点`,
      ),
    );
    if (!committed) {
      setError("添加节点失败：场景已发生变化，请重新尝试。");
      return;
    }
    setSelectedNodeId(insertedId);
  };

  const quickInsertNode = (
    sourceId: string,
    side: "left" | "right",
    type: NodeType,
  ): void => {
    const currentProject = latestProject();
    const result = insertNode(
      currentProject,
      activeSceneId,
      sourceId,
      side,
      type,
    );
    if (!result.ok) {
      setError(result.error);
      return;
    }
    let insertedId = result.nodeId;
    let committed = false;
    flushSync(() =>
      commit((draft) => {
        const latest = insertNode(
          currentPlainProject(draft),
          activeSceneId,
          sourceId,
          side,
          type,
        );
        if (!latest.ok) return undefined;
        insertedId = latest.nodeId;
        committed = true;
        return latest.project;
      }),
    );
    if (!committed) {
      setError("插入节点失败：源节点已发生变化，请重新尝试。\n");
      return;
    }
    setSelectedNodeId(insertedId);
    setNotice(
      `已在${side === "left" ? "左" : "右"}侧插入${nodeLabel(type)}节点。`,
    );
  };

  const insertSayAfter = (sourceId: string, portId?: string): void => {
    const currentProject = latestProject();
    // Compute the id/eligibility for immediate feedback, but perform the
    // actual insertion from the reducer's current project.  Deriving the
    // second project from this render's stale `project` would otherwise
    // overwrite a newer edit when several authoring gestures are batched.
    const preview = insertNode(
      currentProject,
      activeSceneId,
      sourceId,
      "right",
      "say",
      portId,
    );
    if (!preview.ok) {
      setError(preview.error);
      return;
    }
    let insertedId = preview.nodeId;
    let committed = false;
    flushSync(() => {
      commit((draft) => {
        // The reducer supplies the latest draft to this recipe.  `original`
        // unwraps it before the pure story helper clones the project.
        const latest = insertNode(
          currentPlainProject(draft),
          activeSceneId,
          sourceId,
          "right",
          "say",
          portId,
        );
        if (!latest.ok) return undefined;
        const latestSource = latest.project.scenes.find(
          (file) => file.definition.id === activeSceneId,
        )?.definition.nodes[sourceId];
        if (latestSource?.type === "say") {
          const inserted = latest.project.scenes.find(
            (file) => file.definition.id === activeSceneId,
          )?.definition.nodes[latest.nodeId];
          if (inserted?.type === "say") inserted.speaker = latestSource.speaker;
        }
        committed = true;
        insertedId = latest.nodeId;
        return latest.project;
      });
    });
    if (!committed) {
      setError("插入对话失败：源节点已发生变化，请重新尝试。");
      return;
    }
    setSelectedNodeId(insertedId);
  };

  const insertSayAfterWithText = (sourceId: string, text: string): boolean => {
    const current = latestProject();
    const preview = insertNode(
      current,
      activeSceneId,
      sourceId,
      "right",
      "say",
    );
    if (!preview.ok) {
      setError(preview.error);
      return false;
    }
    let insertedId = preview.nodeId;
    let committed = false;
    flushSync(() => {
      commit(
        (draft) => {
          // `insertNode` is deliberately a pure helper.  Build its input from
          // the reducer's current project and apply the pending text before
          // the clone, so committing the textarea and inserting the next
          // sentence produces exactly one history entry.
          const base = structuredClone(currentPlainProject(draft));
          const source = findScene(base, activeSceneId)?.definition.nodes[
            sourceId
          ];
          if (source?.type !== "say") return undefined;
          source.text = text;
          const result = insertNode(
            base,
            activeSceneId,
            sourceId,
            "right",
            "say",
          );
          if (!result.ok) return undefined;
          committed = true;
          insertedId = result.nodeId;
          return result.project;
        },
        true,
        "提交对话并插入下一句",
        true,
      );
    });
    if (!committed) {
      setError(
        "插入对话失败：源节点已发生变化，请重新尝试。正文草稿已保留。\n",
      );
      return false;
    }
    setSelectedNodeId(insertedId);
    return true;
  };

  const insertSayBatch = (
    sourceId: string,
    rows: { speaker: string | null; text: string }[],
  ): void => {
    if (rows.length === 0) return;
    let candidate = project;
    let anchor = sourceId;
    let failed = false;
    for (const row of rows) {
      const result = insertNode(
        candidate,
        activeSceneId,
        anchor,
        "right",
        "say",
      );
      if (!result.ok) {
        setError(result.error);
        failed = true;
        break;
      }
      const file = result.project.scenes.find(
        (item) => item.definition.id === activeSceneId,
      );
      const inserted = file?.definition.nodes[result.nodeId];
      if (inserted?.type === "say") {
        inserted.speaker = row.speaker;
        inserted.text = row.text;
      }
      candidate = result.project;
      anchor = result.nodeId;
    }
    // A paste is one authoring gesture.  Never commit a prefix when a later
    // row cannot be inserted: the user should be able to fix the input and
    // retry without leaving a surprising half-pasted chain in the story.
    if (!failed && candidate !== project) {
      let committed = false;
      flushSync(() =>
        commit(
          (draft) => {
            let latest = structuredClone(currentPlainProject(draft));
            let latestAnchor = sourceId;
            for (const row of rows) {
              const result = insertNode(
                latest,
                activeSceneId,
                latestAnchor,
                "right",
                "say",
              );
              if (!result.ok) return undefined;
              const file = findScene(result.project, activeSceneId);
              const inserted = file?.definition.nodes[result.nodeId];
              if (inserted?.type === "say") {
                inserted.speaker = row.speaker;
                inserted.text = row.text;
              }
              latest = result.project;
              latestAnchor = result.nodeId;
            }
            committed = true;
            return latest;
          },
          true,
          "批量插入对话",
        ),
      );
      if (!committed) {
        setError("批量插入失败：源节点已发生变化，请重新尝试。");
        return;
      }
      setSelectedNodeId(anchor);
      setNotice(`已插入 ${rows.length} 句对话。`);
    }
  };

  const executeDeleteNodes = (nodeIds: string[], fallback: string): void => {
    const removed = new Set(nodeIds);
    commitUndoable(
      (draft) => deleteNodesMutation(draft, activeSceneId, nodeIds, fallback),
      nodeIds.length === 1 ? "删除节点" : "删除节点片段",
      nodeIds.length === 1
        ? `已删除节点 ${nodeIds[0]}，原有连线改接到 ${fallback}。`
        : `已删除 ${nodeIds.length} 个节点，原有连线改接到 ${fallback}。`,
    );
    setDeleteRequest(null);
    setSelectedNodeId(null);
    if (routeShowsNode(route, activeSceneId, removed)) setRoute(STORY_ROUTE);
  };

  const deleteNode = (nodeId: string): void => {
    const currentProject = latestProject();
    const currentScene = findScene(currentProject, activeSceneId)?.definition;
    if (currentScene === undefined) return;
    const plan = planNodeDeletion(currentScene, nodeId);
    if (!plan.ok) {
      setError(plan.error);
      return;
    }
    if (plan.options.length === 1) {
      executeDeleteNodes(plan.nodeIds, plan.options[0].id);
      return;
    }
    setDeleteRequest({ nodeIds: plan.nodeIds, options: plan.options });
  };

  const duplicateNode = (nodeId: string): void => {
    const currentProject = latestProject();
    const currentScene = findScene(currentProject, activeSceneId)?.definition;
    if (currentScene === undefined) return;
    const source = currentScene.nodes[nodeId];
    if (source === undefined) return;
    const id = uniqueNodeId(currentScene, `${nodeId}_copy`);
    commit((draft) => {
      const file = findScene(draft, activeSceneId);
      if (file === undefined || file.definition.nodes[nodeId] === undefined)
        return;
      const duplicate = structuredClone(source);
      remapCopiedEmitterInstances(
        [duplicate],
        draft.scenes.map((scene) => scene.definition),
      );
      file.definition.nodes[id] = duplicate;
      const sceneLayout = ensureSceneLayout(draft.layout, activeSceneId);
      const origin = sceneLayout.nodes[nodeId] ?? { x: 0, y: 0 };
      sceneLayout.nodes[id] = { x: origin.x + 48, y: origin.y + 48 };
    });
    setSelectedNodeId(id);
  };

  const duplicateGraphSelection = (
    selection: readonly GroupChildRef[],
  ): GroupChildRef[] => {
    const currentProject = latestProject();
    const scene = findScene(currentProject, activeSceneId)?.definition;
    if (scene === undefined) return [];
    const layout = currentProject.layout.scenes[activeSceneId];
    const snapshot = captureGraphSelection(
      scene,
      layout,
      selection,
      currentProject.manifest,
    );
    if (snapshot === null) return [];
    const placed = placeGraphSelection(
      snapshot,
      scene,
      layout,
      { x: 0, y: 0 },
      "duplicate",
      currentProject.manifest,
      currentProject.buttons ?? [],
      currentProject.scenes.map((file) => file.definition),
    );
    commit((draft) => {
      const file = findScene(draft, activeSceneId);
      if (file === undefined) return;
      Object.assign(file.definition.nodes, placed.nodes);
      const sceneLayout = ensureSceneLayout(draft.layout, activeSceneId);
      Object.assign(sceneLayout.nodes, placed.positions);
      if (placed.copiedGroupCount > 0) sceneLayout.groups = placed.groups;
    });
    setSelectedNodeId(null);
    return placed.roots;
  };

  const copyGraphSelection = (selection: readonly GroupChildRef[]): void => {
    const currentProject = latestProject();
    const scene = findScene(currentProject, activeSceneId)?.definition;
    if (scene === undefined) return;
    const graph = captureGraphSelection(
      scene,
      currentProject.layout.scenes[activeSceneId],
      selection,
      currentProject.manifest,
    );
    if (graph === null) return;
    clipboardStore.set({ kind: "selection", graph });
    setNotice(
      `已复制 ${Object.keys(graph.nodes).length} 个节点，可切换场景后粘贴。`,
    );
  };

  const copyNode = (nodeId: string): void => {
    const currentProject = latestProject();
    const node = findScene(currentProject, activeSceneId)?.definition.nodes[
      nodeId
    ];
    if (node === undefined) return;
    const sourceCharacterId =
      node.type === "say" &&
      node.speaker !== null &&
      currentProject.manifest.characters[node.speaker] !== undefined
        ? node.speaker
        : null;
    clipboardStore.set({
      kind: "node",
      node: structuredClone(node),
      sourceNodeId: nodeId,
      sourceCharacterId,
    });
    setNotice(`已复制节点 ${nodeId}，可切换场景后粘贴。`);
  };

  const pasteNode = (position: NodePosition): void => {
    const clipboard = clipboardStore.get();
    const currentProject = latestProject();
    const currentScene = findScene(currentProject, activeSceneId)?.definition;
    if (clipboard === null || currentScene === undefined) {
      setNotice("还没有复制节点。");
      return;
    }
    const snapped = {
      x: Math.round(position.x / 16) * 16,
      y: Math.round(position.y / 16) * 16,
    };
    if (clipboard.kind === "selection") {
      const layout = currentProject.layout.scenes[activeSceneId];
      const placed = placeGraphSelection(
        clipboard.graph,
        currentScene,
        layout,
        snapped,
        "paste",
        currentProject.manifest,
        currentProject.buttons ?? [],
        currentProject.scenes.map((file) => file.definition),
      );
      commit((draft) => {
        const file = findScene(draft, activeSceneId);
        if (file === undefined) return;
        Object.assign(file.definition.nodes, placed.nodes);
        const sceneLayout = ensureSceneLayout(draft.layout, activeSceneId);
        Object.assign(sceneLayout.nodes, placed.positions);
        if (placed.copiedGroupCount > 0) sceneLayout.groups = placed.groups;
      });
      setSelectedNodeId(null);
      setNotice(
        `已粘贴 ${Object.keys(placed.nodes).length} 个节点；外部流程连接已清空。`,
      );
      return;
    }
    const id = uniqueNodeId(currentScene, `${clipboard.sourceNodeId}_copy`);
    commit((draft) => {
      const file = findScene(draft, activeSceneId);
      if (file === undefined) return;
      const node = preparePastedNode(
        clipboard.node,
        draft.manifest,
        clipboard.sourceCharacterId,
        draft.buttons ?? [],
      );
      remapCopiedEmitterInstances(
        [node],
        draft.scenes.map((scene) => scene.definition),
      );
      file.definition.nodes[id] = node;
      ensureSceneLayout(draft.layout, activeSceneId).nodes[id] = snapped;
    });
    setSelectedNodeId(id);
    setNotice(`已粘贴为 ${id}；流程连接已清空。`);
  };

  const deleteNodes = (nodeIds: string[]): void => {
    const currentProject = latestProject();
    const currentScene = findScene(currentProject, activeSceneId)?.definition;
    if (currentScene === undefined) return;
    const plan = planChainDeletion(currentScene, nodeIds);
    if (!plan.ok) {
      setError(plan.error);
      return;
    }
    if (plan.nodeIds.length === 1) {
      deleteNode(plan.nodeIds[0]);
      return;
    }
    if (plan.options.length === 1) {
      executeDeleteNodes(plan.nodeIds, plan.options[0].id);
      return;
    }
    setDeleteRequest({ nodeIds: plan.nodeIds, options: plan.options });
  };

  const batchChangeSpeaker = (
    nodeIds: string[],
    speaker: string | null,
  ): void => {
    const currentProject = latestProject();
    const currentScene = findScene(currentProject, activeSceneId)?.definition;
    if (currentScene === undefined || nodeIds.length === 0) return;
    const ids = new Set(nodeIds);
    commit(
      (draft) => {
        const scene = findScene(draft, activeSceneId);
        if (scene === undefined) return;
        for (const id of ids) {
          const node = scene.definition.nodes[id];
          if (node?.type === "say") node.speaker = speaker;
        }
      },
      true,
      "批量修改角色",
    );
  };

  const setEntry = (nodeId: string): void =>
    commit((draft) => {
      const file = findScene(draft, activeSceneId);
      if (file !== undefined) file.definition.entry = nodeId;
    });

  const connectPort = (
    sourceId: string,
    handle: string,
    targetId: string,
  ): void =>
    commit((draft) => {
      const file = findScene(draft, activeSceneId);
      if (file === undefined || file.definition.nodes[sourceId] === undefined)
        return;
      file.definition.nodes[sourceId] = setPortTarget(
        file.definition.nodes[sourceId],
        handle,
        targetId,
      );
    });

  const moveNode = (nodeId: string, position: NodePosition): void =>
    commit((draft) => {
      ensureSceneLayout(draft.layout, activeSceneId).nodes[nodeId] = position;
    });

  /**
   * `positions` is a partial batch (a group drag commits only its
   * descendants), so merge it and keep every unrelated node position intact.
   */
  const moveNodes = (positions: Record<string, NodePosition>): void =>
    commit((draft) => {
      Object.assign(
        ensureSceneLayout(draft.layout, activeSceneId).nodes,
        positions,
      );
    });

  const setGroups = (groups: SceneGroup[]): void =>
    commit((draft) => {
      ensureSceneLayout(draft.layout, activeSceneId).groups = groups;
    });

  const setViewport = (viewport: EditorViewport): void =>
    commit((draft) => {
      ensureSceneLayout(draft.layout, activeSceneId).viewport = viewport;
    }, false);

  /** Rename a node of the active scene and keep it selected. */
  const renameSelectedNode = (previousId: string, nextId: string): void => {
    const reason = idUnavailableReason("node", nextId, project, {
      sceneId: activeSceneId,
    });
    if (reason !== null) {
      setError(reason);
      return;
    }
    commit((draft) =>
      renameNode(currentPlainProject(draft), activeSceneId, previousId, nextId),
    );
    setSelectedNodeId(nextId);
  };

  return {
    setEntry,
    connectPort,
    moveNode,
    moveNodes,
    setGroups,
    setViewport,
    renameSelectedNode,
    changeNode,
    convertNodeToTimeline,
    convertActionNodeToTimeline,
    splitDialogue,
    splitLongText,
    addNode,
    quickInsertNode,
    insertSayAfter,
    insertSayAfterWithText,
    insertSayBatch,
    executeDeleteNodes,
    deleteNode,
    duplicateNode,
    duplicateGraphSelection,
    copyGraphSelection,
    copyNode,
    pasteNode,
    deleteNodes,
    batchChangeSpeaker,
  };
}
