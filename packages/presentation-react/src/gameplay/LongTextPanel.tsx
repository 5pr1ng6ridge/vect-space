import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactElement,
  type WheelEvent,
} from "react";

import {
  buildVisibleUnitCps,
  formulaRevealDurationMs,
  parseMarkup,
  visibleUnits,
} from "@vectspace/text";
import type {
  LongTextPageSnapshot,
  LongTextPrompt,
  TextRevealAnimation,
} from "@vectspace/presentation-core/types";
import { MarkupText } from "./MarkupText";
import { useAnimatedImage, useAnimationPreload } from "../animated-image";
import type { ImageAssetSource } from "@vectspace/presentation-core/image-animation";
import {
  paginateLongTextVisualSteps,
  resolveLongTextPageWindow,
  type LongTextPageWindow,
  type LongTextVisualPage,
} from "./longTextPagination";
import {
  isValidTextMeasurementScale,
  type TextLayoutSnapshot,
} from "@vectspace/text";
import { useLongTextScroll, usePaperArtwork } from "@vectspace/text-react";
import {
  clamp,
  hasReachedLongTextRevealThreshold,
  longTextMaxScroll,
  longTextParagraphTarget,
  longTextFollowTarget,
} from "./longTextScroll";
import { useTextRevealSession } from "./useTextRevealSession";

export interface LongTextPanelHandle {
  complete(): void;
  isComplete(): boolean;
}

interface LongTextPanelProps {
  prompt: LongTextPrompt | null;
  page: LongTextPageSnapshot;
  initialCps: number;
  defaultCps: number;
  disabled: boolean;
  /** null means a configured asset is still resolving; undefined is transparent. */
  /**
   * Resolved paper artwork.  `undefined` means the document declares no paper
   * at all; `null` means one was requested but cannot be resolved.
   */
  paperSource?: ImageAssetSource | null | undefined;
  revealImmediately: boolean;
  /** Per RuntimeUpdate/prompt identity; stable prompt IDs are revisitable. */
  sessionKey?: string;
  revealAnimation?: TextRevealAnimation;
  /** The game viewport scale, used to translate pointer deltas to design pixels. */
  designScale?: number;
  /** Rendering is held until the runtime font has finished loading. */
  fontReady?: boolean;
  /** Identifies the font used by the layout cache. */
  fontKey?: string;
  fastForward: boolean;
  /** Menu/page-hidden suspension freezes both reveal and scroll clocks. */
  suspended?: boolean;
  /** Retained documents stay mounted while hidden so their scroll position is preserved. */
  visible?: boolean;
  onTypingChange(typing: boolean, cps: number): void;
  onRevealComplete(instanceKey: string): void;
}

interface MathRevealMetric {
  widthPx: number;
  fontSizePx: number;
}

interface MetricsForInstance {
  key: string;
  values: ReadonlyMap<number, MathRevealMetric>;
}

const EMPTY_MATH_METRICS: ReadonlyMap<number, MathRevealMetric> = new Map();
const EMPTY_REVEAL_SCHEDULE: readonly number[] = [];
const EMPTY_PAUSE_WINDOWS: readonly { startMs: number; endMs: number }[] = [];
const EMPTY_MATH_REVEAL_DURATIONS: ReadonlyMap<number, number> = new Map();

const LongTextMeasureStep = memo(function LongTextMeasureStep({
  step,
  fontReady,
  designScale,
  onStepLayout,
}: {
  step: LongTextPageSnapshot["steps"][number];
  fontReady: boolean;
  designScale: number;
  onStepLayout(stepId: string, snapshot: TextLayoutSnapshot): void;
}): ReactElement {
  const handleTextLayout = useCallback(
    (snapshot: TextLayoutSnapshot): void => onStepLayout(step.step_id, snapshot),
    [onStepLayout, step.step_id],
  );
  return (
    <div className="long-text-step long-text-measure-step">
      <MarkupText
        fontReady={fontReady}
        measurementScale={designScale}
        onTextLayout={handleTextLayout}
        source={step.text}
      />
    </div>
  );
});

export const LongTextPanel = forwardRef<
  LongTextPanelHandle,
  LongTextPanelProps
