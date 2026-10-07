import { describe, expect, it } from "vitest";

import { defaultNode } from "../story";
import { fixtureProject } from "../test/appHarness";
import type { SceneGroup, SceneNode } from "../types";
import {
  captureGraphSelection,
  placeGraphSelection,
} from "./graphSelectionClipboard";

const nestedGroups: SceneGroup[] = [
  { id: "inner", children: [{ node: "start" }, { node: "second" }] },
  { id: "outer", children: [{ group: "inner" }, { node: "finish" }] },
];

function particleScene() {
  const project = fixtureProject();
  const scene = project.scenes[0].definition;
  const particle = {
    ...(defaultNode("particle", "finish") as Extract<SceneNode, { type: "particle" }>),
    emitter_id: "snow",
  };
  scene.nodes = {
    start: { ...particle, next: "restart" },
    restart: { ...particle, next: "timeline" },
    timeline: {
      ...(defaultNode("timeline", "stop") as Extract<SceneNode, { type: "timeline" }>),
      tracks: [
        { type: "emitter", emitter_id: "snow", remove_at_end: false, channels: {} },
        { type: "emitter", emitter_id: "external", remove_at_end: false, channels: {} },
      ],
    },
    stop: { ...particle, action: "stop", next: "finish" },
    finish: { type: "end" },
  };
  return { project, scene, layout: project.layout.scenes.main };
}

