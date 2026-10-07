import type {
  ActionNode,
  SpriteActionDefinition,
  SpriteActionEnd,
  SpriteActionKeyframe,
  SpriteSnapshot,
  TimelineChannels,
  TimelineEasing,
  TimelineKeyframe,
  TimelineNode,
  TimelineTrack,
} from "./types";
import { applyEasing } from "@vectspace/presentation-core/timeline";

export interface SpriteActionExpansionOptions {
  action: SpriteActionDefinition;
  spriteId: string;
  base: SpriteSnapshot;
  durationMs?: number;
  end?: SpriteActionEnd;
  parameters?: Record<string, number>;
}

/**
 * Convert an action call into the ordinary timeline representation used by
 * the timeline editor.  The runtime performs the same expansion against its
 * authoritative starting pose; this helper is deliberately pure and is only
 * used when an author explicitly chooses to inline a call in the editor.
 */
export interface SpriteActionNodeExpansionOptions {
  node: ActionNode;
  action: SpriteActionDefinition;
  base: SpriteSnapshot;
}

export function expandSpriteActionNode(
  options: SpriteActionNodeExpansionOptions,
): TimelineNode {
  const { node, action, base } = options;
  const durationMs = node.duration_ms ?? action.duration_ms;
  return {
    type: "timeline",
    duration_ms: durationMs,
    await: node.await,
    skippable: false,
    tracks: [
      expandSpriteActionTrack({
        action,
        spriteId: node.sprite_id,
        base,
        durationMs,
        end: node.end ?? action.end ?? "hold",
        parameters: node.parameters ?? {},
      }),
    ],
    events: [],
    next: node.next,
  };
}

/**
 * Expand the editor's reusable action into the same absolute sprite track the
 * Rust runtime emits.  This is intentionally a small, side-effect-free helper
 * for the inspector's "解除引用" command and for conformance tests; runtime
 * preview still comes from Rust, so this helper never becomes an authority.
 */
export function expandSpriteActionTrack(
  options: SpriteActionExpansionOptions,
): TimelineTrack {
  const {
    action,
    spriteId,
    base,
    durationMs = action.duration_ms,
    end = action.end ?? "hold",
    parameters = {},
  } = options;
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    throw new Error("动作时长必须大于 0");
  }
  if (!Number.isInteger(action.duration_ms) || action.duration_ms <= 0) {
    throw new Error("动作定义时长必须大于 0");
  }
  for (const parameterId of Object.keys(parameters)) {
    if (action.parameters?.[parameterId] === undefined) {
      throw new Error(`动作参数未声明: ${parameterId}`);
    }
  }
  for (const [parameterId, definition] of Object.entries(
    action.parameters ?? {},
  )) {
    const value = parameters[parameterId] ?? definition.default;
    if (
      !Number.isFinite(value) ||
      (definition.min != null && value < definition.min) ||
      (definition.max != null && value > definition.max)
    ) {
      throw new Error(`动作参数 ${parameterId} 超出声明范围`);
    }
  }
  const channels: Record<string, TimelineKeyframe[]> = {};
  for (const [channel, keyframes] of Object.entries(action.channels)) {
    const expanded: TimelineKeyframe[] = [];
    for (const keyframe of keyframes) {
      const atMs = Math.floor(
        (keyframe.at_ms * durationMs + Math.floor(action.duration_ms / 2)) /
          action.duration_ms,
      );
      const previous = expanded.at(-1);
      if (previous !== undefined && atMs <= previous.at_ms) {
        throw new Error(`动作通道 ${channel} 的关键帧在目标时长下发生重叠`);
      }
      const relative =
        (keyframe.parameter == null
          ? undefined
          : parameters[keyframe.parameter]) ??
        (keyframe.parameter == null
          ? undefined
          : action.parameters?.[keyframe.parameter]?.default) ??
        keyframe.value;
      const baseValue = actionBaseChannelValue(channel, base);
      const absolute = ["x", "y", "rotation_deg"].includes(channel)
        ? baseValue + relative
        : baseValue * relative;
      if (
        !Number.isFinite(absolute) ||
        (channel === "scale" && absolute <= 0) ||
        (["scale_x", "scale_y"].includes(channel) && absolute === 0) ||
        (channel === "opacity" && (absolute < 0 || absolute > 1))
      ) {
        throw new Error(`动作通道 ${channel} 的结果无效`);
      }
      expanded.push({
        at_ms: atMs,
        value: absolute,
        easing: keyframe.easing ?? "linear",
      });
    }
    if (end === "restore") {
      const restore = actionBaseChannelValue(channel, base);
      const last = expanded.at(-1);
      const frame = {
        at_ms: durationMs,
        value: restore,
        easing: "linear" as const,
      };
      if (last?.at_ms === durationMs) expanded[expanded.length - 1] = frame;
      else expanded.push(frame);
    }
    channels[channel] = expanded;
  }
  if (Object.keys(channels).length === 0) {
    throw new Error("动作至少需要一个变换通道");
  }
  return {
    type: "sprite",
    sprite_id: spriteId,
    asset: null,
    remove_at_end: false,
    channels,
  };
}

