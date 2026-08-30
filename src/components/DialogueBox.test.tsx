import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DialogueBox, type DialogueBoxHandle } from "./DialogueBox";

const page = {
  page_id: "realization",
  speaker: "爱丽丝",
  speaker_id: "alice",
  name_color: "#80D8FF",
  text_color: "#FFFFFF",
  segments: ["等等……", "我想起来了。"],
};

describe("DialogueBox continued pages", () => {
  it("renders completed segments before the currently revealing segment", () => {
    const html = renderToStaticMarkup(
      <DialogueBox
        defaultCps={30}
        dialogueBoxUrl="dialogue.png"
        disabled={false}
        initialCps={30}
        nameBoxUrl="name.png"
        onRevealComplete={vi.fn()}
        onTypingChange={vi.fn()}
        page={page}
        prompt={{
          kind: "dialogue",
          prompt_id: "scene/second",
          speaker: "爱丽丝",
          speaker_id: "alice",
          name_color: "#80D8FF",
          text_color: "#FFFFFF",
          text: "我想起来了。",
          is_read: false,
        }}
        ref={createRef<DialogueBoxHandle>()}
        revealImmediately={false}
        visible
      />,
    );
    expect(html).toContain("等等……");
    expect(html).toContain("我想起来了。");
    expect(html).toContain("advance-indicator");
  });

  it("keeps the entire page visible while runtime presentation is between segments", () => {
    const html = renderToStaticMarkup(
      <DialogueBox
        defaultCps={30}
        dialogueBoxUrl="dialogue.png"
        disabled
        initialCps={30}
        nameBoxUrl="name.png"
        onRevealComplete={vi.fn()}
        onTypingChange={vi.fn()}
        page={{ ...page, segments: ["等等……"] }}
        prompt={null}
        ref={createRef<DialogueBoxHandle>()}
        revealImmediately
        visible
      />,
    );
    expect(html).toContain("等等……");
    expect(html).not.toContain("advance-indicator");
  });
});
