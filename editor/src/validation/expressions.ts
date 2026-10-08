import { validateTemplate } from "../textTemplate";
import { readableVariables } from "../windowInteraction";
import { scalarType } from "../scalars";
import type {
  ConditionExpression,
  EditorProject,
  SceneNode,
  ValueOperand,
  VariableType,
} from "../types";
import { isNumericType } from "./shared";

export function validateMutation(
  project: EditorProject,
  node: Extract<SceneNode, { type: "set" }>,
  issue: (code: string, message: string) => void,
): void {
  const target = project.manifest.variables[node.variable];
  if (target === undefined) return;
  const op = node.op ?? "assign";
  if (op === "toggle") {
    if (target.type !== "boolean") {
      issue("invalid_toggle", "toggle 只能用于 boolean 变量");
    }
    if (node.value !== undefined) {
      issue("invalid_toggle_value", "toggle 不接受 value");
    }
    return;
  }
  if (node.value === undefined) {
    issue("missing_mutation_value", `${op} 必须提供 value`);
    return;
  }
  const sourceType = mutationValueType(project, node.value, issue);
  if (sourceType === null) return;
  const compatible = (() => {
    switch (op) {
      case "assign":
        return (
          target.type === sourceType ||
          (target.type === "number" && sourceType === "integer")
        );
      case "add":
      case "sub":
      case "mul":
        return (
          isNumericType(target.type) &&
          isNumericType(sourceType) &&
          (target.type !== "integer" || sourceType === "integer")
        );
      case "mod":
        return target.type === "integer" && sourceType === "integer";
      case "append":
        return target.type === "string" && sourceType === "string";
    }
  })();
  if (!compatible) {
    issue("variable_operation_type", `${op} 的目标变量与操作数类型不兼容`);
  }
  if (op === "mod" && typeof node.value === "number" && node.value === 0) {
    issue("modulo_by_zero", "mod 的除数不能为零");
  }
}

function mutationValueType(
  project: EditorProject,
  value: NonNullable<Extract<SceneNode, { type: "set" }>["value"]>,
  issue: (code: string, message: string) => void,
): VariableType | null {
  if (typeof value === "object" && value !== null) {
    const definition = readableVariables(project.manifest)[value.variable];
    if (definition === undefined) {
      issue("unknown_variable", `操作数引用了未声明变量：${value.variable}`);
      return null;
    }
    return definition.type;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    issue("non_finite_literal", "运算数值必须是有限数");
  }
  if (
    typeof value === "string" &&
    new TextEncoder().encode(value).length > 16 * 1024
  ) {
    issue("string_too_long", "字符串不能超过 16 KiB UTF-8");
  }
  return scalarType(value);
}

export function validateTextTemplate(
  project: EditorProject,
  source: string,
  issue: (code: string, message: string) => void,
): void {
  const types = Object.fromEntries(
    Object.entries(readableVariables(project.manifest)).map(
      ([id, definition]) => [id, definition.type],
    ),
  );
  for (const message of validateTemplate(source, types)) {
    issue("invalid_interpolation", message);
  }
}

export function validateCondition(
  project: EditorProject,
  condition: ConditionExpression,
  issue: (code: string, message: string) => void,
  allowWindowVariables = true,
): void {
  let nodes = 0;
  const visit = (candidate: ConditionExpression, depth: number): void => {
    nodes += 1;
    if (depth > 32) {
      issue("condition_too_deep", "条件表达式嵌套不能超过 32 层");
      return;
    }
    if (nodes > 256) {
      issue("condition_too_large", "条件表达式不能超过 256 个节点");
      return;
    }
    switch (candidate.op) {
      case "eq":
      case "ne": {
        const left = operandType(
          project,
          candidate.left,
          issue,
          allowWindowVariables,
        );
        const right = operandType(
          project,
          candidate.right,
          issue,
          allowWindowVariables,
        );
        if (
          left !== null &&
          right !== null &&
          left !== right &&
          !(isNumericType(left) && isNumericType(right))
        ) {
          issue("condition_type_mismatch", "Eq/Ne 两侧类型不兼容");
        }
        break;
      }
      case "lt":
      case "le":
      case "gt":
      case "ge": {
        const left = operandType(
          project,
          candidate.left,
          issue,
          allowWindowVariables,
        );
        const right = operandType(
          project,
          candidate.right,
          issue,
          allowWindowVariables,
        );
        if (
          (left !== null && !isNumericType(left)) ||
          (right !== null && !isNumericType(right))
        ) {
          issue("condition_ordering_type", "Lt/Le/Gt/Ge 只允许比较整数或数值");
        }
        break;
      }
      case "and":
      case "or":
        if (candidate.conditions.length === 0) {
          issue("empty_condition_group", "And/Or 至少需要一个子条件");
        }
        candidate.conditions.forEach((child) => visit(child, depth + 1));
        break;
      case "not":
        visit(candidate.condition, depth + 1);
        break;
    }
  };
  visit(condition, 1);
}

function operandType(
  project: EditorProject,
  operand: ValueOperand,
  issue: (code: string, message: string) => void,
  allowWindowVariables = true,
): VariableType | null {
  if ("variable" in operand) {
    const definition = allowWindowVariables
      ? readableVariables(project.manifest)[operand.variable]
      : project.manifest.variables[operand.variable];
    if (definition === undefined) {
      issue("unknown_variable", `条件引用了未声明变量：${operand.variable}`);
      return null;
    }
    return definition.type;
  }
  if (typeof operand.value === "number" && !Number.isFinite(operand.value)) {
    issue("non_finite_literal", "条件数值必须是有限数");
  }
  return scalarType(operand.value);
}
