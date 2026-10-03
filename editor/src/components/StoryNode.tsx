import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Flag, Hourglass, Plus } from "lucide-react";
import { memo, useEffect, type ReactElement } from "react";

import { NODE_CATEGORY } from "../labels";
import type { NodeDescription } from "../nodeSummary";
import { nodeLabel, outputPorts, type InsertSide } from "../story";
import { effectPorts } from "../windowInteraction";
import type { SceneNode } from "../types";
import { DropdownMenu, type MenuItemSpec } from "../ui/Menu";
import { NODE_ICONS, UNKNOWN_NODE_ICON } from "../ui/nodeIcons";

export interface StoryNodeData extends Record<string, unknown> {
  nodeId: string;
  node: SceneNode;
  description: NodeDescription;
  entry: boolean;
  issueCount: number;
  /** Double-click: open the node's workspace or edit it in the inspector. */
  onActivate(nodeId: string): void;
  onSelect(nodeId: string): void;
  /** Menu entries for inserting a node before/after this one. */
  insertEntries(nodeId: string, side: InsertSide): MenuItemSpec[];
}

export type StoryGraphNode = Node<StoryNodeData, "story">;

export const StoryNodeCard = memo(function StoryNodeCard({
  id,
  data,
  selected,
}: NodeProps<StoryGraphNode>): ReactElement {
  const updateNodeInternals = useUpdateNodeInternals();
  const ports = outputPorts(data.node);
  const effects = effectPorts(data.node);
  useEffect(
    () => updateNodeInternals(id),
    [id, ports.length, effects.length, updateNodeInternals],
  );
  const Icon = NODE_ICONS[data.node.type] ?? UNKNOWN_NODE_ICON;
  const category = NODE_CATEGORY[data.node.type] ?? "flow";
  const awaited = "await" in data.node && data.node.await;
  // A lone "next" port is drawn on the card edge; branches get labelled rows.
  const singleNext = ports.length === 1 && ports[0].id === "next";

  const insertButton = (side: InsertSide): ReactElement => (
    <DropdownMenu
      align="start"
      entries={data.insertEntries(data.nodeId, side)}
      label={side === "left" ? "在前面插入节点" : "在后面插入节点"}
      side={side === "left" ? "left" : "right"}
      trigger={
        <button
          aria-label={`在${side === "left" ? "前面" : "后面"}插入节点`}
          className={`story-insert story-insert-${side} nodrag`}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          <Plus aria-hidden="true" />
        </button>
      }
    />
  );

  return (
    <article
      className={`story-node story-cat-${category}${selected ? " is-selected" : ""}`}
      data-node-id={data.nodeId}
      onClick={(event) => {
        if (
          event.button === 0 &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey
        )
          data.onSelect(data.nodeId);
      }}
      onDoubleClick={() => data.onActivate(data.nodeId)}
      onPointerDown={(event) => {
        // Right-click must not discard a multi-selection before its menu opens.
        if (
          event.button === 0 &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey
        )
          data.onSelect(data.nodeId);
      }}
    >
      {insertButton("left")}
      {(singleNext || ports.length === 0) && insertButton("right")}
      <Handle
        className="story-handle story-handle-in"
        position={Position.Left}
        type="target"
      />
      <header className="story-node-header node-drag-handle">
        <span className="story-node-icon">
          <Icon aria-hidden="true" />
        </span>
        <span className="story-node-type">{nodeLabel(data.node.type)}</span>
        <span className="story-node-id" title={data.nodeId}>
          {data.nodeId}
        </span>
        {awaited && (
          <span className="story-node-flag" title="等待演出完成后再继续">
            <Hourglass aria-label="等待完成" />
          </span>
        )}
        {data.entry && (
          <span className="story-node-flag is-entry" title="场景入口">
            <Flag aria-label="场景入口" />
          </span>
        )}
        {data.issueCount > 0 && (
          <span
            className="story-node-issues"
            title={`${data.issueCount} 个问题`}
          >
            {data.issueCount}
          </span>
        )}
      </header>
      <div className="story-node-body">
        {data.description.title !== null && (
          <strong className="story-node-title">{data.description.title}</strong>
        )}
        <p className="story-node-summary">{data.description.summary}</p>
      </div>
      {singleNext && (
        <Handle
          className="story-handle story-handle-out"
          id="next"
          position={Position.Right}
          type="source"
        />
      )}
      {effects.length > 0 && (
        <ul className="story-node-ports story-node-effects">
          {effects.map((port) => (
            <li
              className="story-port story-port-effect"
              key={port.id}
              title={
                port.target === ""
                  ? "拖出连线选择计时器到点时运行的效果节点"
                  : `到点运行 ${port.target} 的效果（不沿它的下一节点走）`
              }
            >
              <span>
                {port.label}
                {port.target === "" ? "（未选）" : ` → ${port.target}`}
              </span>
              <Handle
                className="story-handle story-handle-out story-handle-effect"
                id={port.id}
                position={Position.Right}
                type="source"
              />
            </li>
          ))}
        </ul>
      )}
      {!singleNext && ports.length > 0 && (
        <ul className="story-node-ports">
          {ports.map((port) => (
            <li
              className="story-port"
              key={port.id}
              title={
                port.targetScene === null
                  ? `→ ${port.target}`
                  : `→ ${port.targetScene} / ${port.target}`
              }
            >
              <span>{port.label}</span>
              <Handle
                className="story-handle story-handle-out"
                id={port.id}
                position={Position.Right}
                type="source"
              />
            </li>
          ))}
        </ul>
      )}
    </article>
  );
});
