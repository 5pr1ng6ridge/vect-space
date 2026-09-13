import type { ChoiceFlowDirection } from "./types";

/**
 * Pure, framework-agnostic mirror of the Rust choice-flow layout
 * (`crates/vectspace-core/src/choice.rs`).
 *
 * The runtime is the source of truth: every prompt already ships the resolved
 * rects, and hosts render them directly.  This helper exists for hosts that
 * need the same deterministic placement before a runtime snapshot is
 * available (editor previews, measurement tooling).  Both implementations
 * are verified against the same conformance corpus,
 * `fixtures/choice-layout-cases.json`.
 *
 * Anchor coordinates are design pixels in the fixed 1920x1080 space, never
 * normalized fractions: `(960, 540)` is the stage centre.  A node without an
 * explicit `presentation` keeps the shipped CSS panel top-left of
 * `(470, 360)`; `legacyChoiceAnchor` derives the equivalent centre anchor for
 * it, so every layout below still receives concrete design-pixel anchors.
 */

/** Fixed 1920x1080 design space every choice layout is expressed in. */
export const CHOICE_STAGE_WIDTH = 1920;
export const CHOICE_STAGE_HEIGHT = 1080;

/**
 * Documented built-in fallback for a choice button that resolves to no
 * reusable template.  The dimensions mirror the shipped CSS choice panel
 * (980px width, 92px button min-height, 20px gap).
 */
export const CHOICE_FALLBACK_BUTTON_WIDTH = 980;
export const CHOICE_FALLBACK_BUTTON_HEIGHT = 92;

/**
 * Shipped CSS choice panel origin (`src/App.css`: `left: 470px; top: 360px`).
 * Presentation-less nodes keep exactly this top-left placement.
 */
export const CHOICE_FALLBACK_PANEL_X = 470;
export const CHOICE_FALLBACK_PANEL_Y = 360;

/**
 * Default centre of an explicitly presented group, in design pixels.  `960`
 * is the horizontal centre of the 1920px stage and `540` the vertical centre
 * of the 1080px stage.
 */
export const CHOICE_DEFAULT_ANCHOR_X = 960;
export const CHOICE_DEFAULT_ANCHOR_Y = 540;
export const CHOICE_DEFAULT_GAP = 20;

export interface ChoiceItemSize {
  width: number;
  height: number;
}

export interface ChoiceItemRect extends ChoiceItemSize {
  x: number;
  y: number;
}

export interface ChoiceLayoutRequest {
  direction: ChoiceFlowDirection;
  anchor_x: number;
  anchor_y: number;
  gap: number;
}

export interface ChoiceLayoutResult extends ChoiceItemSize {
  x: number;
  y: number;
  items: ChoiceItemRect[];
}

/**
 * Extent of the whole group as `[main, cross]` lengths in design pixels.
 *
 * `main` is the direction the items flow along and includes the gaps; `cross`
 * is the longest item on the perpendicular axis.  The result is `[0, 0]` for
 * an empty group, so callers can collapse such a group onto its anchor.
 */
function choiceGroupExtent(
  direction: ChoiceFlowDirection,
  gap: number,
  sizes: readonly ChoiceItemSize[],
): [number, number] {
  if (sizes.length === 0) {
    return [0, 0];
  }
  const horizontal = direction === "horizontal";
  let totalMain = 0;
  let maxCross = 0;
  for (const size of sizes) {
    totalMain += horizontal ? size.width : size.height;
    maxCross = Math.max(maxCross, horizontal ? size.height : size.width);
  }
  totalMain += gap * (sizes.length - 1);
  return [totalMain, maxCross];
}

