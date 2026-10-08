import { isIntegerScalar } from "../scalars";
import type {
  AmbienceSlot,
  EditorDiagnostic,
  ScalarValue,
  VariableType,
} from "../types";

export { ID_PATTERN } from "../app/ids";

export const AMBIENCE_SLOTS: readonly AmbienceSlot[] = [
  "slot_1",
  "slot_2",
  "slot_3",
  "slot_4",
];

/** Reports one diagnostic against the node being validated. */
export type IssueSink = (code: string, message: string) => void;

/** `#RRGGBB` or `#RRGGBBAA`, matching the Rust loader's accepted colors. */
export const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/;

export function validateColorValue(
  color: string,
  label: string,
  issue: (code: string, message: string) => void,
): void {
  if (!COLOR_PATTERN.test(color)) {
    issue("invalid_color", `${label}必须是 #RRGGBB 或 #RRGGBBAA`);
  }
}

export function validateDisplayName(value: string): string[] {
  const issues: string[] = [];
  if (value.trim() === "") issues.push("显示名不能为空");
  if (Array.from(value).length > 64) issues.push("显示名不能超过 64 个字符");
  if (/\p{Cc}/u.test(value)) issues.push("显示名不能包含控制字符");
  return issues;
}

export function valueMatchesType(
  value: ScalarValue,
  type: VariableType,
): boolean {
  switch (type) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return (
        isIntegerScalar(value) &&
        (typeof value === "bigint" || Number.isSafeInteger(value))
      );
    case "number":
      return (
        typeof value === "bigint" ||
        (typeof value === "number" && Number.isFinite(value))
      );
    case "string":
      return (
        typeof value === "string" &&
        new TextEncoder().encode(value).length <= 16 * 1024
      );
  }
}

export function isNumericType(type: VariableType): boolean {
  return type === "integer" || type === "number";
}

export function error(
  code: string,
  message: string,
  sceneId: string | null = null,
  nodeId: string | null = null,
): EditorDiagnostic {
  return {
    severity: "error",
    code,
    message,
    scene_id: sceneId,
    node_id: nodeId,
  };
}

export function mapError(
  code: string,
  message: string,
  elementId: string | null,
): EditorDiagnostic {
  return {
    severity: "error",
    code,
    message,
    scene_id: null,
    node_id: null,
    workspace: "map",
    flow_element_id: elementId,
  };
}

export function deduplicate(
  diagnostics: EditorDiagnostic[],
): EditorDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = [
      diagnostic.severity,
      diagnostic.code,
      diagnostic.scene_id,
      diagnostic.node_id,
      diagnostic.workspace,
      diagnostic.flow_element_id,
      diagnostic.message,
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
