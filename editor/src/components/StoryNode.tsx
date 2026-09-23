import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  memo,
  useEffect,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
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
  /** Start the live gameplay preview from this node (plain double-click). */
  onPreview(nodeId: string): void;
  onSelect(nodeId: string): void;
  onQuickInsert(
    nodeId: string,
    side: InsertSide,
    clientX: number,
    clientY: number,
  ): void;
}

export type StoryGraphNode = Node<StoryNodeData, "story">;

export const StoryNodeCard = memo(function StoryNodeCard({
  id,
  data,
  selected,
}: NodeProps<StoryGraphNode>): ReactElement {
  const updateNodeInternals = useUpdateNodeInternals();
  const ports = outputPorts(data.node);
  const hasNextPort = ports.some((port) => port.id === "next");
  const insertSides: InsertSide[] = hasNextPort ? ["left"] : ["left", "right"];
  const openNextInsert = (event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    data.onQuickInsert(data.nodeId, "right", event.clientX, event.clientY);
  };
  useEffect(
    () => updateNodeInternals(id),
    [id, ports.length, updateNodeInternals],
  );

  const awaited = "await" in data.node && data.node.await;
  return (
    <article
      className={`story-node nopan story-node-${data.node.type}${selected ? " is-selected" : ""}`}
      data-allow-context-menu="true"
      onClick={() => data.onSelect(data.nodeId)}
      onPointerDown={() => data.onSelect(data.nodeId)}
      onDoubleClick={() => {
        // timeline / long_text keep their specialized full-screen workspaces;
        // every other node opens the live gameplay preview from itself.
        if (data.node.type === "timeline" || data.node.type === "long_text") {
          data.onOpen(data.nodeId);
          return;
        }
        data.onPreview(data.nodeId);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        data.onQuickInsert(data.nodeId, "right", event.clientX, event.clientY);
      }}
    >
      {insertSides.map((side) => (
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
                  aria-label={
                    port.id === "next"
                      ? "拖动连接，或点击在右侧插入节点"
                      : undefined
                  }
                  className={`story-handle output-handle${
                    port.id === "next" ? " next-output-handle" : ""
                  }`}
                  data-allow-context-menu={
                    port.id === "next" ? "true" : undefined
                  }
                  id={port.id}
                  {...(port.id === "next"
                    ? {
                        onClick: openNextInsert,
                        onContextMenu: openNextInsert,
                      }
                    : {})}
                  position={Position.Right}
                  style={{ top }}
                  type="source"
                >
                  {port.id === "next" && (
                    <span aria-hidden="true" className="next-output-glyph">
                      ＋
                    </span>
                  )}
                </Handle>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
});
