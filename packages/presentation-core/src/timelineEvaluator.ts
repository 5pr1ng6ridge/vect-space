import { evaluateChannel, type SharedTimelineChannels } from "./timeline";
import type { ScreenEffectSpec, TimelineEvent } from "./types";

export interface TimelineBaseSprite {
  asset: string;
  x: number;
  y: number;
  scale: number;
  scale_x: number;
  scale_y: number;
  rotation_deg: number;
  flip_x?: boolean;
  anchor_x?: number;
  anchor_y?: number;
  opacity: number;
  z: number;
  width?: number;
  height?: number;
}

export interface TimelineBaseState {
  sprites: Readonly<Record<string, TimelineBaseSprite>>;
  /** Scene button transforms are evaluated with the same clock as sprites. */
  buttons?: Readonly<Record<string, TimelineBaseButton>>;
  camera: { x: number; y: number; zoom: number; rotation_deg: number };
  bgm_volume?: number;
}

export interface TimelineBaseButton {
  x: number;
  y: number;
  width: number;
  height: number;
  scale_x: number;
  scale_y: number;
  rotation_deg: number;
  opacity: number;
  z: number;
}

export interface TimelineFrameButton extends TimelineBaseButton {
  id: string;
}

export interface TimelineFrameSprite extends Omit<
  TimelineBaseSprite,
  "width" | "height"
> {
  id: string;
  width: number | undefined;
  height: number | undefined;
}

export interface TimelineFrameVideo {
  id: string;
  asset: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  z: number;
  volume: number;
}

export interface TimelineFrame {
  elapsed_ms: number;
  sprites: TimelineFrameSprite[];
  buttons: TimelineFrameButton[];
  camera: TimelineBaseState["camera"];
  videos: TimelineFrameVideo[];
  bgm_volume: number;
}

export interface ActiveScreenEffect {
  startMs: number;
  durationMs: number;
  /** Canonical spec of the winning event for this channel. */
  effect: ScreenEffectSpec;
}

export interface ActiveScreenEffects {
  flash: ActiveScreenEffect | null;
  shake: ActiveScreenEffect | null;
}

/**
 * Reconstruct persistent screen-effect state from a timeline position.
 *
 * Screen effects are presentation events rather than world state, so seeking
 * must derive them from the playhead instead of a wall clock.  When authored
 * intervals of one kind overlap, the latest start wins and an equal start
 * keeps the later array entry; flash and shake are independent, so both can be
 * active at the same playhead position.
 */
export function evaluateActiveScreenEffects(
  events: readonly TimelineEvent[],
  elapsedMs: number,
): ActiveScreenEffects {
  const elapsed = Math.max(0, elapsedMs);
  let flash: ActiveScreenEffect | null = null;
  let shake: ActiveScreenEffect | null = null;
  let flashStart = Number.NEGATIVE_INFINITY;
  let shakeStart = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (event.type !== "screen_effect") continue;
    const durationMs = Math.max(1, event.duration_ms);
    if (event.at_ms <= elapsed && elapsed < event.at_ms + durationMs) {
      const active = {
        startMs: event.at_ms,
        durationMs,
        effect: event.effect,
      };
      // The latest start wins; an equal start keeps the later array entry,
      // which is the authored order the runtime stream also uses.
      if (event.effect.type === "flash") {
        if (event.at_ms >= flashStart) {
          flash = active;
          flashStart = event.at_ms;
        }
      } else if (event.at_ms >= shakeStart) {
        shake = active;
        shakeStart = event.at_ms;
      }
    }
  }
  return { flash, shake };
}

export interface TimelineCueForEvaluation {
  duration_ms: number;
  tracks: readonly TimelineEvaluationTrack[];
}

export type TimelineEvaluationTrack =
  | {
      type: "sprite";
      sprite_id: string;
      asset?: string | null;
      channels: SharedTimelineChannels;
    }
  | { type: "camera"; channels: SharedTimelineChannels }
  | { type: "button"; instance_id: string; channels: SharedTimelineChannels }
  | {
      type: "video";
      asset: string;
      channels: SharedTimelineChannels;
    }
  | { type: "bgm"; channels: SharedTimelineChannels };

/**
 * Pure timeline evaluation shared by the game renderer and editor.  It never
 * touches Pixi, media elements, or audio, which makes seek/scrub behaviour
 * deterministic and straightforward to test.
 */
