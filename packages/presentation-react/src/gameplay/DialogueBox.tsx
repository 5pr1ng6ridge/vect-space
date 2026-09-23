import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type ReactElement,
} from "react";

import {
  buildVisibleUnitCps,
  formulaRevealDurationMs,
  parseMarkup,
} from "@vectspace/text";
import type {
  DialoguePageSnapshot,
  DialoguePrompt,
  TextRevealAnimation,
} from "@vectspace/presentation-core/types";
import type { UiMotionHost } from "@vectspace/presentation-core/ui-motion";
import { MarkupText } from "./MarkupText";
import { AnimatedImage } from "../animated-image";
import { useTextRevealSession } from "./useTextRevealSession";
import type { ImageAssetSource } from "@vectspace/presentation-core/image-animation";

export interface DialogueBoxHandle {
  /** Completes reveal only; it never performs a load-style visual restore. */
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
  dialogueBoxSource: ImageAssetSource | null;
  nameBoxSource: ImageAssetSource | null;
  onTypingChange(typing: boolean, cps: number): void;
  onRevealComplete(instanceKey: string): void;
  /** Per RuntimeUpdate/prompt identity. Revisited prompt ids need a new key. */
  sessionKey?: string;
  /** Saved/no-cue state only; Ctrl uses the imperative complete() method. */
  revealImmediately?: boolean;
  revealAnimation?: TextRevealAnimation;
  fontReady?: boolean;
  /** Scale of the containing 1920×1080 design surface. */
  measurementScale?: number;
  /** Menus and visibility changes freeze the virtual reveal clock. */
  suspended?: boolean;
  motionHost?: UiMotionHost;
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

export const DialogueBox = forwardRef<DialogueBoxHandle, DialogueBoxProps>(
  function DialogueBox(
    {
      prompt,
      page,
      initialCps,
      defaultCps,
      visible,
      disabled,
      dialogueBoxSource,
      nameBoxSource,
      onTypingChange,
      onRevealComplete,
      sessionKey,
      revealImmediately = false,
      revealAnimation = "typewriter",
      fontReady = true,
      measurementScale = 1,
      suspended = false,
      motionHost,
    },
    ref,
  ): ReactElement {
    const promptId = prompt?.prompt_id ?? `${page.page_id}:retained`;
    const instanceKey = sessionKey ?? promptId;
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
    const handleLineSweepLayoutChange = useCallback(
      (ready: boolean): void => {
        setLineSweepReadyKey(ready ? instanceKey : null);
      },
      [instanceKey],
    );
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
      fontReady &&
      metricsReady &&
      (revealAnimation !== "line_sweep" || lineSweepReadyKey === instanceKey);
    const handleSessionComplete = useCallback((): void => {
      if (prompt !== null) onRevealComplete(instanceKey);
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
    const complete = session.isComplete();
    const visibleCount = session.state.revealedCount;
    const typingCps =
      unitCps[Math.min(visibleCount, Math.max(0, unitCps.length - 1))] ??
      initialCps;

    useImperativeHandle(
      ref,
      () => ({
        complete: session.completeReveal,
        isComplete: session.isComplete,
      }),
      [session.completeReveal, session.isComplete],
    );

    useEffect(() => {
      const typing =
        prompt !== null &&
        visible &&
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
      prompt,
      session.state.activePause,
      suspended,
      typingCps,
      visible,
    ]);

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
        <div className="dialogue-surface" ref={dialogueFrameRef}>
          <AnimatedImage
            alt=""
            className="dialogue-frame"
            height={407}
            paused={suspended ?? false}
            source={dialogueBoxSource}
            width={1920}
          />
          {page.speaker !== null && (
            <span
              className="speaker-name"
              ref={dialogueNameplateRef}
              style={{ color: page.name_color ?? undefined }}
            >
              <AnimatedImage
                alt=""
                height={193}
                paused={suspended ?? false}
                source={nameBoxSource}
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
            <MarkupText
              measurementScale={measurementScale}
              source={completedText}
            />
            <MarkupText
              animateMath
              fontReady={fontReady}
              instantMathReveal={complete}
              instantReveal={complete}
              lineSweepElapsedMs={session.state.elapsedMs}
              mathRevealDurations={mathRevealDurations}
              measurementScale={measurementScale}
              onMathMetrics={handleMathMetrics}
              onLineSweepLayoutChange={handleLineSweepLayoutChange}
              pauseWindows={session.plan.pauses}
              revealAnimation={revealAnimation}
              revealClock={session.clock}
              revealSchedule={session.plan.events.map((event) => event.atMs)}
              source={currentText}
              unitCps={unitCps}
              visibleCount={visibleCount}
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
        </div>
      </section>
    );
  },
);
