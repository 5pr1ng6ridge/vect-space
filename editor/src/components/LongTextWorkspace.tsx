import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { assetUrl, editorApi } from "../api";
import { projectRequest } from "../story";
import { useAssetFont } from "../useAssetFont";
import {
  paginateTextLayouts,
  parseMarkup,
  resolveTextPageWindow,
  TextRevealSession,
  type TextLayoutSnapshot,
  type LongTextScrollState,
  type TextRevealAnimation,
  visibleUnits,
} from "@vectspace/text";
import type {
  BuildNodePreviewResult,
  EditorAsset,
  EditorProject,
  LongTextLayout,
  LongTextNode,
  LongTextStep,
  PreviewChoiceDecision,
  TimelinePreviewSettings,
} from "../types";
import {
  MeasuredMarkup,
  useLongTextScroll,
  usePaperArtwork,
} from "@vectspace/text-react";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import { editorImageSource } from "../imageAnimationMap";
import { AnimatedImage } from "./AnimatedImage";

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
  animationMap: AnimationMap;
  dirty: boolean;
  undoAvailable: boolean;
  redoAvailable: boolean;
  onBack(): void;
  onChange(node: LongTextNode): void;
  onPreviewSettingsChange(settings: TimelinePreviewSettings): void;
  onSplitLongText(stepIndex: number): void;
  onSave(): void;
  onUndo(): void;
  onRedo(): void;
  /** Opaque imports that are still staged, forwarded to the Rust preview. */
  importTokens: string[];
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
  animationMap,
  dirty,
  undoAvailable,
  redoAvailable,
  onBack,
  onChange,
  onPreviewSettingsChange,
  onSplitLongText,
  onSave,
  onUndo,
  onRedo,
  importTokens,
}: LongTextWorkspaceProps): ReactElement {
  const [draft, setDraft] = useState(node);
  const draftRef = useRef(node);
  const [previewScale, setPreviewScale] = useState(0.5);
  const [stepLayouts, setStepLayouts] = useState<
    Readonly<Record<string, { key: string; snapshot: TextLayoutSnapshot }>>
  >({});
  const [gestureActive, setGestureActive] = useState(false);
  const [backgroundChoice, setBackgroundChoice] = useState("__current__");
  const [previewStepIndex, setPreviewStepIndex] = useState(0);
  const [previewRun, setPreviewRun] = useState<EditorPreviewRun | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewScrollFinishing, setPreviewScrollFinishing] = useState(false);
  const [previewReplayEpoch, setPreviewReplayEpoch] = useState(0);
  const [previewBackgroundId, setPreviewBackgroundId] = useState<string | null>(
    null,
  );
  const [resolvedStepTexts, setResolvedStepTexts] = useState<
    Readonly<Record<string, string>>
  >({});
  // The Rust preview returns the retained document prefix. Keep that prefix
  // separate from the editable node so continuation nodes can render the
  // complete accumulated manuscript while still allowing only the current
  // node's steps to be edited.
  const [previewDocumentSteps, setPreviewDocumentSteps] = useState<
    readonly LongTextStep[]
  >([]);
  const [previewContextError, setPreviewContextError] = useState<string | null>(
    null,
  );
  const [previewContextStatus, setPreviewContextStatus] =
    useState("尚未建立真实上下文");
  const [previewContextBusy, setPreviewContextBusy] = useState(false);
  // The first frame must wait for Rust's deterministic context; rendering raw
  // YAML here would make a continuation look valid before its retained page
  // has been proven reachable.
  const [previewUnavailable, setPreviewUnavailable] = useState(true);
  const [pendingChoice, setPendingChoice] = useState<Extract<
    BuildNodePreviewResult,
    { status: "needs_choice" }
  > | null>(null);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const designRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<LayoutGesture | null>(null);
  const previewSessionRef = useRef<EditorPreviewRun | null>(null);
  const previewBackgroundStackRef = useRef<HTMLDivElement>(null);
  const previewTextStackRef = useRef<HTMLDivElement>(null);
  const previewAppearanceRangeRef = useRef("");
  const previewPageWindowRef = useRef({ start: 0, end: 0 });
  const [previewPageWindow, setPreviewPageWindow] = useState({
    start: 0,
    end: 0,
  });
  const previewMotionTargetRef = useRef(0);
  const [previewMotionTarget, setPreviewMotionTarget] = useState(0);
  const previewManuallyBrowsingRef = useRef(false);
  const previewPreviousTargetRef = useRef<number | null>(null);
  const previewPreviousAppearanceBaseRef = useRef("");
  const previewPreviousStepRef = useRef<number | null>(null);
  const previewPreviousContentRef = useRef("");
  const [enteredPreviewPageKeys, setEnteredPreviewPageKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());

  const assetsById = useMemo(
    () => new Map(assets.map((asset) => [asset.id, asset] as const)),
    [assets],
  );
  const backgroundId =
    backgroundChoice === "__current__"
      ? previewBackgroundId
      : backgroundChoice === "__none__"
        ? null
        : backgroundChoice;
  const backgroundAsset =
    backgroundId === null ? undefined : assetsById.get(backgroundId);
  const backgroundSource = editorImageSource(
    backgroundAsset,
    assets,
    animationMap,
  );
  const previewFont =
    assets.find((asset) => asset.id === project.manifest.default_font) ??
    assets.find((asset) => asset.id === "font.fusion_pixel") ??
    assets.find((asset) => asset.kind === "font");
  const font = useAssetFont(
    previewFont === undefined ? undefined : assetUrl(previewFont.absolute_path),
    `Long Text ${previewFont?.id ?? "default"}`,
  );
  const isContinuation = draft.mode === "continue";
  const inheritedStart = useMemo(() => {
    if (!isContinuation) return undefined;
    const scene = project.scenes.find((file) => file.definition.id === sceneId);
    if (scene === undefined) return undefined;
    const documentId = draft.document ?? nodeId;
    const found = Object.entries(scene.definition.nodes).find(
      ([candidateId, candidate]) =>
        candidate.type === "long_text" &&
        (candidate.mode ?? "start") === "start" &&
        (candidate.document ?? candidateId) === documentId,
    );
    return found?.[1].type === "long_text" ? found[1] : undefined;
  }, [draft.document, isContinuation, nodeId, project.scenes, sceneId]);
  const presentationNode = isContinuation ? inheritedStart : draft;
  const layout = presentationNode?.layout ?? DEFAULT_LAYOUT;
  const presentationFontSize = presentationNode?.font_size ?? 32;
  const presentationTextColor = presentationNode?.text_color ?? "#212533";
  const presentationPagination = presentationNode?.pagination ?? "auto";
  const presentationPaper = presentationNode?.paper;
  const documentId = draft.document ?? nodeId;
  const sameDocumentNodes = useMemo(() => {
    const scene = project.scenes.find((file) => file.definition.id === sceneId);
    if (scene === undefined) return [] as const;
    return Object.entries(scene.definition.nodes)
      .filter(([candidateId, candidate]) => {
        if (candidate.type !== "long_text") return false;
        return (candidate.document ?? candidateId) === documentId;
      })
      .map(([candidateId, candidate]) => ({
        id: candidateId,
        mode:
          candidate.type === "long_text"
            ? (candidate.mode ?? "start")
            : "start",
      }));
  }, [documentId, project.scenes, sceneId]);
  const paperAsset =
    presentationPaper === null || presentationPaper === undefined
      ? undefined
      : assetsById.get(presentationPaper);
  const paperUrl =
    paperAsset?.kind === "gui" ? assetUrl(paperAsset.absolute_path) : undefined;
  const paperSource = editorImageSource(paperAsset, assets, animationMap);
  const artwork = usePaperArtwork(paperUrl);
  const previewSteps = useMemo<readonly LongTextStep[]>(() => {
    // A failed/unfinished continuation must not silently fall back to its
    // local steps: those steps are not a valid cumulative manuscript until
    // Rust has proved that the retained document can be reached. Keep the
    // canvas empty while the diagnostic or choice wizard is visible.
    if (previewUnavailable) return [];
    const source =
      previewDocumentSteps.length > 0 ? previewDocumentSteps : draft.steps;
    if (source.length === 0) {
      return [{ id: "preview", text: "长文本预览", page_break_before: false }];
    }
    if (previewDocumentSteps.length === 0) return source;

    // A target node may contain steps that have not been reached yet. They do
    // not exist in the retained page returned by Rust, so append them in node
    // order using the resolved preview text when available. Existing page
    // entries deliberately win: revisiting a step must keep its original
    // interpolation rather than silently rewriting the manuscript.
    const present = new Set(source.map((step) => step.id));
    const additions = draft.steps
      .filter((step) => !present.has(step.id))
      .map((step) => ({
        ...step,
        text: resolvedStepTexts[step.id] ?? step.text,
      }));
    return additions.length === 0 ? source : [...source, ...additions];
  }, [
    draft.steps,
    previewDocumentSteps,
    previewUnavailable,
    resolvedStepTexts,
  ]);
  const previewSourceById = useMemo(
    () =>
      new Map(
        previewSteps.map((step) => [
          step.id,
          resolvedStepTexts[step.id] ?? step.text,
        ]),
      ),
    [previewSteps, resolvedStepTexts],
  );
  const stepLayoutKeys = useMemo(() => {
    const result: Record<string, string> = {};
    for (const step of previewSteps) {
      result[step.id] = JSON.stringify([
        step.id,
        previewSourceById.get(step.id) ?? "",
        presentationFontSize,
        layout.width,
        layout.padding_x,
        font.fontFamily ?? "system",
        font.ready ? "ready" : "pending",
      ]);
    }
    return result;
  }, [
    presentationFontSize,
    font.fontFamily,
    font.ready,
    layout.padding_x,
    layout.width,
    previewSourceById,
    previewSteps,
  ]);
  const reportStepLayout = useCallback(
    (stepId: string, nextLayout: TextLayoutSnapshot): void => {
      const key = stepLayoutKeys[stepId];
      if (key === undefined) return;
      setStepLayouts((previous) => {
        const current = previous[stepId];
        if (
          current?.key === key &&
          sameLayoutSnapshot(current.snapshot, nextLayout)
        ) {
          return previous;
        }
        return { ...previous, [stepId]: { key, snapshot: nextLayout } };
      });
    },
    [stepLayoutKeys],
  );
  const stepLayoutCallbacks = useMemo(
    () =>
      new Map(
        previewSteps.map(
          (step) =>
            [
              step.id,
              (nextLayout: TextLayoutSnapshot): void =>
                reportStepLayout(step.id, nextLayout),
            ] as const,
        ),
      ),
    [previewSteps, reportStepLayout],
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
          layout:
            stepLayouts[step.id]?.key === stepLayoutKeys[step.id]
              ? stepLayouts[step.id].snapshot
              : undefined,
          fallbackHeight: Math.max(88, presentationFontSize * 2.2),
        })),
        presentationPagination,
        layout.page_height,
        layout.padding_y,
      ),
    [
      presentationFontSize,
      presentationPagination,
      layout.page_height,
      layout.padding_y,
      previewSteps,
      stepLayoutKeys,
      stepLayouts,
    ],
  );
  const previewPageOffsets = useMemo(() => {
    const offsets: number[] = [];
    let next = 0;
    for (const page of previewPages) {
      offsets.push(next);
      next +=
        page.height +
        (presentationPagination === "continuous" ? 0 : layout.page_gap);
    }
    return offsets;
  }, [layout.page_gap, presentationPagination, previewPages]);
  const previewSurfaceHeight = useMemo(
    () =>
      previewPages.reduce(
        (total, page, index) =>
          total +
          page.height +
          (presentationPagination !== "continuous" &&
          index < previewPages.length - 1
            ? layout.page_gap
            : 0),
        0,
      ),
    [layout.page_gap, presentationPagination, previewPages],
  );
  const previewStepIndexById = useMemo(
    () => new Map(previewSteps.map((step, index) => [step.id, index] as const)),
    [previewSteps],
  );
  const previewMaxScroll = Math.max(
    0,
    previewSurfaceHeight - layout.height + 240,
  );
  const updatePreviewPageWindow = useCallback(
    (offset: number): void => {
      const next = resolveTextPageWindow(
        previewPages,
        previewPageOffsets,
        offset,
        layout.height,
      );
      const current = previewPageWindowRef.current;
      if (current.start === next.start && current.end === next.end) return;
      previewPageWindowRef.current = next;
      setPreviewPageWindow(next);
    },
    [layout.height, previewPageOffsets, previewPages],
  );
  const effectivePreviewPageWindow =
    previewPageWindow.end === 0 && previewPages.length > 0
      ? resolveTextPageWindow(
          previewPages,
          previewPageOffsets,
          0,
          layout.height,
        )
      : previewPageWindow;
  const renderedPreviewPages = useMemo(
    () =>
      previewPages
        .slice(effectivePreviewPageWindow.start, effectivePreviewPageWindow.end)
        .map((page, offset) => {
          const index = effectivePreviewPageWindow.start + offset;
          return { page, index, top: previewPageOffsets[index] ?? 0 };
        }),
    [
      effectivePreviewPageWindow.end,
      effectivePreviewPageWindow.start,
      previewPageOffsets,
      previewPages,
    ],
  );
  const previewRequestGeneration = useRef(0);
  const previewSettings = useMemo(() => {
    const saved = project.layout.timeline_previews?.[
      `${sceneId}/${nodeId}`
    ] ?? {
      variable_overrides: {},
      choices: [],
    };
    return {
      ...saved,
      choices: saved.choices.filter((choice) => choice.scene_id === sceneId),
    };
  }, [nodeId, project.layout.timeline_previews, sceneId]);
  useEffect(() => {
    const generation = ++previewRequestGeneration.current;
    const loadPreview = async (): Promise<void> => {
      setPreviewContextBusy(true);
      setPreviewContextError(null);
      setPendingChoice(null);
      setPreviewUnavailable(true);
      setPreviewDocumentSteps([]);
      setPreviewRun(null);
      setPreviewPlaying(false);
      setPreviewScrollFinishing(false);
      setPreviewReplayEpoch(0);
      previewAppearanceRangeRef.current = "";
      previewPageWindowRef.current = { start: 0, end: 0 };
      setPreviewPageWindow({ start: 0, end: 0 });
      previewMotionTargetRef.current = 0;
      setPreviewMotionTarget(0);
      previewManuallyBrowsingRef.current = false;
      previewPreviousTargetRef.current = null;
      previewPreviousAppearanceBaseRef.current = "";
      previewPreviousStepRef.current = null;
      previewPreviousContentRef.current = "";
      setEnteredPreviewPageKeys(new Set());
      const savedSettings = previewSettings;
      try {
        const result = await editorApi.buildNodePreview({
          project: projectRequest(project, importTokens),
          target: { scene_id: sceneId, node_id: nodeId },
          variable_overrides: savedSettings?.variable_overrides ?? {},
          choices: savedSettings?.choices ?? [],
        });
        if (generation !== previewRequestGeneration.current) return;
        if (result.status === "needs_choice") {
          setPreviewContextError(
            `真实预览需要先选择 ${result.location.scene_id}/${result.location.node_id}`,
          );
          setPreviewContextStatus(
            `等待选择：${result.location.scene_id}/${result.location.node_id}`,
          );
          setPendingChoice(result);
          setResolvedStepTexts({});
          setPreviewDocumentSteps([]);
          setPreviewUnavailable(true);
          setPreviewBackgroundId(null);
          return;
        }
        if (result.status === "unreachable") {
          setPreviewContextStatus("无法到达目标节点");
          setPreviewContextError(result.message);
          setResolvedStepTexts({});
          setPreviewDocumentSteps([]);
          setPreviewUnavailable(true);
          setPreviewRun(null);
          setPreviewPlaying(false);
          setPreviewBackgroundId(null);
          return;
        }
        const page = result.update.snapshot.long_text_page;
        const resolved = result.resolved_texts ?? {};
        const pageSteps = page?.steps ?? [];
        const pageIds = new Set(pageSteps.map((step) => step.step_id));
        const targetSteps = draft.steps
          .filter((step) => !pageIds.has(step.id))
          .map((step) => ({
            id: step.id,
            text: resolved[step.id] ?? step.text,
            page_break_before: step.page_break_before,
          }));
        setPreviewDocumentSteps([
          ...pageSteps.map((step) => ({
            id: step.step_id,
            text: step.text,
            page_break_before: step.page_break_before,
          })),
          ...targetSteps,
        ]);
        setResolvedStepTexts({
          ...resolved,
          // Retained page text is authoritative for steps that were already
          // visited; a fresh interpolation result must not rewrite a
          // previously saved/revisited paragraph.
          ...Object.fromEntries(
            pageSteps.map((step) => [step.step_id, step.text]),
          ),
        });
        const activeStepId =
          page === null || page === undefined
            ? undefined
            : page.steps[page.active_step_index]?.step_id;
        if (activeStepId !== undefined) {
          const activeIndex = [
            ...pageSteps.map((step) => step.step_id),
            ...targetSteps.map((step) => step.id),
          ].indexOf(activeStepId);
          if (activeIndex >= 0) setPreviewStepIndex(activeIndex);
        } else {
          setPreviewStepIndex(0);
        }
        setPreviewRun(null);
        setPreviewPlaying(false);
        setPreviewContextStatus(
          `已捕获真实进入状态（${result.trace.length} 个边界）`,
        );
        setPreviewUnavailable(false);
        setPreviewBackgroundId(result.update.snapshot.world.background);
      } catch (error: unknown) {
        if (generation !== previewRequestGeneration.current) return;
        setPreviewContextError(
          error instanceof Error ? error.message : "真实预览构建失败",
        );
        setPreviewContextStatus("上下文构建失败");
        setResolvedStepTexts({});
        setPreviewDocumentSteps([]);
        setPreviewUnavailable(true);
        setPreviewRun(null);
        setPreviewPlaying(false);
        setPreviewBackgroundId(null);
      } finally {
        if (generation === previewRequestGeneration.current)
          setPreviewContextBusy(false);
      }
    };
    void loadPreview();
    return () => {
      // Incrementing the generation cancels stale promise commits. The Rust
      // command itself remains stateless and can finish in the background.
      if (generation === previewRequestGeneration.current)
        previewRequestGeneration.current += 1;
    };
  }, [draft.steps, importTokens, nodeId, previewSettings, project, sceneId]);

  const onChoice = useCallback(
    (choiceId: string): void => {
      if (pendingChoice === null) return;
      const choices: PreviewChoiceDecision[] = [
        ...previewSettings.choices.filter(
          (choice) =>
            !(
              choice.scene_id === pendingChoice.location.scene_id &&
              choice.node_id === pendingChoice.location.node_id &&
              choice.visit === pendingChoice.visit
            ),
        ),
        {
          scene_id: pendingChoice.location.scene_id,
          node_id: pendingChoice.location.node_id,
          visit: pendingChoice.visit,
          choice_id: choiceId,
        },
      ];
      const nextSettings: TimelinePreviewSettings = {
        ...previewSettings,
        choices,
      };
      onPreviewSettingsChange(nextSettings);
      // The project update will re-run the effect as well; invoking the
      // effect through the normal state update keeps the request source of
      // truth in the saved .vectspace metadata.
    },
    [onPreviewSettingsChange, pendingChoice, previewSettings],
  );
  const safePreviewStepIndex = clamp(
    previewStepIndex,
    0,
    Math.max(0, previewSteps.length - 1),
  );
  const previewPageHasVisibleContent = useMemo(
    () =>
      previewPages.map((page) =>
        page.fragments.some(
          (fragment) =>
            (previewStepIndexById.get(fragment.itemId) ??
              Number.POSITIVE_INFINITY) <= safePreviewStepIndex,
        ),
      ),
    [previewPages, previewStepIndexById, safePreviewStepIndex],
  );
  const previewActiveCursorPositions = useMemo(() => {
    const step = previewSteps[safePreviewStepIndex];
    if (step === undefined) return [] as readonly number[];
    const activeLayout = stepLayouts[step.id]?.snapshot;
    if (activeLayout === undefined) return [] as readonly number[];
    const layoutUnits = visibleUnits(
      parseMarkup(previewSourceById.get(step.id) ?? step.text),
    );
    const revealIndexByLayoutIndex = new Map<number, number>();
    let revealIndex = 0;
    layoutUnits.forEach((unit, layoutIndex) => {
      if (unit.kind === "hard_break") return;
      revealIndexByLayoutIndex.set(layoutIndex, revealIndex);
      revealIndex += 1;
    });
    const linePositions = new Map<number, number>();
    previewPages.forEach((page, pageIndex) => {
      page.fragments.forEach((fragment) => {
        if (fragment.itemId !== step.id) return;
        for (
          let lineIndex = fragment.firstLine;
          lineIndex <= fragment.lastLine;
          lineIndex += 1
        ) {
          if (linePositions.has(lineIndex)) continue;
          const line = activeLayout.lines[lineIndex];
          if (line === undefined) continue;
          linePositions.set(
            lineIndex,
            (previewPageOffsets[pageIndex] ?? 0) +
              layout.padding_y +
              fragment.top +
              (line.bottom - fragment.sourceTop),
          );
        }
      });
    });
    const result: number[] = [];
    activeLayout.lines.forEach((line, lineIndex) => {
      const position = linePositions.get(lineIndex);
      if (position === undefined) return;
      line.unitIndices.forEach((layoutIndex) => {
        const index = revealIndexByLayoutIndex.get(layoutIndex);
        if (index !== undefined) result[index] = position;
      });
    });
    return result;
  }, [
    layout.padding_y,
    previewPageOffsets,
    previewPages,
    previewSourceById,
    previewSteps,
    safePreviewStepIndex,
    stepLayouts,
  ]);
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
        setPreviewScrollFinishing(true);
        setPreviewPlaying(false);
        return;
      }
      const next = current.session.advance(
        Math.min(50, Math.max(0, now - previous)),
      );
      previous = now;
      replacePreviewSession(next);
      if (next.state.status === "completed") {
        setPreviewScrollFinishing(true);
        setPreviewPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [previewPlaying, previewSessionKey, replacePreviewSession]);

  const previewScrollTarget = useMemo(() => {
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

  const previewAppearanceBase = useMemo(
    () =>
      JSON.stringify([
        documentId,
        presentationFontSize,
        layout.width,
        layout.padding_x,
        layout.padding_y,
        layout.page_height,
        presentationPagination,
        previewReplayEpoch,
      ]),
    [
      documentId,
      layout.page_height,
      layout.padding_x,
      layout.padding_y,
      layout.width,
      presentationFontSize,
      presentationPagination,
      previewReplayEpoch,
    ],
  );
  const previewPageAppearanceKey = useCallback(
    (_page: (typeof previewPages)[number], index: number): string =>
      `${previewAppearanceBase}:${index}`,
    [previewAppearanceBase],
  );
  const previewPageAppearanceKeys = useMemo(
    () =>
      previewPages.map((page, index) => previewPageAppearanceKey(page, index)),
    [previewPageAppearanceKey, previewPages],
  );
  const previewContentGeneration = useMemo(
    () =>
      JSON.stringify(
        previewPages.map((page) =>
          page.fragments.map((fragment) => [
            fragment.itemId,
            previewSourceById.get(fragment.itemId) ?? "",
            fragment.sourceTop,
            fragment.height,
            fragment.top,
            fragment.firstLine,
            fragment.lastLine,
          ]),
        ),
      ),
    [previewPages, previewSourceById],
  );
  const applyPreviewScrollOffset = useCallback((offset: number): void => {
    const transform = `translate3d(0, -${offset}px, 0)`;
    if (previewBackgroundStackRef.current !== null) {
      previewBackgroundStackRef.current.style.transform = transform;
    }
    if (previewTextStackRef.current !== null) {
      previewTextStackRef.current.style.transform = transform;
    }
  }, []);
  const markPreviewPages = useCallback(
    (offset: number): void => {
      if (!artwork.ready || !font.ready || previewUnavailable) return;
      updatePreviewPageWindow(offset);
      let start = 0;
      while (
        start < previewPages.length &&
        (previewPageOffsets[start] ?? 0) + (previewPages[start]?.height ?? 0) <=
          offset
      ) {
        start += 1;
      }
      let end = start;
      const viewportBottom = offset + layout.height;
      while (
        end < previewPages.length &&
        (previewPageOffsets[end] ?? 0) < viewportBottom
      ) {
        end += 1;
      }
      const signature = `${previewContentGeneration}:${start}:${end}`;
      if (signature === previewAppearanceRangeRef.current) return;
      previewAppearanceRangeRef.current = signature;
      const keys = Array.from(
        { length: Math.max(0, end - start) },
        (_value, index) => {
          const pageIndex = start + index;
          return previewPageHasVisibleContent[pageIndex]
            ? (previewPageAppearanceKeys[pageIndex] ?? "")
            : "";
        },
      ).filter((key) => key.length > 0);
      if (keys.length === 0) return;
      setEnteredPreviewPageKeys((current) => {
        if (keys.every((key) => current.has(key))) return current;
        const next = new Set(current);
        keys.forEach((key) => next.add(key));
        return next;
      });
    },
    [
      artwork.ready,
      font.ready,
      previewUnavailable,
      layout.height,
      previewContentGeneration,
      previewPageOffsets,
      previewPageHasVisibleContent,
      previewPages,
      previewPageAppearanceKeys,
      updatePreviewPageWindow,
    ],
  );
  const handlePreviewScrollOffset = useCallback(
    (offset: number, state: LongTextScrollState): void => {
      applyPreviewScrollOffset(offset);
      markPreviewPages(offset);
      if (previewScrollFinishing && state.settled) {
        setPreviewScrollFinishing(false);
      }
    },
    [applyPreviewScrollOffset, markPreviewPages, previewScrollFinishing],
  );
  const previewScrollMotion = useLongTextScroll({
    initialPosition: previewScrollTarget,
    target: previewMotionTarget,
    maxScroll: previewMaxScroll,
    resetKey: previewAppearanceBase,
    enabled: !previewUnavailable,
    suspended: !previewPlaying && !previewScrollFinishing,
    onOffsetChange: handlePreviewScrollOffset,
  });
  const setPreviewScrollTarget = useCallback(
    (target: number): void => {
      previewMotionTargetRef.current = target;
      previewScrollMotion.setTarget(target);
    },
    [previewScrollMotion],
  );
  const handlePreviewWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>): void => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      previewManuallyBrowsingRef.current = true;
      const scale =
        Number.isFinite(previewScale) && previewScale > 0 ? previewScale : 1;
      const delta =
        event.deltaMode === 1
          ? (event.deltaY * 40) / scale
          : event.deltaMode === 2
            ? event.deltaY * layout.height
            : event.deltaY / scale;
      const state = previewScrollMotion.getState();
      const target = clamp(state.target + delta, 0, previewMaxScroll);
      setPreviewScrollTarget(target);
      setPreviewMotionTarget(target);
      if (!previewPlaying && !previewScrollFinishing) {
        previewScrollMotion.setPosition(target);
        applyPreviewScrollOffset(target);
        markPreviewPages(target);
      }
    },
    [
      applyPreviewScrollOffset,
      layout.height,
      markPreviewPages,
      previewMaxScroll,
      previewPlaying,
      previewScale,
      previewScrollFinishing,
      previewScrollMotion,
      setPreviewScrollTarget,
    ],
  );
  useLayoutEffect(() => {
    if (
      previewUnavailable ||
      !previewPlaying ||
      previewManuallyBrowsingRef.current ||
      previewActiveCursorPositions.length === 0 ||
      previewSession.state.revealedCount <= 0
    ) {
      return;
    }
    const revealIndex = previewSession.state.revealedCount - 1;
    const cursorY = previewActiveCursorPositions[revealIndex];
    if (cursorY === undefined) return;
    const state = previewScrollMotion.getState();
    const cursorViewportY = cursorY - state.position;
    const guard = layout.height * 0.76;
    if (cursorViewportY < guard) return;
    const target = clamp(cursorY - layout.height * 0.62, 0, previewMaxScroll);
    if (Math.abs(target - state.target) <= 0.5) return;
    setPreviewScrollTarget(target);
    queueMicrotask(() => {
      if (previewMotionTargetRef.current === target) {
        setPreviewMotionTarget(target);
      }
    });
  }, [
    layout.height,
    previewActiveCursorPositions,
    previewMaxScroll,
    previewPlaying,
    previewScrollMotion,
    previewSession.state.revealedCount,
    previewUnavailable,
    setPreviewScrollTarget,
  ]);
  useLayoutEffect(() => {
    const targetChanged =
      previewPreviousTargetRef.current !== previewScrollTarget;
    const appearanceChanged =
      previewPreviousAppearanceBaseRef.current !== previewAppearanceBase;
    const stepChanged = previewPreviousStepRef.current !== safePreviewStepIndex;
    const contentChanged =
      previewPreviousContentRef.current !== previewContentGeneration;
    previewPreviousTargetRef.current = previewScrollTarget;
    previewPreviousAppearanceBaseRef.current = previewAppearanceBase;
    previewPreviousStepRef.current = safePreviewStepIndex;
    previewPreviousContentRef.current = previewContentGeneration;
    if (
      previewUnavailable ||
      (!previewPlaying &&
        (targetChanged || appearanceChanged || stepChanged || contentChanged))
    ) {
      previewMotionTargetRef.current = previewScrollTarget;
      previewScrollMotion.setPosition(previewScrollTarget, false);
      queueMicrotask(() => {
        if (previewMotionTargetRef.current === previewScrollTarget) {
          setPreviewMotionTarget(previewScrollTarget);
        }
      });
      applyPreviewScrollOffset(previewScrollTarget);
      const frame = requestAnimationFrame(() => {
        markPreviewPages(previewScrollTarget);
      });
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [
    applyPreviewScrollOffset,
    markPreviewPages,
    previewPlaying,
    previewAppearanceBase,
    previewContentGeneration,
    previewScrollMotion,
    previewScrollTarget,
    previewUnavailable,
    safePreviewStepIndex,
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
        setPreviewReplayEpoch((current) => current + 1);
        replacePreviewSession(createPreviewSession(normalized));
      } else {
        previewSessionRef.current = null;
        setPreviewRun(null);
      }
      previewManuallyBrowsingRef.current = false;
      setPreviewScrollFinishing(false);
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
    setPreviewScrollFinishing(true);
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
      if (isContinuation) return;
      const next = { ...draftRef.current, layout: nextLayout };
      if (commit) commitNode(next);
      else replaceDraft(next);
    },
    [commitNode, isContinuation, replaceDraft],
  );

  const beginGesture = (
    event: ReactPointerEvent<HTMLElement>,
    mode: LayoutGestureMode,
  ): void => {
    if (event.button !== 0 || isContinuation) return;
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
      if (
        isContinuation &&
        (field === "font_size" ||
          field === "layout" ||
          field === "pagination" ||
          field === "paper" ||
          field === "text_color")
      ) {
        return;
      }
      commitNode({ ...draftRef.current, [field]: value });
    },
    [commitNode, isContinuation],
  );

  const updateLayoutField = (
    field: keyof LongTextLayout,
    value: number,
  ): void => {
    if (isContinuation) return;
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
    visibility: artwork.ready ? undefined : "hidden",
    ...(artwork.url === undefined || paperSource?.animation !== undefined
      ? {}
      : {
          backgroundImage: `url(${JSON.stringify(artwork.url)})`,
          backgroundSize: `100% ${layout.page_height}px`,
        }),
  } as CSSProperties;
  const textSurfaceStyle = {
    visibility: artwork.ready ? undefined : "hidden",
    height: `${previewSurfaceHeight}px`,
    "--long-text-padding-x": `${layout.padding_x}px`,
    "--long-text-padding-y": `${layout.padding_y}px`,
    fontSize: `${presentationFontSize}px`,
  } as CSSProperties;
  const measureStyle = {
    color: presentationTextColor,
    fontSize: `${presentationFontSize}px`,
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
          <button
            disabled={previewUnavailable}
            onClick={togglePreviewPlayback}
            type="button"
          >
            {previewPlaying ? "暂停预览" : "播放预览"}
          </button>
          <button
            disabled={previewUnavailable || previewComplete}
            onClick={completePreviewStep}
            type="button"
          >
            补全
          </button>
          <button
            disabled={
              previewUnavailable ||
              (previewComplete &&
                safePreviewStepIndex >= previewSteps.length - 1)
            }
            onClick={advancePreviewStep}
            type="button"
          >
            下一分段
          </button>
          <button
            disabled={previewUnavailable}
            onClick={() => resetPreview(0)}
            type="button"
          >
            从头重播
          </button>
          <span>
            {previewUnavailable
              ? "等待真实上下文"
              : `${safePreviewStepIndex + 1} / ${previewSteps.length}`}
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
              {backgroundSource === undefined ? (
                <div className="long-text-workspace-empty-background">
                  当前场景没有可达的背景节点
                </div>
              ) : (
                <AnimatedImage
                  alt=""
                  className="long-text-workspace-background"
                  paused={!previewPlaying}
                  source={backgroundSource}
                />
              )}
              {previewUnavailable && (
                <div className="long-text-workspace-preview-unavailable">
                  等待 Rust 真实路径后显示累计文稿
                </div>
              )}
              <div className="long-text-workspace-grid" />
              <div
                className={`long-text-workspace-box${gestureActive ? " is-dragging" : ""}`}
                onPointerDown={(event) => beginGesture(event, "move")}
                style={{
                  color: presentationTextColor,
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
                    <MeasuredMarkup
                      fontFamily={font.fontFamily}
                      fontReady={font.ready}
                      key={step.id}
                      measurementScale={previewScale}
                      onLayout={stepLayoutCallbacks.get(step.id)}
                      source={previewSourceById.get(step.id) ?? ""}
                    />
                  ))}
                </div>
                <div className="long-text-workspace-window">
                  <div
                    className="long-text-workspace-surface"
                    ref={previewBackgroundStackRef}
                    style={{ height: `${previewSurfaceHeight}px` }}
                  >
                    {renderedPreviewPages.map(({ page, index, top }) => (
                      <div
                        className={`long-text-workspace-paper-background${enteredPreviewPageKeys.has(previewPageAppearanceKeys[index] ?? "") ? " is-entered" : ""}`}
                        key={page.index}
                        style={{
                          ...paperArtworkStyle,
                          height: `${page.height}px`,
                          top: `${top}px`,
                        }}
                      >
                        {paperSource !== undefined && (
                          <AnimatedImage
                            alt=""
                            className="long-text-workspace-paper-artwork"
                            paused={!previewPlaying}
                            source={paperSource}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                  <div
                    className="long-text-workspace-text-clip"
                    onWheel={handlePreviewWheel}
                    style={
                      {
                        "--long-text-fade": `${Math.min(96, layout.height / 4)}px`,
                      } as CSSProperties
                    }
                  >
                    <div
                      className="long-text-workspace-surface"
                      ref={previewTextStackRef}
                      style={textSurfaceStyle}
                    >
                      {renderedPreviewPages.map(({ page, index, top }) => (
                        <article
                          className={`long-text-workspace-paper${enteredPreviewPageKeys.has(previewPageAppearanceKeys[index] ?? "") ? " is-entered" : ""}`}
                          key={page.index}
                          style={{
                            height: `${page.height}px`,
                            top: `${top}px`,
                          }}
                        >
                          <div className="long-text-workspace-paper-inner">
                            <div className="long-text-workspace-paper-stage">
                              {page.fragments.map((fragment) => {
                                const fragmentStepIndex =
                                  previewStepIndexById.get(fragment.itemId) ??
                                  -1;
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
                                      <MeasuredMarkup
                                        fontFamily={font.fontFamily}
                                        fontReady={font.ready}
                                        measurementScale={previewScale}
                                        reveal={previewAnimation}
                                        source={
                                          previewSourceById.get(
                                            fragment.itemId,
                                          ) ?? ""
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
                            </div>
                          </div>
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
                {previewContextBusy
                  ? "自动：正在构建真实预览…"
                  : previewBackgroundId === null
                    ? "自动：无背景"
                    : `自动：${previewBackgroundId}`}
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
          <h3>同文稿节点</h3>
          <p className="long-text-workspace-note">
            文稿 ID：<code>{documentId}</code>
          </p>
          <ul className="long-text-workspace-document-list">
            {sameDocumentNodes.map((candidate) => (
              <li
                className={candidate.id === nodeId ? "is-current" : undefined}
                key={candidate.id}
              >
                <code>{candidate.id}</code>
                <span>{candidate.mode === "continue" ? "接续" : "开始"}</span>
              </li>
            ))}
          </ul>
          <div className="long-text-workspace-context-status">
            {previewContextBusy ? "正在构建真实路径…" : previewContextStatus}
          </div>
          {pendingChoice !== null && (
            <div className="long-text-workspace-choice-wizard">
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
          {previewContextError !== null && (
            <div className="long-text-workspace-warning">
              <strong>真实预览诊断</strong>
              <div>{previewContextError}</div>
            </div>
          )}
          <label>
            纸张素材
            <select
              disabled={isContinuation}
              onChange={(event) =>
                updateField(
                  "paper",
                  event.currentTarget.value === ""
                    ? null
                    : event.currentTarget.value,
                )
              }
              value={presentationPaper ?? ""}
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
              disabled={isContinuation}
              label="字号"
              min={16}
              value={presentationFontSize}
              onChange={(value) => updateField("font_size", value)}
            />
            <TextColorField
              disabled={isContinuation}
              label="正文颜色"
              value={presentationTextColor}
              onChange={(value) => updateField("text_color", value)}
            />
          </div>
          <label>
            分页方式
            <select
              disabled={isContinuation}
              onChange={(event) =>
                updateField(
                  "pagination",
                  event.currentTarget.value as LongTextNode["pagination"],
                )
              }
              value={presentationPagination}
            >
              <option value="continuous">连续长卷</option>
              <option value="auto">自动分页</option>
              <option value="manual">仅手动分页</option>
            </select>
          </label>
          <h3>文本区域（设计像素）</h3>
          {isContinuation && (
            <p className="long-text-workspace-note">
              接续节点继承开始节点的纸张、分页、字号、颜色和布局；请在开始节点编辑这些属性。
            </p>
          )}
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
                disabled={isContinuation}
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
          <h3>当前节点步骤</h3>
          <p className="long-text-workspace-note">
            前序步骤来自 Rust
            真实上下文并保持只读；这里的文本在失去焦点时写回当前节点。
          </p>
          <div className="long-text-workspace-step-editor-list">
            {draft.steps.map((step, index) => (
              <label key={`${step.id}:${step.text}`}>
                <span>
                  第 {index + 1} 段 · <code>{step.id}</code>
                </span>
                <textarea
                  defaultValue={step.text}
                  onBlur={(event) => {
                    const text = event.currentTarget.value;
                    const nextSteps = draftRef.current.steps.map((candidate) =>
                      candidate.id === step.id
                        ? { ...candidate, text }
                        : candidate,
                    );
                    updateField("steps", nextSteps);
                  }}
                  rows={4}
                />
                {index > 0 && (
                  <button onClick={() => onSplitLongText(index)} type="button">
                    从此步骤前拆分为接续文稿
                  </button>
                )}
              </label>
            ))}
          </div>
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
  disabled = false,
  label,
  min,
  max,
  value,
  onChange,
}: {
  disabled?: boolean;
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
        disabled={disabled}
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
  disabled = false,
  label,
  value,
  onChange,
}: {
  disabled?: boolean;
  label: string;
  value: string;
  onChange(value: string): void;
}): ReactElement {
  return (
    <label className="long-text-workspace-number">
      <span>{label}</span>
      <input
        disabled={disabled}
        maxLength={9}
        onChange={(event) => onChange(event.currentTarget.value)}
        pattern="#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})"
        type="text"
        value={value}
      />
    </label>
  );
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
