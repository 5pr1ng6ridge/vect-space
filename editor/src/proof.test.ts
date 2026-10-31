import { describe, expect, it } from "vitest";
import {
  defaultNode,
  insertNode,
  outputPorts,
  preparePastedNode,
  renameNode,
  setPortTarget,
  projectRequest,
} from "./story";
import { describeNode } from "./nodeSummary";
import { storyProject } from "./test/storyProject";
import { validateLive } from "./validation";
import { timerTargetAllowed } from "./windowInteraction";
import type { ProofFile, ProofNode } from "./types";

const proofs: ProofFile[] = [
  {
    path: "proofs/basics.yaml",
    definition: { puzzles: [{ id: "truth", title: "真命题", goal: "True" }] },
  },
];
const proof: ProofNode = {
  type: "proof",
  puzzle: "truth",
  next: "left",
  abandon: "right",
};

function project() {
  const value = storyProject();
  value.manifest.proofs = [proofs[0].path];
  value.proofs = structuredClone(proofs);
  value.scenes[0].definition.nodes.start = { ...proof };
  return value;
}

describe("proof story authoring", () => {
  it("uses the first puzzle when adding or inserting a proof", () => {
    expect(defaultNode("proof", "end", [], proofs)).toEqual({
      type: "proof",
      puzzle: "truth",
      next: "end",
    });
    expect(defaultNode("proof", "end")).toEqual({
      type: "proof",
      puzzle: "",
      next: "end",
    });
    const inserted = insertNode(project(), "main", "left", "right", "proof");
    expect(inserted.ok).toBe(true);
    if (inserted.ok)
      expect(
        inserted.project.scenes[0].definition.nodes[inserted.nodeId],
      ).toMatchObject({ type: "proof", puzzle: "truth" });
  });

  it("maps both proof ports and renames their targets", () => {
    expect(outputPorts(proof).map(({ id, target }) => [id, target])).toEqual([
      ["next", "left"],
      ["abandon", "right"],
    ]);
    expect(outputPorts({ ...proof, abandon: null })).toHaveLength(1);
    expect(setPortTarget(proof, "abandon", "end")).toMatchObject({
      abandon: "end",
    });
    const renamed = renameNode(project(), "main", "right", "gave_up");
    expect(renamed.scenes[0].definition.nodes.start).toMatchObject({
      abandon: "gave_up",
    });
    expect(preparePastedNode(proof, project().manifest)).toEqual({
      type: "proof",
      puzzle: "truth",
      next: "",
    });
  });

  it("shows the puzzle title and keeps proof documents outside save requests", () => {
    expect(describeNode(proof, { proofs }).summary).toBe("真命题");
    expect(describeNode(proof).summary).toBe("truth");
    expect(projectRequest(project()).manifest.proofs).toEqual([
      "proofs/basics.yaml",
    ]);
    expect(projectRequest(project())).not.toHaveProperty("proofs");
    expect(timerTargetAllowed(proof)).toBe(false);
  });

  it("validates puzzles, both targets and the main-window restriction", () => {
    const value = project();
    expect(
      validateLive(value).filter((issue) => issue.severity === "error"),
    ).toEqual([]);
    value.scenes[0].definition.nodes.start = {
      ...proof,
      puzzle: "",
      abandon: "missing",
    };
    expect(validateLive(value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_proof_puzzle" }),
        expect.objectContaining({ code: "missing_target_node" }),
      ]),
    );
    value.scenes[0].definition.nodes.start = { ...proof, puzzle: "missing" };
    value.scenes[0].definition.window_role = "secondary";
    expect(validateLive(value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unknown_proof_puzzle" }),
        expect.objectContaining({ code: "secondary_proof" }),
      ]),
    );
  });
});
