/**
 * Pure project commands for the reusable libraries (UI motions, button
 * templates, sprite actions), asset registrations, scenes and the chapter
 * map.  They take either a plain project (queries) or an Immer draft
 * (mutations) and never touch React state, so the App shell only decides
 * *when* to run them and how to report the result.
 */
import type {
  ActionFile,
  ButtonFile,
  ChapterMapFile,
  EditorProject,
  SpriteActionDefinition,
  UiMotionFile,
} from "../types";
import { libraryFilePath, uniqueId } from "./ids";

/** "（a、b…）" — a short, bounded list of reference locations. */
export function formatReferenceList(references: readonly string[]): string {
  return `（${references.slice(0, 8).join("、")}${references.length > 8 ? "…" : ""}）`;
}

// ---------------------------------------------------------------- UI motions

export function newUiMotionFile(id: string): UiMotionFile {
  return {
    path: libraryFilePath("uiMotion", id),
    definition: {
      schema_version: 1,
      id,
      duration_ms: 280,
      tracks: [
        {
          target: "dialogue_root",
          channels: {
            offset_y: [
              { at_ms: 0, value: 48, easing: "ease_out" },
              { at_ms: 280, value: 0, easing: "linear" },
            ],
            opacity: [
              { at_ms: 0, value: 0, easing: "ease_out" },
              { at_ms: 280, value: 1, easing: "linear" },
            ],
          },
        },
      ],
    },
  };
}

export function addUiMotion(draft: EditorProject, file: UiMotionFile): void {
  draft.manifest.ui_motions.push(file.path);
  draft.ui_motions.push(file);
}

export function uiMotionReferenceCount(
  project: EditorProject,
  id: string,
): number {
  let references = 0;
  const defaults = project.manifest.ui_motion_defaults;
  if (defaults.dialogue_show === id) references += 1;
  if (defaults.dialogue_hide === id) references += 1;
  for (const file of project.scenes) {
    for (const node of Object.values(file.definition.nodes)) {
      if (
        (node.type === "dialogue_ui" ||
          node.type === "ui_motion_set" ||
          node.type === "ui_motion_play") &&
        node.motion === id
      )
        references += 1;
    }
  }
  return references;
}

export function removeUiMotion(draft: EditorProject, id: string): void {
  const file = draft.ui_motions.find(
    (candidate) => candidate.definition.id === id,
  );
  if (file === undefined) return;
  draft.ui_motions = draft.ui_motions.filter(
    (candidate) => candidate.definition.id !== id,
  );
  draft.manifest.ui_motions = draft.manifest.ui_motions.filter(
    (path) => path !== file.path,
  );
}

// ---------------------------------------------------------- Button templates

export function newButtonFile(id: string): ButtonFile {
  return {
    path: libraryFilePath("button", id),
    definition: {
      schema_version: 1,
      id,
      width: 200,
      height: 80,
      asset_mode: "separate",
      fit: "stretch",
      normal: null,
      hover: null,
      pressed: null,
      animations: {},
    },
  };
}

export function addButtonTemplate(
  draft: EditorProject,
  file: ButtonFile,
): void {
  draft.manifest.buttons ??= [];
  draft.manifest.buttons.push(file.path);
  draft.buttons ??= [];
  draft.buttons.push(file);
}

export function duplicateButtonFile(
  project: EditorProject,
  id: string,
): ButtonFile | null {
  const source = (project.buttons ?? []).find(
    (candidate) => candidate.definition.id === id,
  );
  if (source === undefined) return null;
  const used = new Set(
    (project.buttons ?? []).map((file) => file.definition.id),
  );
  const nextId = uniqueCopyId(id, (candidate) => used.has(candidate));
  return {
    path: libraryFilePath("button", nextId),
    definition: { ...structuredClone(source.definition), id: nextId },
  };
}

export function removeButtonTemplate(draft: EditorProject, id: string): void {
  const file = (draft.buttons ?? []).find(
    (candidate) => candidate.definition.id === id,
  );
  if (file === undefined) return;
  draft.buttons = (draft.buttons ?? []).filter(
    (candidate) => candidate.definition.id !== id,
  );
  draft.manifest.buttons = (draft.manifest.buttons ?? []).filter(
    (path) => path !== file.path,
  );
}

// ------------------------------------------------------------ Sprite actions

export function newSpriteActionFile(id: string): ActionFile {
  const definition: SpriteActionDefinition = {
    schema_version: 1,
    id,
    name: "新立绘动作",
    duration_ms: 400,
    channels: {
      y: [
        { at_ms: 0, value: 0, easing: "linear" },
        { at_ms: 200, value: -18, easing: "ease_out" },
        { at_ms: 400, value: 0, easing: "ease_in" },
      ],
    },
    parameters: {},
    end: "hold",
  };
  return { path: libraryFilePath("action", id), definition };
}

