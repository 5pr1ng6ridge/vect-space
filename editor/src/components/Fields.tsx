/**
 * Small labelled input primitives shared by the node inspector and the
 * transition/effect parameter editors.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

import { isComposing } from "../ui/keyboard";
import { usePendingCommit } from "../ui/pendingCommits";

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
  const pendingCommit = usePendingCommit(commit);
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
        {...pendingCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !isComposing(event)) {
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
  const pendingCommit = usePendingCommit(commit);
  return (
    <Field label={label} hint="支持 #RRGGBB 或 #RRGGBBAA">
      <div className="inline-field">
        <ColorSwatch
          label={`${label}选择器`}
          onCommit={onChange}
          value={value}
        />
        <input
          aria-label={label}
          defaultValue={value}
          key={value}
          ref={textRef}
          {...pendingCommit}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !isComposing(event)) {
              event.preventDefault();
              commit();
            }
          }}
        />
      </div>
    </Field>
  );
}

/**
 * Uncontrolled text input that commits once on blur or Enter, reverts on Esc,
 * ignores IME composition keys and registers with the pending-commit registry
 * so Ctrl+S / undo / navigation never drop the last typed value.
 *
 * `onCommit` returns `false` to reject the draft; the field then shows the
 * last committed value again.
 */
export function DeferredInput({
  value,
  onCommit,
  onKeyDown,
  ...inputProps
}: Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "defaultValue" | "value" | "onBlur" | "onChange" | "onFocus"
> & {
  value: string;
  /** Return `false` to reject the draft. */
  onCommit(raw: string): unknown;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const revert = (): void => {
    if (inputRef.current !== null) inputRef.current.value = value;
  };
  const commit = (): void => {
    const raw = inputRef.current?.value ?? value;
    if (raw === value) return;
    if (onCommit(raw) === false) revert();
  };
  const pendingCommit = usePendingCommit(commit);
  return (
    <input
      {...inputProps}
      defaultValue={value}
      key={value}
      ref={inputRef}
      {...pendingCommit}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || isComposing(event)) return;
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          revert();
        }
      }}
    />
  );
}

/**
 * Multi-line counterpart of {@link DeferredInput}: commits once on blur or
 * Ctrl/⌘+Enter, reverts on Esc and is flushed by the pending-commit
 * registry.  `onDraftChange` lets a caller drive a live preview without
 * writing one history entry per keystroke.
 */
export function DeferredTextArea({
  value,
  onCommit,
  onDraftChange,
  onKeyDown,
  ...textareaProps
}: Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "defaultValue" | "value" | "onBlur" | "onChange" | "onFocus"
> & {
  value: string;
  /** Return `false` to reject the draft. */
  onCommit(raw: string): unknown;
  onDraftChange?(raw: string): void;
}): ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null);
  const revert = (): void => {
    if (ref.current !== null) ref.current.value = value;
    onDraftChange?.(value);
  };
  const commit = (): void => {
    const raw = ref.current?.value ?? value;
    if (raw === value) return;
    if (onCommit(raw) === false) revert();
  };
  const pendingCommit = usePendingCommit(commit);
  return (
    <textarea
      {...textareaProps}
      defaultValue={value}
      key={value}
      ref={ref}
      {...pendingCommit}
      onChange={(event) => onDraftChange?.(event.currentTarget.value)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || isComposing(event)) return;
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          revert();
        }
      }}
    />
  );
}

/**
 * Native colour swatch that commits once when the picker is closed (the
 * native `change` event) instead of on every intermediate `input` event, so
 * dragging through the palette produces a single undo entry.
 */
export function ColorSwatch({
  label,
  onCommit,
  value,
}: {
  label: string;
  onCommit(value: string): void;
  value: string;
}): ReactElement {
  const ref = useRef<HTMLInputElement>(null);
  const onCommitRef = useRef(onCommit);
  useLayoutEffect(() => {
    onCommitRef.current = onCommit;
  });
  const swatch = /^#[0-9A-Fa-f]{6}/.test(value) ? value.slice(0, 7) : "#000000";
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const handleChange = (): void => {
      const next = element.value.toUpperCase();
      if (next !== swatch.toUpperCase()) onCommitRef.current(next);
    };
    element.addEventListener("change", handleChange);
    return () => element.removeEventListener("change", handleChange);
  }, [swatch]);
  return (
    <input
      aria-label={label}
      defaultValue={swatch}
      key={swatch}
      ref={ref}
      type="color"
    />
  );
}
