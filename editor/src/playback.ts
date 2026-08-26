export function autoReadingDelay(source: string): number {
  let characters = 0;
  let inlineMath = 0;
  let blockMath = 0;
  let index = 0;
  while (index < source.length) {
    const remaining = source.slice(index);
    const control =
      /^\[(?:pause=\d+ms|speed=(?:default|\d+(?:\.\d+)?cps))\]/.exec(remaining);
    const fx = /^\[fx=(?:shake|wave|glow)\]/.exec(remaining);
    if (control !== null || fx !== null) {
      index += (control ?? fx)?.[0].length ?? 0;
      continue;
    }
    if (remaining.startsWith("[/fx]")) {
      index += 5;
      continue;
    }
    if (remaining.startsWith("\\") && remaining.length >= 2) {
      characters += 1;
      index += 2;
      continue;
    }
    const marker = remaining.startsWith("$$")
      ? "$$"
      : remaining.startsWith("$")
        ? "$"
        : null;
    if (marker !== null) {
      const end = findUnescaped(source, marker, index + marker.length);
      if (end >= 0) {
        if (marker === "$$") blockMath += 1;
        else inlineMath += 1;
        index = end + marker.length;
        continue;
      }
    }
    const codePoint = source.codePointAt(index);
    if (codePoint === undefined) break;
    index += String.fromCodePoint(codePoint).length;
    characters += 1;
  }
  return Math.min(
    5_000,
    Math.max(800, 600 + characters * 35 + inlineMath * 350 + blockMath * 700),
  );
}

function findUnescaped(source: string, marker: string, from: number): number {
  let index = from;
  while (index < source.length) {
    const found = source.indexOf(marker, index);
    if (found < 0) return -1;
    let slashCount = 0;
    for (
      let cursor = found - 1;
      cursor >= 0 && source[cursor] === "\\";
      cursor -= 1
    ) {
      slashCount += 1;
    }
    if (slashCount % 2 === 0) return found;
    index = found + marker.length;
  }
  return -1;
}
