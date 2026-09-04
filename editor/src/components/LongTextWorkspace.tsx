import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { assetUrl } from "../api";
import { interpolateTemplate } from "../textTemplate";
import { useAssetFont } from "../useAssetFont";
import type {
  ContentManifest,
  EditorAsset,
  EditorProject,
  LongTextLayout,
  LongTextNode,
  SceneDefinition,
} from "../types";
import { MarkupPreview } from "./MarkupPreview";

const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 1080;
const DEFAULT_LAYOUT: LongTextLayout = {
  x: 340,
  y: 0,
  width: 1240,
  height: 1080,
  padding_x: 118,
  padding_y: 112,
  page_height: 1340,
  page_gap: 92,
};

type LayoutGestureMode = "move" | "resize";

interface LayoutGesture {
  mode: LayoutGestureMode;
  pointerId: number;
  startX: number;
  startY: number;
  initial: LongTextLayout;
  moved: boolean;
}

export interface LongTextWorkspaceProps {
  project: EditorProject;
  sceneId: string;
  nodeId: string;
  node: LongTextNode;
  assets: EditorAsset[];
  dirty: boolean;
  undoAvailable: boolean;
  redoAvailable: boolean;
  onBack(): void;
  onChange(node: LongTextNode): void;
  onSave(): void;
  onUndo(): void;
  onRedo(): void;
}

/**
 * Full-screen long-text layout editor. The design surface intentionally uses
 * the same 1920×1080 coordinate system as the game, while the text block is
 * rendered as a real paper/window over the scene's current background.
 */
