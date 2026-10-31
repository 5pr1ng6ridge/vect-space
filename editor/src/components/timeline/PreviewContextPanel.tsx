import type { ReactElement } from "react";
import { stringifyScalarJson } from "../../scalars";
import type { BuildNodePreviewResult, ScalarValue } from "../../types";

/** Preview-context section of the inspector: errors, path choices, variable overrides. */
export function PreviewContextPanel({
  contextError,
  onChoice,
  onInvalidOverrides,
  onOverridesChange,
  overrides,
  pendingChoice,
}: {
  contextError: string | null;
  onChoice(choiceId: string): void;
  onInvalidOverrides(): void;
  onOverridesChange(overrides: Record<string, ScalarValue>): void;
  overrides: Record<string, ScalarValue>;
  pendingChoice: Extract<
    BuildNodePreviewResult,
    { status: "needs_choice" }
  > | null;
}): ReactElement {
  return (
    <>
      <h3>预览上下文</h3>
      <p>使用运行时默认变量和已保存路径构造，不会写入玩家进度。</p>
      {contextError !== null && (
        <div className="timeline-context-error">{contextError}</div>
      )}
      {pendingChoice !== null && (
        <div className="timeline-choice-wizard">
          <strong>请选择预览路径</strong>
          {pendingChoice.choices.map((choice) => (
            <button
              disabled={!choice.enabled}
              key={choice.id}
              onClick={() => onChoice(choice.id)}
              type="button"
            >
              {choice.label}
            </button>
          ))}
        </div>
      )}
      <label className="timeline-json-field">
        变量覆盖（JSON）
        <textarea
          defaultValue={stringifyScalarJson(overrides, 2)}
          key={stringifyScalarJson(overrides)}
          onBlur={(event) => {
            try {
              onOverridesChange(
                JSON.parse(event.currentTarget.value) as Record<
                  string,
                  ScalarValue
                >,
              );
            } catch {
              onInvalidOverrides();
            }
          }}
          spellCheck={false}
        />
      </label>
    </>
  );
}
