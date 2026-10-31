// Shared Web Audio graph used by the game and editor preview.
import type {
  AmbienceSlot,
  AmbienceSnapshot,
  AssetUrlMap,
  AudioSnapshot,
  LoopingAudioSnapshot,
  Settings,
} from "./types";
import { dynamicFade, playAmbience, playBgm, setGain } from "./audioPlayback";

interface PlayingLoop {
  state: LoopingAudioSnapshot;
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  loopListener: () => void;
  metadataListener: () => void;
  endedListener: () => void;
}
type PlayingBgm = PlayingLoop;
type PlayingAmbience = PlayingLoop;
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

interface AmbienceTransition {
  slot: AmbienceSlot;
  generation: number;
  controller: AbortController;
  previous: PlayingAmbience | null;
  next: PlayingAmbience | null;
}

interface DeferredAudio {
  generation: number;
  ownerSignal?: AbortSignal;
  snapshot: AudioSnapshot;
  assets: AssetUrlMap;
  cleanup(): void;
}

interface LoopPlayAttempt {
  generation: number;
  lifecycleGeneration: number;
  controller: AbortController;
  loop: PlayingLoop;
  promise: Promise<void>;
}

export interface AudioManagerOptions {
  /**
   * Keep a silent preview from creating an AudioContext or media resources
   * until the user explicitly enables sound.
   */
  deferUntilUnmuted?: boolean;
}

/**
 * Read-only state for one manager-owned looping transport.
 *
 * The element itself is deliberately not exposed: hosts and diagnostics can
 * inspect phase/lifecycle state without gaining a second owner that could
 * seek, pause or release the transport behind AudioManager's back.
 */
export interface AudioLoopDiagnostics {
  asset: string;
  volume: number;
  current_time: number;
  paused: boolean;
  start_ms: number;
  loop_start_ms: number | null;
  loop_end_ms: number | null;
}

/** Shared, host-neutral audio diagnostics used by game, editor and parity. */
export interface AudioDiagnostics {
  context_state: AudioContextState | null;
  buses: {
    master: number | null;
    bgm: number | null;
    sfx: number | null;
    video: number | null;
    ambience: number | null;
  };
  bgm: AudioLoopDiagnostics | null;
  ambience: Record<AmbienceSlot, AudioLoopDiagnostics | null>;
}

