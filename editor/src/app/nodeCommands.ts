/**
 * Node deletion planning and the reconnecting delete mutation.
 *
 * Deleting a node must hand its incoming edges (and possibly the scene entry)
 * to a successor.  The planners decide which successors are valid; the App
 * asks the author only when there is more than one choice.
 */
import {
  ensureSceneLayout,
  findScene,
  outputPorts,
  setPortTarget,
} from "../story";
import { removeNodesFromGroups } from "../components/graphGroups";
import {
  effectReferences,
  setEffectReferenceTarget,
} from "../windowInteraction";
import type { EditorProject, SceneDefinition } from "../types";

export interface DeletionOption {
  id: string;
  label: string;
}

export type DeletionPlan =
  | { ok: true; nodeIds: string[]; options: DeletionOption[] }
  | { ok: false; error: string };

export function planNodeDeletion(
  scene: SceneDefinition,
  nodeId: string,
): DeletionPlan {
  if (Object.keys(scene.nodes).length <= 1)
    return { ok: false, error: "场景至少需要保留一个节点。" };
  const node = scene.nodes[nodeId];
  if (node === undefined) return { ok: false, error: "节点已经不存在。" };
  if (node.type === "long_text" && (node.mode ?? "start") === "start") {
    const documentId = node.document ?? nodeId;
    const references = Object.entries(scene.nodes).filter(
      ([candidateId, candidate]) =>
        candidateId !== nodeId &&
        ((candidate.type === "long_text" &&
          candidate.document === documentId &&
          candidate.mode === "continue") ||
          (candidate.type === "long_text_control" &&
            candidate.document === documentId)),
    ).length;
    if (references > 0)
      return {
        ok: false,
        error: `文稿 ${documentId} 仍被 ${references} 个接续或控制节点引用，不能删除开始节点。`,
      };
  }
  const outgoing = outputPorts(node).filter(
    (port) => port.target !== nodeId && port.targetScene === null,
  );
  const successorIds = [...new Set(outgoing.map((port) => port.target))];
  const options: DeletionOption[] = successorIds.map((id) => ({
    id,
    label: outgoing.find((port) => port.target === id)?.label ?? `后继 · ${id}`,
  }));
  if (options.length === 0) {
    for (const id of Object.keys(scene.nodes).sort()) {
      if (id !== nodeId) options.push({ id, label: `保留节点 · ${id}` });
    }
  }
  if (options.length === 0)
    return { ok: false, error: "删除后没有可保留的节点。" };
  return { ok: true, nodeIds: [nodeId], options };
}

/**
 * Multi-node deletion is limited to one contiguous linear segment: a set that
 * crosses a branch, a merge, or two unrelated rows is refused instead of
 * silently reconnecting both regions to one successor.
 */
export function planChainDeletion(
  scene: SceneDefinition,
  nodeIds: readonly string[],
): DeletionPlan {
  const ids = [...new Set(nodeIds)].filter(
    (id) => scene.nodes[id] !== undefined,
  );
  if (ids.length === 0) return { ok: false, error: "没有可删除的节点。" };
  if (ids.length === 1) return planNodeDeletion(scene, ids[0]);
  if (Object.keys(scene.nodes).length <= ids.length)
    return { ok: false, error: "场景至少需要保留一个节点。" };
  const removed = new Set(ids);
  const internalSuccessors = new Map<string, string>();
  const internalPredecessorCount = new Map<string, number>();
  for (const id of ids) {
    const targets = outputPorts(scene.nodes[id])
      .filter((port) => port.targetScene === null && removed.has(port.target))
      .map((port) => port.target);
    if (targets.length > 1)
      return {
        ok: false,
        error: "只能删除同一条连续链，所选节点跨越了分支出口。",
      };
    if (targets.length === 1) {
      internalSuccessors.set(id, targets[0]);
      internalPredecessorCount.set(
        targets[0],
        (internalPredecessorCount.get(targets[0]) ?? 0) + 1,
      );
    }
  }
  if ([...internalPredecessorCount.values()].some((count) => count > 1))
    return { ok: false, error: "只能删除同一条连续链，所选节点包含了合流。" };
  const starts = ids.filter((id) => !internalPredecessorCount.has(id));
  const visited = new Set<string>();
  let cursor: string | undefined = starts[0];
  while (cursor !== undefined && !visited.has(cursor)) {
    visited.add(cursor);
    cursor = internalSuccessors.get(cursor);
  }
  if (starts.length !== 1 || visited.size !== ids.length)
    return { ok: false, error: "请选择同一条连续链中的节点后再删除。" };
  const successors = new Set<string>();
  for (const id of ids) {
    for (const port of outputPorts(scene.nodes[id])) {
      if (port.targetScene === null && !removed.has(port.target))
        successors.add(port.target);
    }
  }
  const options: DeletionOption[] = [...successors]
    .sort()
    .map((id) => ({ id, label: `后继 · ${id}` }));
  if (options.length === 0) {
    for (const id of Object.keys(scene.nodes).sort()) {
      if (!removed.has(id)) options.push({ id, label: `保留节点 · ${id}` });
    }
  }
  if (options.length === 0)
    return { ok: false, error: "删除后没有可保留的节点。" };
  return { ok: true, nodeIds: ids, options };
}

/**
 * Delete `nodeIds` from `sceneId`, redirecting the scene entry, every
 * same-scene port and every cross-scene jump that pointed at them to
 * `fallback`, and dropping their layout and preview records.
 */
export function deleteNodes(
  draft: EditorProject,
  sceneId: string,
  nodeIds: readonly string[],
  fallback: string,
): void {
  const removed = new Set(nodeIds);
  const target = findScene(draft, sceneId);
  if (target === undefined || target.definition.nodes[fallback] === undefined)
    return;
  for (const id of nodeIds) Reflect.deleteProperty(target.definition.nodes, id);
  if (removed.has(target.definition.entry)) target.definition.entry = fallback;
  for (const file of draft.scenes) {
    for (const [candidateId, candidate] of Object.entries(
      file.definition.nodes,
    )) {
      let changed = candidate;
      if (file.definition.id === sceneId) {
        for (const port of outputPorts(changed)) {
          if (port.targetScene === null && removed.has(port.target))
            changed = setPortTarget(changed, port.id, fallback);
        }
        // A timer's effect target is not a flow edge: the flow fallback would
        // usually be an invalid effect, so the reference is cleared and the
        // timer is reported until the author picks a new target.
        for (const reference of effectReferences(changed)) {
          if (removed.has(reference.target))
            changed = setEffectReferenceTarget(changed, reference.id, null);
        }
      }
      if (
        changed.type === "jump" &&
        (changed.scene ?? file.definition.id) === sceneId &&
        removed.has(changed.target)
      ) {
        changed = { ...changed, target: fallback };
      }
      file.definition.nodes[candidateId] = changed;
    }
  }
  const sceneLayout = ensureSceneLayout(draft.layout, sceneId);
  for (const id of nodeIds) Reflect.deleteProperty(sceneLayout.nodes, id);
  if (sceneLayout.groups !== undefined)
    sceneLayout.groups = removeNodesFromGroups(
      sceneLayout.groups,
      removed,
      new Set(Object.keys(target.definition.nodes)),
    );
  const previews = draft.layout.timeline_previews;
  if (previews !== undefined) {
    for (const id of nodeIds)
      Reflect.deleteProperty(previews, `${sceneId}/${id}`);
    for (const settings of Object.values(previews)) {
      settings.choices = settings.choices.filter(
        (choice) => choice.scene_id !== sceneId || !removed.has(choice.node_id),
      );
    }
  }
}
