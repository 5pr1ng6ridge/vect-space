import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type {
  EditorDiagnostic,
  EditorProject,
  ImportedAsset,
  ImportAssetRequest,
  BuildNodePreviewRequest,
  BuildNodePreviewResult,
  PreviewResolvedAsset,
  PreviewSessionStartRequest,
  PreviewSessionStartResult,
  SaveProjectRequest,
  SaveProjectResult,
  AssetInspection,
} from "./types";
import type { RuntimeUpdate } from "@vectspace/presentation-core/types";
import type { ScalarValue, VariableType } from "./types";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import type { WireScalarValue } from "../../shared/generated/WireScalarValue";
import { toCommandError } from "../../shared/commandError";

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

function parseWireInteger(text: string): bigint {
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(text)) {
    throw new Error("wire integer 必须是规范十进制字符串");
  }
  const value = BigInt(text);
  if (value < I64_MIN || value > I64_MAX) {
    throw new Error("wire integer 超出 i64 范围");
  }
  return value;
}

async function command<T>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    throw toCommandError(error);
  }
}

const buildNodePreview = (request: BuildNodePreviewRequest) =>
  command<unknown>("build_node_preview", {
    request: {
      project: encodeProjectRequest(request.project),
      target: request.target,
      choices: request.choices,
      variable_overrides: Object.fromEntries(
        Object.entries(request.variable_overrides).map(([id, value]) => [
          id,
          toWireScalar(value, request.project.manifest.variables[id]?.type),
        ]),
      ),
    },
  }).then((value) => decodeWireValue(value) as BuildNodePreviewResult);

export const editorApi = {
  pickProjectDirectory: (): Promise<string | null> =>
    command<string | null>("pick_project_directory"),
  pickAssetFiles: (): Promise<string[]> =>
    command<string[]>("pick_asset_files"),
  openProject: async (root: string): Promise<EditorProject> =>
    decodeEditorProject(await command<unknown>("open_project", { root })),
  saveProject: async (
    request: SaveProjectRequest,
  ): Promise<SaveProjectResult> => {
    const value = await command<unknown>("save_project", {
      request: encodeProjectRequest(request),
    });
    const decoded = decodeWireValue(value) as SaveProjectResult;
    return { ...decoded, project: decodeEditorProject(decoded.project) };
  },
  validateProject: (request: SaveProjectRequest) =>
    command<EditorDiagnostic[]>("validate_project", {
      request: encodeProjectRequest(request),
    }),
  stageAssetImports: (
    requests: ImportAssetRequest[],
  ): Promise<ImportedAsset[]> =>
    command<ImportedAsset[]>("stage_asset_imports", { request: { requests } }),
  inspectAssetImports: (sourcePaths: string[]): Promise<AssetInspection[]> =>
    command<AssetInspection[]>("inspect_asset_imports", {
      request: { source_paths: sourcePaths },
    }),
  buildNodePreview,
  previewSessionStart,
  previewSessionAdvance,
  previewSessionChoose,
  previewSessionClickButton,
  previewSessionPresentationComplete,
  previewSessionStop,
};

function encodePreviewOverrides(request: PreviewSessionStartRequest): unknown {
  return {
    project: encodeProjectRequest(request.project),
    mode: request.mode,
    scene_id: request.scene_id,
    node_id: request.node_id ?? null,
    variable_overrides: Object.fromEntries(
      Object.entries(request.variable_overrides).map(([id, value]) => [
        id,
        toWireScalar(value, request.project.manifest.variables[id]?.type),
      ]),
    ),
    choices: request.choices,
  };
}

function previewSessionStart(
  request: PreviewSessionStartRequest,
): Promise<PreviewSessionStartResult> {
  return command<unknown>("preview_session_start", {
    request: encodePreviewOverrides(request),
  }).then((value) => decodeWireValue(value) as PreviewSessionStartResult);
}

function previewSessionAdvance(request: {
  session_id: string;
  expected_revision: string;
  source: "manual" | "auto" | "fast_forward" | "forced_auto";
}): Promise<RuntimeUpdate> {
  return command<unknown>("preview_session_advance", { request }).then(
    (value) => decodeWireValue(value) as RuntimeUpdate,
  );
}

function previewSessionChoose(request: {
  session_id: string;
  expected_revision: string;
  choice_id: string;
}): Promise<RuntimeUpdate> {
  return command<unknown>("preview_session_choose", { request }).then(
    (value) => decodeWireValue(value) as RuntimeUpdate,
  );
}

