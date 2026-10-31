import type { ReactElement } from "react";
import { readableVariables } from "../../windowInteraction";
import type {
  ContentManifest,
  MutationValue,
  ScalarValue,
  SceneNode,
} from "../../types";
import { Field } from "../Fields";
import { VARIABLE_TYPE_LABELS } from "../../labels";
import {
  defaultScalar,
  defaultSetValue,
  mutationTypesCompatible,
} from "./model";
import { LiteralEditor } from "./ConditionEditor";

export function MutationValueEditor({
  manifest,
  node,
  onChange,
}: {
  manifest: ContentManifest;
  node: Extract<SceneNode, { type: "set" }>;
  onChange(value: MutationValue): void;
}): ReactElement {
  const op = node.op ?? "assign";
  const targetType = manifest.variables[node.variable]?.type ?? "boolean";
  const value = node.value ?? defaultSetValue(node.variable, op, manifest);
  const variableValue =
    typeof value === "object" && value !== null ? value.variable : null;
  const eligibleVariables = Object.entries(readableVariables(manifest)).filter(
    ([, definition]) =>
      mutationTypesCompatible(targetType, definition.type, op),
  );
  return (
    <Field label="操作数">
      <div className="operand-editor">
        <select
          value={variableValue === null ? "literal" : "variable"}
          onChange={(event) =>
            onChange(
              event.currentTarget.value === "variable"
                ? { variable: eligibleVariables[0]?.[0] ?? "" }
                : defaultScalar(targetType),
            )
          }
        >
          <option value="literal">固定值</option>
          <option value="variable">变量</option>
        </select>
        {variableValue === null ? (
          <LiteralEditor
            expectedType={targetType}
            onChange={onChange}
            value={value as ScalarValue}
          />
        ) : (
          <select
            value={variableValue}
            onChange={(event) =>
              onChange({ variable: event.currentTarget.value })
            }
          >
            {!eligibleVariables.some(([id]) => id === variableValue) && (
              <option value={variableValue}>
                {variableValue || "— 无兼容变量 —"}
              </option>
            )}
            {eligibleVariables.map(([id, definition]) => (
              <option key={id} value={id}>
                {id}（{VARIABLE_TYPE_LABELS[definition.type]}）
              </option>
            ))}
          </select>
        )}
      </div>
    </Field>
  );
}
