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
  formulaPresentationDurationMs,
  formulaRevealDurationMs,
  mathRevealDurationMs,
  parseMarkup,
  revealCompletionTime,
  resolveInstantRevealPromptId,
  type RevealTimingOptions,
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
  fontReady?: boolean;
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
      fontReady = true,
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
    const timingOptions = useMemo<RevealTimingOptions>(
      () => ({ waitForInlineMath: revealAnimation !== "drop_fade" }),
      [revealAnimation],
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
    const [activePromptId, setActivePromptId] = useState(promptId);
    const [instantRevealPromptId, setInstantRevealPromptId] = useState<
      string | null
    >(null);
    const [paused, setPaused] = useState(() => isPauseAt(0, pauseWindows));
    const [typingCps, setTypingCps] = useState(() => unitCps[0] ?? initialCps);
    const [lineSweepReadyPromptId, setLineSweepReadyPromptId] = useState<
      string | null
    >(null);
    const promptIdRef = useRef(promptId);
    const visibleRef = useRef(0);
    const promptIsActive = activePromptId === promptId;
    const renderedVisibleCount = promptIsActive ? visibleCount : 0;
    const complete = promptIsActive && revealFinished;
    const completeRef = useRef(complete);
    const reportedPromptRef = useRef<string | null>(null);
    const handleLineSweepLayoutChange = useCallback(
      (ready: boolean): void => {
        setLineSweepReadyPromptId(ready ? promptId : null);
      },
      [promptId],
    );
    const revealReady =
      revealImmediately ||
      (fontReady &&
        (revealAnimation !== "line_sweep" ||
          lineSweepReadyPromptId === promptId));
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
      if (!revealReady) return;
      if (promptIdRef.current === promptId && completeRef.current) return;
      const previousPromptId = promptIdRef.current;
      const initialVisibleCount = revealImmediately ? schedule.length : 0;
      const initiallyFinished = revealImmediately || schedule.length === 0;
      setActivePromptId(promptId);
      visibleRef.current = initialVisibleCount;
      completeRef.current = initiallyFinished;
      setVisibleCount(initialVisibleCount);
      setRevealFinished(initiallyFinished);
      setInstantRevealPromptId((current) =>
        resolveInstantRevealPromptId(
          current,
          promptId,
          previousPromptId,
          revealImmediately,
        ),
      );
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
          timingOptions,
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
      revealReady,
      schedule,
      unitCps,
      units,
      timingOptions,
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
            instantReveal={instantRevealPromptId === promptId}
            lineSweepPaused={effectivePaused}
            mathRevealDurations={mathRevealDurations}
            onMathMetrics={handleMathMetrics}
            revealAnimation={revealAnimation}
            revealSchedule={schedule}
            pauseWindows={pauseWindows}
            fontReady={fontReady}
            source={currentText}
            unitCps={unitCps}
            visibleCount={renderedVisibleCount}
            {...(revealAnimation === "line_sweep"
              ? { onLineSweepLayoutChange: handleLineSweepLayoutChange }
              : {})}
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
  timingOptions: RevealTimingOptions,
): number {
  let visibleIndex = 0;
  for (const unit of units) {
    if (unit.kind !== "character" && unit.kind !== "math") {
      continue;
    }
    const revealAt = schedule[visibleIndex] ?? Number.POSITIVE_INFINITY;
    const duration =
      unit.kind === "math" &&
      (unit.display || timingOptions.waitForInlineMath !== false)
        ? formulaPresentationDurationMs(
            mathRevealDurationMs(
              mathRevealDurations.get(visibleIndex),
              unitCps[visibleIndex] ?? fallbackCps,
            ),
            unit.display,
          )
        : 0;
    if (elapsedMs < revealAt + duration) {
      return unitCps[visibleIndex] ?? fallbackCps;
    }
    visibleIndex += 1;
  }
  return unitCps[unitCps.length - 1] ?? fallbackCps;
}
