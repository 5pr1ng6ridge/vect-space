import { interpolateTemplate } from "../../textTemplate";
import { scalarType } from "../../scalars";
import { readableVariables } from "../../windowInteraction";
import type {
  ConditionExpression,
  ContentManifest,
  MutationValue,
  LongTextLayout,
  ScalarValue,
  SceneNode,
  ValueOperand,
  VariableOperation,
  VariableType,
} from "../../types";
import { MUTATION_LABELS } from "../../labels";

export const DEFAULT_LONG_TEXT_LAYOUT: LongTextLayout = {
  x: 340,
  y: 0,
  width: 1240,
  height: 1080,
  padding_x: 118,
  padding_y: 112,
  page_height: 1340,
  page_gap: 92,
};

export const SET_OPERATIONS: { value: VariableOperation; label: string }[] = (
  ["assign", "add", "sub", "mul", "mod", "append", "toggle"] as const
).map((value) => ({ value, label: MUTATION_LABELS[value] }));

export function operationSupportsTarget(
  operation: VariableOperation,
  target: VariableType | undefined,
): boolean {
  if (target === undefined || operation === "assign") return true;
  if (target === "boolean") return operation === "toggle";
  if (target === "string") return operation === "append";
  if (target === "integer")
    return ["add", "sub", "mul", "mod"].includes(operation);
  return ["add", "sub", "mul"].includes(operation);
}

export function defaultSetValue(
  variable: string,
  op: NonNullable<Extract<SceneNode, { type: "set" }>["op"]>,
  manifest: ContentManifest,
): MutationValue {
  const type = manifest.variables[variable]?.type ?? "boolean";
  if (op === "append") return "";
  return defaultScalar(type);
}

export function mutationTypesCompatible(
  target: VariableType,
  source: VariableType,
  op: NonNullable<Extract<SceneNode, { type: "set" }>["op"]>,
): boolean {
  switch (op) {
    case "assign":
      return target === source || (target === "number" && source === "integer");
    case "add":
    case "sub":
    case "mul":
      return (
        (target === "integer" || target === "number") &&
        (source === "integer" || source === "number") &&
        (target !== "integer" || source === "integer")
      );
    case "mod":
      return target === "integer" && source === "integer";
    case "append":
      return target === "string" && source === "string";
    case "toggle":
      return false;
  }
}

export function interpolatePreview(
  source: string,
  manifest: ContentManifest,
): string {
  try {
    return interpolateTemplate(source, (id) => {
      const definition = readableVariables(manifest)[id];
      if (definition === undefined) throw new Error(`未知变量 ${id}`);
      return definition.default;
    });
  } catch {
    return source;
  }
}

const COMPARISON_OPERATORS = ["eq", "ne", "lt", "le", "gt", "ge"] as const;

type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

export function isComparison(
  value: ConditionExpression,
): value is Extract<ConditionExpression, { left: ValueOperand }> {
  return COMPARISON_OPERATORS.includes(
    value.op as (typeof COMPARISON_OPERATORS)[number],
  );
}

export function conditionForOperator(
  op: ConditionExpression["op"],
  previous: ConditionExpression,
  fallbackVariable: string,
): ConditionExpression {
  if (COMPARISON_OPERATORS.includes(op as ComparisonOperator)) {
    return {
      op: op as ComparisonOperator,
      left: isComparison(previous)
        ? previous.left
        : { variable: fallbackVariable },
      right: isComparison(previous) ? previous.right : { value: true },
    };
  }
  if (op === "and" || op === "or") {
    return {
      op,
      conditions:
        previous.op === "and" || previous.op === "or"
          ? previous.conditions
          : [previous],
    };
  }
  return {
    op: "not",
    condition: previous.op === "not" ? previous.condition : previous,
  };
}

export function operandVariableType(
  operand: ValueOperand,
  manifest: ContentManifest,
): VariableType | null {
  return "variable" in operand
    ? (readableVariables(manifest)[operand.variable]?.type ?? null)
    : scalarType(operand.value);
}

export function defaultScalar(type: VariableType): ScalarValue {
  switch (type) {
    case "boolean":
      return false;
    case "integer":
      return 0n;
    case "number":
      return 0;
    case "string":
      return "";
  }
}
