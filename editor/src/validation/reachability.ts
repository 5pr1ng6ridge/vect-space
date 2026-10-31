import { outputPorts } from "../story";
import type { EditorDiagnostic, EditorProject } from "../types";

export function reachabilityWarnings(
  project: EditorProject,
  sceneById: Map<string, EditorProject["scenes"][number]["definition"]>,
): EditorDiagnostic[] {
  const entry = sceneById.get(project.manifest.entry_scene);
  if (entry === undefined || entry.nodes[entry.entry] === undefined) return [];
  const reached = new Set<string>();
  // Nodes that only run as a timer's effect: reachable, but not a flow source.
  const effectReached = new Set<string>();
  const queue: [string, string][] = [[entry.id, entry.entry]];
  // The room map is a second way into the story.  A hotspot that is always
  // revealed *and* always replayable is enterable without ever reaching the
  // chapter through a jump, so its scene entry counts as reachable.  A locked
  // hotspot (`replay: completed`) or a hidden one cannot bootstrap itself, and
  // a profile condition cannot be decided statically, so those keep warning.
  for (const hotspot of project.chapter_map?.definition.hotspots ?? []) {
    const scene = sceneById.get(hotspot.scene_id);
    if (scene === undefined || scene.nodes[scene.entry] === undefined) continue;
    const revealed = (hotspot.reveal?.mode ?? "completed") === "always";
    const replayable = (hotspot.replay?.mode ?? "completed") === "always";
    if (revealed && replayable) queue.push([hotspot.scene_id, scene.entry]);
  }
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
    // A timer's effect target runs without following the target's own `next`,
    // so the target itself is reachable but its successors are not implied.
    if (node.type === "timer" && node.action === "start" && node.target) {
      if (scene?.nodes[node.target] !== undefined)
        effectReached.add(`${sceneId}\u0000${node.target}`);
    }
    // The secondary runtime enters its own scene while the main flow follows next.
    if (node.type === "open_window") {
      const windowScene = sceneById.get(node.scene);
      if (windowScene !== undefined)
        queue.push([windowScene.id, windowScene.entry]);
    }
  }
  const warnings: EditorDiagnostic[] = [];
  for (const file of project.scenes) {
    for (const nodeId of Object.keys(file.definition.nodes)) {
      const key = `${file.definition.id}\u0000${nodeId}`;
      if (!reached.has(key) && !effectReached.has(key)) {
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
