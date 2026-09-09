// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ChapterMapDefinition,
  ContentManifest,
  EditorAsset,
} from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));

import { ChapterMapWorkspace } from "./ChapterMapWorkspace";

const MAP: ChapterMapDefinition = {
  schema_version: 1,
  width: 1920,
  height: 1080,
  view_x: 960,
  view_y: 540,
  background: null,
  decorations: [],
  hotspots: [
    {
      id: "chapter-a",
      scene_id: "scene-a",
      title: "章节 A",
      x: 240,
      y: 360,
      width: 280,
      height: 160,
      z: 10,
      asset: "gui.old",
      reveal: { mode: "completed" },
      variable_overrides: {},
    },
  ],
};

const MANIFEST = {
  schema_version: 2,
  content_version: "test",
  entry_scene: "scene-a",
  default_locale: "zh-CN",
  variables: {},
  characters: {},
  assets: {},
  scenes: [],
  ui_motions: [],
  ui_motion_defaults: {},
} as ContentManifest;

const ASSETS: EditorAsset[] = [
  {
    id: "gui.old",
    kind: "gui",
    path: "gui/old.png",
    absolute_path: "C:/old.png",
  },
  {
    id: "gui.new",
    kind: "gui",
    path: "gui/new.png",
    absolute_path: "C:/new.png",
  },
];

function renderWorkspace(
  map: ChapterMapDefinition = MAP,
  onChange: (next: ChapterMapDefinition) => void = () => undefined,
) {
  return render(
    <ChapterMapWorkspace
      assets={ASSETS}
      dirty={false}
      manifest={MANIFEST}
      map={map}
      onChange={onChange}
      onClose={() => undefined}
      onRedo={() => undefined}
      onSave={() => undefined}
      onUndo={() => undefined}
      onValidate={() => undefined}
      sceneIds={["scene-a"]}
      selectionId={null}
      undoAvailable={false}
      redoAvailable={false}
    />,
  );
}

beforeEach(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      disconnect(): void {
        return undefined;
      }
      observe(): void {
        return undefined;
      }
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChapterMapWorkspace pointer interactions", () => {
  it("selects a node on click without starting a canvas pan", () => {
    const onChange = vi.fn();
    const { container } = renderWorkspace(MAP, onChange);
    const object = container.querySelector(".map-editor-object") as HTMLElement;
    const stage = container.querySelector(".map-canvas-stage") as HTMLElement;

    fireEvent.pointerDown(object, {
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 1,
    });
    fireEvent.pointerMove(object, {
      clientX: 180,
      clientY: 100,
      pointerId: 1,
    });
    fireEvent.pointerUp(object, { pointerId: 1 });
    fireEvent.click(object);

    expect(object).toHaveClass("selected");
    expect(stage.style.transform).toBe("translate(0px, 0px)");
    expect(onChange).toHaveBeenCalled();
  });

  it("clears the selection outline when the selected artwork is replaced", () => {
    let currentMap = MAP;
    const renderState: {
      rerender?: ReturnType<typeof renderWorkspace>["rerender"];
    } = {};
    const onChange = (next: ChapterMapDefinition): void => {
      currentMap = next;
      renderState.rerender?.(
        <ChapterMapWorkspace
          assets={ASSETS}
          dirty
          manifest={MANIFEST}
          map={currentMap}
          onChange={onChange}
          onClose={() => undefined}
          onRedo={() => undefined}
          onSave={() => undefined}
          onUndo={() => undefined}
          onValidate={() => undefined}
          sceneIds={["scene-a"]}
          selectionId={null}
          undoAvailable={false}
          redoAvailable={false}
        />,
      );
    };
    const result = renderWorkspace(currentMap, onChange);
    renderState.rerender = result.rerender;
    const object = result.container.querySelector(
      ".map-editor-object",
    ) as HTMLElement;
    fireEvent.click(object);
    expect(object).toHaveClass("selected");

    const material = result.container.querySelector(
      ".map-inspector select",
    ) as HTMLSelectElement;
    fireEvent.change(material, { target: { value: "gui.new" } });

    expect(
      result.container.querySelector(".map-editor-object.selected"),
    ).toBeNull();
  });
});
