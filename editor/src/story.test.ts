import { describe, expect, it } from "vitest";
import {
  countVariableReferences,
  countCharacterReferences,
  outputPorts,
  defaultNode,
  insertNode,
  renameNode,
  renameCharacter,
  renameVariable,
  setPortTarget,
} from "./story";
import type { EditorProject } from "./types";
import { validateLive } from "./validation";

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
    expect(countCharacterReferences(source, "alice")).toBe(1);
    const renamed = renameCharacter(source, "alice", "alicia");
    const renamedRight = renamed.scenes[0].definition.nodes.right;
    expect(renamed.manifest.characters.alicia.display_name).toBe("爱丽丝");
    expect(renamedRight.type === "say" && renamedRight.speaker).toBe("alicia");
  });
});
