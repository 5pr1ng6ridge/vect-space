// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { editorApi } from "./api";
import { installDomStubs, renderOpenedApp } from "./test/appHarness";
import type {
  BuildNodePreviewResult,
  EditorAsset,
  EditorProject,
  SceneNode,
} from "./types";
import type { SceneWorldSnapshot } from "@vectspace/presentation-core/scene-surface";

/** Asset urls are shared with the hoisted surface mock. */
const URLS = vi.hoisted(() => ({
  sprite: "C:/sprites/lumi.png",
  bgA: "C:/bg/a.png",
  bgB: "C:/bg/b.png",
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(() => Promise.reject(new Error("host unavailable in tests"))),
}));

/**
 * The inspector preview always drives the real shared `SceneSurface`; only its
 * renderer is swapped for the in-memory kit, exactly like the component tests,
 * so this file exercises the real gesture, real CuePreview and real history.
 */
vi.mock(
  "@vectspace/presentation-core/scene-surface",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@vectspace/presentation-core/scene-surface")
      >();
    const { createMemoryKit, createMemoryTextureLoader } =
      await import("@vectspace/presentation-core/scene-test-kit");
    const kit = createMemoryKit();
    const loader = createMemoryTextureLoader({
      [URLS.sprite]: { width: 512, height: 1024 },
      [URLS.bgA]: { width: 1920, height: 1080 },
      [URLS.bgB]: { width: 1920, height: 1080 },
    });
    class StageTestSceneSurface extends actual.SceneSurface {
      constructor(
        options: ConstructorParameters<typeof actual.SceneSurface>[0],
      ) {
        super({ ...options, kit: kit.kit, textureLoader: loader.load });
      }
    }
    return { ...actual, SceneSurface: StageTestSceneSurface };
  },
);

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    editorApi: {
      ...actual.editorApi,
      pickProjectDirectory: vi.fn(),
      openProject: vi.fn(),
      saveProject: vi.fn(),
      validateProject: vi.fn(),
      buildNodePreview: vi.fn(),
    },
  };
});

const api = vi.mocked(editorApi);

const ASSETS: EditorAsset[] = [
  {
    id: "bg.a",
    kind: "background",
    path: "backgrounds/a.png",
    absolute_path: URLS.bgA,
  },
  {
    id: "bg.b",
    kind: "background",
    path: "backgrounds/b.png",
    absolute_path: URLS.bgB,
  },
  {
    id: "sprite.lumi",
    kind: "sprite",
    path: "sprites/lumi.png",
    absolute_path: URLS.sprite,
  },
];

const SPRITE_NODE: SceneNode = {
  type: "sprite",
  sprite_id: "lumi",
  action: "show",
  asset: "sprite.lumi",
  x: 960,
  y: 1080,
  scale: null,
  opacity: null,
  z: null,
  easing: "ease_in_out",
  duration_ms: 0,
  await: false,
  next: "finish",
};

/** One entry scene: a background, the edited sprite, then the end. */
function stageProject(): EditorProject {
  return {
    root: "C:/work/game",
    manifest: {
      schema_version: 2,
      content_version: "test",
      entry_scene: "main",
      default_locale: "zh-CN",
      variables: {},
      characters: {},
      assets: {
        "bg.a": { kind: "background", path: "backgrounds/a.png" },
        "bg.b": { kind: "background", path: "backgrounds/b.png" },
        "sprite.lumi": { kind: "sprite", path: "sprites/lumi.png" },
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
          entry: "start",
          nodes: {
            start: {
              type: "background",
              background: "bg.a",
              transition: { type: "cut" },
              duration_ms: 0,
              easing: "linear",
              await: false,
              next: "hero",
            },
            hero: SPRITE_NODE,
            finish: { type: "end" },
          },
        },
      },
    ],
    ui_motions: [],
    layout: {
      version: 1,
      scenes: {
        main: {
          nodes: {
            start: { x: 0, y: 0 },
            hero: { x: 320, y: 0 },
            finish: { x: 640, y: 0 },
          },
          viewport: null,
        },
      },
    },
    assets: ASSETS,
    diagnostics: [],
    fingerprint: "stage-fixture",
  };
}

function spriteWorld(x: number, y: number): SceneWorldSnapshot {
  return {
    background: "bg.a",
    sprites: {
      lumi: {
        asset: "sprite.lumi",
        x,
        y,
        scale: 1,
        scale_x: 1,
        scale_y: 1,
        rotation_deg: 0,
        flip_x: false,
        anchor_x: 0.5,
        anchor_y: 1,
        opacity: 1,
        z: 0,
      },
    },
    camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
    curtain: { covered: false, fill: null },
  };
}

function readyPreview(world: SceneWorldSnapshot): BuildNodePreviewResult {
  return {
    status: "ready",
    start_snapshot: { world },
    update: { snapshot: { world } },
    trace: [],
  } as unknown as BuildNodePreviewResult;
}

