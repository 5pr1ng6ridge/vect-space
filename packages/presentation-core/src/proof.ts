/** Proof board wire contract. Optional feedback/graph fields are omitted, never null. */
export type ProofNodeKind =
  | "given"
  | "goal"
  | "card"
  | "mp"
  | "inst"
  | "intro"
  | "cases"
  | "exists_intro"
  | "exists_elim"
  | "induction"
  | "claim"
  | "auto";
export type AutoTactic =
  "omega" | "decide" | "rfl" | "simp" | "exact" | "contradiction";
export interface ProofGraphNode {
  id: string;
  kind: ProofNodeKind;
  x: number;
  y: number;
  hypothesis?: string;
  card?: string;
  args?: string[];
  statement?: string;
  term?: string;
  tactic?: AutoTactic;
  binders?: string[];
}
export interface ProofGraphEdge {
  from: string;
  from_port: string;
  to: string;
  to_port: string;
}
export interface ProofGraph {
  nodes: ProofGraphNode[];
  edges: ProofGraphEdge[];
}
export interface ProofFormula {
  text: string;
  latex: string | null;
}
export interface NodeFeedback {
  type?: ProofFormula;
  sorry?: boolean;
}
export interface PortMismatch {
  expected: ProofFormula;
  actual: ProofFormula;
}
export interface PortFeedback {
  expected?: ProofFormula;
  open?: boolean;
  mismatch?: PortMismatch;
}
export interface LocalFeedback {
  type?: ProofFormula;
}
export interface FieldFeedback {
  latex?: string;
  error?: string;
}
export type ProofStatus = "complete" | "incomplete" | "unavailable";
export type DiagnosticSeverity = "error" | "warning" | "info";
export interface ProofDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  detail?: string;
  node?: string;
  port?: string;
  field?: string;
  edge?: number;
}
export interface ProofCheckResult {
  status: ProofStatus;
  nodes: Record<string, NodeFeedback>;
  ports: Record<string, PortFeedback>;
  locals: Record<string, LocalFeedback>;
  fields: Record<string, FieldFeedback>;
  diagnostics: ProofDiagnostic[];
  elapsed_ms: number;
}
export interface BoardNamedFormula {
  name: string;
  type: ProofFormula;
}
export interface BoardHypothesis {
  name: string;
  label: string | null;
  statement: ProofFormula;
}
export interface BoardPuzzle {
  id: string;
  title: string;
  description: string | null;
  variables: BoardNamedFormula[];
  hypotheses: BoardHypothesis[];
  goal: ProofFormula;
}
export interface BoardCard {
  id: string;
  name: string;
  description: string | null;
  params: BoardNamedFormula[];
  premises: ProofFormula[];
  conclusion: ProofFormula;
}
export interface BoardTactic {
  id: AutoTactic;
  name: string;
}
export interface ProofBoardSpec {
  puzzle: BoardPuzzle;
  cards: BoardCard[];
  node_kinds: ProofNodeKind[];
  tactics: BoardTactic[];
  initial_graph: ProofGraph;
}
export interface InputPort {
  id: string;
  multi: boolean;
}
export interface LocalPort {
  id: string;
  scope: string;
}
export interface NodePorts {
  inputs: InputPort[];
  has_output: boolean;
  locals: LocalPort[];
}

