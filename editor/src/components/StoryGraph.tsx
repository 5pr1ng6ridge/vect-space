import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import { NODE_TYPES, nodeLabel, outputPorts, type InsertSide } from "../story";
import {
  imeState,
  isInteractiveTarget,
  shouldIgnoreNodeDeletion,
} from "./nodeDeleteShortcut";
import type {
  EditorDiagnostic,
  NodePosition,
  NodeType,
  SceneDefinition,
  SceneLayout,
} from "../types";
import { StoryNodeCard, type StoryGraphNode } from "./StoryNode";

const nodeTypes = { story: StoryNodeCard };

export interface StoryGraphProps {
  scene: SceneDefinition;
  layout: SceneLayout | undefined;
  diagnostics: EditorDiagnostic[];
  selectedNodeId: string | null;
  onSelect(nodeId: string | null): void;
  onOpen(nodeId: string): void;
  /** Open the live gameplay preview starting from this node. */
  onPreview(nodeId: string): void;
  onConnect(sourceId: string, handle: string, targetId: string): void;
  onCopy(nodeId: string): void;
  /** Delete the selected node through the App confirmation/undo pipeline. */
  onDelete(nodeId: string): void;
  /** True while an App-level dialog or entry overlay owns the interaction. */
  deleteDisabled?: boolean;
  onMoveNode(nodeId: string, position: NodePosition): void;
  onMoveMany(positions: Record<string, NodePosition>): void;
  onPaste(position: NodePosition): void;
  onViewport(viewport: Viewport): void;
  onQuickInsert(nodeId: string, side: InsertSide, type: NodeType): void;
}

interface QuickInsertMenu {
  nodeId: string;
  side: InsertSide;
  x: number;
  y: number;
  clientX: number;
  clientY: number;
}

export function StoryGraph(props: StoryGraphProps): ReactElement {
  return (
    <ReactFlowProvider>
      <StoryGraphInner {...props} />
    </ReactFlowProvider>
  );
}

