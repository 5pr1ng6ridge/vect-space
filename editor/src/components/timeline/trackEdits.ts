import { defaultFlashEffect } from "../../presentationDefaults";
import type { SceneObjectFrame } from "@vectspace/presentation-core/scene-frame";
import type {
  AmbienceSlot,
  TimelineEvent,
  TimelineNode,
  TimelineTrack,
} from "../../types";

const AMBIENCE_SLOTS: readonly AmbienceSlot[] = [
  "slot_1",
  "slot_2",
  "slot_3",
  "slot_4",
];

export function snapTime(
  value: number,
  snap: number,
  duration: number,
): number {
  return Math.max(0, Math.min(duration, Math.round(value / snap) * snap));
}

/** Writes `value` at the snapped `playhead` into one channel of one track. */
export function upsertKeyframe(
  next: TimelineNode,
  trackIndex: number,
  channel: string,
  value: number,
  playhead: number,
  snap: number,
): TimelineNode {
  const tracks = structuredClone(next.tracks);
  const track = tracks[trackIndex];
  if (track === undefined) return next;
  const at = snapTime(playhead, snap, next.duration_ms);
  const frames = [...(track.channels[channel] ?? [])];
  const index = frames.findIndex((frame) => frame.at_ms === at);
  const keyframe = { at_ms: at, value, easing: "linear" as const };
  if (index >= 0) frames[index] = keyframe;
  else {
    if (frames.length === 0 && at > 0 && track.type !== "video") {
      frames.push({ at_ms: 0, value: "inherit", easing: "linear" });
    }
    frames.push(keyframe);
  }
  frames.sort((left, right) => left.at_ms - right.at_ms);
  track.channels[channel] = frames;
  return { ...next, tracks };
}

export function selectedObjectAssetChanged(
  current: TimelineNode,
  next: TimelineNode,
  objectId: string,
): boolean {
  const findAsset = (node: TimelineNode): string | null | undefined => {
    const sprite = node.tracks.find(
      (track) => track.type === "sprite" && track.sprite_id === objectId,
    );
    if (sprite?.type === "sprite") return sprite.asset;
    const video = node.tracks.find(
      (track) => track.type === "video" && `video:${track.asset}` === objectId,
    );
    return video?.type === "video" ? video.asset : undefined;
  };
  const currentAsset = findAsset(current);
  return currentAsset !== undefined && findAsset(next) !== currentAsset;
}

/**
 * Builds the track for the "new track" button: the selected object's own kind
 * wins over the toolbar type.  Returns the author-facing reason when the track
 * cannot be added.
 */
export function planNewTrack({
  current,
  newTrackType,
  objectIds,
  selected,
  selectedButtonInstanceId,
  spriteAsset,
  videoAsset,
}: {
  current: TimelineNode;
  newTrackType: TimelineTrack["type"];
  /** Ids of every object in the current preview frame. */
  objectIds: readonly string[];
  selected: SceneObjectFrame | undefined;
  selectedButtonInstanceId: string;
  spriteAsset: string | null;
  videoAsset: string | null;
}): { track: TimelineTrack } | { error: string } {
  const trackType = selected?.kind ?? newTrackType;
  if (
    trackType === "button" &&
    selected === undefined &&
    selectedButtonInstanceId === ""
  )
    return { error: "当前场景没有可添加到时间线的按钮实例。" };
  if (
    trackType === "button" &&
    current.tracks.some(
      (track) =>
        track.type === "button" &&
        track.instance_id === (selected?.id ?? selectedButtonInstanceId),
    )
  )
    return { error: "同一时间线中不能重复添加同一按钮实例轨道。" };
  if (trackType === "emitter" && selected?.kind !== "emitter")
    return {
      error:
        "请先选择场景中已启动的发射器实例。单次爆发和单个粒子不能添加轨道。",
    };
  if (
    selected?.kind === "emitter" &&
    current.tracks.some(
      (track) =>
        track.type === "emitter" &&
        `emitter:${track.emitter_id}` === selected.id,
    )
  )
    return { error: "选中的发射器已有时间线轨道。" };
  const ambienceSlot =
    AMBIENCE_SLOTS.find(
      (slot) =>
        !current.tracks.some(
          (track) => track.type === "ambience" && track.slot === slot,
        ),
    ) ?? "slot_1";
  if (
    trackType === "ambience" &&
    current.tracks.filter((track) => track.type === "ambience").length >=
      AMBIENCE_SLOTS.length
  )
    return { error: "环境声轨道最多只能使用四个固定槽位。" };
  if (trackType === "video" && selected === undefined && videoAsset === null)
    return { error: "没有可用的视频素材（或全部已隐藏），无法新建视频轨。" };
  if (
    trackType === "video" &&
    current.tracks.some((track) => track.type === "video")
  )
    return { error: "一条时间线只能有一条视频轨。" };
  if (
    (trackType === "camera" || trackType === "bgm") &&
    current.tracks.some((track) => track.type === trackType)
  )
    return { error: `一条时间线只能有一条${trackType}轨。` };
  const spriteId =
    selected?.kind === "sprite"
      ? selected.id
      : (() => {
          const used = new Set([
            ...current.tracks
              .filter((track) => track.type === "sprite")
              .map((track) => track.sprite_id),
            ...objectIds,
          ]);
          let index = 1;
          while (used.has(`sprite_${index}`)) index += 1;
          return `sprite_${index}`;
        })();
  if (
    trackType === "sprite" &&
    current.tracks.some(
      (track) => track.type === "sprite" && track.sprite_id === spriteId,
    )
  )
    return { error: "选中的立绘已有时间线轨道。" };
  switch (trackType) {
    case "sprite":
      return {
        track: {
          type: "sprite",
          sprite_id: spriteId,
          asset: selected?.kind === "sprite" ? null : spriteAsset,
          remove_at_end: false,
          channels: {},
        },
      };
    case "video":
      return {
        track: {
          type: "video",
          asset:
            selected?.kind === "video" ? selected.asset : (videoAsset ?? ""),
          clip_start_ms: 0,
          clip_end_ms: null,
          loop: false,
          fit: "contain",
          audio_enabled: true,
          channels: {},
        },
      };
    case "button":
      return {
        track: {
          type: "button",
          instance_id:
            selected?.kind === "button"
              ? selected.id
              : selectedButtonInstanceId,
          channels: {},
        },
      };
    case "emitter":
      return {
        track: {
          type: "emitter",
          emitter_id: selected?.id.slice("emitter:".length) ?? "",
          remove_at_end: false,
          channels: {},
        },
      };
    case "ambience":
      return { track: { type: "ambience", slot: ambienceSlot, channels: {} } };
    default:
      return { track: { type: trackType, channels: {} } };
  }
}

/** A fresh SFX or flash event at `atMs` with an id unused by `current`. */
export function newTimelineEvent(
  kind: TimelineEvent["type"],
  current: TimelineNode,
  atMs: number,
  sfxAsset: string,
): TimelineEvent {
  const used = new Set(current.events.map((event) => event.id));
  let index = current.events.length + 1;
  const prefix = kind === "sfx" ? "sfx" : "flash";
  while (used.has(`${prefix}_${index}`)) index += 1;
  return kind === "sfx"
    ? {
        type: "sfx",
        id: `${prefix}_${index}`,
        at_ms: atMs,
        asset: sfxAsset,
        volume: 1,
      }
    : {
        type: "screen_effect",
        id: `${prefix}_${index}`,
        at_ms: atMs,
        effect: defaultFlashEffect(),
        duration_ms: Math.max(1, Math.min(200, current.duration_ms - atMs)),
      };
}
