import { beforeEach, describe, expect, it, vi } from "vitest";

import { AudioManager } from "./audio";
import type {
  AmbienceSlot,
  AudioSnapshot,
  LoopingAudioSnapshot,
} from "./types";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

let frameCallbacks = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
let frameNow = 0;

class FakeGainNode {
  readonly connections: unknown[] = [];
  readonly gain = {
    value: 1,
    setValueAtTime: (value: number): void => {
      this.gain.value = value;
    },
  };

  constructor(readonly context: FakeAudioContext) {}

  connect<T>(node: T): T {
    this.connections.push(node);
    return node;
  }

  disconnect(): void {
    /* no-op */
  }
}

class FakeMediaElementSource {
  constructor(readonly context: FakeAudioContext) {}

  connect<T>(node: T): T {
    return node;
  }

  disconnect(): void {
    /* no-op */
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static initialState: AudioContextState = "running";
  static resumeDeferred: Deferred | null = null;
  readonly destination = {};
  state: AudioContextState = FakeAudioContext.initialState;
  readonly currentTime = 0;
  readonly gains: FakeGainNode[] = [];
  closed = false;
  resumeCalls = 0;
  suspendCalls = 0;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createGain(): FakeGainNode {
    const gain = new FakeGainNode(this);
    this.gains.push(gain);
    return gain;
  }

  createMediaElementSource(): FakeMediaElementSource {
    return new FakeMediaElementSource(this);
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    const deferred = FakeAudioContext.resumeDeferred;
    if (deferred !== null) {
      FakeAudioContext.resumeDeferred = null;
      return deferred.promise.then(() => {
        this.state = "running";
      });
    }
    this.state = "running";
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.suspendCalls += 1;
    this.state = "suspended";
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  static deferredUrl: string | null = null;
  static deferredPlay: Deferred | null = null;
  static rejectUrls = new Set<string>();
  static playCalls = 0;

  readonly listeners = new Map<string, Set<EventListener>>();
  readonly duration = 60;
  readonly url: string;
  preload = "";
  crossOrigin = "";
  loop = false;
  paused = true;
  currentTime = 0;
  removed = false;
  pauseCalls = 0;
  loadCalls = 0;
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    FakeAudio.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: EventListener,
    _options?: AddEventListenerOptions,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  play(): Promise<void> {
    FakeAudio.playCalls += 1;
    if (FakeAudio.rejectUrls.has(this.url))
      return Promise.reject(new Error(`播放失败: ${this.url}`));
    if (this.url === FakeAudio.deferredUrl) {
      const deferred = makeDeferred();
      FakeAudio.deferredPlay = deferred;
      return deferred.promise.then(() => {
        this.paused = false;
      });
    }
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }

  removeAttribute(name: string): void {
    if (name === "src") this.removed = true;
  }

  load(): void {
    this.loadCalls += 1;
  }

  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])])
      listener(new Event(type));
  }
}

function makeDeferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

const settings = {
  master_volume: 1,
  bgm_volume: 1,
  sfx_volume: 1,
  video_volume: 1,
  text_speed_cps: 30,
};

function installAudioMocks(): void {
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("Audio", FakeAudio);
  frameCallbacks = new Map();
  nextFrameId = 1;
  frameNow = performance.now();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    frameCallbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frameCallbacks.delete(id);
  });
  Object.assign(FakeAudio, {
    instances: [],
    deferredUrl: null,
    deferredPlay: null,
    rejectUrls: new Set<string>(),
    playCalls: 0,
  });
  FakeAudioContext.instances = [];
  FakeAudioContext.initialState = "running";
  FakeAudioContext.resumeDeferred = null;
}

async function runNextFrame(deltaMs: number): Promise<void> {
  // A transition queues its first RAF after the media-play microtask. Wait a
  // bounded number of microtasks rather than racing that queue with a
  // synchronous assertion or inventing a frame when no request exists.
  for (let turn = 0; turn < 8; turn += 1) {
    const next = frameCallbacks.entries().next().value as
      [number, FrameRequestCallback] | undefined;
    if (next !== undefined) {
      frameCallbacks.delete(next[0]);
      frameNow += deltaMs;
      next[1](frameNow);
      return;
    }
    await Promise.resolve();
  }
  throw new Error("no animation frame queued after bounded microtask wait");
}

function loop(
  asset: string,
  volume = 1,
  startMs = 0,
  loopStartMs: number | null = null,
  loopEndMs: number | null = null,
): LoopingAudioSnapshot {
  return {
    asset,
    volume,
    start_ms: startMs,
    loop_start_ms: loopStartMs,
    loop_end_ms: loopEndMs,
  };
}

