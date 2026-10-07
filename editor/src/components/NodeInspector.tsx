import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  canConvertToTimeline,
  defaultCondition,
  defaultNode,
  nodeLabel,
  projectRequest,
  resolveSpriteAsset,
  sceneSpriteIds,
} from "../story";
import { interpolateTemplate } from "../textTemplate";
import { isCanonicalIntegerText, scalarType } from "../scalars";
import {
  MAX_SCENE_TIMERS,
  MAX_TIMER_DURATION_MS,
  MIN_TIMER_INTERVAL_MS,
  nonEmpty,
  readableVariables,
  sceneRole,
  validTimerTargets,
  WINDOW_ROLE_LABELS,
  WINDOW_VARIABLE_LABELS,
} from "../windowInteraction";
import {
  belowMinimumSize,
  defaultPlacementFor,
  defaultWindowSize,
  detectPlacementPreset,
  otherWindow,
  PLACEMENT_PRESET_GROUP_LABELS,
  PLACEMENT_PRESETS,
  presetPlacement,
  resolvePlacement,
  WINDOW_LAYER_ACTIONS,
  WINDOW_MIN_SIZE,
  WINDOW_REFERENCE_LABELS,
  WINDOW_SIZE_UNIT_LABELS,
  type PlacementPresetGroup,
  type PlacementPresetId,
} from "../windowLayout";
import { assetUrl, editorApi, previewAssetsToUrls } from "../api";
import { buildEditorVisualResources, EMPTY_EDITOR_VISUALS, type EditorVisualResources } from "../visualResources";
import { defaultCurtainFill } from "../presentationDefaults";
import { animationSourceId } from "../imageAnimation";
import { isAssetDrag, resolveBackgroundDrop } from "../assetDrag";
import { authoredSpritePosition, spriteDragTarget } from "../stageEdit";
import { AssetChooser, useAssetLayout } from "./AssetChooser";
import { FrameSequencePreview } from "./FrameSequencePreview";
import { SpriteSourceFields } from "./SpriteSourceFields";
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
  WindowGeometryNode,
  WindowLayerAction,
  WindowLayerNode,
  WindowPlacement,
  WindowReference,
  WindowRole,
  WindowSizeUnit,
} from "../types";
import { MeasuredMarkup } from "@vectspace/text-react";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import type { SceneWorldSnapshot } from "@vectspace/presentation-core/scene-surface";
import type {
  ChoicePrompt,
  PresentationCue,
  StoryLocation,
} from "@vectspace/presentation-core/types";
import type { EmitterSnapshot } from "@vectspace/presentation-core/particles";
import { CuePreview } from "./CuePreview";
import type { BurstCue, CuePreviewEnvironment } from "./CuePreview";
import {
  emitterDragPosition,
  emitterStagePoint,
  roundedPosition,
} from "./particleAreaGeometry";
import { ParticleGizmo } from "./ParticleGizmo";
import { DeferredInput, DeferredTextArea, Field, NumberField } from "./Fields";
import { usePendingCommit } from "../ui/pendingCommits";
import {
  ArrowDown,
  ArrowUp,
  Clapperboard,
  CopyPlus,
  Flag,
  MoreHorizontal,
  MousePointerClick,
  Pencil,
  Replace,
  Trash2,
} from "lucide-react";
import { NODE_CATEGORY } from "../labels";
import { Badge, EmptyState } from "../ui/Display";
import { IconButton } from "../ui/Button";
import { DropdownMenu, type MenuItemSpec } from "../ui/Menu";
import { NODE_ICONS } from "../ui/nodeIcons";
import { useConfirm } from "../ui/feedbackContext";
import { nodeTypeEntries } from "./nodeTypeMenu";
import { describeNode } from "../nodeSummary";
import { Crosshair } from "lucide-react";

import {
  EASING_LABELS,
  MUTATION_LABELS,
  VARIABLE_SCOPE_LABELS,
  VARIABLE_TYPE_LABELS,
  WINDOW_LAYER_ACTION_OPTION_LABELS,
} from "../labels";
import { AudioLoopEditor } from "./AudioLoopEditor";
import { ChoicePresentationFields } from "./ChoicePresentationFields";
import { ChoicePreview } from "./ChoicePreview";
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
  buildWorldPreviewRequest,
  storyVisualStateAtNode,
} from "../presentationPreview";

/** Preview inputs threaded to the Rust-backed inspector previews. */
interface NodePreviewContext {
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
  /** Select a node in the story graph (the target locator). */
  onLocateNode?(nodeId: string): void;
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
  onLocateNode,
}: NodeInspectorProps): ReactElement {
  const node = nodeId === null ? undefined : scene.nodes[nodeId];
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
        <EmptyState icon={MousePointerClick} title="未选择节点">
          在剧情图或脚本视图中选择一个节点，这里会显示它的全部属性。
        </EmptyState>
      </aside>
    );
  }

  const update = (next: SceneNode): void => onChange(nodeId, next);
  const fallback =
    Object.keys(scene.nodes).find((id) => id !== nodeId) ?? nodeId;

  return (
    <InspectorSceneContext.Provider
      value={{ scene, manifest, onLocate: onLocateNode }}
    >
      <aside className="inspector">
        <InspectorHeader
          isEntry={scene.entry === nodeId}
          node={node}
          nodeId={nodeId}
          onChangeType={(type) =>
            update(defaultNode(type, fallback, scenes.length > 0 ? scenes : [scene]))
          }
          onConvertActionToTimeline={
            node.type === "action" &&
            onConvertActionToTimeline !== undefined &&
            actions.some((file) => file.definition.id === node.action)
              ? () => void onConvertActionToTimeline(nodeId)
              : undefined
          }
          onConvertToTimeline={
            canConvertToTimeline(node)
              ? () => onConvertToTimeline(nodeId)
              : undefined
          }
          onDelete={() => onDelete(nodeId)}
          onDuplicate={() => onDuplicate(nodeId)}
          onRename={(next) => onRename(nodeId, next)}
          onSetEntry={() => onSetEntry(nodeId)}
        />

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
      </aside>
    </InspectorSceneContext.Provider>
  );
}

/**
 * Inspector title: what the node is, its stable id (renamable in place) and
 * every node-level action in one menu, instead of a column of buttons.
 */
/** Scene data shared with deeply nested field editors. */
const InspectorSceneContext = createContext<{
  scene: SceneDefinition;
  manifest: ContentManifest;
  onLocate?(nodeId: string): void;
} | null>(null);

