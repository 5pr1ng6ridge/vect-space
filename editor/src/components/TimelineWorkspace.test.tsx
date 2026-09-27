// @vitest-environment jsdom
/**
 * TimelineWorkspace host-boundary tests.
 *
 * The workspace is the editor's timeline session host: it owns the per-canvas
 * preview lifecycle, mirrors Pixi frames into React state, and turns gestures
 * into exactly one document edit.  These tests drive the real ownership code
 * (DeferredSession + SceneSurface + TimelineSession through
 * `createEditorTimelinePreview`) against the in-memory render kit, and the
 * real editor history reducer (`editorReducer`) instead of a mock that merely
 * counts undo calls.
 */
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect, useReducer, useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioManager } from "@vectspace/presentation-core/audio";
import type {
  ButtonSnapshot,
  RuntimeSnapshot,
  RuntimeUpdate,
} from "@vectspace/presentation-core/types";
import type {
  BuildNodePreviewResult,
  EditorAsset,
  EditorLayout,
  EditorProject,
  TimelineNode,
} from "../types";
import {
  editorReducer,
  INITIAL_EDITOR_STATE,
  type EditorState,
} from "../editorHistory";
import { findScene } from "../story";
import { TimelineSession } from "@vectspace/presentation-core/timeline-session";
import type { SceneTextureLike } from "@vectspace/presentation-core/scene-textures";
import {
  createFramePump,
  createMemoryKit,
  createMemoryTextureLoader,
  MemorySprite,
  type FramePump,
} from "@vectspace/presentation-core/scene-test-kit";
import {
  createFakeMediaDom,
  type FakeMediaDom,
} from "@vectspace/presentation-core/session-test-kit";
import type { EditorPreviewEnvironment } from "./timelinePreview";
import { AssetLayoutProvider } from "./AssetChooser";
import { TimelineWorkspace } from "./TimelineWorkspace";

type ReadyPreview = Extract<BuildNodePreviewResult, { status: "ready" }>;

const previewApi = vi.hoisted(() => ({
  handler: null as null | ((request: unknown) => Promise<ReadyPreview>),
  requests: [] as unknown[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    editorApi: {
      ...actual.editorApi,
      buildNodePreview: (request: unknown): Promise<ReadyPreview> => {
        previewApi.requests.push(request);
        const handler = previewApi.handler;
        if (handler === null) {
          return Promise.reject(new Error("测试没有注册预览响应"));
        }
        return handler(request);
      },
    },
  };
});

const SCENE_ID = "scene-a";
const NODE_ID = "timeline";
const OTHER_NODE_ID = "timeline-other";

const ASSETS: EditorAsset[] = [
  {
    id: "sprite.alice",
    kind: "sprite",
    path: "sprite/alice.png",
    absolute_path: "C:/game/sprite/alice.png",
  },
  {
    id: "sprite.bob",
    kind: "sprite",
    path: "sprite/bob.png",
    absolute_path: "C:/game/sprite/bob.png",
  },
  {
    id: "bg.room",
    kind: "background",
    path: "bg/room.png",
    absolute_path: "C:/game/bg/room.png",
  },
  {
    id: "bg.other",
    kind: "background",
    path: "bg/other.png",
    absolute_path: "C:/game/bg/other.png",
  },
];

function timelineNode(overrides: Partial<TimelineNode> = {}): TimelineNode {
  return {
    type: "timeline",
    duration_ms: 1000,
    await: true,
    skippable: true,
    tracks: [
      {
        type: "sprite",
        sprite_id: "alice",
        asset: "sprite.alice",
        remove_at_end: false,
        channels: {
          x: [
            { at_ms: 0, value: 100, easing: "linear" },
            { at_ms: 1000, value: 500, easing: "linear" },
          ],
          y: [{ at_ms: 0, value: 500, easing: "linear" }],
        },
      },
      { type: "camera", channels: {} },
    ],
    events: [],
    next: "end",
    ...overrides,
  };
}

function makeProject(nodes: Record<string, TimelineNode>): EditorProject {
  return {
    root: "C:/game",
    manifest: {
      schema_version: 2,
      content_version: "test",
      entry_scene: SCENE_ID,
      default_locale: "zh-CN",
      variables: {},
      characters: {},
      assets: {},
      scenes: [`scenes/${SCENE_ID}.yaml`],
      ui_motions: [],
      ui_motion_defaults: {},
    },
    scenes: [
      {
        path: `scenes/${SCENE_ID}.yaml`,
        definition: {
          schema_version: 1,
          id: SCENE_ID,
          entry: NODE_ID,
          nodes,
        },
      },
    ],
    ui_motions: [],
    layout: { version: 1, scenes: {} },
    assets: ASSETS,
    diagnostics: [],
    fingerprint: "fingerprint",
  };
}

interface SnapshotOptions {
  background?: string;
  spriteId?: string;
  spriteAsset?: string;
  /** Real runtime button instances visible at node entry. */
  buttons?: Record<string, ButtonSnapshot>;
}

function snapshot(options: SnapshotOptions = {}): RuntimeSnapshot {
  const spriteId = options.spriteId ?? "alice";
  return {
    session_id: "1",
    mode: "story",
    revision: "1",
    location: { scene_id: SCENE_ID, node_id: NODE_ID },
    variables: {},
    world: {
      background: options.background ?? "bg.room",
      sprites: {
        [spriteId]: {
          asset: options.spriteAsset ?? "sprite.alice",
          x: 100,
          y: 500,
          scale: 1,
          scale_x: 1,
          scale_y: 1,
          rotation_deg: 0,
          opacity: 1,
          z: 1,
        },
      },
      buttons: options.buttons ?? {},
      camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
      dialogue_ui_visible: true,
      ui_motion_bindings: {},
      persistent_effects: [],
    },
    audio: { bgm: null },
    playback: { auto: "normal", ctrl_fast_forward: "allow" },
    prompt: { kind: "none" },
  };
}

function readyPreview(
  node: TimelineNode,
  options: {
    nodeId?: string;
    traceLength?: number;
    snapshot?: SnapshotOptions;
  } = {},
): ReadyPreview {
  const start = snapshot(options.snapshot);
  const update: RuntimeUpdate = {
    session_id: "1",
    mode: "story",
    update_id: "update",
    snapshot: start,
    requires_ack: false,
    cues: [
      {
        cue_id: "1",
        gate: "runtime",
        type: "timeline",
        presentation_id: "presentation",
        duration_ms: node.duration_ms,
        skippable: true,
        is_seen: true,
        tracks: node.tracks,
        events: node.events,
      },
    ],
  };
  return {
    status: "ready",
    start_snapshot: start,
    update,
    trace: Array.from(
      { length: options.traceLength ?? 1 },
      (_value, index) => ({
        scene_id: SCENE_ID,
        node_id: `${options.nodeId ?? NODE_ID}-${index}`,
      }),
    ),
  };
}

interface HostHandle {
  state: EditorState | null;
  backCalls: number;
}

function WorkspaceHost({
  project,
  onState,
  onBack,
  environment,
  nodeId = NODE_ID,
  nodeOverride,
  onChangeSpy,
}: {
  project: EditorProject;
  onState(state: EditorState): void;
  onBack(): void;
  environment: EditorPreviewEnvironment;
  nodeId?: string;
  nodeOverride?: TimelineNode;
  onChangeSpy?: (node: TimelineNode) => void;
}): ReactElement {
  const [state, dispatch] = useReducer(editorReducer, INITIAL_EDITOR_STATE);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    dispatch({ type: "load", project });
  }, [project]);
  useEffect(() => {
    onState(state);
  }, [state, onState]);
  const scene =
    state.project === null ? undefined : findScene(state.project, SCENE_ID);
  const stored = scene?.definition.nodes[nodeId] as TimelineNode | undefined;
  const node = nodeOverride ?? stored;
  if (state.project === null || node === undefined) {
    return <div>载入中</div>;
  }
  return (
    <>
      {error !== null && <div role="alert">{error}</div>}
      <TimelineWorkspace
        assets={state.project.assets}
        dirty={state.dirty}
        futureAvailable={state.future.length > 0}
        importTokens={[]}
        node={node}
        nodeId={nodeId}
        onBack={onBack}
        onChange={(next) => {
          onChangeSpy?.(next);
          dispatch({
            type: "edit",
            mutation: (draft) => {
              const target = findScene(draft, SCENE_ID);
              if (target !== undefined) {
                target.definition.nodes[nodeId] = next;
              }
            },
            history: true,
            label: "时间轴编辑",
          });
        }}
        onError={setError}
        onPreviewSettingsChange={() => undefined}
        onRedo={() => dispatch({ type: "redo" })}
        onSave={() => undefined}
        onUndo={() => dispatch({ type: "undo" })}
        previewEnvironment={environment}
        previewSettings={undefined}
        project={state.project}
        sceneId={SCENE_ID}
      />
    </>
  );
}

