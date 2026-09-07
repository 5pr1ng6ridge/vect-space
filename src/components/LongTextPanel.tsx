import {
  forwardRef,
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
} from "../engine/markup";
import type {
  LongTextPageSnapshot,
  LongTextPrompt,
  TextRevealAnimation,
} from "../engine/types";
import { MarkupText } from "./MarkupText";
import {
  paginateLongTextVisualSteps,
  resolveLongTextPageWindow,
} from "./longTextPagination";
import {
  isValidTextMeasurementScale,
  type TextLayoutSnapshot,
} from "@vectspace/text";
import {
  advanceLongTextScroll,
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
  paperUrl: string | null | undefined;
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

const readyPaperArtworkUrls = new Set<string>();
const paperArtworkLoads = new Map<string, Promise<void>>();

function preloadPaperArtwork(url: string): Promise<void> {
  if (readyPaperArtworkUrls.has(url)) return Promise.resolve();
  const existing = paperArtworkLoads.get(url);
  if (existing !== undefined) return existing;
  const load = new Promise<void>((resolve) => {
    const image = new Image();
    const finish = (): void => {
      readyPaperArtworkUrls.add(url);
      resolve();
    };
    image.addEventListener("load", () => {
      void image
        .decode()
        .catch(() => undefined)
        .finally(finish);
    });
    image.addEventListener("error", finish);
    image.src = url;
  });
  paperArtworkLoads.set(url, load);
  return load;
}

function usePaperArtworkReady(paperUrl: string | null | undefined): boolean {
  const [readyUrl, setReadyUrl] = useState<string | undefined>(
    typeof paperUrl === "string" && readyPaperArtworkUrls.has(paperUrl)
      ? paperUrl
      : undefined,
  );
  useEffect(() => {
    if (typeof paperUrl !== "string") return;
    let active = true;
    void preloadPaperArtwork(paperUrl).then(() => {
      if (active) setReadyUrl(paperUrl);
    });
    return () => {
      active = false;
    };
  }, [paperUrl]);
  return paperUrl === undefined || readyUrl === paperUrl;
}

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
    paperUrl,
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
  const [presentedDocumentId, setPresentedDocumentId] = useState<string | null>(
    null,
  );
  const pageWindowRef = useRef(pageWindow);
  const pendingCompleteRef = useRef(false);
  const measuringRootRef = useRef<HTMLDivElement>(null);
  const surfaceStackRef = useRef<HTMLDivElement>(null);
  const textStackRef = useRef<HTMLDivElement>(null);
  const scrollOffsetRef = useRef(0);
  const scrollStartOffsetRef = useRef(0);
  const scrollTargetRef = useRef(0);
  const manuallyBrowsingRef = useRef(false);
  const pointerDragRef = useRef<{
    pointerId: number;
    startClientY: number;
    startOffset: number;
    moved: boolean;
  } | null>(null);
  const suppressAdvanceClickRef = useRef(false);
  const pageShapeRef = useRef({
    documentId: page.document_id,
    firstStepId: page.steps[0]?.step_id ?? "",
    firstText: page.steps[0]?.text ?? "",
    stepCount: page.steps.length,
    activeStepIndex: page.active_step_index,
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
  const paperArtworkReady = usePaperArtworkReady(paperUrl);
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

  useLayoutEffect(() => {
    const previous = pageShapeRef.current;
    const next = {
      documentId: page.document_id,
      firstStepId: page.steps[0]?.step_id ?? "",
      firstText: page.steps[0]?.text ?? "",
      stepCount: page.steps.length,
      activeStepIndex: page.active_step_index,
      instanceKey,
    };
    pageShapeRef.current = next;
    const replaced =
      previous.documentId !== next.documentId ||
      previous.firstStepId !== next.firstStepId ||
      previous.firstText !== next.firstText ||
      next.stepCount < previous.stepCount ||
      // Starting the same document again (or revisiting its first step) must
      // return the viewport to the beginning even when the retained list has
      // the same shape as the previous visit.
      (next.activeStepIndex === 0 && previous.activeStepIndex > 0) ||
      (prompt !== null &&
        next.activeStepIndex === 0 &&
        previous.activeStepIndex === 0 &&
        previous.instanceKey !== instanceKey);
    if (!replaced) return;
    manuallyBrowsingRef.current = false;
    applyScrollOffset(0);
    scrollStartOffsetRef.current = 0;
    scrollTargetRef.current = 0;
    setStepLayouts({});
    setMetrics({ key: instanceKey, values: new Map() });
    setScrollPreparedKey(null);
    pendingCompleteRef.current = false;
    const emptyWindow = { start: 0, end: 0 };
    pageWindowRef.current = emptyWindow;
    setPageWindow(emptyWindow);
  }, [
    applyScrollOffset,
    instanceKey,
    page.active_step_index,
    page.document_id,
    page.steps,
    prompt,
  ]);

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
  const updatePageWindow = useCallback(
    (offset: number): void => {
      const next = resolveLongTextPageWindow(
        pages,
        pageOffsets,
        offset,
        layout.height,
      );
      const current = pageWindowRef.current;
      if (current.start === next.start && current.end === next.end) return;
      pageWindowRef.current = next;
      setPageWindow(next);
    },
    [layout.height, pageOffsets, pages],
  );
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

  useLayoutEffect(() => {
    applyScrollOffset(scrollOffsetRef.current);
    updatePageWindow(scrollOffsetRef.current);
  }, [applyScrollOffset, updatePageWindow]);

  useEffect(() => {
    if (!layoutReady || !paperArtworkReady || !fontReady) return;
    const frame = requestAnimationFrame(() => {
      setPresentedDocumentId(page.document_id);
    });
    return () => cancelAnimationFrame(frame);
  }, [fontReady, layoutReady, page.document_id, paperArtworkReady]);

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
    suspended: suspended || disabled,
    units,
    waitForInlineMath: revealAnimation !== "drop_fade",
  });
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
    scrollTargetRef.current = target;
    if (revealImmediately) {
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
    instanceKey,
    revealImmediately,
    scrollPreparedKey,
    activeStepGeometry,
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
    const activeLayout =
      activeStep === undefined
        ? undefined
        : stepLayouts[activeStep.step_id]?.snapshot;
    const revealIndex = renderedVisibleCount - 1;
    const lineIndex =
      activeLayout?.lines.findIndex((line) =>
        line.unitIndices.some(
          (layoutIndex) =>
            (activeRevealIndexByLayoutIndex.get(layoutIndex) ?? -1) >=
            revealIndex,
        ),
      ) ?? -1;
    const line = lineIndex >= 0 ? activeLayout?.lines[lineIndex] : undefined;
    const location =
      line === undefined || activeStep === undefined
        ? undefined
        : pages.flatMap((paper, pageIndex) =>
            paper.fragments
              .filter(
                (fragment) =>
                  fragment.step.step_id === activeStep.step_id &&
                  lineIndex >= fragment.firstLine &&
                  lineIndex <= fragment.lastLine,
              )
              .map((fragment) => ({ fragment, pageIndex })),
          )[0];
    const cursorY =
      line === undefined || location === undefined
        ? activeStepGeometry.start +
          activeStepGeometry.height *
            (renderedVisibleCount / Math.max(1, session.plan.events.length))
        : (pageOffsets[location.pageIndex] ?? 0) +
          layout.padding_y +
          location.fragment.top +
          (line.bottom - location.fragment.sourceTop);
    const currentOffset = scrollOffsetRef.current;
    const followDelta = longTextFollowTarget({
      cursorY: cursorY - currentOffset,
      viewportHeight: layout.height,
      maxScroll,
    });
    if (followDelta === null) return;
    const target = clamp(currentOffset + followDelta, 0, maxScroll);
    if (Math.abs(target - scrollTargetRef.current) <= 0.5) return;
    scrollTargetRef.current = target;
    updatePageWindow(currentOffset);
  }, [
    activeLayoutUnits,
    activeRevealIndexByLayoutIndex,
    activeStep,
    activeStepGeometry,
    layout.height,
    layout.padding_y,
    layoutReady,
    maxScroll,
    instanceKey,
    pageOffsets,
    pages,
    renderedVisibleCount,
    revealImmediately,
    scrollPreparedKey,
    session.plan.events.length,
    stepLayouts,
    updatePageWindow,
  ]);

  useEffect(() => {
    if (!layoutReady) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number): void => {
      if (suspended) return;
      const elapsedMs = now - previous;
      previous = now;
      if (!manuallyBrowsingRef.current) {
        const next = clamp(
          advanceLongTextScroll(
            scrollOffsetRef.current,
            scrollTargetRef.current,
            elapsedMs,
            fastForward,
          ),
          0,
          maxScroll,
        );
        if (Math.abs(next - scrollOffsetRef.current) > 0.01) {
          applyScrollOffset(next);
          updatePageWindow(next);
        }
        if (
          scrollPreparedKey !== instanceKey &&
          hasReachedLongTextRevealThreshold({
            startOffset: scrollStartOffsetRef.current,
            targetOffset: scrollTargetRef.current,
            currentOffset: next,
          })
        ) {
          setScrollPreparedKey(instanceKey);
        }
      }
      const settled =
        Math.abs(scrollTargetRef.current - scrollOffsetRef.current) <= 0.01;
      if (complete && (manuallyBrowsingRef.current || settled)) {
        return;
      }
      // Keep one controller alive for the whole prompt.  Restarting this
      // effect on every newly visible unit introduced a small hitch exactly
      // when a paragraph continued or a new paper entered the viewport.
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [
    complete,
    fastForward,
    applyScrollOffset,
    layoutReady,
    maxScroll,
    instanceKey,
    scrollPreparedKey,
    suspended,
    updatePageWindow,
  ]);

  const handleWheel = (event: WheelEvent<HTMLElement>): void => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    manuallyBrowsingRef.current = true;
    const scale =
      Number.isFinite(designScale) && designScale > 0 ? designScale : 1;
    const next = clamp(
      scrollOffsetRef.current + event.deltaY / scale,
      0,
      maxScroll,
    );
    applyScrollOffset(next);
    scrollTargetRef.current = next;
    updatePageWindow(next);
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
    applyScrollOffset(next);
    scrollTargetRef.current = next;
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
          <div
            className="long-text-step long-text-measure-step"
            key={step.step_id}
          >
            <MarkupText
              fontReady={fontReady}
              measurementScale={designScale}
              onTextLayout={(layoutSnapshot) =>
                handleStepLayout(step.step_id, layoutSnapshot)
              }
              source={step.text}
            />
          </div>
        ))}
      </div>
      <div
        className={`long-text-viewport${paperArtworkReady && (layoutReady || presentedDocumentId === page.document_id) ? " is-ready" : ""}`}
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
              className={`long-text-paper${paperUrl === undefined ? "" : " has-paper-art"}`}
              key={paper.index}
              style={{
                height: `${paper.height}px`,
                position: "absolute",
                top: `${top}px`,
                ...(typeof paperUrl === "string"
                  ? { backgroundImage: `url(${JSON.stringify(paperUrl)})` }
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
                className="long-text-paper-content"
                key={paper.index}
                style={{
                  height: `${paper.height}px`,
                  position: "absolute",
                  top: `${top}px`,
                }}
              >
                <div className="long-text-paper-content-inner">
                  <div className="long-text-paper-content-stage">
                    {paper.fragments.map((fragment) => {
                      const current = fragment.step.step_id === activeStepId;
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
                                instantMathReveal={complete}
                                instantReveal={complete}
                                lineSweepElapsedMs={session.state.elapsedMs}
                                mathRevealDurations={mathRevealDurations}
                                revealAnimation={revealAnimation}
                                revealSchedule={session.plan.events.map(
                                  (event) => event.atMs,
                                )}
                                pauseWindows={session.plan.pauses}
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
