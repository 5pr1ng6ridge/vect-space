import type {
  TimelineEasing,
  TimelineKeyframe,
  TimelineNode,
  TimelineTrack,
} from "./types";
import {
  applyEasing,
  evaluateChannel,
} from "@vectspace/presentation-core/timeline";

export { evaluateChannel };

export interface TimelineKeyframeAddress {
  track: number;
  channel: string;
  index: number;
}

export interface TimelineKeyframeClipboard {
  items: {
    trackIdentity: string;
    channel: string;
    offsetMs: number;
    frame: TimelineKeyframe;
  }[];
}

export interface TimelinePasteResult {
  node: TimelineNode;
  pasted: TimelineKeyframeAddress[];
  skipped: number;
}

export function copyTimelineKeyframes(
  node: TimelineNode,
  addresses: readonly TimelineKeyframeAddress[],
): TimelineKeyframeClipboard | null {
  const resolved = addresses.flatMap((address) => {
    const track = node.tracks[address.track];
    const frame = track?.channels[address.channel]?.[address.index];
    return track === undefined || frame === undefined
      ? []
      : [{ track, channel: address.channel, frame }];
  });
  const origin = Math.min(...resolved.map(({ frame }) => frame.at_ms));
  if (!Number.isFinite(origin)) return null;
  return {
    items: resolved.map(({ track, channel, frame }) => ({
      trackIdentity: timelineTrackIdentity(track),
      channel,
      offsetMs: frame.at_ms - origin,
      frame: structuredClone(frame),
    })),
  };
}

export function pasteTimelineKeyframes(
  node: TimelineNode,
  clipboard: TimelineKeyframeClipboard,
  playheadMs: number,
  snapMs: number,
  snapPointMs?: number,
): TimelinePasteResult {
  const next = structuredClone(node);
  const targets: { track: number; channel: string; atMs: number }[] = [];
  let skipped = 0;
  const anchor = snapTimelineTime(playheadMs, snapMs, snapPointMs);
  for (const item of clipboard.items) {
    const trackIndex = next.tracks.findIndex(
      (track) => timelineTrackIdentity(track) === item.trackIdentity,
    );
    const track = next.tracks[trackIndex];
    const atMs = snapTimelineTime(anchor + item.offsetMs, snapMs);
    if (
      track === undefined ||
      !timelineTrackChannels(track.type).includes(item.channel) ||
      atMs < 0 ||
      atMs > next.duration_ms ||
      (item.frame.value === "inherit" && (atMs !== 0 || track.type === "video"))
    ) {
      skipped += 1;
      continue;
    }
    const frames = (track.channels[item.channel] ?? []).filter(
      (frame) => frame.at_ms !== atMs,
    );
    frames.push({ ...structuredClone(item.frame), at_ms: atMs });
    frames.sort((left, right) => left.at_ms - right.at_ms);
    track.channels[item.channel] = frames;
    targets.push({ track: trackIndex, channel: item.channel, atMs });
  }
  const pasted = targets.flatMap((target) => {
    const index =
      next.tracks[target.track]?.channels[target.channel]?.findIndex(
        (frame) => frame.at_ms === target.atMs,
      ) ?? -1;
    return index < 0
      ? []
      : [{ track: target.track, channel: target.channel, index }];
  });
  return { node: next, pasted, skipped };
}

export function snapTimelineTime(
  value: number,
  snap: number,
  snapPointMs?: number,
): number {
  const grid = Math.round(value / Math.max(1, snap)) * Math.max(1, snap);
  if (snapPointMs === undefined || !Number.isFinite(snapPointMs)) return grid;
  return Math.abs(value - snapPointMs) <= Math.abs(value - grid)
    ? snapPointMs
    : grid;
}

function timelineTrackIdentity(track: TimelineTrack): string {
  return track.type === "sprite" ? `sprite:${track.sprite_id}` : track.type;
}

function timelineTrackChannels(type: TimelineTrack["type"]): string[] {
  switch (type) {
    case "sprite":
      return [
        "x",
        "y",
        "scale",
        "scale_x",
        "scale_y",
        "rotation_deg",
        "opacity",
        "z",
      ];
    case "camera":
      return ["x", "y", "zoom", "rotation_deg"];
    case "video":
      return ["x", "y", "width", "height", "opacity", "z", "volume"];
    case "bgm":
      return ["volume"];
  }
}

export function ease(value: number, easing: TimelineEasing): number {
  return applyEasing(value, easing);
}
