import { describe, expect, it } from "vitest";
import cases from "../../fixtures/text-template-cases.json";
import { interpolateTemplate, renameTemplateVariable } from "./textTemplate";

describe("text template conformance", () => {
  for (const fixture of cases) {
    it(fixture.name, () => {
      expect(
        interpolateTemplate(fixture.source, (id) => {
          const value = fixture.variables[id as keyof typeof fixture.variables];
          if (value === undefined) throw new Error(`unknown variable ${id}`);
          return value;
        }),
      ).toBe(fixture.expected);
    });
  }

  it("renames only active interpolation markers", () => {
    expect(renameTemplateVariable("[var=old] \\[var=old]", "old", "new")).toBe(
      "[var=new] \\[var=old]",
    );
  });
});
