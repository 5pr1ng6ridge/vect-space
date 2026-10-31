import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string): string =>
  readFileSync(resolve(root, path), "utf8");
const escape = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const choiceCss = read("packages/presentation-react/src/choice/choice.css");
const gameplayCss = read(
  "packages/presentation-react/src/gameplay/gameplay.css",
);

/** Every stylesheet the two hosts (game and editor) own. */
function hostStylesheets(): { path: string; content: string }[] {
  return ["src", "editor/src"].flatMap((dir) =>
    readdirSync(resolve(root, dir), { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".css"))
      .map((file) => {
        const path = join(dir, file);
        return { path, content: read(path) };
      }),
  );
}

function rule(selector: string): string {
  const match = new RegExp(`${escape(selector)}\\s*\\{([^}]*)\\}`, "u").exec(
    choiceCss,
  );
  if (match?.[1] === undefined)
    throw new Error(`shared choice.css is missing ${selector}`);
  return match[1];
}

function declaration(body: string, property: string): string {
  const match = new RegExp(
    `(?:^|;)\\s*${escape(property)}\\s*:\\s*([^;]+)`,
    "u",
  ).exec(body);
  if (match?.[1] === undefined)
    throw new Error(`choice.css rule is missing ${property}`);
  return match[1].trim();
}

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

describe("shared choice CSS contract", () => {
  it("locks artwork to the button box and content above overlay artwork", () => {
    const image = rule(".choice-button-image");
    expect(declaration(image, "position")).toBe("absolute");
    expect(declaration(image, "inset")).toBe("0");
    expect(declaration(image, "width")).toBe("100%");
    expect(declaration(image, "height")).toBe("100%");
    expect(declaration(image, "pointer-events")).toBe("none");

    expect(
      declaration(
        rule(".choice-button-image ~ .choice-button-image"),
        "z-index",
      ),
    ).toBe("1");
    expect(rule(".choice-button-fallback")).not.toMatch(/min-height\s*:/u);

    const content = rule(".choice-button-content");
    expect(declaration(content, "position")).toBe("relative");
    expect(declaration(content, "z-index")).toBe("2");
    expect(declaration(content, "pointer-events")).toBe("none");
  });

  it("has no host-local copies of the shared choice selectors", () => {
    const hostSelector = /^\s*\.(?:choice-(?:layer|button)|choice-panel)\b/mu;
    for (const { path, content } of hostStylesheets()) {
      expect(content, path).not.toMatch(hostSelector);
    }
  });
});

describe("shared gameplay CSS contract", () => {
  it("keeps the gameplay surface rules in the shared stylesheet", () => {
    for (const selector of SHARED_SELECTORS) {
      expect(
        new RegExp(`(?:^|\\n)\\s*\\.${escape(selector)}\\s*\\{`, "u").test(
          gameplayCss,
        ),
        selector,
      ).toBe(true);
    }
  });

  it("has no host-local copies of the shared gameplay selectors", () => {
    for (const { path, content } of hostStylesheets()) {
      for (const selector of SHARED_SELECTORS) {
        expect(
          new RegExp(`^\\s*\\.${escape(selector)}\\b`, "mu").test(content),
          `${path} must not define .${selector}`,
        ).toBe(false);
      }
    }
  });
});
