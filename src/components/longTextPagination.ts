import {
  paginateTextLayouts,
  TEXT_LAYOUT_STEP_GAP,
  type TextLayoutSnapshot,
} from "@vectspace/text";

import type { LongTextStepSnapshot } from "../engine/types";

export const LONG_TEXT_PAGE_HEIGHT = 1_340;
export const LONG_TEXT_PAGE_PADDING_TOP = 112;

export interface LongTextPageWindow {
  start: number;
  end: number;
}

export interface LongTextVisualFragment {
  readonly step: LongTextStepSnapshot;
  /** Offset within the source step that is clipped into this paper. */
  readonly sourceTop: number;
  readonly height: number;
  /** Top within the page content box (before the paper padding). */
  readonly top: number;
  readonly firstLine: number;
  readonly lastLine: number;
}

export interface LongTextVisualPage {
  readonly fragments: readonly LongTextVisualFragment[];
  readonly index: number;
  readonly contentHeight: number;
  readonly height: number;
}

export const LONG_TEXT_STEP_GAP = TEXT_LAYOUT_STEP_GAP;

/**
 * Stable visual-line pagination for long text. A sentence/step is still one
 * story advance unit, but in `auto` mode its already measured visual rows may
 * continue onto later papers. Formulae stay atomic because KaTeX is measured
 * as one layout unit/row.
 */
export function paginateLongTextVisualSteps(
  steps: readonly LongTextStepSnapshot[],
  layouts: Readonly<Record<string, TextLayoutSnapshot | undefined>>,
  mode: "continuous" | "auto" | "manual" = "auto",
  pageHeight = LONG_TEXT_PAGE_HEIGHT,
  paddingY = LONG_TEXT_PAGE_PADDING_TOP,
): LongTextVisualPage[] {
  const byId = new Map(steps.map((step) => [step.step_id, step] as const));
  return paginateTextLayouts(
    steps.map((step) => ({
      id: step.step_id,
      pageBreakBefore: step.page_break_before,
      layout: layouts[step.step_id],
      fallbackHeight: 180,
    })),
    mode,
    pageHeight,
    paddingY,
    LONG_TEXT_STEP_GAP,
  ).map((page) => ({
    index: page.index,
    contentHeight: page.contentHeight,
    height: page.height,
    fragments: page.fragments.flatMap((fragment) => {
      const step = byId.get(fragment.itemId);
      return step === undefined ? [] : [{ ...fragment, step }];
    }),
  }));
}

/** Returns an end-exclusive page window with two viewports of overscan. */
export function resolveLongTextPageWindow(
  pages: readonly { height: number }[],
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
