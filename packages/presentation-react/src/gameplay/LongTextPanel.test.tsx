import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LongTextPanel, type LongTextPanelHandle } from "./LongTextPanel";
import {
  LONG_TEXT_PAGE_HEIGHT,
  resolveLongTextPageWindow,
} from "./longTextPagination";
import {
  advanceLongTextScroll,
  hasReachedLongTextRevealThreshold,
  LONG_TEXT_BOTTOM_BROWSING_SPACE,
  longTextFollowTarget,
  longTextMaxScroll,
  longTextParagraphTarget,
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
        paperSource={undefined}
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
    expect(html.match(/class="long-text-paper-content-inner"/g)).toHaveLength(
      2,
    );
    expect(html).toContain("long-text-indicator");
  });

  it("hides the paper and its explicit markup units as one presentation surface", () => {
    const html = renderToStaticMarkup(
      <LongTextPanel
        defaultCps={30}
        disabled={false}
        fastForward={false}
        initialCps={30}
        onRevealComplete={vi.fn()}
        onTypingChange={vi.fn()}
        page={{
          document_id: "prologue/hidden-document",
          visible: false,
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
          steps: [
            {
              step_id: "hidden",
              text: "隐藏的 $x$ 文本",
              page_break_before: false,
            },
          ],
          active_step_index: 0,
        }}
        paperSource={undefined}
        prompt={null}
        ref={createRef<LongTextPanelHandle>()}
        revealImmediately
        visible={false}
      />,
    );

    expect(html).toContain('class="long-text-panel is-hidden"');
    expect(html).toContain('style="display:none;visibility:hidden"');
  });

  it("leaves browsing space below the final sheet", () => {
    expect(longTextMaxScroll(LONG_TEXT_PAGE_HEIGHT)).toBe(
      LONG_TEXT_PAGE_HEIGHT - 1_080 + LONG_TEXT_BOTTOM_BROWSING_SPACE,
    );
    expect(LONG_TEXT_BOTTOM_BROWSING_SPACE).toBeGreaterThan(70);
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

  it("places each paragraph once before reveal and keeps already fitting text still", () => {
    expect(
      longTextParagraphTarget({
        stepStartY: 300,
        stepHeight: 260,
        currentOffset: 100,
        viewportHeight: 1_080,
        maxScroll: 2_000,
      }),
    ).toBe(100);
    expect(
      longTextParagraphTarget({
        stepStartY: 1_200,
        stepHeight: 240,
        currentOffset: 300,
        viewportHeight: 1_080,
        maxScroll: 2_000,
      }),
    ).toBeCloseTo(619.2);
    expect(
      longTextParagraphTarget({
        stepStartY: 1_200,
        stepHeight: 900,
        currentOffset: 300,
        viewportHeight: 1_080,
        maxScroll: 2_000,
      }),
    ).toBe(1_104);
  });

  it("starts revealing halfway through a paragraph scroll in either direction", () => {
    expect(
      hasReachedLongTextRevealThreshold({
        startOffset: 200,
        targetOffset: 600,
        currentOffset: 399,
      }),
    ).toBe(false);
    expect(
      hasReachedLongTextRevealThreshold({
        startOffset: 200,
        targetOffset: 600,
        currentOffset: 400,
      }),
    ).toBe(true);
    expect(
      hasReachedLongTextRevealThreshold({
        startOffset: 800,
        targetOffset: 400,
        currentOffset: 600,
      }),
    ).toBe(true);
    expect(
      hasReachedLongTextRevealThreshold({
        startOffset: 320,
        targetOffset: 320.2,
        currentOffset: 320,
      }),
    ).toBe(true);
  });

  it("renders only a bounded page window for large long-text documents", () => {
    const pages = Array.from({ length: 1_000 }, (_, index) => ({
      steps: [],
      index,
      contentHeight: 1_000,
      height: 1_340,
    }));
    const offsets = pages.map((_page, index) => index * 1_432);
    const window = resolveLongTextPageWindow(
      pages,
      offsets,
      offsets[500] ?? 0,
      1_080,
    );
    expect(window.start).toBeGreaterThanOrEqual(498);
    expect(window.end - window.start).toBeLessThanOrEqual(6);
    expect(window.start).toBeLessThanOrEqual(500);
    expect(window.end).toBeGreaterThan(500);
  });
});
