import { beforeEach, describe, expect, it, vi } from "vitest";

import { AudioManager } from "./audio";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

let frameCallbacks = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

class FakeGainNode {
  readonly gain = {
    value: 1,
    setValueAtTime: (value: number): void => {
      this.gain.value = value;
    },
  };

  constructor(readonly context: FakeAudioContext) {}

  connect<T>(node: T): T {
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
  readonly destination = {};
  readonly state: AudioContextState = "running";
  readonly currentTime = 0;

  createGain(): FakeGainNode {
    return new FakeGainNode(this);
  }

  createMediaElementSource(): FakeMediaElementSource {
    return new FakeMediaElementSource(this);
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  static deferredUrl: string | null = null;
  static deferredPlay: Deferred | null = null;

  readonly listeners = new Map<string, Set<EventListener>>();
  readonly duration = 60;
  readonly url: string;
  preload = "";
  crossOrigin = "";
  loop = false;
  paused = true;
  currentTime = 0;
  removed = false;

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
    this.paused = true;
  }

  removeAttribute(name: string): void {
    if (name === "src") this.removed = true;
  }

  load(): void {
    /* no-op */
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
  });
}

function runNextFrame(deltaMs: number): void {
  const next = frameCallbacks.entries().next().value as
    [number, FrameRequestCallback] | undefined;
  if (next === undefined) throw new Error("no animation frame queued");
  frameCallbacks.delete(next[0]);
  next[1](performance.now() + deltaMs);
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
    runNextFrame(500);
    controller.abort();
    await transition;
    await manager.reconcile({ bgm: null }, { a: "a.mp3", b: "b.mp3" });

    expect(FakeAudio.instances).toHaveLength(2);
    expect(
      FakeAudio.instances.every((audio) => audio.paused && audio.removed),
    ).toBe(true);
  });

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