function StoryGraphInner({
  scene,
  layout,
  diagnostics,
  selectedNodeId,
  onSelect,
  onOpen,
  onPreview,
  onConnect,
  onCopy,
  onDelete,
  deleteDisabled = false,
  onMoveNode,
  onMoveMany,
  onPaste,
  onViewport,
  onQuickInsert,
}: StoryGraphProps): ReactElement {
  const { fitView, screenToFlowPosition, setViewport } =
    useReactFlow<StoryGraphNode>();
  const graphShellRef = useRef<HTMLDivElement>(null);
  const lastPointerRef = useRef({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  });
  const [quickInsertMenu, setQuickInsertMenu] =
    useState<QuickInsertMenu | null>(null);
  const issuesByNode = useMemo(() => {
    const result = new Map<string, number>();
    for (const issue of diagnostics) {
      if (issue.scene_id === scene.id && issue.node_id !== null) {
        result.set(issue.node_id, (result.get(issue.node_id) ?? 0) + 1);
      }
    }
    return result;
  }, [diagnostics, scene.id]);

  const openQuickInsertMenu = useCallback(
    (
      nodeId: string,
      side: InsertSide,
      clientX: number,
      clientY: number,
    ): void => {
      const bounds = graphShellRef.current?.getBoundingClientRect();
      const rawX = clientX - (bounds?.left ?? 0);
      const rawY = clientY - (bounds?.top ?? 0);
      const menuWidth = 264;
      const menuHeight = 500;
      const x = bounds
        ? Math.max(8, Math.min(rawX, bounds.width - menuWidth - 8))
        : rawX;
      const y = bounds
        ? Math.max(8, Math.min(rawY, bounds.height - menuHeight - 8))
        : rawY;
      lastPointerRef.current = { x: clientX, y: clientY };
      setQuickInsertMenu({ nodeId, side, x, y, clientX, clientY });
      onSelect(nodeId);
    },
    [onSelect],
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
        selected: nodeId === selectedNodeId,
        dragHandle: ".node-drag-handle",
        data: {
          nodeId,
          node,
          entry: scene.entry === nodeId,
          issueCount: issuesByNode.get(nodeId) ?? 0,
          onOpen,
          onPreview,
          onSelect,
          onQuickInsert: openQuickInsertMenu,
        },
      })),
    [
      issuesByNode,
      layout?.nodes,
      onSelect,
      onOpen,
      onPreview,
      openQuickInsertMenu,
      scene,
      selectedNodeId,
    ],
  );

  const buildEdges = useCallback((): Edge[] => {
    const edges: Edge[] = [];
    for (const [sourceId, node] of Object.entries(scene.nodes)) {
      for (const port of outputPorts(node)) {
        if (port.targetScene !== null && port.targetScene !== scene.id)
          continue;
        if (scene.nodes[port.target] === undefined) continue;
        edges.push({
          id: `${sourceId}:${port.id}`,
          source: sourceId,
          sourceHandle: port.id,
          target: port.target,
          label: port.label,
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          className: `story-edge story-edge-${node.type}`,
          labelStyle: { fill: "#aeb6cb", fontSize: 11 },
          labelBgStyle: { fill: "#151923", fillOpacity: 0.88 },
          labelBgPadding: [5, 3],
          labelBgBorderRadius: 4,
        });
      }
    }
    return edges;
  }, [scene]);

  const [nodes, setNodes] = useState<StoryGraphNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

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
        () => void fitView({ padding: 0.2, duration: 250 }),
      );
    }
  }, [fitView, layout?.viewport, nodes.length, scene.id, setViewport]);

  const handleNodesChange = (changes: NodeChange<StoryGraphNode>[]): void => {
    setNodes((current) => applyNodeChanges(changes, current));
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
  const handleNodeClick: NodeMouseHandler<StoryGraphNode> = (_event, node) => {
    setQuickInsertMenu(null);
    onSelect(node.id);
    // Delete is handled by this pane's own key listener, so keyboard focus has
    // to stay inside it.  React Flow already focuses the node itself; this is
    // the fallback for a click that did not move focus (canvas chrome, or a
    // browser that does not focus a tabbable ancestor on click).
    const shell = graphShellRef.current;
    if (shell !== null && !shell.contains(document.activeElement))
      shell.focus();
  };

  /**
   * Scoped node deletion.  Only `Delete` is a graph shortcut (Backspace never
   * deletes a node here), the handler is bound to the graph pane rather than the
   * window, and the selection change/deletion/undo work stays in
   * `App.deleteNode`.  An open quick-insert menu or App dialog disables it, and
   * editable, composing, auto-repeat and interactive focus is ignored, so a key
   * press can never delete twice or from another workspace.
   */
  const handleGraphKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.key !== "Delete") return;
    if (deleteDisabled || quickInsertMenu !== null) return;
    if (selectedNodeId === null || scene.nodes[selectedNodeId] === undefined)
      return;
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
    event.preventDefault();
    event.stopPropagation();
    onDelete(selectedNodeId);
  };

  useEffect(() => {
    if (quickInsertMenu === null) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setQuickInsertMenu(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [quickInsertMenu]);

  useEffect(() => {
    const handleClipboardShortcut = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "c" && selectedNodeId !== null) {
        event.preventDefault();
        onCopy(selectedNodeId);
      } else if (key === "v") {
        event.preventDefault();
        onPaste(screenToFlowPosition(lastPointerRef.current));
        setQuickInsertMenu(null);
      }
    };
    window.addEventListener("keydown", handleClipboardShortcut);
    return () => window.removeEventListener("keydown", handleClipboardShortcut);
  }, [onCopy, onPaste, screenToFlowPosition, selectedNodeId]);

  const autoLayout = async (): Promise<void> => {
    const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
    const elk = new ELK();
    const result = await elk.layout({
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.spacing.nodeNode": "72",
        "elk.layered.spacing.nodeNodeBetweenLayers": "120",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
        "elk.edgeRouting": "ORTHOGONAL",
      },
      children: nodes.map((node) => ({ id: node.id, width: 260, height: 150 })),
      edges: edges.map((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      })),
    });
    const positions: Record<string, NodePosition> = {};
    for (const child of result.children ?? []) {
      positions[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
    }
    onMoveMany(positions);
    requestAnimationFrame(() => void fitView({ padding: 0.18, duration: 350 }));
  };

  return (
    <div
      className="graph-shell"
      onKeyDown={handleGraphKeyDown}
      onPointerMove={(event) => {
        lastPointerRef.current = { x: event.clientX, y: event.clientY };
      }}
      ref={graphShellRef}
      tabIndex={-1}
    >
      <div className="graph-toolbar">
        <strong>{scene.id}</strong>
        <span>{Object.keys(scene.nodes).length} nodes</span>
        <button onClick={() => void autoLayout()} type="button">
          自动布局
        </button>
        <button
          onClick={() => void fitView({ padding: 0.2, duration: 250 })}
          type="button"
        >
          适合画布
        </button>
      </div>
      <ReactFlow<StoryGraphNode>
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
        onNodeDragStop={(_event, node) => onMoveNode(node.id, node.position)}
        onNodesChange={handleNodesChange}
        onPaneClick={() => {
          setQuickInsertMenu(null);
          onSelect(null);
        }}
        snapGrid={[16, 16]}
        snapToGrid
      >
        <Background color="#262b38" gap={24} size={1} />
        <MiniMap
          maskColor="rgba(8, 10, 15, 0.72)"
          nodeColor={(node) =>
            node.id === scene.entry ? "#68d7bb" : "#727d99"
          }
          pannable
          zoomable
        />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>
      {quickInsertMenu !== null && (
        <div
          className="quick-insert-menu"
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => event.stopPropagation()}
          role="menu"
          style={{ left: quickInsertMenu.x, top: quickInsertMenu.y }}
        >
          <header className="quick-insert-menu-header">
            <div>
              <strong>
                {quickInsertMenu.side === "left" ? "左侧" : "右侧"}插入节点
              </strong>
              <small>
                {nodeLabel(scene.nodes[quickInsertMenu.nodeId]?.type ?? "say")}{" "}
                · {quickInsertMenu.nodeId}
              </small>
            </div>
            <button
              aria-label="关闭插入菜单"
              onClick={() => setQuickInsertMenu(null)}
              type="button"
            >
              ×
            </button>
          </header>
          <div className="quick-insert-clipboard">
            <button
              onClick={() => {
                onCopy(quickInsertMenu.nodeId);
                setQuickInsertMenu(null);
              }}
              role="menuitem"
              type="button"
            >
              复制节点 <kbd>Ctrl+C</kbd>
            </button>
            <button
              onClick={() => {
                onPaste(
                  screenToFlowPosition({
                    x: quickInsertMenu.clientX,
                    y: quickInsertMenu.clientY,
                  }),
                );
                setQuickInsertMenu(null);
              }}
              role="menuitem"
              type="button"
            >
              粘贴到此处 <kbd>Ctrl+V</kbd>
            </button>
          </div>
          <div className="quick-insert-options">
            {NODE_TYPES.map((candidate) => (
              <button
                key={candidate.type}
                onClick={() => {
                  setQuickInsertMenu(null);
                  onQuickInsert(
                    quickInsertMenu.nodeId,
                    quickInsertMenu.side,
                    candidate.type,
                  );
                }}
                role="menuitem"
                type="button"
              >
                <span>{candidate.label}</span>
                <small>{candidate.group}</small>
              </button>
            ))}
          </div>
          <p>选择类型后会自动接管原有连线。</p>
        </div>
      )}
    </div>
  );
}
