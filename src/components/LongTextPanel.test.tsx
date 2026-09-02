import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LongTextPanel, type LongTextPanelHandle } from "./LongTextPanel";
import {
  LONG_TEXT_PAGE_HEIGHT,
  LONG_TEXT_PAGE_PADDING_BOTTOM,
  LONG_TEXT_PAGE_PADDING_TOP,
  LONG_TEXT_STEP_GAP,
  paginateLongTextSteps,
} from "./longTextPagination";
import {
  advanceLongTextScroll,
  LONG_TEXT_BOTTOM_BROWSING_SPACE,
  longTextFollowTarget,
  longTextMaxScroll,
  resolveLongTextScroll,
} from "./longTextScroll";

describe("LongTextPanel", () => {
  it("keeps revealed steps on paper and starts a new paper at manual breaks", () => {
    const html = renderToStaticMarkup(
      <LongTextPanel
        defaultCps={30}
        disabled={false}
        fastForward={false}
        initialCps={30}
        onRevealComplete={vi.fn()}
        onTypingChange={vi.fn()}
        page={{
          document_id: "prologue/lecture",
          paper: null,
          pagination: "auto",
          font_size: 32,
          text_color: "#212533",
          layout: {
            x: 340,
            y: 0,
            width: 1240,
            height: 1080,
            padding_x: 118,
            padding_y: 112,
            page_height: 1340,
            page_gap: 92,
          },
          active_step_index: 1,
          steps: [
            {
              step_id: "definition",
              text: "第一段：设 $V$ 是向量空间。",
              page_break_before: false,
            },
            {
              step_id: "derivation",
              text: "第二段：于是 $0\\in V$。",
              page_break_before: true,
            },
          ],
        }}
        paperUrl={undefined}
        prompt={{
          kind: "long_text",
          prompt_id: "prologue/lecture/derivation",
          document_id: "prologue/lecture",
          step_id: "derivation",
          step_index: 1,
          text: "第二段：于是 $0\\in V$。",
          is_read: false,
        }}
        ref={createRef<LongTextPanelHandle>()}
        revealImmediately={false}
      />,
    );

    expect(html).toContain('aria-label="长文本"');
    expect(html).toContain("第一段：设");
    expect(html).toContain("第二段：于是");
    expect(html.match(/class="long-text-paper"/g)).toHaveLength(2);
    expect(html).toContain("long-text-indicator");
  });

  it("starts a new sheet when the measured paper capacity is exhausted", () => {
    const pages = paginateLongTextSteps(
      [
        { step_id: "first", text: "第一段", page_break_before: false },
        { step_id: "second", text: "第二段", page_break_before: false },
      ],
      { first: 800, second: 400 },
    );

    expect(pages).toHaveLength(2);
    expect(pages[0]?.steps.map((step) => step.step_id)).toEqual(["first"]);
    expect(pages[1]?.steps.map((step) => step.step_id)).toEqual(["second"]);
  });

  it("accounts for the visible gap between steps at the paper boundary", () => {
    const capacity =
      LONG_TEXT_PAGE_HEIGHT -
      LONG_TEXT_PAGE_PADDING_TOP -
      LONG_TEXT_PAGE_PADDING_BOTTOM;
    const pages = paginateLongTextSteps(
      [
        { step_id: "first", text: "第一段", page_break_before: false },
        { step_id: "second", text: "第二段", page_break_before: false },
      ],
      { first: 400, second: capacity - 400 },
    );

    expect(LONG_TEXT_STEP_GAP).toBeGreaterThan(0);
    expect(pages).toHaveLength(2);
  });

  it("only honors explicit breaks in manual pagination mode", () => {
    const capacity =
      LONG_TEXT_PAGE_HEIGHT -
      LONG_TEXT_PAGE_PADDING_TOP -
      LONG_TEXT_PAGE_PADDING_BOTTOM;
    const steps = [
      { step_id: "first", text: "第一段", page_break_before: false },
      { step_id: "second", text: "第二段", page_break_before: false },
      { step_id: "third", text: "第三段", page_break_before: true },
    ];
    const pages = paginateLongTextSteps(
      steps,
      { first: capacity - 100, second: 300, third: 200 },
      "manual",
    );

    expect(pages).toHaveLength(2);
    expect(pages[0]?.steps.map((step) => step.step_id)).toEqual([
      "first",
      "second",
    ]);
    expect(pages[0]?.height).toBeGreaterThan(LONG_TEXT_PAGE_HEIGHT);
    expect(pages[1]?.steps.map((step) => step.step_id)).toEqual(["third"]);
  });

  it("expands a paper rather than clipping one oversized text step", () => {
    const capacity =
      LONG_TEXT_PAGE_HEIGHT -
      LONG_TEXT_PAGE_PADDING_TOP -
      LONG_TEXT_PAGE_PADDING_BOTTOM;
    const pages = paginateLongTextSteps(
      [{ step_id: "large", text: "很长的证明", page_break_before: false }],
      { large: capacity + 240 },
    );

    expect(pages).toHaveLength(1);
    expect(pages[0]?.contentHeight).toBe(capacity + 240);
    // The new layout has symmetric 112px vertical padding.  An oversized
    // manual page grows from that stable content box instead of clipping.
    expect(pages[0]?.height).toBe(
      LONG_TEXT_PAGE_PADDING_TOP + LONG_TEXT_PAGE_PADDING_TOP + capacity + 240,
    );
  });

  it("leaves browsing space below the final sheet", () => {
    expect(longTextMaxScroll(LONG_TEXT_PAGE_HEIGHT)).toBe(
      LONG_TEXT_PAGE_HEIGHT - 1_080 + LONG_TEXT_BOTTOM_BROWSING_SPACE,
    );
    expect(LONG_TEXT_BOTTOM_BROWSING_SPACE).toBeGreaterThan(70);
  });

  it("jumps once for a new step, then waits for a long step to cross again", () => {
    expect(
      resolveLongTextScroll({
        initialPositioned: false,
        manuallyBrowsing: false,
        stepStartY: 1_100,
        cursorY: 1_100,
        currentOffset: 0,
        maxScroll: 900,
      }),
    ).toEqual({ offset: 540, instant: true });

    expect(
      resolveLongTextScroll({
        initialPositioned: true,
        manuallyBrowsing: false,
        stepStartY: 1_100,
        cursorY: 1_324,
        currentOffset: 540,
        maxScroll: 900,
      }),
    ).toBeNull();

    expect(
      resolveLongTextScroll({
        initialPositioned: true,
        manuallyBrowsing: false,
        stepStartY: 1_100,
        cursorY: 1_326,
        currentOffset: 540,
        maxScroll: 900,
      }),
    ).toEqual({ offset: 766, instant: false });
  });

  it("animates a new placement after the document has already been positioned", () => {
    expect(
      resolveLongTextScroll({
        initialPositioned: false,
        initialPlacementInstant: false,
        manuallyBrowsing: false,
        stepStartY: 1_700,
        cursorY: 1_700,
        currentOffset: 420,
        maxScroll: 1_500,
      }),
    ).toEqual({ offset: 1_140, instant: false });
  });

  it("keeps the new follower bounded through a stalled frame and resumes from manual positions", () => {
    expect(
      longTextFollowTarget({
        cursorY: 821,
        viewportHeight: 1_080,
        maxScroll: 2_000,
      }),
    ).toBeCloseTo(151.4);
    expect(
      advanceLongTextScroll(320, 1_800, 2_000, false) - 320,
    ).toBeLessThanOrEqual(120);
    expect(
      advanceLongTextScroll(320, 1_800, 2_000, true) - 320,
    ).toBeLessThanOrEqual(600);
  });
});
