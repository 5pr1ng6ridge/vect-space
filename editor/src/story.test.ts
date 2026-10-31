import { describe, expect, it } from "vitest";
import {
  countCharacterReferences,
  countVariableReferences,
  convertToTimeline,
  defaultNode,
  insertNode,
  outputPorts,
  preparePastedNode,
  renameCharacter,
  renameNode,
  renameScene,
  renameVariable,
  rewriteLongTextDocumentReferences,
  sceneSpriteIds,
  setPortTarget,
  splitDialogueAt,
  splitLongTextAt,
} from "./story";
import { findAssetReferences } from "./components/assetReferences";
import { buildScriptChainOptions } from "./components/scriptChains";
import { storyProject as project } from "./test/storyProject";
import type { SceneNode } from "./types";
import { validateLive } from "./validation";

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

  it("pastes an ambience node with its slot and an asset that exists", () => {
    const authored = project();
    authored.manifest.assets["ambience.forest"] = {
      kind: "ambience",
      path: "audio/ambience.forest.ogg",
    };
    const node = defaultNode("ambience", "end");
    expect(node).toMatchObject({
      type: "ambience",
      slot: "slot_1",
      action: "start",
      volume: 0.8,
      next: "end",
    });
    if (node.type !== "ambience") throw new Error("expected ambience node");
    const pasted = preparePastedNode(
      { ...node, asset: "ambience.forest", slot: "slot_4" },
      authored.manifest,
    );
    expect(pasted).toMatchObject({
      type: "ambience",
      slot: "slot_4",
      asset: "ambience.forest",
      next: "",
    });
    authored.scenes[0].definition.nodes.ambience = pasted;
    expect(validateLive(authored).map((issue) => issue.code)).not.toContain(
      "missing_asset",
    );
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

describe("canonical presentation authoring", () => {
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
});

describe("sceneSpriteIds", () => {
  it("lists sprite instance ids, not the ids of the nodes that create them", () => {
    const ids = sceneSpriteIds({
      schema_version: 2,
      id: "s",
      entry: "show_hero",
      nodes: {
        show_hero: {
          type: "sprite",
          sprite_id: "hero",
          action: "show",
          next: "move",
        } as SceneNode,
        move: {
          type: "timeline",
          duration_ms: 100,
          tracks: [{ type: "sprite", sprite_id: "rival" }],
          next: "done",
        } as unknown as SceneNode,
        done: { type: "end" },
      },
    });
    expect(ids).toEqual(["hero", "rival"]);
  });
});
