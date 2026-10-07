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
import { assetUrl, editorApi } from "../api";
import {
  BookOpenText,
  ChevronsRight,
  Pause,
  Play,
  RotateCcw,
  StepForward,
} from "lucide-react";
import { WorkspaceHeader } from "../shell/WorkspaceHeader";
import { Button } from "../ui/Button";
import { projectRequest } from "../story";
import { withPreviewBackground } from "../presentationPreview";
import { previewAssetsToUrls } from "../api";
import { buildEditorVisualResources, EMPTY_EDITOR_VISUALS, type EditorVisualResources } from "../visualResources";
import {
  selectGameplayFont,
  useGameplayFont,
  LongTextPanel,
  SceneCanvas,
  ButtonLayer,
  type LongTextPanelHandle,
} from "@vectspace/presentation-react/gameplay";
import type {
  LongTextPageSnapshot,
  LongTextPrompt,
  TextRevealAnimation,
  RuntimeUpdate,
} from "@vectspace/presentation-core/types";
import { UiMotionHost } from "@vectspace/presentation-core/ui-motion";
import { MUTED_PREVIEW_SETTINGS } from "./timelinePreview";
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
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import { editorImageSource } from "../imageAnimationMap";
import { AnimatedImage } from "@vectspace/presentation-react/animated-image";
import { AssetChooser } from "./AssetChooser";
import { ColorSwatch, DeferredInput, DeferredTextArea } from "./Fields";
import { escapeTextEntry, isComposing } from "../ui/keyboard";

/**
 * The editor renders the shared panel but plays no typing sfx: the signal is
 * still produced by the real component, this host simply does not act on it.
 */
