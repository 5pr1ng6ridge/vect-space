import type {
  AmbienceSlot,
  PresentationOutcome,
  RuntimeSnapshot,
  RuntimeUpdate,
} from "@vectspace/presentation-core/types";
import type { TimelineVideoState } from "@vectspace/presentation-core/timeline-session";

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

export interface ParityTarget {
  id: string;
  scene_id: string;
  node_id: string;
  start_snapshot: RuntimeSnapshot;
  update: RuntimeUpdate;
  trace: { scene_id: string; node_id: string }[];
}

export interface ParityFixture {
  schema_version: number;
  game_root: string;
  targets: ParityTarget[];
  assets: ParityAsset[];
}

export type TimelineCue = Extract<
  RuntimeUpdate["cues"][number],
  { type: "timeline" }
>;

export interface CaptureRequest {
  target: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ThumbnailSignature {
  bytes: number;
  sha256: string;
  /** 8x8 average colour grid, packed as 0xRRGGBB. */
  grid: number[];
}

export interface AmbienceObservation {
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

export interface AmbienceAutomationExpectation {
  duration_ms: number;
  values: Record<
    AmbienceSlot,
    { start: number | null; mid: number | null; end: number | null }
  >;
}

export interface TargetAmbienceReport {
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

export interface VideoGeometry {
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

export interface TargetVideoReport {
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

export interface ChoiceLayoutProbeCase {
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

export interface ChoiceLayoutProbeReport {
  cases: ChoiceLayoutProbeCase[];
}

/** One executed shader-pixel assertion; the driver fails on any `ok:false`. */
interface ShaderCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Real-WebGL assertions for the composable world-layer effects.
 *
 * `captureThumbnail()` renders the real Pixi stage, so comparing two frames of
 * the same camera/content isolates what the new passes changed: effect-on vs
 * the same authored timeline with that pass's intensity zeroed, and the zeroed
 * frame vs the event removed entirely (identity bypass).
 */
export interface TargetShaderReport {
  fixture: boolean;
  checks: ShaderCheck[];
  observations: {
    effect: string;
    elapsedMs: number;
    meanAbsDiff: number;
    centroid: { x: number; y: number };
    expectedCenter: { x: number; y: number } | null;
    centerFocusMean: number | null;
    peripheryFocusMean: number | null;
    /** Clearance measured at the fixed design centre mapped through the camera. */
    expectedCenterClearance: number | null;
    /** Clearance measured at the fixed stage (screen) centre. */
    screenCenterClearance: number | null;
    /**
     * Centroid of the lit pixels the pass left unchanged; for `focus` this is
     * the sharp disc and therefore the pass centre, independent of content.
     */
    sharpDiscCentroid: {
      x: number;
      y: number;
      count: number;
      bounds: { x: number; y: number };
    } | null;
    /** 16x9 map of mean relative change (x1000) for locating the pass centre. */
    relativeGrid: number[];
    screenCenter: { x: number; y: number };
    camera: { x: number; y: number; zoom: number; rotation_deg: number };
  }[];
  /**
   * Focus blur-only probe (darkness 0) numbers, so a reviewer can see the
   * detail reduction that distinguishes blur from darkening.
   */
  blurProbe: {
    sharpEdgeEnergy: number;
    blurredEdgeEnergy: number;
    detailReduction: number;
    centerMeanDiff: number;
    darkenModelDiff: number;
    annulusPixels: number;
    annulusPixelsBlurred: number;
  } | null;
}

export interface TargetReport {
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
  /** Real-WebGL pixel assertions for the composable world-layer effects. */
  shader: TargetShaderReport | null;
  thumbnails: Record<string, ThumbnailSignature | null>;
}

export interface ParityReport {
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

export interface Step {
  target: string;
  name: string;
  run(): Promise<CaptureRequest | null>;
}

export interface PendingCapture {
  dataUrl: string | null;
}

export type StepResult =
  | { done: false; capture: CaptureRequest }
  | { done: true; report: ParityReport };
