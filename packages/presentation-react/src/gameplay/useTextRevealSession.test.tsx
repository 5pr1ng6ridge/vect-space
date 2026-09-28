import { render } from "@testing-library/react";
import { useMemo } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
