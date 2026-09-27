/** Field-aware project search (scenes, dialogue, choices, ids, assets). */
import { ASSET_KIND_LABELS } from "../labels";
import { describeNode } from "../nodeSummary";
import { nodeLabel } from "../story";
import type { EditorProject, SceneNode } from "../types";
import { ASSET_KIND_ICONS } from "../ui/assetIcons";
import { NODE_ICONS } from "../ui/nodeIcons";

export interface SearchResult {
  key: string;
  title: string;
  detail: string;
  kind: "node" | "asset" | "scene";
  sceneId: string | null;
  nodeId: string | null;
  assetId?: string;
  icon: (typeof NODE_ICONS)[keyof typeof NODE_ICONS];
}

const LIMIT = 40;

/** The author-visible text of a node, for matching. */
function searchableText(node: SceneNode, project: EditorProject): string {
  const parts: string[] = [];
  const { title, summary } = describeNode(node, { manifest: project.manifest });
  if (title !== null) parts.push(title);
  parts.push(summary);
  if (node.type === "say") {
    parts.push(node.text);
    if (node.speaker !== null) parts.push(node.speaker);
  }
  if (node.type === "long_text")
    for (const step of node.steps) parts.push(step.text);
  if (node.type === "choice")
    for (const choice of node.choices) parts.push(choice.label, choice.id);
  return parts.join("\n").toLowerCase();
}

export function searchProject(
  project: EditorProject,
  query: string,
): SearchResult[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const results: SearchResult[] = [];
  for (const file of project.scenes) {
    const sceneId = file.definition.id;
    if (sceneId.toLowerCase().includes(needle))
      results.push({
        key: `scene:${sceneId}`,
        title: sceneId,
        detail: `场景 · ${Object.keys(file.definition.nodes).length} 个节点`,
        kind: "scene",
        sceneId,
        nodeId: null,
        icon: NODE_ICONS.jump,
      });
  }
  for (const file of project.scenes) {
    const sceneId = file.definition.id;
    for (const [nodeId, node] of Object.entries(file.definition.nodes)) {
      if (results.length >= LIMIT) break;
      if (
        !nodeId.toLowerCase().includes(needle) &&
        !searchableText(node, project).includes(needle)
      )
        continue;
      const { title, summary } = describeNode(node, {
        manifest: project.manifest,
      });
      results.push({
        key: `node:${sceneId}:${nodeId}`,
        title: title === null ? summary : `${title}：${summary}`,
        detail: `${sceneId} / ${nodeId} · ${nodeLabel(node.type)}`,
        kind: "node",
        sceneId,
        nodeId,
        icon: NODE_ICONS[node.type],
      });
    }
  }
  for (const asset of project.assets) {
    if (results.length >= LIMIT) break;
    const description = asset.path ?? `帧动画 ${asset.animation ?? ""}`;
    if (!`${asset.id}\n${description}`.toLowerCase().includes(needle)) continue;
    results.push({
      key: `asset:${asset.id}`,
      title: asset.id,
      detail: `${ASSET_KIND_LABELS[asset.kind]} · ${description}`,
      kind: "asset",
      sceneId: null,
      nodeId: null,
      assetId: asset.id,
      icon: ASSET_KIND_ICONS[asset.kind],
    });
  }
  return results.slice(0, LIMIT);
}
