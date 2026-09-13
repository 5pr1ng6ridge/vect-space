// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeMediaDom } from "./sessionTestKit";
import {
  TimelineSession,
  VIDEO_DRIFT_THRESHOLD_MS,
  type PresentationAudioPort,
  type TimelineDomAdapter,
  type TimelineSurfacePort,
} from "./timelineSession";
import {
  EMPTY_SCENE_OVERRIDES,
  type SceneFrame,
  type SceneOverrides,
  type SceneSpriteGeometry,
} from "./sceneFrame";
import type {
  SceneActiveEffects,
  SceneBases,
  SceneCharacterRequest,
  SceneFrameApplyOptions,
  ScenePreparation,
  ScenePreparationRequest,
  SceneVideoHandle,
} from "./sceneSurface";
import type { AnimationMap } from "./imageAnimation";
import type {
  AssetUrlMap,
  AudioSnapshot,
  CameraSnapshot,
  RuntimeSnapshot,
  RuntimeUpdate,
  Settings,
  TimelineTrack,
} from "./types";

const ASSETS: AssetUrlMap = { sfx: "/sfx/boom.wav", clip: "/video/clip.mp4" };
const CAMERA: CameraSnapshot = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
const GEOMETRY: SceneSpriteGeometry = {
  spriteSize: () => ({ width: 240, height: 480 }),
};

function update(
  tracks: TimelineTrack[],
  events: RuntimeUpdate["cues"][number] extends never ? never : unknown[],
  durationMs: number,
): RuntimeUpdate {
  return {
    update_id: "1",
    snapshot: snapshot(),
    requires_ack: false,
    cues: [
      {
        cue_id: "1",
        gate: "runtime",
        type: "timeline",
        duration_ms: durationMs,
        tracks,
        events: events as never,
        skippable: true,
      },
    ],
  } as RuntimeUpdate;
}

function snapshot(): RuntimeSnapshot {
  return {
    revision: "1",
    location: { scene_id: "s", node_id: "n" },
    variables: {},
    world: {
      background: null,
      sprites: {
        hero: {
          asset: "hero-asset",
          x: 0,
          y: 0,
          scale: 1,
          scale_x: 1,
          scale_y: 1,
          rotation_deg: 0,
          opacity: 1,
          z: 0,
        },
      },
      camera: { ...CAMERA },
      dialogue_ui_visible: true,
      ui_motion_bindings: {},
      persistent_effects: [],
    },
    audio: { bgm: null } as AudioSnapshot,
    playback: { auto: "normal", ctrl_fast_forward: "allow" },
    prompt: { kind: "none" },
  } as RuntimeSnapshot;
}

const SPRITE_TRACK: TimelineTrack = {
  type: "sprite",
  sprite_id: "hero",
  asset: null,
  remove_at_end: false,
  channels: {
    x: [
      { at_ms: 0, value: 0, easing: "linear" },
      { at_ms: 1_000, value: 1_000, easing: "linear" },
    ],
  },
};

const VIDEO_TRACK: TimelineTrack = {
  type: "video",
  asset: "clip",
  clip_start_ms: 0,
  clip_end_ms: null,
  loop: false,
  fit: "contain",
  audio_enabled: true,
  channels: {},
};

interface FrameRecord {
  frame: SceneFrame;
  phase: "playhead" | "keep" | undefined;
}

class FakeSurface implements TimelineSurfacePort {
  readonly geometry = GEOMETRY;
  readonly animations: AnimationMap[] = [];
  readonly applied: FrameRecord[] = [];
  readonly effects: (SceneActiveEffects | null)[] = [];
  readonly prepared: ScenePreparationRequest[] = [];
  readonly stagedWorlds: string[] = [];
  readonly discarded: ScenePreparation[] = [];
  readonly characters: SceneCharacterRequest[][] = [];
  readonly decorations: boolean[] = [];
  readonly paused: boolean[] = [];
  readonly videos: FakeVideoHandle[] = [];
  bases: SceneBases = {
    sprites: {
      hero: {
        asset: "hero-asset",
        x: 0,
        y: 0,
        scale: 1,
        scale_x: 1,
        scale_y: 1,
        rotation_deg: 0,
        opacity: 1,
        z: 0,
      },
    },
    buttons: {},
    camera: { ...CAMERA },
    bgmVolume: 1,
  };
  overrides: SceneOverrides = EMPTY_SCENE_OVERRIDES;
  prepareDelay: Promise<void> | null = null;
  /** Models a surface that finished decoding before it noticed an abort. */
  prepareIgnoresAbort = false;
  ensureCharactersResult: boolean | null = null;
  lastFrame: SceneFrame | null = null;

  setAnimations(animations: AnimationMap): void {
    this.animations.push(animations);
  }

  async prepare(
    request: ScenePreparationRequest,
    signal?: AbortSignal,
  ): Promise<ScenePreparation | null> {
    this.prepared.push(request);
    if (this.prepareDelay !== null) await this.prepareDelay;
    if (!this.prepareIgnoresAbort && (signal?.aborted ?? false)) return null;
    return { stale: false } as ScenePreparation;
  }

  applyWorld(preparation: ScenePreparation | null): boolean {
    if (preparation === null || preparation.stale) return false;
    this.stagedWorlds.push("world");
    return true;
  }

  discardPreparation(preparation: ScenePreparation): void {
    this.discarded.push(preparation);
  }

  async ensureCharacters(
    requests: readonly SceneCharacterRequest[],
  ): Promise<boolean> {
    this.characters.push([...requests]);
    if (this.ensureCharactersResult !== null)
      return this.ensureCharactersResult;
    return true;
  }

  captureBases(): SceneBases {
    return this.bases;
  }

  applyFrame(frame: SceneFrame, options?: SceneFrameApplyOptions): void {
    this.lastFrame = frame;
    this.applied.push({ frame, phase: options?.phase });
  }

  readFrame(): SceneFrame {
    return (
      this.lastFrame ?? {
        elapsed_ms: 0,
        camera: { ...CAMERA },
        objects: [],
        bgm_volume: 1,
      }
    );
  }

  readOverrides(): SceneOverrides {
    return this.overrides;
  }

  setActiveEffects(effects: SceneActiveEffects | null): void {
    this.effects.push(effects);
  }

  setDecorativeRunning(running: boolean): void {
    this.decorations.push(running);
  }

  setPaused(paused: boolean): void {
    this.paused.push(paused);
  }

  async attachVideo(
    element: HTMLVideoElement,
    track: Extract<TimelineTrack, { type: "video" }>,
  ): Promise<SceneVideoHandle> {
    void track;
    const handle = new FakeVideoHandle(element);
    this.videos.push(handle);
    return handle;
  }

  captureThumbnail(): string | null {
    return "data:image/png;base64,AAA";
  }
}

class FakeVideoHandle implements SceneVideoHandle {
  readonly element: HTMLVideoElement;
  released = false;
  updates = 0;