function currentNode(handle: HostHandle, nodeId = NODE_ID): TimelineNode {
  const project = handle.state?.project;
  if (project === null || project === undefined) {
    throw new Error("项目尚未载入");
  }
  const scene = findScene(project, SCENE_ID);
  const node = scene?.definition.nodes[nodeId];
  if (node === undefined || node.type !== "timeline") {
    throw new Error("时间线节点不存在");
  }
  return node;
}

interface RenderKit {
  environment: EditorPreviewEnvironment;
  kit: ReturnType<typeof createMemoryKit>;
  textures: ReturnType<typeof createMemoryTextureLoader>;
  pump: ReturnType<typeof createFramePump>;
}

function createRenderKit(
  textureLoader?: (url: string) => Promise<SceneTextureLike>,
): RenderKit {
  const kit = createMemoryKit();
  const textures = createMemoryTextureLoader();
  const pump = createFramePump();
  const environment: EditorPreviewEnvironment = {
    kit: kit.kit,
    requestFrame: pump.request,
    cancelFrame: pump.cancel,
    textureLoader: textureLoader ?? textures.load,
  };
  return { environment, kit, textures, pump };
}

interface DeferredLoader {
  load(url: string): Promise<SceneTextureLike>;
  release(urls: readonly string[]): void;
  pending: Map<string, () => void>;
}

