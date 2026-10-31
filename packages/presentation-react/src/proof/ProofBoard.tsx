import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import {
  addProofNode,
  connectProof,
  createProofHistory,
  disconnectProof,
  moveProofNode,
  proofKindDescriptions,
  proofKindLabels,
  proofPortKey,
  proofPorts,
  pushProofHistory,
  redoProof,
  removeProofNode,
  undoProof,
  updateProofNode,
  type ProofBoardSpec,
  type ProofCheckResult,
  type ProofFormula,
  type ProofGraph,
  type ProofGraphNode,
  type ProofHistory,
  type ProofNodeKind,
} from "@vectspace/presentation-core/proof";
import { renderMarkupFormula } from "@vectspace/presentation-core/static-markup";
import { MarkupLabel, markupAccessibleLabel } from "../markup/MarkupLabel";
import "./proof.css";

export interface ProofBoardProps {
  spec: ProofBoardSpec;
  /** Initial graph. Mount a new board (keyed by prompt_id) for each prompt. */
  graph: ProofGraph;
  canAbandon: boolean;
  check(graph: ProofGraph): Promise<ProofCheckResult>;
  onDraftChange?(graph: ProofGraph): void;
  submit(
    graph: ProofGraph,
  ): Promise<{ accepted: boolean; check: ProofCheckResult }>;
  onAbandon?(): void;
}
interface Point {
  x: number;
  y: number;
}
type Selection = { node: string } | { edge: number } | null;
type Gesture =
  | { kind: "pan"; pointer: number; start: Point; origin: Point }
  | {
      kind: "move";
      pointer: number;
      start: Point;
      node: ProofGraphNode;
      history: ProofHistory;
    }
  | { kind: "wire"; pointer: number; from: string; port: string };
