import { describe, expect, it } from "vitest";
import {
  countVariableReferences,
  countCharacterReferences,
  convertToTimeline,
  outputPorts,
  defaultNode,
  insertNode,
  preparePastedNode,
  renameNode,
  renameScene,
  renameCharacter,
  renameVariable,
  rewriteLongTextDocumentReferences,
  setPortTarget,
  splitLongTextAt,
  splitDialogueAt,
  summarizeNode,
} from "./story";
import { findAssetReferences } from "./components/assetReferences";
import type { EditorProject, SceneNode } from "./types";
import { validateLive } from "./validation";
import { buildScriptChainOptions } from "./components/scriptChains";

function project(): EditorProject {
  return {
    root: "C:/project/game",
    fingerprint: "test",
    manifest: {
      schema_version: 2,
      content_version: "test",
      entry_scene: "main",
      default_locale: "zh-CN",
      variables: {
        score: { scope: "save", type: "integer", default: 0 },
      },
      characters: {
        alice: {
          display_name: "爱丽丝",
          name_color: "#80D8FF",
          text_color: "#FFFFFF",
        },
      },
      assets: {},
      scenes: ["scenes/main.yaml"],
      ui_motions: [],
      ui_motion_defaults: {},
    },
    scenes: [
      {
        path: "scenes/main.yaml",
        definition: {
          schema_version: 2,
          id: "main",
          entry: "start",
          nodes: {
            start: {
              type: "choice",
              choices: [
                { id: "left", label: "左", next: "left" },
                { id: "right", label: "右", next: "right" },
              ],
            },
            left: { type: "jump", scene: null, target: "end" },
            right: {
              type: "say",
              speaker: null,
              text: "R",
              speed_cps: null,
              next: "end",
            },
            end: { type: "end" },
          },
        },
      },
    ],
    ui_motions: [],
    layout: { version: 1, scenes: {} },
    assets: [],
    diagnostics: [],
  };
}

