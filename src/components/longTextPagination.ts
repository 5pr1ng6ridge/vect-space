import type { LongTextStepSnapshot } from "../engine/types";

export interface LongTextPaperPage {
  steps: LongTextStepSnapshot[];
  index: number;
  contentHeight: number;
  height: number;
}

export const LONG_TEXT_PAGE_HEIGHT = 1_340;
export const LONG_TEXT_PAGE_GAP = 92;
export const LONG_TEXT_PAGE_PADDING_TOP = 112;
export const LONG_TEXT_PAGE_PADDING_BOTTOM = 128;
export const LONG_TEXT_STEP_GAP = 28;

export function paginateLongTextSteps(
  steps: readonly LongTextStepSnapshot[],
  heights: Readonly<Record<string, number>>,
): LongTextPaperPage[] {
  const capacity =
    LONG_TEXT_PAGE_HEIGHT -
    LONG_TEXT_PAGE_PADDING_TOP -
    LONG_TEXT_PAGE_PADDING_BOTTOM;
  const pages: LongTextPaperPage[] = [];
  let current: LongTextStepSnapshot[] = [];
  let used = 0;
  const completePage = (): void => {
    pages.push({
      steps: current,
      index: pages.length,
      contentHeight: used,
      height: Math.max(
        LONG_TEXT_PAGE_HEIGHT,
        LONG_TEXT_PAGE_PADDING_TOP + used + LONG_TEXT_PAGE_PADDING_BOTTOM,
      ),
    });
  };
  for (const step of steps) {
    const height = heights[step.step_id] ?? 180;
    const gap = current.length === 0 ? 0 : LONG_TEXT_STEP_GAP;
    if (
      current.length > 0 &&
      (step.page_break_before || used + gap + height > capacity)
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
