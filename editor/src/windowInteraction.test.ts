import { describe, expect, it } from "vitest";

import { deleteNodes } from "./app/nodeCommands";
import {
  captureGraphSelection,
  placeGraphSelection,
} from "./app/graphSelectionClipboard";
import {
  countVariableReferences,
  defaultNode,
  insertNode,
  newSceneFile,
  outputPorts,
  preparePastedNode,
  renameNode,
  renameScene,
  renameVariable,
  setPortTarget,
  setSceneWindowRole,
} from "./story";
import { defaultFlashEffect } from "./presentationDefaults";
import { fixtureProject } from "./test/appHarness";
import type { EditorProject, SceneDefinition, SceneNode } from "./types";
import { validateLive } from "./validation";
import {
  effectPorts,
  effectReferences,
  readableVariables,
  timerTargetAllowed,
  timerTargetProblem,
  validTimerTargets,
  windowTitleProblem,
} from "./windowInteraction";
import { describeNode } from "./nodeSummary";

const sayNode = (next: string, text = "你好"): SceneNode => ({
  type: "say",
  speaker: null,
  text,
  speed_cps: null,
  next,
});

/** A main Scene with a timer plus a secondary Scene it can open. */
function pairProject(): EditorProject {
  const project = fixtureProject();
  project.manifest.scenes.push("scenes/side.yaml");
  project.scenes[0].definition.nodes = {
    start: sayNode("arm"),
    arm: {
      type: "timer",
      id: "pulse",
      action: "start",
      delay_ms: 500,
      interval_ms: 1000,
      target: "flash",
      next: "open",
    },
    flash: {
      type: "screen_effect",
      effect: defaultFlashEffect(),
      duration_ms: 200,
      await: false,
      next: "finish",
    },
    open: { type: "open_window", scene: "side", next: "finish" },
    finish: { type: "end" },
  };
  project.scenes.push({
    path: "scenes/side.yaml",
    definition: {
      window_role: "secondary",
      schema_version: 2,
      id: "side",
      entry: "hello",
      nodes: { hello: sayNode("done"), done: { type: "end" } },
    },
  });
  return project;
}

const codes = (project: EditorProject): string[] =>
  validateLive(project).map((diagnostic) => diagnostic.code);

function scene(project: EditorProject, id: string): SceneDefinition {
  const file = project.scenes.find(
    (candidate) => candidate.definition.id === id,
  );
  if (file === undefined) throw new Error(`scene ${id}`);
  return file.definition;
}

describe("timer targets", () => {
  it("accepts only effects that do not block or move the story", () => {
    const allowed: SceneNode[] = [
      { type: "set", variable: "x", value: 1, next: "a" },
      { type: "sfx", asset: "a", volume: 1, next: "a" },
      { type: "window_title", target: "main", title: "t", next: "a" },
      {
        type: "window_control",
        target: "main",
        action: "unblock",
        id: "g",
        next: "a",
      },
      defaultNode("screen_effect", "a"),
      defaultNode("timeline", "a"),
      defaultNode("camera", "a"),
    ];
    for (const node of allowed) {
      const awaited =
        "await" in node && node.await ? { ...node, await: false } : node;
      expect(timerTargetAllowed(awaited), node.type).toBe(true);
    }
    const awaited = { ...defaultNode("action", "a"), await: true } as SceneNode;
    expect(timerTargetAllowed(awaited)).toBe(false);
    expect(timerTargetProblem(awaited)).toMatch(/等待完成/);
    for (const type of [
      "say",
      "proof",
      "choice",
      "jump",
      "wait",
      "end",
      "open_window",
      "timer",
      "long_text",
      "clear",
      "dialogue_ui",
      "condition",
    ] as const) {
      expect(timerTargetAllowed(defaultNode(type, "a")), type).toBe(false);
    }
    expect(timerTargetProblem(undefined)).toMatch(/不存在/);
  });

  it("lists only legal targets of the Scene", () => {
    const project = pairProject();
    expect(validTimerTargets(scene(project, "main"))).toEqual(["flash"]);
  });
});

