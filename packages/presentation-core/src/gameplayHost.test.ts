// @vitest-environment jsdom
/**
 * Game host integration tests.
 *
 * These exercise the real `PresentationController` + `TimelineSession` +
 * `SceneSurface` ownership code against the in-memory render/media kits.  They
 * cover the wiring the parity entry only walked through its happy path:
 * default audibility, host settings, fast-forward one-shot suppression at 1x
 * and 8x, and the cancellation/stale-callback boundaries between two
 * presentations.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { AudioManager } from "./audio";
import {
  createFramePump,
  createMemoryKit,
  createMemoryTextureLoader,
  type FramePump,
  type MemoryKit,
} from "./sceneTestKit";
import { createFakeMediaDom, type FakeMediaDom } from "./sessionTestKit";
import { UiMotionHost } from "./uiMotion";

import { PresentationController } from "./gameplayHost";
import { SceneSurface } from "./sceneSurface";
import type {
  AmbienceSlot,
  AssetUrlMap,
  LoopingAudioSnapshot,
  PresentationOutcome,
  RuntimeSnapshot,
  RuntimeUpdate,
  Settings,
} from "./types";

const SETTINGS: Settings = {
  master_volume: 1,
  bgm_volume: 1,
  sfx_volume: 1,
  video_volume: 1,
  ambience_volume: 0.8,
  text_speed_cps: 30,
  text_reveal_animation: "typewriter",
  skip_mode: "disabled",
};

const ASSETS: AssetUrlMap = {
  "sfx.boom": "/sfx/boom.wav",
  "ambience.one": "/ambience/one.mp3",
  "ambience.two": "/ambience/two.mp3",
  "ambience.three": "/ambience/three.mp3",
  "bgm.track": "/bgm/track.mp3",
  "video.clip": "/video/clip.mp4",
  "sprite.alice": "/sprite/alice.png",
  "bg.room": "/bg/room.png",
};

function snapshot(cameraX = 0): RuntimeSnapshot {
  return {
    session_id: "1",
    mode: "story",
    revision: "1",
    location: { scene_id: "scene", node_id: "node" },
    variables: {},
    world: {
      background: "bg.room",
      sprites: {},
      buttons: {},
      camera: { x: cameraX, y: 0, zoom: 1, rotation_deg: 0 },
      dialogue_ui_visible: true,
      ui_motion_bindings: {},
      persistent_effects: [],
    },
    audio: { bgm: null },
    playback: { auto: "normal", ctrl_fast_forward: "allow" },
    prompt: { kind: "none" },
  };
}

interface TimelineOptions {
  updateId?: string;
  durationMs?: number;
  withVideo?: boolean;
  withSprite?: boolean;
  events?: unknown[];
}

function timelineUpdate(options: TimelineOptions = {}): RuntimeUpdate {
  return {
    session_id: "1",
    mode: "story",
    update_id: options.updateId ?? "timeline",
    snapshot: snapshot(),
    requires_ack: false,
    cues: [
      {
        cue_id: "1",
        gate: "runtime",
        type: "timeline",
        presentation_id: "presentation",
        duration_ms: options.durationMs ?? 10_000,
        skippable: true,
        is_seen: true,
        tracks: [
          { type: "camera", channels: {} },
          ...(options.withSprite === true
            ? [
                {
                  type: "sprite" as const,
                  sprite_id: "alice",
                  asset: "sprite.alice",
                  remove_at_end: false,
                  channels: {},
                },
              ]
            : []),
          ...(options.withVideo === true
            ? [
                {
                  type: "video" as const,
                  asset: "video.clip",
                  clip_start_ms: 0,
                  clip_end_ms: null,
                  loop: false,
                  fit: "contain" as const,
                  audio_enabled: true,
                  channels: {},
                },
              ]
            : []),
        ],
        events: options.events ?? [],
      },
    ],
  } as RuntimeUpdate;
}

function stateUpdate(updateId: string, cameraX: number): RuntimeUpdate {
  return {
    session_id: "1",
    mode: "story",
    update_id: updateId,
    snapshot: snapshot(cameraX),
    requires_ack: false,
    cues: [],
  };
}

interface HostHarness {
  controller: PresentationController;
  kit: MemoryKit;
  textures: ReturnType<typeof createMemoryTextureLoader>;
  dom: FakeMediaDom;
  pump: FramePump;
  diagnostic: ReturnType<typeof vi.fn>;
}

function createHost(settings: Settings = SETTINGS): HostHarness {
  const kit = createMemoryKit();
  const textures = createMemoryTextureLoader();
  const dom = createFakeMediaDom();
  const pump = createFramePump();
  const diagnostic = vi.fn<(message: string) => void>();
  vi.stubGlobal("requestAnimationFrame", pump.request);
  vi.stubGlobal("cancelAnimationFrame", pump.cancel);
  vi.spyOn(performance, "now").mockImplementation(() => pump.now());
  const controller = new PresentationController(
    document.createElement("canvas"),
    settings,
    diagnostic,
    new UiMotionHost(),
    {
      kit: kit.kit,
      requestFrame: pump.request,
      cancelFrame: pump.cancel,
      textureLoader: textures.load,
      dom,
    },
  );
  return { controller, kit, textures, dom, pump, diagnostic };
}

/** Yields the event loop so chained session awaits can finish. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    if (condition()) return;
    await settle();
  }
  throw new Error(`等待超时：${label}`);
}

interface AudioSpies {
  playSfx: MockInstance<AudioManager["playSfx"]>;
  attachVideo: MockInstance<AudioManager["attachVideo"]>;
}

function audioSpies(): AudioSpies {
  return {
    playSfx: vi
      .spyOn(AudioManager.prototype, "playSfx")
      .mockResolvedValue(undefined),
    attachVideo: vi
      .spyOn(AudioManager.prototype, "attachVideo")
      .mockImplementation(() => undefined),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PresentationController timeline wiring", () => {
  it("plays timeline SFX and unmutes the video element by default", async () => {
    const { controller, dom, textures } = createHost();
    const audio = audioSpies();
    await controller.init();
    const playing = controller.present(
      timelineUpdate({
        withVideo: true,
        withSprite: true,
        events: [
          { type: "sfx", id: "boom", at_ms: 0, asset: "sfx.boom", volume: 1 },
        ],
      }),
      ASSETS,
    );
    await waitFor(() => dom.videos[0]?.playCalls === 1, "视频开始播放");
    const video = dom.videos[0];
    if (video === undefined) throw new Error("缺少视频元素");
    expect(video.element.muted).toBe(false);
    expect(audio.attachVideo).toHaveBeenCalledTimes(1);
    await waitFor(() => audio.playSfx.mock.calls.length === 1, "默认播放 SFX");
    expect(audio.playSfx).toHaveBeenCalledWith(
      "sfx.boom",
      1,
      ASSETS,
      expect.any(AbortSignal),
    );
    // The timeline track's character asset was prepared before it was shown.
    expect(textures.loaded.length).toBeGreaterThanOrEqual(1);
    controller.cancelCurrentPresentation();
    expect(await playing).toBe("failed");
    controller.destroy();
  });

  it("exposes the live media state and frame geometry used by the parity harness", async () => {
    const { controller, dom } = createHost();
    audioSpies();
    await controller.init();
    const playing = controller.present(
      timelineUpdate({ withVideo: true }),
      ASSETS,
    );
    // The game path releases the media element at the end of the timeline, so
    // observe the seam while the pass is still running.
    await waitFor(() => controller.videoState !== null, "媒体状态可读");
    const media = controller.videoState;
    expect(media?.duration).toBe(10);
    expect(media?.videoWidth).toBe(640);
    expect(media?.videoHeight).toBe(360);
    const frame = controller.readFrame();
    expect(frame.objects.some((object) => object.kind === "video")).toBe(true);
    controller.cancelCurrentPresentation();
    expect(await playing).toBe("failed");
    expect(controller.videoState).toBeNull();
    expect(dom.videos[0]?.listenerCount()).toBe(0);
    controller.destroy();
  });

  it("keeps SFX and video silent with master volume zero and applies later settings", async () => {
    const { controller, dom } = createHost({ ...SETTINGS, master_volume: 0 });
    const audio = audioSpies();
    await controller.init();
    const playing = controller.present(
      timelineUpdate({
        withVideo: true,
        events: [
          { type: "sfx", id: "boom", at_ms: 0, asset: "sfx.boom", volume: 1 },
        ],
      }),
      ASSETS,
    );
    await waitFor(() => dom.videos[0]?.playCalls === 1, "视频开始播放");
    const video = dom.videos[0];
    if (video === undefined) throw new Error("缺少视频元素");
    expect(video.element.muted).toBe(true);
    expect(audio.attachVideo).not.toHaveBeenCalled();
    expect(audio.playSfx).not.toHaveBeenCalled();

    controller.applySettings({ ...SETTINGS, master_volume: 1 });
    expect(video.element.muted).toBe(false);
    expect(audio.attachVideo).toHaveBeenCalledTimes(1);
    // A later SFX still plays: the session muting is a host setting, not a
    // one-way latch.
    controller.cancelCurrentPresentation();
    expect(await playing).toBe("failed");
    const replay = controller.present(
      timelineUpdate({
        updateId: "audible",
        events: [
          { type: "sfx", id: "boom", at_ms: 0, asset: "sfx.boom", volume: 1 },
        ],
      }),
      ASSETS,
    );
    await waitFor(
      () => audio.playSfx.mock.calls.length === 1,
      "设置后播放 SFX",
    );
    controller.cancelCurrentPresentation();
    expect(await replay).toBe("failed");
    controller.destroy();
  });

  it("renders timeline shader effects and applies the reduced-motion setting", async () => {
    const { controller, kit } = createHost();
    audioSpies();
    await controller.init();
    const playing = controller.present(
      timelineUpdate({
        events: [
          {
            type: "screen_effect",
            id: "split",
            at_ms: 0,
            effect: {
              type: "chromatic_aberration",
              intensity: 20,
              angle_deg: 0,
              center_x: 960,
              center_y: 540,
              edge_weight: 0,
              fade_in: 0,
              fade_out: 0,
            },
            duration_ms: 5_000,
          },
        ],
      }),
      ASSETS,
    );
    const host = kit.shaderHosts[0];
    await waitFor(
      () => host?.current?.chromaticAberration != null,
      "色差滤镜生效",
    );
    expect(host?.current?.chromaticAberration?.offsetX).toBeCloseTo(20);
    controller.applySettings({ ...SETTINGS, reduce_motion: true });
    expect(host?.current?.chromaticAberration?.offsetX).toBeCloseTo(10);
    controller.cancelCurrentPresentation();
    expect(await playing).toBe("failed");
    controller.destroy();
    expect(host?.destroyed).toBe(true);
  });

  it("suppresses crossed one-shot SFX at 1x and 8x and forwards the rate", async () => {
    const { controller, dom } = createHost();
    const audio = audioSpies();
    const rates = vi.spyOn(AudioManager.prototype, "setPlaybackRate");
    await controller.init();
    const event = {
      type: "sfx",
      id: "boom",
      at_ms: 0,
      asset: "sfx.boom",
      volume: 1,
    };

    controller.setPlaybackMode(1, true);
    let playing = controller.present(
      timelineUpdate({
        updateId: "suppressed-1x",
        withVideo: true,
        events: [event],
      }),
      ASSETS,
    );
    await waitFor(() => dom.videos[0]?.playCalls === 1, "1x 视频开始播放");
    expect(audio.playSfx).not.toHaveBeenCalled();
    expect(dom.videos[0]?.element.playbackRate).toBe(1);
    controller.cancelCurrentPresentation();
    expect(await playing).toBe("failed");

    controller.setPlaybackMode(8, true);
    playing = controller.present(
      timelineUpdate({
        updateId: "suppressed-8x",
        withVideo: true,
        events: [event],
      }),
      ASSETS,
    );
    await waitFor(() => dom.videos[1]?.playCalls === 1, "8x 视频开始播放");
    expect(audio.playSfx).not.toHaveBeenCalled();
    expect(dom.videos[1]?.element.playbackRate).toBe(8);
    controller.cancelCurrentPresentation();
    expect(await playing).toBe("failed");

    controller.setPlaybackMode(1, false);
    playing = controller.present(
      timelineUpdate({ updateId: "audible", events: [event] }),
      ASSETS,
    );
    await waitFor(() => audio.playSfx.mock.calls.length === 1, "恢复播放 SFX");
    controller.cancelCurrentPresentation();
    expect(await playing).toBe("failed");
    expect(rates).toHaveBeenLastCalledWith(1);
    controller.destroy();
  });

  it("cancels a superseded playing timeline instead of letting stale frames write", async () => {
    const { controller, kit, dom, pump } = createHost();
    audioSpies();
    await controller.init();
    let firstOutcome: PresentationOutcome | null = null;
    const first = controller.present(
      timelineUpdate({ durationMs: 60_000, withVideo: true }),
      ASSETS,
    );
    void first.then((outcome) => {
      firstOutcome = outcome;
    });
    // Wait until the first timeline is genuinely playing, not merely loading;
    // that is the window in which a supersede leaves a live clock behind.
    await waitFor(() => dom.videos[0]?.playCalls === 1, "首段开始播放");
    pump.step(16);
    await settle();
    expect(firstOutcome).toBeNull();

    expect(await controller.present(stateUpdate("second", 120), ASSETS)).toBe(
      "completed",
    );
    // Flush the frame the committed snapshot marked dirty, then measure.
    pump.step(16);
    await settle();
    // Superseding the first update settles it as failed; without the session
    // cancel it would keep ticking and repaint stale timeline frames.
    expect(firstOutcome).toBe("failed");
    const rendersAfterCommit = kit.renderCount();
    for (let frame = 0; frame < 4; frame += 1) {
      pump.step(16);
      await settle();
    }
    expect(kit.renderCount()).toBe(rendersAfterCommit);
    controller.destroy();
  });

  it("discards a superseded load's stale callbacks", async () => {
    const { controller, dom } = createHost();
    audioSpies();
    await controller.init();
    const first = controller.present(
      timelineUpdate({ updateId: "first", withVideo: true }),
      ASSETS,
    );
    let firstOutcome: PresentationOutcome | null = null;
    void first.then((outcome) => {
      firstOutcome = outcome;
    });
    await waitFor(() => dom.videos[0]?.playCalls === 1, "首段视频开始播放");
    const second = controller.present(
      timelineUpdate({ updateId: "second", withVideo: true }),
      ASSETS,
    );
    await waitFor(() => firstOutcome === "failed", "旧段已判定失败");
    expect(dom.videos[0]?.released).toBe(true);
    expect(dom.videos.length).toBe(2);
    // The replacement owns the live element; the superseded one is released.
    expect(dom.videos[0]?.released).toBe(true);
    expect(dom.videos[0]?.listenerCount()).toBe(0);
    expect(dom.videos[1]?.released).toBe(false);
    controller.cancelCurrentPresentation();
    expect(await second).toBe("failed");
    controller.destroy();
  });

  it("keeps a host pause across a superseding update", async () => {
    const { controller, kit, dom, pump } = createHost();
    audioSpies();
    await controller.init();
    const first = controller.present(
      timelineUpdate({ durationMs: 60_000, withVideo: true }),
      ASSETS,
    );
    await waitFor(() => dom.videos[0]?.playCalls === 1, "首段开始播放");
    controller.setPaused(true);

    // The replacement timeline loads, but a host pause must survive the
    // supersede: its clock stays frozen until the host resumes.
    const second = controller.present(
      timelineUpdate({
        updateId: "paused",
        durationMs: 60_000,
        withVideo: true,
      }),
      ASSETS,
    );
    await waitFor(() => dom.videos[1]?.playCalls === 1, "暂停时新段已装载");
    pump.step(16);
    await settle();
    const pausedRenders = kit.renderCount();
    for (let frame = 0; frame < 3; frame += 1) {
      pump.step(16);
      await settle();
    }
    expect(kit.renderCount()).toBe(pausedRenders);

    controller.setPaused(false);
    pump.step(16);
    await settle();
    pump.step(16);
    await settle();
    expect(kit.renderCount()).toBeGreaterThan(pausedRenders);

    controller.cancelCurrentPresentation();
    expect(await first).toBe("failed");
    expect(await second).toBe("failed");
    controller.destroy();
  });

  it("releases media listeners and stops rendering on cancelCurrentPresentation", async () => {
    const { controller, kit, dom, pump, textures } = createHost();
    const audio = audioSpies();
    await controller.init();
    const playing = controller.present(
      timelineUpdate({ withVideo: true, withSprite: true }),
      ASSETS,
    );
    await waitFor(() => dom.videos[0]?.playCalls === 1, "视频开始播放");
    pump.step(16);
    await settle();

    controller.cancelCurrentPresentation();
    expect(await playing).toBe("failed");
    await settle();
    const video = dom.videos[0];
    if (video === undefined) throw new Error("缺少视频元素");
    expect(video.listenerCount()).toBe(0);
    expect(video.released).toBe(true);
    expect(audio.playSfx).not.toHaveBeenCalled();
    // Flush the frame the timeline already marked dirty before the cancel,
    // then prove the recycled clock writes nothing more.
    pump.step(16);
    await settle();
    const rendersAfterCancel = kit.renderCount();
    for (let frame = 0; frame < 3; frame += 1) {
      pump.step(16);
      await settle();
    }
    expect(kit.renderCount()).toBe(rendersAfterCancel);
    controller.destroy();
    expect(textures.loaded.every((texture) => texture.destroyed)).toBe(true);
  });

  it("orders ambience cues per slot while allowing different slots to run concurrently", async () => {
    const { controller } = createHost();
    const starts: string[] = [];
    const pending = new Map<string, (() => void)[]>();
    const transition = vi
      .spyOn(AudioManager.prototype, "transitionAmbience")
      .mockImplementation(async (slot, target, durationMs): Promise<void> => {
        if (durationMs === 0) return;
        const asset = target?.asset ?? "stop";
        starts.push(`${slot}:${asset}`);
        await new Promise<void>((resolve) => {
          const queue = pending.get(slot) ?? [];
          queue.push(resolve);
          pending.set(slot, queue);
        });
      });
    await controller.init();
    const state = (asset: string) => ({
      asset,
      volume: 1,
      start_ms: 0,
      loop_start_ms: null,
      loop_end_ms: null,
    });
    const playing = controller.present(
      {
        update_id: "ambience-order",
        snapshot: snapshot(),
        cues: [
          {
            cue_id: "one-a",
            gate: "runtime",
            type: "ambience_transition",
            slot: "slot_1",
            from: null,
            to: state("ambience.one"),
            duration_ms: 10,
          },
          {
            cue_id: "one-b",
            gate: "runtime",
            type: "ambience_transition",
            slot: "slot_1",
            from: null,
            to: state("ambience.two"),
            duration_ms: 10,
          },
          {
            cue_id: "two-a",
            gate: "runtime",
            type: "ambience_transition",
            slot: "slot_2",
            from: null,
            to: state("ambience.three"),
            duration_ms: 10,
          },
        ],
        requires_ack: false,
      },
      ASSETS,
    );
    await settle();
    expect(starts).toEqual(["slot_1:ambience.one", "slot_2:ambience.three"]);
    pending.get("slot_1")?.shift()?.();
    await settle();
    expect(starts).toEqual([
      "slot_1:ambience.one",
      "slot_2:ambience.three",
      "slot_1:ambience.two",
    ]);
    pending.get("slot_1")?.shift()?.();
    pending.get("slot_2")?.shift()?.();
    expect(await playing).toBe("completed");
    expect(transition).toHaveBeenCalledTimes(7);
    controller.destroy();
  });

  it("keeps a non-awaited slot-1 timeline from overwriting slot-2", async () => {
    const { controller, pump } = createHost();
    const liveVolumes = new Map<AmbienceSlot, number>([
      ["slot_1", 0.7],
      ["slot_2", 0.4],
    ]);
    const writes: { slot: AmbienceSlot; volume: number }[] = [];
    vi.spyOn(
      AudioManager.prototype,
      "currentAmbienceVolume",
    ).mockImplementation((slot) => liveVolumes.get(slot));
    vi.spyOn(
      AudioManager.prototype,
      "setAmbienceTimelineVolume",
    ).mockImplementation((slot, volume) => {
      writes.push({ slot, volume });
      liveVolumes.set(slot, volume);
    });
    let releaseSlot2: (() => void) | undefined;
    let slot2Started = false;
    const slot2Transition = new Promise<void>((resolve) => {
      releaseSlot2 = resolve;
    });
    vi.spyOn(AudioManager.prototype, "transitionAmbience").mockImplementation(
      (slot, _target, durationMs) => {
        if (durationMs > 0 && slot === "slot_2") {
          slot2Started = true;
          return slot2Transition;
        }
        return Promise.resolve();
      },
    );
    await controller.init();
    const base = timelineUpdate({
      updateId: "ambience-race",
      durationMs: 1_000,
    });
    const timelineCue = base.cues[0];
    if (timelineCue?.type !== "timeline") throw new Error("缺少时间线 Cue");
    const track: Extract<
      (typeof timelineCue.tracks)[number],
      { type: "ambience" }
    > = {
      type: "ambience",
      slot: "slot_1",
      channels: {
        volume: [
          { at_ms: 0, value: 0.2, easing: "linear" },
          { at_ms: 1_000, value: 0.8, easing: "linear" },
        ],
      },
    };
    const target: LoopingAudioSnapshot = {
      asset: "ambience.two",
      volume: 0.5,
      start_ms: 0,
      loop_start_ms: null,
      loop_end_ms: null,
    };
    const playing = controller.present(
      {
        ...base,
        cues: [
          { ...timelineCue, tracks: [...timelineCue.tracks, track] },
          {
            cue_id: "slot-2-transition",
            gate: "runtime",
            type: "ambience_transition",
            slot: "slot_2",
            from: null,
            to: target,
            duration_ms: 100,
          },
        ],
      },
      ASSETS,
    );
    await waitFor(
      () => slot2Started && writes.length > 0,
      "非阻塞时间线和 slot_2 转场启动",
    );
    expect(writes.every((write) => write.slot === "slot_1")).toBe(true);
    const beforeFrames = writes.length;
    for (let frame = 0; frame < 4; frame += 1) {
      pump.step(100);
      await settle();
    }
    expect(writes.length).toBeGreaterThan(beforeFrames);
    expect(
      writes.slice(beforeFrames).every((write) => write.slot === "slot_1"),
    ).toBe(true);
    expect(liveVolumes.get("slot_2")).toBe(0.4);

    releaseSlot2?.();
    for (let frame = 0; frame < 12; frame += 1) {
      pump.step(100);
      await settle();
    }
    expect(await playing).toBe("completed");
    expect(liveVolumes.get("slot_2")).toBe(0.4);
    controller.destroy();
  });

  it("reports one failed ambience cue without cancelling another slot", async () => {
    const { controller } = createHost();
    const transition = vi
      .spyOn(AudioManager.prototype, "transitionAmbience")
      .mockImplementation((slot, _target, durationMs): Promise<void> => {
        if (durationMs > 0 && slot === "slot_1")
          return Promise.reject(new Error("slot 1 failed"));
        return Promise.resolve();
      });
    await controller.init();
    const cue = (cueId: string, slot: "slot_1" | "slot_2") => ({
      cue_id: cueId,
      gate: "runtime" as const,
      type: "ambience_transition" as const,
      slot,
      from: null,
      to: {
        asset: "ambience.one",
        volume: 1,
        start_ms: 0,
        loop_start_ms: null,
        loop_end_ms: null,
      },
      duration_ms: 1,
    });
    const outcome = await controller.present(
      {
        update_id: "ambience-failure",
        snapshot: snapshot(),
        cues: [cue("bad", "slot_1"), cue("good", "slot_2")],
        requires_ack: false,
      },
      ASSETS,
    );
    expect(outcome).toBe("failed");
    expect(transition).toHaveBeenCalledWith(
      "slot_2",
      expect.objectContaining({ asset: "ambience.one" }),
      1,
      ASSETS,
      expect.any(AbortSignal),
    );
    controller.destroy();
  });

  it("reports an audio-only ambience cancellation as failed", async () => {
    const { controller } = createHost();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transition = vi
      .spyOn(AudioManager.prototype, "transitionAmbience")
      .mockReturnValue(blocked);
    await controller.init();
    const playing = controller.present(
      {
        update_id: "ambience-cancel",
        snapshot: snapshot(),
        cues: [
          {
            cue_id: "ambience-cancel-cue",
            gate: "runtime",
            type: "ambience_transition",
            slot: "slot_1",
            from: null,
            to: {
              asset: "ambience.one",
              volume: 0.5,
              start_ms: 0,
              loop_start_ms: null,
              loop_end_ms: null,
            },
            duration_ms: 1_000,
          },
        ],
        requires_ack: false,
      },
      ASSETS,
    );
    await waitFor(() => transition.mock.calls.length === 1, "环境声转场启动");
    controller.cancelCurrentPresentation();
    release?.();
    expect(await playing).toBe("failed");
    controller.destroy();
  });
});

describe("PresentationController BGM timeline dependencies", () => {
  const bgmTrack = {
    type: "bgm" as const,
    channels: {
      volume: [
        { at_ms: 0, value: 0.2, easing: "linear" as const },
        { at_ms: 1_000, value: 0.8, easing: "linear" as const },
      ],
    },
  };

  const bgmCue = {
    cue_id: "bgm-transition",
    gate: "runtime" as const,
    type: "bgm_transition" as const,
    from: null,
    to: {
      asset: "bgm.track",
      volume: 0.6,
      start_ms: 0,
      loop_start_ms: null,
      loop_end_ms: null,
    },
    duration_ms: 1,
  };

  it("orders a later BGM cue after a timeline that owns the BGM resource", async () => {
    const harness = createHost();
    const starts: string[] = [];
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transition = vi
      .spyOn(AudioManager.prototype, "transitionBgm")
      .mockImplementation((target, durationMs) => {
        if (durationMs > 0) {
          starts.push(target?.asset ?? "stop");
          return blocked;
        }
        return Promise.resolve();
      });
    const timelineVolume = vi.spyOn(
      AudioManager.prototype,
      "setBgmTimelineVolume",
    );
    await harness.controller.init();
    const base = timelineUpdate({ updateId: "bgm-order", durationMs: 1_000 });
    const timeline = base.cues[0];
    if (timeline?.type !== "timeline") throw new Error("缺少时间线 Cue");
    const playing = harness.controller.present(
      {
        ...base,
        cues: [{ ...timeline, tracks: [...timeline.tracks, bgmTrack] }, bgmCue],
      },
      ASSETS,
    );
    await waitFor(
      () => timelineVolume.mock.calls.length > 0,
      "BGM 时间线开始定位",
    );
    for (let frame = 0; frame < 3; frame += 1) {
      harness.pump.step(100);
      await settle();
    }
    expect(starts).toEqual([]);
    for (let frame = 0; frame < 12; frame += 1) {
      harness.pump.step(100);
      await settle();
      if (starts.length > 0) break;
    }
    expect(starts).toEqual(["bgm.track"]);
    release?.();
    expect(await playing).toBe("completed");
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({ asset: "bgm.track" }),
      1,
      ASSETS,
      expect.any(AbortSignal),
    );
    harness.controller.destroy();
  });

  it("lets a BGM cue run concurrently with a timeline that has no BGM track", async () => {
    const harness = createHost();
    const starts: string[] = [];
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(AudioManager.prototype, "transitionBgm").mockImplementation(
      (target, durationMs) => {
        if (durationMs > 0) {
          starts.push(target?.asset ?? "stop");
          return blocked;
        }
        return Promise.resolve();
      },
    );
    await harness.controller.init();
    const base = timelineUpdate({
      updateId: "bgm-concurrent",
      durationMs: 1_000,
    });
    const timeline = base.cues[0];
    if (timeline?.type !== "timeline") throw new Error("缺少时间线 Cue");
    const playing = harness.controller.present(
      { ...base, cues: [timeline, bgmCue] },
      ASSETS,
    );
    await waitFor(() => starts.length === 1, "无 BGM 时间线旁的 BGM Cue");
    expect(starts).toEqual(["bgm.track"]);
    release?.();
    for (let frame = 0; frame < 12; frame += 1) {
      harness.pump.step(100);
      await settle();
    }
    expect(await playing).toBe("completed");
    harness.controller.destroy();
  });
});

/**
 * Host-only session curtain.
 *
 * The controller covers the canvas before a session switch, hard-aligns the
 * replacement world while it is fully black (no cue is replayed) and reveals
 * again after the replacement's first stable frame.
 */
