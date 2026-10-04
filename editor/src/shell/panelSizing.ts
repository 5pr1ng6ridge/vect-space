/**
 * Width and collapse rules for the resizable side panels.
 *
 * Kept free of React so the drag and keyboard behaviour can be tested as
 * plain functions.  A panel has a remembered `size` (the width it reopens at)
 * and a `visible` flag; collapsing never rewrites the remembered size.
 */

export type PanelAxis = "left" | "right";

export interface PanelSizes {
  left: number;
  right: number;
}

/** A panel's remembered width plus whether it is currently shown. */
export interface PanelLayout {
  size: number;
  visible: boolean;
}

/** One pointer gesture on a panel's resize handle (or its collapsed rail). */
export interface PanelDrag {
  axis: PanelAxis;
  startX: number;
  /** Panel width when the gesture began; 0 when it began on the collapsed rail. */
  origin: number;
  /** Remembered width, restored if the gesture leaves the panel collapsed. */
  remembered: number;
  startedCollapsed: boolean;
}

const PANEL_BOUNDS: Record<PanelAxis, readonly [number, number]> = {
  left: [220, 480],
  right: [300, 560],
};

/** Dragging this many pixels below the minimum width collapses the panel. */
export const PANEL_COLLAPSE_DISTANCE = 56;

/**
 * Pointer travel that separates a click from a drag on the collapsed rail.
 * A click reopens the panel at its remembered width; a drag past this
 * distance pulls it out at the minimum width and then follows the pointer.
 */
export const PANEL_CLICK_SLOP = 4;

export const PANEL_STEP = 12;
export const PANEL_STEP_LARGE = 32;

export function panelBounds(axis: PanelAxis): readonly [number, number] {
  return PANEL_BOUNDS[axis];
}

export function clampPanelSize(axis: PanelAxis, value: number): number {
  const [minimum, maximum] = PANEL_BOUNDS[axis];
  return Math.round(Math.min(maximum, Math.max(minimum, value)));
}

/**
 * The layout a drag produces with the pointer at `clientX`.  Visibility is a
 * pure function of the pointer, so dragging back out of a collapse reopens
 * the panel within the same gesture.
 */
export function resolvePanelDrag(
  drag: PanelDrag,
  clientX: number,
): PanelLayout {
  const delta = clientX - drag.startX;
  const width = drag.origin + (drag.axis === "right" ? -delta : delta);
  const [minimum] = PANEL_BOUNDS[drag.axis];
  const hiddenBelow = drag.startedCollapsed
    ? PANEL_CLICK_SLOP
    : minimum - PANEL_COLLAPSE_DISTANCE;
  if (width < hiddenBelow) return { size: drag.remembered, visible: false };
  return { size: clampPanelSize(drag.axis, width), visible: true };
}

/**
 * Keyboard step; positive `delta` moves the edge outward (wider panel).
 * Pressing inward at the minimum width collapses; pressing outward on a
 * collapsed panel reopens it at the remembered width.  `allowCollapse` is
 * false for auto-repeat so holding a key cannot shrink straight through to
 * a collapse.
 */
export function stepPanel(
  axis: PanelAxis,
  layout: PanelLayout,
  delta: number,
  allowCollapse = true,
): PanelLayout {
  if (!layout.visible) return delta > 0 ? { ...layout, visible: true } : layout;
  const [minimum] = PANEL_BOUNDS[axis];
  if (delta < 0 && layout.size <= minimum) {
    return allowCollapse ? { ...layout, visible: false } : layout;
  }
  return { ...layout, size: clampPanelSize(axis, layout.size + delta) };
}