/**
 * Equivalent centre anchor of the shipped CSS choice panel.
 *
 * A node without `presentation` keeps the panel top-left at `(470, 360)`, so
 * its group-centre anchor depends on the resolved group extent.  Deriving the
 * anchor here — instead of re-anchoring the layout — keeps one centring rule
 * for every choice node: the reported layout is always
 * `layoutChoiceItems(sizes, { direction, anchor_x, anchor_y, gap })`.
 *
 * The mapping is axis-aware: a vertical flow stacks along `y`, so the panel
 * origin is reached by offsetting `anchor_y` by half the main extent; a
 * horizontal flow stacks along `x` and offsets `anchor_x` instead.  Callers
 * may pass either direction and still get a layout whose bounding box starts
 * at the shipped panel origin.
 */
export function legacyChoiceAnchor(
  direction: ChoiceFlowDirection,
  gap: number,
  sizes: readonly ChoiceItemSize[],
): { anchor_x: number; anchor_y: number } {
  const [totalMain, maxCross] = choiceGroupExtent(direction, gap, sizes);
  return direction === "horizontal"
    ? {
        anchor_x: CHOICE_FALLBACK_PANEL_X + totalMain / 2,
        anchor_y: CHOICE_FALLBACK_PANEL_Y + maxCross / 2,
      }
    : {
        anchor_x: CHOICE_FALLBACK_PANEL_X + maxCross / 2,
        anchor_y: CHOICE_FALLBACK_PANEL_Y + totalMain / 2,
      };
}

/**
 * Places visible choice buttons in the fixed 1920x1080 stage.
 *
 * The group is centred on `anchor_x`/`anchor_y` (design pixels, `0..=1920`
 * and `0..=1080`) and flows along `direction`, separated by `gap` design
 * pixels.  Every item is centred on the cross axis, so mixed template sizes
 * stay visually aligned while the main axis advances by each item's own size
 * plus the gap.
 */
export function layoutChoiceItems(
  sizes: readonly ChoiceItemSize[],
  request: ChoiceLayoutRequest,
): ChoiceLayoutResult {
  const { direction, anchor_x, anchor_y, gap } = request;
  if (sizes.length === 0) {
    return { x: anchor_x, y: anchor_y, width: 0, height: 0, items: [] };
  }
  const horizontal = direction === "horizontal";
  const [totalMain, maxCross] = choiceGroupExtent(direction, gap, sizes);
  const anchorMain = horizontal ? anchor_x : anchor_y;
  const anchorCross = horizontal ? anchor_y : anchor_x;
  const startMain = anchorMain - totalMain / 2;
  const crossOrigin = anchorCross - maxCross / 2;
  let cursor = startMain;
  const items: ChoiceItemRect[] = [];
  for (const size of sizes) {
    const x = horizontal ? cursor : anchorCross - size.width / 2;
    const y = horizontal ? anchorCross - size.height / 2 : cursor;
    items.push({ x, y, width: size.width, height: size.height });
    cursor += (horizontal ? size.width : size.height) + gap;
  }
  return horizontal
    ? {
        x: startMain,
        y: crossOrigin,
        width: totalMain,
        height: maxCross,
        items,
      }
    : {
        x: crossOrigin,
        y: startMain,
        width: maxCross,
        height: totalMain,
        items,
      };
}

export interface ChoiceItemSizeResolution {
  /** Resolved template dimensions, or null/absent for the CSS fallback. */
  template?: ChoiceItemSize | null;
  /** Node-wide presentation overrides; invalid values are ignored. */
  button_width?: number | null;
  button_height?: number | null;
}

/**
 * Resolves the effective size of one choice item with the same priority the
 * runtime uses: node override, then template dimensions, then the documented
 * built-in fallback.
 */
export function resolveChoiceItemSize(
  resolution: ChoiceItemSizeResolution,
): ChoiceItemSize {
  const baseWidth = resolution.template?.width ?? CHOICE_FALLBACK_BUTTON_WIDTH;
  const baseHeight =
    resolution.template?.height ?? CHOICE_FALLBACK_BUTTON_HEIGHT;
  return {
    width: validOverride(resolution.button_width) ?? baseWidth,
    height: validOverride(resolution.button_height) ?? baseHeight,
  };
}

function validOverride(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}
