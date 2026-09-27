import { describe, expect, it } from "vitest";

import { fixtureProject } from "../test/appHarness";
import type { SceneGroup } from "../types";
import {
  captureGraphSelection,
  placeGraphSelection,
} from "./graphSelectionClipboard";

const nestedGroups: SceneGroup[] = [
  { id: "inner", children: [{ node: "start" }, { node: "second" }] },
  { id: "outer", children: [{ group: "inner" }, { node: "finish" }] },
];

describe("graph selection clipboard", () => {
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
