import {
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  NODE_TYPES,
  canConvertToTimeline,
  defaultCondition,
  defaultNode,
  nodeLabel,
  resolveSpriteAsset,
} from "../story";
import { interpolateTemplate } from "../textTemplate";
import { isCanonicalIntegerText, scalarType } from "../scalars";
import { assetUrl } from "../api";
import { defaultCurtainFill } from "../presentationDefaults";
import { animationSourceId } from "../imageAnimation";
import { FrameSequencePreview } from "./FrameSequencePreview";
import type {
  AnimationFile,
  ActionFile,
  AssetKind,
  ConditionExpression,
  ContentManifest,
  CurtainAction,
  EditorAsset,
  MutationValue,
  LongTextLayout,
  LongTextStep,
  ScalarValue,
  SceneDefinition,
  SceneNode,
  ValueOperand,
  VariableOperation,
  VariableType,
  UiMotionFile,
  ButtonFile,
  ButtonClickAction,
  ButtonPostAction,
  ButtonSetAction,
  EditorProject,
  PreviewChoiceDecision,
  SpriteActionEnd,
} from "../types";
import { MeasuredMarkup } from "@vectspace/text-react";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import type { ChoicePrompt } from "@vectspace/presentation-core/types";
import { CuePreview } from "./CuePreview";
import type { CuePreviewEnvironment } from "./CuePreview";
import { Field, NumberField } from "./Fields";
import { ChoicePresentationFields } from "./ChoicePresentationFields";
import { ChoicePreview } from "./ChoicePreview";
import { choiceIconOptions } from "../choicePresentation";
import {
  CurtainFillFields,
  CurtainTransitionFields,
  ScreenEffectFields,
  TransitionSpecFields,
} from "./SpecFields";
import {
  buildBackgroundPreviewRequest,
  buildCurtainPreviewRequest,
  buildScreenEffectPreviewRequest,
  storyVisualStateAtNode,
} from "../presentationPreview";

/** Preview inputs threaded to the Rust-backed Choice inspector preview. */
interface ChoicePreviewContext {
  project: EditorProject;
  animationMap: AnimationMap;
  importTokens: string[];
  variableOverrides: Record<string, ScalarValue>;
  choices: PreviewChoiceDecision[];
  onResolvedPrompt(prompt: ChoicePrompt | null): void;
}

const DEFAULT_LONG_TEXT_LAYOUT: LongTextLayout = {
  x: 340,
  y: 0,
  width: 1240,
  height: 1080,
  padding_x: 118,
  padding_y: 112,
  page_height: 1340,
  page_gap: 92,
};

interface NodeInspectorProps {
  scene: SceneDefinition;
  manifest: ContentManifest;
  nodeId: string | null;
  onChange(nodeId: string, node: SceneNode): void;
  onRename(previousId: string, nextId: string): void;
  onDelete(nodeId: string): void;
  onDuplicate(nodeId: string): void;
  onConvertToTimeline(nodeId: string): void;
  /** Inline a reusable sprite action into an ordinary Timeline node. */
  onConvertActionToTimeline?(nodeId: string): void | Promise<void>;
  onSplitDialogue(nodeId: string, offset: number, text?: string): void;
  onSplitLongText(nodeId: string, stepIndex: number): void;
  onSetEntry(nodeId: string): void;
  onOpenLongTextWorkspace(nodeId: string): void;
  uiMotions: UiMotionFile[];
  buttons: ButtonFile[];
  animations?: AnimationFile[];
  actions?: ActionFile[];
  assets?: EditorAsset[];
  /** Scene definitions used to author cross-scene button jumps. */
  scenes?: SceneDefinition[];
  /** Preview diagnostics (Pixi init, decode and cue failures). */
  onError?: (message: string) => void;
  /** Test seam: in-memory render kit for the inspector previews. */
  previewEnvironment?: CuePreviewEnvironment;
  /** Whole project for the Rust-backed Choice inspector preview. */
  previewProject?: EditorProject;
  previewAnimationMap?: AnimationMap;
  previewImportTokens?: string[];
  previewVariableOverrides?: Record<string, ScalarValue>;
  previewChoices?: PreviewChoiceDecision[];
}

export function NodeInspector({
  scene,
  manifest,
  nodeId,
  onChange,
  onRename,
  onDelete,
  onDuplicate,
  onConvertToTimeline,
  onConvertActionToTimeline,
  onSplitDialogue,
  onSplitLongText,
  onSetEntry,
  onOpenLongTextWorkspace,
  uiMotions,
  buttons,
  animations = [],
  actions = [],
  assets = [],
  scenes = [],
  onError,
  previewEnvironment,
  previewProject,
  previewAnimationMap = {},
  previewImportTokens,
  previewVariableOverrides,
  previewChoices,
}: NodeInspectorProps): ReactElement {
  const node = nodeId === null ? undefined : scene.nodes[nodeId];
  const [idDraft, setIdDraft] = useState(nodeId ?? "");
  const [choicePreviewResolution, setChoicePreviewResolution] = useState<{
    project: EditorProject;
    sceneId: string;
    nodeId: string;
    prompt: ChoicePrompt | null;
  } | null>(null);
  const choicePreviewPrompt =
    choicePreviewResolution !== null &&
    choicePreviewResolution.project === previewProject &&
    choicePreviewResolution.sceneId === scene.id &&
    choicePreviewResolution.nodeId === nodeId
      ? choicePreviewResolution.prompt
      : null;

  if (nodeId === null || node === undefined) {
    return (
      <aside className="inspector empty-inspector">
        <div className="empty-state compact">
          <span className="empty-glyph">⌁</span>
          <p>选择一个节点以编辑属性</p>
        </div>
      </aside>
    );
  }

  const update = (next: SceneNode): void => onChange(nodeId, next);
  const fallback =
    Object.keys(scene.nodes).find((id) => id !== nodeId) ?? nodeId;

  return (
    <aside className="inspector">
      <header className="inspector-header">
        <div>
          <span className="eyebrow">NODE INSPECTOR</span>
          <h2>{nodeLabel(node.type)}</h2>
        </div>
        {scene.entry === nodeId && <span className="entry-chip">ENTRY</span>}
      </header>

      <section className="inspector-section">
        <Field label="节点 ID" hint="存档会引用此 ID">
          <div className="inline-field">
            <input
              value={idDraft}
              onChange={(event) => setIdDraft(event.currentTarget.value)}
            />
            <button
              disabled={idDraft === nodeId || idDraft.trim() === ""}
              onClick={() => {
                if (
                  window.confirm(
                    "重命名节点会破坏使用旧 ID 的既有存档。确定要更新全部剧情引用吗？",
                  )
                ) {
                  onRename(nodeId, idDraft.trim());
                }
              }}
              type="button"
            >
              重命名
            </button>
          </div>
        </Field>
        <Field label="节点类型">
          <select
            value={node.type}
            onChange={(event) => {
              const nextType = event.currentTarget.value as SceneNode["type"];
              if (window.confirm("切换节点类型会重置该节点的专有字段。")) {
                update(defaultNode(nextType, fallback));
              }
            }}
          >
            {NODE_TYPES.map((candidate) => (
              <option key={candidate.type} value={candidate.type}>
                {candidate.group} · {candidate.label}
              </option>
            ))}
          </select>
        </Field>
      </section>

      <section className="inspector-section node-fields">
        {renderFields(
          node,
          nodeId,
          update,
          scene,
          manifest,
          uiMotions,
          buttons,
          assets,
          animations,
          actions,
          scenes,
          onError,
          previewEnvironment,
          (offset, text) => onSplitDialogue(nodeId, offset, text),
          (stepIndex) => onSplitLongText(nodeId, stepIndex),
          () => onOpenLongTextWorkspace(nodeId),
          previewProject === undefined
            ? undefined
            : {
                project: previewProject,
                animationMap: previewAnimationMap,
                importTokens: previewImportTokens ?? [],
                variableOverrides: previewVariableOverrides ?? {},
                choices: previewChoices ?? [],
                onResolvedPrompt: (prompt) =>
                  setChoicePreviewResolution({
                    project: previewProject,
                    sceneId: scene.id,
                    nodeId,
                    prompt,
                  }),
              },
          choicePreviewPrompt,
        )}
      </section>

      <section className="inspector-section inspector-actions">
        {node.type === "action" &&
          onConvertActionToTimeline !== undefined &&
          actions.some((file) => file.definition.id === node.action) && (
            <button
              className="convert-timeline-button"
              onClick={() => {
                void onConvertActionToTimeline(nodeId);
              }}
              type="button"
            >
              解除引用为关键帧时间线
            </button>
          )}
        {canConvertToTimeline(node) && (
          <>
            <button
              className="convert-timeline-button"
              onClick={() => onConvertToTimeline(nodeId)}
              type="button"
            >
              转为关键帧时间线
            </button>
            <p className="field-note">
              保留下一节点、时长与等待策略；0 ms
              使用“继承入口值”，无需先选择预览路径。
            </p>
          </>
        )}
        <button
          disabled={scene.entry === nodeId}
          onClick={() => onSetEntry(nodeId)}
          type="button"
        >
          设为场景入口
        </button>
        <button onClick={() => onDuplicate(nodeId)} type="button">
          复制节点
        </button>
        <button
          className="danger-button"
          onClick={() => onDelete(nodeId)}
          type="button"
        >
          删除节点
        </button>
      </section>
    </aside>
  );
}

