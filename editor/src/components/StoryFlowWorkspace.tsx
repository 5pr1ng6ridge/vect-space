import {
  Background,
  ConnectionLineType,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  type ReactFlowInstance,
  ViewportPortal,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { ConditionEditor } from "./NodeInspector";
import { defaultCondition } from "../story";
import type {
  ContentManifest,
  StoryFlowDefinition,
  StoryFlowEdge,
  StoryFlowNode,
} from "../types";

const GRID = 20;
const WIDTH = 240;
const HEIGHT = 92;
const MAIN_AXIS_Y = 540;
const BRANCH_OFFSET = 240;

export function StoryFlowWorkspace({
  projectManifest,
  sceneIds,
  flow,
  dirty,
  initialSelectionId,
  onChange,
  onClose,
  onSave,
  onValidate,
  onUndo,
  onRedo,
  undoAvailable,
  redoAvailable,
}: {
  projectManifest: ContentManifest;
  sceneIds: string[];
  flow: StoryFlowDefinition;
  dirty: boolean;
  initialSelectionId: string | null;
  onChange(flow: StoryFlowDefinition): void;
  onClose(): void;
  onSave(): void;
  onValidate(): void;
  onUndo(): void;
  onRedo(): void;
  undoAvailable: boolean;
  redoAvailable: boolean;
}): ReactElement {
  const [selected, setSelected] = useState<{
    kind: "node" | "edge";
    id: string;
  } | null>(() => {
    if (initialSelectionId === null) return null;
    if (flow.nodes[initialSelectionId] !== undefined) {
      return { kind: "node", id: initialSelectionId };
    }
    if (flow.edges.some((edge) => edge.id === initialSelectionId)) {
      return { kind: "edge", id: initialSelectionId };
    }
    return null;
  });
  const [instance, setInstance] = useState<ReactFlowInstance | null>(null);
  const previousSelectionRequest = useRef(initialSelectionId);
  useEffect(() => {
    if (previousSelectionRequest.current === initialSelectionId) return;
    previousSelectionRequest.current = initialSelectionId;
    const frame = requestAnimationFrame(() => {
      if (initialSelectionId === null) {
        setSelected(null);
      } else if (flow.nodes[initialSelectionId] !== undefined) {
        setSelected({ kind: "node", id: initialSelectionId });
      } else if (flow.edges.some((edge) => edge.id === initialSelectionId)) {
        setSelected({ kind: "edge", id: initialSelectionId });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [flow.edges, flow.nodes, initialSelectionId]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setSelected((current) => {
        if (current === null) return current;
        const exists =
          current.kind === "node"
            ? flow.nodes[current.id] !== undefined
            : flow.edges.some((edge) => edge.id === current.id);
        return exists ? current : null;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [flow.edges, flow.nodes]);
  const profileManifest = useMemo(
    () => ({
      ...projectManifest,
      variables: Object.fromEntries(
        Object.entries(projectManifest.variables).filter(
          ([, definition]) => definition.scope === "profile",
        ),
      ),
    }),
    [projectManifest],
  );
  const nodes = useMemo<Node[]>(
    () =>
      Object.entries(flow.nodes).map(([id, node]) => ({
        id,
        position: { x: node.x - WIDTH / 2, y: node.y - HEIGHT / 2 },
        data: {
          label: (
            <div
              className={`flow-editor-card${node.y === MAIN_AXIS_Y ? " main-axis" : " branch"}`}
            >
              <strong>{node.title}</strong>
              <span>
                {node.y === MAIN_AXIS_Y
                  ? "主轴"
                  : node.y < MAIN_AXIS_Y
                    ? "上分支"
                    : "下分支"}
                · {node.reveal?.mode ?? "completed"}
              </span>
            </div>
          ),
        },
        style: { width: WIDTH, height: HEIGHT },
      })),
    [flow.nodes],
  );
  const edges = useMemo<Edge[]>(
    () =>
      flow.edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        label: edge.label ?? undefined,
        type: "straight",
        markerEnd: { type: MarkerType.ArrowClosed },
        labelStyle: { fill: "#c1d0ee" },
      })),
    [flow.edges],
  );
  const selectedNode =
    selected?.kind === "node" ? flow.nodes[selected.id] : undefined;
  const selectedNodeId = selected?.kind === "node" ? selected.id : null;
  const selectedEdge =
    selected?.kind === "edge"
      ? flow.edges.find((edge) => edge.id === selected.id)
      : undefined;
  const updateNode = (id: string, update: Partial<StoryFlowNode>): void =>
    onChange({
      ...flow,
      nodes: { ...flow.nodes, [id]: { ...flow.nodes[id], ...update } },
    });
  const updateEdge = (id: string, update: Partial<StoryFlowEdge>): void =>
    onChange({
      ...flow,
      edges: flow.edges.map((edge) =>
        edge.id === id ? { ...edge, ...update } : edge,
      ),
    });
  const renameEdge = (id: string, nextId: string): void => {
    updateEdge(id, { id: nextId });
    setSelected({ kind: "edge", id: nextId });
  };
  const addScene = (id: string): void => {
    const index = Object.keys(flow.nodes).length;
    onChange({
      ...flow,
      nodes: {
        ...flow.nodes,
        [id]: {
          title: id,
          x: 240 + index * 360,
          y: 540,
          reveal: { mode: "completed" },
        },
      },
    });
    setSelected({ kind: "node", id });
  };
  const connect = (connection: Connection): void => {
    if (
      !connection.source ||
      !connection.target ||
      connection.source === connection.target ||
      flow.edges.some(
        (edge) =>
          edge.from === connection.source && edge.to === connection.target,
      )
    )
      return;
    const id = `edge_${connection.source}_${connection.target}`.replace(
      /[^A-Za-z0-9._-]/g,
      "_",
    );
    onChange({
      ...flow,
      edges: [
        ...flow.edges,
        {
          id: `${id}_${flow.edges.length + 1}`,
          from: connection.source,
          to: connection.target,
          label: null,
        },
      ],
    });
  };
  return (
    <div className="flow-workspace">
      <header className="timeline-topbar">
        <button onClick={onClose} type="button">
          返回剧情图
        </button>
        <strong>总流程</strong>
        <span className="timeline-dirty">{dirty ? "未保存" : "已保存"}</span>
        <div className="timeline-toolbar-spacer" />
        <button disabled={!undoAvailable} onClick={onUndo} type="button">
          撤销
        </button>
        <button disabled={!redoAvailable} onClick={onRedo} type="button">
          重做
        </button>
        <button
          disabled={instance === null}
          onClick={() => void instance?.fitView({ padding: 0.18 })}
          type="button"
        >
          适合画布
        </button>
        <button onClick={onValidate} type="button">
          校验
        </button>
        <button
          className="primary-button"
          disabled={!dirty}
          onClick={onSave}
          type="button"
        >
          保存
        </button>
      </header>
      <div className="flow-workspace-body">
        <aside className="flow-scene-list">
          <h3>Scene</h3>
          {sceneIds.map((id) =>
            flow.nodes[id] ? (
              <button
                key={id}
                onClick={() => setSelected({ kind: "node", id })}
                type="button"
              >
                {id}
              </button>
            ) : (
              <button key={id} onClick={() => addScene(id)} type="button">
                ＋ {id}
              </button>
            ),
          )}
        </aside>
        <main className="flow-graph">
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              fitView
              snapToGrid
              snapGrid={[GRID, GRID]}
              connectionLineType={ConnectionLineType.Straight}
              onInit={setInstance}
              onConnect={connect}
              onNodeClick={(_, node) =>
                setSelected({ kind: "node", id: node.id })
              }
              onEdgeClick={(_, edge) =>
                setSelected({ kind: "edge", id: edge.id })
              }
              onNodeDragStop={(_, node) =>
                updateNode(node.id, {
                  x: Math.round((node.position.x + WIDTH / 2) / GRID) * GRID,
                  y: Math.round((node.position.y + HEIGHT / 2) / GRID) * GRID,
                })
              }
              onNodesDelete={(removed) => {
                const ids = new Set(removed.map((node) => node.id));
                const nextNodes = { ...flow.nodes };
                removed.forEach((node) =>
                  Reflect.deleteProperty(nextNodes, node.id),
                );
                onChange({
                  ...flow,
                  nodes: nextNodes,
                  edges: flow.edges.filter(
                    (edge) => !ids.has(edge.from) && !ids.has(edge.to),
                  ),
                });
              }}
              onEdgesDelete={(removed) =>
                onChange({
                  ...flow,
                  edges: flow.edges.filter(
                    (edge) => !removed.some((item) => item.id === edge.id),
                  ),
                })
              }
            >
              <ViewportPortal>
                <div
                  className="flow-main-axis-guide"
                  style={{ top: MAIN_AXIS_Y }}
                >
                  <span>主轴 y = {MAIN_AXIS_Y}</span>
                </div>
              </ViewportPortal>
              <Background gap={GRID} size={1} />
              <Controls />
            </ReactFlow>
          </ReactFlowProvider>
        </main>
        <aside className="flow-inspector">
          {selectedNode && selectedNodeId !== null && (
            <>
              <h3>{selectedNodeId}</h3>
              <label>
                标题
                <DeferredTextInput
                  value={selectedNode.title}
                  onCommit={(title) => updateNode(selectedNodeId, { title })}
                />
              </label>
              <label>
                X
                <DeferredNumberInput
                  step={GRID}
                  value={selectedNode.x}
                  onCommit={(x) =>
                    updateNode(selectedNodeId, {
                      x: Math.round(x / GRID) * GRID,
                    })
                  }
                />
              </label>
              <label>
                Y
                <DeferredNumberInput
                  step={GRID}
                  value={selectedNode.y}
                  onCommit={(y) =>
                    updateNode(selectedNodeId, {
                      y: Math.round(y / GRID) * GRID,
                    })
                  }
                />
              </label>
              <div className="flow-axis-actions" aria-label="流程轴位置">
                <button
                  onClick={() => updateNode(selectedNodeId, { y: MAIN_AXIS_Y })}
                  type="button"
                >
                  置于主轴
                </button>
                <button
                  onClick={() =>
                    updateNode(selectedNodeId, {
                      y: MAIN_AXIS_Y - BRANCH_OFFSET,
                    })
                  }
                  type="button"
                >
                  上分支
                </button>
                <button
                  onClick={() =>
                    updateNode(selectedNodeId, {
                      y: MAIN_AXIS_Y + BRANCH_OFFSET,
                    })
                  }
                  type="button"
                >
                  下分支
                </button>
              </div>
              <label>
                揭示
                <select
                  value={selectedNode.reveal?.mode ?? "completed"}
                  onChange={(event) => {
                    const mode = event.currentTarget.value as
                      "completed" | "always" | "condition";
                    updateNode(selectedNodeId, {
                      reveal:
                        mode === "condition"
                          ? {
                              mode,
                              condition: defaultCondition(
                                Object.keys(profileManifest.variables)[0] ??
                                  "flag",
                              ),
                            }
                          : { mode },
                    });
                  }}
                >
                  <option value="completed">读完后揭示</option>
                  <option value="always">始终揭示</option>
                  <option
                    disabled={
                      Object.keys(profileManifest.variables).length === 0
                    }
                    value="condition"
                  >
                    变量条件
                  </option>
                </select>
              </label>
              {Object.keys(profileManifest.variables).length === 0 && (
                <p className="flow-inspector-hint">
                  项目没有 profile 变量，暂时不能创建条件揭示。
                </p>
              )}
              {selectedNode.reveal?.mode === "condition" &&
                Object.keys(profileManifest.variables).length > 0 && (
                  <ConditionEditor
                    manifest={profileManifest}
                    value={selectedNode.reveal.condition}
                    onChange={(condition) =>
                      updateNode(selectedNodeId, {
                        reveal: { mode: "condition", condition },
                      })
                    }
                  />
                )}
            </>
          )}
          {selectedEdge && (
            <>
              <h3>{selectedEdge.id}</h3>
              <label>
                边 ID
                <DeferredTextInput
                  value={selectedEdge.id}
                  onCommit={(id) => renameEdge(selectedEdge.id, id)}
                />
              </label>
              <label>
                起点
                <select
                  value={selectedEdge.from}
                  onChange={(event) =>
                    updateEdge(selectedEdge.id, {
                      from: event.currentTarget.value,
                    })
                  }
                >
                  {Object.keys(flow.nodes).map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                终点
                <select
                  value={selectedEdge.to}
                  onChange={(event) =>
                    updateEdge(selectedEdge.id, {
                      to: event.currentTarget.value,
                    })
                  }
                >
                  {Object.keys(flow.nodes).map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                标签
                <DeferredTextInput
                  value={selectedEdge.label ?? ""}
                  onCommit={(label) =>
                    updateEdge(selectedEdge.id, { label: label || null })
                  }
                />
              </label>
              <button
                onClick={() => {
                  onChange({
                    ...flow,
                    edges: flow.edges.filter(
                      (edge) => edge.id !== selectedEdge.id,
                    ),
                  });
                  setSelected(null);
                }}
                type="button"
              >
                删除连线
              </button>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function DeferredTextInput({
  onCommit,
  value,
}: {
  onCommit(value: string): void;
  value: string;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = (): void => {
    const draft = inputRef.current?.value ?? value;
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      defaultValue={value}
      key={value}
      ref={inputRef}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

function DeferredNumberInput({
  onCommit,
  step,
  value,
}: {
  onCommit(value: number): void;
  step: number;
  value: number;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = (): void => {
    const draft = inputRef.current?.value ?? String(value);
    const parsed = Number(draft);
    if (draft.trim() !== "" && Number.isFinite(parsed)) onCommit(parsed);
    else if (inputRef.current !== null) inputRef.current.value = String(value);
  };
  return (
    <input
      defaultValue={String(value)}
      key={String(value)}
      ref={inputRef}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
      step={step}
      type="number"
    />
  );
}