export function LongTextWorkspace({
  project,
  sceneId,
  nodeId,
  node,
  assets,
  dirty,
  undoAvailable,
  redoAvailable,
  onBack,
  onChange,
  onSave,
  onUndo,
  onRedo,
}: LongTextWorkspaceProps): ReactElement {
  const [draft, setDraft] = useState(node);
  const draftRef = useRef(node);
  const [previewScale, setPreviewScale] = useState(0.5);
  const [gestureActive, setGestureActive] = useState(false);
  const [backgroundChoice, setBackgroundChoice] = useState("__current__");
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const designRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<LayoutGesture | null>(null);

  const assetsById = useMemo(
    () => new Map(assets.map((asset) => [asset.id, asset] as const)),
    [assets],
  );
  const inferredBackground = useMemo(
    () => resolveSceneBackground(project, sceneId, nodeId),
    [nodeId, project, sceneId],
  );
  const backgroundId =
    backgroundChoice === "__current__"
      ? inferredBackground
      : backgroundChoice === "__none__"
        ? null
        : backgroundChoice;
  const backgroundAsset =
    backgroundId === null ? undefined : assetsById.get(backgroundId);
  const backgroundUrl =
    backgroundAsset?.kind === "background"
      ? assetUrl(backgroundAsset.absolute_path)
      : undefined;
  const paperAsset =
    draft.paper === null || draft.paper === undefined
      ? undefined
      : assetsById.get(draft.paper);
  const paperUrl =
    paperAsset?.kind === "gui" ? assetUrl(paperAsset.absolute_path) : undefined;
  const previewFont = assets.find((asset) => asset.kind === "font");
  const font = useAssetFont(
    previewFont === undefined ? undefined : assetUrl(previewFont.absolute_path),
    `Long Text ${previewFont?.id ?? "default"}`,
  );
  const layout = draft.layout ?? DEFAULT_LAYOUT;
  const previewSteps =
    draft.steps.length > 0
      ? draft.steps
      : [{ id: "preview", text: "长文本预览", page_break_before: false }];
  const previewSurfaceHeight = useMemo(() => {
    const estimatedStepHeight = Math.max(88, (draft.font_size ?? 32) * 2.2);
    const contentHeight =
      layout.padding_y * 2 + previewSteps.length * estimatedStepHeight;
    return Math.max(layout.page_height, contentHeight);
  }, [
    draft.font_size,
    layout.page_height,
    layout.padding_y,
    previewSteps.length,
  ]);

  const replaceDraft = useCallback((next: LongTextNode): void => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  useEffect(() => {
    if (gestureRef.current !== null) return;
    if (draftRef.current === node) return;
    // Parent updates include undo/redo and committed inspector changes.
    draftRef.current = node;
    setDraft(node);
  }, [node]);

  useEffect(() => {
    const element = stageWrapRef.current;
    if (element === null) return;
    const update = (): void => {
      const bounds = element.getBoundingClientRect();
      setPreviewScale(
        Math.max(
          0.05,
          Math.min(bounds.width / DESIGN_WIDTH, bounds.height / DESIGN_HEIGHT),
        ),
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, []);

  const commitNode = useCallback(
    (next: LongTextNode): void => {
      replaceDraft(next);
      onChange(next);
    },
    [onChange, replaceDraft],
  );

  const updateLayout = useCallback(
    (nextLayout: LongTextLayout, commit = true): void => {
      const next = { ...draftRef.current, layout: nextLayout };
      if (commit) commitNode(next);
      else replaceDraft(next);
    },
    [commitNode, replaceDraft],
  );

  const beginGesture = (
    event: ReactPointerEvent<HTMLElement>,
    mode: LayoutGestureMode,
  ): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      initial: { ...(draftRef.current.layout ?? DEFAULT_LAYOUT) },
      moved: false,
    };
    setGestureActive(true);
  };

  const handleGestureMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const gesture = gestureRef.current;
    const design = designRef.current;
    if (
      gesture === null ||
      design === null ||
      gesture.pointerId !== event.pointerId
    )
      return;
    const bounds = design.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const scaleX = DESIGN_WIDTH / bounds.width;
    const scaleY = DESIGN_HEIGHT / bounds.height;
    const dx = (event.clientX - gesture.startX) * scaleX;
    const dy = (event.clientY - gesture.startY) * scaleY;
    if (!gesture.moved && Math.hypot(dx, dy) < 1) return;
    gesture.moved = true;
    const snap = event.shiftKey
      ? (value: number): number => value
      : (value: number): number => Math.round(value / 10) * 10;
    const initial = gesture.initial;
    const nextLayout =
      gesture.mode === "move"
        ? {
            ...initial,
            x: snap(clamp(initial.x + dx, 0, DESIGN_WIDTH - initial.width)),
            y: snap(clamp(initial.y + dy, 0, DESIGN_HEIGHT - initial.height)),
          }
        : {
            ...initial,
            width: snap(
              clamp(initial.width + dx, 160, DESIGN_WIDTH - initial.x),
            ),
            height: snap(
              clamp(initial.height + dy, 240, DESIGN_HEIGHT - initial.y),
            ),
          };
    updateLayout(nextLayout, false);
    event.preventDefault();
  };

  const finishGesture = (
    event: ReactPointerEvent<HTMLDivElement>,
    cancelled = false,
  ): void => {
    const gesture = gestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    gestureRef.current = null;
    setGestureActive(false);
    if (cancelled) {
      replaceDraft({ ...draftRef.current, layout: gesture.initial });
    } else if (gesture.moved) {
      commitNode(draftRef.current);
    }
  };

  const updateField = useCallback(
    <K extends keyof LongTextNode>(field: K, value: LongTextNode[K]): void => {
      commitNode({ ...draftRef.current, [field]: value });
    },
    [commitNode],
  );

  const updateLayoutField = (
    field: keyof LongTextLayout,
    value: number,
  ): void => {
    updateLayout({
      ...(draftRef.current.layout ?? DEFAULT_LAYOUT),
      [field]: value,
    });
  };

  const handleKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const gesture = gestureRef.current;
      if (gesture !== null) {
        gestureRef.current = null;
        setGestureActive(false);
        replaceDraft({ ...draftRef.current, layout: gesture.initial });
        return;
      }
      onBack();
    },
    [onBack, replaceDraft],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const designStyle = {
    transform: `translate(-50%, -50%) scale(${previewScale})`,
    fontFamily: font.fontFamily,
  } as CSSProperties;
  const paperStyle = {
    height: `${previewSurfaceHeight}px`,
    ...(paperUrl === undefined
      ? {}
      : {
          backgroundImage: `url(${JSON.stringify(paperUrl)})`,
          backgroundSize: `100% ${layout.page_height}px`,
        }),
  } as CSSProperties;
  const textStyle = {
    height: `${previewSurfaceHeight}px`,
    "--long-text-page-gap": `${layout.page_gap}px`,
    "--long-text-padding-x": `${layout.padding_x}px`,
    "--long-text-padding-y": `${layout.padding_y}px`,
    fontSize: `${draft.font_size ?? 32}px`,
  } as CSSProperties;

  return (
    <main className="long-text-workspace">
      <header className="long-text-workspace-toolbar">
        <button onClick={onBack} type="button">
          ← 返回剧情图
        </button>
        <strong>长文本背景预览</strong>
        <code>
          {sceneId}/{nodeId}
        </code>
        <span className="long-text-workspace-status">
          {dirty ? "有未保存修改" : "已保存"}
        </span>
        <button disabled={!undoAvailable} onClick={onUndo} type="button">
          撤销
        </button>
        <button disabled={!redoAvailable} onClick={onRedo} type="button">
          重做
        </button>
        <button
          className="primary-button"
          disabled={!dirty}
          onClick={onSave}
          type="button"
        >
          保存
        </button>
      </header>

      <section className="long-text-workspace-main">
        <div className="long-text-workspace-stage-pane">
          <div
            className="long-text-workspace-stage-wrap"
            onPointerMove={handleGestureMove}
            onPointerUp={finishGesture}
            onPointerCancel={(event) => finishGesture(event, true)}
            ref={stageWrapRef}
          >
            <div
              className="long-text-workspace-design"
              ref={designRef}
              style={designStyle}
            >
              {backgroundUrl === undefined ? (
                <div className="long-text-workspace-empty-background">
                  当前场景没有可达的背景节点
                </div>
              ) : (
                <img
                  alt=""
                  className="long-text-workspace-background"
                  draggable={false}
                  src={backgroundUrl}
                />
              )}
              <div className="long-text-workspace-grid" />
              <div
                className={`long-text-workspace-box${gestureActive ? " is-dragging" : ""}`}
                onPointerDown={(event) => beginGesture(event, "move")}
                style={{
                  color: draft.text_color ?? "#212533",
                  height: `${layout.height}px`,
                  left: `${layout.x}px`,
                  top: `${layout.y}px`,
                  width: `${layout.width}px`,
                }}
              >
                <div className="long-text-workspace-window">
                  <div
                    className="long-text-workspace-paper-background"
                    style={paperStyle}
                  />
                  <div className="long-text-workspace-text-clip">
                    <div
                      className="long-text-workspace-paper"
                      style={textStyle}
                    >
                      {previewSteps.map((step, index) => (
                        <div
                          className={`long-text-workspace-step${step.page_break_before && index > 0 ? " page-break" : ""}`}
                          key={step.id}
                        >
                          <MarkupPreview
                            source={previewText(step.text, project.manifest)}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <span className="long-text-workspace-box-label">
                  {Math.round(layout.width)} × {Math.round(layout.height)}
                </span>
                <i
                  aria-label="缩放长文本区域"
                  className="long-text-workspace-resize"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    beginGesture(event, "resize");
                  }}
                  role="button"
                />
              </div>
            </div>
          </div>
          <div className="long-text-workspace-hint">
            拖动文本块调整位置，右下角调整大小；默认 10px 吸附，按住 Shift
            可取消吸附。 当前坐标均为 1920×1080 设计像素。
          </div>
        </div>

        <aside className="long-text-workspace-inspector">
          <h3>预览与布局</h3>
          <label>
            当前背景（仅编辑器）
            <select
              onChange={(event) =>
                setBackgroundChoice(event.currentTarget.value)
              }
              value={backgroundChoice}
            >
              <option value="__current__">
                {inferredBackground === null
                  ? "自动：无背景"
                  : `自动：${inferredBackground}`}
              </option>
              <option value="__none__">无背景</option>
              {assets
                .filter((asset) => asset.kind === "background")
                .map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.id}
                  </option>
                ))}
            </select>
          </label>
          <p className="long-text-workspace-note">
            背景选择不会写入 YAML；它只用于确认文本块在真实场景中的可读性。
          </p>
          <label>
            纸张素材
            <select
              onChange={(event) =>
                updateField(
                  "paper",
                  event.currentTarget.value === ""
                    ? null
                    : event.currentTarget.value,
                )
              }
              value={draft.paper ?? ""}
            >
              <option value="">透明板书</option>
              {assets
                .filter((asset) => asset.kind === "gui")
                .map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.id}
                  </option>
                ))}
            </select>
          </label>
          <div className="long-text-workspace-field-grid">
            <NumericField
              label="字号"
              min={16}
              value={draft.font_size ?? 32}
              onChange={(value) => updateField("font_size", value)}
            />
            <TextColorField
              label="正文颜色"
              value={draft.text_color ?? "#212533"}
              onChange={(value) => updateField("text_color", value)}
            />
          </div>
          <label>
            分页方式
            <select
              onChange={(event) =>
                updateField(
                  "pagination",
                  event.currentTarget.value as LongTextNode["pagination"],
                )
              }
              value={draft.pagination ?? "auto"}
            >
              <option value="continuous">连续长卷</option>
              <option value="auto">自动分页</option>
              <option value="manual">仅手动分页</option>
            </select>
          </label>
          <h3>文本区域（设计像素）</h3>
          <div className="long-text-workspace-field-grid">
            {(
              [
                ["x", "X", 0, DESIGN_WIDTH],
                ["y", "Y", 0, DESIGN_HEIGHT],
                ["width", "宽", 160, DESIGN_WIDTH],
                ["height", "高", 240, DESIGN_HEIGHT],
                ["padding_x", "水平边距", 0, 480],
                ["padding_y", "垂直边距", 0, 480],
                ["page_height", "页高", 240, 10_000],
                ["page_gap", "页间距", 0, 1_000],
              ] as const
            ).map(([field, label, min, max]) => (
              <NumericField
                key={field}
                label={label}
                max={max}
                min={min}
                value={layout[field]}
                onChange={(value) => updateLayoutField(field, value)}
              />
            ))}
          </div>
          <p className="long-text-workspace-note">
            右侧数值修改会立即写入项目历史；拖动操作在松开鼠标时作为一次撤销记录提交。
          </p>
          {font.error !== null && (
            <p className="long-text-workspace-warning">
              预览字体加载失败，将使用系统回退字体。
            </p>
          )}
        </aside>
      </section>
    </main>
  );
}

