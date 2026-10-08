import type {
  DialoguePrompt,
  LongTextPrompt,
  PresentationCue,
  RuntimeUpdate,
} from "@vectspace/presentation-core/types";

type TimelineCue = Extract<PresentationCue, { type: "timeline" }>;

/** What the current update asks the gameplay layers to show. */
export function describePrompt(update: RuntimeUpdate | null) {
  const prompt = update?.snapshot.prompt;
  const dialogue = prompt?.kind === "dialogue" ? prompt : null;
  const longText = prompt?.kind === "long_text" ? prompt : null;
  const choice = prompt?.kind === "choice" ? prompt : null;
  const textPrompt: DialoguePrompt | LongTextPrompt | null =
    dialogue ?? longText;
  const dialoguePage =
    update?.snapshot.dialogue_page ??
    (dialogue === null
      ? null
      : {
          page_id: dialogue.prompt_id,
          speaker: dialogue.speaker,
          speaker_id: dialogue.speaker_id ?? null,
          name_color: dialogue.name_color ?? null,
          text_color: dialogue.text_color ?? null,
          segments: [dialogue.text],
        });
  const hasUiMotionCue =
    update?.cues.some(
      (cue) =>
        cue.type === "dialogue_ui_transition" || cue.type === "ui_motion",
    ) ?? false;
  // A UI-motion cue can show the (empty) dialogue frame without any prompt.
  const renderedDialoguePage =
    longText === null
      ? (dialoguePage ??
        (hasUiMotionCue
          ? {
              page_id: "ui_motion_preview",
              speaker: null,
              speaker_id: null,
              name_color: null,
              text_color: null,
              segments: [""],
            }
          : null))
      : null;
  return {
    dialogue,
    longText,
    choice,
    textPrompt,
    renderedDialoguePage,
    longTextPage: update?.snapshot.long_text_page ?? null,
    timelineCue: update?.cues.find(
      (cue): cue is TimelineCue => cue.type === "timeline",
    ),
    runtimeTimelineCue: update?.cues.find(
      (cue): cue is TimelineCue =>
        cue.type === "timeline" && cue.gate === "runtime",
    ),
    playback: update?.snapshot.playback ?? {
      auto: "normal" as const,
      ctrl_fast_forward: "allow" as const,
    },
  };
}

export type PromptView = ReturnType<typeof describePrompt>;