function renderFields(
  node: SceneNode,
  nodeId: string,
  update: (node: SceneNode) => void,
  scene: SceneDefinition,
  manifest: ContentManifest,
  uiMotions: UiMotionFile[],
  buttons: ButtonFile[],
  assets: readonly EditorAsset[],
  animations: readonly AnimationFile[],
  actions: readonly ActionFile[],
  scenes: SceneDefinition[],
  onError: ((message: string) => void) | undefined,
  previewEnvironment: CuePreviewEnvironment | undefined,
  splitDialogue: (offset: number, text?: string) => void,
  splitLongText: (stepIndex: number) => void,
  openLongTextWorkspace: () => void,
  preview: ChoicePreviewContext | undefined,
  choicePreviewPrompt: ChoicePrompt | null,
): ReactNode {
  const targets = Object.keys(scene.nodes);
  switch (node.type) {
    case "background":
      return (
        <>
          <AssetSelect
            allowNone
            animations={animations}
            assets={assets}
            kind="background"
            label="背景素材"
            manifest={manifest}
            onChange={(background) => update({ ...node, background })}
            value={node.background}
          />
          <TransitionSpecFields
            onChange={(transition) => update({ ...node, transition })}
            value={node.transition}
          />
          <AnimationFields node={node} onChange={update} />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
          <BackgroundPreview
            assets={assets}
            environment={previewEnvironment}
            node={node}
            nodeId={nodeId}
            onError={onError}
            scene={scene}
          />
        </>
      );
    case "curtain":
      return (
        <>
          <Field label="幕布动作">
            <select
              value={node.action}
              onChange={(event) => {
                const action = event.currentTarget.value as CurtainAction;
                update({
                  ...node,
                  action,
                  fill:
                    action === "cover"
                      ? (node.fill ?? defaultCurtainFill())
                      : null,
                });
              }}
            >
              <option value="cover">落下幕布</option>
              <option value="reveal">收起幕布</option>
            </select>
          </Field>
          {node.action === "cover" && (
            <CurtainFillFields
              manifest={manifest}
              onChange={(fill) => update({ ...node, fill })}
              value={node.fill ?? null}
            />
          )}
          <CurtainTransitionFields
            onChange={(transition) => update({ ...node, transition })}
            value={node.transition}
          />
          <AnimationFields node={node} onChange={update} />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
          <CurtainPreview
            assets={assets}
            environment={previewEnvironment}
            node={node}
            nodeId={nodeId}
            onError={onError}
            scene={scene}
          />
        </>
      );
    case "sprite":
      return (
        <>
          <TextField
            label="立绘实例 ID"
            onChange={(sprite_id) => update({ ...node, sprite_id })}
            value={node.sprite_id}
          />
          <Field label="动作">
            <select
              value={node.action}
              onChange={(event) =>
                update({
                  ...node,
                  action: event.currentTarget.value as typeof node.action,
                })
              }
            >
              <option value="show">显示</option>
              <option value="move">移动 / 修改</option>
              <option value="hide">隐藏</option>
            </select>
          </Field>
          <Field label="角色绑定（可选）">
            <select
              value={node.character ?? ""}
              onChange={(event) => {
                const character = event.currentTarget.value || null;
                const definition =
                  character === null
                    ? undefined
                    : manifest.characters[character];
                const expression =
                  character === null
                    ? null
                    : (node.expression ??
                      definition?.default_expression ??
                      null);
                update({ ...node, character, expression });
              }}
            >
              <option value="">不绑定角色（直接素材）</option>
              {Object.entries(manifest.characters).map(([id, definition]) => (
                <option key={id} value={id}>
                  {definition.display_name} · {id}
                </option>
              ))}
            </select>
          </Field>
          {node.character != null && (
            <Field label="表情">
              <select
                value={node.expression ?? ""}
                onChange={(event) =>
                  update({
                    ...node,
                    expression: event.currentTarget.value || null,
                  })
                }
              >
                <option value="">使用默认表情</option>
                {Object.keys(
                  manifest.characters[node.character]?.expressions ?? {},
                ).map((expressionId) => (
                  <option key={expressionId} value={expressionId}>
                    {expressionId}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {node.character != null &&
          node.asset == null &&
          node.action !== "hide" ? (
            <Field
              hint="已绑定角色表情，运行时会自动使用角色表中登记的素材。"
              label="立绘素材"
            >
              <output>
                {resolveSpriteAsset(node, manifest) ??
                  "未解析：请选择表情或设置默认表情"}
              </output>
            </Field>
          ) : (
            <AssetSelect
              allowNone={node.action !== "show" || node.character != null}
              animations={animations}
              assets={assets}
              kind="sprite"
              label={node.character == null ? "立绘素材" : "素材覆盖（可选）"}
              manifest={manifest}
              onChange={(asset) => update({ ...node, asset })}
              value={node.asset}
            />
          )}
          <div className="field-grid">
            <OptionalNumber
              label="X"
              onChange={(x) => update({ ...node, x })}
              value={node.x}
            />
            <OptionalNumber
              label="Y"
              onChange={(y) => update({ ...node, y })}
              value={node.y}
            />
            <OptionalNumber
              label="缩放"
              min={0.001}
              onChange={(scale) => update({ ...node, scale })}
              step={0.05}
              value={node.scale}
            />
            <OptionalNumber
              label="透明度"
              max={1}
              min={0}
              onChange={(opacity) => update({ ...node, opacity })}
              step={0.05}
              value={node.opacity}
            />
            <OptionalNumber
              label="层级 Z"
              onChange={(z) => update({ ...node, z })}
              step={1}
              value={node.z}
            />
            {node.action === "move" ? (
              <Field label="水平翻转">
                <select
                  onChange={(event) =>
                    update({
                      ...node,
                      flip_x:
                        event.currentTarget.value === "keep"
                          ? undefined
                          : event.currentTarget.value === "true",
                    })
                  }
                  value={node.flip_x == null ? "keep" : String(node.flip_x)}
                >
                  <option value="keep">保持当前</option>
                  <option value="false">不翻转</option>
                  <option value="true">翻转</option>
                </select>
              </Field>
            ) : (
              <label className="checkbox-field">
                <span>水平翻转</span>
                <input
                  checked={node.flip_x ?? false}
                  onChange={(event) =>
                    update({ ...node, flip_x: event.currentTarget.checked })
                  }
                  type="checkbox"
                />
              </label>
            )}
            <OptionalNumber
              label="换表情淡化 ms"
              min={0}
              onChange={(crossfade_ms) => update({ ...node, crossfade_ms })}
              value={node.crossfade_ms ?? null}
            />
          </div>
          <AnimationFields node={node} onChange={update} />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "clear":
      return (
        <>
          <p className="field-note">
            淡出背景、立绘、镜头与持续视觉效果；BGM、环境声和对话框 UI 会保留。
          </p>
          <AnimationFields node={node} onChange={update} />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "say": {
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
                    mode === "append"
                      ? (node.page_id ?? "dialogue")
                      : node.page_id,
                });
              }}
            >
              <option value="start">开始新对话页</option>
              <option value="append">接续已有对话页</option>
            </select>
          </Field>
          <TextField
            label={node.mode === "append" ? "接续的页面 ID" : "页面 ID（可选）"}
            onChange={(page_id) =>
              update({ ...node, page_id: page_id || null })
            }
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
            onChange={(reveal_animation) =>
              update({ ...node, reveal_animation })
            }
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
    case "long_text": {
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
                  const mode = event.currentTarget.value as
                    "start" | "continue";
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
            onChange={(reveal_animation) =>
              update({ ...node, reveal_animation })
            }
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
    case "long_text_control":
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
                  action: event.currentTarget.value as
                    "show" | "hide" | "close",
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
    case "choice":
      return (
        <>
          <div className="choice-editor-list">
            {node.choices.map((choice, index) => (
              <article className="choice-editor" key={`${choice.id}-${index}`}>
                <header>
                  <strong>选项 {index + 1}</strong>
                  <div>
                    <button
                      disabled={index === 0}
                      onClick={() => {
                        const choices = [...node.choices];
                        [choices[index - 1], choices[index]] = [
                          choices[index],
                          choices[index - 1],
                        ];
                        update({ ...node, choices });
                      }}
                      type="button"
                    >
                      ↑
                    </button>
                    <button
                      disabled={index === node.choices.length - 1}
                      onClick={() => {
                        const choices = [...node.choices];
                        [choices[index], choices[index + 1]] = [
                          choices[index + 1],
                          choices[index],
                        ];
                        update({ ...node, choices });
                      }}
                      type="button"
                    >
                      ↓
                    </button>
                    <button
                      className="danger-text"
                      onClick={() =>
                        update({
                          ...node,
                          choices: node.choices.filter(
                            (_candidate, candidateIndex) =>
                              candidateIndex !== index,
                          ),
                        })
                      }
                      type="button"
                    >
                      删除
                    </button>
                  </div>
                </header>
                <TextField
                  label="ID"
                  onChange={(id) =>
                    update({
                      ...node,
                      choices: node.choices.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, id }
                          : candidate,
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
                        choices: node.choices.map(
                          (candidate, candidateIndex) =>
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
                    <option value="">继承节点模板 / 内置 CSS 按钮</option>
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
                      <option
                        key={file.definition.id}
                        value={file.definition.id}
                      >
                        {file.definition.id}（{file.definition.width}×
                        {file.definition.height}）
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="图标（gui）">
                  <select
                    onChange={(event) =>
                      update({
                        ...node,
                        choices: node.choices.map(
                          (candidate, candidateIndex) =>
                            candidateIndex === index
                              ? {
                                  ...candidate,
                                  icon: event.currentTarget.value || null,
                                }
                              : candidate,
                        ),
                      })
                    }
                    value={choice.icon ?? ""}
                  >
                    <option value="">无图标</option>
                    {choice.icon != null &&
                      choice.icon !== "" &&
                      manifest.assets[choice.icon] === undefined && (
                        <option value={choice.icon}>缺失：{choice.icon}</option>
                      )}
                    {choiceIconOptions(manifest).map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.id}
                      </option>
                    ))}
                  </select>
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
              while (
                node.choices.some((choice) => choice.id === `option_${index}`)
              )
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
    case "set":
      return (
        <>
          <Field label="目标变量">
            <select
              value={node.variable}
              onChange={(event) => {
                const variable = event.currentTarget.value;
                const targetType =
                  manifest.variables[variable]?.type ?? "boolean";
                update({
                  ...node,
                  variable,
                  op: "assign",
                  value: defaultScalar(targetType),
                });
              }}
            >
              {!manifest.variables[node.variable] && (
                <option value={node.variable}>
                  {node.variable || "— 未声明 —"}
                </option>
              )}
              {Object.entries(manifest.variables).map(([id, definition]) => (
                <option key={id} value={id}>
                  {id} · {definition.type}
                </option>
              ))}
            </select>
          </Field>
          <Field label="操作">
            <select
              value={node.op ?? "assign"}
              onChange={(event) => {
                const op = event.currentTarget.value as NonNullable<
                  typeof node.op
                >;
                update({
                  ...node,
                  op,
                  value:
                    op === "toggle"
                      ? undefined
                      : defaultSetValue(node.variable, op, manifest),
                });
              }}
            >
              {SET_OPERATIONS.map(({ value, label }) => (
                <option
                  disabled={
                    !operationSupportsTarget(
                      value,
                      manifest.variables[node.variable]?.type,
                    )
                  }
                  key={value}
                  value={value}
                >
                  {label}
                </option>
              ))}
            </select>
          </Field>
          {(node.op ?? "assign") !== "toggle" && (
            <MutationValueEditor
              manifest={manifest}
              node={node}
              onChange={(value) => update({ ...node, value })}
            />
          )}
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "condition":
      return (
        <>
          <ConditionEditor
            manifest={manifest}
            onChange={(condition) => update({ ...node, condition })}
            value={node.condition}
          />
          <TargetSelect
            label="条件成立"
            onChange={(then) => update({ ...node, then })}
            targets={targets}
            value={node.then}
          />
          <TargetSelect
            label="否则"
            onChange={(otherwise) => update({ ...node, otherwise })}
            targets={targets}
            value={node.otherwise}
          />
        </>
      );
    case "playback":
      return (
        <>
          <Field label="自动播放策略">
            <select
              value={node.auto}
              onChange={(event) =>
                update({
                  ...node,
                  auto: event.currentTarget.value as typeof node.auto,
                })
              }
            >
              <option value="normal">普通（由玩家切换自动）</option>
              <option value="forced">强制自动，禁止手动推进</option>
            </select>
          </Field>
          <Field label="Ctrl 快进策略">
            <select
              value={node.ctrl_fast_forward}
              onChange={(event) =>
                update({
                  ...node,
                  ctrl_fast_forward: event.currentTarget
                    .value as typeof node.ctrl_fast_forward,
                })
              }
            >
              <option value="allow">允许</option>
              <option value="block">禁止</option>
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
    case "action": {
      const definition = actions.find(
        (file) => file.definition.id === node.action,
      )?.definition;
      const spriteIds = Object.entries(scene.nodes)
        .filter(([, candidate]) => candidate.type === "sprite")
        .map(([id]) => id);
      return (
        <>
          <Field label="目标立绘实例">
            <select
              onChange={(event) =>
                update({ ...node, sprite_id: event.currentTarget.value })
              }
              value={node.sprite_id}
            >
              {!spriteIds.includes(node.sprite_id) && (
                <option value={node.sprite_id}>{node.sprite_id}</option>
              )}
              {spriteIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </Field>
          <Field label="动作">
            <select
              onChange={(event) =>
                update({
                  ...node,
                  action: event.currentTarget.value,
                  parameters: {},
                })
              }
              value={node.action}
            >
              {!actions.some((file) => file.definition.id === node.action) && (
                <option value={node.action}>
                  {node.action || "— 未选择 —"}
                </option>
              )}
              {actions.map(({ definition: candidate }) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.id} · {candidate.name}
                </option>
              ))}
            </select>
          </Field>
          {definition !== undefined && (
            <>
              <OptionalNumber
                label="覆盖时长 ms（留空使用定义）"
                max={1_800_000}
                min={1}
                onChange={(duration_ms) => update({ ...node, duration_ms })}
                step={1}
                value={node.duration_ms ?? null}
              />
              {Object.entries(definition.parameters ?? {}).map(
                ([parameter, parameterDefinition]) => (
                  <NumberField
                    key={parameter}
                    label={`参数 ${parameter}`}
                    max={parameterDefinition.max ?? undefined}
                    min={parameterDefinition.min ?? undefined}
                    onChange={(value) =>
                      update({
                        ...node,
                        parameters: {
                          ...(node.parameters ?? {}),
                          [parameter]: value,
                        },
                      })
                    }
                    value={
                      node.parameters?.[parameter] ??
                      parameterDefinition.default
                    }
                  />
                ),
              )}
            </>
          )}
          <Field label="结束姿态">
            <select
              onChange={(event) =>
                update({
                  ...node,
                  end: (event.currentTarget.value ||
                    null) as SpriteActionEnd | null,
                })
              }
              value={node.end ?? ""}
            >
              <option value="">使用动作定义</option>
              <option value="hold">保持最后一帧</option>
              <option value="restore">恢复动作前姿态</option>
            </select>
          </Field>
          <BooleanField
            label="等待动作完成"
            onChange={(await_completion) =>
              update({ ...node, await: await_completion })
            }
            value={node.await}
          />
          {actions.length === 0 && (
            <p className="field-note">请先在项目面板创建一个立绘动作。</p>
          )}
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    }
    case "jump": {
      const targetScene = node.scene === null ? scene : undefined;
      return (
        <>
          <Field label="目标场景" hint="留空表示当前场景">
            <select
              value={node.scene ?? ""}
              onChange={(event) =>
                update({ ...node, scene: event.currentTarget.value || null })
              }
            >
              <option value="">当前场景</option>
              {manifest.scenes.map((path) => {
                const id =
                  path
                    .split("/")
                    .at(-1)
                    ?.replace(/\.ya?ml$/, "") ?? path;
                return (
                  <option key={path} value={id}>
                    {id}
                  </option>
                );
              })}
            </select>
          </Field>
          {targetScene !== undefined ? (
            <TargetSelect
              label="目标节点"
              onChange={(target) => update({ ...node, target })}
              targets={Object.keys(targetScene.nodes)}
              value={node.target}
            />
          ) : (
            <TextField
              label="目标节点 ID"
              onChange={(target) => update({ ...node, target })}
              value={node.target}
            />
          )}
        </>
      );
    }
    case "wait":
      return (
        <>
          <NumberField
            label="等待毫秒"
            max={60000}
            min={0}
            onChange={(duration_ms) => update({ ...node, duration_ms })}
            step={50}
            value={node.duration_ms}
          />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "bgm":
      return (
        <>
          <Field label="动作">
            <select
              value={node.action}
              onChange={(event) =>
                update({
                  ...node,
                  action: event.currentTarget.value as typeof node.action,
                })
              }
            >
              <option value="start">开始</option>
              <option value="stop">停止</option>
            </select>
          </Field>
          <AssetSelect
            allowNone={node.action === "stop"}
            kind="bgm"
            label="BGM 素材"
            manifest={manifest}
            onChange={(asset) => update({ ...node, asset })}
            value={node.asset}
          />
          <NumberField
            label="音量"
            max={1}
            min={0}
            onChange={(volume) => update({ ...node, volume })}
            step={0.05}
            value={node.volume}
          />
          {node.action === "start" && (
            <>
              <NumberField
                label="起播 ms"
                min={0}
                onChange={(start_ms) => update({ ...node, start_ms })}
                step={100}
                value={node.start_ms ?? 0}
              />
              <BooleanField
                label="自定义循环段"
                onChange={(enabled) =>
                  update({
                    ...node,
                    loop_start_ms: enabled ? 0 : null,
                    loop_end_ms: enabled ? 1000 : null,
                  })
                }
                value={node.loop_start_ms != null && node.loop_end_ms != null}
              />
              {node.loop_start_ms != null && node.loop_end_ms != null && (
                <div className="field-grid">
                  <NumberField
                    label="循环起点 ms"
                    min={0}
                    onChange={(loop_start_ms) =>
                      update({ ...node, loop_start_ms })
                    }
                    step={100}
                    value={node.loop_start_ms}
                  />
                  <NumberField
                    label="循环终点 ms"
                    min={0}
                    onChange={(loop_end_ms) => update({ ...node, loop_end_ms })}
                    step={100}
                    value={node.loop_end_ms}
                  />
                </div>
              )}
            </>
          )}
          <AwaitFields node={node} onChange={update} />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "ambience":
      return (
        <>
          <Field label="槽位">
            <select
              value={node.slot}
              onChange={(event) =>
                update({
                  ...node,
                  slot: event.currentTarget.value as typeof node.slot,
                })
              }
            >
              <option value="slot_1">槽位 1</option>
              <option value="slot_2">槽位 2</option>
              <option value="slot_3">槽位 3</option>
              <option value="slot_4">槽位 4</option>
            </select>
          </Field>
          <Field label="动作">
            <select
              value={node.action}
              onChange={(event) => {
                const action = event.currentTarget.value as typeof node.action;
                const next = { ...node, action };
                if (action === "stop") {
                  // Stop nodes carry no start/loop metadata.  Besides keeping
                  // the authored shape canonical, this prevents changing back
                  // and forth between actions from leaving invalid hidden
                  // fields behind.
                  next.asset = null;
                  delete next.start_ms;
                  delete next.loop_start_ms;
                  delete next.loop_end_ms;
                }
                update(next);
              }}
            >
              <option value="start">开始 / 替换</option>
              <option value="stop">停止</option>
            </select>
          </Field>
          <AssetSelect
            allowNone={node.action === "stop"}
            kind="ambience"
            label="环境声素材"
            manifest={manifest}
            onChange={(asset) => update({ ...node, asset })}
            value={node.asset}
          />
          <NumberField
            label="音量"
            max={1}
            min={0}
            onChange={(volume) => update({ ...node, volume })}
            step={0.05}
            value={node.volume}
          />
          {node.action === "start" && (
            <>
              <NumberField
                label="起播 ms"
                min={0}
                onChange={(start_ms) => update({ ...node, start_ms })}
                step={100}
                value={node.start_ms ?? 0}
              />
              <BooleanField
                label="自定义循环段"
                onChange={(enabled) =>
                  update({
                    ...node,
                    loop_start_ms: enabled ? 0 : null,
                    loop_end_ms: enabled ? 1000 : null,
                  })
                }
                value={node.loop_start_ms != null && node.loop_end_ms != null}
              />
              {node.loop_start_ms != null && node.loop_end_ms != null && (
                <div className="field-grid">
                  <NumberField
                    label="循环起点 ms"
                    min={0}
                    onChange={(loop_start_ms) =>
                      update({ ...node, loop_start_ms })
                    }
                    step={100}
                    value={node.loop_start_ms}
                  />
                  <NumberField
                    label="循环终点 ms"
                    min={0}
                    onChange={(loop_end_ms) => update({ ...node, loop_end_ms })}
                    step={100}
                    value={node.loop_end_ms}
                  />
                </div>
              )}
            </>
          )}
          <AwaitFields node={node} onChange={update} />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "sfx":
      return (
        <>
          <AssetSelect
            kind="sfx"
            label="音效素材"
            manifest={manifest}
            onChange={(asset) => update({ ...node, asset: asset ?? "" })}
            value={node.asset}
          />
          <NumberField
            label="音量"
            max={1}
            min={0}
            onChange={(volume) => update({ ...node, volume })}
            step={0.05}
            value={node.volume}
          />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "camera":
      return (
        <>
          <div className="field-grid">
            <NumberField
              label="X"
              onChange={(x) => update({ ...node, x })}
              value={node.x}
            />
            <NumberField
              label="Y"
              onChange={(y) => update({ ...node, y })}
              value={node.y}
            />
            <NumberField
              label="缩放"
              min={0.001}
              onChange={(zoom) => update({ ...node, zoom })}
              step={0.05}
              value={node.zoom}
            />
          </div>
          <AnimationFields node={node} onChange={update} />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "screen_effect":
      return (
        <>
          <ScreenEffectFields
            onChange={(effect) => update({ ...node, effect })}
            value={node.effect}
          />
          <AwaitFields node={node} onChange={update} />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
          <ScreenEffectPreview
            assets={assets}
            environment={previewEnvironment}
            node={node}
            nodeId={nodeId}
            onError={onError}
            scene={scene}
          />
        </>
      );
    case "dialogue_ui":
      return (
        <>
          <BooleanField
            label="显示对话框"
            onChange={(visible) => update({ ...node, visible })}
            value={node.visible}
          />
          <UiMotionSelect
            allowDefault
            label="本次动效"
            motions={uiMotions}
            onChange={(motion) => update({ ...node, motion })}
            value={node.motion}
          />
          <OptionalDurationField
            onChange={(duration_ms) => update({ ...node, duration_ms })}
            value={node.duration_ms}
          />
          <BooleanField
            label="等待动效完成"
            onChange={(awaitCompletion) =>
              update({ ...node, await: awaitCompletion })
            }
            value={node.await}
          />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "ui_motion_set":
      return (
        <>
          <Field label="默认槽位">
            <select
              onChange={(event) =>
                update({
                  ...node,
                  slot: event.currentTarget.value as typeof node.slot,
                })
              }
              value={node.slot}
            >
              <option value="dialogue_show">对话框出现</option>
              <option value="dialogue_hide">对话框收起</option>
            </select>
          </Field>
          <UiMotionSelect
            label="后续默认动效"
            motions={uiMotions}
            onChange={(motion) => update({ ...node, motion })}
            value={node.motion}
          />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "ui_motion_play":
      return (
        <>
          <UiMotionSelect
            label="播放动效"
            motions={uiMotions}
            onChange={(motion) => update({ ...node, motion: motion ?? "" })}
            value={node.motion || null}
          />
          <OptionalDurationField
            onChange={(duration_ms) => update({ ...node, duration_ms })}
            value={node.duration_ms}
          />
          <BooleanField
            label="等待动效完成"
            onChange={(awaitCompletion) =>
              update({ ...node, await: awaitCompletion })
            }
            value={node.await}
          />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "button_create":
      return (
        <>
          <TextField
            label="实例 ID"
            onChange={(instance_id) => update({ ...node, instance_id })}
            value={node.instance_id}
          />
          <Field label="按钮模板">
            <select
              value={node.template}
              onChange={(event) =>
                update({ ...node, template: event.currentTarget.value })
              }
            >
              {!buttons.some(
                ({ definition }) => definition.id === node.template,
              ) && (
                <option value={node.template}>
                  — 未找到：{node.template} —
                </option>
              )}
              {buttons.map(({ definition }) => (
                <option key={definition.id} value={definition.id}>
                  {definition.id} · {definition.width}×{definition.height}
                </option>
              ))}
            </select>
          </Field>
          <ButtonLayoutFields node={node} onChange={update} />
          <ButtonActionEditor
            action={node.action}
            manifest={manifest}
            onChange={(action) => {
              if (action !== null) update({ ...node, action });
            }}
            sceneId={scene.id}
            scenes={scenes}
            targets={targets}
          />
          <TargetSelect
            label="节点完成后"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "button_update":
      return (
        <>
          <TextField
            label="实例 ID"
            onChange={(instance_id) => update({ ...node, instance_id })}
            value={node.instance_id}
          />
          <Field label="替换模板（可选）">
            <select
              value={node.template ?? ""}
              onChange={(event) =>
                update({ ...node, template: event.currentTarget.value || null })
              }
            >
              <option value="">保持当前模板</option>
              {buttons.map(({ definition }) => (
                <option key={definition.id} value={definition.id}>
                  {definition.id}
                </option>
              ))}
            </select>
          </Field>
          <ButtonLayoutFields node={node} onChange={update} />
          <ButtonActionEditor
            action={node.action ?? { sets: [], next: null }}
            manifest={manifest}
            onChange={(action) => update({ ...node, action })}
            optional
            sceneId={scene.id}
            scenes={scenes}
            targets={targets}
          />
          <TargetSelect
            label="节点完成后"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "button_remove":
      return (
        <>
          <TextField
            label="实例 ID"
            onChange={(instance_id) => update({ ...node, instance_id })}
            value={node.instance_id}
          />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "timeline":
      return (
        <>
          <NumberField
            label="时间线时长 ms"
            max={1_800_000}
            min={1}
            onChange={(duration_ms) => update({ ...node, duration_ms })}
            step={100}
            value={node.duration_ms}
          />
          <BooleanField
            label="等待时间线完成"
            onChange={(awaitCompletion) =>
              update({
                ...node,
                await: awaitCompletion,
                skippable: awaitCompletion ? node.skippable : false,
              })
            }
            value={node.await}
          />
          <BooleanField
            label="允许手动跳过"
            onChange={(skippable) => update({ ...node, skippable })}
            value={node.skippable}
          />
          <p className="field-note">
            双击时间线节点进入全屏工作区，编辑轨道、事件和缓动曲线。
          </p>
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "end":
      return (
        <p className="field-note">
          终点节点没有出口。运行时将在这里显示结束状态。
        </p>
      );
  }
}

function ButtonLayoutFields({
  node,
  onChange,
}: {
  node: Extract<SceneNode, { type: "button_create" | "button_update" }>;
  onChange(node: SceneNode): void;
}): ReactElement {
  return (
    <div className="field-grid">
      <OptionalNumber
        label="X"
        onChange={(x) => onChange({ ...node, x })}
        value={node.x ?? null}
      />
      <OptionalNumber
        label="Y"
        onChange={(y) => onChange({ ...node, y })}
        value={node.y ?? null}
      />
      <OptionalNumber
        label="宽度"
        min={1}
        onChange={(width) => onChange({ ...node, width })}
        value={node.width ?? null}
      />
      <OptionalNumber
        label="高度"
        min={1}
        onChange={(height) => onChange({ ...node, height })}
        value={node.height ?? null}
      />
      <OptionalNumber
        label="旋转°"
        onChange={(rotation_deg) => onChange({ ...node, rotation_deg })}
        value={node.rotation_deg ?? null}
      />
      <OptionalNumber
        label="横向缩放"
        min={0.001}
        onChange={(scale_x) => onChange({ ...node, scale_x })}
        step={0.05}
        value={node.scale_x ?? null}
      />
      <OptionalNumber
        label="纵向缩放"
        min={0.001}
        onChange={(scale_y) => onChange({ ...node, scale_y })}
        step={0.05}
        value={node.scale_y ?? null}
      />
      <OptionalNumber
        label="透明度"
        max={1}
        min={0}
        onChange={(opacity) => onChange({ ...node, opacity })}
        step={0.05}
        value={node.opacity ?? null}
      />
      <OptionalNumber
        label="层级 Z"
        onChange={(z) => onChange({ ...node, z })}
        step={1}
        value={node.z ?? null}
      />
      <BooleanField
        label="显示"
        onChange={(visible) => onChange({ ...node, visible })}
        value={node.visible ?? true}
      />
      <BooleanField
        label="启用点击"
        onChange={(enabled) => onChange({ ...node, enabled })}
        value={node.enabled ?? true}
      />
    </div>
  );
}

function ButtonActionEditor({
  action,
  manifest,
  onChange,
  optional = false,
  sceneId,
  scenes,
  targets,
}: {
  action: ButtonClickAction;
  manifest: ContentManifest;
  onChange(action: ButtonClickAction | null): void;
  optional?: boolean;
  sceneId: string;
  scenes: SceneDefinition[];
  targets: string[];
}): ReactElement {
  const replaceSet = (index: number, patch: Partial<ButtonSetAction>): void => {
    const sets = action.sets.map((set, setIndex) =>
      setIndex === index ? { ...set, ...patch } : set,
    );
    onChange({ ...action, sets });
  };
  const addSet = (): void => {
    const variable = Object.keys(manifest.variables)[0] ?? "";
    const type = manifest.variables[variable]?.type ?? "boolean";
    onChange({
      ...action,
      sets: [
        ...action.sets,
        { variable, op: "assign", value: defaultScalar(type) },
      ],
    });
  };
  const nextKind = action.next?.type ?? "none";
  const setNext = (kind: string): void => {
    let next: ButtonPostAction | null = null;
    if (kind === "advance") next = { type: "advance" };
    if (kind === "open_panel") next = { type: "open_panel", panel: "saves" };
    if (kind === "jump")
      next = { type: "jump", scene: null, target: targets[0] ?? "" };
    onChange({ ...action, next });
  };
  const jump = action.next?.type === "jump" ? action.next : undefined;
  const jumpSceneId = jump?.scene ?? sceneId;
  const jumpScene = scenes.find((candidate) => candidate.id === jumpSceneId);
  const jumpTargets =
    jumpScene === undefined ? targets : Object.keys(jumpScene.nodes);
  return (
    <section className="button-action-editor">
      <header>
        <strong>点击行为{optional ? "（可选）" : ""}</strong>
        {optional && (
          <button onClick={() => onChange(null)} type="button">
            清空
          </button>
        )}
      </header>
      {action.sets.map((set, index) => {
        const variableType =
          manifest.variables[set.variable]?.type ?? "boolean";
        const operation = set.op ?? "assign";
        return (
          <article
            className="button-action-row"
            key={`${index}-${set.variable}`}
          >
            <select
              value={set.variable}
              onChange={(event) =>
                replaceSet(index, {
                  variable: event.currentTarget.value,
                  value: defaultScalar(
                    manifest.variables[event.currentTarget.value]?.type ??
                      "boolean",
                  ),
                })
              }
            >
              {!manifest.variables[set.variable] && (
                <option value={set.variable}>
                  {set.variable || "— 未声明 —"}
                </option>
              )}
              {Object.entries(manifest.variables).map(([id, definition]) => (
                <option key={id} value={id}>
                  {id} · {definition.type}
                </option>
              ))}
            </select>
            <select
              value={operation}
              onChange={(event) =>
                replaceSet(index, {
                  op: event.currentTarget.value as VariableOperation,
                  value:
                    event.currentTarget.value === "toggle"
                      ? undefined
                      : (set.value ?? defaultScalar(variableType)),
                })
              }
            >
              {SET_OPERATIONS.map(({ value, label }) => (
                <option
                  disabled={!operationSupportsTarget(value, variableType)}
                  key={value}
                  value={value}
                >
                  {label}
                </option>
              ))}
            </select>
            {operation !== "toggle" && (
              <ButtonMutationValueEditor
                manifest={manifest}
                onChange={(value) => replaceSet(index, { value })}
                operation={operation}
                targetVariable={set.variable}
                value={set.value}
              />
            )}
            <button
              className="danger-text"
              onClick={() =>
                onChange({
                  ...action,
                  sets: action.sets.filter(
                    (_candidate, setIndex) => setIndex !== index,
                  ),
                })
              }
              type="button"
            >
              ×
            </button>
          </article>
        );
      })}
      <button onClick={addSet} type="button">
        ＋ 添加变量修改
      </button>
      <Field label="点击后操作">
        <select
          value={nextKind}
          onChange={(event) => setNext(event.currentTarget.value)}
        >
          <option value="none">无（仍拦截背景点击）</option>
          <option value="advance">推进剧情</option>
          <option value="jump">跳转剧情节点</option>
          <option value="open_panel">打开系统面板</option>
        </select>
      </Field>
      {action.next?.type === "jump" && (
        <>
          <Field label="跳转场景">
            <select
              value={action.next.scene ?? ""}
              onChange={(event) => {
                const nextScene = event.currentTarget.value || null;
                const candidate =
                  scenes.find((item) => item.id === (nextScene ?? sceneId)) ??
                  (nextScene === null ? jumpScene : undefined);
                const nextTarget =
                  candidate === undefined
                    ? ""
                    : (Object.keys(candidate.nodes)[0] ?? "");
                onChange({
                  ...action,
                  next: {
                    type: "jump",
                    scene: nextScene,
                    target: nextTarget,
                  },
                });
              }}
            >
              <option value="">本场景 · {sceneId}</option>
              {scenes
                .filter((candidate) => candidate.id !== sceneId)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.id}
                  </option>
                ))}
            </select>
          </Field>
          <TargetSelect
            label="跳转目标"
            onChange={(target) =>
              onChange({
                ...action,
                next: {
                  ...(action.next as Extract<
                    ButtonPostAction,
                    { type: "jump" }
                  >),
                  target,
                },
              })
            }
            targets={jumpTargets}
            value={action.next.target}
          />
        </>
      )}
      {action.next?.type === "open_panel" && (
        <Field label="系统面板">
          <select
            value={action.next.panel}
            onChange={(event) =>
              onChange({
                ...action,
                next: {
                  type: "open_panel",
                  panel: event.currentTarget.value as Extract<
                    ButtonPostAction,
                    { type: "open_panel" }
                  >["panel"],
                },
              })
            }
          >
            <option value="saves">存档</option>
            <option value="settings">设置</option>
            <option value="history">历史记录</option>
          </select>
        </Field>
      )}
    </section>
  );
}

function ButtonMutationValueEditor({
  manifest,
  onChange,
  operation,
  targetVariable,
  value,
}: {
  manifest: ContentManifest;
  onChange(value: MutationValue): void;
  operation: VariableOperation;
  targetVariable: string;
  value: MutationValue | undefined;
}): ReactElement {
  const targetType = manifest.variables[targetVariable]?.type ?? "boolean";
  const current = value ?? defaultSetValue(targetVariable, operation, manifest);
  const variableValue =
    typeof current === "object" && current !== null ? current.variable : null;
  const eligibleVariables = Object.entries(manifest.variables).filter(
    ([, definition]) =>
      mutationTypesCompatible(targetType, definition.type, operation),
  );
  return (
    <div className="operand-editor">
      <select
        value={variableValue === null ? "literal" : "variable"}
        onChange={(event) => {
          if (event.currentTarget.value === "variable") {
            onChange({ variable: eligibleVariables[0]?.[0] ?? "" });
          } else {
            onChange(defaultScalar(targetType));
          }
        }}
      >
        <option value="literal">字面量</option>
        <option disabled={eligibleVariables.length === 0} value="variable">
          变量
        </option>
      </select>
      {variableValue === null ? (
        <LiteralEditor
          expectedType={targetType}
          onChange={onChange}
          value={current as ScalarValue}
        />
      ) : (
        <select
          value={variableValue}
          onChange={(event) =>
            onChange({ variable: event.currentTarget.value })
          }
        >
          {!eligibleVariables.some(([id]) => id === variableValue) && (
            <option value={variableValue}>
              {variableValue || "— 无兼容变量 —"}
            </option>
          )}
          {eligibleVariables.map(([id, definition]) => (
            <option key={id} value={id}>
              {id} · {definition.type}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function AnimationFields({
  node,
  onChange,
}: {
  node: Extract<
    SceneNode,
    { type: "background" | "curtain" | "sprite" | "clear" | "camera" }
  >;
  onChange(node: SceneNode): void;
}): ReactElement {
  return (
    <>
      <AwaitFields node={node} onChange={onChange} />
      <Field label="缓动">
        <select
          value={node.easing}
          onChange={(event) =>
            onChange({
              ...node,
              easing: event.currentTarget.value as typeof node.easing,
            })
          }
        >
          <option value="linear">linear</option>
          <option value="ease_in">ease in</option>
          <option value="ease_out">ease out</option>
          <option value="ease_in_out">ease in/out</option>
        </select>
      </Field>
    </>
  );
}

function AwaitFields({
  node,
  onChange,
}: {
  node: Extract<SceneNode, { duration_ms: number; await: boolean }>;
  onChange(node: SceneNode): void;
}): ReactElement {
  return (
    <div className="field-grid">
      <NumberField
        label="时长 ms"
        max={60000}
        min={0}
        onChange={(duration_ms) => onChange({ ...node, duration_ms })}
        step={50}
        value={node.duration_ms}
      />
      <BooleanField
        label="等待完成"
        onChange={(awaitCompletion) =>
          onChange({ ...node, await: awaitCompletion })
        }
        value={node.await}
      />
    </div>
  );
}

function OptionalDurationField({
  value,
  onChange,
}: {
  value: number | null;
  onChange(value: number | null): void;
}): ReactElement {
  return (
    <Field label="时长覆盖">
      <label className="checkbox-field">
        <input
          checked={value !== null}
          onChange={(event) =>
            onChange(event.currentTarget.checked ? 200 : null)
          }
          type="checkbox"
        />
        使用节点时长
      </label>
      {value !== null && (
        <input
          max={60_000}
          min={0}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
          step={10}
          type="number"
          value={value}
        />
      )}
      <small>关闭时使用预设自身时长</small>
    </Field>
  );
}

function UiMotionSelect({
  allowDefault = false,
  label,
  motions,
  value,
  onChange,
}: {
  allowDefault?: boolean;
  label: string;
  motions: UiMotionFile[];
  value: string | null;
  onChange(value: string | null): void;
}): ReactElement {
  return (
    <Field label={label}>
      <select
        onChange={(event) => onChange(event.currentTarget.value || null)}
        value={value ?? ""}
      >
        <option value="">
          {allowDefault ? "使用当前默认绑定" : "关闭 / 未选择"}
        </option>
        {motions.map(({ definition }) => (
          <option key={definition.id} value={definition.id}>
            {definition.id}
          </option>
        ))}
      </select>
    </Field>
  );
}

function AssetSelect({
  allowNone = false,
  animations = [],
  assets: imageAssets = [],
  disabled = false,
  kind,
  label,
  manifest,
  onChange,
  value,
}: {
  allowNone?: boolean;
  /** Animation documents used to preview an animated selection. */
  animations?: readonly AnimationFile[];
  /** Registered assets, for the animated preview's frame urls and size. */
  assets?: readonly EditorAsset[];
  disabled?: boolean;
  kind: AssetKind;
  label: string;
  manifest: ContentManifest;
  onChange(value: string | null): void;
  value: string | null | undefined;
}): ReactElement {
  const assets = useMemo(
    () =>
      Object.entries(manifest.assets).filter(
        ([, asset]) => asset.kind === kind,
      ),
    [kind, manifest.assets],
  );
  const selectedDefinition = value == null ? undefined : manifest.assets[value];
  const animation =
    selectedDefinition?.animation === undefined
      ? undefined
      : animationSourceId(selectedDefinition.animation, animations);
  const selectedAsset = imageAssets.find((asset) => asset.id === value);
  const metadata = selectedAsset?.metadata;
  const size =
    metadata === undefined ||
    metadata === null ||
    metadata.width === null ||
    metadata.height === null
      ? undefined
      : { width: metadata.width, height: metadata.height };
  return (
    <Field label={label}>
      <select
        disabled={disabled}
        value={value ?? ""}
        onChange={(event) => onChange(event.currentTarget.value || null)}
      >
        {allowNone && <option value="">— 无 —</option>}
        {!allowNone && <option value="">— 请选择 —</option>}
        {assets.map(([id, definition]) => (
          <option key={id} value={id}>
            {definition.animation === undefined ? id : `${id}（动画）`}
          </option>
        ))}
      </select>
      {animation !== undefined && (
        <FrameSequencePreview
          frames={animation.definition.frames.map((frame) => ({
            asset: frame.asset,
            url: assetUrl(
              imageAssets.find((asset) => asset.id === frame.asset)
                ?.absolute_path ?? "",
            ),
            duration_ms: frame.duration_ms,
          }))}
          height={size?.height}
          label={`素材 ${value ?? ""}`}
          width={size?.width}
        />
      )}
    </Field>
  );
}

const SET_OPERATIONS: { value: VariableOperation; label: string }[] = [
  { value: "assign", label: "assign · 赋值" },
  { value: "add", label: "add · 加" },
  { value: "sub", label: "sub · 减" },
  { value: "mul", label: "mul · 乘" },
  { value: "mod", label: "mod · 取模" },
  { value: "append", label: "append · 追加文本" },
  { value: "toggle", label: "toggle · 布尔翻转" },
];

function operationSupportsTarget(
  operation: VariableOperation,
  target: VariableType | undefined,
): boolean {
  if (target === undefined || operation === "assign") return true;
  if (target === "boolean") return operation === "toggle";
  if (target === "string") return operation === "append";
  if (target === "integer")
    return ["add", "sub", "mul", "mod"].includes(operation);
  return ["add", "sub", "mul"].includes(operation);
}

function MutationValueEditor({
  manifest,
  node,
  onChange,
}: {
  manifest: ContentManifest;
  node: Extract<SceneNode, { type: "set" }>;
  onChange(value: MutationValue): void;
}): ReactElement {
  const op = node.op ?? "assign";
  const targetType = manifest.variables[node.variable]?.type ?? "boolean";
  const value = node.value ?? defaultSetValue(node.variable, op, manifest);
  const variableValue =
    typeof value === "object" && value !== null ? value.variable : null;
  const eligibleVariables = Object.entries(manifest.variables).filter(
    ([, definition]) =>
      mutationTypesCompatible(targetType, definition.type, op),
  );
  return (
    <Field label="操作数">
      <div className="operand-editor">
        <select
          value={variableValue === null ? "literal" : "variable"}
          onChange={(event) =>
            onChange(
              event.currentTarget.value === "variable"
                ? { variable: eligibleVariables[0]?.[0] ?? "" }
                : defaultScalar(targetType),
            )
          }
        >
          <option value="literal">字面量</option>
          <option value="variable">变量</option>
        </select>
        {variableValue === null ? (
          <LiteralEditor
            expectedType={targetType}
            onChange={onChange}
            value={value as ScalarValue}
          />
        ) : (
          <select
            value={variableValue}
            onChange={(event) =>
              onChange({ variable: event.currentTarget.value })
            }
          >
            {!eligibleVariables.some(([id]) => id === variableValue) && (
              <option value={variableValue}>
                {variableValue || "— 无兼容变量 —"}
              </option>
            )}
            {eligibleVariables.map(([id, definition]) => (
              <option key={id} value={id}>
                {id} · {definition.type}
              </option>
            ))}
          </select>
        )}
      </div>
    </Field>
  );
}

function defaultSetValue(
  variable: string,
  op: NonNullable<Extract<SceneNode, { type: "set" }>["op"]>,
  manifest: ContentManifest,
): MutationValue {
  const type = manifest.variables[variable]?.type ?? "boolean";
  if (op === "append") return "";
  return defaultScalar(type);
}

function mutationTypesCompatible(
  target: VariableType,
  source: VariableType,
  op: NonNullable<Extract<SceneNode, { type: "set" }>["op"]>,
): boolean {
  switch (op) {
    case "assign":
      return target === source || (target === "number" && source === "integer");
    case "add":
    case "sub":
    case "mul":
      return (
        (target === "integer" || target === "number") &&
        (source === "integer" || source === "number") &&
        (target !== "integer" || source === "integer")
      );
    case "mod":
      return target === "integer" && source === "integer";
    case "append":
      return target === "string" && source === "string";
    case "toggle":
      return false;
  }
}

function interpolatePreview(source: string, manifest: ContentManifest): string {
  try {
    return interpolateTemplate(source, (id) => {
      const definition = manifest.variables[id];
      if (definition === undefined) throw new Error(`未知变量 ${id}`);
      return definition.default;
    });
  } catch {
    return source;
  }
}

const COMPARISON_OPERATORS = ["eq", "ne", "lt", "le", "gt", "ge"] as const;
type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

function OptionalConditionEditor({
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
          <option value="eq">Eq · 等于</option>
          <option value="ne">Ne · 不等于</option>
          <option value="lt">Lt · 小于</option>
          <option value="le">Le · 小于等于</option>
          <option value="gt">Gt · 大于</option>
          <option value="ge">Ge · 大于等于</option>
          <option value="and">And · 全部成立</option>
          <option value="or">Or · 任一成立</option>
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
                <button
                  disabled={index === 0}
                  onClick={() => {
                    const conditions = [...value.conditions];
                    [conditions[index - 1], conditions[index]] = [
                      conditions[index],
                      conditions[index - 1],
                    ];
                    onChange({ ...value, conditions });
                  }}
                  type="button"
                >
                  ↑
                </button>
                <button
                  disabled={index === value.conditions.length - 1}
                  onClick={() => {
                    const conditions = [...value.conditions];
                    [conditions[index], conditions[index + 1]] = [
                      conditions[index + 1],
                      conditions[index],
                    ];
                    onChange({ ...value, conditions });
                  }}
                  type="button"
                >
                  ↓
                </button>
                <button
                  className="danger-text"
                  onClick={() =>
                    onChange({
                      ...value,
                      conditions: value.conditions.filter(
                        (_candidate, candidateIndex) =>
                          candidateIndex !== index,
                      ),
                    })
                  }
                  type="button"
                >
                  删除
                </button>
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
  const variableIds = Object.keys(manifest.variables);
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
          <option value="value">字面量</option>
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
                {id} · {manifest.variables[id].scope}/
                {manifest.variables[id].type}
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

function LiteralEditor({
  expectedType,
  onChange,
  value,
}: {
  expectedType: VariableType | null;
  onChange(value: ScalarValue): void;
  value: ScalarValue;
}): ReactElement {
  const valueType = expectedType ?? scalarVariableType(value);
  const integerInputRef = useRef<HTMLInputElement>(null);
  if (valueType === "boolean") {
    return (
      <select
        value={String(value)}
        onChange={(event) => onChange(event.currentTarget.value === "true")}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (valueType === "integer") {
    return (
      <input
        aria-label="整数值"
        inputMode="numeric"
        key={String(value)}
        ref={integerInputRef}
        type="text"
        defaultValue={String(value)}
        onBlur={() => {
          const raw = integerInputRef.current?.value ?? String(value);
          if (isCanonicalIntegerText(raw)) onChange(BigInt(raw));
        }}
        onKeyDown={(event) => {
          const raw = integerInputRef.current?.value ?? String(value);
          if (event.key === "Enter" && isCanonicalIntegerText(raw)) {
            onChange(BigInt(raw));
          }
        }}
      />
    );
  }
  return (
    <input
      step="any"
      type={valueType === "number" ? "number" : "text"}
      value={String(value)}
      onChange={(event) =>
        onChange(
          valueType === "number"
            ? Number(event.currentTarget.value)
            : event.currentTarget.value,
        )
      }
    />
  );
}

function isComparison(
  value: ConditionExpression,
): value is Extract<ConditionExpression, { left: ValueOperand }> {
  return COMPARISON_OPERATORS.includes(
    value.op as (typeof COMPARISON_OPERATORS)[number],
  );
}

function conditionForOperator(
  op: ConditionExpression["op"],
  previous: ConditionExpression,
  fallbackVariable: string,
): ConditionExpression {
  if (COMPARISON_OPERATORS.includes(op as ComparisonOperator)) {
    return {
      op: op as ComparisonOperator,
      left: isComparison(previous)
        ? previous.left
        : { variable: fallbackVariable },
      right: isComparison(previous) ? previous.right : { value: true },
    };
  }
  if (op === "and" || op === "or") {
    return {
      op,
      conditions:
        previous.op === "and" || previous.op === "or"
          ? previous.conditions
          : [previous],
    };
  }
  return {
    op: "not",
    condition: previous.op === "not" ? previous.condition : previous,
  };
}

function operandVariableType(
  operand: ValueOperand,
  manifest: ContentManifest,
): VariableType | null {
  return "variable" in operand
    ? (manifest.variables[operand.variable]?.type ?? null)
    : scalarVariableType(operand.value);
}

function scalarVariableType(value: ScalarValue): VariableType {
  return scalarType(value);
}

function defaultScalar(type: VariableType): ScalarValue {
  switch (type) {
    case "boolean":
      return false;
    case "integer":
      return 0n;
    case "number":
      return 0;
    case "string":
      return "";
  }
}

function LongTextStepsEditor({
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
        <article className="long-text-step-editor" key={`${step.id}-${index}`}>
          <header>
            <strong>第 {index + 1} 段</strong>
            <div className="compact-actions">
              <button
                disabled={index === 0}
                onClick={() => {
                  const next = [...steps];
                  [next[index - 1], next[index]] = [
                    next[index],
                    next[index - 1],
                  ];
                  onChange(next);
                }}
                type="button"
              >
                ↑
              </button>
              <button
                disabled={index === steps.length - 1}
                onClick={() => {
                  const next = [...steps];
                  [next[index], next[index + 1]] = [
                    next[index + 1],
                    next[index],
                  ];
                  onChange(next);
                }}
                type="button"
              >
                ↓
              </button>
              <button
                className="danger-text"
                disabled={steps.length === 1}
                onClick={() =>
                  onChange(steps.filter((_, current) => current !== index))
                }
                type="button"
              >
                删除
              </button>
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
            <input
              onChange={(event) =>
                replace(index, { id: event.currentTarget.value })
              }
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
          <textarea
            onChange={(event) =>
              replace(index, { text: event.currentTarget.value })
            }
            rows={6}
            value={step.text}
          />
          <MeasuredMarkup source={interpolatePreview(step.text, manifest)} />
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

function DialogueTextEditor({
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
  return (
    <Field label="对话文本" hint="支持 KaTeX、pause、speed 和 fx 标记">
      <textarea
        ref={inputRef}
        rows={8}
        defaultValue={value}
        key={value}
        onChange={(event) => setTextLength(event.currentTarget.value.length)}
        onBlur={commit}
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

function RevealAnimationField({
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

function LongTextLayoutEditor({
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
      onChange({
        ...drag.layout,
        x: snap(
          Math.max(0, Math.min(1920 - drag.layout.width, drag.layout.x + dx)),
        ),
        y: snap(
          Math.max(0, Math.min(1080 - drag.layout.height, drag.layout.y + dy)),
        ),
      });
    } else {
      onChange({
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
          }}
          onPointerCancel={() => {
            dragRef.current = undefined;
          }}
          ref={canvasRef}
        >
          <button
            disabled={disabled}
            className="long-text-layout-rect"
            onPointerDown={(event) => begin(event, "move")}
            style={{
              left: `${(layout.x / 1920) * 100}%`,
              top: `${(layout.y / 1080) * 100}%`,
              width: `${(layout.width / 1920) * 100}%`,
              height: `${(layout.height / 1080) * 100}%`,
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

function TextField({
  allowEmpty = false,
  disabled = false,
  label,
  onChange,
  value,
}: {
  allowEmpty?: boolean;
  disabled?: boolean;
  label: string;
  onChange(value: string): void;
  value: string;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = (): void => {
    const draft = inputRef.current?.value ?? value;
    if (draft !== value) onChange(draft);
  };
  return (
    <Field label={label}>
      <input
        disabled={disabled}
        required={!allowEmpty}
        defaultValue={value}
        key={value}
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

function OptionalNumber({
  label,
  max,
  min,
  onChange,
  step = 1,
  value,
}: {
  label: string;
  max?: number;
  min?: number;
  onChange(value: number | null): void;
  step?: number;
  value: number | null;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = (): void => {
    const raw =
      inputRef.current?.value ?? (value === null ? "" : String(value));
    if (raw.trim() === "") {
      if (value !== null) onChange(null);
      return;
    }
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      if (parsed !== value) onChange(parsed);
    } else {
      if (inputRef.current !== null)
        inputRef.current.value = value === null ? "" : String(value);
    }
  };
  return (
    <Field label={label}>
      <input
        max={max}
        min={min}
        placeholder="保持不变"
        step={step}
        type="number"
        defaultValue={value === null ? "" : String(value)}
        key={value === null ? "null" : String(value)}
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

function BooleanField({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange(value: boolean): void;
  value: boolean;
}): ReactElement {
  return (
    <label className="boolean-field">
      <input
        checked={value}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  );
}

function TargetSelect({
  label,
  onChange,
  targets,
  value,
}: {
  label: string;
  onChange(value: string): void;
  targets: string[];
  value: string;
}): ReactElement {
  return (
    <Field label={label}>
      <select
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {!targets.includes(value) && (
          <option value={value}>{value || "— 缺少目标 —"}</option>
        )}
        {targets.map((target) => (
          <option key={target} value={target}>
            {target}
          </option>
        ))}
      </select>
    </Field>
  );
}

function BackgroundPreview({
  assets,
  environment,
  node,
  nodeId,
  onError,
  scene,
}: {
  assets: readonly EditorAsset[];
  environment: CuePreviewEnvironment | undefined;
  node: Extract<SceneNode, { type: "background" }>;
  nodeId: string;
  onError: ((message: string) => void) | undefined;
  scene: SceneDefinition;
}): ReactElement {
  const request = useMemo(
    () =>
      buildBackgroundPreviewRequest(
        node,
        storyVisualStateAtNode(scene, nodeId),
      ),
    [node, nodeId, scene],
  );
  return (
    <CuePreview
      assets={assets}
      environment={environment}
      label="背景转场预览"
      onError={onError}
      request={request}
    />
  );
}

function CurtainPreview({
  assets,
  environment,
  node,
  nodeId,
  onError,
  scene,
}: {
  assets: readonly EditorAsset[];
  environment: CuePreviewEnvironment | undefined;
  node: Extract<SceneNode, { type: "curtain" }>;
  nodeId: string;
  onError: ((message: string) => void) | undefined;
  scene: SceneDefinition;
}): ReactElement {
  const request = useMemo(
    () =>
      buildCurtainPreviewRequest(node, storyVisualStateAtNode(scene, nodeId)),
    [node, nodeId, scene],
  );
  return (
    <CuePreview
      assets={assets}
      environment={environment}
      label="幕布预览"
      onError={onError}
      request={request}
    />
  );
}

function ScreenEffectPreview({
  assets,
  environment,
  node,
  nodeId,
  onError,
  scene,
}: {
  assets: readonly EditorAsset[];
  environment: CuePreviewEnvironment | undefined;
  node: Extract<SceneNode, { type: "screen_effect" }>;
  nodeId: string;
  onError: ((message: string) => void) | undefined;
  scene: SceneDefinition;
}): ReactElement {
  const request = useMemo(
    () =>
      buildScreenEffectPreviewRequest(
        node,
        storyVisualStateAtNode(scene, nodeId),
      ),
    [node, nodeId, scene],
  );
  return (
    <CuePreview
      assets={assets}
      environment={environment}
      label="屏幕效果预览"
      onError={onError}
      request={request}
    />
  );
}
