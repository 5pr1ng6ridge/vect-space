import type { ReactElement } from "react";
import { isCanonicalIntegerText } from "../../scalars";
import { ColorSwatch, DeferredInput } from "../Fields";
import type { ScalarValue, VariableDefinition } from "../../types";

export function CharacterColorInput({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange(value: string | null): void;
  value?: string | null;
}): ReactElement {
  const opaqueColor = value?.slice(0, 7) ?? "#FFFFFF";
  return (
    <label className="character-color-field">
      <span>{label}</span>
      <span>
        <ColorSwatch
          label={`${label}选择器`}
          onCommit={onChange}
          value={
            /^#[0-9A-Fa-f]{6}$/.test(opaqueColor) ? opaqueColor : "#FFFFFF"
          }
        />
        <DeferredTextInput
          placeholder="#RRGGBB / 留空"
          value={value ?? ""}
          onCommit={(next) => onChange(next || null)}
        />
      </span>
    </label>
  );
}

export function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
  min?: number;
  max?: number;
  step?: number;
}): ReactElement {
  return (
    <label>
      <span>{label}</span>
      <DeferredInput
        max={max}
        min={min}
        onCommit={(raw) => {
          const next = Number(raw);
          if (raw.trim() === "" || !Number.isFinite(next)) return false;
          onChange(next);
        }}
        step={step ?? "any"}
        type="number"
        value={String(value)}
      />
    </label>
  );
}

export function VariableDefaultInput({
  definition,
  onChange,
}: {
  definition: VariableDefinition;
  onChange(value: ScalarValue): void;
}): ReactElement {
  if (definition.type === "boolean") {
    return (
      <select
        value={String(definition.default)}
        onChange={(event) => onChange(event.currentTarget.value === "true")}
      >
        <option value="true">是</option>
        <option value="false">否</option>
      </select>
    );
  }
  const defaultText = String(definition.default);
  if (definition.type === "integer") {
    return (
      <DeferredInput
        aria-label="整数默认值"
        inputMode="numeric"
        onCommit={(raw) => {
          if (!isCanonicalIntegerText(raw)) return false;
          onChange(BigInt(raw));
        }}
        type="text"
        value={defaultText}
      />
    );
  }
  return (
    <DeferredInput
      onCommit={(raw) => {
        if (definition.type !== "number") {
          onChange(raw);
          return;
        }
        const parsed = Number(raw);
        if (raw.trim() === "" || !Number.isFinite(parsed)) return false;
        if (parsed !== definition.default) onChange(parsed);
      }}
      step="any"
      type={definition.type === "number" ? "number" : "text"}
      value={defaultText}
    />
  );
}

export function DeferredTextInput({
  maxLength,
  onCommit,
  placeholder,
  value,
}: {
  maxLength?: number;
  onCommit(value: string): void;
  placeholder?: string;
  value: string;
}): ReactElement {
  return (
    <DeferredInput
      maxLength={maxLength}
      onCommit={(raw) => onCommit(raw)}
      placeholder={placeholder}
      value={value}
    />
  );
}
