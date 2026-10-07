/**
 * Window-level pointer gesture lifecycle shared by every stage drag.
 *
 * A stage gesture follows the pointer on `window` (so it survives leaving the
 * canvas) and ends in exactly one of two ways:
 *
 * - `release`: the primary pointer was released; the host may commit one
 *   authored change,
 * - `abort`: `Escape`, a pointer cancel, the window losing focus or the owner
 *   unmounting; nothing may be committed.
 *
 * Whichever happens first wins and detaches every listener, so a late
 * `pointerup` after an abort can never commit and a double release never
 * commits twice.  The returned function aborts the gesture on demand (owner
 * cleanup) and is idempotent.
 */
export interface StageGesture {
  /** Pointer moved while the gesture was live. */
  move(event: PointerEvent): void;
  /** Primary pointer released; the gesture is already over. */
  release(event: PointerEvent): void;
  /** Escape, pointer cancel, blur or owner cleanup; the gesture is over. */
  abort(): void;
}

export function beginStageGesture(gesture: StageGesture): () => void {
  let finished = false;
  const detach = (): boolean => {
    if (finished) return false;
    finished = true;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", abort);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("blur", abort);
    return true;
  };
  const onMove = (event: PointerEvent): void => {
    if (!finished) gesture.move(event);
  };
  const onUp = (event: PointerEvent): void => {
    if (detach()) gesture.release(event);
  };
  const abort = (): void => {
    if (detach()) gesture.abort();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") abort();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", abort);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("blur", abort);
  return abort;
}
