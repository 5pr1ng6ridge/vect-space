import { describe, expect, it } from "vitest";
import { defaultNode } from "./story";
import {
  defaultChromaticAberrationEffect,
  defaultColorGradeEffect,
  defaultFocusEffect,
  defaultGlitchEffect,
  defaultRippleEffect,
  defaultShockwaveEffect,
} from "./presentationDefaults";
import { storyProject as project } from "./test/storyProject";
import type { EditorProject, SceneNode, ScreenEffectSpec } from "./types";
import { validateLive } from "./validation";

describe("live validation", () => {
  it("reports duplicate step IDs repeated inside a later continuation", () => {
    const invalid = project();
    const scene = invalid.scenes[0].definition;
    const start = defaultNode("long_text", "continuation");
    if (start.type !== "long_text") throw new Error("missing long-text node");
    start.document = "lecture";
    start.steps = [{ id: "statement", text: "开始", page_break_before: false }];
    const continuation = {
      ...start,
      mode: "continue" as const,
      steps: [
        { id: "repeat", text: "一", page_break_before: false },
        { id: "repeat", text: "二", page_break_before: false },
      ],
      next: "end",
    };
    delete continuation.paper;
    delete continuation.pagination;
    delete continuation.font_size;
    delete continuation.text_color;
    delete continuation.layout;
    scene.nodes.lecture = start;
    scene.nodes.continuation = continuation;

    expect(validateLive(invalid)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_long_text_step",
          node_id: "continuation",
        }),
      ]),
    );
  });

  it("reports case-insensitive document path collisions before save", () => {
    const invalid = project();
    invalid.manifest.scenes = ["scenes/main.yaml", "scenes/MAIN.yaml"];
    expect(validateLive(invalid)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_document_path" }),
      ]),
    );
  });

  it.each([
    ["view center that leaves the game viewport", { view_x: 0 }, "map_view"],
    [
      "view center off the 20px grid",
      { width: 4000, height: 2000, view_x: 951, view_y: 1000 },
      "map_view",
    ],
    ["layer outside the Rust i32 range", { z: 2147483648 }, "map_z"],
  ])("rejects a chapter map with a %s", (_label, change, code) => {
    const invalid = project();
    invalid.manifest.chapter_map = "chapter-map.yaml";
    const { z, ...geometry } = { z: undefined, ...change };
    invalid.chapter_map = {
      path: "chapter-map.yaml",
      definition: {
        schema_version: 1,
        width: 1920,
        height: 1080,
        view_x: 960,
        view_y: 540,
        background: null,
        decorations:
          z === undefined
            ? []
            : [
                {
                  id: "decor",
                  asset: "",
                  x: 0,
                  y: 0,
                  width: 20,
                  height: 20,
                  z,
                },
              ],
        hotspots: [],
        ...geometry,
      },
    };
    expect(validateLive(invalid).map((issue) => issue.code)).toContain(code);
  });

  it("reports a broken edge before Rust save validation", () => {
    const broken = project();
    const right = broken.scenes[0].definition.nodes.right;
    if (right.type === "say") right.next = "missing";
    expect(
      validateLive(broken).some(
        (issue) => issue.code === "missing_target_node",
      ),
    ).toBe(true);
  });

  it("matches Rust by rejecting non-finite story node numbers", () => {
    const invalid = project();
    invalid.scenes[0].definition.nodes.bad_sprite = {
      type: "sprite",
      sprite_id: "bad",
      action: "move",
      asset: null,
      x: Number.NaN,
      y: null,
      scale: null,
      opacity: null,
      z: null,
      duration_ms: 0,
      easing: "linear",
      await: false,
      next: "end",
    };
    invalid.scenes[0].definition.nodes.bad_speed = {
      type: "say",
      speaker: null,
      text: "速度错误",
      speed_cps: Number.POSITIVE_INFINITY,
      next: "end",
    };
    invalid.scenes[0].definition.nodes.bad_long_text_font_size = {
      type: "long_text",
      paper: null,
      pagination: "auto",
      font_size: 73,
      steps: [{ id: "step", text: "字号错误", page_break_before: false }],
      speed_cps: null,
      next: "end",
    };

    const codes = validateLive(invalid).map((diagnostic) => diagnostic.code);
    expect(codes).toContain("invalid_sprite_position");
    expect(codes).toContain("invalid_speed");
    expect(codes).toContain("invalid_long_text_font_size");
  });

  it("allows negative axis scale for a timeline mirror but rejects zero", () => {
    const mirrored = project();
    mirrored.scenes[0].definition.nodes.mirror = {
      type: "timeline",
      duration_ms: 100,
      await: true,
      skippable: true,
      tracks: [
        {
          type: "sprite",
          sprite_id: "mirror",
          asset: null,
          remove_at_end: false,
          channels: { scale_x: [{ at_ms: 0, value: -1, easing: "linear" }] },
        },
      ],
      events: [],
      next: "end",
    };
    expect(
      validateLive(mirrored).some(
        (issue) => issue.code === "invalid_timeline_range",
      ),
    ).toBe(false);
    const node = mirrored.scenes[0].definition.nodes.mirror;
    if (node.type !== "timeline" || node.tracks[0]?.type !== "sprite")
      throw new Error("missing track");
    const scaleFrame = node.tracks[0].channels.scale_x?.[0];
    if (scaleFrame === undefined) throw new Error("missing scale keyframe");
    scaleFrame.value = 0;
    expect(
      validateLive(mirrored).some(
        (issue) => issue.code === "invalid_timeline_range",
      ),
    ).toBe(true);
  });

  it("surfaces timeline and BGM data Rust would reject on save", () => {
    const invalid = project();
    invalid.scenes[0].definition.nodes.bad_bgm = {
      type: "bgm",
      action: "start",
      asset: null,
      volume: 1,
      duration_ms: 0,
      await: false,
      start_ms: 50,
      loop_start_ms: 100,
      loop_end_ms: null,
      next: "end",
    };
    invalid.scenes[0].definition.nodes.bad_timeline = {
      type: "timeline",
      duration_ms: 100,
      await: true,
      skippable: true,
      tracks: [
        {
          type: "video",
          asset: "",
          clip_start_ms: 60,
          clip_end_ms: 40,
          loop: false,
          fit: "contain",
          audio_enabled: false,
          channels: { opacity: [] },
        },
        {
          type: "ambience",
          slot: "slot_5" as never,
          channels: { volume: [] },
        },
      ],
      events: [
        {
          type: "screen_effect",
          id: "bad-event",
          at_ms: Number.NaN,
          effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 },
          duration_ms: 60_001,
        },
      ],
      next: "end",
    };

    const codes = validateLive(invalid).map((diagnostic) => diagnostic.code);
    expect(codes).toContain("invalid_bgm_loop");
    expect(codes).toContain("invalid_ambience_slot");
    expect(codes).toContain("invalid_video_clip");
    expect(codes).toContain("empty_timeline_channel");
    expect(codes).toContain("invalid_timeline_event_time");
    expect(codes).toContain("invalid_duration");
  });

  it("validates canonical transition, effect and curtain parameters", () => {
    const fixture = project();
    const scene = fixture.scenes[0].definition;
    scene.nodes.bad_bg = {
      type: "background",
      background: null,
      transition: {
        type: "wipe",
        direction: "left_to_right",
        softness: 2,
      },
      duration_ms: 0,
      easing: "linear",
      await: false,
      next: "end",
    };
    scene.nodes.bad_color = {
      type: "background",
      background: null,
      transition: { type: "fade_through_color", color: "red" },
      duration_ms: 0,
      easing: "linear",
      await: false,
      next: "end",
    };
    scene.nodes.bad_fx = {
      type: "screen_effect",
      effect: {
        type: "shake",
        amplitude_x: 300,
        amplitude_y: -1,
        frequency_hz: 0,
        decay: 2,
        seed: -1,
      },
      duration_ms: 200,
      await: false,
      next: "end",
    };
    scene.nodes.bad_flash = {
      type: "screen_effect",
      effect: { type: "flash", color: "#GGGGGG", peak_alpha: 2 },
      duration_ms: 200,
      await: false,
      next: "end",
    };
    scene.nodes.bad_curtain = {
      type: "curtain",
      action: "cover",
      fill: null,
      transition: { type: "fade" },
      duration_ms: 500,
      easing: "linear",
      await: false,
      next: "end",
    };
    scene.nodes.reveal_fill = {
      type: "curtain",
      action: "reveal",
      fill: { color: "#000000" },
      transition: { type: "fade" },
      duration_ms: 500,
      easing: "linear",
      await: false,
      next: "end",
    };
    scene.nodes.bad_event = {
      type: "timeline",
      duration_ms: 500,
      await: true,
      skippable: false,
      tracks: [],
      events: [
        {
          type: "screen_effect",
          id: "bad",
          at_ms: 0,
          effect: {
            type: "shake",
            amplitude_x: 0,
            amplitude_y: 0,
            frequency_hz: 90,
            decay: 0,
            seed: 1,
          },
          duration_ms: 200,
        },
      ],
      next: "end",
    };
    const codes = validateLive(fixture).map((diagnostic) => diagnostic.code);
    expect(codes).toContain("invalid_transition_softness");
    expect(codes).toContain("invalid_color");
    expect(codes).toContain("invalid_shake_amplitude");
    expect(codes).toContain("invalid_shake_frequency");
    expect(codes).toContain("invalid_shake_decay");
    expect(codes).toContain("invalid_shake_seed");
    expect(codes).toContain("invalid_flash_peak");
    expect(codes).toContain("missing_curtain_fill");
    expect(codes).toContain("invalid_curtain_fill");
    // The timeline event shares the same canonical validation.
    expect(
      validateLive(fixture).filter(
        (diagnostic) =>
          diagnostic.node_id === "bad_event" &&
          diagnostic.code === "invalid_shake_frequency",
      ),
    ).toHaveLength(1);
  });

  it("accepts every new canonical parameter within its range", () => {
    const fixture = project();
    fixture.manifest.assets["gui.curtain"] = {
      kind: "gui",
      path: "gui/curtain.png",
    };
    const scene = fixture.scenes[0].definition;
    scene.nodes.bg = {
      type: "background",
      background: null,
      transition: {
        type: "push",
        direction: "bottom_to_top",
        softness: 1,
      },
      duration_ms: 0,
      easing: "linear",
      await: false,
      next: "end",
    };
    scene.nodes.curtain = {
      type: "curtain",
      action: "cover",
      fill: { asset: "gui.curtain" },
      transition: { type: "wipe", direction: "right_to_left" },
      duration_ms: 500,
      easing: "linear",
      await: false,
      next: "end",
    };
    scene.nodes.fx = {
      type: "screen_effect",
      effect: {
        type: "shake",
        amplitude_x: 256,
        amplitude_y: 0,
        frequency_hz: 0.1,
        decay: 0,
        seed: 0xffff_ffff,
      },
      duration_ms: 200,
      await: false,
      next: "end",
    };
    expect(
      validateLive(fixture).filter((diagnostic) =>
        [
          "invalid_transition_softness",
          "invalid_color",
          "invalid_shake_amplitude",
          "invalid_shake_frequency",
          "invalid_shake_decay",
          "invalid_shake_seed",
          "missing_curtain_fill",
          "invalid_curtain_fill",
        ].includes(diagnostic.code),
      ),
    ).toEqual([]);
  });

  it("validates the shader screen effects like the content model", () => {
    const fixture = project();
    const scene = fixture.scenes[0].definition;
    const node = (effect: ScreenEffectSpec): SceneNode => ({
      type: "screen_effect",
      effect,
      duration_ms: 200,
      await: false,
      next: "end",
    });
    scene.nodes.good_split = node(defaultChromaticAberrationEffect());
    scene.nodes.good_glitch = node(defaultGlitchEffect());
    scene.nodes.good_wave = node(defaultShockwaveEffect());
    scene.nodes.good_grade = node(defaultColorGradeEffect());
    scene.nodes.good_focus = node(defaultFocusEffect());
    scene.nodes.good_ripple = node(defaultRippleEffect());
    const shaderCodes = (): string[] =>
      validateLive(fixture)
        .map((diagnostic) => diagnostic.code)
        .filter((code) =>
          /^invalid_(chromatic|glitch|shockwave|color_grade|focus|ripple)_/.test(
            code,
          ),
        );
    expect(shaderCodes()).toEqual([]);

    scene.nodes.bad_split = node({
      type: "chromatic_aberration",
      intensity: 200,
      angle_deg: 400,
      center_x: -1,
      center_y: 540,
      edge_weight: 2,
      fade_in: 0.7,
      fade_out: 0.7,
    });
    scene.nodes.bad_glitch = node({
      type: "glitch",
      displacement: 600,
      slice_count: 2.5,
      density: 1.5,
      frequency_hz: 0,
      seed: -1,
      fade_in: 0,
      fade_out: 0,
    });
    scene.nodes.bad_wave = node({
      type: "shockwave",
      center_x: 960,
      center_y: 2000,
      max_radius: 0,
      wave_width: 2000,
      strength: 300,
    });
    scene.nodes.bad_grade = node({
      type: "color_grade",
      brightness: 2,
      contrast: -1,
      saturation: 3,
      tint: "not-a-color",
      tint_strength: 2,
      intensity: 2,
      fade_in: 0.6,
      fade_out: 0.6,
    });
    scene.nodes.bad_focus = node({
      type: "focus",
      center_x: 2000,
      center_y: -1,
      radius: 3000,
      softness: 0,
      blur: 40,
      darkness: 2,
      intensity: 2,
      fade_in: 0.5,
      fade_out: 0.6,
    });
    scene.nodes.bad_ripple = node({
      type: "ripple",
      center_x: -1,
      center_y: 2000,
      amplitude: 100,
      wavelength: 2,
      speed: 3000,
      damping: 9,
      intensity: -1,
      fade_in: 0.5,
      fade_out: 0.7,
    });
    expect(new Set(shaderCodes())).toEqual(
      new Set([
        "invalid_chromatic_intensity",
        "invalid_chromatic_angle",
        "invalid_chromatic_center",
        "invalid_chromatic_edge_weight",
        "invalid_chromatic_fade",
        "invalid_glitch_displacement",
        "invalid_glitch_slice_count",
        "invalid_glitch_density",
        "invalid_glitch_frequency",
        "invalid_glitch_seed",
        "invalid_shockwave_center",
        "invalid_shockwave_radius",
        "invalid_shockwave_width",
        "invalid_shockwave_strength",
        "invalid_color_grade_brightness",
        "invalid_color_grade_contrast",
        "invalid_color_grade_saturation",
        "invalid_color_grade_tint_strength",
        "invalid_color_grade_intensity",
        "invalid_color_grade_fade",
        "invalid_focus_center",
        "invalid_focus_radius",
        "invalid_focus_softness",
        "invalid_focus_blur",
        "invalid_focus_darkness",
        "invalid_focus_intensity",
        "invalid_focus_fade",
        "invalid_ripple_center",
        "invalid_ripple_amplitude",
        "invalid_ripple_wavelength",
        "invalid_ripple_speed",
        "invalid_ripple_damping",
        "invalid_ripple_intensity",
        "invalid_ripple_fade",
      ]),
    );
    // The tint uses the shared colour contract, not a shader-private range.
    expect(
      validateLive(fixture).map((diagnostic) => diagnostic.code),
    ).toContain("invalid_color");
  });
});

