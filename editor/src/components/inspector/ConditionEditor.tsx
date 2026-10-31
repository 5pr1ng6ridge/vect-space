import type { ReactElement } from "react";
import { defaultCondition } from "../../story";
import { isCanonicalIntegerText, scalarType } from "../../scalars";
import {
  readableVariables,
  WINDOW_VARIABLE_LABELS,
} from "../../windowInteraction";
import type {
  ConditionExpression,
  ContentManifest,
  ScalarValue,
  ValueOperand,
  VariableType,
} from "../../types";
import { DeferredInput, Field } from "../Fields";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { VARIABLE_SCOPE_LABELS, VARIABLE_TYPE_LABELS } from "../../labels";
import { IconButton } from "../../ui/Button";
import { BooleanField } from "./fieldControls";
import {
  conditionForOperator,
  defaultScalar,
  isComparison,
  operandVariableType,
} from "./model";

export function OptionalConditionEditor({
  label,
  manifest,
  onChange,
  value,
}: {
  label: string;
  manifest: ContentManifest;
  onChange(value: ConditionExpression | undefined): void;
  value: ConditionExpression | undefined;
}): ReactElement {
  const fallbackVariable = Object.keys(manifest.variables)[0] ?? "flag";
  return (
    <div className="optional-condition">
      <BooleanField
        label={label}
        onChange={(enabled) =>
          onChange(
            enabled ? (value ?? defaultCondition(fallbackVariable)) : undefined,
          )
        }
        value={value !== undefined}
      />
      {value !== undefined && (
        <ConditionEditor
          manifest={manifest}
          onChange={onChange}
          value={value}
        />
      )}
    </div>
  );
}

export function ConditionEditor({
  manifest,
  onChange,
  value,
}: {
  manifest: ContentManifest;
  onChange(value: ConditionExpression): void;
  value: ConditionExpression;
}): ReactElement {
  const fallbackVariable = Object.keys(manifest.variables)[0] ?? "flag";
  return (
    <div className="condition-editor">
      <Field label="运算符">
        <select
          value={value.op}
          onChange={(event) =>
            onChange(
              conditionForOperator(
                event.currentTarget.value as ConditionExpression["op"],
                value,
                fallbackVariable,
              ),
            )
          }
        >
          <option value="eq">等于</option>
          <option value="ne">不等于</option>
          <option value="lt">小于</option>
          <option value="le">小于等于</option>
          <option value="gt">大于</option>
          <option value="ge">大于等于</option>
          <option value="and">And · 全部成立</option>
          <option value="or">任一满足（或）</option>
          <option value="not">Not · 取反</option>
        </select>
      </Field>
      {isComparison(value) && (
        <div className="condition-operands">
          <OperandEditor
            label="左值"
            manifest={manifest}
            onChange={(left) => onChange({ ...value, left })}
            other={value.right}
            value={value.left}
          />
          <OperandEditor
            label="右值"
            manifest={manifest}
            onChange={(right) => onChange({ ...value, right })}
            other={value.left}
            value={value.right}
          />
        </div>
      )}
      {(value.op === "and" || value.op === "or") && (
        <div className="condition-children">
          {value.conditions.map((child, index) => (
            <div className="condition-child" key={index}>
              <div className="condition-child-actions">
                <IconButton
                  disabled={index === 0}
                  onClick={() => {
                    const conditions = [...value.conditions];
                    [conditions[index - 1], conditions[index]] = [
                      conditions[index],
                      conditions[index - 1],
                    ];
                    onChange({ ...value, conditions });
                  }}
                  icon={ArrowUp}
                  label="上移"
                  size="sm"
                  variant="ghost"
                />
                <IconButton
                  disabled={index === value.conditions.length - 1}
                  onClick={() => {
                    const conditions = [...value.conditions];
                    [conditions[index], conditions[index + 1]] = [
                      conditions[index + 1],
                      conditions[index],
                    ];
                    onChange({ ...value, conditions });
                  }}
                  icon={ArrowDown}
                  label="下移"
                  size="sm"
                  variant="ghost"
                />
                <IconButton
                  onClick={() =>
                    onChange({
                      ...value,
                      conditions: value.conditions.filter(
                        (_candidate, candidateIndex) =>
                          candidateIndex !== index,
                      ),
                    })
                  }
                  icon={Trash2}
                  label="删除"
                  size="sm"
                />
              </div>
              <ConditionEditor
                manifest={manifest}
                onChange={(condition) =>
                  onChange({
                    ...value,
                    conditions: value.conditions.map(
                      (candidate, candidateIndex) =>
                        candidateIndex === index ? condition : candidate,
                    ),
                  })
                }
                value={child}
              />
            </div>
          ))}
          <button
            className="wide-button"
            onClick={() =>
              onChange({
                ...value,
                conditions: [
                  ...value.conditions,
                  defaultCondition(fallbackVariable),
                ],
              })
            }
            type="button"
          >
            ＋ 添加子条件
          </button>
        </div>
      )}
      {value.op === "not" && (
        <div className="condition-child">
          <ConditionEditor
            manifest={manifest}
            onChange={(condition) => onChange({ ...value, condition })}
            value={value.condition}
          />
        </div>
      )}
    </div>
  );
}

