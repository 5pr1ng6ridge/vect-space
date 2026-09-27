/**
 * Keyboard policy shared by every window/container-level shortcut handler.
 *
 * Text entry owns its own keys: Ctrl+Z inside a text field is text undo, Esc
 * reverts the field rather than leaving the workspace, and an IME composition
 * owns Enter.  A `<select>` is deliberately *not* text entry: after changing a
 * select, focus stays on it and Ctrl+Z must still undo that project change.
 */

/** True for inputs that accept typed text, textareas and editing hosts. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === "TEXTAREA") return true;
  if (target instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has(target.type);
  }
  // jsdom does not implement `isContentEditable`; match the attribute.
  return (
    target.closest(
      '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
    ) !== null
  );
}

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** True while an IME composition owns the keystroke. */
export function isComposing(event: {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): boolean {
  const native = event.nativeEvent ?? event;
  return native.isComposing === true || native.keyCode === 229;
}

/**
 * The first line of every window- or container-level shortcut handler: skip
 * keys another layer already consumed (a popover's Esc, a chooser's arrows),
 * keys typed into a text field, and IME compositions.
 */
export function shouldIgnoreShortcut(event: {
  defaultPrevented: boolean;
  target: EventTarget | null;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): boolean {
  return (
    event.defaultPrevented ||
    isComposing(event) ||
    isTextEntryTarget(event.target)
  );
}

/**
 * Esc pressed inside a text field only leaves that field (a DeferredInput has
 * already reverted its draft).  Returns true when the key was consumed so a
 * workspace-level handler must not also exit the workspace.
 */
export function escapeTextEntry(event: {
  key: string;
  target: EventTarget | null;
}): boolean {
  if (event.key !== "Escape" || !isTextEntryTarget(event.target)) return false;
  if (event.target instanceof HTMLElement) event.target.blur();
  return true;
}
