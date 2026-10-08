// @vitest-environment jsdom
/**
 * ButtonWorkspace: the shared keyframe surface writes only into the selected
 * state's `ButtonAnimation` channels, and the preview is the shared gameplay
 * button.
 */
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ButtonFile, EditorAsset } from "../types";
import { ButtonWorkspace } from "./ButtonWorkspace";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  // jsdom has no ResizeObserver; the preview scale observer only needs to be
  // present for mount/unmount.
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserverStub {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});

const ASSETS: EditorAsset[] = [
  {
    id: "gui.btn_normal",
    kind: "gui",
    path: "gui/btn_normal.png",
    absolute_path: "C:/game/gui/btn_normal.png",
  },
  {
    id: "gui.btn_hover",
    kind: "gui",
    path: "gui/btn_hover.png",
    absolute_path: "C:/game/gui/btn_hover.png",
  },
];

function buttonFile(): ButtonFile {
  return {
    path: "ui/buttons/demo.yaml",
    definition: {
      schema_version: 1,
      id: "demo",
      width: 320,
      height: 120,
      asset_mode: "separate",
      fit: "contain",
      normal: "gui.btn_normal",
      hover: "gui.btn_hover",
      pressed: null,
      animations: {
        normal: {
          duration_ms: 400,
          channels: {
            offset_y: [
              { at_ms: 0, value: 0, easing: "linear" },
              { at_ms: 400, value: -8, easing: "ease_out" },
            ],
          },
        },
        hover: {
          duration_ms: 200,
          channels: {
            offset_x: [
              { at_ms: 0, value: 2, easing: "linear" },
              { at_ms: 200, value: 6, easing: "linear" },
            ],
          },
        },
        pressed: null,
      },
    },
  };
}

interface WorkspaceProps {
  file: ButtonFile;
  onChange(file: ButtonFile): void;
}

function Workspace({ file, onChange }: WorkspaceProps): ReactElement {
  return (
    <ButtonWorkspace
      animationMap={{}}
      assets={ASSETS}
      dirty
      file={file}
      onBack={() => undefined}
      onChange={onChange}
      onRedo={() => undefined}
      onSave={() => undefined}
      onUndo={() => undefined}
    />
  );
}

function renderWorkspace(
  onChange: (file: ButtonFile) => void = () => undefined,
  file: ButtonFile = buttonFile(),
) {
  const view = render(<Workspace file={file} onChange={onChange} />);
  return { view };
}

function selectKeyframe(label: string): void {
  fireEvent.pointerDown(screen.getByLabelText(label), {
    button: 0,
    pointerId: 1,
  });
}

