import type {
  ContentManifest,
  SceneNode,
  TimelineChannels,
  TimelineNode,
} from "../types";
import { spritePreset } from "@vectspace/presentation-core/visual";
import { nodeLabel } from "./defaults";

export function canConvertToTimeline(node: SceneNode): boolean {
  return ["sprite", "camera", "screen_effect", "wait", "sfx"].includes(
    node.type,
  );
}

/**
 * Resolve the artwork a sprite node will use at runtime.  A node may omit
 * `asset` when its character and expression point to a registered portrait;
 * keeping this lookup in one place prevents the editor from treating that
 * valid form as an incomplete direct-sprite node.
 */
export function resolveSpriteAsset(
  node: Extract<SceneNode, { type: "sprite" }>,
  manifest?: ContentManifest,
): string | null {
  if (node.source !== undefined)
    return node.source.type === "image" ? node.source.asset : null;
  if (node.asset != null && node.asset !== "") return node.asset;
  if (node.character == null || node.character === "") return null;
  if (manifest === undefined) return null;
  const character = manifest.characters[node.character];
  if (character === undefined) return null;
  const expressionId = node.expression ?? character.default_expression;
  return expressionId == null
    ? null
    : ((character.expressions ?? {})[expressionId]?.asset ?? null);
}

/**
 * Expand one compact presentation node into an editable Timeline node. Move,
 * hide and camera channels explicitly inherit the runtime value at 0ms, so
 * conversion is independent of the route used to reach the node.
 */
export function convertToTimeline(
  node: SceneNode,
  manifest?: ContentManifest,
): TimelineNode {
  const timeline = (
    duration_ms: number,
    awaitCompletion: boolean,
  ): TimelineNode => ({
    type: "timeline",
    duration_ms: Math.max(1, duration_ms),
    await: awaitCompletion,
    skippable: false,
    tracks: [],
    events: [],
    next: "next" in node ? node.next : "",
  });

  if (node.type === "wait") return timeline(node.duration_ms, true);
  if (node.type === "sfx") {
    return {
      ...timeline(1, false),
      events: [
        {
          type: "sfx",
          id: "quick_sfx",
          at_ms: 0,
          asset: node.asset,
          volume: node.volume,
        },
      ],
    };
  }
  if (node.type === "screen_effect") {
    const result = timeline(node.duration_ms, node.await);
    result.events = [
      {
        type: "screen_effect",
        id: "quick_effect",
        at_ms: 0,
        effect: node.effect,
        duration_ms: node.duration_ms,
      },
    ];
    return result;
  }
  if (node.type === "camera") {
    const result = timeline(node.duration_ms, node.await);
    result.tracks = [
      {
        type: "camera",
        channels: inheritedChannels(
          {
            x: node.x,
            y: node.y,
            zoom: node.zoom,
          },
          result.duration_ms,
          node.easing,
        ),
      },
    ];
    return result;
  }
  if (node.type === "sprite") {
    const result = timeline(node.duration_ms, node.await);
    const resolvedAsset =
      node.action === "hide"
        ? (node.asset ?? null)
        : resolveSpriteAsset(node, manifest);
    let channels: TimelineChannels;
    if (node.action === "show") {
      const source =
        node.source ??
        (resolvedAsset === null
          ? null
          : { type: "image" as const, asset: resolvedAsset });
      if (source === null) {
        throw new Error(
          "显示 Sprite 缺少图片、文本块或有效角色表情，无法转换。",
        );
      }
      const preset = spritePreset(
        node.sprite_kind ?? (source.type === "text" ? "text" : "character"),
        source,
      );
      const target = {
        x: node.x ?? preset.x,
        y: node.y ?? preset.y,
        scale: node.scale ?? preset.scale,
        scale_x: node.scale_x ?? preset.scale_x,
        scale_y: node.scale_y ?? preset.scale_y,
        rotation_deg: node.rotation_deg ?? preset.rotation_deg,
        opacity: node.opacity ?? preset.opacity,
        z: node.z ?? preset.z,
      };
      channels = pairedChannels(
        { ...target, y: target.y + 48, scale: target.scale * 0.96, opacity: 0 },
        target,
        result.duration_ms,
        node.easing,
      );
    } else if (node.action === "hide") {
      channels = inheritedChannels(
        { opacity: 0 },
        result.duration_ms,
        node.easing,
      );
    } else {
      channels = inheritedChannels(
        Object.fromEntries(
          Object.entries({
            x: node.x,
            y: node.y,
            scale: node.scale,
            scale_x: node.scale_x,
            scale_y: node.scale_y,
            rotation_deg: node.rotation_deg,
            opacity: node.opacity,
            z: node.z,
          }).filter((entry): entry is [string, number] => entry[1] != null),
        ),
        result.duration_ms,
        node.easing,
      );
    }
    result.tracks = [
      {
        type: "sprite",
        sprite_id: node.sprite_id,
        ...(node.source === undefined
          ? { asset: resolvedAsset }
          : { source: node.source }),
        ...(node.sprite_kind === undefined
          ? {}
          : { sprite_kind: node.sprite_kind }),
        ...(node.space === undefined ? {} : { space: node.space }),
        ...(node.layout === undefined ? {} : { layout: node.layout }),
        remove_at_end: node.action === "hide",
        channels,
      },
    ];
    return result;
  }
  throw new Error(`${nodeLabel(node.type)}节点不能无损转换为关键帧时间线。`);
}

function pairedChannels(
  start: Record<string, number>,
  end: Record<string, number>,
  durationMs: number,
  easing: "linear" | "ease_in" | "ease_out" | "ease_in_out",
): TimelineChannels {
  return Object.fromEntries(
    Object.keys(end).map((channel) => [
      channel,
      [
        {
          at_ms: 0,
          value: start[channel] ?? end[channel] ?? 0,
          easing: channel === "z" ? "step" : easing,
        },
        {
          at_ms: durationMs,
          value: end[channel] ?? 0,
          easing: "linear",
        },
      ],
    ]),
  );
}

function inheritedChannels(
  end: Record<string, number>,
  durationMs: number,
  easing: "linear" | "ease_in" | "ease_out" | "ease_in_out",
): TimelineChannels {
  return Object.fromEntries(
    Object.entries(end).map(([channel, value]) => [
      channel,
      [
        {
          at_ms: 0,
          value: "inherit" as const,
          easing: channel === "z" ? ("step" as const) : easing,
        },
        { at_ms: durationMs, value, easing: "linear" as const },
      ],
    ]),
  );
}
