import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProofBoardSpec,
  ProofCheckResult,
  ProofGraph,
} from "@vectspace/presentation-core/proof";
import { ProofBoard } from "./ProofBoard";
const f = { text: "p", latex: "p" };
const initial: ProofGraph = {
  nodes: [
    { id: "given", kind: "given", hypothesis: "h", x: 20, y: 30 },
    { id: "goal", kind: "goal", x: 800, y: 100 },
  ],
  edges: [],
};
const spec: ProofBoardSpec = {
  puzzle: {
    id: "test",
    title: "合取交换",
    description: "已知 $p$，证明 $p$。",
    variables: [],
    hypotheses: [{ name: "h", label: "条件", statement: f }],
    goal: f,
  },
  cards: [
    {
      id: "identity",
      name: "恒等",
      description: null,
      params: [{ name: "p", type: f }],
      premises: [f],
      conclusion: f,
    },
  ],
  node_kinds: ["card", "claim", "intro", "auto"],
  tactics: [{ id: "exact", name: "由已知" }],
  initial_graph: initial,
};
function result(
  status: ProofCheckResult["status"] = "incomplete",
): ProofCheckResult {
  return {
    status,
    nodes: {},
    ports: {},
    locals: {},
    fields: {},
    diagnostics: [],
    elapsed_ms: 12,
  };
}
function setup(
  check = vi
    .fn<(graph: ProofGraph) => Promise<ProofCheckResult>>()
    .mockResolvedValue(result()),
) {
  const submit = vi
    .fn()
    .mockResolvedValue({ accepted: true, check: result("complete") });
  const draft = vi.fn();
  const abandon = vi.fn();
  const view = render(
    <ProofBoard
      spec={spec}
      graph={initial}
      canAbandon
      check={check}
      onDraftChange={draft}
      submit={submit}
      onAbandon={abandon}
    />,
  );
  return { ...view, check, submit, draft, abandon };
}
async function tick(ms = 350): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  // jsdom lacks PointerEvent; preserve pointer coordinates/buttons for gestures.
  vi.stubGlobal("PointerEvent", MouseEvent);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("ProofBoard", () => {
  it("renders the puzzle, KaTeX, allowed nodes and initial graph", () => {
    const { container } = setup();
    expect(screen.getByRole("dialog", { name: "合取交换" })).toHaveAttribute(
      "data-block-story-advance",
    );
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(screen.getByRole("button", { name: "添加恒等" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^分情况/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "goal/in 输入" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交证明" })).toBeDisabled();
  });
  it("converts header drags through the host CSS scale and groups the drag into one undo", async () => {
    const { check, container } = setup();
    fireEvent.click(screen.getByRole("button", { name: "添加恒等" }));
    const canvas = screen.getByLabelText("证明画布");
    Object.defineProperty(canvas, "offsetWidth", { value: 1320 });
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 150,
      y: 100,
      left: 150,
      top: 100,
      right: 810,
      bottom: 500,
      width: 660,
      height: 400,
      toJSON: () => ({}),
    });
    const node = container.querySelector<HTMLElement>(
      '[data-proof-node="node1"]',
    )!;
    const x = parseFloat(node.style.left);
    const y = parseFloat(node.style.top);
    const header = node.querySelector("button")!;
    fireEvent.pointerDown(header, { button: 0, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(canvas, { clientX: 320, clientY: 215 });
    fireEvent.pointerMove(canvas, { clientX: 340, clientY: 225 });
    fireEvent.pointerUp(canvas, { clientX: 340, clientY: 225 });
    expect(node.style.left).toBe(`${x + 80}px`);
    expect(node.style.top).toBe(`${y + 50}px`);
    await tick();
    expect(check.mock.calls[0]?.[0].nodes[2]).toMatchObject({
      x: x + 80,
      y: y + 50,
    });
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(node.style.left).toBe(`${x}px`);
    expect(node.style.top).toBe(`${y}px`);
  });
  it("adds a card with editable params, debounces check and draft, and supports undo/redo", async () => {
    const { check, draft, container } = setup();
    fireEvent.click(screen.getByRole("button", { name: "添加恒等" }));
    const node = container.querySelector('[data-proof-node="node1"]')!;
    const input = within(node as HTMLElement).getByLabelText("p（留空推断）");
    fireEvent.change(input, { target: { value: "p" } });
    await tick(349);
    expect(check).not.toHaveBeenCalled();
    await tick(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]?.[0].nodes[2]).toMatchObject({
      card: "identity",
      args: ["p"],
    });
    await tick(450);
    expect(draft).toHaveBeenCalledWith(check.mock.calls[0]?.[0]);
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(
      within(node as HTMLElement).getByLabelText("p（留空推断）"),
    ).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    expect(
      within(node as HTMLElement).getByLabelText("p（留空推断）"),
    ).toHaveValue("p");
  });
  it("connects output to input using pointer gestures, deletes edges, and protects given/goal", async () => {
    const { check } = setup();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "given/out 输出" }),
      { button: 0, clientX: 100, clientY: 100 },
    );
    fireEvent.pointerUp(screen.getByRole("button", { name: "goal/in 输入" }), {
      button: 0,
      clientX: 400,
      clientY: 100,
    });
    await tick();
    expect(check.mock.calls[0]?.[0].edges).toEqual([
      { from: "given", from_port: "out", to: "goal", to_port: "in" },
    ]);
    fireEvent.click(
      screen.getByRole("button", { name: "连线 given/out 到 goal/in" }),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Delete" });
    await tick();
    expect(check.mock.calls[1]?.[0].edges).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "目标goal" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Backspace" });
    expect(
      screen.getByRole("button", { name: "goal/in 输入" }),
    ).toBeInTheDocument();
  });
  it("deletes selected cards but ignores Delete inside an input", () => {
    const { container } = setup();
    fireEvent.click(screen.getByRole("button", { name: "添加恒等" }));
    fireEvent.keyDown(screen.getByLabelText("p（留空推断）"), {
      key: "Delete",
    });
    expect(container.querySelector('[data-proof-node="node1"]')).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Delete" });
    expect(container.querySelector('[data-proof-node="node1"]')).toBeNull();
  });
  it("enables submit only for a complete result of the current graph", async () => {
    const { check, submit } = setup(
      vi
        .fn<(graph: ProofGraph) => Promise<ProofCheckResult>>()
        .mockResolvedValue(result("complete")),
    );
    await tick();
    const button = screen.getByRole("button", { name: "提交证明" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await tick(0);
    expect(submit).toHaveBeenCalledWith(initial);
    fireEvent.click(screen.getByRole("button", { name: "添加恒等" }));
    expect(button).toBeDisabled();
    check.mockResolvedValue(result("incomplete"));
    await tick();
    expect(button).toBeDisabled();
  });
  it("drops stale check responses and preserves the latest feedback", async () => {
    let resolveOld!: (value: ProofCheckResult) => void;
    let resolveNew!: (value: ProofCheckResult) => void;
    const check = vi
      .fn<(graph: ProofGraph) => Promise<ProofCheckResult>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNew = resolve;
          }),
      );
    setup(check);
    await tick();
    fireEvent.click(screen.getByRole("button", { name: "添加恒等" }));
    await tick();
    await act(async () => resolveNew(result("incomplete")));
    await act(async () => resolveOld(result("complete")));
    expect(screen.getByRole("button", { name: "提交证明" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("还有 1 处待证");
  });
  it("shows field errors, mismatch details and unavailable messages", async () => {
    const feedback = result("unavailable");
    feedback.diagnostics = [
      {
        severity: "error",
        code: "unavailable",
        message: "未找到 Lean",
        detail: "server missing",
        node: "goal",
      },
    ];
    feedback.ports["goal/in"] = {
      mismatch: { expected: f, actual: { text: "q", latex: "q" } },
    };
    const { container } = setup(
      vi
        .fn<(graph: ProofGraph) => Promise<ProofCheckResult>>()
        .mockResolvedValue(feedback),
    );
    await tick();
    expect(screen.getByRole("status")).toHaveTextContent("Lean 不可用");
    expect(
      screen.getByRole("button", { name: "goal/in 输入" }),
    ).toHaveAttribute("title", "需要 p；得到 q");
    fireEvent.click(screen.getByRole("button", { name: "未找到 Lean" }));
    expect(container.querySelector('[data-proof-node="goal"]')).toHaveClass(
      "selected",
    );
    expect(screen.getByText("详细信息")).toBeInTheDocument();
  });
  it("counts mismatches separately from open ports", async () => {
    const feedback = result();
    feedback.ports["goal/in"] = {
      mismatch: { expected: f, actual: { text: "q", latex: "q" } },
    };
    setup(
      vi
        .fn<(graph: ProofGraph) => Promise<ProofCheckResult>>()
        .mockResolvedValue(feedback),
    );
    await tick();
    expect(screen.getByRole("status")).toHaveTextContent("有 1 处不匹配");
  });
  it("hides palette sections with nothing to place", () => {
    render(
      <ProofBoard
        spec={{
          ...spec,
          puzzle: { ...spec.puzzle, hypotheses: [] },
          node_kinds: ["card"],
        }}
        graph={initial}
        canAbandon={false}
        check={vi.fn().mockResolvedValue(result())}
        submit={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "定理卡" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "推理" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "已知" })).toBeNull();
  });
  it("confirms abandon and reset, and allows undo after reset", () => {
    const { abandon, container } = setup();
    fireEvent.click(screen.getByRole("button", { name: "添加恒等" }));
    fireEvent.click(screen.getByRole("button", { name: "重置" }));
    expect(container.querySelector('[data-proof-node="node1"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));
    expect(container.querySelector('[data-proof-node="node1"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(container.querySelector('[data-proof-node="node1"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "放弃" }));
    expect(abandon).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认放弃" }));
    expect(abandon).toHaveBeenCalledTimes(1);
  });
});
