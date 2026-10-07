// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFramePump,
  createMemoryKit,
  createMemoryTextureLoader,
} from "@vectspace/presentation-core/scene-test-kit";

import type { EditorAsset, SpriteActionDefinition } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));

import { ActionWorkspace } from "./ActionWorkspace";

afterEach(cleanup);

const ACTION: SpriteActionDefinition = {
  schema_version: 1,
  id: "sprite.bounce",
  name: "小跳",
  duration_ms: 600,
  end: "restore",
  parameters: { height: { default: 40, min: 0, max: 200 } },
  channels: {
    y: [
      { at_ms: 0, value: 0, easing: "linear" },
      { at_ms: 300, value: -1, easing: "ease_in_out", parameter: "height" },
      { at_ms: 600, value: 0, easing: "linear" },
    ],
  },
};

const ASSETS: EditorAsset[] = [
  {
    id: "sprite.jelly",
    kind: "sprite",
    path: "sprites/jelly.png",
    absolute_path: "C:/jelly.png",
  },
];

function renderWorkspace(
  onChange: (definition: SpriteActionDefinition) => void = () => undefined,
  definition: SpriteActionDefinition = ACTION,
) {
  const kit = createMemoryKit();
  const pump = createFramePump();
  const loader = createMemoryTextureLoader({
    "C:/jelly.png": { width: 200, height: 400 },
  });
  const view = render(
    <ActionWorkspace
      animationMap={{}}
      assets={ASSETS}
      definition={definition}
      dirty
      onBack={() => undefined}
      onChange={onChange}
      onRedo={() => undefined}
      onSave={() => undefined}
      onUndo={() => undefined}
      onValidate={() => undefined}
      path="actions/bounce.yaml"
      previewEnvironment={{
        kit: kit.kit,
        requestFrame: pump.request,
        cancelFrame: pump.cancel,
        textureLoader: loader.load,
      }}
    />,
  );
  return { view, kit, pump, loader };
}

describe("ActionWorkspace", () => {
  it("edits the action with the shared keyframe editor", () => {
    const onChange = vi.fn();
    renderWorkspace(onChange);

    // The action library no longer owns a bespoke keyframe table: the
    // workspace renders the same timeline editor the story timelines use, and
    // the keyframe markers are addressed by channel and time.
    expect(document.querySelector(".timeline-editor")).not.toBeNull();
    expect(screen.getByLabelText("y 300ms")).toBeInTheDocument();
    // Relative channels are projected onto the visible preview pose, so the
    // parameter default (40) is what the author sees on the ruler.
    fireEvent.pointerDown(screen.getByLabelText("y 300ms"), {
      button: 0,
      pointerId: 1,
    });

    const inspector = document.querySelector(".keyframe-inspector");
    expect(inspector).not.toBeNull();
    const valueInput = within(inspector as HTMLElement).getByLabelText(/数值/);
    fireEvent.change(valueInput, { target: { value: "1020" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const folded = onChange.mock.calls[0][0] as SpriteActionDefinition;
    // 1020 - 1080 = -60 relative, and editing the number detaches the frame
    // from the `height` parameter instead of silently keeping it.
    expect(folded.channels.y[1]).toEqual({
      at_ms: 300,
      value: -60,
      easing: "ease_in_out",
    });
    expect(folded.duration_ms).toBe(600);
    expect(folded.end).toBe("restore");
  });

  it("keeps the parameter binding when a keyframe only moves in time", () => {
    const onChange = vi.fn();
    renderWorkspace(onChange);
    fireEvent.pointerDown(screen.getByLabelText("y 300ms"), {
      button: 0,
      pointerId: 1,
    });

    const inspector = document.querySelector(".keyframe-inspector");
    const timeInput = within(inspector as HTMLElement).getByLabelText(/时间/);
    fireEvent.change(timeInput, { target: { value: "400" } });

    const folded = onChange.mock.calls[0][0] as SpriteActionDefinition;
    expect(folded.channels.y[1]).toEqual({
      at_ms: 400,
      value: 40,
      easing: "ease_in_out",
      parameter: "height",
    });
  });

  it("edits parameters and the end policy without touching keyframes", () => {
    const onChange = vi.fn();
    renderWorkspace(onChange);

    fireEvent.change(screen.getByLabelText("height 默认值"), {
      target: { value: "80" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        parameters: { height: { default: 80, min: 0, max: 200 } },
      }),
    );

    fireEvent.change(screen.getByLabelText("结束姿态"), {
      target: { value: "hold" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ end: "hold" }),
    );
    // Keyframes are carried through untouched.
    expect(
      (onChange.mock.lastCall?.[0] as SpriteActionDefinition).channels.y,
    ).toEqual(ACTION.channels.y);
  });

  it("uses the shared scene surface for the default artwork and follows the playhead", async () => {
    const harness = renderWorkspace(() => undefined, {
      schema_version: 1,
      id: "sprite.drop",
      name: "落下",
      duration_ms: 200,
      end: "hold",
      channels: {
        y: [
          { at_ms: 0, value: 0, easing: "linear" },
          { at_ms: 200, value: -100, easing: "linear" },
        ],
      },
    });

    expect(screen.getByLabelText("立绘素材")).toHaveTextContent("sprite.jelly");
    await waitFor(() => {
      expect(screen.getByLabelText("动作预览播放头")).not.toBeDisabled();
    });
    const characterLayer =
      harness.kit.applications[0]?.stage.children[0];
    expect(characterLayer?.children).toHaveLength(1);
    expect(characterLayer?.children[0]?.position.y).toBe(1080);

    fireEvent.change(screen.getByLabelText("动作预览播放头"), {
      target: { value: "200" },
    });
    await waitFor(() => {
      expect(characterLayer?.children[0]?.position.y).toBe(980);
    });
  });
});
