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
import {
  paginateTextLayouts,
  parseMarkup,
  TextRevealSession,
  type TextLayoutSnapshot,
  type TextRevealAnimation,
} from "@vectspace/text";
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

interface EditorPreviewRun {
  key: string;
  session: TextRevealSession;
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
  const [stepLayouts, setStepLayouts] = useState<
    Readonly<Record<string, TextLayoutSnapshot>>
  >({});
  const [gestureActive, setGestureActive] = useState(false);
  const [backgroundChoice, setBackgroundChoice] = useState("__current__");
  const [previewStepIndex, setPreviewStepIndex] = useState(0);
  const [previewRun, setPreviewRun] = useState<EditorPreviewRun | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const designRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<LayoutGesture | null>(null);
  const previewSessionRef = useRef<EditorPreviewRun | null>(null);

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
  const previewSteps = useMemo(
    () =>
      draft.steps.length > 0
        ? draft.steps
        : [{ id: "preview", text: "长文本预览", page_break_before: false }],
    [draft.steps],
  );
  const reportStepLayout = useCallback(
    (stepId: string, nextLayout: TextLayoutSnapshot): void => {
      setStepLayouts((previous) => {
        const current = previous[stepId];
        if (current !== undefined && sameLayoutSnapshot(current, nextLayout)) {
          return previous;
        }
        return { ...previous, [stepId]: nextLayout };
      });
    },
    [],
  );
  // This is the identical row-based paginator used by the game.  Before an
  // asynchronous font/KaTeX measurement arrives it uses only a provisional
  // height; it never falls back to the former editor-only line estimate.
  const previewPages = useMemo(
    () =>
      paginateTextLayouts(
        previewSteps.map((step) => ({
          id: step.id,
          pageBreakBefore: step.page_break_before,
          layout: stepLayouts[step.id],
          fallbackHeight: Math.max(88, (draft.font_size ?? 32) * 2.2),
        })),
        draft.pagination ?? "auto",
        layout.page_height,
        layout.padding_y,
      ),
    [
      draft.font_size,
      draft.pagination,
      layout.page_height,
      layout.padding_y,
      previewSteps,
      stepLayouts,
    ],
  );
  const previewPageOffsets = useMemo(() => {
    const offsets: number[] = [];
    let next = 0;
    for (const page of previewPages) {
      offsets.push(next);
      next +=
        page.height + (draft.pagination === "continuous" ? 0 : layout.page_gap);
    }
    return offsets;
  }, [draft.pagination, layout.page_gap, previewPages]);
  const previewSurfaceHeight = useMemo(
    () =>
      previewPages.reduce(
        (total, page, index) =>
          total +
          page.height +
          (draft.pagination !== "continuous" && index < previewPages.length - 1
            ? layout.page_gap
            : 0),
        0,
      ),
    [draft.pagination, layout.page_gap, previewPages],
  );
  const previewStepIndexById = useMemo(
    () => new Map(previewSteps.map((step, index) => [step.id, index] as const)),
    [previewSteps],
  );
  const previewMaxScroll = Math.max(
    0,
    previewSurfaceHeight - layout.height + 240,
  );
  const previewSourceById = useMemo(
    () =>
      new Map(
        previewSteps.map((step) => [
          step.id,
          previewText(step.text, project.manifest),
        ]),
      ),
    [previewSteps, project.manifest],
  );
  const safePreviewStepIndex = clamp(
    previewStepIndex,
    0,
    Math.max(0, previewSteps.length - 1),
  );
  const previewAnimation: TextRevealAnimation =
    draft.reveal_animation ?? "typewriter";
  const previewCps = draft.speed_cps ?? 30;
  const createPreviewSession = useCallback(
    (stepIndex: number): TextRevealSession => {
      const step =
        previewSteps[clamp(stepIndex, 0, Math.max(0, previewSteps.length - 1))];
      return new TextRevealSession({
        units: parseMarkup(
          step === undefined ? "" : (previewSourceById.get(step.id) ?? ""),
        ),
        initialCps: previewCps,
        defaultCps: previewCps,
        animation: previewAnimation,
        waitForInlineMath: previewAnimation !== "drop_fade",
      });
    },
    [previewAnimation, previewCps, previewSourceById, previewSteps],
  );
  const previewStep = previewSteps[safePreviewStepIndex];
  const previewSessionKey = JSON.stringify([
    previewStep?.id ?? "",
    previewSourceById.get(previewStep?.id ?? "") ?? "",
    previewCps,
    previewAnimation,
  ]);
  const initialPreviewSession = useMemo(
    () => createPreviewSession(safePreviewStepIndex),
    [createPreviewSession, safePreviewStepIndex],
  );
  const previewSession =
    previewRun?.key === previewSessionKey
      ? previewRun.session
      : initialPreviewSession;
  const replacePreviewSession = useCallback(
    (next: TextRevealSession): void => {
      const run = { key: previewSessionKey, session: next };
      previewSessionRef.current = run;
      setPreviewRun(run);
    },
    [previewSessionKey],
  );

