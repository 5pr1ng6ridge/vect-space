import type { EditorProject, SceneNode } from "../types";

/**
 * Return every user-visible and implicit runtime use of an asset.
 *
 * Keeping this traversal outside React components makes the same reference
 * policy available to the sidebar, delete guard, and future import validator
 * without triggering Fast Refresh's component-only export rule.
 */
export function findAssetReferences(
  project: EditorProject,
  assetId: string,
): string[] {
  const references: string[] = [];
  if (project.manifest.default_font === assetId)
    references.push("manifest / default_font");
  if (["gui.dialogue_box", "gui.name_box", "sfx.typing"].includes(assetId))
    references.push("runtime / implicit asset");
  for (const scene of project.scenes) {
    for (const [nodeId, node] of Object.entries(scene.definition.nodes)) {
      if (nodeReferencesAsset(node, assetId))
        references.push(`${scene.definition.id}/${nodeId}`);
    }
  }
  for (const file of project.buttons ?? []) {
    for (const [state, id] of [
      ["normal", file.definition.normal],
      ["hover", file.definition.hover],
      ["pressed", file.definition.pressed],
    ] as const) {
      if (id === assetId)
        references.push(`button-template:${file.definition.id}/${state}`);
    }
  }
  for (const file of project.animations ?? []) {
    for (const [index, frame] of file.definition.frames.entries()) {
      if (frame.asset === assetId)
        references.push(`帧动画:${file.definition.id} / 第 ${index + 1} 帧`);
    }
  }
  const map = project.chapter_map?.definition;
  if (map?.background === assetId) references.push("chapter-map / 背景");
  for (const decoration of map?.decorations ?? []) {
    if (decoration.asset === assetId)
      references.push(`chapter-map / decoration:${decoration.id}`);
  }
  for (const hotspot of map?.hotspots ?? []) {
    if (hotspot.asset === assetId)
      references.push(`chapter-map / hotspot:${hotspot.id}`);
  }
  return references;
}

function nodeReferencesAsset(node: SceneNode, assetId: string): boolean {
  switch (node.type) {
    case "background":
      return node.background === assetId;
    case "sprite":
      return node.asset === assetId;
    case "long_text":
      return node.paper === assetId;
    case "bgm":
      return node.asset === assetId;
    case "sfx":
      return node.asset === assetId;
    case "timeline":
      return (
        node.tracks.some(
          (track) =>
            (track.type === "sprite" || track.type === "video") &&
            track.asset === assetId,
        ) ||
        node.events.some(
          (event) => event.type === "sfx" && event.asset === assetId,
        )
      );
    case "button_create":
    case "button_update":
      return false;
    default:
      return false;
  }
}
