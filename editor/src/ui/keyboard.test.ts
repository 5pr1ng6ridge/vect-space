// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  escapeTextEntry,
  isTextEntryTarget,
  shouldIgnoreShortcut,
} from "./keyboard";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes))
    node.setAttribute(name, value);
  document.body.append(node);
  return node;
}

describe("keyboard policy", () => {
  it("treats text inputs and textareas as text entry but not selects or checkboxes", () => {
    expect(isTextEntryTarget(element("input"))).toBe(true);
    expect(isTextEntryTarget(element("input", { type: "number" }))).toBe(true);
    expect(isTextEntryTarget(element("textarea"))).toBe(true);
    expect(isTextEntryTarget(element("select"))).toBe(false);
    expect(isTextEntryTarget(element("input", { type: "checkbox" }))).toBe(
      false,
    );
    expect(isTextEntryTarget(element("button"))).toBe(false);
  });

  it("ignores consumed keys, IME composition and typing", () => {
    const button = element("button");
    expect(
      shouldIgnoreShortcut({ defaultPrevented: true, target: button }),
    ).toBe(true);
    expect(
      shouldIgnoreShortcut({
        defaultPrevented: false,
        target: button,
        keyCode: 229,
      }),
    ).toBe(true);
    expect(
      shouldIgnoreShortcut({
        defaultPrevented: false,
        target: element("input"),
      }),
    ).toBe(true);
    expect(
      shouldIgnoreShortcut({ defaultPrevented: false, target: button }),
    ).toBe(false);
  });

  it("consumes Esc in a text field by leaving the field", () => {
    const input = element("input");
    input.focus();
    expect(escapeTextEntry({ key: "Escape", target: input })).toBe(true);
    expect(document.activeElement).not.toBe(input);
    expect(escapeTextEntry({ key: "Escape", target: element("button") })).toBe(
      false,
    );
  });
});
