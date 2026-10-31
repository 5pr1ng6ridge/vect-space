import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProofGraph } from "@vectspace/presentation-core/proof";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: (value: string) => value,
}));
import { engineApi } from "./api";
const graph: ProofGraph = { nodes: [], edges: [] };
beforeEach(() => invoke.mockReset());
describe("proof command transport", () => {
  it("uses the exact read-only command args", async () => {
    invoke.mockResolvedValue({});
    await engineApi.proofBoard("puzzle");
    expect(invoke).toHaveBeenLastCalledWith("proof_board", {
      puzzle: "puzzle",
    });
    await engineApi.proofCheck("puzzle", graph);
    expect(invoke).toHaveBeenLastCalledWith("proof_check", {
      puzzle: "puzzle",
      graph,
    });
  });
  it("sends lossless revisions/session ids and decodes accepted updates", async () => {
    invoke.mockResolvedValue(null);
    await engineApi.proofSaveDraft("proof1", graph, "9007199254740993");
    expect(invoke).toHaveBeenLastCalledWith("proof_save_draft", {
      promptId: "proof1",
      graph,
      expectedSessionId: "9007199254740993",
    });
    invoke.mockResolvedValue({
      accepted: true,
      check: {},
      update: {
        snapshot: {
          variables: { n: { kind: "integer", value: "9007199254740993" } },
        },
      },
    });
    const response = await engineApi.proofSubmit(
      "9007199254740994",
      graph,
      "9007199254740993",
    );
    expect(invoke).toHaveBeenLastCalledWith("proof_submit", {
      expectedRevision: "9007199254740994",
      graph,
      expectedSessionId: "9007199254740993",
    });
    expect(response.update?.snapshot.variables.n).toBe(9007199254740993n);
    await engineApi.proofAbandon("17", "5");
    expect(invoke).toHaveBeenLastCalledWith("proof_abandon", {
      expectedRevision: "17",
      expectedSessionId: "5",
    });
  });
});
