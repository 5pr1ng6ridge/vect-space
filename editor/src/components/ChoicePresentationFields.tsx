import { type ReactElement } from "react";

import { Field, NumberField } from "./Fields";
import {
  defaultChoicePresentation,
  reseedChoicePresentationAnchor,
  resolveChoiceOptionSizes,
} from "../choicePresentation";
import {
  CHOICE_STAGE_HEIGHT,
  CHOICE_STAGE_WIDTH,
} from "@vectspace/presentation-core/choice-layout";
import type { ChoicePrompt } from "@vectspace/presentation-core/types";
import type { ButtonFile, ChoiceNode, ChoicePresentation } from "../types";

export interface ChoicePresentationFieldsProps {
  node: ChoiceNode;
  buttons: ButtonFile[];
  /** Latest Rust-filtered prompt, when the inspector preview has one. */
  previewPrompt?: ChoicePrompt | null;
  onChange(node: ChoiceNode): void;
}

/**
 * Authoring fields for a `choice` node's optional template presentation.
 *
 * Enabling presentation never moves the buttons: the seeded anchor is the
 * centre that reproduces the legacy CSS panel placement for the sizes this
 * node currently resolves to.  Every field mirrors a runtime default, and the
 * live size summary uses the same resolution priority as the runtime, so what
 * the author reads is what the resolved prompt will contain.
 */
export function ChoicePresentationFields({
  node,
  buttons,
  previewPrompt = null,
  onChange,
}: ChoicePresentationFieldsProps): ReactElement {
  const presentation = node.presentation ?? null;
  const updatePresentation = (patch: Partial<ChoicePresentation>): void => {
    if (presentation === null) return;
    onChange({ ...node, presentation: { ...presentation, ...patch } });
  };
  const sizes = resolveChoiceOptionSizes(node, buttons);

  return (
    <section className="choice-presentation-fields">
      <label className="field checkbox-field">
        <span className="field-label">模板表现</span>
        <span>
          <input
            checked={presentation !== null}
            onChange={(event) =>
              onChange({
                ...node,
                presentation: event.currentTarget.checked
                  ? defaultChoicePresentation(node, buttons, previewPrompt)
                  : null,
              })
            }
            type="checkbox"
          />
          启用 presentation（按钮模板 / 设计像素锚点）
        </span>
        <small>
          关闭时保持旧版 CSS 面板位置与内置按钮皮肤；未取得 Rust
          预览时，首次启用使用纵向旧版面板中心作为后备。
        </small>
      </label>

      {presentation !== null && (
        <>
          <Field label="默认按钮模板">
            <select
              onChange={(event) =>
                updatePresentation({
                  template: event.currentTarget.value || null,
                })
              }
              value={presentation.template ?? ""}
            >
              <option value="">内置 CSS 按钮</option>
              {buttons.map((file) => (
                <option key={file.definition.id} value={file.definition.id}>
                  {file.definition.id}（{file.definition.width}×
                  {file.definition.height}）
                </option>
              ))}
            </select>
          </Field>
          <NumberField
            label="锚点 X（0–1920）"
            max={CHOICE_STAGE_WIDTH}
            min={0}
            onChange={(anchor_x) => updatePresentation({ anchor_x })}
            value={presentation.anchor_x}
          />
          <NumberField
            label="锚点 Y（0–1080）"
            max={CHOICE_STAGE_HEIGHT}
            min={0}
            onChange={(anchor_y) => updatePresentation({ anchor_y })}
            value={presentation.anchor_y}
          />
          <Field label="排列方向">
            <select
              onChange={(event) =>
                updatePresentation({
                  direction: event.currentTarget
                    .value as ChoicePresentation["direction"],
                })
              }
              value={presentation.direction}
            >
              <option value="vertical">纵向</option>
              <option value="horizontal">横向</option>
            </select>
          </Field>
          <NumberField
            label="间距（设计像素）"
            min={0}
            onChange={(gap) => updatePresentation({ gap })}
            value={presentation.gap}
          />
          <label className="field checkbox-field">
            <span className="field-label">宽度覆盖</span>
            <span>
              <input
                checked={presentation.button_width != null}
                onChange={(event) =>
                  updatePresentation({
                    button_width: event.currentTarget.checked ? 320 : null,
                  })
                }
                type="checkbox"
              />
              覆盖模板宽度
            </span>
          </label>
          {presentation.button_width != null && (
            <NumberField
              label="按钮宽度"
              min={1}
              onChange={(button_width) => updatePresentation({ button_width })}
              value={presentation.button_width}
            />
          )}
          <label className="field checkbox-field">
            <span className="field-label">高度覆盖</span>
            <span>
              <input
                checked={presentation.button_height != null}
                onChange={(event) =>
                  updatePresentation({
                    button_height: event.currentTarget.checked ? 88 : null,
                  })
                }
                type="checkbox"
              />
              覆盖模板高度
            </span>
          </label>
          {presentation.button_height != null && (
            <NumberField
              label="按钮高度"
              min={1}
              onChange={(button_height) =>
                updatePresentation({ button_height })
              }
              value={presentation.button_height}
            />
          )}
          <div className="choice-presentation-summary">
            <small>
              解析尺寸：
              {sizes.length === 0
                ? "无选项"
                : sizes
                    .map((size, index) => {
                      const option = node.choices[index];
                      return `${option?.id ?? index + 1} ${size.width}×${size.height}`;
                    })
                    .join(" · ")}
            </small>
            <small>模板/素材来自当前项目；缺失引用会在诊断面板中报告。</small>
            <button
              onClick={() =>
                onChange({
                  ...node,
                  presentation: reseedChoicePresentationAnchor(
                    node,
                    buttons,
                    previewPrompt,
                  ),
                })
              }
              type="button"
            >
              重新对齐到旧版面板中心
            </button>
          </div>
        </>
      )}
    </section>
  );
}
