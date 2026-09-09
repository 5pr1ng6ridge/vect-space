import { outputPorts } from "../story";
import type { SceneDefinition, SceneNode } from "../types";

export interface ScriptChainOption {
  id: string;
  label: string;
}

/**
 * Build a stable index of authoring chains rather than listing every node as
 * a pseudo-chain. A chain starts at the scene entry, a branch/jump exit, a
 * merge/unconnected node, or (as a final fallback) the first unvisited node.
 * Traversal stops at a boundary or a visited node, so cycles and shared
 * continuations never get rendered twice while every node remains reachable
 * from the selector.
 */
export function buildScriptChainOptions(
  scene: SceneDefinition,
): ScriptChainOption[] {
  const incoming = new Map<string, string[]>();
  for (const [sourceId, node] of Object.entries(scene.nodes)) {
    for (const port of outputPorts(node)) {
      if (!scene.nodes[port.target]) continue;
      const labels = incoming.get(port.target) ?? [];
      labels.push(`${sourceId} · ${port.label}`);
      incoming.set(port.target, labels);
    }
  }

  const isBoundary = (node: SceneNode): boolean =>
    node.type === "choice" ||
    node.type === "condition" ||
    node.type === "jump" ||
    node.type === "end" ||
    outputPorts(node).length !== 1;

  const starts: string[] = [];
  const seenStarts = new Set<string>();
  const addStart = (id: string): void => {
    if (scene.nodes[id] !== undefined && seenStarts.add(id)) starts.push(id);
  };
  addStart(scene.entry);
  // Branch outputs are ordered by their source and authored port order. Do
  // not sort localized labels: browser locale would otherwise reorder choices.
  const boundarySources = Object.keys(scene.nodes).sort();
  const entryIndex = boundarySources.indexOf(scene.entry);
  if (entryIndex >= 0) {
    boundarySources.splice(entryIndex, 1);
    boundarySources.unshift(scene.entry);
  }
  for (const sourceId of boundarySources) {
    const node = scene.nodes[sourceId];
    if (node === undefined || !isBoundary(node)) continue;
    for (const port of outputPorts(node)) addStart(port.target);
  }
  // Merge points and disconnected nodes need their own chain entry. A node
  // with one incoming edge is covered by the preceding traversal.
  for (const id of Object.keys(scene.nodes).sort()) {
    if ((incoming.get(id)?.length ?? 0) !== 1) addStart(id);
  }

  const visited = new Set<string>();
  const chains: { start: string; size: number }[] = [];
  const build = (start: string): void => {
    if (visited.has(start)) return;
    let current: string | undefined = start;
    let size = 0;
    const local = new Set<string>();
    while (current !== undefined && scene.nodes[current] !== undefined) {
      if (visited.has(current) || local.has(current)) break;
      local.add(current);
      visited.add(current);
      size += 1;
      const node: SceneNode | undefined = scene.nodes[current];
      if (node === undefined) break;
      if (isBoundary(node)) break;
      const next: string | undefined = outputPorts(node)[0]?.target;
      if (next === undefined || next.length === 0) break;
      current = next;
    }
    if (size > 0) chains.push({ start, size });
  };
  for (const start of starts) build(start);
  // Any malformed/disconnected remainder is still presented without
  // pretending it belongs to the entry chain.
  for (const id of Object.keys(scene.nodes).sort()) build(id);

  return chains.map(({ start, size }) => {
    const links = incoming.get(start)?.slice().sort() ?? [];
    const suffix =
      start === scene.entry
        ? "入口"
        : links.length > 0
          ? links.join("、")
          : "未连接";
    return {
      id: start,
      label: `${start}（${suffix} · ${size} 个节点）`,
    };
  });
}
