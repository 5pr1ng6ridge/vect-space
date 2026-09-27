/**
 * Guard: raw colour literals belong in tokens.css only.
 *
 * The legacy stylesheets are exempt while they are migrated area by area;
 * this list may only shrink.  New CSS must use the design tokens.
 */
import { describe, expect, it } from "vitest";

const LEGACY_EXEMPT = new Set(["../styles.css", "../editor-layout.css"]);

const stylesheets = import.meta.glob<string>(["../**/*.css", "./*.css"], {
  eager: true,
  import: "default",
  query: "?raw",
});

describe("editor CSS colour tokens", () => {
  it("keeps hex colours out of every non-legacy stylesheet", () => {
    const offenders = Object.entries(stylesheets)
      .filter(
        ([path]) =>
          !path.endsWith("/tokens.css") &&
          path !== "./tokens.css" &&
          !LEGACY_EXEMPT.has(path),
      )
      .flatMap(([path, source]) =>
        [...source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(
          (match) => `${path}: ${match[0]}`,
        ),
      );
    expect(Object.keys(stylesheets).length).toBeGreaterThan(3);
    expect(offenders).toEqual([]);
  });
});
