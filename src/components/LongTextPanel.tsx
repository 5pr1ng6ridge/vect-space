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
  buildPauseWindows,
  buildRevealSchedule,
  buildVisibleUnitCps,
  formulaPresentationDurationMs,
  formulaRevealDurationMs,
  mathRevealDurationMs,
  parseMarkup,
  revealCompletionTime,
  resolveInstantRevealPromptId,
  type RevealTimingOptions,
} from "../engine/markup";
import type {
  LongTextPageSnapshot,
  LongTextPrompt,
  TextRevealAnimation,
} from "../engine/types";
import { MarkupText } from "./MarkupText";
import {
  LONG_TEXT_STEP_GAP,
  paginateLongTextSteps,
  resolveLongTextPageWindow,
} from "./longTextPagination";
import {
  advanceLongTextScroll,
  clamp,
  hasReachedLongTextRevealThreshold,
  longTextMaxScroll,
  longTextParagraphTarget,
  longTextFollowTarget,
} from "./longTextScroll";

export interface LongTextPanelHandle {
  complete(): void;
  isComplete(): boolean;
}

interface LongTextPanelProps {
  prompt: LongTextPrompt;
  page: LongTextPageSnapshot;
  initialCps: number;
  defaultCps: number;
  disabled: boolean;
  /** null means a configured asset is still resolving; undefined is transparent. */
  paperUrl: string | null | undefined;
  revealImmediately: boolean;
  revealAnimation?: TextRevealAnimation;
  /** The game viewport scale, used to translate pointer deltas to design pixels. */
  designScale?: number;
  /** Rendering is held until the runtime font has finished loading. */
  fontReady?: boolean;
  fastForward: boolean;
  onTypingChange(typing: boolean, cps: number): void;
  onRevealComplete(promptId: string): void;
}

