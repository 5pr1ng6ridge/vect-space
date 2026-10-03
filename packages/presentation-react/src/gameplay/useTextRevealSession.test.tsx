import { act, render } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseMarkup } from "@vectspace/text";

import { useTextRevealSession } from "./useTextRevealSession";

const units = parseMarkup("ABC");
const durations = new Map<number, number>();

function Probe({ instanceKey }: { instanceKey: string }) {
  const stableUnits = useMemo(() => units, []);
  const session = useTextRevealSession({
    animation: "typewriter",
    defaultCps: 20,
    initialCps: 20,
    instanceKey,
    mathRevealDurations: durations,
    ready: true,
    restorePresentation: false,
    units: stableUnits,
    waitForInlineMath: true,
  });
  return <output data-status={session.state.status} />;
}

describe("useTextRevealSession RAF lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "requestAnimationFrame",
      (() => {
        let nextId = 1;
        const callbacks = new Map<number, FrameRequestCallback>();
        const request = (callback: FrameRequestCallback): number => {
          const id = nextId++;
          callbacks.set(id, callback);
          return id;
        };
        const cancel = (id: number): void => {
          callbacks.delete(id);
        };
        return Object.assign(request, { callbacks, cancel });
      })(),
    );
    const request =
      globalThis.requestAnimationFrame as typeof requestAnimationFrame & {
        callbacks?: Map<number, FrameRequestCallback>;
        cancel?: (id: number) => void;
      };
    vi.stubGlobal("cancelAnimationFrame", (id: number) => request.cancel?.(id));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts a replacement loop after a session instance resets", () => {
    const request =
      globalThis.requestAnimationFrame as typeof requestAnimationFrame & {
        callbacks: Map<number, FrameRequestCallback>;
      };
    const { rerender, unmount } = render(<Probe instanceKey="first" />);
    const firstId = [...request.callbacks.keys()][0];
    expect(firstId).toBeDefined();

    rerender(<Probe instanceKey="second" />);

    expect(request.callbacks.size).toBe(1);
    expect(request.callbacks.has(firstId as number)).toBe(false);
    unmount();
  });

  function TextProbe({ text }: { text: string }) {
    const parsed = useMemo(() => parseMarkup(text), [text]);
    const session = useTextRevealSession({
      animation: "typewriter",
      defaultCps: 20,
      initialCps: 20,
      instanceKey: "stable",
      mathRevealDurations: durations,
      ready: true,
      restorePresentation: false,
      units: parsed,
      waitForInlineMath: true,
    });
    return (
      <output
        data-count={session.state.revealedCount}
        data-status={session.state.status}
        data-total={session.plan.events.length}
      />
    );
  }

  function runFrame(now: number): void {
    const request =
      globalThis.requestAnimationFrame as typeof requestAnimationFrame & {
        callbacks: Map<number, FrameRequestCallback>;
      };
    const pending = [...request.callbacks.entries()];
    request.callbacks.clear();
    act(() => {
      for (const [, callback] of pending) callback(now);
    });
  }

  it("keeps reveal progress when interpolated text changes under one instance", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const { container, rerender, unmount } = render(<TextProbe text="ABCD" />);
    const output = (): HTMLOutputElement =>
      container.querySelector("output") as HTMLOutputElement;
    runFrame(50);
    runFrame(100);
    expect(output().dataset.count).toBe("2");

    rerender(<TextProbe text="ABCDEFGH" />);
    // Same instance, longer text: the plan is rebuilt but nothing replays.
    expect(output().dataset.total).toBe("8");
    expect(output().dataset.count).toBe("2");
    expect(output().dataset.status).toBe("revealing");
    unmount();
  });

  it("does not replay a completed line whose text changes", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const { container, rerender, unmount } = render(<TextProbe text="AB" />);
    const output = (): HTMLOutputElement =>
      container.querySelector("output") as HTMLOutputElement;
    for (let now = 50; now <= 250; now += 50) runFrame(now);
    expect(output().dataset.status).toBe("completed");

    rerender(<TextProbe text="ABCDEF" />);
    expect(output().dataset.status).toBe("completed");
    expect(output().dataset.count).toBe("6");
    unmount();
  });
});
