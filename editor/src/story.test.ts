import { describe, expect, it } from "vitest";
import { outputPorts, renameNode, setPortTarget } from "./story";
import type { EditorProject } from "./types";
import { validateLive } from "./validation";

function project(): EditorProject {
  return {
    root: "C:/project/game",
    fingerprint: "test",
    manifest: {
      schema_version: 1,
      content_version: "test",
      entry_scene: "main",
      default_locale: "zh-CN",
      assets: {},
      scenes: ["scenes/main.yaml"],
    },
    scenes: [
      {
        path: "scenes/main.yaml",
        definition: {
          schema_version: 1,
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
    layout: { version: 1, scenes: {} },
    assets: [],
    diagnostics: [],
  };
}

describe("story graph mapping", () => {
  it("maps every choice to an independently addressable output port", () => {
    const node = project().scenes[0].definition.nodes.start;
    expect(outputPorts(node).map((port) => port.id)).toEqual([
      "choice:left",
      "choice:right",
    ]);
    const changed = setPortTarget(node, "choice:left", "end");
    expect(changed.type === "choice" && changed.choices[0].next).toBe("end");
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
});
