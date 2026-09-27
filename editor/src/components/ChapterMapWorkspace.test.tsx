// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { useRef, useState, type ReactElement } from "react";
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
import { ASSET_DRAG_TYPE } from "../assetDrag";

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
      hover_text: "章节 A 的说明",
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

const EMPTY_MAP: ChapterMapDefinition = {
  schema_version: 1,
  width: 1920,
  height: 1080,
  view_x: 960,
  view_y: 540,
  background: null,
  decorations: [],
  hotspots: [],
};

/**
 * Controlled harness that mirrors how the editor application owns the map and
 * the selected object id.  Selection must stay a single derived value: a
 * mirrored pair of states here used to update forever, so a hard render cap
 * turns that regression into a fast, readable failure instead of a hang.
 */
function Harness({
  initialMap,
  sceneIds,
  onChange,
  onSelectionChange,
}: {
  initialMap: ChapterMapDefinition;
  sceneIds: string[];
  onChange?(next: ChapterMapDefinition): void;
  onSelectionChange?(selectionId: string | null): void;
}): ReactElement {
  const [map, setMap] = useState(initialMap);
  const [selectionId, setSelectionId] = useState<string | null>(null);
  const notifications = useRef(0);
  return (
    <ChapterMapWorkspace
      activeEdit={null}
      assets={ASSETS}
      dirty={false}
      manifest={MANIFEST}
      map={map}
      onChange={(next) => {
        onChange?.(next);
        setMap(next);
      }}
      onClose={() => undefined}
      onRedo={() => undefined}
      onSave={() => undefined}
      onUndo={() => undefined}
      onValidate={() => undefined}
      onSelectionChange={(value) => {
        notifications.current += 1;
        // Refuse further mirror updates after a generous bound.  A regression
        // in the selection mirror then fails the recorded-call assertion
        // instead of hanging the whole test run forever.
        if (notifications.current > 12) return;
        onSelectionChange?.(value);
        setSelectionId(value);
      }}
      sceneIds={sceneIds}
      selectionId={selectionId}
      undoAvailable={false}
      redoAvailable={false}
    />
  );
}

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
    expect(object.querySelector(".map-resize-handle")).toBeNull();
    expect(container.querySelector(".map-resize-overlay")).toBeInTheDocument();
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

    // Target the selected object's own artwork chooser.  The first control in
    // the inspector is the hotspot *reveal* selector, so the lookup must be by
    // label; querying positionally silently edited the reveal mode instead.
    const material = within(result.container).getByLabelText("素材");
    fireEvent.click(material);
    fireEvent.click(
      within(result.container).getByRole("option", { name: /gui\.new/ }),
    );

    expect(currentMap.hotspots[0].asset).toBe("gui.new");
    expect(
      result.container.querySelector(".map-editor-object.selected"),
    ).toBeNull();
  });

  it("keeps a newly created hotspot selected without mirroring it back and forth", () => {
    // Regression: creating a hotspot used to ping-pong the selection between
    // "no selection" (map background settings) and the new hotspot forever,
    // because one effect mirrored the local selection to the parent while
    // another mirrored the parent back before the new map had rendered.
    const changes: string[] = [];
    const { container } = render(
      <Harness
        initialMap={EMPTY_MAP}
        sceneIds={["scene-a", "scene-b"]}
        onChange={() => undefined}
        onSelectionChange={(value) => changes.push(String(value))}
      />,
    );

    fireEvent.click(within(container).getByText("＋ scene-a"));

    expect(changes).toEqual(["scene-a"]);
    expect(container.querySelector(".map-editor-object.selected")).toHaveClass(
      "selected",
    );
  });

  it("previews and edits a hotspot hover text", () => {
    const onChange = vi.fn();
    const { container } = renderWorkspace(MAP, onChange);
    const object = container.querySelector(".map-editor-object") as HTMLElement;

    fireEvent.pointerEnter(object);
    expect(container.querySelector(".map-hover-card")).toHaveTextContent(
      "章节 A 的说明",
    );

    fireEvent.click(object);
    const textarea = container.querySelector(
      ".map-inspector textarea",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "新的 hover 说明" } });

    const latest = onChange.mock.lastCall?.[0] as ChapterMapDefinition;
    expect(latest.hotspots[0].hover_text).toBe("新的 hover 说明");
  });
});

describe("ChapterMapWorkspace drag and drop", () => {
  it("accepts an asset dragged from the shared asset library", () => {
    const onChange = vi.fn();
    const { container } = renderWorkspace(EMPTY_MAP, onChange);
    const stage = container.querySelector<HTMLElement>(".map-canvas-stage");
    if (stage === null) throw new Error("missing map stage");
    const data: Record<string, string> = { [ASSET_DRAG_TYPE]: "gui.new" };
    fireEvent.drop(stage, {
      clientX: 100,
      clientY: 100,
      dataTransfer: { getData: (type: string) => data[type] ?? "" },
    });
    const next = onChange.mock.calls.at(-1)?.[0] as
      ChapterMapDefinition | undefined;
    expect(next?.decorations.map((item) => item.asset)).toEqual(["gui.new"]);
  });
});

describe("ChapterMapWorkspace keyboard and zoom", () => {
  beforeEach(cleanup);

  it("nudges the selected object with arrow keys and deletes it with Delete", () => {
    const onChange = vi.fn();
    const { container } = render(
      <Harness initialMap={MAP} onChange={onChange} sceneIds={["scene-a"]} />,
    );
    const object = container.querySelector<HTMLElement>(".map-editor-object");
    if (object === null) throw new Error("missing map object");
    fireEvent.click(object);

    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    const nudged = onChange.mock.calls.at(-1)?.[0] as ChapterMapDefinition;
    expect(nudged.hotspots[0]?.x).toBe(260);

    fireEvent.keyDown(document.body, { key: "ArrowDown", shiftKey: true });
    const shifted = onChange.mock.calls.at(-1)?.[0] as ChapterMapDefinition;
    expect(shifted.hotspots[0]?.y).toBe(460);

    fireEvent.keyDown(document.body, { key: "Delete" });
    const removed = onChange.mock.calls.at(-1)?.[0] as ChapterMapDefinition;
    expect(removed.hotspots).toHaveLength(0);
  });

  it("zooms with the header buttons and resets to fit", () => {
    const { getByRole, getByTitle } = renderWorkspace(MAP);
    const readout = getByTitle("当前缩放");
    const before = readout.textContent;
    fireEvent.click(getByRole("button", { name: "放大" }));
    expect(readout.textContent).not.toBe(before);
    fireEvent.click(getByRole("button", { name: "适合画布" }));
    expect(readout.textContent).toBe(before);
  });
});
