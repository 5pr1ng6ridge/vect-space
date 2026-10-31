import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ProofBoardSpec,
  ProofCheckResult,
  ProofGraph,
} from "@vectspace/presentation-core/proof";
import type { ProofPrompt } from "@vectspace/presentation-core/types";
import { ProofPromptLayer } from "./ProofPromptLayer";
const api = vi.hoisted(() => ({
  proofBoard: vi.fn(),
  proofCheck: vi.fn(),
  proofSaveDraft: vi.fn(),
}));
vi.mock("../engine/api", () => ({ engineApi: api }));
const f = { text: "p", latex: "p" };
const initial: ProofGraph = {
  nodes: [{ id: "goal", kind: "goal", x: 500, y: 50 }],
  edges: [],
};
const draft: ProofGraph = {
  nodes: [
    ...initial.nodes,
    { id: "saved", kind: "claim", x: 20, y: 30, statement: "p" },
  ],
  edges: [],
};
const spec: ProofBoardSpec = {
  puzzle: {
    id: "puzzle",
    title: "恢复证明",
    description: null,
    variables: [],
    hypotheses: [],
    goal: f,
  },
  cards: [],
  node_kinds: ["claim"],
  tactics: [],
  initial_graph: initial,
};
const prompt: ProofPrompt = {
  kind: "proof",
  prompt_id: "proof1",
  puzzle: "puzzle",
  draft,
  can_abandon: true,
};
const feedback: ProofCheckResult = {
  status: "complete",
  nodes: {},
  ports: {},
  locals: {},
  fields: {},
  diagnostics: [],
  elapsed_ms: 1,
};
beforeEach(() => {
  vi.useFakeTimers();
  api.proofBoard.mockReset().mockResolvedValue(spec);
  api.proofCheck.mockReset().mockResolvedValue(feedback);
  api.proofSaveDraft.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("loads spec, restores prompt draft, saves it and forwards submit/abandon", async () => {
  const submit = vi.fn().mockResolvedValue({ accepted: true, check: feedback });
  const abandon = vi.fn();
  const { container } = render(
    <ProofPromptLayer
      prompt={prompt}
      sessionId="9"
      onSubmit={submit}
      onAbandon={abandon}
      onDiagnostic={vi.fn()}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(api.proofBoard).toHaveBeenCalledWith("puzzle");
  expect(container.querySelector('[data-proof-node="saved"]')).not.toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
  expect(api.proofCheck).toHaveBeenCalledWith("puzzle", draft);
  expect(api.proofSaveDraft).toHaveBeenCalledWith("proof1", draft, "9");
  fireEvent.click(screen.getByRole("button", { name: "提交证明" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(submit).toHaveBeenCalledWith(draft);
  fireEvent.click(screen.getByRole("button", { name: "放弃" }));
  fireEvent.click(screen.getByRole("button", { name: "确认放弃" }));
  expect(abandon).toHaveBeenCalledOnce();
});
it("cancels a stale spec load after switching prompts", async () => {
  let resolveOld!: (value: ProofBoardSpec) => void;
  api.proofBoard.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const props = {
    sessionId: "9",
    onSubmit: vi.fn().mockResolvedValue({ accepted: true, check: feedback }),
    onAbandon: vi.fn(),
    onDiagnostic: vi.fn(),
  };
  const { rerender } = render(
    <ProofPromptLayer key="proof1" prompt={prompt} {...props} />,
  );
  rerender(
    <ProofPromptLayer
      key="proof2"
      prompt={{ ...prompt, prompt_id: "proof2", puzzle: "next", draft: null }}
      {...props}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  act(() =>
    resolveOld({ ...spec, puzzle: { ...spec.puzzle, title: "旧题目" } }),
  );
  expect(screen.getByRole("dialog", { name: "恢复证明" })).toBeInTheDocument();
  expect(screen.queryByText("旧题目")).not.toBeInTheDocument();
});
it("renders a retryable board load error", async () => {
  api.proofBoard.mockRejectedValueOnce(new Error("无法读取题目"));
  render(
    <ProofPromptLayer
      prompt={prompt}
      sessionId="9"
      onSubmit={vi.fn()}
      onAbandon={vi.fn()}
      onDiagnostic={vi.fn()}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByText("无法读取题目")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByRole("dialog", { name: "恢复证明" })).toBeInTheDocument();
});
