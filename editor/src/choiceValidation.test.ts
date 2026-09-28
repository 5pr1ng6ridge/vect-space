import { describe, expect, it } from "vitest";

import {
  findAssetReferences,
  findButtonTemplateReferences,
} from "./components/assetReferences";
import { preparePastedNode } from "./story";
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
      variables: {},
      characters: {},
      assets: {
        "gui.icon": { kind: "gui", path: "gui/icon.png" },
        "sprite.x": { kind: "sprite", path: "sprites/x.png" },
      },
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
          entry: "route",
          nodes: {
            route: {
              type: "choice",
              presentation: {
                template: "missing.template",
                anchor_x: 2400,
                anchor_y: -1,
                direction: "vertical",
                gap: -5,
                button_width: 0,
                button_height: 10,
              },
              choices: [
                { id: "a", label: "缺失图标", icon: "missing.icon", next: "" },
                { id: "b", label: "错误类型", icon: "sprite.x", next: "" },
                {
                  id: "c",
                  label: "缺失模板",
                  template: "missing.option",
                  next: "",
                },
              ],
            },
          },
        },
      },
    ],
    ui_motions: [],
    buttons: [
      {
        path: "ui/buttons/choice_primary.yaml",
        definition: {
          schema_version: 1,
          id: "choice.primary",
          width: 320,
          height: 88,
          asset_mode: "separate",
          fit: "stretch",
          normal: "gui.icon",
          hover: null,
          pressed: null,
          animations: {},
        },
      },
    ],
    layout: { version: 1, scenes: {} },
    assets: [],
    diagnostics: [],
  };
}

describe("choice presentation live diagnostics", () => {
  it("reports invalid ranges, unknown templates and bad icons", () => {
    const codes = validateLive(project()).map((diagnostic) => diagnostic.code);
    expect(codes).toContain("invalid_choice_anchor");
    expect(codes).toContain("invalid_choice_gap");
    expect(codes).toContain("invalid_choice_size");
    expect(codes).toContain("unknown_choice_template");
    expect(codes).toContain("missing_choice_icon");
    expect(codes).toContain("invalid_choice_icon_kind");
    // Node template and option template are distinct diagnostics.
    const templateIssues = validateLive(project()).filter(
      (diagnostic) => diagnostic.code === "unknown_choice_template",
    );
    expect(templateIssues).toHaveLength(2);
    expect(templateIssues.map((issue) => issue.message).join()).toContain(
      "missing.option",
    );
  });

  it("accepts a fully resolved presentation", () => {
    const valid = project();
    const node = valid.scenes[0].definition.nodes.route;
    if (node.type !== "choice") throw new Error("fixture must be a choice");
    node.presentation = {
      template: "choice.primary",
      anchor_x: 960,
      anchor_y: 540,
      direction: "horizontal",
      gap: 16,
      button_width: null,
      button_height: 72,
    };
    node.choices = [
      {
        id: "a",
        label: "A",
        icon: "gui.icon",
        template: "choice.primary",
        next: "",
      },
      { id: "b", label: "B", next: "" },
    ];
    expect(
      validateLive(valid).filter((diagnostic) =>
        diagnostic.code.includes("choice"),
      ),
    ).toEqual([]);
  });
});

describe("choice asset and template references", () => {
  it("counts a choice icon as a gui asset reference", () => {
    const withIcon = project();
    const node = withIcon.scenes[0].definition.nodes.route;
    if (node.type !== "choice") throw new Error("fixture must be a choice");
    node.choices[1].icon = "gui.icon";
    expect(findAssetReferences(withIcon, "gui.icon")).toEqual([
      "main/route",
      "button-template:choice.primary/normal",
    ]);
  });

  it("counts node templates and option templates as button-template references", () => {
    const withReferences = project();
    const node = withReferences.scenes[0].definition.nodes.route;
    if (node.type !== "choice") throw new Error("fixture must be a choice");
    node.presentation = {
      template: "choice.primary",
      anchor_x: 960,
      anchor_y: 540,
      direction: "vertical",
      gap: 20,
      button_width: null,
      button_height: null,
    };
    node.choices[0].template = "choice.primary";
    withReferences.scenes[0].definition.nodes.create = {
      type: "button_create",
      instance_id: "confirm",
      template: "choice.primary",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      visible: true,
      enabled: true,
      action: { sets: [] },
      next: "route",
    };
    expect(
      findButtonTemplateReferences(withReferences, "choice.primary"),
    ).toEqual(["main/route · 节点模板", "main/route · 选项 a", "main/create"]);
    expect(findButtonTemplateReferences(withReferences, "unused")).toEqual([]);
  });

  it("clears pasted template and icon references the destination lacks", () => {
    const source = {
      type: "choice" as const,
      presentation: {
        template: "choice.missing",
        anchor_x: 960,
        anchor_y: 540,
        direction: "vertical" as const,
        gap: 20,
        button_width: null,
        button_height: null,
      },
      choices: [
        {
          id: "keep",
          label: "保留",
          template: "choice.primary",
          icon: "gui.icon",
          next: "end",
        },
        {
          id: "drop",
          label: "清除",
          template: "choice.missing",
          icon: "missing.icon",
          next: "end",
        },
      ],
    };
    const pasted = preparePastedNode(
      source,
      project().manifest,
      null,
      project().buttons ?? [],
    );
    if (pasted.type !== "choice")
      throw new Error("paste must keep the node type");
    expect(pasted.presentation?.template).toBeNull();
    expect(pasted.choices[0].template).toBe("choice.primary");
    expect(pasted.choices[0].icon).toBe("gui.icon");
    expect(pasted.choices[0].next).toBe("");
    expect(pasted.choices[1].template).toBeNull();
    expect(pasted.choices[1].icon).toBeNull();
  });
});
