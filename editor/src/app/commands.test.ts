import { describe, expect, it } from "vitest";

import { fixtureProject } from "../test/appHarness";
import { idFormatError, idUnavailableReason, uniqueId } from "./ids";
import {
  duplicateSpriteActionFile,
  newSpriteActionFile,
  removeScene,
} from "./libraryCommands";
import {
  deleteNodes,
  planChainDeletion,
  planNodeDeletion,
} from "./nodeCommands";

describe("stable id rules", () => {
  it("explains format problems and collisions in Chinese", () => {
    expect(idFormatError("场景一")).toMatch(/格式不正确/);
    expect(idFormatError("")).toMatch(/不能为空/);
    expect(idFormatError("scene_1")).toBeNull();
    const project = fixtureProject();
    expect(idUnavailableReason("scene", "main", project)).toMatch(/已经存在/);
    expect(
      idUnavailableReason("scene", "main", project, { previous: "main" }),
    ).toBeNull();
    expect(
      idUnavailableReason("node", "start", project, { sceneId: "main" }),
    ).toMatch(/节点 ID「start」已经存在/);
    expect(idUnavailableReason("character", "lumi", project)).not.toBeNull();
  });

  it("refuses sprite action ids that collide with assets", () => {
    const project = fixtureProject();
    project.manifest.assets["bg.room"] = {
      kind: "background",
      path: "backgrounds/room.png",
    };
    expect(idUnavailableReason("action", "bg.room", project)).toMatch(/素材/);
  });

  it("finds the first free suffixed id", () => {
    const taken = new Set(["a", "a_2"]);
    expect(uniqueId("a", (id) => taken.has(id))).toBe("a_3");
    expect(uniqueId("b", (id) => taken.has(id))).toBe("b");
  });
});

describe("library commands", () => {
  it("duplicates a sprite action under a free copy id", () => {
    const project = fixtureProject();
    project.actions = [newSpriteActionFile("hop")];
    const copy = duplicateSpriteActionFile(project, "hop");
    expect(copy?.definition.id).toBe("hop_copy");
    expect(copy?.path).toBe("actions/hop_copy.yaml");
  });

  it("removes a scene and its editor-only records", () => {
    const project = fixtureProject();
    project.layout.timeline_previews = {
      "main/start": { variable_overrides: {}, choices: [] },
    };
    removeScene(project, "main");
    expect(project.scenes).toHaveLength(0);
    expect(project.manifest.scenes).toHaveLength(0);
    expect(project.layout.scenes.main).toBeUndefined();
    expect(project.layout.timeline_previews).toEqual({});
  });
});

describe("node deletion", () => {
  it("reconnects the only successor automatically", () => {
    const project = fixtureProject();
    const scene = project.scenes[0].definition;
    const plan = planNodeDeletion(scene, "start");
    expect(plan).toEqual({
      ok: true,
      nodeIds: ["start"],
      options: [expect.objectContaining({ id: "second" })],
    });
    deleteNodes(project, "main", ["start"], "second");
    expect(scene.nodes.start).toBeUndefined();
    expect(scene.entry).toBe("second");
  });

  it("refuses a selection that is not one contiguous chain", () => {
    const scene = fixtureProject().scenes[0].definition;
    const refused = planChainDeletion(scene, ["start", "finish"]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/连续链/);
    expect(planChainDeletion(scene, ["start", "second"])).toMatchObject({
      ok: true,
      nodeIds: ["start", "second"],
    });
  });
});
