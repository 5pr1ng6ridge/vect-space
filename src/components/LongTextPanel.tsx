import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
import type { LongTextPageSnapshot, LongTextPrompt } from "../engine/types";
import { MarkupText } from "./MarkupText";
import {
  LONG_TEXT_PAGE_GAP,
  LONG_TEXT_PAGE_PADDING_TOP,
  LONG_TEXT_STEP_GAP,
  paginateLongTextSteps,
} from "./longTextPagination";

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
  paperUrl: string | undefined;
  revealImmediately: boolean;
  fastForward: boolean;
  onTypingChange(typing: boolean, cps: number): void;
  onRevealComplete(promptId: string): void;
}

interface MathRevealMetric {
  widthPx: number;
  fontSizePx: number;
}

const VIEWPORT_HEIGHT = 1_080;
const FOLLOW_LINE = 785;

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
    for (const [unitIndex, metric] of mathRevealMetrics) {
      result.set(
        unitIndex,
        formulaRevealDurationMs(
          metric.widthPx,
          metric.fontSizePx,
          unitCps[unitIndex] ?? 30,
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
  const manuallyBrowsingRef = useRef(false);
  const promptIsActive = activePromptId === prompt.prompt_id;
  const renderedVisibleCount = promptIsActive ? visibleCount : 0;
  const complete = promptIsActive && revealFinished;
  const activeStep = page.steps[page.active_step_index];

  const handleMathMetrics = useCallback(
    (unitIndex: number, widthPx: number, fontSizePx: number): void => {
      if (visibleRef.current > 0) return;
      setMathRevealMetrics((current) => {
        const previous = current.get(unitIndex);
        if (
          previous?.widthPx === widthPx &&
          previous.fontSizePx === fontSizePx
        ) {
          return current;
        }
        const next = new Map(current);
        next.set(unitIndex, { widthPx, fontSizePx });
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    const initialVisibleCount = revealImmediately ? schedule.length : 0;
    const initiallyFinished = revealImmediately || schedule.length === 0;
    setActivePromptId(prompt.prompt_id);
    visibleRef.current = initialVisibleCount;
    completeRef.current = initiallyFinished;
    setVisibleCount(initialVisibleCount);
    setRevealFinished(initiallyFinished);
    setInstantRevealPromptId(revealImmediately ? prompt.prompt_id : null);
    setPaused(isPauseAt(0, pauseWindows));
    setTypingCps(unitCps[0] ?? initialCps);
    manuallyBrowsingRef.current = false;
    if (initiallyFinished) return;
    const startedAt = performance.now();
    let frame = 0;
    const tick = (now: number): void => {
      const elapsed = now - startedAt;
      const nextPaused = isPauseAt(elapsed, pauseWindows);
      setPaused((current) => (current === nextPaused ? current : nextPaused));
      const nextCps = typingCpsAt(
        elapsed,
        units,
        schedule,
        unitCps,
        mathRevealDurations,
        initialCps,
      );
      setTypingCps((current) => (current === nextCps ? current : nextCps));
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
    frame = requestAnimationFrame(tick);
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
        manuallyBrowsingRef.current = false;
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

  const updateMeasurements = useCallback((): void => {
    const next: Record<string, number> = {};
    for (const [id, element] of stepMeasureRefs.current) {
      next[id] = Math.ceil(element.getBoundingClientRect().height);
    }
    setStepHeights((current) =>
      sameMeasurements(current, next) ? current : next,
    );
  }, []);

  useLayoutEffect(() => {
    const root = measuringRootRef.current;
    if (root === null) return;
    const frame = requestAnimationFrame(updateMeasurements);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => updateMeasurements());
    observer?.observe(root);
    if ("fonts" in document) {
      void document.fonts.ready.then(updateMeasurements);
    }
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [page.steps, updateMeasurements]);

  const pages = useMemo(
    () => paginateLongTextSteps(page.steps, stepHeights),
    [page.steps, stepHeights],
  );
  const activePageIndex = pages.findIndex((candidate) =>
    candidate.steps.some((step) => step.step_id === activeStep?.step_id),
  );
  const pageOffsets = useMemo(() => {
    let offset = 0;
    return pages.map((paper, index) => {
      const current = offset;
      offset += paper.height;
      if (index < pages.length - 1) offset += LONG_TEXT_PAGE_GAP;
      return current;
    });
  }, [pages]);
  const paperStackHeight = pages.reduce(
    (total, paper, index) =>
      total +
      paper.height +
      (index < pages.length - 1 ? LONG_TEXT_PAGE_GAP : 0),
    0,
  );
  const maxScroll = Math.max(0, paperStackHeight - VIEWPORT_HEIGHT + 70);

  useEffect(() => {
    const activePage = pages[activePageIndex];
    if (
      manuallyBrowsingRef.current ||
      activePageIndex < 0 ||
      activeStep === undefined ||
      activePage === undefined
    ) {
      return;
    }
    const beforeActive = activePage.steps
      .slice(
        0,
        activePage.steps.findIndex(
          (step) => step.step_id === activeStep.step_id,
        ),
      )
      .reduce(
        (sum, step, index) =>
          sum +
          (index === 0 ? 0 : LONG_TEXT_STEP_GAP) +
          (stepHeights[step.step_id] ?? 180),
        0,
      );
    const activeHeight = stepHeights[activeStep.step_id] ?? 180;
    const visibleRatio =
      schedule.length === 0 ? 1 : renderedVisibleCount / schedule.length;
    const cursorY =
      70 +
      (pageOffsets[activePageIndex] ?? 0) +
      LONG_TEXT_PAGE_PADDING_TOP +
      beforeActive +
      activeHeight * visibleRatio;
    const target = clamp(cursorY - FOLLOW_LINE, 0, maxScroll);
    const frame = requestAnimationFrame(() => {
      setScrollOffset((current) =>
        Math.abs(current - target) < 1 ? current : target,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [
    activePageIndex,
    activeStep,
    maxScroll,
    pages,
    pageOffsets,
    renderedVisibleCount,
    schedule.length,
    stepHeights,
  ]);

  const handleWheel = (event: WheelEvent<HTMLElement>): void => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    manuallyBrowsingRef.current = true;
    setScrollOffset((current) => clamp(current + event.deltaY, 0, maxScroll));
  };

  return (
    <section
      aria-label="长文本"
      className="long-text-panel"
      onWheel={handleWheel}
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
        className="long-text-paper-stack"
        style={{
          transform: `translateY(${-scrollOffset}px)`,
          transitionDuration: `${fastForward ? 55 : 360}ms`,
        }}
      >
        {pages.map((paper) => (
          <article
            className="long-text-paper"
            key={paper.index}
            style={{
              height: `${paper.height}px`,
              ...(paperUrl === undefined
                ? {}
                : { backgroundImage: `url(${JSON.stringify(paperUrl)})` }),
            }}
          >
            <div className="long-text-paper-content">
              {paper.steps.map((step) => {
                const current = step.step_id === prompt.step_id;
                return (
                  <div className="long-text-step" key={step.step_id}>
                    <MarkupText
                      source={step.text}
                      visibleCount={
                        current
                          ? renderedVisibleCount
                          : Number.POSITIVE_INFINITY
                      }
                      {...(current
                        ? {
                            animateMath: true,
                            instantMathReveal:
                              instantRevealPromptId === prompt.prompt_id,
                            onMathMetrics: handleMathMetrics,
                            unitCps,
                          }
                        : {})}
                    />
                  </div>
                );
              })}
            </div>
          </article>
        ))}
      </div>
      <span className={`long-text-indicator${complete ? " is-ready" : ""}`}>
        ◆
      </span>
    </section>
  );
});

function sameMeasurements(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean {
  const leftIds = Object.keys(left);
  const rightIds = Object.keys(right);
  return (
    leftIds.length === rightIds.length &&
    leftIds.every((id) => left[id] === right[id])
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
  let visibleIndex = 0;
  for (const unit of units) {
    if (unit.kind !== "character" && unit.kind !== "math") continue;
    const revealAt = schedule[visibleIndex] ?? Number.POSITIVE_INFINITY;
    const duration =
      unit.kind === "math"
        ? (mathRevealDurations.get(visibleIndex) ??
          DEFAULT_MATH_REVEAL_DURATION_MS)
        : 0;
    if (elapsedMs <= revealAt + duration) {
      return unitCps[visibleIndex] ?? fallbackCps;
    }
    visibleIndex += 1;
  }
  return unitCps[unitCps.length - 1] ?? fallbackCps;
}
