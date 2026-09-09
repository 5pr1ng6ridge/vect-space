import type { LayoutUnit } from "./markup";

/** Renderer-neutral measured layout data, always expressed in unscaled CSS/design pixels. */
export interface TextUnitBox {
  index: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** A DOM rectangle expressed in the renderer's current (possibly scaled) space. */
export interface TextMeasurementRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly height?: number;
}

/**
 * Converts a browser rectangle to the unscaled design space used by the
 * paginator.  The browser reports transformed rectangles in viewport pixels,
 * while scrollHeight/offsetLeft remain in layout pixels; keeping this
 * conversion in the shared package prevents the game and editor from drifting.
 */
export function normalizeTextUnitBox(
  index: number,
  rect: TextMeasurementRect,
  origin: Pick<TextMeasurementRect, "top" | "left">,
  measurementScale = 1,
): TextUnitBox {
  const scale = safeMeasurementScale(measurementScale);
  return {
    index,
    top: (rect.top - origin.top) / scale,
    bottom: (rect.bottom - origin.top) / scale,
    left: (rect.left - origin.left) / scale,
    right: (rect.right - origin.left) / scale,
  };
}

/** Measurement adapters must wait for a real, finite design-surface scale. */
export function isValidTextMeasurementScale(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Returns a stable content height in the same unscaled space as unit boxes. */
export function normalizeTextContentHeight(
  contentHeight: number,
  rootHeight: number,
  boxes: ReadonlyMap<number, TextUnitBox>,
  measurementScale = 1,
): number {
  const scale = safeMeasurementScale(measurementScale);
  return finitePositive(
    Math.max(
      contentHeight,
      rootHeight / scale,
      ...[...boxes.values()].map((box) => box.bottom),
    ),
  );
}

export interface TextLayoutLine {
  readonly unitIndices: readonly number[];
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface TextLayoutSnapshot {
  readonly lines: readonly TextLayoutLine[];
  readonly contentHeight: number;
}

export type TextPaginationMode = "continuous" | "auto" | "manual";

/** A renderer-neutral text block supplied to the shared visual-line paginator. */
export interface TextPaginationItem {
  readonly id: string;
  readonly pageBreakBefore: boolean;
  /** Undefined only while an asynchronous browser measurement is pending. */
  readonly layout: TextLayoutSnapshot | undefined;
  /** Stable provisional height used before the real layout arrives. */
  readonly fallbackHeight?: number;
}

export interface TextLayoutFragment {
  readonly itemId: string;
  /** Offset in the item's own unscaled source layout. */
  readonly sourceTop: number;
  readonly height: number;
  readonly firstLine: number;
  readonly lastLine: number;
  /** Position inside the page content box, before page padding. */
  readonly top: number;
}

export interface TextLayoutPage {
  readonly index: number;
  readonly fragments: readonly TextLayoutFragment[];
  readonly contentHeight: number;
  readonly height: number;
}

export interface TextPageWindow {
  /** Inclusive start, exclusive end. */
  readonly start: number;
  readonly end: number;
}

/**
 * Returns the pages that should remain mounted around a design-space scroll
 * offset. The two-viewport overscan is shared by gameplay and editor so a
 * page can be prepared before it reaches the actual viewport without making
 * the whole document part of the DOM.
 */
export function resolveTextPageWindow(
  pages: readonly { height: number }[],
  pageOffsets: readonly number[],
  scrollOffset: number,
  viewportHeight: number,
  overscan = viewportHeight * 2,
): TextPageWindow {
  if (pages.length === 0) return { start: 0, end: 0 };
  const lower = Math.max(0, scrollOffset - Math.max(0, overscan));
  const upper =
    scrollOffset + Math.max(0, viewportHeight) + Math.max(0, overscan);

  let low = 0;
  let high = pages.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const bottom = (pageOffsets[middle] ?? 0) + (pages[middle]?.height ?? 0);
    if (bottom < lower) low = middle + 1;
    else high = middle;
  }
  const start = low;
  low = start;
  high = pages.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((pageOffsets[middle] ?? 0) <= upper) low = middle + 1;
    else high = middle;
  }
  return { start, end: Math.max(start, low) };
}

