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
  DEFAULT_MATH_REVEAL_DURATION_MS,
  formulaRevealDurationMs,
  parseMarkup,
  revealCompletionTime,
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
} from "./longTextPagination";
import {
  advanceLongTextScroll,
  clamp,
  longTextFollowTarget,
  longTextMaxScroll,
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
      buildRevealSchedule(units, initialCps, defaultCps, mathRevealDurations),
    [defaultCps, initialCps, mathRevealDurations, units],
  );
  const pauseWindows = useMemo(
    () => buildPauseWindows(units, initialCps, defaultCps, mathRevealDurations),
    [defaultCps, initialCps, mathRevealDurations, units],
  );
  const revealCompletionMs = useMemo(
    () => revealCompletionTime(units, schedule, mathRevealDurations),
    [mathRevealDurations, schedule, units],
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
  const [stepHeights, setStepHeights] = useState<
    Readonly<Record<string, number>>
  >({});
  const [scrollOffset, setScrollOffset] = useState(0);
  const visibleRef = useRef(0);
  const completeRef = useRef(revealImmediately || schedule.length === 0);
  const reportedPromptRef = useRef<string | null>(null);
  const measuringRootRef = useRef<HTMLDivElement>(null);
  const stepMeasureRefs = useRef(new Map<string, HTMLDivElement>());
  const activeStepRef = useRef<HTMLDivElement>(null);
  const scrollOffsetRef = useRef(0);
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
  const activeStep = page.steps[page.active_step_index];
  const paperArtworkReady = usePaperArtworkReady(paperUrl);
  const layout = page.layout;

  useLayoutEffect(() => {
    if (documentRef.current === page.document_id) return;
    documentRef.current = page.document_id;
    manuallyBrowsingRef.current = false;
    scrollOffsetRef.current = 0;
    scrollTargetRef.current = 0;
    setScrollOffset(0);
    setStepHeights({});
    setMathRevealMetrics(new Map());
  }, [page.document_id]);

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
    if ("fonts" in document) {
      void document.fonts.ready.then(measureWhenFontsReady);
    } else {
      measureWhenFontsReady();
    }
    return () => {
      active = false;
    };
  }, [measureSteps, page.steps]);

  const layoutReady = page.steps.every(
    (step) => stepHeights[step.step_id] !== undefined,
  );
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
    return pages.reduce<number[]>((offsets, _paper, index) => {
      const previousOffset = offsets[index - 1] ?? 0;
      const previousPaper = pages[index - 1];
      const offset =
        index === 0
          ? 0
          : previousOffset +
            (previousPaper?.height ?? 0) +
            (page.pagination === "continuous" ? 0 : layout.page_gap);
      return [...offsets, offset];
    }, []);
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
    const initialVisibleCount = revealImmediately ? schedule.length : 0;
    const initiallyFinished = revealImmediately || schedule.length === 0;
    let frame = 0;
    const start = (): void => {
      setActivePromptId(prompt.prompt_id);
      visibleRef.current = initialVisibleCount;
      completeRef.current = initiallyFinished;
      setVisibleCount(initialVisibleCount);
      setRevealFinished(initiallyFinished);
      setInstantRevealPromptId(revealImmediately ? prompt.prompt_id : null);
      setPaused(isPauseAt(0, pauseWindows));
      setTypingCps(unitCps[0] ?? initialCps);
      manuallyBrowsingRef.current = false;
      if (!initiallyFinished) frame = requestAnimationFrame(tick);
    };
    const startedAt = performance.now();
    const tick = (now: number): void => {
      const elapsed = now - startedAt;
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
    revealImmediately,
    schedule,
    unitCps,
    units,
  ]);

  useImperativeHandle(
    ref,
    () => ({
      complete: () => {
        visibleRef.current = schedule.length;
        completeRef.current = true;
        setRevealFinished(true);
        setInstantRevealPromptId(prompt.prompt_id);
        setVisibleCount(schedule.length);
      },
      isComplete: () => completeRef.current,
    }),
    [prompt.prompt_id, schedule.length],
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
    const activeElement = activeStepRef.current;
    const pageIndex = pages.findIndex((candidate) =>
      candidate.steps.some((step) => step.step_id === activeStep.step_id),
    );
    if (pageIndex < 0) return;
    const activePage = pages[pageIndex];
    if (activePage === undefined) return;
    const activeIndex = activePage.steps.findIndex(
      (step) => step.step_id === activeStep.step_id,
    );
    const before = activePage.steps
      .slice(0, activeIndex)
      .reduce(
        (total, step, index) =>
          total +
          (index === 0 ? 0 : LONG_TEXT_STEP_GAP) +
          (stepHeights[step.step_id] ?? 0),
        0,
      );
    const start = (pageOffsets[pageIndex] ?? 0) + layout.padding_y + before;
    const measuredCursor = renderedUnitBottomOffset(
      activeElement,
      renderedVisibleCount,
    );
    const activeHeight = stepHeights[activeStep.step_id] ?? 0;
    const cursorY =
      start +
      (measuredCursor ??
        activeHeight * (renderedVisibleCount / Math.max(1, schedule.length)));
    const target = longTextFollowTarget({
      cursorY,
      viewportHeight: layout.height,
      maxScroll,
    });
    if (target !== null && !manuallyBrowsingRef.current) {
      scrollTargetRef.current = target;
      if (revealImmediately) {
        scrollOffsetRef.current = target;
        setScrollOffset(target);
      }
    }
  }, [
    activeStep,
    layout.height,
    layout.padding_y,
    layoutReady,
    maxScroll,
    pageOffsets,
    pages,
    renderedVisibleCount,
    revealImmediately,
    schedule.length,
    stepHeights,
  ]);

  useEffect(() => {
    if (!layoutReady || manuallyBrowsingRef.current) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number): void => {
      const next = clamp(
        advanceLongTextScroll(
          scrollOffsetRef.current,
          scrollTargetRef.current,
          now - previous,
          fastForward,
        ),
        0,
        maxScroll,
      );
      previous = now;
      if (Math.abs(next - scrollOffsetRef.current) > 0.01) {
        scrollOffsetRef.current = next;
        setScrollOffset(next);
      }
      if (Math.abs(scrollTargetRef.current - next) > 0.01) {
        frame = requestAnimationFrame(tick);
      }
    };
    if (Math.abs(scrollTargetRef.current - scrollOffsetRef.current) > 0.01) {
      frame = requestAnimationFrame(tick);
    }
    return () => cancelAnimationFrame(frame);
  }, [
    fastForward,
    layoutReady,
    maxScroll,
    renderedVisibleCount,
    prompt.prompt_id,
  ]);

  const handleWheel = (event: WheelEvent<HTMLElement>): void => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    manuallyBrowsingRef.current = true;
    const next = clamp(scrollOffsetRef.current + event.deltaY, 0, maxScroll);
    scrollOffsetRef.current = next;
    scrollTargetRef.current = next;
    setScrollOffset(next);
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
    const delta = event.clientY - drag.startClientY;
    if (!drag.moved && Math.abs(delta) < 5) return;
    drag.moved = true;
    manuallyBrowsingRef.current = true;
    const next = clamp(drag.startOffset - delta, 0, maxScroll);
    scrollOffsetRef.current = next;
    scrollTargetRef.current = next;
    setScrollOffset(next);
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
        {page.steps.map((step) => (
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
        className={`long-text-viewport${layoutReady && paperArtworkReady ? " is-ready" : ""}`}
      >
        <div
          className="long-text-surface-stack"
          style={{ transform: `translateY(${-scrollOffset}px)` }}
        >
          {pages.map((paper, index) => (
            <article
              className={`long-text-paper${paperUrl === undefined ? "" : " has-paper-art"}`}
              key={paper.index}
              style={{
                height: `${paper.height}px`,
                marginBottom:
                  page.pagination === "continuous" || index === pages.length - 1
                    ? 0
                    : `${layout.page_gap}px`,
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
            style={{ transform: `translateY(${-scrollOffset}px)` }}
          >
            {pages.map((paper, index) => (
              <article
                className="long-text-paper-content"
                key={paper.index}
                style={{
                  height: `${paper.height}px`,
                  marginBottom:
                    page.pagination === "continuous" ||
                    index === pages.length - 1
                      ? 0
                      : `${layout.page_gap}px`,
                }}
              >
                {paper.steps.map((step) => {
                  const current = step.step_id === prompt.step_id;
                  return (
                    <div
                      className="long-text-step"
                      key={step.step_id}
                      ref={current ? activeStepRef : null}
                    >
                      <MarkupText
                        animateMath={current}
                        instantMathReveal={
                          instantRevealPromptId === prompt.prompt_id
                        }
                        revealAnimation={revealAnimation}
                        source={step.text}
                        {...(current
                          ? { onMathMetrics: handleMathMetrics }
                          : {})}
                        {...(current ? { unitCps } : {})}
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

function renderedUnitBottomOffset(
  step: HTMLDivElement | null,
  visibleCount: number,
): number | null {
  if (step === null || visibleCount <= 0) return null;
  const units = step.querySelectorAll<HTMLElement>(
    ":scope > span > .markup-unit",
  );
  const unit = units.item(Math.min(visibleCount, units.length) - 1);
  if (unit === null) return null;
  return unit.getBoundingClientRect().bottom - step.getBoundingClientRect().top;
}

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
): number {
  let index = 0;
  for (const unit of units) {
    if (unit.kind !== "character" && unit.kind !== "math") continue;
    const revealAt = schedule[index] ?? Number.POSITIVE_INFINITY;
    const duration =
      unit.kind === "math"
        ? (mathRevealDurations.get(index) ?? DEFAULT_MATH_REVEAL_DURATION_MS)
        : 0;
    if (elapsedMs <= revealAt + duration) return unitCps[index] ?? fallbackCps;
    index += 1;
  }
  return unitCps[unitCps.length - 1] ?? fallbackCps;
}