  constructor(element: HTMLVideoElement) {
    this.element = element;
  }

  updateFrame(): void {
    this.updates += 1;
  }

  setFrame(): void {
    // Geometry application is the surface's own concern.
  }

  release(): void {
    this.released = true;
  }
}

class FakeAudio implements PresentationAudioPort {
  readonly sfx: { asset: string; volume: number }[] = [];
  readonly timelineVolumes: number[] = [];
  readonly videoVolumes: number[] = [];
  readonly settings: Settings[] = [];
  readonly rates: number[] = [];
  reconciled: AudioSnapshot[] = [];
  attached = 0;
  unlocks = 0;
  deferred = 0;
  destroyed = 0;

  async playSfx(asset: string, volume: number): Promise<void> {
    this.sfx.push({ asset, volume });
  }

  attachVideo(): void {
    this.attached += 1;
  }

  setVideoVolume(_element: HTMLVideoElement, volume: number): void {
    this.videoVolumes.push(volume);
  }

  setBgmTimelineVolume(volume: number): void {
    this.timelineVolumes.push(volume);
  }

  currentBgmVolume(): number | undefined {
    return 0.5;
  }

  setPlaybackRate(rate: number): void {
    this.rates.push(rate);
  }

  async reconcile(snapshot: AudioSnapshot): Promise<void> {
    this.reconciled.push(snapshot);
  }

  applySettings(settings: Settings): void {
    this.settings.push(settings);
  }

  async activateDeferred(): Promise<void> {
    this.deferred += 1;
  }

  async unlock(): Promise<void> {
    this.unlocks += 1;
  }

  destroy(): void {
    this.destroyed += 1;
  }
}

interface FakeVideo {
  currentTime: number;
  readonly seeks: number[];
  readonly listeners: Map<string, Set<() => void>>;
  dispatch(type: string): void;
  readonly element: HTMLVideoElement;
  readonly videoFrameCallbacks: (() => void)[];
}

function createFakeVideo(duration = 10): FakeVideo {
  const listeners = new Map<string, Set<() => void>>();
  const seeks: number[] = [];
  const videoFrameCallbacks: (() => void)[] = [];
  let currentTime = 0;
  const record: FakeVideo = {
    seeks,
    listeners,
    videoFrameCallbacks,
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
      seeks.push(value);
    },
    dispatch: (type) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
    element: null as unknown as HTMLVideoElement,
  };
  const element = {
    preload: "",
    crossOrigin: "",
    playsInline: false,
    autoplay: false,
    loop: false,
    controls: false,
    disablePictureInPicture: false,
    muted: true,
    playbackRate: 1,
    paused: true,
    readyState: 4,
    duration,
    videoWidth: 640,
    videoHeight: 360,
    error: null,
    get currentTime() {
      return record.currentTime;
    },
    set currentTime(value: number) {
      record.currentTime = value;
    },
    src: "",
    addEventListener: (type: string, listener: () => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
    play: () => {
      element.paused = false;
      record.dispatch("playing");
      return Promise.resolve();
    },
    pause: () => {
      element.paused = true;
    },
    load: () => undefined,
    removeAttribute: () => undefined,
    requestVideoFrameCallback: (callback: () => void) => {
      videoFrameCallbacks.push(callback);
      return videoFrameCallbacks.length;
    },
    cancelVideoFrameCallback: () => undefined,
  };
  record.element = element as unknown as HTMLVideoElement;
  return record;
}

class FakeDom implements TimelineDomAdapter {
  readonly videos: FakeVideo[] = [];
  private handle = 0;
  private readonly frames = new Map<number, (now: number) => void>();
  private nowMs = 0;

  createVideo(): HTMLVideoElement {
    const video = createFakeVideo();
    this.videos.push(video);
    return video.element;
  }

  requestFrame(callback: (nowMs: number) => void): number {
    this.handle += 1;
    this.frames.set(this.handle, callback);
    return this.handle;
  }

  cancelFrame(handle: number): void {
    this.frames.delete(handle);
  }

  /** Runs every pending animation frame with `deltaMs` of wall time. */
  step(deltaMs = 16): void {
    this.nowMs += deltaMs;
    const pending = [...this.frames.values()];
    this.frames.clear();
    for (const callback of pending) callback(this.nowMs);
  }

  get video(): FakeVideo {
    const video = this.videos[0];
    if (video === undefined) throw new Error("没有视频元素");
    return video;
  }
}

interface Harness {
  session: TimelineSession;
  surface: FakeSurface;
  audio: FakeAudio;
  dom: FakeDom;
}

function createHarness(
  options: {
    decorations?: "always" | "while-playing";
    audioPolicy?: "host" | "preview";
    videoAtEnd?: "release" | "hold";
    diagnostic?: (message: string) => void;
  } = {},
): Harness {
  const surface = new FakeSurface();
  const audio = new FakeAudio();
  const dom = new FakeDom();
  const session = new TimelineSession({
    surface,
    audio,
    dom,
    audioPolicy: options.audioPolicy ?? "preview",
    decorations: options.decorations ?? "while-playing",
    diagnostic: options.diagnostic ?? ((): void => undefined),
    ...(options.videoAtEnd === undefined
      ? {}
      : { videoAtEnd: options.videoAtEnd }),
  });
  return { session, surface, audio, dom };
}

let rafHandle = 0;
const rafCallbacks = new Map<number, (now: number) => void>();
let nowMs = 0;

function pumpFrames(deltaMs: number, times = 1): void {
  for (let index = 0; index < times; index += 1) {
    nowMs += deltaMs;
    const pending = [...rafCallbacks.values()];
    rafCallbacks.clear();
    for (const callback of pending) callback(nowMs);
  }
}

/**
 * Advances wall-clock frames, yielding between them so the session's
 * asynchronous start-up (audio unlock, media priming) has run before the
 * clock registers its first animation frame.
 */
async function advance(deltaMs: number, times = 1): Promise<void> {
  // Let the session's asynchronous start-up (audio unlock, media priming)
  // finish before the clock registers its animation frames.
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
    pumpFrames(deltaMs);
  }
}

