import { validateVisualDocuments } from "./visualValidation";
import { sceneRole } from "./windowInteraction";
import type { EditorDiagnostic, EditorProject } from "./types";
import {
  validateCharacters,
  validateManagedDocumentPaths,
  validateVariables,
} from "./validation/manifest";
import { deduplicate, error } from "./validation/shared";
import { validateUiMotions } from "./validation/uiMotion";
import { validateButtons } from "./validation/buttons";
import { validateAnimations } from "./validation/animations";
import { validateActions } from "./validation/actions";
import { validateScenes } from "./validation/scenes";
import { validateChapterMap } from "./validation/chapterMap";
import { reachabilityWarnings } from "./validation/reachability";

export function validateLive(project: EditorProject): EditorDiagnostic[] {
  const diagnostics: EditorDiagnostic[] = [];
  validateManagedDocumentPaths(project, diagnostics);
  diagnostics.push(...validateVisualDocuments(project));
  const sceneById = new Map(
    project.scenes.map(
      (file) => [file.definition.id, file.definition] as const,
    ),
  );

  if (!sceneById.has(project.manifest.entry_scene)) {
    diagnostics.push(error("missing_entry_scene", "项目入口场景不存在"));
  } else if (
    sceneRole(sceneById.get(project.manifest.entry_scene)) !== "main"
  ) {
    diagnostics.push(
      error(
        "secondary_entry_scene",
        "项目入口场景不能是副窗口专用 Scene；请换一个主窗口 Scene 作为入口",
        project.manifest.entry_scene,
      ),
    );
  }

  if (project.manifest.schema_version !== 2) {
    diagnostics.push(
      error("invalid_manifest_schema", "manifest schema_version 必须为 2"),
    );
  }
  validateVariables(project, diagnostics);
  validateCharacters(project, diagnostics);
  validateUiMotions(project, diagnostics);
  validateButtons(project, diagnostics);
  validateAnimations(project, diagnostics);
  validateActions(project, diagnostics);
  validateScenes(project, sceneById, diagnostics);

  validateChapterMap(project, sceneById, diagnostics);

  diagnostics.push(...reachabilityWarnings(project, sceneById));
  return deduplicate([...diagnostics, ...project.diagnostics]);
}
