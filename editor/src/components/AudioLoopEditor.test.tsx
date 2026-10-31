// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EditorAsset } from "../types";
import { AudioLoopEditor, type AudioLoopEditorProps } from "./AudioLoopEditor";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
}));

const ASSET: EditorAsset = {
  id: "bgm.a",
  kind: "bgm",
  path: "audio/a.ogg",
  absolute_path: "C:/game/audio/a.ogg",
  metadata: {
    channels: 2,
    duration_ms: "4000",
    font_family: null,
    font_style: null,
    format: "ogg",
    height: null,
    sample_rate: 44100,
    width: null,
  },
};

/** Stable decode seam: 4 s of half-amplitude audio. */
const load = vi.fn(() =>
  Promise.resolve({
    durationMs: 4000,
    peaks: new Array<number>(32).fill(0.5),
  }),
);

const playSpy = vi.fn((): Promise<void> => Promise.resolve());
const pauseSpy = vi.fn((): void => undefined);
const loadSpy = vi.fn((): void => undefined);

beforeEach(() => {
  load.mockClear();
  playSpy.mockClear();
  pauseSpy.mockClear();
  loadSpy.mockClear();
  HTMLMediaElement.prototype.play = playSpy;
  HTMLMediaElement.prototype.pause = pauseSpy;
  // jsdom does not implement the media load() reset; the component uses it to
  // release a detached element, and the spy keeps the output free of jsdom's
  // "not implemented" warning.
  HTMLMediaElement.prototype.load = loadSpy;
});

afterEach(cleanup);

/** A `play()` promise the test can settle after the transport has moved on. */
function deferredPlay(): {
  promise: Promise<void>;
  reject(reason: unknown): void;
  resolve(): void;
} {
  let reject: (reason: unknown) => void = () => undefined;
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePlay, rejectPlay) => {
    reject = rejectPlay;
    resolve = resolvePlay;
  });
  return { promise, reject, resolve };
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

function renderEditor(
  overrides: Partial<AudioLoopEditorProps> = {},
  options: { strict?: boolean } = {},
) {
  const onChange = vi.fn();
  const props: AudioLoopEditorProps = {
    asset: ASSET,
    decode: load,
    label: "BGM",
    loopEndMs: 3000,
    loopStartMs: 1000,
    onChange,
    startMs: 500,
    volume: 1,
    ...overrides,
  };
  const view = render(
    options.strict === true ? (
      <StrictMode>
        <AudioLoopEditor {...props} />
      </StrictMode>
    ) : (
      <AudioLoopEditor {...props} />
    ),
  );
  const track = view.container.querySelector<HTMLElement>(
    '[data-audio-loop-track="true"]',
  );
  if (track === null) throw new Error("missing waveform track");
  // jsdom has no layout; the marker math needs a deterministic track box.
  Object.defineProperty(track, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: 40,
      height: 40,
      left: 0,
      right: 1000,
      toJSON: () => ({}),
      top: 0,
      width: 1000,
      x: 0,
      y: 0,
    }),
  });
  const audio = view.container.querySelector("audio");
  if (audio === null) throw new Error("missing audition element");
  // The source effect assigns the media URL imperatively, so metadata is
  // usually ready by the time the author interacts.  Tests that need a
  // metadata-pending element redefine this to HAVE_NOTHING.
  Object.defineProperty(audio, "readyState", {
    configurable: true,
    value: HTMLMediaElement.HAVE_METADATA,
  });
  return { audio, onChange, props, track, view };
}

function slider(name: string): HTMLElement {
  return screen.getByRole("slider", { name });
}

function drag(handle: HTMLElement, fromX: number, toX: number): void {
  fireEvent.pointerDown(handle, { clientX: fromX, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: toX, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: toX, pointerId: 1 });
}