/** Mirrors vectspace-proof::graph::node_ports, including unknown-card and empty-binder behavior. */
export function proofPorts(
  node: ProofGraphNode,
  spec: Pick<ProofBoardSpec, "cards">,
): NodePorts {
  const single = (...ids: string[]): InputPort[] =>
    ids.map((id) => ({ id, multi: false }));
  const locals = (...scopes: string[]): LocalPort[] =>
    scopes.map((scope, index) => ({ id: `l${index}`, scope }));
  let inputs: InputPort[] = [];
  let localPorts: LocalPort[] = [];
  switch (node.kind) {
    case "given":
      break;
    case "goal":
      inputs = single("in");
      break;
    case "card":
      inputs = single(
        ...(
          spec.cards.find((card) => card.id === node.card)?.premises ?? []
        ).map((_, i) => `p${i}`),
      );
      break;
    case "mp":
      inputs = single("imp", "arg");
      break;
    case "inst":
      inputs = single("all");
      break;
    case "intro":
      inputs = single("body");
      localPorts = locals(
        ...Array<string>(Math.max(1, node.binders?.length ?? 1)).fill("body"),
      );
      break;
    case "cases":
      inputs = single("or", "left", "right");
      localPorts = locals("left", "right");
      break;
    case "exists_intro":
      inputs = single("proof");
      break;
    case "exists_elim":
      inputs = single("exists", "body");
      localPorts = locals("body", "body");
      break;
    case "induction":
      inputs = single("base", "step");
      localPorts = locals("step", "step");
      break;
    case "claim":
      inputs = single("in");
      break;
    case "auto":
      inputs = [{ id: "facts", multi: true }];
      break;
  }
  return { inputs, has_output: node.kind !== "goal", locals: localPorts };
}
export const proofPortKey = (id: string, port: string): string =>
  `${id}/${port}`;
