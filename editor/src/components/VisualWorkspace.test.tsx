// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState, type ReactElement } from "react";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryKit,
  createMemoryTextureLoader,
  type MemoryKit,
} from "@vectspace/presentation-core/scene-test-kit";

import { visualProject } from "../test/visualFixtures";
import type { ParticleDefinition, ParticleFile } from "../types";
import { VisualWorkspace } from "./VisualWorkspace";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));

afterEach(cleanup);

const DOT_URL = "C:/game/dot.png";

interface Mounted {
  kit: MemoryKit;
  onChange: ReturnType<typeof vi.fn<(definition: ParticleDefinition) => void>>;
}

/** Owns the file like the app does: a committed change replaces the prop. */
function Harness({
  initial,
  kit,
  onChange,
}: {
  initial: ParticleFile;
  kit: MemoryKit;
  onChange: Mounted["onChange"];
}): ReactElement {
  const [file, setFile] = useState(initial);
  const textures = createMemoryTextureLoader({
    [DOT_URL]: { width: 64, height: 64 },
  });
  return (
    <VisualWorkspace
      animationMap={{}}
      dirty={false}
      file={file}
      kind="particle"
      onBack={() => undefined}
      onChange={(definition) => {
        onChange(definition as ParticleDefinition);
        setFile({ ...file, definition: definition as ParticleDefinition });
      }}
      onRedo={() => undefined}
      onSave={() => undefined}
      onUndo={() => undefined}
      onValidate={() => undefined}
      previewEnvironment={{ kit: kit.kit, textureLoader: textures.load }}
      project={visualProject()}
      redoAvailable={false}
      undoAvailable={false}
    />
  );
}

function mount(patch: Partial<ParticleDefinition> = {}): Mounted {
  const kit = createMemoryKit();
  const onChange = vi.fn<(definition: ParticleDefinition) => void>();
  const file = visualProject().particles[0];
  const initial: ParticleFile = {
    ...file,
    definition: { ...file.definition, ...patch },
  };
  render(<Harness initial={initial} kit={kit} onChange={onChange} />);
  return { kit, onChange };
}

/** A short-lived, burst-only particle: finishes within a few frames. */
const BURST_ONLY: Partial<ParticleDefinition> = {
  rate: 0,
  burst_count: 5,
  max_particles: 20,
  lifetime_ms: { min: 40, max: 60 },
};

