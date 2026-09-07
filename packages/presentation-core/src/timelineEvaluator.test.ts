import { describe, expect, it } from "vitest";
import {
  evaluateActiveScreenEffects,
  evaluateTimelineFrame,
} from "./timelineEvaluator";

describe("evaluateTimelineFrame", () => {
  it("evaluates sprite, camera and BGM channels from the same base state", () => {
    const frame = evaluateTimelineFrame(
      {
        duration_ms: 1_000,
        tracks: [
          {
            type: "sprite",
            sprite_id: "alice",
            asset: null,
            channels: {
              x: [
                { at_ms: 0, value: 100, easing: "linear" },
                { at_ms: 1_000, value: 500, easing: "linear" },
              ],
              opacity: [
                { at_ms: 0, value: 1, easing: "linear" },
                { at_ms: 1_000, value: 0, easing: "linear" },
              ],
            },
          },
          {
            type: "camera",
            channels: {
              zoom: [
                { at_ms: 0, value: 1, easing: "linear" },
                { at_ms: 1_000, value: 2, easing: "linear" },
              ],
            },
          },
          {
            type: "bgm",
            channels: {
              volume: [
                { at_ms: 0, value: 1, easing: "linear" },
                { at_ms: 1_000, value: 0.5, easing: "linear" },
              ],
            },
          },
        ],
      },
      {
        sprites: {
          alice: {
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
          bob: {
            asset: "sprite.bob",
            x: 300,
            y: 800,
            scale: 1,
            scale_x: 1,
            scale_y: 1,
            rotation_deg: 0,
            opacity: 1,
            z: 1,
          },
        },
        camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
        bgm_volume: 1,
      },
      500,
    );

    expect(frame.elapsed_ms).toBe(500);
    expect(frame.sprites.find((sprite) => sprite.id === "alice")?.x).toBe(300);
    expect(frame.sprites.find((sprite) => sprite.id === "bob")?.x).toBe(300);
    expect(frame.camera.zoom).toBe(1.5);
    expect(frame.bgm_volume).toBe(0.75);
  });

  it("clamps time and preserves video defaults", () => {
    const frame = evaluateTimelineFrame(
      {
        duration_ms: 100,
        tracks: [{ type: "video", asset: "video.test", channels: {} }],
      },
      {
        sprites: {},
        camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
      },
      1_000,
    );
    expect(frame.elapsed_ms).toBe(100);
    expect(frame.videos[0]).toMatchObject({
      asset: "video.test",
      width: 1920,
      height: 1080,
      opacity: 1,
      volume: 1,
    });
  });

  it("keeps inherited transforms anchored to one captured base", () => {
    const cue = {
      duration_ms: 1_000,
      tracks: [
        {
          type: "sprite" as const,
          sprite_id: "alice",
          asset: null,
          channels: {
            x: [
              {
                at_ms: 500,
                value: "inherit" as const,
                easing: "linear" as const,
              },
              { at_ms: 1_000, value: 100, easing: "linear" as const },
            ],
            scale: [
              {
                at_ms: 500,
                value: "inherit" as const,
                easing: "linear" as const,
              },
              { at_ms: 1_000, value: 3, easing: "linear" as const },
            ],
            scale_x: [
              {
                at_ms: 500,
                value: "inherit" as const,
                easing: "linear" as const,
              },
              { at_ms: 1_000, value: 2, easing: "linear" as const },
            ],
            scale_y: [
              {
                at_ms: 500,
                value: "inherit" as const,
                easing: "linear" as const,
              },
              { at_ms: 1_000, value: 0.5, easing: "linear" as const },
            ],
          },
        },
      ],
    };
    const base = {
      sprites: {
        alice: {
          asset: "sprite.alice",
          x: 0,
          y: 20,
          scale: 1,
          scale_x: 1,
          scale_y: 1,
          rotation_deg: 0,
          opacity: 1,
          z: 0,
        },
      },
      camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
    };

    const atHalf = evaluateTimelineFrame(cue, base, 750);
    const atThreeQuarters = evaluateTimelineFrame(cue, base, 900);
    const afterSeek = evaluateTimelineFrame(cue, base, 900);
    const half = atHalf.sprites[0];
    if (half === undefined) throw new Error("missing evaluated sprite");
    const refed = evaluateTimelineFrame(
      cue,
      {
        ...base,
        sprites: {
          alice: {
            asset: half.asset,
            x: half.x,
            y: half.y,
            scale: half.scale,
            scale_x: half.scale_x,
            scale_y: half.scale_y,
            rotation_deg: half.rotation_deg,
            opacity: half.opacity,
            z: half.z,
          },
        },
      },
      900,
    );
    const expected = atThreeQuarters.sprites[0];
    expect(expected).toMatchObject({
      x: 80,
      scale: 2.6,
      scale_x: 1.8,
      scale_y: 0.6,
    });
    expect(afterSeek.sprites[0]).toEqual(expected);
    expect(refed.sprites[0]?.x).not.toBe(expected?.x);
    expect(refed.sprites[0]?.scale).not.toBe(expected?.scale);
  });

  it("reconstructs overlapping screen effects from timeline time", () => {
    const events = [
      {
        type: "screen_effect",
        id: "flash-a",
        at_ms: 100,
        effect: "flash",
        duration_ms: 400,
      },
      {
        type: "screen_effect",
        id: "shake-a",
        at_ms: 200,
        effect: "shake",
        duration_ms: 500,
      },
      // The later flash wins while both flash intervals overlap.
      {
        type: "screen_effect",
        id: "flash-b",
        at_ms: 300,
        effect: "flash",
        duration_ms: 400,
      },
    ] as const;

    expect(evaluateActiveScreenEffects(events, 50)).toEqual({
      flash: null,
      shake: null,
    });
    expect(evaluateActiveScreenEffects(events, 350)).toEqual({
      flash: { startMs: 300, durationMs: 400 },
      shake: { startMs: 200, durationMs: 500 },
    });
    expect(evaluateActiveScreenEffects(events, 701)).toEqual({
      flash: null,
      shake: null,
    });
  });
});