/** The game and editor use the same stable separation between story steps. */
export const TEXT_LAYOUT_STEP_GAP = 28;

/**
 * Converts renderer-collected row groups to a deterministic, serializable
 * layout snapshot. The browser adapter owns DOM measurement; this function
 * deliberately stays independent of React, KaTeX and Tauri.
 */
export function createTextLayoutSnapshot(
  groups: readonly (readonly number[])[],
  boxes: ReadonlyMap<number, TextUnitBox>,
  contentHeight: number,
): TextLayoutSnapshot {
  const lines: TextLayoutLine[] = [];
  for (const group of groups) {
    const units = group
      .map((index) => boxes.get(index))
      .filter((box): box is TextUnitBox => box !== undefined);
    if (units.length !== group.length || units.length === 0) continue;
    lines.push({
      unitIndices: [...group],
      top: Math.min(...units.map((unit) => unit.top)),
      bottom: Math.max(...units.map((unit) => unit.bottom)),
      left: Math.min(...units.map((unit) => unit.left)),
      right: Math.max(...units.map((unit) => unit.right)),
    });
  }
  return {
    lines,
    contentHeight: finitePositive(contentHeight),
  };
}

/**
 * Groups measured inline units into visual CSS rows.  Both the game and the
 * editor supply their DOM boxes here so pagination does not depend on two
 * subtly different "same line" heuristics.
 */
export function resolveTextLayoutLineGroups(
  units: readonly LayoutUnit[],
  boxes: ReadonlyMap<number, TextUnitBox>,
): readonly (readonly number[])[] {
  const groups: number[][] = [];
  let lastCenter: number | null = null;
  let lastHeight = 0;
  let previousWasDisplayMath = false;
  let forceNextLine = false;

  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (unit === undefined) return [];
    if (unit.kind === "hard_break") {
      forceNextLine = true;
      previousWasDisplayMath = false;
      continue;
    }
    const box = boxes.get(index);
    if (box === undefined) return [];
    const height = Math.max(0, box.bottom - box.top);
    const center = box.top + height / 2;
    const tolerance = Math.max(4, Math.max(lastHeight, height) * 0.45);
    const isDisplayMath = unit.kind === "math" && unit.display;
    const startsLine =
      lastCenter === null ||
      forceNextLine ||
      previousWasDisplayMath ||
      isDisplayMath ||
      Math.abs(center - lastCenter) > tolerance;
    if (startsLine) groups.push([]);
    groups[groups.length - 1]?.push(index);
    lastCenter = center;
    lastHeight = height;
    previousWasDisplayMath = isDisplayMath;
    forceNextLine = false;
  }
  return groups;
}

/**
 * Distributes already measured visual rows onto logical paper pages.
 *
 * `auto` is deliberately row-based: a single story step can cross papers,
 * while a formula remains atomic because it owns one measured layout row.
 * `manual` only honours explicit breaks and extends a page for overflow;
 * `continuous` is a single unbroken surface.
 */
