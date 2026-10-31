import type { SceneFrame } from "@vectspace/presentation-core/scene-frame";
import type { TimelineVideoState } from "@vectspace/presentation-core/timeline-session";
import type {
  RuntimeUpdate,
  TimelineTrack,
} from "@vectspace/presentation-core/types";
import type { TargetVideoReport, VideoGeometry } from "./types";

/** Media wait bound for a wall-clock game observation. */
export const VIDEO_OBSERVE_TIMEOUT_MS = 3_000;
/** Length of the continuous-playback sampling window. */
export const VIDEO_PLAYBACK_WINDOW_MS = 700;
/** Geometry the frozen video fixture authors (locked by game_content.rs too). */
const VIDEO_GEOMETRY = { x: 160, y: 90, width: 1_600, height: 900 };
const VIDEO_GEOMETRY_TOLERANCE = 0.5;

export function findVideoTrack(
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

export function videoCheck(
  video: TargetVideoReport,
  name: string,
  ok: boolean,
  detail: string,
): void {
  video.checks.push({ name, ok, detail });
}

export function videoGeometry(
  frame: SceneFrame,
  asset: string,
): VideoGeometry | null {
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

export function geometryMatchesFixture(
  geometry: VideoGeometry | null,
): boolean {
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

export function mediaIsReady(media: TimelineVideoState | null): boolean {
  return (
    media !== null &&
    Number.isFinite(media.duration) &&
    media.duration > 0 &&
    media.readyState >= 2 &&
    media.videoWidth >= 2 &&
    media.videoHeight >= 2
  );
}