describe("story graph mapping", () => {
  it("indexes authoring chains without repeating branch targets or cycles", () => {
    const scene = project().scenes[0].definition;
    scene.nodes.merge = {
      type: "say",
      speaker: null,
      text: "合流",
      speed_cps: 30,
      next: "loop",
    };
    scene.nodes.loop = {
      type: "say",
      speaker: null,
      text: "循环",
      speed_cps: 30,
      next: "loop",
    };
    scene.nodes.left = { type: "jump", scene: null, target: "merge" };
    const options = buildScriptChainOptions(scene);
    expect(options.map((option) => option.id)).toEqual([
      "start",
      "left",
      "right",
      "merge",
    ]);
    expect(options.find((option) => option.id === "left")?.label).toContain(
      "start",
    );
    expect(options.filter((option) => option.id === "merge")).toHaveLength(1);
  });

  it("splits dialogue at the caret into an explicit append page", () => {
    const scene = project().scenes[0].definition;
    scene.nodes.line = {
      type: "say",
      speaker: "alice",
      text: "等等……我想起来了。",
      speed_cps: 30,
      next: "end",
    };
    const offset = "等等……".length;
    const result = splitDialogueAt(scene, "line", offset);
    expect(result.continuationId).toBe("line_continue");
    expect(result.first).toMatchObject({
      type: "say",
      text: "等等……",
      mode: "start",
      page_id: "line",
      next: "line_continue",
    });
    expect(result.continuation).toMatchObject({
      type: "say",
      text: "我想起来了。",
      mode: "append",
      page_id: "line",
      next: "end",
    });
  });

  it("splits long text with inherited continuation style and rewrites implicit references", () => {
    const sourceProject = project();
    const scene = sourceProject.scenes[0].definition;
    const source = defaultNode("long_text", "end");
    if (source.type !== "long_text") throw new Error("missing long-text node");
    source.steps = [
      { id: "statement", text: "第一段", page_break_before: false },
      { id: "proof", text: "第二段", page_break_before: false },
      { id: "remark", text: "第三段", page_break_before: false },
    ];
    scene.nodes.lecture = source;
    scene.nodes.hide_lecture = {
      type: "long_text_control",
      document: "lecture",
      action: "hide",
      next: "end",
    };

    const result = splitLongTextAt(scene, "lecture", 1);
    expect(result.previousDocument).toBe("lecture");
    expect(result.document).toBe("lecture_document");
    expect(result.first).toMatchObject({
      document: "lecture_document",
      mode: "start",
      on_exit: "keep_visible",
      font_size: 32,
      steps: [source.steps[0]],
    });
    expect(result.continuation).toMatchObject({
      document: "lecture_document",
      mode: "continue",
      steps: source.steps.slice(1),
    });
    expect(result.continuation).not.toHaveProperty("paper");
    expect(result.continuation).not.toHaveProperty("pagination");
    expect(result.continuation).not.toHaveProperty("font_size");
    expect(result.continuation).not.toHaveProperty("text_color");
    expect(result.continuation).not.toHaveProperty("layout");

    scene.nodes.lecture = result.first;
    scene.nodes[result.continuationId] = result.continuation;
    rewriteLongTextDocumentReferences(
      scene,
      result.previousDocument,
      result.document,
      "lecture",
    );
    expect(scene.nodes.hide_lecture).toMatchObject({
      type: "long_text_control",
      document: "lecture_document",
    });
    expect(
      validateLive(sourceProject).some((issue) =>
        issue.code.startsWith("long_text_"),
      ),
    ).toBe(false);
  });

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

  it("requires the map view center to keep the complete game viewport in bounds", () => {
    const invalid = project();
    invalid.manifest.chapter_map = "chapter-map.yaml";
    invalid.chapter_map = {
      path: "chapter-map.yaml",
      definition: {
        schema_version: 1,
        width: 1920,
        height: 1080,
        view_x: 0,
        view_y: 540,
        background: null,
        decorations: [],
        hotspots: [],
      },
    };
    expect(validateLive(invalid)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "map_view" })]),
    );
  });

  it("requires the map view center to use the 20px grid", () => {
    const invalid = project();
    invalid.manifest.chapter_map = "chapter-map.yaml";
    invalid.chapter_map = {
      path: "chapter-map.yaml",
      definition: {
        schema_version: 1,
        width: 4000,
        height: 2000,
        view_x: 951,
        view_y: 1000,
        background: null,
        decorations: [],
        hotspots: [],
      },
    };
    expect(validateLive(invalid)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "map_view" })]),
    );
  });

  it("rejects map layer values outside the Rust i32 contract", () => {
    const invalid = project();
    invalid.manifest.chapter_map = "chapter-map.yaml";
    invalid.chapter_map = {
      path: "chapter-map.yaml",
      definition: {
        schema_version: 1,
        width: 1920,
        height: 1080,
        view_x: 960,
        view_y: 540,
        background: null,
        decorations: [
          {
            id: "decor",
            asset: "",
            x: 0,
            y: 0,
            width: 20,
            height: 20,
            z: 2147483648,
          },
        ],
        hotspots: [],
      },
    };
    expect(validateLive(invalid)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "map_z" })]),
    );
  });

  it("expands quick presentation nodes into editable timeline data", () => {
    const sprite = convertToTimeline({
      type: "sprite",
      sprite_id: "alice",
      action: "move",
      asset: null,
      x: 700,
      y: null,
      scale: null,
      opacity: 0.5,
      z: null,
      duration_ms: 600,
      easing: "ease_in_out",
      await: true,
      next: "after",
    });
    expect(sprite).toMatchObject({
      type: "timeline",
      duration_ms: 600,
      await: true,
      skippable: false,
      next: "after",
      tracks: [
        {
          type: "sprite",
          sprite_id: "alice",
          asset: null,
          remove_at_end: false,
        },
      ],
    });
    const spriteTrack = sprite.tracks[0];
    expect(spriteTrack?.type).toBe("sprite");
    if (spriteTrack?.type !== "sprite") throw new Error("missing sprite track");
    expect(spriteTrack.channels.x?.map((frame) => frame.value)).toEqual([
      "inherit",
      700,
    ]);
    expect(spriteTrack.channels.opacity?.map((frame) => frame.value)).toEqual([
      "inherit",
      0.5,
    ]);

    const camera = convertToTimeline({
      type: "camera",
      x: 100,
      y: 200,
      zoom: 1.5,
      duration_ms: 400,
      easing: "linear",
      await: false,
      next: "after",
    });
    const cameraTrack = camera.tracks[0];
    expect(cameraTrack?.type).toBe("camera");
    if (cameraTrack?.type !== "camera") throw new Error("missing camera track");
    expect(cameraTrack.channels.rotation_deg).toBeUndefined();
    expect(cameraTrack.channels.x?.map((frame) => frame.value)).toEqual([
      "inherit",
      100,
    ]);

    expect(
      convertToTimeline({
        type: "screen_effect",
        effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 },
        duration_ms: 200,
        await: false,
        next: "after",
      }).events,
    ).toEqual([
      {
        type: "screen_effect",
        id: "quick_effect",
        at_ms: 0,
        effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 },
        duration_ms: 200,
      },
    ]);
  });

  it("resolves a character expression when a sprite omits its direct asset", () => {
    const source = project();
    source.manifest.assets["sprite.alice"] = {
      kind: "sprite",
      path: "sprites/alice.png",
    };
    source.manifest.characters.alice.default_expression = "neutral";
    source.manifest.characters.alice.expressions = {
      neutral: { asset: "sprite.alice" },
    };
    const node: SceneNode = {
      type: "sprite",
      sprite_id: "alice",
      action: "show",
      character: "alice",
      expression: "neutral",
      x: 960,
      y: 1080,
      scale: 1,
      opacity: 1,
      z: 0,
      duration_ms: 300,
      easing: "linear",
      await: false,
      next: "after",
    };

    const timeline = convertToTimeline(node, source.manifest);
    expect(timeline.tracks[0]).toMatchObject({
      type: "sprite",
      sprite_id: "alice",
      asset: "sprite.alice",
    });
    expect(
      validateLive({
        ...source,
        scenes: [
          {
            ...source.scenes[0],
            definition: {
              ...source.scenes[0].definition,
              nodes: {
                sprite: node,
                after: { type: "end" },
              },
            },
          },
        ],
      }).filter(
        (diagnostic) =>
          diagnostic.scene_id === "main" &&
          diagnostic.node_id === "sprite" &&
          diagnostic.code === "missing_asset",
      ),
    ).toHaveLength(0);
  });

  it("pastes nodes without carrying story connections", () => {
    const source = project();
    const manifest = source.manifest;
    const choice = preparePastedNode(
      source.scenes[0].definition.nodes.start,
      manifest,
    );
    expect(
      choice.type === "choice" && choice.choices.map(({ next }) => next),
    ).toEqual(["", ""]);

    const condition = preparePastedNode(
      {
        type: "condition",
        condition: {
          op: "ge",
          left: { variable: "score" },
          right: { value: 1 },
        },
        then: "left",
        otherwise: "right",
      },
      manifest,
    );
    expect(condition).toMatchObject({ then: "", otherwise: "" });
    const jump = preparePastedNode(
      { type: "jump", scene: "other", target: "start" },
      manifest,
    );
    expect(jump).toEqual({ type: "jump", scene: null, target: "" });
  });

  it("empties missing project references while preserving available ones", () => {
    const manifest = project().manifest;
    const set = preparePastedNode(
      {
        type: "set",
        variable: "missing_target",
        op: "add",
        value: { variable: "missing_operand" },
        next: "end",
      },
      manifest,
    );
    expect(set).toMatchObject({
      variable: "",
      value: { variable: "" },
      next: "",
    });

    const say = preparePastedNode(
      {
        type: "say",
        speaker: "alice",
        text: "保留 [var=score]，移除 [var=missing]，字面 \\[var=missing]",
        speed_cps: null,
        next: "end",
      },
      { ...manifest, characters: {} },
      "alice",
    );
    expect(say).toMatchObject({
      speaker: null,
      text: "保留 [var=score]，移除 ，字面 \\[var=missing]",
      next: "",
    });

    const timeline = preparePastedNode(
      {
        type: "timeline",
        duration_ms: 1000,
        await: true,
        skippable: true,
        tracks: [
          {
            type: "sprite",
            sprite_id: "alice",
            asset: "missing.sprite",
            remove_at_end: false,
            channels: {},
          },
        ],
        events: [
          {
            type: "sfx",
            id: "hit",
            at_ms: 100,
            asset: "missing.sfx",
            volume: 1,
          },
        ],
        next: "end",
      },
      manifest,
    );
    expect(timeline.type === "timeline" && timeline.tracks[0]).toMatchObject({
      asset: null,
    });
    expect(timeline.type === "timeline" && timeline.events[0]).toMatchObject({
      asset: "",
    });
  });

  it("maps every choice to an independently addressable output port", () => {
    const node = project().scenes[0].definition.nodes.start;
    expect(outputPorts(node).map((port) => port.id)).toEqual([
      "choice:left",
      "choice:right",
    ]);
    const changed = setPortTarget(node, "choice:left", "end");
    expect(changed.type === "choice" && changed.choices[0].next).toBe("end");
  });

  it("inserts after the explicitly selected choice branch", () => {
    const source = project();
    const result = insertNode(
      source,
      "main",
      "start",
      "right",
      "say",
      "choice:right",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.project.scenes[0].definition;
    const choice = scene.nodes.start;
    expect(choice.type === "choice" && choice.choices[0].next).toBe("left");
    expect(choice.type === "choice" && choice.choices[1].next).toBe(
      result.nodeId,
    );
    const inserted = scene.nodes[result.nodeId];
    expect(inserted.type).toBe("say");
    expect(inserted.type === "say" && inserted.next).toBe("right");
  });

  it("requires an outlet before inserting into a multi-branch node", () => {
    const result = insertNode(project(), "main", "start", "right", "say");
    expect(result).toEqual({
      ok: false,
      error: "该节点有多个分支出口，请先选择要插入的出口。",
    });
  });

  it("creates playback nodes with an explicit two-field policy", () => {
    const node = defaultNode("playback", "end");
    expect(node).toEqual({
      type: "playback",
      auto: "normal",
      ctrl_fast_forward: "allow",
      next: "end",
    });
    expect(outputPorts(node)).toEqual([
      { id: "next", label: "下一步", target: "end", targetScene: null },
    ]);
  });

  it("creates and pastes clear nodes as independent visual transitions", () => {
    const clear = defaultNode("clear", "end");
    expect(clear).toEqual({
      type: "clear",
      duration_ms: 500,
      easing: "ease_in_out",
      await: true,
      next: "end",
    });
    expect(preparePastedNode(clear, project().manifest)).toMatchObject({
      type: "clear",
      next: "",
    });
  });

  it("inserts a node on the right and preserves the original destination", () => {
    const result = insertNode(project(), "main", "right", "right", "wait");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.project.scenes[0].definition;
    const source = scene.nodes.right;
    const inserted = scene.nodes[result.nodeId];
    expect(source.type === "say" && source.next).toBe(result.nodeId);
    expect(inserted.type === "wait" && inserted.next).toBe("end");
  });

  it("allows an explicit end node as a terminal right insertion", () => {
    const result = insertNode(project(), "main", "right", "right", "end");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.project.scenes[0].definition;
    const source = scene.nodes.right;
    expect(source.type === "say" && source.next).toBe(result.nodeId);
    expect(scene.nodes[result.nodeId]).toEqual({ type: "end" });
  });

  it("inserts a node on the left and redirects all local references", () => {
    const source = project();
    const result = insertNode(source, "main", "end", "left", "wait");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.project.scenes[0].definition;
    const inserted = scene.nodes[result.nodeId];
    expect(scene.entry).toBe("start");
    expect(inserted.type).toBe("wait");
    if (inserted.type === "wait") expect(inserted.next).toBe("end");
    expect(scene.nodes.left.type === "jump" && scene.nodes.left.target).toBe(
      result.nodeId,
    );
    expect(scene.nodes.right.type === "say" && scene.nodes.right.next).toBe(
      result.nodeId,
    );
  });

  it("renames a node and all local and jump references atomically", () => {
    const renamed = renameNode(project(), "main", "end", "finish");
    const scene = renamed.scenes[0].definition;
    expect(scene.nodes.end).toBeUndefined();
    expect(scene.nodes.finish.type).toBe("end");
    expect(scene.nodes.left.type === "jump" && scene.nodes.left.target).toBe(
      "finish",
    );
    expect(scene.nodes.right.type === "say" && scene.nodes.right.next).toBe(
      "finish",
    );
  });

  it("keeps timeline preview metadata in sync with renamed targets", () => {
    const source = project();
    source.layout.timeline_previews = {
      "main/end": {
        variable_overrides: { score: 5 },
        choices: [
          {
            scene_id: "main",
            node_id: "end",
            visit: 1,
            choice_id: "left",
          },
        ],
      },
    };
    const renamedNode = renameNode(source, "main", "end", "finish");
    expect(renamedNode.layout.timeline_previews?.["main/finish"]).toEqual({
      variable_overrides: { score: 5 },
      choices: [
        {
          scene_id: "main",
          node_id: "finish",
          visit: 1,
          choice_id: "left",
        },
      ],
    });
    const renamedScene = renameScene(renamedNode, "main", "chapter_one");
    expect(
      renamedScene.layout.timeline_previews?.["chapter_one/finish"],
    ).toBeDefined();
    expect(
      renamedScene.layout.timeline_previews?.["chapter_one/finish"]?.choices[0]
        ?.scene_id,
    ).toBe("chapter_one");
    const renamedVariable = renameVariable(renamedScene, "score", "points");
    expect(
      renamedVariable.layout.timeline_previews?.["chapter_one/finish"]
        ?.variable_overrides,
    ).toEqual({ points: 5 });
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
    expect(codes).toContain("invalid_video_clip");
    expect(codes).toContain("empty_timeline_channel");
    expect(codes).toContain("invalid_timeline_event_time");
    expect(codes).toContain("invalid_duration");
  });

  it("renames nested condition and choice variable references", () => {
    const source = project();
    source.scenes[0].definition.nodes.guard = {
      type: "condition",
      condition: {
        op: "not",
        condition: {
          op: "ge",
          left: { variable: "score" },
          right: { value: 1 },
        },
      },
      then: "end",
      otherwise: "end",
    };
    const start = source.scenes[0].definition.nodes.start;
    if (start.type === "choice") {
      start.choices[0].label = "分数 [var=score]，字面 \\[var=score]";
      start.choices[0].enabled_if = {
        op: "eq",
        left: { variable: "score" },
        right: { value: 0 },
      };
    }
    source.scenes[0].definition.nodes.right = {
      type: "say",
      speaker: "alice",
      text: "当前 $[var=score]$",
      speed_cps: null,
      next: "end",
    };
    source.scenes[0].definition.nodes.set = {
      type: "set",
      variable: "score",
      op: "add",
      value: { variable: "score" },
      next: "end",
    };
    expect(countVariableReferences(source, "score")).toBe(6);
    const renamed = renameVariable(source, "score", "points");
    expect(renamed.manifest.variables.points).toBeDefined();
    expect(countVariableReferences(renamed, "score")).toBe(0);
    expect(countVariableReferences(renamed, "points")).toBe(6);
    const renamedStart = renamed.scenes[0].definition.nodes.start;
    expect(
      renamedStart.type === "choice" && renamedStart.choices[0].label,
    ).toBe("分数 [var=points]，字面 \\[var=score]");
  });

  it("renames character IDs and protects referenced characters", () => {
    const source = project();
    const right = source.scenes[0].definition.nodes.right;
    if (right.type === "say") right.speaker = "alice";
    source.scenes[0].definition.nodes.portrait = {
      type: "sprite",
      sprite_id: "alice-instance",
      action: "show",
      asset: null,
      character: "alice",
      expression: null,
      flip_x: false,
      crossfade_ms: null,
      x: 960,
      y: 1080,
      scale: 1,
      opacity: 1,
      z: 1,
      duration_ms: 1,
      easing: "linear",
      await: false,
      next: "end",
    };
    expect(countCharacterReferences(source, "alice")).toBe(2);
    const renamed = renameCharacter(source, "alice", "alicia");
    const renamedRight = renamed.scenes[0].definition.nodes.right;
    expect(renamed.manifest.characters.alicia.display_name).toBe("爱丽丝");
    expect(renamedRight.type === "say" && renamedRight.speaker).toBe("alicia");
    const renamedPortrait = renamed.scenes[0].definition.nodes.portrait;
    expect(renamedPortrait.type === "sprite" && renamedPortrait.character).toBe(
      "alicia",
    );
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

  it("still reports a chapter that is hidden or locked behind completion", () => {
    expect(unreachable(projectWithMap("completed", "always"))).toEqual([
      "extras/start",
    ]);
    expect(unreachable(projectWithMap("always", "completed"))).toEqual([
      "extras/start",
    ]);
  });
});

describe("canonical presentation authoring", () => {
  it("creates a curtain node whose default cover is visible", () => {
    const node = defaultNode("curtain", "end");
    expect(node).toEqual({
      type: "curtain",
      action: "cover",
      fill: { color: "#000000" },
      transition: { type: "fade" },
      duration_ms: 500,
      easing: "ease_in_out",
      await: false,
      next: "end",
    });
    expect(outputPorts(node)).toEqual([
      { id: "next", label: "下一步", target: "end", targetScene: null },
    ]);
  });

  it("summarises the canonical specs instead of raw objects", () => {
    expect(
      summarizeNode({
        type: "background",
        background: "bg.a",
        transition: { type: "push", direction: "bottom_to_top", softness: 0.1 },
        duration_ms: 500,
        easing: "linear",
        await: false,
        next: "end",
      }),
    ).toBe("bg.a");
    expect(
      summarizeNode({
        type: "curtain",
        action: "cover",
        fill: { asset: "gui.curtain" },
        transition: { type: "split_vertical" },
        duration_ms: 500,
        easing: "linear",
        await: false,
        next: "end",
      }),
    ).toContain("gui.curtain");
    expect(
      summarizeNode({
        type: "screen_effect",
        effect: {
          type: "shake",
          amplitude_x: 16,
          amplitude_y: 9.6,
          frequency_hz: 18,
          decay: 1,
          seed: 7,
        },
        duration_ms: 200,
        await: false,
        next: "end",
      }),
    ).toContain("seed 7");
  });

  it("clears a pasted curtain fill that no longer resolves to a gui asset", () => {
    const manifest = project().manifest;
    const source: SceneNode = {
      type: "curtain",
      action: "cover",
      fill: { asset: "gui.missing" },
      transition: { type: "wipe", direction: "left_to_right" },
      duration_ms: 400,
      easing: "linear",
      await: false,
      next: "end",
    };
    expect(preparePastedNode(source, manifest)).toMatchObject({
      type: "curtain",
      fill: null,
    });
    manifest.assets["gui.curtain"] = { kind: "gui", path: "gui/curtain.png" };
    expect(
      preparePastedNode(
        { ...source, fill: { asset: "gui.curtain" } },
        manifest,
      ),
    ).toMatchObject({ fill: { asset: "gui.curtain" } });
  });

  it("counts a curtain gui fill as an asset reference", () => {
    const fixture = project();
    fixture.manifest.assets["gui.curtain"] = {
      kind: "gui",
      path: "gui/curtain.png",
    };
    fixture.scenes[0].definition.nodes.curtain = {
      type: "curtain",
      action: "cover",
      fill: { asset: "gui.curtain" },
      transition: { type: "fade" },
      duration_ms: 500,
      easing: "linear",
      await: false,
      next: "end",
    };
    expect(findAssetReferences(fixture, "gui.curtain")).toEqual([
      "main/curtain",
    ]);
    // A colour fill never references an asset, so it must not block deletion.
    fixture.scenes[0].definition.nodes.curtain = {
      type: "curtain",
      action: "cover",
      fill: { color: "#000000" },
      transition: { type: "fade" },
      duration_ms: 500,
      easing: "linear",
      await: false,
      next: "end",
    };
    expect(findAssetReferences(fixture, "gui.curtain")).toEqual([]);
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
});
