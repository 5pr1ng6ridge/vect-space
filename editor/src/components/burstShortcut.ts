/**
 * When a Space key press replays the previewed particle burst.
 *
 * The replay shortcut is a window-level handler, so it must stay out of the
 * way of everything that already owns Space:
 *
 * - text entry and IME compositions (typing a space into a field),
 * - native controls whose own activation key is Space (a focused button, a
 *   select, a checkbox, a link): they keep their native behavior,
 * - dialogs, menus and listboxes that trap focus,
 * - modified keys and auto-repeat (holding Space replays once, not 30 times),
 * - presses outside the workspace or inspector that owns the preview.
 *
 * When it does handle the key the caller prevents the default action: that
 * stops the page from scrolling and stops a focused transport button from also
 * firing its native click (which would replay a second time).
 */

import { isComposing, isTextEntryTarget } from "../ui/keyboard";

/** Controls that use Space themselves; they keep their native behavior. */
const NATIVE_SPACE_CONTROLS = [
  "button",
  "a[href]",
  "select",
  "summary",
  "textarea",
  'input:not([type="range"])',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="spinbutton"]',
].join(",");

/** Containers whose contents are modal or transient. */
const TRANSIENT_CONTAINERS = '[role="dialog"], [role="menu"], [role="listbox"]';

export function isSpaceKey(event: { key: string; code?: string }): boolean {
  return event.key === " " || event.code === "Space";
}

/** True when no modifier turns the key into a different shortcut. */
export function hasNoModifier(event: {
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): boolean {
  return !(event.ctrlKey || event.altKey || event.metaKey || event.shiftKey);
}

/**
 * Whether `event` should replay the burst.
 *
 * `preview` is the transport's own section: its buttons and slider are part of
 * the shortcut's surface, so Space on them replays (and the caller suppresses
 * the native click).  `scope` is the workspace/inspector that owns the
 * preview; a press elsewhere (the story graph, another panel) is not ours.
 */
export function shouldReplayBurst(
  event: KeyboardEvent,
  scope: Element | null,
  preview: Element | null,
): boolean {
  if (!isSpaceKey(event) || !hasNoModifier(event) || event.repeat) return false;
  if (event.defaultPrevented || isComposing(event)) return false;
  const target = event.target;
  if (isTextEntryTarget(target)) return false;
  // A modal anywhere in the document owns the keyboard, even when focus has
  // not moved into it yet.
  if (document.querySelector('[role="dialog"], [aria-modal="true"]') !== null)
    return false;
  // Nothing focused: the key lands on the body, so the workspace that is on
  // screen owns it.
  if (targetsBareDocument(target)) return true;
  if (!(target instanceof Element)) return false;
  if (target.closest(TRANSIENT_CONTAINERS) !== null) return false;
  if (preview !== null && preview.contains(target)) return true;
  if (target.closest(NATIVE_SPACE_CONTROLS) !== null) return false;
  return scope !== null && scope.contains(target);
}

/** `document.body` as the target means no element has focus. */
export function targetsBareDocument(target: EventTarget | null): boolean {
  return (
    target === document.body &&
    (document.activeElement === document.body ||
      document.activeElement === null)
  );
}
