import type {
  EditorLayout,
  EditorProject,
  EditorSceneFile,
  SceneDefinition,
  WindowRole,
} from "../types";

/**
 * Sprite instance ids a scene can refer to: every `sprite` node's `sprite_id`
 * and every timeline sprite track, de-duplicated and sorted.
 */
export function sceneSpriteIds(scene: SceneDefinition): string[] {
  const ids = new Set<string>();
  for (const node of Object.values(scene.nodes)) {
    if (node.type === "sprite") ids.add(node.sprite_id);
    if (node.type === "timeline") {
      for (const track of node.tracks) {
        if (track.type === "sprite") ids.add(track.sprite_id);
      }
    }
  }
  ids.delete("");
  return [...ids].sort();
}

export function uniqueNodeId(scene: SceneDefinition, prefix: string): string {
  const cleaned = prefix.replace(/[^A-Za-z0-9._-]/g, "_") || "node";
  if (scene.nodes[cleaned] === undefined) {
    return cleaned;
  }
  let index = 2;
  while (scene.nodes[`${cleaned}_${index}`] !== undefined) {
    index += 1;
  }
  return `${cleaned}_${index}`;
}

export function cloneProject(project: EditorProject): EditorProject {
  return structuredClone(project);
}

export function findScene(
  project: EditorProject,
  sceneId: string,
): EditorSceneFile | undefined {
  return project.scenes.find((scene) => scene.definition.id === sceneId);
}

export function projectRequest(
  project: EditorProject,
  importTokens: string[] = [],
) {
  return {
    manifest: project.manifest,
    scenes: project.scenes,
    ui_motions: project.ui_motions,
    buttons: project.buttons ?? [],
    animations: project.animations ?? [],
    actions: project.actions ?? [],
    text_blocks: project.text_blocks ?? [],
    particles: project.particles ?? [],
    chapter_map: project.chapter_map ?? null,
    layout: project.layout,
    expected_fingerprint: project.fingerprint,
    import_tokens: importTokens,
  };
}

export function newSceneFile(
  id: string,
  windowRole: WindowRole = "main",
): EditorSceneFile {
  return {
    path: `scenes/${id}.yaml`,
    definition: {
      // `main` is the file default and stays implicit.
      ...(windowRole === "main" ? {} : { window_role: windowRole }),
      schema_version: 2,
      id,
      entry: "start",
      nodes: { start: { type: "end" } },
    },
  };
}

/**
 * Change which window a Scene is written for.  Existing references are not
 * rewritten (that would guess intent); the live diagnostics list every
 * `open_window` / `jump` / entry that no longer fits.
 */
export function setSceneWindowRole(
  project: EditorProject,
  sceneId: string,
  role: WindowRole,
): EditorProject {
  const file = findScene(project, sceneId);
  if (file === undefined || (file.definition.window_role ?? "main") === role)
    return project;
  const updated = cloneProject(project);
  const scene = findScene(updated, sceneId);
  if (scene === undefined) return project;
  if (role === "main") Reflect.deleteProperty(scene.definition, "window_role");
  else scene.definition.window_role = role;
  return updated;
}

export function ensureSceneLayout(layout: EditorLayout, sceneId: string) {
  layout.scenes[sceneId] ??= { nodes: {}, viewport: null };
  return layout.scenes[sceneId];
}
