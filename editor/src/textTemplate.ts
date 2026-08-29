import type { ScalarValue, VariableType } from "./types";

export type TemplateContext = "text" | "math";

export interface TemplateReference {
  id: string;
  context: TemplateContext;
  start: number;
  end: number;
}

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function templateReferences(source: string): TemplateReference[] {
  const output: TemplateReference[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (isUnescapedAt(source, cursor, "$$")) {
      const end = findUnescaped(source, "$$", cursor + 2);
      if (end !== -1) {
        scanRange(source, cursor + 2, end, "math", output);
        cursor = end + 2;
        continue;
      }
    }
    if (isUnescapedAt(source, cursor, "$")) {
      const end = findUnescaped(source, "$", cursor + 1);
      if (end !== -1) {
        scanRange(source, cursor + 1, end, "math", output);
        cursor = end + 1;
        continue;
      }
    }
    const nextMath = nextUnescapedDollar(source, cursor);
    const end = nextMath === -1 ? source.length : nextMath;
    scanRange(source, cursor, end, "text", output);
    cursor = end === cursor ? cursor + 1 : end;
  }
  return output.sort((left, right) => left.start - right.start);
}

export function interpolateTemplate(
  source: string,
  resolve: (id: string) => ScalarValue,
): string {
  const references = templateReferences(source);
  let output = "";
  let cursor = 0;
  for (const reference of references) {
    output += source.slice(cursor, reference.start);
    const value = resolve(reference.id);
    output +=
      reference.context === "math"
        ? formatMathValue(value)
        : escapePlainValue(value);
    cursor = reference.end;
  }
  return output + source.slice(cursor);
}

export function renameTemplateVariable(
  source: string,
  previousId: string,
  nextId: string,
): string {
  try {
    return replaceReferences(source, (reference) =>
      reference.id === previousId ? `[var=${nextId}]` : null,
    );
  } catch {
    return source;
  }
}

export function countTemplateVariable(
  source: string,
  variableId: string,
): number {
  try {
    return templateReferences(source).filter(({ id }) => id === variableId)
      .length;
  } catch {
    return 0;
  }
}

export function removeUnknownTemplateVariables(
  source: string,
  knownVariables: ReadonlySet<string>,
): string {
  try {
    return replaceReferences(source, (reference) =>
      knownVariables.has(reference.id) ? null : "",
    );
  } catch {
    return source;
  }
}

export function validateTemplate(
  source: string,
  variableTypes: Record<string, VariableType>,
): string[] {
  const issues: string[] = [];
  let references: TemplateReference[];
  try {
    references = templateReferences(source);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  for (const reference of references) {
    const type = variableTypes[reference.id];
    if (type === undefined) {
      issues.push(`变量插值引用了未声明变量：${reference.id}`);
    } else if (
      reference.context === "math" &&
      type !== "integer" &&
      type !== "number"
    ) {
      issues.push(`公式中的插值变量 ${reference.id} 必须是 integer 或 number`);
    }
  }
  return issues;
}

function replaceReferences(
  source: string,
  replacement: (reference: TemplateReference) => string | null,
): string {
  let output = "";
  let cursor = 0;
  for (const reference of templateReferences(source)) {
    const next = replacement(reference);
    if (next === null) continue;
    output += source.slice(cursor, reference.start) + next;
    cursor = reference.end;
  }
  return output + source.slice(cursor);
}

function scanRange(
  source: string,
  start: number,
  end: number,
  context: TemplateContext,
  output: TemplateReference[],
): void {
  let cursor = start;
  while (cursor < end) {
    if (source.startsWith("[var=", cursor) && !isEscaped(source, cursor)) {
      const close = source.indexOf("]", cursor + 5);
      if (close === -1 || close >= end) {
        throw new Error("变量插值缺少右方括号");
      }
      const id = source.slice(cursor + 5, close);
      if (!ID_PATTERN.test(id)) throw new Error(`变量插值 ID 非法：${id}`);
      output.push({ id, context, start: cursor, end: close + 1 });
      cursor = close + 1;
    } else {
      cursor += 1;
    }
  }
}

function isEscaped(source: string, index: number): boolean {
  let slashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && source[cursor] === "\\";
    cursor -= 1
  ) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function isUnescapedAt(source: string, index: number, marker: string): boolean {
  return source.startsWith(marker, index) && !isEscaped(source, index);
}

function findUnescaped(source: string, marker: string, from: number): number {
  let found = source.indexOf(marker, from);
  while (found !== -1 && isEscaped(source, found)) {
    found = source.indexOf(marker, found + marker.length);
  }
  return found;
}

function nextUnescapedDollar(source: string, from: number): number {
  return findUnescaped(source, "$", from);
}

function escapePlainValue(value: ScalarValue): string {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("$", "\\$")
    .replaceAll("[", "\\[");
}

function formatMathValue(value: ScalarValue): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("公式插值只接受 integer 或 number");
  }
  const text = String(value);
  const match = /^(.+?)[eE]([+-]?\d+)$/.exec(text);
  if (match === null) return text;
  const exponent = match[2].replace(/^\+/, "");
  return `${match[1]}\\times 10^{${exponent}}`;
}
