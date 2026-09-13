/**
 * Real-WebGL parity harness for the SceneSurface migration baseline.
 *
 * The page renders the game's `PresentationController` and the editor's
 * `SceneSurface` on two separate canvases from the same generated runtime
 * payload (`/__parity/fixtures.json`, produced by
 * `cargo run -p vectspace-protocol --bin export_parity_fixture`).  It never
 * asserts that the two surfaces are equal: it exposes a step machine that the
 * Node driver (`scripts/check-scene-parity.mjs`) walks, capturing a full-size
 * screenshot plus coarse thumbnail metrics at every observation point.
 * Differences are recorded in `docs/scene-surface-migration-baseline.md` and
 * must not be frozen as desired behaviour.
 */
import type {
  AnimationMap,
  AnimationSource,
} from "@vectspace/presentation-core/image-animation";
import type {
  AssetUrlMap,
  PresentationOutcome,
  RuntimeSnapshot,
  RuntimeUpdate,
  Settings,
  TimelineTrack,
} from "@vectspace/presentation-core/types";
import { UiMotionHost } from "@vectspace/presentation-core/ui-motion";
import type { SceneFrame } from "@vectspace/presentation-core/scene-frame";
import type { TimelineVideoState } from "@vectspace/presentation-core/timeline-session";
import {
  createEditorTimelinePreview,
  type EditorTimelinePreview,
} from "../editor/src/components/timelinePreview";
import { PresentationController } from "../src/engine/presentation";

const FIXTURE_URL = "/__parity/fixtures.json";

const SETTINGS: Settings = {
  master_volume: 0,
  bgm_volume: 0,
  sfx_volume: 0,
  video_volume: 0,
  text_speed_cps: 30,
  text_reveal_animation: "typewriter",
  skip_mode: "disabled",
};

interface ParityAnimationFrame {
  asset: string;
  duration_ms: number;
  path: string;
}

interface ParityAnimation {
  id: string;
  width: number;
  height: number;
  total_duration_ms: number;
  frames: ParityAnimationFrame[];
}

interface ParityAsset {
  id: string;
  kind: string;
  path: string;
  animation?: ParityAnimation;
}

interface ParityTarget {
  id: string;
  scene_id: string;
  node_id: string;
  start_snapshot: RuntimeSnapshot;
  update: RuntimeUpdate;
  trace: { scene_id: string; node_id: string }[];
}

interface ParityFixture {
  schema_version: number;
  game_root: string;
  targets: ParityTarget[];
  assets: ParityAsset[];
}

type TimelineCue = Extract<RuntimeUpdate["cues"][number], { type: "timeline" }>;

