import { describe, expect, it } from "vitest";
import {
  emptyActiveScreenEffects,
  evaluateActiveScreenEffects,
  evaluateTimelineFrame,
} from "./timelineEvaluator";

describe("evaluateTimelineFrame", () => {
  it("evaluates button transform tracks without changing the hit-area model", () => {
    const frame = evaluateTimelineFrame(
      {
        duration_ms: 1_000,
        tracks: [
          {
            type: "button",
            instance_id: "confirm",
            channels: {
              x: [
                { at_ms: 0, value: "inherit", easing: "linear" },
                { at_ms: 1_000, value: 600, easing: "ease_in_out" },
              ],
              width: [
                { at_ms: 0, value: 200, easing: "linear" },
                { at_ms: 1_000, value: 300, easing: "linear" },
              ],
            },
          },
        ],
      },
      {
        sprites: {},
        buttons: {
          confirm: {
            x: 100,
            y: 200,
            width: 200,
            height: 80,
            scale_x: 1,
            scale_y: 1,
            rotation_deg: 0,
            opacity: 1,
            z: 4,
          },
        },
        camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
      },
      500,
    );
    expect(frame.buttons).toHaveLength(1);
    expect(frame.buttons[0]).toMatchObject({
      id: "confirm",
      x: 350,
      y: 200,
      width: 250,
      z: 4,
    });
  });

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

  it("evaluates ambience volume tracks per slot without changing authoritative audio state", () => {
    const frame = evaluateTimelineFrame(
      {
        duration_ms: 1_000,
        tracks: [
          {
            type: "ambience",
            slot: "slot_1",
            channels: {
              volume: [
                { at_ms: 0, value: 0.2, easing: "linear" },
                { at_ms: 1_000, value: 0.8, easing: "linear" },
              ],
            },
          },
          {
            type: "ambience",
            slot: "slot_4",
            channels: {
              volume: [{ at_ms: 0, value: 0.4, easing: "linear" }],
            },
          },
        ],
      },
      {
        sprites: {},
        camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
        ambience_volumes: { slot_1: 0.6, slot_4: 0.9 },
      },
      500,
    );
    expect(frame.bgm_volume).toBe(1);
    expect(frame.ambience_volumes).toEqual({ slot_1: 0.5, slot_4: 0.4 });
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
        effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 },
        duration_ms: 400,
      },
      {
        type: "screen_effect",
        id: "shake-a",
        at_ms: 200,
        effect: {
          type: "shake",
          amplitude_x: 16,
          amplitude_y: 9.6,
          frequency_hz: 18,
          decay: 1,
          seed: 0,
        },
        duration_ms: 500,
      },
      // The later flash wins while both flash intervals overlap.
      {
        type: "screen_effect",
        id: "flash-b",
        at_ms: 300,
        effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 },
        duration_ms: 400,
      },
    ] as const;

    expect(evaluateActiveScreenEffects(events, 50)).toMatchObject({
      flash: null,
      shake: null,
    });
    expect(evaluateActiveScreenEffects(events, 350)).toMatchObject({
      flash: { startMs: 300, durationMs: 400 },
      shake: { startMs: 200, durationMs: 500 },
    });
    expect(evaluateActiveScreenEffects(events, 701)).toMatchObject({
      flash: null,
      shake: null,
    });
  });
});