function createDeferredLoader(): DeferredLoader {
  const pending = new Map<string, () => void>();
  return {
    pending,
    load: (url) =>
      new Promise((resolve) => {
        pending.set(url, () =>
          resolve({
            url,
            width: 64,
            height: 64,
            destroy: () => undefined,
          } as unknown as SceneTextureLike),
        );
      }),
    release: (urls) => {
      for (const url of urls) {
        const resolve = pending.get(url);
        if (resolve !== undefined) {
          pending.delete(url);
          resolve();
        }
      }
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForReady(traceLength = 1): Promise<void> {
  await waitFor(() =>
    expect(
      screen.getByText(
        new RegExp(`已捕获真实进入状态（${traceLength} 个边界）`),
      ),
    ).toBeInTheDocument(),
  );
}

function stageRect(container: HTMLElement): void {
  const layer = container.querySelector(".timeline-gizmo-layer");
  if (layer === null) throw new Error("缺少 gizmo 层");
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

function selectedGizmo(container: HTMLElement): HTMLElement {
  const gizmo = container.querySelector(".timeline-gizmo.selected");
  if (gizmo === null) throw new Error("没有选中的 gizmo");
  return gizmo as HTMLElement;
}

function gizmoLeft(container: HTMLElement): string {
  const gizmo = container.querySelector(".timeline-gizmo");
  if (gizmo === null) throw new Error("没有 gizmo");
  return (gizmo as HTMLElement).style.left;
}

function dragGizmo(gizmo: HTMLElement, dx: number): void {
  fireEvent.pointerDown(gizmo, { button: 0, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(gizmo, { clientX: dx, clientY: 0 });
  fireEvent.pointerUp(gizmo, { clientX: dx, clientY: 0 });
}

async function renderWorkspace(): Promise<{
  view: ReturnType<typeof render>;
  handle: HostHandle;
  onChangeSpy: ReturnType<typeof vi.fn>;
  renderKit: RenderKit;
}> {
  const renderKit = createRenderKit();
  const node = timelineNode();
  previewApi.handler = () => Promise.resolve(readyPreview(node));
  const handle: HostHandle = { state: null, backCalls: 0 };
  const onChangeSpy = vi.fn<(node: TimelineNode) => void>();
  const view = render(
    <WorkspaceHost
      environment={renderKit.environment}
      onBack={() => {
        handle.backCalls += 1;
      }}
      onChangeSpy={onChangeSpy}
      onState={(state) => {
        handle.state = state;
      }}
      project={makeProject({ [NODE_ID]: node })}
    />,
  );
  await waitForReady();
  stageRect(view.container);
  return { view, handle, onChangeSpy, renderKit };
}

function inspectorField(
  container: HTMLElement,
  label: string,
): HTMLInputElement {
  const inspector = container.querySelector(".timeline-object-inspector");
  if (inspector === null) throw new Error("缺少选中对象检视器");
  return within(inspector as HTMLElement).getByLabelText<HTMLInputElement>(
    label,
  );
}

function selectFirstObject(container: HTMLElement): void {
  const list = container.querySelector<HTMLElement>(".timeline-object-list");
  if (list === null) throw new Error("缺少对象列表");
  const button = within(list).getAllByRole("button")[0];
  if (button === undefined) throw new Error("对象列表为空");
  fireEvent.click(button);
}

beforeEach(() => {
  previewApi.handler = null;
  previewApi.requests.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TimelineWorkspace preview context", () => {
  it("passes the canonical screen effects to the preview unchanged", async () => {
    const renderKit = createRenderKit();
    const canonicalFlash = {
      type: "screen_effect" as const,
      id: "fx-flash",
      at_ms: 100,
      effect: { type: "flash" as const, color: "#FFEEDD", peak_alpha: 0.5 },
      duration_ms: 200,
    };
    const canonicalShake = {
      type: "screen_effect" as const,
      id: "fx-shake",
      at_ms: 400,
      effect: {
        type: "shake" as const,
        amplitude_x: 24,
        amplitude_y: 12,
        frequency_hz: 22,
        decay: 0.75,
        seed: 42,
      },
      duration_ms: 200,
    };
    const node = timelineNode({ events: [canonicalFlash, canonicalShake] });
    previewApi.handler = () => Promise.resolve(readyPreview(node));
    const handle: HostHandle = { state: null, backCalls: 0 };
    const project = makeProject({ [NODE_ID]: node });
    const view = render(
      <WorkspaceHost
        environment={renderKit.environment}
        onBack={() => {
          handle.backCalls += 1;
        }}
        onState={(state) => {
          handle.state = state;
        }}
        project={project}
      />,
    );
    await waitForReady();

    // Editing the timeline is the production path that hands the editor's own
    // authoring model to the shared preview.  The editor now authors the same
    // canonical specs the Rust loader normalises YAML into, so the boundary
    // must pass them through without any rewrite.
    const applyEdit = vi.spyOn(TimelineSession.prototype, "applyTimelineEdit");
    const load = vi.spyOn(TimelineSession.prototype, "load");
    const edited = timelineNode({
      duration_ms: 2000,
      events: [canonicalFlash, canonicalShake],
    });
    view.rerender(
      <WorkspaceHost
        environment={renderKit.environment}
        nodeOverride={edited}
        onBack={() => {
          handle.backCalls += 1;
        }}
        onState={(state) => {
          handle.state = state;
        }}
        project={project}
      />,
    );
    await waitFor(() => expect(applyEdit).toHaveBeenCalled());

    const updates = [
      ...applyEdit.mock.calls.map((call) => call[0]),
      ...load.mock.calls.map((call) => call[0].update),
    ];
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      const cue = update.cues.find(
        (candidate) => candidate.type === "timeline",
      );
      if (cue?.type !== "timeline") throw new Error("缺少时间轴 Cue");
      expect(cue.events).toEqual([canonicalFlash, canonicalShake]);
    }
  });

  it("re-evaluates a keyframe-only edit without preparing, and prepares a resource change", async () => {
    const renderKit = createRenderKit();
    const node = timelineNode();
    previewApi.handler = () => Promise.resolve(readyPreview(node));
    const handle: HostHandle = { state: null, backCalls: 0 };
    const project = makeProject({ [NODE_ID]: node });
    const view = render(
      <WorkspaceHost
        environment={renderKit.environment}
        onBack={() => {
          handle.backCalls += 1;
        }}
        onState={(state) => {
          handle.state = state;
        }}
        project={project}
      />,
    );
    await waitForReady();
    const loadsBefore = renderKit.textures.loaded.length;
    expect(loadsBefore).toBeGreaterThan(0);
    const leftBefore = gizmoLeft(view.container);

    // A keyframe-only edit: the timeline asset signature is unchanged, so the
    // preview re-evaluates in place instead of re-preparing the context.
    const edited = timelineNode({
      tracks: [
        {
          type: "sprite",
          sprite_id: "alice",
          asset: "sprite.alice",
          remove_at_end: false,
          channels: {
            x: [
              { at_ms: 0, value: 300, easing: "linear" },
              { at_ms: 1000, value: 500, easing: "linear" },
            ],
            y: [{ at_ms: 0, value: 500, easing: "linear" }],
          },
        },
        { type: "camera", channels: {} },
      ],
    });
    view.rerender(
      <WorkspaceHost
        environment={renderKit.environment}
        nodeOverride={edited}
        onBack={() => {
          handle.backCalls += 1;
        }}
        onState={(state) => {
          handle.state = state;
        }}
        project={project}
      />,
    );
    await waitFor(() => expect(gizmoLeft(view.container)).not.toBe(leftBefore));
    expect(renderKit.textures.loaded.length).toBe(loadsBefore);

    // A different artwork id is a resource dependency: the host reloads the
    // context so the replacement pixels are prepared before they commit.
    const replaced = timelineNode({
      tracks: [
        {
          type: "sprite",
          sprite_id: "alice",
          asset: "sprite.bob",
          remove_at_end: false,
          channels: { x: [{ at_ms: 0, value: 100, easing: "linear" }] },
        },
        { type: "camera", channels: {} },
      ],
    });
    view.rerender(
      <WorkspaceHost
        environment={renderKit.environment}
        nodeOverride={replaced}
        onBack={() => {
          handle.backCalls += 1;
        }}
        onState={(state) => {
          handle.state = state;
        }}
        project={project}
      />,
    );
    await waitFor(() =>
      expect(renderKit.textures.loaded.length).toBeGreaterThan(loadsBefore),
    );
    expect(
      renderKit.textures.loaded.some((texture) => texture.url.includes("bob")),
    ).toBe(true);
  });

  it("ignores a superseded context response instead of replacing the newer preview", async () => {
    const loader = createDeferredLoader();
    const renderKit = createRenderKit(loader.load);
    const pendingIpc = new Map<string, (result: ReadyPreview) => void>();
    previewApi.handler = (request) => {
      const target = request as { target: { node_id: string } };
      return new Promise((resolve) => {
        pendingIpc.set(target.target.node_id, resolve);
      });
    };
    const firstNode = timelineNode();
    const secondNode = timelineNode({
      tracks: [
        {
          type: "sprite",
          sprite_id: "bob",
          asset: "sprite.bob",
          remove_at_end: false,
          channels: { x: [{ at_ms: 0, value: 700, easing: "linear" }] },
        },
        { type: "camera", channels: {} },
      ],
    });
    const handle: HostHandle = { state: null, backCalls: 0 };
    const project = makeProject({
      [NODE_ID]: firstNode,
      [OTHER_NODE_ID]: secondNode,
    });
    const view = render(
      <WorkspaceHost
        environment={renderKit.environment}
        onBack={() => {
          handle.backCalls += 1;
        }}
        onState={(state) => {
          handle.state = state;
        }}
        project={project}
      />,
    );
    await waitFor(() => expect(pendingIpc.has(NODE_ID)).toBe(true));

    // The first response arrives and starts decoding its context.
    pendingIpc.get(NODE_ID)?.(readyPreview(firstNode, { traceLength: 1 }));
    await waitFor(() =>
      expect(loader.pending.has("C:/game/sprite/alice.png")).toBe(true),
    );

    // A newer target supersedes it while that decode is still in flight.
    view.rerender(
      <WorkspaceHost
        environment={renderKit.environment}
        nodeId={OTHER_NODE_ID}
        onBack={() => {
          handle.backCalls += 1;
        }}
        onState={(state) => {
          handle.state = state;
        }}
        project={project}
      />,
    );
    await waitFor(() => expect(pendingIpc.has(OTHER_NODE_ID)).toBe(true));
    pendingIpc.get(OTHER_NODE_ID)?.(
      readyPreview(secondNode, {
        nodeId: OTHER_NODE_ID,
        traceLength: 2,
        snapshot: {
          background: "bg.other",
          spriteId: "bob",
          spriteAsset: "sprite.bob",
        },
      }),
    );
    // The context decodes its sprites before its background, and each decode
    // gates the next one, so release the gates in that order.
    await waitFor(() =>
      expect(loader.pending.has("C:/game/sprite/bob.png")).toBe(true),
    );
    loader.release(["C:/game/sprite/bob.png"]);
    await waitFor(() =>
      expect(loader.pending.has("C:/game/bg/other.png")).toBe(true),
    );
    loader.release(["C:/game/bg/other.png"]);
    await waitForReady(2);
    expect(
      within(
        view.container.querySelector(".timeline-object-list") as HTMLElement,
      ).getByRole("button", { name: /bob/ }),
    ).toBeInTheDocument();

    // The stale first context now finishes decoding (the replacement already
    // aborted its preparation).  It must not seek the replacement timeline or
    // overwrite the newer preview/status.
    loader.release(["C:/game/sprite/alice.png"]);
    await settle();
    await settle();
    expect(
      screen.getByText(/已捕获真实进入状态（2 个边界）/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/（1 个边界）/)).toBeNull();
  });

  it("ignores a stale resource load so it cannot clear a newer override or seek", async () => {
    const loader = createDeferredLoader();
    const renderKit = createRenderKit(loader.load);
    const node = timelineNode();
    previewApi.handler = () => Promise.resolve(readyPreview(node));
    const handle: HostHandle = { state: null, backCalls: 0 };
    const project = makeProject({ [NODE_ID]: node });
    const renderHost = (override?: TimelineNode): void => {
      view.rerender(
        <WorkspaceHost
          environment={renderKit.environment}
          nodeOverride={override}
          onBack={() => {
            handle.backCalls += 1;
          }}
          onState={(state) => {
            handle.state = state;
          }}
          project={project}
        />,
      );
    };
    const view = render(
      <WorkspaceHost
        environment={renderKit.environment}
        onBack={() => {
          handle.backCalls += 1;
        }}
        onState={(state) => {
          handle.state = state;
        }}
        project={project}
      />,
    );
    // Resolve the initial context decode: sprites gate before the background.
    await waitFor(() =>
      expect(loader.pending.has("C:/game/sprite/alice.png")).toBe(true),
    );
    loader.release(["C:/game/sprite/alice.png"]);
    await waitFor(() =>
      expect(loader.pending.has("C:/game/bg/room.png")).toBe(true),
    );
    loader.release(["C:/game/bg/room.png"]);
    await waitForReady();
    stageRect(view.container);

    // An uncommitted interactive override makes a stale clear observable.
    fireEvent.click(screen.getByRole("button", { name: "自动关键帧" }));
    selectFirstObject(view.container);
    dragGizmo(selectedGizmo(view.container), 96);
    const overrideLeft = gizmoLeft(view.container);

    const withAsset = (asset: string): TimelineNode =>
      timelineNode({
        tracks: [
          {
            type: "sprite",
            sprite_id: "alice",
            asset,
            remove_at_end: false,
            channels: { x: [{ at_ms: 0, value: 100, easing: "linear" }] },
          },
          { type: "camera", channels: {} },
        ],
      });

    // Resource change #1 starts a deferred load of the replacement texture.
    renderHost(withAsset("sprite.bob"));
    await waitFor(() =>
      expect(loader.pending.has("C:/game/sprite/bob.png")).toBe(true),
    );

    // Resource change #2 supersedes it while #1 is still decoding.
    renderHost(withAsset("bg.other"));
    await waitFor(() =>
      expect(loader.pending.has("C:/game/bg/other.png")).toBe(true),
    );

    // The superseded load finishes later: it must not clear the override or
    // seek the newer state.
    loader.release(["C:/game/sprite/bob.png"]);
    await settle();
    await settle();
    expect(gizmoLeft(view.container)).toBe(overrideLeft);

    // The latest load still applies its reset and seek (drain any texture the
    // new context requests, including a re-requested background, and pump the
    // deferred frame so the cleared override is rendered).
    loader.release(["C:/game/bg/other.png"]);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await settle();
      renderKit.pump.step();
      loader.release([...loader.pending.keys()]);
    }
    await waitFor(() =>
      expect(gizmoLeft(view.container)).not.toBe(overrideLeft),
    );
  });
});

describe("TimelineWorkspace gestures and history", () => {
  it("focuses on entry and Space toggles playback from buttons but not editable fields", async () => {
    const { view, handle } = await renderWorkspace();
    const workspace = view.container.querySelector(".timeline-workspace");
    expect(workspace).not.toBeNull();
    expect(document.activeElement).toBe(workspace);

    const addFlash = screen.getByRole("button", { name: "＋闪光" });
    fireEvent.click(addFlash);
    expect(currentNode(handle).events).toHaveLength(1);
    addFlash.focus();
    fireEvent.keyDown(addFlash, { key: " " });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "＋闪光" })).toBe(addFlash);

    fireEvent.keyDown(addFlash, { key: " " });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "播放" })).toBeInTheDocument(),
    );
    const durationInput = screen.getByLabelText("时间线时长");
    durationInput.focus();
    fireEvent.keyDown(durationInput, { key: " " });
    expect(screen.getByRole("button", { name: "播放" })).toBeInTheDocument();

    const slider = screen.getByRole("slider", { name: "时间线播放头" });
    slider.focus();
    expect(fireEvent.keyDown(slider, { key: " ", code: "Space" })).toBe(false);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument(),
    );
    const tracks =
      view.container.querySelector<HTMLElement>(".timeline-tracks");
    if (tracks === null) throw new Error("missing scrolling tracks");
    tracks.tabIndex = 0;
    tracks.focus();
    tracks.addEventListener("keydown", (event) => event.stopPropagation());
    expect(fireEvent.keyDown(tracks, { key: " ", code: "Space" })).toBe(false);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "播放" })).toBeInTheDocument(),
    );
  });

  it("commits outward uniform sprite scaling from all four corner handles and cancels cleanly", async () => {
    const { view, handle, onChangeSpy } = await renderWorkspace();
    selectFirstObject(view.container);
    const initialScale = Number(inspectorField(view.container, "Scale").value);
    const cases = [
      ["左上角缩放素材", -96, -96],
      ["右上角缩放素材", 96, -96],
      ["左下角缩放素材", -96, 96],
      ["右下角缩放素材", 96, 96],
    ] as const;
    let commits = 0;
    for (const [label, dx, dy] of cases) {
      const corner = screen.getByRole("button", { name: label });
      fireEvent.pointerDown(corner, { button: 0, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(corner, { clientX: dx, clientY: dy });
      fireEvent.pointerUp(corner, { clientX: dx, clientY: dy });
      commits += 1;
      expect(onChangeSpy).toHaveBeenCalledTimes(commits);
      expect(
        currentNode(handle).tracks[0]?.channels.scale?.[0]?.value,
      ).toBeCloseTo(initialScale + (commits * 96) / 450);
    }

    const before = currentNode(handle).tracks[0]?.channels.scale;
    const corner = screen.getByRole("button", { name: "左上角缩放素材" });
    fireEvent.pointerDown(corner, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(corner, { clientX: -200, clientY: -200 });
    fireEvent.pointerCancel(corner);
    fireEvent.pointerUp(corner, { clientX: -200, clientY: -200 });
    expect(currentNode(handle).tracks[0]?.channels.scale).toEqual(before);
    expect(onChangeSpy).toHaveBeenCalledTimes(4);
  });

  it("commits one history entry per drag, snapping to the playhead, and one undo reverts it", async () => {
    const { view, handle, onChangeSpy } = await renderWorkspace();
    expect(view.container.querySelector(".timeline-gizmo.selected")).toBeNull();

    selectFirstObject(view.container);
    const gizmo = selectedGizmo(view.container);
    expect(gizmo.querySelector(".timeline-gizmo-scale")).not.toBeNull();

    dragGizmo(gizmo, 96);
    expect(onChangeSpy).toHaveBeenCalledTimes(1);
    expect(handle.state?.past).toHaveLength(1);
    const afterDrag = currentNode(handle);
    const xChannel = afterDrag.tracks[0]?.channels.x;
    expect(xChannel).toEqual([
      { at_ms: 0, value: 196, easing: "linear" },
      { at_ms: 1000, value: 500, easing: "linear" },
    ]);

    // One gesture = one history entry: a single undo restores the whole drag.
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(handle.state?.past).toHaveLength(0);
    expect(currentNode(handle).tracks[0]?.channels.x).toEqual([
      { at_ms: 0, value: 100, easing: "linear" },
      { at_ms: 1000, value: 500, easing: "linear" },
    ]);

    // Snapping follows the snap selector: a playhead at 130 ms lands on the
    // 100 ms grid, then on the 10 ms grid after the selector changes.
    fireEvent.change(screen.getByLabelText("关键帧吸附"), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByLabelText("时间线播放头"), {
      target: { value: "130" },
    });
    dragGizmo(selectedGizmo(view.container), 96);
    const coarse = currentNode(handle).tracks[0]?.channels.x ?? [];
    expect(coarse.some((frame) => frame.at_ms === 100)).toBe(true);

    fireEvent.change(screen.getByLabelText("关键帧吸附"), {
      target: { value: "10" },
    });
    dragGizmo(selectedGizmo(view.container), 96);
    const fine = currentNode(handle).tracks[0]?.channels.x ?? [];
    expect(fine.some((frame) => frame.at_ms === 130)).toBe(true);
    expect(handle.state?.past).toHaveLength(2);
  });

  it("accumulates a temporary override and writes it once when confirmed", async () => {
    const { view, handle, onChangeSpy } = await renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "自动关键帧" }));
    selectFirstObject(view.container);
    const leftBefore = gizmoLeft(view.container);

    dragGizmo(selectedGizmo(view.container), 96);
    expect(onChangeSpy).not.toHaveBeenCalled();
    expect(handle.state?.past).toHaveLength(0);
    // The preview shows the pending pose even though the document is clean.
    expect(gizmoLeft(view.container)).not.toBe(leftBefore);
    const commitButton = screen.getByRole("button", { name: "写入所改通道" });

    fireEvent.click(commitButton);
    expect(onChangeSpy).toHaveBeenCalledTimes(1);
    expect(handle.state?.past).toHaveLength(1);
    expect(currentNode(handle).tracks[0]?.channels.x).toEqual([
      { at_ms: 0, value: 196, easing: "linear" },
      { at_ms: 1000, value: 500, easing: "linear" },
    ]);

    // The exit dialog's "write and return" is the same single commit.
    dragGizmo(selectedGizmo(view.container), 96);
    fireEvent.click(screen.getByRole("button", { name: "返回剧情图" }));
    fireEvent.click(screen.getByRole("button", { name: "写入并返回" }));
    expect(handle.backCalls).toBe(1);
    expect(handle.state?.past).toHaveLength(2);
  });

  it("discards a temporary override on cancel without touching the document", async () => {
    const { view, handle, onChangeSpy } = await renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "自动关键帧" }));
    selectFirstObject(view.container);
    const leftBefore = gizmoLeft(view.container);

    dragGizmo(selectedGizmo(view.container), 96);
    expect(gizmoLeft(view.container)).not.toBe(leftBefore);
    fireEvent.click(screen.getByRole("button", { name: "返回剧情图" }));
    fireEvent.click(screen.getByRole("button", { name: "丢弃并返回" }));
    expect(handle.backCalls).toBe(1);
    expect(onChangeSpy).not.toHaveBeenCalled();
    expect(handle.state?.past).toHaveLength(0);
    await waitFor(() => expect(gizmoLeft(view.container)).toBe(leftBefore));

    // Escape during the gesture is the same discard: overrides are cleared and
    // the release that follows writes nothing.
    const workspace = view.container.querySelector(".timeline-workspace");
    if (workspace === null) throw new Error("缺少工作区");
    const gizmo = selectedGizmo(view.container);
    fireEvent.pointerDown(gizmo, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(gizmo, { clientX: 96, clientY: 0 });
    expect(gizmoLeft(view.container)).not.toBe(leftBefore);
    fireEvent.keyDown(workspace, { key: "Escape" });
    await waitFor(() => expect(gizmoLeft(view.container)).toBe(leftBefore));
    fireEvent.pointerUp(gizmo, { clientX: 96, clientY: 0 });
    expect(onChangeSpy).not.toHaveBeenCalled();
    expect(handle.state?.past).toHaveLength(0);
  });
});