function OperandEditor({
  label,
  manifest,
  onChange,
  other,
  value,
}: {
  label: string;
  manifest: ContentManifest;
  onChange(value: ValueOperand): void;
  other: ValueOperand;
  value: ValueOperand;
}): ReactElement {
  const readable = readableVariables(manifest);
  const variableIds = Object.keys(readable);
  const expectedType = operandVariableType(other, manifest);
  return (
    <Field label={label}>
      <div className="operand-editor">
        <select
          value={"variable" in value ? "variable" : "value"}
          onChange={(event) => {
            if (event.currentTarget.value === "variable") {
              onChange({ variable: variableIds[0] ?? "" });
            } else {
              onChange({ value: defaultScalar(expectedType ?? "boolean") });
            }
          }}
        >
          <option value="variable">变量</option>
          <option value="value">固定值</option>
        </select>
        {"variable" in value ? (
          <select
            value={value.variable}
            onChange={(event) =>
              onChange({ variable: event.currentTarget.value })
            }
          >
            {!variableIds.includes(value.variable) && (
              <option value={value.variable}>
                {value.variable || "— 未声明 —"}
              </option>
            )}
            {variableIds.map((id) => (
              <option key={id} value={id}>
                {id in WINDOW_VARIABLE_LABELS
                  ? `${id}（${WINDOW_VARIABLE_LABELS[id]} · 只读 · 文本）`
                  : `${id}（${VARIABLE_SCOPE_LABELS[readable[id].scope]} · ${VARIABLE_TYPE_LABELS[readable[id].type]}）`}
              </option>
            ))}
          </select>
        ) : (
          <LiteralEditor
            expectedType={expectedType}
            onChange={(literal) => onChange({ value: literal })}
            value={value.value}
          />
        )}
      </div>
    </Field>
  );
}

export function LiteralEditor({
  expectedType,
  onChange,
  value,
}: {
  expectedType: VariableType | null;
  onChange(value: ScalarValue): void;
  value: ScalarValue;
}): ReactElement {
  const valueType = expectedType ?? scalarType(value);
  if (valueType === "boolean") {
    return (
      <select
        value={String(value)}
        onChange={(event) => onChange(event.currentTarget.value === "true")}
      >
        <option value="true">是</option>
        <option value="false">否</option>
      </select>
    );
  }
  if (valueType === "integer") {
    return (
      <DeferredInput
        aria-label="整数值"
        inputMode="numeric"
        onCommit={(raw) => {
          if (!isCanonicalIntegerText(raw)) return false;
          onChange(BigInt(raw));
        }}
        type="text"
        value={String(value)}
      />
    );
  }
  return (
    <DeferredInput
      onCommit={(raw) => {
        if (valueType !== "number") {
          onChange(raw);
          return;
        }
        const parsed = Number(raw);
        if (raw.trim() === "" || !Number.isFinite(parsed)) return false;
        onChange(parsed);
      }}
      step="any"
      type={valueType === "number" ? "number" : "text"}
      value={String(value)}
    />
  );
}
