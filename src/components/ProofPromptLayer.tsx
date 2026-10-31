import { useEffect, useState, type ReactElement } from "react";
import { ProofBoard } from "@vectspace/presentation-react/proof";
import type {
  ProofBoardSpec,
  ProofCheckResult,
  ProofGraph,
} from "@vectspace/presentation-core/proof";
import type { ProofPrompt } from "@vectspace/presentation-core/types";
import type { WireU64 } from "../../shared/generated/WireU64";
import { errorMessage } from "../../shared/commandError";
import { engineApi } from "../engine/api";

interface ProofPromptLayerProps {
  prompt: ProofPrompt;
  sessionId: WireU64;
  onSubmit(
    graph: ProofGraph,
  ): Promise<{ accepted: boolean; check: ProofCheckResult }>;
  onAbandon(): void;
  onDiagnostic(message: string): void;
}
/** Mounted by prompt id so async loads and local history cannot leak into another puzzle. */
export function ProofPromptLayer({
  prompt,
  sessionId,
  onSubmit,
  onAbandon,
  onDiagnostic,
}: ProofPromptLayerProps): ReactElement {
  const [loaded, setLoaded] = useState<
    { spec: ProofBoardSpec } | { error: string } | null
  >(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void engineApi
      .proofBoard(prompt.puzzle)
      .then((spec) => {
        if (active) setLoaded({ spec });
      })
      .catch((reason: unknown) => {
        if (active) setLoaded({ error: errorMessage(reason) });
      });
    return () => {
      active = false;
    };
  }, [prompt.puzzle, sessionId, attempt]);
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
      check={(graph) => engineApi.proofCheck(prompt.puzzle, graph)}
      onDraftChange={(graph) => {
        void engineApi
          .proofSaveDraft(prompt.prompt_id, graph, sessionId)
          .catch((reason: unknown) => onDiagnostic(errorMessage(reason)));
      }}
      submit={onSubmit}
      onAbandon={onAbandon}
    />
  );
}
