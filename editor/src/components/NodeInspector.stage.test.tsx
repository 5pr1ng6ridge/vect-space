// @vitest-environment jsdom

import type { ReactElement } from "react";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  createMemoryKit,
  createMemoryTextureLoader,
  type MemoryKit,
} from "@vectspace/presentation-core/scene-test-kit";
import {
  SceneSurface,
  type SceneWorldSnapshot,
} from "@vectspace/presentation-core/scene-surface";
import { worldPointToStage } from "@vectspace/presentation-core/scene-frame";
import type {
  EmitterSnapshot,
  ParticleDefinition,
} from "@vectspace/presentation-core/particles";
import type { PresentationCue } from "@vectspace/presentation-core/types";

import { PARTICLE_FIXTURE } from "../../../packages/presentation-core/src/visualTestKit";

import type {
  BuildNodePreviewResult,
  ContentManifest,
  EditorAsset,
  EditorLayout,
  EditorProject,
  SceneDefinition,
  SceneNode,
} from "../types";
import { AssetLayoutProvider } from "./AssetChooser";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    editorApi: { ...actual.editorApi, buildNodePreview: vi.fn() },
  };
});

import { editorApi } from "../api";
import { NodeInspector } from "./NodeInspector";

const api = vi.mocked(editorApi);

beforeEach(() => {
  // Each case owns its runtime answers; a leftover `Once` implementation must
  // never leak into the next one.
  api.buildNodePreview.mockReset();
});

afterEach(cleanup);

const SPRITE_URL = "C:/sprites/lumi.png";
const BACKGROUND_A_URL = "C:/bg/a.png";
const BACKGROUND_B_URL = "C:/bg/b.png";
const DOT_URL = "C:/game/dot.png";

const ASSETS: EditorAsset[] = [
  {
    id: "bg.a",
    kind: "background",
    path: "backgrounds/a.png",
    absolute_path: BACKGROUND_A_URL,
  },
  {
    id: "bg.b",
    kind: "background",
    path: "backgrounds/b.png",
    absolute_path: BACKGROUND_B_URL,
  },
  {
    id: "sprite.lumi",
    kind: "sprite",
    path: "sprites/lumi.png",
    absolute_path: SPRITE_URL,
  },
  {
    id: "dot",
    kind: "gui",
    path: "dot.png",
    absolute_path: DOT_URL,
  },
];

const MANIFEST: ContentManifest = {
  schema_version: 2,
  content_version: "test",
  entry_scene: "main",
  default_locale: "zh-CN",
  variables: {},
  characters: {
    lumi: {
      display_name: "露米",
      default_expression: "smile",
      expressions: {
        smile: {
          asset: "sprite.lumi",
          offset_x: 40,
          offset_y: -20,
        },
      },
    },
  },
  assets: {
    "bg.a": { kind: "background", path: "backgrounds/a.png" },
    "bg.b": { kind: "background", path: "backgrounds/b.png" },
    "sprite.lumi": { kind: "sprite", path: "sprites/lumi.png" },
  },
  scenes: ["scenes/main.yaml"],
  ui_motions: [],
  ui_motion_defaults: {},
};

type SpriteNode = Extract<SceneNode, { type: "sprite" }>;
type BackgroundNode = Extract<SceneNode, { type: "background" }>;

function spriteNode(overrides: Partial<SpriteNode> = {}): SpriteNode {
  return {
    type: "sprite",
    sprite_id: "lumi",
    action: "show",
    character: "lumi",
    expression: "smile",
    asset: null,
    x: 960,
    y: 1080,
    scale: null,
    opacity: null,
    z: null,
    easing: "ease_in_out",
    duration_ms: 0,
    await: false,
    next: "end",
    ...overrides,
  };
}

function backgroundNode(
  overrides: Partial<BackgroundNode> = {},
): BackgroundNode {
  return {
    type: "background",
    background: "bg.a",
    transition: { type: "cut" },
    duration_ms: 0,
    easing: "linear",
    await: false,
    next: "end",
    ...overrides,
  };
}

function sceneWith(node: SceneNode): SceneDefinition {
  return {
    schema_version: 2,
    id: "main",
    entry: "start",
    nodes: {
      start: backgroundNode({ background: "bg.a", next: "target" }),
      target: node,
    },
  };
}

function projectWith(node: SceneNode): EditorProject {
  return {
    root: "C:/work/game",
    manifest: MANIFEST,
    scenes: [{ path: "scenes/main.yaml", definition: sceneWith(node) }],
    ui_motions: [],
    layout: {
      version: 1,
      scenes: {
        main: {
          nodes: { start: { x: 0, y: 0 }, target: { x: 320, y: 0 } },
          viewport: null,
        },
      },
    },
    assets: ASSETS,
    diagnostics: [],
    fingerprint: "test",
  };
}