beforeEach(() => {
  installDomStubs();
  localStorage.clear();
  api.pickProjectDirectory.mockResolvedValue("C:/work/game");
  api.openProject.mockImplementation(() =>
    Promise.resolve(structuredClone(stageProject())),
  );
  api.validateProject.mockResolvedValue(undefined as never);
  api.saveProject.mockImplementation(() =>
    Promise.resolve({
      project: structuredClone(stageProject()),
      changed_paths: ["scenes/main.yaml"],
      deleted_paths: [],
      warnings: [],
    } as never),
  );
  api.buildNodePreview.mockImplementation(() =>
    Promise.resolve(readyPreview(spriteWorld(960, 1080))),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Opens the project and selects the node whose graph card shows `summary`. */
async function selectNode(summary: string): Promise<void> {
  await renderOpenedApp(<App />);
  fireEvent.click(
    await screen.findByText(summary, { selector: ".story-node-summary" }),
  );
  await waitFor(() =>
    expect(document.querySelector("aside.inspector")).not.toBeNull(),
  );
}

function inspectorField(label: string): HTMLInputElement {
  const field = screen.getByLabelText(label);
  if (!(field instanceof HTMLInputElement))
    throw new Error(`字段 ${label} 不是输入框`);
  return field;
}

function undoButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "撤销" });
}

function redoButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "重做" });
}

/** The measured 16:9 stage: one client pixel is one design pixel. */
async function spriteStage(): Promise<HTMLCanvasElement> {
  const canvas = await screen.findByLabelText<HTMLCanvasElement>("立绘预览");
  canvas.getBoundingClientRect = () => ({
    width: 1920,
    height: 1080,
    left: 0,
    top: 0,
    right: 1920,
    bottom: 1080,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  await waitFor(() =>
    expect(canvas.parentElement?.className ?? "").toContain("is-draggable"),
  );
  return canvas;
}

describe("App direct stage editing", () => {
  it("commits one history entry per sprite drag and undoes/redoes it", async () => {
    await selectNode("登场 lumi · sprite.lumi");
    const canvas = await spriteStage();
    expect(inspectorField("X").value).toBe("960");
    expect(undoButton()).toBeDisabled();

    fireEvent.pointerDown(canvas, { button: 0, clientX: 960, clientY: 1000 });
    fireEvent.pointerMove(canvas, { clientX: 1160, clientY: 900 });
    // Mid-drag nothing is authored: the document and history are untouched.
    expect(inspectorField("X").value).toBe("960");
    expect(undoButton()).toBeDisabled();
    fireEvent.pointerUp(canvas, { clientX: 1160, clientY: 900 });

    await waitFor(() => expect(inspectorField("X").value).toBe("1160"));
    expect(inspectorField("Y").value).toBe("980");

    // Exactly one entry: a single undo restores both channels together.
    fireEvent.click(undoButton());
    await waitFor(() => expect(inspectorField("X").value).toBe("960"));
    expect(inspectorField("Y").value).toBe("1080");
    expect(undoButton()).toBeDisabled();
    expect(redoButton()).toBeEnabled();

    fireEvent.click(redoButton());
    await waitFor(() => expect(inspectorField("X").value).toBe("1160"));
    expect(inspectorField("Y").value).toBe("980");
  });

  it("writes nothing when the sprite is only clicked", async () => {
    await selectNode("登场 lumi · sprite.lumi");
    const canvas = await spriteStage();

    fireEvent.pointerDown(canvas, { button: 0, clientX: 960, clientY: 1000 });
    fireEvent.pointerUp(canvas, { button: 0, clientX: 960, clientY: 1000 });

    expect(inspectorField("X").value).toBe("960");
    expect(undoButton()).toBeDisabled();
  });

  it("cancels a drag on Escape and on pointer cancel without dirtying", async () => {
    await selectNode("登场 lumi · sprite.lumi");
    const canvas = await spriteStage();

    fireEvent.pointerDown(canvas, { button: 0, clientX: 960, clientY: 1000 });
    fireEvent.pointerMove(canvas, { clientX: 1160, clientY: 900 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(canvas, { clientX: 1160, clientY: 900 });

    fireEvent.pointerDown(canvas, { button: 0, clientX: 960, clientY: 1000 });
    fireEvent.pointerMove(canvas, { clientX: 1160, clientY: 900 });
    fireEvent.pointerCancel(canvas, { clientX: 1160, clientY: 900 });
    fireEvent.pointerUp(canvas, { clientX: 1160, clientY: 900 });

    expect(inspectorField("X").value).toBe("960");
    expect(inspectorField("Y").value).toBe("1080");
    expect(undoButton()).toBeDisabled();
  });

  it("swaps the background with one drop and undoes it", async () => {
    await selectNode("bg.a · 直接切换");
    await screen.findByLabelText("背景转场预览");
    const target = document.querySelector<HTMLElement>(".stage-drop-target");
    if (target === null) throw new Error("缺少画布拖放层");
    const chooser = screen.getByLabelText("背景素材");
    expect(chooser.textContent).toContain("bg.a");

    fireEvent.drop(target, {
      dataTransfer: {
        getData: (type: string) =>
          type === "application/x-vect-asset" ? "bg.b" : "",
        types: ["application/x-vect-asset"],
        dropEffect: "none",
      },
    });

    await waitFor(() => expect(chooser.textContent).toContain("bg.b"));
    expect(undoButton()).toBeEnabled();

    fireEvent.click(undoButton());
    await waitFor(() => expect(chooser.textContent).toContain("bg.a"));
    expect(undoButton()).toBeDisabled();
  });

  it("ignores an OS file drop on the background stage", async () => {
    await selectNode("bg.a · 直接切换");
    await screen.findByLabelText("背景转场预览");
    const target = document.querySelector<HTMLElement>(".stage-drop-target");
    if (target === null) throw new Error("缺少画布拖放层");

    fireEvent.drop(target, {
      dataTransfer: {
        getData: () => "",
        types: ["Files"],
        dropEffect: "none",
      },
    });

    expect(screen.getByLabelText("背景素材").textContent).toContain("bg.a");
    expect(undoButton()).toBeDisabled();
  });
});
