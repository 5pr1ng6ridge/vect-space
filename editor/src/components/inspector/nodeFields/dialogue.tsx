import type { ReactNode } from "react";
import { AssetChooser } from "../../AssetChooser";
import { MeasuredMarkup } from "@vectspace/text-react";
import { Field, NumberField } from "../../Fields";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { IconButton } from "../../../ui/Button";
import { ChoicePresentationFields } from "../../ChoicePresentationFields";
import { ChoicePreview } from "../../ChoicePreview";
import type { FieldsContext, NodeOf } from "../fieldsContext";
import {
  AssetSelect,
  OptionalNumber,
  TargetSelect,
  TextField,
} from "../fieldControls";
import {
  DialogueTextEditor,
  LongTextLayoutEditor,
  LongTextStepsEditor,
  RevealAnimationField,
} from "../LongTextEditors";
import { DEFAULT_LONG_TEXT_LAYOUT, interpolatePreview } from "../model";
import { OptionalConditionEditor } from "../ConditionEditor";

export function sayFields(node: NodeOf<"say">, ctx: FieldsContext): ReactNode {
  const { update, manifest, splitDialogue, targets } = ctx;
  const speakerMode =
    node.speaker === null
      ? "narrator"
      : manifest.characters[node.speaker] !== undefined
        ? "character"
        : "temporary";
  const character =
    speakerMode === "character" && node.speaker !== null
      ? manifest.characters[node.speaker]
      : undefined;
  return (
    <>
      <Field label="对话页模式">
        <select
          value={node.mode ?? "start"}
          onChange={(event) => {
            const mode = event.currentTarget.value as "start" | "append";
            update({
              ...node,
              mode,
              page_id:
                mode === "append" ? (node.page_id ?? "dialogue") : node.page_id,
            });
          }}
        >
          <option value="start">开始新对话页</option>
          <option value="append">接续已有对话页</option>
        </select>
      </Field>
      <TextField
        label={node.mode === "append" ? "接续的页面 ID" : "页面 ID（可选）"}
        onChange={(page_id) => update({ ...node, page_id: page_id || null })}
        value={node.page_id ?? ""}
      />
      <Field label="说话人模式">
        <select
          value={speakerMode}
          onChange={(event) => {
            const mode = event.currentTarget.value;
            update({
              ...node,
              speaker:
                mode === "narrator"
                  ? null
                  : mode === "character"
                    ? (Object.keys(manifest.characters)[0] ?? "")
                    : "临时角色",
            });
          }}
        >
          <option value="narrator">旁白</option>
          <option
            disabled={Object.keys(manifest.characters).length === 0}
            value="character"
          >
            已定义角色
          </option>
          <option value="temporary">临时名字</option>
        </select>
      </Field>
      {speakerMode === "character" && (
        <Field label="角色">
          <select
            value={node.speaker ?? ""}
            onChange={(event) =>
              update({ ...node, speaker: event.currentTarget.value })
            }
          >
            {Object.entries(manifest.characters).map(([id, definition]) => (
              <option key={id} value={id}>
                {definition.display_name} · {id}
              </option>
            ))}
          </select>
        </Field>
      )}
      {speakerMode === "temporary" && (
        <TextField
          label="临时显示名"
          onChange={(speaker) => update({ ...node, speaker })}
          value={node.speaker ?? ""}
        />
      )}
      {character !== undefined && (
        <div className="character-style-preview">
          <span style={{ color: character.name_color ?? undefined }}>
            {character.display_name}
          </span>
          <span style={{ color: character.text_color ?? undefined }}>
            正文颜色预览
          </span>
        </div>
      )}
      <DialogueTextEditor
        key={node.text}
        onChange={(text) => update({ ...node, text })}
        onSplit={splitDialogue}
        value={node.text}
      />
      <Field label="实际渲染预览">
        <MeasuredMarkup source={interpolatePreview(node.text, manifest)} />
      </Field>
      <OptionalNumber
        label="文字速度 CPS"
        min={0.1}
        onChange={(speed_cps) => update({ ...node, speed_cps })}
        value={node.speed_cps}
      />
      <RevealAnimationField
        onChange={(reveal_animation) => update({ ...node, reveal_animation })}
        value={node.reveal_animation ?? null}
      />
      <TargetSelect
        label="下一节点"
        onChange={(next) => update({ ...node, next })}
        targets={targets}
        value={node.next}
      />
    </>
  );
}

