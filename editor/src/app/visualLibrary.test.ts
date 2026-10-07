import { describe, expect, it } from "vitest";
import { produce } from "immer";

import { defaultNode } from "../story";
import { visualProject } from "../test/visualFixtures";
import { validateLive } from "../validation";
import type { SceneNode } from "../types";
import { idUnavailableReason } from "./ids";
import {
  addVisualDocument,
  duplicateVisualFile,
  newParticleFile,
  newTextBlockFile,
  removeVisualDocument,
  renameVisualDocument,
  visualReferences,
} from "./visualLibrary";

function referencingProject() {
  const project = visualProject();
  const sprite = { ...(defaultNode("sprite", "particle") as Extract<SceneNode, { type: "sprite" }>), source: { type: "text" as const, text_block: "label" } };
  const particle = { ...(defaultNode("particle", "timeline") as Extract<SceneNode, { type: "particle" }>), particle: "snow" };
  const timeline = defaultNode("timeline", "finish") as Extract<SceneNode, { type: "timeline" }>;
  timeline.tracks = [{ type: "sprite", sprite_id: "caption", source: { type: "text", text_block: "label" }, remove_at_end: false, channels: {} }];
  project.scenes[0].definition.nodes = { start: sprite, particle, timeline, finish: { type: "end" } };
  return project;
}

describe("visual library commands", () => {
  it("creates valid definitions under managed paths without colliding with other namespaces", () => {
    const project = visualProject();
    expect(idUnavailableReason("textBlock", "dot", project)).toMatch(/素材/);
    expect(idUnavailableReason("particle", "label", project)).toMatch(/固定文本块/);
    expect(idUnavailableReason("action", "snow", project)).toMatch(/粒子效果/);
    const next = produce(project, (draft) => {
      addVisualDocument(draft, "textBlock", newTextBlockFile("title"));
      addVisualDocument(draft, "particle", newParticleFile("sparks", "dot"));
    });
    expect(next.manifest.text_blocks).toContain("text_blocks/title.yaml");
    expect(next.manifest.particles).toContain("particles/sparks.yaml");
    expect(validateLive(next).filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  it("counts sprite, timeline and particle-node references for delete protection", () => {
    const project = referencingProject();
    expect(visualReferences(project, "textBlock", "label")).toEqual(["main/start", "main/timeline · 时间线"]);
    expect(visualReferences(project, "particle", "snow")).toEqual(["main/particle"]);
  });

  it("renames file paths and every reference in one draft so validation stays clean", () => {
    const renamed = produce(referencingProject(), (draft) => {
      renameVisualDocument(draft, "textBlock", "label", "caption.text");
      renameVisualDocument(draft, "particle", "snow", "rain");
    });
    expect(renamed.manifest.text_blocks).toEqual(["text_blocks/caption_text.yaml"]);
    expect(renamed.text_blocks?.[0]).toMatchObject({ path: "text_blocks/caption_text.yaml", definition: { id: "caption.text" } });
    expect(visualReferences(renamed, "textBlock", "caption.text")).toHaveLength(2);
    expect(visualReferences(renamed, "particle", "rain")).toEqual(["main/particle"]);
    expect(validateLive(renamed).filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  it("duplicates under a free copy id and removes only the manifest entry and document", () => {
    const project = visualProject();
    const copy = duplicateVisualFile(project, "particle", "snow", (id) => idUnavailableReason("particle", id, project) !== null);
    expect(copy).toMatchObject({ path: "particles/snow_copy.yaml", definition: { id: "snow_copy", image: "dot" } });
    const removed = produce(project, (draft) => removeVisualDocument(draft, "textBlock", "label"));
    expect(removed.text_blocks).toEqual([]);
    expect(removed.manifest.text_blocks).toEqual([]);
    expect(removed.particles).toHaveLength(1);
  });
});
