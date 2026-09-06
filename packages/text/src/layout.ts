import type { LayoutUnit } from "./markup";

/** Renderer-neutral measured layout data, always expressed in unscaled CSS/design pixels. */
export interface TextUnitBox {
  index: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
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

    let lineIndex = 0;
    while (lineIndex < lines.length) {
      const first = lines[lineIndex];
      if (first === undefined) break;
      const previous = fragments[fragments.length - 1];
      const gap =
        previous === undefined || previous.itemId === item.id ? 0 : safeGap;
      const available = capacity - used - gap;
      const sourceTop = lineIndex === 0 ? 0 : first.top;
      let endIndex = lineIndex;
      while (endIndex < lines.length) {
        const line = lines[endIndex];
        if (line === undefined) break;
        // A unit's DOM rect is a glyph/inline box, not a complete CSS line
        // box.  Slicing at `line.bottom` therefore clips the descent and the
        // line-leading below the last visual row of a fragment.  The next
        // row's stable top is the only shared, renderer-neutral boundary.
        const nextLine = lines[endIndex + 1];
        const lastLine = lines[endIndex];
        // A browser inline rect can overlap the next row's top (large
        // glyphs, KaTeX and fallback fonts all do this). The boundary must
        // contain both the following row's leading and the current row's
        // descent; using only `nextLine.top` crops the lower part of a
        // fragment in both renderers.
        const nextBoundary = Math.max(
          nextLine?.top ?? sourceHeight,
          lastLine?.bottom ?? sourceHeight,
        );
        if (nextBoundary - sourceTop > available) break;
        endIndex += 1;
      }

      // If the current page has no room for the next row, start a fresh
      // paper. An over-height atomic row is then allowed to extend that page.
      if (endIndex === lineIndex && fragments.length > 0) {
        finishPage();
        continue;
      }
      endIndex = Math.max(lineIndex + 1, endIndex);
      const nextLine = lines[endIndex];
      const lastLine = lines[endIndex - 1];
      const sourceBottom = Math.max(
        nextLine?.top ?? sourceHeight,
        lastLine?.bottom ?? sourceHeight,
      );
      append(
        item.id,
        sourceTop,
        sourceBottom - sourceTop,
        lineIndex,
        endIndex - 1,
        gap,
      );
      lineIndex = endIndex;
      if (lineIndex < lines.length) finishPage();
    }
  }
  finishPage();
  return pages;
}

function finitePositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
