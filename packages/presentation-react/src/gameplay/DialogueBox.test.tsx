import { createRef } from "react";
import { act, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DialogueBox, type DialogueBoxHandle } from "./DialogueBox";
import { staticImageSource } from "../useAnimatedImage";

const page = {
  page_id: "realization",
  speaker: "爱丽丝",
  speaker_id: "alice",
  name_color: "#80D8FF",
  text_color: "#FFFFFF",
  segments: ["等等……", "我想起来了。"],
};

describe("DialogueBox continued pages", () => {
  it("skips a pause and continues across prompts while immediate reveal is held", () => {
    vi.useFakeTimers();
    const handle = createRef<DialogueBoxHandle>();
    const onComplete = vi.fn();
    const props = {
      defaultCps: 30,
      initialCps: 30,
      dialogueBoxSource: staticImageSource("dialogue.png"),
      nameBoxSource: staticImageSource("name.png"),
      disabled: false,
      visible: true,
      onRevealComplete: onComplete,
      onTypingChange: vi.fn(),
      page,
    };
    const prompt = {
      kind: "dialogue" as const,
      prompt_id: "first",
      speaker: null,
      speaker_id: null,
      name_color: null,
      text_color: null,
      text: "A[pause=10000ms]B",
      is_read: true,
    };
    const view = render(
      <DialogueBox
        {...props}
        prompt={prompt}
        ref={handle}
        revealImmediately={false}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(handle.current?.isComplete()).toBe(false);
    view.rerender(
      <DialogueBox {...props} prompt={prompt} ref={handle} revealImmediately />,
    );
    expect(handle.current?.isComplete()).toBe(true);
    expect(onComplete).toHaveBeenCalledWith("first");
    view.rerender(
      <DialogueBox
        {...props}
        prompt={{ ...prompt, prompt_id: "second" }}
        ref={handle}
        revealImmediately
      />,
    );
    expect(handle.current?.isComplete()).toBe(true);
    expect(onComplete).toHaveBeenCalledWith("second");
    view.unmount();
    vi.useRealTimers();
  });
  it("renders completed segments before the currently revealing segment", () => {
    const html = renderToStaticMarkup(
      <DialogueBox
        defaultCps={30}
        dialogueBoxSource={staticImageSource("dialogue.png")}
        disabled={false}
        initialCps={30}
        nameBoxSource={staticImageSource("name.png")}
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
        dialogueBoxSource={staticImageSource("dialogue.png")}
        disabled
        initialCps={30}
        nameBoxSource={staticImageSource("name.png")}
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

  it("keeps the frame and all dialogue content on one motion surface", () => {
    const { container } = render(
      <DialogueBox
        defaultCps={30}
        dialogueBoxSource={staticImageSource("dialogue.png")}
        disabled
        initialCps={30}
        nameBoxSource={staticImageSource("name.png")}
        onRevealComplete={vi.fn()}
        onTypingChange={vi.fn()}
        page={page}
        prompt={{
          kind: "dialogue",
          prompt_id: "surface",
          speaker: "爱丽丝",
          speaker_id: "alice",
          name_color: "#80D8FF",
          text_color: "#FFFFFF",
          text: "正文",
          is_read: true,
        }}
        ref={createRef<DialogueBoxHandle>()}
        revealImmediately
        visible
      />,
    );
    const surface = container.querySelector(".dialogue-surface");
    expect(surface).not.toBeNull();
    expect(surface?.querySelector(".dialogue-frame")).not.toBeNull();
    expect(surface?.querySelector(".speaker-name")).not.toBeNull();
    expect(surface?.querySelector(".dialogue-text")).not.toBeNull();
    expect(surface?.querySelector(".advance-indicator")).not.toBeNull();
  });

  it("retains the hidden state on the shared surface", () => {
    const { container } = render(
      <DialogueBox
        defaultCps={30}
        dialogueBoxSource={staticImageSource("dialogue.png")}
        disabled
        initialCps={30}
        nameBoxSource={staticImageSource("name.png")}
        onRevealComplete={vi.fn()}
        onTypingChange={vi.fn()}
        page={page}
        prompt={{
          kind: "dialogue",
          prompt_id: "hidden-surface",
          speaker: null,
          speaker_id: null,
          name_color: null,
          text_color: null,
          text: "隐藏文本",
          is_read: true,
        }}
        ref={createRef<DialogueBoxHandle>()}
        revealImmediately
        visible={false}
      />,
    );
    expect(container.querySelector(".dialogue-box")).toHaveClass("is-hidden");
    expect(container.querySelector(".dialogue-surface")).not.toBeNull();
    expect(
      container.querySelector<HTMLElement>(".dialogue-text .markup-unit")?.style
        .visibility,
    ).toBe("inherit");
  });
});
