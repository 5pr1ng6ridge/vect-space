import { isWindowVariable } from "../windowInteraction";
import type { EditorDiagnostic, EditorProject } from "../types";
import {
  COLOR_PATTERN,
  ID_PATTERN,
  error,
  validateDisplayName,
  valueMatchesType,
} from "./shared";

export function validateVariables(
  project: EditorProject,
  diagnostics: EditorDiagnostic[],
): void {
  for (const [id, definition] of Object.entries(project.manifest.variables)) {
    if (!ID_PATTERN.test(id)) {
      diagnostics.push(error("invalid_variable", `变量名非法：${id}`));
    }
    if (isWindowVariable(id)) {
      diagnostics.push(
        error(
          "reserved_window_variable",
          `变量 ${id} 是内置的只读窗口标题变量，不能声明同名变量`,
        ),
      );
    }
    if (!valueMatchesType(definition.default, definition.type)) {
      diagnostics.push(
        error(
          "invalid_variable_default",
          `变量 ${id} 的默认值不符合 ${definition.type} 类型`,
        ),
      );
    }
  }
}

export function validateCharacters(
  project: EditorProject,
  diagnostics: EditorDiagnostic[],
): void {
  for (const [id, definition] of Object.entries(project.manifest.characters)) {
    if (!ID_PATTERN.test(id)) {
      diagnostics.push(error("invalid_character", `角色 ID 非法：${id}`));
    }
    validateDisplayName(definition.display_name).forEach((message) =>
      diagnostics.push(
        error("invalid_character_name", `角色 ${id}：${message}`),
      ),
    );
    for (const [field, color] of [
      ["姓名色", definition.name_color],
      ["正文色", definition.text_color],
    ] as const) {
      if (color != null && !COLOR_PATTERN.test(color)) {
        diagnostics.push(
          error("invalid_character_color", `角色 ${id} 的${field}格式非法`),
        );
      }
    }
    const expressions = definition.expressions ?? {};
    const defaultExpression = definition.default_expression ?? null;
    if (
      definition.default_scale !== undefined &&
      (!Number.isFinite(definition.default_scale) ||
        definition.default_scale <= 0)
    ) {
      diagnostics.push(
        error("invalid_character_scale", `角色 ${id} 的默认缩放必须为正数`),
      );
    }
    if (
      defaultExpression !== null &&
      expressions[defaultExpression] === undefined
    ) {
      diagnostics.push(
        error(
          "unknown_character_expression",
          `角色 ${id} 的默认表情不存在：${defaultExpression}`,
        ),
      );
    }
    for (const [expressionId, expression] of Object.entries(expressions)) {
      if (!ID_PATTERN.test(expressionId)) {
        diagnostics.push(
          error(
            "invalid_character_expression",
            `角色 ${id} 的表情 ID 非法：${expressionId}`,
          ),
        );
      }
      const asset = project.manifest.assets[expression.asset];
      if (asset === undefined || asset.kind !== "sprite") {
        diagnostics.push(
          error(
            "invalid_character_expression_asset",
            `角色 ${id}/${expressionId} 必须引用 sprite 素材：${expression.asset}`,
          ),
        );
      }
      const anchorX = expression.anchor_x ?? 0.5;
      const anchorY = expression.anchor_y ?? 1;
      const scale = expression.scale ?? 1;
      if (
        !Number.isFinite(anchorX) ||
        !Number.isFinite(anchorY) ||
        anchorX < 0 ||
        anchorX > 1 ||
        anchorY < 0 ||
        anchorY > 1
      ) {
        diagnostics.push(
          error(
            "invalid_character_anchor",
            `角色 ${id}/${expressionId} 的锚点必须在 0 到 1 之间`,
          ),
        );
      }
      if (
        !Number.isFinite(expression.offset_x ?? 0) ||
        !Number.isFinite(expression.offset_y ?? 0) ||
        !Number.isFinite(scale) ||
        scale <= 0
      ) {
        diagnostics.push(
          error(
            "invalid_character_alignment",
            `角色 ${id}/${expressionId} 的对齐参数无效`,
          ),
        );
      }
    }
  }
}

export function validateManagedDocumentPaths(
  project: EditorProject,
  output: EditorDiagnostic[],
): void {
  const paths: [string, string][] = [
    ...project.manifest.scenes.map((path): [string, string] => ["scene", path]),
    ...project.manifest.ui_motions.map((path): [string, string] => [
      "ui_motion",
      path,
    ]),
    ...(project.manifest.buttons ?? []).map((path): [string, string] => [
      "button",
      path,
    ]),
    ...(project.manifest.animations ?? []).map((path): [string, string] => [
      "animation",
      path,
    ]),
    ...(project.manifest.actions ?? []).map((path): [string, string] => [
      "action",
      path,
    ]),
    ...(project.manifest.text_blocks ?? []).map((path): [string, string] => [
      "text_block",
      path,
    ]),
    ...(project.manifest.particles ?? []).map((path): [string, string] => [
      "particle",
      path,
    ]),
  ];
  if (project.manifest.chapter_map != null)
    paths.push(["chapter_map", project.manifest.chapter_map]);
  const seen = new Map<string, string>();
  for (const [kind, path] of paths) {
    const normalized = path.replaceAll("\\", "/").toLowerCase();
    if (
      normalized === "manifest.yaml" ||
      normalized.startsWith("assets/") ||
      normalized.startsWith(".vectspace/")
    ) {
      output.push(
        error(
          "reserved_document_path",
          `${kind} 路径不能覆盖受管制文件：${path}`,
        ),
      );
    }
    const previous = seen.get(normalized);
    if (previous !== undefined) {
      output.push(
        error(
          "duplicate_document_path",
          `内容文件路径与 ${previous} 冲突：${path}`,
        ),
      );
    } else {
      seen.set(normalized, kind);
    }
  }
}
