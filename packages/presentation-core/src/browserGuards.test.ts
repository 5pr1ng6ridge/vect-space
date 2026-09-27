// @vitest-environment jsdom

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installBrowserGuards } from "./browserGuards";

function press(init: KeyboardEventInit): {
  event: KeyboardEvent;
  reachedApp: boolean;
} {
  let reachedApp = false;
  const listener = (): void => {
    reachedApp = true;
  };
  document.body.addEventListener("keydown", listener);
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  document.body.dispatchEvent(event);
  document.body.removeEventListener("keydown", listener);
  return { event, reachedApp };
}

describe("installBrowserGuards", () => {
  beforeAll(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    installBrowserGuards({
      allowContextMenu: true,
      passThrough: (event) => event.ctrlKey && event.key === "k",
    });
  });

  afterAll(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("swallows browser shortcuts the app does not claim", () => {
    const { event, reachedApp } = press({ key: "p", ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(reachedApp).toBe(false);
  });

  it("passes claimed shortcuts to the app with the browser default prevented", () => {
    const { event, reachedApp } = press({ key: "k", ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(reachedApp).toBe(true);
  });

  it("leaves ordinary app shortcuts untouched", () => {
    const { event, reachedApp } = press({ key: "s", ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(reachedApp).toBe(true);
  });

  it("allows context menus only inside opted-in regions", () => {
    const allowed = document.createElement("div");
    allowed.dataset.allowContextMenu = "true";
    const blocked = document.createElement("div");
    document.body.append(allowed, blocked);
    const open = (target: HTMLElement): boolean => {
      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(open(allowed)).toBe(false);
    expect(open(blocked)).toBe(true);
  });
});
