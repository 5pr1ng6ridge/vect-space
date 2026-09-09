import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePaperArtwork } from "./PaperArtwork";

afterEach(() => vi.unstubAllGlobals());

it("waits for decode and ignores completion of a replaced image", async () => {
  const pending: { onload: () => void; finish: () => void }[] = [];
  vi.stubGlobal(
    "Image",
    class {
      onload = () => {};
      onerror = () => {};
      src = "";
      finish = () => {};
      decode = () =>
        new Promise<void>((resolve) => {
          this.finish = resolve;
        });
      constructor() {
        pending.push(this);
      }
    },
  );
  const view = renderHook(({ url }) => usePaperArtwork(url), {
    initialProps: { url: "delayed-a" },
  });
  expect(view.result.current).toEqual({ ready: false, url: undefined });
  act(() => pending[0].onload());
  expect(view.result.current.ready).toBe(false);
  view.rerender({ url: "delayed-b" });
  await act(async () => pending[0].finish());
  expect(view.result.current.ready).toBe(false);
  act(() => pending[1].onload());
  await act(async () => pending[1].finish());
  expect(view.result.current).toEqual({ ready: true, url: "delayed-b" });
});

it("releases a failed image to a transparent fallback", async () => {
  let fail = () => {};
  vi.stubGlobal(
    "Image",
    class {
      onerror = () => {};
      set src(_url: string) {
        fail = () => this.onerror();
      }
    },
  );
  const view = renderHook(() => usePaperArtwork("failed-paper"));
  await act(async () => fail());
  expect(view.result.current).toEqual({ ready: true, url: undefined });
});
