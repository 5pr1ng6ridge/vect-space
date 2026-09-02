import type { LongTextStepSnapshot } from "../engine/types";

// Kept as exported compatibility defaults for content tests and tools.
export const LONG_TEXT_PAGE_HEIGHT = 1_340;
export const LONG_TEXT_PAGE_PADDING_TOP = 112;
export const LONG_TEXT_PAGE_PADDING_BOTTOM = 128;
export const LONG_TEXT_PAGE_GAP = 92;

export interface LongTextPaperPage {
  steps: LongTextStepSnapshot[];
  index: number;
  contentHeight: number;
  height: number;
}

export interface LongTextPageWindow {
  start: number;
  end: number;
}

export const LONG_TEXT_STEP_GAP = 28;

export function paginateLongTextSteps(
  steps: readonly LongTextStepSnapshot[],
  heights: Readonly<Record<string, number>>,
  mode: "continuous" | "auto" | "manual" = "auto",
  pageHeight = 1_340,
  paddingY = 112,
): LongTextPaperPage[] {
  const capacity = pageHeight - paddingY * 2;
  const pages: LongTextPaperPage[] = [];
  let current: LongTextStepSnapshot[] = [];
  let used = 0;
  const completePage = (): void => {
    pages.push({
      steps: current,
      index: pages.length,
      contentHeight: used,
      height: Math.max(pageHeight, paddingY * 2 + used),
    });
  };
  for (const step of steps) {
    const height = heights[step.step_id] ?? 180;
    const gap = current.length === 0 ? 0 : LONG_TEXT_STEP_GAP;
    if (
      current.length > 0 &&
      ((mode !== "continuous" && step.page_break_before) ||
        (mode === "auto" && used + gap + height > capacity))
    ) {
      completePage();
      current = [];
      used = 0;
    }
    const nextGap = current.length === 0 ? 0 : LONG_TEXT_STEP_GAP;
    current.push(step);
    used += nextGap + height;
  }
  if (current.length > 0) completePage();
  return pages;
}

/** Returns an end-exclusive page window with two viewports of overscan. */
export function resolveLongTextPageWindow(
  pages: readonly LongTextPaperPage[],
  pageOffsets: readonly number[],
  scrollOffset: number,
  viewportHeight: number,
  overscan = viewportHeight * 2,
): LongTextPageWindow {
  if (pages.length === 0) return { start: 0, end: 0 };
  const lower = Math.max(0, scrollOffset - overscan);
  const upper = scrollOffset + viewportHeight + overscan;

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
