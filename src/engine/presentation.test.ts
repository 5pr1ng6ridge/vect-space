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

import { AudioManager } from "@vectspace/presentation-core/audio";
import {
  createFramePump,
  createMemoryKit,
  createMemoryTextureLoader,
  type FramePump,
  type MemoryKit,
} from "@vectspace/presentation-core/scene-test-kit";
import {
  createFakeMediaDom,
  type FakeMediaDom,
} from "@vectspace/presentation-core/session-test-kit";
import { UiMotionHost } from "@vectspace/presentation-core/ui-motion";

import { PresentationController } from "./presentation";
import type {
  AssetUrlMap,
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
  text_speed_cps: 30,
  text_reveal_animation: "typewriter",
  skip_mode: "disabled",
};

const ASSETS: AssetUrlMap = {
  "sfx.boom": "/sfx/boom.wav",
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
});
