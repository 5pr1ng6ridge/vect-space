import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type NodeMouseHandler,
  type Viewport,
} from "@xyflow/react";
import {
  ChevronDown,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Flag,
  Group,
  Maximize,
  PanelRightOpen,
  Play,
  Plus,
  Trash2,
  Ungroup,
  Workflow,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";

import { describeNode } from "../nodeSummary";
import {
  canonicalizeGroupSelection,
  createParentGroup,
  dissolveGroup,
  groupNodeIds,
  moveGroupChildUpOneLevel,
  nestedGroupBounds,
  nestedGroupedLayout,
  normalizeSceneGroups,
} from "./graphGroups";
import { outputPorts, type InsertSide } from "../story";
import { nodeTypeEntries } from "./nodeTypeMenu";
import type {
  ContentManifest,
  EditorDiagnostic,
  GroupChildRef,
  NodePosition,
  NodeType,
  SceneDefinition,
  SceneGroup,
  SceneLayout,
} from "../types";
import { Button, IconButton } from "../ui/Button";
import { ContextMenuArea, DropdownMenu, type MenuItemSpec } from "../ui/Menu";
import {
  imeState,
  isInteractiveTarget,
  shouldIgnoreNodeDeletion,
} from "./nodeDeleteShortcut";
import { StoryNodeCard, type StoryGraphNode } from "./StoryNode";

const nodeTypes = { story: StoryNodeCard };

export interface StoryGraphProps {
  scene: SceneDefinition;
  layout: SceneLayout | undefined;
  diagnostics: EditorDiagnostic[];
  /** Used to show character display names in node summaries. */
  manifest?: ContentManifest;
  selectedNodeId: string | null;
  onSelect(nodeId: string | null): void;
  /** Open the dedicated workspace of a timeline / long-text node. */
  onOpen(nodeId: string): void;
  /** Open the live gameplay preview starting from this node. */
  onPreview(nodeId: string): void;
  /** Double-click on an ordinary node: move focus to its inspector. */
  onEditNode?(nodeId: string): void;
  onConnect(sourceId: string, handle: string, targetId: string): void;
  onCopy(nodeId: string): void;
  /** Copy a multi-selection or an entire nested group into the graph clipboard. */
  onCopySelection?(selection: readonly GroupChildRef[]): void;
  /** Delete the selected node through the App confirmation/undo pipeline. */
  onDelete(nodeId: string): void;
  onDuplicate?(nodeId: string): void;
  /** Return newly cloned roots so the canvas can select the batch. */
  onDuplicateSelection?(selection: readonly GroupChildRef[]): GroupChildRef[];
  onSetEntry?(nodeId: string): void;
  /** True while an App-level dialog or entry overlay owns the interaction. */
  deleteDisabled?: boolean;
  onMoveNode(nodeId: string, position: NodePosition): void;
  /**
   * Commit a batch of node positions.  The map is **partial**: it may only
   * name the nodes a gesture moved (a group drag sends its descendants), so
   * the App merges it into the scene layout and never replaces the whole
   * `SceneLayout.nodes` map.
   */
  onMoveMany(positions: Record<string, NodePosition>): void;
  onSetGroups(groups: SceneGroup[]): void;
  onPaste(position: NodePosition): void;
  onViewport(viewport: Viewport): void;
  onQuickInsert(nodeId: string, side: InsertSide, type: NodeType): void;
  /** Create an unconnected node at a flow position. */
  onAddNode?(type: NodeType, position: NodePosition): void;
}

export function StoryGraph(props: StoryGraphProps): ReactElement {
  return (
    <ReactFlowProvider>
      <StoryGraphInner {...props} />
    </ReactFlowProvider>
  );
}

interface MenuTarget {
  nodeId: string | null;
  groupId: string | null;
  position: NodePosition;
}

/** One selected canvas entity: a node card or a group frame. */
type EntityRef = GroupChildRef;

function refKey(ref: EntityRef): string {
  return "node" in ref ? `node:${ref.node}` : `group:${ref.group}`;
}

function groupMenuEntry(
  canWrap: boolean,
  canUngroup: boolean,
  disabled: boolean,
  onSelect: () => void,
): MenuItemSpec {
  return {
    id: "group-selection",
    label: canUngroup ? "解散此组" : "将所选项组成父组",
    icon: canUngroup ? Ungroup : Group,
    shortcut: "Ctrl+Shift+L",
    disabled: disabled || (!canWrap && !canUngroup),
    hint: "请先多选至少两个节点或组",
    onSelect,
  };
}

interface GroupDrag {
  groupId: string;
  pointerId: number;
  origin: NodePosition;
  /** Positions of every descendant node when the drag started. */
  base: Record<string, NodePosition>;
}

/** Snap a group drag delta to the 16px card grid. */
function snapGroupDelta(
  origin: NodePosition,
  pointer: NodePosition,
): NodePosition {
  return {
    x: Math.round((pointer.x - origin.x) / 16) * 16,
    y: Math.round((pointer.y - origin.y) / 16) * 16,
  };
}

/** Absolute positions of the dragged descendants at a given snapped delta. */
function groupDragPositions(
  drag: GroupDrag,
  delta: NodePosition,
): Map<string, NodePosition> {
  const moved = new Map<string, NodePosition>();
  for (const [id, position] of Object.entries(drag.base))
    moved.set(id, { x: position.x + delta.x, y: position.y + delta.y });
  return moved;
}

/** Apply a partial position map to the locally rendered React Flow nodes. */
function applyPositions(
  nodes: StoryGraphNode[],
  moved: Map<string, NodePosition>,
): StoryGraphNode[] {
  return nodes.map((node) => {
    const position = moved.get(node.id);
    return position === undefined ? node : { ...node, position };
  });
}

/**
 * ELK layout runs are guarded by a monotonic token.  The helpers keep the
 * token access out of render-reachable code (only event handlers and effects
 * touch the ref), so a stale async result can never move nodes after the scene
 * changed or after a newer run started.
 */
function beginLayoutRun(ref: { current: number }): number {
  ref.current += 1;
  return ref.current;
}

function layoutRunIsCurrent(ref: { current: number }, token: number): boolean {
  return ref.current === token;
}

function StoryGraphInner({
  scene,
  layout,
  diagnostics,
  manifest,
  selectedNodeId,
  onSelect,
  onOpen,
  onPreview,
  onEditNode,
  onConnect,
  onCopy,
  onCopySelection,
  onDelete,
  onDuplicate,
  onDuplicateSelection,
  onSetEntry,
  deleteDisabled = false,
  onMoveNode,
  onMoveMany,
  onSetGroups,
  onPaste,
  onViewport,
  onQuickInsert,
  onAddNode,
}: StoryGraphProps): ReactElement {
  const { fitView, getNodes, screenToFlowPosition, setViewport } =
    useReactFlow<StoryGraphNode>();
  const graphShellRef = useRef<HTMLDivElement>(null);
  // Kept in state as well so render-time menu builders never read a ref.
  const [shellElement, setShellElement] = useState<HTMLDivElement | null>(null);
  const lastPointerRef = useRef({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  });
  const [menuTarget, setMenuTarget] = useState<MenuTarget>({
    nodeId: null,
    groupId: null,
    position: { x: 0, y: 0 },
  });
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [selection, setSelectionState] = useState<EntityRef[]>(() =>
    selectedNodeId === null ? [] : [{ node: selectedNodeId }],
  );
  const selectionRef = useRef<EntityRef[]>(selection);
  const setSelection = useCallback((next: EntityRef[]): void => {
    selectionRef.current = next;
    setSelectionState(next);
  }, []);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);
  const selectedNodeIdRef = useRef(selectedNodeId);
  // Synced in an effect (not during render) and declared before the scene
  // reset below, so a scene switch reads the freshly committed focus.
  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
  }, [selectedNodeId]);
  // A scene switch resets the canvas selection.  The App's inspector focus is
  // intentionally *not* a dependency: an additive Ctrl/Shift selection (and a
  // group selection, which reports `null` back to the App) must survive it.
  useEffect(() => {
    const focused = selectedNodeIdRef.current;
    setSelection(focused === null ? [] : [{ node: focused }]);
  }, [scene.id, setSelection]);
  // When the App focuses a node on its own (duplicate, paste, insert), mirror
  // it so Delete keeps targeting the node the author is looking at.
  useEffect(() => {
    if (selectedNodeId === null) return;
    const current = selectionRef.current;
    if (
      current.length === 1 &&
      "node" in current[0] &&
      current[0].node === selectedNodeId
    )
      return;
    setSelection([{ node: selectedNodeId }]);
  }, [scene.id, selectedNodeId, setSelection]);
  // Drop selection entries whose node no longer exists (e.g. after a delete).
  useEffect(() => {
    const current = selectionRef.current;
    const pruned = current.filter(
      (ref) => "group" in ref || scene.nodes[ref.node] !== undefined,
    );
    if (pruned.length !== current.length) setSelection(pruned);
  }, [scene, setSelection]);
  const issuesByNode = useMemo(() => {
    const result = new Map<string, number>();
    for (const issue of diagnostics) {
      if (issue.scene_id === scene.id && issue.node_id !== null) {
        result.set(issue.node_id, (result.get(issue.node_id) ?? 0) + 1);
      }
    }
    return result;
  }, [diagnostics, scene.id]);

  const nodeIdSet = useMemo(
    () => new Set(Object.keys(scene.nodes)),
    [scene.nodes],
  );
  const groups = useMemo(
    () => normalizeSceneGroups(layout?.groups, nodeIdSet),
    [layout?.groups, nodeIdSet],
  );
  const selectionKeys = useMemo(
    () => new Set(selection.map((ref) => refKey(ref))),
    [selection],
  );

  const activate = useCallback(
    (nodeId: string): void => {
      const type = scene.nodes[nodeId]?.type;
      if (type === "timeline" || type === "long_text") onOpen(nodeId);
      else onEditNode?.(nodeId);
    },
    [onEditNode, onOpen, scene.nodes],
  );

  const insertEntries = useCallback(
    (nodeId: string, side: InsertSide): MenuItemSpec[] =>
      nodeTypeEntries((type) => onQuickInsert(nodeId, side, type)),
    [onQuickInsert],
  );

  const buildNodes = useCallback(
    (): StoryGraphNode[] =>
      Object.entries(scene.nodes).map(([nodeId, node], index) => ({
        id: nodeId,
        type: "story",
        position: layout?.nodes[nodeId] ?? {
          x: (index % 4) * 320,
          y: Math.floor(index / 4) * 220,
        },
        selected: selectionKeys.has(`node:${nodeId}`),
        dragHandle: ".node-drag-handle",
        data: {
          nodeId,
          node,
          description: describeNode(node, { manifest }),
          entry: scene.entry === nodeId,
          issueCount: issuesByNode.get(nodeId) ?? 0,
          onActivate: activate,
          onSelect,
          insertEntries,
        },
      })),
    [
      activate,
      insertEntries,
      issuesByNode,
      layout?.nodes,
      manifest,
      onSelect,
      scene,
      selectionKeys,
    ],
  );

  const buildEdges = useCallback((): Edge[] => {
    const edges: Edge[] = [];
    for (const [sourceId, node] of Object.entries(scene.nodes)) {
      for (const port of outputPorts(node)) {
        if (port.targetScene !== null && port.targetScene !== scene.id)
          continue;
        if (scene.nodes[port.target] === undefined) continue;
        const branch = port.id !== "next";
        edges.push({
          id: `${sourceId}:${port.id}`,
          source: sourceId,
          sourceHandle: port.id,
          target: port.target,
          label: branch ? port.label : undefined,
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          className: `story-edge${branch ? " story-edge-branch" : ""}`,
          labelBgPadding: [6, 3],
          labelBgBorderRadius: 4,
        });
      }
    }
    return edges;
  }, [scene]);

  const [nodes, setNodes] = useState<StoryGraphNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const nodesRef = useRef<StoryGraphNode[]>(nodes);
  // Click selection is owned by this pane; only a Shift marquee may import
  // React Flow's `select` changes into that same selection model.
  const marqueeActiveRef = useRef(false);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // Frame geometry is measured from the live card rects, so the empty first
  // render simply produces no frames.
  const graphItems = useMemo(
    () =>
      nodes.map((node) => ({
        id: node.id,
        position: node.position,
        width: node.measured?.width ?? 248,
        height: node.measured?.height ?? 120,
      })),
    [nodes],
  );
  const frames = useMemo(
    () => nestedGroupBounds(graphItems, groups),
    [graphItems, groups],
  );
  // Parents first so a child frame's border/header wins the pointer above it.
  const orderedGroups = useMemo(() => {
    const parentOf = new Map<string, string>();
    for (const group of groups) {
      for (const ref of group.children) {
        if ("group" in ref) parentOf.set(ref.group, group.id);
      }
    }
    const depth = new Map<string, number>();
    const depthOf = (id: string): number => {
      const cached = depth.get(id);
      if (cached !== undefined) return cached;
      const parent = parentOf.get(id);
      const value = parent === undefined ? 0 : depthOf(parent) + 1;
      depth.set(id, value);
      return value;
    };
    return [...groups].sort((a, b) => depthOf(a.id) - depthOf(b.id));
  }, [groups]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setNodes(buildNodes()));
    return () => cancelAnimationFrame(frame);
  }, [buildNodes]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEdges(buildEdges()));
    return () => cancelAnimationFrame(frame);
  }, [buildEdges]);
  useEffect(() => {
    if (nodes.length === 0) return;
    const viewport = layout?.viewport;
    if (viewport !== null && viewport !== undefined) {
      void setViewport(viewport, { duration: 0 });
    } else {
      requestAnimationFrame(
        () => void fitView({ padding: 0.2, duration: 250, maxZoom: 1 }),
      );
    }
  }, [fitView, layout?.viewport, nodes.length, scene.id, setViewport]);

  const handleNodesChange = (changes: NodeChange<StoryGraphNode>[]): void => {
    // Keep click and frame selection under our control.  During a Shift
    // marquee, adopt React Flow's selection changes so Ctrl+L/context menus
    // see the same nodes that the rectangle highlighted.
    const accepted = marqueeActiveRef.current
      ? changes
      : changes.filter((change) => change.type !== "select");
    if (
      marqueeActiveRef.current &&
      accepted.some((change) => change.type === "select")
    ) {
      const updated = applyNodeChanges(accepted, nodesRef.current);
      nodesRef.current = updated;
      const selected = updated
        .filter((node) => node.selected)
        .map((node) => ({ node: node.id }));
      setSelection(selected);
      onSelect(selected.length === 1 ? selected[0].node : null);
    }
    setNodes((current) => applyNodeChanges(accepted, current));
  };
  const handleEdgesChange = (changes: EdgeChange<Edge>[]): void => {
    setEdges((current) => applyEdgeChanges(changes, current));
  };
  const handleConnect = (connection: Connection): void => {
    if (
      connection.source !== null &&
      connection.target !== null &&
      connection.sourceHandle !== null
    ) {
      onConnect(connection.source, connection.sourceHandle, connection.target);
    }
  };

  /** The node the inspector should follow, or `null` for group/multi selects. */
  const focusedNodeOf = (entities: EntityRef[]): string | null =>
    entities.length === 1 && "node" in entities[0] ? entities[0].node : null;

  const focusShell = useCallback((): void => {
    // A toolbar button remains inside the pane but is an interactive target;
    // it must relinquish focus after a node/group is selected so shortcuts work.
    graphShellRef.current?.focus();
  }, []);

  /** Toggle `ref` in the canvas selection, replacing it when not additive. */
  const selectEntity = useCallback(
    (ref: EntityRef, additive: boolean): EntityRef[] => {
      const key = refKey(ref);
      const current = selectionRef.current;
      const next = additive
        ? current.some((entry) => refKey(entry) === key)
          ? current.filter((entry) => refKey(entry) !== key)
          : [...current, ref]
        : [ref];
      setSelection(next);
      return next;
    },
    [setSelection],
  );

  const handleNodeClick: NodeMouseHandler<StoryGraphNode> = (event, node) => {
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const next = selectEntity({ node: node.id }, additive);
    onSelect(focusedNodeOf(next));
    focusShell();
  };

  /** Every scene node under a group frame, recursively. */
  const groupNodeSelection = (groupId: string): string[] =>
    groupNodeIds(groups, groupId).filter((id) => scene.nodes[id] !== undefined);

  const dragRef = useRef<GroupDrag | null>(null);

  const selectGroup = (
    event: ReactPointerEvent<HTMLDivElement>,
    groupId: string,
    additive: boolean,
  ): EntityRef[] => {
    event.preventDefault();
    event.stopPropagation();
    const next = selectEntity({ group: groupId }, additive);
    onSelect(focusedNodeOf(next));
    focusShell();
    return next;
  };

  const handleGroupHeaderPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    groupId: string,
  ): void => {
    if (event.button !== 0) return;
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    selectGroup(event, groupId, additive);
    if (additive) return;
    // Arm one rigid drag: all descendant nodes move by the same snapped delta.
    const origin = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const base: Record<string, NodePosition> = {};
    for (const id of groupNodeSelection(groupId)) {
      const node = nodesRef.current.find((candidate) => candidate.id === id);
      if (node !== undefined) base[id] = { ...node.position };
    }
    dragRef.current = {
      groupId,
      pointerId: event.pointerId,
      origin,
      base,
    };
    const element = event.currentTarget;
    if (typeof element.setPointerCapture === "function")
      element.setPointerCapture(event.pointerId);
  };

  /** Release pointer capture if the environment implements it (jsdom does not). */
  const releaseGroupPointer = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const element = event.currentTarget;
    if (
      typeof element.hasPointerCapture === "function" &&
      element.hasPointerCapture(event.pointerId) &&
      typeof element.releasePointerCapture === "function"
    ) {
      element.releasePointerCapture(event.pointerId);
    }
  };

  const handleGroupPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    // Always derive from the drag baseline, including a zero delta: dragging
    // out and back to the origin must restore the original positions rather
    // than leave the nodes at the last non-zero offset.
    const delta = snapGroupDelta(
      drag.origin,
      screenToFlowPosition({ x: event.clientX, y: event.clientY }),
    );
    const moved = groupDragPositions(drag, delta);
    setNodes((current) => applyPositions(current, moved));
  };

  /** Pointer-up: commit the final snapped delta once (or restore on a no-op). */
  const endGroupDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    releaseGroupPointer(event);
    // Read the final delta from this event, not from a possibly batched
    // pointermove or from the rendered node state.
    const delta = snapGroupDelta(
      drag.origin,
      screenToFlowPosition({ x: event.clientX, y: event.clientY }),
    );
    const moved = groupDragPositions(drag, delta);
    if (delta.x === 0 && delta.y === 0) {
      // Out-and-back (or a plain header click): ensure the baseline is shown
      // and commit nothing.
      setNodes((current) => applyPositions(current, moved));
      return;
    }
    setNodes((current) => applyPositions(current, moved));
    // Partial batch: only the dragged descendants.  App merges it into the
    // scene layout, so unrelated node/group positions are preserved.
    onMoveMany(Object.fromEntries(moved));
  };

  /** Cancelled gesture: restore the baseline and never commit. */
  const cancelGroupDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    releaseGroupPointer(event);
    setNodes((current) =>
      applyPositions(current, groupDragPositions(drag, { x: 0, y: 0 })),
    );
  };

  const selectedForGrouping = (entities: EntityRef[]): EntityRef[] =>
    canonicalizeGroupSelection(
      groups,
      entities.filter((ref) =>
        "node" in ref
          ? scene.nodes[ref.node] !== undefined
          : groups.some((group) => group.id === ref.group),
      ),
    );

  /** Shared by keyboard and context menu; returns false for an ineligible selection. */
  const applyGrouping = (canonical: EntityRef[]): boolean => {
    if (deleteDisabled) return false;
    if (canonical.length >= 2) {
      const previousIds = new Set(groups.map((group) => group.id));
      const next = createParentGroup(groups, canonical, nodeIdSet);
      const parent = next.find((group) => !previousIds.has(group.id));
      setSelectionState(parent === undefined ? [] : [{ group: parent.id }]);
      onSetGroups(next);
      return true;
    }
    const single = canonical[0];
    if (canonical.length === 1 && single !== undefined && "group" in single) {
      const target = groups.find((group) => group.id === single.group);
      const next = dissolveGroup(groups, single.group, nodeIdSet);
      setSelectionState(target === undefined ? [] : [...target.children]);
      onSetGroups(next);
      return true;
    }
    return false;
  };

  /**
   * Delete remains pane-scoped. Grouping is registered at window capture phase
   * below, because React Flow can own the focused inner node or marquee and
   * stop its bubbled key event before it reaches this shell.
   */
  const handleGraphKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.key !== "Delete" || event.defaultPrevented) return;
    if (deleteDisabled) return;
    if (
      shouldIgnoreNodeDeletion({
        target: event.target,
        repeat: event.repeat,
        ...imeState(event),
      }) ||
      isInteractiveTarget(event.target)
    ) {
      return;
    }
    const selectedGroups = selectionRef.current.filter(
      (ref): ref is { group: string } =>
        "group" in ref && groups.some((group) => group.id === ref.group),
    );
    if (selectedGroups.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const selectedNodes = selectionRef.current.filter(
      (ref): ref is { node: string } =>
        "node" in ref && scene.nodes[ref.node] !== undefined,
    );
    if (selectedNodes.length !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    onDelete(selectedNodes[0].node);
  };

  useEffect(() => {
    const handleClipboardShortcut = (event: KeyboardEvent): void => {
      const shell = graphShellRef.current;
      const target = event.target;
      if (
        shell === null ||
        (!(target instanceof Node && shell.contains(target)) &&
          !(
            target === document.body && document.activeElement === document.body
          ))
      )
        return;
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "l"
      ) {
        if (
          // The Tauri browser guard prevents the native Ctrl+L address-bar
          // action before this window listener runs. It deliberately keeps
          // propagation alive for the graph, so defaultPrevented is expected.
          deleteDisabled ||
          event.repeat ||
          shouldIgnoreNodeDeletion({
            target,
            repeat: event.repeat,
            isComposing: event.isComposing,
            keyCode: imeState({ nativeEvent: event }).keyCode,
          }) ||
          isInteractiveTarget(target)
        )
          return;
        if (applyGrouping(selectedForGrouping(selectionRef.current))) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.defaultPrevented) return;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "enter" && selectedNodeId !== null) {
        event.preventDefault();
        onPreview(selectedNodeId);
      } else if (key === "c") {
        const selected = selectedForGrouping(selectionRef.current);
        if (selected.length === 1 && "node" in selected[0]) {
          event.preventDefault();
          onCopy(selected[0].node);
        } else if (selected.length > 0 && onCopySelection !== undefined) {
          event.preventDefault();
          onCopySelection(selected);
        }
      } else if (key === "v") {
        event.preventDefault();
        onPaste(screenToFlowPosition(lastPointerRef.current));
      }
    };
    window.addEventListener("keydown", handleClipboardShortcut, true);
    return () =>
      window.removeEventListener("keydown", handleClipboardShortcut, true);
  });

  // A stale ELK callback must never move nodes after the scene changed or a
  // newer layout run started: bump the token on every run and on scene change.
  // The counter lives in a stable state object (an ordinary instance field)
  // rather than a ref, so render-reachable menu code never touches a ref.
  const [layoutRunStore] = useState(() => ({ current: 0 }));
  useEffect(
    () => () => {
      layoutRunStore.current += 1;
    },
    [layoutRunStore, scene.id],
  );

  const autoLayout = useCallback(async (): Promise<void> => {
    const token = beginLayoutRun(layoutRunStore);
    setLayoutBusy(true);
    try {
      const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
      if (!layoutRunIsCurrent(layoutRunStore, token)) return;
      const elk = new ELK();
      const graph = nestedGroupedLayout(
        nodes.map((node) => ({
          id: node.id,
          position: node.position,
          width: node.measured?.width ?? 248,
          height: node.measured?.height ?? 120,
        })),
        edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
        })),
        groups,
      );
      const result = await elk.layout({
        id: "root",
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": "RIGHT",
          "elk.spacing.nodeNode": "56",
          "elk.layered.spacing.nodeNodeBetweenLayers": "96",
          "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
          "elk.edgeRouting": "ORTHOGONAL",
        },
        children: graph.children,
        edges: graph.edges,
      });
      if (!layoutRunIsCurrent(layoutRunStore, token)) return;
      const positions: Record<string, NodePosition> = {};
      for (const child of result.children ?? []) {
        positions[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
      }
      onMoveMany(graph.expand(positions));
      requestAnimationFrame(
        () => void fitView({ padding: 0.18, duration: 350, maxZoom: 1 }),
      );
    } finally {
      if (layoutRunIsCurrent(layoutRunStore, token)) setLayoutBusy(false);
    }
  }, [edges, fitView, groups, layoutRunStore, nodes, onMoveMany]);

  /** Flow position at the centre of the visible canvas. */
  const viewportCentre = (): NodePosition => {
    const bounds = shellElement?.getBoundingClientRect();
    const centre =
      bounds === undefined
        ? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
        : {
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
          };
    const position = screenToFlowPosition(centre);
    // Offset by half a card so the new node lands centred.
    return { x: position.x - 124, y: position.y - 48 };
  };

  const canonicalForMenu = selectedForGrouping(selection);
  const copyEntities = (entities: EntityRef[]): void => {
    if (entities.length === 1 && "node" in entities[0])
      onCopy(entities[0].node);
    else if (entities.length > 0) onCopySelection?.(entities);
  };
  const duplicateEntities = (entities: EntityRef[]): void => {
    if (entities.length === 1 && "node" in entities[0]) {
      onDuplicate?.(entities[0].node);
    } else if (entities.length > 0 && onDuplicateSelection !== undefined) {
      const copiedRoots = onDuplicateSelection(entities);
      if (copiedRoots.length > 0) {
        setSelectionState(copiedRoots);
        onSelect(null);
      }
    }
  };
  const canWrap = canonicalForMenu.length >= 2;
  const canUngroup =
    canonicalForMenu.length === 1 && "group" in canonicalForMenu[0];
  const groupingEntry = groupMenuEntry(
    canWrap,
    canUngroup,
    deleteDisabled,
    () => {
      applyGrouping(canonicalForMenu);
    },
  );
  const menuEntity: EntityRef | null =
    menuTarget.nodeId !== null
      ? { node: menuTarget.nodeId }
      : menuTarget.groupId !== null
        ? { group: menuTarget.groupId }
        : null;
  const directOwner =
    menuEntity === null
      ? undefined
      : groups.find((group) =>
          group.children.some((ref) => refKey(ref) === refKey(menuEntity)),
        );
  const detachEntry: MenuItemSpec | null =
    menuEntity !== null &&
    directOwner !== undefined &&
    canonicalForMenu.length === 1 &&
    refKey(canonicalForMenu[0]) === refKey(menuEntity)
      ? {
          id: "move-up-one-level",
          label: "移出此组（上移一级）",
          icon: Ungroup,
          disabled: deleteDisabled,
          onSelect: () => {
            if (deleteDisabled) return;
            onSetGroups(
              moveGroupChildUpOneLevel(groups, menuEntity, nodeIdSet),
            );
          },
        }
      : null;

  const menuEntries = (): MenuItemSpec[] => {
    const { nodeId, position } = menuTarget;
    const node = nodeId === null ? undefined : scene.nodes[nodeId];
    if (nodeId === null || node === undefined) {
      const entries: MenuItemSpec[] = [];
      if (onAddNode !== undefined)
        entries.push({
          kind: "submenu",
          id: "add",
          label: "在此处添加节点",
          icon: Plus,
          entries: nodeTypeEntries((type) => onAddNode(type, position)),
        });
      entries.push(
        groupingEntry,
        ...(detachEntry === null ? [] : [detachEntry]),
        { kind: "separator", id: "sep-group" },
        ...(canonicalForMenu.length > 0 && onCopySelection !== undefined
          ? [
              {
                id: "copy-selection",
                label: "复制所选项",
                icon: Copy,
                shortcut: "Ctrl+C",
                onSelect: () => copyEntities(canonicalForMenu),
              } satisfies MenuItemSpec,
            ]
          : []),
        ...(canonicalForMenu.length > 0 && onDuplicateSelection !== undefined
          ? [
              {
                id: "duplicate-selection",
                label: "为所选项创建副本",
                icon: CopyPlus,
                onSelect: () => duplicateEntities(canonicalForMenu),
              } satisfies MenuItemSpec,
            ]
          : []),
        {
          id: "paste",
          label: "粘贴到此处",
          icon: ClipboardPaste,
          shortcut: "Ctrl+V",
          onSelect: () => onPaste(position),
        },
        { kind: "separator", id: "sep" },
        {
          id: "layout",
          label: "自动布局",
          icon: Workflow,
          onSelect: () => void autoLayout(),
        },
        {
          id: "fit",
          label: "适合画布",
          icon: Maximize,
          onSelect: () => void fitView({ padding: 0.2, duration: 250 }),
        },
      );
      return entries;
    }
    const entries: MenuItemSpec[] = [
      groupingEntry,
      ...(detachEntry === null ? [] : [detachEntry]),
      { kind: "separator", id: "sep-group" },
      {
        id: "preview",
        label: "从此处预览",
        icon: Play,
        shortcut: "Ctrl+Enter",
        onSelect: () => onPreview(nodeId),
      },
    ];
    if (node.type === "timeline" || node.type === "long_text")
      entries.push({
        id: "open",
        label:
          node.type === "timeline" ? "打开时间线工作区" : "打开长文本工作区",
        icon: PanelRightOpen,
        onSelect: () => onOpen(nodeId),
      });
    if (onSetEntry !== undefined)
      entries.push({
        id: "entry",
        label: "设为场景入口",
        icon: Flag,
        disabled: scene.entry === nodeId,
        hint: "已经是场景入口",
        onSelect: () => onSetEntry(nodeId),
      });
    entries.push(
      { kind: "separator", id: "sep-insert" },
      {
        kind: "submenu",
        id: "insert-before",
        label: "在前面插入",
        entries: insertEntries(nodeId, "left"),
      },
      {
        kind: "submenu",
        id: "insert-after",
        label: "在后面插入",
        entries: insertEntries(nodeId, "right"),
      },
      { kind: "separator", id: "sep-clipboard" },
      {
        id: "copy",
        label: "复制",
        icon: Copy,
        shortcut: "Ctrl+C",
        onSelect: () => copyEntities(canonicalForMenu),
      },
    );
    if (onDuplicate !== undefined || onDuplicateSelection !== undefined)
      entries.push({
        id: "duplicate",
        label: canonicalForMenu.length > 1 ? "为所选项创建副本" : "创建副本",
        icon: CopyPlus,
        onSelect: () => duplicateEntities(canonicalForMenu),
      });
    entries.push(
      { kind: "separator", id: "sep-delete" },
      {
        id: "delete",
        label: "删除",
        icon: Trash2,
        shortcut: "Delete",
        danger: true,
        disabled: deleteDisabled,
        onSelect: () => onDelete(nodeId),
      },
    );
    return entries;
  };

  return (
    <ContextMenuArea
      entries={menuEntries()}
      label={
        menuTarget.groupId !== null
          ? "布局组操作"
          : menuTarget.nodeId === null
            ? "画布操作"
            : "节点操作"
      }
      onOpen={(event) => {
        const element = event.target instanceof Element ? event.target : null;
        const nodeId =
          element?.closest<HTMLElement>(".react-flow__node")?.dataset.id ??
          null;
        const candidateGroupId =
          element?.closest<HTMLElement>(".story-group-frame")?.dataset
            .groupId ?? null;
        const groupId =
          candidateGroupId !== null &&
          groups.some((group) => group.id === candidateGroupId)
            ? candidateGroupId
            : null;
        const target =
          nodeId !== null
            ? { node: nodeId }
            : groupId !== null
              ? { group: groupId }
              : null;
        if (
          target !== null &&
          !selectionRef.current.some((ref) => refKey(ref) === refKey(target))
        ) {
          setSelection([target]);
          onSelect(nodeId);
        }
        // Right-clicking a selected member keeps the full multi-selection.
        setMenuTarget({
          nodeId,
          groupId,
          position: screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
          }),
        });
      }}
    >
      <div
        className="graph-shell"
        onKeyDown={handleGraphKeyDown}
        onPointerMove={(event) => {
          lastPointerRef.current = { x: event.clientX, y: event.clientY };
        }}
        ref={(element) => {
          graphShellRef.current = element;
          setShellElement(element);
        }}
        tabIndex={-1}
      >
        <div aria-label="剧情图工具" className="graph-toolbar" role="toolbar">
          {onAddNode !== undefined && (
            <DropdownMenu
              entries={nodeTypeEntries((type) =>
                onAddNode(type, viewportCentre()),
              )}
              label="添加节点"
              trigger={
                <Button
                  icon={Plus}
                  size="sm"
                  trailing={<ChevronDown aria-hidden="true" />}
                >
                  添加节点
                </Button>
              }
            />
          )}
          <IconButton
            disabled={deleteDisabled || (!canWrap && !canUngroup)}
            icon={canUngroup ? Ungroup : Group}
            label={canUngroup ? "解散此组" : "组合所选项"}
            onClick={() => {
              applyGrouping(selectedForGrouping(selectionRef.current));
              focusShell();
            }}
            size="sm"
          />
          <IconButton
            disabled={layoutBusy}
            icon={Workflow}
            label="自动布局"
            onClick={() => void autoLayout()}
            size="sm"
          />
          <IconButton
            icon={Maximize}
            label="适合画布"
            onClick={() => void fitView({ padding: 0.2, duration: 250 })}
            size="sm"
          />
        </div>
        <ReactFlow<StoryGraphNode>
          colorMode="dark"
          deleteKeyCode={null}
          edges={edges}
          fitViewOptions={{ padding: 0.2 }}
          maxZoom={1.8}
          minZoom={0.15}
          nodeTypes={nodeTypes}
          nodes={nodes}
          onConnect={handleConnect}
          onEdgesChange={handleEdgesChange}
          onMoveEnd={(event, viewport) => {
            if (event !== null) onViewport(viewport);
          }}
          onNodeClick={handleNodeClick}
          onNodeDragStop={(_event, node) => {
            const selectedNodes = selectionRef.current.filter(
              (ref): ref is { node: string } => "node" in ref,
            );
            if (selectedNodes.length < 2) {
              onMoveNode(node.id, node.position);
              return;
            }
            onMoveMany(
              Object.fromEntries(
                getNodes().map((current) => [
                  current.id,
                  current.id === node.id ? node.position : current.position,
                ]),
              ),
            );
          }}
          onNodesChange={handleNodesChange}
          onSelectionStart={() => {
            marqueeActiveRef.current = true;
            setSelection([]);
            onSelect(null);
          }}
          onSelectionEnd={() => {
            marqueeActiveRef.current = false;
            focusShell();
          }}
          onPaneClick={() => {
            setSelection([]);
            onSelect(null);
          }}
          proOptions={{ hideAttribution: true }}
          snapGrid={[16, 16]}
          snapToGrid
        >
          <ViewportPortal>
            {orderedGroups.map((group) => {
              const bounds = frames.get(group.id);
              if (bounds === undefined) return null;
              const selected = selectionKeys.has(`group:${group.id}`);
              return (
                <div
                  className={`story-group-frame${selected ? " is-selected" : ""}`}
                  data-group-id={group.id}
                  key={group.id}
                  style={{
                    transform: `translate(${bounds.x}px, ${bounds.y}px)`,
                    width: bounds.width,
                    height: bounds.height,
                  }}
                >
                  <div aria-hidden="true" className="story-group-border" />
                  <div
                    className="story-group-header nopan"
                    onPointerCancel={cancelGroupDrag}
                    onPointerDown={(event) =>
                      handleGroupHeaderPointerDown(event, group.id)
                    }
                    onPointerMove={handleGroupPointerMove}
                    onPointerUp={endGroupDrag}
                  >
                    {group.id}
                  </div>
                  {(["top", "right", "bottom", "left"] as const).map((side) => (
                    <div
                      aria-hidden="true"
                      className={`story-group-edge story-group-edge-${side} nopan`}
                      key={side}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        selectGroup(
                          event,
                          group.id,
                          event.ctrlKey || event.metaKey || event.shiftKey,
                        );
                      }}
                    />
                  ))}
                </div>
              );
            })}
          </ViewportPortal>
          <Background gap={24} size={1.2} variant={BackgroundVariant.Dots} />
          <MiniMap
            nodeBorderRadius={4}
            nodeClassName={(node) =>
              node.id === scene.entry ? "minimap-entry" : "minimap-node"
            }
            pannable
            zoomable
          />
          <Controls position="bottom-left" showInteractive={false} />
        </ReactFlow>
      </div>
    </ContextMenuArea>
  );
}
