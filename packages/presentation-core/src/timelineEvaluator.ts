import { evaluateChannel, type SharedTimelineChannels } from "./timeline";
import type { AmbienceSlot, ScreenEffectSpec, TimelineEvent } from "./types";
import { spriteResourceId, spriteTrackState, type SpriteTrackSource, type CoordinateSpace, type SpriteKind, type SpriteLayout, type SpriteSource } from "./visual";
import type { EmitterSnapshot } from "./particles";

export interface TimelineBaseSprite {
  asset?: string;
  source?: SpriteSource;
  sprite_kind?: SpriteKind;
  space?: CoordinateSpace;
  layout?: SpriteLayout | null;
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
  emitters?: Readonly<Record<string, EmitterSnapshot>>;
  /** Scene button transforms are evaluated with the same clock as sprites. */
  buttons?: Readonly<Record<string, TimelineBaseButton>>;
  camera: { x: number; y: number; zoom: number; rotation_deg: number };
  bgm_volume?: number;
  /** Transient volume bases for ambience tracks; never persisted by the runtime. */
  ambience_volumes?: Partial<Record<AmbienceSlot, number>>;
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
  asset: string;
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
  emitters?: (EmitterSnapshot & { id: string })[];
  buttons: TimelineFrameButton[];
  camera: TimelineBaseState["camera"];
  videos: TimelineFrameVideo[];
  bgm_volume: number;
  /** Present only when the timeline contains ambience volume automation. */
  ambience_volumes?: Partial<Record<AmbienceSlot, number>>;
}

export interface ActiveScreenEffect {
  startMs: number;
  durationMs: number;
  /** Canonical spec of the winning event for this channel. */
  effect: ScreenEffectSpec;
}

/** One independent channel per effect type, keyed by the spec's `type`. */
export type ActiveScreenEffects = Record<
  ScreenEffectSpec["type"],
  ActiveScreenEffect | null
>;

export function emptyActiveScreenEffects(): ActiveScreenEffects {
  return {
    flash: null,
    shake: null,
    chromatic_aberration: null,
    glitch: null,
    shockwave: null,
    color_grade: null,
    focus: null,
    ripple: null,
  };
}

/**
 * Reconstruct persistent screen-effect state from a timeline position.
 *
 * Screen effects are presentation events rather than world state, so seeking
 * must derive them from the playhead instead of a wall clock.  When authored
 * intervals of one kind overlap, the latest start wins and an equal start
 * keeps the later array entry; different kinds are independent channels, so
 * a flash, a shake and every shader effect can be active at the same playhead
 * position.
 */
export function evaluateActiveScreenEffects(
  events: readonly TimelineEvent[],
  elapsedMs: number,
): ActiveScreenEffects {
  const elapsed = Math.max(0, elapsedMs);
  const active = emptyActiveScreenEffects();
  for (const event of events) {
    if (event.type !== "screen_effect") continue;
    const durationMs = Math.max(1, event.duration_ms);
    if (event.at_ms <= elapsed && elapsed < event.at_ms + durationMs) {
      const channel = event.effect.type;
      const current = active[channel];
      // The latest start wins; an equal start keeps the later array entry,
      // which is the authored order the runtime stream also uses.
      if (current === null || event.at_ms >= current.startMs) {
        active[channel] = {
          startMs: event.at_ms,
          durationMs,
          effect: event.effect,
        };
      }
    }
  }
  return active;
}

export interface TimelineCueForEvaluation {
  duration_ms: number;
  tracks: readonly TimelineEvaluationTrack[];
}

export type TimelineEvaluationTrack =
  | (SpriteTrackSource & {
      type: "sprite";
      sprite_id: string;
      channels: SharedTimelineChannels;
    })
  | { type: "emitter"; emitter_id: string; channels: SharedTimelineChannels }
  | { type: "camera"; channels: SharedTimelineChannels }
  | { type: "button"; instance_id: string; channels: SharedTimelineChannels }
  | {
      type: "video";
      asset: string;
      channels: SharedTimelineChannels;
    }
  | { type: "bgm"; channels: SharedTimelineChannels }
  | { type: "ambience"; slot: AmbienceSlot; channels: SharedTimelineChannels };

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
  const emitters = new Map<string, EmitterSnapshot & { id: string }>();
  for (const [id, state] of Object.entries(bases.emitters ?? {})) emitters.set(id, { ...state, id });
  const buttons = new Map<string, TimelineFrameButton>();
  const camera = { ...bases.camera };
  let bgmVolume = bases.bgm_volume ?? 1;
  const ambienceVolumes: Partial<Record<AmbienceSlot, number>> = {};
  const videos: TimelineFrameVideo[] = [];

  for (const [id, base] of Object.entries(bases.sprites)) {
    sprites.set(id, {
      id,
      ...base,
      asset: spriteResourceId(base),
      width: base.width,
      height: base.height,
    });
  }
  for (const [id, base] of Object.entries(bases.buttons ?? {})) {
    buttons.set(id, { id, ...base });
  }
  for (const track of cue.tracks) {
    if (track.type === "sprite") {
      const base = spriteTrackState(bases.sprites[track.sprite_id], track);
      sprites.set(track.sprite_id, {
        ...base,
        id: track.sprite_id,
        asset: spriteResourceId(base),
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
        width: bases.sprites[track.sprite_id]?.width,
        height: bases.sprites[track.sprite_id]?.height,
      });
    } else if (track.type === "emitter") {
      const base = bases.emitters?.[track.emitter_id];
      if (base === undefined) throw new Error(`发射器 ${track.emitter_id} 未启动，无法应用时间线`);
      emitters.set(track.emitter_id, {
        ...base, id: track.emitter_id,
        x: evaluateChannel(track.channels, "x", elapsed, base.x),
        y: evaluateChannel(track.channels, "y", elapsed, base.y),
        scale: evaluateChannel(track.channels, "scale", elapsed, base.scale),
        rotation_deg: evaluateChannel(track.channels, "rotation_deg", elapsed, base.rotation_deg),
        opacity: evaluateChannel(track.channels, "opacity", elapsed, base.opacity),
        z: Math.round(evaluateChannel(track.channels, "z", elapsed, base.z)),
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
    } else if (track.type === "ambience") {
      const base = bases.ambience_volumes?.[track.slot] ?? 1;
      ambienceVolumes[track.slot] = evaluateChannel(
        track.channels,
        "volume",
        elapsed,
        base,
      );
    }
  }
  // Keep untracked starting sprites in the evaluated frame.  This is the
  // important inheritance rule used by both the editor and player.
  return {
    elapsed_ms: elapsed,
    sprites: [...sprites.values()],
    ...(emitters.size === 0 ? {} : { emitters: [...emitters.values()] }),
    buttons: [...buttons.values()],
    camera,
    videos,
    bgm_volume: Number.isFinite(bgmVolume) ? bgmVolume : 0,
    ...(Object.keys(ambienceVolumes).length > 0
      ? { ambience_volumes: ambienceVolumes }
      : {}),
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

