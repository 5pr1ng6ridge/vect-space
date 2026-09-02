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
