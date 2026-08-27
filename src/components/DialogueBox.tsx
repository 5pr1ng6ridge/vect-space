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
import type { DialoguePrompt } from "../engine/types";
import { MarkupText } from "./MarkupText";

export interface DialogueBoxHandle {
  complete(): void;
  isComplete(): boolean;
}

interface DialogueBoxProps {
  prompt: DialoguePrompt;
  initialCps: number;
  defaultCps: number;
  visible: boolean;
  disabled: boolean;
  dialogueBoxUrl: string;
  nameBoxUrl: string;
  onTypingChange(typing: boolean, cps: number): void;
  onRevealComplete(promptId: string): void;
  revealImmediately: boolean;
}

interface MathRevealMetric {
  widthPx: number;
  fontSizePx: number;
}

export const DialogueBox = forwardRef<DialogueBoxHandle, DialogueBoxProps>(
  function DialogueBox(
    {
      prompt,
      initialCps,
      defaultCps,
      visible,
      disabled,
      dialogueBoxUrl,
      nameBoxUrl,
      onTypingChange,
      onRevealComplete,
      revealImmediately,
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
    const [activePromptId, setActivePromptId] = useState(prompt.prompt_id);
    const [instantRevealPromptId, setInstantRevealPromptId] = useState<
      string | null
    >(null);
    const [paused, setPaused] = useState(() => isPauseAt(0, pauseWindows));
    const [typingCps, setTypingCps] = useState(() => unitCps[0] ?? initialCps);
    const promptIdRef = useRef(prompt.prompt_id);
    const visibleRef = useRef(0);
    const promptIsActive = activePromptId === prompt.prompt_id;
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
      setActivePromptId(prompt.prompt_id);
      visibleRef.current = initialVisibleCount;
      completeRef.current = initiallyFinished;
      setVisibleCount(initialVisibleCount);
      setRevealFinished(initiallyFinished);
      setInstantRevealPromptId(revealImmediately ? prompt.prompt_id : null);
      promptIdRef.current = prompt.prompt_id;
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

    const effectivePaused =
      promptIdRef.current === prompt.prompt_id
        ? paused
        : isPauseAt(0, pauseWindows);
    const typing =
      promptIsActive && visible && !disabled && !complete && !effectivePaused;
    useEffect(() => {
      onTypingChange(typing, typingCps);
      return () => onTypingChange(false, typingCps);
    }, [onTypingChange, typing, typingCps]);

    return (
      <section
        aria-hidden={!visible}
        aria-label="对话"
        className={`dialogue-box${visible ? " is-visible" : " is-hidden"}`}
      >
        <img
          alt=""
          aria-hidden="true"
          className="dialogue-frame"
          draggable={false}
          height={407}
          src={dialogueBoxUrl}
          width={1920}
        />
        {prompt.speaker !== null && (
          <span
            className="speaker-name"
            style={{ color: prompt.name_color ?? undefined }}
          >
            <img
              alt=""
              aria-hidden="true"
              draggable={false}
              height={193}
              src={nameBoxUrl}
              width={364}
            />
            <span>{prompt.speaker}</span>
          </span>
        )}
        <span
          className="dialogue-text"
          style={{ color: prompt.text_color ?? undefined }}
        >
          <MarkupText
            animateMath
            instantMathReveal={instantRevealPromptId === prompt.prompt_id}
            onMathMetrics={handleMathMetrics}
            source={prompt.text}
            unitCps={unitCps}
            visibleCount={renderedVisibleCount}
          />
        </span>
        <span className={`advance-indicator${complete ? " is-ready" : ""}`}>
          ◆
        </span>
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