describe("TimelineWorkspace selected-object numeric edits", () => {
  it("reflects a numeric edit in the live preview and keeps tracking the timeline", async () => {
    const { view, handle, onChangeSpy } = await renderWorkspace();
    selectFirstObject(view.container);
    const beforeX = gizmoLeft(view.container);
    const applyEdit = vi.spyOn(TimelineSession.prototype, "applyTimelineEdit");

    // Typing into the selected-object inspector (not a gizmo drag) must patch
    // the live session once, show the new pose immediately, and display the
    // newly evaluated frame without leaving and re-entering the workspace.
    fireEvent.change(inspectorField(view.container, "X"), {
      target: { value: "300" },
    });
    expect(onChangeSpy).toHaveBeenCalledTimes(1);
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(gizmoLeft(view.container)).not.toBe(beforeX);
    expect(Number(inspectorField(view.container, "X").value)).toBe(300);
    expect(currentNode(handle).tracks[0]?.channels.x).toEqual([
      { at_ms: 0, value: 300, easing: "linear" },
      { at_ms: 1000, value: 500, easing: "linear" },
    ]);

    // The committed keyframe is authoritative: scrubbing re-evaluates the
    // channel instead of staying pinned to the edited pose by a stale
    // interactive override (the defect only a workspace rebuild used to fix).
    fireEvent.change(screen.getByLabelText("时间线播放头"), {
      target: { value: "1000" },
    });
    await settle();
    expect(Number(inspectorField(view.container, "X").value)).toBe(500);
    expect(gizmoLeft(view.container)).toBe("26.041666666666668%");
  });

  it("applies repeated numeric edits to the same and other channels", async () => {
    const { view, handle, onChangeSpy } = await renderWorkspace();
    selectFirstObject(view.container);

    fireEvent.change(inspectorField(view.container, "X"), {
      target: { value: "300" },
    });
    await settle();
    fireEvent.change(inspectorField(view.container, "X"), {
      target: { value: "400" },
    });
    await settle();
    expect(onChangeSpy).toHaveBeenCalledTimes(2);
    expect(currentNode(handle).tracks[0]?.channels.x?.[0]).toEqual({
      at_ms: 0,
      value: 400,
      easing: "linear",
    });

    // A second numeric channel writes its own keyframe with no rebuild.
    fireEvent.change(inspectorField(view.container, "Scale"), {
      target: { value: "2" },
    });
    await settle();
    expect(currentNode(handle).tracks[0]?.channels.scale).toEqual([
      { at_ms: 0, value: 2, easing: "linear" },
    ]);
    expect(onChangeSpy).toHaveBeenCalledTimes(3);
  });

  it("undoes a numeric edit from the parent and refreshes the preview", async () => {
    const { view, handle } = await renderWorkspace();
    selectFirstObject(view.container);
    const beforeX = gizmoLeft(view.container);

    fireEvent.change(inspectorField(view.container, "X"), {
      target: { value: "300" },
    });
    await settle();
    expect(currentNode(handle).tracks[0]?.channels.x?.[0]?.value).toBe(300);

    // The parent (undo/redo) replaces the node externally; the strict preview
    // must adopt the restored document instead of keeping the edit.
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(gizmoLeft(view.container)).toBe(beforeX));
    expect(currentNode(handle).tracks[0]?.channels.x?.[0]?.value).toBe(100);
    expect(Number(inspectorField(view.container, "X").value)).toBe(100);
  });

  it("reads a committed numeric edit immediately when the workspace reopens", async () => {
    const first = await renderWorkspace();
    selectFirstObject(first.view.container);
    fireEvent.change(inspectorField(first.view.container, "X"), {
      target: { value: "300" },
    });
    await settle();
    const committed = currentNode(first.handle);
    expect(committed.tracks[0]?.channels.x?.[0]?.value).toBe(300);

    // Leave the workspace (a real unmount/dispose) and reopen it on the
    // persisted document.  The reopened preview must show the committed pose
    // with no edit and no override leaked from the previous session.
    cleanup();
    const renderKit = createRenderKit();
    previewApi.handler = () => Promise.resolve(readyPreview(committed));
    const handle: HostHandle = { state: null, backCalls: 0 };
    const view = render(
      <WorkspaceHost
        environment={renderKit.environment}
        onBack={() => {
          handle.backCalls += 1;
        }}
        onState={(state) => {
          handle.state = state;
        }}
        project={makeProject({ [NODE_ID]: committed })}
      />,
    );
    await waitForReady();
    stageRect(view.container);
    selectFirstObject(view.container);
    expect(gizmoLeft(view.container)).toBe("15.625%");
    expect(Number(inspectorField(view.container, "X").value)).toBe(300);
  });
});

