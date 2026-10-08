import { useRef, useState, type ReactElement } from "react";
import type {
  ContentManifest,
  LongTextLayout,
  LongTextStep,
} from "../../types";
import { MeasuredMarkup } from "@vectspace/text-react";
import { DeferredInput, DeferredTextArea, Field, NumberField } from "../Fields";
import { usePendingCommit } from "../../ui/pendingCommits";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { IconButton } from "../../ui/Button";
import { interpolatePreview } from "./model";

export function LongTextStepsEditor({
  allowManualBreaks,
  manifest,
  onSplit,
  steps,
  onChange,
}: {
  allowManualBreaks: boolean;
  manifest: ContentManifest;
  onSplit(stepIndex: number): void;
  steps: LongTextStep[];
  onChange(steps: LongTextStep[]): void;
}): ReactElement {
  const replace = (index: number, patch: Partial<LongTextStep>): void => {
    onChange(
      steps.map((step, current) =>
        current === index ? { ...step, ...patch } : step,
      ),
    );
  };
  return (
    <div className="long-text-steps-editor">
      <div className="field-label">推进段落</div>
      {steps.map((step, index) => (
        <article className="long-text-step-editor" key={index}>
          <header>
            <strong>第 {index + 1} 段</strong>
            <div className="compact-actions">
              <IconButton
                disabled={index === 0}
                onClick={() => {
                  const next = [...steps];
                  [next[index - 1], next[index]] = [
                    next[index],
                    next[index - 1],
                  ];
                  onChange(next);
                }}
                icon={ArrowUp}
                label="上移"
                size="sm"
                variant="ghost"
              />
              <IconButton
                disabled={index === steps.length - 1}
                onClick={() => {
                  const next = [...steps];
                  [next[index], next[index + 1]] = [
                    next[index + 1],
                    next[index],
                  ];
                  onChange(next);
                }}
                icon={ArrowDown}
                label="下移"
                size="sm"
                variant="ghost"
              />
              <IconButton
                disabled={steps.length === 1}
                onClick={() =>
                  onChange(steps.filter((_, current) => current !== index))
                }
                icon={Trash2}
                label="删除"
                size="sm"
              />
              <button
                disabled={index === 0}
                onClick={() => onSplit(index)}
                type="button"
              >
                从此处分成接续文稿
              </button>
            </div>
          </header>
          <label>
            <span>步骤 ID</span>
            <DeferredInput
              onCommit={(id) => {
                if (id.trim() === "") return false;
                replace(index, { id });
              }}
              value={step.id}
            />
          </label>
          <label className="long-text-break-toggle">
            <input
              checked={step.page_break_before}
              disabled={index === 0 || !allowManualBreaks}
              onChange={(event) =>
                replace(index, {
                  page_break_before: event.currentTarget.checked,
                })
              }
              type="checkbox"
            />
            <span>从新纸张开始</span>
          </label>
          <LongTextStepText
            manifest={manifest}
            onCommit={(text) => replace(index, { text })}
            value={step.text}
          />
        </article>
      ))}
      <button
        onClick={() => {
          const nextNumber = steps.length + 1;
          onChange([
            ...steps,
            {
              id: `step_${nextNumber}`,
              text: "新的长文本段落。",
              page_break_before: false,
            },
          ]);
        }}
        type="button"
      >
        添加推进段落
      </button>
    </div>
  );
}

export function DialogueTextEditor({
  onChange,
  onSplit,
  value,
}: {
  onChange(value: string): void;
  onSplit(offset: number, text?: string): void;
  value: string;
}): ReactElement {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [offset, setOffset] = useState(0);
  const [textLength, setTextLength] = useState(value.length);
  const commit = (): void => {
    const draft = inputRef.current?.value ?? value;
    if (draft !== value) onChange(draft);
  };
  const pendingCommit = usePendingCommit(commit);
  return (
    <Field label="对话文本" hint="支持 KaTeX、pause、speed 和 fx 标记">
      <textarea
        ref={inputRef}
        rows={8}
        defaultValue={value}
        key={value}
        onChange={(event) => setTextLength(event.currentTarget.value.length)}
        {...pendingCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            commit();
          }
        }}
        onSelect={(event) => setOffset(event.currentTarget.selectionStart)}
      />
      <button
        className="wide-button"
        disabled={offset <= 0 || offset >= textLength}
        onClick={() =>
          onSplit(
            inputRef.current?.selectionStart ?? 0,
            inputRef.current?.value ?? value,
          )
        }
        type="button"
      >
        在光标处分段并接续
      </button>
    </Field>
  );
}

export function RevealAnimationField({
  onChange,
  value,
}: {
  onChange(value: "line_sweep" | "typewriter" | "drop_fade" | null): void;
  value: "line_sweep" | "typewriter" | "drop_fade" | null;
}): ReactElement {
  return (
    <Field label="文字动画">
      <select
        onChange={(event) =>
          onChange(
            event.currentTarget.value === ""
              ? null
              : (event.currentTarget.value as
                  "line_sweep" | "typewriter" | "drop_fade"),
          )
        }
        value={value ?? ""}
      >
        <option value="">跟随玩家设置</option>
        <option value="line_sweep">逐行横向渐显</option>
        <option value="typewriter">逐字 / 公式渐显</option>
        <option value="drop_fade">下落渐显</option>
      </select>
    </Field>
  );
}

