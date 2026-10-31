import { describe, expect, it } from "vitest";
import {
  copyTimelineKeyframesFrom,
  expandSpriteActionNode,
  expandSpriteActionTrack,
  pasteTimelineKeyframesInto,
  snapTimelineTime,
  spriteActionToTimelineNode,
  timelineNodeToSpriteAction,
  timelineTrackIdentity,
  type TimelineKeyframeAddress,
  type TimelineKeyframeClipboard,
} from "./timeline";
import type {
  SpriteActionDefinition,
  SpriteSnapshot,
  TimelineNode,
  TimelineTrack,
} from "./types";

const copyTimelineKeyframes = (
  node: TimelineNode,
  addresses: readonly TimelineKeyframeAddress[],
) => copyTimelineKeyframesFrom(node.tracks, timelineTrackIdentity, addresses);

const pasteTimelineKeyframes = (
  node: TimelineNode,
  clipboard: TimelineKeyframeClipboard,
  playheadMs: number,
  snapMs: number,
) => {
  const { document, pasted, skipped } = pasteTimelineKeyframesInto(
    node,
    timelineTrackIdentity,
    () => ["x", "y"],
    (track: TimelineTrack) => track.type !== "video",
    clipboard,
    playheadMs,
    snapMs,
  );
  return { node: document, pasted, skipped };
};

describe("timeline keyframe clipboard", () => {
  const node = (): TimelineNode => ({
    type: "timeline",
    duration_ms: 1000,
    await: true,
    skippable: true,
    tracks: [
      {
        type: "sprite",
        sprite_id: "alice",
        asset: "sprite.alice",
        remove_at_end: false,
        channels: {
          x: [
            { at_ms: 100, value: 10, easing: "linear" },
            { at_ms: 300, value: 30, easing: "ease_out" },
          ],
          y: [{ at_ms: 200, value: 20, easing: "linear" }],
        },
      },
      { type: "camera", channels: {} },
    ],
    events: [],
    next: "end",
  });

  it("preserves relative timing and channels when pasting at the playhead", () => {
    const source = node();
    const clipboard = copyTimelineKeyframes(source, [
      { track: 0, channel: "x", index: 0 },
      { track: 0, channel: "y", index: 0 },
    ]);
    expect(clipboard).not.toBeNull();
    if (clipboard === null) throw new Error("expected keyframe clipboard");
    const result = pasteTimelineKeyframes(source, clipboard, 500, 50);
    expect(result.skipped).toBe(0);
    expect(result.pasted).toHaveLength(2);
    expect(result.node.tracks[0]?.channels.x).toContainEqual({
      at_ms: 500,
      value: 10,
      easing: "linear",
    });
    expect(result.node.tracks[0]?.channels.y).toContainEqual({
      at_ms: 600,
      value: 20,
      easing: "linear",
    });
  });

  it("overwrites collisions and skips missing tracks or out-of-range frames", () => {
    const source = node();
    const clipboard = copyTimelineKeyframes(source, [
      { track: 0, channel: "x", index: 0 },
      { track: 0, channel: "x", index: 1 },
    ]);
    expect(clipboard).not.toBeNull();
    if (clipboard === null) throw new Error("expected keyframe clipboard");
    const collision = pasteTimelineKeyframes(source, clipboard, 100, 50);
    expect(collision.node.tracks[0]?.channels.x).toHaveLength(2);

    const short = { ...source, duration_ms: 150 };
    const clipped = pasteTimelineKeyframes(short, clipboard, 100, 50);
    expect(clipped.pasted).toHaveLength(1);
    expect(clipped.skipped).toBe(1);

    const camera = source.tracks[1];
    if (camera === undefined) throw new Error("expected camera track");
    const withoutAlice = { ...source, tracks: [camera] };
    const missing = pasteTimelineKeyframes(withoutAlice, clipboard, 0, 50);
    expect(missing.pasted).toHaveLength(0);
    expect(missing.skipped).toBe(2);
  });

  it("keeps inherited frames at zero and rejects them on video tracks", () => {
    const source = node();
    const sourceTrack = source.tracks[0];
    if (sourceTrack === undefined) throw new Error("expected sprite track");
    sourceTrack.channels.x = [
      { at_ms: 0, value: "inherit", easing: "linear" },
      { at_ms: 300, value: 30, easing: "linear" },
    ];
    const clipboard = copyTimelineKeyframes(source, [
      { track: 0, channel: "x", index: 0 },
    ]);
    expect(clipboard).not.toBeNull();
    if (clipboard === null) throw new Error("expected keyframe clipboard");
    expect(pasteTimelineKeyframes(source, clipboard, 500, 50)).toMatchObject({
      pasted: [],
      skipped: 1,
    });

    const video: TimelineNode = {
      ...source,
      tracks: [
        {
          type: "video",
          asset: "video.demo",
          fit: "contain",
          clip_start_ms: 0,
          clip_end_ms: null,
          loop: false,
          audio_enabled: false,
          channels: { x: [] },
        },
      ],
    };
    const videoClipboard = {
      items: [
        {
          trackIdentity: "video",
          channel: "x",
          offsetMs: 0,
          frame: {
            at_ms: 0,
            value: "inherit" as const,
            easing: "linear" as const,
          },
        },
      ],
    };
    expect(pasteTimelineKeyframes(video, videoClipboard, 0, 50)).toMatchObject({
      pasted: [],
      skipped: 1,
    });
  });
});

