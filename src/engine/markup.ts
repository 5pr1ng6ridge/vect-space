/**
 * Compatibility boundary for game code.
 *
 * Text syntax, grapheme parsing and reveal timing live in `@vectspace/text`.
 * Keeping this tiny module lets older game imports migrate gradually without
 * allowing a second parser or scheduler to grow here again.
 */
export {
  autoReadingDelay,
  buildPauseWindows,
  buildRevealSchedule,
  buildVisibleUnitCps,
  formulaPresentationDurationMs,
  formulaRevealDurationForUnit,
  formulaRevealDurationMs,
  hasImmediateAutoAdvance,
  mathRevealDurationMs,
  parseMarkup,
  revealCompletionTime,
  revealUnits,
  visibleUnits,
} from "@vectspace/text";

export type {
  AutoAdvanceUnit,
  CharacterUnit,
  HardBreakUnit,
  LayoutUnit,
  MarkupUnit,
  MathUnit,
  PauseUnit,
  PauseWindow,
  RevealTimingOptions,
  RevealUnit,
  SourceSpan,
  SpeedUnit,
  TextEffect,
} from "@vectspace/text";

/** A layout unit may be a grapheme, a TeX atom, or an explicit hard break. */
export type { LayoutUnit as VisibleUnit } from "@vectspace/text";

/**
 * Retained only for callers that have not yet switched to TextRevealSession.
 * `completeReveal()` and `restorePresentation()` are deliberately separate
 * in the shared session; this helper never represents either operation.
 */
export function resolveInstantRevealPromptId(
  current: string | null,
  promptId: string,
  previousPromptId: string,
  restorePresentation: boolean,
): string | null {
  if (restorePresentation) return promptId;
  return previousPromptId === promptId ? current : null;
}
