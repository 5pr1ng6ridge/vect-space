// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
}));

// The inspector must not need real Web Audio in jsdom: the bounded decoder is
// replaced by a deterministic waveform.
vi.mock("../audioWaveform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audioWaveform")>();
  return {
    ...actual,
    decodeWaveform: () =>
      Promise.resolve({
        durationMs: 4000,
        peaks: new Array<number>(24).fill(0.4),
      }),
  };
});

import type {
  ContentManifest,
  EditorAsset,
  SceneDefinition,
  SceneNode,
} from "../types";
import { NodeInspector } from "./NodeInspector";

afterEach(cleanup);

const METADATA = {
  channels: 2,
  duration_ms: "4000",
  font_family: null,
  font_style: null,
  format: "ogg",
  height: null,
  sample_rate: 44100,
  width: null,
};

const ASSETS: EditorAsset[] = [
  {
    absolute_path: "C:/game/audio/a.ogg",
    id: "bgm.a",
    kind: "bgm",
    metadata: METADATA,
    path: "audio/a.ogg",
  },
  {
    absolute_path: "C:/game/audio/amb.ogg",
    id: "ambience.forest",
    kind: "ambience",
    metadata: METADATA,
    path: "audio/amb.ogg",
  },
];

const MANIFEST: ContentManifest = {
  assets: {
    "ambience.forest": { kind: "ambience", path: "audio/amb.ogg" },
    "bgm.a": { kind: "bgm", path: "audio/a.ogg" },
  },
  characters: {},
  content_version: "test",
  default_locale: "zh-CN",
  entry_scene: "main",
  scenes: ["scenes/main.yaml"],
  schema_version: 2,
  ui_motion_defaults: {},
  ui_motions: [],
  variables: {},
};

function sceneWith(node: SceneNode): SceneDefinition {
  return {
    entry: "target",
    id: "main",
    nodes: { target: node },
    schema_version: 2,
  };
}

function renderInspector(node: SceneNode) {
  const onChange = vi.fn();
  const view = render(
    <NodeInspector
      assets={ASSETS}
      buttons={[]}
      manifest={MANIFEST}
      nodeId="target"
      onChange={onChange}
      onConvertToTimeline={() => undefined}
      onDelete={() => undefined}
      onDuplicate={() => undefined}
      onOpenLongTextWorkspace={() => undefined}
      onRename={() => undefined}
      onSetEntry={() => undefined}
      onSplitDialogue={() => undefined}
      onSplitLongText={() => undefined}
      scene={sceneWith(node)}
      uiMotions={[]}
    />,
  );
  return { onChange, view };
}

describe("NodeInspector audio editors", () => {
  it("exposes the waveform editor for a bgm start node", async () => {
    renderInspector({
      action: "start",
      asset: "bgm.a",
      await: true,
      duration_ms: 0,
      loop_end_ms: 3000,
      loop_start_ms: 1000,
      next: "target",
      start_ms: 500,
      type: "bgm",
      volume: 0.5,
    });
    expect(
      await screen.findByRole("slider", { name: "BGM 起播标记" }),
    ).toBeDefined();
    expect(
      screen.getByRole("slider", { name: "BGM 循环起点标记" }),
    ).toBeDefined();
    expect(
      screen.getByRole("slider", { name: "BGM 循环终点标记" }),
    ).toBeDefined();
    expect(screen.getByLabelText("起播 ms")).toHaveValue(500);
    expect(screen.getByLabelText("循环起点 ms")).toHaveValue(1000);
    expect(screen.getByLabelText("循环终点 ms")).toHaveValue(3000);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("素材时长 4.00 s"),
    );
  });

  it("exposes the waveform editor for an ambience start node", async () => {
    renderInspector({
      action: "start",
      asset: "ambience.forest",
      await: true,
      duration_ms: 0,
      next: "target",
      slot: "slot_1",
      start_ms: 0,
      type: "ambience",
      volume: 0.5,
    });
    expect(
      await screen.findByRole("slider", { name: "环境声 起播标记" }),
    ).toBeDefined();
    expect(screen.getByLabelText("起播 ms")).toHaveValue(0);
    expect(screen.getByLabelText("自定义循环段")).not.toBeChecked();
  });

  it("hides the editor for a stop action", () => {
    renderInspector({
      action: "stop",
      asset: null,
      await: true,
      duration_ms: 0,
      next: "target",
      type: "bgm",
      volume: 0.5,
    });
    expect(screen.queryByRole("slider", { name: "BGM 起播标记" })).toBeNull();
    expect(screen.queryByLabelText("起播 ms")).toBeNull();
  });

  it("persists an exact millisecond commit through the node change path", async () => {
    const { onChange } = renderInspector({
      action: "start",
      asset: "bgm.a",
      await: true,
      duration_ms: 0,
      loop_end_ms: 3000,
      loop_start_ms: 1000,
      next: "target",
      start_ms: 500,
      type: "bgm",
      volume: 0.5,
    });
    const input = await screen.findByLabelText("起播 ms");
    fireEvent.change(input, { target: { value: "1234" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      "target",
      expect.objectContaining({
        loop_end_ms: 3000,
        loop_start_ms: 1000,
        start_ms: 1234,
        type: "bgm",
      }),
    );
  });

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
});