describe("chapter map reachability", () => {
  function projectWithMap(
    reveal: "completed" | "always",
    replay: "completed" | "always",
  ): EditorProject {
    const base = project();
    return {
      ...base,
      manifest: { ...base.manifest, chapter_map: "chapter-map.yaml" },
      chapter_map: {
        path: "chapter-map.yaml",
        definition: {
          schema_version: 1,
          width: 1920,
          height: 1080,
          view_x: 960,
          view_y: 540,
          background: null,
          decorations: [],
          hotspots: [
            {
              id: "extras",
              scene_id: "extras",
              title: "附录",
              hover_text: null,
              x: 240,
              y: 460,
              width: 280,
              height: 160,
              z: 10,
              asset: null,
              reveal: { mode: reveal },
              replay: { mode: replay },
              variable_overrides: {},
            },
          ],
        },
      },
      scenes: [
        ...base.scenes,
        {
          path: "scenes/extras.yaml",
          definition: {
            schema_version: 2,
            id: "extras",
            entry: "start",
            nodes: { start: { type: "end" } },
          },
        },
      ],
    };
  }

  const unreachable = (project: EditorProject): string[] =>
    validateLive(project)
      .filter((diagnostic) => diagnostic.code === "unreachable_node")
      .map((diagnostic) => `${diagnostic.scene_id}/${diagnostic.node_id}`);

  it("does not report an always-shown, always-replayable chapter as unreachable", () => {
    // The room map is a real entry point, so a chapter reachable only through
    // it must not be flagged as unreachable from the story entry.
    expect(unreachable(projectWithMap("always", "always"))).toEqual([]);
  });

  it("counts only a reached secondary-window entry and its descendants", () => {
    const opened = project();
    opened.scenes[0].definition.nodes.start = {
      type: "open_window",
      scene: "extras",
      next: "end",
    };
    opened.scenes.push({
      path: "scenes/extras.yaml",
      definition: {
        schema_version: 2,
        id: "extras",
        entry: "entry",
        nodes: {
          entry: { type: "jump", scene: null, target: "finish" },
          finish: { type: "end" },
        },
      },
    });
    expect(unreachable(opened)).not.toContain("extras/entry");
    expect(unreachable(opened)).not.toContain("extras/finish");
    opened.scenes[0].definition.nodes.start = { type: "end" };
    expect(unreachable(opened)).toContain("extras/entry");
  });

  it("still reports a chapter that is hidden or locked behind completion", () => {
    expect(unreachable(projectWithMap("completed", "always"))).toEqual([
      "extras/start",
    ]);
    expect(unreachable(projectWithMap("always", "completed"))).toEqual([
      "extras/start",
    ]);
  });
});
