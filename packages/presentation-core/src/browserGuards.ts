const browserCtrlKeys = new Set([
  "d",
  "e",
  "f",
  "g",
  "h",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "t",
  "u",
  "w",
  "0",
  "+",
  "=",
  "-",
  "_",
  "pageup",
  "pagedown",
  "tab",
]);

const browserCtrlShiftKeys = new Set([
  "b",
  "c",
  "d",
  "i",
  "j",
  "m",
  "n",
  "o",
  "p",
  "r",
  "s",
  "t",
  "w",
  "delete",
]);

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function isBrowserShortcut(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase();
  const functionKey = /^f(?:[1-9]|1[0-2])$/.test(key);
  if (
    functionKey ||
    key === "contextmenu" ||
    event.code.toLowerCase() === "apps"
  )
    return true;

  if (event.altKey && ["arrowleft", "arrowright", "home"].includes(key))
    return true;

  const command = event.ctrlKey || event.metaKey;
  if (!command) {
    return ["browserback", "browserforward", "goback", "goforward"].includes(
      key,
    );
  }

  if (event.shiftKey && browserCtrlShiftKeys.has(key)) return true;
  return browserCtrlKeys.has(key);
}

export interface BrowserGuardOptions {
  /** Let right-clicks inside `[data-allow-context-menu]` reach the app. */
  allowContextMenu?: boolean;
  /**
   * Browser-reserved shortcuts the app handles itself.  The browser default
   * is still prevented, but the event keeps propagating to app handlers.
   */
  passThrough?(event: KeyboardEvent): boolean;
}

/** Disable browser chrome behavior while leaving app shortcuts such as Ctrl+S/Z/Y intact. */
export function installBrowserGuards(
  options: boolean | BrowserGuardOptions = false,
): void {
  if (!isTauriRuntime()) return;
  const { allowContextMenu = false, passThrough } =
    typeof options === "boolean" ? { allowContextMenu: options } : options;

  const preventContextMenu = (event: MouseEvent): void => {
    if (
      allowContextMenu &&
      event.target instanceof Element &&
      event.target.closest("[data-allow-context-menu]") !== null
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  const preventBrowserShortcut = (event: KeyboardEvent): void => {
    if (!isBrowserShortcut(event)) return;
    event.preventDefault();
    if (passThrough?.(event) === true) return;
    event.stopPropagation();
  };

  document.addEventListener("contextmenu", preventContextMenu, true);
  window.addEventListener("keydown", preventBrowserShortcut, true);
}