const inputLabels: Record<string, string> = {
  in: "证明",
  imp: "蕴含",
  arg: "前提",
  all: "全称命题",
  body: "局部证明",
  or: "析取命题",
  left: "左侧情形",
  right: "右侧情形",
  proof: "性质",
  exists: "存在命题",
  base: "基础情形",
  step: "归纳步骤",
  facts: "事实（可连接多个）",
};
function Formula({
  formula,
}: {
  formula?: ProofFormula | undefined;
}): ReactElement | null {
  if (!formula) return null;
  return formula.latex === null ? (
    <code className="proof-formula-fallback">{formula.text}</code>
  ) : (
    <span
      aria-label={formula.text}
      className="proof-formula"
      dangerouslySetInnerHTML={{
        __html: renderMarkupFormula(formula.latex, false),
      }}
    />
  );
}
function unavailable(error: unknown): ProofCheckResult {
  return {
    status: "unavailable",
    nodes: {},
    ports: {},
    locals: {},
    fields: {},
    elapsed_ms: 0,
    diagnostics: [
      {
        code: "unavailable",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}
function curve(from: Point, to: Point): string {
  const bend = Math.max(70, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

export function ProofBoard({
  spec,
  graph: initialGraph,
  canAbandon,
  check,
  onDraftChange,
  submit,
  onAbandon,
}: ProofBoardProps): ReactElement {
  const [history, setHistory] = useState(() =>
    createProofHistory(initialGraph),
  );
  const graph = history.present;
  const graphRef = useRef(graph);
  const [feedback, setFeedback] = useState<{
    graph: ProofGraph;
    result: ProofCheckResult;
  } | null>(null);
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [pan, setPan] = useState<Point>({ x: 20, y: 20 });
  const [zoom, setZoom] = useState(1);
  const [wire, setWire] = useState<{
    from: string;
    port: string;
    point: Point;
  } | null>(null);
  const [anchors, setAnchors] = useState<Record<string, Point>>({});
  const [confirmation, setConfirmation] = useState<"reset" | "abandon" | null>(
    null,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const portRefs = useRef(new Map<string, HTMLButtonElement>());
  const gesture = useRef<Gesture | null>(null);
  const sequence = useRef(0);
  const callbacks = useRef({ check, onDraftChange, submit, onAbandon });
  useLayoutEffect(() => {
    rootRef.current?.focus();
  }, []);
  useLayoutEffect(() => {
    callbacks.current = { check, onDraftChange, submit, onAbandon };
  });
  const result = feedback?.result;
  const currentComplete =
    feedback?.graph === graph && result?.status === "complete" && !checking;

  function install(next: ProofGraph, mode: "push" | "move" = "push"): void {
    if (submitting || next === graphRef.current) return;
    sequence.current++;
    graphRef.current = next;
    setChecking(true);
    setNotice("");
    setHistory((old) =>
      mode === "move" ? { ...old, present: next } : pushProofHistory(old, next),
    );
  }
  function travel(direction: "undo" | "redo"): void {
    if (submitting) return;
    const next = direction === "undo" ? undoProof(history) : redoProof(history);
    if (next === history) return;
    sequence.current++;
    graphRef.current = next.present;
    setChecking(true);
    setHistory(next);
    setSelection(null);
  }
  useEffect(() => {
    const seq = ++sequence.current;
    const timer = window.setTimeout(() => {
      void callbacks.current
        .check(graph)
        .catch(unavailable)
        .then((next) => {
          if (sequence.current !== seq) return;
          setFeedback({ graph, result: next });
          setChecking(false);
        });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      sequence.current++;
    };
  }, [graph]);
  useEffect(() => {
    const timer = window.setTimeout(
      () => callbacks.current.onDraftChange?.(graph),
      800,
    );
    return () => window.clearTimeout(timer);
  }, [graph]);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / canvas.offsetWidth || 1;
    const next: Record<string, Point> = {};
    for (const [key, element] of portRefs.current) {
      const port = element.getBoundingClientRect();
      next[key] = {
        x: ((port.left + port.width / 2 - rect.left) / scale - pan.x) / zoom,
        y: ((port.top + port.height / 2 - rect.top) / scale - pan.y) / zoom,
      };
    }
    setAnchors(next);
  }, [graph, result, pan, zoom]);

  function point(clientX: number, clientY: number): Point {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    // The host scales the entire 1920x1080 viewport with one CSS transform.
    const scale = rect.width / canvas.offsetWidth || 1;
    return {
      x: (clientX - rect.left) / scale,
      y: (clientY - rect.top) / scale,
    };
  }
  function boardPoint(clientX: number, clientY: number): Point {
    const p = point(clientX, clientY);
    return { x: (p.x - pan.x) / zoom, y: (p.y - pan.y) / zoom };
  }
  function add(
    kind: ProofNodeKind,
    options: { card?: string; hypothesis?: string } = {},
    at?: Point,
  ): void {
    const base = at ?? { x: (100 - pan.x) / zoom, y: (90 - pan.y) / zoom };
    let position = base;
    if (!at) {
      // Card nodes grow with their argument fields, so test against the
      // rendered boxes (layout size is unaffected by the board transform).
      const boxes = graph.nodes.map((node) => {
        const element = rootRef.current?.querySelector<HTMLElement>(
          `[data-proof-node="${node.id}"]`,
        );
        return {
          x: node.x,
          y: node.y,
          w: element?.offsetWidth || 310,
          h: element?.offsetHeight || 230,
        };
      });
      const params =
        spec.cards.find((card) => card.id === options.card)?.params.length ?? 1;
      const size = { w: 310, h: 200 + params * 80 };
      const gap = 20;
      const free = (p: Point) =>
        boxes.every(
          (b) =>
            p.x + size.w + gap <= b.x ||
            b.x + b.w + gap <= p.x ||
            p.y + size.h + gap <= b.y ||
            b.y + b.h + gap <= p.y,
        );
      for (let attempt = 1; !free(position) && attempt <= 200; attempt++)
        position = {
          x: base.x + (attempt % 4) * 330,
          y: base.y + Math.floor(attempt / 4) * 120,
        };
    }
    const next = addProofNode(graph, spec, kind, { ...options, ...position });
    install(next);
    const node = next.nodes[next.nodes.length - 1];
    if (next !== graph && node) setSelection({ node: node.id });
  }
  function capture(event: ReactPointerEvent): void {
    try {
      canvasRef.current?.setPointerCapture(event.pointerId);
    } catch {
      /* jsdom and old webviews */
    }
  }
  function beginMove(event: ReactPointerEvent, node: ProofGraphNode): void {
    if (event.button !== 0 || submitting) return;
    event.preventDefault();
    event.stopPropagation();
    rootRef.current?.focus();
    setSelection({ node: node.id });
    gesture.current = {
      kind: "move",
      pointer: event.pointerId,
      start: point(event.clientX, event.clientY),
      node,
      history,
    };
    capture(event);
  }
  function startWire(
    event: ReactPointerEvent,
    node: ProofGraphNode,
    port: string,
  ): void {
    if (event.button !== 0 || submitting) return;
    event.preventDefault();
    event.stopPropagation();
    gesture.current = {
      kind: "wire",
      pointer: event.pointerId,
      from: node.id,
      port,
    };
    setWire({
      from: node.id,
      port,
      point: boardPoint(event.clientX, event.clientY),
    });
    // Keep hit testing on input ports; do not capture the output pointer.
  }
  function finishPointer(event: ReactPointerEvent, cancelled = false): void {
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    if (active.kind === "wire" && !cancelled) {
      const element = event.target instanceof Element ? event.target : null;
      const input =
        element?.closest<HTMLElement>("[data-proof-input]") ??
        document
          .elementFromPoint?.(event.clientX, event.clientY)
          ?.closest<HTMLElement>("[data-proof-input]");
      if (input?.dataset.node && input.dataset.port) {
        const next = connectProof(graphRef.current, spec, {
          from: active.from,
          from_port: active.port,
          to: input.dataset.node,
          to_port: input.dataset.port,
        });
        if (next === graphRef.current)
          setNotice("无法连接：请检查端口方向或循环依赖。");
        else install(next);
      }
    }
    if (active.kind === "move") {
      if (cancelled) {
        graphRef.current = active.history.present;
        setHistory(active.history);
      } else setHistory(pushProofHistory(active.history, graphRef.current));
    }
    gesture.current = null;
    setWire(null);
  }
  function deleteSelection(): void {
    if (selection && "node" in selection)
      install(removeProofNode(graph, selection.node));
    else if (selection && "edge" in selection)
      install(disconnectProof(graph, selection.edge));
    setSelection(null);
  }
  function focusNode(id: string): void {
    const node = graph.nodes.find((item) => item.id === id);
    if (!node) return;
    setSelection({ node: id });
    setPan({ x: 380 - node.x * zoom, y: 150 - node.y * zoom });
    rootRef.current
      ?.querySelector<HTMLElement>(
        `[data-proof-node="${id}"] .proof-node-header`,
      )
      ?.focus();
  }
  async function submitGraph(): Promise<void> {
    if (!currentComplete || submitting) return;
    const submitted = graph;
    const seq = ++sequence.current;
    setSubmitting(true);
    try {
      const response = await callbacks.current.submit(submitted);
      if (seq !== sequence.current) return;
      setFeedback({ graph: submitted, result: response.check });
      setNotice(
        response.accepted ? "证明已提交。" : "证明尚未通过，请查看检查结果。",
      );
    } catch (error) {
      if (seq === sequence.current) {
        setFeedback({ graph: submitted, result: unavailable(error) });
        setNotice("提交失败，请重试。");
      }
    } finally {
      setSubmitting(false);
    }
  }
  function field(
    node: ProofGraphNode,
    name: string,
    label: string,
    value: string,
    change: (value: string) => Partial<ProofGraphNode>,
  ): ReactElement {
    const feedback = result?.fields[proofPortKey(node.id, name)];
    const id = `proof-${node.id}-${name}`;
    return (
      <label className="proof-field" key={name} htmlFor={id}>
        <span>{label}</span>
        <input
          id={id}
          value={value}
          maxLength={200}
          disabled={submitting}
          aria-invalid={!!feedback?.error}
          aria-describedby={feedback?.error ? `${id}-error` : undefined}
          onChange={(event) =>
            install(updateProofNode(graph, node.id, change(event.target.value)))
          }
        />
        {feedback?.error && (
          <small id={`${id}-error`} role="alert">
            {feedback.error}
          </small>
        )}
      </label>
    );
  }
  function portRef(key: string, element: HTMLButtonElement | null): void {
    if (element) portRefs.current.set(key, element);
    else portRefs.current.delete(key);
  }
  const openCount = result
    ? Object.values(result.ports).filter((port) => port.open || port.mismatch)
        .length
    : 0;
  const pendingCount = Math.max(
    openCount,
    result?.diagnostics.filter((d) => d.severity === "error").length ?? 0,
    1,
  );
  const mismatchCount = result
    ? Object.values(result.ports).filter((port) => port.mismatch).length
    : 0;
  const status = checking
    ? "检查中…"
    : result?.status === "complete"
      ? "证明完成"
      : result?.status === "unavailable"
        ? "Lean 不可用"
        : mismatchCount
          ? `有 ${mismatchCount} 处不匹配`
          : `还有 ${pendingCount} 处待证`;
  const reasoningKinds = spec.node_kinds.filter(
    (kind) => kind !== "card" && kind !== "given" && kind !== "goal",
  );
  return (
    <div
      className="proof-board"
      data-block-story-advance
      role="dialog"
      aria-modal="true"
      aria-label={spec.puzzle.title}
      tabIndex={-1}
      ref={rootRef}
      onPointerUp={(event) => finishPointer(event)}
      onPointerCancel={(event) => finishPointer(event, true)}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (event.key === "Tab") {
          const scope =
            rootRef.current?.querySelector(".proof-confirm") ?? rootRef.current;
          const focusable = scope?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex='0']",
          );
          const first = focusable?.[0];
          const last = focusable?.[focusable.length - 1];
          if (
            event.shiftKey &&
            (target === first || target === rootRef.current)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && target === last) {
            event.preventDefault();
            first?.focus();
          }
        }
        if (target.closest("input, textarea, select, [contenteditable=true]"))
          return;
        if (
          (event.ctrlKey || event.metaKey) &&
          (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")
        ) {
          event.preventDefault();
          event.stopPropagation();
          travel(
            event.shiftKey || event.key.toLowerCase() === "y" ? "redo" : "undo",
          );
        } else if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          event.stopPropagation();
          deleteSelection();
        } else if (event.key === "Escape") {
          gesture.current = null;
          setWire(null);
          setConfirmation(null);
        }
      }}
    >
      <header className="proof-board-header">
        <div className="proof-heading">
          <h1>{spec.puzzle.title}</h1>
          {spec.puzzle.description && (
            <p>
              <MarkupLabel
                source={spec.puzzle.description}
                ariaLabel={markupAccessibleLabel(spec.puzzle.description)}
              />
            </p>
          )}
          <div className="proof-goal">
            <span>目标</span>
            <Formula formula={spec.puzzle.goal} />
          </div>
        </div>
        <div className="proof-toolbar">
          <span
            role="status"
            className={`proof-status proof-status-${result?.status ?? "incomplete"}`}
          >
            {status}
          </span>
          <button
            type="button"
            disabled={!currentComplete || submitting}
            onClick={() => void submitGraph()}
          >
            {submitting ? "提交中…" : "提交证明"}
          </button>
          <button
            type="button"
            disabled={submitting || !history.past.length}
            onClick={() => travel("undo")}
          >
            撤销
          </button>
          <button
            type="button"
            disabled={submitting || !history.future.length}
            onClick={() => travel("redo")}
          >
            重做
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => setConfirmation("reset")}
          >
            重置
          </button>
          {canAbandon && onAbandon && (
            <button
              type="button"
              disabled={submitting}
              onClick={() => setConfirmation("abandon")}
            >
              放弃
            </button>
          )}
        </div>
      </header>
      <div className="proof-workspace">
        <aside className="proof-palette" aria-label="证明工具">
          {spec.node_kinds.includes("card") && spec.cards.length > 0 && (
            <h2>定理卡</h2>
          )}
          {spec.node_kinds.includes("card") &&
            spec.cards.map((card) => (
              <button
                type="button"
                className="proof-palette-card"
                key={card.id}
                disabled={submitting}
                draggable
                onDragStart={(event) =>
                  event.dataTransfer.setData(
                    "application/x-vectspace-proof",
                    JSON.stringify({ kind: "card", card: card.id }),
                  )
                }
                onClick={() => add("card", { card: card.id })}
                aria-label={`添加${card.name}`}
              >
                <strong>{card.name}</strong>
                {card.premises.map((premise, i) => (
                  <span className="proof-premise" key={i}>
                    <span>前提 {i + 1}</span>
                    <Formula formula={premise} />
                  </span>
                ))}
                <span className="proof-conclusion">
                  <Formula formula={card.conclusion} />
                </span>
                {card.description && (
                  <MarkupLabel
                    source={card.description}
                    ariaLabel={markupAccessibleLabel(card.description)}
                  />
                )}
              </button>
            ))}
          {reasoningKinds.length > 0 && <h2>推理</h2>}
          {reasoningKinds.map((kind) => (
            <button
              type="button"
              className="proof-palette-card"
              key={kind}
              disabled={submitting}
              onClick={() => add(kind)}
            >
              <strong>{proofKindLabels[kind]}</strong>
              <span>{proofKindDescriptions[kind]}</span>
            </button>
          ))}
          {spec.puzzle.hypotheses.length > 0 && <h2>已知</h2>}
          {spec.puzzle.hypotheses.map((h) => (
            <button
              type="button"
              className="proof-palette-card"
              key={h.name}
              disabled={submitting}
              onClick={() => add("given", { hypothesis: h.name })}
            >
              <strong>{h.label ?? "已知"}</strong>
              <Formula formula={h.statement} />
            </button>
          ))}
        </aside>
        <div
          className="proof-canvas"
          ref={canvasRef}
          aria-label="证明画布"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            try {
              const data: unknown = JSON.parse(
                event.dataTransfer.getData("application/x-vectspace-proof"),
              );
              if (
                data &&
                typeof data === "object" &&
                "card" in data &&
                typeof data.card === "string"
              )
                add(
                  "card",
                  { card: data.card },
                  boardPoint(event.clientX, event.clientY),
                );
            } catch {
              /* Ignore unrelated external drags. */
            }
          }}
          onPointerDown={(event) => {
            if (
              event.button !== 0 ||
              (event.target as HTMLElement).closest(
                ".proof-node, .proof-edge, .proof-canvas-controls",
              )
            )
              return;
            rootRef.current?.focus();
            setSelection(null);
            gesture.current = {
              kind: "pan",
              pointer: event.pointerId,
              start: point(event.clientX, event.clientY),
              origin: pan,
            };
            capture(event);
          }}
          onPointerMove={(event) => {
            const active = gesture.current;
            if (!active || active.pointer !== event.pointerId) return;
            const p = point(event.clientX, event.clientY);
            if (active.kind === "pan")
              setPan({
                x: active.origin.x + p.x - active.start.x,
                y: active.origin.y + p.y - active.start.y,
              });
            else if (active.kind === "move")
              install(
                moveProofNode(
                  graphRef.current,
                  active.node.id,
                  active.node.x + (p.x - active.start.x) / zoom,
                  active.node.y + (p.y - active.start.y) / zoom,
                ),
                "move",
              );
            else
              setWire({
                from: active.from,
                port: active.port,
                point: boardPoint(event.clientX, event.clientY),
              });
          }}
          onWheel={(event) => {
            const p = point(event.clientX, event.clientY);
            const next = Math.max(
              0.5,
              Math.min(1.5, zoom * (event.deltaY > 0 ? 0.9 : 1.1)),
            );
            setPan({
              x: p.x - ((p.x - pan.x) * next) / zoom,
              y: p.y - ((p.y - pan.y) * next) / zoom,
            });
            setZoom(next);
          }}
        >
          <div
            className="proof-world"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            }}
          >
            <svg className="proof-edges" aria-label="证明连线">
              {graph.edges.map((edge, i) => {
                const from = anchors[proofPortKey(edge.from, edge.from_port)];
                const to = anchors[proofPortKey(edge.to, edge.to_port)];
                if (!from || !to) return null;
                const mismatch =
                  result?.ports[proofPortKey(edge.to, edge.to_port)]
                    ?.mismatch ||
                  result?.diagnostics.some(
                    (d) => d.edge === i && d.severity === "error",
                  );
                return (
                  <path
                    key={`${edge.from}/${edge.from_port}/${edge.to}/${edge.to_port}`}
                    d={curve(from, to)}
                    className={`proof-edge${mismatch ? " mismatch" : ""}${selection && "edge" in selection && selection.edge === i ? " selected" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`连线 ${edge.from}/${edge.from_port} 到 ${edge.to}/${edge.to_port}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelection({ edge: i });
                      rootRef.current?.focus();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelection({ edge: i });
                      }
                    }}
                  />
                );
              })}
              {wire && anchors[proofPortKey(wire.from, wire.port)] && (
                <path
                  className="proof-wire"
                  d={curve(
                    anchors[proofPortKey(wire.from, wire.port)]!,
                    wire.point,
                  )}
                />
              )}
            </svg>
            {graph.nodes.map((node) => {
              const ports = proofPorts(node, spec);
              const card = spec.cards.find((card) => card.id === node.card);
              const hypothesis = spec.puzzle.hypotheses.find(
                (h) => h.name === node.hypothesis,
              );
              const formula =
                result?.nodes[node.id]?.type ??
                (node.kind === "goal"
                  ? spec.puzzle.goal
                  : node.kind === "given"
                    ? hypothesis?.statement
                    : card?.conclusion);
              const selected =
                selection && "node" in selection && selection.node === node.id;
              return (
                <article
                  key={node.id}
                  data-proof-node={node.id}
                  className={`proof-node${selected ? " selected" : ""}`}
                  style={{ left: node.x, top: node.y }}
                  onClick={() => setSelection({ node: node.id })}
                >
                  <button
                    className="proof-node-header"
                    type="button"
                    onPointerDown={(event) => beginMove(event, node)}
                    onClick={() => setSelection({ node: node.id })}
                  >
                    <span>
                      {card?.name ??
                        (node.kind === "given"
                          ? (hypothesis?.label ?? proofKindLabels[node.kind])
                          : proofKindLabels[node.kind])}
                    </span>
                    <small>{node.id}</small>
                  </button>
                  <div className="proof-node-body">
                    <Formula formula={formula} />
                    {card?.params.map((param, index) =>
                      field(
                        node,
                        `args.${index}`,
                        `${param.name}（留空推断）`,
                        node.args?.[index] ?? "",
                        (value) => ({
                          args: card.params.map((_, i) =>
                            i === index ? value : (node.args?.[i] ?? ""),
                          ),
                        }),
                      ),
                    )}
                    {(
                      [
                        "intro",
                        "cases",
                        "exists_intro",
                        "exists_elim",
                        "induction",
                        "claim",
                        "auto",
                      ] as ProofNodeKind[]
                    ).includes(node.kind) &&
                      field(
                        node,
                        "statement",
                        node.kind === "claim" ? "命题" : "命题（可选）",
                        node.statement ?? "",
                        (statement) => ({ statement }),
                      )}
                    {(node.kind === "inst" || node.kind === "exists_intro") &&
                      field(
                        node,
                        "term",
                        node.kind === "inst" ? "代入对象" : "见证",
                        node.term ?? "",
                        (term) => ({ term }),
                      )}
                    {(node.kind === "intro" ||
                      node.kind === "exists_elim" ||
                      node.kind === "induction") && (
                      <>
                        {field(
                          node,
                          "binders",
                          "变量名（以空格分隔）",
                          node.binders?.join(" ") ?? "",
                          (value) => ({ binders: value.split(/[\s,，]+/u) }),
                        )}
                        {node.binders?.map(
                          (_, i) =>
                            result?.fields[
                              proofPortKey(node.id, `binders.${i}`)
                            ]?.error && (
                              <small role="alert" key={i}>
                                {
                                  result.fields[
                                    proofPortKey(node.id, `binders.${i}`)
                                  ]?.error
                                }
                              </small>
                            ),
                        )}
                      </>
                    )}
                    {node.kind === "auto" && (
                      <label className="proof-field">
                        <span>推导方法</span>
                        <select
                          value={node.tactic ?? ""}
                          disabled={submitting}
                          onChange={(event) => {
                            const tactic = spec.tactics.find(
                              (t) => t.id === event.target.value,
                            )?.id;
                            if (tactic)
                              install(
                                updateProofNode(graph, node.id, { tactic }),
                              );
                          }}
                        >
                          {spec.tactics.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                        {result?.fields[proofPortKey(node.id, "tactic")]
                          ?.error && (
                          <small role="alert">
                            {
                              result.fields[proofPortKey(node.id, "tactic")]
                                ?.error
                            }
                          </small>
                        )}
                      </label>
                    )}
                  </div>
                  <div className="proof-node-ports">
                    <div className="proof-inputs">
                      {ports.inputs.map((port) => {
                        const key = proofPortKey(node.id, port.id);
                        const feedback = result?.ports[key];
                        const connected = graph.edges.some(
                          (e) => e.to === node.id && e.to_port === port.id,
                        );
                        const state = feedback?.mismatch
                          ? "mismatch"
                          : feedback?.open || !connected
                            ? "open"
                            : "connected";
                        const expected =
                          feedback?.expected ??
                          (port.id.startsWith("p")
                            ? card?.premises[Number(port.id.slice(1))]
                            : undefined);
                        return (
                          <div
                            className={`proof-port-row ${state}`}
                            key={port.id}
                          >
                            <button
                              type="button"
                              className="proof-port"
                              ref={(element) => portRef(key, element)}
                              data-proof-input
                              data-node={node.id}
                              data-port={port.id}
                              aria-label={`${node.id}/${port.id} 输入`}
                              title={
                                feedback?.mismatch
                                  ? `需要 ${feedback.mismatch.expected.text}；得到 ${feedback.mismatch.actual.text}`
                                  : (expected?.text ?? inputLabels[port.id])
                              }
                              onClick={(event) => {
                                event.stopPropagation();
                                if (wire) {
                                  install(
                                    connectProof(graph, spec, {
                                      from: wire.from,
                                      from_port: wire.port,
                                      to: node.id,
                                      to_port: port.id,
                                    }),
                                  );
                                  gesture.current = null;
                                  setWire(null);
                                }
                              }}
                            />
                            <span>
                              {expected ? (
                                <Formula formula={expected} />
                              ) : (
                                (inputLabels[port.id] ?? port.id)
                              )}
                              <small>
                                {state === "mismatch"
                                  ? "不匹配"
                                  : state === "open"
                                    ? "待证"
                                    : "已连接"}
                              </small>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="proof-outputs">
                      {[
                        ...(ports.has_output ? [{ id: "out", scope: "" }] : []),
                        ...ports.locals,
                      ].map((port) => {
                        const key = proofPortKey(node.id, port.id);
                        const index = Number(port.id.slice(1));
                        const label =
                          port.id === "out"
                            ? "结论"
                            : (node.binders?.[index] ??
                              (index === 1 &&
                              (node.kind === "induction" ||
                                node.kind === "exists_elim")
                                ? node.kind === "induction"
                                  ? "归纳假设"
                                  : "性质"
                                : node.kind === "cases"
                                  ? index === 0
                                    ? "左侧假设"
                                    : "右侧假设"
                                  : `局部 ${index + 1}`));
                        return (
                          <div className="proof-port-row" key={port.id}>
                            <span>
                              {label}
                              {port.scope && (
                                <small>
                                  用于{inputLabels[port.scope] ?? port.scope}
                                </small>
                              )}
                              <Formula formula={result?.locals[key]?.type} />
                            </span>
                            <button
                              type="button"
                              className={`proof-port${port.id !== "out" ? " local" : ""}`}
                              aria-label={`${key} 输出`}
                              ref={(element) => portRef(key, element)}
                              onPointerDown={(event) =>
                                startWire(event, node, port.id)
                              }
                              onClick={(event) => {
                                event.stopPropagation();
                                setWire({
                                  from: node.id,
                                  port: port.id,
                                  point: anchors[key] ?? {
                                    x: node.x + 300,
                                    y: node.y + 60,
                                  },
                                });
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
          <div className="proof-canvas-controls">
            <span>{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              onClick={() => {
                setPan({ x: 20, y: 20 });
                setZoom(1);
              }}
            >
              回到起点
            </button>
            <span>拖动画布平移 · 滚轮缩放 · Delete 删除</span>
          </div>
        </div>
        <aside className="proof-diagnostics" aria-label="证明反馈">
          <h2>检查结果</h2>
          {checking && <p>正在检查当前证明…</p>}
          {notice && <p role="alert">{notice}</p>}
          {result?.status === "unavailable" && (
            <p>
              Lean 不可用：
              {result.diagnostics.find(
                (d) => d.code === "unavailable" || d.code === "timeout",
              )?.message ?? "请稍后重试"}
            </p>
          )}
          {!result?.diagnostics.length && (
            <p>
              {result?.status === "complete"
                ? "所有目标均已证明，可以提交。"
                : "将结论端口连接到需要它的前提。"}
            </p>
          )}
          {result?.diagnostics.map((d, i) => {
            const id =
              d.node ??
              d.port?.split("/")[0] ??
              d.field?.split("/")[0] ??
              (d.edge !== undefined ? graph.edges[d.edge]?.to : undefined);
            return (
              <div key={i} className={`proof-diagnostic ${d.severity}`}>
                <button
                  type="button"
                  disabled={!id}
                  onClick={() => {
                    if (id) focusNode(id);
                  }}
                >
                  {d.message}
                </button>
                {d.detail && (
                  <details>
                    <summary>详细信息</summary>
                    <pre>{d.detail}</pre>
                  </details>
                )}
              </div>
            );
          })}
        </aside>
      </div>
      {confirmation && (
        <div className="proof-confirm-backdrop">
          <section
            role="alertdialog"
            aria-modal="true"
            aria-label={confirmation === "reset" ? "重置证明" : "放弃证明"}
            className="proof-confirm"
          >
            <p>
              {confirmation === "reset"
                ? "重置证明板？当前操作仍可撤销。"
                : "放弃这道证明题并继续故事？"}
            </p>
            <button
              type="button"
              autoFocus
              onClick={() => setConfirmation(null)}
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => {
                if (confirmation === "reset") {
                  install(spec.initial_graph);
                  setSelection(null);
                } else callbacks.current.onAbandon?.();
                setConfirmation(null);
              }}
            >
              {confirmation === "reset" ? "确认重置" : "确认放弃"}
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