beforeEach(() => {
  rafHandle = 0;
  nowMs = 0;
  rafCallbacks.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: (now: number) => void) => {
    rafHandle += 1;
    rafCallbacks.set(rafHandle, callback);
    return rafHandle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    rafCallbacks.delete(handle);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("TimelineSession load", () => {
  it("requires a timeline cue", async () => {
    const { session } = createHarness();
    await expect(
      session.load({
        update: { ...update([], [], 100), cues: [] },
        assets: ASSETS,
      }),
    ).rejects.toThrow("目标 update 不包含 timeline Cue");
  });

  it("restores the snapshot world and reconciles audio", async () => {
    const harness = createHarness();
    const snapshotState = snapshot();
    expect(
      await harness.session.load({
        update: update([SPRITE_TRACK], [], 100),
        assets: ASSETS,
        snapshot: snapshotState,
        world: "restore",
      }),
    ).toBe("loaded");
    expect(harness.surface.stagedWorlds).toEqual(["world"]);
    expect(harness.audio.reconciled).toEqual([snapshotState.audio]);
    expect(harness.surface.characters).toEqual([
      [{ id: "hero", asset: "hero-asset" }],
    ]);
    expect(harness.dom.videos).toHaveLength(0);
  });

  it("continues on the live scene and reads the BGM volume", async () => {
    const harness = createHarness({ decorations: "always" });
    harness.surface.bases = {
      sprites: {
        hero: {
          asset: "hero-asset",
          x: 10,
          y: 20,
          scale: 1,
          scale_x: 1,
          scale_y: 1,
          rotation_deg: 0,
          opacity: 1,
          z: 0,
        },
      },
      buttons: {},
      camera: { ...CAMERA },
      bgmVolume: 1,
    };
    expect(
      await harness.session.load({
        update: update([SPRITE_TRACK], [], 100),
        assets: ASSETS,
      }),
    ).toBe("loaded");
    expect(harness.surface.stagedWorlds).toEqual([]);
    expect(harness.audio.reconciled).toEqual([]);
    // The inherited BGM volume comes from the live audio graph.
    expect(harness.surface.applied.at(-1)?.frame.bgm_volume).toBeCloseTo(0.5);
    expect(harness.surface.characters).toEqual([
      [{ id: "hero", asset: "hero-asset" }],
    ]);
  });

  it("reports a superseded load as stale without committing it", async () => {
    const harness = createHarness();
    let release: (() => void) | null = null;
    harness.surface.prepareDelay = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = harness.session.load({
      update: update([SPRITE_TRACK], [], 100),
      assets: ASSETS,
      snapshot: snapshot(),
      world: "restore",
    });
    const second = harness.session.load({
      update: update([SPRITE_TRACK], [], 100),
      assets: ASSETS,
      snapshot: snapshot(),
      world: "restore",
    });
    release?.();
    expect(await first).toBe("stale");
    expect(await second).toBe("loaded");
    expect(harness.surface.stagedWorlds).toHaveLength(1);
  });

  it("discards a completed preparation that a newer load superseded", async () => {
    const harness = createHarness();
    // The surface finished decoding before it noticed the abort, so a token
    // exists that the session must release instead of holding its textures.
    harness.surface.prepareIgnoresAbort = true;
    let release: (() => void) | null = null;
    harness.surface.prepareDelay = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = harness.session.load({
      update: update([SPRITE_TRACK], [], 100),
      assets: ASSETS,
      snapshot: snapshot(),
      world: "restore",
    });
    const second = harness.session.load({
      update: update([SPRITE_TRACK], [], 100),
      assets: ASSETS,
      snapshot: snapshot(),
      world: "restore",
    });
    release?.();
    expect(await first).toBe("stale");
    expect(await second).toBe("loaded");
    expect(harness.surface.discarded).toHaveLength(1);
    expect(harness.surface.stagedWorlds).toEqual(["world"]);
  });

  it("releases a video and clears the BGM when the load fails", async () => {
    const harness = createHarness();
    harness.surface.ensureCharactersResult = false;
    const result = await harness.session.load({
      update: update([SPRITE_TRACK], [], 100),
      assets: ASSETS,
    });
    expect(result).toBe("stale");
    expect(harness.audio.reconciled).toEqual([]);
  });

  it("prepares a video element with listeners and no audio while silent", async () => {
    const harness = createHarness();
    expect(
      await harness.session.load({
        update: update([VIDEO_TRACK], [], 1_000),
        assets: ASSETS,
      }),
    ).toBe("loaded");
    const video = harness.dom.video;
    expect(video.element.muted).toBe(true);
    expect(harness.audio.attached).toBe(0);
    expect(harness.surface.videos).toHaveLength(1);
    session_release(harness);
  });
});

function session_release(harness: Harness): void {
  harness.session.dispose();
  expect(harness.surface.videos.every((video) => video.released)).toBe(true);
  expect(harness.audio.destroyed).toBe(1);
}

describe("TimelineSession timeline edits", () => {
  it("re-evaluates a keyframe-only edit without re-preparing the scene", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update([SPRITE_TRACK], [], 1_000),
      assets: ASSETS,
    });
    const prepared = harness.surface.prepared.length;
    const edited = update(
      [
        {
          ...SPRITE_TRACK,
          channels: {
            x: [
              { at_ms: 0, value: 0, easing: "linear" },
              { at_ms: 1_000, value: 500, easing: "linear" },
            ],
          },
        } as TimelineTrack,
      ],
      [],
      800,
    );
    expect(harness.session.applyTimelineEdit(edited)).toBe(true);
    expect(harness.surface.prepared).toHaveLength(prepared);
    await harness.session.seek(400, "scrub");
    const object = harness.surface.applied.at(-1)?.frame.objects[0];
    expect(object?.x).toBeCloseTo(200);
    expect(harness.session.durationMs).toBe(800);
    harness.session.dispose();
  });

  it("requires a reload when the edit changes the timeline's assets", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update([SPRITE_TRACK], [], 1_000),
      assets: ASSETS,
    });
    expect(
      harness.session.applyTimelineEdit(update([VIDEO_TRACK], [], 1_000)),
    ).toBe(false);
    expect(
      harness.session.applyTimelineEdit(
        update(
          [
            {
              ...SPRITE_TRACK,
              asset: "other-asset",
            } as TimelineTrack,
          ],
          [],
          1_000,
        ),
      ),
    ).toBe(false);
    harness.session.dispose();
  });

  it("ignores an edit without a loaded timeline", () => {
    const harness = createHarness();
    expect(harness.session.applyTimelineEdit(update([], [], 100))).toBe(false);
    expect(
      harness.session.applyTimelineEdit(update([SPRITE_TRACK], [], 100)),
    ).toBe(false);
    harness.session.dispose();
  });
});

