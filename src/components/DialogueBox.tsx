import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactElement,
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
  DialoguePageSnapshot,
  DialoguePrompt,
  TextRevealAnimation,
} from "../engine/types";
import type { UiMotionHost } from "../engine/uiMotion";
import { MarkupText } from "./MarkupText";

export interface DialogueBoxHandle {
  complete(): void;
  isComplete(): boolean;
}

interface DialogueBoxProps {
  prompt: DialoguePrompt | null;
  page: DialoguePageSnapshot;
  initialCps: number;
  defaultCps: number;
  visible: boolean;
  disabled: boolean;
  dialogueBoxUrl: string;
  nameBoxUrl: string;
  onTypingChange(typing: boolean, cps: number): void;
  onRevealComplete(promptId: string): void;
  revealImmediately: boolean;
  revealAnimation?: TextRevealAnimation;
  motionHost?: UiMotionHost;
}

interface MathRevealMetric {
  widthPx: number;
  fontSizePx: number;
}

export const DialogueBox = forwardRef<DialogueBoxHandle, DialogueBoxProps>(
  function DialogueBox(
    {
      prompt,
      page,
      initialCps,
      defaultCps,
      visible,
      disabled,
      dialogueBoxUrl,
      nameBoxUrl,
      onTypingChange,
      onRevealComplete,
      revealImmediately,
      revealAnimation = "typewriter",
      motionHost,
    },
    ref,
  ): ReactElement {
    const promptId = prompt?.prompt_id ?? `${page.page_id}:retained`;
    const currentText = prompt?.text ?? "";
    const completedText = useMemo(
      () =>
        (prompt === null ? page.segments : page.segments.slice(0, -1)).join(""),
      [page.segments, prompt],
    );
    const units = useMemo(() => parseMarkup(currentText), [currentText]);
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
      () =>
        buildPauseWindows(units, initialCps, defaultCps, mathRevealDurations),
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
    const [activePromptId, setActivePromptId] = useState(promptId);
    const [instantRevealPromptId, setInstantRevealPromptId] = useState<
      string | null
    >(null);
    const [paused, setPaused] = useState(() => isPauseAt(0, pauseWindows));
    const [typingCps, setTypingCps] = useState(() => unitCps[0] ?? initialCps);
    const promptIdRef = useRef(promptId);
    const visibleRef = useRef(0);
    const promptIsActive = activePromptId === promptId;
    const renderedVisibleCount = promptIsActive ? visibleCount : 0;
    const complete = promptIsActive && revealFinished;
    const completeRef = useRef(complete);
    const reportedPromptRef = useRef<string | null>(null);
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
      setActivePromptId(promptId);
      visibleRef.current = initialVisibleCount;
      completeRef.current = initiallyFinished;
      setVisibleCount(initialVisibleCount);
      setRevealFinished(initiallyFinished);
      setInstantRevealPromptId(revealImmediately ? promptId : null);
      promptIdRef.current = promptId;
      setPaused(isPauseAt(0, pauseWindows));
      setTypingCps(unitCps[0] ?? initialCps);
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
        const timelineFinished =
          next >= schedule.length && elapsed >= revealCompletionMs;
        if (timelineFinished) {
          completeRef.current = true;
          setRevealFinished(true);
        } else {
          frame = requestAnimationFrame(tick);
        }
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }, [
      pauseWindows,
      initialCps,
      mathRevealDurations,
      promptId,
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
          setInstantRevealPromptId(promptId);
          setVisibleCount(schedule.length);
        },
        isComplete: () => completeRef.current,
      }),
      [promptId, schedule.length],
    );

    useEffect(() => {
      if (
        prompt !== null &&
        complete &&
        reportedPromptRef.current !== promptId
      ) {
        reportedPromptRef.current = promptId;
        onRevealComplete(promptId);
      }
    }, [complete, onRevealComplete, prompt, promptId]);

    const effectivePaused =
      promptIdRef.current === promptId ? paused : isPauseAt(0, pauseWindows);
    const typing =
      promptIsActive && visible && !disabled && !complete && !effectivePaused;
    useEffect(() => {
      onTypingChange(typing, typingCps);
      return () => onTypingChange(false, typingCps);
    }, [onTypingChange, typing, typingCps]);

    // Keep callback refs stable while the typewriter causes frequent React
    // renders. Re-registering an element would reset an in-flight UI motion.
    const dialogueRootRef = useCallback(
      (element: HTMLElement | null) =>
        motionHost?.register("dialogue_root", element),
      [motionHost],
    );
    const dialogueFrameRef = useCallback(
      (element: HTMLElement | null) =>
        motionHost?.register("dialogue_frame", element),
      [motionHost],
    );
    const dialogueNameplateRef = useCallback(
      (element: HTMLElement | null) =>
        motionHost?.register("dialogue_nameplate", element),
      [motionHost],
    );
    const dialogueTextRef = useCallback(
      (element: HTMLElement | null) =>
        motionHost?.register("dialogue_text", element),
      [motionHost],
    );
    const dialogueIndicatorRef = useCallback(
      (element: HTMLElement | null) =>
        motionHost?.register("dialogue_advance_indicator", element),
      [motionHost],
    );

    return (
      <section
        aria-hidden={!visible}
        aria-label="对话"
        className={`dialogue-box${visible ? " is-visible" : " is-hidden"}`}
        ref={dialogueRootRef}
      >
        <img
          alt=""
          aria-hidden="true"
          className="dialogue-frame"
          draggable={false}
          height={407}
          src={dialogueBoxUrl}
          ref={dialogueFrameRef}
          width={1920}
        />
        {page.speaker !== null && (
          <span
            className="speaker-name"
            ref={dialogueNameplateRef}
            style={{ color: page.name_color ?? undefined }}
          >
            <img
              alt=""
              aria-hidden="true"
              draggable={false}
              height={193}
              src={nameBoxUrl}
              width={364}
            />
            <span>{page.speaker}</span>
          </span>
        )}
        <span
          className="dialogue-text"
          ref={dialogueTextRef}
          style={{ color: page.text_color ?? undefined }}
        >
          <MarkupText source={completedText} />
          <MarkupText
            animateMath
            instantMathReveal={instantRevealPromptId === promptId}
            onMathMetrics={handleMathMetrics}
            revealAnimation={revealAnimation}
            source={currentText}
            unitCps={unitCps}
            visibleCount={renderedVisibleCount}
          />
        </span>
        {prompt !== null && (
          <span
            className={`advance-indicator${complete ? " is-ready" : ""}`}
            ref={dialogueIndicatorRef}
          >
            ◆
          </span>
        )}
      </section>
    );
  },
);

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
    if (unit.kind !== "character" && unit.kind !== "math") {
      continue;
    }
    const revealAt = schedule[visibleIndex] ?? Number.POSITIVE_INFINITY;
    const duration =
      unit.kind === "math"
        ? (mathRevealDurations.get(visibleIndex) ??
          DEFAULT_MATH_REVEAL_DURATION_MS)
        : 0;
    if (elapsedMs < revealAt + duration) {
      return unitCps[visibleIndex] ?? fallbackCps;
    }
    visibleIndex += 1;
  }
  return unitCps[unitCps.length - 1] ?? fallbackCps;
}