  // Keep the animation callback in sync with derived content without using
  // an effect to reset React state. A changed text/layout key simply presents
  // a new pure session until the user presses a playback control.
  useEffect(() => {
    previewSessionRef.current = {
      key: previewSessionKey,
      session: previewSession,
    };
  }, [previewSession, previewSessionKey]);

  useEffect(() => {
    if (!previewPlaying) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number): void => {
      const current = previewSessionRef.current;
      if (
        current === null ||
        current.key !== previewSessionKey ||
        current.session.state.status === "completed"
      ) {
        setPreviewPlaying(false);
        return;
      }
      const next = current.session.advance(
        Math.min(50, Math.max(0, now - previous)),
      );
      previous = now;
      replacePreviewSession(next);
      if (next.state.status === "completed") {
        setPreviewPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [previewPlaying, previewSessionKey, replacePreviewSession]);

  const previewScrollOffset = useMemo(() => {
    if (previewStep === undefined) return 0;
    let start: number | undefined;
    for (const [pageIndex, page] of previewPages.entries()) {
      const fragment = page.fragments.find(
        (candidate) => candidate.itemId === previewStep.id,
      );
      if (fragment === undefined) continue;
      start =
        (previewPageOffsets[pageIndex] ?? 0) + layout.padding_y + fragment.top;
      break;
    }
    return start === undefined
      ? 0
      : clamp(start - layout.height * 0.38, 0, previewMaxScroll);
  }, [
    layout.height,
    layout.padding_y,
    previewMaxScroll,
    previewPageOffsets,
    previewPages,
    previewStep,
  ]);

  const previewComplete = previewSession.state.status === "completed";
  const resetPreview = useCallback(
    (stepIndex: number, playing = false): void => {
      const normalized = clamp(
        stepIndex,
        0,
        Math.max(0, previewSteps.length - 1),
      );
      setPreviewStepIndex(normalized);
      if (normalized === safePreviewStepIndex) {
        replacePreviewSession(createPreviewSession(normalized));
      } else {
        previewSessionRef.current = null;
        setPreviewRun(null);
      }
      setPreviewPlaying(playing);
    },
    [
      createPreviewSession,
      previewSteps.length,
      replacePreviewSession,
      safePreviewStepIndex,
    ],
  );
  const togglePreviewPlayback = useCallback((): void => {
    if (previewComplete) {
      resetPreview(safePreviewStepIndex, true);
      return;
    }
    setPreviewPlaying((current) => !current);
  }, [previewComplete, resetPreview, safePreviewStepIndex]);
  const completePreviewStep = useCallback((): void => {
    const current = previewSessionRef.current;
    const session =
      current?.key === previewSessionKey ? current.session : previewSession;
    replacePreviewSession(session.completeReveal());
    setPreviewPlaying(false);
  }, [previewSession, previewSessionKey, replacePreviewSession]);
  const advancePreviewStep = useCallback((): void => {
    if (!previewComplete) {
      completePreviewStep();
      return;
    }
    if (safePreviewStepIndex >= previewSteps.length - 1) return;
    resetPreview(safePreviewStepIndex + 1);
  }, [
    completePreviewStep,
    previewComplete,
    previewSteps.length,
    resetPreview,
    safePreviewStepIndex,
  ]);

  const interpolationWarnings = useMemo(
    () =>
      previewSteps.flatMap((step) => {
        try {
          interpolateTemplate(step.text, (id) => {
            const definition = project.manifest.variables[id];
            if (definition === undefined) throw new Error(`未知变量：${id}`);
            return definition.default;
          });
          return [];
        } catch (error) {
          return [
            `${step.id}：${error instanceof Error ? error.message : "变量插值失败"}`,
          ];
        }
      }),
    [previewSteps, project.manifest.variables],
  );

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
  const paperArtworkStyle = {
    ...(paperUrl === undefined
      ? {}
      : {
          backgroundImage: `url(${JSON.stringify(paperUrl)})`,
          backgroundSize: `100% ${layout.page_height}px`,
        }),
  } as CSSProperties;
  const textSurfaceStyle = {
    height: `${previewSurfaceHeight}px`,
    "--long-text-padding-x": `${layout.padding_x}px`,
    "--long-text-padding-y": `${layout.padding_y}px`,
    fontSize: `${draft.font_size ?? 32}px`,
  } as CSSProperties;
  const measureStyle = {
    color: draft.text_color ?? "#212533",
    fontSize: `${draft.font_size ?? 32}px`,
    width: `${Math.max(1, layout.width - layout.padding_x * 2)}px`,
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
        <div className="long-text-workspace-preview-controls">
          <button onClick={togglePreviewPlayback} type="button">
            {previewPlaying ? "暂停预览" : "播放预览"}
          </button>
          <button
            disabled={previewComplete}
            onClick={completePreviewStep}
            type="button"
          >
            补全
          </button>
          <button
            disabled={
              previewComplete && safePreviewStepIndex >= previewSteps.length - 1
            }
            onClick={advancePreviewStep}
            type="button"
          >
            下一分段
          </button>
          <button onClick={() => resetPreview(0)} type="button">
            从头重播
          </button>
          <span>
            {safePreviewStepIndex + 1} / {previewSteps.length}
          </span>
        </div>
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
                <div
                  aria-hidden="true"
                  className="long-text-workspace-measure-root"
                  style={measureStyle}
                >
                  {previewSteps.map((step) => (
                    <MarkupPreview
                      key={step.id}
                      onLayout={(nextLayout) =>
                        reportStepLayout(step.id, nextLayout)
                      }
                      source={previewSourceById.get(step.id) ?? ""}
                    />
                  ))}
                </div>
                <div className="long-text-workspace-window">
                  <div
                    className="long-text-workspace-surface"
                    style={{
                      height: `${previewSurfaceHeight}px`,
                      transform: `translate3d(0, -${previewScrollOffset}px, 0)`,
                    }}
                  >
                    {previewPages.map((page, index) => (
                      <div
                        className="long-text-workspace-paper-background"
                        key={page.index}
                        style={{
                          ...paperArtworkStyle,
                          height: `${page.height}px`,
                          top: `${previewPageOffsets[index] ?? 0}px`,
                        }}
                      />
                    ))}
                  </div>
                  <div className="long-text-workspace-text-clip">
                    <div
                      className="long-text-workspace-surface"
                      style={{
                        ...textSurfaceStyle,
                        transform: `translate3d(0, -${previewScrollOffset}px, 0)`,
                      }}
                    >
                      {previewPages.map((page, index) => (
                        <article
                          className="long-text-workspace-paper"
                          key={page.index}
                          style={{
                            height: `${page.height}px`,
                            top: `${previewPageOffsets[index] ?? 0}px`,
                          }}
                        >
                          {page.fragments.map((fragment) => {
                            const fragmentStepIndex =
                              previewStepIndexById.get(fragment.itemId) ?? -1;
                            if (fragmentStepIndex > safePreviewStepIndex) {
                              return null;
                            }
                            const active =
                              fragmentStepIndex === safePreviewStepIndex;
                            return (
                              <div
                                className="long-text-workspace-step-fragment"
                                key={`${fragment.itemId}:${fragment.sourceTop}`}
                                style={{
                                  height: `${fragment.height}px`,
                                  top: `${fragment.top}px`,
                                }}
                              >
                                <div
                                  className="long-text-workspace-step-fragment-content"
                                  style={{
                                    transform: `translate3d(0, -${fragment.sourceTop}px, 0)`,
                                  }}
                                >
                                  <MarkupPreview
                                    revealAnimation={previewAnimation}
                                    source={
                                      previewSourceById.get(fragment.itemId) ??
                                      ""
                                    }
                                    visibleCount={
                                      active
                                        ? (previewSession?.state
                                            .revealedCount ?? 0)
                                        : Number.POSITIVE_INFINITY
                                    }
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </article>
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
          <p className="long-text-workspace-note">
            预览使用共享文本解析器；pause、speed 和 auto
            只控制播放，不占据正文排版空间。
          </p>
          {interpolationWarnings.length > 0 && (
            <div className="long-text-workspace-warning">
              <strong>预览插值诊断</strong>
              {interpolationWarnings.map((warning) => (
                <div key={warning}>{warning}</div>
              ))}
            </div>
          )}
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

function sameLayoutSnapshot(
  left: TextLayoutSnapshot,
  right: TextLayoutSnapshot,
): boolean {
  if (
    Math.abs(left.contentHeight - right.contentHeight) > 0.1 ||
    left.lines.length !== right.lines.length
  ) {
    return false;
  }
  return left.lines.every((line, index) => {
    const other = right.lines[index];
    if (
      other === undefined ||
      line.unitIndices.length !== other.unitIndices.length
    ) {
      return false;
    }
    return (
      line.unitIndices.every(
        (unit, unitIndex) => unit === other.unitIndices[unitIndex],
      ) &&
      Math.abs(line.top - other.top) <= 0.1 &&
      Math.abs(line.bottom - other.bottom) <= 0.1 &&
      Math.abs(line.left - other.left) <= 0.1 &&
      Math.abs(line.right - other.right) <= 0.1
    );
  });
}