describe("effect references", () => {
  it("are not story ports but are offered as a connectable effect port", () => {
    const project = pairProject();
    const timer = scene(project, "main").nodes.arm;
    expect(outputPorts(timer).map((port) => port.id)).toEqual(["next"]);
    expect(effectReferences(timer)).toEqual([
      { id: "effect", label: "触发效果", target: "flash" },
    ]);
    const empty = defaultNode("timer", "finish");
    expect(effectReferences(empty)).toEqual([]);
    expect(effectPorts(empty)).toHaveLength(1);
    expect(setPortTarget(empty, "effect", "flash")).toMatchObject({
      target: "flash",
    });
    const stop = { ...empty, action: "stop" } as SceneNode;
    expect(effectPorts(stop)).toEqual([]);
  });

  it("follow a node rename without becoming a flow edge", () => {
    const renamed = renameNode(pairProject(), "main", "flash", "pulse_fx");
    expect(scene(renamed, "main").nodes.arm).toMatchObject({
      target: "pulse_fx",
    });
    expect(codes(renamed)).not.toContain("invalid_timer_target");
  });

  it("are cleared, not redirected to a flow node, when the target is deleted", () => {
    const project = pairProject();
    deleteNodes(project, "main", ["flash"], "finish");
    expect(scene(project, "main").nodes.arm).toMatchObject({ target: null });
    expect(codes(project)).toContain("missing_timer_target");
  });

  it("follow a copied effect node inside a selection and survive a duplicate", () => {
    const project = pairProject();
    const main = scene(project, "main");
    const snapshot = captureGraphSelection(
      main,
      project.layout.scenes.main,
      [{ node: "arm" }, { node: "flash" }],
      project.manifest,
    );
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    for (const mode of ["duplicate", "paste"] as const) {
      const placed = placeGraphSelection(
        snapshot,
        main,
        project.layout.scenes.main,
        { x: 0, y: 0 },
        mode,
        project.manifest,
      );
      expect(placed.nodes.arm_copy).toMatchObject({ target: "flash_copy" });
    }
    // Duplicating only the timer keeps pointing at the original effect node;
    // pasting it elsewhere clears the reference instead of guessing.
    const only = captureGraphSelection(
      main,
      project.layout.scenes.main,
      [{ node: "arm" }],
      project.manifest,
    );
    if (only === null) throw new Error("selection");
    expect(
      placeGraphSelection(
        only,
        main,
        project.layout.scenes.main,
        { x: 0, y: 0 },
        "duplicate",
        project.manifest,
      ).nodes.arm_copy,
    ).toMatchObject({ target: "flash" });
    expect(
      placeGraphSelection(
        only,
        main,
        project.layout.scenes.main,
        { x: 0, y: 0 },
        "paste",
        project.manifest,
      ).nodes.arm_copy,
    ).toMatchObject({ target: null });
    expect(preparePastedNode(main.nodes.arm, project.manifest)).toMatchObject({
      target: null,
    });
  });

  it("do not make the effect node's successors reachable", () => {
    const project = pairProject();
    scene(project, "main").nodes.flash = {
      ...(scene(project, "main").nodes.flash as SceneNode & { next: string }),
      next: "tail",
    } as SceneNode;
    scene(project, "main").nodes.tail = { type: "end" };
    const unreachable = validateLive(project)
      .filter((diagnostic) => diagnostic.code === "unreachable_node")
      .map((diagnostic) => diagnostic.node_id);
    expect(unreachable).toContain("tail");
    expect(unreachable).not.toContain("flash");
  });

  it("inserting before the effect node leaves the timer reference alone", () => {
    const result = insertNode(pairProject(), "main", "flash", "left", "wait");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(scene(result.project, "main").nodes.arm).toMatchObject({
      target: "flash",
    });
  });
});