interface MathRevealMetric {
  widthPx: number;
  fontSizePx: number;
}

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
    revealAnimation = "typewriter",
    designScale = 1,
    fontReady = true,
    fastForward,
    onTypingChange,
    onRevealComplete,
  },
  ref,
): ReactElement {
  const units = useMemo(() => parseMarkup(prompt.text), [prompt.text]);
  const unitCps = useMemo(
    () => buildVisibleUnitCps(units, initialCps, defaultCps),
    [defaultCps, initialCps, units],
  );
  const timingOptions = useMemo<RevealTimingOptions>(
    () => ({ waitForInlineMath: revealAnimation !== "drop_fade" }),
    [revealAnimation],
  );
  const [mathRevealMetrics, setMathRevealMetrics] = useState<
    ReadonlyMap<number, MathRevealMetric>
  >(() => new Map());
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
  const schedule = useMemo(
    () =>
      buildRevealSchedule(
        units,
        initialCps,
        defaultCps,
        mathRevealDurations,
        timingOptions,
      ),
    [defaultCps, initialCps, mathRevealDurations, timingOptions, units],
  );
  const pauseWindows = useMemo(
    () =>
      buildPauseWindows(
        units,
        initialCps,
        defaultCps,
        mathRevealDurations,
        timingOptions,
      ),
    [defaultCps, initialCps, mathRevealDurations, timingOptions, units],
  );
  const revealCompletionMs = useMemo(
    () =>
      revealCompletionTime(
        units,
        schedule,
        mathRevealDurations,
        revealAnimation,
        unitCps,
        timingOptions,
      ),
    [
      mathRevealDurations,
      revealAnimation,
      schedule,
      timingOptions,
      unitCps,
      units,
    ],
  );
  const [visibleCount, setVisibleCount] = useState(0);
  const [revealFinished, setRevealFinished] = useState(
    () => revealImmediately || schedule.length === 0,
  );
  const [activePromptId, setActivePromptId] = useState(prompt.prompt_id);
  const [instantRevealPromptId, setInstantRevealPromptId] = useState<
    string | null
  >(revealImmediately ? prompt.prompt_id : null);
  const [paused, setPaused] = useState(() => isPauseAt(0, pauseWindows));
  const [typingCps, setTypingCps] = useState(() => unitCps[0] ?? initialCps);
  const [lineSweepReadyPromptId, setLineSweepReadyPromptId] = useState<
    string | null
  >(null);
  const [lineSweepElapsedMs, setLineSweepElapsedMs] = useState(0);
  const [stepHeights, setStepHeights] = useState<
    Readonly<Record<string, number>>
  >({});
  const [scrollPreparedPromptId, setScrollPreparedPromptId] = useState<
    string | null
  >(null);
  const [pageWindow, setPageWindow] = useState({ start: 0, end: 0 });
  const [presentedDocumentId, setPresentedDocumentId] = useState<string | null>(
    null,
  );
  const visibleRef = useRef(0);
  const completeRef = useRef(revealImmediately || schedule.length === 0);
  const pageWindowRef = useRef(pageWindow);
  const revealPromptRef = useRef(prompt.prompt_id);
  const reportedPromptRef = useRef<string | null>(null);
  const measuringRootRef = useRef<HTMLDivElement>(null);
  const stepMeasureRefs = useRef(new Map<string, HTMLDivElement>());
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
  const documentRef = useRef(page.document_id);
  const promptIsActive = activePromptId === prompt.prompt_id;
  const renderedVisibleCount = promptIsActive ? visibleCount : 0;
  const complete = promptIsActive && revealFinished;
  const handleLineSweepLayoutChange = useCallback(
    (ready: boolean): void => {
      setLineSweepReadyPromptId(ready ? prompt.prompt_id : null);
    },
    [prompt.prompt_id],
  );
  const revealReady =
    revealImmediately ||
    (fontReady &&
      (revealAnimation !== "line_sweep" ||
        lineSweepReadyPromptId === prompt.prompt_id));
  const activeStep = page.steps[page.active_step_index];
  const activeStepRef = useRef<HTMLDivElement>(null);
  const paperArtworkReady = usePaperArtworkReady(paperUrl);
  const layout = page.layout;
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
    if (documentRef.current === page.document_id) return;
    documentRef.current = page.document_id;
    manuallyBrowsingRef.current = false;
    applyScrollOffset(0);
    scrollStartOffsetRef.current = 0;
    scrollTargetRef.current = 0;
    setStepHeights({});
    setMathRevealMetrics(new Map());
    setScrollPreparedPromptId(null);
    const emptyWindow = { start: 0, end: 0 };
    pageWindowRef.current = emptyWindow;
    setPageWindow(emptyWindow);
  }, [applyScrollOffset, page.document_id]);

  const unmeasuredSteps = useMemo(
    () => page.steps.filter((step) => stepHeights[step.step_id] === undefined),
    [page.steps, stepHeights],
  );
  const measurementBatch = useMemo(
    () => unmeasuredSteps.slice(0, 16),
    [unmeasuredSteps],
  );

  const measureSteps = useCallback(() => {
    const measured: Record<string, number> = {};
    for (const [id, element] of stepMeasureRefs.current) {
      measured[id] = Math.ceil(
        Math.max(element.getBoundingClientRect().height, element.scrollHeight),
      );
    }
    setStepHeights((current) => {
      let changed = false;
      const next = { ...current };
      for (const [id, height] of Object.entries(measured)) {
        // A committed step never changes height later: this is the layout
        // boundary that prevents image/font settling from moving old pages.
        if (next[id] === undefined) {
          next[id] = height;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, []);

  useLayoutEffect(() => {
    const root = measuringRootRef.current;
    if (root === null) return;
    let active = true;
    const measureWhenFontsReady = (): void => {
      if (active) measureSteps();
    };
    if (!fontReady) return;
    if ("fonts" in document) {
      void document.fonts.ready.then(measureWhenFontsReady);
    } else {
      measureWhenFontsReady();
    }
    return () => {
      active = false;
    };
  }, [fontReady, measureSteps, measurementBatch]);

  const layoutReady = fontReady && unmeasuredSteps.length === 0;
  const pages = useMemo(
    () =>
      paginateLongTextSteps(
        page.steps,
        stepHeights,
        page.pagination,
        layout.page_height,
        layout.padding_y,
      ),
    [
      layout.page_height,
      layout.padding_y,
      page.pagination,
      page.steps,
      stepHeights,
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
    const pageIndex = pages.findIndex((candidate) =>
      candidate.steps.some((step) => step.step_id === activeStep.step_id),
    );
    if (pageIndex < 0) return null;
    const activePage = pages[pageIndex];
    if (activePage === undefined) return null;
    const activeIndex = activePage.steps.findIndex(
      (step) => step.step_id === activeStep.step_id,
    );
    if (activeIndex < 0) return null;
    const before = activePage.steps
      .slice(0, activeIndex)
      .reduce(
        (total, step, index) =>
          total +
          (index === 0 ? 0 : LONG_TEXT_STEP_GAP) +
          (stepHeights[step.step_id] ?? 0),
        0,
      );
    return {
      start: (pageOffsets[pageIndex] ?? 0) + layout.padding_y + before,
      height: stepHeights[activeStep.step_id] ?? 0,
    };
  }, [
    activeStep,
    layout.padding_y,
    layoutReady,
    pageOffsets,
    pages,
    stepHeights,
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
      if (visibleRef.current > 0) return;
      setMathRevealMetrics((current) => {
        const previous = current.get(index);
        if (
          previous?.widthPx === widthPx &&
          previous.fontSizePx === fontSizePx
        ) {
          return current;
        }
        const next = new Map(current);
        next.set(index, { widthPx, fontSizePx });
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    if (scrollPreparedPromptId !== prompt.prompt_id) return;
    if (!revealReady) return;
    if (revealPromptRef.current === prompt.prompt_id && completeRef.current) {
      return;
    }
    const previousPromptId = revealPromptRef.current;
    const initialVisibleCount = revealImmediately ? schedule.length : 0;
    const initiallyFinished = revealImmediately || schedule.length === 0;
    let frame = 0;
    const start = (): void => {
      setActivePromptId(prompt.prompt_id);
      visibleRef.current = initialVisibleCount;
      completeRef.current = initiallyFinished;
      setVisibleCount(initialVisibleCount);
      setRevealFinished(initiallyFinished);
      setInstantRevealPromptId((current) =>
        resolveInstantRevealPromptId(
          current,
          prompt.prompt_id,
          previousPromptId,
          revealImmediately,
        ),
      );
      revealPromptRef.current = prompt.prompt_id;
      setPaused(isPauseAt(0, pauseWindows));
      setTypingCps(unitCps[0] ?? initialCps);
      setLineSweepElapsedMs(revealImmediately ? revealCompletionMs : 0);
      manuallyBrowsingRef.current = false;
      if (!initiallyFinished) frame = requestAnimationFrame(tick);
    };
    const startedAt = performance.now();
    const tick = (now: number): void => {
      const elapsed = now - startedAt;
      if (revealAnimation === "line_sweep") {
        setLineSweepElapsedMs(elapsed);
      }
      const nextPaused = isPauseAt(elapsed, pauseWindows);
      setPaused((current) => (current === nextPaused ? current : nextPaused));
      setTypingCps((current) => {
        const next = typingCpsAt(
          elapsed,
          units,
          schedule,
          unitCps,
          mathRevealDurations,
          initialCps,
          timingOptions,
        );
        return current === next ? current : next;
      });
      let next = visibleRef.current;
      while (
        next < schedule.length &&
        (schedule[next] ?? Number.POSITIVE_INFINITY) <= elapsed
      ) {
        next += 1;
      }
      if (next !== visibleRef.current) {
        visibleRef.current = next;
        setVisibleCount(next);
      }
      if (next >= schedule.length && elapsed >= revealCompletionMs) {
        completeRef.current = true;
        setRevealFinished(true);
      } else {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(start);
    return () => cancelAnimationFrame(frame);
  }, [
    defaultCps,
    initialCps,
    mathRevealDurations,
    pauseWindows,
    prompt.prompt_id,
    revealCompletionMs,
    revealAnimation,
    revealImmediately,
    revealReady,
    schedule,
    unitCps,
    units,
    scrollPreparedPromptId,
    timingOptions,
  ]);

  useImperativeHandle(
    ref,
    () => ({
      complete: () => {
        if (scrollPreparedPromptId !== prompt.prompt_id) return;
        visibleRef.current = schedule.length;
        completeRef.current = true;
        setRevealFinished(true);
        setInstantRevealPromptId(prompt.prompt_id);
        setVisibleCount(schedule.length);
      },
      isComplete: () =>
        scrollPreparedPromptId === prompt.prompt_id && completeRef.current,
    }),
    [prompt.prompt_id, schedule.length, scrollPreparedPromptId],
  );

  useEffect(() => {
    if (complete && reportedPromptRef.current !== prompt.prompt_id) {
      reportedPromptRef.current = prompt.prompt_id;
      onRevealComplete(prompt.prompt_id);
    }
  }, [complete, onRevealComplete, prompt.prompt_id]);

  const effectivePaused = promptIsActive ? paused : isPauseAt(0, pauseWindows);
  const typing = promptIsActive && !disabled && !complete && !effectivePaused;
  useEffect(() => {
    onTypingChange(typing, typingCps);
    return () => onTypingChange(false, typingCps);
  }, [onTypingChange, typing, typingCps]);

  useLayoutEffect(() => {
    if (!layoutReady || activeStep === undefined) return;
    if (scrollPreparedPromptId === prompt.prompt_id) return;
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
        setScrollPreparedPromptId(prompt.prompt_id);
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
    prompt.prompt_id,
    revealImmediately,
    scrollPreparedPromptId,
    activeStepGeometry,
    updatePageWindow,
  ]);

  // Once a paragraph has started revealing, follow its actual rendered cursor
  // instead of aligning the whole paragraph again. This is what keeps a very
  // tall paragraph readable without a second teleport at the page boundary.
  useLayoutEffect(() => {
    if (
      !layoutReady ||
      revealImmediately ||
      activeStepGeometry === null ||
      scrollPreparedPromptId !== prompt.prompt_id ||
      manuallyBrowsingRef.current ||
      renderedVisibleCount <= 0
    ) {
      return;
    }
    const stepElement = activeStepRef.current;
    if (stepElement === null) return;
    const visibleElements =
      stepElement.querySelectorAll<HTMLElement>(".markup-unit");
    const visibleIndex = Math.min(renderedVisibleCount, visibleElements.length);
    if (visibleIndex <= 0) return;
    const cursorElement = visibleElements.item(visibleIndex - 1);
    const scale =
      Number.isFinite(designScale) && designScale > 0 ? designScale : 1;
    const stepRect = stepElement.getBoundingClientRect();
    const cursorRect = cursorElement?.getBoundingClientRect();
    const measuredOffset =
      cursorRect === undefined
        ? Number.NaN
        : (cursorRect.bottom - stepRect.top) / scale;
    const cursorY =
      activeStepGeometry.start +
      (Number.isFinite(measuredOffset)
        ? measuredOffset
        : activeStepGeometry.height *
          (visibleIndex / Math.max(1, schedule.length)));
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
    activeStepGeometry,
    designScale,
    layout.height,
    layoutReady,
    maxScroll,
    prompt.prompt_id,
    renderedVisibleCount,
    revealImmediately,
    scrollPreparedPromptId,
    schedule.length,
    updatePageWindow,
  ]);

  useEffect(() => {
    if (!layoutReady || complete) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number): void => {
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
          scrollPreparedPromptId !== prompt.prompt_id &&
          hasReachedLongTextRevealThreshold({
            startOffset: scrollStartOffsetRef.current,
            targetOffset: scrollTargetRef.current,
            currentOffset: next,
          })
        ) {
          setScrollPreparedPromptId(prompt.prompt_id);
        }
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
    prompt.prompt_id,
    scrollPreparedPromptId,
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
      className="long-text-panel"
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
            className="long-text-step"
            key={step.step_id}
            ref={(element) => {
              if (element === null)
                stepMeasureRefs.current.delete(step.step_id);
              else stepMeasureRefs.current.set(step.step_id, element);
            }}
          >
            <MarkupText source={step.text} />
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
                {paper.steps.map((step) => {
                  const current = step.step_id === prompt.step_id;
                  return (
                    <div
                      className="long-text-step"
                      key={step.step_id}
                      ref={current ? activeStepRef : undefined}
                    >
                      <MarkupText
                        animateMath={current}
                        instantMathReveal={
                          instantRevealPromptId === prompt.prompt_id
                        }
                        instantReveal={
                          instantRevealPromptId === prompt.prompt_id
                        }
                        lineSweepElapsedMs={lineSweepElapsedMs}
                        mathRevealDurations={mathRevealDurations}
                        revealAnimation={revealAnimation}
                        revealSchedule={schedule}
                        pauseWindows={pauseWindows}
                        fontReady={fontReady}
                        source={step.text}
                        {...(current
                          ? { onMathMetrics: handleMathMetrics }
                          : {})}
                        {...(current ? { unitCps } : {})}
                        {...(current && revealAnimation === "line_sweep"
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
                  );
                })}
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

function isPauseAt(
  elapsedMs: number,
  windows: { startMs: number; endMs: number }[],
): boolean {
  return windows.some(
    ({ startMs, endMs }) => elapsedMs >= startMs && elapsedMs < endMs,
  );
}

function typingCpsAt(
  elapsedMs: number,
  units: ReturnType<typeof parseMarkup>,
  schedule: readonly number[],
  unitCps: readonly number[],
  mathRevealDurations: ReadonlyMap<number, number>,
  fallbackCps: number,
  timingOptions: RevealTimingOptions,
): number {
  let index = 0;
  for (const unit of units) {
    if (unit.kind !== "character" && unit.kind !== "math") continue;
    const revealAt = schedule[index] ?? Number.POSITIVE_INFINITY;
    const duration =
      unit.kind === "math" &&
      (unit.display || timingOptions.waitForInlineMath !== false)
        ? formulaPresentationDurationMs(
            mathRevealDurationMs(
              mathRevealDurations.get(index),
              unitCps[index] ?? fallbackCps,
            ),
            unit.display,
          )
        : 0;
    if (elapsedMs <= revealAt + duration) return unitCps[index] ?? fallbackCps;
    index += 1;
  }
  return unitCps[unitCps.length - 1] ?? fallbackCps;
}