>(function LongTextPanel(
  {
    prompt,
    page,
    initialCps,
    defaultCps,
    disabled,
    paperSource,
    revealImmediately,
    sessionKey,
    revealAnimation = "typewriter",
    designScale = 1,
    fontReady = true,
    fontKey = "system",
    fastForward,
    suspended = false,
    visible = true,
    onTypingChange,
    onRevealComplete,
  },
  ref,
): ReactElement {
  // A retained document can coexist with dialogue, choices, or a neutral
  // prompt. Only a current long-text prompt is an active reveal; when the
  // document is merely being kept visible every accumulated step is static.
  const activeStep =
    prompt === null ? undefined : page.steps[page.active_step_index];
  const activeStepId = prompt?.step_id ?? "retained";
  const activeText = prompt?.text ?? "";
  const instanceKey =
    sessionKey ?? prompt?.prompt_id ?? `${page.document_id}/${activeStepId}`;
  const units = useMemo(() => parseMarkup(activeText), [activeText]);
  const unitCps = useMemo(
    () => buildVisibleUnitCps(units, initialCps, defaultCps),
    [defaultCps, initialCps, units],
  );
  const mathUnitCount = useMemo(
    () => units.filter((unit) => unit.kind === "math").length,
    [units],
  );
  const [metrics, setMetrics] = useState<MetricsForInstance>(() => ({
    key: instanceKey,
    values: new Map(),
  }));
  const mathRevealMetrics =
    metrics.key === instanceKey ? metrics.values : EMPTY_MATH_METRICS;
  const mathRevealDurations = useMemo(() => {
    const result = new Map<number, number>();
    for (const [index, metric] of mathRevealMetrics) {
      result.set(
        index,
        formulaRevealDurationMs(
          metric.widthPx,
          metric.fontSizePx,
          unitCps[index] ?? 30,
        ),
      );
    }
    return result;
  }, [mathRevealMetrics, unitCps]);
  const [lineSweepReadyKey, setLineSweepReadyKey] = useState<string | null>(
    null,
  );
  const layout = page.layout;
  const stepLayoutKeys = useMemo(() => {
    const result: Record<string, string> = {};
    for (const step of page.steps) {
      result[step.step_id] = JSON.stringify([
        page.document_id,
        step.step_id,
        step.text,
        page.font_size,
        layout.width,
        layout.padding_x,
        fontKey,
        fontReady ? "ready" : "pending",
      ]);
    }
    return result;
  }, [
    fontKey,
    fontReady,
    layout.padding_x,
    layout.width,
    page.document_id,
    page.font_size,
    page.steps,
  ]);
  const [stepLayouts, setStepLayouts] = useState<
    Readonly<Record<string, { key: string; snapshot: TextLayoutSnapshot }>>
  >({});
  const [scrollPreparedKey, setScrollPreparedKey] = useState<string | null>(
    null,
  );
  const [pageWindow, setPageWindow] = useState({ start: 0, end: 0 });
  const [fragmentWindow, setFragmentWindow] = useState({ start: 0, end: 0 });
  const [enteredPageKeys, setEnteredPageKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [appearanceGeneration, setAppearanceGeneration] = useState(0);
  const pageWindowRef = useRef(pageWindow);
  const fragmentWindowRef = useRef(fragmentWindow);
  const pendingCompleteRef = useRef(false);
  const measuringRootRef = useRef<HTMLDivElement>(null);
  const surfaceStackRef = useRef<HTMLDivElement>(null);
  const textStackRef = useRef<HTMLDivElement>(null);
  const scrollOffsetRef = useRef(0);
  const scrollStartOffsetRef = useRef(0);
  const scrollTargetRef = useRef(0);
  const [scrollTarget, setScrollTargetState] = useState(0);
  const appearanceRangeRef = useRef<{
    pages: readonly LongTextVisualPage[];
    start: number;
    end: number;
  } | null>(null);
  const manuallyBrowsingRef = useRef(false);
  const pointerDragRef = useRef<{
    pointerId: number;
    startClientY: number;
    startOffset: number;
    moved: boolean;
  } | null>(null);
  const suppressAdvanceClickRef = useRef(false);
  const pageStepSignature = useMemo(
    () =>
      JSON.stringify(
        page.steps.map((step) => [
          step.step_id,
          step.text,
          step.page_break_before,
        ]),
      ),
    [page.steps],
  );
  const pageLayoutSignature = useMemo(
    () =>
      JSON.stringify([
        page.document_id,
        page.font_size,
        page.text_color,
        page.pagination,
        layout.width,
        layout.height,
        layout.padding_x,
        layout.padding_y,
        layout.page_height,
        layout.page_gap,
      ]),
    [
      layout.height,
      layout.page_gap,
      layout.page_height,
      layout.padding_x,
      layout.padding_y,
      layout.width,
      page.document_id,
      page.font_size,
      page.pagination,
      page.text_color,
    ],
  );
  const pageShapeRef = useRef({
    documentId: page.document_id,
    firstStepId: page.steps[0]?.step_id ?? "",
    firstText: page.steps[0]?.text ?? "",
    stepCount: page.steps.length,
    stepRows: page.steps.map(stepRow),
    stepSignature: pageStepSignature,
    layoutSignature: pageLayoutSignature,
    activeStepIndex: page.active_step_index,
    visible: page.visible !== false,
    instanceKey,
  });
  const handleLineSweepLayoutChange = useCallback(
    (ready: boolean): void => {
      setLineSweepReadyKey(ready ? instanceKey : null);
    },
    [instanceKey],
  );
  const activeLayoutUnits = useMemo(
    () =>
      activeStep === undefined
        ? []
        : visibleUnits(parseMarkup(activeStep.text)),
    [activeStep],
  );
  const activeRevealIndexByLayoutIndex = useMemo(() => {
    const result = new Map<number, number>();
    let revealIndex = 0;
    activeLayoutUnits.forEach((unit, layoutIndex) => {
      if (unit.kind === "hard_break") return;
      result.set(layoutIndex, revealIndex);
      revealIndex += 1;
    });
    return result;
  }, [activeLayoutUnits]);
  // The paper artwork follows the same decorative clock as every other image
  // entry: it advances only while the document is live, and it never restarts
  // when the panel re-renders.
  const paperFrames = useAnimatedImage(paperSource, suspended ?? false);
  useAnimationPreload(paperSource);
  const paperUrl =
    paperSource === undefined ? undefined : (paperFrames.url ?? null);
  const artwork = usePaperArtwork(paperUrl);
  const paperArtworkReady = artwork.ready;
  const applyScrollOffset = useCallback((offset: number): void => {
    scrollOffsetRef.current = offset;
    const transform = `translate3d(0, ${-offset}px, 0)`;
    if (surfaceStackRef.current !== null) {
      surfaceStackRef.current.style.transform = transform;
    }
    if (textStackRef.current !== null) {
      textStackRef.current.style.transform = transform;
    }
  }, []);

  const unmeasuredSteps = useMemo(
    () =>
      page.steps.filter(
        (step) =>
          stepLayouts[step.step_id]?.key !== stepLayoutKeys[step.step_id],
      ),
    [page.steps, stepLayoutKeys, stepLayouts],
  );
  const measurementBatch = useMemo(
    () => unmeasuredSteps.slice(0, 16),
    [unmeasuredSteps],
  );

  const handleStepLayout = useCallback(
    (stepId: string, layoutSnapshot: TextLayoutSnapshot): void => {
      const key = stepLayoutKeys[stepId];
      if (key === undefined) return;
      setStepLayouts((current) => {
        const previous = current[stepId];
        if (
          previous?.key === key &&
          sameTextLayoutSnapshot(previous.snapshot, layoutSnapshot)
        ) {
          return current;
        }
        return { ...current, [stepId]: { key, snapshot: layoutSnapshot } };
      });
    },
    [stepLayoutKeys],
  );

  const layoutReady =
    fontReady &&
    isValidTextMeasurementScale(designScale) &&
    unmeasuredSteps.length === 0;
  const pages = useMemo(
    () =>
      paginateLongTextVisualSteps(
        page.steps,
        Object.fromEntries(
          page.steps.map((step) => {
            const entry = stepLayouts[step.step_id];
            return [
              step.step_id,
              entry !== undefined && entry.key === stepLayoutKeys[step.step_id]
                ? entry.snapshot
                : undefined,
            ] as const;
          }),
        ),
        page.pagination,
        layout.page_height,
        layout.padding_y,
      ),
    [
      layout.page_height,
      layout.padding_y,
      page.pagination,
      page.steps,
      stepLayoutKeys,
      stepLayouts,
    ],
  );
  const pageOffsets = useMemo(() => {
    const offsets: number[] = [];
    let nextOffset = 0;
    for (const paper of pages) {
      offsets.push(nextOffset);
      nextOffset +=
        paper.height + (page.pagination === "continuous" ? 0 : layout.page_gap);
    }
    return offsets;
  }, [layout.page_gap, page.pagination, pages]);
  const fragmentGeometry = useMemo(() => {
    const bounds: { top: number; bottom: number }[] = [];
    const pageStarts: number[] = [];
    pages.forEach((paper, pageIndex) => {
      pageStarts.push(bounds.length);
      paper.fragments.forEach((fragment) => {
        const top =
          (pageOffsets[pageIndex] ?? 0) + layout.padding_y + fragment.top;
        bounds.push({ top, bottom: top + fragment.height });
      });
    });
    return { bounds, pageStarts };
  }, [layout.padding_y, pageOffsets, pages]);
  const surfaceHeight = useMemo(
    () =>
      pages.reduce(
        (total, paper, index) =>
          total +
          paper.height +
          (page.pagination !== "continuous" && index < pages.length - 1
            ? layout.page_gap
            : 0),
        0,
      ),
    [layout.page_gap, page.pagination, pages],
  );
  const maxScroll = longTextMaxScroll(surfaceHeight, layout.height);
  const activeStepGeometry = useMemo(() => {
    if (!layoutReady || activeStep === undefined) return null;
    const fragments = pages.flatMap((candidate, pageIndex) =>
      candidate.fragments
        .filter((fragment) => fragment.step.step_id === activeStep.step_id)
        .map((fragment) => ({ fragment, pageIndex })),
    );
    const first = fragments[0];
    const last = fragments[fragments.length - 1];
    if (first === undefined || last === undefined) return null;
    const start =
      (pageOffsets[first.pageIndex] ?? 0) +
      layout.padding_y +
      first.fragment.top;
    const end =
      (pageOffsets[last.pageIndex] ?? 0) +
      layout.padding_y +
      last.fragment.top +
      last.fragment.height;
    return {
      start,
      height: Math.max(1, end - start),
    };
  }, [activeStep, layout.padding_y, layoutReady, pageOffsets, pages]);
  const activeCursorPositions = useMemo(() => {
    if (activeStep === undefined) return [] as readonly number[];
    const activeLayout = stepLayouts[activeStep.step_id]?.snapshot;
    if (activeLayout === undefined) return [] as readonly number[];
    const linePositions = new Map<number, number>();
    pages.forEach((paper, pageIndex) => {
      paper.fragments.forEach((fragment) => {
        if (fragment.step.step_id !== activeStep.step_id) return;
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
            (pageOffsets[pageIndex] ?? 0) +
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
        const revealIndex = activeRevealIndexByLayoutIndex.get(layoutIndex);
        if (revealIndex !== undefined) result[revealIndex] = position;
      });
    });
    return result;
  }, [
    activeRevealIndexByLayoutIndex,
    activeStep,
    layout.padding_y,
    pageOffsets,
    pages,
    stepLayouts,
  ]);
  const updatePageWindow = useCallback(
    (offset: number): void => {
      const next = resolveLongTextPageWindow(
        pages,
        pageOffsets,
        offset,
        layout.height,
      );
      const current = pageWindowRef.current;
      if (current.start !== next.start || current.end !== next.end) {
        pageWindowRef.current = next;
        setPageWindow(next);
      }
      const nextFragments = resolveFragmentWindow(
        fragmentGeometry.bounds,
        offset,
        layout.height,
      );
      const currentFragments = fragmentWindowRef.current;
      if (
        currentFragments.start !== nextFragments.start ||
        currentFragments.end !== nextFragments.end
      ) {
        fragmentWindowRef.current = nextFragments;
        setFragmentWindow(nextFragments);
      }
    },
    [fragmentGeometry, layout.height, pageOffsets, pages],
  );
  const effectiveFragmentWindow =
    fragmentWindow.end === 0 && fragmentGeometry.bounds.length > 0
      ? resolveFragmentWindow(fragmentGeometry.bounds, 0, layout.height)
      : fragmentWindow;
  const effectivePageWindow =
    pageWindow.end === 0 && pages.length > 0
      ? resolveLongTextPageWindow(pages, pageOffsets, 0, layout.height)
      : pageWindow;
  const renderedPages = useMemo(
    () =>
      pages
        .slice(effectivePageWindow.start, effectivePageWindow.end)
        .map((paper, offset) => {
          const index = effectivePageWindow.start + offset;
          return { paper, index, top: pageOffsets[index] ?? 0 };
        }),
    [effectivePageWindow.end, effectivePageWindow.start, pageOffsets, pages],
  );
  const appearanceBase = useMemo(
    () =>
      JSON.stringify([
        page.document_id,
        page.font_size,
        page.text_color,
        page.pagination,
        layout.width,
        layout.height,
        layout.padding_x,
        layout.padding_y,
        layout.page_height,
        layout.page_gap,
      ]),
    [
      layout.height,
      layout.page_gap,
      layout.page_height,
      layout.padding_x,
      layout.padding_y,
      layout.width,
      page.document_id,
      page.font_size,
      page.pagination,
      page.text_color,
    ],
  );
  const pageAppearanceKey = useCallback(
    (_paper: (typeof pages)[number], index: number): string =>
      `${appearanceBase}:${appearanceGeneration}:${index}`,
    [appearanceBase, appearanceGeneration],
  );
  const pageAppearanceKeys = useMemo(
    () => pages.map((paper, index) => pageAppearanceKey(paper, index)),
    [pageAppearanceKey, pages],
  );

  const markVisiblePages = useCallback(
    (offset: number): void => {
      if (!paperArtworkReady || !layoutReady || !visible) return;
      const visibleWindow = resolveLongTextPageWindow(
        pages,
        pageOffsets,
        offset,
        layout.height,
        0,
      );
      const previous = appearanceRangeRef.current;
      if (
        previous?.pages === pages &&
        previous.start === visibleWindow.start &&
        previous.end === visibleWindow.end
      ) {
        return;
      }
      appearanceRangeRef.current = { pages, ...visibleWindow };
      const keys = Array.from(
        { length: Math.max(0, visibleWindow.end - visibleWindow.start) },
        (_value, index) => {
          return pageAppearanceKeys[visibleWindow.start + index] ?? "";
        },
      );
      if (keys.length === 0) return;
      setEnteredPageKeys((current) => {
        if (keys.every((key) => current.has(key))) return current;
        const next = new Set(current);
        keys.forEach((key) => next.add(key));
        return next;
      });
    },
    [
      paperArtworkReady,
      layoutReady,
      visible,
      layout.height,
      pageOffsets,
      pageAppearanceKeys,
      pages,
    ],
  );

  // MarkupText deliberately gives every unit an explicit visibility style so
  // the reveal clock can hide individual characters.  That means an ancestor
  // `visibility: hidden` is not a sufficient boundary for a retained long
  // text document: a unit can explicitly opt back into visibility.  Publish
  // the page surface only after its paper artwork is settled and while the
  // document is visible.  `display: none` is intentional here; it is the
  // one boundary that cannot be overridden by an inline unit style and it
  // keeps the paper and text stacks in lockstep during hide/show transitions.
  const presentationVisible = visible && paperArtworkReady;

  useLayoutEffect(() => {
    if (!visible) return;
    // A retained document may be hidden while the scroll controller is
    // already settled.  In that case no new RAF callback is emitted when it
    // is shown again, so explicitly enter the currently visible pages.
    markVisiblePages(scrollOffsetRef.current);
  }, [layoutReady, markVisiblePages, paperArtworkReady, visible]);

  const handleMotionOffset = useCallback(
    (offset: number): void => {
      applyScrollOffset(offset);
      updatePageWindow(offset);
      markVisiblePages(offset);
      if (
        scrollPreparedKey !== instanceKey &&
        hasReachedLongTextRevealThreshold({
          startOffset: scrollStartOffsetRef.current,
          targetOffset: scrollTargetRef.current,
          currentOffset: offset,
        })
      ) {
        setScrollPreparedKey(instanceKey);
      }
    },
    [
      applyScrollOffset,
      instanceKey,
      markVisiblePages,
      scrollPreparedKey,
      updatePageWindow,
    ],
  );
  const scrollMotion = useLongTextScroll({
    target: scrollTarget,
    maxScroll,
    fastForward,
    enabled: layoutReady && paperArtworkReady,
    // A retained document remains mounted while hidden, but neither its
    // reveal clock nor its scroll animation should continue off-screen.
    suspended: suspended || !visible,
    initialPosition: 0,
    // The reveal instance changes for every runtime update.  It must not reset
    // the document scroll controller; only a new mounted document resets it.
    resetKey: page.document_id,
    onOffsetChange: handleMotionOffset,
  });
  const setScrollTarget = useCallback(
    (target: number): void => {
      scrollTargetRef.current = target;
      setScrollTargetState(target);
      scrollMotion.setTarget(target);
    },
    [scrollMotion],
  );

  useLayoutEffect(() => {
    const previous = pageShapeRef.current;
    const next = {
      documentId: page.document_id,
      firstStepId: page.steps[0]?.step_id ?? "",
      firstText: page.steps[0]?.text ?? "",
      stepCount: page.steps.length,
      stepRows: page.steps.map(stepRow),
      stepSignature: pageStepSignature,
      layoutSignature: pageLayoutSignature,
      activeStepIndex: page.active_step_index,
      visible: page.visible !== false,
      instanceKey,
    };
    const appendedOnly =
      next.stepCount > previous.stepCount &&
      JSON.stringify(
        page.steps
          .slice(0, previous.stepCount)
          .map((step) => [step.step_id, step.text, step.page_break_before]),
      ) === previous.stepSignature;
    pageShapeRef.current = next;
    // The runtime re-interpolates the *active* step when a variable it reads
    // changes.  That is a refresh of the same reading position, not a new or
    // replaced document: the scroll position and the pages already entered must
    // survive it.  It is recognised by an unchanged instance whose rows differ
    // only in the active step's text.
    const activeTextRefreshed =
      previous.instanceKey === next.instanceKey &&
      previous.documentId === next.documentId &&
      previous.layoutSignature === next.layoutSignature &&
      previous.stepSignature !== next.stepSignature &&
      next.stepCount === previous.stepCount &&
      next.activeStepIndex === previous.activeStepIndex &&
      next.stepRows.every(
        (row, index) =>
          index === next.activeStepIndex ||
          sameStepRow(row, previous.stepRows[index]),
      );
    const replaced =
      previous.documentId !== next.documentId ||
      previous.firstStepId !== next.firstStepId ||
      (previous.firstText !== next.firstText &&
        !(activeTextRefreshed && next.activeStepIndex === 0)) ||
      next.stepCount < previous.stepCount ||
      // Visibility changes preserve the retained document's scroll and pages.
      (next.activeStepIndex === 0 && previous.activeStepIndex > 0);
    const appearanceChanged =
      previous.layoutSignature !== next.layoutSignature ||
      (previous.stepSignature !== next.stepSignature &&
        !appendedOnly &&
        !activeTextRefreshed) ||
      replaced;
    if (appearanceChanged) {
      setAppearanceGeneration((current) => current + 1);
      setEnteredPageKeys(new Set());
      appearanceRangeRef.current = null;
    }
    if (!replaced) return;
    manuallyBrowsingRef.current = false;
    // Keep the controller, refs and both transformed stacks in sync.  This is
    // an explicit replay/document replacement, not a normal step advance.
    scrollStartOffsetRef.current = 0;
    scrollTargetRef.current = 0;
    scrollMotion.setPosition(0);
    scrollMotion.setTarget(0);
    applyScrollOffset(0);
    setScrollTargetState(0);
    setStepLayouts({});
    setMetrics({ key: instanceKey, values: new Map() });
    setScrollPreparedKey(null);
    pendingCompleteRef.current = false;
    const emptyWindow = { start: 0, end: 0 };
    pageWindowRef.current = emptyWindow;
    setPageWindow(emptyWindow);
    fragmentWindowRef.current = emptyWindow;
    setFragmentWindow(emptyWindow);
  }, [
    applyScrollOffset,
    instanceKey,
    page.active_step_index,
    page.document_id,
    page.steps,
    page.visible,
    pageLayoutSignature,
    pageStepSignature,
    scrollMotion,
  ]);

  const setManualScrollPosition = useCallback(
    (position: number): void => {
      scrollMotion.setPosition(position);
      applyScrollOffset(position);
      scrollTargetRef.current = position;
      setScrollTargetState(position);
      scrollMotion.setTarget(position);
    },
    [applyScrollOffset, scrollMotion],
  );

  useLayoutEffect(() => {
    applyScrollOffset(scrollOffsetRef.current);
    updatePageWindow(scrollOffsetRef.current);
  }, [applyScrollOffset, updatePageWindow]);

  const handleMathMetrics = useCallback(
    (index: number, widthPx: number, fontSizePx: number): void => {
      setMetrics((current) => {
        const values: ReadonlyMap<number, MathRevealMetric> =
          current.key === instanceKey ? current.values : EMPTY_MATH_METRICS;
        const previous = values.get(index);
        if (
          previous?.widthPx === widthPx &&
          previous.fontSizePx === fontSizePx &&
          current.key === instanceKey
        ) {
          return current;
        }
        const next = new Map<number, MathRevealMetric>(values);
        next.set(index, { widthPx, fontSizePx });
        return { key: instanceKey, values: next };
      });
    },
    [instanceKey],
  );
  const metricsReady = mathRevealMetrics.size >= mathUnitCount;
  const revealReady =
    scrollPreparedKey === instanceKey &&
    fontReady &&
    metricsReady &&
    (revealAnimation !== "line_sweep" || lineSweepReadyKey === instanceKey);
  const handleSessionComplete = useCallback((): void => {
    // A retained document can stay mounted while the current prompt is a
    // dialogue, choice, or neutral boundary. Its empty reveal session is
    // intentionally static and must not satisfy the game's active prompt
    // completion gate.
    if (prompt === null) return;
    onRevealComplete(instanceKey);
  }, [instanceKey, onRevealComplete, prompt]);
  const session = useTextRevealSession({
    animation: revealAnimation,
    defaultCps,
    initialCps,
    instanceKey,
    mathRevealDurations,
    onComplete: handleSessionComplete,
    ready: revealReady,
    restorePresentation: revealImmediately,
    suspended: suspended || disabled || !visible,
    units,
    waitForInlineMath: revealAnimation !== "drop_fade",
  });
  const revealSchedule = useMemo(
    () => session.plan.events.map((event) => event.atMs),
    [session.plan],
  );
  const completeReveal = session.completeReveal;
  const isSessionComplete = session.isComplete;
  const complete = session.isComplete();
  const renderedVisibleCount = session.state.revealedCount;
  const typingCps =
    unitCps[Math.min(renderedVisibleCount, Math.max(0, unitCps.length - 1))] ??
    initialCps;

  useEffect(() => {
    pendingCompleteRef.current = false;
  }, [instanceKey]);

  useEffect(() => {
    if (pendingCompleteRef.current && scrollPreparedKey === instanceKey) {
      pendingCompleteRef.current = false;
      completeReveal();
    }
  }, [completeReveal, instanceKey, scrollPreparedKey]);

  useImperativeHandle(
    ref,
    () => ({
      complete: () => {
        if (scrollPreparedKey !== instanceKey) {
          pendingCompleteRef.current = true;
          return;
        }
        completeReveal();
      },
      isComplete: isSessionComplete,
    }),
    [completeReveal, instanceKey, isSessionComplete, scrollPreparedKey],
  );

  useEffect(() => {
    const typing =
      prompt !== null &&
      !disabled &&
      !suspended &&
      visible &&
      !complete &&
      session.state.activePause === null;
    onTypingChange(typing, typingCps);
    return () => onTypingChange(false, typingCps);
  }, [
    complete,
    disabled,
    onTypingChange,
    session.state.activePause,
    suspended,
    prompt,
    typingCps,
    visible,
  ]);

  useLayoutEffect(() => {
    if (!layoutReady || activeStep === undefined) return;
    if (scrollPreparedKey === instanceKey) return;
    if (activeStepGeometry === null) return;
    const { start, height: activeHeight } = activeStepGeometry;
    const target = longTextParagraphTarget({
      stepStartY: start,
      stepHeight: activeHeight,
      currentOffset: scrollOffsetRef.current,
      viewportHeight: layout.height,
      maxScroll,
    });
    manuallyBrowsingRef.current = false;
    scrollStartOffsetRef.current = scrollOffsetRef.current;
    setScrollTarget(target);
    if (revealImmediately) {
      scrollMotion.setPosition(target, false);
      applyScrollOffset(target);
      updatePageWindow(target);
    }
    if (
      revealImmediately ||
      hasReachedLongTextRevealThreshold({
        startOffset: scrollStartOffsetRef.current,
        targetOffset: target,
        currentOffset: scrollOffsetRef.current,
      })
    ) {
      const frame = requestAnimationFrame(() => {
        setScrollPreparedKey(instanceKey);
      });
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [
    activeStep,
    applyScrollOffset,
    layout.height,
    layout.padding_y,
    layoutReady,
    maxScroll,
    pageOffsets,
    paperArtworkReady,
    instanceKey,
    revealImmediately,
    scrollMotion,
    scrollPreparedKey,
    activeStepGeometry,
    setScrollTarget,
    updatePageWindow,
  ]);

  // Once a paragraph has started revealing, follow its actual rendered cursor
  // from the immutable visual-line layout instead of querying transformed DOM
  // boxes. This keeps a tall step smooth when it crosses a paper boundary.
  useLayoutEffect(() => {
    if (
      !layoutReady ||
      revealImmediately ||
      activeStepGeometry === null ||
      scrollPreparedKey !== instanceKey ||
      manuallyBrowsingRef.current ||
      renderedVisibleCount <= 0
    ) {
      return;
    }
    const revealIndex = renderedVisibleCount - 1;
    const cursorY =
      activeCursorPositions[revealIndex] ??
      activeStepGeometry.start +
        activeStepGeometry.height *
          (renderedVisibleCount / Math.max(1, session.plan.events.length));
    const currentOffset = scrollOffsetRef.current;
    const followDelta = longTextFollowTarget({
      cursorY: cursorY - currentOffset,
      viewportHeight: layout.height,
      maxScroll,
    });
    if (followDelta === null) return;
    const target = clamp(currentOffset + followDelta, 0, maxScroll);
    if (Math.abs(target - scrollTargetRef.current) <= 0.5) return;
    setScrollTarget(target);
    updatePageWindow(currentOffset);
  }, [
    activeCursorPositions,
    activeStep,
    activeStepGeometry,
    layout.height,
    layout.padding_y,
    layoutReady,
    maxScroll,
    instanceKey,
    renderedVisibleCount,
    revealImmediately,
    setScrollTarget,
    scrollPreparedKey,
    session.plan.events.length,
    stepLayouts,
    updatePageWindow,
  ]);

  const handleWheel = (event: WheelEvent<HTMLElement>): void => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    manuallyBrowsingRef.current = true;
    const scale =
      Number.isFinite(designScale) && designScale > 0 ? designScale : 1;
    const delta =
      event.deltaMode === 1
        ? (event.deltaY * 40) / scale
        : event.deltaMode === 2
          ? event.deltaY * layout.height
          : event.deltaY / scale;
    const next = clamp(scrollMotion.getState().target + delta, 0, maxScroll);
    setScrollTarget(next);
    updatePageWindow(scrollOffsetRef.current);
  };

  const handlePointerDown = (event: PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    pointerDragRef.current = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      startOffset: scrollOffsetRef.current,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLElement>): void => {
    const drag = pointerDragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const scale =
      Number.isFinite(designScale) && designScale > 0 ? designScale : 1;
    const delta = (event.clientY - drag.startClientY) / scale;
    if (!drag.moved && Math.abs(delta) < 5) return;
    drag.moved = true;
    manuallyBrowsingRef.current = true;
    const next = clamp(drag.startOffset - delta, 0, maxScroll);
    setManualScrollPosition(next);
    updatePageWindow(next);
    event.preventDefault();
  };

  const finishPointerDrag = (event: PointerEvent<HTMLElement>): void => {
    const drag = pointerDragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointerDragRef.current = null;
    if (drag.moved) suppressAdvanceClickRef.current = true;
  };

  const style = {
    "--long-text-x": `${layout.x}px`,
    "--long-text-y": `${layout.y}px`,
    "--long-text-width": `${layout.width}px`,
    "--long-text-height": `${layout.height}px`,
    "--long-text-padding-x": `${layout.padding_x}px`,
    "--long-text-padding-y": `${layout.padding_y}px`,
    "--long-text-page-height": `${layout.page_height}px`,
    "--long-text-page-gap": `${layout.page_gap}px`,
    "--long-text-fade": `${Math.min(96, layout.height / 4)}px`,
    "--long-text-font-size": `${page.font_size}px`,
    "--long-text-color": page.text_color,
  } as CSSProperties;

  return (
    <section
      aria-label="长文本"
      className={`long-text-panel${visible ? "" : " is-hidden"}`}
      aria-hidden={!visible}
      onClickCapture={(event) => {
        if (!suppressAdvanceClickRef.current) return;
        suppressAdvanceClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerDrag}
      onPointerCancel={finishPointerDrag}
      onWheel={handleWheel}
      style={style}
    >
      <div
        aria-hidden="true"
        className="long-text-measure-root"
        ref={measuringRootRef}
      >
        {measurementBatch.map((step) => (
          <LongTextMeasureStep
            designScale={designScale}
            fontReady={fontReady}
            key={step.step_id}
            onStepLayout={handleStepLayout}
            step={step}
          />
        ))}
      </div>
      <div
        className="long-text-viewport"
        aria-hidden={!presentationVisible}
        style={
          presentationVisible
            ? undefined
            : { display: "none", visibility: "hidden" }
        }
      >
        <div
          className="long-text-surface-stack"
          ref={surfaceStackRef}
          style={{
            height: `${surfaceHeight}px`,
          }}
        >
          {renderedPages.map(({ paper, top }) => (
            <article
              className={`long-text-paper${paperSource === undefined ? "" : " has-paper-art"}${enteredPageKeys.has(pageAppearanceKeys[paper.index] ?? "") ? " is-entered" : ""}${revealImmediately ? " is-immediate" : ""}`}
              key={paper.index}
              style={{
                height: `${paper.height}px`,
                position: "absolute",
                top: `${top}px`,
                ...(artwork.url !== undefined
                  ? { backgroundImage: `url(${JSON.stringify(artwork.url)})` }
                  : {}),
              }}
            />
          ))}
        </div>
        <div className="long-text-text-clip">
          <div
            className="long-text-text-stack"
            ref={textStackRef}
            style={{
              height: `${surfaceHeight}px`,
            }}
          >
            {renderedPages.map(({ paper, top }) => (
              <article
                className={`long-text-paper-content${enteredPageKeys.has(pageAppearanceKeys[paper.index] ?? "") ? " is-entered" : ""}${revealImmediately ? " is-immediate" : ""}`}
                key={paper.index}
                style={{
                  height: `${paper.height}px`,
                  position: "absolute",
                  top: `${top}px`,
                }}
              >
                <div className="long-text-paper-content-inner">
                  <div className="long-text-paper-content-stage">
                    {paper.fragments.map((fragment, fragmentIndex) => {
                      const current = fragment.step.step_id === activeStepId;
                      const index =
                        (fragmentGeometry.pageStarts[paper.index] ?? 0) +
                        fragmentIndex;
                      if (
                        !current &&
                        (index < effectiveFragmentWindow.start ||
                          index >= effectiveFragmentWindow.end)
                      ) {
                        return null;
                      }
                      return (
                        <div
                          className="long-text-step-fragment"
                          key={`${fragment.step.step_id}:${fragment.sourceTop}`}
                          style={{
                            height: `${fragment.height}px`,
                            top: `${fragment.top}px`,
                          }}
                        >
                          <div
                            className="long-text-step-fragment-content"
                            style={{
                              transform: `translate3d(0, -${fragment.sourceTop}px, 0)`,
                            }}
                          >
                            <div className="long-text-step">
                              <MarkupText
                                animateMath={current}
                                instantMathReveal={current ? complete : true}
                                instantReveal={current ? complete : true}
                                lineSweepElapsedMs={
                                  current ? session.state.elapsedMs : 0
                                }
                                mathRevealDurations={
                                  current
                                    ? mathRevealDurations
                                    : EMPTY_MATH_REVEAL_DURATIONS
                                }
                                revealAnimation={revealAnimation}
                                revealSchedule={
                                  current ? revealSchedule : EMPTY_REVEAL_SCHEDULE
                                }
                                pauseWindows={
                                  current
                                    ? session.plan.pauses
                                    : EMPTY_PAUSE_WINDOWS
                                }
                                fontReady={fontReady}
                                measurementScale={designScale}
                                source={fragment.step.text}
                                {...(current
                                  ? { onMathMetrics: handleMathMetrics }
                                  : {})}
                                {...(current ? { unitCps } : {})}
                                {...(current
                                  ? { revealClock: session.clock }
                                  : {})}
                                {...(current &&
                                fragment.sourceTop === 0 &&
                                revealAnimation === "line_sweep"
                                  ? {
                                      onLineSweepLayoutChange:
                                        handleLineSweepLayoutChange,
                                    }
                                  : {})}
                                visibleCount={
                                  current
                                    ? renderedVisibleCount
                                    : Number.POSITIVE_INFINITY
                                }
                              />
                            </div>
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
      <span className={`long-text-indicator${complete ? " is-ready" : ""}`}>
        ◆
      </span>
    </section>
  );
});

function resolveFragmentWindow(
  bounds: readonly { top: number; bottom: number }[],
  scrollOffset: number,
  viewportHeight: number,
): LongTextPageWindow {
  const overscan = Math.max(0, viewportHeight) * 2;
  const lower = Math.max(0, scrollOffset - overscan);
  const upper = scrollOffset + Math.max(0, viewportHeight) + overscan;
  let low = 0;
  let high = bounds.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((bounds[middle]?.bottom ?? 0) <= lower) low = middle + 1;
    else high = middle;
  }
  const start = low;
  high = bounds.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((bounds[middle]?.top ?? 0) < upper) low = middle + 1;
    else high = middle;
  }
  return { start, end: low };
}

function sameTextLayoutSnapshot(
  left: TextLayoutSnapshot,
  right: TextLayoutSnapshot,
): boolean {
  if (
    Math.abs(left.contentHeight - right.contentHeight) > 0.25 ||
    left.lines.length !== right.lines.length
  ) {
    return false;
  }
  return left.lines.every((line, index) => {
    const candidate = right.lines[index];
    return (
      candidate !== undefined &&
      line.unitIndices.length === candidate.unitIndices.length &&
      line.unitIndices.every(
        (unit, unitIndex) => unit === candidate.unitIndices[unitIndex],
      ) &&
      Math.abs(line.top - candidate.top) <= 0.25 &&
      Math.abs(line.bottom - candidate.bottom) <= 0.25 &&
      Math.abs(line.left - candidate.left) <= 0.25 &&
      Math.abs(line.right - candidate.right) <= 0.25
    );
  });
}

type StepRow = readonly [string, string, boolean];

function stepRow(step: {
  step_id: string;
  text: string;
  page_break_before: boolean;
}): StepRow {
  return [step.step_id, step.text, step.page_break_before];
}

function sameStepRow(left: StepRow, right: StepRow | undefined): boolean {
  return (
    right !== undefined &&
    left[0] === right[0] &&
    left[1] === right[1] &&
    left[2] === right[2]
  );
}
