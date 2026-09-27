// @vitest-environment jsdom
/**
 * TimelineWorkspace lifecycle tests (Strict Mode, init cancellation, repeated
 * workspace switches).
 *
 * These assert on the *resources* the real ownership code holds — decoded
 * texture references, media elements and their listeners, the render loop's
 * animation frame, and the single WebGL application — rather than on
 * `DeferredSession` instance counts alone.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  StrictMode,
  useEffect,
  useReducer,
  useState,
  type ReactElement,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RuntimeSnapshot,
  RuntimeUpdate,
} from "@vectspace/presentation-core/types";
import type {
  BuildNodePreviewResult,
  EditorAsset,
  EditorProject,
  TimelineNode,
  TimelineTrack,
} from "../types";
import { editorReducer, INITIAL_EDITOR_STATE } from "../editorHistory";
import { findScene } from "../story";
import type { SceneKit } from "@vectspace/presentation-core/scene-surface";
import {
  MemorySprite,
  createFramePump,
  createMemoryKit,
  createMemoryTextureLoader,
} from "@vectspace/presentation-core/scene-test-kit";
import {
  createFakeMediaDom,
  type FakeMediaDom,
} from "@vectspace/presentation-core/session-test-kit";
import type { EditorPreviewEnvironment } from "./timelinePreview";
import { TimelineWorkspace } from "./TimelineWorkspace";

type ReadyPreview = Extract<BuildNodePreviewResult, { status: "ready" }>;

const previewApi = vi.hoisted(() => ({
  handler: null as null | ((request: unknown) => Promise<ReadyPreview>),
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
  {
    id: "video.clip",
    kind: "video",
    path: "video/clip.mp4",
    absolute_path: "C:/game/video/clip.mp4",
  },
];

const VIDEO_TRACK: TimelineTrack = {
  type: "video",
  asset: "video.clip",
  clip_start_ms: 0,
  clip_end_ms: null,
  loop: false,
  fit: "contain",
  audio_enabled: true,
  channels: {},
};

function timelineNode(
  spriteId: string,
  asset: string,
  overrides: Partial<TimelineNode> = {},
): TimelineNode {
  return {
    type: "timeline",
    duration_ms: 1000,
    await: true,
    skippable: true,
    tracks: [
      {
        type: "sprite",
        sprite_id: spriteId,
        asset,
        remove_at_end: false,
        channels: { x: [{ at_ms: 0, value: 100, easing: "linear" }] },
      },
      { type: "camera", channels: {} },
      VIDEO_TRACK,
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

function snapshot(node: TimelineNode): RuntimeSnapshot {
  const sprite = node.tracks.find((track) => track.type === "sprite");
  const spriteId = sprite?.type === "sprite" ? sprite.sprite_id : "alice";
  const spriteAsset = sprite?.type === "sprite" ? (sprite.asset ?? "") : "";
  const background = spriteId === "bob" ? "bg.other" : "bg.room";
  return {
    session_id: "1",
    mode: "story",
    revision: "1",
    location: { scene_id: SCENE_ID, node_id: NODE_ID },
    variables: {},
    world: {
      background,
      sprites: {
        [spriteId]: {
          asset: spriteAsset,
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
      buttons: {},
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

function readyPreview(node: TimelineNode): ReadyPreview {
  const start = snapshot(node);
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
    trace: [{ scene_id: SCENE_ID, node_id: NODE_ID }],
  };
}

function SwitchHost({
  baseProject,
  environment,
}: {
  baseProject: EditorProject;
  environment: EditorPreviewEnvironment;
}): ReactElement {
  const [state, dispatch] = useReducer(editorReducer, INITIAL_EDITOR_STATE);
  const [nodeId, setNodeId] = useState(NODE_ID);
  useEffect(() => {
    dispatch({ type: "load", project: baseProject });
  }, [baseProject]);
  if (state.project === null) {
    return <div>载入中</div>;
  }
  const node = findScene(state.project, SCENE_ID)?.definition.nodes[nodeId] as
    TimelineNode | undefined;
  if (node === undefined) return <div>缺失节点</div>;
  return (
    <>
      <button
        onClick={() => {
          setNodeId((current) =>
            current === NODE_ID ? OTHER_NODE_ID : NODE_ID,
          );
        }}
        type="button"
      >
        切换工作区
      </button>
      <TimelineWorkspace
        assets={state.project.assets}
        dirty={false}
        futureAvailable={false}
        importTokens={[]}
        node={node}
        nodeId={nodeId}
        onBack={() => undefined}
        onChange={() => undefined}
        onError={() => undefined}
        onPreviewSettingsChange={() => undefined}
        onRedo={() => undefined}
        onSave={() => undefined}
        onUndo={() => undefined}
        previewEnvironment={environment}
        previewSettings={undefined}
        project={state.project}
        sceneId={SCENE_ID}
      />
    </>
  );
}

interface LifecycleKit {
  environment: EditorPreviewEnvironment;
  kit: ReturnType<typeof createMemoryKit>;
  textures: ReturnType<typeof createMemoryTextureLoader>;
  dom: FakeMediaDom;
  pump: ReturnType<typeof createFramePump>;
  videoSprites: MemorySprite[];
  videoSources: { destroyed: number }[];
}

function createLifecycleKit(): LifecycleKit {
  const kit = createMemoryKit();
  const textures = createMemoryTextureLoader();
  const dom = createFakeMediaDom();
  const pump = createFramePump();
  const videoSprites: MemorySprite[] = [];
  const videoSources: { destroyed: number }[] = [];
  const base = kit.kit;
  const wrapped: SceneKit = {
    ...base,
    videoSource: (element) => {
      const source = base.videoSource(element);
      const record = { destroyed: 0 };
      const original = source.destroy.bind(source);
      source.destroy = (): void => {
        record.destroyed += 1;
        original();
      };
      videoSources.push(record);
      return source;
    },
    videoSprite: (source) => {
      const sprite = base.videoSprite(source) as MemorySprite;
      videoSprites.push(sprite);
      return sprite;
    },
  };
  return {
    environment: {
      kit: wrapped,
      requestFrame: pump.request,
      cancelFrame: pump.cancel,
      textureLoader: textures.load,
      dom,
    },
    kit,
    textures,
    dom,
    pump,
    videoSprites,
    videoSources,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForReady(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByText(/已捕获真实进入状态/)).toBeInTheDocument(),
  );
}

function gizmoLabels(): string[] {
  return [...document.querySelectorAll(".timeline-gizmo span")].map(
    (element) => element.textContent ?? "",
  );
}

beforeEach(() => {
  previewApi.handler = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TimelineWorkspace lifecycle", () => {
  it("keeps one session across the Strict Mode probe and returns every resource to baseline after 30 workspace switches", async () => {
    const lifecycle = createLifecycleKit();
    const alice = timelineNode("alice", "sprite.alice");
    const bob = timelineNode("bob", "sprite.bob");
    const project = makeProject({ [NODE_ID]: alice, [OTHER_NODE_ID]: bob });
    previewApi.handler = (request) => {
      const target = request as { target: { node_id: string } };
      return Promise.resolve(
        readyPreview(target.target.node_id === OTHER_NODE_ID ? bob : alice),
      );
    };

    const view = render(
      <StrictMode>
        <SwitchHost baseProject={project} environment={lifecycle.environment} />
      </StrictMode>,
    );
    await waitForReady();
    // Strict Mode probes the effect with setup → cleanup → setup; the shared
    // lifecycle reclaims the initialized application instead of rebuilding it.
    expect(lifecycle.kit.applications).toHaveLength(1);
    expect(lifecycle.kit.applications[0]?.destroyed).toBe(false);

    const switchButton = screen.getByRole("button", { name: "切换工作区" });
    for (let index = 0; index < 30; index += 1) {
      switchButton.click();
      await waitFor(() => {
        expect(gizmoLabels()).toContain(index % 2 === 0 ? "bob" : "alice");
      });
    }
    // The switches reused the same application and session.
    expect(lifecycle.kit.applications).toHaveLength(1);
    // Every superseded media element was released with its listeners.
    const videos = lifecycle.dom.videos;
    expect(videos.length).toBeGreaterThan(30);
    expect(
      videos
        .slice(0, -1)
        .every((video) => video.released && video.listenerCount() === 0),
    ).toBe(true);
    expect(videos.at(-1)?.released).toBe(false);

    view.unmount();
    // The shared lifecycle disposes one task after the last release.
    await settle();
    await settle();

    expect(lifecycle.kit.applications[0]?.destroyed).toBe(true);
    expect(lifecycle.pump.pending()).toBe(0);
    expect(lifecycle.textures.loaded.length).toBeGreaterThan(0);
    expect(lifecycle.textures.destroyed.length).toBe(
      lifecycle.textures.loaded.length,
    );
    expect(
      lifecycle.textures.loaded.every((texture) => texture.destroyed),
    ).toBe(true);
    expect(
      videos.every((video) => video.released && video.listenerCount() === 0),
    ).toBe(true);
    // The video views/sources the surface created were released exactly once.
    expect(lifecycle.videoSprites.every((sprite) => sprite.destroyed)).toBe(
      true,
    );
    expect(
      lifecycle.videoSources.every((source) => source.destroyed === 1),
    ).toBe(true);

    // No frame callback survives the teardown: pumping re-renders nothing.
    const renders = lifecycle.kit.renderCount();
    for (let frame = 0; frame < 3; frame += 1) {
      lifecycle.pump.step(16);
      await settle();
    }
    expect(lifecycle.kit.renderCount()).toBe(renders);
  });

  it("waits for a cancelled initialization and still releases the session", async () => {
    const lifecycle = createLifecycleKit();
    const initGate = { started: false, release: (): void => undefined };
    const base = lifecycle.kit.kit;
    const kit: SceneKit = {
      ...base,
      application: () => {
        const application = base.application();
        const original = application.init.bind(application);
        application.init = (options) =>
          new Promise((resolve) => {
            initGate.started = true;
            initGate.release = () => {
              void original(options).then(resolve);
            };
          });
        return application;
      },
    };
    const environment = { ...lifecycle.environment, kit };
    const node = timelineNode("alice", "sprite.alice");
    previewApi.handler = () => Promise.resolve(readyPreview(node));
    const view = render(
      <StrictMode>
        <SwitchHost
          baseProject={makeProject({ [NODE_ID]: node })}
          environment={environment}
        />
      </StrictMode>,
    );
    await waitFor(() => expect(initGate.started).toBe(true));

    // Unmount while initialization is still running: the deferred disposal
    // must wait for it instead of leaking the half-built session.
    view.unmount();
    await settle();
    expect(lifecycle.kit.applications[0]?.destroyed).toBe(false);
    initGate.release();
    await settle();
    await settle();

    expect(lifecycle.kit.applications).toHaveLength(1);
    expect(lifecycle.kit.applications[0]?.destroyed).toBe(true);
    expect(lifecycle.pump.pending()).toBe(0);
    expect(lifecycle.textures.loaded).toEqual([]);
    expect(lifecycle.dom.videos).toEqual([]);
  });

  it("leaves no resources behind across 30 mount/unmount cycles", async () => {
    const lifecycle = createLifecycleKit();
    const node = timelineNode("alice", "sprite.alice");
    const project = makeProject({ [NODE_ID]: node });
    previewApi.handler = () => Promise.resolve(readyPreview(node));
    for (let index = 0; index < 30; index += 1) {
      const view = render(
        <StrictMode>
          <SwitchHost
            baseProject={project}
            environment={lifecycle.environment}
          />
        </StrictMode>,
      );
      await waitForReady();
      view.unmount();
      await settle();
    }
    // This host creates one session per mount; every one of them must be gone.
    expect(lifecycle.kit.applications).toHaveLength(30);
    expect(lifecycle.kit.applications.every((app) => app.destroyed)).toBe(true);
    expect(lifecycle.pump.pending()).toBe(0);
    expect(lifecycle.textures.loaded.length).toBeGreaterThan(0);
    expect(
      lifecycle.textures.loaded.every((texture) => texture.destroyed),
    ).toBe(true);
    expect(lifecycle.dom.videos.every((video) => video.released)).toBe(true);
    expect(
      lifecycle.dom.videos.every((video) => video.listenerCount() === 0),
    ).toBe(true);
  }, 15_000);
});