describe("Scene purpose", () => {
  it("is implicit for main and written only for secondary", () => {
    expect(newSceneFile("a").definition).not.toHaveProperty("window_role");
    expect(newSceneFile("b", "secondary").definition.window_role).toBe(
      "secondary",
    );
    const project = pairProject();
    const flipped = setSceneWindowRole(project, "side", "main");
    expect(scene(flipped, "side")).not.toHaveProperty("window_role");
    expect(scene(project, "side").window_role).toBe("secondary");
    expect(setSceneWindowRole(project, "side", "secondary")).toBe(project);
  });

  it("accepts a main Scene opening a secondary Scene", () => {
    expect(
      codes(pairProject()).filter((code) => /window|secondary/.test(code)),
    ).toEqual([]);
  });

  it("rejects open_window to a main Scene and from a secondary Scene", () => {
    const project = pairProject();
    scene(project, "side").window_role = undefined;
    expect(codes(project)).toContain("window_scene_not_secondary");
    const nested = pairProject();
    scene(nested, "side").nodes.hello = {
      type: "open_window",
      scene: "side",
      next: "done",
    };
    expect(codes(nested)).toContain("secondary_opens_window");
  });

  it("rejects jumps and button jumps across purposes", () => {
    const project = pairProject();
    scene(project, "main").nodes.finish = {
      type: "jump",
      scene: "side",
      target: "hello",
    };
    expect(codes(project)).toContain("window_role_mismatch");
    const same = pairProject();
    scene(same, "side").nodes.done = {
      type: "jump",
      scene: null,
      target: "hello",
    };
    expect(codes(same)).not.toContain("window_role_mismatch");
  });

  it("keeps secondary Scenes out of the entry and the chapter map", () => {
    const project = pairProject();
    project.manifest.entry_scene = "side";
    expect(codes(project)).toContain("secondary_entry_scene");
    const mapped = pairProject();
    mapped.manifest.chapter_map = "chapter-map.yaml";
    mapped.chapter_map = {
      path: "chapter-map.yaml",
      definition: {
        schema_version: 1,
        width: 1920,
        height: 1080,
        background: null,
        decorations: [],
        hotspots: [
          {
            id: "h",
            scene_id: "side",
            title: "副",
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            z: 0,
            asset: null,
            variable_overrides: {},
          },
        ],
      },
    } as unknown as EditorProject["chapter_map"];
    expect(codes(mapped)).toContain("map_scene_secondary");
  });

  it("follows a Scene rename in open_window nodes", () => {
    const renamed = renameScene(pairProject(), "side", "side_two");
    expect(scene(renamed, "main").nodes.open).toMatchObject({
      scene: "side_two",
    });
  });
});

describe("window title variables", () => {
  it("are readable in templates, conditions and operands but never writable", () => {
    const project = pairProject();
    project.manifest.variables.label = {
      scope: "save",
      type: "string",
      default: "",
    };
    const nodes = scene(project, "main").nodes;
    nodes.start = sayNode("arm", "副窗口叫「[var=window.secondary.title]」");
    nodes.cond = {
      type: "condition",
      condition: {
        op: "eq",
        left: { variable: "window.main.title" },
        right: { value: "x" },
      },
      then: "finish",
      otherwise: "finish",
    };
    nodes.copy = {
      type: "set",
      variable: "label",
      op: "assign",
      value: { variable: "window.main.title" },
      next: "finish",
    };
    expect(codes(project)).not.toContain("unknown_variable");
    expect(codes(project)).not.toContain("invalid_interpolation");

    nodes.write = {
      type: "set",
      variable: "window.main.title",
      op: "assign",
      value: "x",
      next: "finish",
    };
    expect(codes(project)).toContain("readonly_window_variable");

    const declared = pairProject();
    declared.manifest.variables["window.main.title"] = {
      scope: "save",
      type: "string",
      default: "",
    };
    expect(codes(declared)).toContain("reserved_window_variable");
    expect(Object.keys(readableVariables(pairProject().manifest))).toEqual(
      expect.arrayContaining(["window.main.title", "window.secondary.title"]),
    );
  });

  it("rename and count ordinary variables inside title and block text", () => {
    const project = pairProject();
    project.manifest.variables.name = {
      scope: "save",
      type: "string",
      default: "",
    };
    const nodes = scene(project, "main").nodes;
    nodes.title = {
      type: "window_title",
      target: "main",
      title: "你好 [var=name]",
      next: "finish",
    };
    nodes.block = {
      type: "window_control",
      target: "secondary",
      action: "block",
      id: "gate",
      message: "等 [var=name]",
      next: "finish",
    };
    expect(countVariableReferences(project, "name")).toBe(2);
    const renamed = renameVariable(project, "name", "who");
    expect(scene(renamed, "main").nodes.title).toMatchObject({
      title: "你好 [var=who]",
    });
    expect(scene(renamed, "main").nodes.block).toMatchObject({
      message: "等 [var=who]",
    });
  });

  it("paste drops references to variables the destination lacks, keeps the built-ins", () => {
    const project = pairProject();
    const pasted = preparePastedNode(
      {
        type: "window_title",
        target: "main",
        title: "[var=window.main.title][var=gone]",
        next: "x",
      },
      project.manifest,
    );
    expect(pasted).toMatchObject({ title: "[var=window.main.title]" });
  });

  it("validate title and block texts", () => {
    expect(windowTitleProblem("正常标题")).toBeNull();
    expect(windowTitleProblem("a\nb")).toMatch(/控制字符/);
    expect(windowTitleProblem("字".repeat(2000))).toMatch(/字节/);
    const project = pairProject();
    scene(project, "main").nodes.title = {
      type: "window_title",
      target: "main",
      title: "a\tb",
      next: "finish",
    };
    scene(project, "main").nodes.block = {
      type: "window_control",
      target: "main",
      action: "block",
      id: "",
      next: "finish",
    };
    expect(codes(project)).toEqual(
      expect.arrayContaining(["invalid_window_title", "invalid_block_id"]),
    );
  });
});