export function paginateTextLayouts(
  items: readonly TextPaginationItem[],
  mode: TextPaginationMode,
  pageHeight: number,
  paddingY: number,
  stepGap = TEXT_LAYOUT_STEP_GAP,
): TextLayoutPage[] {
  const safePageHeight = finitePositive(pageHeight);
  const safePadding = Math.max(0, finitePositive(paddingY));
  const capacity = Math.max(1, safePageHeight - safePadding * 2);
  const safeGap = Math.max(0, finitePositive(stepGap));
  const pages: TextLayoutPage[] = [];
  let fragments: TextLayoutFragment[] = [];
  let used = 0;

  const finishPage = (): void => {
    if (fragments.length === 0) return;
    pages.push({
      index: pages.length,
      fragments,
      contentHeight: used,
      height: Math.max(safePageHeight, safePadding * 2 + used),
    });
    fragments = [];
    used = 0;
  };
  const append = (
    itemId: string,
    sourceTop: number,
    height: number,
    firstLine: number,
    lastLine: number,
    gap: number,
  ): void => {
    fragments.push({
      itemId,
      sourceTop,
      height: Math.max(1, height),
      firstLine,
      lastLine,
      top: used + gap,
    });
    used += gap + Math.max(1, height);
  };

  for (const item of items) {
    const layout = item.layout;
    const lines = layout?.lines ?? [];
    // Inline roots (especially ones containing vertically aligned KaTeX)
    // can report a smaller union rect than their lowest child.  Keep the
    // final source boundary at least as low as the measured visual rows.
    const sourceHeight = Math.max(
      1,
      layout?.contentHeight ?? item.fallbackHeight ?? 180,
      ...lines.map((line) => line.bottom),
    );
    if (fragments.length > 0 && mode !== "continuous" && item.pageBreakBefore) {
      finishPage();
    }

    // A layout that is still measuring cannot safely be split.  The caller
    // receives a deterministic provisional page and re-runs after measure.
    if (mode !== "auto" || lines.length === 0) {
      const gap = fragments.length === 0 ? 0 : safeGap;
      append(item.id, 0, sourceHeight, 0, Math.max(0, lines.length - 1), gap);
      continue;
    }

    const blocks = mergeOverlappingLines(lines);
    let blockIndex = 0;
    while (blockIndex < blocks.length) {
      const block = blocks[blockIndex];
      if (block === undefined) break;
      const previous = fragments[fragments.length - 1];
      const gap =
        previous === undefined || previous.itemId === item.id ? 0 : safeGap;
      const sourceTop = block.firstLine === 0 ? 0 : block.top;
      const available = capacity - used - gap;

      // A block contains every consecutive row whose glyph boxes overlap.
      // Keeping it atomic prevents one row's descent from being rendered on
      // the preceding paper while the next row starts on the following one.
      if (
        fragmentBoundary(blocks, blockIndex, sourceHeight) - sourceTop >
          available &&
        fragments.length > 0
      ) {
        finishPage();
        continue;
      }
      let endBlockIndex = blockIndex;
      while (endBlockIndex + 1 < blocks.length) {
        const next = blocks[endBlockIndex + 1];
        if (next === undefined) break;
        const candidateBottom = fragmentBoundary(
          blocks,
          endBlockIndex + 1,
          sourceHeight,
        );
        if (candidateBottom - sourceTop > available) break;
        endBlockIndex += 1;
      }
      const lastBlock = blocks[endBlockIndex];
      if (lastBlock === undefined) break;
      // Leave the inter-row gap on the page that owns the preceding rows.
      // The next block's top is the clipping boundary; using the last glyph
      // bottom here would pull that gap into the fragment and change the
      // established reveal/scroll geometry.
      const sourceBottom = fragmentBoundary(
        blocks,
        endBlockIndex,
        sourceHeight,
      );
      append(
        item.id,
        sourceTop,
        sourceBottom - sourceTop,
        block.firstLine,
        lastBlock.lastLine,
        gap,
      );
      blockIndex = endBlockIndex + 1;
      if (blockIndex < blocks.length) finishPage();
    }
  }
  finishPage();
  return pages;
}

function finitePositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

interface LineBlock {
  readonly firstLine: number;
  readonly lastLine: number;
  readonly top: number;
  readonly bottom: number;
}

function mergeOverlappingLines(lines: readonly TextLayoutLine[]): LineBlock[] {
  const blocks: LineBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const previous = blocks[blocks.length - 1];
    if (previous !== undefined && line.top < previous.bottom) {
      blocks[blocks.length - 1] = {
        firstLine: previous.firstLine,
        lastLine: index,
        top: previous.top,
        bottom: Math.max(previous.bottom, line.bottom),
      };
      continue;
    }
    blocks.push({
      firstLine: index,
      lastLine: index,
      top: line.top,
      bottom: line.bottom,
    });
  }
  return blocks;
}

function safeMeasurementScale(value: number): number {
  return isValidTextMeasurementScale(value) ? value : 1;
}

function fragmentBoundary(
  blocks: readonly LineBlock[],
  blockIndex: number,
  sourceHeight: number,
): number {
  const block = blocks[blockIndex];
  if (block === undefined) return sourceHeight;
  const next = blocks[blockIndex + 1];
  return next === undefined
    ? Math.max(block.bottom, sourceHeight)
    : Math.max(block.bottom, next.top);
}