describe("TimelineSession playback", () => {
  it("settles only at the end and reports playing changes", async () => {
    const harness = createHarness();
    const playing: boolean[] = [];
    harness.session.setPlayingListener((value) => playing.push(value));
    await harness.session.load({
      update: update([SPRITE_TRACK], [], 100),
      assets: ASSETS,
    });
    const play = harness.session.play();
    expect(harness.session.playing).toBe(true);
    await advance(80, 4);
    expect(await play).toBe("completed");
    expect(harness.session.playing).toBe(false);
    expect(playing).toEqual([true, false]);
    expect(harness.surface.applied.at(-1)?.frame.elapsed_ms).toBe(100);
    harness.session.dispose();
  });

  it("keeps the play promise pending across pause and resumes it", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update([SPRITE_TRACK], [], 200),
      assets: ASSETS,
    });
    let settled = false;
    const play = harness.session.play().then((outcome) => {
      settled = true;
      return outcome;
    });
    await advance(50, 3);
    harness.session.pause();
    expect(settled).toBe(false);
    await advance(1_000, 3);
    expect(settled).toBe(false);
    const resumed = harness.session.play();
    await advance(1_000, 3);
    expect(await play).toBe("completed");
    expect(await resumed).toBe("completed");
    harness.session.dispose();
  });

  it("pauses and resumes with the host pause", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update([SPRITE_TRACK], [], 200),
      assets: ASSETS,
    });
    void harness.session.play();
    await advance(50, 3);
    const elapsed = harness.session.elapsedMs;
    harness.session.setPaused(true);
    await advance(500, 3);
    expect(harness.session.elapsedMs).toBe(elapsed);
    harness.session.setPaused(false);
    await advance(50, 3);
    expect(harness.session.elapsedMs).toBeGreaterThan(elapsed);
    expect(harness.surface.paused).toEqual([true, false]);
    harness.session.dispose();
  });

  it("skips to the end and suppresses the remaining events", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update(
        [SPRITE_TRACK],
        [{ type: "sfx", id: "late", at_ms: 400, asset: "sfx", volume: 1 }],
        1_000,
      ),
      assets: ASSETS,
    });
    harness.session.setMuted(false);
    const play = harness.session.play();
    await advance(100, 3);
    expect(harness.session.skip()).toBe(true);
    expect(await play).toBe("skipped");
    expect(harness.session.elapsedMs).toBe(1_000);
    expect(harness.audio.sfx).toEqual([]);
    harness.session.dispose();
  });

  it("cancels with failed and releases everything", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update([VIDEO_TRACK], [], 10_000),
      assets: ASSETS,
    });
    const play = harness.session.play();
    await advance(50, 3);
    harness.session.cancel();
    expect(await play).toBe("failed");
    // Cancel releases the element's listeners and its surface handle.
    expect(
      [...harness.dom.video.listeners.values()].every(
        (listeners) => listeners.size === 0,
      ),
    ).toBe(true);
    expect(harness.surface.videos[0]?.released).toBe(true);
    expect(harness.session.elapsedMs).toBe(0);
    expect(harness.session.playing).toBe(false);
    harness.session.dispose();
  });

  it("is idempotent on dispose and destroys the audio session once", () => {
    const harness = createHarness();
    harness.session.dispose();
    harness.session.dispose();
    expect(harness.audio.destroyed).toBe(1);
  });
});

describe("TimelineSession events", () => {
  const events = [
    { type: "sfx", id: "first", at_ms: 0, asset: "sfx", volume: 1 },
    { type: "sfx", id: "second", at_ms: 0, asset: "sfx", volume: 2 },
    { type: "sfx", id: "third", at_ms: 300, asset: "sfx", volume: 3 },
  ];

  it("fires a zero-time event once on the first play, in array order", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update([SPRITE_TRACK], events, 1_000),
      assets: ASSETS,
    });
    harness.session.setMuted(false);
    void harness.session.play();
    await advance(1, 1);
    expect(harness.audio.sfx.map((entry) => entry.volume)).toEqual([1, 2]);
    await advance(200, 3);
    expect(harness.audio.sfx.map((entry) => entry.volume)).toEqual([1, 2, 3]);
    // The zero-time events are consumed, not repeated.
    harness.session.pause();
    await advance(500, 3);
    expect(harness.audio.sfx.map((entry) => entry.volume)).toEqual([1, 2, 3]);
    harness.session.dispose();
  });

  it("stays silent while muted and plays once after unmuting", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update([SPRITE_TRACK], events, 1_000),
      assets: ASSETS,
    });
    void harness.session.play();
    await advance(200, 3);
    expect(harness.audio.sfx).toEqual([]);
    harness.session.dispose();
  });

  it("scrubs silently and re-arms a backwards seek", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update([SPRITE_TRACK], events, 1_000),
      assets: ASSETS,
    });
    harness.session.setMuted(false);
    // A forward scrub is silent, but it also moves the playhead past the
    // events, so they are not reported when playback later crosses them.
    await harness.session.seek(500, "scrub");
    expect(harness.audio.sfx).toEqual([]);
    await harness.session.seek(500, "playback");
    expect(harness.audio.sfx).toEqual([]);

    // A backwards seek re-arms everything from the new position.
    await harness.session.seek(0, "scrub");
    await harness.session.seek(500, "playback");
    expect(harness.audio.sfx.map((entry) => entry.volume)).toEqual([1, 2, 3]);
    // The same position does not fire the consumed events again.
    await harness.session.seek(500, "playback");
    expect(harness.audio.sfx.map((entry) => entry.volume)).toEqual([1, 2, 3]);
    await harness.session.seek(0, "playback");
    await harness.session.seek(500, "playback");
    expect(harness.audio.sfx.map((entry) => entry.volume)).toEqual([
      1, 2, 3, 1, 2, 3,
    ]);
    harness.session.dispose();
  });

  it("starts the first playback frame at the scrubbed position", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update(
        [SPRITE_TRACK],
        [
          { type: "sfx", id: "early", at_ms: 100, asset: "sfx", volume: 1 },
          { type: "sfx", id: "late", at_ms: 900, asset: "sfx", volume: 2 },
        ],
        1_000,
      ),
      assets: ASSETS,
    });
    harness.session.setMuted(false);
    // The editor positions the playhead on its marker before playing.
    await harness.session.seek(500, "scrub");
    const rendered = harness.surface.applied.length;
    void harness.session.play();
    await advance(1, 1);
    const frames = harness.surface.applied
      .slice(rendered)
      .map((entry) => entry.frame.elapsed_ms);
    // The first playback frame continues the scrubbed position: it must not
    // rewind to zero and re-fire the events the user seeked past.
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((elapsed) => elapsed >= 500)).toBe(true);
    expect(harness.audio.sfx).toEqual([]);
    expect(harness.session.elapsedMs).toBeGreaterThanOrEqual(500);
    harness.session.dispose();
  });

  it("consumes crossed one-shot SFX silently while the host fast-forwards", async () => {
    const harness = createHarness({ audioPolicy: "host" });
    await harness.session.load({
      update: update([SPRITE_TRACK], events, 1_000),
      assets: ASSETS,
    });
    harness.session.setOneShotSuppression(true);
    void harness.session.play();
    await advance(1, 1);
    await advance(100, 1);
    expect(harness.audio.sfx).toEqual([]);
    // Lifting the suppression only affects events that were not consumed yet.
    harness.session.setOneShotSuppression(false);
    await advance(300, 1);
    expect(harness.audio.sfx).toEqual([{ asset: "sfx", volume: 3 }]);
    harness.session.dispose();
  });

  it("derives flash and shake from the playhead so both coexist", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update(
        [SPRITE_TRACK],
        [
          {
            type: "screen_effect",
            id: "flash",
            at_ms: 100,
            effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 },
            duration_ms: 400,
          },
          {
            type: "screen_effect",
            id: "shake",
            at_ms: 200,
            effect: {
              type: "shake",
              amplitude_x: 16,
              amplitude_y: 9.6,
              frequency_hz: 18,
              decay: 1,
              seed: 0,
            },
            duration_ms: 400,
          },
        ],
        1_000,
      ),
      assets: ASSETS,
    });
    await harness.session.seek(300, "scrub");
    const effect = harness.surface.effects.at(-1);
    expect(effect?.flash?.startMs).toBe(100);
    expect(effect?.shake?.startMs).toBe(200);
    expect(effect?.elapsedMs).toBe(300);
    harness.session.dispose();
  });

  it("applies the latest starting effect when intervals overlap", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update(
        [SPRITE_TRACK],
        [
          {
            type: "screen_effect",
            id: "early",
            at_ms: 100,
            effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 },
            duration_ms: 900,
          },
          {
            type: "screen_effect",
            id: "late",
            at_ms: 500,
            effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 },
            duration_ms: 400,
          },
        ],
        1_000,
      ),
      assets: ASSETS,
    });
    await harness.session.seek(600, "scrub");
    expect(harness.surface.effects.at(-1)?.flash?.startMs).toBe(500);
    harness.session.dispose();
  });

  it("resolves same-kind shake overlaps on the surface with latest-start and tie-array order", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update(
        [SPRITE_TRACK],
        [
          {
            type: "screen_effect",
            id: "shake-a",
            at_ms: 100,
            effect: {
              type: "shake",
              amplitude_x: 16,
              amplitude_y: 9.6,
              frequency_hz: 18,
              decay: 1,
              seed: 0,
            },
            duration_ms: 900,
          },
          {
            type: "screen_effect",
            id: "shake-b",
            at_ms: 100,
            effect: {
              type: "shake",
              amplitude_x: 16,
              amplitude_y: 9.6,
              frequency_hz: 18,
              decay: 1,
              seed: 0,
            },
            duration_ms: 600,
          },
          {
            type: "screen_effect",
            id: "shake-c",
            at_ms: 500,
            effect: {
              type: "shake",
              amplitude_x: 16,
              amplitude_y: 9.6,
              frequency_hz: 18,
              decay: 1,
              seed: 0,
            },
            duration_ms: 100,
          },
        ],
        1_000,
      ),
      assets: ASSETS,
    });
    // Equal starts: the later array entry reaches the surface.
    await harness.session.seek(300, "scrub");
    expect(harness.surface.effects.at(-1)?.shake).toMatchObject({
      startMs: 100,
      durationMs: 600,
    });
    // A later start supersedes; when it ends the early one is active again.
    await harness.session.seek(550, "scrub");
    expect(harness.surface.effects.at(-1)?.shake).toMatchObject({
      startMs: 500,
      durationMs: 100,
    });
    await harness.session.seek(800, "scrub");
    expect(harness.surface.effects.at(-1)?.shake).toMatchObject({
      startMs: 100,
      durationMs: 900,
    });
    harness.session.dispose();
  });
});

