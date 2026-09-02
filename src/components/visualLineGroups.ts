import type { VisibleUnit } from "../engine/markup";

/**
 * Groups inline markup into visual rows without mistaking KaTeX baseline
 * alignment for a line break. Display formulae deliberately form their own
 * row before and after surrounding text.
 */
export function resolveVisualLineGroups(
  units: readonly VisibleUnit[],
  elements: ReadonlyMap<number, HTMLElement>,
): readonly (readonly number[])[] {
  const groups: number[][] = [];
  let lastCenter: number | null = null;
  let lastHeight = 0;
  let previousWasDisplayMath = false;
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    const element = elements.get(index);
    if (unit === undefined || element === undefined) return [];
    const rect = element.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    const tolerance = Math.max(4, Math.max(lastHeight, rect.height) * 0.45);
    const isDisplayMath = unit.kind === "math" && unit.display;
    const startsLine =
      lastCenter === null ||
      previousWasDisplayMath ||
      isDisplayMath ||
      Math.abs(center - lastCenter) > tolerance;
    if (startsLine) groups.push([]);
    groups[groups.length - 1]?.push(index);
    lastCenter = center;
    lastHeight = rect.height;
    previousWasDisplayMath = isDisplayMath;
  }
  return groups;
}
