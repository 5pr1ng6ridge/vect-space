import { describe, expect, it } from "vitest";
import {
  addProofNode,
  connectProof,
  createProofHistory,
  disconnectProof,
  freshProofBinder,
  freshProofId,
  moveProofNode,
  proofKindDescriptions,
  proofKindLabels,
  proofPortKey,
  proofPorts,
  pushProofHistory,
  redoProof,
  removeProofNode,
  splitProofPortKey,
  undoProof,
  updateProofNode,
  type ProofBoardSpec,
  type ProofGraph,
  type ProofGraphNode,
  type ProofNodeKind,
} from "./proof";
const formula = { text: "p", latex: "p" };
const graph: ProofGraph = {
  nodes: [
    { id: "given", kind: "given", hypothesis: "h", x: 0, y: 0 },
    { id: "goal", kind: "goal", x: 900, y: 0 },
  ],
  edges: [],
};
const spec: ProofBoardSpec = {
  puzzle: {
    id: "test",
    title: "题目",
    description: null,
    variables: [{ name: "x", type: formula }],
    hypotheses: [{ name: "h", label: null, statement: formula }],
    goal: formula,
  },
  cards: [
    {
      id: "pair",
      name: "合取",
      description: null,
      params: [{ name: "p", type: formula }],
      premises: [formula, formula],
      conclusion: formula,
    },
  ],
  node_kinds: [
    "card",
    "mp",
    "inst",
    "intro",
    "cases",
    "exists_intro",
    "exists_elim",
    "induction",
    "claim",
    "auto",
  ],
  tactics: [{ id: "exact", name: "由已知" }],
  initial_graph: graph,
};
function node(
  kind: ProofNodeKind,
  extra: Partial<ProofGraphNode> = {},
): ProofGraphNode {
  return { id: kind, kind, x: 0, y: 0, ...extra };
}
const edge = (from: string, to: string, to_port = "in", from_port = "out") => ({
  from,
  from_port,
  to,
  to_port,
});
describe("proofPorts", () => {
  it.each<[ProofNodeKind, string[], string[]]>([
    ["given", [], []],
    ["goal", ["in"], []],
    ["card", ["p0", "p1"], []],
    ["mp", ["imp", "arg"], []],
    ["inst", ["all"], []],
    ["intro", ["body"], ["body"]],
    ["cases", ["or", "left", "right"], ["left", "right"]],
    ["exists_intro", ["proof"], []],
    ["exists_elim", ["exists", "body"], ["body", "body"]],
    ["induction", ["base", "step"], ["step", "step"]],
    ["claim", ["in"], []],
    ["auto", ["facts"], []],
  ])("mirrors %s ports", (kind, inputs, scopes) => {
    const ports = proofPorts(node(kind, { card: "pair" }), spec);
    expect(ports.inputs).toEqual(
      inputs.map((id) => ({ id, multi: kind === "auto" })),
    );
    expect(ports.has_output).toBe(kind !== "goal");
    expect(ports.locals).toEqual(
      scopes.map((scope, index) => ({ id: `l${index}`, scope })),
    );
  });
  it("uses the spec premise count and at least one intro binder", () => {
    expect(proofPorts(node("card", { card: "unknown" }), spec).inputs).toEqual(
      [],
    );
    expect(
      proofPorts(node("intro", { binders: [] }), spec).locals,
    ).toHaveLength(1);
    expect(
      proofPorts(node("intro", { binders: ["a", "b", "c"] }), spec).locals,
    ).toHaveLength(3);
  });
});
describe("proof graph editing", () => {
  it("adds nodes with fresh ids and kind defaults, without mutating the graph", () => {
    const next = addProofNode(graph, spec, "card", {
      card: "pair",
      x: 20,
      y: 30,
    });
    expect(next.nodes[2]).toEqual({
      id: "node1",
      kind: "card",
      card: "pair",
      args: [""],
      x: 20,
      y: 30,
    });
    expect(graph.nodes).toHaveLength(2);
    expect(addProofNode(next, spec, "intro").nodes[3]?.binders).toEqual(["x1"]);
    expect(addProofNode(graph, spec, "exists_elim").nodes[2]?.binders).toEqual([
      "x1",
    ]);
    expect(addProofNode(graph, spec, "induction").nodes[2]?.binders).toEqual([
      "k",
    ]);
    expect(addProofNode(graph, spec, "inst").nodes[2]?.term).toBe("");
    expect(addProofNode(graph, spec, "exists_intro").nodes[2]?.term).toBe("");
    expect(addProofNode(graph, spec, "claim").nodes[2]?.statement).toBe("");
    expect(addProofNode(graph, spec, "auto").nodes[2]?.tactic).toBe("exact");
    expect(addProofNode(graph, spec, "given").nodes[2]?.hypothesis).toBe("h");
    expect(addProofNode(graph, spec, "goal")).toBe(graph);
    expect(addProofNode(graph, { ...spec, node_kinds: [] }, "card")).toBe(
      graph,
    );
    expect(addProofNode(graph, spec, "card", { card: "missing" })).toBe(graph);
    expect(addProofNode(graph, spec, "given", { hypothesis: "missing" })).toBe(
      graph,
    );
    expect(addProofNode(graph, { ...spec, tactics: [] }, "auto")).toBe(graph);
    expect(next.nodes[2]).not.toHaveProperty("statement");
  });
  it("keeps generated names unique against puzzle and graph binders", () => {
    const existing = {
      ...graph,
      nodes: [
        ...graph.nodes,
        node("intro", { id: "node1", binders: ["x1", "k"] }),
      ],
    };
    expect(freshProofId(existing)).toBe("node2");
    expect(freshProofBinder(existing, spec)).toBe("x2");
    expect(freshProofBinder(existing, spec, "h")).toBe("h1");
  });
  it("moves and edits immutably, removes incident edges, protects given/goal", () => {
    const before = addProofNode(graph, spec, "claim");
    const wired = {
      ...before,
      edges: [edge("given", "node1"), edge("node1", "goal")],
    };
    const moved = moveProofNode(wired, "node1", 42, 58);
    expect(moved.nodes[2]).toMatchObject({ x: 42, y: 58 });
    expect(wired.nodes[2]?.x).toBe(380);
    expect(moveProofNode(wired, "node1", NaN, 1)).toBe(wired);
    expect(updateProofNode(wired, "missing", {})).toBe(wired);
    expect(removeProofNode(wired, "node1")).toEqual(graph);
    expect(removeProofNode(wired, "given")).toBe(wired);
    expect(removeProofNode(wired, "goal")).toBe(wired);
    expect(removeProofNode(wired, "missing")).toBe(wired);
  });
  it("validates endpoints, direction, locals and single-input replacement", () => {
    const base = {
      ...graph,
      nodes: [...graph.nodes, node("intro"), node("claim"), node("auto")],
    };
    for (const invalid of [
      edge("missing", "goal"),
      edge("given", "missing"),
      edge("goal", "claim"),
      edge("given", "goal", "out"),
      edge("given", "goal", "in", "l0"),
      edge("claim", "claim"),
    ])
      expect(connectProof(base, spec, invalid)).toBe(base);
    const first = connectProof(base, spec, edge("given", "goal"));
    expect(connectProof(first, spec, edge("claim", "goal")).edges).toEqual([
      edge("claim", "goal"),
    ]);
    const local = connectProof(base, spec, edge("intro", "claim", "in", "l0"));
    expect(local.edges).toHaveLength(1);
    const scoped = connectProof(local, spec, edge("claim", "intro", "body"));
    expect(scoped.edges).toHaveLength(2);
    expect(
      connectProof(scoped, spec, edge("intro", "intro", "body", "l0")),
    ).toBe(scoped);
    const multi = connectProof(
      connectProof(base, spec, edge("given", "auto", "facts")),
      spec,
      edge("claim", "auto", "facts"),
    );
    expect(multi.edges).toHaveLength(2);
    expect(connectProof(multi, spec, edge("given", "auto", "facts"))).toBe(
      multi,
    );
  });
  it("rejects indirect value cycles and disconnects by edge index", () => {
    const base = {
      ...graph,
      nodes: [
        ...graph.nodes,
        node("claim", { id: "a" }),
        node("claim", { id: "b" }),
        node("claim", { id: "c" }),
      ],
      edges: [edge("a", "b"), edge("b", "c")],
    };
    expect(connectProof(base, spec, edge("c", "a"))).toBe(base);
    expect(disconnectProof(base, 0).edges).toEqual([edge("b", "c")]);
    expect(disconnectProof(base, 100)).toBe(base);
    expect(disconnectProof(base, -1)).toBe(base);
  });
  it("has labels/descriptions and round-trips port keys", () => {
    for (const kind of [
      "given",
      "goal",
      ...spec.node_kinds,
    ] as ProofNodeKind[]) {
      expect(proofKindLabels[kind]).toBeTruthy();
      expect(proofKindDescriptions[kind]).toBeTruthy();
    }
    expect(proofPortKey("a", "l0")).toBe("a/l0");
    expect(splitProofPortKey("a/l0")).toEqual({ id: "a", port: "l0" });
    for (const key of ["a", "/p0", "a/", "a/p0/extra"])
      expect(splitProofPortKey(key)).toBeNull();
  });
});
describe("proof history", () => {
  it("undoes/redoes, ignores equivalent graphs, clears redo on edit and caps memory", () => {
    const start = createProofHistory(graph);
    expect(undoProof(start)).toBe(start);
    expect(redoProof(start)).toBe(start);
    expect(pushProofHistory(start, { ...graph })).toBe(start);
    const edited = pushProofHistory(start, addProofNode(graph, spec, "claim"));
    const undone = undoProof(edited);
    expect(undone.present).toBe(graph);
    expect(redoProof(undone)).toEqual(edited);
    expect(
      pushProofHistory(undone, addProofNode(graph, spec, "intro")).future,
    ).toEqual([]);
    let history = start;
    for (let i = 0; i < 110; i++)
      history = pushProofHistory(
        history,
        moveProofNode(history.present, "goal", i, 0),
      );
    expect(history.past).toHaveLength(100);
  });
});
