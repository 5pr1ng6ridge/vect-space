import { resolveTextBlocks, type TextBlockMap } from "@vectspace/presentation-core/text-block";
import type { ParticleMap } from "@vectspace/presentation-core/particles";
import type { EditorProject, ParticleDefinition, TextBlockDefinition } from "./types";

interface EditorVisualDefinitions {
  text_blocks?: Record<string, TextBlockDefinition>;
  particles?: Record<string, ParticleDefinition>;
  font_versions?: Record<string, string>;
}

export interface EditorVisualResources {
  textBlocks: TextBlockMap;
  particles: ParticleMap;
}

/** Resolve the exact draft used by a preview, including staged font URLs. */
export function buildEditorVisualResources(
  project: EditorProject,
  assets: Readonly<Record<string, string>>,
  resolved?: EditorVisualDefinitions,
): EditorVisualResources {
  const textBlocks = resolved?.text_blocks ?? Object.fromEntries(
    (project.text_blocks ?? []).map((file) => [file.definition.id, file.definition]),
  );
  const particles = resolved?.particles ?? Object.fromEntries(
    (project.particles ?? []).map((file) => [file.definition.id, file.definition]),
  );
  const fontVersions = resolved?.font_versions ?? Object.fromEntries(
    project.assets.filter((asset) => asset.kind === "font")
      .map((asset) => [asset.id, project.fingerprint]),
  );
  return {
    textBlocks: resolveTextBlocks(textBlocks, assets, project.manifest.default_font, fontVersions),
    particles,
  };
}

export const EMPTY_EDITOR_VISUALS: EditorVisualResources = { textBlocks: {}, particles: {} };
