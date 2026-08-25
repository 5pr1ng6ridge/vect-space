import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { buildRevealSchedule, parseMarkup } from "../engine/markup";
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
    },
    ref,
  ): ReactElement {
    const schedule = useMemo(
      () =>
        buildRevealSchedule(parseMarkup(prompt.text), initialCps, defaultCps),
      [defaultCps, initialCps, prompt.text],
    );
    const [visibleCount, setVisibleCount] = useState(0);
    const visibleRef = useRef(0);
    const complete = visibleCount >= schedule.length;
    const completeRef = useRef(complete);

    useEffect(() => {
      visibleRef.current = 0;
      completeRef.current = schedule.length === 0;
      setVisibleCount(0);
      const startedAt = performance.now();
      let frame = 0;
      const tick = (now: number): void => {
        const elapsed = now - startedAt;
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
    }, [prompt.prompt_id, schedule]);

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

    const typing = visible && !disabled && !complete;
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
          <span className="speaker-name">
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
        <span className="dialogue-text">
          <MarkupText source={prompt.text} visibleCount={visibleCount} />
        </span>
        <span className={`advance-indicator${complete ? " is-ready" : ""}`}>
          ◆
        </span>
      </section>
    );
  },
);
