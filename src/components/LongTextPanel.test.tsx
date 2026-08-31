import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  LongTextPanel,
  paginateLongTextSteps,
  type LongTextPanelHandle,
} from "./LongTextPanel";

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
});