describe("TimelineSession video", () => {
  it("corrects continuous playback only beyond 50ms of drift", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update([VIDEO_TRACK], [], 10_000),
      assets: ASSETS,
    });
    const video = harness.dom.video;
    const play = harness.session.play();
    await advance(16, 5);
    const corrections = video.seeks.length;
    expect(corrections).toBeGreaterThan(0);
    // Just inside the threshold, counting the playhead advance of one frame.
    // The fake element records the test's own assignments too, so each manual
    // write counts as one entry before the session's correction.
    const next = harness.session.elapsedMs / 1_000 + 0.016;
    video.currentTime = next + VIDEO_DRIFT_THRESHOLD_MS / 1_000 / 2;
    pumpFrames(16);
    expect(video.seeks.length).toBe(corrections + 1);
    // Beyond the threshold: corrected.
    video.currentTime = next + (VIDEO_DRIFT_THRESHOLD_MS * 4) / 1_000;
    pumpFrames(16);
    expect(video.seeks.length).toBe(corrections + 3);
    harness.session.cancel();
    await play;
    harness.session.dispose();
  });

  it("does not correct while the element is buffering", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update([VIDEO_TRACK], [], 10_000),
      assets: ASSETS,
    });
    const video = harness.dom.video;
    void harness.session.play();
    await advance(16, 5);
    const before = video.seeks.length;
    expect(before).toBeGreaterThan(0);
    video.dispatch("waiting");
    video.currentTime = 20;
    pumpFrames(16);
    expect(video.seeks.length).toBe(before + 1);
    harness.session.cancel();
    harness.session.dispose();
  });

  it("waits for seeked plus a presented frame while scrubbing", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update([VIDEO_TRACK], [], 10_000),
      assets: ASSETS,
    });
    const video = harness.dom.video;
    let settled = false;
    const seek = harness.session.seek(2_000, "scrub").then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(video.seeks.at(-1)).toBeCloseTo(2);
    expect(settled).toBe(false);
    video.dispatch("seeked");
    await Promise.resolve();
    // The presented frame resolves it.
    for (const callback of video.videoFrameCallbacks) callback();
    await seek;
    expect(settled).toBe(true);
    harness.session.dispose();
  });

  it("reports a scrub seek timeout and keeps the latest seek", async () => {
    const diagnostics: string[] = [];
    const harness = createHarness({
      diagnostic: (message) => diagnostics.push(message),
    });
    await harness.session.load({
      update: update([VIDEO_TRACK], [], 10_000),
      assets: ASSETS,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = harness.session.seek(1_000, "scrub");
    const second = harness.session.seek(2_000, "scrub");
    vi.advanceTimersByTime(3_000);
    await Promise.all([first, second]);
    expect(harness.dom.video.seeks.at(-1)).toBeCloseTo(2);
    expect(
      diagnostics.some((message) => message.includes("视频定位失败")),
    ).toBe(true);
    vi.useRealTimers();
    harness.session.dispose();
  });

  it("abandons a pending scrub seek before a slow replacement releases its media", async () => {
    // Both ways an abandoned seek can outlive its pass: the media layer never
    // finishes it (the diagnostic timeout path) and it finishes after the
    // element was released (the released-handle path).
    for (const settleStaleSeek of [false, true]) {
      const diagnostics: string[] = [];
      const harness = createHarness();
      const dom = createFakeMediaDom();
      const session = new TimelineSession({
        surface: harness.surface,
        audio: harness.audio,
        dom,
        audioPolicy: "host",
        decorations: "always",
        diagnostic: (message) => diagnostics.push(message),
      });
      await session.load({
        update: update([VIDEO_TRACK], [], 10_000),
        assets: ASSETS,
      });
      void session.play();
      await advance(16, 3);
      const element = dom.videos[0]?.element;
      if (element === undefined) throw new Error("缺少媒体元素");
      // The element accepts the next seek but never finishes it by itself.
      const seeks: number[] = [];
      Object.defineProperty(element, "currentTime", {
        configurable: true,
        get: () => 0,
        set: (value: number) => {
          seeks.push(value);
        },
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stale = session.seek(1_000, "scrub");
      await Promise.resolve();
      expect(seeks).toEqual([1]);

      // The replacement is superseded by a preparation that takes longer than
      // the 2s scrub bound; the superseded run releases its media immediately.
      let releasePrepare: (() => void) | null = null;
      harness.surface.prepareDelay = new Promise<void>((resolve) => {
        releasePrepare = resolve;
      });
      const replacement = session.load({
        update: update([VIDEO_TRACK], [], 5_000),
        assets: ASSETS,
        snapshot: snapshot(),
        world: "restore",
      });
      const released = harness.surface.videos[0];
      expect(released?.released).toBe(true);
      const updates = released?.updates ?? 0;
      const rendered = harness.surface.applied.length;
      if (settleStaleSeek) dom.videos[0]?.dispatch("seeked");
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
      // The abandoned seek neither drives the released handle, renders,
      // plays audio nor reports its timeout while the replacement loads.
      expect(released?.updates).toBe(updates);
      vi.advanceTimersByTime(3_000);
      expect(harness.surface.applied).toHaveLength(rendered);
      expect(diagnostics).toEqual([]);

      releasePrepare?.();
      expect(await replacement).toBe("loaded");
      await stale;
      expect(dom.videos[0]?.listenerCount()).toBe(0);
      // The replacement's own deterministic seek is unaffected.
      await session.seek(500, "scrub");
      const media = session.videoState;
      if (media === null) throw new Error("缺少媒体状态");
      expect(
        Math.abs(media.currentTime - media.targetTime),
      ).toBeLessThanOrEqual(0.05);
      vi.useRealTimers();
      session.dispose();
      harness.session.dispose();
    }
  });

  it("follows the rate, silence at fast-forward and mute changes", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update([VIDEO_TRACK], [], 10_000),
      assets: ASSETS,
    });
    harness.session.setMuted(false);
    expect(harness.audio.attached).toBe(1);
    expect(harness.dom.video.element.muted).toBe(false);
    harness.session.setRate(8);
    expect(harness.audio.rates.at(-1)).toBe(8);
    void harness.session.play();
    await advance(100, 3);
    expect(harness.dom.video.element.playbackRate).toBe(8);
    expect(harness.audio.videoVolumes.at(-1)).toBe(0);
    harness.session.setMuted(true);
    expect(harness.dom.video.element.muted).toBe(true);
    harness.session.dispose();
  });

  it("releases the element and its listeners when the timeline ends", async () => {
    const harness = createHarness({ videoAtEnd: "release" });
    await harness.session.load({
      update: update([VIDEO_TRACK], [], 100),
      assets: ASSETS,
    });
    const play = harness.session.play();
    await advance(80, 4);
    expect(await play).toBe("completed");
    expect(harness.surface.videos[0]?.released).toBe(true);
    expect(harness.dom.video.listeners.get("waiting")?.size ?? 0).toBe(0);
    harness.session.dispose();
  });
});

