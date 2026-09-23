/**
 * Guards shared by the two node-deletion keyboard entry points — the script
 * list and the story graph.
 *
 * Deletion itself stays in `App.deleteNode`, so these helpers only decide
 * *whether* the currently selected node may be removed by a key press.  Both
 * call sites keep the handler scoped to their own pane, which is what keeps an
 * open dialog, an overlay or another workspace out of reach; these guards cover
 * the cases that a scoped handler still sees: focus in an editable field, an IME
 * composition, a held-down key and the pane's own interactive chrome.
 */

/** True when the event target is a text field or an editable document region. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  ) {
    return true;
  }
  // An editing host can be an ancestor of the event target, and jsdom does not
  // implement `isContentEditable`, so match the attribute itself.
  return (
    target.closest(
      '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
    ) !== null
  );
}

/**
 * True when focus sits on an interactive control of the pane's own chrome (a
 * toolbar button, a mini-map control, an open menu).  Activating such a control
 * must never double as a destructive shortcut.
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.closest(
      'button, a[href], input, select, textarea, [role="menu"], [role="menuitem"], [role="dialog"], [role="listbox"], [role="slider"]',
    ) !== null
  );
}

export interface NodeDeleteShortcutEvent {
  target: EventTarget | null;
  repeat: boolean;
  keyCode?: number;
  isComposing?: boolean;
}

/**
 * IME state for a keyboard event.  `keyCode === 229` is the legacy sentinel
 * sent while an IME owns the keystroke; it is read structurally because the DOM
 * typings deprecate the property.
 */
export function imeState(event: {
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): { isComposing: boolean; keyCode: number | undefined } {
  const native = event.nativeEvent;
  return {
    isComposing: native?.isComposing === true,
    keyCode: native?.keyCode,
  };
}

/**
 * True when a Delete shortcut must be ignored: held-key auto-repeat, an IME
 * composition in progress, or focus inside an editable region.
 */
export function shouldIgnoreNodeDeletion(
  event: NodeDeleteShortcutEvent,
): boolean {
  if (event.repeat) return true;
  if (event.isComposing === true || event.keyCode === 229) return true;
  return isEditableTarget(event.target);
}
