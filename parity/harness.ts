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
import type { AudioDiagnostics } from "@vectspace/presentation-core/audio";
import type {
  AmbienceSlot,
  AssetUrlMap,
  ButtonSnapshot,
  ChoicePrompt,
  ChoiceSnapshot,
  PresentationCue,
  PresentationOutcome,
  RuntimeSnapshot,
  RuntimeUpdate,
  Settings,
  TimelineTrack,
} from "@vectspace/presentation-core/types";
import { UiMotionHost } from "@vectspace/presentation-core/ui-motion";
import type { SceneFrame } from "@vectspace/presentation-core/scene-frame";
import { evaluateTimelineFrame } from "@vectspace/presentation-core/timeline-evaluator";
import type { TimelineVideoState } from "@vectspace/presentation-core/timeline-session";
import "katex/dist/katex.min.css";
import { ChoiceLayer } from "@vectspace/presentation-react/choice";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
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
  ambience_volume: 0.8,
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

interface AmbienceObservation {
  host: "game" | "editor";
  step: string;
  slots: Record<
    "slot_1" | "slot_2" | "slot_3" | "slot_4",
    {
      asset: string;
      volume: number;
      paused: boolean;
      current_time: number;
    } | null
  >;
  bus_volume: number | null;
  context_state: AudioContextState | null;
}

interface AmbienceAutomationExpectation {
  duration_ms: number;
  values: Record<
    AmbienceSlot,
    { start: number | null; mid: number | null; end: number | null }
  >;
}