describe("TimelineWorkspace playback context replacement", () => {
  const VIDEO_ASSET: EditorAsset = {
    id: "video.clip",
    kind: "video",
    path: "video/clip.mp4",
    absolute_path: "C:/game/video/clip.mp4",
  };

  const playbackFrames = new Map<number, (now: number) => void>();
  let playbackNow = 0;
  let playbackHandle = 0;

  /**
   * The preview clock runs on the browser frame source; pinning both the
   * frame callbacks and `performance.now` to one stepped clock makes a pass
   * advance by exactly the pumped deltas instead of the test process uptime.
   */
  function installPlaybackClock(): void {
    playbackFrames.clear();
    playbackNow = 0;
    playbackHandle = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: (now: number) => void): number => {
        playbackHandle += 1;
        playbackFrames.set(playbackHandle, callback);
        return playbackHandle;
      },
    );
    vi.stubGlobal("cancelAnimationFrame", (handle: number): void => {
      playbackFrames.delete(handle);
    });
    vi.spyOn(performance, "now").mockImplementation(() => playbackNow);
  }

  async function stepPlayback(
    pump: FramePump,
    deltaMs: number,
    times: number,
  ): Promise<void> {
    for (let index = 0; index < times; index += 1) {
      await act(async () => {
        await settle();
        playbackNow += deltaMs;
        const pending = [...playbackFrames.values()];
        playbackFrames.clear();
        for (const callback of pending) callback(playbackNow);
        // The preview surface's own render/cue clock follows the same step.
        pump.step(deltaMs);
      });
    }
  }

  interface PlaybackKit {
    environment: EditorPreviewEnvironment;
    pump: FramePump;
    dom: FakeMediaDom;
  }

  function createPlaybackKit(): PlaybackKit {
    const kit = createMemoryKit();
    const textures = createMemoryTextureLoader();
    const pump = createFramePump();
    const dom = createFakeMediaDom();
    return {
      environment: {
        kit: kit.kit,
        requestFrame: pump.request,
        cancelFrame: pump.cancel,
        textureLoader: textures.load,
        dom,
      },
      pump,
      dom,
    };
  }

  function playheadLabel(): string {
    return screen.getByText(/播放 \d+ · 起点 \d+ ms/).textContent ?? "";
  }

  async function startPlayback(pump: FramePump): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "播放" }));
      await settle();
      await settle();
    });
    await stepPlayback(pump, 100, 3);
    expect(playheadLabel()).toBe("播放 300 · 起点 0 ms");
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
  }

  function videoProject(node: TimelineNode): EditorProject {
    return {
      ...makeProject({ [NODE_ID]: node }),
      assets: [...ASSETS, VIDEO_ASSET],
    };
  }

  it("keeps a running pass alive when the edited duration grows", async () => {
    const playback = createPlaybackKit();
    const node = timelineNode();
    previewApi.handler = () => Promise.resolve(readyPreview(node));
    const project = makeProject({ [NODE_ID]: node });
    installPlaybackClock();
    const view = render(
      <WorkspaceHost
        environment={playback.environment}
        nodeOverride={node}
        onBack={() => undefined}
        onState={() => undefined}
        project={project}
      />,
    );
    await waitForReady();
    await startPlayback(playback.pump);

    // A duration edit (or an undo/redo of one) replaces the node while the
    // pass runs; the live clock must adopt the edited bound.
    const longer = timelineNode({ duration_ms: 3000 });
    view.rerender(
      <WorkspaceHost
        environment={playback.environment}
        nodeOverride={longer}
        onBack={() => undefined}
        onState={() => undefined}
        project={project}
      />,
    );
    await settle();
    await stepPlayback(playback.pump, 100, 12);
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
    await stepPlayback(playback.pump, 100, 20);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "播放" })).toBeInTheDocument(),
    );
    expect(playheadLabel()).toBe("播放 3000 · 起点 0 ms");
  });

  it("stops a running pass at a shortened edited duration", async () => {
    const playback = createPlaybackKit();
    const node = timelineNode({ duration_ms: 4000 });
    previewApi.handler = () => Promise.resolve(readyPreview(node));
    const project = makeProject({ [NODE_ID]: node });
    installPlaybackClock();
    const view = render(
      <WorkspaceHost
        environment={playback.environment}
        nodeOverride={node}
        onBack={() => undefined}
        onState={() => undefined}
        project={project}
      />,
    );
    await waitForReady();
    await startPlayback(playback.pump);

    const shorter = timelineNode({ duration_ms: 1000 });
    view.rerender(
      <WorkspaceHost
        environment={playback.environment}
        nodeOverride={shorter}
        onBack={() => undefined}
        onState={() => undefined}
        project={project}
      />,
    );
    await settle();
    await stepPlayback(playback.pump, 100, 8);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "播放" })).toBeInTheDocument(),
    );
    expect(playheadLabel()).toBe("播放 1000 · 起点 0 ms");
  });

  it("ends the pass when a resource edit reloads the preview", async () => {
    const playback = createPlaybackKit();
    const node = timelineNode();
    previewApi.handler = () => Promise.resolve(readyPreview(node));
    const project = videoProject(node);
    installPlaybackClock();
    render(
      <WorkspaceHost
        environment={playback.environment}
        nodeOverride={node}
        onBack={() => undefined}
        onState={() => undefined}
        project={project}
      />,
    );
    await waitForReady();
    await startPlayback(playback.pump);

    // Adding a video track changes the timeline's resource signature, so the
    // host reloads the context.  The reload must end the stale run (its clock
    // was built for the old cue) instead of letting it gate the replacement.
    fireEvent.change(screen.getByLabelText("新建轨道类型"), {
      target: { value: "video" },
    });
    fireEvent.click(screen.getByRole("button", { name: "＋轨道" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "播放" })).toBeInTheDocument(),
    );
    await waitFor(() => expect(playheadLabel()).toBe("播放 300 · 起点 0 ms"));
    expect(playback.dom.videos).toHaveLength(1);

    // No stale clock drives the replacement: pumping moves nothing and never
    // completes a phantom pass against the replaced cue.
    await stepPlayback(playback.pump, 100, 10);
    expect(playheadLabel()).toBe("播放 300 · 起点 0 ms");
    expect(screen.getByRole("button", { name: "播放" })).toBeInTheDocument();
  });

  it("ends a running pass when undo removes the video track", async () => {
    const playback = createPlaybackKit();
    const node = timelineNode();
    previewApi.handler = () => Promise.resolve(readyPreview(node));
    const project = videoProject(node);
    installPlaybackClock();
    render(
      <WorkspaceHost
        environment={playback.environment}
        onBack={() => undefined}
        onState={() => undefined}
        project={project}
      />,
    );
    await waitForReady();

    // A real history edit first: add the video track and let its media settle.
    fireEvent.change(screen.getByLabelText("新建轨道类型"), {
      target: { value: "video" },
    });
    fireEvent.click(screen.getByRole("button", { name: "＋轨道" }));
    await waitFor(() => expect(playback.dom.videos).toHaveLength(1));

    await startPlayback(playback.pump);

    // Undo reverts the authoritative document to a timeline without the video
    // track, which changes the resource signature again: the replacement must
    // end the run rather than run on the removed track's clock.
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "播放" })).toBeInTheDocument(),
    );
    await waitFor(() => expect(playheadLabel()).toBe("播放 300 · 起点 0 ms"));
    await stepPlayback(playback.pump, 100, 10);
    expect(playheadLabel()).toBe("播放 300 · 起点 0 ms");
  });

  it("does not re-fire the event at the exact cursor after an ordinary keyframe edit", async () => {
    const playback = createPlaybackKit();
    const events: TimelineNode["events"] = [
      { type: "sfx", id: "cursor", at_ms: 300, asset: "sfx.boom", volume: 1 },
      { type: "sfx", id: "future", at_ms: 900, asset: "sfx.boom", volume: 2 },
    ];
    const node = timelineNode({ events });
    previewApi.handler = () => Promise.resolve(readyPreview(node));
    const project = makeProject({ [NODE_ID]: node });
    installPlaybackClock();
    const playSfx = vi
      .spyOn(AudioManager.prototype, "playSfx")
      .mockResolvedValue(undefined);
    const view = render(
      <WorkspaceHost
        environment={playback.environment}
        nodeOverride={node}
        onBack={() => undefined}
        onState={() => undefined}
        project={project}
      />,
    );
    await waitForReady();
    // A preview starts silent; unmute so a crossed SFX reaches the audio port.
    fireEvent.click(screen.getByRole("button", { name: "取消静音" }));
    await settle();
    await startPlayback(playback.pump);
    expect(playSfx).toHaveBeenCalledTimes(1);

    // Pause exactly on the event cursor, then make an ordinary keyframe edit.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "暂停" }));
      await settle();
    });
    const edited = timelineNode({
      events,
      tracks: [
        {
          type: "sprite",
          sprite_id: "alice",
          asset: "sprite.alice",
          remove_at_end: false,
          channels: {
            x: [
              { at_ms: 0, value: 100, easing: "linear" },
              { at_ms: 1_000, value: 700, easing: "linear" },
            ],
            y: [{ at_ms: 0, value: 500, easing: "linear" }],
          },
        },
        { type: "camera", channels: {} },
      ],
    });
    view.rerender(
      <WorkspaceHost
        environment={playback.environment}
        nodeOverride={edited}
        onBack={() => undefined}
        onState={() => undefined}
        project={project}
      />,
    );
    await settle();

    // Resuming across the cursor must not re-fire the consumed event.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "播放" }));
      await settle();
      await settle();
    });
    await stepPlayback(playback.pump, 100, 1);
    expect(playSfx).toHaveBeenCalledTimes(1);
    // The event still ahead of the playhead keeps firing normally.
    await stepPlayback(playback.pump, 100, 5);
    expect(playSfx).toHaveBeenCalledTimes(2);
  });

  it("does not re-fire the event at the exact cursor while the pass keeps running", async () => {
    const playback = createPlaybackKit();
    const events: TimelineNode["events"] = [
      { type: "sfx", id: "cursor", at_ms: 300, asset: "sfx.boom", volume: 1 },
      { type: "sfx", id: "future", at_ms: 900, asset: "sfx.boom", volume: 2 },
    ];
    const node = timelineNode({ events });
    previewApi.handler = () => Promise.resolve(readyPreview(node));
    const project = makeProject({ [NODE_ID]: node });
    installPlaybackClock();
    const playSfx = vi
      .spyOn(AudioManager.prototype, "playSfx")
      .mockResolvedValue(undefined);
    const view = render(
      <WorkspaceHost
        environment={playback.environment}
        nodeOverride={node}
        onBack={() => undefined}
        onState={() => undefined}
        project={project}
      />,
    );
    await waitForReady();
    fireEvent.click(screen.getByRole("button", { name: "取消静音" }));
    await settle();
    await startPlayback(playback.pump);
    expect(playSfx).toHaveBeenCalledTimes(1);

    // An ordinary keyframe edit lands exactly on the event cursor while the
    // pass is still running.
    const edited = timelineNode({
      events,
      tracks: [
        {
          type: "sprite",
          sprite_id: "alice",
          asset: "sprite.alice",
          remove_at_end: false,
          channels: {
            x: [
              { at_ms: 0, value: 100, easing: "linear" },
              { at_ms: 1_000, value: 700, easing: "linear" },
            ],
            y: [{ at_ms: 0, value: 500, easing: "linear" }],
          },
        },
        { type: "camera", channels: {} },
      ],
    });
    view.rerender(
      <WorkspaceHost
        environment={playback.environment}
        nodeOverride={edited}
        onBack={() => undefined}
        onState={() => undefined}
        project={project}
      />,
    );
    await settle();
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
    await stepPlayback(playback.pump, 100, 1);
    expect(playSfx).toHaveBeenCalledTimes(1);
    await stepPlayback(playback.pump, 100, 5);
    expect(playSfx).toHaveBeenCalledTimes(2);
  });
});