function ambienceSnapshot(
  slots: Partial<Record<AmbienceSlot, LoopingAudioSnapshot | null>>,
): AudioSnapshot {
  const ambience: NonNullable<AudioSnapshot["ambience"]> = {};
  for (const slot of ["slot_1", "slot_2", "slot_3", "slot_4"] as const) {
    const state = slots[slot];
    if (state !== undefined) ambience[slot] = state;
  }
  return { bgm: null, ambience };
}

describe("AudioManager BGM transitions", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installAudioMocks();
  });

  it("destroys a newly-created track when a fade is cancelled", async () => {
    const manager = new AudioManager(settings);
    await manager.transitionBgm(
      {
        asset: "a",
        volume: 1,
        loop_start_ms: 0,
        loop_end_ms: null,
        start_ms: 0,
      },
      0,
      { a: "a.mp3" },
    );

    const controller = new AbortController();
    const transition = manager.transitionBgm(
      {
        asset: "b",
        volume: 1,
        loop_start_ms: 0,
        loop_end_ms: null,
        start_ms: 0,
      },
      1_000,
      { a: "a.mp3", b: "b.mp3" },
      controller.signal,
    );
    await Promise.resolve();
    await Promise.resolve();
    await runNextFrame(500);
    controller.abort();
    await transition;
    await manager.reconcile({ bgm: null }, { a: "a.mp3", b: "b.mp3" });

    expect(FakeAudio.instances).toHaveLength(2);
    expect(
      FakeAudio.instances.every((audio) => audio.paused && audio.removed),
    ).toBe(true);
  });

  it.each(["bgm", "ambience"] as const)(
    "pauses a late %s play after reset instead of reviving its transport",
    async (kind) => {
      FakeAudio.deferredUrl = "late.mp3";
      const manager = new AudioManager(settings);
      const pending =
        kind === "bgm"
          ? manager.transitionBgm(loop("late"), 0, { late: "late.mp3" })
          : manager.transitionAmbience("slot_1", loop("late"), 0, {
              late: "late.mp3",
            });
      await Promise.resolve();
      const audio = FakeAudio.instances[0];
      const nativePlay = FakeAudio.deferredPlay;
      if (audio === undefined || nativePlay === null)
        throw new Error("missing deferred transport");

      manager.resetSession();
      await pending;
      expect(audio.paused).toBe(true);
      nativePlay.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(audio.paused).toBe(true);
      expect(audio.removed).toBe(true);
      nativePlay.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(audio.paused).toBe(true);
      manager.destroy();
    },
  );

  it.each(["bgm", "ambience"] as const)(
    "keeps the current %s transport playing when an older retry resolves late",
    async (kind) => {
      const manager = new AudioManager(settings);
      const start =
        kind === "bgm"
          ? manager.transitionBgm(loop("steady"), 0, {
              steady: "steady.mp3",
            })
          : manager.transitionAmbience("slot_1", loop("steady"), 0, {
              steady: "steady.mp3",
            });
      await start;
      const audio = FakeAudio.instances[0];
      if (audio === undefined) throw new Error("missing committed transport");

      await manager.setPaused(true);
      FakeAudio.deferredUrl = "steady.mp3";
      const firstResume = manager.setPaused(false);
      for (let turn = 0; turn < 4 && FakeAudio.deferredPlay === null; turn += 1)
        await Promise.resolve();
      const firstPlay = FakeAudio.deferredPlay;
      if (firstPlay === null) throw new Error("missing first deferred play");

      // A second resume gets a fresh manager-owned attempt on the same
      // element. The old native promise remains pending underneath.
      await manager.setPaused(true);
      await firstResume;
      FakeAudio.deferredUrl = null;
      await manager.setPaused(false);
      expect(audio.paused).toBe(false);
      expect(
        kind === "bgm"
          ? manager.currentBgmVolume()
          : manager.currentAmbienceVolume("slot_1"),
      ).toBe(1);

      firstPlay.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // The stale attempt is allowed to settle, but it cannot pause the
      // currently owned, globally unpaused transport.
      expect(audio.paused).toBe(false);
      manager.destroy();
    },
  );

  it.each(["bgm", "ambience"] as const)(
    "keeps a stale %s element paused after replacement, reset, or destroy",
    async (kind) => {
      for (const lifecycle of ["replacement", "reset", "destroy"] as const) {
        FakeAudio.deferredUrl = "stale.mp3";
        const manager = new AudioManager(settings);
        const staleTransition =
          kind === "bgm"
            ? manager.transitionBgm(loop("stale"), 0, {
                stale: "stale.mp3",
                fresh: "fresh.mp3",
              })
            : manager.transitionAmbience("slot_1", loop("stale"), 0, {
                stale: "stale.mp3",
                fresh: "fresh.mp3",
              });
        await Promise.resolve();
        const staleAudio = FakeAudio.instances.at(-1);
        const stalePlay = FakeAudio.deferredPlay;
        if (staleAudio === undefined || stalePlay === null)
          throw new Error("missing stale transport");

        if (lifecycle === "replacement") {
          FakeAudio.deferredUrl = null;
          if (kind === "bgm") {
            await manager.transitionBgm(loop("fresh"), 0, {
              stale: "stale.mp3",
              fresh: "fresh.mp3",
            });
          } else {
            await manager.transitionAmbience("slot_1", loop("fresh"), 0, {
              stale: "stale.mp3",
              fresh: "fresh.mp3",
            });
          }
        } else if (lifecycle === "reset") {
          manager.resetSession();
        } else {
          manager.destroy();
        }
        await staleTransition;
        stalePlay.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(staleAudio.paused).toBe(true);
        expect(staleAudio.removed).toBe(true);
        manager.destroy();
      }
    },
  );

  it("cancels a pending play promise and lets the next snapshot restore audio", async () => {
    FakeAudio.deferredUrl = "b.mp3";
    const manager = new AudioManager(settings);
    await manager.transitionBgm(
      {
        asset: "a",
        volume: 1,
        loop_start_ms: 0,
        loop_end_ms: null,
        start_ms: 0,
      },
      0,
      { a: "a.mp3" },
    );

    const transition = manager.transitionBgm(
      {
        asset: "b",
        volume: 1,
        loop_start_ms: 0,
        loop_end_ms: null,
        start_ms: 0,
      },
      500,
      { a: "a.mp3", b: "b.mp3" },
    );
    await Promise.resolve();
    const pending = FakeAudio.deferredPlay;
    expect(pending).not.toBeNull();
    await manager.reconcile({ bgm: null }, { a: "a.mp3", b: "b.mp3" });
    await transition;

    expect(pending).not.toBeNull();
    expect(
      FakeAudio.instances.every((audio) => audio.paused && audio.removed),
    ).toBe(true);
  });

  it("leaves only the target track after a completed replacement", async () => {
    const manager = new AudioManager(settings);
    await manager.transitionBgm(
      {
        asset: "a",
        volume: 1,
        loop_start_ms: 0,
        loop_end_ms: null,
        start_ms: 0,
      },
      0,
      { a: "a.mp3" },
    );
    await manager.transitionBgm(
      {
        asset: "b",
        volume: 0.5,
        loop_start_ms: 0,
        loop_end_ms: null,
        start_ms: 0,
      },
      0,
      { a: "a.mp3", b: "b.mp3" },
    );

    expect(FakeAudio.instances[0]?.removed).toBe(true);
    expect(FakeAudio.instances[1]?.removed).toBe(false);
    expect(manager.currentBgmVolume()).toBe(0.5);
  });
});

