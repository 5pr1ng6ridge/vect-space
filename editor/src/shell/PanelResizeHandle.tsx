import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from "react";

import {
  PANEL_STEP,
  PANEL_STEP_LARGE,
  panelBounds,
  type PanelAxis,
} from "./panelSizing";

/**
 * Drag handle on a side panel's inner edge.  While the panel is collapsed the
 * same element stays on the screen edge as a rail: drag it inward to pull the
 * panel out, or click / press Enter / Space to reopen it at its last width.
 * Keeping one element across both states keeps keyboard focus on it when the
 * panel collapses.
 */
export function PanelResizeHandle({
  axis,
  collapsed,
  size,
  onStart,
  onStep,
  onExpand,
}: {
  axis: PanelAxis;
  collapsed: boolean;
  size: number;
  onStart(axis: PanelAxis, startX: number): void;
  /** Positive `delta` widens the panel; `repeated` marks key auto-repeat. */
  onStep(axis: PanelAxis, delta: number, repeated: boolean): void;
  onExpand(axis: PanelAxis): void;
}): ReactElement {
  const side = axis === "left" ? "左侧栏" : "右侧栏";
  const outward = axis === "left" ? "ArrowRight" : "ArrowLeft";
  const inward = axis === "left" ? "ArrowLeft" : "ArrowRight";
  const [, maximum] = panelBounds(axis);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (collapsed && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      onExpand(axis);
      return;
    }
    const direction = event.key === outward ? 1 : event.key === inward ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const step = event.shiftKey ? PANEL_STEP_LARGE : PANEL_STEP;
    onStep(axis, direction * step, event.repeat);
  };

  return (
    <div
      aria-label={collapsed ? `拖出${side}` : `调整${side}宽度`}
      aria-orientation="vertical"
      aria-valuemax={maximum}
      aria-valuemin={0}
      aria-valuenow={collapsed ? 0 : size}
      className={`resize-handle resize-handle-${axis}${collapsed ? " is-collapsed" : ""}`}
      onKeyDown={handleKeyDown}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        onStart(axis, event.clientX);
      }}
      role="separator"
      tabIndex={0}
      title={collapsed ? `拖出${side}，或单击展开` : undefined}
    />
  );
}