describe("PresentationController session curtain", () => {
  const SWITCH_ASSETS: AssetUrlMap = {
    ...ASSETS,
    "bg.other": "/bg/other.png",
  };

  function worldSnapshot(background: string): RuntimeSnapshot {
    const base = snapshot();
    return { ...base, world: { ...base.world, background } };
  }

  function sessionLayer(kit: MemoryKit): { alpha: number }[] {
    return kit.applications[0]?.stage.children[4]?.children ?? [];
  }

  function backgroundUrls(kit: MemoryKit): string[] {
    const children = (kit.applications[0]?.stage.children[0]?.children ?? []) as { texture?: { url?: string } }[];
    return children
      .map((child) => child.texture?.url ?? "")
      .filter((url) => url.length > 0);
  }

  async function pump(harness: HostHarness, frames: number): Promise<void> {
    for (let frame = 0; frame < frames; frame += 1) {
      harness.pump.step(16);
      await settle();
    }
  }

  it("covers before the replacement and reveals after its first frame", async () => {
    const harness = createHost();
    const { controller, kit } = harness;
    await controller.init();
    await controller.applySnapshotImmediately(worldSnapshot("bg.room"), ASSETS);
    await pump(harness, 2);
    expect(backgroundUrls(kit)).toContain("/bg/room.png");

    let settled = false;
    const pending = controller
      .applySessionSnapshot(worldSnapshot("bg.other"), SWITCH_ASSETS)
      .then(() => {
        settled = true;
      });
    const samples: { alpha: number; switched: boolean }[] = [];
    for (let frame = 0; frame < 90; frame += 1) {
      harness.pump.step(16);
      await settle();
      samples.push({
        alpha: sessionLayer(kit)[0]?.alpha ?? 0,
        switched: backgroundUrls(kit).includes("/bg/other.png"),
      });
    }
    await pending;
    expect(settled).toBe(true);

    // 1. The cover fades in before the world changes: the first sample is not
    //    yet opaque and the replacement is not on screen.
    expect(samples[0]?.alpha).toBeLessThan(1);
    expect(samples[0]?.switched).toBe(false);
    // 2. The hard alignment happens while the cover is fully black: no sample
    //    shows the replacement before the cover was opaque.
    const switchIndex = samples.findIndex((sample) => sample.switched);
    expect(switchIndex).toBeGreaterThan(0);
    expect(samples[switchIndex]?.alpha).toBe(1);
    // 3. The reveal only starts after the replacement was drawn once, and the
    //    curtain is gone at the end.
    expect(
      samples.find((sample) => sample.alpha < 1 && sample.switched),
    ).toBeDefined();
    expect(controller.sessionCovered).toBe(false);
    expect(sessionLayer(kit)).toHaveLength(0);
    expect(backgroundUrls(kit)).toContain("/bg/other.png");
    expect(backgroundUrls(kit)).not.toContain("/bg/room.png");
    controller.destroy();
  });

  it("hard-aligns the snapshot without replaying cues", async () => {
    const harness = createHost();
    const { controller, kit } = harness;
    await controller.init();
    const runCue = vi.spyOn(SceneSurface.prototype, "runCue");
    await controller.applySnapshotImmediately(worldSnapshot("bg.room"), ASSETS);
    const base = worldSnapshot("bg.other");
    const covered: RuntimeSnapshot = {
      ...base,
      world: {
        ...base.world,
        curtain: { covered: true, fill: { color: "#000000" } },
      },
    };
    const pending = controller.applySessionSnapshot(covered, SWITCH_ASSETS);
    await pump(harness, 80);
    await pending;
    // The alignment never enters the cue executor: it is a hard reconcile, so
    // no transition/sprite/effect cue is replayed for the old snapshot.
    expect(runCue).not.toHaveBeenCalled();
    // The stable curtain of the snapshot is committed directly ...
    const storyCurtain = kit.applications[0]?.stage.children[3]?.children ?? [];
    expect(storyCurtain.length).toBeGreaterThanOrEqual(1);
    // ... and no cue-owned transient node exists: no fade-through overlay, no
    // wipe mask and no stepped feather strips were created by a replay.
    expect(kit.applications[0]?.stage.children[2]?.children ?? []).toHaveLength(
      0,
    );
    const backgrounds = (kit.applications[0]?.stage.children[0]?.children ?? []) as { label: string; mask: { label: string } | null }[];
    expect(backgrounds.every((child) => child.mask === null || child.mask.label === "layout:__background__")).toBe(true);
    expect(backgrounds.some((child) => child.label.endsWith("#feather"))).toBe(
      false,
    );
    controller.destroy();
  });

  it("clears the curtain when the switch is cancelled mid-cover", async () => {
    const harness = createHost();
    const { controller, kit } = harness;
    await controller.init();
    const pending = controller.applySessionSnapshot(
      worldSnapshot("bg.other"),
      SWITCH_ASSETS,
    );
    await pump(harness, 4);
    expect(controller.sessionCovered).toBe(false);
    expect(sessionLayer(kit).length).toBeGreaterThan(0);

    controller.cancelCurrentPresentation();
    await pending;
    expect(controller.sessionCovered).toBe(false);
    expect(sessionLayer(kit)).toHaveLength(0);
    // The reset frame flushes once, then the released scheduler stops drawing.
    await pump(harness, 3);
    const renders = kit.renderCount();
    await pump(harness, 3);
    expect(kit.renderCount()).toBe(renders);
    controller.destroy();
  });

  it("clears the curtain when the replacement itself fails", async () => {
    const harness = createHost();
    const { controller, kit } = harness;
    await controller.init();
    // The snapshot names an asset that cannot be resolved, so the hard
    // alignment rejects; the curtain must still be released.
    const outcome = controller
      .applySessionSnapshot(worldSnapshot("bg.missing"), ASSETS)
      .then(
        () => null,
        (error: unknown) => error,
      );
    await pump(harness, 80);
    expect(await outcome).toBeInstanceOf(Error);
    expect(controller.sessionCovered).toBe(false);
    expect(sessionLayer(kit)).toHaveLength(0);
    controller.destroy();
  });

  it("releases the curtain and the scheduler on destroy", async () => {
    const harness = createHost();
    const { controller, kit, pump: rawPump } = harness;
    await controller.init();
    const pending = controller.applySessionSnapshot(
      worldSnapshot("bg.other"),
      SWITCH_ASSETS,
    );
    await pump(harness, 4);
    expect(sessionLayer(kit).length).toBeGreaterThan(0);

    // A reveal that is waiting for a drawn frame must be released by destroy
    // instead of hanging on a frame the disposed surface will never draw.
    const reveal = controller.revealSession();
    controller.destroy();
    await reveal;
    await pending;
    expect(controller.sessionCovered).toBe(false);
    expect(kit.applications[0]?.destroyed).toBe(true);
    const renders = kit.renderCount();
    for (let frame = 0; frame < 3; frame += 1) {
      rawPump.step(16);
    }
    expect(kit.renderCount()).toBe(renders);
  });

  it("completes a switch within a bounded time when frames are suspended", async () => {
    const harness = createHost();
    const { controller, kit } = harness;
    await controller.init();
    await controller.applySnapshotImmediately(worldSnapshot("bg.room"), ASSETS);
    await pump(harness, 2);

    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = controller
        .applySessionSnapshot(worldSnapshot("bg.other"), SWITCH_ASSETS)
        .then(() => {
          settled = true;
        });
      // A hidden host never pumps another frame.  The cover/reveal fades and
      // the reveal's frame wait all fall back to bounded watchdogs, so the
      // switch (and the host's busy lock) cannot stay pending forever.
      await vi.advanceTimersByTimeAsync(2_000);
      await pending;
      expect(settled).toBe(true);
      expect(controller.sessionCovered).toBe(false);
      expect(sessionLayer(kit)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
    controller.destroy();
  });
});

describe("PresentationController timer effects", () => {
  const ambience = (asset: string) => ({
    asset,
    volume: 1,
    start_ms: 0,
    loop_start_ms: null,
    loop_end_ms: null,
  });

  function effectUpdate(
    updateId: string,
    cameraX: number,
    asset: string,
    slot: AmbienceSlot = "slot_1",
  ): RuntimeUpdate {
    return {
      session_id: "1",
      mode: "story",
      kind: "effect",
      update_id: updateId,
      snapshot: snapshot(cameraX),
      requires_ack: false,
      cues: [
        {
          cue_id: "1",
          gate: "none",
          type: "ambience_transition",
          slot,
          from: null,
          to: ambience(asset),
          duration_ms: 10,
        },
      ],
    };
  }

  function storyWithDelay(updateId: string, cameraX = 0): RuntimeUpdate {
    return {
      session_id: "1",
      mode: "story",
      update_id: updateId,
      snapshot: snapshot(cameraX),
      requires_ack: false,
      cues: [{ cue_id: "1", gate: "none", type: "delay", duration_ms: 100 }],
    };
  }

  /** Holds every ambience transition until the test resolves it. */
  function holdAmbience(): {
    resolve(index: number): void;
    started: string[];
  } {
    const resolvers: (() => void)[] = [];
    const started: string[] = [];
    vi.spyOn(AudioManager.prototype, "transitionAmbience").mockImplementation(
      async (slot, target, durationMs): Promise<void> => {
        if (durationMs === 0) return;
        started.push(`${slot}:${target?.asset ?? "stop"}`);
        await new Promise<void>((resolve) => resolvers.push(resolve));
      },
    );
    return { resolve: (index) => resolvers[index]?.(), started };
  }

  function committedCameras(): number[] {
    const cameras: number[] = [];
    const original = SceneSurface.prototype.applyWorld;
    vi.spyOn(SceneSurface.prototype, "applyWorld").mockImplementation(function (
      this: SceneSurface,
      preparation,
    ) {
      if (preparation !== null) {
        cameras.push(preparation.world.camera.x);
      }
      return original.call(this, preparation);
    });
    return cameras;
  }

  it("runs an effect beside the story without cancelling or replacing it", async () => {
    const harness = createHost();
    const { controller, pump } = harness;
    await controller.init();
    const held = holdAmbience();
    const story = controller.present(storyWithDelay("story"), ASSETS);
    await settle();
    expect(controller.isPresentationCurrent("story")).toBe(true);

    const effect = controller.runEffect(
      effectUpdate("effect", 7, "ambience.one"),
      ASSETS,
    );
    await settle();
    expect(held.started).toEqual(["slot_1:ambience.one"]);
    // The story keeps its identity and promise while the effect is running.
    expect(controller.isPresentationCurrent("story")).toBe(true);
    held.resolve(0);
    expect(await effect).toBe("completed");
    expect(controller.isPresentationCurrent("story")).toBe(true);

    for (let frame = 0; frame < 20; frame += 1) pump.step(16);
    expect(await story).toBe("completed");
    controller.destroy();
  });

  it("lets the last finisher align the newest snapshot instead of a stale one", async () => {
    const harness = createHost();
    const { controller, pump } = harness;
    await controller.init();
    const held = holdAmbience();
    const cameras = committedCameras();
    const story = controller.present(storyWithDelay("story", 0), ASSETS);
    await settle();
    const effect = controller.runEffect(
      effectUpdate("effect", 7, "ambience.one"),
      ASSETS,
    );
    await settle();
    held.resolve(0);
    expect(await effect).toBe("completed");
    // The story is still presenting, so the effect must not commit a world
    // (that would silence the story's running cue).
    expect(cameras).toEqual([]);

    for (let frame = 0; frame < 20; frame += 1) pump.step(16);
    expect(await story).toBe("completed");
    // The story then aligns to the newest snapshot, which includes the effect.
    expect(cameras).toEqual([7]);
    controller.destroy();
  });

  it("supersedes an older effect on the same resource without a stale reconcile", async () => {
    const harness = createHost();
    const { controller } = harness;
    await controller.init();
    const held = holdAmbience();
    const cameras = committedCameras();
    const first = controller.runEffect(
      effectUpdate("effect-1", 1, "ambience.one"),
      ASSETS,
    );
    await settle();
    const second = controller.runEffect(
      effectUpdate("effect-2", 2, "ambience.two"),
      ASSETS,
    );
    await settle();
    // The superseded effect settles as failed and never reconciles.
    held.resolve(0);
    held.resolve(1);
    expect(await first).toBe("failed");
    expect(await second).toBe("completed");
    expect(cameras).toEqual([2]);
    controller.destroy();
  });

  it("keeps effects on different resources running together", async () => {
    const harness = createHost();
    const { controller } = harness;
    await controller.init();
    const held = holdAmbience();
    const cameras = committedCameras();
    const first = controller.runEffect(
      effectUpdate("effect-1", 1, "ambience.one", "slot_1"),
      ASSETS,
    );
    await settle();
    const second = controller.runEffect(
      effectUpdate("effect-2", 2, "ambience.two", "slot_2"),
      ASSETS,
    );
    await settle();
    expect(held.started).toEqual([
      "slot_1:ambience.one",
      "slot_2:ambience.two",
    ]);
    held.resolve(0);
    expect(await first).toBe("completed");
    // Only the last one to finish commits the world, with the newest snapshot.
    expect(cameras).toEqual([]);
    held.resolve(1);
    expect(await second).toBe("completed");
    expect(cameras).toEqual([2]);
    controller.destroy();
  });

  it("cancels in-flight effects when a story update takes over", async () => {
    const harness = createHost();
    const { controller } = harness;
    await controller.init();
    const held = holdAmbience();
    const effect = controller.runEffect(
      effectUpdate("effect", 3, "ambience.one"),
      ASSETS,
    );
    await settle();
    const next = controller.present(stateUpdate("story-2", 9), ASSETS);
    held.resolve(0);
    expect(await effect).toBe("failed");
    expect(await next).toBe("completed");
    controller.destroy();
  });
});