describe("evaluateActiveScreenEffects overlap rules", () => {
  const events = [
    {
      type: "screen_effect",
      id: "early-flash",
      at_ms: 100,
      effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 },
      duration_ms: 900,
    },
    {
      type: "screen_effect",
      id: "early-shake",
      at_ms: 150,
      effect: {
        type: "shake",
        amplitude_x: 16,
        amplitude_y: 9.6,
        frequency_hz: 18,
        decay: 1,
        seed: 0,
      },
      duration_ms: 900,
    },
    {
      type: "screen_effect",
      id: "late-flash",
      at_ms: 500,
      effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 },
      duration_ms: 400,
    },
  ] as const;

  it("lets the latest start win and keeps flash and shake independent", () => {
    const active = evaluateActiveScreenEffects(events, 600);
    expect(active.flash).toMatchObject({ startMs: 500, durationMs: 400 });
    expect(active.shake).toMatchObject({ startMs: 150, durationMs: 900 });
  });

  it("keeps the later array entry when timestamps are equal", () => {
    const sameTime = [
      {
        type: "screen_effect",
        id: "first",
        at_ms: 100,
        effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 },
        duration_ms: 500,
      },
      {
        type: "screen_effect",
        id: "second",
        at_ms: 100,
        effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 },
        duration_ms: 600,
      },
    ] as const;
    expect(evaluateActiveScreenEffects(sameTime, 200).flash).toMatchObject({
      startMs: 100,
      durationMs: 600,
    });
  });

  it("resolves same-kind shake overlaps with the latest start and the later array entry", () => {
    const shakes = [
      {
        type: "screen_effect",
        id: "shake-a",
        at_ms: 100,
        effect: {
          type: "shake",
          amplitude_x: 16,
          amplitude_y: 9.6,
          frequency_hz: 18,
          decay: 1,
          seed: 0,
        },
        duration_ms: 900,
      },
      {
        type: "screen_effect",
        id: "shake-b",
        at_ms: 100,
        effect: {
          type: "shake",
          amplitude_x: 16,
          amplitude_y: 9.6,
          frequency_hz: 18,
          decay: 1,
          seed: 0,
        },
        duration_ms: 600,
      },
      {
        type: "screen_effect",
        id: "shake-c",
        at_ms: 500,
        effect: {
          type: "shake",
          amplitude_x: 16,
          amplitude_y: 9.6,
          frequency_hz: 18,
          decay: 1,
          seed: 0,
        },
        duration_ms: 100,
      },
    ] as const;
    // Equal starts: the later array entry owns the interval.
    expect(evaluateActiveScreenEffects(shakes, 300).shake).toMatchObject({
      startMs: 100,
      durationMs: 600,
    });
    // A later start supersedes both, regardless of duration.
    expect(evaluateActiveScreenEffects(shakes, 550).shake).toMatchObject({
      startMs: 500,
      durationMs: 100,
    });
    // When the later intervals end, the still-running early one is active.
    expect(evaluateActiveScreenEffects(shakes, 800).shake).toMatchObject({
      startMs: 100,
      durationMs: 900,
    });
  });

  it("falls back to the still-running effect and then drops both", () => {
    // Once the later flash interval ends, the earlier one is active again.
    const active = evaluateActiveScreenEffects(events, 950);
    expect(active.flash).toMatchObject({ startMs: 100, durationMs: 900 });
    expect(active.shake).toMatchObject({ startMs: 150, durationMs: 900 });
    expect(evaluateActiveScreenEffects(events, 1_050)).toMatchObject({
      flash: null,
      shake: null,
    });
  });
});