describe("timer validation", () => {
  const withTimer = (patch: Record<string, unknown>): string[] => {
    const project = pairProject();
    scene(project, "main").nodes.arm = {
      ...(scene(project, "main").nodes.arm as object),
      ...patch,
    } as unknown as SceneNode;
    return codes(project);
  };

  it("rejects bad intervals, delays, ids and targets", () => {
    expect(withTimer({ interval_ms: 10 })).toContain("invalid_timer_interval");
    expect(withTimer({ delay_ms: 90_000 })).toContain("invalid_timer_delay");
    expect(withTimer({ id: "不行" })).toContain("invalid_timer_id");
    expect(withTimer({ target: null })).toContain("missing_timer_target");
    expect(withTimer({ target: "start" })).toContain("invalid_timer_target");
    expect(withTimer({ target: "open" })).toContain("invalid_timer_target");
    expect(withTimer({ target: "nowhere" })).toContain("invalid_timer_target");
  });

  it("does not require a target for stop", () => {
    // The effect node is then merely unreachable (a warning), never invalid.
    expect(
      withTimer({ action: "stop", target: null }).filter(
        (code) => code !== "unreachable_node",
      ),
    ).toEqual([]);
  });

  it("rejects an awaited effect", () => {
    const project = pairProject();
    scene(project, "main").nodes.flash = {
      ...(scene(project, "main").nodes.flash as object),
      await: true,
    } as SceneNode;
    expect(codes(project)).toContain("invalid_timer_target");
  });
});

describe("summaries", () => {
  it("describe the new nodes in plain language", () => {
    const timer = pairProject().scenes[0].definition.nodes.arm;
    expect(describeNode(timer).summary).toContain("每 1000 ms 重复");
    expect(
      describeNode({
        type: "window_control",
        target: "secondary",
        action: "advance",
        next: "a",
      }).summary,
    ).toBe("推进副窗口一页");
    expect(
      describeNode({
        type: "window_title",
        target: "main",
        title: "你好",
        next: "a",
      }).summary,
    ).toContain("主窗口标题");
  });
});