describe("TimelineWorkspace creation asset policy", () => {
  const VIDEO_ASSET: EditorAsset = {
    id: "video.clip",
    kind: "video",
    path: "video/clip.mp4",
    absolute_path: "C:/game/video/clip.mp4",
  };
  const SFX_ASSET: EditorAsset = {
    id: "sfx.hit",
    kind: "sfx",
    path: "audio/hit.ogg",
    absolute_path: "C:/game/audio/hit.ogg",
  };

  function projectWith(extra: readonly EditorAsset[]): EditorProject {
    const project = makeProject({ [NODE_ID]: timelineNode() });
    return { ...project, assets: [...ASSETS, ...extra] };
  }

  function renderWorkspaceWith(
    project: EditorProject,
    layout?: EditorLayout,
    node = timelineNode(),
  ): { view: ReturnType<typeof render>; handle: HostHandle } {
    const renderKit = createRenderKit();
    previewApi.handler = () => Promise.resolve(readyPreview(node));
    const handle: HostHandle = { state: null, backCalls: 0 };
    const host = (
      <WorkspaceHost
        environment={renderKit.environment}
        onBack={() => {
          handle.backCalls += 1;
        }}
        onState={(state) => {
          handle.state = state;
        }}
        project={project}
      />
    );
    const view = render(
      layout === undefined ? (
        host
      ) : (
        <AssetLayoutProvider layout={layout}>{host}</AssetLayoutProvider>
      ),
    );
    return { view, handle };
  }

  function allHiddenLayout(assets: readonly EditorAsset[]): EditorLayout {
    return {
      version: 1,
      scenes: {},
      asset_metadata: Object.fromEntries(
        assets.map((asset) => [asset.id, { hidden: true }]),
      ),
    };
  }

  it("binds a newly created track to the selected inherited sprite", async () => {
    const node = timelineNode({ tracks: [] });
    const { view, handle } = renderWorkspaceWith(
      makeProject({ [NODE_ID]: node }),
      undefined,
      node,
    );
    await waitForReady();
    selectFirstObject(view.container);
    fireEvent.click(screen.getByRole("button", { name: "＋轨道" }));
    expect(currentNode(handle).tracks[0]).toMatchObject({
      type: "sprite",
      sprite_id: "alice",
      asset: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "＋轨道" }));
    expect(currentNode(handle).tracks).toHaveLength(1);
  });

  it("disables video/SFX creation for hidden assets and commits nothing", async () => {
    const project = projectWith([VIDEO_ASSET, SFX_ASSET]);
    const { handle } = renderWorkspaceWith(
      project,
      allHiddenLayout(project.assets),
    );
    await waitForReady();

    fireEvent.change(screen.getByLabelText("新建轨道类型"), {
      target: { value: "video" },
    });
    const addTrack = screen.getByRole("button", { name: "＋轨道" });
    expect(addTrack).toBeDisabled();
    fireEvent.click(addTrack);

    const sfx = screen.getByRole("button", { name: "＋SFX" });
    expect(sfx).toBeDisabled();
    expect(sfx).toHaveAttribute("title", expect.stringContaining("音效"));
    fireEvent.click(sfx);
    await settle();

    // No invalid empty asset row / event was written.
    expect(handle.state?.past).toHaveLength(0);
    expect(
      currentNode(handle).tracks.some((track) => track.type === "video"),
    ).toBe(false);
    expect(currentNode(handle).events).toHaveLength(0);
  });

  it("creates video tracks and SFX events with a real visible asset", async () => {
    const { handle } = renderWorkspaceWith(
      projectWith([VIDEO_ASSET, SFX_ASSET]),
    );
    await waitForReady();

    fireEvent.change(screen.getByLabelText("新建轨道类型"), {
      target: { value: "video" },
    });
    fireEvent.click(screen.getByRole("button", { name: "＋轨道" }));
    await settle();
    const video = currentNode(handle).tracks.find(
      (track) => track.type === "video",
    );
    expect(video).toMatchObject({ asset: "video.clip" });

    fireEvent.click(screen.getByRole("button", { name: "＋SFX" }));
    await settle();
    const event = currentNode(handle).events.find(
      (candidate) => candidate.type === "sfx",
    );
    expect(event).toMatchObject({ asset: "sfx.hit" });
  });
});

