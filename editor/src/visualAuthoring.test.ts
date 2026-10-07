import { describe, expect, it } from "vitest";
import { convertToTimeline, defaultNode, insertNode, outputPorts, resolveSpriteAsset } from "./story";
import { validateLive } from "./validation";
import { timerTargetAllowed } from "./windowInteraction";
import { findAssetReferences } from "./components/assetReferences";
import { withPreviewBackground } from "./presentationPreview";
import { spritePreset } from "@vectspace/presentation-core/visual";
import { visualProject } from "./test/visualFixtures";
import type { SceneNode, TimelineTrack } from "./types";

function sprite(source: Extract<SceneNode, { type: "sprite" }>["source"]): Extract<SceneNode, { type: "sprite" }> {
  return { ...defaultNode("sprite", "finish") as Extract<SceneNode, { type: "sprite" }>, source, asset: null };
}

function codes(project = visualProject()): string[] {
  return validateLive(project).filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => diagnostic.code);
}

describe("canonical visual authoring", () => {
  it("accepts background, gui and text Sprite sources without character-only asset errors", () => {
    for (const source of [{ type: "image", asset: "bg" }, { type: "image", asset: "dot" }, { type: "text", text_block: "label" }] as const) {
      const project = visualProject();
      project.scenes[0].definition.nodes.start = sprite(source);
      expect(codes(project)).toEqual([]);
    }
  });

  it("diagnoses conflicting sources, reserved instances, layout and anchor bounds", () => {
    const project = visualProject();
    project.scenes[0].definition.nodes.start = {
      ...sprite({ type: "text", text_block: "missing" }), asset: "dot", sprite_id: "__background__",
      anchor_y: 2, scale_x: 0, layout: { width: 0, height: 1080, fit: "cover" },
    };
    expect(codes(project)).toEqual(expect.arrayContaining([
      "conflicting_sprite_source", "invalid_sprite_source", "reserved_sprite_id", "invalid_sprite_layout", "invalid_sprite_scale", "invalid_sprite_anchor",
    ]));
  });

  it("creates nonblocking particle nodes with ordinary flow and strict seed/definition checks", () => {
    const project = visualProject();
    const node = defaultNode("particle", "finish") as Extract<SceneNode, { type: "particle" }>;
    node.particle = "snow";
    project.scenes[0].definition.nodes.start = node;
    expect(outputPorts(node)).toEqual([{ id: "next", label: "下一步", target: "finish", targetScene: null }]);
    expect(timerTargetAllowed(node)).toBe(true);
    expect(codes(project)).toEqual([]);
    node.seed = 0x100000000;
    node.particle = "missing";
    expect(codes(project)).toEqual(expect.arrayContaining(["unknown_particle_definition", "invalid_emitter_transform"]));
    node.action = "stop";
    node.seed = null;
    expect(codes(project)).not.toContain("unknown_particle_definition");
  });

  it("allocates distinct instances when two persistent particle nodes are created", () => {
    const project = visualProject();
    const scenes = project.scenes.map((file) => file.definition);
    const first = defaultNode("particle", "finish", scenes);
    project.scenes[0].definition.nodes.first = first;
    const second = defaultNode("particle", "finish", scenes);
    expect(first).toMatchObject({ action: "start", emitter_id: "emitter" });
    expect(second).toMatchObject({ action: "start", emitter_id: "emitter_2" });
    expect(first).toMatchObject({ emitter_id: "emitter" });
  });

  it("reserves instance IDs used by other scenes, stop/burst nodes and emitter tracks", () => {
    const project = visualProject();
    const scene = structuredClone(project.scenes[0].definition);
    scene.id = "other";
    const particle = defaultNode("particle", "finish") as Extract<SceneNode, { type: "particle" }>;
    scene.nodes = {
      stop: { ...particle, action: "stop", emitter_id: "emitter" },
      burst: { ...particle, action: "burst", emitter_id: "emitter_2" },
      timeline: {
        ...defaultNode("timeline", "finish") as Extract<SceneNode, { type: "timeline" }>,
        tracks: [{ type: "emitter", emitter_id: "emitter_3", remove_at_end: false, channels: {} }],
      },
      finish: { type: "end" },
    };
    expect(defaultNode("particle", "finish", [project.scenes[0].definition, scene]))
      .toMatchObject({ emitter_id: "emitter_4" });
    expect(scene.nodes.stop).toMatchObject({ action: "stop", emitter_id: "emitter" });
  });

  it("allocates distinct instances through consecutive quick insertions", () => {
    const first = insertNode(visualProject(), "main", "start", "right", "particle");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    const second = insertNode(first.project, "main", first.nodeId, "right", "particle");
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error);
    const nodes = second.project.scenes[0].definition.nodes;
    expect(nodes[first.nodeId]).toMatchObject({ emitter_id: "emitter", next: second.nodeId });
    expect(nodes[second.nodeId]).toMatchObject({ emitter_id: "emitter_2" });
  });

  it("distinguishes persistent emitter tracks and rejects burst-only or per-particle targets", () => {
    const project = visualProject();
    const start = defaultNode("particle", "timeline") as Extract<SceneNode, { type: "particle" }>;
    start.particle = "snow";
    const track = (id: string): TimelineTrack => ({ type: "emitter", emitter_id: id, remove_at_end: false, channels: {} });
    project.scenes[0].definition.nodes = {
      start, other: { ...start, emitter_id: "other", next: "timeline" },
      timeline: { ...defaultNode("timeline", "finish") as Extract<SceneNode, { type: "timeline" }>, tracks: [track("emitter"), track("other")] },
      finish: { type: "end" },
    };
    expect(codes(project)).not.toContain("duplicate_timeline_track");
    expect(codes(project)).not.toContain("unknown_emitter_instance");
    start.action = "burst";
    expect(codes(project)).toContain("unknown_emitter_instance");
  });

  it("checks exact visual document sets, namespace collisions, fonts and static image constraints", () => {
    const project = visualProject();
    project.manifest.text_blocks?.push("particles/snow.yaml");
    project.text_blocks[0].definition.font = "dot";
    project.particles[0].definition.id = "label";
    project.particles[0].definition.image = "font";
    expect(codes(project)).toEqual(expect.arrayContaining([
      "duplicate_document_path", "visual_document_set_mismatch", "duplicate_visual_id", "invalid_text_block_font", "invalid_particle_image",
    ]));
  });

  it("converts canonical text/category/space/layout and full transform channels", () => {
    const node = { ...sprite({ type: "text", text_block: "label" }), sprite_kind: "text" as const, space: "screen" as const,
      x: null, y: null, scale_x: 2, rotation_deg: 30, layout: { width: 500, height: 100, fit: "contain" as const } };
    const converted = convertToTimeline(node);
    expect(converted.tracks[0]).toMatchObject({ source: node.source, sprite_kind: "text", space: "screen", layout: node.layout,
      channels: { y: [{ at_ms: 0, value: 588 }, { at_ms: 500, value: 540 }], scale_x: [{ value: 2 }, { value: 2 }], rotation_deg: [{ value: 30 }, { value: 30 }] } });
    expect(converted.tracks[0]).not.toHaveProperty("asset");
    expect(resolveSpriteAsset(node)).toBeNull();
    expect(resolveSpriteAsset(sprite({ type: "image", asset: "bg" }))).toBe("bg");
  });

  it("protects canonical image and definition font/image dependencies", () => {
    const project = visualProject();
    project.text_blocks[0].definition.font = "font";
    project.scenes[0].definition.nodes.start = sprite({ type: "image", asset: "dot" });
    expect(findAssetReferences(project, "dot")).toEqual(["main/start", "particle:snow/image"]);
    expect(findAssetReferences(project, "font")).toEqual(["text-block:label/font"]);
  });

  it("replaces canonical background without losing nonvisual snapshot fields or creating a collision", () => {
    const world = { sprites: { __background__: spritePreset("background", { type: "image", asset: "bg" }) },
      camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 }, dialogue_ui_visible: false, emitters: {} };
    const changed = withPreviewBackground(world, "dot");
    expect(changed.sprites.__background__?.source).toEqual({ type: "image", asset: "dot" });
    expect(changed.dialogue_ui_visible).toBe(false);
    expect(changed).not.toHaveProperty("background");
    expect(withPreviewBackground(world, null).sprites).toEqual({});
  });
});
