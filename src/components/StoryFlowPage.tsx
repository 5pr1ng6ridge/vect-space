import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from "react";

import type { StoryFlowSnapshot } from "../engine/types";

const DESIGN_WIDTH = 1920;
const MAIN_AXIS_Y = 540;
const VIEW_CENTER_X = DESIGN_WIDTH / 2;

export function StoryFlowPage({
  flow,
  onClose,
}: {
  flow: StoryFlowSnapshot;
  onClose(): void;
}): ReactElement {
  const nodesById = useMemo(
    () => new Map(flow.nodes.map((node) => [node.scene_id, node])),
    [flow.nodes],
  );
  const bounds = useMemo(() => {
    if (flow.nodes.length === 0) return { minX: 0, maxX: 0 };
    return {
      minX: Math.min(...flow.nodes.map((node) => node.x)),
      maxX: Math.max(...flow.nodes.map((node) => node.x)),
    };
  }, [flow.nodes]);
  const completed = flow.nodes.filter((node) => node.completed);
  const focus = (completed.length > 0 ? completed : flow.nodes).reduce<
    (typeof flow.nodes)[number] | null
  >((right, node) => (right === null || node.x > right.x ? node : right), null);
  const clampOffset = (value: number): number => {
    if (flow.nodes.length <= 1) return focus ? VIEW_CENTER_X - focus.x : 0;
    return Math.max(
      VIEW_CENTER_X - bounds.maxX,
      Math.min(VIEW_CENTER_X - bounds.minX, value),
    );
  };
  const [offsetX, setOffsetX] = useState(() =>
    focus ? VIEW_CENTER_X - focus.x : 0,
  );
  const drag = useRef<{
    x: number;
    offsetX: number;
    screenScale: number;
  } | null>(null);

  const panBy = (delta: number): void => {
    setOffsetX((value) => clampOffset(value + delta));
  };
  const startDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const screenScale =
      event.currentTarget.getBoundingClientRect().width / DESIGN_WIDTH || 1;
    drag.current = { x: event.clientX, offsetX, screenScale };
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return;
    setOffsetX(
      clampOffset(
        drag.current.offsetX +
          (event.clientX - drag.current.x) / drag.current.screenScale,
      ),
    );
  };
  const stopDrag = (): void => {
    drag.current = null;
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      panBy(120);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      panBy(-120);
    }
  };

  return (
    <section className="story-flow-page" data-block-story-advance>
      <button
        aria-label="返回标题"
        className="story-flow-back"
        onClick={onClose}
        type="button"
      >
        ← 返回
      </button>
      <div
        aria-label="剧情流程，可左右拖动浏览"
        className="story-flow-canvas"
        onKeyDown={handleKeyDown}
        onPointerCancel={stopDrag}
        onPointerDown={startDrag}
        onPointerMove={move}
        onPointerUp={stopDrag}
        onWheel={(event) => {
          event.preventDefault();
          const screenScale =
            event.currentTarget.getBoundingClientRect().width / DESIGN_WIDTH ||
            1;
          panBy(-(event.deltaX + event.deltaY) / screenScale);
        }}
        role="region"
        tabIndex={0}
      >
        <div
          className="story-flow-world"
          style={{ transform: `translate3d(${offsetX}px, 0, 0)` }}
        >
          <svg className="story-flow-edges" aria-hidden="true">
            <defs>
              <marker
                id="flow-arrow"
                markerHeight="8"
                markerWidth="8"
                orient="auto"
                refX="7"
                refY="4"
              >
                <path d="M0,0 L8,4 L0,8 z" />
              </marker>
            </defs>
            {flow.nodes.length > 0 && (
              <line
                className="story-flow-main-axis"
                x1={bounds.minX - 360}
                x2={bounds.maxX + 360}
                y1={MAIN_AXIS_Y}
                y2={MAIN_AXIS_Y}
              />
            )}
            {flow.edges.map((edge) => {
              const from = nodesById.get(edge.from);
              const to = nodesById.get(edge.to);
              if (!from || !to) return null;
              const isMainEdge = from.y === MAIN_AXIS_Y && to.y === MAIN_AXIS_Y;
              return (
                <g
                  className={isMainEdge ? "main-edge" : "branch-edge"}
                  key={edge.id}
                >
                  <line
                    markerEnd="url(#flow-arrow)"
                    x1={from.x}
                    x2={to.x}
                    y1={from.y}
                    y2={to.y}
                  />
                  {edge.label && (
                    <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 14}>
                      {edge.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {flow.nodes.map((node) => (
            <article
              className={`story-flow-node ${node.completed ? "completed" : "revealed"} ${node.y === MAIN_AXIS_Y ? "main-node" : "branch-node"}`}
              key={node.scene_id}
              style={{ left: node.x, top: node.y }}
            >
              <strong>{node.title}</strong>
              <span>{node.completed ? "已完成" : "已揭示"}</span>
            </article>
          ))}
        </div>
        {flow.nodes.length === 0 && (
          <p className="story-flow-empty">尚未揭示剧情节点</p>
        )}
      </div>
      <p className="story-flow-help">左右拖动 · 滚轮横向浏览</p>
    </section>
  );
}
