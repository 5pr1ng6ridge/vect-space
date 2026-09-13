/**
 * Small labelled input primitives shared by the node inspector and the
 * transition/effect parameter editors.
 */

import { useRef, type ReactElement, type ReactNode } from "react";

export function Field({
  children,
  hint,
  label,
}: {
  children: ReactNode;
  hint?: string;
  label: string;
}): ReactElement {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint !== undefined && <small>{hint}</small>}
    </label>
  );
}

export function NumberField({
  disabled = false,
  label,
  max,
  min,
  onChange,
  step = 1,
  value,
}: {
  disabled?: boolean;
  label: string;
  max?: number;
  min?: number;
  onChange(value: number): void;
  step?: number;
  value: number;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = (): void => {
    const raw = inputRef.current?.value ?? String(value);
    const parsed = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(parsed)) {
      if (parsed !== value) onChange(parsed);
    } else {
      if (inputRef.current !== null) inputRef.current.value = String(value);
    }
  };
  return (
    <Field label={label}>
      <input
        disabled={disabled}
        max={max}
        min={min}
        step={step}
        type="number"
        defaultValue={String(value)}
        key={String(value)}
        ref={inputRef}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
    </Field>
  );
}

/** `#RRGGBB`/`#RRGGBBAA` colour picker plus a free-form text field. */
export function ColorField({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange(value: string): void;
  value: string;
}): ReactElement {
  const textRef = useRef<HTMLInputElement>(null);
  const commit = (): void => {
    const draft = textRef.current?.value ?? value;
    if (draft !== value) onChange(draft);
  };
  return (
    <Field label={label} hint="支持 #RRGGBB 或 #RRGGBBAA">
      <div className="inline-field">
        <input
          aria-label={`${label}选择器`}
          onChange={(event) =>
            onChange(event.currentTarget.value.toUpperCase())
          }
          type="color"
          value={/^#[0-9A-Fa-f]{6}/.test(value) ? value.slice(0, 7) : "#000000"}
        />
        <input
          aria-label={label}
          defaultValue={value}
          key={value}
          ref={textRef}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
        />
      </div>
    </Field>
  );
}