const MAX_SFX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_SFX_VOICES = 32;
const MAX_SFX_VOICES_PER_ASSET = 4;
const AMBIENCE_VOLUME_DEFAULT = 0.8;
const AMBIENCE_SLOTS: readonly AmbienceSlot[] = [
  "slot_1",
  "slot_2",
  "slot_3",
  "slot_4",
];

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
  #ambienceBus: GainNode | null = null;
  #currentBgm: PlayingBgm | null = null;
  #ambienceSlots: Record<AmbienceSlot, PlayingAmbience | null> = {
    slot_1: null,
    slot_2: null,
    slot_3: null,
    slot_4: null,
  };
  #bgmTransition: BgmTransition | null = null;
  #bgmTransitionGeneration = 0;
  #ambienceTransitions: Record<AmbienceSlot, AmbienceTransition | null> = {
    slot_1: null,
    slot_2: null,
    slot_3: null,
    slot_4: null,
  };
  #ambienceTransitionGenerations: Record<AmbienceSlot, number> = {
    slot_1: 0,
    slot_2: 0,
    slot_3: 0,
    slot_4: 0,
  };
  #typingSfx: PlayingTypingSfx | null = null;
  #typingGeneration = 0;
  #playbackRate = 1;
  #paused = false;
  #settings: Settings;
  readonly #deferUntilUnmuted: boolean;
  #deferredAudio: DeferredAudio | null = null;
  #deferredGeneration = 0;
  #deferredActivationGeneration = 0;
  /** Invalidates activation callers across reset/destroy boundaries. */
  #managerLifecycleGeneration = 0;
  /** Serializes concurrent user-gesture activation calls. */
  #deferredActivationPromise: Promise<void> | null = null;
  #loopLifecycleGeneration = 0;
  readonly #loopPlayGenerations = new WeakMap<HTMLAudioElement, number>();
  readonly #pendingLoopPlays = new WeakMap<HTMLAudioElement, LoopPlayAttempt>();

  constructor(settings: Settings, options: AudioManagerOptions = {}) {
    this.#settings = settings;
    this.#deferUntilUnmuted = options.deferUntilUnmuted === true;
  }

  async unlock(): Promise<void> {
    // `unlock` is an explicit user-gesture boundary.  A muted preview normally
    // activates through `activateDeferred`, but accepting unlock here keeps the
    // public audio port useful for hosts that use the gesture directly.
    if (this.#deferredAudio !== null) {
      await this.activateDeferred();
      return;
    }
    const context = this.#ensureContext();
    if (!this.#paused && context.state === "suspended") await context.resume();
    if (!this.#paused) {
      await Promise.all(
        this.#loopTracks()
          .filter((track) => track.element.paused)
          .map((track) =>
            this.#startLoop(
              track,
              undefined,
              this.#isAmbienceLoop(track),
            ).catch(() => undefined),
          ),
      );
      if (this.#typingSfx !== null) this.#playTypingTick(this.#typingSfx);
    }
  }

  async setPaused(paused: boolean): Promise<void> {
    this.#paused = paused;
    if (paused) this.#invalidateLoopLifecycle();
    if (this.#context === null) return;
    if (paused) {
      await this.#context.suspend();
      if (!this.#paused) return;
      for (const track of this.#loopTracks()) track.element.pause();
    } else {
      await this.#context.resume();
      if (this.#paused) return;
      await Promise.all(
        this.#loopTracks()
          .filter((track) => track.element.paused)
          .map((track) =>
            this.#startLoop(
              track,
              undefined,
              this.#isAmbienceLoop(track),
            ).catch(() => undefined),
          ),
      );
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
    this.#ambienceBus?.gain.setValueAtTime(
      settings.ambience_volume ?? AMBIENCE_VOLUME_DEFAULT,
      now,
    );
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

  setAmbienceTimelineVolume(slot: AmbienceSlot, volume: number): void {
    const track = this.#ambienceSlots[slot];
    if (track !== null) setGain(track.gain, volume);
  }

  currentAmbienceVolume(slot: AmbienceSlot): number | undefined {
    return this.#ambienceSlots[slot]?.gain.gain.value;
  }

  /**
   * Returns a defensive snapshot of the shared graph. This is intentionally a
   * read-only seam: callers cannot mutate media, gain nodes or lifecycle
   * ownership through the returned value.
   */
  get diagnostics(): AudioDiagnostics {
    const ambience = {} as Record<AmbienceSlot, AudioLoopDiagnostics | null>;
    for (const slot of AMBIENCE_SLOTS) {
      ambience[slot] = describeLoop(this.#ambienceSlots[slot]);
    }
    return {
      context_state: this.#context?.state ?? null,
      buses: {
        master: gainValue(this.#master),
        bgm: gainValue(this.#bgmBus),
        sfx: gainValue(this.#sfxBus),
        video: gainValue(this.#videoBus),
        ambience: gainValue(this.#ambienceBus),
      },
      bgm: describeLoop(this.#currentBgm),
      ambience,
    };
  }

  /** Explicit method alias for hosts that prefer function-style seams. */
  readDiagnostics(): AudioDiagnostics {
    return this.diagnostics;
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
    deferredActivationGeneration?: number,
  ): Promise<void> {
    if (deferredActivationGeneration === undefined)
      this.#deferredActivationGeneration += 1;
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
        if (!this.#paused)
          await this.#startLoop(next, transition.controller.signal, false);
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

  async transitionAmbience(
    slot: AmbienceSlot,
    target: LoopingAudioSnapshot | null,
    durationMs: number,
    assets: AssetUrlMap,
    signal?: AbortSignal,
    deferredActivationGeneration?: number,
  ): Promise<void> {
    if (deferredActivationGeneration === undefined)
      this.#deferredActivationGeneration += 1;
    if (signal?.aborted) return;
    this.#invalidateAmbienceTransition(slot);
    const transition: AmbienceTransition = {
      slot,
      generation: ++this.#ambienceTransitionGenerations[slot],
      controller: new AbortController(),
      previous: this.#ambienceSlots[slot],
      next: null,
    };
    this.#ambienceTransitions[slot] = transition;
    const relayAbort = (): void => transition.controller.abort();
    signal?.addEventListener("abort", relayAbort, { once: true });
    const isCurrent = (): boolean =>
      this.#ambienceTransitions[slot] === transition &&
      transition.generation === this.#ambienceTransitionGenerations[slot] &&
      !transition.controller.signal.aborted;
    let committed = false;
    const previous = transition.previous;
    const previousVolume = previous?.gain.gain.value;
    try {
      if (target === null && previous === null) return;
      // Reusing a media element for the same asset is important: a timeline or
      // snapshot update changes authored gain/loop metadata, not the audible
      // phase.  In particular, do not seek to target.start_ms here.
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
        committed = true;
        return;
      }

      if (target !== null) {
        const next = this.#createAmbience(
          target,
          requireAssetUrl(assets, target.asset),
        );
        transition.next = next;
        setGain(next.gain, durationMs > 0 ? 0 : target.volume);
        if (!this.#paused)
          await this.#startLoop(next, transition.controller.signal, true);
        if (!isCurrent()) return;
      }

      const next = transition.next;
      await dynamicFade(
        durationMs,
        () => (this.#paused ? 0 : this.#playbackRate),
        (progress) => {
          if (next !== null && target !== null)
            setGain(next.gain, target.volume * progress);
          if (previous !== null)
            setGain(previous.gain, (previousVolume ?? 0) * (1 - progress));
        },
        transition.controller.signal,
      );
      if (!isCurrent()) return;
      if (previous !== null) this.#destroyAmbience(previous);
      this.#ambienceSlots[slot] = next;
      transition.next = null;
      committed = true;
    } finally {
      signal?.removeEventListener("abort", relayAbort);
      const ownsTransition = this.#ambienceTransitions[slot] === transition;
      if (ownsTransition) this.#ambienceTransitions[slot] = null;
      // A superseded transition owns its new element.  Keep the previous
      // element active so the latest request can cross-fade from its phase.
      // If an external abort owns the slot, roll back any partial fade; a
      // newer same-slot request will immediately establish its own starting
      // gain and must not be overwritten by this stale callback.
      if (
        !committed &&
        ownsTransition &&
        previous !== null &&
        previousVolume !== undefined
      )
        setGain(previous.gain, previousVolume);
      if (!committed && transition.next !== null) {
        if (transition.next !== this.#ambienceSlots[slot])
          this.#destroyAmbience(transition.next);
        transition.next = null;
      }
    }
  }

  async reconcile(
    snapshot: AudioSnapshot,
    assets: AssetUrlMap,
    signal?: AbortSignal,
  ): Promise<void> {
    // A timeline preview starts muted. Remember the latest desired state for
    // every bus/slot while no graph exists; do not create Web Audio, media
    // elements, or downloads merely to keep a silent canvas in sync.
    const deferredAtStart = this.#deferredAudio;
    if (signal?.aborted) {
      this.#clearDeferredForSignal(signal);
      return;
    }
    if (
      this.#deferUntilUnmuted &&
      this.#context === null &&
      this.#settings.master_volume <= 0
    ) {
      this.#storeDeferredAudio(snapshot, assets, signal);
      return;
    }
    // An active reconcile supersedes any deferred activation attempt. Only
    // clear the generation this call observed; an older callback must not
    // erase a replacement's desired state.
    this.#deferredActivationGeneration += 1;
    if (deferredAtStart === this.#deferredAudio)
      this.#clearDeferredAudio(deferredAtStart?.generation);
    await this.#reconcileActive(snapshot, assets, signal);
  }

  /** Start the latest deferred preview audio after an explicit user gesture. */
  async activateDeferred(signal?: AbortSignal): Promise<void> {
    const lifecycleGeneration = this.#managerLifecycleGeneration;
    // Concurrent gestures share the current activation, but a caller that
    // arrives while it is in flight must not mistake an aborted/stale attempt
    // for a successful activation. Once the older attempt settles, retry the
    // latest still-owned deferred target unless this caller was cancelled.
    while (true) {
      if (lifecycleGeneration !== this.#managerLifecycleGeneration) return;
      const inFlight = this.#deferredActivationPromise;
      if (inFlight !== null) {
        try {
          await inFlight;
        } catch {
          // The waiting caller still owns the gesture. A failed activation can
          // leave its deferred target intact, so let this caller retry it.
        }
        if (
          signal?.aborted ||
          lifecycleGeneration !== this.#managerLifecycleGeneration
        ) {
          if (signal?.aborted) this.#clearDeferredForSignal(signal);
          return;
        }
        continue;
      }
      const activation = this.#activateDeferred(signal, lifecycleGeneration);
      this.#deferredActivationPromise = activation;
      try {
        await activation;
      } finally {
        if (this.#deferredActivationPromise === activation)
          this.#deferredActivationPromise = null;
      }
      return;
    }
  }

  async #activateDeferred(
    signal: AbortSignal | undefined,
    lifecycleGeneration: number,
  ): Promise<void> {
    const activationGeneration = ++this.#deferredActivationGeneration;
    if (
      signal?.aborted ||
      lifecycleGeneration !== this.#managerLifecycleGeneration
    ) {
      if (signal !== undefined) this.#clearDeferredForSignal(signal);
      return;
    }
    const deferred = this.#deferredAudio;
    if (deferred === null) return;
    const deferredGeneration = deferred.generation;
    // The first explicit gesture may arrive while the browser-created context
    // is suspended. Resume that one context before starting media; activation
    // is deliberately serialized above so concurrent gestures cannot create
    // duplicate transports while this await is pending.
    const context = this.#ensureContext();
    if (!this.#paused && context.state === "suspended") await context.resume();
    // Reset/destroy, a newer activation, or a newer deferred owner may have
    // won while resume was pending. Recheck all ownership before reconciling:
    // stale continuations must not create a media element after cleanup.
    if (
      signal?.aborted ||
      lifecycleGeneration !== this.#managerLifecycleGeneration ||
      activationGeneration !== this.#deferredActivationGeneration ||
      this.#deferredAudio !== deferred ||
      this.#deferredAudio?.generation !== deferredGeneration
    )
      return;
    // Keep the desired snapshot installed until every current-generation
    // transition has reconciled. A remute/abort can cancel media.play() after
    // the context exists; retaining this owner lets the next unmute retry it.
    await this.#reconcileActive(
      deferred.snapshot,
      deferred.assets,
      signal,
      activationGeneration,
    );
    if (
      signal?.aborted ||
      lifecycleGeneration !== this.#managerLifecycleGeneration ||
      activationGeneration !== this.#deferredActivationGeneration ||
      this.#deferredAudio !== deferred ||
      this.#deferredAudio?.generation !== deferredGeneration
    )
      return;
    this.#clearDeferredAudio(deferredGeneration);
  }

  /**
   * Stop all media owned by the current presentation session while keeping
   * the AudioContext and decoded buffer cache reusable for the next scene.
   * This is intentionally different from `destroy()`: title/replay
   * boundaries should be cheap, but must not leave a fading BGM, typing loop,
   * SFX voice, or deferred transition alive behind the new page.
   */
  resetSession(): void {
    this.#managerLifecycleGeneration += 1;
    this.#deferredActivationGeneration += 1;
    this.#deferredActivationPromise = null;
    this.#invalidateLoopLifecycle();
    this.#invalidateBgmTransition();
    for (const slot of AMBIENCE_SLOTS) {
      this.#invalidateAmbienceTransition(slot);
      const track = this.#ambienceSlots[slot];
      if (track !== null) this.#destroyAmbience(track);
      this.#ambienceSlots[slot] = null;
    }
    this.#typingGeneration += 1;
    this.#stopTypingSfx();
    for (const voice of [...this.#activeSfx]) this.#stopVoice(voice);
    if (this.#currentBgm !== null) this.#destroyBgm(this.#currentBgm);
    this.#currentBgm = null;
    this.#clearDeferredAudio();
  }

  destroy(): void {
    this.resetSession();
    if (this.#context !== null) void this.#context.close();
    this.#context = null;
    this.#master = null;
    this.#bgmBus = null;
    this.#sfxBus = null;
    this.#videoBus = null;
    this.#ambienceBus = null;
    this.#buffers.clear();
    this.#clearDeferredAudio();
  }

  #reconcileActive(
    snapshot: AudioSnapshot,
    assets: AssetUrlMap,
    signal?: AbortSignal,
    deferredActivationGeneration?: number,
  ): Promise<void> {
    const targets: Array<Promise<void>> = [
      this.transitionBgm(
        snapshot.bgm,
        0,
        assets,
        signal,
        deferredActivationGeneration,
      ),
    ];
    for (const slot of AMBIENCE_SLOTS) {
      targets.push(
        this.transitionAmbience(
          slot,
          snapshot.ambience?.[slot] ?? null,
          0,
          assets,
          signal,
          deferredActivationGeneration,
        ),
      );
    }
    return Promise.allSettled(targets).then((results) => {
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure !== undefined) throw failure.reason;
    });
  }

  #storeDeferredAudio(
    snapshot: AudioSnapshot,
    assets: AssetUrlMap,
    signal?: AbortSignal,
  ): void {
    // A newly stored desired state supersedes an activation currently trying
    // to realize an older one, even if that older operation settles later.
    this.#deferredActivationGeneration += 1;
    this.#clearDeferredAudio();
    if (signal?.aborted) return;
    const generation = ++this.#deferredGeneration;
    let deferred!: DeferredAudio;
    const onAbort = (): void => {
      if (this.#deferredAudio?.generation === generation) {
        this.#deferredActivationGeneration += 1;
        this.#clearDeferredAudio(generation);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    deferred = {
      generation,
      ...(signal === undefined ? {} : { ownerSignal: signal }),
      snapshot: cloneAudioSnapshot(snapshot),
      assets: { ...assets },
      cleanup: () => signal?.removeEventListener("abort", onAbort),
    };
    this.#deferredAudio = deferred;
  }

  #clearDeferredForSignal(signal: AbortSignal): void {
    const deferred = this.#deferredAudio;
    if (deferred?.ownerSignal === signal) {
      this.#deferredActivationGeneration += 1;
      this.#clearDeferredAudio(deferred.generation);
    }
  }

  #clearDeferredAudio(generation?: number): void {
    const deferred = this.#deferredAudio;
    if (
      deferred === null ||
      (generation !== undefined && deferred.generation !== generation)
    )
      return;
    this.#deferredAudio = null;
    deferred.cleanup();
  }

  #invalidateLoopLifecycle(): void {
    this.#loopLifecycleGeneration += 1;
    for (const track of this.#loopTracks()) this.#cancelLoopPlay(track);
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

  #invalidateAmbienceTransition(slot: AmbienceSlot): void {
    this.#ambienceTransitionGenerations[slot] += 1;
    const transition = this.#ambienceTransitions[slot];
    this.#ambienceTransitions[slot] = null;
    if (transition === null) return;
    transition.controller.abort();
    if (
      transition.next !== null &&
      transition.next !== this.#ambienceSlots[slot]
    ) {
      this.#destroyAmbience(transition.next);
      transition.next = null;
    }
  }

  /** Every committed track and pending replacement that must follow pause. */
  #loopTracks(): PlayingLoop[] {
    const tracks: PlayingLoop[] = [];
    const seen = new Set<HTMLAudioElement>();
    const add = (track: PlayingLoop | null | undefined): void => {
      if (track === null || track === undefined || seen.has(track.element))
        return;
      seen.add(track.element);
      tracks.push(track);
    };
    add(this.#currentBgm);
    const bgmTransition = this.#bgmTransition;
    if (bgmTransition !== null && !bgmTransition.controller.signal.aborted)
      add(bgmTransition.next);
    for (const slot of AMBIENCE_SLOTS) {
      add(this.#ambienceSlots[slot]);
      const transition = this.#ambienceTransitions[slot];
      if (transition !== null && !transition.controller.signal.aborted)
        add(transition.next);
    }
    return tracks;
  }

  #isAmbienceLoop(loop: PlayingLoop): boolean {
    for (const slot of AMBIENCE_SLOTS) {
      if (
        this.#ambienceSlots[slot] === loop ||
        this.#ambienceTransitions[slot]?.next === loop
      )
        return true;
    }
    return false;
  }

  /** True while the manager still owns a committed or pending transport. */
  #isLoopOwned(loop: PlayingLoop): boolean {
    if (this.#currentBgm === loop) return true;
    const bgmTransition = this.#bgmTransition;
    if (
      bgmTransition?.next === loop &&
      !bgmTransition.controller.signal.aborted
    )
      return true;
    for (const slot of AMBIENCE_SLOTS) {
      if (this.#ambienceSlots[slot] === loop) return true;
      const transition = this.#ambienceTransitions[slot];
      if (transition?.next === loop && !transition.controller.signal.aborted)
        return true;
    }
    return false;
  }

  #isLoopElementOwned(element: HTMLAudioElement): boolean {
    return this.#loopTracks().some((track) => track.element === element);
  }

  /**
   * Starts one manager-owned media play attempt.
   *
   * The browser promise may settle long after a transition was replaced or a
   * session was reset.  The attempt therefore has both a per-element
   * generation and a manager lifecycle generation; a late success can only
   * remain audible when it still owns the current transport and the manager is
   * globally unpaused.  The attempt signal is distinct from the caller's
   * signal so manager teardown can invalidate the native play promise too.
   */
  #startLoop(
    loop: PlayingLoop,
    signal?: AbortSignal,
    rejectOnFailure = false,
  ): Promise<void> {
    if (signal?.aborted || this.#paused || !this.#isLoopOwned(loop))
      return Promise.resolve();
    const pending = this.#pendingLoopPlays.get(loop.element);
    if (pending !== undefined) {
      if (pending.loop === loop && this.#isCurrentLoopPlayAttempt(pending))
        return pending.promise;
      this.#cancelLoopPlay(pending.loop);
    }

    const generation = (this.#loopPlayGenerations.get(loop.element) ?? 0) + 1;
    this.#loopPlayGenerations.set(loop.element, generation);
    const controller = new AbortController();
    // A stale native callback may arrive after this attempt was replaced. It
    // must not pause a newer attempt that still owns the same element; only a
    // globally paused manager or an unowned transport is allowed to silence it.
    const shouldPauseLatePlay = (): boolean =>
      this.#paused || !this.#isLoopElementOwned(loop.element);
    let attempt!: LoopPlayAttempt;
    const promise = rejectOnFailure
      ? playAmbience(loop.element, controller.signal, shouldPauseLatePlay)
      : playBgm(loop.element, controller.signal, shouldPauseLatePlay);
    attempt = {
      generation,
      lifecycleGeneration: this.#loopLifecycleGeneration,
      controller,
      loop,
      promise,
    };
    this.#pendingLoopPlays.set(loop.element, attempt);
    const relayAbort = (): void => controller.abort();
    signal?.addEventListener("abort", relayAbort, { once: true });
    // Register ownership cleanup without creating an unhandled rejection (the
    // native play promise is allowed to reject for ambience failures).
    void promise.then(
      () => this.#finishLoopPlay(attempt),
      () => this.#finishLoopPlay(attempt),
    );
    void promise.then(
      () => signal?.removeEventListener("abort", relayAbort),
      () => signal?.removeEventListener("abort", relayAbort),
    );
    return promise;
  }

  #isCurrentLoopPlayAttempt(attempt: LoopPlayAttempt): boolean {
    return (
      this.#pendingLoopPlays.get(attempt.loop.element) === attempt &&
      this.#loopPlayGenerations.get(attempt.loop.element) ===
        attempt.generation &&
      attempt.lifecycleGeneration === this.#loopLifecycleGeneration &&
      !attempt.controller.signal.aborted &&
      !this.#paused &&
      this.#isLoopOwned(attempt.loop)
    );
  }

  #finishLoopPlay(attempt: LoopPlayAttempt): void {
    if (this.#pendingLoopPlays.get(attempt.loop.element) !== attempt) return;
    const current = this.#isCurrentLoopPlayAttempt(attempt);
    this.#pendingLoopPlays.delete(attempt.loop.element);
    // A stale native play resolution must not leave an orphan transport
    // running.  If a newer attempt already owns the same element, leave it to
    // that attempt; its generation is intentionally independent.
    if (!current) attempt.loop.element.pause();
  }

  #cancelLoopPlay(loop: PlayingLoop): void {
    const attempt = this.#pendingLoopPlays.get(loop.element);
    if (attempt === undefined) return;
    this.#pendingLoopPlays.delete(loop.element);
    this.#loopPlayGenerations.set(loop.element, attempt.generation + 1);
    attempt.controller.abort();
    loop.element.pause();
  }

  #ensureContext(): AudioContext {
    if (this.#context !== null) return this.#context;
    const context = new AudioContext({ latencyHint: "interactive" });
    const master = context.createGain();
    const bgm = context.createGain();
    const sfx = context.createGain();
    const video = context.createGain();
    const ambience = context.createGain();
    bgm.connect(master);
    sfx.connect(master);
    video.connect(master);
    ambience.connect(master);
    master.connect(context.destination);
    this.#context = context;
    this.#master = master;
    this.#bgmBus = bgm;
    this.#sfxBus = sfx;
    this.#videoBus = video;
    this.#ambienceBus = ambience;
    this.applySettings(this.#settings);
    return context;
  }

  #createBgm(state: LoopingAudioSnapshot, url: string): PlayingBgm {
    this.#ensureContext();
    return this.#createLoop(state, url, this.#bgmBus as GainNode);
  }

  #createAmbience(state: LoopingAudioSnapshot, url: string): PlayingAmbience {
    this.#ensureContext();
    return this.#createLoop(state, url, this.#ambienceBus as GainNode);
  }

  /**
   * Creates the media transport shared by BGM and ambience.  Keeping one
   * implementation is intentional: metadata seeking, bounded-loop handling,
   * and teardown must not drift between the two looping buses.
   */
  #createLoop(
    state: LoopingAudioSnapshot,
    url: string,
    bus: GainNode,
  ): PlayingLoop {
    const context = this.#ensureContext();
    const element = new Audio(url);
    element.preload = "auto";
    element.crossOrigin = "anonymous";
    element.loop = state.loop_end_ms == null;
    const source = context.createMediaElementSource(element);
    const gain = context.createGain();
    source.connect(gain).connect(bus);
    const playing: PlayingLoop = {
      state: { ...state },
      element,
      source,
      gain,
      loopListener: () => undefined,
      metadataListener: () => undefined,
      endedListener: () => undefined,
    };
    // `timeupdate` cadence is browser-defined (typically far coarser than a
    // frame), so a bounded loop can overshoot its end by tens of milliseconds;
    // the `ended` fallback below is what makes an end at the media EOF safe.
    const loopListener = (): void => {
      // Native whole-file looping is owned by `element.loop`; running the
      // custom rewind as well truncates the tail and can seek every event.
      if (playing.state.loop_end_ms == null) return;
      const loopStart = (playing.state.loop_start_ms ?? 0) / 1_000;
      const loopEnd = playing.state.loop_end_ms / 1_000;
      if (Number.isFinite(loopEnd) && element.currentTime >= loopEnd - 0.025)
        element.currentTime = loopStart;
    };
    // A bounded loop whose end sits at (or past) the media length reaches the
    // element's own EOF, where `timeupdate` stops firing and the element
    // pauses forever. Rewind and resume, but only while this manager still
    // owns the transport and is not globally paused.
    const endedListener = (): void => {
      if (playing.state.loop_end_ms == null) return;
      if (this.#paused || !this.#isLoopOwned(playing)) return;
      element.currentTime = (playing.state.loop_start_ms ?? 0) / 1_000;
      void this.#startLoop(playing).catch(() => undefined);
    };
    const seekToStart = (): void => {
      element.currentTime = state.start_ms / 1_000;
    };
    element.addEventListener("timeupdate", loopListener);
    element.addEventListener("ended", endedListener);
    element.addEventListener("loadedmetadata", seekToStart, { once: true });
    // Real media can already have metadata by the time the listener is
    // attached (notably a cached element in an unlocked browser).
    if (element.readyState >= 1) seekToStart();
    playing.loopListener = loopListener;
    playing.endedListener = endedListener;
    playing.metadataListener = seekToStart;
    return playing;
  }

  #destroyBgm(bgm: PlayingBgm): void {
    this.#destroyLoop(bgm);
  }

  #destroyAmbience(ambience: PlayingAmbience): void {
    this.#destroyLoop(ambience);
  }

  #destroyLoop(loop: PlayingLoop): void {
    this.#cancelLoopPlay(loop);
    loop.element.pause();
    loop.element.removeEventListener("timeupdate", loop.loopListener);
    loop.element.removeEventListener("ended", loop.endedListener);
    loop.element.removeEventListener("loadedmetadata", loop.metadataListener);
    loop.element.removeAttribute("src");
    loop.element.load();
    loop.source.disconnect();
    loop.gain.disconnect();
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

function gainValue(node: GainNode | null): number | null {
  return node === null ? null : node.gain.value;
}

function describeLoop(loop: PlayingLoop | null): AudioLoopDiagnostics | null {
  if (loop === null) return null;
  return {
    asset: loop.state.asset,
    volume: loop.gain.gain.value,
    current_time: loop.element.currentTime,
    paused: loop.element.paused,
    start_ms: loop.state.start_ms,
    loop_start_ms: loop.state.loop_start_ms ?? null,
    loop_end_ms: loop.state.loop_end_ms ?? null,
  };
}

function requireAssetUrl(assets: AssetUrlMap, id: string): string {
  const url = assets[id];
  if (url === undefined) throw new Error(`表现层找不到素材 URL: ${id}`);
  return url;
}

function cloneAudioSnapshot(snapshot: AudioSnapshot): AudioSnapshot {
  const clone: AudioSnapshot = {
    bgm: snapshot.bgm === null ? null : { ...snapshot.bgm },
  };
  if (snapshot.ambience !== undefined) {
    clone.ambience =
      snapshot.ambience === null
        ? null
        : cloneAmbienceSnapshot(snapshot.ambience);
  }
  return clone;
}

function cloneAmbienceSnapshot(snapshot: AmbienceSnapshot): AmbienceSnapshot {
  const clone: AmbienceSnapshot = {};
  for (const slot of AMBIENCE_SLOTS) {
    const value = snapshot[slot];
    if (value !== undefined) clone[slot] = value === null ? null : { ...value };
  }
  return clone;
}
function normalizeCps(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 30;
}
function firstItem<T>(values: readonly T[]): T | undefined {
  for (const value of values) return value;
  return undefined;
}
