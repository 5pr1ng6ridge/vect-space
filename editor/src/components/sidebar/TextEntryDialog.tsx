import { useEffect, useRef, useState, type ReactElement } from "react";
import { isComposing } from "../../ui/keyboard";

export function TextEntryDialog({
  title,
  initialValue,
  onSubmit,
  onCancel,
  validate,
  hint,
}: {
  title: string;
  initialValue: string;
  onSubmit(value: string): boolean;
  onCancel(): void;
  /** Live check; its message is shown inline and blocks submission. */
  validate?(value: string): string | null;
  hint?: string;
}): ReactElement {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const trimmed = value.trim();
  const problem =
    trimmed.length === 0 ? "输入不能为空。" : (validate?.(trimmed) ?? null);
  const submit = (): void => {
    if (problem !== null) {
      setError(problem);
      return;
    }
    const accepted = onSubmit(trimmed);
    if (!accepted) setError("输入未通过校验，请修正后重试。");
    else setError(null);
  };
  const message =
    validate !== undefined && trimmed.length > 0 ? problem : error;
  return (
    <div
      className="editor-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        className="editor-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !isComposing(event)) {
            event.preventDefault();
            onCancel();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h3>{title}</h3>
        <input
          aria-invalid={message !== null}
          aria-label={title}
          ref={inputRef}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setError(null);
          }}
          spellCheck={false}
          value={value}
        />
        {message !== null ? (
          <p className="inline-error" role="alert">
            {message}
          </p>
        ) : (
          hint !== undefined && <small className="muted">{hint}</small>
        )}
        <div className="editor-dialog-actions">
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button className="primary-button" type="submit">
            确定
          </button>
        </div>
      </form>
    </div>
  );
}
