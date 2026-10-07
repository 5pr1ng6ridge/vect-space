import { describe, expect, it } from "vitest";
import { textBlockVersion } from "@vectspace/presentation-core/text-block";
import { buildEditorVisualResources } from "./visualResources";
import { visualProject, TEXT_FIXTURE, PARTICLE_FIXTURE } from "./test/visualFixtures";

describe("editor visual preview resources", () => {
  it("uses validated host definitions and staged font URLs, not a newer draft", () => {
    const project = visualProject();
    project.manifest.default_font = "font";
    project.text_blocks[0].definition.content = "unsaved newer content";
    const resources = buildEditorVisualResources(project, { font: "asset://staged/font.woff2" }, {
      text_blocks: { label: TEXT_FIXTURE }, particles: { snow: PARTICLE_FIXTURE }, font_versions: { font: "bytes-v1" },
    });
    expect(resources.textBlocks.label).toEqual({ definition: TEXT_FIXTURE, font_url: "asset://staged/font.woff2", font_version: "bytes-v1" });
    expect(resources.particles.snow).toBe(PARTICLE_FIXTURE);
  });

  it("keeps identity for transform-only changes and invalidates same-URL font replacement", () => {
    const project = visualProject();
    project.manifest.default_font = "font";
    const assets = { font: "asset://font.woff2" };
    const first = buildEditorVisualResources(project, assets, { font_versions: { font: "v1" } });
    project.fingerprint = "new-scene-pose";
    const transformed = buildEditorVisualResources(project, assets, { font_versions: { font: "v1" } });
    const replaced = buildEditorVisualResources(project, assets, { font_versions: { font: "v2" } });
    expect(textBlockVersion(first.textBlocks.label)).toBe(textBlockVersion(transformed.textBlocks.label));
    expect(textBlockVersion(first.textBlocks.label)).not.toBe(textBlockVersion(replaced.textBlocks.label));
  });

  it("supports old host fixtures but never silently drops an unresolved font", () => {
    const project = visualProject();
    expect(buildEditorVisualResources(project, {}).particles.snow).toEqual(PARTICLE_FIXTURE);
    project.text_blocks[0].definition.font = "font";
    expect(() => buildEditorVisualResources(project, {})).toThrow(/字体尚未解析/);
    expect(buildEditorVisualResources(project, { font: "font-url" }).textBlocks.label?.font_version).toBe(project.fingerprint);
  });
});