describe("window layout nodes", () => {
  const geometry = (patch: Record<string, unknown> = {}): SceneNode =>
    ({
      ...(defaultNode("window_geometry", "finish") as object),
      ...patch,
    }) as unknown as SceneNode;
  const layer = (patch: Record<string, unknown> = {}): SceneNode =>
    ({
      ...(defaultNode("window_layer", "finish") as object),
      ...patch,
    }) as unknown as SceneNode;

  /** The pair project with a timer pointed at `target`, a chain through `chain`. */
  function withLayout(nodes: Record<string, SceneNode>): EditorProject {
    const project = pairProject();
    const main = scene(project, "main");
    Object.assign(main.nodes, nodes);
    return project;
  }

  it("are timer targets only when they never wait", () => {
    expect(timerTargetAllowed(layer())).toBe(true);
    expect(timerTargetAllowed(layer({ action: "top" }))).toBe(true);
    expect(timerTargetAllowed(geometry())).toBe(true);
    expect(timerTargetAllowed(geometry({ await: true }))).toBe(false);
    expect(timerTargetProblem(geometry({ await: true }))).toMatch(/等待完成/);
    expect(timerTargetProblem(geometry())).toBeNull();
    expect(timerTargetProblem(layer())).toBeNull();
  });

  it("list a drifting geometry and a layer node as timer targets", () => {
    const project = withLayout({
      drift: geometry({
        position: {
          relative_to: "current",
          x: 0,
          y: 0,
          anchor_x: 0,
          anchor_y: 0,
          offset_x: 8,
          offset_y: 0,
        },
        duration_ms: 120,
      }),
      pin: layer({ action: "top" }),
      waits: geometry({ await: true }),
    });
    expect(validTimerTargets(scene(project, "main"))).toEqual([
      "drift",
      "flash",
      "pin",
    ]);
    const arm = scene(project, "main").nodes.arm;
    for (const target of ["drift", "pin"]) {
      scene(project, "main").nodes.arm = { ...arm, target } as SceneNode;
      expect(codes(project), target).not.toContain("invalid_timer_target");
    }
    scene(project, "main").nodes.arm = { ...arm, target: "waits" } as SceneNode;
    expect(codes(project)).toContain("invalid_timer_target");
  });

  it("accept the default nodes and reject out-of-range geometry", () => {
    const ok = withLayout({ move: geometry(), raise: layer() });
    expect(codes(ok).filter((code) => /window|duration/.test(code))).toEqual(
      [],
    );

    const cases: [string, Record<string, unknown>][] = [
      ["no position or size", { position: null, size: null }],
      [
        "anchor out of range",
        {
          position: {
            relative_to: "window",
            x: 1,
            y: 0.5,
            anchor_x: 1.5,
            anchor_y: 0.5,
          },
        },
      ],
      [
        "tiny logical size",
        { size: { unit: "logical", width: 0, height: 10 } },
      ],
      [
        "work area size over 1",
        { size: { unit: "work_area", width: 1.2, height: 0.5 } },
      ],
    ];
    for (const [label, patch] of cases) {
      const project = withLayout({ move: geometry(patch) });
      expect(codes(project), label).toContain("invalid_window_geometry");
    }
    expect(
      codes(withLayout({ move: geometry({ duration_ms: 70_000 }) })),
    ).toContain("invalid_duration");
    expect(
      codes(withLayout({ move: geometry({ duration_ms: 12.5 }) })),
    ).toContain("invalid_duration");
  });

  it("reject an unknown window or layer action", () => {
    expect(
      codes(withLayout({ move: geometry({ target: "third" }) })),
    ).toContain("invalid_window_target");
    expect(codes(withLayout({ raise: layer({ target: "third" }) }))).toContain(
      "invalid_window_target",
    );
    expect(codes(withLayout({ raise: layer({ action: "sink" }) }))).toContain(
      "invalid_window_layer_action",
    );
  });

  it("make their successors reachable like any flow node", () => {
    const project = withLayout({
      move: geometry({ next: "raise" }),
      raise: layer({ next: "tail" }),
      tail: { type: "end" },
    });
    scene(project, "main").nodes.open = {
      type: "open_window",
      scene: "side",
      next: "move",
    };
    const unreachable = validateLive(project)
      .filter((diagnostic) => diagnostic.code === "unreachable_node")
      .map((diagnostic) => diagnostic.node_id);
    expect(unreachable).not.toContain("move");
    expect(unreachable).not.toContain("raise");
    expect(unreachable).not.toContain("tail");
  });

  it("follow node renames and deletions with their next port", () => {
    const project = withLayout({
      move: geometry({ next: "finish" }),
      raise: layer({ next: "move" }),
    });
    const renamed = renameNode(project, "main", "move", "dock");
    expect(scene(renamed, "main").nodes.raise).toMatchObject({ next: "dock" });
    deleteNodes(project, "main", ["move"], "finish");
    expect(scene(project, "main").nodes.raise).toMatchObject({
      next: "finish",
    });
  });
});