describe("TimelineSession presentation policy", () => {
  it("keeps the terminal frame and stops decorating when playback ends", async () => {
    const harness = createHarness({ decorations: "while-playing" });
    await harness.session.load({
      update: update([SPRITE_TRACK], [], 100),
      assets: ASSETS,
    });
    expect(harness.surface.decorations).toEqual([]);
    const play = harness.session.play();
    expect(harness.surface.decorations).toEqual([true]);
    await advance(80, 4);
    await play;
    expect(harness.surface.decorations).toEqual([true, false]);
    expect(harness.surface.applied.at(-1)?.frame.elapsed_ms).toBe(100);
    expect(harness.surface.applied.at(-1)?.phase).toBe("playhead");
    harness.session.dispose();
  });

  it("applies the preview mute policy and activates deferred audio", async () => {
    const harness = createHarness({ audioPolicy: "preview" });
    harness.session.setMuted(false);
    expect(harness.audio.settings.at(-1)?.master_volume).toBe(1);
    expect(harness.audio.deferred).toBe(1);
    harness.session.setMuted(true);
    expect(harness.audio.settings.at(-1)?.master_volume).toBe(0);
    harness.session.dispose();
  });

  it("leaves the master volume to the host in game mode", async () => {
    const harness = createHarness({ audioPolicy: "host" });
    harness.session.setMuted(false);
    expect(harness.audio.settings).toEqual([]);
    harness.session.dispose();
  });

  it("plays timeline SFX and video audio in host mode without an explicit unmute", async () => {
    // The game never calls `setMuted`; a host session is audible by policy.
    const harness = createHarness({ audioPolicy: "host" });
    await harness.session.load({
      update: update(
        [VIDEO_TRACK],
        [{ type: "sfx", id: "hit", at_ms: 0, asset: "sfx", volume: 1 }],
        1_000,
      ),
      assets: ASSETS,
    });
    expect(harness.dom.video.element.muted).toBe(false);
    expect(harness.audio.attached).toBe(1);
    void harness.session.play();
    await advance(1, 1);
    expect(harness.audio.sfx).toEqual([{ asset: "sfx", volume: 1 }]);
    harness.session.dispose();
  });

  it("positions decorative loops from the playhead on every seek", async () => {
    const harness = createHarness({ decorations: "always" });
    await harness.session.load({
      update: update([SPRITE_TRACK], [], 1_000),
      assets: ASSETS,
    });
    await harness.session.seek(400, "playback");
    expect(harness.surface.applied.at(-1)?.phase).toBe("playhead");
    void harness.session.play();
    await advance(50, 2);
    expect(harness.surface.applied.at(-1)?.phase).toBe("keep");
    harness.session.dispose();
  });

  it("exposes frames with overrides and a thumbnail", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update([SPRITE_TRACK], [], 1_000),
      assets: ASSETS,
    });
    expect(harness.session.frameAt(500).elapsed_ms).toBe(500);
    expect(harness.session.readFrame().elapsed_ms).toBe(0);
    expect(harness.session.captureThumbnail()).toBe(
      "data:image/png;base64,AAA",
    );
    expect(harness.session.readOverrides()).toBe(EMPTY_SCENE_OVERRIDES);
    harness.session.dispose();
  });

  it("ignores seeks without a loaded timeline", async () => {
    const harness = createHarness();
    await harness.session.seek(500, "scrub");
    expect(harness.surface.applied).toEqual([]);
    expect(harness.session.durationMs).toBe(0);
    harness.session.dispose();
  });

  it("lands a deterministically scrubbed video within 50ms of its target", async () => {
    const harness = createHarness();
    // Frame-granularity media: a real codec lands on a frame boundary, not on
    // the exact requested time.
    const dom = createFakeMediaDom({
      durationSeconds: 10,
      seekGranularitySeconds: 1 / 30,
    });
    const session = new TimelineSession({
      surface: harness.surface,
      audio: harness.audio,
      dom,
      audioPolicy: "host",
      decorations: "always",
    });
    await session.load({
      update: update([VIDEO_TRACK], [], 4_000),
      assets: ASSETS,
    });
    for (const elapsed of [0, 1_234, 2_500, 3_999]) {
      await session.seek(elapsed, "scrub");
      const media = session.videoState;
      expect(media).not.toBeNull();
      if (media === null) throw new Error("缺少媒体状态");
      expect(
        Math.abs(media.currentTime - media.targetTime),
      ).toBeLessThanOrEqual(0.05);
      expect(media.muted).toBe(false);
      expect(media.duration).toBe(10);
      // Real decoded frame dimensions are part of the diagnostic seam the
      // parity harness asserts on.
      expect(media.videoWidth).toBe(640);
      expect(media.videoHeight).toBe(360);
      // Scrubbing the same position twice is deterministic.
      await session.seek(elapsed, "scrub");
      expect(session.videoState?.currentTime).toBe(media.currentTime);
    }
    session.dispose();
    harness.session.dispose();
  });

  it("reports a failed video preparation", async () => {
    const harness = createHarness();
    const dom: TimelineDomAdapter = {
      createVideo: () => {
        const video = createFakeVideo();
        video.element.removeAttribute = () => {
          throw new Error("拒绝释放");
        };
        return video.element;
      },
      requestFrame: () => 0,
      cancelFrame: () => undefined,
    };
    const session = new TimelineSession({
      surface: harness.surface,
      audio: harness.audio,
      dom,
      diagnostic: () => undefined,
    });
    await expect(
      session.load({
        update: update([VIDEO_TRACK], [], 1_000),
        assets: {},
      }),
    ).rejects.toThrow("素材尚未解析: clip");
    session.dispose();
    harness.session.dispose();
  });
});