interface CaptureRequest {
  target: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ThumbnailSignature {
  bytes: number;
  sha256: string;
  /** 8x8 average colour grid, packed as 0xRRGGBB. */
  grid: number[];
}

interface EditorFrameRecord {
  elapsed_ms: number;
  /** How the playhead reached this position (playback-mode seeks differ from
   * deterministic scrubs and only the latter assert the media drift bound). */
  mode: "scrub" | "playback";
  camera: { x: number; y: number; zoom: number; rotation_deg: number };
  objects: {
    id: string;
    kind: string;
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
    opacity: number;
    z: number;
    asset: string;
  }[];
  /** Media element state at this observation point (`null` without a video). */
  media: {
    muted: boolean;
    paused: boolean;
    currentTime: number;
    targetTime: number;
    duration: number;
    readyState: number;
    videoWidth: number;
    videoHeight: number;
  } | null;
}

interface VideoGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One nonzero observation of the real HTMLVideoElement behind a video track. */
interface VideoObservation {
  step: string;
  host: "game" | "editor";
  mode: "scrub" | "playback";
  elapsedMs: number;
  media: TimelineVideoState | null;
  geometry: VideoGeometry | null;
}

/** One executed browser video assertion; the driver fails on any `ok:false`. */
interface VideoCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface TargetVideoReport {
  /** True when the target's timeline carries a video track. */
  fixture: boolean;
  asset: string;
  checks: VideoCheck[];
  observations: VideoObservation[];
  latestSeek: {
    firstTargetMs: number;
    lastTargetMs: number;
    currentTime: number;
    targetTime: number;
  } | null;
  cancelReleased: boolean | null;
  reloadState: {
    name: string;
    currentTime: number;
    targetTime: number;
    duration: number;
    readyState: number;
    videoWidth: number;
    videoHeight: number;
  } | null;
}

interface TargetReport {
  id: string;
  scene_id: string;
  node_id: string;
  game: {
    outcome: PresentationOutcome | null;
    /** Outcome of re-presenting the target and cancelling mid-play. */
    cancelledOutcome: PresentationOutcome | null;
    captures: string[];
  };
  editor: { frames: EditorFrameRecord[]; captures: string[] };
  trace: number;
  /** Media state right after a session cancel (must release the element). */
  cancelledMedia: EditorFrameRecord["media"];
  /** Real-video fixture checks for targets whose timeline carries a video. */
  video: TargetVideoReport | null;
  thumbnails: Record<string, ThumbnailSignature | null>;
}

interface ParityReport {
  status: "completed";
  fixture: {
    schema_version: number;
    game_root: string;
    targets: number;
    assets: number;
  };
  webgl: { version: string | null; renderer: string | null };
  /**
   * How each side is observed.  The game's mid point is a wall-clock sample
   * after `present()` and is not comparable across runs; the editor's points
   * are deterministic seeks and are reproducible.  Only the deterministic
   * side may be compared against a target time or a previous run.
   */
  capturePolicy: {
    game: "wall-clock-sample";
    editor: "deterministic-seek";
  };
  targets: TargetReport[];
  diagnostics: string[];
  errors: { step: string; message: string }[];
}

interface Step {
  target: string;
  name: string;
  run(): Promise<CaptureRequest | null>;
}

interface PendingCapture {
  dataUrl: string | null;
}

type StepResult =
  | { done: false; capture: CaptureRequest }
  | { done: true; report: ParityReport };

type ParityStatus = "preparing" | "ready" | "running" | "completed" | "failed";

declare global {
  interface Window {
    __parity?: {
      status: ParityStatus;
      error: string | null;
      next(): Promise<StepResult>;
    };
  }
}

const gameCanvas = document.getElementById("game") as HTMLCanvasElement;
const editorCanvas = document.getElementById("editor") as HTMLCanvasElement;
const uiMotionHost = new UiMotionHost();

let game: PresentationController | null = null;
let editor: EditorTimelinePreview | null = null;
let fixture: ParityFixture | null = null;
let urls: AssetUrlMap = {};
let animations: AnimationMap = {};
let steps: Step[] = [];
let stepIndex = 0;
const diagnostics: string[] = [];
const errors: { step: string; message: string }[] = [];
const report: ParityReport = {
  status: "completed",
  fixture: { schema_version: 0, game_root: "", targets: 0, assets: 0 },
  webgl: { version: null, renderer: null },
  capturePolicy: { game: "wall-clock-sample", editor: "deterministic-seek" },
  targets: [],
  diagnostics,
  errors,
};

const pendingCaptures = new Map<string, PendingCapture>();

const bridge: NonNullable<Window["__parity"]> = {
  status: "preparing",
  error: null,
  next,
};
window.__parity = bridge;

void boot();

async function boot(): Promise<void> {
  try {
    const response = await fetch(FIXTURE_URL);
    if (!response.ok) {
      throw new Error(`夹具请求失败：HTTP ${response.status}`);
    }
    fixture = (await response.json()) as ParityFixture;
    urls = buildAssetUrls(fixture);
    animations = buildAnimationMap(fixture);
    report.fixture = {
      schema_version: fixture.schema_version,
      game_root: fixture.game_root,
      targets: fixture.targets.length,
      assets: fixture.assets.length,
    };
    steps = buildSteps(fixture);
    bridge.status = "ready";
  } catch (error) {
    bridge.status = "failed";
    bridge.error = errorMessage(error);
  }
}

async function next(): Promise<StepResult> {
  while (true) {
    const step = steps[stepIndex];
    if (step === undefined) {
      bridge.status = "completed";
      return { done: true, report };
    }
    stepIndex += 1;
    try {
      const capture = await step.run();
      if (capture !== null) {
        return { done: false, capture };
      }
    } catch (error) {
      errors.push({
        step: `${step.target}/${step.name}`,
        message: errorMessage(error),
      });
    }
  }
}

function buildSteps(input: ParityFixture): Step[] {
  const queue: Step[] = [
    {
      target: "prepare",
      name: "init-surfaces",
      run: initSurfaces,
    },
  ];
  for (const target of input.targets) {
    queue.push(...targetSteps(target));
  }
  return queue;
}

async function initSurfaces(): Promise<null> {
  if (game === null) {
    game = new PresentationController(
      gameCanvas,
      SETTINGS,
      (message) => diagnostics.push(`game: ${message}`),
      uiMotionHost,
    );
  }
  if (editor === null) {
    // The harness no longer copies the editor preview policies: it instantiates
    // the same factory the editor workspace uses (silent audio, playhead-driven
    // frame loops, held terminal frame) and only supplies the diagnostic sink.
    const created = createEditorTimelinePreview(editorCanvas, (message) =>
      diagnostics.push(`editor: ${message}`),
    );
    editor = created.preview;
    await created.initialized;
  }
  await game.init();
  game.setAnimationAssets(animations);
  editor.surface.setAnimations(animations);
  const probe = document.createElement("canvas").getContext("webgl2");
  if (probe !== null) {
    report.webgl = {
      version: String(probe.getParameter(probe.VERSION)),
      renderer: String(probe.getParameter(probe.RENDERER)),
    };
  }
  return null;
}

function targetSteps(target: ParityTarget): Step[] {
  const cue = findTimelineCue(target.update);
  const durationMs = cue?.duration_ms ?? 0;
  const midMs = Math.max(1, Math.floor(durationMs / 2));
  const videoTrack = findVideoTrack(target.update);
  const videoReport: TargetVideoReport | null =
    videoTrack === null
      ? null
      : {
          fixture: true,
          asset: videoTrack.asset,
          checks: [],
          observations: [],
          latestSeek: null,
          cancelReleased: null,
          reloadState: null,
        };
  const targetReport: TargetReport = {
    id: target.id,
    scene_id: target.scene_id,
    node_id: target.node_id,
    game: { outcome: null, cancelledOutcome: null, captures: [] },
    editor: { frames: [], captures: [] },
    trace: target.trace.length,
    cancelledMedia: null,
    video: videoReport,
    thumbnails: {},
  };
  report.targets.push(targetReport);
  let presenting: Promise<PresentationOutcome> | null = null;

  const steps: Step[] = [
    {
      target: target.id,
      name: "game-apply-start",
      run: async () => {
        await requireGame().applySnapshotImmediately(
          target.start_snapshot,
          urls,
        );
        return capture(targetReport, "game", gameCanvas, "game-start");
      },
    },
    {
      target: target.id,
      name: "game-present-mid",
      run: async () => {
        presenting = requireGame().present(target.update, urls);
        await delay(midMs);
        if (videoReport !== null) {
          // The game path is a wall-clock presentation: wait (bounded) until
          // the real media element is decoding and within the shared 50ms
          // drift threshold before recording the observation.
          await observeGameVideo(videoReport, "game-mid", midMs);
        }
        return capture(targetReport, "game", gameCanvas, "game-mid");
      },
    },
    {
      target: target.id,
      name: "game-present-settled",
      run: async () => {
        if (presenting !== null) {
          targetReport.game.outcome = await presenting;
          presenting = null;
        }
        if (videoReport !== null) {
          videoCheck(
            videoReport,
            "game-present-settled 完成",
            targetReport.game.outcome === "completed",
            String(targetReport.game.outcome),
          );
          // The game policy releases the media element at the end of a
          // timeline; a surviving element would leak the decoder.
          const after = requireGame().videoState;
          videoCheck(
            videoReport,
            "game-present-settled 释放媒体",
            after === null,
            JSON.stringify(after),
          );
        }
        return capture(targetReport, "game", gameCanvas, "game-settled");
      },
    },
    {
      target: target.id,
      name: "editor-load",
      run: async () => {
        await requireEditorSession().load({
          update: target.update,
          assets: urls,
          snapshot: target.start_snapshot,
          world: "restore",
          animations,
        });
        await requireEditorSession().seek(0, "scrub");
        if (videoReport !== null) {
          await recordEditorScrub(videoReport, "editor-0000", 0);
        }
        recordFrame(targetReport, 0, "scrub");
        return capture(targetReport, "editor", editorCanvas, "editor-0000");
      },
    },
    {
      target: target.id,
      name: "editor-mid",
      run: async () => {
        await requireEditorSession().seek(midMs, "playback");
        if (videoReport !== null) {
          await recordEditorPlaybackSample(videoReport, "editor-mid", midMs);
        }
        recordFrame(targetReport, midMs, "playback");
        return capture(targetReport, "editor", editorCanvas, "editor-mid");
      },
    },
    {
      target: target.id,
      name: "editor-end",
      run: async () => {
        await requireEditorSession().seek(durationMs, "playback");
        if (videoReport !== null) {
          await recordEditorPlaybackSample(
            videoReport,
            "editor-end",
            durationMs,
          );
        }
        recordFrame(targetReport, durationMs, "playback");
        return capture(targetReport, "editor", editorCanvas, "editor-end");
      },
    },
  ];

  if (videoReport !== null) {
    // Deterministic video checks: three nonzero scrub points, an overlapping
    // latest-seek pair and one real continuous-playback window.  Scrub points
    // assert the full 50ms bound; playback is checked separately for progress
    // and drift because it is corrected asynchronously by the clock.
    for (const fraction of [0.25, 0.5, 0.75]) {
      const point = Math.max(1, Math.round(durationMs * fraction));
      steps.push({
        target: target.id,
        name: `editor-video-scrub-${point}`,
        run: async () => {
          await requireEditorSession().seek(point, "scrub");
          await recordEditorScrub(videoReport, `editor-scrub-${point}`, point);
          recordFrame(targetReport, point, "scrub");
          return capture(
            targetReport,
            "editor",
            editorCanvas,
            `editor-video-scrub-${point}`,
          );
        },
      });
    }
    steps.push({
      target: target.id,
      name: "editor-video-latest-seek",
      run: async () => {
        const session = requireEditorSession();
        const firstMs = Math.max(1, Math.round(durationMs * 0.2));
        const lastMs = Math.max(2, Math.round(durationMs * 0.8));
        if (lastMs <= firstMs) {
          throw new Error(
            `视频目标时长不足以验证 latest seek：${durationMs}ms`,
          );
        }
        const first = session.seek(firstMs, "scrub");
        const last = session.seek(lastMs, "scrub");
        await Promise.all([first, last]);
        const media = session.videoState;
        videoReport.latestSeek = {
          firstTargetMs: firstMs,
          lastTargetMs: lastMs,
          currentTime: media?.currentTime ?? -1,
          targetTime: media?.targetTime ?? -1,
        };
        videoCheck(
          videoReport,
          "editor-latest-seek 最后发出者生效",
          media !== null &&
            Math.abs(media.currentTime - lastMs / 1_000) <= 0.05,
          JSON.stringify(videoReport.latestSeek),
        );
        await recordEditorScrub(videoReport, "editor-latest-seek", lastMs);
        recordFrame(targetReport, lastMs, "scrub");
        return capture(
          targetReport,
          "editor",
          editorCanvas,
          "editor-video-latest-seek",
        );
      },
    });
    steps.push({
      target: target.id,
      name: "editor-video-playback",
      run: async () => {
        const session = requireEditorSession();
        const startMs = Math.max(1, Math.round(durationMs * 0.25));
        await session.seek(startMs, "scrub");
        void session.play().catch(() => undefined);
        const samples: TimelineVideoState[] = [];
        const startedAt = performance.now();
        while (performance.now() - startedAt < VIDEO_PLAYBACK_WINDOW_MS) {
          await delay(60);
          const media = session.videoState;
          if (media === null) continue;
          samples.push(media);
          videoReport.observations.push({
            step: "editor-video-playback",
            host: "editor",
            mode: "playback",
            elapsedMs: session.elapsedMs,
            media,
            geometry: videoGeometry(
              session.frameAt(session.elapsedMs),
              videoReport.asset,
            ),
          });
          // Stop once the real element has actually advanced while playing;
          // drift is then evaluated on that live sample.
          const first = samples[0];
          if (
            samples.length >= 2 &&
            first !== undefined &&
            !media.paused &&
            media.currentTime - first.currentTime >= 0.1
          ) {
            break;
          }
        }
        session.pause();
        const firstMedia = samples[0] ?? null;
        const lastMedia = samples.at(-1) ?? null;
        const mediaOk =
          firstMedia !== null &&
          lastMedia !== null &&
          firstMedia.duration > 0 &&
          firstMedia.readyState >= 2 &&
          firstMedia.videoWidth >= 2 &&
          firstMedia.videoHeight >= 2;
        const progressed =
          firstMedia !== null &&
          lastMedia !== null &&
          !lastMedia.paused &&
          lastMedia.currentTime - firstMedia.currentTime >= 0.1;
        const driftOk =
          lastMedia !== null &&
          Math.abs(lastMedia.currentTime - lastMedia.targetTime) <= 0.05;
        videoCheck(
          videoReport,
          "editor-playback 真实媒体推进",
          mediaOk && progressed,
          JSON.stringify({ firstMedia, lastMedia }),
        );
        videoCheck(
          videoReport,
          "editor-playback 漂移 ≤50ms",
          driftOk,
          JSON.stringify({ lastMedia }),
        );
        return capture(
          targetReport,
          "editor",
          editorCanvas,
          "editor-video-playback",
        );
      },
    });
  }

  steps.push(
    {
      target: target.id,
      name: "game-cancel",
      run: async () => {
        // Real browser lifecycle: start the presentation again (new update id
        // so the controller does not dedupe it), cancel it mid-flight and
        // prove the outcome is `failed` with a screenshot of the reset stage.
        const cancelled = requireGame().present(
          { ...target.update, update_id: `${target.update.update_id}:cancel` },
          urls,
        );
        await delay(Math.max(1, Math.floor(midMs / 2)));
        requireGame().cancelCurrentPresentation();
        targetReport.game.cancelledOutcome = await cancelled;
        if (videoReport !== null) {
          const after = requireGame().videoState;
          videoCheck(
            videoReport,
            "game-cancel 释放媒体",
            after === null,
            JSON.stringify(after),
          );
        }
        return capture(targetReport, "game", gameCanvas, "game-cancelled");
      },
    },
    {
      target: target.id,
      name: "editor-cancel-reload",
      run: async () => {
        const session = requireEditorSession();
        session.cancel();
        targetReport.cancelledMedia = session.videoState;
        if (videoReport !== null) {
          videoReport.cancelReleased = session.videoState === null;
          videoCheck(
            videoReport,
            "editor-cancel 释放媒体",
            videoReport.cancelReleased,
            JSON.stringify(targetReport.cancelledMedia),
          );
        }
        await session.load({
          update: target.update,
          assets: urls,
          snapshot: target.start_snapshot,
          world: "restore",
          animations,
        });
        await session.seek(0, "scrub");
        if (videoReport !== null) {
          await recordEditorScrub(videoReport, "editor-cancelled-reload", 0);
          await recordReloadState(videoReport, "editor-cancelled-reload");
        }
        recordFrame(targetReport, 0, "scrub");
        return capture(
          targetReport,
          "editor",
          editorCanvas,
          "editor-cancelled-reload",
        );
      },
    },
    {
      target: target.id,
      name: "editor-reset-reload",
      run: async () => {
        const session = requireEditorSession();
        requireEditor().surface.reset();
        await session.load({
          update: target.update,
          assets: urls,
          snapshot: target.start_snapshot,
          world: "restore",
          animations,
        });
        await session.seek(0, "scrub");
        if (videoReport !== null) {
          await recordEditorScrub(videoReport, "editor-reset-reload", 0);
          await recordReloadState(videoReport, "editor-reset-reload");
        }
        recordFrame(targetReport, 0, "scrub");
        return capture(
          targetReport,
          "editor",
          editorCanvas,
          "editor-reset-reload",
        );
      },
    },
    {
      target: target.id,
      name: "metrics",
      run: async () => {
        for (const name of [
          ...targetReport.game.captures,
          ...targetReport.editor.captures,
        ]) {
          const pending = pendingCaptures.get(captureKey(target.id, name));
          targetReport.thumbnails[name] =
            pending === undefined
              ? null
              : await thumbnailSignature(pending.dataUrl);
        }
        return null;
      },
    },
  );
  return steps;
}

/** Media wait bound for a wall-clock game observation. */
const VIDEO_OBSERVE_TIMEOUT_MS = 3_000;
/** Length of the continuous-playback sampling window. */
const VIDEO_PLAYBACK_WINDOW_MS = 700;
/** Geometry the frozen video fixture authors (locked by game_content.rs too). */
const VIDEO_GEOMETRY = { x: 160, y: 90, width: 1_600, height: 900 };
const VIDEO_GEOMETRY_TOLERANCE = 0.5;

function findVideoTrack(
  update: RuntimeUpdate,
): Extract<TimelineTrack, { type: "video" }> | null {
  for (const candidate of update.cues) {
    if (candidate.type !== "timeline") continue;
    for (const track of candidate.tracks) {
      if (track.type === "video") return track;
    }
  }
  return null;
}

function videoCheck(
  video: TargetVideoReport,
  name: string,
  ok: boolean,
  detail: string,
): void {
  video.checks.push({ name, ok, detail });
}

function videoGeometry(frame: SceneFrame, asset: string): VideoGeometry | null {
  const object = frame.objects.find(
    (candidate) => candidate.kind === "video" && candidate.asset === asset,
  );
  if (object === undefined) return null;
  return {
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
  };
}

function geometryMatchesFixture(geometry: VideoGeometry | null): boolean {
  return (
    geometry !== null &&
    Math.abs(geometry.x - VIDEO_GEOMETRY.x) <= VIDEO_GEOMETRY_TOLERANCE &&
    Math.abs(geometry.y - VIDEO_GEOMETRY.y) <= VIDEO_GEOMETRY_TOLERANCE &&
    Math.abs(geometry.width - VIDEO_GEOMETRY.width) <=
      VIDEO_GEOMETRY_TOLERANCE &&
    Math.abs(geometry.height - VIDEO_GEOMETRY.height) <=
      VIDEO_GEOMETRY_TOLERANCE
  );
}

function mediaIsReady(media: TimelineVideoState | null): boolean {
  return (
    media !== null &&
    Number.isFinite(media.duration) &&
    media.duration > 0 &&
    media.readyState >= 2 &&
    media.videoWidth >= 2 &&
    media.videoHeight >= 2
  );
}

/**
 * Bounded wait until the editor's real media element has current data.
 *
 * A seek that lands on the position the element already reports settles
 * without waiting for the decoder, so the observation waits (bounded) before
 * sampling instead of recording a metadata-only element as ready.
 */
async function waitForEditorMediaReady(boundMs = 2_000): Promise<void> {
  const deadline = performance.now() + boundMs;
  while (performance.now() < deadline) {
    const media = requireEditorSession().videoState;
    if (
      media !== null &&
      media.readyState >= 2 &&
      media.videoWidth >= 2 &&
      media.videoHeight >= 2
    ) {
      return;
    }
    await delay(50);
  }
}

/** Deterministic editor scrub: media time must land within the 50ms bound. */
async function recordEditorScrub(
  video: TargetVideoReport,
  step: string,
  elapsedMs: number,
): Promise<void> {
  // Bounded wait until the real element has current data: a seek that lands
  // on the already-current position settles without waiting for the decoder.
  await waitForEditorMediaReady();
  const session = requireEditorSession();
  const media = session.videoState;
  const geometry = videoGeometry(session.frameAt(elapsedMs), video.asset);
  const expected = elapsedMs / 1_000;
  video.observations.push({
    step,
    host: "editor",
    mode: "scrub",
    elapsedMs,
    media,
    geometry,
  });
  videoCheck(
    video,
    `${step} 真实媒体就绪`,
    mediaIsReady(media),
    JSON.stringify(media),
  );
  videoCheck(
    video,
    `${step} 定位误差 ≤50ms`,
    media !== null && Math.abs(media.currentTime - expected) <= 0.05,
    JSON.stringify({
      expectedSeconds: expected,
      currentTime: media?.currentTime ?? null,
    }),
  );
  videoCheck(
    video,
    `${step} 目标时间`,
    media !== null && Math.abs(media.targetTime - expected) <= 0.001,
    JSON.stringify({
      expectedSeconds: expected,
      targetTime: media?.targetTime ?? null,
    }),
  );
  videoCheck(
    video,
    `${step} 视频几何`,
    geometryMatchesFixture(geometry),
    JSON.stringify(geometry),
  );
}

/** Playback-mode seek: report the sampled media without the scrub bound. */
async function recordEditorPlaybackSample(
  video: TargetVideoReport,
  step: string,
  elapsedMs: number,
): Promise<void> {
  // Playback-mode seeks do not wait for `seeked`; give the real decoder a
  // bounded chance to reach current data before recording the observation.
  await waitForEditorMediaReady();
  const session = requireEditorSession();
  const media = session.videoState;
  video.observations.push({
    step,
    host: "editor",
    mode: "playback",
    elapsedMs,
    media,
    geometry: videoGeometry(session.frameAt(elapsedMs), video.asset),
  });
  videoCheck(
    video,
    `${step} 真实媒体就绪`,
    mediaIsReady(media),
    JSON.stringify(media),
  );
}

async function recordReloadState(
  video: TargetVideoReport,
  name: string,
): Promise<void> {
  await waitForEditorMediaReady();
  const media = requireEditorSession().videoState;
  if (media === null) {
    video.reloadState = null;
  } else {
    video.reloadState = {
      name,
      currentTime: media.currentTime,
      targetTime: media.targetTime,
      duration: media.duration,
      readyState: media.readyState,
      videoWidth: media.videoWidth,
      videoHeight: media.videoHeight,
    };
  }
  videoCheck(
    video,
    `${name} 重载后媒体就绪`,
    mediaIsReady(media) && Math.abs(media?.currentTime ?? -1) <= 0.05,
    JSON.stringify(video.reloadState),
  );
}

async function observeGameVideo(
  video: TargetVideoReport,
  step: string,
  elapsedMs: number,
): Promise<void> {
  const deadline = performance.now() + VIDEO_OBSERVE_TIMEOUT_MS;
  let media: TimelineVideoState | null = null;
  while (performance.now() < deadline) {
    media = requireGame().videoState;
    if (
      media !== null &&
      mediaIsReady(media) &&
      media.currentTime > 0.01 &&
      Math.abs(media.currentTime - media.targetTime) <= 0.05
    ) {
      break;
    }
    await delay(50);
  }
  const geometry = videoGeometry(requireGame().readFrame(), video.asset);
  video.observations.push({
    step,
    host: "game",
    mode: "playback",
    elapsedMs,
    media,
    geometry,
  });
  videoCheck(
    video,
    `${step} 真实媒体推进`,
    mediaIsReady(media) && (media?.currentTime ?? 0) > 0.01,
    JSON.stringify(media),
  );
  videoCheck(
    video,
    `${step} 漂移 ≤50ms`,
    media !== null && Math.abs(media.currentTime - media.targetTime) <= 0.05,
    JSON.stringify(media),
  );
  videoCheck(
    video,
    `${step} 视频几何`,
    geometryMatchesFixture(geometry),
    JSON.stringify(geometry),
  );
}

function capture(
  targetReport: TargetReport,
  surface: "game" | "editor",
  canvas: HTMLCanvasElement,
  name: string,
): CaptureRequest {
  const controller = surface === "game" ? game : (editor?.surface ?? null);
  const dataUrl =
    controller === null ? null : (controller.captureThumbnail() ?? null);
  pendingCaptures.set(captureKey(targetReport.id, name), { dataUrl });
  targetReport[surface].captures.push(name);
  const rect = canvas.getBoundingClientRect();
  return {
    target: targetReport.id,
    name,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function recordFrame(
  targetReport: TargetReport,
  elapsedMs: number,
  mode: "scrub" | "playback",
): void {
  const session = requireEditorSession();
  const frame = session.frameAt(elapsedMs);
  const media = session.videoState;
  targetReport.editor.frames.push({
    elapsed_ms: frame.elapsed_ms,
    mode,
    camera: {
      x: frame.camera.x,
      y: frame.camera.y,
      zoom: frame.camera.zoom,
      rotation_deg: frame.camera.rotation_deg,
    },
    objects: frame.objects.map((object) => ({
      id: object.id,
      kind: object.kind,
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
      scale: object.scale,
      opacity: object.opacity,
      z: object.z,
      asset: object.asset,
    })),
    media:
      media === null
        ? null
        : {
            muted: media.muted,
            paused: media.paused,
            currentTime: media.currentTime,
            targetTime: media.targetTime,
            duration: media.duration,
            readyState: media.readyState,
            videoWidth: media.videoWidth,
            videoHeight: media.videoHeight,
          },
  });
}

function requireGame(): PresentationController {
  if (game === null) {
    throw new Error("游戏表面尚未初始化");
  }
  return game;
}

function requireEditorSession(): EditorTimelinePreview["session"] {
  if (editor === null) {
    throw new Error("编辑器会话尚未初始化");
  }
  return editor.session;
}

function requireEditor(): EditorTimelinePreview {
  if (editor === null) {
    throw new Error("编辑器表面尚未初始化");
  }
  return editor;
}

function captureKey(targetId: string, name: string): string {
  return `${targetId}/${name}`;
}

function findTimelineCue(update: RuntimeUpdate): TimelineCue | null {
  return (
    update.cues.find(
      (candidate): candidate is TimelineCue => candidate.type === "timeline",
    ) ?? null
  );
}

function buildAssetUrls(parity: ParityFixture): AssetUrlMap {
  const map: Record<string, string> = {};
  for (const asset of parity.assets) {
    map[asset.id] = assetUrl(asset.path);
  }
  return map;
}

function buildAnimationMap(parity: ParityFixture): AnimationMap {
  const map: Record<string, AnimationSource> = {};
  for (const asset of parity.assets) {
    const animation = asset.animation;
    if (animation === undefined) {
      continue;
    }
    map[asset.id] = {
      id: animation.id,
      width: animation.width,
      height: animation.height,
      total_duration_ms: animation.total_duration_ms,
      frames: animation.frames.map((frame) => ({
        asset: frame.asset,
        url: assetUrl(frame.path),
        duration_ms: frame.duration_ms,
      })),
    };
  }
  return map;
}

function assetUrl(path: string): string {
  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/${encoded}`;
}

async function thumbnailSignature(
  dataUrl: string | null,
): Promise<ThumbnailSignature | null> {
  if (dataUrl === null) {
    return null;
  }
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 8;
  const context = canvas.getContext("2d");
  if (context === null) {
    return null;
  }
  context.drawImage(image, 0, 0, 8, 8);
  const pixels = context.getImageData(0, 0, 8, 8).data;
  const grid: number[] = [];
  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index] ?? 0;
    const green = pixels[index + 1] ?? 0;
    const blue = pixels[index + 2] ?? 0;
    grid.push((red << 16) | (green << 8) | blue);
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(dataUrl),
  );
  const sha256 = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { bytes: dataUrl.length, sha256, grid };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    window.setTimeout(resolveDelay, milliseconds);
  });
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
