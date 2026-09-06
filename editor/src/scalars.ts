import type { ScalarValue, VariableType } from "./types";

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export function isIntegerScalar(value: ScalarValue): value is bigint | number {
  return (
    typeof value === "bigint" ||
    (typeof value === "number" && Number.isInteger(value))
  );
}

export function isFiniteNumberScalar(value: ScalarValue): boolean {
  return (
    typeof value === "bigint" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

export function scalarType(value: ScalarValue): VariableType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  return isIntegerScalar(value) ? "integer" : "number";
}

export function scalarText(value: ScalarValue): string {
  return typeof value === "bigint" ? value.toString() : String(value);
}

/**
 * JSON.stringify does not support bigint.  Editor settings are deliberately
 * allowed to contain bigint values, so every UI boundary that serializes a
 * domain object should use this helper instead of calling JSON.stringify
 * directly.  Integers are represented as decimal strings in the editable JSON
 * view and are converted back to wire integers by the API using the declared
 * variable type.
 */
export function stringifyScalarJson(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_key, child: unknown) =>
      typeof child === "bigint" ? child.toString() : child,
    space,
  );
}

export function parseIntegerText(value: string): ScalarValue {
  if (!isCanonicalIntegerText(value)) return 0n;
  const parsed = BigInt(value);
  return parsed;
}

export function isCanonicalIntegerText(value: string): boolean {
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(value)) return false;
  const parsed = BigInt(value);
  return parsed >= I64_MIN && parsed <= I64_MAX;
}
