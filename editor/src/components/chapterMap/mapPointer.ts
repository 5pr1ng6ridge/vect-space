const MAP_INTERACTIVE_SELECTOR =
  ".map-editor-object, .map-resize-handle, .map-editor-view-frame span";

export function isMapInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(MAP_INTERACTIVE_SELECTOR) !== null
  );
}

export function captureMapPointer(
  target: HTMLElement,
  pointerId: number,
): void {
  try {
    target.setPointerCapture?.(pointerId);
  } catch {
    // A cancelled pointer cannot be captured. The gesture state is still
    // useful for the current event, and selection must not be lost with it.
  }
}