function ignoreTypingChange(): void {
  // Intentionally silent.
}

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
 * the same 1920×1080 coordinate system as the game.  The document itself is
 * rendered by the shared in-game `LongTextPanel` (paper artwork, pagination,
 * reveal clock and scrolling are the player's), while this workspace owns the
 * Rust-reconstructed retained context, the layout gizmo, the inspector and the
 * step textareas.
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
  const [revealCompleteKey, setRevealCompleteKey] = useState<string | null>(
    null,
  );
  const [gestureActive, setGestureActive] = useState(false);
  const [backgroundChoice, setBackgroundChoice] = useState("__current__");
  const [previewStepIndex, setPreviewStepIndex] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewReplayEpoch, setPreviewReplayEpoch] = useState(0);
  const [previewBackgroundId, setPreviewBackgroundId] = useState<string | null>(
    null,
  );
  const [sceneUpdate, setSceneUpdate] = useState<RuntimeUpdate | null>(null);
  const [visuals, setVisuals] = useState<EditorVisualResources>(EMPTY_EDITOR_VISUALS);
  const [resolvedSceneUrls, setResolvedSceneUrls] = useState<Record<string, string> | null>(null);
  const sceneUrls = useMemo(
    () =>
      Object.fromEntries(
        assets.map((asset) => [asset.id, assetUrl(asset.absolute_path)]),
      ),
    [assets],
  );
  const uiMotionHost = useMemo(() => new UiMotionHost(), []);
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
    useState("尚未生成预览");
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
  const longTextPanelRef = useRef<LongTextPanelHandle>(null);

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
  const sceneDisplayUpdate = useMemo(
    () =>
      sceneUpdate === null
        ? null
        : {
            ...sceneUpdate,
            snapshot: {
              ...sceneUpdate.snapshot,
              world: backgroundChoice === "__current__" ? sceneUpdate.snapshot.world
                : withPreviewBackground(sceneUpdate.snapshot.world, backgroundId),
            },
            // This is an authoring still, not a second runtime presentation. Drawing
            // only the resolved snapshot keeps inherited scene objects without
            // replaying sounds or transitions when an author changes the background.
            cues: [],
          },
    [sceneUpdate, backgroundId, backgroundChoice],
  );
  const backgroundAsset =
    backgroundId === null ? undefined : assetsById.get(backgroundId);
  const backgroundSource = editorImageSource(
    backgroundAsset,
    assets,
    animationMap,
  );
  // The shared gameplay font facility registers the project font under the
  // exact family `gameplay.css` asks for, so long-text measurement, reveal and
  // pagination use the same metrics (and the same cache identity) as the game.
  const fontAsset = useMemo(
    () => selectGameplayFont(project.manifest.default_font, assets),
    [assets, project.manifest.default_font],
  );
  const gameplayFont = useGameplayFont(
    fontAsset === undefined ? undefined : assetUrl(fontAsset.absolute_path),
  );
  const fontKey = fontAsset?.id ?? "system";
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
  // `undefined` means the document declares no paper at all; `null` means one
  // was authored but cannot be resolved, which the shared panel renders as a
  // transparent page instead of a missing image.
  const paperSource =
    presentationPaper === null || presentationPaper === undefined
      ? undefined
      : paperAsset === undefined
        ? null
        : (editorImageSource(paperAsset, assets, animationMap) ?? null);
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
      setPreviewPlaying(false);
      setSceneUpdate(null);
      setPreviewReplayEpoch(0);
      setRevealCompleteKey(null);
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
        setPreviewPlaying(false);
        setPreviewContextStatus(
          `已捕获真实进入状态（${result.trace.length} 个边界）`,
        );
        setPreviewUnavailable(false);
        // Hosts that predate resolved preview assets fall back to the draft's
        // registered files (`project` is already this effect's dependency).
        const urls =
          result.assets === undefined
            ? Object.fromEntries(
                project.assets.map((asset) => [
                  asset.id,
                  assetUrl(asset.absolute_path),
                ]),
              )
            : previewAssetsToUrls(result.assets);
        setVisuals(buildEditorVisualResources(project, urls, result));
        setResolvedSceneUrls(urls);
        setSceneUpdate(result.update);
        const world = result.update.snapshot.world;
        const source = world.sprites.__background__?.source;
        setPreviewBackgroundId(source?.type === "image" ? source.asset : world.background ?? null);
      } catch (error: unknown) {
        if (generation !== previewRequestGeneration.current) return;
        setPreviewContextError(
          error instanceof Error ? error.message : "真实预览构建失败",
        );
        setPreviewContextStatus("上下文构建失败");
        setResolvedStepTexts({});
        setPreviewDocumentSteps([]);
        setPreviewUnavailable(true);
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
  const previewStep = previewSteps[safePreviewStepIndex];
  const previewAnimation: TextRevealAnimation =
    draft.reveal_animation ?? "typewriter";
  const previewCps = draft.speed_cps ?? 30;
  // The shared panel owns reveal, pagination and scroll.  Its instance key
  // covers every authored input a viewer can see, so editing the shown step,
  // its text, the speed, the animation or replaying presents a fresh reveal
  // (with fresh measurements) while a layout-only edit simply re-measures.
  const previewSessionKey = JSON.stringify([
    documentId,
    previewStep?.id ?? "",
    previewStep === undefined
      ? ""
      : (previewSourceById.get(previewStep.id) ?? ""),
    previewCps,
    previewAnimation,
    previewReplayEpoch,
  ]);
  const previewDocument = useMemo<LongTextPageSnapshot>(
    () => ({
      document_id: documentId,
      visible: !previewUnavailable,
      paper: presentationPaper ?? null,
      pagination: presentationPagination,
      font_size: presentationFontSize,
      text_color: presentationTextColor,
      layout,
      steps: previewSteps.map((step) => ({
        step_id: step.id,
        text: previewSourceById.get(step.id) ?? step.text,
        page_break_before: step.page_break_before,
      })),
      active_step_index: safePreviewStepIndex,
    }),
    [
      documentId,
      layout,
      presentationFontSize,
      presentationPagination,
      presentationPaper,
      presentationTextColor,
      previewSourceById,
      previewSteps,
      previewUnavailable,
      safePreviewStepIndex,
    ],
  );
  // Only the step under the playhead is a live prompt: the shared panel reveals
  // exactly this text and shows every earlier step in its final state, which is
  // the game's retained-document behaviour.
  const previewPrompt = useMemo<LongTextPrompt | null>(() => {
    if (previewUnavailable || previewStep === undefined) return null;
    return {
      kind: "long_text",
      prompt_id: `${documentId}/${previewStep.id}`,
      document_id: documentId,
      step_id: previewStep.id,
      step_index: safePreviewStepIndex,
      text: previewSourceById.get(previewStep.id) ?? previewStep.text,
      is_read: false,
    };
  }, [
    documentId,
    previewSourceById,
    previewStep,
    previewUnavailable,
    safePreviewStepIndex,
  ]);
  const previewComplete = revealCompleteKey === previewSessionKey;
  const handleRevealComplete = useCallback((instanceKey: string): void => {
    setRevealCompleteKey(instanceKey);
  }, []);
  const goToPreviewStep = useCallback(
    (stepIndex: number): void => {
      setPreviewStepIndex(
        clamp(stepIndex, 0, Math.max(0, previewSteps.length - 1)),
      );
      setPreviewPlaying(false);
    },
    [previewSteps.length],
  );
  const togglePreviewPlayback = useCallback((): void => {
    if (previewComplete) {
      // Pausing is not a state a finished reveal can return from: replay the
      // current step from its first unit and let it run.
      setPreviewReplayEpoch((current) => current + 1);
      setPreviewPlaying(true);
      return;
    }
    setPreviewPlaying((current) => !current);
  }, [previewComplete]);
  const completePreviewStep = useCallback((): void => {
    longTextPanelRef.current?.complete();
  }, []);
  const advancePreviewStep = useCallback((): void => {
    if (!previewComplete) {
      completePreviewStep();
      return;
    }
    if (safePreviewStepIndex >= previewSteps.length - 1) return;
    goToPreviewStep(safePreviewStepIndex + 1);
  }, [
    completePreviewStep,
    goToPreviewStep,
    previewComplete,
    previewSteps.length,
    safePreviewStepIndex,
  ]);
  const replayPreview = useCallback((): void => {
    setPreviewStepIndex(0);
    setPreviewReplayEpoch((current) => current + 1);
    setPreviewPlaying(false);
  }, []);

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
    event.currentTarget.setPointerCapture?.(event.pointerId);
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
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
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
      if (event.defaultPrevented || isComposing(event)) return;
      if (escapeTextEntry(event)) return;
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
  } as CSSProperties;
  const gizmoStyle = {
    height: `${layout.height}px`,
    left: `${layout.x}px`,
    top: `${layout.y}px`,
    width: `${layout.width}px`,
  } as CSSProperties;

  return (
    <main className="long-text-workspace">
      <WorkspaceHeader
        dirty={dirty}
        icon={BookOpenText}
        kind="长文本"
        onBack={onBack}
        onRedo={onRedo}
        onSave={onSave}
        onUndo={onUndo}
        redoAvailable={redoAvailable}
        title={nodeId}
        undoAvailable={undoAvailable}
      >
        <div className="workspace-transport">
          <Button
            disabled={previewUnavailable}
            icon={previewPlaying ? Pause : Play}
            onClick={togglePreviewPlayback}
            size="sm"
          >
            {previewPlaying ? "暂停预览" : "播放预览"}
          </Button>
          <Button
            disabled={previewUnavailable || previewComplete}
            icon={ChevronsRight}
            onClick={completePreviewStep}
            size="sm"
            title="立即显示本段全部文字"
            variant="ghost"
          >
            补全
          </Button>
          <Button
            disabled={
              previewUnavailable ||
              (previewComplete &&
                safePreviewStepIndex >= previewSteps.length - 1)
            }
            icon={StepForward}
            onClick={advancePreviewStep}
            size="sm"
            variant="ghost"
          >
            下一分段
          </Button>
          <Button
            disabled={previewUnavailable}
            icon={RotateCcw}
            onClick={replayPreview}
            size="sm"
            variant="ghost"
          >
            从头重播
          </Button>
          <span className="workspace-transport-readout">
            {previewUnavailable
              ? "正在准备预览…"
              : `第 ${safePreviewStepIndex + 1} / ${previewSteps.length} 段`}
          </span>
        </div>
      </WorkspaceHeader>

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
              {sceneUpdate !== null && !previewUnavailable ? (
                <>
                  <SceneCanvas
                    animations={animationMap}
                    assets={resolvedSceneUrls ?? sceneUrls}
                    textBlocks={visuals.textBlocks}
                    particles={visuals.particles}
                    key={backgroundChoice}
                    onDiagnostic={setPreviewContextError}
                    onSettled={() => undefined}
                    paused
                    playbackRate={1}
                    settings={MUTED_PREVIEW_SETTINGS}
                    suppressOneShots
                    typingSfxActive={false}
                    typingSfxCps={0}
                    uiMotionHost={uiMotionHost}
                    update={sceneDisplayUpdate}
                    visible
                  />
                  <ButtonLayer
                    animations={animationMap}
                    assets={sceneUrls}
                    disabled
                    onClick={() => undefined}
                    paused
                    playbackRate={1}
                    snapshot={sceneUpdate.snapshot}
                    timeline={null}
                  />
                </>
              ) : backgroundSource === undefined ? (
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
                  正在准备预览，稍后显示之前各步骤的文稿
                </div>
              )}
              <div className="long-text-workspace-grid" />
              {!previewUnavailable && (
                <LongTextPanel
                  defaultCps={previewCps}
                  designScale={previewScale}
                  disabled={previewUnavailable}
                  fastForward={false}
                  fontKey={fontKey}
                  fontReady={gameplayFont.ready}
                  initialCps={previewCps}
                  onRevealComplete={handleRevealComplete}
                  onTypingChange={ignoreTypingChange}
                  page={previewDocument}
                  paperSource={paperSource}
                  prompt={previewPrompt}
                  ref={longTextPanelRef}
                  revealAnimation={previewAnimation}
                  revealImmediately={false}
                  sessionKey={previewSessionKey}
                  suspended={!previewPlaying}
                  visible={!previewUnavailable}
                />
              )}
              <div
                className={`long-text-workspace-gizmo${gestureActive ? " is-dragging" : ""}`}
                style={gizmoStyle}
              >
                <div
                  aria-label="拖动长文本区域"
                  className="long-text-workspace-drag-handle"
                  onPointerDown={(event) => beginGesture(event, "move")}
                  role="button"
                >
                  {Math.round(layout.width)} × {Math.round(layout.height)}
                </div>
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
            拖动文本块顶部的标签条调整位置，右下角调整大小；默认 10px 吸附，按住
            Shift 可取消吸附。
            预览为真实游戏长文本组件，滚轮或拖动可直接滚动累计文稿（1920×1080
            设计像素）。
          </div>
        </div>

        <aside className="long-text-workspace-inspector">
          <h3>预览与布局</h3>
          <label>
            当前背景（仅编辑器）
            <AssetChooser
              assets={assets}
              extraOptions={[
                {
                  id: "__current__",
                  label: previewContextBusy
                    ? "自动：正在构建真实预览…"
                    : previewBackgroundId === null
                      ? "自动：无背景"
                      : `自动：${previewBackgroundId}`,
                },
                { id: "__none__", label: "无背景" },
              ]}
              kind="background"
              label="当前背景（仅编辑器）"
              onChange={(value) => setBackgroundChoice(value ?? "__none__")}
              value={backgroundChoice}
            />
          </label>
          <p className="long-text-workspace-note">
            预览背景只影响编辑器，不会保存到剧情中；用它检查文字在实际场景里是否清晰可读。
          </p>
          <p className="long-text-workspace-note">
            预览渲染游戏本体的长文本组件（分页、打字机与滚动一致）；pause、speed
            和 auto 只控制播放，不占据正文排版空间。
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
            {previewContextBusy ? "正在准备预览…" : previewContextStatus}
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
            <AssetChooser
              allowEmpty
              assets={assets}
              disabled={isContinuation}
              emptyLabel="透明板书"
              kind="gui"
              label="纸张素材"
              onChange={(value) => updateField("paper", value)}
              value={presentationPaper ?? null}
            />
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
            右侧数值在失焦或按 Enter
            时写入一次撤销记录；拖动操作在松开鼠标时提交。
          </p>
          <h3>当前节点步骤</h3>
          <p className="long-text-workspace-note">
            前面步骤的文稿只读显示；这里的文字在输入框失去焦点时保存到当前节点。
          </p>
          <div className="long-text-workspace-step-editor-list">
            {draft.steps.map((step, index) => (
              <label key={`${step.id}:${step.text}`}>
                <span>
                  第 {index + 1} 段 · <code>{step.id}</code>
                </span>
                <DeferredTextArea
                  rows={4}
                  onCommit={(text) => {
                    const nextSteps = draftRef.current.steps.map((candidate) =>
                      candidate.id === step.id
                        ? { ...candidate, text }
                        : candidate,
                    );
                    updateField("steps", nextSteps);
                  }}
                  value={step.text}
                />
                {index > 0 && (
                  <button onClick={() => onSplitLongText(index)} type="button">
                    从此步骤前拆分为接续文稿
                  </button>
                )}
              </label>
            ))}
          </div>
          {gameplayFont.error !== null && (
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
      <DeferredInput
        disabled={disabled}
        max={max}
        min={min}
        onCommit={(raw) => {
          const next = Number(raw);
          if (raw.trim() === "" || !Number.isFinite(next)) return false;
          onChange(next);
        }}
        step="any"
        type="number"
        value={String(value)}
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
      <span className="inline-field">
        <ColorSwatch
          label={`${label}选择器`}
          onCommit={onChange}
          value={value}
        />
        <DeferredInput
          aria-label={label}
          disabled={disabled}
          maxLength={9}
          onCommit={(raw) => {
            if (!/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(raw)) return false;
            onChange(raw);
          }}
          type="text"
          value={value}
        />
      </span>
    </label>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