/** The world `build_node_preview` would return for the sprite node. */
function spriteWorld(
  x: number,
  y: number,
  camera: SceneWorldSnapshot["camera"] = {
    x: 0,
    y: 0,
    zoom: 1,
    rotation_deg: 0,
  },
): SceneWorldSnapshot {
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
    camera,
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

/** The inspector change spy: one call is one authored change. */
type ChangeSpy = Mock<(nodeId: string, node: SceneNode) => void>;

function renderInspector(
  node: SceneNode,
  options: { onChange?: ChangeSpy; layout?: EditorLayout } = {},
): {
  onChange: ChangeSpy;
  kit: MemoryKit;
  view: ReturnType<typeof render>;
  rerender(node: SceneNode): void;
} {
  const onChange =
    options.onChange ?? vi.fn<(nodeId: string, node: SceneNode) => void>();
  const kit = createMemoryKit();
  const loader = createMemoryTextureLoader({
    [SPRITE_URL]: { width: 512, height: 1024 },
    [BACKGROUND_A_URL]: { width: 1920, height: 1080 },
    [BACKGROUND_B_URL]: { width: 1920, height: 1080 },
    [DOT_URL]: { width: 64, height: 64 },
  });
  const element = (current: SceneNode): ReactElement => (
    <AssetLayoutProvider layout={options.layout ?? null}>
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
        previewAnimationMap={{}}
        previewChoices={[]}
        previewEnvironment={{ kit: kit.kit, textureLoader: loader.load }}
        previewImportTokens={[]}
        previewProject={projectWith(current)}
        previewVariableOverrides={{}}
        scene={sceneWith(current)}
        uiMotions={[]}
      />
    </AssetLayoutProvider>
  );
  const view = render(element(node));
  return {
    onChange,
    kit,
    view,
    rerender: (next) => view.rerender(element(next)),
  };
}

/** Stubs the canvas box so a client point is exactly a design pixel. */
function stubStageRect(canvas: HTMLCanvasElement): void {
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
}

/** The ready sprite stage canvas, measured and armed for a gesture. */
async function grabbableCanvas(): Promise<HTMLCanvasElement> {
  const canvas = await screen.findByLabelText<HTMLCanvasElement>("立绘预览");
  stubStageRect(canvas);
  await waitFor(() => expect(stageClass(canvas)).toContain("is-draggable"));
  return canvas;
}

function stageClass(canvas: HTMLCanvasElement): string {
  return canvas.parentElement?.className ?? "";
}

/** Minimal `DataTransfer` stand-in: only the members the drop reads. */
function transfer(
  entries: Record<string, string>,
  types: readonly string[] = Object.keys(entries),
): {
  getData(type: string): string;
  types: readonly string[];
  dropEffect: string;
} {
  return {
    getData: (type) => entries[type] ?? "",
    types,
    dropEffect: "none",
  };
}

describe("NodeInspector sprite stage editing", () => {
  it("drags the visible sprite and writes the authored x/y once, on release", async () => {
    api.buildNodePreview.mockResolvedValue(
      readyPreview(spriteWorld(1000, 1060)),
    );
    const { onChange } = renderInspector(spriteNode());
    const canvas = await grabbableCanvas();

    // The runtime resolved the authored 960/1080 plus the smile offset 40/-20.
    const overrides = vi.spyOn(SceneSurface.prototype, "setObjectOverride");
    const rebuilds = vi.spyOn(SceneSurface.prototype, "reset");
    try {
      fireEvent.pointerDown(canvas, {
        button: 0,
        clientX: 1000,
        clientY: 1000,
      });
      fireEvent.pointerMove(canvas, { clientX: 1100, clientY: 950 });
      // Mid-drag the document is untouched: only the surface override moved.
      expect(onChange).not.toHaveBeenCalled();
      fireEvent.pointerMove(canvas, { clientX: 1200, clientY: 900 });
      expect(onChange).not.toHaveBeenCalled();
      // Frames move pixels, never the document: one override per pointer move
      // and not a single preview rebuild.
      expect(overrides).toHaveBeenCalledTimes(2);
      expect(rebuilds).not.toHaveBeenCalled();
      fireEvent.pointerUp(canvas, { clientX: 1200, clientY: 900 });
    } finally {
      overrides.mockRestore();
      rebuilds.mockRestore();
    }

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("target", {
      ...spriteNode(),
      x: 1160,
      y: 980,
    });
  });

  it("keeps a move node's action and its other channels", async () => {
    api.buildNodePreview.mockResolvedValue(
      readyPreview(spriteWorld(1000, 1060)),
    );
    const node = spriteNode({
      action: "move",
      flip_x: true,
      opacity: 0.5,
      z: 3,
    });
    const { onChange } = renderInspector(node);
    const canvas = await grabbableCanvas();

    fireEvent.pointerDown(canvas, { button: 0, clientX: 1000, clientY: 1000 });
    fireEvent.pointerMove(canvas, { clientX: 900, clientY: 1100 });
    fireEvent.pointerUp(canvas, { clientX: 900, clientY: 1100 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("target", {
      ...node,
      x: 860,
      y: 1180,
    });
  });

  it("drags the authored x/y through a zoomed and rotated camera", async () => {
    // A 1.6x camera turned 30 degrees: design pixels are not world pixels and
    // the drag axis is rotated, so only the shared inverse camera can map the
    // pointer onto the authored coordinate.
    const camera = { x: 120, y: -60, zoom: 1.6, rotation_deg: 30 };
    api.buildNodePreview.mockResolvedValue(
      readyPreview(spriteWorld(1000, 1060, camera)),
    );
    const { onChange } = renderInspector(spriteNode());
    const canvas = await grabbableCanvas();

    // The 512x1024 artwork is anchored centre/bottom at (1000, 1060), so its
    // centre (1000, 548) is what a grab must land on; the camera decides where
    // that centre is on the stage.
    const center = worldPointToStage({ x: 1000, y: 548 }, camera);
    fireEvent.pointerDown(canvas, {
      button: 0,
      clientX: center.x,
      clientY: center.y,
    });
    // 100 design pixels right is 100 / 1.6 = 62.5 world pixels along the
    // camera's x axis, which a 30 degree rotation turns into
    // (62.5*cos30, -62.5*sin30) = (+54.13, -31.25) of world displacement.
    fireEvent.pointerMove(canvas, {
      clientX: center.x + 100,
      clientY: center.y,
    });
    fireEvent.pointerUp(canvas, {
      clientX: center.x + 100,
      clientY: center.y,
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    // The world position minus the resolved expression offset (40, -20).
    expect(onChange).toHaveBeenCalledWith("target", {
      ...spriteNode(),
      x: 1014,
      y: 1049,
    });
  });

  it("starts no gesture when the pointer misses the edited sprite", async () => {
    api.buildNodePreview.mockResolvedValue(
      readyPreview(spriteWorld(1000, 1060)),
    );
    const { onChange } = renderInspector(spriteNode());
    const canvas = await grabbableCanvas();

    // Far outside the 512x1024 box anchored at (1000, 1060).
    fireEvent.pointerDown(canvas, { button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(canvas, { clientX: 400, clientY: 200 });
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 200 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("treats a click without movement as a click, not an edit", async () => {
    api.buildNodePreview.mockResolvedValue(
      readyPreview(spriteWorld(1000, 1060)),
    );
    const { onChange } = renderInspector(spriteNode());
    const canvas = await grabbableCanvas();

    fireEvent.pointerDown(canvas, { button: 0, clientX: 1000, clientY: 1000 });
    fireEvent.pointerUp(canvas, { clientX: 1000, clientY: 1000 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("cancels the gesture on Escape, a pointer cancel and a blur", async () => {
    api.buildNodePreview.mockResolvedValue(
      readyPreview(spriteWorld(1000, 1060)),
    );
    const { onChange } = renderInspector(spriteNode());
    const canvas = await grabbableCanvas();

    fireEvent.pointerDown(canvas, { button: 0, clientX: 1000, clientY: 1000 });
    fireEvent.pointerMove(canvas, { clientX: 1200, clientY: 900 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(canvas, { clientX: 1200, clientY: 900 });

    fireEvent.pointerDown(canvas, { button: 0, clientX: 1000, clientY: 1000 });
    fireEvent.pointerMove(canvas, { clientX: 1200, clientY: 900 });
    fireEvent.pointerCancel(canvas, { clientX: 1200, clientY: 900 });
    fireEvent.pointerUp(canvas, { clientX: 1200, clientY: 900 });

    fireEvent.pointerDown(canvas, { button: 0, clientX: 1000, clientY: 1000 });
    fireEvent.pointerMove(canvas, { clientX: 1200, clientY: 900 });
    fireEvent(window, new Event("blur"));
    fireEvent.pointerUp(canvas, { clientX: 1200, clientY: 900 });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("never offers a drag for a hide node", async () => {
    api.buildNodePreview.mockResolvedValue(
      readyPreview({
        background: "bg.a",
        sprites: {},
        camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
        curtain: { covered: false, fill: null },
      }),
    );
    const { onChange } = renderInspector(spriteNode({ action: "hide" }));
    const canvas = await screen.findByLabelText<HTMLCanvasElement>("立绘预览");
    await waitFor(() =>
      expect(screen.getByText(/隐藏节点没有可拖动的目标/)).toBeInTheDocument(),
    );
    expect(stageClass(canvas)).not.toContain("is-draggable");

    // A stray gesture on the canvas can never write the node.
    fireEvent.pointerDown(canvas, { button: 0, clientX: 960, clientY: 540 });
    fireEvent.pointerMove(canvas, { clientX: 1200, clientY: 900 });
    fireEvent.pointerUp(canvas, { clientX: 1200, clientY: 900 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the resolving note while the runtime preview is still loading", async () => {
    // A host round trip that has not answered yet must show its own state
    // instead of an empty or half-built stage.
    api.buildNodePreview.mockReturnValue(
      new Promise<BuildNodePreviewResult>(() => undefined),
    );
    renderInspector(spriteNode());
    expect(
      await screen.findByText("正在通过运行时解析预览…"),
    ).toBeInTheDocument();
    // Nothing is draggable before a world exists.
    expect(screen.queryByLabelText("立绘预览")).toBeNull();
  });

  it("shows the runtime path requirement instead of guessing a world", async () => {
    api.buildNodePreview.mockResolvedValue({
      status: "needs_choice",
      location: { scene_id: "main", node_id: "branch" },
      visit: 1,
      choices: [],
      trace: [],
    } as unknown as BuildNodePreviewResult);
    renderInspector(spriteNode());
    expect(
      await screen.findByText("预览需要先补充路径选择：main/branch"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("立绘预览")).toBeNull();
  });

  it("reports an unreachable node and a failed request", async () => {
    api.buildNodePreview.mockResolvedValueOnce({
      status: "unreachable",
      message: "节点不可达",
      trace: [],
    } as unknown as BuildNodePreviewResult);
    const first = renderInspector(spriteNode());
    expect(
      await screen.findByText("无法从场景入口到达该节点：节点不可达"),
    ).toBeInTheDocument();
    first.view.unmount();

    api.buildNodePreview.mockRejectedValueOnce(new Error("运行时未启动"));
    renderInspector(spriteNode());
    expect(
      await screen.findByText("预览失败：运行时未启动"),
    ).toBeInTheDocument();
    // A failed request stays retryable without touching the document.
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("ignores a superseded preview that resolves after the current one", async () => {
    let resolveFirst: (value: BuildNodePreviewResult) => void = () => undefined;
    let resolveSecond: (value: BuildNodePreviewResult) => void = () =>
      undefined;
    api.buildNodePreview
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveFirst = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveSecond = resolve)),
      );

    const { onChange, rerender } = renderInspector(spriteNode());
    await waitFor(() => expect(api.buildNodePreview).toHaveBeenCalledTimes(1));

    // A second authored revision starts its own request while the first is
    // still in flight; the stale result may never replace the newer world.
    const node = spriteNode({ x: 700 });
    rerender(node);
    await waitFor(() => expect(api.buildNodePreview).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveSecond(readyPreview(spriteWorld(740, 1060)));
      await Promise.resolve();
    });
    const canvas = await grabbableCanvas();
    await act(async () => {
      resolveFirst(readyPreview(spriteWorld(1000, 1060)));
      await Promise.resolve();
    });

    fireEvent.pointerDown(canvas, { button: 0, clientX: 740, clientY: 1000 });
    fireEvent.pointerMove(canvas, { clientX: 940, clientY: 1000 });
    fireEvent.pointerUp(canvas, { clientX: 940, clientY: 1000 });

    // 740 + 200 world pixels, minus the 40px expression offset.
    expect(onChange).toHaveBeenCalledWith("target", {
      ...node,
      x: 900,
      y: 1080,
    });
  });
});

describe("NodeInspector background stage drops", () => {
  it("assigns a dropped library asset with one change", async () => {
    const { onChange } = renderInspector(
      backgroundNode({ background: "bg.a" }),
    );
    await screen.findByLabelText("背景转场预览");
    const target = document.querySelector(".stage-drop-target");
    if (target === null) throw new Error("缺少画布拖放层");

    fireEvent.drop(target, {
      dataTransfer: transfer({ "application/x-vect-asset": "bg.b" }),
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("target", {
      ...backgroundNode({ background: "bg.a" }),
      background: "bg.b",
    });
  });

  it("creates no change for the background it already shows", async () => {
    const { onChange } = renderInspector(
      backgroundNode({ background: "bg.a" }),
    );
    await screen.findByLabelText("背景转场预览");
    const target = document.querySelector(".stage-drop-target");
    if (target === null) throw new Error("缺少画布拖放层");

    fireEvent.drop(target, {
      dataTransfer: transfer({ "application/x-vect-asset": "bg.a" }),
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("refuses OS files, multi-selections, other kinds and hidden assets", async () => {
    const layout: EditorLayout = {
      version: 1,
      scenes: {},
      asset_metadata: { "bg.b": { hidden: true } },
    };
    const { onChange } = renderInspector(
      backgroundNode({ background: "bg.a" }),
      {
        layout,
      },
    );
    await screen.findByLabelText("背景转场预览");
    const target = document.querySelector(".stage-drop-target");
    if (target === null) throw new Error("缺少画布拖放层");

    const drops = [
      transfer({ Files: "C:/photos/photo.png" }, ["Files"]),
      transfer(
        {
          "application/x-vect-asset": "bg.b",
          "application/x-vect-assets": '["bg.b","bg.a"]',
        },
        ["application/x-vect-asset", "application/x-vect-assets"],
      ),
      transfer({ "application/x-vect-asset": "sprite.lumi" }),
      transfer({ "application/x-vect-asset": "ghost" }),
      transfer({ "application/x-vect-asset": "bg.b" }),
    ];
    for (const dataTransfer of drops) {
      fireEvent.drop(target, { dataTransfer });
    }

    expect(onChange).not.toHaveBeenCalled();
  });

  it("consumes an OS file drag over the canvas instead of letting the WebView navigate", async () => {
    const { onChange } = renderInspector(
      backgroundNode({ background: "bg.a" }),
    );
    await screen.findByLabelText("背景转场预览");
    const target = document.querySelector(".stage-drop-target");
    if (target === null) throw new Error("缺少画布拖放层");

    const files = () => transfer({ Files: "C:/photos/photo.png" }, ["Files"]);
    // An uncancelled drag over the canvas leaves the WebView free to open the
    // dropped file, which would discard unsaved authoring.
    const over = createEvent.dragOver(target, { dataTransfer: files() });
    fireEvent(target, over);
    expect(over.defaultPrevented).toBe(true);
    // Refused, so the stage never claims to accept the drop.
    expect(target.className).not.toContain("is-active");

    const drop = createEvent.drop(target, { dataTransfer: files() });
    fireEvent(target, drop);
    expect(drop.defaultPrevented).toBe(true);
    // Consumed without touching the node: the file is not an import here.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("consumes a refused internal drop without offering the drop affordance", async () => {
    const { onChange } = renderInspector(
      backgroundNode({ background: "bg.a" }),
    );
    await screen.findByLabelText("背景转场预览");
    const target = document.querySelector(".stage-drop-target");
    if (target === null) throw new Error("缺少画布拖放层");

    const multi = () =>
      transfer(
        {
          "application/x-vect-asset": "bg.b",
          "application/x-vect-assets": '["bg.b","bg.a"]',
        },
        ["application/x-vect-asset", "application/x-vect-assets"],
      );
    const over = createEvent.dragOver(target, { dataTransfer: multi() });
    fireEvent(target, over);
    expect(over.defaultPrevented).toBe(true);
    expect(target.className).not.toContain("is-active");

    const drop = createEvent.drop(target, { dataTransfer: multi() });
    fireEvent(target, drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps accepting a valid library drag after a refused one", async () => {
    const { onChange } = renderInspector(
      backgroundNode({ background: "bg.a" }),
    );
    await screen.findByLabelText("背景转场预览");
    const target = document.querySelector(".stage-drop-target");
    if (target === null) throw new Error("缺少画布拖放层");

    const refused = createEvent.dragOver(target, {
      dataTransfer: transfer({ Files: "C:/photos/photo.png" }, ["Files"]),
    });
    fireEvent(target, refused);
    expect(refused.defaultPrevented).toBe(true);

    const accepted = createEvent.dragOver(target, {
      dataTransfer: transfer({ "application/x-vect-asset": "bg.b" }),
    });
    fireEvent(target, accepted);
    expect(accepted.defaultPrevented).toBe(true);
    expect(target.className).toContain("is-active");

    fireEvent.drop(target, {
      dataTransfer: transfer({ "application/x-vect-asset": "bg.b" }),
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("target", {
      ...backgroundNode({ background: "bg.a" }),
      background: "bg.b",
    });
  });
});

type ParticleNode = Extract<SceneNode, { type: "particle" }>;

function particleNode(overrides: Partial<ParticleNode> = {}): ParticleNode {
  return {
    type: "particle",
    emitter_id: "fx",
    action: "start",
    particle: "snow",
    seed: null,
    space: "world",
    x: 900,
    y: 500,
    scale: 1,
    rotation_deg: 0,
    opacity: 1,
    z: 0,
    next: "end",
    ...overrides,
  };
}

/** A burst-only definition that finishes within a few frames. */
const BURST_PARTICLE: ParticleDefinition = {
  ...PARTICLE_FIXTURE,
  image: "dot",
  rate: 0,
  burst_count: 5,
  max_particles: 20,
  lifetime_ms: { min: 40, max: 60 },
};

const CONTINUOUS_PARTICLE: ParticleDefinition = {
  ...PARTICLE_FIXTURE,
  image: "dot",
};

const IDENTITY_CAMERA = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
const ZOOMED_CAMERA = { x: 120, y: -60, zoom: 1.6, rotation_deg: 30 };

function emitterAt(
  node: ParticleNode,
  overrides: Partial<EmitterSnapshot> = {},
): EmitterSnapshot {
  return {
    particle: "snow",
    seed: 17,
    generation: 1,
    space: node.space,
    x: node.x,
    y: node.y,
    scale: 1,
    rotation_deg: 0,
    opacity: 1,
    z: 0,
    ...overrides,
  };
}

function burstCueFor(
  node: ParticleNode,
  emitterId = node.emitter_id,
  overrides: Partial<EmitterSnapshot> = {},
): PresentationCue {
  return {
    cue_id: `cue.${emitterId}`,
    gate: "none",
    type: "particle_state",
    emitter_id: emitterId,
    emitter: emitterAt(node, overrides),
    burst: true,
  };
}

/** The runtime answer for a particle node: world, its cues and definitions. */
function particlePreview(
  node: ParticleNode,
  options: {
    camera?: SceneWorldSnapshot["camera"];
    persistent?: boolean;
    cues?: PresentationCue[];
    particle?: ParticleDefinition;
  } = {},
): BuildNodePreviewResult {
  const world: SceneWorldSnapshot = {
    background: "bg.a",
    sprites: {},
    emitters:
      options.persistent === true
        ? { [node.emitter_id]: emitterAt(node) }
        : {},
    camera: options.camera ?? IDENTITY_CAMERA,
    curtain: { covered: false, fill: null },
  };
  return {
    status: "ready",
    start_snapshot: { world },
    update: { snapshot: { world }, cues: options.cues ?? [] },
    trace: [],
    particles: { snow: options.particle ?? CONTINUOUS_PARTICLE },
  } as unknown as BuildNodePreviewResult;
}

/** Measures the overlay layer so a client point is exactly a design pixel. */
function measureParticleLayer(): void {
  const layer = screen.getByRole("group", { name: "粒子生成点" });
  layer.getBoundingClientRect = () => ({
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
}

function liveBatches(kit: MemoryKit) {
  return kit.particleBatches.filter((batch) => !batch.node.destroyed);
}

function burstReadout(): { ms: number; finished: boolean } {
  const text =
    document.querySelector(".cue-preview-burst-transport code")?.textContent ??
    "";
  return {
    ms: Number(/(\d+) \//.exec(text)?.[1] ?? Number.NaN),
    finished: text.includes("已结束"),
  };
}

describe("NodeInspector particle generation point", () => {
  it("drags a world-space start emitter through a zoomed and rotated camera, saving x/y once", async () => {
    const node = particleNode();
    api.buildNodePreview.mockResolvedValue(
      particlePreview(node, { camera: ZOOMED_CAMERA, persistent: true }),
    );
    const { onChange } = renderInspector(node);
    const marker = await screen.findByLabelText("拖动生成点");
    measureParticleLayer();

    // The marker sits where the camera shows the world point (900, 500).
    const shown = worldPointToStage({ x: 900, y: 500 }, ZOOMED_CAMERA);
    expect(marker.style.left).toBe(`${(shown.x / 1920) * 100}%`);
    expect(marker.style.top).toBe(`${(shown.y / 1080) * 100}%`);

    fireEvent.pointerDown(marker, {
      button: 0,
      clientX: shown.x,
      clientY: shown.y,
    });
    fireEvent.pointerMove(marker, { clientX: shown.x + 50, clientY: shown.y });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerMove(marker, { clientX: shown.x + 100, clientY: shown.y });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(marker, { clientX: shown.x + 100, clientY: shown.y });

    // 100 design pixels right is (+54.13, -31.25) world pixels under this
    // camera.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("target", {
      ...node,
      x: 954,
      y: 469,
    });
  });

  it("drags a screen-space emitter by raw design pixels, ignoring the camera", async () => {
    const node = particleNode({ space: "screen", x: 400, y: 300 });
    api.buildNodePreview.mockResolvedValue(
      particlePreview(node, { camera: ZOOMED_CAMERA, persistent: true }),
    );
    const { onChange } = renderInspector(node);
    const marker = await screen.findByLabelText("拖动生成点");
    measureParticleLayer();
    // A screen emitter is not shown through the camera.
    expect(marker.style.left).toBe(`${(400 / 1920) * 100}%`);

    fireEvent.pointerDown(marker, { button: 0, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(marker, { clientX: 480, clientY: 340 });
    fireEvent.pointerUp(marker, { clientX: 480, clientY: 340 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("target", {
      ...node,
      x: 480,
      y: 340,
    });
  });

  it("writes nothing for a click, a cancelled drag or a drag that lands where it started", async () => {
    const node = particleNode();
    api.buildNodePreview.mockResolvedValue(
      particlePreview(node, { persistent: true }),
    );
    const { onChange } = renderInspector(node);
    const marker = await screen.findByLabelText("拖动生成点");
    measureParticleLayer();

    fireEvent.pointerDown(marker, { button: 0, clientX: 900, clientY: 500 });
    fireEvent.pointerUp(marker, { clientX: 900, clientY: 500 });

    for (const cancel of [
      () => fireEvent.keyDown(window, { key: "Escape" }),
      () => fireEvent.pointerCancel(marker, { clientX: 1000, clientY: 600 }),
      () => fireEvent(window, new Event("blur")),
    ]) {
      fireEvent.pointerDown(marker, { button: 0, clientX: 900, clientY: 500 });
      fireEvent.pointerMove(marker, { clientX: 1000, clientY: 600 });
      cancel();
      fireEvent.pointerUp(marker, { clientX: 1000, clientY: 600 });
    }

    fireEvent.pointerDown(marker, { button: 0, clientX: 900, clientY: 500 });
    fireEvent.pointerMove(marker, { clientX: 1000, clientY: 600 });
    fireEvent.pointerMove(marker, { clientX: 900, clientY: 500 });
    fireEvent.pointerUp(marker, { clientX: 900, clientY: 500 });

    expect(onChange).not.toHaveBeenCalled();
    // The marker is back on the runtime position after every cancel.
    expect(marker.style.left).toBe(`${(900 / 1920) * 100}%`);
  });

  it("keeps a dropped marker until the refetch moves it, without applying the drop twice", async () => {
    const node = particleNode();
    let current = node;
    api.buildNodePreview.mockImplementation(() =>
      Promise.resolve(particlePreview(current, { persistent: true })),
    );
    const { onChange, rerender } = renderInspector(node);
    await screen.findByLabelText("拖动生成点");
    measureParticleLayer();

    const marker = screen.getByLabelText("拖动生成点");
    fireEvent.pointerDown(marker, { button: 0, clientX: 900, clientY: 500 });
    fireEvent.pointerMove(marker, { clientX: 1000, clientY: 560 });
    fireEvent.pointerUp(marker, { clientX: 1000, clientY: 560 });
    expect(onChange).toHaveBeenCalledTimes(1);
    // Until the runtime answers, the marker stays where it was dropped.
    expect(marker.style.left).toBe(`${(1000 / 1920) * 100}%`);

    // The host applied the change; the refetch reports the new position.
    current = { ...node, x: 1000, y: 560 };
    rerender(current);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const settled = screen.getByLabelText("拖动生成点");
    expect(settled.style.left).toBe(`${(1000 / 1920) * 100}%`);
    expect(settled.style.top).toBe(`${(560 / 1080) * 100}%`);
  });

  it("returns the marker to the document position when the drop is undone before its refetch arrives", async () => {
    const node = particleNode();
    // Every answer reports the original position, and it is the very same
    // object each time: only the request revision can tell the answers apart.
    api.buildNodePreview.mockResolvedValue(
      particlePreview(node, { persistent: true }),
    );
    const { onChange, rerender } = renderInspector(node);
    await screen.findByLabelText("拖动生成点");
    measureParticleLayer();

    const marker = screen.getByLabelText("拖动生成点");
    fireEvent.pointerDown(marker, { button: 0, clientX: 900, clientY: 500 });
    fireEvent.pointerMove(marker, { clientX: 1000, clientY: 560 });
    fireEvent.pointerUp(marker, { clientX: 1000, clientY: 560 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(marker.style.left).toBe(`${(1000 / 1920) * 100}%`);

    // Commit, then undo before the runtime answered the commit.
    rerender({ ...node, x: 1000, y: 560 });
    rerender(node);

    await waitFor(
      () =>
        expect(screen.getByLabelText("拖动生成点").style.left).toBe(
          `${(900 / 1920) * 100}%`,
        ),
      { timeout: 3000 },
    );
    expect(screen.getByLabelText("拖动生成点").style.top).toBe(
      `${(500 / 1080) * 100}%`,
    );
  });

  it("still drags a start emitter by hitting it on the canvas", async () => {
    const node = particleNode({ x: 600, y: 300 });
    api.buildNodePreview.mockResolvedValue(
      particlePreview(node, { persistent: true }),
    );
    const { onChange } = renderInspector(node);
    const canvas = await screen.findByLabelText<HTMLCanvasElement>("粒子预览");
    stubStageRect(canvas);
    await waitFor(() => expect(stageClass(canvas)).toContain("is-draggable"));

    fireEvent.pointerDown(canvas, { button: 0, clientX: 600, clientY: 300 });
    fireEvent.pointerMove(canvas, { clientX: 700, clientY: 350 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(canvas, { clientX: 700, clientY: 350 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("target", {
      ...node,
      x: 700,
      y: 350,
    });
  });

  it("previews a burst node's own cue without a saved emitter and drags its generation point", async () => {
    const node = particleNode({ action: "burst", x: 700, y: 400 });
    const decoy = burstCueFor(node, "other", { x: 100, y: 100 });
    api.buildNodePreview.mockResolvedValue(
      particlePreview(node, {
        cues: [decoy, burstCueFor(node)],
        particle: BURST_PARTICLE,
      }),
    );
    const { onChange, kit } = renderInspector(node);
    const marker = await screen.findByLabelText("拖动生成点");
    measureParticleLayer();

    // The matching cue is previewed: one transient batch at the node's
    // position, never the decoy's.
    await waitFor(() => expect(kit.particleBatches).toHaveLength(1));
    expect(kit.particleBatches[0]?.node.position).toMatchObject({
      x: 700,
      y: 400,
    });
    expect(marker).toHaveTextContent("爆发生成点");
    expect(marker.style.left).toBe(`${(700 / 1920) * 100}%`);
    await waitFor(() => expect(burstReadout().finished).toBe(true), {
      timeout: 4000,
    });
    // Nothing persistent was faked: once the burst expired nothing is left.
    expect(liveBatches(kit)).toHaveLength(0);

    fireEvent.pointerDown(marker, { button: 0, clientX: 700, clientY: 400 });
    fireEvent.pointerMove(marker, { clientX: 640, clientY: 460 });
    fireEvent.pointerUp(marker, { clientX: 640, clientY: 460 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("target", {
      ...node,
      x: 640,
      y: 460,
    });
  });

  it("drags a burst generation point through the camera", async () => {
    const node = particleNode({ action: "burst", x: 900, y: 500 });
    api.buildNodePreview.mockResolvedValue(
      particlePreview(node, {
        camera: ZOOMED_CAMERA,
        cues: [burstCueFor(node)],
        particle: BURST_PARTICLE,
      }),
    );
    const { onChange } = renderInspector(node);
    const marker = await screen.findByLabelText("拖动生成点");
    measureParticleLayer();
    const shown = worldPointToStage({ x: 900, y: 500 }, ZOOMED_CAMERA);

    fireEvent.pointerDown(marker, {
      button: 0,
      clientX: shown.x,
      clientY: shown.y,
    });
    fireEvent.pointerMove(marker, { clientX: shown.x + 100, clientY: shown.y });
    fireEvent.pointerUp(marker, { clientX: shown.x + 100, clientY: shown.y });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("target", {
      ...node,
      x: 954,
      y: 469,
    });
  });

  it("replays a burst node with Space after it completed, without history", async () => {
    const node = particleNode({ action: "burst" });
    api.buildNodePreview.mockResolvedValue(
      particlePreview(node, {
        cues: [burstCueFor(node)],
        particle: BURST_PARTICLE,
      }),
    );
    const { onChange, kit } = renderInspector(node);
    await screen.findByRole("button", { name: /重播爆发/ });
    await waitFor(() => expect(burstReadout().finished).toBe(true), {
      timeout: 4000,
    });
    expect(kit.particleBatches).toHaveLength(1);

    const press = createEvent.keyDown(document.body, {
      key: " ",
      code: "Space",
    });
    fireEvent(document.body, press);
    expect(press.defaultPrevented).toBe(true);
    await waitFor(() => expect(kit.particleBatches).toHaveLength(2));
    await waitFor(() => expect(burstReadout().finished).toBe(true), {
      timeout: 4000,
    });

    // The button is the same operation.
    fireEvent.click(screen.getByRole("button", { name: /重播爆发/ }));
    await waitFor(() => expect(kit.particleBatches).toHaveLength(3));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers neither a burst transport nor Space for a start node, and nothing for stop", async () => {
    const start = particleNode();
    api.buildNodePreview.mockResolvedValue(
      particlePreview(start, { persistent: true }),
    );
    const first = renderInspector(start);
    await screen.findByLabelText("拖动生成点");
    expect(screen.queryByRole("button", { name: /重播爆发/ })).toBeNull();
    const press = createEvent.keyDown(document.body, {
      key: " ",
      code: "Space",
    });
    fireEvent(document.body, press);
    expect(press.defaultPrevented).toBe(false);
    first.view.unmount();

    const stop = particleNode({ action: "stop" });
    api.buildNodePreview.mockResolvedValue(particlePreview(stop));
    renderInspector(stop);
    await screen.findByLabelText("粒子预览");
    expect(screen.queryByLabelText("拖动生成点")).toBeNull();
    expect(screen.getByText(/停止节点没有可拖动的目标/)).toBeInTheDocument();
  });

  it("shows no burst transport or marker when the runtime produced no matching cue", async () => {
    const node = particleNode({ action: "burst" });
    api.buildNodePreview.mockResolvedValue(
      particlePreview(node, {
        cues: [burstCueFor(node, "other")],
        particle: BURST_PARTICLE,
      }),
    );
    const { kit } = renderInspector(node);
    await screen.findByLabelText("粒子预览");
    expect(screen.queryByRole("button", { name: /重播爆发/ })).toBeNull();
    expect(screen.queryByLabelText("拖动生成点")).toBeNull();
    expect(kit.particleBatches).toHaveLength(0);
  });
});
