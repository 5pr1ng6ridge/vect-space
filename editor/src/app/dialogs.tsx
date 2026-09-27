/**
 * App-level modal dialogs.  They share the legacy `.editor-dialog` styling
 * until the dialog primitive replaces it.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";

import { isComposing } from "../ui/keyboard";
import { ID_RULE_HINT } from "./ids";

/**
 * Ask for a new stable id.  `validate` runs on every keystroke so the
 * concrete reason (format, collision, file path) is shown next to the field
 * instead of a generic failure after submit.
 */
export function IdEntryDialog({
  dialogLabel,
  title,
  fieldLabel,
  hint = ID_RULE_HINT,
  initialValue,
  submitLabel = "创建",
  validate,
  onSubmit,
  onCancel,
}: {
  dialogLabel: string;
  title: string;
  fieldLabel: string;
  hint?: string;
  initialValue: string;
  submitLabel?: string;
  validate(value: string): string | null;
  onSubmit(value: string): void;
  onCancel(): void;
}): ReactElement {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const trimmed = value.trim();
  const problem = validate(trimmed);
  return (
    <div
      aria-label={dialogLabel}
      className="editor-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <form
        aria-modal="true"
        className="editor-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !isComposing(event)) {
            event.preventDefault();
            onCancel();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (problem === null) onSubmit(trimmed);
        }}
        role="dialog"
      >
        <h3>{title}</h3>
        <input
          aria-describedby="id-entry-feedback"
          aria-invalid={problem !== null}
          aria-label={fieldLabel}
          onChange={(event) => setValue(event.currentTarget.value)}
          ref={inputRef}
          spellCheck={false}
          value={value}
        />
        <small
          className={problem === null ? "muted" : "inline-error"}
          id="id-entry-feedback"
          role={problem === null ? undefined : "alert"}
        >
          {problem ?? hint}
        </small>
        <div className="editor-dialog-actions">
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button
            className="primary-button"
            disabled={problem !== null}
            type="submit"
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Pick the node that inherits the entry and incoming edges of a deletion. */
export function DeleteNodesDialog({
  nodeIds,
  options,
  onConfirm,
  onCancel,
}: {
  nodeIds: string[];
  options: { id: string; label: string }[];
  onConfirm(fallback: string): void;
  onCancel(): void;
}): ReactElement {
  const [fallback, setFallback] = useState(options[0]?.id ?? "");
  const selectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => selectRef.current?.focus(), []);
  return (
    <div
      aria-label="选择删除后的继承节点"
      className="editor-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <form
        aria-modal="true"
        className="editor-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (fallback !== "") onConfirm(fallback);
        }}
        role="dialog"
      >
        <h3>删除并重连</h3>
        <p>
          {nodeIds.length === 1
            ? `将删除节点 ${nodeIds[0]}。`
            : `将删除 ${nodeIds.length} 个连续节点。`}
          请选择原本指向它的连线（以及场景入口）改为连接到哪个节点；跨场景跳转也会一并更新。
        </p>
        <label>
          改为连接到
          <select
            aria-label="删除后继节点"
            onChange={(event) => setFallback(event.currentTarget.value)}
            ref={selectRef}
            value={fallback}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="editor-dialog-actions">
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button
            className="danger-button"
            disabled={fallback === ""}
            type="submit"
          >
            删除并重连
          </button>
        </div>
      </form>
    </div>
  );
}
