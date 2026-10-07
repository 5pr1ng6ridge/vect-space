import { fixtureProject } from "./appHarness";
import { PARTICLE_FIXTURE, TEXT_FIXTURE } from "../../../packages/presentation-core/src/visualTestKit";
import type { EditorProject, ParticleFile, TextBlockFile } from "../types";

export { PARTICLE_FIXTURE, TEXT_FIXTURE };

export type VisualProject = EditorProject & {
  text_blocks: TextBlockFile[];
  particles: ParticleFile[];
};

export function visualProject(): VisualProject {
  const project = fixtureProject();
  project.manifest.assets = {
    dot: { kind: "gui", path: "dot.png" },
    bg: { kind: "background", path: "bg.png" },
    font: { kind: "font", path: "font.woff2" },
  };
  project.assets = Object.entries(project.manifest.assets).map(([id, asset]) => ({
    id, kind: asset.kind, path: asset.path ?? "", absolute_path: `C:/game/${asset.path ?? ""}`,
  }));
  project.manifest.text_blocks = ["texts/label.yaml"];
  project.manifest.particles = ["particles/snow.yaml"];
  return {
    ...project,
    text_blocks: [{ path: "texts/label.yaml", definition: structuredClone(TEXT_FIXTURE) }],
    particles: [{ path: "particles/snow.yaml", definition: structuredClone(PARTICLE_FIXTURE) }],
  };
}
