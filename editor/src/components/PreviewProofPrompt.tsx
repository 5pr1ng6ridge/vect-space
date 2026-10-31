import { useEffect, useState, type ReactElement } from "react";
import { ProofBoard } from "@vectspace/presentation-react/proof";
import "@vectspace/presentation-react/proof.css";
import type {
  ProofBoardSpec,
  ProofCheckResult,
  ProofGraph,
} from "@vectspace/presentation-core/proof";
import type { ProofPrompt } from "@vectspace/presentation-core/types";
import { editorApi } from "../api";
import { errorMessage } from "./errorMessage";

export function PreviewProofPrompt({
  prompt,
  sessionId,
  onSubmit,
  onAbandon,
  onError,
}: {
  prompt: ProofPrompt;
  sessionId: string;
  onSubmit(
    graph: ProofGraph,
  ): Promise<{ accepted: boolean; check: ProofCheckResult }>;
  onAbandon(): void;
  onError(message: string): void;
}): ReactElement {
  const [loaded, setLoaded] = useState<
    { spec: ProofBoardSpec } | { error: string } | null
  >(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void editorApi
      .previewProofBoard({ session_id: sessionId, puzzle: prompt.puzzle })
      .then((spec) => {
        if (active) setLoaded({ spec });
      })
      .catch((reason: unknown) => {
        if (active) setLoaded({ error: errorMessage(reason) });
      });
    return () => {
      active = false;
    };
  }, [attempt, prompt.puzzle, sessionId]);
  if (!loaded || "error" in loaded)
    return (
      <div
        className="proof-board"
        data-block-story-advance
        role="dialog"
        aria-label="证明板"
      >
        <div className="proof-board-header">
          <h1>{loaded ? loaded.error : "正在打开证明板…"}</h1>
          {loaded && (
            <button
              type="button"
              onClick={() => {
                setLoaded(null);
                setAttempt((value) => value + 1);
              }}
            >
              重试
            </button>
          )}
        </div>
      </div>
    );
  return (
    <ProofBoard
      spec={loaded.spec}
      graph={prompt.draft ?? loaded.spec.initial_graph}
      canAbandon={prompt.can_abandon}
      check={(graph) =>
        editorApi.previewProofCheck({
          session_id: sessionId,
          puzzle: prompt.puzzle,
          graph,
        })
      }
      onDraftChange={(graph) => {
        void editorApi
          .previewProofSaveDraft({
            session_id: sessionId,
            prompt_id: prompt.prompt_id,
            graph,
          })
          .catch((reason: unknown) => onError(errorMessage(reason)));
      }}
      submit={onSubmit}
      onAbandon={onAbandon}
    />
  );
}