function NumericField({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max?: number;
  value: number;
  onChange(value: number): void;
}): ReactElement {
  return (
    <label className="long-text-workspace-number">
      <span>{label}</span>
      <input
        max={max}
        min={min}
        onChange={(event) => {
          const value = Number(event.currentTarget.value);
          if (Number.isFinite(value)) onChange(value);
        }}
        step="any"
        type="number"
        value={value}
      />
    </label>
  );
}

function TextColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
}): ReactElement {
  return (
    <label className="long-text-workspace-number">
      <span>{label}</span>
      <input
        maxLength={9}
        onChange={(event) => onChange(event.currentTarget.value)}
        pattern="#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})"
        type="text"
        value={value}
      />
    </label>
  );
}

function previewText(source: string, manifest: ContentManifest): string {
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

function resolveSceneBackground(
  project: EditorProject,
  targetSceneId: string,
  targetNodeId: string,
): string | null {
  const scenes = new Map(
    project.scenes.map((file) => [file.definition.id, file.definition]),
  );
  const entrySceneId = scenes.has(project.manifest.entry_scene)
    ? project.manifest.entry_scene
    : targetSceneId;
  const fromEntry = searchBackground(
    scenes,
    entrySceneId,
    targetSceneId,
    targetNodeId,
  );
  if (fromEntry !== undefined) return fromEntry;

  // An unreferenced scene can still be edited. In that case use its own entry
  // as a useful local preview instead of presenting an empty surface.
  return (
    searchBackground(scenes, targetSceneId, targetSceneId, targetNodeId) ?? null
  );
}

function searchBackground(
  scenes: ReadonlyMap<string, SceneDefinition>,
  startSceneId: string,
  targetSceneId: string,
  targetNodeId: string,
): string | null | undefined {
  const start = scenes.get(startSceneId);
  if (start === undefined) return undefined;
  const queue: {
    sceneId: string;
    nodeId: string;
    background: string | null;
  }[] = [{ sceneId: startSceneId, nodeId: start.entry, background: null }];
  const visited = new Set<string>();
  for (const current of queue) {
    const key = `${current.sceneId}/${current.nodeId}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (current.sceneId === targetSceneId && current.nodeId === targetNodeId) {
      return current.background;
    }
    const scene = scenes.get(current.sceneId);
    const node = scene?.nodes[current.nodeId];
    if (scene === undefined || node === undefined) continue;
    const background =
      node.type === "background" ? node.background : current.background;
    for (const successor of previewSuccessors(current.sceneId, node)) {
      if (
        scenes.get(successor.sceneId)?.nodes[successor.nodeId] !== undefined
      ) {
        queue.push({ ...successor, background });
      }
    }
  }
  return undefined;
}

function previewSuccessors(
  sceneId: string,
  node: SceneDefinition["nodes"][string],
): { sceneId: string; nodeId: string }[] {
  if (node.type === "jump") {
    return [{ sceneId: node.scene ?? sceneId, nodeId: node.target }];
  }
  if (node.type === "condition") {
    return [
      { sceneId, nodeId: node.then },
      { sceneId, nodeId: node.otherwise },
    ];
  }
  if (node.type === "choice") {
    return node.choices.map((choice) => ({ sceneId, nodeId: choice.next }));
  }
  return "next" in node ? [{ sceneId, nodeId: node.next }] : [];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