export function evaluateTimelineFrame(
  cue: TimelineCueForEvaluation,
  bases: TimelineBaseState,
  elapsedMs: number,
): TimelineFrame {
  const elapsed = Math.max(0, Math.min(cue.duration_ms, elapsedMs));
  const sprites = new Map<string, TimelineFrameSprite>();
  const buttons = new Map<string, TimelineFrameButton>();
  const camera = { ...bases.camera };
  let bgmVolume = bases.bgm_volume ?? 1;
  const videos: TimelineFrameVideo[] = [];

  for (const [id, base] of Object.entries(bases.sprites)) {
    sprites.set(id, {
      id,
      ...base,
      width: base.width,
      height: base.height,
    });
  }
  for (const [id, base] of Object.entries(bases.buttons ?? {})) {
    buttons.set(id, { id, ...base });
  }
  for (const track of cue.tracks) {
    if (track.type === "sprite") {
      const base = bases.sprites[track.sprite_id] ?? defaultSprite(track.asset);
      sprites.set(track.sprite_id, {
        id: track.sprite_id,
        asset: track.asset ?? base.asset,
        x: evaluateChannel(track.channels, "x", elapsed, base.x),
        y: evaluateChannel(track.channels, "y", elapsed, base.y),
        scale: evaluateChannel(track.channels, "scale", elapsed, base.scale),
        scale_x: evaluateChannel(
          track.channels,
          "scale_x",
          elapsed,
          base.scale_x,
        ),
        scale_y: evaluateChannel(
          track.channels,
          "scale_y",
          elapsed,
          base.scale_y,
        ),
        rotation_deg: evaluateChannel(
          track.channels,
          "rotation_deg",
          elapsed,
          base.rotation_deg,
        ),
        flip_x: base.flip_x ?? false,
        anchor_x: base.anchor_x ?? 0.5,
        anchor_y: base.anchor_y ?? 1,
        opacity: evaluateChannel(
          track.channels,
          "opacity",
          elapsed,
          base.opacity,
        ),
        z: Math.round(evaluateChannel(track.channels, "z", elapsed, base.z)),
        width: base.width,
        height: base.height,
      });
    } else if (track.type === "camera") {
      camera.x = evaluateChannel(track.channels, "x", elapsed, camera.x);
      camera.y = evaluateChannel(track.channels, "y", elapsed, camera.y);
      camera.zoom = evaluateChannel(
        track.channels,
        "zoom",
        elapsed,
        camera.zoom,
      );
      camera.rotation_deg = evaluateChannel(
        track.channels,
        "rotation_deg",
        elapsed,
        camera.rotation_deg,
      );
    } else if (track.type === "button") {
      const base = bases.buttons?.[track.instance_id] ?? defaultButton();
      buttons.set(track.instance_id, {
        id: track.instance_id,
        x: evaluateChannel(track.channels, "x", elapsed, base.x),
        y: evaluateChannel(track.channels, "y", elapsed, base.y),
        width: evaluateChannel(track.channels, "width", elapsed, base.width),
        height: evaluateChannel(track.channels, "height", elapsed, base.height),
        scale_x: evaluateChannel(
          track.channels,
          "scale_x",
          elapsed,
          base.scale_x,
        ),
        scale_y: evaluateChannel(
          track.channels,
          "scale_y",
          elapsed,
          base.scale_y,
        ),
        rotation_deg: evaluateChannel(
          track.channels,
          "rotation_deg",
          elapsed,
          base.rotation_deg,
        ),
        opacity: evaluateChannel(
          track.channels,
          "opacity",
          elapsed,
          base.opacity,
        ),
        z: Math.round(evaluateChannel(track.channels, "z", elapsed, base.z)),
      });
    } else if (track.type === "video") {
      videos.push({
        id: `video:${track.asset}`,
        asset: track.asset,
        x: evaluateChannel(track.channels, "x", elapsed, 0),
        y: evaluateChannel(track.channels, "y", elapsed, 0),
        width: evaluateChannel(track.channels, "width", elapsed, 1920),
        height: evaluateChannel(track.channels, "height", elapsed, 1080),
        opacity: evaluateChannel(track.channels, "opacity", elapsed, 1),
        z: Math.round(evaluateChannel(track.channels, "z", elapsed, 0)),
        volume: evaluateChannel(track.channels, "volume", elapsed, 1),
      });
    } else if (track.type === "bgm") {
      bgmVolume = evaluateChannel(track.channels, "volume", elapsed, bgmVolume);
    }
  }
  // Keep untracked starting sprites in the evaluated frame.  This is the
  // important inheritance rule used by both the editor and player.
  return {
    elapsed_ms: elapsed,
    sprites: [...sprites.values()],
    buttons: [...buttons.values()],
    camera,
    videos,
    bgm_volume: Number.isFinite(bgmVolume) ? bgmVolume : 0,
  };
}

function defaultButton(): TimelineBaseButton {
  return {
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    scale_x: 1,
    scale_y: 1,
    rotation_deg: 0,
    opacity: 1,
    z: 0,
  };
}

function defaultSprite(asset: string | null | undefined): TimelineBaseSprite {
  return {
    asset: asset ?? "",
    x: 960,
    y: 1080,
    scale: 1,
    scale_x: 1,
    scale_y: 1,
    rotation_deg: 0,
    anchor_x: 0.5,
    anchor_y: 1,
    opacity: 1,
    z: 0,
  };
}