describe("sprite action inlining", () => {
  it("creates an equivalent timeline call with its duration and end policy", () => {
    const node = {
      type: "action" as const,
      sprite_id: "alice",
      action: "bob",
      duration_ms: 240,
      await: true,
      parameters: { distance: 12 },
      end: "restore" as const,
      next: "dialogue",
    };
    const action: SpriteActionDefinition = {
      schema_version: 1,
      id: "bob",
      name: "轻跳",
      duration_ms: 120,
      channels: {
        x: [
          { at_ms: 0, value: 0, easing: "linear" },
          {
            at_ms: 120,
            value: 1,
            easing: "ease_out",
            parameter: "distance",
          },
        ],
      },
      parameters: { distance: { default: 8, min: 0, max: 50 } },
      end: "hold",
    };
    const timeline = expandSpriteActionNode({
      node,
      action,
      base: {
        asset: "sprite.alice",
        x: 100,
        y: 800,
        scale: 1,
        scale_x: 1,
        scale_y: 1,
        rotation_deg: 0,
        opacity: 1,
        z: 2,
      },
    });
    expect(timeline.duration_ms).toBe(240);
    expect(timeline.await).toBe(true);
    expect(timeline.next).toBe("dialogue");
    expect(timeline.tracks[0]).toMatchObject({
      type: "sprite",
      sprite_id: "alice",
      channels: {
        x: [
          { at_ms: 0, value: 100 },
          { at_ms: 240, value: 100 },
        ],
      },
    });
  });
});

describe("timeline marker snapping", () => {
  it("uses the marker when it is closer than the timing grid", () => {
    expect(snapTimelineTime(478, 50, 480)).toBe(480);
    expect(snapTimelineTime(459, 50, 480)).toBe(450);
  });
});

describe("reusable sprite action expansion", () => {
  it("matches relative offsets, parameter defaults, overrides, and restore", () => {
    const action: SpriteActionDefinition = {
      schema_version: 1,
      id: "sprite.bob",
      name: "轻跳",
      duration_ms: 100,
      channels: {
        x: [
          { at_ms: 0, value: 0, easing: "linear" },
          {
            at_ms: 50,
            value: 10,
            easing: "ease_out",
            parameter: "distance",
          },
        ],
      },
      parameters: { distance: { default: 8, min: 0, max: 20 } },
      end: "restore",
    };
    const base: SpriteSnapshot = {
      asset: "sprite.alice",
      x: 40,
      y: 20,
      scale: 1,
      scale_x: 1,
      scale_y: 1,
      rotation_deg: 0,
      opacity: 1,
      z: 1,
    };
    const track = expandSpriteActionTrack({
      action,
      spriteId: "alice",
      base,
      durationMs: 200,
      parameters: { distance: 12 },
    });
    expect(track.type).toBe("sprite");
    if (track.type !== "sprite") throw new Error("expected sprite track");
    expect(track.channels.x).toEqual([
      { at_ms: 0, value: 40, easing: "linear" },
      { at_ms: 100, value: 52, easing: "ease_out" },
      { at_ms: 200, value: 40, easing: "linear" },
    ]);
  });

  it("rejects unknown or out-of-range parameters", () => {
    const action: SpriteActionDefinition = {
      schema_version: 1,
      id: "sprite.test",
      name: "测试",
      duration_ms: 100,
      channels: { x: [{ at_ms: 0, value: 0, easing: "linear" }] },
      parameters: { distance: { default: 1, min: 0, max: 2 } },
    };
    const base: SpriteSnapshot = {
      asset: "sprite.alice",
      x: 0,
      y: 0,
      scale: 1,
      scale_x: 1,
      scale_y: 1,
      rotation_deg: 0,
      opacity: 1,
      z: 0,
    };
    expect(() =>
      expandSpriteActionTrack({
        action,
        spriteId: "alice",
        base,
        parameters: { missing: 1 },
      }),
    ).toThrow("未声明");
    expect(() =>
      expandSpriteActionTrack({
        action,
        spriteId: "alice",
        base,
        parameters: { distance: 3 },
      }),
    ).toThrow("超出");
  });
});