function InspectorHeader({
  node,
  nodeId,
  isEntry,
  onRename,
  onChangeType,
  onSetEntry,
  onDuplicate,
  onDelete,
  onConvertToTimeline,
  onConvertActionToTimeline,
}: {
  node: SceneNode;
  nodeId: string;
  isEntry: boolean;
  onRename(next: string): void;
  onChangeType(type: SceneNode["type"]): void;
  onSetEntry(): void;
  onDuplicate(): void;
  onDelete(): void;
  onConvertToTimeline?(): void;
  onConvertActionToTimeline?(): void;
}): ReactElement {
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState(false);
  const Icon = NODE_ICONS[node.type];
  const category = NODE_CATEGORY[node.type];
  const requestRename = (raw: string): boolean => {
    const next = raw.trim();
    if (next === "" || next === nodeId) {
      setRenaming(false);
      return true;
    }
    void confirm({
      title: `把节点 ${nodeId} 重命名为 ${next}？`,
      description:
        "本项目中指向它的连线、跳转与预览设置会一并更新；但玩家已有存档中记录的旧 ID 将无法恢复到这个节点。",
      confirmLabel: "重命名并更新引用",
    }).then((accepted) => {
      if (accepted) onRename(next);
      setRenaming(false);
    });
    return true;
  };
  const entries: MenuItemSpec[] = [
    {
      id: "entry",
      label: "设为场景入口",
      icon: Flag,
      disabled: isEntry,
      hint: "已经是场景入口",
      onSelect: onSetEntry,
    },
    {
      id: "rename",
      label: "重命名 ID…",
      icon: Pencil,
      onSelect: () => setRenaming(true),
    },
    {
      id: "duplicate",
      label: "创建副本",
      icon: CopyPlus,
      onSelect: onDuplicate,
    },
  ];
  if (
    onConvertToTimeline !== undefined ||
    onConvertActionToTimeline !== undefined
  )
    entries.push({ kind: "separator", id: "sep-convert" });
  if (onConvertToTimeline !== undefined)
    entries.push({
      id: "convert",
      label: "转为关键帧时间线",
      icon: Clapperboard,
      onSelect: onConvertToTimeline,
    });
  if (onConvertActionToTimeline !== undefined)
    entries.push({
      id: "convert-action",
      label: "展开为关键帧时间线",
      icon: Clapperboard,
      onSelect: onConvertActionToTimeline,
    });
  entries.push(
    { kind: "separator", id: "sep-type" },
    {
      kind: "submenu",
      id: "type",
      label: "更改类型",
      icon: Replace,
      entries: nodeTypeEntries((type) => {
        if (type === node.type) return;
        void confirm({
          title: `把这个节点改为「${nodeLabel(type)}」？`,
          description:
            "切换类型会清空该节点的专有设置，只保留节点 ID 与位置。可以撤销。",
          confirmLabel: "更改类型",
          danger: true,
        }).then((accepted) => {
          if (accepted) onChangeType(type);
        });
      }),
    },
    { kind: "separator", id: "sep-delete" },
    {
      id: "delete",
      label: "删除节点",
      icon: Trash2,
      danger: true,
      shortcut: "Delete",
      onSelect: onDelete,
    },
  );
  return (
    <header className={`inspector-header story-cat-${category}`}>
      <span className="inspector-type-icon">
        <Icon aria-hidden="true" />
      </span>
      <div className="inspector-heading">
        <h2>{nodeLabel(node.type)}</h2>
        {renaming ? (
          <DeferredInput
            aria-label="节点 ID"
            autoFocus
            className="inspector-id-input"
            onCommit={requestRename}
            onKeyDown={(event) => {
              if (event.key === "Escape") setRenaming(false);
            }}
            spellCheck={false}
            value={nodeId}
          />
        ) : (
          <button
            aria-label={`节点 ID ${nodeId}，点击重命名`}
            className="inspector-id"
            onClick={() => setRenaming(true)}
            title="点击重命名（存档会引用此 ID）"
            type="button"
          >
            <code>{nodeId}</code>
            <Pencil aria-hidden="true" />
          </button>
        )}
      </div>
      {isEntry && (
        <Badge icon={Flag} tone="accent">
          入口
        </Badge>
      )}
      <DropdownMenu
        align="end"
        entries={entries}
        label="节点操作"
        trigger={<IconButton icon={MoreHorizontal} label="节点操作" />}
      />
    </header>
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
  preview: NodePreviewContext | undefined,
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
            onChange={update}
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
            suggestions={sceneSpriteIds(scene)}
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
          <SpriteSourceFields
            assets={assets}
            textBlocks={preview?.project.text_blocks ?? []}
            value={node}
            onChange={(patch) => update({
              ...node,
              ...patch,
              ...(patch.source === undefined ? {} : { character: null, expression: null }),
            })}
          />
          {node.source === undefined && <>
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
          </>}
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
            <OptionalNumber label="横向缩放" value={node.scale_x ?? null} step={0.05} onChange={(scale_x) => update({ ...node, scale_x })} />
            <OptionalNumber label="纵向缩放" value={node.scale_y ?? null} step={0.05} onChange={(scale_y) => update({ ...node, scale_y })} />
            <OptionalNumber label="旋转 °" value={node.rotation_deg ?? null} onChange={(rotation_deg) => update({ ...node, rotation_deg })} />
            <OptionalNumber label="锚点 X" value={node.anchor_x ?? null} min={0} max={1} step={0.05} onChange={(anchor_x) => update({ ...node, anchor_x })} />
            <OptionalNumber label="锚点 Y" value={node.anchor_y ?? null} min={0} max={1} step={0.05} onChange={(anchor_y) => update({ ...node, anchor_y })} />
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
          <SpriteStagePreview
            assets={assets}
            environment={previewEnvironment}
            manifest={manifest}
            node={node}
            nodeId={nodeId}
            onChange={update}
            onError={onError}
            preview={preview}
            sceneId={scene.id}
          />
        </>
      );
    case "particle":
      return (
        <>
          <TextField label="发射器实例 ID" value={node.emitter_id} onChange={(emitter_id) => update({ ...node, emitter_id })} />
          <p className="field-note">同时显示多个持续特效时使用不同的实例 ID；同 ID 的 start 会重启该发射器，stop 会清除该发射器。</p>
          <Field label="粒子动作">
            <select value={node.action} onChange={(event) => update({ ...node, action: event.currentTarget.value as typeof node.action })}>
              <option value="start">持续发射 / 重启</option>
              <option value="stop">停止并清除</option>
              <option value="burst">单次爆发（不存档）</option>
            </select>
          </Field>
          {node.action !== "stop" && <>
            <Field label="粒子效果">
              <select value={node.particle ?? ""} onChange={(event) => update({ ...node, particle: event.currentTarget.value || null })}>
                <option value="">选择粒子定义</option>
                {(preview?.project.particles ?? []).map((file) => <option key={file.definition.id} value={file.definition.id}>{file.definition.id}</option>)}
              </select>
            </Field>
            <OptionalNumber label="随机种子（留空沿用定义）" min={0} max={0xffffffff} value={node.seed ?? null} onChange={(seed) => update({ ...node, seed })} />
            <Field label="发射器坐标空间">
              <select value={node.space} onChange={(event) => update({ ...node, space: event.currentTarget.value as typeof node.space })}>
                <option value="world">世界</option><option value="screen">屏幕</option>
              </select>
            </Field>
            <div className="field-grid">
              <NumberField label="X" value={node.x} onChange={(x) => update({ ...node, x })} />
              <NumberField label="Y" value={node.y} onChange={(y) => update({ ...node, y })} />
              <NumberField label="整体缩放" min={0.001} step={0.05} value={node.scale} onChange={(scale) => update({ ...node, scale })} />
              <NumberField label="整体旋转 °" value={node.rotation_deg} onChange={(rotation_deg) => update({ ...node, rotation_deg })} />
              <NumberField label="整体透明度" min={0} max={1} step={0.05} value={node.opacity} onChange={(opacity) => update({ ...node, opacity })} />
              <NumberField label="层级 Z" value={node.z} onChange={(z) => update({ ...node, z })} />
            </div>
          </>}
          <p className="field-note">只操作整个发射器；单次爆发和单个粒子不能添加时间线轨道。</p>
          <TargetSelect label="下一节点" targets={targets} value={node.next} onChange={(next) => update({ ...node, next })} />
          <SpriteStagePreview assets={assets} environment={previewEnvironment} manifest={manifest} node={node} nodeId={nodeId} onChange={update} onError={onError} preview={preview} sceneId={scene.id} />
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
                        choices: node.choices.map(
                          (candidate, candidateIndex) =>
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
                  {id}（{VARIABLE_TYPE_LABELS[definition.type]}）
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
      const spriteIds = sceneSpriteIds(scene);
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
          <Field
            label="目标场景"
            hint={`留空表示当前场景；只能跳到同为${WINDOW_ROLE_LABELS[sceneRole(scene)]}专用的场景`}
          >
            <select
              value={node.scene ?? ""}
              onChange={(event) =>
                update({ ...node, scene: event.currentTarget.value || null })
              }
            >
              <option value="">当前场景</option>
              <SceneOptions
                current={node.scene}
                role={sceneRole(scene)}
                scenes={scenes}
              />
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
    case "open_window": {
      return (
        <>
          <Field
            hint="只列出「副窗口」用途的场景；重复打开会在同一个副窗口中替换场景"
            label="副窗口场景"
          >
            <select
              value={node.scene}
              onChange={(event) =>
                update({ ...node, scene: event.currentTarget.value })
              }
            >
              <option value="">请选择场景</option>
              <SceneOptions
                current={node.scene}
                role="secondary"
                scenes={scenes}
              />
            </select>
          </Field>
          <p className="field-note">
            仅「主窗口」用途的场景可以打开副窗口；副窗口没有存档、设置或历史界面，也不能再打开窗口。
            目标场景的用途可在左侧场景列表中设置。
          </p>
          {sceneRole(scene) !== "main" && (
            <p className="field-note field-note-warning">
              当前场景是副窗口专用，不能包含「打开副窗口」节点。
            </p>
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
    case "window_title":
      return (
        <>
          <WindowRoleSelect
            label="目标窗口"
            onChange={(target) => update({ ...node, target })}
            value={node.target}
          />
          <TextField
            allowEmpty
            label="标题"
            onChange={(title) => update({ ...node, title })}
            value={node.title}
          />
          <p className="field-note">
            可写 [var=变量名]
            引用变量。标题只在执行到这里时求值一次并保存，之后可用
            [var=window.main.title] / [var=window.secondary.title]
            读取（只读）。原生窗口标题按纯文本显示，不处理排版标记。副窗口标题在窗口关闭或被替换后恢复默认。
          </p>
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "window_control":
      return (
        <>
          <WindowRoleSelect
            label="目标窗口"
            onChange={(target) => update({ ...node, target })}
            value={node.target}
          />
          <Field label="操作">
            <select
              value={node.action}
              onChange={(event) => {
                const action = event.currentTarget.value as typeof node.action;
                update({
                  ...node,
                  action,
                  id: action === "advance" ? "" : nonEmpty(node.id, "gate"),
                  message: action === "block" ? (node.message ?? "") : "",
                });
              }}
            >
              <option value="block">阻挡翻页</option>
              <option value="unblock">解除阻挡</option>
              <option value="advance">推进一页（脚本）</option>
            </select>
          </Field>
          {node.action !== "advance" && (
            <TextField
              label="阻挡 ID"
              onChange={(id) => update({ ...node, id })}
              value={node.id ?? ""}
            />
          )}
          {node.action === "block" && (
            <TextField
              allowEmpty
              label="提示文本（可选）"
              onChange={(message) => update({ ...node, message })}
              value={node.message ?? ""}
            />
          )}
          <p className="field-note">
            {node.action === "advance"
              ? "推进只翻一页：不会替玩家选择选项，也不会自动解除阻挡；目标没有停在对话或长文本时什么也不会发生。需要先「解除阻挡」再推进。"
              : "阻挡只限制翻页（手动、自动、快进和按钮的「继续」）；选项、其他按钮和计时器照常工作。同一个场景用同一个 ID 再次阻挡会覆盖旧提示；解除只会解除自己用这个 ID 创建的阻挡，场景退出时自动清除。"}
          </p>
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "window_geometry":
      return (
        <>
          <WindowGeometryFields node={node} onChange={update} />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "window_layer":
      return (
        <>
          <WindowLayerFields node={node} onChange={update} />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "timer": {
      const targetsForTimer = validTimerTargets(scene);
      const repeating = node.interval_ms != null;
      return (
        <>
          <Field label="操作">
            <select
              value={node.action}
              onChange={(event) => {
                const action = event.currentTarget.value as typeof node.action;
                update(
                  action === "stop"
                    ? {
                        ...node,
                        action,
                        delay_ms: 0,
                        interval_ms: null,
                        target: null,
                      }
                    : {
                        ...node,
                        action,
                        delay_ms: node.delay_ms ?? 1000,
                      },
                );
              }}
            >
              <option value="start">启动</option>
              <option value="stop">停止</option>
            </select>
          </Field>
          <TextField
            label="计时器 ID"
            onChange={(id) => update({ ...node, id })}
            value={node.id}
          />
          {node.action === "start" && (
            <>
              <NumberField
                label="首次延迟 ms"
                max={MAX_TIMER_DURATION_MS}
                min={0}
                onChange={(delay_ms) => update({ ...node, delay_ms })}
                step={50}
                value={node.delay_ms ?? 0}
              />
              <BooleanField
                label="重复触发"
                onChange={(repeat) =>
                  update({ ...node, interval_ms: repeat ? 1000 : null })
                }
                value={repeating}
              />
              {repeating && (
                <NumberField
                  label="重复间隔 ms"
                  max={MAX_TIMER_DURATION_MS}
                  min={MIN_TIMER_INTERVAL_MS}
                  onChange={(interval_ms) => update({ ...node, interval_ms })}
                  step={50}
                  value={node.interval_ms ?? MIN_TIMER_INTERVAL_MS}
                />
              )}
              <TargetSelect
                label="触发时运行的效果节点"
                onChange={(target) => update({ ...node, target })}
                targets={targetsForTimer}
                value={node.target ?? ""}
              />
              <p className="field-note">
                到点只运行所选节点的效果，不会沿它的「下一节点」走，也不会改变正在等待的对话、长文本或选项。可选：设置变量、音效、窗口标题/控制/层级，以及未开启「等待完成」的窗口位置/大小、背景、立绘、立绘动作、时间线、BGM、环境声、镜头、屏幕效果、幕布、UI
                动效。组合动画请用时间线。
              </p>
              {targetsForTimer.length === 0 && (
                <p className="field-note field-note-warning">
                  本场景还没有可被计时器运行的效果节点；请先添加一个，并保持它不要接入主线。
                </p>
              )}
            </>
          )}
          <p className="field-note">
            计时器不会自动结束：它会一直运行，直到被「停止」节点停止、场景退出或会话结束。请在离开等待处的后续节点里显式停止重复计时器。同
            ID 再次启动会替换旧计时器；重复间隔至少 {MIN_TIMER_INTERVAL_MS}{" "}
            ms，同时最多 {MAX_SCENE_TIMERS} 个。
          </p>
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
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
            <AudioLoopEditor
              asset={
                assets.find((candidate) => candidate.id === node.asset) ?? null
              }
              label="BGM"
              loopEndMs={node.loop_end_ms ?? null}
              loopStartMs={node.loop_start_ms ?? null}
              onChange={(patch) => update({ ...node, ...patch })}
              onError={onError}
              startMs={node.start_ms ?? 0}
              volume={node.volume}
            />
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
            <AudioLoopEditor
              asset={
                assets.find((candidate) => candidate.id === node.asset) ?? null
              }
              label="环境声"
              loopEndMs={node.loop_end_ms ?? null}
              loopStartMs={node.loop_start_ms ?? null}
              onChange={(patch) => update({ ...node, ...patch })}
              onError={onError}
              startMs={node.start_ms ?? 0}
              volume={node.volume}
            />
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
        onChange={(scale_x) => onChange({ ...node, scale_x })}
        step={0.05}
        value={node.scale_x ?? null}
      />
      <OptionalNumber
        label="纵向缩放"
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
                  {id}（{VARIABLE_TYPE_LABELS[definition.type]}）
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
            <IconButton
              icon={Trash2}
              label="移除这条变量修改"
              onClick={() =>
                onChange({
                  ...action,
                  sets: action.sets.filter(
                    (_candidate, setIndex) => setIndex !== index,
                  ),
                })
              }
              size="sm"
            />
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
                .filter(
                  (candidate) =>
                    candidate.id !== sceneId &&
                    // A button never moves the story to the other window's Scenes.
                    sceneRole(candidate) ===
                      sceneRole(scenes.find((item) => item.id === sceneId)),
                )
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
        <option value="literal">固定值</option>
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
              {id}（{VARIABLE_TYPE_LABELS[definition.type]}）
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
        <DeferredInput
          aria-label="时长覆盖 ms"
          max={60_000}
          min={0}
          onCommit={(raw) => {
            const duration = Number(raw);
            if (raw.trim() === "" || !Number.isFinite(duration) || duration < 0)
              return false;
            onChange(duration);
          }}
          step={10}
          type="number"
          value={String(value)}
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
      Object.entries(manifest.assets).map(([id, asset]) => ({
        id,
        kind: asset.kind,
        path: asset.path,
        animation: asset.animation,
      })),
    [manifest.assets],
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
      <AssetChooser
        allowEmpty={allowNone}
        assets={assets}
        disabled={disabled}
        kind={kind}
        label={label}
        onChange={onChange}
        value={value ?? null}
      />
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

const SET_OPERATIONS: { value: VariableOperation; label: string }[] = (
  ["assign", "add", "sub", "mul", "mod", "append", "toggle"] as const
).map((value) => ({ value, label: MUTATION_LABELS[value] }));

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
  const eligibleVariables = Object.entries(readableVariables(manifest)).filter(
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
          <option value="literal">固定值</option>
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
                {id}（{VARIABLE_TYPE_LABELS[definition.type]}）
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
      const definition = readableVariables(manifest)[id];
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
          <option value="eq">等于</option>
          <option value="ne">不等于</option>
          <option value="lt">小于</option>
          <option value="le">小于等于</option>
          <option value="gt">大于</option>
          <option value="ge">大于等于</option>
          <option value="and">And · 全部成立</option>
          <option value="or">任一满足（或）</option>
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
                <IconButton
                  disabled={index === 0}
                  onClick={() => {
                    const conditions = [...value.conditions];
                    [conditions[index - 1], conditions[index]] = [
                      conditions[index],
                      conditions[index - 1],
                    ];
                    onChange({ ...value, conditions });
                  }}
                  icon={ArrowUp}
                  label="上移"
                  size="sm"
                  variant="ghost"
                />
                <IconButton
                  disabled={index === value.conditions.length - 1}
                  onClick={() => {
                    const conditions = [...value.conditions];
                    [conditions[index], conditions[index + 1]] = [
                      conditions[index + 1],
                      conditions[index],
                    ];
                    onChange({ ...value, conditions });
                  }}
                  icon={ArrowDown}
                  label="下移"
                  size="sm"
                  variant="ghost"
                />
                <IconButton
                  onClick={() =>
                    onChange({
                      ...value,
                      conditions: value.conditions.filter(
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
  const readable = readableVariables(manifest);
  const variableIds = Object.keys(readable);
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
          <option value="value">固定值</option>
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
                {id in WINDOW_VARIABLE_LABELS
                  ? `${id}（${WINDOW_VARIABLE_LABELS[id]} · 只读 · 文本）`
                  : `${id}（${VARIABLE_SCOPE_LABELS[readable[id].scope]} · ${VARIABLE_TYPE_LABELS[readable[id].type]}）`}
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
  if (valueType === "boolean") {
    return (
      <select
        value={String(value)}
        onChange={(event) => onChange(event.currentTarget.value === "true")}
      >
        <option value="true">是</option>
        <option value="false">否</option>
      </select>
    );
  }
  if (valueType === "integer") {
    return (
      <DeferredInput
        aria-label="整数值"
        inputMode="numeric"
        onCommit={(raw) => {
          if (!isCanonicalIntegerText(raw)) return false;
          onChange(BigInt(raw));
        }}
        type="text"
        value={String(value)}
      />
    );
  }
  return (
    <DeferredInput
      onCommit={(raw) => {
        if (valueType !== "number") {
          onChange(raw);
          return;
        }
        const parsed = Number(raw);
        if (raw.trim() === "" || !Number.isFinite(parsed)) return false;
        onChange(parsed);
      }}
      step="any"
      type={valueType === "number" ? "number" : "text"}
      value={String(value)}
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
    ? (readableVariables(manifest)[operand.variable]?.type ?? null)
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

function TextField({
  allowEmpty = false,
  disabled = false,
  label,
  onChange,
  suggestions,
  value,
}: {
  allowEmpty?: boolean;
  disabled?: boolean;
  label: string;
  onChange(value: string): void;
  /** Offer existing values (e.g. sprite ids) while still allowing new ones. */
  suggestions?: readonly string[];
  value: string;
}): ReactElement {
  const listId = useId();
  return (
    <Field label={label}>
      <DeferredInput
        disabled={disabled}
        list={suggestions === undefined ? undefined : listId}
        onCommit={(raw) => onChange(raw)}
        required={!allowEmpty}
        spellCheck={false}
        value={value}
      />
      {suggestions !== undefined && (
        <datalist id={listId}>
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      )}
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
  return (
    <Field label={label}>
      <DeferredInput
        max={max}
        min={min}
        onCommit={(raw) => {
          if (raw.trim() === "") {
            if (value !== null) onChange(null);
            return;
          }
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) return false;
          if (parsed !== value) onChange(parsed);
        }}
        placeholder="保持不变"
        step={step}
        type="number"
        value={value === null ? "" : String(value)}
      />
    </Field>
  );
}

/**
 * `<option>`s for the real Scene ids (never derived from file names) that a
 * node may point at.  A reference that no longer fits is kept visible so the
 * author sees what is wrong instead of a silently empty select.
 */
function SceneOptions({
  current,
  role,
  scenes,
}: {
  current: string | null;
  role: WindowRole;
  scenes: readonly SceneDefinition[];
}): ReactElement {
  const candidates = scenes.filter(
    (candidate) => sceneRole(candidate) === role,
  );
  const stale =
    current !== null &&
    current !== "" &&
    !candidates.some((candidate) => candidate.id === current);
  return (
    <>
      {stale && (
        <option value={current}>
          {current}
          {scenes.some((candidate) => candidate.id === current)
            ? `（用途不符：需要${WINDOW_ROLE_LABELS[role]}专用）`
            : "（场景不存在）"}
        </option>
      )}
      {candidates.map((candidate) => (
        <option key={candidate.id} value={candidate.id}>
          {candidate.id}
        </option>
      ))}
    </>
  );
}

const PLACEMENT_GROUPS: readonly PlacementPresetGroup[] = [
  "screen",
  "window",
  "current",
];

/** Easings a window move can use (no timeline-only `step`). */
const WINDOW_EASINGS = [
  "linear",
  "ease_in",
  "ease_out",
  "ease_in_out",
] as const;

function WindowGeometryFields({
  node,
  onChange,
}: {
  node: WindowGeometryNode;
  onChange(node: SceneNode): void;
}): ReactElement {
  const position = node.position ?? null;
  const size = node.size ?? null;
  const other = WINDOW_ROLE_LABELS[otherWindow(node.target)];
  const placement = position === null ? null : resolvePlacement(position);
  const presetId = position === null ? null : detectPlacementPreset(position);
  const minimum = WINDOW_MIN_SIZE[node.target];
  const patchPosition = (patch: Partial<WindowPlacement>): void => {
    if (position !== null)
      onChange({ ...node, position: { ...position, ...patch } });
  };
  const sizeUnit: WindowSizeUnit = size?.unit ?? "logical";
  return (
    <>
      <WindowRoleSelect
        label="目标窗口"
        onChange={(target) => onChange({ ...node, target })}
        value={node.target}
      />
      <BooleanField
        label="改变位置"
        onChange={(enabled) =>
          onChange({
            ...node,
            position: enabled ? defaultPlacementFor(node.target) : null,
          })
        }
        value={position !== null}
      />
      {placement !== null && (
        <>
          <Field label="位置预设">
            <select
              value={presetId ?? "custom"}
              onChange={(event) => {
                const value = event.currentTarget.value;
                // "Custom" is what any hand-edited placement already is.
                if (value !== "custom") {
                  onChange({
                    ...node,
                    position: presetPlacement(value as PlacementPresetId),
                  });
                }
              }}
            >
              {PLACEMENT_GROUPS.map((group) => (
                <optgroup
                  key={group}
                  label={PLACEMENT_PRESET_GROUP_LABELS[group]}
                >
                  {PLACEMENT_PRESETS.filter(
                    (preset) => preset.group === group,
                  ).map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </optgroup>
              ))}
              <option value="custom">自定义</option>
            </select>
          </Field>
          <Field label="参考对象">
            <select
              value={placement.relative_to}
              onChange={(event) =>
                patchPosition({
                  relative_to: event.currentTarget.value as WindowReference,
                })
              }
            >
              {(Object.keys(WINDOW_REFERENCE_LABELS) as WindowReference[]).map(
                (reference) => (
                  <option key={reference} value={reference}>
                    {WINDOW_REFERENCE_LABELS[reference]}
                  </option>
                ),
              )}
            </select>
          </Field>
          <div className="field-grid">
            <NumberField
              label="参考点 X"
              max={4}
              min={-4}
              onChange={(x) => patchPosition({ x })}
              step={0.05}
              value={placement.x}
            />
            <NumberField
              label="参考点 Y"
              max={4}
              min={-4}
              onChange={(y) => patchPosition({ y })}
              step={0.05}
              value={placement.y}
            />
            <NumberField
              label="窗口锚点 X"
              max={1}
              min={0}
              onChange={(anchor_x) => patchPosition({ anchor_x })}
              step={0.05}
              value={placement.anchor_x}
            />
            <NumberField
              label="窗口锚点 Y"
              max={1}
              min={0}
              onChange={(anchor_y) => patchPosition({ anchor_y })}
              step={0.05}
              value={placement.anchor_y}
            />
            <NumberField
              label="偏移 X px"
              max={10000}
              min={-10000}
              onChange={(offset_x) => patchPosition({ offset_x })}
              step={4}
              value={placement.offset_x}
            />
            <NumberField
              label="偏移 Y px"
              max={10000}
              min={-10000}
              onChange={(offset_y) => patchPosition({ offset_y })}
              step={4}
              value={placement.offset_y}
            />
          </div>
          <p className="field-note">
            窗口上的「锚点」会被放到参考对象上的「参考点」处，再平移「偏移」逻辑像素。参考点和锚点都是比例：0
            为左/上边缘，1 为右/下边缘，参考点可在 −4…4
            之间（超出表示落在参考对象之外）。例如参考点 (1, 0.5)、锚点 (0,
            0.5)、偏移 X 16 就是贴在右侧并留 16 像素间距。「另一个游戏窗口」指
            {other}
            ；「屏幕工作区」是窗口所在显示器去掉任务栏后的区域；「自身当前位置」用于相对当前位置的偏移（可被计时器反复触发做漂移、抖动）。选预设只是填好这些数值，之后仍可微调。
          </p>
        </>
      )}
      <BooleanField
        label="改变大小"
        onChange={(enabled) =>
          onChange({
            ...node,
            size: enabled ? defaultWindowSize("logical") : null,
          })
        }
        value={size !== null}
      />
      {size !== null && (
        <>
          <Field label="大小单位">
            <select
              value={sizeUnit}
              onChange={(event) =>
                // The two units are not convertible without the screen size,
                // so switching starts from that unit's default.
                onChange({
                  ...node,
                  size: defaultWindowSize(
                    event.currentTarget.value as WindowSizeUnit,
                  ),
                })
              }
            >
              {(Object.keys(WINDOW_SIZE_UNIT_LABELS) as WindowSizeUnit[]).map(
                (unit) => (
                  <option key={unit} value={unit}>
                    {WINDOW_SIZE_UNIT_LABELS[unit]}
                  </option>
                ),
              )}
            </select>
          </Field>
          <div className="field-grid">
            <NumberField
              label="宽度"
              max={sizeUnit === "logical" ? 10000 : 1}
              min={sizeUnit === "logical" ? 1 : 0}
              onChange={(width) =>
                onChange({ ...node, size: { ...size, width } })
              }
              step={sizeUnit === "logical" ? 10 : 0.05}
              value={size.width}
            />
            <NumberField
              label="高度"
              max={sizeUnit === "logical" ? 10000 : 1}
              min={sizeUnit === "logical" ? 1 : 0}
              onChange={(height) =>
                onChange({ ...node, size: { ...size, height } })
              }
              step={sizeUnit === "logical" ? 10 : 0.05}
              value={size.height}
            />
          </div>
          <p className="field-note">
            逻辑像素是窗口客户区（不含标题栏和边框）的大小；工作区比例按显示器去掉任务栏后的区域计算（0
            到 1，不含 0），包含边框。切换单位会重置为该单位的默认大小。
          </p>
          {belowMinimumSize(node.target, size) && (
            <p className="field-note field-note-warning">
              小于{WINDOW_ROLE_LABELS[node.target]}的最小尺寸 {minimum.width}×
              {minimum.height}，运行时会被放大到最小尺寸。
            </p>
          )}
        </>
      )}
      {position === null && size === null && (
        <p className="field-note field-note-warning">
          位置和大小至少要改变一项。
        </p>
      )}
      <div className="field-grid">
        <NumberField
          label="时长 ms"
          max={60000}
          min={0}
          onChange={(duration_ms) => onChange({ ...node, duration_ms })}
          step={50}
          value={node.duration_ms}
        />
        <Field label="缓动">
          <select
            value={node.easing}
            onChange={(event) =>
              onChange({
                ...node,
                easing: event.currentTarget
                  .value as WindowGeometryNode["easing"],
              })
            }
          >
            {WINDOW_EASINGS.map((easing) => (
              <option key={easing} value={easing}>
                {EASING_LABELS[easing]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <BooleanField
        label="等待完成"
        onChange={(awaitCompletion) =>
          onChange({ ...node, await: awaitCompletion })
        }
        value={node.await}
      />
      <p className="field-note">
        时长为 0 时瞬间到位；「等待完成」只在时长大于 0
        时让剧情等动画播完。不等待的移动/缩放可以被计时器反复触发。全屏或最大化的窗口会跳过移动和缩放；窗口始终限制在所在显示器内，主窗口最小
        {WINDOW_MIN_SIZE.main.width}×{WINDOW_MIN_SIZE.main.height}，副窗口最小
        {WINDOW_MIN_SIZE.secondary.width}×{WINDOW_MIN_SIZE.secondary.height}
        （逻辑像素）。存档不记录窗口位置和大小；回到标题或退出重演时主窗口会自动复原。预览不会移动真实窗口，请在桌面双窗口运行验证。
      </p>
    </>
  );
}

function WindowLayerFields({
  node,
  onChange,
}: {
  node: WindowLayerNode;
  onChange(node: SceneNode): void;
}): ReactElement {
  return (
    <>
      <WindowRoleSelect
        label="目标窗口"
        onChange={(target) => onChange({ ...node, target })}
        value={node.target}
      />
      <Field label="层级操作">
        <select
          value={node.action}
          onChange={(event) =>
            onChange({
              ...node,
              action: event.currentTarget.value as WindowLayerAction,
            })
          }
        >
          {WINDOW_LAYER_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {WINDOW_LAYER_ACTION_OPTION_LABELS[action]}
            </option>
          ))}
        </select>
      </Field>
      <p className="field-note">
        「提到最前」只把窗口放到其他窗口上方，不抢键盘焦点；「聚焦」会激活窗口并抢走键盘焦点；「置顶」/「置底」让窗口始终在其他应用上方/下方，直到「恢复普通层级」。预览不会改变真实窗口层级，请在桌面双窗口运行验证。
      </p>
    </>
  );
}

function WindowRoleSelect({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange(value: WindowRole): void;
  value: WindowRole;
}): ReactElement {
  return (
    <Field label={label}>
      <select
        onChange={(event) => onChange(event.currentTarget.value as WindowRole)}
        value={value}
      >
        <option value="main">{WINDOW_ROLE_LABELS.main}</option>
        <option value="secondary">{WINDOW_ROLE_LABELS.secondary}</option>
      </select>
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
  const context = useContext(InspectorSceneContext);
  const optionLabel = (id: string): string => {
    const target = context?.scene.nodes[id];
    if (target === undefined) return id;
    const { title, summary } = describeNode(target, {
      manifest: context?.manifest,
    });
    const text = `${title === null ? "" : `${title}：`}${summary}`;
    return `${id} · ${nodeLabel(target.type)} · ${
      text.length > 24 ? `${text.slice(0, 24)}…` : text
    }`;
  };
  return (
    <Field label={label}>
      <div className="inline-field">
        <select
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          {!targets.includes(value) && (
            <option value={value}>{value || "— 缺少目标 —"}</option>
          )}
          {targets.map((target) => (
            <option key={target} value={target}>
              {optionLabel(target)}
            </option>
          ))}
        </select>
        {context?.onLocate !== undefined && targets.includes(value) && (
          <IconButton
            icon={Crosshair}
            label={`在剧情图中定位 ${value}`}
            onClick={() => context.onLocate?.(value)}
            size="sm"
            tooltip="在剧情图中定位"
          />
        )}
      </div>
    </Field>
  );
}

function BackgroundPreview({
  assets,
  environment,
  node,
  nodeId,
  onChange,
  onError,
  scene,
}: {
  assets: readonly EditorAsset[];
  environment: CuePreviewEnvironment | undefined;
  node: Extract<SceneNode, { type: "background" }>;
  nodeId: string;
  onChange(node: SceneNode): void;
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
  const layout = useAssetLayout();
  const [dragOver, setDragOver] = useState(false);
  return (
    <CuePreview
      assets={assets}
      environment={environment}
      label="背景转场预览"
      onError={onError}
      overlay={
        <div
          className={`stage-drop-target${dragOver ? " is-active" : ""}`}
          onDragLeave={() => setDragOver(false)}
          onDragOver={(event) => {
            // Every drag over the stage canvas is consumed, including one the
            // canvas refuses: an uncancelled drag leaves the WebView free to
            // open a dropped OS file (or the file's target) and throw away
            // unsaved authoring.  Only an internal single-asset drag offers
            // the drop affordance; a refused payload is consumed silently.
            event.preventDefault();
            const internal = isAssetDrag(event.dataTransfer);
            event.dataTransfer.dropEffect = internal ? "copy" : "none";
            setDragOver(internal);
          }}
          onDrop={(event) => {
            // Consumed unconditionally: dropping on the canvas is never a file
            // import (that is the asset library's own drop zone) and a refused
            // drop must not bubble into another target either.
            event.preventDefault();
            event.stopPropagation();
            setDragOver(false);
            if (!isAssetDrag(event.dataTransfer)) return;
            const id = resolveBackgroundDrop(
              event.dataTransfer,
              assets,
              layout,
            );
            // Re-dropping the background the node already shows is a no-op:
            // an unchanged value must never create an undo entry.
            if (id === null || id === node.background) return;
            onChange({ ...node, background: id });
          }}
        >
          {dragOver && <span>松开以更换背景</span>}
        </div>
      }
      request={request}
    />
  );
}

/**
 * Where the sprite stage editor stands while its real entering state is being
 * resolved by the Rust runtime.
 *
 * `loading` keeps the previously resolved world (if any) on screen, so a
 * refetch never blanks the canvas or drops the just-committed pose.
 */
type SpriteStageState =
  | {
      status: "loading";
      world: SceneWorldSnapshot | null;
      burst: BurstCue | null;
      /** Request generation that produced `world`; advances per answer. */
      revision: number;
    }
  | {
      status: "ready";
      world: SceneWorldSnapshot;
      burst: BurstCue | null;
      revision: number;
    }
  | { status: "needs_choice"; location: StoryLocation }
  | { status: "unreachable"; message: string }
  | { status: "error"; message: string };

/** Debounce for the runtime preview request; typing must not fire per key. */
const STAGE_PREVIEW_SETTLE_MS = 200;

function stageWorld(state: SpriteStageState): SceneWorldSnapshot | null {
  return state.status === "loading" || state.status === "ready"
    ? state.world
    : null;
}

function stageRevision(state: SpriteStageState): number {
  return state.status === "loading" || state.status === "ready"
    ? state.revision
    : 0;
}

function stageBurst(state: SpriteStageState): BurstCue | null {
  return state.status === "loading" || state.status === "ready"
    ? state.burst
    : null;
}

/**
 * The runtime's transient burst for `emitterId`, if the node produced one.
 *
 * A burst never enters the snapshot world (it is not saved), so the only
 * place the resolved emitter exists is the node's own `particle_state` cue.
 */
function matchingBurstCue(
  cues: readonly PresentationCue[] | undefined,
  emitterId: string,
): BurstCue | null {
  for (const cue of cues ?? []) {
    if (
      cue.type === "particle_state" &&
      cue.burst &&
      cue.emitter !== null &&
      cue.emitter_id === emitterId
    )
      return cue;
  }
  return null;
}

/**
 * The editable stage of one ordinary `sprite` node.
 *
 * The world is always the real one the runtime produces: the node's own
 * `build_node_preview` result, resolved from the *current* draft and preview
 * decisions, never a graph-walk guess.  `show` and `move` therefore show the
 * exact pose the game will end up at, and dragging the visible sprite writes
 * the authored `x`/`y` once, on release:
 *
 * - the gesture temporarily overrides pixels on the shared surface only,
 * - `hide` removes the sprite, so it has no target and stays read-only,
 * - the authored value is derived from the world position by removing the
 *   resolved expression offset (see `stageEdit.ts`).
 */
function SpriteStagePreview({
  assets,
  environment,
  manifest,
  node,
  nodeId,
  onChange,
  onError,
  preview,
  sceneId,
}: {
  assets: readonly EditorAsset[];
  environment: CuePreviewEnvironment | undefined;
  manifest: ContentManifest;
  node: Extract<SceneNode, { type: "sprite" | "particle" }>;
  nodeId: string;
  onChange(node: SceneNode): void;
  onError: ((message: string) => void) | undefined;
  preview: NodePreviewContext | undefined;
  sceneId: string;
}): ReactElement {
  const project = preview?.project;
  const choices = preview?.choices;
  const importTokens = preview?.importTokens;
  const variableOverrides = preview?.variableOverrides;
  const [visuals, setVisuals] = useState<EditorVisualResources>(EMPTY_EDITOR_VISUALS);
  const [resolvedAssets, setResolvedAssets] = useState<readonly EditorAsset[]>(assets);
  const [state, setState] = useState<SpriteStageState>({
    status: "loading",
    world: null,
    burst: null,
    revision: 0,
  });
  const burstEmitterId =
    node.type === "particle" && node.action === "burst" ? node.emitter_id : null;
  const [attempt, setAttempt] = useState(0);
  const generationRef = useRef(0);
  const sceneChoices = useMemo(
    () => (choices ?? []).filter((choice) => choice.scene_id === sceneId),
    [choices, sceneId],
  );
  // The parent rebuilds the preview inputs on every commit, so the effect keys
  // on signatures instead of object identities: an unrelated re-render may not
  // re-fire a host request (and therefore can never reorder two worlds).
  const importTokensKey = (importTokens ?? []).join("\u0000");
  const overridesKey = JSON.stringify(variableOverrides ?? {});
  const choicesKey = JSON.stringify(sceneChoices);

  useEffect(() => {
    if (project === undefined) return undefined;
    const generation = ++generationRef.current;
    let active = true;
    // Keeping the last world while the replacement is resolved is an
    // intentional external-system synchronization, exactly like the cue
    // preview's own loading state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((current) => ({
      status: "loading",
      world: stageWorld(current),
      burst: stageBurst(current),
      revision: stageRevision(current),
    }));
    // A short settle window keeps typing in the inspector from firing one
    // host round trip per keystroke; a superseded request never starts.
    const timer = window.setTimeout(() => {
      void editorApi
        .buildNodePreview({
          project: projectRequest(project, importTokens ?? []),
          target: { scene_id: sceneId, node_id: nodeId },
          variable_overrides: variableOverrides ?? {},
          choices: sceneChoices,
        })
        .then((result) => {
          if (!active || generation !== generationRef.current) return;
          if (result.status === "needs_choice") {
            setState({ status: "needs_choice", location: result.location });
            return;
          }
          if (result.status === "unreachable") {
            setState({ status: "unreachable", message: result.message });
            return;
          }
          const urls = result.assets === undefined
            ? Object.fromEntries(assets.map((asset) => [asset.id, assetUrl(asset.absolute_path)]))
            : previewAssetsToUrls(result.assets);
          setResolvedAssets(result.assets === undefined ? assets : assets.map((asset) => ({
            ...asset,
            absolute_path: result.assets?.find((resolved) => resolved.id === asset.id)?.absolute_path ?? asset.absolute_path,
          })));
          setVisuals(buildEditorVisualResources(project, urls, result));
          setState({
            status: "ready",
            world: result.update.snapshot.world,
            // Every completed answer is a new revision, even when it reports
            // the same coordinates: the marker uses it to drop a kept drop
            // that an undo made obsolete before this answer arrived.
            revision: generation,
            burst:
              burstEmitterId === null
                ? null
                : matchingBurstCue(result.update.cues, burstEmitterId),
          });
        })
        .catch((reason: unknown) => {
          if (!active || generation !== generationRef.current) return;
          setState({ status: "error", message: stagePreviewError(reason) });
        });
    }, STAGE_PREVIEW_SETTLE_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
      generationRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signatures stand in for the derived decision objects; project identity changes on every commit.
  }, [
    project,
    sceneId,
    nodeId,
    importTokensKey,
    overridesKey,
    choicesKey,
    attempt,
    burstEmitterId,
  ]);

  const world = stageWorld(state);
  const burst = stageBurst(state);
  const request = useMemo(
    () => (world === null ? null : buildWorldPreviewRequest(world)),
    [world],
  );
  if (project === undefined) return <></>;
  if (request === null) {
    return (
      <p className="inspector-preview-note">
        {state.status === "needs_choice"
          ? `预览需要先补充路径选择：${state.location.scene_id}/${state.location.node_id}`
          : state.status === "unreachable"
            ? `无法从场景入口到达该节点：${state.message}`
            : state.status === "error"
              ? `预览失败：${state.message}`
              : "正在通过运行时解析预览…"}
        {state.status === "error" && (
          <button
            onClick={() => setAttempt((current) => current + 1)}
            type="button"
          >
            重试
          </button>
        )}
      </p>
    );
  }
  const spriteId = node.type === "sprite" ? spriteDragTarget(node)
    : node.action === "start" ? `emitter:${node.emitter_id}` : null;
  const commitPosition = (position: { x: number; y: number }): boolean => {
    const authored = node.type === "sprite"
      ? authoredSpritePosition(node, manifest, position)
      : roundedPosition(position);
    if (
      authored.x === (node.x ?? null) &&
      authored.y === (node.y ?? null)
    )
      return false;
    onChange({ ...node, x: authored.x, y: authored.y });
    return true;
  };
  // The generation point the runtime resolved: the persistent emitter of a
  // `start`, or the transient emitter of the node's own burst cue.
  const generation: EmitterSnapshot | null =
    node.type !== "particle"
      ? null
      : node.action === "start"
        ? (request.world.emitters?.[node.emitter_id] ?? null)
        : node.action === "burst"
          ? (burst?.emitter ?? null)
          : null;
  const burstDefinition =
    burst?.emitter == null ? undefined : visuals.particles[burst.emitter.particle];
  const gizmo =
    generation === null ? undefined : (
      <ParticleGizmo
        markerAriaLabel="拖动生成点"
        markerLabel={node.type === "particle" && node.action === "burst" ? "爆发生成点" : "发射器生成点"}
        onMarkerDrop={
          state.status === "ready"
            ? ({ pointerDown, pointerNow }) =>
                commitPosition(
                  emitterDragPosition({
                    space: generation.space,
                    origin: { x: generation.x, y: generation.y },
                    pointerDown,
                    pointerNow,
                    camera: request.world.camera,
                  }),
                )
            : undefined
        }
        point={emitterStagePoint(generation, request.world.camera)}
        revision={stageRevision(state)}
      />
    );
  return (
    <>
      <CuePreview
        animations={preview?.animationMap}
        assets={resolvedAssets}
        visuals={visuals}
        decorationTransport={
          burst === null
            ? undefined
            : {
                durationMs: Math.max(
                  1,
                  Math.ceil(burstDefinition?.lifetime_ms.max ?? 1000),
                ),
                burst,
              }
        }
        dragTargetId={
          state.status === "ready" && spriteId !== null ? spriteId : undefined
        }
        environment={environment}
        label={node.type === "sprite" ? "立绘预览" : "粒子预览"}
        onDragCommit={(position) => void commitPosition(position)}
        onError={onError}
        overlay={gizmo}
        request={request}
      />
      {node.type === "particle" ? (
        <p className="inspector-preview-note">
          {node.action === "stop"
            ? "停止节点没有可拖动的目标；画面是执行后的真实结果。"
            : node.action === "burst"
              ? "拖动生成点即可修改 X / Y；单次爆发只在预览中临时播放、不会保存发射器，按空格或“重播爆发”重播。"
              : "拖动生成点或画面中的发射器即可修改 X / Y。"}
        </p>
      ) : spriteId === null ? (
        <p className="inspector-preview-note">
          隐藏节点没有可拖动的目标；画面是执行后的真实结果。
        </p>
      ) : (
        <p className="inspector-preview-note">
          拖动画面中的立绘即可修改 X / Y。
        </p>
      )}
    </>
  );
}

function stagePreviewError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
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