describe("TimelineWorkspace pending resource load supersession", () => {
  /** Every texture currently displayed by a memory sprite, in render order. */
  function spriteTextureUrls(renderKit: RenderKit): string[] {
    const urls: string[] = [];
    const visit = (value: unknown): void => {
      if (value instanceof MemorySprite)
        urls.push((value.texture as { url?: string }).url ?? value.label);
      const children = (value as { children?: unknown[] }).children;
      if (Array.isArray(children)) for (const child of children) visit(child);
    };
    for (const application of renderKit.kit.applications)
      visit(application.stage);
    return urls;
  }

  it("supersedes a pending load when an undo restores the previous signature", async () => {
    const loader = createDeferredLoader();
    const renderKit = createRenderKit(loader.load);
    const original = timelineNode();
    previewApi.handler = () => Promise.resolve(readyPreview(original));
    const handle: HostHandle = { state: null, backCalls: 0 };
    const project = makeProject({ [NODE_ID]: original });
    const renderHost = (override: TimelineNode | undefined): void => {
      view.rerender(
        <WorkspaceHost
          environment={renderKit.environment}
          nodeOverride={override}
          onBack={() => {
            handle.backCalls += 1;
          }}
          onState={(state) => {
            handle.state = state;
          }}
          project={project}
        />,
      );
    };
    const view = render(
      <WorkspaceHost
        environment={renderKit.environment}
        onBack={() => {
          handle.backCalls += 1;
        }}
        onState={(state) => {
          handle.state = state;
        }}
        project={project}
      />,
    );
    await waitFor(() =>
      expect(loader.pending.has("C:/game/sprite/alice.png")).toBe(true),
    );
    loader.release(["C:/game/sprite/alice.png"]);
    await waitFor(() =>
      expect(loader.pending.has("C:/game/bg/room.png")).toBe(true),
    );
    loader.release(["C:/game/bg/room.png"]);
    await waitForReady();
    expect(spriteTextureUrls(renderKit)).toContain("C:/game/sprite/alice.png");

    const withAsset = (asset: string): TimelineNode =>
      timelineNode({
        tracks: [
          {
            type: "sprite",
            sprite_id: "alice",
            asset,
            remove_at_end: false,
            channels: { x: [{ at_ms: 0, value: 100, easing: "linear" }] },
          },
          { type: "camera", channels: {} },
        ],
      });

    // Hot edit to a new artwork starts a deferred resource load.
    renderHost(withAsset("sprite.bob"));
    await waitFor(() =>
      expect(loader.pending.has("C:/game/sprite/bob.png")).toBe(true),
    );

    // The parent restores the previous signature (undo) while that load is
    // still awaiting its texture.  The newest cue must supersede the pending
    // load, so the old one can never commit its stale texture.
    renderHost(undefined);
    await settle();

    // Finish the superseded load first, then drain every follow-up texture.
    // If the pending load were allowed to commit, `bob` would appear in the
    // sprite's texture history even though the document is back on `alice`.
    loader.release(["C:/game/sprite/bob.png"]);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await settle();
      renderKit.pump.step();
      loader.release([...loader.pending.keys()]);
    }

    const urls = spriteTextureUrls(renderKit);
    expect(urls.at(-1)).toBe("C:/game/sprite/alice.png");
    expect(urls).not.toContain("C:/game/sprite/bob.png");
    expect(currentNode(handle).tracks[0]).toMatchObject({
      type: "sprite",
      asset: "sprite.alice",
    });
  });

  it("supersedes a pending load so a hot keyframe edit is not reverted", async () => {
    const loader = createDeferredLoader();
    const renderKit = createRenderKit(loader.load);
    const original = timelineNode();
    previewApi.handler = () => Promise.resolve(readyPreview(original));
    const handle: HostHandle = { state: null, backCalls: 0 };
    const project = makeProject({ [NODE_ID]: original });
    const renderHost = (override: TimelineNode | undefined): void => {
      view.rerender(
        <WorkspaceHost
          environment={renderKit.environment}
          nodeOverride={override}
          onBack={() => {
            handle.backCalls += 1;
          }}
          onState={(state) => {
            handle.state = state;
          }}
          project={project}
        />,
      );
    };
    const view = render(
      <WorkspaceHost
        environment={renderKit.environment}
        onBack={() => {
          handle.backCalls += 1;
        }}
        onState={(state) => {
          handle.state = state;
        }}
        project={project}
      />,
    );
    await waitFor(() =>
      expect(loader.pending.has("C:/game/sprite/alice.png")).toBe(true),
    );
    loader.release(["C:/game/sprite/alice.png"]);
    await waitFor(() =>
      expect(loader.pending.has("C:/game/bg/room.png")).toBe(true),
    );
    loader.release(["C:/game/bg/room.png"]);
    await waitForReady();
    stageRect(view.container);
    selectFirstObject(view.container);

    const withAsset = (asset: string): TimelineNode =>
      timelineNode({
        tracks: [
          {
            type: "sprite",
            sprite_id: "alice",
            asset,
            remove_at_end: false,
            channels: { x: [{ at_ms: 0, value: 100, easing: "linear" }] },
          },
          { type: "camera", channels: {} },
        ],
      });

    // Resource edit to a new artwork starts a deferred load.
    renderHost(withAsset("sprite.bob"));
    await waitFor(() =>
      expect(loader.pending.has("C:/game/sprite/bob.png")).toBe(true),
    );

    // A hot keyframe edit while that load is pending keeps the same resource
    // signature, so it can only survive if the newest cue supersedes the
    // pending load.  Otherwise the old load commits its own cue and reverts
    // the freshly typed value.
    fireEvent.change(inspectorField(view.container, "X"), {
      target: { value: "400" },
    });
    await settle();

    // Finish the superseded load and drain every follow-up texture.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await settle();
      renderKit.pump.step();
      loader.release([...loader.pending.keys()]);
    }

    expect(Number(inspectorField(view.container, "X").value)).toBe(400);
    expect(spriteTextureUrls(renderKit).at(-1)).toBe("C:/game/sprite/bob.png");
  });
});

