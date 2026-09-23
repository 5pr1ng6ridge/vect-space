// @vitest-environment jsdom
/**
 * UiMotionWorkspace keyframe authoring.
 *
 * UI motion presets are edited with the same shared keyframe surface as the
 * story timeline, while the *real* shared `DialogueBox` (driven by the same
 * `UiMotionHost` the game uses) stays the authority for the target visuals.
 * These tests pin both halves: the surface folds back to the exact target
 * list/order, the preview is the shipping component, and the editor-only hit
 * boxes drive the authored offset channels.
 */
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EditorAsset, UiMotionFile } from "../types";
import { UiMotionWorkspace } from "./UiMotionWorkspace";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));

const resizeCallbacks: (() => void)[] = [];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  resizeCallbacks.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserverStub {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback);
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});

const ASSETS: EditorAsset[] = [
  {
    id: "gui.dialogue_box",
    kind: "gui",
    path: "gui/dialogue_box.png",
    absolute_path: "C:/game/gui/dialogue_box.png",
  },
  {
    id: "gui.name_box",
    kind: "gui",
    path: "gui/name_box.png",
    absolute_path: "C:/game/gui/name_box.png",
  },
];

const FONT_ASSETS: EditorAsset[] = [
  {
    id: "font.fusion_pixel",
    kind: "font",
    path: "fonts/fusion_pixel.ttf",
    absolute_path: "C:/game/fonts/fusion_pixel.ttf",
  },
];

function motionFile(): UiMotionFile {
  return {
    path: "ui/motions/dialogue.yaml",
    definition: {
      schema_version: 1,
      id: "dialogue.in",
      duration_ms: 300,
      tracks: [
        {
          target: "dialogue_root",
          channels: {
            offset_y: [
              { at_ms: 0, value: 40, easing: "linear" },
              { at_ms: 300, value: 0, easing: "ease_out" },
            ],
            opacity: [
              { at_ms: 0, value: 0, easing: "linear" },
              { at_ms: 300, value: 1, easing: "linear" },
            ],
          },
        },
      ],
    },
  };
}