describe("ButtonWorkspace keyframe authoring", () => {
  it("writes a numeric keyframe edit into the selected state's channels", () => {
    const onChange = vi.fn<(file: ButtonFile) => void>();
    renderWorkspace(onChange);

    selectKeyframe("offset_y 400ms");
    const inspector = document.querySelector(".keyframe-inspector");
    expect(inspector).not.toBeNull();
    fireEvent.change(within(inspector as HTMLElement).getByLabelText(/数值/), {
      target: { value: "-20" },
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.definition.animations.normal?.channels.offset_y).toEqual([
      { at_ms: 0, value: 0, easing: "linear" },
      { at_ms: 400, value: -20, easing: "ease_out" },
    ]);
    // The other states are untouched by a normal-state edit.
    expect(next.definition.animations.hover?.channels.offset_x).toEqual([
      { at_ms: 0, value: 2, easing: "linear" },
      { at_ms: 200, value: 6, easing: "linear" },
    ]);
    expect(next.definition.animations.normal?.duration_ms).toBe(400);
  });

  it("adds a keyframe to the picked channel at the playhead", () => {
    const onChange = vi.fn<(file: ButtonFile) => void>();
    renderWorkspace(onChange);
    fireEvent.change(screen.getByLabelText("关键帧通道"), {
      target: { value: "scale_x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "＋关键帧" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(
      onChange.mock.calls[0][0].definition.animations.normal?.channels.scale_x,
    ).toEqual([{ at_ms: 0, value: 1, easing: "linear" }]);
  });

  it("deletes a selected keyframe through the shared surface control", () => {
    const onChange = vi.fn<(file: ButtonFile) => void>();
    renderWorkspace(onChange);
    selectKeyframe("offset_y 0ms");
    fireEvent.click(screen.getByRole("button", { name: "删除关键帧" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(
      onChange.mock.calls[0][0].definition.animations.normal?.channels.offset_y,
    ).toEqual([{ at_ms: 400, value: -8, easing: "ease_out" }]);
  });

  it("copies and pastes keyframes with the shared clipboard", () => {
    const onChange = vi.fn<(file: ButtonFile) => void>();
    renderWorkspace(onChange);
    selectKeyframe("offset_y 0ms");
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    // Move the playhead to a free 10 ms slot and paste.
    fireEvent.change(screen.getByLabelText("播放头"), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByRole("button", { name: "粘贴" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(
      onChange.mock.calls[0][0].definition.animations.normal?.channels.offset_y,
    ).toEqual([
      { at_ms: 0, value: 0, easing: "linear" },
      { at_ms: 100, value: 0, easing: "linear" },
      { at_ms: 400, value: -8, easing: "ease_out" },
    ]);
  });

  it("reflects the animated transform in the preview while editing", () => {
    // A stateful host keeps the committed file so the preview re-renders.
    function Harness(): ReactElement {
      const [file, setFile] = useState(buttonFile);
      return <Workspace file={file} onChange={setFile} />;
    }
    const view = render(<Harness />);
    const visual = view.container.querySelector(
      ".button-preview-hit .scene-button-visual",
    );
    expect(visual).not.toBeNull();
    expect((visual as HTMLElement).style.transform).toContain(
      "translate3d(0px, 0px, 0)",
    );

    selectKeyframe("offset_y 0ms");
    const inspector = document.querySelector(".keyframe-inspector");
    fireEvent.change(within(inspector as HTMLElement).getByLabelText(/数值/), {
      target: { value: "50" },
    });

    // The shared button pose follows the committed edit.
    expect((visual as HTMLElement).style.transform).toContain(
      "translate3d(0px, 50px, 0)",
    );
  });
});

describe("ButtonWorkspace shared gameplay button preview", () => {
  function preview(): HTMLElement {
    const element = document.querySelector(".button-preview-hit");
    if (!(element instanceof HTMLElement)) throw new Error("缺少预览点击区");
    return element;
  }

  function artwork(): HTMLImageElement[] {
    return Array.from(preview().querySelectorAll("img.scene-button-image"));
  }

  it("previews the real shared TemplateButton", () => {
    renderWorkspace();
    const button = preview().querySelector("button.scene-button");
    expect(button).not.toBeNull();
    expect(button).toHaveClass("scene-button-normal");
    // Artwork resolution, fit and box come from the shared component.
    const images = artwork();
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("src")).toBe("C:/game/gui/btn_normal.png");
    expect(images[0]?.style.objectFit).toBe("contain");
  });

  it("stays inert: activating the preview never dispatches an edit or action", () => {
    const onChange = vi.fn<(file: ButtonFile) => void>();
    renderWorkspace(onChange);
    const button = preview().querySelector("button.scene-button");
    expect(button).toBeDisabled();
    fireEvent.pointerDown(button as HTMLElement, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(button as HTMLElement, { button: 0, pointerId: 1 });
    fireEvent.click(button as HTMLElement);
    expect(onChange).not.toHaveBeenCalled();
    // The authoring state did not move away from the selected tab either.
    expect(button).toHaveClass("scene-button-normal");
  });

  it("scrubs the authored state deterministically with the playhead", () => {
    renderWorkspace();
    const visual = () =>
      preview().querySelector(".scene-button-visual") as HTMLElement;
    // normal: offset_y 0 -> -8 over 400 ms.
    expect(visual().style.transform).toContain("translate3d(0px, 0px, 0)");
    fireEvent.change(screen.getByLabelText("播放头"), {
      target: { value: "400" },
    });
    expect(visual().style.transform).toContain("translate3d(0px, -8px, 0)");
    fireEvent.change(screen.getByLabelText("播放头"), {
      target: { value: "200" },
    });
    expect(visual().style.transform).toContain("translate3d(0px, -4px, 0)");
  });

  it("re-targets the shared button to the selected state's artwork and pose", () => {
    renderWorkspace();
    expect(artwork()[0]?.getAttribute("src")).toBe(
      "C:/game/gui/btn_normal.png",
    );

    fireEvent.click(screen.getByRole("button", { name: "悬停" }));
    const button = preview().querySelector("button.scene-button");
    expect(button).toHaveClass("scene-button-hover");
    expect(artwork()[0]?.getAttribute("src")).toBe("C:/game/gui/btn_hover.png");
    // hover: offset_x 2 -> 6 over 200 ms; the playhead was reset by the tab.
    const visual = preview().querySelector(
      ".scene-button-visual",
    ) as HTMLElement;
    expect(visual.style.transform).toContain("translate3d(2px, 0px, 0)");
  });

  it("keeps the shared overlay composition for overlay-mode states", () => {
    const file = buttonFile();
    file.definition.asset_mode = "overlay";
    renderWorkspace(() => undefined, file);
    expect(artwork()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "悬停" }));
    // The real component composes the normal base with the hover overlay.
    expect(artwork().map((image) => image.getAttribute("src"))).toEqual([
      "C:/game/gui/btn_normal.png",
      "C:/game/gui/btn_hover.png",
    ]);
  });

  it("keeps the hit-area outline a togglable editor overlay", () => {
    renderWorkspace();
    expect(preview().style.borderStyle).toBe("dashed");
    fireEvent.click(screen.getByLabelText("显示点击区轮廓"));
    expect(preview().style.borderStyle).toBe("none");
  });
});
