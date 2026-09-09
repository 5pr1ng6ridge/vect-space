// Shared Web Audio graph used by the game and editor preview.
import type {
  AssetUrlMap,
  AudioSnapshot,
  LoopingAudioSnapshot,
  Settings,
} from "./types";
import { advanceVirtualElapsed } from "./virtualClock";

interface PlayingBgm {
  state: LoopingAudioSnapshot;
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  loopListener: () => void;
}
interface CachedBuffer {
  promise: Promise<AudioBuffer>;
  bytes: number;
  touched: number;
}
interface ActiveSfx {
  url: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
  started: number;
}
interface PlayingTypingSfx {
  url: string;
  cps: number;
  buffer: AudioBuffer;
  timer: number | null;
  sources: Set<ActiveSfx>;
}

interface BgmTransition {
  generation: number;
  controller: AbortController;
  previous: PlayingBgm | null;
  next: PlayingBgm | null;
}

export interface AudioManagerOptions {
  /**
   * Keep a silent preview from creating an AudioContext or downloading BGM
   * until the user explicitly enables sound.
   */
  deferUntilUnmuted?: boolean;
}

const MAX_SFX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_SFX_VOICES = 32;
const MAX_SFX_VOICES_PER_ASSET = 4;

export class AudioManager {
  readonly #buffers = new Map<string, CachedBuffer>();
  readonly #activeSfx: ActiveSfx[] = [];
  readonly #videoSources = new WeakMap<
    HTMLMediaElement,
    MediaElementAudioSourceNode
  >();
  readonly #videoGains = new WeakMap<HTMLMediaElement, GainNode>();
  #context: AudioContext | null = null;
  #master: GainNode | null = null;
  #bgmBus: GainNode | null = null;
  #sfxBus: GainNode | null = null;
  #videoBus: GainNode | null = null;
  #currentBgm: PlayingBgm | null = null;
  #bgmTransition: BgmTransition | null = null;
  #bgmTransitionGeneration = 0;
  #typingSfx: PlayingTypingSfx | null = null;
  #typingGeneration = 0;
  #playbackRate = 1;
  #paused = false;
  #settings: Settings;
  readonly #deferUntilUnmuted: boolean;
  #deferredBgm: {
    target: LoopingAudioSnapshot | null;
    assets: AssetUrlMap;
  } | null = null;

  constructor(settings: Settings, options: AudioManagerOptions = {}) {
    this.#settings = settings;
    this.#deferUntilUnmuted = options.deferUntilUnmuted === true;
  }

  async unlock(): Promise<void> {
    const context = this.#ensureContext();
    if (!this.#paused && context.state === "suspended") await context.resume();
    if (this.#currentBgm !== null && this.#currentBgm.element.paused) {
      await this.#currentBgm.element.play().catch(() => undefined);
    }
    if (this.#typingSfx !== null) this.#playTypingTick(this.#typingSfx);
  }

  async setPaused(paused: boolean): Promise<void> {
    this.#paused = paused;
    if (this.#context === null) return;
    if (paused) {
      await this.#context.suspend();
      this.#currentBgm?.element.pause();
    } else {
      await this.#context.resume();
      await this.#currentBgm?.element.play().catch(() => undefined);
    }
  }

  applySettings(settings: Settings): void {
    this.#settings = settings;
    if (this.#context === null) return;
    const now = this.#context.currentTime;
    this.#master?.gain.setValueAtTime(settings.master_volume, now);
    this.#bgmBus?.gain.setValueAtTime(settings.bgm_volume, now);
    this.#sfxBus?.gain.setValueAtTime(settings.sfx_volume, now);
    this.#videoBus?.gain.setValueAtTime(settings.video_volume, now);
  }

  setPlaybackRate(rate: number): void {
    this.#playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  }

  setBgmTimelineVolume(volume: number): void {
    if (this.#currentBgm !== null) setGain(this.#currentBgm.gain, volume);
  }

  currentBgmVolume(): number | undefined {
    return this.#currentBgm?.gain.gain.value;
  }

  attachVideo(element: HTMLVideoElement, volume: number): void {
    const context = this.#ensureContext();
    let source = this.#videoSources.get(element);
    if (source === undefined) {
      source = context.createMediaElementSource(element);
      this.#videoSources.set(element, source);
    }
    let gain = this.#videoGains.get(element);
    if (gain === undefined) {
      gain = context.createGain();
      source.connect(gain).connect(this.#videoBus as GainNode);
      this.#videoGains.set(element, gain);
    }
    setGain(gain, volume);
  }

  setVideoVolume(element: HTMLVideoElement, volume: number): void {
    const gain = this.#videoGains.get(element);
    if (gain !== undefined) setGain(gain, volume);
  }

  async playSfx(
    asset: string,
    volume: number,
    assets: AssetUrlMap,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = requireAssetUrl(assets, asset);
    const context = this.#ensureContext();
    const buffer = await this.#load(url);
    // Loading an SFX is asynchronous.  A presentation can be interrupted
    // while the buffer is decoding (for example by loading a save or
    // switching the editor preview target); never start a stale voice after
    // that boundary.
    if (signal?.aborted) return;
    this.#enforcePolyphony(url);
    const source = context.createBufferSource();
    const gain = context.createGain();
    const voice: ActiveSfx = { url, source, gain, started: performance.now() };
    source.buffer = buffer;
    gain.gain.value = volume;
    source.connect(gain).connect(this.#sfxBus as GainNode);
    this.#activeSfx.push(voice);
    const abort = (): void => {
      signal?.removeEventListener("abort", abort);
      this.#stopVoice(voice);
    };
    signal?.addEventListener("abort", abort, { once: true });
    source.addEventListener(
      "ended",
      () => {
        signal?.removeEventListener("abort", abort);
        this.#removeVoice(voice);
      },
      { once: true },
    );
    if (signal?.aborted) {
      signal.removeEventListener("abort", abort);
      this.#stopVoice(voice);
      return;
    }
    source.start();
  }

  async setTypingSfx(
    active: boolean,
    assets: AssetUrlMap,
    cps: number,
  ): Promise<void> {
    const generation = ++this.#typingGeneration;
    if (!active) {
      this.#stopTypingSfx();
      return;
    }
    const url = requireAssetUrl(assets, "sfx.typing");
    const safeCps = normalizeCps(cps);
    if (this.#typingSfx?.url === url && this.#typingSfx.cps === safeCps) return;
    this.#stopTypingSfx();
    const buffer = await this.#load(url);
    if (generation !== this.#typingGeneration) return;
    const session: PlayingTypingSfx = {
      url,
      cps: safeCps,
      buffer,
      timer: null,
      sources: new Set(),
    };
    this.#typingSfx = session;
    this.#playTypingTick(session);
    session.timer = window.setInterval(
      () => this.#playTypingTick(session),
      1_000 / safeCps,
    );
  }

  async transitionBgm(
    target: LoopingAudioSnapshot | null,
    durationMs: number,
    assets: AssetUrlMap,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;
    this.#invalidateBgmTransition();
    const transition: BgmTransition = {
      generation: ++this.#bgmTransitionGeneration,
      controller: new AbortController(),
      previous: this.#currentBgm,
      next: null,
    };
    this.#bgmTransition = transition;
    const relayAbort = (): void => transition.controller.abort();
    signal?.addEventListener("abort", relayAbort, { once: true });
    const isCurrent = (): boolean =>
      this.#bgmTransition === transition &&
      transition.generation === this.#bgmTransitionGeneration &&
      !transition.controller.signal.aborted;
    let committed = false;
    try {
      const previous = transition.previous;
      if (target === null && previous === null) return;
      if (target !== null && previous?.state.asset === target.asset) {
        const from = previous.gain.gain.value;
        await dynamicFade(
          durationMs,
          () => (this.#paused ? 0 : this.#playbackRate),
          (progress) =>
            setGain(previous.gain, from + (target.volume - from) * progress),
          transition.controller.signal,
        );
        if (!isCurrent()) return;
        previous.state = { ...target };
        previous.element.loop = target.loop_end_ms == null;
        return;
      }

      if (target !== null) {
        const next = this.#createBgm(
          target,
          requireAssetUrl(assets, target.asset),
        );
        transition.next = next;
        setGain(next.gain, durationMs > 0 ? 0 : target.volume);
        await playBgm(next.element, transition.controller.signal);
        if (!isCurrent()) return;
      }

      const next = transition.next;
      const previousVolume = previous?.gain.gain.value ?? 0;
      await dynamicFade(
        durationMs,
        () => (this.#paused ? 0 : this.#playbackRate),
        (progress) => {
          if (next !== null && target !== null)
            setGain(next.gain, target.volume * progress);
          if (previous !== null)
            setGain(previous.gain, previousVolume * (1 - progress));
        },
        transition.controller.signal,
      );
      if (!isCurrent()) return;
      if (previous !== null) this.#destroyBgm(previous);
      this.#currentBgm = next;
      transition.next = null;
      committed = true;
    } finally {
      signal?.removeEventListener("abort", relayAbort);
      if (this.#bgmTransition === transition) this.#bgmTransition = null;
      // A cancelled transition owns its newly-created element.  The active
      // BGM is deliberately left intact so a later snapshot can reconcile it.
      if (!committed && transition.next !== null) {
        if (transition.next !== this.#currentBgm)
          this.#destroyBgm(transition.next);
        transition.next = null;
      }
    }
  }

  async reconcile(
    snapshot: AudioSnapshot,
    assets: AssetUrlMap,
    signal?: AbortSignal,
  ): Promise<void> {
    // A timeline preview starts muted. Remember only the latest desired BGM
    // while no graph exists; do not create Web Audio or fetch an audio file
    // merely to keep a silent canvas in sync.
    if (
      this.#deferUntilUnmuted &&
      this.#context === null &&
      this.#settings.master_volume <= 0
    ) {
      this.#deferredBgm = {
        target: snapshot.bgm === null ? null : { ...snapshot.bgm },
        assets: { ...assets },
      };
      return;
    }
    this.#deferredBgm = null;
    await this.transitionBgm(snapshot.bgm, 0, assets, signal);
  }

  /** Start the latest deferred preview audio after an explicit user gesture. */
  async activateDeferred(signal?: AbortSignal): Promise<void> {
    const deferred = this.#deferredBgm;
    this.#deferredBgm = null;
    if (deferred === null || signal?.aborted) return;
    await this.transitionBgm(deferred.target, 0, deferred.assets, signal);
  }

  /**
   * Stop all media owned by the current presentation session while keeping
   * the AudioContext and decoded buffer cache reusable for the next scene.
   * This is intentionally different from `destroy()`: title/replay
   * boundaries should be cheap, but must not leave a fading BGM, typing loop,
   * SFX voice, or deferred transition alive behind the new page.
   */
  resetSession(): void {
    this.#invalidateBgmTransition();
    this.#typingGeneration += 1;
    this.#stopTypingSfx();
    for (const voice of [...this.#activeSfx]) this.#stopVoice(voice);
    if (this.#currentBgm !== null) this.#destroyBgm(this.#currentBgm);
    this.#currentBgm = null;
    this.#deferredBgm = null;
  }

  destroy(): void {
    this.resetSession();
    if (this.#context !== null) void this.#context.close();
    this.#context = null;
    this.#buffers.clear();
    this.#deferredBgm = null;
  }

  #invalidateBgmTransition(): void {
    this.#bgmTransitionGeneration += 1;
    const transition = this.#bgmTransition;
    this.#bgmTransition = null;
    if (transition === null) return;
    transition.controller.abort();
    if (transition.next !== null && transition.next !== this.#currentBgm) {
      this.#destroyBgm(transition.next);
      transition.next = null;
    }
  }

  #ensureContext(): AudioContext {
    if (this.#context !== null) return this.#context;
    const context = new AudioContext({ latencyHint: "interactive" });
    const master = context.createGain();
    const bgm = context.createGain();
    const sfx = context.createGain();
    const video = context.createGain();
    bgm.connect(master);
    sfx.connect(master);
    video.connect(master);
    master.connect(context.destination);
    this.#context = context;
    this.#master = master;
    this.#bgmBus = bgm;
    this.#sfxBus = sfx;
    this.#videoBus = video;
    this.applySettings(this.#settings);
    return context;
  }

  #createBgm(state: LoopingAudioSnapshot, url: string): PlayingBgm {
    const context = this.#ensureContext();
    const element = new Audio(url);
    element.preload = "auto";
    element.crossOrigin = "anonymous";
    element.loop = state.loop_end_ms == null;
    const source = context.createMediaElementSource(element);
    const gain = context.createGain();
    source.connect(gain).connect(this.#bgmBus as GainNode);
    const playing: PlayingBgm = {
      state: { ...state },
      element,
      source,
      gain,
      loopListener: () => undefined,
    };
    const loopListener = (): void => {
      const loopStart = (playing.state.loop_start_ms ?? 0) / 1_000;
      const loopEnd =
        playing.state.loop_end_ms == null
          ? element.duration
          : playing.state.loop_end_ms / 1_000;
      if (Number.isFinite(loopEnd) && element.currentTime >= loopEnd - 0.025)
        element.currentTime = loopStart;
    };
    element.addEventListener("timeupdate", loopListener);
    element.addEventListener(
      "loadedmetadata",
      () => {
        element.currentTime = state.start_ms / 1_000;
      },
      { once: true },
    );
    playing.loopListener = loopListener;
    return playing;
  }

  #destroyBgm(bgm: PlayingBgm): void {
    bgm.element.pause();
    bgm.element.removeEventListener("timeupdate", bgm.loopListener);
    bgm.element.removeAttribute("src");
    bgm.element.load();
    bgm.source.disconnect();
    bgm.gain.disconnect();
  }

  #stopTypingSfx(): void {
    const session = this.#typingSfx;
    if (session === null) return;
    if (session.timer !== null) window.clearInterval(session.timer);
    for (const voice of session.sources) this.#stopVoice(voice);
    session.sources.clear();
    this.#typingSfx = null;
  }

  #playTypingTick(session: PlayingTypingSfx): void {
    const context = this.#context;
    if (
      context === null ||
      context.state !== "running" ||
      this.#typingSfx !== session
    )
      return;
    this.#enforcePolyphony(session.url);
    const source = context.createBufferSource();
    const gain = context.createGain();
    const voice: ActiveSfx = {
      url: session.url,
      source,
      gain,
      started: performance.now(),
    };
    source.buffer = session.buffer;
    gain.gain.value = 0.25;
    source.connect(gain).connect(this.#sfxBus as GainNode);
    this.#activeSfx.push(voice);
    session.sources.add(voice);
    source.addEventListener(
      "ended",
      () => {
        session.sources.delete(voice);
        this.#removeVoice(voice);
      },
      { once: true },
    );
    source.start();
  }

  #enforcePolyphony(url: string): void {
    while (this.#activeSfx.length >= MAX_SFX_VOICES) {
      const oldest = firstItem(this.#activeSfx);
      if (oldest === undefined) break;
      this.#stopVoice(oldest);
    }
    const same = this.#activeSfx
      .filter((voice) => voice.url === url)
      .sort((a, b) => a.started - b.started);
    const oldestSame = firstItem(same);
    if (same.length >= MAX_SFX_VOICES_PER_ASSET && oldestSame !== undefined)
      this.#stopVoice(oldestSame);
  }
  #stopVoice(voice: ActiveSfx): void {
    try {
      voice.source.stop();
    } catch {
      /* idempotent */
    }
    this.#removeVoice(voice);
  }
  #removeVoice(voice: ActiveSfx): void {
    const index = this.#activeSfx.indexOf(voice);
    if (index >= 0) this.#activeSfx.splice(index, 1);
    voice.source.disconnect();
    voice.gain.disconnect();
  }

  #load(url: string): Promise<AudioBuffer> {
    const cached = this.#buffers.get(url);
    if (cached !== undefined) {
      cached.touched = performance.now();
      return cached.promise;
    }
    const context = this.#ensureContext();
    const entry: CachedBuffer = {
      bytes: 0,
      touched: performance.now(),
      promise: fetch(url)
        .then(async (response) => {
          if (!response.ok)
            throw new Error(`音频读取失败 (${response.status}): ${url}`);
          return response.arrayBuffer();
        })
        .then((data) => context.decodeAudioData(data))
        .then((buffer) => {
          entry.bytes = buffer.length * buffer.numberOfChannels * 4;
          this.#evictBuffers(url);
          return buffer;
        }),
    };
    this.#buffers.set(url, entry);
    entry.promise.catch(() => this.#buffers.delete(url));
    return entry.promise;
  }
  #evictBuffers(protectedUrl: string): void {
    let total = [...this.#buffers.values()].reduce(
      (sum, value) => sum + value.bytes,
      0,
    );
    const candidates = [...this.#buffers.entries()]
      .filter(([url]) => url !== protectedUrl)
      .sort(([, a], [, b]) => a.touched - b.touched);
    for (const [url, value] of candidates) {
      if (total <= MAX_SFX_CACHE_BYTES) break;
      this.#buffers.delete(url);
      total -= value.bytes;
    }
  }
}

function requireAssetUrl(assets: AssetUrlMap, id: string): string {
  const url = assets[id];
  if (url === undefined) throw new Error(`表现层找不到素材 URL: ${id}`);
  return url;
}
function setGain(node: GainNode, value: number): void {
  node.gain.setValueAtTime(
    Math.max(0, Math.min(1, value)),
    node.context.currentTime,
  );
}
function normalizeCps(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 30;
}
function firstItem<T>(values: readonly T[]): T | undefined {
  for (const value of values) return value;
  return undefined;
}
function dynamicFade(
  durationMs: number,
  getRate: () => number,
  apply: (progress: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (durationMs <= 0 || signal?.aborted) {
    if (!signal?.aborted) apply(1);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let previous = performance.now();
    let elapsed = 0;
    let frame = 0;
    let settled = false;
    const abort = (): void => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frame);
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const tick = (now: number): void => {
      if (settled || signal?.aborted) return;
      const rate = getRate();
      if (rate > 0) {
        elapsed = advanceVirtualElapsed(
          elapsed,
          now - previous,
          rate,
          durationMs,
        );
      }
      previous = now;
      const progress = Math.min(1, elapsed / durationMs);
      apply(progress);
      if (progress >= 1) {
        settled = true;
        signal?.removeEventListener("abort", abort);
        resolve();
      } else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  });
}

function playBgm(
  element: HTMLAudioElement,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    try {
      void element.play().then(finish, finish);
    } catch {
      finish();
    }
  });
}
