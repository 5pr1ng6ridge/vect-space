// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { shouldReplayBurst } from "./burstShortcut";

let scope: HTMLElement;
let preview: HTMLElement;
let field: HTMLInputElement;
let area: HTMLTextAreaElement;
let select: HTMLSelectElement;
let outsideButton: HTMLButtonElement;
let replayButton: HTMLButtonElement;
let slider: HTMLInputElement;
let checkbox: HTMLInputElement;
let elsewhere: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = `
    <main id="scope">
      <aside>
        <input id="field" type="text" />
        <textarea id="area"></textarea>
        <select id="select"><option>a</option></select>
        <input id="checkbox" type="checkbox" />
        <button id="outside">保存</button>
      </aside>
      <section id="preview">
        <button id="replay">重播</button>
        <input id="slider" type="range" />
      </section>
    </main>
    <div id="elsewhere" tabindex="-1"></div>`;
  scope = document.getElementById("scope") as HTMLElement;
  preview = document.getElementById("preview") as HTMLElement;
  field = document.getElementById("field") as HTMLInputElement;
  area = document.getElementById("area") as HTMLTextAreaElement;
  select = document.getElementById("select") as HTMLSelectElement;
  checkbox = document.getElementById("checkbox") as HTMLInputElement;
  outsideButton = document.getElementById("outside") as HTMLButtonElement;
  replayButton = document.getElementById("replay") as HTMLButtonElement;
  slider = document.getElementById("slider") as HTMLInputElement;
  elsewhere = document.getElementById("elsewhere") as HTMLElement;
});

afterEach(() => {
  document.body.innerHTML = "";
});

/** Dispatches a real keydown so `event.target` is the focused element. */
function press(
  target: EventTarget,
  init: KeyboardEventInit & { keyCode?: number } = {},
): KeyboardEvent {
  let seen: KeyboardEvent | null = null;
  const capture = (event: Event): void => {
    seen = event as KeyboardEvent;
  };
  window.addEventListener("keydown", capture);
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
  window.removeEventListener("keydown", capture);
  if (seen === null) throw new Error("keydown not delivered");
  return seen;
}

function replays(target: EventTarget, init?: KeyboardEventInit): boolean {
  return shouldReplayBurst(press(target, init), scope, preview);
}

describe("burst replay shortcut policy", () => {
  it("replays on a bare document and on the preview's own controls", () => {
    expect(replays(document.body)).toBe(true);
    // The transport's buttons and slider are part of the shortcut surface; the
    // caller suppresses the native click so it cannot replay twice.
    expect(replays(replayButton)).toBe(true);
    expect(replays(slider)).toBe(true);
    expect(replays(preview)).toBe(true);
  });

  it("ignores text entry, a select and a checkbox: Space belongs to them", () => {
    expect(replays(field)).toBe(false);
    expect(replays(area)).toBe(false);
    expect(replays(select)).toBe(false);
    expect(replays(checkbox)).toBe(false);
  });

  it("leaves a button outside the preview to its native activation", () => {
    expect(replays(outsideButton)).toBe(false);
  });

  it("ignores presses that do not belong to this workspace", () => {
    elsewhere.focus();
    expect(replays(elsewhere)).toBe(false);
  });

  it("ignores modifiers, key repeat, IME composition and consumed keys", () => {
    expect(replays(document.body, { ctrlKey: true })).toBe(false);
    expect(replays(document.body, { altKey: true })).toBe(false);
    expect(replays(document.body, { metaKey: true })).toBe(false);
    expect(replays(document.body, { shiftKey: true })).toBe(false);
    expect(replays(document.body, { repeat: true })).toBe(false);
    expect(replays(document.body, { isComposing: true })).toBe(false);
    expect(replays(document.body, { keyCode: 229 })).toBe(false);
    // Only Space replays.
    expect(replays(document.body, { key: "Enter", code: "Enter" })).toBe(false);

    const consumed = new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      cancelable: true,
    });
    consumed.preventDefault();
    expect(shouldReplayBurst(consumed, scope, preview)).toBe(false);
  });

  it("yields to dialogs, menus and listboxes", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inner = document.createElement("button");
    dialog.append(inner);
    document.body.append(dialog);
    // A modal anywhere owns the keyboard, even for presses on the bare page.
    expect(replays(document.body)).toBe(false);
    expect(replays(inner)).toBe(false);
    dialog.remove();

    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const item = document.createElement("div");
    menu.append(item);
    scope.append(menu);
    expect(replays(item)).toBe(false);
  });
});
