import { act, render } from "@testing-library/react";
import { forwardRef, StrictMode, useImperativeHandle, type Ref } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLongTextScroll, type LongTextScrollHandle } from "./LongTextScroll";

interface RafRequest extends Function {
  callbacks: Map<number, FrameRequestCallback>;
  cancel(id: number): void;
}

function Probe(): null {
  useLongTextScroll({
    maxScroll: 500,
    onOffsetChange: () => undefined,
    target: 300,
  });
  return null;
}

interface ResetProbeProps {
  readonly initialPosition?: number;
  readonly resetKey?: string;
  readonly target: number;
  onOffsetChange(offset: number): void;
}

const ResetProbe = forwardRef(function ResetProbe(
  { initialPosition, resetKey, target, onOffsetChange }: ResetProbeProps,
  ref: Ref<LongTextScrollHandle>,
): null {
  const handle = useLongTextScroll({
    initialPosition,
    maxScroll: 1_000,
    onOffsetChange: (offset) => onOffsetChange(offset),
    resetKey,
    target,
  });
  useImperativeHandle(ref, () => handle, [handle]);
  return null;
});

describe("useLongTextScroll lifecycle", () => {
  let raf: RafRequest;

  beforeEach(() => {
    let nextId = 1;
    const callbacks = new Map<number, FrameRequestCallback>();
    const request = ((callback: FrameRequestCallback): number => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    }) as RafRequest;
    request.callbacks = callbacks;
    request.cancel = (id: number): void => {
      callbacks.delete(id);
    };
    raf = request;
    vi.stubGlobal("requestAnimationFrame", request);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => raf.cancel(id));
    vi.stubGlobal("performance", { now: () => 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restarts the driver after StrictMode effect replay", () => {
    const { unmount } = render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    expect(raf.callbacks.size).toBe(1);
    unmount();
    expect(raf.callbacks.size).toBe(0);
  });

  it("preserves the current position when only the target changes", () => {
    const handle = { current: null as LongTextScrollHandle | null };
    const onOffsetChange = vi.fn();
    const view = render(
      <ResetProbe
        onOffsetChange={onOffsetChange}
        ref={handle}
        resetKey="document-1"
        target={800}
      />,
    );
    const firstFrame = raf.callbacks.values().next().value as
      FrameRequestCallback | undefined;
    expect(firstFrame).toBeDefined();
    act(() => firstFrame?.(0));
    const secondFrame = raf.callbacks.values().next().value as
      FrameRequestCallback | undefined;
    expect(secondFrame).toBeDefined();
    act(() => secondFrame?.(50));
    const before = handle.current?.getState();
    expect(before?.position).toBeGreaterThan(0);

    view.rerender(
      <ResetProbe
        onOffsetChange={onOffsetChange}
        ref={handle}
        resetKey="document-1"
        target={200}
      />,
    );
    const after = handle.current?.getState();
    expect(after?.position).toBeCloseTo(before?.position ?? 0);
    expect(after?.velocity).toBeCloseTo(before?.velocity ?? 0);
    expect(after?.target).toBe(200);
  });

  it("publishes a reset position when the reset key changes", () => {
    const handle = { current: null as LongTextScrollHandle | null };
    const onOffsetChange = vi.fn();
    const view = render(
      <ResetProbe
        initialPosition={120}
        onOffsetChange={onOffsetChange}
        ref={handle}
        resetKey="document-1"
        target={800}
      />,
    );
    expect(handle.current?.getState().position).toBe(120);
    onOffsetChange.mockClear();

    view.rerender(
      <ResetProbe
        initialPosition={0}
        onOffsetChange={onOffsetChange}
        ref={handle}
        resetKey="document-2"
        target={300}
      />,
    );
    expect(handle.current?.getState().position).toBe(0);
    expect(onOffsetChange).toHaveBeenCalledWith(0);
  });
});