describe("TimelineWorkspace shared gameplay buttons", () => {
  // A real `gui` artwork asset so the shared button resolves pixels exactly
  // like the game's `ButtonLayer` would.
  const GUI_ASSETS: EditorAsset[] = [
    {
      id: "gui.confirm",
      kind: "gui",
      path: "gui/confirm.png",
      absolute_path: "C:/game/gui/confirm.png",
    },
  ];

  function buttonSnapshot(
    overrides: Partial<ButtonSnapshot> = {},
  ): ButtonSnapshot {
    return {
      id: "confirm",
      template: "demo.separate",
      asset_mode: "separate",
      fit: "contain",
      normal: "gui.confirm",
      hover: null,
      pressed: null,
      animations: {
        normal: {
          duration_ms: 400,
          channels: {
            offset_x: [{ at_ms: 0, value: 12, easing: "linear" }],
          },
        },
      },
      x: 100,
      y: 200,
      width: 300,
      height: 120,
      rotation_deg: 0,
      scale_x: 1,
      scale_y: 1,
      opacity: 1,
      z: 2,
      visible: true,
      enabled: true,
      action: { sets: [] },
      ...overrides,
    };
  }

  function buttonNode(overrides: Partial<TimelineNode> = {}): TimelineNode {
    return timelineNode({
      tracks: [
        {
          type: "button",
          instance_id: "confirm",
          channels: {
            x: [
              { at_ms: 0, value: 100, easing: "linear" },
              { at_ms: 1000, value: 900, easing: "linear" },
            ],
            y: [{ at_ms: 0, value: 200, easing: "linear" }],
          },
        },
        { type: "camera", channels: {} },
      ],
      ...overrides,
    });
  }

  async function renderButtons(
    buttons: Record<string, ButtonSnapshot>,
    node: TimelineNode = buttonNode(),
  ): Promise<{
    view: ReturnType<typeof render>;
    handle: HostHandle;
    onChangeSpy: ReturnType<typeof vi.fn>;
  }> {
    const renderKit = createRenderKit();
    const project: EditorProject = {
      ...makeProject({ [NODE_ID]: node }),
      assets: [...ASSETS, ...GUI_ASSETS],
    };
    previewApi.handler = () =>
      Promise.resolve(readyPreview(node, { snapshot: { buttons } }));
    const handle: HostHandle = { state: null, backCalls: 0 };
    const onChangeSpy = vi.fn<(next: TimelineNode) => void>();
    const view = render(
      <WorkspaceHost
        environment={renderKit.environment}
        onBack={() => {
          handle.backCalls += 1;
        }}
        onChangeSpy={onChangeSpy}
        onState={(state) => {
          handle.state = state;
        }}
        project={project}
      />,
    );
    await waitForReady();
    stageRect(view.container);
    return { view, handle, onChangeSpy };
  }

  function previewButton(container: HTMLElement): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      ".timeline-button-layer .scene-button",
    );
  }

  it("renders evaluated buttons through the real shared gameplay component", async () => {
    const { view } = await renderButtons({ confirm: buttonSnapshot() });
    const button = previewButton(view.container);
    if (button === null) throw new Error("共享按钮未渲染");

    // Real shared component + state machine class, never interactive.
    expect(button.className).toContain("scene-button");
    expect(button.className).toContain("scene-button-normal");
    expect(button.disabled).toBe(true);
    // The overlay never steals pointer events from the gizmos.
    expect(button.style.pointerEvents).toBe("none");

    // Placement is the session-evaluated frame, not the raw snapshot geometry.
    expect(button.style.left).toBe(`${(100 / 1920) * 100}%`);
    expect(button.style.top).toBe(`${(200 / 1080) * 100}%`);
    expect(button.style.width).toBe(`${(300 / 1920) * 100}%`);
    expect(button.style.height).toBe(`${(120 / 1080) * 100}%`);

    // Artwork and `fit` come from the live runtime scene context.
    const image = button.querySelector<HTMLImageElement>(
      "img.scene-button-image",
    );
    expect(image?.getAttribute("src")).toBe("C:/game/gui/confirm.png");
    expect(image?.style.objectFit).toBe("contain");

    // The shared state machine's animation channels are applied (paused at 0).
    const visual = button.querySelector<HTMLElement>(".scene-button-visual");
    expect(visual?.style.transform).toContain("translate3d(12px, 0px, 0)");

    // No hand-built artwork layer survives.
    expect(view.container.querySelector(".timeline-button-preview")).toBeNull();
  });

  it("follows the session playhead deterministically when scrubbing", async () => {
    const { view } = await renderButtons({ confirm: buttonSnapshot() });
    const button = previewButton(view.container);
    if (button === null) throw new Error("共享按钮未渲染");
    expect(button.style.left).toBe(`${(100 / 1920) * 100}%`);

    fireEvent.change(screen.getByLabelText("时间线播放头"), {
      target: { value: "1000" },
    });
    await waitFor(() =>
      expect(button.style.left).toBe(`${(900 / 1920) * 100}%`),
    );

    fireEvent.change(screen.getByLabelText("时间线播放头"), {
      target: { value: "0" },
    });
    await waitFor(() =>
      expect(button.style.left).toBe(`${(100 / 1920) * 100}%`),
    );
  });

  it("keeps gizmo drag and keyframe writes for button tracks", async () => {
    const { view, handle, onChangeSpy } = await renderButtons({
      confirm: buttonSnapshot(),
    });
    // Select the button itself (the runtime context also seeds a sprite).
    const list = view.container.querySelector(".timeline-object-list");
    if (list === null) throw new Error("缺少对象列表");
    fireEvent.click(
      within(list as HTMLElement).getByRole("button", { name: /confirm/ }),
    );
    dragGizmo(selectedGizmo(view.container), 96);
    expect(onChangeSpy).toHaveBeenCalledTimes(1);

    const track = currentNode(handle).tracks.find(
      (candidate) => candidate.type === "button",
    );
    expect(track?.channels.x).toEqual([
      { at_ms: 0, value: 196, easing: "linear" },
      { at_ms: 1000, value: 900, easing: "linear" },
    ]);

    // The shared button follows the committed keyframe.
    const button = previewButton(view.container);
    await waitFor(() =>
      expect(button?.style.left).toBe(`${(196 / 1920) * 100}%`),
    );
  });

  it("hides the shared artwork for an invisible runtime instance but keeps the gizmo", async () => {
    const { view } = await renderButtons({
      confirm: buttonSnapshot({ visible: false }),
    });
    expect(previewButton(view.container)).toBeNull();
    expect(view.container.querySelector(".timeline-gizmo")).not.toBeNull();
  });

  it("renders no shared artwork for an instance missing from the runtime context", async () => {
    const { view } = await renderButtons({});
    expect(previewButton(view.container)).toBeNull();
    const list = view.container.querySelector(".timeline-object-list");
    if (list === null) throw new Error("缺少对象列表");
    expect(
      within(list as HTMLElement).getByRole("button", { name: /confirm/ }),
    ).toBeInTheDocument();
  });
});
