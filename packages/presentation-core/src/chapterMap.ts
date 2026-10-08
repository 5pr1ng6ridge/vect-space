/** Shared, renderer-independent chapter-map geometry.  The game and editor
 * intentionally consume the same ordering and camera math so an authored
 * rectangle cannot change meaning when it crosses the IPC boundary. */

export interface MapLayerObject {
  id: string;
  z: number;
}

export interface MapPoint {
  x: number;
  y: number;
}

export interface MapRect extends MapPoint {
  width: number;
  height: number;
}

/**
 * Resolve the text shown in a chapter-map hotspot's hover card.  An omitted
 * value preserves the legacy title-based behavior, while an explicitly empty
 * value lets authors hide the card.
 */
export function resolveChapterMapHoverText(
  title: string,
  hoverText: string | null | undefined,
): string | null {
  if (hoverText === null || hoverText === undefined) return title;
  return hoverText.trim().length === 0 ? null : hoverText;
}

export interface ChapterMapObject<T extends MapLayerObject = MapLayerObject> {
  kind: "decoration" | "hotspot";
  item: T;
}

/**
 * Compare authored IDs without depending on the host locale.  `localeCompare`
 * can produce different orderings between the browser and the Rust/editor
 * environment (and even between user locales), which would make overlapping
 * map objects select a different top-most item.  JavaScript relational string
 * comparison is defined in terms of UTF-16 code units and is therefore stable
 * across the game and editor.
 */
export function compareStableId(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function sortMapObjects<T extends MapLayerObject>(
  objects: readonly ChapterMapObject<T>[],
): ChapterMapObject<T>[] {
  return [...objects].sort(
    (left, right) =>
      left.item.z - right.item.z ||
      compareStableId(left.item.id, right.item.id),
  );
}

export function sortMapLayer<T extends MapLayerObject>(
  items: readonly T[],
): T[] {
  return [...items].sort(
    (left, right) => left.z - right.z || compareStableId(left.id, right.id),
  );
}

export function snapMap(value: number, grid = 20): number {
  if (!Number.isFinite(value) || !Number.isFinite(grid) || grid <= 0)
    return value;
  return Math.round(value / grid) * grid;
}

export function clampMapCenter(
  value: number,
  roomSize: number,
  viewportSize: number,
): number {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(roomSize) ||
    !Number.isFinite(viewportSize)
  )
    return value;
  if (roomSize <= viewportSize) return roomSize / 2;
  return Math.min(
    roomSize - viewportSize / 2,
    Math.max(viewportSize / 2, value),
  );
}

export function containMapRect(
  rect: MapRect,
  roomWidth: number,
  roomHeight: number,
): boolean {
  if (
    !Number.isFinite(roomWidth) ||
    !Number.isFinite(roomHeight) ||
    roomWidth < 0 ||
    roomHeight < 0
  )
    return false;
  // Use subtraction for the upper bound rather than `x + width <= room`.
  // The latter can overflow to Infinity for hostile editor input and makes
  // a finite-looking rectangle appear valid on some engines.
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width >= 0 &&
    rect.height >= 0 &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x <= roomWidth &&
    rect.y <= roomHeight &&
    rect.width <= roomWidth - rect.x &&
    rect.height <= roomHeight - rect.y
  );
}

export function mapDragExceededThreshold(
  start: MapPoint,
  current: MapPoint,
  threshold = 4,
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) > threshold;
}
