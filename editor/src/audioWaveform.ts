/**
 * Bounded browser waveform decoding for the per-node audio loop editor.
 *
 * The editor only needs a coarse peak envelope, so the file is decoded once
 * with `decodeAudioData` and downsampled.  Every expensive step is bounded
 * *before* it happens:
 *
 * 1. the media duration must be known up front — from the host's `duration_ms`
 *    or from a bounded metadata probe — and the channel count must be known
 *    too; the file is rejected when it is over-long or would decode to too much
 *    PCM (the estimate uses the decoder's own target sample rate),
 * 2. the body is read only as a stream, and the reader is cancelled the moment
 *    the download cap is exceeded,
 * 3. the decoded duration and PCM shape are checked again after decode.
 *
 * A file whose duration or channel count cannot be determined is never
 * downloaded or decoded automatically: compressed bytes cannot prove a decoded
 * shape, so the caller shows the honest "waveform unavailable" fallback
 * instead.  Failures reject with an explicit `WaveformUnavailableError` so
 * numeric editing, the authored loop points and the private audio audition are
 * never affected.  Decoding is asynchronous and cancellable through an
 * `AbortSignal`; the caller must also guard against stale results when the node
 * or asset changes.
 */

/** Compressed download cap: larger files are never read. */
export const MAX_WAVEFORM_BYTES = 24 * 1024 * 1024;
/** Longest media the editor will draw a waveform for. */
export const MAX_WAVEFORM_DURATION_MS = 20 * 60 * 1000;
/** Decoded float32 PCM cap used to reject a costly decode before it runs. */
const MAX_DECODED_PCM_BYTES = 256 * 1024 * 1024;
/** Bound for the `loadedmetadata` duration preflight. */
const METADATA_PROBE_TIMEOUT_MS = 3_000;
const WAVEFORM_BUCKETS = 480;

/** Decoded bytes per second of one float32 channel. */
const DECODED_BYTES_PER_SAMPLE = 4;

export interface WaveformPeaks {
  /** Decoded media duration in milliseconds. */
  durationMs: number;
  /** Normalised 0..1 amplitude, one entry per bucket. */
  peaks: number[];
}

type WaveformFailureReason =
  "decode" | "fetch" | "too-large" | "too-long" | "unsupported";

export class WaveformUnavailableError extends Error {
  readonly reason: WaveformFailureReason;

  constructor(reason: WaveformFailureReason, message: string) {
    super(message);
    this.name = "WaveformUnavailableError";
    this.reason = reason;
  }
}

interface WaveformDecodeOptions {
  buckets?: number;
  /**
   * Host `channels` metadata.  Required: a missing, non-positive or non-finite
   * count refuses the waveform instead of decoding an unknown shape.
   */
  knownChannels?: number | null;
  /** Host `duration_ms` metadata; `null`/omitted triggers the bounded preflight. */
  knownDurationMs?: number | null;
  /**
   * Host `sample_rate` metadata.  When absent or invalid the estimate uses the
   * decode context's own target rate instead.
   */
  knownSampleRate?: number | null;
  maxBytes?: number;
  maxDecodedBytes?: number;
  maxDurationMs?: number;
  probeTimeoutMs?: number;
  signal?: AbortSignal;
}

interface WaveformDecodeContext {
  close(): Promise<void>;
  decodeAudioData(audioData: ArrayBuffer): Promise<AudioBuffer>;
}

interface StreamChunk {
  done: boolean;
  value?: Uint8Array;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Float32 PCM bytes a decoded buffer of this shape occupies. */
export function estimateDecodedPcmBytes(
  durationSeconds: number,
  sampleRate: number,
  channels: number,
): number {
  if (
    !Number.isFinite(durationSeconds) ||
    !Number.isFinite(sampleRate) ||
    !Number.isFinite(channels)
  )
    return 0;
  return Math.ceil(
    Math.max(0, durationSeconds) *
      Math.max(1, sampleRate) *
      Math.max(1, channels) *
      DECODED_BYTES_PER_SAMPLE,
  );
}

function abortError(): DOMException {
  return new DOMException("aborted", "AbortError");
}

/**
 * Bounded metadata preflight: asks the browser for the media length through an
 * `<audio>` element asking only for metadata.  `preload` is a hint, not a
 * guarantee — a browser may read more of the container (or nothing at all) —
 * so the probe is always time-bounded.  Resolves `null` when the environment
 * cannot probe or the length never arrives within the bound.
 */
export function probeMediaDurationMs(
  url: string,
  signal?: AbortSignal,
  timeoutMs = METADATA_PROBE_TIMEOUT_MS,
): Promise<number | null> {
  if (signal?.aborted === true) return Promise.resolve(null);
  if (typeof Audio !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    const element = new Audio();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = (): void => {
      if (timer !== null) clearTimeout(timer);
      element.removeEventListener("loadedmetadata", onLoaded);
      element.removeEventListener("error", onFailed);
      signal?.removeEventListener("abort", onAbort);
      element.removeAttribute("src");
    };
    const finish = (value: number | null): void => {
      cleanup();
      resolve(value);
    };
    const onLoaded = (): void => {
      const duration = element.duration;
      finish(
        Number.isFinite(duration) && duration >= 0
          ? Math.round(duration * 1000)
          : null,
      );
    };
    const onFailed = (): void => finish(null);
    const onAbort = (): void => finish(null);
    element.addEventListener("loadedmetadata", onLoaded);
    element.addEventListener("error", onFailed);
    signal?.addEventListener("abort", onAbort);
    timer = setTimeout(() => finish(null), timeoutMs);
    element.preload = "metadata";
    element.src = url;
  });
}