describe("TimelineSession replacement during a run", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Pins wall time to the pumped frame clock so run lengths are exact. */
  function pinWallClock(): void {
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  }

  it("ends the running clock before a replacement cue can drive it", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update([SPRITE_TRACK], [], 1_000),
      assets: ASSETS,
    });
    pinWallClock();
    const playing: boolean[] = [];
    harness.session.setPlayingListener((value) => playing.push(value));
    const play = harness.session.play();
    await advance(100, 2);
    expect(harness.session.elapsedMs).toBe(200);
    expect(harness.session.playing).toBe(true);

    const replacement = harness.session.load({
      update: update([SPRITE_TRACK], [], 5_000),
      assets: ASSETS,
    });
    // The old pass settles synchronously and the stale clock stops before the
    // cue changes: the replacement's own duration now governs the session.
    expect(harness.session.playing).toBe(false);
    expect(playing).toEqual([true, false]);
    expect(await play).toBe("failed");
    expect(await replacement).toBe("loaded");
    expect(harness.session.durationMs).toBe(5_000);
    expect(harness.session.elapsedMs).toBe(0);

    // Nothing of the stale clock survives: pumping renders no frame until the
    // replacement is played, so the new cue cannot run on the old duration.
    await advance(100, 15);
    expect(harness.session.elapsedMs).toBe(0);
    expect(harness.session.playing).toBe(false);

    // The replacement then runs to its own end instead of ending early.
    const replay = harness.session.play();
    await advance(100, 55);
    expect(await replay).toBe("completed");
    expect(harness.session.elapsedMs).toBe(5_000);
    expect(harness.surface.applied.at(-1)?.frame.elapsed_ms).toBe(5_000);
    harness.session.dispose();
  });

  it("settles a paused run when the timeline is replaced", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update([SPRITE_TRACK], [], 2_000),
      assets: ASSETS,
    });
    pinWallClock();
    const play = harness.session.play();
    let outcome: string | null = null;
    void play.then((value) => {
      outcome = value;
    });
    await advance(100, 2);
    harness.session.pause();
    expect(harness.session.playing).toBe(false);
    expect(outcome).toBeNull();

    const replacement = harness.session.load({
      update: update([SPRITE_TRACK], [], 1_000),
      assets: ASSETS,
    });
    expect(await replacement).toBe("loaded");
    await advance(100, 3);
    // A paused run has no frames left to tick; a replacement must still settle
    // it instead of leaving the old play promise pending forever.
    expect(outcome).toBe("failed");
    expect(harness.session.durationMs).toBe(1_000);

    const replay = harness.session.play();
    await advance(100, 12);
    expect(await replay).toBe("completed");
    expect(harness.session.elapsedMs).toBe(1_000);
    harness.session.dispose();
  });

  it("extends a running clock when an edit changes the duration", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update([SPRITE_TRACK], [], 1_000),
      assets: ASSETS,
    });
    pinWallClock();
    const play = harness.session.play();
    await advance(100, 3);
    expect(harness.session.playing).toBe(true);

    expect(
      harness.session.applyTimelineEdit(update([SPRITE_TRACK], [], 3_000)),
    ).toBe(true);
    // The running clock adopts the edited bound: the pass is still running
    // past the old duration and completes at the edited one.
    await advance(100, 15);
    expect(harness.session.playing).toBe(true);
    expect(harness.session.elapsedMs).toBe(1_800);
    await advance(100, 15);
    expect(await play).toBe("completed");
    expect(harness.session.elapsedMs).toBe(3_000);
    harness.session.dispose();
  });

  it("finishes a running clock at a shortened duration", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update([SPRITE_TRACK], [], 4_000),
      assets: ASSETS,
    });
    pinWallClock();
    const play = harness.session.play();
    await advance(100, 5);
    expect(harness.session.elapsedMs).toBe(500);

    expect(
      harness.session.applyTimelineEdit(update([SPRITE_TRACK], [], 1_000)),
    ).toBe(true);
    expect(harness.session.durationMs).toBe(1_000);
    expect(harness.session.elapsedMs).toBe(500);
    await advance(100, 8);
    // The shortened bound ends the pass instead of waiting for the old one.
    expect(harness.session.playing).toBe(false);
    expect(await play).toBe("completed");
    expect(harness.session.elapsedMs).toBe(1_000);
    harness.session.dispose();
  });

  it("re-evaluates a keyframe-only edit without ending the running pass", async () => {
    const harness = createHarness();
    await harness.session.load({
      update: update([SPRITE_TRACK], [], 2_000),
      assets: ASSETS,
    });
    pinWallClock();
    const play = harness.session.play();
    await advance(100, 3);
    const prepared = harness.surface.prepared.length;
    const edited = update(
      [
        {
          ...SPRITE_TRACK,
          channels: {
            x: [
              { at_ms: 0, value: 0, easing: "linear" },
              { at_ms: 1_000, value: 500, easing: "linear" },
            ],
          },
        } as TimelineTrack,
      ],
      [],
      2_000,
    );
    // Ordinary keyframes only change what the evaluator produces: the pass is
    // not restarted and nothing is re-prepared.
    expect(harness.session.applyTimelineEdit(edited)).toBe(true);
    expect(harness.surface.prepared).toHaveLength(prepared);
    expect(harness.session.playing).toBe(true);
    await advance(100, 20);
    expect(await play).toBe("completed");
    expect(harness.session.elapsedMs).toBe(2_000);
    harness.session.dispose();
  });

  it("replaces a running timeline without replaying its events", async () => {
    const harness = createHarness();
    const events = [
      { type: "sfx", id: "zero", at_ms: 0, asset: "sfx", volume: 1 },
      { type: "sfx", id: "late", at_ms: 500, asset: "sfx", volume: 1 },
    ];
    await harness.session.load({
      update: update([SPRITE_TRACK], events, 1_000),
      assets: ASSETS,
    });
    harness.session.setMuted(false);
    const play = harness.session.play();
    await advance(100, 2);
    // The zero-time event fired exactly once on the first play.
    expect(harness.audio.sfx).toEqual([{ asset: "sfx", volume: 1 }]);

    const replacement = harness.session.load({
      update: update([SPRITE_TRACK], events, 1_500),
      assets: ASSETS,
    });
    await advance(100, 10);
    // A stale clock would cross the late event here; the replacement is silent
    // (a load positions its cue the way a scrub does) and re-arms its ledger.
    expect(harness.audio.sfx).toHaveLength(1);
    expect(await play).toBe("failed");
    expect(await replacement).toBe("loaded");

    const replay = harness.session.play();
    await advance(100, 3);
    // The replacement's zero-time event fires once on its own first play.
    expect(harness.audio.sfx).toHaveLength(2);
    await advance(100, 20);
    expect(await replay).toBe("completed");
    expect(harness.audio.sfx).toHaveLength(3);
    harness.session.dispose();
  });

  it("does not re-arm a consumed event at the exact cursor after a paused edit", async () => {
    const harness = createHarness();
    const events = [
      { type: "sfx", id: "zero", at_ms: 0, asset: "sfx", volume: 1 },
      { type: "sfx", id: "cursor", at_ms: 300, asset: "sfx", volume: 2 },
      { type: "sfx", id: "future", at_ms: 900, asset: "sfx", volume: 3 },
    ];
    await harness.session.load({
      update: update([SPRITE_TRACK], events, 1_000),
      assets: ASSETS,
    });
    harness.session.setMuted(false);
    pinWallClock();
    void harness.session.play();
    await advance(100, 3);
    expect(harness.session.elapsedMs).toBe(300);
    expect(harness.audio.sfx.map((entry) => entry.volume)).toEqual([1, 2]);
    harness.session.pause();

    // An ordinary keyframe edit at the exact cursor...
    const edited = update(
      [
        {
          ...SPRITE_TRACK,
          channels: {
            x: [
              { at_ms: 0, value: 0, easing: "linear" },
              { at_ms: 1_000, value: 500, easing: "linear" },
            ],
          },
        } as TimelineTrack,
      ],
      events,
      1_000,
    );
    expect(harness.session.applyTimelineEdit(edited)).toBe(true);
    void harness.session.play();
    await advance(100, 1);
    // ...must not re-arm and re-fire the event the cursor already consumed.
    expect(harness.audio.sfx.map((entry) => entry.volume)).toEqual([1, 2]);
    // Events ahead of the playhead keep firing normally.
    await advance(100, 6);
    expect(harness.audio.sfx.map((entry) => entry.volume)).toEqual([1, 2, 3]);
    harness.session.dispose();
  });

  it("does not re-arm a consumed event at the exact cursor while the pass runs on", async () => {
    const harness = createHarness();
    const events = [
      { type: "sfx", id: "zero", at_ms: 0, asset: "sfx", volume: 1 },
      { type: "sfx", id: "cursor", at_ms: 300, asset: "sfx", volume: 2 },
      { type: "sfx", id: "future", at_ms: 900, asset: "sfx", volume: 3 },
    ];
    await harness.session.load({
      update: update([SPRITE_TRACK], events, 1_000),
      assets: ASSETS,
    });
    harness.session.setMuted(false);
    pinWallClock();
    const play = harness.session.play();
    await advance(100, 3);
    expect(harness.session.elapsedMs).toBe(300);
    expect(harness.audio.sfx.map((entry) => entry.volume)).toEqual([1, 2]);

    const edited = update(
      [
        {
          ...SPRITE_TRACK,
          channels: {
            x: [
              { at_ms: 0, value: 0, easing: "linear" },
              { at_ms: 1_000, value: 500, easing: "linear" },
            ],
          },
        } as TimelineTrack,
      ],
      events,
      1_000,
    );
    expect(harness.session.applyTimelineEdit(edited)).toBe(true);
    expect(harness.session.playing).toBe(true);
    await advance(100, 2);
    // The running pass crosses the cursor again on its next frame; the
    // consumed event stays consumed.
    expect(harness.audio.sfx.map((entry) => entry.volume)).toEqual([1, 2]);
    await advance(100, 5);
    expect(harness.audio.sfx.map((entry) => entry.volume)).toEqual([1, 2, 3]);
    expect(await play).toBe("completed");
    harness.session.dispose();
  });

  it("re-arms a consumed event the edit moved to a later time", async () => {
    const harness = createHarness();
    const events = [
      { type: "sfx", id: "zero", at_ms: 0, asset: "sfx", volume: 1 },
      { type: "sfx", id: "cursor", at_ms: 300, asset: "sfx", volume: 2 },
      { type: "sfx", id: "future", at_ms: 900, asset: "sfx", volume: 3 },
    ];
    await harness.session.load({
      update: update([SPRITE_TRACK], events, 1_000),
      assets: ASSETS,
    });
    harness.session.setMuted(false);
    pinWallClock();
    void harness.session.play();
    await advance(100, 3);
    expect(harness.audio.sfx.map((entry) => entry.volume)).toEqual([1, 2]);
    harness.session.pause();

    // Moving the event is a real edit: it fires again at its new position.
    const moved = [
      { type: "sfx", id: "zero", at_ms: 0, asset: "sfx", volume: 1 },
      { type: "sfx", id: "cursor", at_ms: 500, asset: "sfx", volume: 5 },
      { type: "sfx", id: "future", at_ms: 900, asset: "sfx", volume: 3 },
    ];
    expect(
      harness.session.applyTimelineEdit(update([SPRITE_TRACK], moved, 1_000)),
    ).toBe(true);
    void harness.session.play();
    await advance(100, 2);
    expect(harness.audio.sfx.map((entry) => entry.volume)).toEqual([1, 2, 5]);
    await advance(100, 4);
    expect(harness.audio.sfx.map((entry) => entry.volume)).toEqual([
      1, 2, 5, 3,
    ]);
    harness.session.dispose();
  });
});