describe("AudioManager four-slot ambience", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installAudioMocks();
  });

  it("reconciles all four slots onto independent transports and a dedicated bus", async () => {
    const manager = new AudioManager({ ...settings, ambience_volume: 0.65 });
    await manager.reconcile(
      ambienceSnapshot({
        slot_1: loop("one", 0.1),
        slot_2: loop("two", 0.2),
        slot_3: loop("three", 0.3),
        slot_4: loop("four", 0.4),
      }),
      {
        one: "one.mp3",
        two: "two.mp3",
        three: "three.mp3",
        four: "four.mp3",
      },
    );

    expect(FakeAudio.instances.map((audio) => audio.url)).toEqual([
      "one.mp3",
      "two.mp3",
      "three.mp3",
      "four.mp3",
    ]);
    expect(FakeAudio.instances.every((audio) => !audio.removed)).toBe(true);
    expect(manager.currentAmbienceVolume("slot_1")).toBe(0.1);
    expect(manager.currentAmbienceVolume("slot_2")).toBe(0.2);
    expect(manager.currentAmbienceVolume("slot_3")).toBe(0.3);
    expect(manager.currentAmbienceVolume("slot_4")).toBe(0.4);
    const context = FakeAudioContext.instances[0];
    expect(context?.gains).toHaveLength(9);
    // Buses are created in master/BGM/SFX/video/ambience order.  The
    // ambience bus is not any of the existing BGM/SFX/video buses.
    expect(context?.gains[1]?.gain.value).toBe(1);
    expect(context?.gains[4]?.gain.value).toBe(0.65);
    const diagnostics = manager.readDiagnostics();
    expect(diagnostics.context_state).toBe("running");
    expect(diagnostics.buses.ambience).toBe(0.65);
    expect(diagnostics.buses.bgm).toBe(1);
    expect(
      Object.values(diagnostics.ambience).map((track) => track?.asset),
    ).toEqual(["one", "two", "three", "four"]);
    expect(diagnostics.ambience.slot_1?.paused).toBe(false);
    const plays = FakeAudio.playCalls;
    manager.applySettings({ ...settings, ambience_volume: 0.25 });
    expect(FakeAudio.playCalls).toBe(plays);
    expect(context?.gains[4]?.gain.value).toBe(0.25);
  });

  it("seeks metadata, preserves same-asset phase, and applies updated loop bounds", async () => {
    const manager = new AudioManager(settings);
    await manager.transitionAmbience(
      "slot_1",
      loop("forest", 0.5, 125, 200, 500),
      0,
      { forest: "forest.mp3" },
    );
    const audio = FakeAudio.instances[0];
    if (audio === undefined) throw new Error("missing ambience element");
    audio.dispatch("loadedmetadata");
    expect(audio.currentTime).toBe(0.125);
    audio.currentTime = 0.49;
    audio.dispatch("timeupdate");
    expect(audio.currentTime).toBe(0.2);

    audio.currentTime = 12.345;
    await manager.transitionAmbience(
      "slot_1",
      loop("forest", 0.75, 900, 1000, 2_000),
      0,
      { forest: "forest.mp3" },
    );
    expect(FakeAudio.instances).toHaveLength(1);
    expect(audio.currentTime).toBe(12.345);
    expect(audio.loop).toBe(false);
    audio.currentTime = 1.99;
    audio.dispatch("timeupdate");
    expect(audio.currentTime).toBe(1);
    expect(manager.currentAmbienceVolume("slot_1")).toBe(0.75);
  });

  it("crossfades replacement and releases the old track on stop", async () => {
    const manager = new AudioManager(settings);
    await manager.transitionAmbience("slot_2", loop("old", 0.8), 0, {
      old: "old.mp3",
      next: "next.mp3",
    });
    const replacement = manager.transitionAmbience(
      "slot_2",
      loop("next", 0.4),
      1_000,
      { old: "old.mp3", next: "next.mp3" },
    );
    await Promise.resolve();
    await Promise.resolve();
    await runNextFrame(500);
    expect(FakeAudio.instances[0]?.removed).toBe(false);
    expect(FakeAudio.instances[1]?.removed).toBe(false);
    expect(FakeAudioContext.instances[0]?.gains[5]?.gain.value).toBeCloseTo(
      0.4,
    );
    expect(FakeAudioContext.instances[0]?.gains[6]?.gain.value).toBeCloseTo(
      0.2,
    );
    await runNextFrame(501);
    await replacement;
    expect(FakeAudio.instances[0]?.removed).toBe(true);
    expect(FakeAudio.instances[1]?.removed).toBe(false);
    expect(manager.currentAmbienceVolume("slot_2")).toBe(0.4);

    await manager.transitionAmbience("slot_2", null, 0, {
      old: "old.mp3",
      next: "next.mp3",
    });
    expect(FakeAudio.instances[1]?.removed).toBe(true);
    expect(manager.currentAmbienceVolume("slot_2")).toBeUndefined();
    expect(
      [...(FakeAudio.instances[1]?.listeners.values() ?? [])].every(
        (listeners) => listeners.size === 0,
      ),
    ).toBe(true);
  });

  it("isolates a failed slot while other slots converge", async () => {
    FakeAudio.rejectUrls.add("bad.mp3");
    const manager = new AudioManager(settings);
    await expect(
      manager.reconcile(
        ambienceSnapshot({
          slot_1: loop("bad", 0.2),
          slot_2: loop("good", 0.6),
        }),
        { bad: "bad.mp3", good: "good.mp3" },
      ),
    ).rejects.toThrow("播放失败: bad.mp3");
    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances[0]?.removed).toBe(true);
    expect(FakeAudio.instances[1]?.removed).toBe(false);
    expect(manager.currentAmbienceVolume("slot_1")).toBeUndefined();
    expect(manager.currentAmbienceVolume("slot_2")).toBe(0.6);
  });

  it("makes same-slot requests latest-safe and abort-safe", async () => {
    FakeAudio.deferredUrl = "slow.mp3";
    const manager = new AudioManager(settings);
    const stale = manager.transitionAmbience("slot_1", loop("slow"), 0, {
      slow: "slow.mp3",
      fresh: "fresh.mp3",
    });
    await Promise.resolve();
    const stalePlay = FakeAudio.deferredPlay;
    const latest = manager.transitionAmbience("slot_1", loop("fresh", 0.7), 0, {
      slow: "slow.mp3",
      fresh: "fresh.mp3",
    });
    await latest;
    await stale;
    expect(FakeAudio.instances[0]?.removed).toBe(true);
    expect(FakeAudio.instances[1]?.removed).toBe(false);
    expect(manager.currentAmbienceVolume("slot_1")).toBe(0.7);
    stalePlay?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(FakeAudio.instances[0]?.paused).toBe(true);

    FakeAudio.deferredUrl = "abort.mp3";
    const controller = new AbortController();
    const aborted = manager.transitionAmbience(
      "slot_3",
      loop("abort"),
      0,
      { abort: "abort.mp3" },
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    await aborted;
    expect(FakeAudio.instances[FakeAudio.instances.length - 1]?.removed).toBe(
      true,
    );
    expect(manager.currentAmbienceVolume("slot_3")).toBeUndefined();
  });

  it("rolls back a partial same-slot fade when its signal aborts", async () => {
    const manager = new AudioManager(settings);
    await manager.transitionAmbience("slot_1", loop("steady", 0.8), 0, {
      steady: "steady.mp3",
    });
    const controller = new AbortController();
    const fading = manager.transitionAmbience(
      "slot_1",
      loop("steady", 0.2),
      1_000,
      { steady: "steady.mp3" },
      controller.signal,
    );
    await Promise.resolve();
    await Promise.resolve();
    await runNextFrame(500);
    controller.abort();
    await fading;
    expect(manager.currentAmbienceVolume("slot_1")).toBe(0.8);
  });

  it("defers every ambience resource while muted and activates only the latest desired state", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const manager = new AudioManager(
      { ...settings, master_volume: 0 },
      { deferUntilUnmuted: true },
    );
    await manager.reconcile(
      ambienceSnapshot({
        slot_1: loop("old"),
        slot_2: loop("old-two"),
      }),
      { old: "old.mp3", "old-two": "old-two.mp3", fresh: "fresh.mp3" },
    );
    await manager.reconcile(ambienceSnapshot({ slot_1: loop("fresh", 0.3) }), {
      fresh: "fresh.mp3",
    });
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(FakeAudio.instances).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();

    manager.applySettings({
      ...settings,
      master_volume: 1,
      ambience_volume: 0.4,
    });
    await manager.activateDeferred();
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0]?.url).toBe("fresh.mp3");
    expect(manager.currentAmbienceVolume("slot_1")).toBe(0.3);
    expect(FakeAudioContext.instances[0]?.gains[4]?.gain.value).toBe(0.4);
  });

  it("resumes a suspended context once without duplicating deferred resources", async () => {
    FakeAudioContext.initialState = "suspended";
    const manager = new AudioManager(
      { ...settings, master_volume: 0 },
      { deferUntilUnmuted: true },
    );
    await manager.reconcile(ambienceSnapshot({ slot_1: loop("forest") }), {
      forest: "forest.mp3",
    });
    expect(FakeAudio.instances).toHaveLength(0);

    const first = manager.activateDeferred();
    const second = manager.activateDeferred();
    await Promise.all([first, second]);

    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0]?.state).toBe("running");
    expect(FakeAudioContext.instances[0]?.resumeCalls).toBe(1);
    expect(FakeAudio.instances.map((audio) => audio.url)).toEqual([
      "forest.mp3",
    ]);
    await manager.activateDeferred();
    expect(FakeAudio.instances).toHaveLength(1);
    manager.destroy();
  });

  it("does not revive media after a failed-load boundary while resume is delayed", async () => {
    FakeAudioContext.initialState = "suspended";
    const resume = makeDeferred();
    FakeAudioContext.resumeDeferred = resume;
    const manager = new AudioManager(
      { ...settings, master_volume: 0 },
      { deferUntilUnmuted: true },
    );
    const load = new AbortController();
    await manager.reconcile(
      ambienceSnapshot({ slot_1: loop("failed-load") }),
      { "failed-load": "failed-load.mp3" },
      load.signal,
    );
    manager.applySettings(settings);
    const activationOwner = new AbortController();
    const activation = manager.activateDeferred(activationOwner.signal);
    await Promise.resolve();
    expect(FakeAudioContext.instances[0]?.resumeCalls).toBe(1);

    // A failed replacement load invalidates both the old load owner and the
    // active reconciliation before the delayed resume continuation settles.
    load.abort();
    await manager.reconcile({ bgm: null, ambience: {} }, {});
    resume.resolve();
    await activation;
    expect(FakeAudio.instances).toHaveLength(0);
    expect(manager.currentAmbienceVolume("slot_1")).toBeUndefined();
    manager.destroy();
  });

  it("does not revive media after reset while context resume is delayed", async () => {
    FakeAudioContext.initialState = "suspended";
    const resume = makeDeferred();
    FakeAudioContext.resumeDeferred = resume;
    const manager = new AudioManager(
      { ...settings, master_volume: 0 },
      { deferUntilUnmuted: true },
    );
    await manager.reconcile(
      ambienceSnapshot({ slot_1: loop("reset-target") }),
      { "reset-target": "reset-target.mp3" },
    );
    manager.applySettings(settings);
    const activation = manager.activateDeferred();
    await Promise.resolve();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0]?.resumeCalls).toBe(1);
    expect(FakeAudio.instances).toHaveLength(0);

    manager.resetSession();
    resume.resolve();
    await activation;
    expect(FakeAudio.instances).toHaveLength(0);
    expect(manager.currentAmbienceVolume("slot_1")).toBeUndefined();
    manager.destroy();
  });

  it("does not let an activation waiter revive a post-reset target", async () => {
    FakeAudioContext.initialState = "suspended";
    const resume = makeDeferred();
    FakeAudioContext.resumeDeferred = resume;
    const manager = new AudioManager(
      { ...settings, master_volume: 0 },
      { deferUntilUnmuted: true },
    );
    await manager.reconcile(
      ambienceSnapshot({ slot_1: loop("before-reset") }),
      { "before-reset": "before-reset.mp3" },
    );
    manager.applySettings(settings);
    const first = manager.activateDeferred();
    await Promise.resolve();
    const waiter = manager.activateDeferred();

    // Destroying the old manager and storing a replacement target must not let
    // the old waiter activate that replacement after the lifecycle boundary.
    manager.destroy();
    manager.applySettings({ ...settings, master_volume: 0 });
    await manager.reconcile(ambienceSnapshot({ slot_1: loop("after-reset") }), {
      "after-reset": "after-reset.mp3",
    });
    resume.resolve();
    await Promise.all([first, waiter]);
    expect(FakeAudio.instances).toHaveLength(0);
    manager.destroy();
  });

  it("does not revive media after destroy while context resume is delayed", async () => {
    FakeAudioContext.initialState = "suspended";
    const resume = makeDeferred();
    FakeAudioContext.resumeDeferred = resume;
    const manager = new AudioManager(
      { ...settings, master_volume: 0 },
      { deferUntilUnmuted: true },
    );
    await manager.reconcile(
      ambienceSnapshot({ slot_2: loop("destroy-target") }),
      { "destroy-target": "destroy-target.mp3" },
    );
    manager.applySettings(settings);
    const activation = manager.activateDeferred();
    await Promise.resolve();
    expect(FakeAudio.instances).toHaveLength(0);

    manager.destroy();
    resume.resolve();
    await activation;
    expect(FakeAudio.instances).toHaveLength(0);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
  });

  it("serializes rapid mute-unmute and creates one current resource set", async () => {
    FakeAudioContext.initialState = "suspended";
    const resume = makeDeferred();
    FakeAudioContext.resumeDeferred = resume;
    const manager = new AudioManager(
      { ...settings, master_volume: 0 },
      { deferUntilUnmuted: true },
    );
    await manager.reconcile(ambienceSnapshot({ slot_3: loop("rapid") }), {
      rapid: "rapid.mp3",
    });
    manager.applySettings(settings);
    const firstOwner = new AbortController();
    const first = manager.activateDeferred(firstOwner.signal);
    await Promise.resolve();
    const second = manager.activateDeferred();
    // The remute aborts the first caller while the shared resume is pending;
    // the target remains deferred for the second still-current caller.
    manager.applySettings({ ...settings, master_volume: 0 });
    firstOwner.abort();
    manager.applySettings(settings);
    resume.resolve();
    await Promise.all([first, second]);
    expect(FakeAudio.instances.map((audio) => audio.url)).toEqual([
      "rapid.mp3",
    ]);
    expect(FakeAudio.instances.filter((audio) => !audio.removed)).toHaveLength(
      1,
    );
    expect(FakeAudioContext.instances[0]?.resumeCalls).toBe(1);
    manager.destroy();
  });

  it("keeps concurrent unmute callers deduplicated with exact resources", async () => {
    FakeAudioContext.initialState = "suspended";
    const resume = makeDeferred();
    FakeAudioContext.resumeDeferred = resume;
    const manager = new AudioManager(
      { ...settings, master_volume: 0 },
      { deferUntilUnmuted: true },
    );
    await manager.reconcile(
      ambienceSnapshot({
        slot_1: loop("one"),
        slot_2: loop("two"),
      }),
      { one: "one.mp3", two: "two.mp3" },
    );
    manager.applySettings(settings);
    const calls = [
      manager.activateDeferred(),
      manager.activateDeferred(),
      manager.activateDeferred(),
    ];
    await Promise.resolve();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0]?.resumeCalls).toBe(1);
    resume.resolve();
    await Promise.all(calls);
    expect(FakeAudio.instances.map((audio) => audio.url)).toEqual([
      "one.mp3",
      "two.mp3",
    ]);
    expect(FakeAudio.instances.filter((audio) => !audio.removed)).toHaveLength(
      2,
    );
    manager.destroy();
  });

  it("keeps a newer deferred reconcile after an older aborted reconcile", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const manager = new AudioManager(
      { ...settings, master_volume: 0 },
      { deferUntilUnmuted: true },
    );
    const first = new AbortController();
    await manager.reconcile(
      ambienceSnapshot({ slot_1: loop("first") }),
      { first: "first.mp3" },
      first.signal,
    );
    const second = new AbortController();
    await manager.reconcile(
      ambienceSnapshot({ slot_1: loop("second", 0.4) }),
      { second: "second.mp3" },
      second.signal,
    );

    first.abort();
    // This pre-aborted stale operation must not clear the newer generation.
    await manager.reconcile(
      ambienceSnapshot({ slot_1: loop("first") }),
      { first: "first.mp3" },
      first.signal,
    );
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(FakeAudio.instances).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();

    await manager.activateDeferred(second.signal);
    expect(FakeAudio.instances.map((audio) => audio.url)).toEqual([
      "second.mp3",
    ]);
    expect(manager.currentAmbienceVolume("slot_1")).toBe(0.4);
  });

  it("retains a deferred target when remuting cancels pending media play", async () => {
    FakeAudio.deferredUrl = "pending.mp3";
    const manager = new AudioManager(
      { ...settings, master_volume: 0 },
      { deferUntilUnmuted: true },
    );
    await manager.reconcile(
      { bgm: loop("pending") },
      { pending: "pending.mp3" },
    );
    manager.applySettings(settings);
    const activationController = new AbortController();
    const activation = manager.activateDeferred(activationController.signal);
    await Promise.resolve();
    await Promise.resolve();
    const firstPlay = FakeAudio.deferredPlay;
    if (firstPlay === null) throw new Error("missing deferred play");
    manager.applySettings({ ...settings, master_volume: 0 });
    activationController.abort();
    await activation;
    expect(FakeAudio.instances[0]?.removed).toBe(true);

    // The desired snapshot survived the aborted generation, so a later
    // unmute retries it rather than treating the cancelled activation as done.
    FakeAudio.deferredUrl = null;
    manager.applySettings(settings);
    await manager.activateDeferred();
    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances[1]?.removed).toBe(false);
    expect(manager.currentBgmVolume()).toBe(1);
    manager.destroy();
  });

  it("does not let a stale deferred activation overwrite a newer target", async () => {
    FakeAudio.deferredUrl = "first.mp3";
    const manager = new AudioManager(
      { ...settings, master_volume: 0 },
      { deferUntilUnmuted: true },
    );
    await manager.reconcile({ bgm: loop("first") }, { first: "first.mp3" });
    manager.applySettings(settings);
    const activationController = new AbortController();
    const activation = manager.activateDeferred(activationController.signal);
    await Promise.resolve();
    await Promise.resolve();
    const stalePlay = FakeAudio.deferredPlay;
    if (stalePlay === null) throw new Error("missing stale deferred play");

    // Once a context exists, the newer active reconcile owns the BGM slot. It
    // must remain authoritative when the old native play promise settles.
    FakeAudio.deferredUrl = null;
    manager.applySettings({ ...settings, master_volume: 0 });
    await manager.reconcile(
      { bgm: loop("second", 0.6) },
      { first: "first.mp3", second: "second.mp3" },
    );
    stalePlay.resolve();
    await activation;
    await Promise.resolve();
    expect(FakeAudio.instances[1]?.url).toBe("second.mp3");
    expect(FakeAudio.instances[1]?.removed).toBe(false);
    expect(manager.currentBgmVolume()).toBe(0.6);
    manager.destroy();
  });

  it("keeps a newer deferred target after a stale activateDeferred abort", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const manager = new AudioManager(
      { ...settings, master_volume: 0 },
      { deferUntilUnmuted: true },
    );
    const first = new AbortController();
    await manager.reconcile(
      ambienceSnapshot({ slot_2: loop("first") }),
      { first: "first.mp3" },
      first.signal,
    );
    const second = new AbortController();
    await manager.reconcile(
      ambienceSnapshot({ slot_2: loop("second", 0.6) }),
      { second: "second.mp3" },
      second.signal,
    );

    first.abort();
    await manager.activateDeferred(first.signal);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(FakeAudio.instances).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();

    await manager.activateDeferred(second.signal);
    expect(FakeAudio.instances.map((audio) => audio.url)).toEqual([
      "second.mp3",
    ]);
    expect(manager.currentAmbienceVolume("slot_2")).toBe(0.6);
  });

  it("clears deferred desires on abort/reset and handles ambience:null reconciliation", async () => {
    const manager = new AudioManager(
      { ...settings, master_volume: 0 },
      { deferUntilUnmuted: true },
    );
    const controller = new AbortController();
    await manager.reconcile(
      ambienceSnapshot({ slot_4: loop("ambient") }),
      { ambient: "ambient.mp3" },
      controller.signal,
    );
    controller.abort();
    manager.applySettings(settings);
    await manager.activateDeferred();
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(FakeAudio.instances).toHaveLength(0);

    await manager.reconcile(ambienceSnapshot({ slot_4: loop("ambient") }), {
      ambient: "ambient.mp3",
    });
    // Explicit null is the legacy/canonical empty shape and must stop all
    // four slots without reviving the stale deferred target.
    await manager.reconcile({ bgm: null, ambience: null }, {});
    expect(FakeAudio.instances[0]?.removed).toBe(true);
    expect(manager.currentAmbienceVolume("slot_4")).toBeUndefined();
    manager.resetSession();
    manager.destroy();
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
  });

  it("pauses a crossfade replacement and resumes each transport exactly once", async () => {
    const manager = new AudioManager(settings);
    await manager.transitionAmbience("slot_1", loop("old"), 0, {
      old: "old.mp3",
      next: "next.mp3",
    });
    const replacement = manager.transitionAmbience(
      "slot_1",
      loop("next", 0.4),
      1_000,
      { old: "old.mp3", next: "next.mp3" },
    );
    await Promise.resolve();
    await Promise.resolve();
    const old = FakeAudio.instances[0];
    const next = FakeAudio.instances[1];
    if (old === undefined || next === undefined)
      throw new Error("missing crossfade transports");
    old.currentTime = 12;
    next.currentTime = 3;
    await runNextFrame(500);

    await manager.setPaused(true);
    expect(old.paused).toBe(true);
    expect(next.paused).toBe(true);
    expect(old.currentTime).toBe(12);
    expect(next.currentTime).toBe(3);
    const pausedPlayCalls = FakeAudio.playCalls;
    await runNextFrame(1_000);
    expect(FakeAudio.playCalls).toBe(pausedPlayCalls);

    await manager.setPaused(false);
    expect(FakeAudio.playCalls).toBe(pausedPlayCalls + 2);
    expect(old.paused).toBe(false);
    expect(next.paused).toBe(false);
    await manager.setPaused(false);
    expect(FakeAudio.playCalls).toBe(pausedPlayCalls + 2);
    await runNextFrame(501);
    await replacement;
    expect(old.removed).toBe(true);
    expect(next.removed).toBe(false);
    manager.destroy();
  });

  it("starts and replaces ambience while already paused without advancing it", async () => {
    const manager = new AudioManager(settings);
    await manager.setPaused(true);
    const initial = manager.transitionAmbience("slot_3", loop("old"), 0, {
      old: "old.mp3",
      next: "next.mp3",
    });
    await initial;
    const replacement = manager.transitionAmbience(
      "slot_3",
      loop("next", 0.5),
      1_000,
      { old: "old.mp3", next: "next.mp3" },
    );
    await Promise.resolve();
    await Promise.resolve();
    const old = FakeAudio.instances[0];
    const next = FakeAudio.instances[1];
    if (old === undefined || next === undefined)
      throw new Error("missing paused transports");
    expect(FakeAudio.playCalls).toBe(0);
    expect(old.paused).toBe(true);
    expect(next.paused).toBe(true);
    await runNextFrame(1_000);
    expect(next.paused).toBe(true);
    expect(manager.currentAmbienceVolume("slot_3")).toBe(1);

    await manager.setPaused(false);
    expect(FakeAudio.playCalls).toBe(2);
    await manager.setPaused(false);
    expect(FakeAudio.playCalls).toBe(2);
    await runNextFrame(1_000);
    await replacement;
    expect(old.removed).toBe(true);
    expect(next.removed).toBe(false);
    expect(manager.currentAmbienceVolume("slot_3")).toBe(0.5);
    manager.destroy();
  });

  it("pauses, resumes, resets, and destroys all four transports", async () => {
    const manager = new AudioManager(settings);
    await manager.reconcile(
      ambienceSnapshot({
        slot_1: loop("one"),
        slot_2: loop("two"),
        slot_3: loop("three"),
        slot_4: loop("four"),
      }),
      { one: "one.mp3", two: "two.mp3", three: "three.mp3", four: "four.mp3" },
    );
    await manager.setPaused(true);
    expect(FakeAudio.instances.every((audio) => audio.paused)).toBe(true);
    await manager.unlock();
    expect(FakeAudio.playCalls).toBe(4);
    await manager.setPaused(false);
    expect(FakeAudio.instances.every((audio) => !audio.paused)).toBe(true);
    expect(FakeAudio.playCalls).toBe(8);
    manager.resetSession();
    expect(
      FakeAudio.instances.every((audio) => audio.paused && audio.removed),
    ).toBe(true);
    expect(FakeAudio.instances.every((audio) => audio.pauseCalls >= 2)).toBe(
      true,
    );
    expect(FakeAudio.instances.every((audio) => audio.loadCalls >= 1)).toBe(
      true,
    );
    expect(manager.currentAmbienceVolume("slot_1")).toBeUndefined();
    manager.destroy();
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
  });
});
