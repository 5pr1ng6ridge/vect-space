// @vitest-environment jsdom

import type { ReactElement } from "react";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryKit,
  createMemoryTextureLoader,
} from "@vectspace/presentation-core/scene-test-kit";
import { SceneSurface } from "@vectspace/presentation-core/scene-surface";

import type {
  ContentManifest,
  EditorAsset,
  SceneDefinition,
  SceneNode,
} from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));

import { NodeInspector } from "./NodeInspector";

afterEach(cleanup);

const ASSETS: EditorAsset[] = [
  {
    id: "bg.a",
    kind: "background",
    path: "backgrounds/a.png",
    absolute_path: "C:/a.png",
  },
  {
    id: "gui.curtain",
    kind: "gui",
    path: "gui/curtain.png",
    absolute_path: "C:/curtain.png",
  },
  {
    id: "ambience.forest",
    kind: "ambience",
    path: "audio/ambience.forest.ogg",
    absolute_path: "C:/ambience.forest.ogg",
  },
];

const MANIFEST: ContentManifest = {
  schema_version: 2,
  content_version: "test",
  entry_scene: "main",
  default_locale: "zh-CN",
  variables: {},
  characters: {},
  assets: {
    "bg.a": { kind: "background", path: "backgrounds/a.png" },
    "gui.curtain": { kind: "gui", path: "gui/curtain.png" },
    "ambience.forest": {
      kind: "ambience",
      path: "audio/ambience.forest.ogg",
    },
  },
  scenes: ["scenes/main.yaml"],
  ui_motions: [],
  ui_motion_defaults: {},
};

function sceneWith(node: SceneNode): SceneDefinition {
  return {
    schema_version: 2,
    id: "main",
    entry: "target",
    nodes: {
      start: {
        type: "background",
        background: "bg.a",
        transition: { type: "cut" },
        duration_ms: 0,
        easing: "linear",
        await: false,
        next: "target",
      },
      target: node,
    },
  };
}

function renderInspector(node: SceneNode, onChange = vi.fn()) {
  const kit = createMemoryKit();
  const loader = createMemoryTextureLoader({
    "C:/a.png": { width: 1920, height: 1080 },
    "C:/curtain.png": { width: 1920, height: 1080 },
  });
  const environment = { kit: kit.kit, textureLoader: loader.load };
  const scene = sceneWith(node);
  const element = (
    assets: EditorAsset[] = ASSETS,
    changeNode = onChange,
  ): ReactElement => (
    <NodeInspector
      assets={assets}
      buttons={[]}
      manifest={MANIFEST}
      nodeId="target"
      onChange={changeNode}
      onConvertToTimeline={() => undefined}
      onDelete={() => undefined}
      onDuplicate={() => undefined}
      onOpenLongTextWorkspace={() => undefined}
      onRename={() => undefined}
      onSetEntry={() => undefined}
      onSplitDialogue={() => undefined}
      onSplitLongText={() => undefined}
      previewEnvironment={environment}
      scene={scene}
      uiMotions={[]}
    />
  );
  const view = render(element());
  return { kit, loader, view, element, onChange };
}

