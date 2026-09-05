import { createRef } from "react";
import { act, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DialogueBox, type DialogueBoxHandle } from "./DialogueBox";
import { MarkupText } from "./MarkupText";

const page = {
  page_id: "text-architecture",
  speaker: "爱丽丝",
  speaker_id: "alice",
  name_color: "#80D8FF",
  text_color: "#FFFFFF",
  segments: [],
};
const prompt = {
  kind: "dialogue" as const,
  prompt_id: "text-architecture/line",
  speaker: "爱丽丝",
  speaker_id: "alice",
  name_color: "#80D8FF",
  text_color: "#FFFFFF",
  text: "甲乙",
  is_read: false,
};
const sessionKey = "update-7:text-architecture/line";

describe("text rendering boundaries", () => {
  it("keeps hard breaks in layout while excluding them from reveal units", () => {
    const html = renderToStaticMarkup(
      <MarkupText source={"甲\n乙"} visibleCount={1} />,
    );
    const root = document.createElement("div");
    root.innerHTML = html;
    const units = [...root.querySelectorAll<HTMLElement>(".markup-unit")];
    expect(units).toHaveLength(3);
    expect(units[0]?.style.visibility).toBe("visible");
    expect(units[1]?.classList.contains("line-break-unit")).toBe(true);
    expect(units[2]?.style.visibility).toBe("hidden");
    expect(root.querySelector("br")).not.toBeNull();
  });

  it("does not expose text after a pause before the prompt is complete", () => {
    const html = renderToStaticMarkup(
      <MarkupText
        source="先[pause=500ms]后"
        visibleCount={1}
        revealSchedule={[50, 600]}
        pauseWindows={[{ startMs: 50, endMs: 550 }]}
      />,
    );
    const root = document.createElement("div");
    root.innerHTML = html;
    const characters = [
      ...root.querySelectorAll<HTMLElement>(".character-unit"),
    ].filter((element) => !element.classList.contains("line-break-unit"));
    expect(characters[0]?.style.visibility).toBe("visible");
    expect(characters[1]?.style.visibility).toBe("hidden");
  });

  it("keeps display math as one mounted atomic unit during reveal", () => {
    const html = renderToStaticMarkup(
      <MarkupText
        animateMath
        revealAnimation="drop_fade"
        source="说明 $$A\\subseteq B$$"
        visibleCount={2}
      />,
    );
    const root = document.createElement("div");
    root.innerHTML = html;
    const formula = root.querySelector<HTMLElement>(".display-math");
    expect(formula).not.toBeNull();
    expect(formula?.querySelectorAll(".katex")).toHaveLength(1);
    expect(formula?.classList.contains("is-reveal-drop_fade")).toBe(false);
  });
});

describe("DialogueBox live completion versus restore", () => {
  it("uses the imperative completion path without requiring restoreImmediately", () => {
    const handle = createRef<DialogueBoxHandle>();
    const onRevealComplete = vi.fn();
    render(
      <DialogueBox
        defaultCps={30}
        dialogueBoxUrl="dialogue.png"
        disabled={false}
        initialCps={30}
        nameBoxUrl="name.png"
        onRevealComplete={onRevealComplete}
        onTypingChange={vi.fn()}
        page={page}
        prompt={prompt}
        ref={handle}
        revealImmediately={false}
        sessionKey={sessionKey}
        visible
      />,
    );
    expect(handle.current?.isComplete()).toBe(false);
    act(() => handle.current?.complete());
    expect(handle.current?.isComplete()).toBe(true);
    expect(onRevealComplete).toHaveBeenCalledWith(sessionKey);
  });

  it("restores a prompt at its final state on mount", () => {
    const handle = createRef<DialogueBoxHandle>();
    const onRevealComplete = vi.fn();
    render(
      <DialogueBox
        defaultCps={30}
        dialogueBoxUrl="dialogue.png"
        disabled={false}
        initialCps={30}
        nameBoxUrl="name.png"
        onRevealComplete={onRevealComplete}
        onTypingChange={vi.fn()}
        page={page}
        prompt={prompt}
        ref={handle}
        revealImmediately
        sessionKey={sessionKey}
        visible
      />,
    );
    expect(handle.current?.isComplete()).toBe(true);
    expect(onRevealComplete).toHaveBeenCalledWith(sessionKey);
  });
});
