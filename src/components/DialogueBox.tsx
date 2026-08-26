import {
  forwardRef,
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
  parseMarkup,
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
  onTypingChange(typing: boolean): void;
  onRevealComplete(promptId: string): void;
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
    },
    ref,
  ): ReactElement {
    const units = useMemo(() => parseMarkup(prompt.text), [prompt.text]);
    const schedule = useMemo(
      () => buildRevealSchedule(units, initialCps, defaultCps),
      [defaultCps, initialCps, units],
    );
    const pauseWindows = useMemo(
      () => buildPauseWindows(units, initialCps, defaultCps),
      [defaultCps, initialCps, units],
    );
    const [visibleCount, setVisibleCount] = useState(0);
    const [paused, setPaused] = useState(() => isPauseAt(0, pauseWindows));
    const promptIdRef = useRef(prompt.prompt_id);
    const visibleRef = useRef(0);
    const complete = visibleCount >= schedule.length;
    const completeRef = useRef(complete);
    const reportedPromptRef = useRef<string | null>(null);

    useEffect(() => {
      visibleRef.current = 0;
      completeRef.current = schedule.length === 0;
      setVisibleCount(0);
      promptIdRef.current = prompt.prompt_id;
      setPaused(isPauseAt(0, pauseWindows));
      const startedAt = performance.now();
      let frame = 0;
      const tick = (now: number): void => {
        const elapsed = now - startedAt;
        const nextPaused = isPauseAt(elapsed, pauseWindows);
        setPaused((current) => (current === nextPaused ? current : nextPaused));
        let next = visibleRef.current;
        while (
          next < schedule.length &&
          (schedule[next] ?? Number.POSITIVE_INFINITY) <= elapsed
        ) {
          next += 1;
        }
        if (next !== visibleRef.current) {
          visibleRef.current = next;
          completeRef.current = next >= schedule.length;
          setVisibleCount(next);
        }
        if (next < schedule.length) {
          frame = requestAnimationFrame(tick);
        }
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }, [pauseWindows, prompt.prompt_id, schedule]);

    useImperativeHandle(
      ref,
      () => ({
        complete: () => {
          visibleRef.current = schedule.length;
          completeRef.current = true;
          setVisibleCount(schedule.length);
        },
        isComplete: () => completeRef.current,
      }),
      [schedule.length],
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
    const typing = visible && !disabled && !complete && !effectivePaused;
    useEffect(() => {
      onTypingChange(typing);
      return () => onTypingChange(false);
    }, [onTypingChange, typing]);

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
          <MarkupText source={prompt.text} visibleCount={visibleCount} />
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
