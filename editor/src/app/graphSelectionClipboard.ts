import {
  canonicalizeGroupSelection,
  groupChildGroupIds,
  groupNodeIds,
  nextGroupId,
  normalizeSceneGroups,
} from "../components/graphGroups";
import {
  outputPorts,
  preparePastedNode,
  remapCopiedEmitterInstances,
  setPortTarget,
  uniqueNodeId,
} from "../story";
import {
  effectReferences,
  setEffectReferenceTarget,
} from "../windowInteraction";
import type {
  ButtonFile,
  ContentManifest,
  GroupChildRef,
  NodePosition,
  SceneDefinition,
  SceneGroup,
  SceneLayout,
  SceneNode,
} from "../types";

/** A detached, reusable graph selection; nothing here is an Immer draft. */
export interface GraphSelectionClipboard {
  sourceSceneId: string;
  roots: GroupChildRef[];
  nodes: Record<string, SceneNode>;
  positions: Record<string, NodePosition>;
  groups: SceneGroup[];
  sourceCharacterIds: Record<string, string | null>;
}

export function captureGraphSelection(
  scene: SceneDefinition,
  layout: SceneLayout | undefined,
  selection: readonly GroupChildRef[],
  manifest: ContentManifest,
): GraphSelectionClipboard | null {
  const groups = normalizeSceneGroups(
    layout?.groups,
    new Set(Object.keys(scene.nodes)),
  );
  const roots = canonicalizeGroupSelection(groups, selection).filter((ref) =>
    "node" in ref
      ? scene.nodes[ref.node] !== undefined
      : groups.some((group) => group.id === ref.group),
  );
  if (roots.length === 0) return null;
  const includedGroups = new Set<string>();
  const includedNodes = new Set<string>();
  for (const ref of roots) {
    if ("node" in ref) includedNodes.add(ref.node);
    else {
      includedGroups.add(ref.group);
      for (const id of groupChildGroupIds(groups, ref.group))
        includedGroups.add(id);
      for (const id of groupNodeIds(groups, ref.group)) includedNodes.add(id);
    }
  }
  const nodes: Record<string, SceneNode> = {};
  const positions: Record<string, NodePosition> = {};
  const sourceCharacterIds: Record<string, string | null> = {};
  Object.entries(scene.nodes).forEach(([id, node], index) => {
    if (!includedNodes.has(id)) return;
    nodes[id] = structuredClone(node);
    positions[id] = {
      ...(layout?.nodes[id] ?? {
        x: (index % 4) * 320,
        y: Math.floor(index / 4) * 220,
      }),
    };
    sourceCharacterIds[id] =
      node.type === "say" &&
      node.speaker !== null &&
      manifest.characters[node.speaker] !== undefined
        ? node.speaker
        : null;
  });
  return {
    sourceSceneId: scene.id,
    roots: structuredClone(roots),
    nodes,
    positions,
    groups: structuredClone(
      groups.filter((group) => includedGroups.has(group.id)),
    ),
    sourceCharacterIds,
  };
}

export interface PlacedGraphSelection {
  nodes: Record<string, SceneNode>;
  positions: Record<string, NodePosition>;
  /** The entire destination forest, including the newly copied groups. */
  groups: SceneGroup[];
  /** Newly copied top-level entities to select after duplication. */
  roots: GroupChildRef[];
  copiedGroupCount: number;
}

/** Clone once and remap internal ports without changing references outside the selection. */
export function placeGraphSelection(
  clipboard: GraphSelectionClipboard,
  scene: SceneDefinition,
  layout: SceneLayout | undefined,
  destination: NodePosition,
  mode: "duplicate" | "paste",
  manifest: ContentManifest,
  buttons: readonly ButtonFile[] = [],
  scenes: readonly SceneDefinition[] = [scene],
): PlacedGraphSelection {
  const allocated = { ...scene, nodes: { ...scene.nodes } };
  const nodeIds = new Map<string, string>();
  for (const [id, node] of Object.entries(clipboard.nodes)) {
    const next = uniqueNodeId(allocated, `${id}_copy`);
    nodeIds.set(id, next);
    allocated.nodes[next] = node;
  }
  const sourcePositions = Object.values(clipboard.positions);
  const minX = Math.min(...sourcePositions.map((position) => position.x));
  const minY = Math.min(...sourcePositions.map((position) => position.y));
  const positions: Record<string, NodePosition> = {};
  const nodes: Record<string, SceneNode> = {};
  for (const [id, source] of Object.entries(clipboard.nodes)) {
    const nextId = nodeIds.get(id);
    if (nextId === undefined) continue;
    const sourcePosition = clipboard.positions[id];
    positions[nextId] =
      mode === "duplicate"
        ? { x: sourcePosition.x + 48, y: sourcePosition.y + 48 }
        : {
            x: destination.x + sourcePosition.x - minX,
            y: destination.y + sourcePosition.y - minY,
          };
    let node =
      mode === "duplicate"
        ? structuredClone(source)
        : preparePastedNode(
            source,
            manifest,
            clipboard.sourceCharacterIds[id] ?? null,
            buttons,
          );
    for (const port of outputPorts(source)) {
      if (
        port.targetScene !== null &&
        port.targetScene !== clipboard.sourceSceneId
      )
        continue;
      const copiedTarget = nodeIds.get(port.target);
      if (copiedTarget !== undefined)
        node = setPortTarget(node, port.id, copiedTarget);
    }
    // Timer effect targets follow the copied effect node when it is part of
    // the selection; otherwise a duplicate keeps pointing at the original
    // (same Scene) and a paste has already cleared it.
    for (const reference of effectReferences(source)) {
      const copiedTarget = nodeIds.get(reference.target);
      if (copiedTarget !== undefined)
        node = setEffectReferenceTarget(node, reference.id, copiedTarget);
    }
    nodes[nextId] = node;
  }
  remapCopiedEmitterInstances(Object.values(nodes), scenes);
  const groups = normalizeSceneGroups(
    layout?.groups,
    new Set(Object.keys(scene.nodes)),
  );
  const groupIds = new Map<string, string>();
  for (const group of clipboard.groups) {
    const id = nextGroupId(groups);
    groupIds.set(group.id, id);
    groups.push({ id, children: [] });
  }
  const remap = (ref: GroupChildRef): GroupChildRef =>
    "node" in ref
      ? { node: nodeIds.get(ref.node) ?? ref.node }
      : { group: groupIds.get(ref.group) ?? ref.group };
  for (const source of clipboard.groups) {
    const destinationGroup = groups.find(
      (group) => group.id === groupIds.get(source.id),
    );
    if (destinationGroup !== undefined)
      destinationGroup.children = source.children.map(remap);
  }
  return {
    nodes,
    positions,
    groups,
    roots: clipboard.roots.map(remap),
    copiedGroupCount: clipboard.groups.length,
  };
}
