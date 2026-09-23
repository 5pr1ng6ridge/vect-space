// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  isEditableTarget,
  isInteractiveTarget,
  shouldIgnoreNodeDeletion,
} from "./nodeDeleteShortcut";

function element(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  const first = host.firstElementChild;
  if (!(first instanceof HTMLElement)) throw new Error("missing element");
  return first;
}

describe("node deletion shortcut guards", () => {
  it("treats text fields and contenteditable regions as editable", () => {
    expect(isEditableTarget(element("<input />"))).toBe(true);
    expect(isEditableTarget(element("<textarea></textarea>"))).toBe(true);
    expect(isEditableTarget(element("<select></select>"))).toBe(true);
    expect(
      isEditableTarget(element('<div contenteditable="true"></div>')),
    ).toBe(true);
    expect(isEditableTarget(element('<div contenteditable=""></div>'))).toBe(
      true,
    );
    // Descendants of an editing host are editable too.
    expect(
      isEditableTarget(
        element('<div contenteditable="true"><span id="inner">x</span></div>')
          .firstElementChild,
      ),
    ).toBe(true);
    expect(isEditableTarget(element("<div>plain</div>"))).toBe(false);
    expect(isEditableTarget(element("<button>ok</button>"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(document)).toBe(false);
  });

  it("treats pane chrome as interactive", () => {
    expect(isInteractiveTarget(element("<button>布局</button>"))).toBe(true);
    expect(isInteractiveTarget(element('<div role="menu"></div>'))).toBe(true);
    expect(isInteractiveTarget(element("<input />"))).toBe(true);
    // A React Flow node wrapper is a tabbable group, not a control.
    expect(
      isInteractiveTarget(element('<div role="group" tabindex="0"></div>')),
    ).toBe(false);
    expect(isInteractiveTarget(element("<div></div>"))).toBe(false);
    expect(isInteractiveTarget(null)).toBe(false);
  });

  it("ignores auto-repeat, IME composition and editable focus", () => {
    const plain = element("<div></div>");
    expect(shouldIgnoreNodeDeletion({ repeat: false, target: plain })).toBe(
      false,
    );
    expect(shouldIgnoreNodeDeletion({ repeat: true, target: plain })).toBe(
      true,
    );
    expect(
      shouldIgnoreNodeDeletion({ keyCode: 229, repeat: false, target: plain }),
    ).toBe(true);
    expect(
      shouldIgnoreNodeDeletion({
        isComposing: true,
        repeat: false,
        target: plain,
      }),
    ).toBe(true);
    expect(
      shouldIgnoreNodeDeletion({
        repeat: false,
        target: element("<input />"),
      }),
    ).toBe(true);
  });
});
