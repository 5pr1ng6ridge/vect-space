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