/** Peak envelope of one channel, downsampled into `buckets` entries. */
export function downsamplePeaks(
  samples: Float32Array,
  buckets = WAVEFORM_BUCKETS,
): number[] {
  const count = Math.max(1, Math.floor(buckets));
  const peaks = new Array<number>(count).fill(0);
  if (samples.length === 0) return peaks;
  const step = samples.length / count;
  for (let bucket = 0; bucket < count; bucket += 1) {
    const start = Math.floor(bucket * step);
    const end = Math.max(
      start + 1,
      Math.min(samples.length, Math.floor((bucket + 1) * step)),
    );
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      const amplitude = Math.abs(samples[index] ?? 0);
      if (amplitude > peak) peak = amplitude;
    }
    peaks[bucket] = peak > 1 ? 1 : peak;
  }
  return peaks;
}

/**
 * Sample rate the decode context targets.  `decodeAudioData` resamples into
 * this context, so the decoded PCM never exceeds this rate — an 8 kHz source
 * still decodes to 44.1 kHz samples.
 */
const DECODE_TARGET_SAMPLE_RATE = 44_100;

function createDecodeContext(): WaveformDecodeContext {
  const offline = globalThis.OfflineAudioContext;
  if (typeof offline === "function")
    return new offline(
      1,
      1,
      DECODE_TARGET_SAMPLE_RATE,
    ) as unknown as WaveformDecodeContext;
  // The live fallback must request the same controlled rate: a device default
  // (e.g. 48 kHz) would decode more PCM than the pre-decode budget assumed.
  const live = globalThis.AudioContext;
  if (typeof live === "function")
    return new live({ sampleRate: DECODE_TARGET_SAMPLE_RATE });
  throw new WaveformUnavailableError("unsupported", "当前环境不支持音频解码");
}

/** A positive finite media shape value, or `null` when it is unusable. */
function positiveNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * Rejects a decode the known metadata already proves would be too long or too
 * expensive, before any network or decode work happens.
 *
 * The channel count is mandatory.  A metadata probe can report a duration but
 * never a channel layout, and without it the decoded PCM size is unknowable, so
 * the safe answer is the honest no-waveform fallback rather than decoding
 * blind.
 *
 * The estimate uses `max(input rate, decode target rate)`: the decoder always
 * produces `DECODE_TARGET_SAMPLE_RATE` PCM, so a low-rate source does not shrink
 * the budget.  That target rate is a real bound this component controls, not an
 * invented cap, so an absent or invalid metadata rate falls back to it instead
 * of silently allowing a decode.
 */
function guardDecodeCost(
  durationMs: number,
  sampleRate: number | null,
  channels: number | null,
  maxDurationMs: number,
  maxDecodedBytes: number,
): void {
  if (durationMs > maxDurationMs)
    throw new WaveformUnavailableError("too-long", "音频过长，未解码波形");
  const knownChannels = positiveNumber(channels);
  if (knownChannels === null)
    throw new WaveformUnavailableError(
      "unsupported",
      "声道数量未知或无效，已跳过波形解码",
    );
  const targetRate = Math.max(
    positiveNumber(sampleRate) ?? 0,
    DECODE_TARGET_SAMPLE_RATE,
  );
  const estimate = estimateDecodedPcmBytes(
    durationMs / 1000,
    targetRate,
    knownChannels,
  );
  if (estimate > maxDecodedBytes)
    throw new WaveformUnavailableError(
      "too-large",
      "音频解码所需内存过大，未解码波形",
    );
}

