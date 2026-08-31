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
import type { WireScalarValue } from "../../shared/generated/WireScalarValue";

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
    command<TimelinePreviewResult>("build_timeline_preview", {
      request: {
        ...request,
        variable_overrides: Object.fromEntries(
          Object.entries(request.variable_overrides).map(([id, value]) => [
            id,
            toWireScalar(value, request.project.manifest.variables[id]?.type),
          ]),
        ),
      },
    }),
};

function toWireScalar(
  value: boolean | number | string,
  declaredType: "boolean" | "integer" | "number" | "string" | undefined,
): WireScalarValue {
  if (declaredType === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new Error("整数预览覆盖值必须是 JavaScript 安全整数");
    }
    return { kind: "integer", value: String(value) };
  }
  if (declaredType === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("浮点预览覆盖值必须是有限数");
    }
    return { kind: "number", value };
  }
  if (declaredType === "boolean" && typeof value === "boolean") {
    return { kind: "boolean", value };
  }
  if (declaredType === "string" && typeof value === "string") {
    return { kind: "string", value };
  }
  throw new Error("预览覆盖值与变量声明类型不一致");
}

export function assetUrl(path: string): string {
  return convertFileSrc(path);
}
