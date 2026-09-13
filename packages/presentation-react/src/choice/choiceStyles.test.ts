import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sharedCss = readFileSync(
  resolve(process.cwd(), "packages/presentation-react/src/choice/choice.css"),
  "utf8",
);
const choiceLayer = readFileSync(
  resolve(
    process.cwd(),
    "packages/presentation-react/src/choice/ChoiceLayer.tsx",
  ),
  "utf8",
);

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(sharedCss);
  if (match?.[1] === undefined) {
    throw new Error(`shared choice.css is missing ${selector}`);
  }
  return match[1];
}

function declaration(body: string, property: string): string {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`, "u").exec(
    body,
  );
  if (match?.[1] === undefined) {
    throw new Error(`choice.css rule is missing ${property}`);
  }
  return match[1].trim();
}

describe("shared choice CSS contract", () => {
  it("imports the one stylesheet through ChoiceLayer", () => {
    expect(choiceLayer).toContain('import "./choice.css";');
  });

  it("locks artwork to the button box and content above overlay artwork", () => {
    const image = rule(".choice-button-image");
    expect(declaration(image, "position")).toBe("absolute");
    expect(declaration(image, "inset")).toBe("0");
    expect(declaration(image, "width")).toBe("100%");
    expect(declaration(image, "height")).toBe("100%");
    expect(declaration(image, "pointer-events")).toBe("none");

    const overlay = rule(".choice-button-image ~ .choice-button-image");
    expect(declaration(overlay, "z-index")).toBe("1");

    const fallback = rule(".choice-button-fallback");
    expect(fallback).not.toMatch(/min-height\s*:/u);

    const content = rule(".choice-button-content");
    expect(declaration(content, "position")).toBe("relative");
    expect(declaration(content, "z-index")).toBe("2");
    expect(declaration(content, "pointer-events")).toBe("none");
  });

  it("has no host-local copies of shared choice selectors", () => {
    const hosts = [
      resolve(process.cwd(), "src/App.css"),
      resolve(process.cwd(), "editor/src/styles.css"),
    ];
    const hostSelector = /^\s*\.(?:choice-(?:layer|button)|choice-panel)\b/mu;
    for (const host of hosts) {
      const content = readFileSync(host, "utf8");
      expect(content, host).not.toMatch(hostSelector);
    }
  });
});