function previewSessionClickButton(request: {
  session_id: string;
  expected_revision: string;
  instance_id: string;
}): Promise<RuntimeUpdate> {
  return command<unknown>("preview_session_click_button", { request }).then(
    (value) => decodeWireValue(value) as RuntimeUpdate,
  );
}

function previewSessionPresentationComplete(request: {
  session_id: string;
  update_id: string;
  outcome: "completed" | "skipped" | "failed";
}): Promise<RuntimeUpdate> {
  return command<unknown>("preview_session_presentation_complete", {
    request,
  }).then((value) => decodeWireValue(value) as RuntimeUpdate);
}

function previewSessionStop(sessionId: string): Promise<boolean> {
  return command<boolean>("preview_session_stop", {
    request: { session_id: sessionId },
  });
}

export function previewAssetsToUrls(
  assets: PreviewResolvedAsset[],
): Record<string, string> {
  return Object.fromEntries(
    assets.map((asset) => [asset.id, convertFileSrc(asset.absolute_path)]),
  );
}

export function previewAssetsToAnimations(
  assets: PreviewResolvedAsset[],
): AnimationMap {
  const animations: Record<
    string,
    {
      id: string;
      width: number;
      height: number;
      total_duration_ms: number;
      frames: { asset: string; duration_ms: number; url: string }[];
    }
  > = {};
  for (const asset of assets) {
    const animation = asset.animation;
    if (animation === null || animation === undefined) continue;
    if (animation.frames.length === 0) continue;
    animations[asset.id] = {
      id: animation.id,
      width: animation.width,
      height: animation.height,
      total_duration_ms: animation.total_duration_ms,
      frames: animation.frames.map((frame) => ({
        asset: frame.asset,
        duration_ms: frame.duration_ms,
        url: convertFileSrc(frame.absolute_path),
      })),
    };
  }
  return animations;
}

function toWireScalar(
  value: ScalarValue,
  declaredType: "boolean" | "integer" | "number" | "string" | undefined,
): WireScalarValue {
  if (declaredType === "integer") {
    let integer: bigint;
    if (typeof value === "bigint") {
      integer = value;
    } else if (typeof value === "number" && Number.isSafeInteger(value)) {
      integer = BigInt(value);
    } else if (
      typeof value === "string" &&
      /^(?:0|-?[1-9][0-9]*)$/.test(value)
    ) {
      integer = BigInt(value);
    } else {
      throw new Error("整数预览覆盖值必须是合法整数");
    }
    if (integer < I64_MIN || integer > I64_MAX) {
      throw new Error("整数预览覆盖值超出 i64 范围");
    }
    return { kind: "integer", value: integer.toString() };
  }
  if (declaredType === "number") {
    const number = typeof value === "bigint" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number)) {
      throw new Error("浮点预览覆盖值必须是有限数");
    }
    return { kind: "number", value: number };
  }
  if (declaredType === "boolean" && typeof value === "boolean") {
    return { kind: "boolean", value };
  }
  if (declaredType === "string" && typeof value === "string") {
    return { kind: "string", value };
  }
  throw new Error("预览覆盖值与变量声明类型不一致");
}

function decodeEditorProject(value: unknown): EditorProject {
  return decodeWireValue(value) as EditorProject;
}

function decodeWireValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeWireValue);
  if (value === null || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (isWireScalar(object)) {
    switch (object.kind) {
      case "boolean":
      case "string":
        return object.value;
      case "number":
        if (
          typeof object.value !== "number" ||
          !Number.isFinite(object.value)
        ) {
          throw new Error("wire number 必须是有限数字");
        }
        return object.value;
      case "integer": {
        if (
          typeof object.value !== "string" ||
          !/^(?:0|-?[1-9][0-9]*)$/.test(object.value)
        ) {
          throw new Error("wire integer 必须是规范十进制字符串");
        }
        // Keep every integer as bigint inside the editor.  Converting only
        // values outside the safe range would make the same field change
        // representation depending on its value and would reintroduce
        // precision bugs when an input is edited and sent back to Rust.
        return parseWireInteger(object.value);
      }
    }
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => [key, decodeWireValue(child)]),
  );
}

function isWireScalar(
  value: Record<string, unknown>,
): value is Record<"kind", WireScalarValue["kind"]> & Record<"value", unknown> {
  return (
    Object.keys(value).length === 2 &&
    typeof value.kind === "string" &&
    ["boolean", "integer", "number", "string"].includes(value.kind)
  );
}

function encodeProjectRequest(request: SaveProjectRequest): unknown {
  const copy = structuredClone(request);
  encodeProjectScalars(copy);
  return copy;
}