function stubLayerRect(): HTMLElement {
  const layer = screen.getByRole("group", { name: "粒子生成点" });
  layer.getBoundingClientRect = () => ({
    width: 1920,
    height: 1080,
    left: 0,
    top: 0,
    right: 1920,
    bottom: 1080,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return layer;
}

/** The ready workspace stage with a measured overlay layer. */
async function readyStage(kit: MemoryKit): Promise<void> {
  await screen.findByLabelText("粒子效果预览");
  stubLayerRect();
  await waitFor(() => expect(kit.particleBatches.length).toBeGreaterThan(0));
}

function region(): HTMLElement {
  return screen.getByTestId("particle-emission-region");
}

function liveBatches(kit: MemoryKit) {
  return kit.particleBatches.filter((batch) => !batch.node.destroyed);
}

function handle(name: string): HTMLElement {
  return screen.getByLabelText(`调整生成区域${name}`);
}

function readout(): { ms: number; finished: boolean } {
  const text =
    document.querySelector(".cue-preview-burst-transport code")?.textContent ??
    "";
  return {
    ms: Number(/(\d+) \//.exec(text)?.[1] ?? Number.NaN),
    finished: text.includes("已结束"),
  };
}

describe("VisualWorkspace particle generation point and area", () => {
  it("shows the rectangle area, its handles and the preview-only centre", async () => {
    const { kit } = mount();
    await readyStage(kit);

    expect(region()).toHaveTextContent("400 × 100");
    expect(region().style.left).toBe(`${((960 - 200) / 1920) * 100}%`);
    for (const name of ["上边", "下边", "左边", "右边", "左上角", "右上角", "左下角", "右下角"]) {
      expect(handle(name)).toBeInTheDocument();
    }
    // The definition has no stage position: moving the centre is labelled as
    // a preview-only gesture.
    expect(
      screen.getByLabelText("拖动预览中心（仅预览，不保存）"),
    ).toHaveTextContent("预览中心 · 不保存");
    expect(screen.getByText(/不会保存/)).toBeInTheDocument();
  });

  it("offers no area handles for a point emitter", async () => {
    const { kit } = mount({ area: { type: "point" } });
    await readyStage(kit);
    expect(screen.queryByTestId("particle-emission-region")).toBeNull();
    expect(screen.queryByLabelText(/调整生成区域/)).toBeNull();
    expect(
      screen.getByLabelText("拖动预览中心（仅预览，不保存）"),
    ).toBeInTheDocument();
  });

  it("resizes the real area width with one change after release", async () => {
    const { kit, onChange } = mount();
    await readyStage(kit);
    const east = handle("右边");

    fireEvent.pointerDown(east, { button: 0, clientX: 1160, clientY: 540 });
    fireEvent.pointerMove(east, { clientX: 1210, clientY: 560 });
    // The draft follows the pointer; nothing is authored yet.
    expect(region()).toHaveTextContent("500 × 100");
    fireEvent.pointerMove(east, { clientX: 1260, clientY: 540 });
    expect(region()).toHaveTextContent("600 × 100");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(east, { clientX: 1260, clientY: 540 });
    expect(onChange).toHaveBeenCalledTimes(1);
    const saved = onChange.mock.calls[0]?.[0];
    expect(saved?.area).toEqual({ type: "rectangle", width: 600, height: 100 });
    // Everything else in the definition is untouched.
    expect({ ...saved, area: undefined }).toEqual({
      ...visualProject().particles[0]?.definition,
      area: undefined,
    });
    expect(region()).toHaveTextContent("600 × 100");
  });

  it("resizes the height from the bottom handle and both sides from a corner", async () => {
    const { kit, onChange } = mount();
    await readyStage(kit);

    const south = handle("下边");
    fireEvent.pointerDown(south, { button: 0, clientX: 960, clientY: 590 });
    fireEvent.pointerMove(south, { clientX: 1000, clientY: 640 });
    fireEvent.pointerUp(south, { clientX: 1000, clientY: 640 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0].area).toEqual({
      type: "rectangle",
      width: 400,
      height: 200,
    });

    const corner = handle("右下角");
    // The harness applied the first change: the corner sits at (1160, 640).
    fireEvent.pointerDown(corner, { button: 0, clientX: 1160, clientY: 640 });
    fireEvent.pointerMove(corner, { clientX: 1110, clientY: 600 });
    fireEvent.pointerUp(corner, { clientX: 1110, clientY: 600 });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1]?.[0].area).toEqual({
      type: "rectangle",
      width: 300,
      height: 120,
    });
  });

  it("keeps a legitimate zero width or height", async () => {
    const { kit, onChange } = mount();
    await readyStage(kit);
    const east = handle("右边");

    // Dragging the edge through the centre and beyond stops at zero.
    fireEvent.pointerDown(east, { button: 0, clientX: 1160, clientY: 540 });
    fireEvent.pointerMove(east, { clientX: 500, clientY: 540 });
    expect(region()).toHaveTextContent("0 × 100");
    fireEvent.pointerUp(east, { clientX: 500, clientY: 540 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0].area).toEqual({
      type: "rectangle",
      width: 0,
      height: 100,
    });

    // The zero-width area is still resizable from the stacked handles.
    const south = handle("右下角");
    fireEvent.pointerDown(south, { button: 0, clientX: 960, clientY: 590 });
    fireEvent.pointerMove(south, { clientX: 960, clientY: 0 });
    fireEvent.pointerUp(south, { clientX: 960, clientY: 0 });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1]?.[0].area).toEqual({
      type: "rectangle",
      width: 0,
      height: 0,
    });
  });

  it("treats a click, a sub-threshold wobble and a return to the start as no edit", async () => {
    const { kit, onChange } = mount();
    await readyStage(kit);
    const east = handle("右边");

    fireEvent.pointerDown(east, { button: 0, clientX: 1160, clientY: 540 });
    fireEvent.pointerUp(east, { clientX: 1160, clientY: 540 });

    fireEvent.pointerDown(east, { button: 0, clientX: 1160, clientY: 540 });
    fireEvent.pointerMove(east, { clientX: 1160.2, clientY: 540 });
    fireEvent.pointerUp(east, { clientX: 1160.2, clientY: 540 });

    // Dragging away and back to the exact start is no change either: no
    // history entry for an identical definition.
    fireEvent.pointerDown(east, { button: 0, clientX: 1160, clientY: 540 });
    fireEvent.pointerMove(east, { clientX: 1300, clientY: 540 });
    expect(region()).toHaveTextContent("680 × 100");
    fireEvent.pointerMove(east, { clientX: 1160, clientY: 540 });
    fireEvent.pointerUp(east, { clientX: 1160, clientY: 540 });

    expect(onChange).not.toHaveBeenCalled();
    expect(region()).toHaveTextContent("400 × 100");
  });

  it("cancels on Escape, a pointer cancel and a blur without saving", async () => {
    const { kit, onChange } = mount();
    await readyStage(kit);
    const east = handle("右边");
    const cancels: (() => void)[] = [
      () => fireEvent.keyDown(window, { key: "Escape" }),
      () => fireEvent.pointerCancel(east, { clientX: 1300, clientY: 540 }),
      () => fireEvent(window, new Event("blur")),
    ];
    for (const cancel of cancels) {
      fireEvent.pointerDown(east, { button: 0, clientX: 1160, clientY: 540 });
      fireEvent.pointerMove(east, { clientX: 1300, clientY: 540 });
      expect(region()).toHaveTextContent("680 × 100");
      cancel();
      // The draft is discarded and a late release can no longer commit.
      expect(region()).toHaveTextContent("400 × 100");
      fireEvent.pointerUp(east, { clientX: 1300, clientY: 540 });
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves the preview centre without saving anything", async () => {
    const { kit, onChange } = mount();
    await readyStage(kit);
    const centerBefore = liveBatches(kit).at(-1)?.node.position;
    expect(centerBefore).toMatchObject({ x: 960, y: 540 });

    const marker = screen.getByLabelText("拖动预览中心（仅预览，不保存）");
    fireEvent.pointerDown(marker, { button: 0, clientX: 960, clientY: 540 });
    fireEvent.pointerMove(marker, { clientX: 1060, clientY: 590 });
    fireEvent.pointerUp(marker, { clientX: 1060, clientY: 590 });

    // The preview emitter is rebuilt at the new centre; the definition and
    // therefore the history never see it.
    await waitFor(() =>
      expect(liveBatches(kit).at(-1)?.node.position).toMatchObject({
        x: 1060,
        y: 590,
      }),
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(region().style.left).toBe(`${((1060 - 200) / 1920) * 100}%`);

    fireEvent.click(screen.getByRole("button", { name: "回到画面中心" }));
    await waitFor(() =>
      expect(liveBatches(kit).at(-1)?.node.position).toMatchObject({
        x: 960,
        y: 540,
      }),
    );
  });

  it("cancels a centre drag without moving the preview", async () => {
    const { kit, onChange } = mount();
    await readyStage(kit);
    const marker = screen.getByLabelText("拖动预览中心（仅预览，不保存）");
    fireEvent.pointerDown(marker, { button: 0, clientX: 960, clientY: 540 });
    fireEvent.pointerMove(marker, { clientX: 1060, clientY: 590 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(marker, { clientX: 1060, clientY: 590 });
    // A click is no drag either.
    fireEvent.pointerDown(marker, { button: 0, clientX: 960, clientY: 540 });
    fireEvent.pointerUp(marker, { clientX: 960, clientY: 540 });

    expect(screen.queryByRole("button", { name: "回到画面中心" })).toBeNull();
    expect(liveBatches(kit).at(-1)?.node.position).toMatchObject({
      x: 960,
      y: 540,
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("VisualWorkspace burst mode", () => {
  it("defaults a rate-0 definition to burst and keeps a continuous one continuous", async () => {
    const burst = mount(BURST_ONLY);
    await screen.findByLabelText("粒子效果预览");
    expect(screen.getByRole("button", { name: "单次爆发" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /重播爆发/ })).toBeInTheDocument();
    await waitFor(() => expect(readout().finished).toBe(true), {
      timeout: 4000,
    });
    // Only the transient batch existed, and it is gone: no persistent emitter
    // was faked and nothing was authored.
    expect(burst.kit.particleBatches).toHaveLength(1);
    expect(liveBatches(burst.kit)).toHaveLength(0);
    expect(burst.onChange).not.toHaveBeenCalled();
    cleanup();

    const continuous = mount();
    await screen.findByLabelText("粒子效果预览");
    expect(screen.getByRole("button", { name: "持续发射" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByRole("button", { name: /重播爆发/ })).toBeNull();
    await waitFor(() =>
      expect(liveBatches(continuous.kit)).toHaveLength(1),
    );
  });

  it("switches between continuous and burst without touching the definition", async () => {
    const { kit, onChange } = mount();
    await screen.findByLabelText("粒子效果预览");
    await waitFor(() => expect(liveBatches(kit)).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "单次爆发" }));
    expect(screen.getByRole("button", { name: "单次爆发" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await screen.findByRole("button", { name: /重播爆发/ });
    expect(screen.getByText(/按空格或“重播爆发”从头重播/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "持续发射" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /重播爆发/ })).toBeNull(),
    );
    // Continuous mode says plainly that Space does not apply there.
    expect(screen.getByText(/空格仅在“单次爆发”模式下重播/)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("replays with Space after completion, as often as pressed, without history", async () => {
    const { kit, onChange } = mount(BURST_ONLY);
    await screen.findByLabelText("粒子效果预览");
    await waitFor(() => expect(readout().finished).toBe(true), {
      timeout: 4000,
    });
    expect(kit.particleBatches).toHaveLength(1);

    for (let round = 2; round <= 3; round += 1) {
      const press = createEvent.keyDown(document.body, {
        key: " ",
        code: "Space",
      });
      fireEvent(document.body, press);
      // The page must not scroll and no focused button may also click.
      expect(press.defaultPrevented).toBe(true);
      await waitFor(() => expect(kit.particleBatches).toHaveLength(round));
      await waitFor(() => expect(readout().finished).toBe(true), {
        timeout: 4000,
      });
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not take Space from fields, selects or buttons outside the preview", async () => {
    const { kit } = mount(BURST_ONLY);
    await screen.findByLabelText("粒子效果预览");
    await waitFor(() => expect(readout().finished).toBe(true), {
      timeout: 4000,
    });

    const field = screen.getByLabelText("每秒数量");
    const select = screen.getByLabelText("混合模式");
    const outside = screen.getByRole("button", { name: /返回/ });
    for (const target of [field, select, outside]) {
      const press = createEvent.keyDown(target, { key: " ", code: "Space" });
      fireEvent(target, press);
      expect(press.defaultPrevented).toBe(false);
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(kit.particleBatches).toHaveLength(1);
  });

  it("gives Space no meaning in continuous mode", async () => {
    const { kit } = mount();
    await screen.findByLabelText("粒子效果预览");
    await waitFor(() => expect(liveBatches(kit)).toHaveLength(1));
    const press = createEvent.keyDown(document.body, { key: " ", code: "Space" });
    fireEvent(document.body, press);
    expect(press.defaultPrevented).toBe(false);
    expect(kit.particleBatches).toHaveLength(1);
  });
});