/**
 * Reads the response body as a stream with a hard byte cap.
 *
 * The reader is cancelled as soon as the cap is exceeded.  There is no
 * buffering fallback: a response without a readable stream is refused, so a
 * declared (or missing) `Content-Length` can never be used to justify reading
 * an unbounded body.
 */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null || typeof body.getReader !== "function")
    throw new WaveformUnavailableError(
      "unsupported",
      "当前环境不支持流式读取音频",
    );
  const reader = body.getReader();
  const read = async (): Promise<StreamChunk> => {
    try {
      return await reader.read();
    } catch (error) {
      if (signal?.aborted === true) throw abortError();
      throw new WaveformUnavailableError(
        "fetch",
        `无法读取音频：${describeError(error)}`,
      );
    }
  };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await read();
      if (chunk.done) break;
      const value = chunk.value;
      // A conforming stream always pairs `done: false` with a chunk; breaking
      // here keeps a broken polyfill from spinning forever (the decode then
      // reports a truncated file).
      if (value === undefined) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop the download the moment the cap is exceeded instead of buffering
        // the rest and failing afterwards.
        await reader.cancel().catch(() => undefined);
        throw new WaveformUnavailableError(
          "too-large",
          "音频文件过大，未解码波形",
        );
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released/cancelled; the cap error is reported above.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function decodeWaveform(
  url: string,
  options: WaveformDecodeOptions = {},
): Promise<WaveformPeaks> {
  const buckets = options.buckets ?? WAVEFORM_BUCKETS;
  const maxBytes = options.maxBytes ?? MAX_WAVEFORM_BYTES;
  const maxDurationMs = options.maxDurationMs ?? MAX_WAVEFORM_DURATION_MS;
  const maxDecodedBytes = options.maxDecodedBytes ?? MAX_DECODED_PCM_BYTES;
  const signal = options.signal;
  const aborted = (): boolean => signal?.aborted === true;
  if (aborted()) throw abortError();
  if (typeof fetch !== "function")
    throw new WaveformUnavailableError("unsupported", "当前环境不支持读取音频");

  // 1. The duration must be known before anything is downloaded or decoded:
  //    compressed bytes cannot prove a decoded duration, so an unknown length
  //    is refused instead of risking a huge decode.
  const knownDurationMs =
    options.knownDurationMs ??
    (await probeMediaDurationMs(
      url,
      signal,
      options.probeTimeoutMs ?? METADATA_PROBE_TIMEOUT_MS,
    ));
  if (aborted()) throw abortError();
  if (knownDurationMs === null)
    throw new WaveformUnavailableError(
      "unsupported",
      "无法确定素材时长，已跳过波形解码",
    );
  guardDecodeCost(
    knownDurationMs,
    options.knownSampleRate ?? null,
    options.knownChannels ?? null,
    maxDurationMs,
    maxDecodedBytes,
  );

  // 2. Bounded, cancellable download.
  let response: Response;
  try {
    response = await fetch(url, signal === undefined ? {} : { signal });
  } catch (error) {
    if (aborted()) throw abortError();
    throw new WaveformUnavailableError(
      "fetch",
      `无法读取音频：${describeError(error)}`,
    );
  }
  if (!response.ok)
    throw new WaveformUnavailableError(
      "fetch",
      `无法读取音频（HTTP ${response.status}）`,
    );
  // A declared length is only a cheap early reject; it is never trusted to
  // justify buffering, because a missing header reads as `0` and a server may
  // under-report.  The streaming cap below is the real bound.
  const declaredHeader = response.headers.get("content-length");
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  if (declared !== null && Number.isFinite(declared) && declared > maxBytes)
    throw new WaveformUnavailableError("too-large", "音频文件过大，未解码波形");
  const bytes = await readBoundedBody(response, maxBytes, signal);
  if (aborted()) throw abortError();

  // 2. Decode, then re-check the decoded shape.
  const context = createDecodeContext();
  try {
    let buffer: AudioBuffer;
    try {
      // `decodeAudioData` detaches its input; a copy keeps our bounded bytes
      // independent and narrows the ArrayBufferLike view to ArrayBuffer.
      buffer = await context.decodeAudioData(bytes.slice().buffer);
    } catch (error) {
      throw new WaveformUnavailableError(
        "decode",
        `音频解码失败：${describeError(error)}`,
      );
    }
    if (aborted()) throw abortError();
    const durationMs = Math.round(buffer.duration * 1000);
    if (durationMs > maxDurationMs)
      throw new WaveformUnavailableError("too-long", "音频过长，未解码波形");
    const decodedBytes = estimateDecodedPcmBytes(
      buffer.duration,
      buffer.sampleRate,
      buffer.numberOfChannels,
    );
    if (decodedBytes > maxDecodedBytes)
      throw new WaveformUnavailableError(
        "too-large",
        "音频解码所需内存过大，未解码波形",
      );
    return {
      durationMs,
      peaks: downsamplePeaks(buffer.getChannelData(0), buckets),
    };
  } finally {
    try {
      await context.close();
    } catch {
      // The context may already have been closed; a decode error is reported.
    }
  }
}