export function longTextFields(
  node: NodeOf<"long_text">,
  ctx: FieldsContext,
): ReactNode {
  const {
    update,
    scene,
    manifest,
    assets,
    animations,
    splitLongText,
    openLongTextWorkspace,
    targets,
  } = ctx;
  const isContinuation = node.mode === "continue";
  const longTextDocuments = Array.from(
    new Set(
      Object.entries(scene.nodes)
        .filter(
          ([candidateId, candidate]) =>
            candidate.type === "long_text" &&
            (candidate.mode ?? "start") === "start" &&
            (candidate.document ?? candidateId) !== "",
        )
        .map(([candidateId, candidate]) =>
          candidate.type === "long_text"
            ? (candidate.document ?? candidateId)
            : candidateId,
        ),
    ),
  );
  if (
    isContinuation &&
    node.document !== undefined &&
    node.document !== null &&
    !longTextDocuments.includes(node.document)
  ) {
    longTextDocuments.push(node.document);
  }
  const inheritedStart = isContinuation
    ? Object.entries(scene.nodes).find(
        ([candidateId, candidate]) =>
          candidate.type === "long_text" &&
          (candidate.mode ?? "start") === "start" &&
          (candidate.document ?? candidateId) === node.document,
      )?.[1]
    : undefined;
  const presentationNode =
    inheritedStart?.type === "long_text" ? inheritedStart : node;
  const presentationPagination = presentationNode.pagination ?? "auto";
  return (
    <>
      {isContinuation ? (
        <Field label="接续文稿">
          <select
            onChange={(event) =>
              update({
                ...node,
                document: event.currentTarget.value || null,
              })
            }
            value={node.document ?? ""}
          >
            <option value="">— 请选择开始节点文稿 —</option>
            {longTextDocuments.map((document) => (
              <option key={document} value={document}>
                {document}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <TextField
          label="文稿 ID（可选）"
          onChange={(document) =>
            update({ ...node, document: document.trim() || null })
          }
          value={node.document ?? ""}
        />
      )}
      <Field label="文稿模式">
        <select
          onChange={(event) =>
            (() => {
              const mode = event.currentTarget.value as "start" | "continue";
              if (mode === "start") {
                update({
                  ...node,
                  mode,
                  paper: node.paper ?? null,
                  pagination: node.pagination ?? "auto",
                  font_size: node.font_size ?? 32,
                  text_color: node.text_color ?? "#212533",
                  layout: node.layout ?? DEFAULT_LONG_TEXT_LAYOUT,
                });
                return;
              }
              // A continuation inherits all layout/paper fields from its
              // start node. Explicitly remove them so the YAML cannot
              // accidentally shadow the document's stable presentation.
              const inherited = { ...node };
              delete inherited.font_size;
              delete inherited.layout;
              delete inherited.pagination;
              delete inherited.paper;
              delete inherited.text_color;
              update({ ...inherited, mode });
            })()
          }
          value={node.mode ?? "start"}
        >
          <option value="start">开始新文稿</option>
          <option value="continue">接续已有文稿</option>
        </select>
      </Field>
      <Field label="离开行为">
        <select
          onChange={(event) =>
            update({
              ...node,
              on_exit: event.currentTarget.value as
                "close" | "hide" | "keep_visible",
            })
          }
          value={node.on_exit ?? "close"}
        >
          <option value="close">关闭文稿</option>
          <option value="hide">隐藏但保留</option>
          <option value="keep_visible">继续显示</option>
        </select>
      </Field>
      <AssetSelect
        allowNone
        animations={animations}
        assets={assets}
        disabled={isContinuation}
        kind="gui"
        label="纸张素材"
        manifest={manifest}
        onChange={(paper) => update({ ...node, paper })}
        value={presentationNode.paper ?? null}
      />
      <Field label="分页方式">
        <select
          disabled={isContinuation}
          onChange={(event) => {
            const pagination = event.currentTarget.value as
              "continuous" | "auto" | "manual";
            update({
              ...node,
              pagination,
              ...(pagination === "continuous"
                ? {
                    steps: node.steps.map((step) =>
                      step.page_break_before
                        ? { ...step, page_break_before: false }
                        : step,
                    ),
                  }
                : {}),
            });
          }}
          value={presentationPagination}
        >
          <option value="continuous">连续长卷</option>
          <option value="auto">自动分页</option>
          <option value="manual">仅手动分页</option>
        </select>
      </Field>
      <NumberField
        disabled={isContinuation}
        label="字号（设计像素）"
        max={72}
        min={16}
        onChange={(font_size) => update({ ...node, font_size })}
        value={presentationNode.font_size ?? 32}
      />
      <TextField
        disabled={isContinuation}
        label="正文颜色"
        onChange={(text_color) => update({ ...node, text_color })}
        value={presentationNode.text_color ?? "#212533"}
      />
      <button
        className="primary-button long-text-open-workspace"
        onClick={openLongTextWorkspace}
        type="button"
      >
        全屏背景预览编辑
      </button>
      <LongTextLayoutEditor
        disabled={isContinuation}
        layout={presentationNode.layout ?? DEFAULT_LONG_TEXT_LAYOUT}
        onChange={(layout) => update({ ...node, layout })}
        previewText={interpolatePreview(
          node.steps[0]?.text ?? "长文本预览",
          manifest,
        )}
      />
      <p className="field-note">
        {isContinuation
          ? "接续节点继承开始节点的纸张、分页、字号、颜色和布局；请在开始节点编辑这些属性。"
          : "每一段在游戏中对应一次推进。自动分页会在空间不足时续页；仅手动分页只响应段落的强制分页标记。"}
      </p>
      <LongTextStepsEditor
        allowManualBreaks={presentationPagination !== "continuous"}
        manifest={manifest}
        onChange={(steps) => update({ ...node, steps })}
        onSplit={splitLongText}
        steps={node.steps}
      />
      <OptionalNumber
        label="文字速度 CPS"
        min={0.1}
        onChange={(speed_cps) => update({ ...node, speed_cps })}
        value={node.speed_cps}
      />
      <RevealAnimationField
        onChange={(reveal_animation) => update({ ...node, reveal_animation })}
        value={node.reveal_animation ?? null}
      />
      <TargetSelect
        label="下一节点"
        onChange={(next) => update({ ...node, next })}
        targets={targets}
        value={node.next}
      />
    </>
  );
}

export function longTextControlFields(
  node: NodeOf<"long_text_control">,
  ctx: FieldsContext,
): ReactNode {
  const { update, targets } = ctx;
  return (
    <>
      <TextField
        label="文稿 ID"
        onChange={(document) => update({ ...node, document })}
        value={node.document}
      />
      <Field label="操作">
        <select
          onChange={(event) =>
            update({
              ...node,
              action: event.currentTarget.value as "show" | "hide" | "close",
            })
          }
          value={node.action}
        >
          <option value="show">显示</option>
          <option value="hide">隐藏</option>
          <option value="close">关闭并清除</option>
        </select>
      </Field>
      <TargetSelect
        label="下一节点"
        onChange={(next) => update({ ...node, next })}
        targets={targets}
        value={node.next}
      />
    </>
  );
}

export function choiceFields(
  node: NodeOf<"choice">,
  ctx: FieldsContext,
): ReactNode {
  const {
    nodeId,
    update,
    scene,
    manifest,
    buttons,
    assets,
    preview,
    choicePreviewPrompt,
    targets,
  } = ctx;
  return (
    <>
      <div className="choice-editor-list">
        {node.choices.map((choice, index) => (
          <article className="choice-editor" key={`${choice.id}-${index}`}>
            <header>
              <strong>选项 {index + 1}</strong>
              <div>
                <IconButton
                  disabled={index === 0}
                  onClick={() => {
                    const choices = [...node.choices];
                    [choices[index - 1], choices[index]] = [
                      choices[index],
                      choices[index - 1],
                    ];
                    update({ ...node, choices });
                  }}
                  icon={ArrowUp}
                  label="上移"
                  size="sm"
                  variant="ghost"
                />
                <IconButton
                  disabled={index === node.choices.length - 1}
                  onClick={() => {
                    const choices = [...node.choices];
                    [choices[index], choices[index + 1]] = [
                      choices[index + 1],
                      choices[index],
                    ];
                    update({ ...node, choices });
                  }}
                  icon={ArrowDown}
                  label="下移"
                  size="sm"
                  variant="ghost"
                />
                <IconButton
                  onClick={() =>
                    update({
                      ...node,
                      choices: node.choices.filter(
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
            </header>
            <TextField
              label="ID"
              onChange={(id) =>
                update({
                  ...node,
                  choices: node.choices.map((candidate, candidateIndex) =>
                    candidateIndex === index ? { ...candidate, id } : candidate,
                  ),
                })
              }
              value={choice.id}
            />
            <TextField
              label="文本"
              onChange={(label) =>
                update({
                  ...node,
                  choices: node.choices.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, label }
                      : candidate,
                  ),
                })
              }
              value={choice.label}
            />
            <TargetSelect
              label="目标"
              onChange={(next) =>
                update({
                  ...node,
                  choices: node.choices.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, next }
                      : candidate,
                  ),
                })
              }
              targets={targets}
              value={choice.next}
            />
            <Field label="按钮模板">
              <select
                onChange={(event) =>
                  update({
                    ...node,
                    choices: node.choices.map((candidate, candidateIndex) =>
                      candidateIndex === index
                        ? {
                            ...candidate,
                            template: event.currentTarget.value || null,
                          }
                        : candidate,
                    ),
                  })
                }
                value={choice.template ?? ""}
              >
                <option value="">继承节点模板 / 默认选项按钮</option>
                {choice.template != null &&
                  choice.template !== "" &&
                  !buttons.some(
                    (file) => file.definition.id === choice.template,
                  ) && (
                    <option value={choice.template}>
                      缺失：{choice.template}
                    </option>
                  )}
                {buttons.map((file) => (
                  <option key={file.definition.id} value={file.definition.id}>
                    {file.definition.id}（{file.definition.width}×
                    {file.definition.height}）
                  </option>
                ))}
              </select>
            </Field>
            <Field label="图标（gui）">
              <AssetChooser
                allowEmpty
                assets={Object.entries(manifest.assets).map(
                  ([id, definition]) => ({
                    id,
                    kind: definition.kind,
                    path: definition.path,
                    animation: definition.animation,
                  }),
                )}
                emptyLabel="无图标"
                kind="gui"
                label="图标（gui）"
                onChange={(icon) =>
                  update({
                    ...node,
                    choices: node.choices.map((candidate, candidateIndex) =>
                      candidateIndex === index
                        ? { ...candidate, icon }
                        : candidate,
                    ),
                  })
                }
                value={choice.icon ?? null}
              />
            </Field>
            <OptionalConditionEditor
              label="显示条件"
              manifest={manifest}
              onChange={(visible_if) =>
                update({
                  ...node,
                  choices: node.choices.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, visible_if }
                      : candidate,
                  ),
                })
              }
              value={choice.visible_if}
            />
            <OptionalConditionEditor
              label="可用条件"
              manifest={manifest}
              onChange={(enabled_if) =>
                update({
                  ...node,
                  choices: node.choices.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, enabled_if }
                      : candidate,
                  ),
                })
              }
              value={choice.enabled_if}
            />
            <MeasuredMarkup
              source={interpolatePreview(choice.label, manifest)}
            />
          </article>
        ))}
      </div>
      <button
        className="wide-button"
        onClick={() => {
          let index = node.choices.length + 1;
          while (node.choices.some((choice) => choice.id === `option_${index}`))
            index += 1;
          update({
            ...node,
            choices: [
              ...node.choices,
              {
                id: `option_${index}`,
                label: `选项 ${index}`,
                next: targets[0] ?? "",
              },
            ],
          });
        }}
        type="button"
      >
        ＋ 添加选项
      </button>
      <ChoicePresentationFields
        buttons={buttons}
        node={node}
        onChange={update}
        previewPrompt={choicePreviewPrompt}
      />
      {preview !== undefined && (
        <ChoicePreview
          animations={preview.animationMap}
          assets={assets}
          choices={preview.choices}
          importTokens={preview.importTokens}
          nodeId={nodeId}
          project={preview.project}
          sceneId={scene.id}
          variableOverrides={preview.variableOverrides}
          onResolvedPrompt={preview.onResolvedPrompt}
        />
      )}
    </>
  );
}
