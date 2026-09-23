import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const gameplayCss = readFileSync(
  resolve(
    process.cwd(),
    "packages/presentation-react/src/gameplay/gameplay.css",
  ),
  "utf8",
);
const barrel = readFileSync(
  resolve(process.cwd(), "packages/presentation-react/src/gameplay/index.ts"),
  "utf8",
);

/**
 * Selectors that belong to the shared gameplay surface.  A host-local copy
 * would let the game and the editor preview drift, so the app stylesheets must
 * not define them.
 */
const SHARED_SELECTORS = [
  "dialogue-box",
  "dialogue-surface",
  "dialogue-frame",
  "speaker-name",
  "dialogue-text",
  "advance-indicator",
  "long-text-panel",
  "long-text-viewport",
  "markup-unit",
  "markup-reveal-content",
  "character-unit",
  "math-unit",
  "button-layer",
  "scene-canvas",
  "scene-button",
];

describe("shared gameplay CSS contract", () => {
  it("imports the one stylesheet through the gameplay barrel", () => {
    expect(barrel).toContain('import "./gameplay.css";');
  });

  it("keeps the gameplay surface rules in the shared stylesheet", () => {
    for (const selector of SHARED_SELECTORS) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      expect(
        new RegExp(`(?:^|\\n)\\s*\\.${escaped}\\s*\\{`, "u").test(gameplayCss),
        selector,
      ).toBe(true);
    }
  });

  it("has no host-local copies of the shared gameplay selectors", () => {
    const hosts = [
      resolve(process.cwd(), "src/App.css"),
      resolve(process.cwd(), "editor/src/styles.css"),
    ];
    for (const host of hosts) {
      const content = readFileSync(host, "utf8");
      for (const selector of SHARED_SELECTORS) {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        expect(
          new RegExp(`^\\s*\\.${escaped}\\b`, "mu").test(content),
          `${host} must not define .${selector}`,
        ).toBe(false);
      }
    }
  });

  it("keeps the reduced-motion contract with the gameplay surface", () => {
    expect(gameplayCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(gameplayCss).toContain(".long-text-paper");
  });
});