/**
 * Preview pose an action is authored against.
 *
 * An action stores *relative* channels (position/rotation offsets, scale and
 * opacity multipliers) because its start pose is whatever the sprite looks
 * like when the node runs.  The keyframe editor works with absolute values, so
 * the action workspace converts against one explicit, visible base pose.  The
 * default matches the runtime's own default sprite pose, which keeps
 * round-tripping lossless and predictable.
 */
export const SPRITE_ACTION_PREVIEW_BASE: SpriteSnapshot = {
  asset: "",
  x: 960,
  y: 1080,
  scale: 1,
  scale_x: 1,
  scale_y: 1,
  rotation_deg: 0,
  flip_x: false,
  anchor_x: 0.5,
  anchor_y: 1,
  opacity: 1,
  z: 0,
};

/** Channels an action may drive, in the order the editor lists them. */
export const SPRITE_ACTION_CHANNELS = [
  "x",
  "y",
  "scale",
  "scale_x",
  "scale_y",
  "rotation_deg",
  "opacity",
] as const;

export interface SpriteActionConversionOptions {
  definition: SpriteActionDefinition;
  base?: SpriteSnapshot;
  /** Sprite instance id and artwork used only by the keyframe preview. */
  previewSpriteId?: string;
  previewAsset?: string | null;
}

/**
 * Project a reusable action into the ordinary single-sprite timeline the
 * keyframe editor understands.  Parameter references are resolved with their
 * declared defaults so the preview shows concrete numbers; the binding itself
 * is preserved by {@link timelineNodeToSpriteAction}.
 */
export function spriteActionToTimelineNode(
  options: SpriteActionConversionOptions,
): TimelineNode {
  const {
    definition,
    base = SPRITE_ACTION_PREVIEW_BASE,
    previewSpriteId = definition.id,
    previewAsset = null,
  } = options;
  const channels: TimelineChannels = {};
  for (const [channel, keyframes] of Object.entries(
    definition.channels ?? {},
  )) {
    channels[channel] = keyframes.map((keyframe) => ({
      at_ms: keyframe.at_ms,
      value: actionAbsoluteValue(channel, keyframe, definition, base),
      easing: keyframe.easing ?? "linear",
    }));
  }
  return {
    type: "timeline",
    duration_ms: definition.duration_ms,
    await: true,
    skippable: true,
    tracks: [
      {
        type: "sprite",
        sprite_id: previewSpriteId,
        asset: previewAsset,
        remove_at_end: false,
        channels,
      },
    ],
    events: [],
    next: "continue",
  };
}

/**
 * Fold an edited single-sprite timeline back into the action definition.
 *
 * Values are converted back to relative form against the same base pose used
 * for projection.  A keyframe that still evaluates to its parameter's default
 * keeps its parameter binding; editing the number detaches that keyframe so
 * the author's intent stays explicit instead of silently discarded.
 */
export function timelineNodeToSpriteAction(
  node: TimelineNode,
  definition: SpriteActionDefinition,
  base: SpriteSnapshot = SPRITE_ACTION_PREVIEW_BASE,
): SpriteActionDefinition {
  const track = node.tracks.find(
    (candidate): candidate is Extract<TimelineTrack, { type: "sprite" }> =>
      candidate.type === "sprite",
  );
  if (track === undefined) {
    throw new Error("动作时间线缺少立绘轨道");
  }
  const previous = definition.channels ?? {};
  const channels: Record<string, SpriteActionKeyframe[]> = {};
  for (const [channel, keyframes] of Object.entries(track.channels)) {
    const baseValue = actionBaseChannelValue(channel, base);
    channels[channel] = keyframes.map((keyframe, index) => {
      const value = keyframe.value;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`动作通道 ${channel} 的关键帧必须是数值`);
      }
      const relative = ["x", "y", "rotation_deg"].includes(channel)
        ? value - baseValue
        : baseValue === 0
          ? value
          : value / baseValue;
      const binding = previous[channel]?.[index];
      // A parameter-bound keyframe evaluates to the parameter's value, not to
      // its authored fallback, so the binding survives exactly while the
      // folded number still equals the parameter default.  Any other number
      // means the author edited the keyframe itself, which detaches it.
      const parameterDefault =
        binding?.parameter == null
          ? undefined
          : definition.parameters?.[binding.parameter]?.default;
      const keepParameter =
        parameterDefault !== undefined &&
        Math.abs(parameterDefault - relative) < 1e-6;
      return {
        at_ms: keyframe.at_ms,
        value: relative,
        easing: keyframe.easing ?? "linear",
        ...(keepParameter && binding?.parameter != null
          ? { parameter: binding.parameter }
          : {}),
      };
    });
  }
  const next: SpriteActionDefinition = {
    ...definition,
    duration_ms: node.duration_ms,
    channels,
  };
  if (Object.keys(channels).length === 0) {
    throw new Error("动作至少需要一个变换通道");
  }
  return next;
}