export function splitProofPortKey(
  key: string,
): { id: string; port: string } | null {
  const slash = key.indexOf("/");
  return slash > 0 && slash < key.length - 1 && !key.includes("/", slash + 1)
    ? { id: key.slice(0, slash), port: key.slice(slash + 1) }
    : null;
}
export const proofKindLabels: Record<ProofNodeKind, string> = {
  given: "已知",
  goal: "目标",
  card: "定理卡",
  mp: "推出",
  inst: "代入",
  intro: "引入",
  cases: "分情况",
  exists_intro: "构造",
  exists_elim: "取出",
  induction: "归纳",
  claim: "断言",
  auto: "推导",
};
export const proofKindDescriptions: Record<ProofNodeKind, string> = {
  given: "使用题目给出的条件",
  goal: "连接证明以完成目标",
  card: "将前提连接到定理，得到结论",
  mp: "由蕴含和它的前提推出结论",
  inst: "为全称命题代入一个对象",
  intro: "引入变量或假设，在局部完成证明",
  cases: "分别证明析取的两种情况",
  exists_intro: "给出见证并证明它满足条件",
  exists_elim: "取出存在命题的见证及其性质",
  induction: "证明基础情形与归纳步骤",
  claim: "写出并证明一个中间命题",
  auto: "用所连接的事实进行指定推导",
};
export function freshProofId(graph: ProofGraph, prefix = "node"): string {
  const taken = new Set(graph.nodes.map((node) => node.id));
  let i = 1;
  while (taken.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}
export function freshProofBinder(
  graph: ProofGraph,
  spec: ProofBoardSpec,
  base = "x",
): string {
  const taken = new Set([
    ...spec.puzzle.variables.map((item) => item.name),
    ...spec.puzzle.hypotheses.map((item) => item.name),
    ...graph.nodes.flatMap((node) => node.binders ?? []),
  ]);
  let name = base;
  let i = 1;
  while (taken.has(name)) name = `${base}${i++}`;
  return name;
}
export function addProofNode(
  graph: ProofGraph,
  spec: ProofBoardSpec,
  kind: ProofNodeKind,
  options: { x?: number; y?: number; card?: string; hypothesis?: string } = {},
): ProofGraph {
  if (kind === "goal" || (kind !== "given" && !spec.node_kinds.includes(kind)))
    return graph;
  const node: ProofGraphNode = {
    id: freshProofId(graph),
    kind,
    x: options.x ?? 380,
    y: options.y ?? 140,
  };
  if (kind === "given") {
    const name = options.hypothesis ?? spec.puzzle.hypotheses[0]?.name;
    if (!spec.puzzle.hypotheses.some((item) => item.name === name))
      return graph;
    node.hypothesis = name!;
  }
  if (kind === "card") {
    const card = spec.cards.find(
      (item) => item.id === (options.card ?? spec.cards[0]?.id),
    );
    if (!card) return graph;
    node.card = card.id;
    node.args = card.params.map(() => "");
  }
  if (kind === "intro" || kind === "exists_elim" || kind === "induction")
    node.binders = [
      freshProofBinder(graph, spec, kind === "induction" ? "k" : "x"),
    ];
  if (kind === "claim") node.statement = "";
  if (kind === "inst" || kind === "exists_intro") node.term = "";
  if (kind === "auto") {
    const tactic = spec.tactics[0]?.id;
    if (!tactic) return graph;
    node.tactic = tactic;
  }
  return { ...graph, nodes: [...graph.nodes, node] };
}
export function updateProofNode(
  graph: ProofGraph,
  id: string,
  patch: Partial<Omit<ProofGraphNode, "id" | "kind">>,
): ProofGraph {
  if (!graph.nodes.some((node) => node.id === id)) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === id ? { ...node, ...patch } : node,
    ),
  };
}
export function moveProofNode(
  graph: ProofGraph,
  id: string,
  x: number,
  y: number,
): ProofGraph {
  return Number.isFinite(x) && Number.isFinite(y)
    ? updateProofNode(graph, id, { x, y })
    : graph;
}
export function removeProofNode(graph: ProofGraph, id: string): ProofGraph {
  const node = graph.nodes.find((item) => item.id === id);
  if (!node || node.kind === "given" || node.kind === "goal") return graph;
  return {
    nodes: graph.nodes.filter((item) => item.id !== id),
    edges: graph.edges.filter((edge) => edge.from !== id && edge.to !== id),
  };
}
export function connectProof(
  graph: ProofGraph,
  spec: ProofBoardSpec,
  edge: ProofGraphEdge,
): ProofGraph {
  const source = graph.nodes.find((node) => node.id === edge.from);
  const target = graph.nodes.find((node) => node.id === edge.to);
  if (!source || !target) return graph;
  const from = proofPorts(source, spec);
  const input = proofPorts(target, spec).inputs.find(
    (port) => port.id === edge.to_port,
  );
  const local = from.locals.some((port) => port.id === edge.from_port);
  if (!input || (!(from.has_output && edge.from_port === "out") && !local))
    return graph;
  // A scoped local is a binder supplied by its own node. Feeding that node's
  // scoped input directly is legal (e.g. intro x => x), and not a value cycle.
  // The UI still rejects self-loops as required by its interaction contract.
  if (edge.from === edge.to) return graph;
  const edges = graph.edges.filter(
    (item) =>
      input.multi || item.to !== edge.to || item.to_port !== edge.to_port,
  );
  if (
    edges.some(
      (item) =>
        item.from === edge.from &&
        item.from_port === edge.from_port &&
        item.to === edge.to &&
        item.to_port === edge.to_port,
    )
  )
    return graph;
  const pending = local ? [] : [edge.to];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === edge.from) return graph;
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(
      ...edges
        .filter((item) => item.from === id && item.from_port === "out")
        .map((item) => item.to),
    );
  }
  return { ...graph, edges: [...edges, edge] };
}
export function disconnectProof(graph: ProofGraph, index: number): ProofGraph {
  return index >= 0 && index < graph.edges.length
    ? { ...graph, edges: graph.edges.filter((_, i) => i !== index) }
    : graph;
}
export interface ProofHistory {
  past: ProofGraph[];
  present: ProofGraph;
  future: ProofGraph[];
}
export function createProofHistory(graph: ProofGraph): ProofHistory {
  return { past: [], present: graph, future: [] };
}
export function pushProofHistory(
  history: ProofHistory,
  graph: ProofGraph,
): ProofHistory {
  return graph === history.present ||
    JSON.stringify(graph) === JSON.stringify(history.present)
    ? history
    : {
        past: [...history.past, history.present].slice(-100),
        present: graph,
        future: [],
      };
}
export function undoProof(history: ProofHistory): ProofHistory {
  const previous = history.past[history.past.length - 1];
  return previous
    ? {
        past: history.past.slice(0, -1),
        present: previous,
        future: [history.present, ...history.future],
      }
    : history;
}
export function redoProof(history: ProofHistory): ProofHistory {
  const next = history.future[0];
  return next
    ? {
        past: [...history.past, history.present],
        present: next,
        future: history.future.slice(1),
      }
    : history;
}
