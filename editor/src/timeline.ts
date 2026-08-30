import type {
  TimelineChannels,
  TimelineEasing,
  TimelineKeyframe,
  TimelineNode,
  TimelineTrack,
} from "./types";

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

export function evaluateChannel(
  channels: TimelineChannels,
  name: string,
  elapsedMs: number,
  fallback: number,
): number {
  const frames = channels[name];
  if (frames === undefined || frames.length === 0) return fallback;
  const first = firstItem(frames);
  const last = lastItem(frames);
  if (first === undefined || last === undefined) return fallback;
  if (elapsedMs <= first.at_ms) return resolveValue(first.value, fallback);
  if (elapsedMs >= last.at_ms) return resolveValue(last.value, fallback);
  for (let index = 0; index < frames.length - 1; index += 1) {
    const left = frames[index];
    const right = frames[index + 1];
    if (left === undefined || right === undefined) continue;
    if (elapsedMs <= right.at_ms) {
      const progress = (elapsedMs - left.at_ms) / (right.at_ms - left.at_ms);
      return (
        resolveValue(left.value, fallback) +
        (resolveValue(right.value, fallback) -
          resolveValue(left.value, fallback)) *
          ease(progress, left.easing)
      );
    }
  }
  return resolveValue(last.value, fallback);
}

function resolveValue(value: number | "inherit", fallback: number): number {
  return value === "inherit" ? fallback : value;
}

export function ease(value: number, easing: TimelineEasing): number {
  const x = Math.max(0, Math.min(1, value));
  if (typeof easing === "object") {
    const [x1, y1, x2, y2] = easing.cubic_bezier;
    const sample = (t: number, a: number, b: number): number =>
      3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
    let low = 0;
    let high = 1;
    let t = x;
    for (let index = 0; index < 14; index += 1) {
      if (sample(t, x1, x2) < x) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return sample(t, y1, y2);
  }
  if (easing === "step") return x < 1 ? 0 : 1;
  if (easing === "ease_in") return x * x;
  if (easing === "ease_out") return 1 - (1 - x) ** 2;
  if (easing === "ease_in_out")
    return x < 0.5 ? 2 * x ** 2 : 1 - (-2 * x + 2) ** 2 / 2;
  return x;
}

function firstItem<T>(values: readonly T[]): T | undefined {
  for (const value of values) return value;
  return undefined;
}

function lastItem<T>(values: readonly T[]): T | undefined {
  let result: T | undefined;
  for (const value of values) result = value;
  return result;
}