describe("AudioLoopEditor", () => {
  it("shows authored milliseconds without normalising them on load", () => {
    const { onChange } = renderEditor({
      loopEndMs: 3999,
      loopStartMs: 250,
      startMs: 1234,
    });
    expect(screen.getByLabelText("起播 ms")).toHaveValue(1234);
    expect(screen.getByLabelText("循环起点 ms")).toHaveValue(250);
    expect(screen.getByLabelText("循环终点 ms")).toHaveValue(3999);
    expect(slider("BGM 起播标记")).toHaveAttribute("aria-valuenow", "1234");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps an out-of-range authored marker while clamping slider ARIA", () => {
    renderEditor({ loopEndMs: 5000, loopStartMs: 1000, startMs: 500 });
    // The authored value survives exactly in the numeric field…
    expect(screen.getByLabelText("循环终点 ms")).toHaveValue(5000);
    // …while the slider reports a valid range for assistive tech.
    const handle = slider("BGM 循环终点标记");
    expect(handle).toHaveAttribute("aria-valuemax", "4000");
    expect(handle).toHaveAttribute("aria-valuenow", "4000");
    expect(handle).toHaveAttribute(
      "aria-valuetext",
      "已保存 5000 ms，超出素材时长，按 4000 ms 显示",
    );
  });

  it("never starts playback without an explicit audition action", async () => {
    const { audio } = renderEditor();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("素材时长"),
    );
    expect(playSpy).not.toHaveBeenCalled();
    // Loading metadata is not a user gesture either.
    fireEvent.loadedMetadata(audio);
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("still plays on an explicit gesture under React StrictMode", () => {
    const { audio } = renderEditor({}, { strict: true });
    expect(audio.getAttribute("src")).toBe("C:/game/audio/a.ogg");
    expect(playSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "试听（从起播点）" }));
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(0.5);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("commits one exact millisecond value per drag on pointer-up", () => {
    const { onChange } = renderEditor();
    drag(slider("BGM 起播标记"), 125, 250);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      loop_end_ms: 3000,
      loop_start_ms: 1000,
      start_ms: 1000,
    });
  });

  it("clamps a dragged start marker to the loop end", () => {
    const { onChange } = renderEditor();
    drag(slider("BGM 起播标记"), 125, 990);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ start_ms: 3000 }),
    );
  });

  it("prevents loop markers from inverting", () => {
    const { onChange } = renderEditor();
    drag(slider("BGM 循环起点标记"), 250, 990);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ loop_start_ms: 2999 }),
    );
  });

  it("commits exact integer milliseconds from the numeric fields", () => {
    const { onChange } = renderEditor();
    const input = screen.getByLabelText("起播 ms");
    fireEvent.change(input, { target: { value: "1234" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      loop_end_ms: 3000,
      loop_start_ms: 1000,
      start_ms: 1234,
    });
  });

  it("clamps out-of-range numeric input instead of persisting it", () => {
    const { onChange } = renderEditor();
    const input = screen.getByLabelText("循环终点 ms");
    fireEvent.change(input, { target: { value: "9000" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ loop_end_ms: 4000 }),
    );
  });

  it("ignores a negative numeric commit", () => {
    const { onChange } = renderEditor();
    const input = screen.getByLabelText("起播 ms");
    fireEvent.change(input, { target: { value: "-20" } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue(500);
  });

  it("nudges a marker with the keyboard", () => {
    const { onChange } = renderEditor();
    fireEvent.keyDown(slider("BGM 起播标记"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ start_ms: 510 }),
    );
  });

  it("uses the media duration as the custom-loop default", async () => {
    const { onChange } = renderEditor({ loopEndMs: null, loopStartMs: null });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("素材时长"),
    );
    fireEvent.click(screen.getByLabelText("自定义循环段"));
    expect(onChange).toHaveBeenCalledWith({
      loop_end_ms: 4000,
      loop_start_ms: 0,
      start_ms: 500,
    });
  });

  it("seeks on a waveform click without playing", () => {
    const { audio, track } = renderEditor();
    fireEvent.pointerDown(track, { clientX: 500, pointerId: 1 });
    expect(audio.currentTime).toBe(2);
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("starts audition at start_ms, pauses and replays", () => {
    const { audio } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "试听（从起播点）" }));
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(0.5);

    fireEvent.click(screen.getByRole("button", { name: "暂停试听" }));
    expect(pauseSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "试听（从起播点）" }));
    expect(playSpy).toHaveBeenCalledTimes(2);
    expect(audio.currentTime).toBe(0.5);
  });

  it("replays from the authored start after a natural EOF", () => {
    const { audio } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "试听（从起播点）" }));
    expect(audio.currentTime).toBe(0.5);

    // The media runs to its own end; the cursor must not stay there.
    audio.currentTime = 4;
    fireEvent.ended(audio);
    const replay = screen.getByRole("button", { name: "试听（从起播点）" });
    playSpy.mockClear();
    fireEvent.click(replay);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(0.5);
  });

  it("labels a positioned resume accurately and resumes from the cursor", () => {
    const { audio, track } = renderEditor();
    fireEvent.pointerDown(track, { clientX: 500, pointerId: 1 });
    const resume = screen.getByRole("button", {
      name: "继续试听（2000 ms）",
    });
    fireEvent.click(resume);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(2);
  });

  it("queues the start position while metadata is still pending", () => {
    const { audio } = renderEditor();
    Object.defineProperty(audio, "readyState", {
      configurable: true,
      value: 0,
    });
    fireEvent.click(screen.getByRole("button", { name: "试听（从起播点）" }));
    // The real browser play() path is not blocked on metadata…
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(0);
    expect(screen.getByText("500 ms")).toBeDefined();
    // …and the queued seek lands as soon as the element is ready.
    fireEvent.loadedMetadata(audio);
    expect(audio.currentTime).toBe(0.5);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("auditions the whole loop from the loop start", () => {
    const { audio } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "整段循环试听" }));
    expect(audio.currentTime).toBe(1);
    audio.currentTime = 3;
    fireEvent.timeUpdate(audio);
    expect(audio.currentTime).toBe(1);
  });

  it("starts the seam audition just before the loop end, then wraps", () => {
    const { audio } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "接缝试听" }));
    // loopEnd - 1500ms, clamped to loopStart.
    expect(audio.currentTime).toBe(1.5);
    audio.currentTime = 3;
    fireEvent.timeUpdate(audio);
    expect(audio.currentTime).toBe(1);
  });

  it("starts a short-loop seam audition at the loop start", () => {
    const { audio } = renderEditor({ loopEndMs: 3000, loopStartMs: 2000 });
    fireEvent.click(screen.getByRole("button", { name: "接缝试听" }));
    expect(audio.currentTime).toBe(2);
  });

  it("keeps wrapping a seam audition at the media end", () => {
    const { audio } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "接缝试听" }));
    playSpy.mockClear();
    audio.currentTime = 4;
    fireEvent.ended(audio);
    expect(audio.currentTime).toBe(1);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the same element and phase when the loop points are edited", () => {
    const { audio, onChange, props, view } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "整段循环试听" }));
    audio.currentTime = 1.5;
    fireEvent.timeUpdate(audio);
    pauseSpy.mockClear();
    const element = audio;

    // A numeric loop-point edit commits once and must not restart anything.
    const input = screen.getByLabelText("循环终点 ms");
    fireEvent.change(input, { target: { value: "2500" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ loop_end_ms: 2500 }),
    );
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "暂停试听" })).toBeDefined();

    // The parent commits the new bounds (the App path): same element, same
    // cursor, still playing.
    view.rerender(<AudioLoopEditor {...props} loopEndMs={2500} />);
    expect(view.container.querySelector("audio")).toBe(element);
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(audio.currentTime).toBe(1.5);
    expect(screen.getByRole("button", { name: "暂停试听" })).toBeDefined();

    // The next boundary check uses the committed bounds.
    audio.currentTime = 2.5;
    fireEvent.timeUpdate(audio);
    expect(audio.currentTime).toBe(1);
  });

  it("does not jump into a range that starts ahead of the cursor", () => {
    const { audio, props, view } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "整段循环试听" }));
    audio.currentTime = 1.2;
    fireEvent.timeUpdate(audio);

    // The approved preserve-position rule: an edit never seeks the transport,
    // the gap plays once and the wrap happens at the next boundary check.
    view.rerender(
      <AudioLoopEditor {...props} loopEndMs={3900} loopStartMs={2000} />,
    );
    expect(audio.currentTime).toBe(1.2);
    audio.currentTime = 3.9;
    fireEvent.timeUpdate(audio);
    expect(audio.currentTime).toBe(2);
  });

  it("switches a running loop audition to native whole-file looping", () => {
    const { audio, props, view } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "整段循环试听" }));
    expect(audio.loop).toBe(false);
    pauseSpy.mockClear();

    // Clearing the custom bounds keeps the element, the phase and playback;
    // the element itself now loops the whole file.
    view.rerender(
      <AudioLoopEditor {...props} loopEndMs={null} loopStartMs={null} />,
    );
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(audio.loop).toBe(true);
    expect(screen.getByRole("button", { name: "暂停试听" })).toBeDefined();

    // Custom wrapping is off, so a full-file pass is left to the element.
    audio.currentTime = 3.5;
    fireEvent.timeUpdate(audio);
    expect(audio.currentTime).toBe(3.5);
  });

  it("keeps a one-shot audition one-shot when bounds appear later", () => {
    const { audio, props, view } = renderEditor({
      loopEndMs: null,
      loopStartMs: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "试听（从起播点）" }));
    expect(playSpy).toHaveBeenCalledTimes(1);

    view.rerender(
      <AudioLoopEditor {...props} loopEndMs={3000} loopStartMs={1000} />,
    );
    expect(audio.loop).toBe(false);
    audio.currentTime = 3.5;
    fireEvent.timeUpdate(audio);
    expect(audio.currentTime).toBe(3.5);
    fireEvent.ended(audio);
    expect(
      screen.getByRole("button", { name: "试听（从起播点）" }),
    ).toBeDefined();
  });

  it("disables both loop auditions without both loop points", () => {
    renderEditor({ loopEndMs: null, loopStartMs: null });
    expect(screen.getByRole("button", { name: "整段循环试听" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "接缝试听" })).toBeDisabled();
  });

  it("surfaces a rejected play() visibly", async () => {
    const onError = vi.fn();
    const { onChange } = renderEditor({ onError });
    playSpy.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "试听（从起播点）" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("无法开始试听"),
    );
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("无法开始试听"),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("treats a pending play() interrupted by pause as a cancellation", async () => {
    const onError = vi.fn();
    renderEditor({ onError });
    const pending = deferredPlay();
    playSpy.mockReturnValueOnce(pending.promise);

    fireEvent.click(screen.getByRole("button", { name: "试听（从起播点）" }));
    fireEvent.click(screen.getByRole("button", { name: "暂停试听" }));
    pending.reject(
      new DOMException(
        "The play() request was interrupted by a call to pause().",
        "AbortError",
      ),
    );
    await flush();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    // The deliberate pause is not overwritten by the stale rejection.
    expect(
      screen.getByRole("button", { name: "试听（从起播点）" }),
    ).toBeDefined();
  });

  it("does not rewind or restart when media events arrive after pause or stop", () => {
    const { audio } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "整段循环试听" }));
    audio.currentTime = 1.5;
    fireEvent.timeUpdate(audio);

    // Pause: a queued event that overshoots the loop end must neither rewind
    // the element nor replay it.
    fireEvent.click(screen.getByRole("button", { name: "暂停试听" }));
    playSpy.mockClear();
    audio.currentTime = 3;
    fireEvent.timeUpdate(audio);
    expect(audio.currentTime).toBe(3);
    fireEvent.ended(audio);
    expect(playSpy).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "继续试听（1500 ms）" }),
    ).toBeDefined();

    // Stop: the cursor is cleared and stays cleared, and no late event can
    // revive playback.
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    audio.currentTime = 3.9;
    fireEvent.timeUpdate(audio);
    expect(audio.currentTime).toBe(3.9);
    fireEvent.ended(audio);
    expect(playSpy).not.toHaveBeenCalled();
    expect(screen.getByText("—")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "试听（从起播点）" }),
    ).toBeDefined();
  });

  it("resumes a paused loop audition in loop mode with the current bounds", () => {
    const { audio, props, view } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "整段循环试听" }));
    audio.currentTime = 1.5;
    fireEvent.timeUpdate(audio);
    fireEvent.click(screen.getByRole("button", { name: "暂停试听" }));
    playSpy.mockClear();

    // Resume continues the loop audition the author selected…
    fireEvent.click(
      screen.getByRole("button", { name: "继续试听（1500 ms）" }),
    );
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(1.5);

    // …and still wraps around the *current committed* bounds after an edit.
    view.rerender(<AudioLoopEditor {...props} loopEndMs={2500} />);
    audio.currentTime = 2.5;
    fireEvent.timeUpdate(audio);
    expect(audio.currentTime).toBe(1);
  });

  it("resumes a whole-file loop whose custom bounds were removed while paused", () => {
    const { audio, props, view } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "整段循环试听" }));
    fireEvent.click(screen.getByRole("button", { name: "暂停试听" }));

    // Clearing the bounds while paused keeps the loop mode…
    view.rerender(
      <AudioLoopEditor {...props} loopEndMs={null} loopStartMs={null} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "继续试听（1000 ms）" }),
    );
    expect(playSpy).toHaveBeenCalledTimes(2);
    // …so the resumed element loops the whole file itself.
    expect(audio.loop).toBe(true);
    audio.currentTime = 3.5;
    fireEvent.timeUpdate(audio);
    expect(audio.currentTime).toBe(3.5);
  });

  it("starts a fresh one-shot after a stop, not a resumed loop", () => {
    const { audio } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "整段循环试听" }));
    fireEvent.click(screen.getByRole("button", { name: "停止" }));

    fireEvent.click(screen.getByRole("button", { name: "试听（从起播点）" }));
    expect(audio.currentTime).toBe(0.5);
    audio.currentTime = 3.5;
    fireEvent.timeUpdate(audio);
    expect(audio.currentTime).toBe(3.5);
  });

  it("drops the queued metadata seek on stop so late metadata cannot revive it", () => {
    const { audio } = renderEditor();
    Object.defineProperty(audio, "readyState", {
      configurable: true,
      value: 0,
    });
    fireEvent.click(screen.getByRole("button", { name: "试听（从起播点）" }));
    fireEvent.click(screen.getByRole("button", { name: "停止" }));

    fireEvent.loadedMetadata(audio);
    expect(audio.currentTime).toBe(0);
    expect(screen.getByText("—")).toBeDefined();
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("disarms the loop replay when the current play() failed", async () => {
    const { audio } = renderEditor({ onError: vi.fn() });
    playSpy.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "整段循环试听" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());

    playSpy.mockClear();
    audio.currentTime = 4;
    fireEvent.ended(audio);
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("surfaces a current AbortError the author did not cause", async () => {
    const onError = vi.fn();
    const { audio, track } = renderEditor({ onError });
    // Put the cursor away from the authored start so a paused transport is
    // distinguishable from a stopped one (stop clears the cursor).
    fireEvent.pointerDown(track, { clientX: 500, pointerId: 1 });
    playSpy.mockRejectedValueOnce(
      new DOMException("source aborted", "AbortError"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "继续试听（2000 ms）" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("无法开始试听"),
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "继续试听（2000 ms）" }),
    ).toBeDefined();
    expect(audio.currentTime).toBe(2);
  });

  it("keeps the stopped state when a superseded play() resolves late", async () => {
    const { audio } = renderEditor();
    const pending = deferredPlay();
    playSpy.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "试听（从起播点）" }));
    fireEvent.click(screen.getByRole("button", { name: "停止" }));

    pending.resolve();
    await flush();
    expect(
      screen.getByRole("button", { name: "试听（从起播点）" }),
    ).toBeDefined();
    expect(screen.getByText("—")).toBeDefined();

    // A media event from the superseded attempt still cannot revive it.
    audio.currentTime = 3;
    fireEvent.timeUpdate(audio);
    fireEvent.ended(audio);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("—")).toBeDefined();
  });

  it("does not report or overwrite a stop when the pending play() rejects", async () => {
    const onError = vi.fn();
    renderEditor({ onError });
    const pending = deferredPlay();
    playSpy.mockReturnValueOnce(pending.promise);

    fireEvent.click(screen.getByRole("button", { name: "试听（从起播点）" }));
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    pending.reject(new Error("denied"));
    await flush();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "试听（从起播点）" }),
    ).toBeDefined();
    expect(screen.getByText("—")).toBeDefined();
  });

  it("ignores a stale rejection after a newer audition supersedes it", async () => {
    const onError = vi.fn();
    renderEditor({ onError });
    const pending = deferredPlay();
    playSpy.mockReturnValueOnce(pending.promise);

    fireEvent.click(screen.getByRole("button", { name: "试听（从起播点）" }));
    fireEvent.click(screen.getByRole("button", { name: "整段循环试听" }));
    pending.reject(new Error("denied"));
    await flush();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    // The newer loop audition keeps playing.
    expect(screen.getByRole("button", { name: "暂停试听" })).toBeDefined();
  });

  it("ignores a rejection from an unmounted transport", async () => {
    const onError = vi.fn();
    const { view } = renderEditor({ onError });
    const pending = deferredPlay();
    playSpy.mockReturnValueOnce(pending.promise);

    fireEvent.click(screen.getByRole("button", { name: "试听（从起播点）" }));
    view.unmount();
    pending.reject(new Error("denied"));
    await flush();

    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps numeric editing when the waveform decode fails", async () => {
    const failing = vi.fn(() => Promise.reject(new Error("decode boom")));
    const { onChange } = renderEditor({ decode: failing });
    await waitFor(() => expect(screen.getByText(/decode boom/)).toBeDefined());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("起播 ms")).toHaveValue(500);
    // Host metadata still provides the duration, so the handles stay editable.
    expect(slider("BGM 起播标记")).toBeDefined();
  });

  it("disables dragging when neither the host nor the decoder knows the duration", async () => {
    const failing = vi.fn(() => Promise.reject(new Error("decode boom")));
    renderEditor({ asset: { ...ASSET, metadata: null }, decode: failing });
    await waitFor(() => expect(screen.getByText(/decode boom/)).toBeDefined());
    expect(screen.queryByRole("slider", { name: "BGM 起播标记" })).toBeNull();
    expect(screen.getByLabelText("起播 ms")).toHaveValue(500);
  });

  it("stops and releases the private transport on unmount", () => {
    const { audio, view } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "试听（从起播点）" }));
    pauseSpy.mockClear();
    loadSpy.mockClear();
    view.unmount();
    expect(pauseSpy).toHaveBeenCalled();
    expect(loadSpy).toHaveBeenCalled();
    expect(audio.getAttribute("src")).toBeNull();
  });

  it("stops and releases the old transport when the asset changes", () => {
    const { audio, props, view } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "试听（从起播点）" }));
    pauseSpy.mockClear();
    view.rerender(
      <AudioLoopEditor
        {...props}
        asset={{
          ...ASSET,
          absolute_path: "C:/game/audio/b.ogg",
          id: "bgm.b",
        }}
      />,
    );
    expect(pauseSpy).toHaveBeenCalled();
    const next = view.container.querySelector("audio");
    expect(next).not.toBe(audio);
    expect(next?.getAttribute("src")).toBe("C:/game/audio/b.ogg");
  });

  it("renders a waveform path once decoding succeeds", async () => {
    const { view } = renderEditor();
    await waitFor(() =>
      expect(
        view.container.querySelector(".audio-loop-waveform path"),
      ).not.toBeNull(),
    );
  });
});