function Workspace({
  file,
  assets = ASSETS,
  defaultFontId,
  onChange,
}: {
  file: UiMotionFile;
  assets?: EditorAsset[];
  defaultFontId?: string | null;
  onChange(file: UiMotionFile): void;
}): ReactElement {
  return (
    <UiMotionWorkspace
      animationMap={{}}
      assets={assets}
      defaultFontId={defaultFontId}
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
  onChange: (file: UiMotionFile) => void = () => undefined,
  file: UiMotionFile = motionFile(),
  assets: EditorAsset[] = ASSETS,
  defaultFontId?: string | null,
) {
  const view = render(
    <Workspace
      assets={assets}
      defaultFontId={defaultFontId}
      file={file}
      onChange={onChange}
    />,
  );
  return { view };
}

function dialogueRoot(view: ReturnType<typeof render>): HTMLElement {
  const element = view.container.querySelector(".dialogue-box");
  if (!(element instanceof HTMLElement)) throw new Error("缺少对话框预览");
  return element;
}

/** jsdom has no layout: give the measured nodes a real design rect. */
function stubRect(element: Element, rect: Partial<DOMRect>): void {
  element.getBoundingClientRect = (): DOMRect => ({
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...rect,
  });
}

describe("UiMotionWorkspace keyframe authoring", () => {
  it("authors each target as a track on the shared surface and drives the real dialogue node", () => {
    const { view } = renderWorkspace();
    expect(view.container.querySelector(".timeline-surface")).not.toBeNull();
    expect(view.container.querySelector(".timeline-ruler")).not.toBeNull();
    expect(screen.getByLabelText("播放头")).toBeInTheDocument();
    expect(
      within(
        view.container.querySelector(".timeline-surface") as HTMLElement,
      ).getByText("对话框整体"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("offset_y 0ms")).toBeInTheDocument();
    // The real shared dialogue box is driven from the same playhead.
    expect(dialogueRoot(view).style.transform).toBe(
      "translate3d(0px, 40px, 0) rotate(0deg) scale(1, 1)",
    );
    expect(dialogueRoot(view).style.opacity).toBe("0");
  });

  it("previews the real shared DialogueBox rather than a mock dialogue DOM", () => {
    const { view } = renderWorkspace();
    // The mock duplicate (and its hard-coded speaker/formula) is gone.
    expect(view.container.querySelector(".ui-preview-dialogue")).toBeNull();
    expect(view.container.querySelector(".ui-preview-surface")).toBeNull();
    expect(view.container.querySelector(".ui-preview-name")).toBeNull();
    expect(view.container.querySelector(".ui-preview-text")).toBeNull();
    expect(view.container.querySelector(".ui-preview-indicator")).toBeNull();
    // Every shared motion target is registered by the real component.
    const root = dialogueRoot(view);
    expect(root).toHaveClass("dialogue-box", "is-visible");
    expect(
      root.querySelector(".dialogue-surface .dialogue-frame"),
    ).not.toBeNull();
    expect(root.querySelector(".speaker-name")).not.toBeNull();
    expect(root.querySelector(".dialogue-text")).not.toBeNull();
    expect(root.querySelector(".advance-indicator")).not.toBeNull();
    expect(view.container.textContent).not.toContain("爱丽丝");
    expect(view.container.textContent).toContain("角色名");
  });

  it("reflects a numeric keyframe edit live in the real dialogue node", () => {
    function Harness(): ReactElement {
      const [file, setFile] = useState(motionFile);
      return <Workspace file={file} onChange={setFile} />;
    }
    const view = render(<Harness />);

    fireEvent.pointerDown(screen.getByLabelText("offset_y 0ms"), {
      button: 0,
      pointerId: 1,
    });
    const inspector = document.querySelector(".keyframe-inspector");
    expect(inspector).not.toBeNull();
    fireEvent.change(within(inspector as HTMLElement).getByLabelText(/数值/), {
      target: { value: "80" },
    });

    expect(dialogueRoot(view).style.transform).toContain(
      "translate3d(0px, 80px, 0)",
    );
  });

  it("adds a target track and a channel through the shared surface", () => {
    const onChange = vi.fn<(file: UiMotionFile) => void>();
    renderWorkspace(onChange);

    fireEvent.change(screen.getByLabelText("添加目标"), {
      target: { value: "dialogue_text" },
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(
      onChange.mock.calls[0][0].definition.tracks.map((track) => track.target),
    ).toEqual(["dialogue_root", "dialogue_text"]);
    expect(
      onChange.mock.calls[0][0].definition.tracks[1]?.channels.opacity,
    ).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("对话框整体 添加通道"), {
      target: { value: "rotation_deg" },
    });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(
      onChange.mock.calls[1][0].definition.tracks[0]?.channels.rotation_deg,
    ).toEqual([
      { at_ms: 0, value: 0, easing: "linear" },
      { at_ms: 300, value: 0, easing: "linear" },
    ]);
  });

  it("deletes a selected keyframe and preserves the target order", () => {
    const onChange = vi.fn<(file: UiMotionFile) => void>();
    renderWorkspace(onChange);
    fireEvent.pointerDown(screen.getByLabelText("offset_y 300ms"), {
      button: 0,
      pointerId: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: "删除关键帧" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.definition.tracks).toHaveLength(1);
    expect(next.definition.tracks[0]?.target).toBe("dialogue_root");
    expect(next.definition.tracks[0]?.channels.offset_y).toEqual([
      { at_ms: 0, value: 40, easing: "linear" },
    ]);
  });

  it("writes an offset keyframe when a measured target node is dragged", () => {
    const onChange = vi.fn<(file: UiMotionFile) => void>();
    const { view } = renderWorkspace(onChange);
    // Real layout (design scale 0.5): the dialogue box is 1920x387 at y=693.
    stubRect(view.container.querySelector(".ui-motion-preview") as Element, {
      width: 960,
      height: 540,
    });
    stubRect(view.container.querySelector(".ui-motion-design") as Element, {
      width: 960,
      height: 540,
    });
    stubRect(dialogueRoot(view), {
      left: 0,
      top: 346.5,
      width: 960,
      height: 193.5,
    });
    act(() => resizeCallbacks.forEach((callback) => callback()));

    const target = screen.getByLabelText("对话框整体 预览区域");
    expect(target.style.left).toBe("0px");
    expect(target.style.top).toBe("693px");
    expect(target.style.width).toBe("1920px");
    expect(target.style.height).toBe("387px");
    expect(target).toHaveClass("selected");

    fireEvent.pointerDown(target, {
      button: 0,
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });
    fireEvent.pointerMove(dialogueRoot(view), {
      clientX: 50,
      clientY: 10,
      pointerId: 1,
    });
    fireEvent.pointerUp(target, {
      clientX: 50,
      clientY: 10,
      pointerId: 1,
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    const channels =
      onChange.mock.calls[0][0].definition.tracks[0]?.channels ?? {};
    // Client deltas are converted through the preview scale (960/1920 = 0.5).
    expect(channels.offset_x).toEqual([
      { at_ms: 0, value: 100, easing: "linear" },
    ]);
    // The existing offset_y frame at the playhead is overwritten; the later
    // authored frame is preserved.
    expect(channels.offset_y).toEqual([
      { at_ms: 0, value: 60, easing: "linear" },
      { at_ms: 300, value: 0, easing: "ease_out" },
    ]);
  });

  it("hides the editor hit boxes when the design surface has no layout", () => {
    renderWorkspace();
    // jsdom reports a zero-sized design surface, so no hit box may be guessed.
    expect(screen.queryByLabelText("对话框整体 预览区域")).toBeNull();
  });

  it("reports a non-fatal font failure and keeps the preview rendering", async () => {
    const rejected = vi.fn().mockRejectedValue(new Error("bad font"));
    class FontFaceStub {
      constructor(
        public family: string,
        public source: string,
      ) {}
      load = rejected;
    }
    const fonts = {
      add: vi.fn(),
      delete: vi.fn(),
      ready: Promise.resolve(),
    };
    vi.stubGlobal("FontFace", FontFaceStub);
    vi.stubGlobal("document", Object.assign(document, { fonts }));

    const { view } = renderWorkspace(
      () => undefined,
      motionFile(),
      FONT_ASSETS,
    );
    expect(fonts.add).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/预览字体加载失败/)).toBeInTheDocument();
    // The preview keeps using the shipping component.
    expect(dialogueRoot(view)).toBeInTheDocument();
  });

  it("previews without the FontFace API (jsdom system fallback)", () => {
    const { view } = renderWorkspace(
      () => undefined,
      motionFile(),
      FONT_ASSETS,
    );
    expect(screen.queryByText(/预览字体加载失败/)).toBeNull();
    expect(dialogueRoot(view)).toBeInTheDocument();
  });

  it("resolves the manifest default font under the shared family", () => {
    const loaded: string[] = [];
    class FontFaceStub {
      constructor(
        public family: string,
        public source: string,
      ) {
        loaded.push(source);
      }
      load = vi.fn().mockResolvedValue(undefined);
    }
    vi.stubGlobal("FontFace", FontFaceStub);
    vi.stubGlobal(
      "document",
      Object.assign(document, {
        fonts: { add: vi.fn(), delete: vi.fn(), ready: Promise.resolve() },
      }),
    );
    const assets: EditorAsset[] = [
      {
        id: "font.fusion_pixel",
        kind: "font",
        path: "fonts/fusion_pixel.ttf",
        absolute_path: "C:/game/fonts/fusion_pixel.ttf",
      },
      {
        id: "font.custom",
        kind: "font",
        path: "fonts/custom.ttf",
        absolute_path: "C:/game/fonts/custom.ttf",
      },
    ];
    renderWorkspace(() => undefined, motionFile(), assets, "font.custom");
    expect(loaded).toEqual(['url("C:/game/fonts/custom.ttf")']);
    // The manifest default font must win over the fallback chain.
    expect(loaded).not.toContain('url("C:/game/fonts/fusion_pixel.ttf")');
  });
});