describe("evaluateActiveScreenEffects shader channels", () => {
  const chromatic = {
    type: "chromatic_aberration",
    intensity: 12,
    angle_deg: 0,
    center_x: 960,
    center_y: 540,
    edge_weight: 0.6,
    fade_in: 0,
    fade_out: 1,
  } as const;
  const glitch = {
    type: "glitch",
    displacement: 48,
    slice_count: 16,
    density: 0.35,
    frequency_hz: 12,
    seed: 0,
    fade_in: 0,
    fade_out: 0,
  } as const;
  const events = [
    {
      type: "screen_effect",
      id: "wave",
      at_ms: 0,
      effect: {
        type: "shockwave",
        center_x: 960,
        center_y: 540,
        max_radius: 1100,
        wave_width: 140,
        strength: 28,
      },
      duration_ms: 700,
    },
    {
      type: "screen_effect",
      id: "shake",
      at_ms: 0,
      effect: {
        type: "shake",
        amplitude_x: 16,
        amplitude_y: 9.6,
        frequency_hz: 18,
        decay: 1,
        seed: 0,
      },
      duration_ms: 400,
    },
    {
      type: "screen_effect",
      id: "split-a",
      at_ms: 100,
      effect: chromatic,
      duration_ms: 800,
    },
    {
      type: "screen_effect",
      id: "break",
      at_ms: 200,
      effect: glitch,
      duration_ms: 200,
    },
    {
      type: "screen_effect",
      id: "split-b",
      at_ms: 300,
      effect: { ...chromatic, intensity: 30 },
      duration_ms: 100,
    },
  ] as const;

  it("keeps every effect kind on its own channel", () => {
    const active = evaluateActiveScreenEffects(events, 250);
    expect(active.shockwave).toMatchObject({ startMs: 0, durationMs: 700 });
    expect(active.shake).toMatchObject({ startMs: 0, durationMs: 400 });
    expect(active.chromatic_aberration).toMatchObject({ startMs: 100 });
    expect(active.glitch).toMatchObject({ startMs: 200, durationMs: 200 });
    expect(active.flash).toBeNull();
    // A shader effect never lands on the shake channel.
    expect(active.shake?.effect.type).toBe("shake");
  });

  it("lets the latest chromatic window win and falls back when it ends", () => {
    expect(
      evaluateActiveScreenEffects(events, 350).chromatic_aberration,
    ).toMatchObject({ startMs: 300, effect: { intensity: 30 } });
    expect(
      evaluateActiveScreenEffects(events, 450).chromatic_aberration,
    ).toMatchObject({ startMs: 100, effect: { intensity: 12 } });
    expect(evaluateActiveScreenEffects(events, 900)).toMatchObject({
      shockwave: null,
      chromatic_aberration: null,
      glitch: null,
    });
  });

  it("keys the new effects on their own channels", () => {
    const colorGrade = {
      type: "color_grade",
      brightness: 0.2,
      contrast: 1.3,
      saturation: 1.4,
      tint: "#ffffff",
      tint_strength: 0.5,
      intensity: 1,
      fade_in: 0,
      fade_out: 0,
    } as const;
    const focus = {
      type: "focus",
      center_x: 960,
      center_y: 540,
      radius: 280,
      softness: 160,
      blur: 8,
      darkness: 0.3,
      intensity: 1,
      fade_in: 0,
      fade_out: 0,
    } as const;
    const ripple = {
      type: "ripple",
      center_x: 960,
      center_y: 540,
      amplitude: 12,
      wavelength: 160,
      speed: 240,
      damping: 1,
      intensity: 1,
      fade_in: 0,
      fade_out: 0,
    } as const;
    const newEvents = [
      {
        type: "screen_effect",
        id: "grade",
        at_ms: 100,
        effect: colorGrade,
        duration_ms: 500,
      },
      {
        type: "screen_effect",
        id: "dof",
        at_ms: 200,
        effect: focus,
        duration_ms: 500,
      },
      {
        type: "screen_effect",
        id: "wave",
        at_ms: 300,
        effect: ripple,
        duration_ms: 500,
      },
    ] as const;
    const active = evaluateActiveScreenEffects(newEvents, 350);
    expect(active.color_grade).toMatchObject({ startMs: 100 });
    expect(active.focus).toMatchObject({ startMs: 200 });
    expect(active.ripple).toMatchObject({ startMs: 300 });
    // None of them leak onto the geometric channels.
    expect(active.shake).toBeNull();
    expect(active.flash).toBeNull();
    expect(evaluateActiveScreenEffects(newEvents, 1_000)).toMatchObject({
      color_grade: null,
      focus: null,
      ripple: null,
    });
  });

  it("opens every channel empty", () => {
    expect(emptyActiveScreenEffects()).toEqual({
      flash: null,
      shake: null,
      chromatic_aberration: null,
      glitch: null,
      shockwave: null,
      color_grade: null,
      focus: null,
      ripple: null,
    });
  });
});
