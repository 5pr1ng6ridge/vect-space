import { describe, expect, it } from "vitest";
import corpus from "../../shared/timeline-conformance.json";
import {
  copyTimelineKeyframes,
  evaluateChannel,
  pasteTimelineKeyframes,
  snapTimelineTime,
} from "./timeline";
import type { TimelineEasing, TimelineNode } from "./types";

describe("editor timeline evaluator conformance", () => {
  for (const sample of corpus) {
    it(sample.name, () => {
      expect(
        evaluateChannel(
          {
            value: [
              { at_ms: 0, value: 0, easing: sample.easing as TimelineEasing },
              { at_ms: 1000, value: 10, easing: "linear" },
            ],
          },
          "value",
          sample.time,
          -1,
        ),
      ).toBeCloseTo(sample.expected, 3);
    });
  }

  it("resolves inherit from the concrete preview entry state", () => {
    const channels = {
      x: [
        { at_ms: 0, value: "inherit" as const, easing: "linear" as const },
        { at_ms: 1000, value: 700, easing: "linear" as const },
      ],
    };
    expect(evaluateChannel(channels, "x", 500, 200)).toBe(450);
    expect(evaluateChannel(channels, "x", 500, 500)).toBe(600);
  });
});

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

describe("timeline marker snapping", () => {
  it("uses the marker when it is closer than the timing grid", () => {
    expect(snapTimelineTime(478, 50, 480)).toBe(480);
    expect(snapTimelineTime(459, 50, 480)).toBe(450);
  });
});