describe("NodeInspector canonical presentation editors", () => {
  it("edits ambience slots and canonicalizes stop nodes", () => {
    const { onChange } = renderInspector({
      type: "ambience",
      slot: "slot_1",
      action: "start",
      asset: "ambience.forest",
      volume: 0.5,
      duration_ms: 0,
      start_ms: 250,
      loop_start_ms: 100,
      loop_end_ms: 900,
      await: true,
      next: "target",
    });
    const comboboxes = screen.getAllByRole<HTMLSelectElement>("combobox");
    expect(comboboxes.some((field) => field.value === "slot_1")).toBe(true);
    expect(comboboxes.some((field) => field.value === "start")).toBe(true);
    const slotField = comboboxes.find((field) => field.value === "slot_1");
    if (slotField === undefined) throw new Error("missing ambience slot field");
    fireEvent.change(slotField, { target: { value: "slot_4" } });
    expect(onChange).toHaveBeenLastCalledWith(
      "target",
      expect.objectContaining({ slot: "slot_4" }),
    );

    const actionField = comboboxes.find((field) => field.value === "start");
    if (actionField === undefined)
      throw new Error("missing ambience action field");
    fireEvent.change(actionField, { target: { value: "stop" } });
    expect(onChange).toHaveBeenLastCalledWith("target", {
      type: "ambience",
      slot: "slot_1",
      action: "stop",
      asset: null,
      volume: 0.5,
      duration_ms: 0,
      await: true,
      next: "target",
    });
  });

  it("edits a background transition with every parameter and a live preview", () => {
    const { onChange } = renderInspector({
      type: "background",
      background: "bg.a",
      transition: { type: "cross_fade" },
      duration_ms: 500,
      easing: "ease_in_out",
      await: false,
      next: "target",
    });
    expect(screen.getByLabelText("转场类型")).toBeDefined();
    expect(screen.getByLabelText("缓动")).toBeDefined();
    expect(screen.getByLabelText("时长 ms")).toBeDefined();
    expect(screen.getByLabelText("背景转场预览")).toBeDefined();

    fireEvent.change(screen.getByLabelText("转场类型"), {
      target: { value: "wipe" },
    });
    expect(onChange).toHaveBeenLastCalledWith("target", {
      type: "background",
      background: "bg.a",
      transition: {
        type: "wipe",
        direction: "left_to_right",
        softness: 0,
      },
      duration_ms: 500,
      easing: "ease_in_out",
      await: false,
      next: "target",
    });

    fireEvent.change(screen.getByLabelText("转场类型"), {
      target: { value: "fade_through_color" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      "target",
      expect.objectContaining({
        transition: { type: "fade_through_color", color: "#000000" },
      }),
    );
  });

  it("edits a curtain with fill, animation and the 1920x1080 preview", () => {
    const { onChange } = renderInspector({
      type: "curtain",
      action: "cover",
      fill: { color: "#000000" },
      transition: { type: "fade" },
      duration_ms: 500,
      easing: "ease_in_out",
      await: false,
      next: "target",
    });
    expect(screen.getByLabelText("幕布动作")).toBeDefined();
    expect(screen.getByLabelText("幕布填充")).toBeDefined();
    expect(screen.getByLabelText("幕布颜色")).toBeDefined();
    expect(screen.getByLabelText("幕布动画")).toBeDefined();
    const canvas = screen.getByLabelText("幕布预览");
    expect(canvas).toHaveAttribute("width", "1920");
    expect(canvas).toHaveAttribute("height", "1080");

    fireEvent.change(screen.getByLabelText("幕布动画"), {
      target: { value: "wipe" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      "target",
      expect.objectContaining({
        transition: { type: "wipe", direction: "left_to_right" },
      }),
    );

    fireEvent.change(screen.getByLabelText("幕布填充"), {
      target: { value: "asset" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      "target",
      expect.objectContaining({ fill: { asset: "" } }),
    );

    // A reveal has no fill and hides whatever the current curtain shows.
    fireEvent.change(screen.getByLabelText("幕布动作"), {
      target: { value: "reveal" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      "target",
      expect.objectContaining({ action: "reveal", fill: null }),
    );
  });

  it("edits a type-safe screen effect with ranges and the shared preview", () => {
    const { onChange } = renderInspector({
      type: "screen_effect",
      effect: { type: "flash", color: "#FFFFFF", peak_alpha: 0.88 },
      duration_ms: 200,
      await: false,
      next: "target",
    });
    expect(screen.getByLabelText("效果类型")).toBeDefined();
    expect(screen.getByLabelText("闪光颜色")).toBeDefined();
    expect(screen.getByLabelText("峰值透明度（0–1）")).toBeDefined();
    expect(screen.getByLabelText("屏幕效果预览")).toBeDefined();

    fireEvent.change(screen.getByLabelText("效果类型"), {
      target: { value: "shake" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      "target",
      expect.objectContaining({
        effect: {
          type: "shake",
          amplitude_x: 16,
          amplitude_y: 9.6,
          frequency_hz: 18,
          decay: 1,
          seed: 0,
        },
      }),
    );
  });

  it("keeps the preview surface and playhead across an unrelated rerender", async () => {
    const { element, kit, view } = renderInspector({
      type: "background",
      background: "bg.a",
      transition: { type: "cross_fade" },
      duration_ms: 40,
      easing: "ease_in_out",
      await: false,
      next: "target",
    });

    // Seek to the end of the cue so a rebuild would be visible as a reset
    // playhead.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "转场后" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "转场后" }));
    await waitFor(() => expect(screen.getByText("40 / 40 ms")).toBeDefined(), {
      timeout: 5000,
    });

    const surface = kit.applications[0];
    const reset = vi.spyOn(SceneSurface.prototype, "reset");
    try {
      // A parent rerender with fresh assets/onChange identities is not an
      // authored change: no rebuild, same surface, playhead untouched.
      view.rerender(element([...ASSETS], vi.fn()));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText("40 / 40 ms")).toBeDefined();
      expect(reset).not.toHaveBeenCalled();
      expect(kit.applications).toHaveLength(1);
      expect(kit.applications[0]).toBe(surface);
      expect(surface?.destroyed).toBe(false);
    } finally {
      reset.mockRestore();
    }
  });

  it("plays a curtain cover in the live preview", async () => {
    renderInspector({
      type: "curtain",
      action: "cover",
      fill: { color: "#112233" },
      transition: { type: "fade" },
      duration_ms: 40,
      easing: "linear",
      await: false,
      next: "target",
    });
    const seek = await screen.findByRole("button", { name: "转场后" });
    await waitFor(() => expect(seek).toBeEnabled());
    fireEvent.click(seek);
    await waitFor(() => expect(screen.getByText("40 / 40 ms")).toBeDefined(), {
      timeout: 5000,
    });
  });
});