export function LongTextLayoutEditor({
  disabled = false,
  layout,
  onChange,
  previewText,
}: {
  disabled?: boolean;
  layout: LongTextLayout;
  onChange(layout: LongTextLayout): void;
  previewText: string;
}): ReactElement {
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<
    | {
        mode: "move" | "resize";
        x: number;
        y: number;
        layout: LongTextLayout;
      }
    | undefined
  >(undefined);
  // The drag previews locally and commits one history entry on release.
  const [dragLayout, setDragLayout] = useState<LongTextLayout | null>(null);
  const shown = dragLayout ?? layout;
  const change = (field: keyof LongTextLayout, value: number): void =>
    onChange({ ...layout, [field]: value });
  const snapped = (value: number): number => Math.round(value / 10) * 10;
  const begin = (
    event: React.PointerEvent<HTMLElement>,
    mode: "move" | "resize",
  ): void => {
    if (disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { mode, x: event.clientX, y: event.clientY, layout };
  };
  const move = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (drag === undefined || canvas === null) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = 1920 / rect.width;
    const scaleY = 1080 / rect.height;
    const dx = (event.clientX - drag.x) * scaleX;
    const dy = (event.clientY - drag.y) * scaleY;
    const snap = event.shiftKey ? (value: number) => value : snapped;
    if (drag.mode === "move") {
      setDragLayout({
        ...drag.layout,
        x: snap(
          Math.max(0, Math.min(1920 - drag.layout.width, drag.layout.x + dx)),
        ),
        y: snap(
          Math.max(0, Math.min(1080 - drag.layout.height, drag.layout.y + dy)),
        ),
      });
    } else {
      setDragLayout({
        ...drag.layout,
        width: snap(
          Math.max(160, Math.min(1920 - drag.layout.x, drag.layout.width + dx)),
        ),
        height: snap(
          Math.max(
            240,
            Math.min(1080 - drag.layout.y, drag.layout.height + dy),
          ),
        ),
      });
    }
  };
  return (
    <div className="long-text-layout-editor">
      <Field label="文本块位置与范围">
        <div
          className="long-text-layout-preview"
          onPointerMove={move}
          onPointerUp={() => {
            dragRef.current = undefined;
            if (dragLayout !== null) onChange(dragLayout);
            setDragLayout(null);
          }}
          onPointerCancel={() => {
            dragRef.current = undefined;
            setDragLayout(null);
          }}
          ref={canvasRef}
        >
          <button
            disabled={disabled}
            className="long-text-layout-rect"
            onPointerDown={(event) => begin(event, "move")}
            style={{
              left: `${(shown.x / 1920) * 100}%`,
              top: `${(shown.y / 1080) * 100}%`,
              width: `${(shown.width / 1920) * 100}%`,
              height: `${(shown.height / 1080) * 100}%`,
            }}
            type="button"
          >
            <div className="long-text-layout-preview-content">
              <MeasuredMarkup source={previewText} />
            </div>
            <i
              onPointerDown={(event) => {
                // The resize handle lives inside the draggable button. Stop
                // bubbling so the parent cannot replace the resize gesture
                // with a move gesture.
                event.stopPropagation();
                event.preventDefault();
                begin(event, "resize");
              }}
            />
          </button>
        </div>
      </Field>
      <div className="long-text-layout-fields">
        {(
          [
            ["x", "X"],
            ["y", "Y"],
            ["width", "宽"],
            ["height", "高"],
            ["padding_x", "水平边距"],
            ["padding_y", "垂直边距"],
            ["page_height", "页高"],
            ["page_gap", "页间距"],
          ] as const
        ).map(([field, label]) => (
          <NumberField
            disabled={disabled}
            key={field}
            label={label}
            min={0}
            onChange={(value) => change(field, value)}
            value={layout[field]}
          />
        ))}
      </div>
      <p className="field-note">
        拖动或右下角缩放；按住 Shift 可取消 10px 吸附。
      </p>
    </div>
  );
}

/** A long-text step body: live markup preview, one history entry per edit. */
function LongTextStepText({
  manifest,
  onCommit,
  value,
}: {
  manifest: ContentManifest;
  onCommit(text: string): void;
  value: string;
}): ReactElement {
  const [draft, setDraft] = useState({ source: value, text: value });
  // Re-seed the preview when the committed value changes (undo, redo).
  const previewText = draft.source === value ? draft.text : value;
  return (
    <>
      <DeferredTextArea
        onCommit={(text) => onCommit(text)}
        onDraftChange={(text) => setDraft({ source: value, text })}
        rows={6}
        value={value}
      />
      <MeasuredMarkup source={interpolatePreview(previewText, manifest)} />
    </>
  );
}
