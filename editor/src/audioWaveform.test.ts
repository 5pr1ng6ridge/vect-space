import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_WAVEFORM_BYTES,
  MAX_WAVEFORM_DURATION_MS,
  WaveformUnavailableError,
  decodeWaveform,
  downsamplePeaks,
  estimateDecodedPcmBytes,
  probeMediaDurationMs,
} from "./audioWaveform";

beforeEach(() => {
  // jsdom exposes an `Audio` constructor that never loads, so the duration
  // preflight would time out in every test.  Probe-specific tests stub their
  // own fake; everything else disables the probe and passes a known duration.
  vi.stubGlobal("Audio", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeBuffer(
  duration: number,
  samples: Float32Array,
  sampleRate = 44_100,
  numberOfChannels = 2,
): AudioBuffer {
  return {
    duration,
    getChannelData: () => samples,
    numberOfChannels,
    sampleRate,
  } as unknown as AudioBuffer;
}

class FakeOfflineAudioContext {
  readonly buffer: AudioBuffer;

  constructor(buffer = fakeBuffer(4, new Float32Array([0, 0.5, -1]))) {
    this.buffer = buffer;
  }

  decodeAudioData(): Promise<AudioBuffer> {
    return Promise.resolve(this.buffer);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function stubDecodeContext(
  buffer = fakeBuffer(4, new Float32Array([0, 0.5, -1])),
): void {
  vi.stubGlobal(
    "OfflineAudioContext",
    class extends FakeOfflineAudioContext {
      constructor() {
        super(buffer);
      }
    },
  );
}

/** Counts decode-context construction so a test can prove decode never ran. */
function countDecodeContexts(): () => number {
  let contexts = 0;
  vi.stubGlobal(
    "OfflineAudioContext",
    class {
      constructor() {
        contexts += 1;
      }
      decodeAudioData(): Promise<AudioBuffer> {
        return Promise.reject(new Error("must not decode"));
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    },
  );
  return () => contexts;
}

/** Reader fake so a test can observe cancellation and lock release. */
interface FakeReader {
  cancelled: boolean;
  reads: number;
  released: boolean;
}

function fakeBody(chunks: Uint8Array[]): {
  body: ReadableStream<Uint8Array>;
  reader: FakeReader;
} {
  const remaining = [...chunks];
  const reader: FakeReader = { cancelled: false, reads: 0, released: false };
  const stream = {
    getReader: () => ({
      cancel: () => {
        reader.cancelled = true;
        return Promise.resolve();
      },
      read: () => {
        reader.reads += 1;
        const next = remaining.shift();
        return Promise.resolve(
          next === undefined ? { done: true } : { done: false, value: next },
        );
      },
      releaseLock: () => {
        reader.released = true;
      },
    }),
  } as unknown as ReadableStream<Uint8Array>;
  return { body: stream, reader };
}

function realBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

interface ResponseHarness {
  arrayBuffer: ReturnType<typeof vi.fn>;
  response: Response;
}

function response(overrides: {
  body?: ReadableStream<Uint8Array> | null;
  bytes?: Uint8Array;
  contentLength?: string | null;
  ok?: boolean;
  status?: number;
}): ResponseHarness {
  const bytes = overrides.bytes ?? new Uint8Array(2048);
  const arrayBuffer = vi.fn(() => Promise.resolve(bytes.slice().buffer));
  const value = {
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-length"
          ? (overrides.contentLength ?? null)
          : null,
    },
    body: overrides.body === undefined ? realBody(bytes) : overrides.body,
    arrayBuffer,
  } as unknown as Response;
  return { arrayBuffer, response: value };
}

function stubFetch(harness: ResponseHarness): {
  arrayBuffer: ReturnType<typeof vi.fn>;
  fetchSpy: ReturnType<typeof vi.fn>;
} {
  const fetchSpy = vi.fn(() => Promise.resolve(harness.response));
  vi.stubGlobal("fetch", fetchSpy);
  return { arrayBuffer: harness.arrayBuffer, fetchSpy };
}

/** A complete, in-budget media shape for the download/decode happy paths. */
const KNOWN = {
  knownChannels: 2,
  knownDurationMs: 4000,
  knownSampleRate: 44_100,
} as const;

describe("downsamplePeaks", () => {
  it("returns zeros for an empty buffer", () => {
    const peaks = downsamplePeaks(new Float32Array(0), 4);
    expect(peaks).toEqual([0, 0, 0, 0]);
  });

  it("keeps the peak amplitude per bucket and clamps to 1", () => {
    const samples = new Float32Array([0.1, 0.9, 0.2, 2]);
    const peaks = downsamplePeaks(samples, 2);
    expect(peaks[0]).toBeCloseTo(0.9, 5);
    expect(peaks[1]).toBe(1);
  });
});

describe("estimateDecodedPcmBytes", () => {
  it("is the float32 size of the decoded channels", () => {
    expect(estimateDecodedPcmBytes(10, 44_100, 2)).toBe(10 * 44_100 * 2 * 4);
  });

  it("returns 0 for a non-finite shape", () => {
    expect(estimateDecodedPcmBytes(Number.NaN, 44_100, 2)).toBe(0);
  });
});

describe("probeMediaDurationMs", () => {
  it("returns null when the environment cannot probe", async () => {
    await expect(probeMediaDurationMs("C:/a.ogg", undefined, 10)).resolves.toBe(
      null,
    );
  });

  it("reads the duration from loadedmetadata", async () => {
    const listeners = new Map<string, Set<() => void>>();
    class FakeAudio {
      duration = 4.5;
      preload = "";
      src = "";
      addEventListener(type: string, listener: () => void): void {
        const set = listeners.get(type) ?? new Set<() => void>();
        set.add(listener);
        listeners.set(type, set);
      }
      removeEventListener(type: string, listener: () => void): void {
        listeners.get(type)?.delete(listener);
      }
      removeAttribute(name: string): void {
        if (name === "src") this.src = "";
      }
    }
    vi.stubGlobal("Audio", FakeAudio);
    const promise = probeMediaDurationMs("C:/a.ogg", undefined, 50);
    for (const listener of [...(listeners.get("loadedmetadata") ?? [])])
      listener();
    await expect(promise).resolves.toBe(4500);
  });

  it("times out to null so the caller can fall back honestly", async () => {
    class SilentAudio {
      preload = "";
      src = "";
      addEventListener(): void {
        // never reports metadata
      }
      removeEventListener(): void {
        // nothing registered
      }
      removeAttribute(): void {
        // no src to clear
      }
    }
    vi.stubGlobal("Audio", SilentAudio);
    await expect(probeMediaDurationMs("C:/a.ogg", undefined, 5)).resolves.toBe(
      null,
    );
  });

  it("returns null for an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      probeMediaDurationMs("C:/a.ogg", controller.signal),
    ).resolves.toBeNull();
  });
});

describe("decodeWaveform", () => {
  it("streams the body and returns peaks plus the decoded duration", async () => {
    stubFetch(response({ bytes: new Uint8Array(2048) }));
    stubDecodeContext(fakeBuffer(4, new Float32Array([0, 0.5, 1, 0])));
    const result = await decodeWaveform("C:/a.ogg", {
      ...KNOWN,
      buckets: 2,
    });
    expect(result.durationMs).toBe(4000);
    expect(result.peaks).toHaveLength(2);
    expect(result.peaks[1]).toBe(1);
  });

  it("uses the bounded metadata probe when the host has no duration", async () => {
    const listeners = new Map<string, Set<() => void>>();
    class FakeAudio {
      duration = 4.5;
      preload = "";
      src = "";
      addEventListener(type: string, listener: () => void): void {
        const set = listeners.get(type) ?? new Set<() => void>();
        set.add(listener);
        listeners.set(type, set);
      }
      removeEventListener(type: string, listener: () => void): void {
        listeners.get(type)?.delete(listener);
      }
      removeAttribute(): void {
        // nothing to release
      }
    }
    vi.stubGlobal("Audio", FakeAudio);
    stubFetch(response({ bytes: new Uint8Array(2048) }));
    stubDecodeContext();
    const promise = decodeWaveform("C:/a.ogg", {
      buckets: 2,
      knownChannels: 2,
      knownSampleRate: 44_100,
    });
    for (const listener of [...(listeners.get("loadedmetadata") ?? [])])
      listener();
    await expect(promise).resolves.toMatchObject({ durationMs: 4000 });
  });

  it("rejects an unknown duration before downloading or decoding", async () => {
    const { arrayBuffer, fetchSpy } = stubFetch(response({}));
    const contexts = countDecodeContexts();
    await expect(decodeWaveform("C:/a.ogg")).rejects.toMatchObject({
      name: "WaveformUnavailableError",
      reason: "unsupported",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(contexts()).toBe(0);
  });

  it("rejects an over-long file from the declared content length before reading", async () => {
    const { body, reader } = fakeBody([]);
    stubFetch(
      response({ body, contentLength: String(MAX_WAVEFORM_BYTES + 1) }),
    );
    await expect(
      decodeWaveform("C:/a.ogg", { ...KNOWN }),
    ).rejects.toMatchObject({
      reason: "too-large",
    });
    expect(reader.reads).toBe(0);
  });

  it("cancels the reader the moment the streaming cap is exceeded", async () => {
    const { body, reader } = fakeBody([
      new Uint8Array(MAX_WAVEFORM_BYTES + 1),
      new Uint8Array(1024),
    ]);
    stubFetch(response({ body }));
    await expect(
      decodeWaveform("C:/a.ogg", { ...KNOWN }),
    ).rejects.toMatchObject({ reason: "too-large" });
    expect(reader.cancelled).toBe(true);
    expect(reader.released).toBe(true);
    // The oversized chunk alone tripped the cap; later chunks were never read.
    expect(reader.reads).toBe(1);
  });

  it.each([
    ["no length is declared", { body: null }],
    [
      "the declared length is valid",
      { body: null, bytes: new Uint8Array(16), contentLength: "16" },
    ],
    [
      "the length is under-reported",
      { body: null, bytes: new Uint8Array(4096), contentLength: "1" },
    ],
  ])(
    "refuses a response without a readable stream when %s",
    async (_label, init) => {
      const { arrayBuffer } = stubFetch(response(init));
      const contexts = countDecodeContexts();
      await expect(
        decodeWaveform("C:/a.ogg", { ...KNOWN }),
      ).rejects.toMatchObject({ reason: "unsupported" });
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(contexts()).toBe(0);
    },
  );

  it("refuses a missing or invalid channel count before decoding", async () => {
    for (const knownChannels of [null, undefined, 0, Number.NaN, -2]) {
      const { arrayBuffer, fetchSpy } = stubFetch(response({}));
      const contexts = countDecodeContexts();
      await expect(
        decodeWaveform("C:/a.ogg", { knownChannels, knownDurationMs: 4000 }),
      ).rejects.toMatchObject({ reason: "unsupported" });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(contexts()).toBe(0);
    }
  });

  // The decoder always produces 44.1 kHz PCM, so a low, absent or invalid
  // metadata rate must not shrink the estimate below the real decode size.
  const BUDGET = 100 * 1024 * 1024;
  it.each([
    [
      "a host-declared over-long file",
      { knownDurationMs: MAX_WAVEFORM_DURATION_MS + 1 },
      "too-long",
    ],
    [
      "a PCM estimate over the decode cap",
      {
        knownChannels: 2,
        knownDurationMs: 10 * 60 * 1000,
        knownSampleRate: 192_000,
        maxDecodedBytes: 1024,
      },
      "too-large",
    ],
    [
      "a high-channel duration over the cap",
      {
        knownChannels: 8,
        knownDurationMs: 10 * 60 * 1000,
        knownSampleRate: 44_100,
      },
      "too-large",
    ],
    [
      "a low metadata sample rate",
      {
        knownChannels: 2,
        knownDurationMs: MAX_WAVEFORM_DURATION_MS,
        knownSampleRate: 8000,
        maxDecodedBytes: BUDGET,
      },
      "too-large",
    ],
    [
      "a missing metadata sample rate",
      {
        knownChannels: 2,
        knownDurationMs: MAX_WAVEFORM_DURATION_MS,
        maxDecodedBytes: BUDGET,
      },
      "too-large",
    ],
    [
      "an invalid metadata sample rate",
      {
        knownChannels: 2,
        knownDurationMs: MAX_WAVEFORM_DURATION_MS,
        knownSampleRate: Number.NaN,
        maxDecodedBytes: BUDGET,
      },
      "too-large",
    ],
  ])("rejects %s before any download", async (_label, options, reason) => {
    const { fetchSpy } = stubFetch(response({}));
    await expect(decodeWaveform("C:/a.ogg", options)).rejects.toMatchObject({
      reason,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requests the controlled decode target rate on both context paths", async () => {
    const offlineArgs: number[][] = [];
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        constructor(...args: number[]) {
          offlineArgs.push(args);
        }
        decodeAudioData(): Promise<AudioBuffer> {
          return Promise.resolve(fakeBuffer(4, new Float32Array([1])));
        }
        close(): Promise<void> {
          return Promise.resolve();
        }
      },
    );
    stubFetch(response({ bytes: new Uint8Array(2048) }));
    await decodeWaveform("C:/a.ogg", { ...KNOWN, buckets: 2 });
    expect(offlineArgs).toEqual([[1, 1, 44_100]]);

    // The live-context fallback must ask for the same rate instead of the
    // device default (e.g. 48 kHz), which would contradict the pre-decode
    // budget.
    vi.stubGlobal("OfflineAudioContext", undefined);
    const liveOptions: ({ sampleRate?: number } | undefined)[] = [];
    class FakeAudioContext {
      constructor(options?: { sampleRate?: number }) {
        liveOptions.push(options);
      }
      decodeAudioData(): Promise<AudioBuffer> {
        return Promise.resolve(fakeBuffer(4, new Float32Array([1])));
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    stubFetch(response({ bytes: new Uint8Array(2048) }));
    await decodeWaveform("C:/a.ogg", { ...KNOWN, buckets: 2 });
    expect(liveOptions).toEqual([{ sampleRate: 44_100 }]);
  });

  it("reports a fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    await expect(
      decodeWaveform("C:/a.ogg", { ...KNOWN }),
    ).rejects.toMatchObject({ reason: "fetch" });
  });

  it("reports a decode failure and still closes the context", async () => {
    const closes: boolean[] = [];
    stubFetch(response({ bytes: new Uint8Array(16) }));
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData(): Promise<AudioBuffer> {
          return Promise.reject(new Error("bad codec"));
        }
        close(): Promise<void> {
          closes.push(true);
          return Promise.resolve();
        }
      },
    );
    await expect(
      decodeWaveform("C:/a.ogg", { ...KNOWN }),
    ).rejects.toMatchObject({ reason: "decode" });
    expect(closes).toHaveLength(1);
  });

  it("refuses media longer than the configured bound after decoding", async () => {
    stubFetch(response({ bytes: new Uint8Array(16) }));
    stubDecodeContext(fakeBuffer(9999, new Float32Array([1])));
    await expect(
      decodeWaveform("C:/a.ogg", {
        knownChannels: 2,
        knownDurationMs: 1000,
        knownSampleRate: 44_100,
        maxDurationMs: 1000,
      }),
    ).rejects.toMatchObject({ reason: "too-long" });
  });

  it("refuses a decoded PCM shape over the decode cap", async () => {
    stubFetch(response({ bytes: new Uint8Array(16) }));
    // The metadata says one channel, so the pre-decode estimate fits the
    // budget; the decoded buffer is 8 channels and the post-decode check must
    // still refuse it.
    stubDecodeContext(fakeBuffer(4, new Float32Array([1]), 44_100, 8));
    await expect(
      decodeWaveform("C:/a.ogg", {
        knownChannels: 1,
        knownDurationMs: 4000,
        knownSampleRate: 44_100,
        maxDecodedBytes: 1_000_000,
      }),
    ).rejects.toMatchObject({ reason: "too-large" });
  });

  it("honours an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      decodeWaveform("C:/a.ogg", {
        knownDurationMs: 1000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports a body read failure as a fetch failure", async () => {
    const stream = {
      getReader: () => ({
        cancel: () => Promise.resolve(),
        read: () => Promise.reject(new Error("stream reset")),
        releaseLock: () => undefined,
      }),
    } as unknown as ReadableStream<Uint8Array>;
    stubFetch(response({ body: stream }));
    await expect(
      decodeWaveform("C:/a.ogg", { ...KNOWN }),
    ).rejects.toBeInstanceOf(WaveformUnavailableError);
  });
});
