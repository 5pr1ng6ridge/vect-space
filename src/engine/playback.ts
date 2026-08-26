import type { PlaybackSnapshot, PromptSnapshot, SkipMode } from "./types";

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
  if (prompt.kind !== "dialogue") {
    return false;
  }
  return skipMode === "all" || prompt.is_read;
}