describe("graph selection clipboard", () => {
  it.each(["duplicate", "paste"] as const)("allocates independent emitter instances on repeated %s", (mode) => {
    const { project, scene, layout } = particleScene();
    const snapshot = captureGraphSelection(scene, layout, [{ node: "start" }], project.manifest);
    if (snapshot === null) throw new Error("expected copied emitter");
    const first = placeGraphSelection(snapshot, scene, layout, { x: 0, y: 0 }, mode, project.manifest);
    const destination = { ...scene, nodes: { ...scene.nodes, ...first.nodes } };
    const second = placeGraphSelection(snapshot, destination, layout, { x: 0, y: 0 }, mode, project.manifest);
    expect(first.nodes.start_copy).toMatchObject({ emitter_id: "snow_2" });
    expect(second.nodes.start_copy_2).toMatchObject({ emitter_id: "snow_3" });
    expect(scene.nodes.start).toMatchObject({ emitter_id: "snow" });
    expect(snapshot.nodes.start).toMatchObject({ emitter_id: "snow" });
  });

  it.each(["duplicate", "paste"] as const)("keeps copied starts, restarts, stops and tracks together on %s", (mode) => {
    const { project, scene, layout } = particleScene();
    const snapshot = captureGraphSelection(scene, layout, [
      { node: "start" }, { node: "restart" }, { node: "timeline" }, { node: "stop" },
    ], project.manifest);
    if (snapshot === null) throw new Error("expected copied emitter controls");
    const placed = placeGraphSelection(snapshot, scene, layout, { x: 0, y: 0 }, mode, project.manifest);
    for (const id of ["start_copy", "restart_copy", "stop_copy"])
      expect(placed.nodes[id]).toMatchObject({ emitter_id: "snow_2" });
    expect(placed.nodes.timeline_copy).toMatchObject({
      tracks: [{ emitter_id: "snow_2" }, { emitter_id: "external" }],
    });
    expect(placed.nodes.restart_copy).toMatchObject({ next: "timeline_copy" });
    expect(placed.nodes.timeline_copy).toMatchObject({ next: "stop_copy" });
    expect(snapshot.nodes.timeline).toMatchObject({
      tracks: [{ emitter_id: "snow" }, { emitter_id: "external" }],
    });
  });

  it.each(["duplicate", "paste"] as const)("preserves external emitter targets when only controls are %sd", (mode) => {
    const { project, scene, layout } = particleScene();
    const snapshot = captureGraphSelection(scene, layout, [{ node: "timeline" }, { node: "stop" }], project.manifest);
    if (snapshot === null) throw new Error("expected copied controls");
    const placed = placeGraphSelection(snapshot, scene, layout, { x: 0, y: 0 }, mode, project.manifest);
    expect(placed.nodes.stop_copy).toMatchObject({ emitter_id: "snow" });
    expect(placed.nodes.timeline_copy).toMatchObject({
      tracks: [{ emitter_id: "snow" }, { emitter_id: "external" }],
    });
  });

  it("does not capture external clipboard controls when pasted into another project", () => {
    const { project, scene, layout } = particleScene();
    scene.nodes.external_stop = {
      ...(scene.nodes.stop as Extract<SceneNode, { type: "particle" }>),
      emitter_id: "snow_2",
    };
    const snapshot = captureGraphSelection(scene, layout, [{ node: "start" }, { node: "external_stop" }], project.manifest);
    if (snapshot === null) throw new Error("expected copied emitter and external control");
    const destination = { ...scene, id: "other", nodes: { finish: { type: "end" as const } } };
    const placed = placeGraphSelection(snapshot, destination, undefined, { x: 0, y: 0 }, "paste", project.manifest);
    expect(placed.nodes.start_copy).toMatchObject({ emitter_id: "snow_3" });
    expect(placed.nodes.external_stop_copy).toMatchObject({ emitter_id: "snow_2" });
  });

  it("reserves emitter identities from other project scenes", () => {
    const { project, scene, layout } = particleScene();
    const other = { ...scene, id: "other", nodes: {
      reserved: { ...(scene.nodes.stop as Extract<SceneNode, { type: "particle" }>), emitter_id: "snow_2" },
    } };
    const snapshot = captureGraphSelection(scene, layout, [{ node: "start" }], project.manifest);
    if (snapshot === null) throw new Error("expected copied emitter");
    const placed = placeGraphSelection(snapshot, scene, layout, { x: 0, y: 0 }, "paste", project.manifest, [], [scene, other]);
    expect(placed.nodes.start_copy).toMatchObject({ emitter_id: "snow_3" });
  });

  it("copies a selected nested group once, preserving its forest, positions and internal links", () => {
    const project = fixtureProject();
    const scene = project.scenes[0].definition;
    const layout = project.layout.scenes.main;
    layout.groups = nestedGroups;
    const snapshot = captureGraphSelection(
      scene,
      layout,
      [{ group: "outer" }, { node: "start" }],
      project.manifest,
    );
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    expect(snapshot.roots).toEqual([{ group: "outer" }]);
    expect(Object.keys(snapshot.nodes)).toEqual(["start", "second", "finish"]);
    const placed = placeGraphSelection(
      snapshot,
      scene,
      layout,
      { x: 0, y: 0 },
      "duplicate",
      project.manifest,
    );
    expect(placed.roots).toEqual([{ group: "group-1" }]);
    expect(placed.groups).toEqual([
      ...nestedGroups,
      {
        id: "group-0",
        children: [{ node: "start_copy" }, { node: "second_copy" }],
      },
      {
        id: "group-1",
        children: [{ group: "group-0" }, { node: "finish_copy" }],
      },
    ]);
    expect(placed.positions).toEqual({
      start_copy: { x: 48, y: 48 },
      second_copy: { x: 368, y: 48 },
      finish_copy: { x: 688, y: 48 },
    });
    expect(placed.nodes.start_copy).toMatchObject({ next: "second_copy" });
    expect(placed.nodes.second_copy).toMatchObject({ next: "finish_copy" });
    expect(scene.nodes.start).toMatchObject({ next: "second" });
  });

  it("pastes an ungrouped batch at one anchor, retaining only links inside the copied range", () => {
    const project = fixtureProject();
    const scene = project.scenes[0].definition;
    const layout = project.layout.scenes.main;
    const snapshot = captureGraphSelection(
      scene,
      layout,
      [{ node: "start" }, { node: "second" }],
      project.manifest,
    );
    if (snapshot === null) throw new Error("expected a copied batch");
    const destinationManifest = structuredClone(project.manifest);
    delete destinationManifest.characters.lumi;
    const placed = placeGraphSelection(
      snapshot,
      { ...scene, id: "another" },
      layout,
      { x: 96, y: 160 },
      "paste",
      destinationManifest,
    );
    expect(placed.positions).toEqual({
      start_copy: { x: 96, y: 160 },
      second_copy: { x: 416, y: 160 },
    });
    expect(placed.nodes.start_copy).toMatchObject({
      next: "second_copy",
      speaker: null,
    });
    expect(placed.nodes.second_copy).toMatchObject({ next: "" });
    expect(placed.copiedGroupCount).toBe(0);
    expect(placed.roots).toEqual([
      { node: "start_copy" },
      { node: "second_copy" },
    ]);
  });

  it("remaps choice branches inside a batch and leaves explicit cross-scene jumps alone", () => {
    const project = fixtureProject();
    const scene = project.scenes[0].definition;
    scene.nodes.branch = {
      type: "choice",
      choices: [
        { id: "inside", label: "内部", next: "start" },
        { id: "outside", label: "外部", next: "finish" },
      ],
    };
    scene.nodes.jump = { type: "jump", scene: "another", target: "start" };
    const snapshot = captureGraphSelection(
      scene,
      project.layout.scenes.main,
      [{ node: "branch" }, { node: "jump" }, { node: "start" }],
      project.manifest,
    );
    if (snapshot === null) throw new Error("expected a copied batch");
    const duplicated = placeGraphSelection(
      snapshot,
      scene,
      project.layout.scenes.main,
      { x: 0, y: 0 },
      "duplicate",
      project.manifest,
    );
    expect(duplicated.nodes.branch_copy).toMatchObject({
      choices: [{ next: "start_copy" }, { next: "finish" }],
    });
    expect(duplicated.nodes.jump_copy).toMatchObject({
      scene: "another",
      target: "start",
    });
    const pasted = placeGraphSelection(
      snapshot,
      { ...scene, id: "another" },
      project.layout.scenes.main,
      { x: 64, y: 64 },
      "paste",
      project.manifest,
    );
    expect(pasted.nodes.branch_copy).toMatchObject({
      choices: [{ next: "start_copy" }, { next: "" }],
    });
    expect(pasted.nodes.jump_copy).toMatchObject({ scene: null, target: "" });
  });

  it("allocates distinct names and group identities on repeated paste", () => {
    const project = fixtureProject();
    const scene = project.scenes[0].definition;
    const layout = project.layout.scenes.main;
    layout.groups = nestedGroups;
    const snapshot = captureGraphSelection(
      scene,
      layout,
      [{ group: "outer" }],
      project.manifest,
    );
    if (snapshot === null) throw new Error("expected a copied group");
    const first = placeGraphSelection(
      snapshot,
      scene,
      layout,
      { x: 16, y: 32 },
      "paste",
      project.manifest,
    );
    const second = placeGraphSelection(
      snapshot,
      { ...scene, nodes: { ...scene.nodes, ...first.nodes } },
      { ...layout, groups: first.groups },
      { x: 80, y: 96 },
      "paste",
      project.manifest,
    );
    expect(Object.keys(second.nodes)).toEqual([
      "start_copy_2",
      "second_copy_2",
      "finish_copy_2",
    ]);
    expect(second.roots).toEqual([{ group: "group-3" }]);
    expect(second.nodes.start_copy_2).toMatchObject({ next: "second_copy_2" });
  });
});
