import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { memo, useEffect, type ReactElement } from "react";
import {
  nodeLabel,
  outputPorts,
  summarizeNode,
  type InsertSide,
} from "../story";
import type { SceneNode } from "../types";

export interface StoryNodeData extends Record<string, unknown> {
  nodeId: string;
  node: SceneNode;
  entry: boolean;
  issueCount: number;
  onOpen(nodeId: string): void;
  onQuickInsert(
    nodeId: string,
    side: InsertSide,
    clientX: number,
    clientY: number,
  ): void;
}

export type StoryFlowNode = Node<StoryNodeData, "story">;

export const StoryNodeCard = memo(function StoryNodeCard({
  id,
  data,
  selected,
}: NodeProps<StoryFlowNode>): ReactElement {
  const updateNodeInternals = useUpdateNodeInternals();
  const ports = outputPorts(data.node);
  useEffect(
    () => updateNodeInternals(id),
    [id, ports.length, updateNodeInternals],
  );

  const awaited = "await" in data.node && data.node.await;
  return (
    <article
      className={`story-node story-node-${data.node.type}${selected ? " is-selected" : ""}`}
      data-allow-context-menu="true"
      onDoubleClick={() => data.onOpen(data.nodeId)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        data.onQuickInsert(data.nodeId, "right", event.clientX, event.clientY);
      }}
    >
      {(["left", "right"] as InsertSide[]).map((side) => (
        <button
          aria-label={`在${side === "left" ? "左" : "右"}侧插入节点`}
          className={`insert-point insert-point-${side}`}
          data-allow-context-menu="true"
          key={side}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            data.onQuickInsert(data.nodeId, side, event.clientX, event.clientY);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            data.onQuickInsert(data.nodeId, side, event.clientX, event.clientY);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          <span aria-hidden="true">＋</span>
        </button>
      ))}
      <Handle
        className="story-handle input-handle"
        position={Position.Left}
        type="target"
      />
      <header className="story-node-header node-drag-handle">
        <span className="story-node-type">{nodeLabel(data.node.type)}</span>
        <span className="story-node-id">{data.nodeId}</span>
      </header>
      <div className="story-node-summary">{summarizeNode(data.node)}</div>
      <div className="story-node-badges">
        {data.entry && <span className="node-badge entry-badge">ENTRY</span>}
        {awaited && <span className="node-badge await-badge">AWAIT</span>}
        {data.node.type === "say" && (
          <span className="node-badge boundary-badge">PLAYER</span>
        )}
        {data.issueCount > 0 && (
          <span className="node-badge issue-badge">
            {data.issueCount} ISSUE
          </span>
        )}
      </div>
      {ports.length > 0 && (
        <div className="story-node-ports">
          {ports.map((port, index) => {
            const top = `${((index + 1) / (ports.length + 1)) * 100}%`;
            return (
              <div className="story-port-row" key={port.id} title={port.target}>
                <span>{port.label}</span>
                <small>{port.target}</small>
                <Handle
                  className="story-handle output-handle"
                  id={port.id}
                  position={Position.Right}
                  style={{ top }}
                  type="source"
                />
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
});