describe("sprite action keyframe conversion", () => {
  const action: SpriteActionDefinition = {
    schema_version: 1,
    id: "sprite.bounce",
    name: "小跳",
    duration_ms: 600,
    end: "restore",
    parameters: { height: { default: 40, min: 0, max: 200 } },
    channels: {
      y: [
        { at_ms: 0, value: 0, easing: "linear" },
        { at_ms: 300, value: -1, easing: "ease_in_out", parameter: "height" },
        { at_ms: 600, value: 0, easing: "linear" },
      ],
      opacity: [
        { at_ms: 0, value: 1, easing: "linear" },
        { at_ms: 600, value: 0.5, easing: "linear" },
      ],
    },
  };

  it("projects relative channels onto an absolute single-sprite timeline", () => {
    const node = spriteActionToTimelineNode({ definition: action });
    expect(node.duration_ms).toBe(600);
    expect(node.tracks).toHaveLength(1);
    const track = node.tracks[0];
    expect(track.type).toBe("sprite");
    // Position offsets are added to the base pose, multipliers are applied.
    // A parameter-bound keyframe resolves to the *parameter default*, so the
    // authored fallback (`-1`) is intentionally not used.
    expect(track.channels.y.map((frame) => frame.value)).toEqual([
      1080, 1120, 1080,
    ]);
    expect(track.channels.opacity.map((frame) => frame.value)).toEqual([
      1, 0.5,
    ]);
    // The parameter default is resolved for display, not baked into the file.
    expect(action.channels.y[1].parameter).toBe("height");
  });

  it("keeps the parameter binding while the value still matches its default", () => {
    const node = spriteActionToTimelineNode({ definition: action });
    const folded = timelineNodeToSpriteAction(node, action);
    expect(folded.channels.y[1]).toEqual({
      at_ms: 300,
      value: 40,
      easing: "ease_in_out",
      parameter: "height",
    });
    expect(folded.duration_ms).toBe(600);
    expect(folded.parameters).toEqual(action.parameters);
    expect(folded.end).toBe("restore");
  });

  it("detaches a keyframe from its parameter once the author edits the number", () => {
    const node = spriteActionToTimelineNode({ definition: action });
    const track = node.tracks[0];
    const edited = {
      ...node,
      tracks: [
        {
          ...track,
          channels: {
            ...track.channels,
            y: track.channels.y.map((frame, index) =>
              index === 1 ? { ...frame, value: 1000 } : frame,
            ),
          },
        },
      ],
    };
    const folded = timelineNodeToSpriteAction(edited, action);
    expect(folded.channels.y[1].value).toBe(-80);
    expect(folded.channels.y[1].parameter).toBeUndefined();
  });

  it("round-trips a channel edit through both representations", () => {
    const node = spriteActionToTimelineNode({ definition: action });
    const track = node.tracks[0];
    const moved = {
      ...node,
      duration_ms: 900,
      tracks: [
        {
          ...track,
          channels: {
            ...track.channels,
            opacity: [
              { at_ms: 0, value: 1, easing: "linear" as const },
              { at_ms: 900, value: 0.25, easing: "linear" as const },
            ],
          },
        },
      ],
    };
    const folded = timelineNodeToSpriteAction(moved, action);
    expect(folded.duration_ms).toBe(900);
    expect(folded.channels.opacity.map((frame) => frame.value)).toEqual([
      1, 0.25,
    ]);
    expect(folded.channels.opacity.map((frame) => frame.at_ms)).toEqual([
      0, 900,
    ]);
  });

  it("refuses a timeline without a sprite track", () => {
    expect(() =>
      timelineNodeToSpriteAction(
        {
          type: "timeline",
          duration_ms: 100,
          await: true,
          skippable: true,
          tracks: [{ type: "camera", channels: {} }],
          events: [],
          next: "continue",
        },
        action,
      ),
    ).toThrow(/立绘轨道/);
  });
});