interface TargetAmbienceReport {
  fixture: boolean;
  /** Snapshot before the target update is presented. */
  expected: Record<AmbienceSlot, string | null>;
  /** Snapshot committed by a post-demo replacement/stop node. */
  expected_after: Record<AmbienceSlot, string | null>;
  /** Authored volumes restored by the game after a timeline completes. */
  snapshot_volumes: Record<AmbienceSlot, number | null>;
  automation: AmbienceAutomationExpectation | null;
  transition: { slot: AmbienceSlot; asset: string | null } | null;
  /** Same-slot/same-asset retune metadata; game diagnostics prove head retention. */
  retune: {
    slot: AmbienceSlot;
    asset: string;
    start_ms: number;
    loop_start_ms: number | null;
    loop_end_ms: number | null;
  } | null;
  observations: AmbienceObservation[];
  checks: VideoCheck[];
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

interface ChoiceLayoutProbeCase {
  host: "game" | "editor";
  mode: "separate" | "overlay";
  button: { x: number; y: number; width: number; height: number };
  images: {
    x: number;
    y: number;
    width: number;
    height: number;
  }[];
  content: { x: number; y: number; width: number; height: number };
  icon: { x: number; y: number; width: number; height: number };
  formula: { x: number; y: number; width: number; height: number };
  fallback: { x: number; y: number; width: number; height: number };
  imageBoxesMatchButton: boolean;
  fallbackHeightMatches: boolean;
  contentOverlaysArtwork: boolean;
}

interface ChoiceLayoutProbeReport {
  cases: ChoiceLayoutProbeCase[];
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
  /** Four-slot audio diagnostics from the shared game/editor seam. */
  ambience: TargetAmbienceReport | null;
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
  choiceLayout: ChoiceLayoutProbeReport;
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
  choiceLayout: { cases: [] },
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
  await runChoiceLayoutProbe();
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
  const ambienceReport = buildAmbienceReport(target);
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
    ambience: ambienceReport,
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
        recordAmbience(
          targetReport.ambience,
          "game",
          "game-start",
          requireGame().audioDiagnostics,
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
        recordAmbience(
          targetReport.ambience,
          "game",
          "game-mid",
          requireGame().audioDiagnostics,
        );
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
        if (targetReport.ambience !== null) {
          // Gain changes are scheduled on the real audio clock. Allow one
          // bounded render turn before reading the post-presentation values.
          await delay(75);
        }
        recordAmbience(
          targetReport.ambience,
          "game",
          "game-end",
          requireGame().audioDiagnostics,
        );
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
        requireEditorSession().setMuted(true);
        await requireEditorSession().load({
          update: editorCompatibleUpdate(target),
          assets: urls,
          snapshot: target.start_snapshot,
          world: "restore",
          animations,
        });
        recordAmbience(
          targetReport.ambience,
          "editor",
          "editor-pre-unlock",
          requireEditorSession().audioDiagnostics,
        );
        await requireEditorSession().seek(0, "scrub");
        if (targetReport.ambience !== null) {
          requireEditorSession().setMuted(false);
          await waitForEditorAmbience(targetReport.ambience.expected);
        }
        recordAmbience(
          targetReport.ambience,
          "editor",
          "editor-0000",
          requireEditorSession().audioDiagnostics,
        );
        if (
          targetReport.ambience !== null &&
          targetReport.ambience.transition !== null
        ) {
          requireEditorSession().setMuted(true);
          await requireEditorSession().load({
            update: editorCompatibleUpdate(target),
            assets: urls,
            snapshot: target.update.snapshot,
            world: "restore",
            animations,
          });
          await requireEditorSession().seek(0, "scrub");
          requireEditorSession().setMuted(false);
          await waitForEditorAmbience(targetReport.ambience.expected_after);
          recordAmbience(
            targetReport.ambience,
            "editor",
            "editor-transition-settled",
            requireEditorSession().audioDiagnostics,
          );
        }
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
        if (targetReport.ambience !== null)
          await waitForEditorAmbience(
            targetReport.ambience.transition === null
              ? targetReport.ambience.expected
              : targetReport.ambience.expected_after,
          );
        recordAmbience(
          targetReport.ambience,
          "editor",
          "editor-mid",
          requireEditorSession().audioDiagnostics,
        );
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
        if (targetReport.ambience !== null)
          await waitForEditorAmbience(
            targetReport.ambience.transition === null
              ? targetReport.ambience.expected
              : targetReport.ambience.expected_after,
          );
        recordAmbience(
          targetReport.ambience,
          "editor",
          "editor-end",
          requireEditorSession().audioDiagnostics,
        );
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
        // A live seek can briefly expose HAVE_METADATA (readyState=1) while
        // currentTime is already advancing and the decoded dimensions remain
        // populated.  The strict scrub/readiness checks above still require
        // HAVE_CURRENT_DATA; continuous playback only needs a real media
        // timeline plus the observable clock progression here.
        const mediaOk =
          firstMedia !== null &&
          lastMedia !== null &&
          firstMedia.duration > 0 &&
          lastMedia.duration > 0 &&
          lastMedia.readyState >= 1 &&
          lastMedia.videoWidth >= 2 &&
          lastMedia.videoHeight >= 2;
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
          {
            ...target.update,
            update_id: `${target.update.update_id}:cancel`,
            // Keep the cancellation pass pending even for a zero-duration
            // dialogue/ambience node so the lifecycle assertion exercises the
            // real abort path rather than an already-completed promise.
            cues: [
              ...target.update.cues,
              {
                cue_id: `${target.update.update_id}:cancel-hold`,
                gate: "runtime",
                type: "delay",
                duration_ms: 1_000,
              },
            ],
          },
          urls,
        );
        await delay(Math.max(1, Math.floor(midMs / 2)));
        requireGame().cancelCurrentPresentation();
        targetReport.game.cancelledOutcome = await cancelled;
        recordAmbience(
          targetReport.ambience,
          "game",
          "game-cancelled",
          requireGame().audioDiagnostics,
        );
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
        recordAmbience(
          targetReport.ambience,
          "editor",
          "editor-cancelled",
          session.audioDiagnostics,
        );
        if (videoReport !== null) {
          videoReport.cancelReleased = session.videoState === null;
          videoCheck(
            videoReport,
            "editor-cancel 释放媒体",
            videoReport.cancelReleased,
            JSON.stringify(targetReport.cancelledMedia),
          );
        }
        session.setMuted(true);
        await session.load({
          update: editorCompatibleUpdate(target),
          assets: urls,
          snapshot: target.start_snapshot,
          world: "restore",
          animations,
        });
        await session.seek(0, "scrub");
        if (targetReport.ambience !== null) {
          session.setMuted(false);
          await waitForEditorAmbience(targetReport.ambience.expected);
        }
        recordAmbience(
          targetReport.ambience,
          "editor",
          "editor-cancelled-reload",
          session.audioDiagnostics,
        );
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
        session.setMuted(true);
        await session.load({
          update: editorCompatibleUpdate(target),
          assets: urls,
          snapshot: target.start_snapshot,
          world: "restore",
          animations,
        });
        await session.seek(0, "scrub");
        if (targetReport.ambience !== null) {
          session.setMuted(false);
          await waitForEditorAmbience(targetReport.ambience.expected);
        }
        recordAmbience(
          targetReport.ambience,
          "editor",
          "editor-reset-reload",
          session.audioDiagnostics,
        );
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
        validateAmbienceReport(targetReport.ambience);
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
  if (target.id === "ambience-closing" && targetReport.ambience !== null) {
    steps.splice(-1, 0, {
      target: target.id,
      name: "ambience-scene-boundary-cleanup",
      run: async () => {
        requireGame().destroy();
        requireEditor().session.dispose();
        requireEditor().surface.dispose();
        const gameDiagnostics = requireGame().audioDiagnostics;
        const editorDiagnostics = requireEditorSession().audioDiagnostics;
        recordAmbience(
          targetReport.ambience,
          "game",
          "scene-boundary-cleanup",
          gameDiagnostics,
        );
        recordAmbience(
          targetReport.ambience,
          "editor",
          "scene-boundary-cleanup",
          editorDiagnostics,
        );
        const cleared = (diagnostics: AudioDiagnostics): boolean =>
          diagnostics.buses.ambience === null &&
          AMBIENCE_DIAGNOSTIC_SLOTS.every(
            (slot) => diagnostics.ambience[slot] === null,
          );
        ambienceCheck(
          targetReport.ambience,
          "场景边界销毁游戏端清理四个环境声槽位",
          cleared(gameDiagnostics),
          JSON.stringify(gameDiagnostics),
        );
        ambienceCheck(
          targetReport.ambience,
          "场景边界销毁编辑器端清理四个环境声槽位",
          cleared(editorDiagnostics),
          JSON.stringify(editorDiagnostics),
        );
        return null;
      },
    });
  }
  return steps;
}

/**
 * Mounts the actual shared ChoiceLayer in a real browser and records resolved
 * layout boxes for both hosts and both template modes.  This is deliberately
 * a DOM probe rather than a string-only CSS test: absolute positioning,
 * intrinsic image sizing and stacking are browser-computed behaviours.
 */
async function runChoiceLayoutProbe(): Promise<void> {
  const probeRoot = document.createElement("div");
  probeRoot.setAttribute("aria-hidden", "true");
  probeRoot.style.cssText =
    "position:absolute;left:-10000px;top:0;width:1920px;height:1080px;overflow:hidden;";
  document.body.append(probeRoot);
  const cases: ChoiceLayoutProbeCase[] = [];
  try {
    for (const host of ["game", "editor"] as const) {
      for (const mode of ["separate", "overlay"] as const) {
        const mount = document.createElement("div");
        mount.className = `choice-probe-${host}-${mode}`;
        mount.style.cssText =
          "position:relative;width:1920px;height:1080px;overflow:hidden;";
        probeRoot.append(mount);
        const root = createRoot(mount);
        root.render(
          createElement(ChoiceLayer, {
            assets: {
              "probe.normal": CHOICE_PROBE_IMAGE,
              "probe.hover": CHOICE_PROBE_IMAGE,
              "probe.icon": CHOICE_PROBE_IMAGE,
            },
            onChoose: () => undefined,
            prompt: choiceProbePrompt(mode),
          }),
        );
        await settleChoiceProbeDom();
        await settleChoiceProbeDom();
        const button = mount.querySelector("button");
        const fallbackButton = mount.querySelector(
          '[data-choice-id="probe.fallback"]',
        );
        if (
          !(button instanceof HTMLButtonElement) ||
          !(fallbackButton instanceof HTMLButtonElement)
        ) {
          root.unmount();
          throw new Error(`Choice ${host}/${mode} 探针没有渲染完整按钮集合`);
        }
        if (mode === "overlay") {
          // React's onPointerEnter is delegated from pointerover in browsers;
          // dispatch both names so the probe remains valid in headless engines
          // that expose only the generic Event constructor.
          const pointerOptions = {
            bubbles: true,
            clientX: button.getBoundingClientRect().left + 1,
            clientY: button.getBoundingClientRect().top + 1,
            pointerId: 1,
            pointerType: "mouse",
          };
          if (typeof PointerEvent === "function") {
            button.dispatchEvent(
              new PointerEvent("pointerover", pointerOptions),
            );
            button.dispatchEvent(
              new PointerEvent("pointerenter", pointerOptions),
            );
            button.dispatchEvent(
              new PointerEvent("pointerdown", {
                ...pointerOptions,
                button: 0,
              }),
            );
            button.dispatchEvent(
              new PointerEvent("pointerup", {
                ...pointerOptions,
                button: 0,
              }),
            );
          } else {
            button.dispatchEvent(new Event("pointerover", { bubbles: true }));
            button.dispatchEvent(new Event("pointerenter", { bubbles: true }));
          }
          // Focus is a real browser interaction and is also the keyboard
          // equivalent of hover; it keeps the probe deterministic when a
          // headless engine declines untrusted pointer events.
          button.focus();
          await settleChoiceProbeDom();
        }
        const buttonRect = rectData(button.getBoundingClientRect());
        const fallbackRect = rectData(fallbackButton.getBoundingClientRect());
        const imageElements = [
          ...mount.querySelectorAll(".choice-button-image"),
        ];
        const content = mount.querySelector(".choice-button-content");
        const icon = mount.querySelector(".choice-button-icon");
        const formula = mount.querySelector(".katex");
        if (
          content === null ||
          icon === null ||
          formula === null ||
          imageElements.length !== (mode === "overlay" ? 2 : 1)
        ) {
          root.unmount();
          throw new Error(
            `Choice ${host}/${mode} 探针 DOM 不完整 (images=${imageElements.length}, class=${button.className}, content=${content !== null}, icon=${icon !== null}, formula=${formula !== null})`,
          );
        }
        const images = imageElements.map((image) =>
          rectData(image.getBoundingClientRect()),
        );
        const contentRect = rectData(content.getBoundingClientRect());
        const iconRect = rectData(icon.getBoundingClientRect());
        const formulaRect = rectData(formula.getBoundingClientRect());
        const artworkZ = Math.max(
          ...imageElements.map((image) => computedZIndex(image)),
        );
        const contentZ = computedZIndex(content);
        const imageBoxesMatchButton = images.every((image) =>
          rectMatches(image, buttonRect),
        );
        const contentOverlaysArtwork =
          contentZ > artworkZ &&
          rectHasArea(contentRect) &&
          rectHasArea(iconRect) &&
          rectHasArea(formulaRect) &&
          images.every((image) => rectsOverlap(contentRect, image));
        cases.push({
          host,
          mode,
          button: buttonRect,
          images,
          content: contentRect,
          icon: iconRect,
          formula: formulaRect,
          fallback: fallbackRect,
          imageBoxesMatchButton,
          fallbackHeightMatches: Math.abs(fallbackRect.height - 80) <= 0.01,
          contentOverlaysArtwork,
        });
        root.unmount();
        mount.remove();
      }
    }
  } finally {
    probeRoot.remove();
  }
  report.choiceLayout = { cases };
}

const CHOICE_PROBE_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Crect width='8' height='8' fill='%2300aacc'/%3E%3C/svg%3E";

function choiceProbePrompt(mode: "separate" | "overlay"): ChoicePrompt {
  const button: ButtonSnapshot = {
    id: `probe.${mode}`,
    template: "probe.button",
    asset_mode: mode,
    fit: "stretch",
    normal: "probe.normal",
    hover: "probe.hover",
    pressed: "probe.hover",
    animations: {},
    x: 320,
    y: 248,
    width: 520,
    height: 128,
    rotation_deg: 0,
    scale_x: 1,
    scale_y: 1,
    opacity: 1,
    z: 0,
    visible: true,
    enabled: true,
    action: { sets: [], next: null },
  };
  const choice: ChoiceSnapshot = {
    id: `probe.${mode}`,
    label: "Probe $x^2+y^2$",
    enabled: true,
    icon: "probe.icon",
    template: { kind: "button", button },
    x: button.x,
    y: button.y,
    width: button.width,
    height: button.height,
  };
  const fallbackChoice: ChoiceSnapshot = {
    id: "probe.fallback",
    label: "Probe fallback",
    enabled: true,
    icon: null,
    template: { kind: "fallback" },
    x: 920,
    y: 248,
    width: 320,
    height: 80,
  };
  return {
    kind: "choice",
    prompt_id: `probe/${mode}`,
    layout: {
      stage_width: 1920,
      stage_height: 1080,
      anchor_x: 580,
      anchor_y: 312,
      direction: "vertical",
      gap: 20,
      x: button.x,
      y: button.y,
      width: button.width,
      height: button.height + 20 + fallbackChoice.height,
    },
    diagnostics: [],
    choices: [choice, fallbackChoice],
  };
}

async function settleChoiceProbeDom(): Promise<void> {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

interface ProbeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectData(rect: DOMRect): ProbeRect {
  return {
    x: roundProbeNumber(rect.x),
    y: roundProbeNumber(rect.y),
    width: roundProbeNumber(rect.width),
    height: roundProbeNumber(rect.height),
  };
}

function roundProbeNumber(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function rectMatches(left: ProbeRect, right: ProbeRect): boolean {
  return (
    Math.abs(left.x - right.x) <= 0.01 &&
    Math.abs(left.y - right.y) <= 0.01 &&
    Math.abs(left.width - right.width) <= 0.01 &&
    Math.abs(left.height - right.height) <= 0.01
  );
}

function rectHasArea(rect: ProbeRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

function rectsOverlap(left: ProbeRect, right: ProbeRect): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function computedZIndex(element: Element): number {
  const value = getComputedStyle(element).zIndex;
  return value === "auto" ? 0 : Number(value);
}

/** Media wait bound for a wall-clock game observation. */
const VIDEO_OBSERVE_TIMEOUT_MS = 3_000;
/** Length of the continuous-playback sampling window. */
const VIDEO_PLAYBACK_WINDOW_MS = 700;
/** Geometry the frozen video fixture authors (locked by game_content.rs too). */
const VIDEO_GEOMETRY = { x: 160, y: 90, width: 1_600, height: 900 };
const VIDEO_GEOMETRY_TOLERANCE = 0.5;

const AMBIENCE_DIAGNOSTIC_SLOTS = [
  "slot_1",
  "slot_2",
  "slot_3",
  "slot_4",
] as const;

function buildAmbienceReport(
  target: ParityTarget,
): TargetAmbienceReport | null {
  const start = target.start_snapshot.audio.ambience;
  const expected = Object.fromEntries(
    AMBIENCE_DIAGNOSTIC_SLOTS.map((slot) => [
      slot,
      start?.[slot]?.asset ?? null,
    ]),
  ) as TargetAmbienceReport["expected"];
  const after = target.update.snapshot.audio.ambience;
  const expectedAfter = Object.fromEntries(
    AMBIENCE_DIAGNOSTIC_SLOTS.map((slot) => [
      slot,
      after?.[slot]?.asset ?? null,
    ]),
  ) as TargetAmbienceReport["expected_after"];
  const snapshotVolumes = Object.fromEntries(
    AMBIENCE_DIAGNOSTIC_SLOTS.map((slot) => [
      slot,
      start?.[slot]?.volume ?? null,
    ]),
  ) as TargetAmbienceReport["snapshot_volumes"];
  const timeline =
    target.update.cues.find(
      (cue): cue is TimelineCue => cue.type === "timeline",
    ) ?? null;
  const transitionCue = target.update.cues.find(
    (cue): cue is Extract<PresentationCue, { type: "ambience_transition" }> =>
      cue.type === "ambience_transition",
  );
  const transition =
    transitionCue === undefined
      ? null
      : { slot: transitionCue.slot, asset: transitionCue.to?.asset ?? null };
  const retune =
    transitionCue?.from !== null &&
    transitionCue?.from !== undefined &&
    transitionCue.to !== null &&
    transitionCue.to !== undefined &&
    transitionCue.from.asset === transitionCue.to.asset
      ? {
          slot: transitionCue.slot,
          asset: transitionCue.to.asset,
          start_ms: transitionCue.to.start_ms,
          loop_start_ms: transitionCue.to.loop_start_ms ?? null,
          loop_end_ms: transitionCue.to.loop_end_ms ?? null,
        }
      : null;
  const fixture =
    Object.values(expected).some((asset) => asset !== null) ||
    Object.values(expectedAfter).some((asset) => asset !== null) ||
    timeline?.tracks.some((track) => track.type === "ambience") === true ||
    transition !== null;
  return fixture
    ? {
        fixture: true,
        expected,
        expected_after: expectedAfter,
        snapshot_volumes: snapshotVolumes,
        automation:
          timeline === null ? null : buildAmbienceAutomation(timeline, start),
        transition,
        retune,
        observations: [],
        checks: [],
      }
    : null;
}

function buildAmbienceAutomation(
  timeline: TimelineCue,
  start: RuntimeSnapshot["audio"]["ambience"],
): AmbienceAutomationExpectation {
  const baseVolumes = Object.fromEntries(
    AMBIENCE_DIAGNOSTIC_SLOTS.map((slot) => [slot, start?.[slot]?.volume ?? 1]),
  ) as Partial<Record<AmbienceSlot, number>>;
  const evaluate = (elapsedMs: number): Record<AmbienceSlot, number | null> => {
    const frame = evaluateTimelineFrame(
      { duration_ms: timeline.duration_ms, tracks: timeline.tracks },
      {
        sprites: {},
        camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
        ambience_volumes: baseVolumes,
      },
      elapsedMs,
    );
    return Object.fromEntries(
      AMBIENCE_DIAGNOSTIC_SLOTS.map((slot) => [
        slot,
        frame.ambience_volumes?.[slot] ?? null,
      ]),
    ) as Record<AmbienceSlot, number | null>;
  };
  return {
    duration_ms: timeline.duration_ms,
    values: Object.fromEntries(
      AMBIENCE_DIAGNOSTIC_SLOTS.map((slot) => {
        const startValue = evaluate(0)[slot];
        const midValue = evaluate(timeline.duration_ms / 2)[slot];
        const endValue = evaluate(timeline.duration_ms)[slot];
        return [slot, { start: startValue, mid: midValue, end: endValue }];
      }),
    ) as AmbienceAutomationExpectation["values"],
  };
}

function recordAmbience(
  report: TargetAmbienceReport | null,
  host: "game" | "editor",
  step: string,
  diagnostics: AudioDiagnostics | null,
): void {
  if (report === null) return;
  const slots = {} as AmbienceObservation["slots"];
  for (const slot of AMBIENCE_DIAGNOSTIC_SLOTS) {
    const track = diagnostics?.ambience[slot] ?? null;
    slots[slot] =
      track === null
        ? null
        : {
            asset: track.asset,
            volume: track.volume,
            paused: track.paused,
            current_time: track.current_time,
          };
  }
  report.observations.push({
    host,
    step,
    slots,
    bus_volume: diagnostics?.buses.ambience ?? null,
    context_state: diagnostics?.context_state ?? null,
  });
}

async function waitForEditorAmbience(
  expected: Record<AmbienceSlot, string | null>,
): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (performance.now() < deadline) {
    const diagnostics = requireEditorSession().audioDiagnostics;
    if (
      diagnostics !== null &&
      AMBIENCE_DIAGNOSTIC_SLOTS.every((slot) =>
        expected[slot] === null
          ? diagnostics.ambience[slot] === null
          : diagnostics.ambience[slot] !== null,
      )
    ) {
      // AudioParam changes are scheduled on the browser's audio clock. Give
      // the graph one bounded wall-clock turn before taking a diagnostic
      // snapshot, otherwise a seek can race the gain update while media is
      // already active.
      await delay(75);
      return;
    }
    await delay(50);
  }
}

function ambienceCheck(
  report: TargetAmbienceReport,
  name: string,
  ok: boolean,
  detail: string,
): void {
  report.checks.push({ name, ok, detail });
}

function ambienceObservation(
  report: TargetAmbienceReport,
  host: "game" | "editor",
  step: string,
): AmbienceObservation | undefined {
  return report.observations.find(
    (candidate) => candidate.host === host && candidate.step === step,
  );
}

function hasExpectedAmbience(
  report: TargetAmbienceReport,
  observation: AmbienceObservation | undefined,
  expectedAssets: Record<AmbienceSlot, string | null> = report.expected,
): boolean {
  return (
    observation !== undefined &&
    AMBIENCE_DIAGNOSTIC_SLOTS.every((slot) => {
      const expected = expectedAssets[slot];
      const actual = observation.slots[slot];
      return expected === null
        ? actual === null
        : actual !== null && actual.asset === expected && !actual.paused;
    })
  );
}

function hasStoppedAmbience(
  observation: AmbienceObservation | undefined,
): boolean {
  return (
    observation !== undefined &&
    AMBIENCE_DIAGNOSTIC_SLOTS.every((slot) => observation.slots[slot] === null)
  );
}

function hasClearedAmbience(
  observation: AmbienceObservation | undefined,
): boolean {
  return hasStoppedAmbience(observation) && observation?.bus_volume === null;
}

function validateAutomationPoint(
  report: TargetAmbienceReport,
  host: "game" | "editor",
  step: string,
  point: "start" | "mid" | "end",
  tolerance: number,
): void {
  const observation = ambienceObservation(report, host, step);
  const expected = report.automation?.values;
  const ok =
    observation !== undefined &&
    expected !== undefined &&
    AMBIENCE_DIAGNOSTIC_SLOTS.every((slot) => {
      const expectedVolume = expected[slot][point];
      const actual = observation.slots[slot];
      return (
        expectedVolume !== null &&
        actual !== null &&
        Number.isFinite(actual.volume) &&
        Math.abs(actual.volume - expectedVolume) <= tolerance
      );
    });
  ambienceCheck(
    report,
    `${host} ${step} 精确应用四槽位音量自动化`,
    ok,
    JSON.stringify({ observation, expected: expected?.["slot_1"] }),
  );
}

function validateSnapshotVolumePoint(
  report: TargetAmbienceReport,
  host: "game" | "editor",
  step: string,
  tolerance: number,
): void {
  const observation = ambienceObservation(report, host, step);
  const ok =
    observation !== undefined &&
    AMBIENCE_DIAGNOSTIC_SLOTS.every((slot) => {
      const expected = report.snapshot_volumes[slot];
      const actual = observation.slots[slot];
      return (
        expected !== null &&
        actual !== null &&
        Number.isFinite(actual.volume) &&
        Math.abs(actual.volume - expected) <= tolerance
      );
    });
  ambienceCheck(
    report,
    `${host} ${step} 恢复权威快照音量`,
    ok,
    JSON.stringify({ observation, expected: report.snapshot_volumes }),
  );
}

function validateAmbienceReport(report: TargetAmbienceReport | null): void {
  if (report === null) return;
  const gameStart = ambienceObservation(report, "game", "game-start");
  const editorPreUnlock = ambienceObservation(
    report,
    "editor",
    "editor-pre-unlock",
  );
  const editorStart = ambienceObservation(report, "editor", "editor-0000");
  ambienceCheck(
    report,
    "editor pre-unlock 不创建任何环境声 media resource",
    editorPreUnlock !== undefined &&
      AMBIENCE_DIAGNOSTIC_SLOTS.every(
        (slot) => editorPreUnlock.slots[slot] === null,
      ),
    JSON.stringify(editorPreUnlock ?? null),
  );
  for (const [host, observation] of [
    ["game", gameStart],
    ["editor", editorStart],
  ] as const) {
    ambienceCheck(
      report,
      `${host} 四个环境声槽位由共享诊断可读`,
      hasExpectedAmbience(report, observation),
      JSON.stringify(observation ?? null),
    );
    ambienceCheck(
      report,
      `${host} 使用独立 ambience bus`,
      observation?.bus_volume !== null &&
        observation?.bus_volume !== undefined &&
        observation.bus_volume > 0,
      JSON.stringify(observation?.bus_volume ?? null),
    );
  }

  // Game samples are wall-clock observations, while editor seeks are
  // deterministic. Keep a tight tolerance for the latter and a bounded one
  // for the browser clock while checking every authored slot, not just the
  // first diagnostic snapshot.
  if (report.automation !== null) {
    validateAutomationPoint(report, "game", "game-mid", "mid", 0.08);
    validateSnapshotVolumePoint(report, "game", "game-end", 0.08);
    validateAutomationPoint(report, "editor", "editor-mid", "mid", 0.025);
    validateAutomationPoint(report, "editor", "editor-end", "end", 0.025);
  }
  const expectedCurrent =
    report.transition === null ? report.expected : report.expected_after;
  if (report.transition !== null) {
    ambienceCheck(
      report,
      `game post-demo ${report.transition.slot} replacement/stop`,
      hasExpectedAmbience(
        report,
        ambienceObservation(report, "game", "game-end"),
        report.expected_after,
      ),
      JSON.stringify({
        transition: report.transition,
        observation: ambienceObservation(report, "game", "game-end"),
      }),
    );
    ambienceCheck(
      report,
      `editor post-demo ${report.transition.slot} replacement/stop`,
      hasExpectedAmbience(
        report,
        ambienceObservation(report, "editor", "editor-transition-settled"),
        report.expected_after,
      ),
      JSON.stringify({
        transition: report.transition,
        observation: ambienceObservation(
          report,
          "editor",
          "editor-transition-settled",
        ),
      }),
    );
  }

  if (report.retune !== null) {
    const before = gameStart?.slots[report.retune.slot] ?? null;
    const after =
      ambienceObservation(report, "game", "game-end")?.slots[
        report.retune.slot
      ] ?? null;
    const resetHead = report.retune.start_ms / 1_000;
    const preservedHead =
      before !== null &&
      after !== null &&
      before.asset === report.retune.asset &&
      after.asset === report.retune.asset &&
      Number.isFinite(before.current_time) &&
      Number.isFinite(after.current_time) &&
      Math.abs(after.current_time - before.current_time) <= 0.25 &&
      Math.abs(after.current_time - resetHead) >= 0.25;
    ambienceCheck(
      report,
      "game same-slot same-asset retune 保留播放头而非 seek 到 start_ms",
      preservedHead,
      JSON.stringify({ before, after, retune: report.retune }),
    );
  }

  const phasePoints = [
    {
      observation: ambienceObservation(report, "game", "game-mid"),
      expected: report.expected,
    },
    {
      observation: ambienceObservation(report, "game", "game-end"),
      expected: expectedCurrent,
    },
    {
      observation: ambienceObservation(report, "editor", "editor-end"),
      expected: expectedCurrent,
    },
  ];
  ambienceCheck(
    report,
    "四槽位 phase diagnostics 均为有限非负值",
    phasePoints.every(
      ({ observation, expected }) =>
        observation !== undefined &&
        AMBIENCE_DIAGNOSTIC_SLOTS.every((slot) => {
          const actual = observation.slots[slot];
          return expected[slot] === null
            ? actual === null
            : actual !== null &&
                Number.isFinite(actual.current_time) &&
                actual.current_time >= 0;
        }),
    ),
    JSON.stringify(phasePoints),
  );
  const editorEnd = ambienceObservation(report, "editor", "editor-end");
  ambienceCheck(
    report,
    "editor seek 不把环境声 phase 重置到零",
    editorEnd !== undefined &&
      AMBIENCE_DIAGNOSTIC_SLOTS.every((slot) => {
        if (expectedCurrent[slot] === null)
          return editorEnd.slots[slot] === null;
        return (editorEnd.slots[slot]?.current_time ?? 0) > 0.01;
      }),
    JSON.stringify(editorEnd ?? null),
  );

  ambienceCheck(
    report,
    "游戏与编辑器共享四槽位资产诊断",
    gameStart !== undefined &&
      editorStart !== undefined &&
      AMBIENCE_DIAGNOSTIC_SLOTS.every(
        (slot) =>
          gameStart.slots[slot]?.asset === editorStart.slots[slot]?.asset,
      ),
    JSON.stringify({ game: gameStart, editor: editorStart }),
  );

  ambienceCheck(
    report,
    "game cancellation 清理所有环境声槽位",
    hasStoppedAmbience(ambienceObservation(report, "game", "game-cancelled")),
    JSON.stringify(
      ambienceObservation(report, "game", "game-cancelled") ?? null,
    ),
  );
  ambienceCheck(
    report,
    "editor cancellation 保留并恢复环境声快照",
    hasExpectedAmbience(
      report,
      ambienceObservation(report, "editor", "editor-cancelled"),
      expectedCurrent,
    ),
    JSON.stringify(
      ambienceObservation(report, "editor", "editor-cancelled") ?? null,
    ),
  );
  for (const step of ["editor-cancelled-reload", "editor-reset-reload"]) {
    ambienceCheck(
      report,
      `${step} 恢复四个环境声槽位`,
      hasExpectedAmbience(report, ambienceObservation(report, "editor", step)),
      JSON.stringify(ambienceObservation(report, "editor", step) ?? null),
    );
  }
  if (
    report.observations.some(
      (observation) => observation.step === "scene-boundary-cleanup",
    )
  ) {
    for (const host of ["game", "editor"] as const) {
      ambienceCheck(
        report,
        `${host} scene boundary cleanup`,
        hasClearedAmbience(
          ambienceObservation(report, host, "scene-boundary-cleanup"),
        ),
        JSON.stringify(
          ambienceObservation(report, host, "scene-boundary-cleanup") ?? null,
        ),
      );
    }
  }
}

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

/** TimelineSession is intentionally a timeline host; non-timeline ambience
 * nodes still need a zero-duration compatibility cue for preview reloads. */
function editorCompatibleUpdate(target: ParityTarget): RuntimeUpdate {
  if (findTimelineCue(target.update) !== null) return target.update;
  return {
    ...target.update,
    cues: [
      {
        cue_id: `${target.update.update_id}:editor-timeline`,
        gate: "runtime",
        type: "timeline",
        presentation_id: `${target.scene_id}/${target.node_id}:editor`,
        duration_ms: 0,
        skippable: false,
        is_seen: true,
        tracks: [],
        events: [],
      },
    ],
  };
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
