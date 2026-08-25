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
  useState,
  type ReactElement,
} from "react";
import { outputPorts } from "../story";
import type {
  EditorDiagnostic,
  NodePosition,
  SceneDefinition,
  SceneLayout,
} from "../types";
import { StoryNodeCard, type StoryFlowNode } from "./StoryNode";

const nodeTypes = { story: StoryNodeCard };

interface StoryGraphProps {
  scene: SceneDefinition;
  layout: SceneLayout | undefined;
  diagnostics: EditorDiagnostic[];
  selectedNodeId: string | null;
  onSelect(nodeId: string | null): void;
  onConnect(sourceId: string, handle: string, targetId: string): void;
  onMoveNode(nodeId: string, position: NodePosition): void;
  onMoveMany(positions: Record<string, NodePosition>): void;
  onViewport(viewport: Viewport): void;
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
  onConnect,
  onMoveNode,
  onMoveMany,
  onViewport,
}: StoryGraphProps): ReactElement {
  const { fitView, setViewport } = useReactFlow<StoryFlowNode>();
  const issuesByNode = useMemo(() => {
    const result = new Map<string, number>();
    for (const issue of diagnostics) {
      if (issue.scene_id === scene.id && issue.node_id !== null) {
        result.set(issue.node_id, (result.get(issue.node_id) ?? 0) + 1);
      }
    }
    return result;
  }, [diagnostics, scene.id]);

  const buildNodes = useCallback(
    (): StoryFlowNode[] =>
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
          onOpen: onSelect,
        },
      })),
    [issuesByNode, layout?.nodes, onSelect, scene, selectedNodeId],
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

  const [nodes, setNodes] = useState<StoryFlowNode[]>(buildNodes);
  const [edges, setEdges] = useState<Edge[]>(buildEdges);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setNodes(buildNodes()));
    return () => cancelAnimationFrame(frame);
  }, [buildNodes]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEdges(buildEdges()));
    return () => cancelAnimationFrame(frame);
  }, [buildEdges]);
  useEffect(() => {
    const viewport = layout?.viewport;
    if (viewport !== null && viewport !== undefined) {
      void setViewport(viewport, { duration: 0 });
    } else {
      requestAnimationFrame(
        () => void fitView({ padding: 0.2, duration: 250 }),
      );
    }
  }, [fitView, layout?.viewport, scene.id, setViewport]);

  const handleNodesChange = (changes: NodeChange<StoryFlowNode>[]): void => {
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
  const handleNodeClick: NodeMouseHandler<StoryFlowNode> = (_event, node) => {
    onSelect(node.id);
  };

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
    <div className="graph-shell">
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
      <ReactFlow<StoryFlowNode>
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
        onPaneClick={() => onSelect(null)}
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
    </div>
  );
}