function encodeProjectScalars(request: SaveProjectRequest): void {
  for (const definition of Object.values(request.manifest.variables)) {
    const value = definition.default;
    definition.default = encodeScalar(
      value,
      definition.type,
    ) as unknown as ScalarValue;
  }
  for (const scene of request.scenes) {
    for (const node of Object.values(scene.definition.nodes)) encodeNode(node);
  }
  if (request.chapter_map !== null && request.chapter_map !== undefined) {
    for (const hotspot of request.chapter_map.definition.hotspots) {
      for (const [id, value] of Object.entries(hotspot.variable_overrides)) {
        hotspot.variable_overrides[id] = encodeScalar(
          value,
          request.manifest.variables[id]?.type,
        ) as unknown as ScalarValue;
      }
      if (hotspot.reveal?.mode === "condition")
        encodeCondition(hotspot.reveal.condition);
    }
  }
  for (const settings of Object.values(
    request.layout.timeline_previews ?? {},
  )) {
    for (const [id, value] of Object.entries(settings.variable_overrides)) {
      settings.variable_overrides[id] = encodeScalar(
        value,
        request.manifest.variables[id]?.type,
      ) as unknown as ScalarValue;
    }
  }
}

function encodeNode(
  node: SaveProjectRequest["scenes"][number]["definition"]["nodes"][string],
): void {
  if (
    node.type === "set" &&
    node.value !== undefined &&
    !(
      typeof node.value === "object" &&
      node.value !== null &&
      "variable" in node.value
    )
  ) {
    node.value = encodeScalar(node.value) as unknown as typeof node.value;
  }
  if (node.type === "condition") encodeCondition(node.condition);
  if (node.type === "choice") {
    for (const choice of node.choices) {
      if (choice.visible_if !== undefined) encodeCondition(choice.visible_if);
      if (choice.enabled_if !== undefined) encodeCondition(choice.enabled_if);
    }
  }
  if (
    (node.type === "button_create" || node.type === "button_update") &&
    node.action !== undefined &&
    node.action !== null
  ) {
    for (const set of node.action.sets) {
      if (
        set.value !== undefined &&
        !(
          typeof set.value === "object" &&
          set.value !== null &&
          "variable" in set.value
        )
      ) {
        set.value = encodeScalar(set.value) as unknown as typeof set.value;
      }
    }
  }
}

function encodeCondition(
  condition: NonNullable<
    Extract<
      SaveProjectRequest["scenes"][number]["definition"]["nodes"][string],
      { type: "condition" }
    >["condition"]
  >,
): void {
  if ("left" in condition) {
    for (const side of [condition.left, condition.right]) {
      if ("value" in side)
        side.value = encodeScalar(side.value) as unknown as ScalarValue;
    }
  } else if (condition.op === "and" || condition.op === "or") {
    condition.conditions.forEach(encodeCondition);
  } else if (condition.op === "not") {
    encodeCondition(condition.condition);
  }
}

function encodeScalar(
  value: ScalarValue,
  expectedType?: VariableType,
): WireScalarValue {
  if (expectedType === "integer") {
    let integer: bigint;
    if (typeof value === "bigint") {
      integer = value;
    } else if (typeof value === "number" && Number.isSafeInteger(value)) {
      integer = BigInt(value);
    } else if (
      typeof value === "string" &&
      /^(?:0|-?[1-9][0-9]*)$/.test(value)
    ) {
      integer = BigInt(value);
    } else {
      throw new Error("integer 必须是合法整数");
    }
    if (integer < I64_MIN || integer > I64_MAX)
      throw new Error("integer 超出 i64 范围");
    return { kind: "integer", value: integer.toString() };
  }
  if (expectedType === "number") {
    const number = typeof value === "bigint" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number))
      throw new Error("number 必须是有限值");
    return { kind: "number", value: number };
  }
  if (expectedType === "boolean") {
    if (typeof value !== "boolean") throw new Error("boolean 类型不匹配");
    return { kind: "boolean", value };
  }
  if (expectedType === "string") {
    if (typeof value !== "string") throw new Error("string 类型不匹配");
    return { kind: "string", value };
  }
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (typeof value === "string") return { kind: "string", value };
  if (typeof value === "bigint")
    if (value < I64_MIN || value > I64_MAX)
      throw new Error("integer 超出 i64 范围");
    else return { kind: "integer", value: value.toString() };
  if (Number.isSafeInteger(value))
    return { kind: "integer", value: String(value) };
  if (!Number.isFinite(value)) throw new Error("number 必须是有限值");
  return { kind: "number", value };
}

export function assetUrl(path: string): string {
  return convertFileSrc(path);
}
