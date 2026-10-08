import type {
  DialoguePrompt,
  LongTextPrompt,
  PlaybackSnapshot,
  PromptSnapshot,
  RuntimeUpdate,
  SkipMode,
} from "@vectspace/presentation-core/types";

export function canFastForwardPrompt(
  playback: PlaybackSnapshot,
  skipMode: SkipMode,
  prompt: PromptSnapshot,
): boolean {
  if (
    skipMode === "disabled" ||
    playback.auto === "forced" ||
    playback.ctrl_fast_forward === "block"
  ) {
    return false;
  }
  if (prompt.kind === "none") {
    return true;
  }
  if (prompt.kind !== "dialogue" && prompt.kind !== "long_text") {
    return false;
  }
  return skipMode === "all" || prompt.is_read;
}

/**
 * Ctrl fast-forward for the current frame: `requested` is the player's intent
 * under the script policy, `dialogueAllowed` whether the current text may be
 * skipped under the skip mode, and `active` whether the whole presentation
 * should run fast (`enabled` gates it to the window being in play).
 */
export function fastForwardState(input: {
  ctrlHeld: boolean;
  enabled: boolean;
  playback: PlaybackSnapshot;
  skipMode: SkipMode;
  update: RuntimeUpdate | null;
  textPrompt: DialoguePrompt | LongTextPrompt | null;
  runtimeTimelineCue: { is_seen: boolean } | undefined;
}): { requested: boolean; dialogueAllowed: boolean; active: boolean } {
  const { playback, skipMode, textPrompt, runtimeTimelineCue } = input;
  const requested =
    input.ctrlHeld &&
    playback.auto !== "forced" &&
    playback.ctrl_fast_forward === "allow" &&
    skipMode !== "disabled";
  const dialogueAllowed =
    textPrompt !== null &&
    (skipMode === "all" || (skipMode === "read_only" && textPrompt.is_read));
  const active =
    input.enabled &&
    requested &&
    input.update !== null &&
    canFastForwardPrompt(playback, skipMode, input.update.snapshot.prompt) &&
    (runtimeTimelineCue === undefined ||
      skipMode === "all" ||
      (skipMode === "read_only" && runtimeTimelineCue.is_seen));
  return { requested, dialogueAllowed, active };
}

/** True for targets that handle their own click/Enter (never advance the story). */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "button, input, select, textarea, a, label, [contenteditable='true'], [data-block-story-advance]",
    ) !== null
  );
}
