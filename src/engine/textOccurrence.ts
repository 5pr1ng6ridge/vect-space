import { useState } from "react";

import { promptOccurrence } from "@vectspace/presentation-core/live-update";
import type {
  DialoguePrompt,
  LongTextPrompt,
  RuntimeUpdate,
  TextRevealAnimation,
} from "@vectspace/presentation-core/types";

/**
 * Reveal settings of one prompt occurrence.
 *
 * They are decided once, from the update that *first* shows the occurrence, and
 * then held: a later update of the same occurrence (a refresh, a button click,
 * an interpolation change) carries no reveal cue of its own and must not turn a
 * line that is still typing into one that appears instantly - nor restart it.
 */
export interface TextOccurrence {
  /** Identity of this occurrence; the reveal session and dialogue key. */
  key: string;
  hasRevealCue: boolean;
  speedCps: number | null | undefined;
  animation: TextRevealAnimation | null;
}

function textOccurrenceKey(
  update: RuntimeUpdate | null,
  prompt: DialoguePrompt | LongTextPrompt | null,
): string | null {
  return update === null || prompt === null
    ? null
    : `${promptOccurrence(update)}:${prompt.prompt_id}`;
}

function revealCue(
  update: RuntimeUpdate,
  prompt: DialoguePrompt | LongTextPrompt,
) {
  return update.cues.find(
    (candidate) =>
      (candidate.type === "dialogue_reveal" ||
        candidate.type === "long_text_reveal") &&
      candidate.prompt_id === prompt.prompt_id,
  );
}

function describe(
  key: string,
  update: RuntimeUpdate,
  prompt: DialoguePrompt | LongTextPrompt,
): TextOccurrence {
  const cue = revealCue(update, prompt);
  const isReveal =
    cue?.type === "dialogue_reveal" || cue?.type === "long_text_reveal";
  return {
    key,
    hasRevealCue: cue !== undefined,
    speedCps: isReveal ? cue.speed_cps : undefined,
    animation: isReveal ? (cue.reveal_animation ?? null) : null,
  };
}

/** Returns the held reveal settings of the active text prompt, if any. */
export function useTextOccurrence(
  update: RuntimeUpdate | null,
  prompt: DialoguePrompt | LongTextPrompt | null,
): TextOccurrence | null {
  const key = textOccurrenceKey(update, prompt);
  const [held, setHeld] = useState<TextOccurrence | null>(null);
  if (key === null || update === null || prompt === null) {
    // State derived from props: adjusted during render, which React applies
    // before painting, instead of lagging one effect behind.
    if (held !== null) setHeld(null);
    return null;
  }
  if (held?.key === key) return held;
  const next = describe(key, update, prompt);
  setHeld(next);
  return next;
}