function actionAbsoluteValue(
  channel: string,
  keyframe: SpriteActionKeyframe,
  definition: SpriteActionDefinition,
  base: SpriteSnapshot,
): number {
  const relative =
    (keyframe.parameter == null
      ? undefined
      : definition.parameters?.[keyframe.parameter]?.default) ?? keyframe.value;
  const baseValue = actionBaseChannelValue(channel, base);
  return ["x", "y", "rotation_deg"].includes(channel)
    ? baseValue + relative
    : baseValue * relative;
}

function actionBaseChannelValue(channel: string, base: SpriteSnapshot): number {
  switch (channel) {
    case "x":
      return base.x;
    case "y":
      return base.y;
    case "scale":
      return base.scale;
    case "scale_x":
      return base.scale_x;
    case "scale_y":
      return base.scale_y;
    case "rotation_deg":
      return base.rotation_deg;
    case "opacity":
      return base.opacity;
    default:
      throw new Error(`动作不支持通道 ${channel}`);
  }
}

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
  return copyTimelineKeyframesFrom(
    node.tracks,
    (track: TimelineTrack) => timelineTrackIdentity(track),
    addresses,
  );
}

/**
 * Structural copy shared by every keyframe surface.
 *
 * `identityOf` resolves the stable track address the clipboard stores, so a
 * story track and a button/UI-motion track can use the same clipboard code
 * without sharing a schema.
 */
export function copyTimelineKeyframesFrom<
  TTrack extends { channels: TimelineChannels },
>(
  tracks: readonly TTrack[],
  identityOf: (track: TTrack, index: number) => string,
  addresses: readonly TimelineKeyframeAddress[],
): TimelineKeyframeClipboard | null {
  const resolved = addresses.flatMap((address) => {
    const track = tracks[address.track];
    const frame = track?.channels[address.channel]?.[address.index];
    return track === undefined || frame === undefined
      ? []
      : [{ track, channel: address.channel, frame }];
  });
  const origin = Math.min(...resolved.map(({ frame }) => frame.at_ms));
  if (!Number.isFinite(origin)) return null;
  return {
    items: resolved.map(({ track, channel, frame }) => ({
      trackIdentity: identityOf(track, tracks.indexOf(track)),
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
  const result = pasteTimelineKeyframesInto(
    node,
    (track: TimelineTrack) => timelineTrackIdentity(track),
    (track: TimelineTrack) => timelineTrackChannels(track.type),
    (track: TimelineTrack) => track.type !== "video",
    clipboard,
    playheadMs,
    snapMs,
    snapPointMs,
  );
  return {
    node: result.document,
    pasted: result.pasted,
    skipped: result.skipped,
  };
}

/**
 * Structural paste shared by every keyframe surface.  The document is cloned
 * and only `duration_ms`/`tracks[].channels` are inspected, so a caller's
 * domain fields survive untouched.
 */
export function pasteTimelineKeyframesInto<
  TTrack extends { channels: TimelineChannels },
  TDocument extends { duration_ms: number; tracks: TTrack[] },
>(
  document: TDocument,
  identityOf: (track: TTrack, index: number) => string,
  channelsOf: (track: TTrack, index: number) => readonly string[],
  allowInheritOf: (track: TTrack, index: number) => boolean,
  clipboard: TimelineKeyframeClipboard,
  playheadMs: number,
  snapMs: number,
  snapPointMs?: number,
): {
  document: TDocument;
  pasted: TimelineKeyframeAddress[];
  skipped: number;
} {
  const next = structuredClone(document);
  const targets: { track: number; channel: string; atMs: number }[] = [];
  let skipped = 0;
  const anchor = snapTimelineTime(playheadMs, snapMs, snapPointMs);
  for (const item of clipboard.items) {
    const trackIndex = next.tracks.findIndex(
      (track, index) => identityOf(track, index) === item.trackIdentity,
    );
    const track = next.tracks[trackIndex];
    const atMs = snapTimelineTime(anchor + item.offsetMs, snapMs);
    if (
      track === undefined ||
      !channelsOf(track, trackIndex).includes(item.channel) ||
      atMs < 0 ||
      atMs > next.duration_ms ||
      (item.frame.value === "inherit" &&
        (atMs !== 0 || !allowInheritOf(track, trackIndex)))
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
  return { document: next, pasted, skipped };
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

export function timelineTrackIdentity(track: TimelineTrack): string {
  if (track.type === "sprite") return `sprite:${track.sprite_id}`;
  if (track.type === "emitter") return `emitter:${track.emitter_id}`;
  if (track.type === "button") return `button:${track.instance_id}`;
  if (track.type === "ambience") return `ambience:${track.slot}`;
  return track.type;
}

function timelineTrackChannels(type: TimelineTrack["type"]): string[] {
  switch (type) {
    case "emitter":
      return ["x", "y", "scale", "rotation_deg", "opacity", "z"];
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
    case "button":
      return [
        "x",
        "y",
        "width",
        "height",
        "scale_x",
        "scale_y",
        "rotation_deg",
        "opacity",
        "z",
      ];
    case "video":
      return ["x", "y", "width", "height", "opacity", "z", "volume"];
    case "bgm":
    case "ambience":
      return ["volume"];
  }
}

export function ease(value: number, easing: TimelineEasing): number {
  return applyEasing(value, easing);
}
