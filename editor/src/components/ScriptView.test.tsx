// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ContentManifest, SceneDefinition } from "../types";
import { ScriptView } from "./ScriptView";

const manifest: ContentManifest = {
  schema_version: 2,
  content_version: "test",
  entry_scene: "main",
  default_locale: "zh-CN",
  variables: {},
  characters: {},
  assets: {},
  scenes: ["scenes/main.yaml"],
  ui_motions: [],
  ui_motion_defaults: {},
};

const scene: SceneDefinition = {
  schema_version: 2,
  id: "main",
  entry: "choice",
  nodes: {
    choice: {
      type: "choice",
      choices: [
        { id: "left", label: "左分支", next: "left" },
        { id: "right", label: "右分支", next: "right" },
      ],
    },
    left: {
      type: "say",
      speaker: null,
      text: "左",
      speed_cps: null,
      next: "finish",
    },
    right: {
      type: "say",
      speaker: null,
      text: "右",
      speed_cps: null,
      next: "finish",
    },
    finish: { type: "end" },
  },
};

describe("ScriptView branch insertion", () => {
  it("offers branch outlets and inserts into the selected outlet", () => {
    const onInsertAfter = vi.fn();
    render(
      <ScriptView
        manifest={manifest}
        onChange={() => undefined}
        onDelete={() => undefined}
        onInsertAfter={onInsertAfter}
        onInsertBatch={() => undefined}
        onOpenGraph={() => undefined}
        onSelect={() => undefined}
        scene={scene}
        selectedNodeId="choice"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "在 choice 后插入对话" }),
    );
    const menu = screen.getByLabelText("choice 插入出口");
    expect(menu).toBeTruthy();
    fireEvent.click(
      within(menu).getByRole("button", { name: "右分支 → right" }),
    );

    expect(onInsertAfter).toHaveBeenCalledTimes(1);
    expect(onInsertAfter).toHaveBeenCalledWith("choice", "choice:right");
  });
});

describe("ScriptView choice summary", () => {
  it("shows the legacy option count and the template presentation when set", () => {
    const legacy: SceneDefinition = {
      ...scene,
      nodes: {
        ...scene.nodes,
        choice: {
          type: "choice",
          choices: [{ id: "left", label: "左分支", next: "left" }],
        },
      },
    };
    const first = render(
      <ScriptView
        manifest={manifest}
        onChange={() => undefined}
        onDelete={() => undefined}
        onInsertAfter={() => undefined}
        onInsertBatch={() => undefined}
        onOpenGraph={() => undefined}
        onSelect={() => undefined}
        scene={legacy}
        selectedNodeId={null}
      />,
    );
    expect(screen.getByText("1 个选项")).toBeTruthy();
    first.unmount();

    const presented: SceneDefinition = {
      ...scene,
      nodes: {
        ...scene.nodes,
        choice: {
          type: "choice",
          presentation: {
            template: "choice.primary",
            anchor_x: 960,
            anchor_y: 540,
            direction: "horizontal",
            gap: 20,
            button_width: null,
            button_height: null,
          },
          choices: [
            { id: "left", label: "左分支", next: "left" },
            { id: "right", label: "右分支", next: "right" },
          ],
        },
      },
    };
    render(
      <ScriptView
        manifest={manifest}
        onChange={() => undefined}
        onDelete={() => undefined}
        onInsertAfter={() => undefined}
        onInsertBatch={() => undefined}
        onOpenGraph={() => undefined}
        onSelect={() => undefined}
        scene={presented}
        selectedNodeId={null}
      />,
    );
    expect(screen.getByText("2 个选项 · choice.primary · 横向")).toBeTruthy();
  });
});