export function addSpriteAction(draft: EditorProject, file: ActionFile): void {
  draft.manifest.actions ??= [];
  draft.manifest.actions.push(file.path);
  draft.actions ??= [];
  draft.actions.push(file);
}

export function spriteActionReferences(
  project: EditorProject,
  id: string,
): string[] {
  const references: string[] = [];
  for (const scene of project.scenes) {
    for (const [nodeId, node] of Object.entries(scene.definition.nodes)) {
      if (node.type === "action" && node.action === id)
        references.push(`${scene.definition.id}/${nodeId}`);
    }
  }
  return references;
}

export function duplicateSpriteActionFile(
  project: EditorProject,
  id: string,
): ActionFile | null {
  const source = (project.actions ?? []).find(
    (file) => file.definition.id === id,
  );
  if (source === undefined) return null;
  const used = new Set(
    (project.actions ?? []).map((file) => file.definition.id),
  );
  const nextId = uniqueCopyId(
    id,
    (candidate) =>
      used.has(candidate) ||
      project.manifest.assets[candidate] !== undefined ||
      (project.animations ?? []).some(
        (file) => file.definition.id === candidate,
      ),
  );
  const definition = structuredClone(source.definition);
  definition.id = nextId;
  definition.name = `${definition.name}（副本）`;
  return { path: libraryFilePath("action", nextId), definition };
}

export function removeSpriteAction(draft: EditorProject, id: string): void {
  const file = (draft.actions ?? []).find(
    (candidate) => candidate.definition.id === id,
  );
  if (file === undefined) return;
  draft.actions = (draft.actions ?? []).filter(
    (candidate) => candidate.definition.id !== id,
  );
  draft.manifest.actions = (draft.manifest.actions ?? []).filter(
    (path) => path !== file.path,
  );
}

// -------------------------------------------------------------------- Assets

/**
 * Remove an asset registration.  An animation document is only reachable
 * through its asset, so removing the asset removes the document in the same
 * commit — unless a hand-authored manifest shares it with another asset.
 */
export function removeAssetRegistration(
  draft: EditorProject,
  id: string,
): void {
  const animationId = draft.manifest.assets[id]?.animation;
  Reflect.deleteProperty(draft.manifest.assets, id);
  draft.assets = draft.assets.filter((asset) => asset.id !== id);
  if (animationId === undefined) return;
  const shared = Object.values(draft.manifest.assets).some(
    (definition) => definition.animation === animationId,
  );
  if (shared) return;
  const file = (draft.animations ?? []).find(
    (candidate) => candidate.definition.id === animationId,
  );
  draft.animations = (draft.animations ?? []).filter(
    (candidate) => candidate.definition.id !== animationId,
  );
  draft.manifest.animations = (draft.manifest.animations ?? []).filter(
    (path) => path !== file?.path,
  );
}

// -------------------------------------------------------------------- Scenes

/**
 * Remove a scene registration and every editor-only record that points at
 * it.  The YAML file itself stays on disk as a recoverable copy.
 */
export function removeScene(draft: EditorProject, sceneId: string): void {
  const file = draft.scenes.find(
    (candidate) => candidate.definition.id === sceneId,
  );
  draft.scenes = draft.scenes.filter(
    (candidate) => candidate.definition.id !== sceneId,
  );
  if (file !== undefined) {
    draft.manifest.scenes = draft.manifest.scenes.filter(
      (path) => path !== file.path,
    );
  }
  Reflect.deleteProperty(draft.layout.scenes, sceneId);
  const previews = draft.layout.timeline_previews;
  if (previews !== undefined) {
    for (const key of Object.keys(previews)) {
      if (key.startsWith(`${sceneId}/`)) Reflect.deleteProperty(previews, key);
    }
    for (const settings of Object.values(previews)) {
      settings.choices = settings.choices.filter(
        (choice) => choice.scene_id !== sceneId,
      );
    }
  }
  if (draft.chapter_map !== null && draft.chapter_map !== undefined) {
    draft.chapter_map.definition.hotspots =
      draft.chapter_map.definition.hotspots.filter(
        (hotspot) => hotspot.scene_id !== sceneId,
      );
  }
}

// --------------------------------------------------------------- Chapter map

export function emptyChapterMapFile(entryScene: string): ChapterMapFile {
  return {
    path: "chapter-map.yaml",
    definition: {
      schema_version: 1,
      width: 1920,
      height: 1080,
      view_x: 960,
      view_y: 540,
      background: null,
      decorations: [],
      hotspots: [
        {
          id: entryScene,
          scene_id: entryScene,
          title: entryScene,
          x: 240,
          y: 460,
          width: 280,
          height: 160,
          z: 10,
          asset: null,
          reveal: { mode: "completed" as const },
          variable_overrides: {},
        },
      ],
    },
  };
}

function uniqueCopyId(id: string, isTaken: (id: string) => boolean): string {
  // Historical naming: `x_copy`, then `x_copy_2`, `x_copy_3`…
  return uniqueId(`${id}_copy`, isTaken);
}
