import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type {
  AssetKind,
  EditorDiagnostic,
  EditorProject,
  ImportedAsset,
  SaveProjectRequest,
  TimelinePreviewRequest,
  TimelinePreviewResult,
} from "./types";

async function command<T>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

export const editorApi = {
  openProject: (root: string) =>
    command<EditorProject>("open_project", { root }),
  saveProject: (request: SaveProjectRequest) =>
    command<EditorProject>("save_project", { request }),
  validateProject: (request: SaveProjectRequest) =>
    command<EditorDiagnostic[]>("validate_project", { request }),
  importAsset: (id: string, kind: AssetKind, sourcePath: string) =>
    command<ImportedAsset>("import_asset", {
      request: { id, kind, source_path: sourcePath },
    }),
  buildTimelinePreview: (request: TimelinePreviewRequest) =>
    command<TimelinePreviewResult>("build_timeline_preview", { request }),
};

export function assetUrl(path: string): string {
  return convertFileSrc(path);
}
