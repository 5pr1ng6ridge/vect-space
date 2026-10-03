// @vitest-environment jsdom
/**
 * Editor gameplay preview tests.
 *
 * These drive the real DialogueBox / LongTextPanel / ChoiceLayer / ButtonLayer
 * components (only the Pixi canvas and the Rust IPC boundary are mocked) so the
 * assertions cover what an author actually sees and can click: dialogue text,
 * long-text panel, choice options, UI buttons, presentation acknowledgements,
 * the three start modes, branch selection, restart cleanup and stale-response
 * isolation.
 */
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  ChoicePrompt,
  LongTextPageSnapshot,
  RuntimeSnapshot,
  RuntimeUpdate,
} from "@vectspace/presentation-core/types";

import type { EditorProject } from "../types";
import { GameplayPreview } from "./GameplayPreview";

const host = vi.hoisted(() => ({
  startRequests: [] as unknown[],
  start: null as null | ((request: unknown) => Promise<unknown>),
  advance: null as null | ((request: unknown) => Promise<unknown>),
  choose: null as null | ((request: unknown) => Promise<unknown>),
  clickButton: null as null | ((request: unknown) => Promise<unknown>),
  ack: null as null | ((request: unknown) => Promise<unknown>),
  tick: null as null | ((sessionId: string) => Promise<unknown>),
  stopCalls: [] as string[],
  cancels: 0,
  skips: 0,
  canvasProps: null as null | {
    update: RuntimeUpdate | null;
    effects?: RuntimeUpdate[];
    activeTimers?: string[] | null;
    assets: Record<string, string>;
    onSettled(update: RuntimeUpdate, outcome: string): void;
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: vi.fn(),
}));

vi.mock("@vectspace/presentation-react/gameplay", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@vectspace/presentation-react/gameplay")
    >();
  const { forwardRef, useImperativeHandle } = await import("react");
  // The WebGL surface needs a real GPU; the controller logic itself is
  // covered by the package's own tests.  The stub records props and exposes
  // the imperative handle so cancellation/skip can be asserted.
  const SceneCanvas = forwardRef<unknown, Record<string, unknown>>(
    function SceneCanvasStub(props, ref) {
      host.canvasProps = props as typeof host.canvasProps;
      useImperativeHandle(
        ref,
        () => ({
          captureThumbnail: () => null,
          unlockAudio: () => Promise.resolve(),
          skipCurrentPresentation: () => {
            host.skips += 1;
            return true;
          },
          cancelCurrentPresentation: () => {
            host.cancels += 1;
          },
          applySnapshotImmediately: () => Promise.resolve(),
          coverSession: () => Promise.resolve(),
          revealSession: () => Promise.resolve(),
          applySessionSnapshot: () => Promise.resolve(),
          isPresentationCurrent: () => true,
        }),
        [],
      );
      return null;
    },
  );
  return { ...actual, SceneCanvas };
});

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    editorApi: {
      ...actual.editorApi,
      previewSessionStart: (request: unknown) => {
        host.startRequests.push(request);
        return required(host.start, "start")(request);
      },
      previewSessionAdvance: (request: unknown) =>
        required(host.advance, "advance")(request),
      previewSessionChoose: (request: unknown) =>
        required(host.choose, "choose")(request),
      previewSessionClickButton: (request: unknown) =>
        required(host.clickButton, "clickButton")(request),
      previewSessionPresentationComplete: (request: unknown) =>
        required(host.ack, "ack")(request),
      previewSessionTick: (sessionId: string) =>
        required(host.tick, "tick")(sessionId),
      previewSessionStop: (sessionId: string) => {
        host.stopCalls.push(sessionId);
        return Promise.resolve(true);
      },
    },
  };
});

function required<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`测试没有注册 ${name} 处理器`);
  return value;
}

interface PreviewFontFace {
  family: string;
  source: string;
  load(): Promise<void>;
  resolve(): void;
  reject(reason: unknown): void;
}

interface PreviewFontEnv {
  faces: PreviewFontFace[];
  added: PreviewFontFace[];
  deleted: PreviewFontFace[];
  restore(): void;
}

const fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
let fontEnv: PreviewFontEnv | null = null;

/** Install a controllable `FontFace` + `document.fonts` into jsdom. */
function installPreviewFontFace(): PreviewFontEnv {
  const faces: PreviewFontFace[] = [];
  const added: PreviewFontFace[] = [];
  const deleted: PreviewFontFace[] = [];

  class StubFontFace implements PreviewFontFace {
    family: string;
    source: string;
    private readonly promise: Promise<void>;
    private settleLoad!: () => void;
    private settleReject!: (reason: unknown) => void;

    constructor(family: string, source: string) {
      this.family = family;
      this.source = source;
      this.promise = new Promise<void>((resolve, reject) => {
        this.settleLoad = resolve;
        this.settleReject = reject;
      });
      faces.push(this);
    }

    load(): Promise<void> {
      return this.promise;
    }

    resolve(): void {
      this.settleLoad();
    }

    reject(reason: unknown): void {
      this.settleReject(reason);
    }
  }

  (globalThis as { FontFace?: unknown }).FontFace = StubFontFace;
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      add: (face: PreviewFontFace) => added.push(face),
      delete: (face: PreviewFontFace) => deleted.push(face),
      ready: Promise.resolve(),
    },
  });

  fontEnv = {
    faces,
    added,
    deleted,
    restore(): void {
      delete (globalThis as { FontFace?: unknown }).FontFace;
      if (fontsDescriptor === undefined) {
        delete (document as { fonts?: unknown }).fonts;
      } else {
        Object.defineProperty(document, "fonts", fontsDescriptor);
      }
    },
  };
  return fontEnv;
}

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe(): void {
      /* jsdom has no layout to observe */
    }
    unobserve(): void {
      /* jsdom has no layout to observe */
    }
    disconnect(): void {
      /* jsdom has no layout to observe */
    }
  };
});

beforeEach(() => {
  host.startRequests = [];
  host.stopCalls = [];
  host.cancels = 0;
  host.skips = 0;
  host.canvasProps = null;
  host.start = () => Promise.reject(new Error("no start handler"));
  host.advance = () => Promise.reject(new Error("no advance handler"));
  host.choose = () => Promise.reject(new Error("no choose handler"));
  host.clickButton = () => Promise.reject(new Error("no click handler"));
  host.ack = () => Promise.reject(new Error("no ack handler"));
  host.tick = () =>
    Promise.resolve({ updates: [], notes: [], diagnostics: [] });
});

afterEach(() => {
  // Unmount first so the hook's cleanup deletes its face against the stub,
  // then restore the jsdom globals for the next test.
  cleanup();
  fontEnv?.restore();
  fontEnv = null;
});

function world(overrides: Partial<RuntimeSnapshot["world"]> = {}) {
  return {
    background: null,
    sprites: {},
    buttons: {},
    camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
    dialogue_ui_visible: true,
    ui_motion_bindings: {},
    persistent_effects: [],
    ...overrides,
  };
}

function dialogueUpdate(revision = "1", requiresAck = false): RuntimeUpdate {
  const prompt = {
    kind: "dialogue" as const,
    prompt_id: "main/say",
    speaker: "爱丽丝",
    text: "你好，世界 $a^2$",
    is_read: false,
  };
  return {
    update_id: revision,
    requires_ack: requiresAck,
    cues: [],
    snapshot: {
      revision,
      location: { scene_id: "main", node_id: "say" },
      variables: {},
      world: world(),
      audio: { bgm: null },
      playback: { auto: "normal", ctrl_fast_forward: "allow" },
      prompt,
      dialogue_page: {
        page_id: "main/say",
        speaker: "爱丽丝",
        segments: ["你好，世界 $a^2$"],
      },
    },
  };
}

function longTextUpdate(revision = "1"): RuntimeUpdate {
  const page: LongTextPageSnapshot = {
    document_id: "main/doc",
    visible: true,
    paper: null,
    pagination: "auto",
    font_size: 32,
    text_color: "#212533",
    layout: {
      x: 240,
      y: 180,
      width: 1440,
      height: 720,
      padding_x: 40,
      padding_y: 32,
      page_height: 640,
      page_gap: 24,
    },
    steps: [{ step_id: "s1", text: "长文本步骤一", page_break_before: false }],
    active_step_index: 0,
  };
  return {
    update_id: revision,
    requires_ack: false,
    cues: [],
    snapshot: {
      revision,
      location: { scene_id: "main", node_id: "doc" },
      variables: {},
      world: world(),
      audio: { bgm: null },
      playback: { auto: "normal", ctrl_fast_forward: "allow" },
      prompt: {
        kind: "long_text",
        prompt_id: "main/doc/s1",
        document_id: "main/doc",
        step_id: "s1",
        step_index: 0,
        text: "长文本步骤一",
        is_read: false,
      },
      long_text_page: page,
    },
  };
}

function choicePrompt(): ChoicePrompt {
  return {
    kind: "choice",
    prompt_id: "main/route",
    layout: {
      stage_width: 1920,
      stage_height: 1080,
      anchor_x: 960,
      anchor_y: 540,
      direction: "vertical",
      gap: 20,
      x: 470,
      y: 382,
      width: 980,
      height: 316,
    },
    diagnostics: [],
    choices: [
      {
        id: "left",
        label: "向左",
        enabled: true,
        icon: null,
        template: { kind: "fallback" },
        x: 470,
        y: 382,
        width: 980,
        height: 92,
      },
      {
        id: "right",
        label: "向右",
        enabled: true,
        icon: null,
        template: { kind: "fallback" },
        x: 470,
        y: 494,
        width: 980,
        height: 92,
      },
    ],
  };
}

function choiceUpdate(revision = "1"): RuntimeUpdate {
  return {
    update_id: revision,
    requires_ack: false,
    cues: [],
    snapshot: {
      revision,
      location: { scene_id: "main", node_id: "route" },
      variables: {},
      world: world(),
      audio: { bgm: null },
      playback: { auto: "normal", ctrl_fast_forward: "allow" },
      prompt: choicePrompt(),
    },
  };
}

function buttonUpdate(revision = "1"): RuntimeUpdate {
  return {
    update_id: revision,
    requires_ack: false,
    cues: [],
    snapshot: {
      revision,
      location: { scene_id: "main", node_id: "panel" },
      variables: {},
      world: world({
        buttons: {
          "btn.menu": {
            id: "btn.menu",
            template: "button.primary",
            asset_mode: "separate",
            fit: "stretch",
            normal: null,
            hover: null,
            pressed: null,
            animations: {},
            x: 100,
            y: 100,
            width: 200,
            height: 80,
            rotation_deg: 0,
            scale_x: 1,
            scale_y: 1,
            opacity: 1,
            z: 1,
            visible: true,
            enabled: true,
            action: { sets: [], next: null },
          },
        },
      }),
      audio: { bgm: null },
      playback: { auto: "normal", ctrl_fast_forward: "allow" },
      prompt: { kind: "none" },
    },
  };
}

function project(): EditorProject {
  return {
    root: "C:/project/game",
    fingerprint: "test",
    manifest: {
      schema_version: 2,
      content_version: "test",
      entry_scene: "main",
      default_locale: "zh-CN",
      variables: {},
      characters: {},
      assets: {},
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
          entry: "say",
          nodes: { say: { type: "end" }, route: { type: "end" } },
        },
      },
    ],
    ui_motions: [],
    layout: { version: 1, scenes: {} },
    assets: [],
    diagnostics: [],
  };
}

/** The same project with a declared gameplay font so the loader is exercised. */
function projectWithFont(): EditorProject {
  const base = project();
  return {
    ...base,
    manifest: { ...base.manifest, default_font: "font.fusion_pixel" },
    assets: [
      {
        id: "font.fusion_pixel",
        kind: "font",
        absolute_path: "C:/project/game/fonts/pixel.ttf",
      },
    ],
  };
}

function started(update: RuntimeUpdate, sessionId = "7", notes?: string[]) {
  return {
    status: "started" as const,
    session_id: sessionId,
    update,
    assets: [],
    ...(notes === undefined ? {} : { notes }),
  };
}

/** The same update with window interaction state attached to its snapshot. */
function withInteraction(
  update: RuntimeUpdate,
  interaction: NonNullable<RuntimeSnapshot["interaction"]>,
  kind?: RuntimeUpdate["kind"],
  patch: Partial<RuntimeUpdate> = {},
): RuntimeUpdate {
  return {
    ...update,
    ...(kind === undefined ? {} : { kind }),
    ...patch,
    snapshot: { ...update.snapshot, interaction },
  };
}

function withUpdateId(update: RuntimeUpdate, updateId: string): RuntimeUpdate {
  return { ...update, update_id: updateId };
}

function autoUpdate(
  auto: "normal" | "forced",
  text: string,
  revision = "1",
): RuntimeUpdate {
  const base = dialogueUpdate(revision);
  return {
    ...base,
    snapshot: {
      ...base.snapshot,
      playback: { auto, ctrl_fast_forward: "allow" },
      prompt: {
        kind: "dialogue",
        prompt_id: "main/say",
        speaker: "爱丽丝",
        text,
        is_read: false,
      },
      dialogue_page: {
        page_id: "main/say",
        speaker: "爱丽丝",
        segments: [text],
      },
    },
  };
}

function renderPreview(nodeId: string | null = "say") {
  return render(
    <GameplayPreview
      importTokens={[]}
      nodeId={nodeId}
      onError={() => undefined}
      project={project()}
      sceneId="main"
    />,
  );
}

async function startScene(update = dialogueUpdate()): Promise<void> {
  if (host.canvasProps === null) renderPreview();
  host.start = () => Promise.resolve(started(update));
  fireEvent.click(screen.getByRole("button", { name: "从场景入口开始" }));
  await waitFor(() =>
    expect(host.canvasProps?.update?.snapshot.revision).toBe(
      update.snapshot.revision,
    ),
  );
}

describe("GameplayPreview", () => {
  it("starts at the scene entry and renders the live dialogue box", async () => {
    await startScene();
    const request = host.startRequests[0] as { mode: string; scene_id: string };
    expect(request.mode).toBe("scene");
    expect(request.scene_id).toBe("main");
    expect(document.querySelector(".dialogue-box")).not.toBeNull();
    expect(
      document.querySelector(".dialogue-text")?.textContent ?? "",
    ).toContain("你好，世界");
  });

  it("starts from the selected node, and can reset directly at it", async () => {
    await startScene();
    host.start = () => Promise.resolve(started(dialogueUpdate("2")));
    fireEvent.click(screen.getByRole("button", { name: "从所选节点开始" }));
    await waitFor(() =>
      expect((host.startRequests[1] as { mode: string }).mode).toBe("node"),
    );
    expect((host.startRequests[1] as { node_id: string }).node_id).toBe("say");

    fireEvent.click(screen.getByRole("button", { name: "重置并从此节点开始" }));
    await waitFor(() =>
      expect((host.startRequests[2] as { mode: string }).mode).toBe(
        "reset_node",
      ),
    );
  });

  it("renders the shared long-text panel for a long_text prompt", async () => {
    await startScene(longTextUpdate());
    expect(document.querySelector(".long-text-panel")).not.toBeNull();
  });

  it("advances with the live revision", async () => {
    await startScene();
    const advanceCalls: unknown[] = [];
    host.advance = (request) => {
      advanceCalls.push(request);
      return Promise.resolve(dialogueUpdate("2"));
    };
    fireEvent.click(screen.getByRole("button", { name: "推进 / 完成打字" }));
    // The first click completes the running typewriter reveal; a second click
    // issues the runtime advance, exactly like gameplay.
    fireEvent.click(screen.getByRole("button", { name: "推进 / 完成打字" }));
    await waitFor(() => expect(advanceCalls.length).toBeGreaterThan(0));
    expect(
      (advanceCalls[0] as { expected_revision: string }).expected_revision,
    ).toBe("1");
  });

  it("dispatches a real choice and a UI button click", async () => {
    await startScene(choiceUpdate());
    const chooseCalls: unknown[] = [];
    host.choose = (request) => {
      chooseCalls.push(request);
      return Promise.resolve(dialogueUpdate("2"));
    };
    fireEvent.click(await screen.findByRole("button", { name: "向左" }));
    await waitFor(() => expect(chooseCalls).toHaveLength(1));
    expect((chooseCalls[0] as { choice_id: string }).choice_id).toBe("left");
    expect(
      (chooseCalls[0] as { expected_revision: string }).expected_revision,
    ).toBe("1");

    await startScene(buttonUpdate());
    const clickCalls: unknown[] = [];
    host.clickButton = (request) => {
      clickCalls.push(request);
      return Promise.resolve(dialogueUpdate("3"));
    };
    const button = await screen.findByLabelText("btn.menu");
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      bottom: 80,
      height: 80,
      left: 0,
      right: 200,
      top: 0,
      width: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(button, {
      button: 0,
      clientX: 10,
      clientY: 10,
      pointerId: 1,
    });
    fireEvent.pointerUp(button, {
      button: 0,
      clientX: 10,
      clientY: 10,
      pointerId: 1,
    });
    await waitFor(() => expect(clickCalls).toHaveLength(1));
    expect((clickCalls[0] as { instance_id: string }).instance_id).toBe(
      "btn.menu",
    );
  });

  it("acknowledges a gated presentation exactly once", async () => {
    await startScene(dialogueUpdate("1", true));
    const ackCalls: unknown[] = [];
    host.ack = (request) => {
      ackCalls.push(request);
      return Promise.resolve(dialogueUpdate("2", false));
    };
    act(() => {
      host.canvasProps?.onSettled(dialogueUpdate("1", true), "completed");
    });
    await waitFor(() => expect(ackCalls).toHaveLength(1));
    expect((ackCalls[0] as { update_id: string }).update_id).toBe("1");
    expect((ackCalls[0] as { outcome: string }).outcome).toBe("completed");
  });

  it("returns NeedsChoice without guessing and starts after a branch is picked", async () => {
    renderPreview();
    host.start = () =>
      Promise.resolve({
        status: "needs_choice",
        location: { scene_id: "main", node_id: "route" },
        visit: 0,
        choices: [{ id: "left", label: "向左", enabled: true }],
        trace: [],
      });
    fireEvent.click(screen.getByRole("button", { name: "从所选节点开始" }));
    const branch = await screen.findByRole("button", { name: "向左" });

    host.start = () => Promise.resolve(started(dialogueUpdate("9")));
    fireEvent.click(branch);
    await waitFor(() => expect(host.startRequests).toHaveLength(2));
    const second = host.startRequests[1] as {
      choices: { choice_id: string; node_id: string }[];
    };
    expect(second.choices).toEqual([
      { scene_id: "main", node_id: "route", visit: 0, choice_id: "left" },
    ]);
  });

  it("offers the explicit reset when the node is unreachable from the entry", async () => {
    renderPreview();
    host.start = () =>
      Promise.resolve({
        status: "unreachable",
        message: "路径已离开 main",
        trace: [],
      });
    fireEvent.click(screen.getByRole("button", { name: "从所选节点开始" }));
    expect(
      await screen.findByText(/无法从场景入口构造该节点的进入状态/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重置并从此节点开始" }),
    ).toBeEnabled();
  });

  it("stops the previous session on restart and drops a reply superseded by unmount", async () => {
    let resolveSecond: ((value: unknown) => void) | null = null;
    const view = renderPreview();
    await startScene();
    expect(host.stopCalls).toEqual([]);

    // Restart: a new start must stop the old session id.
    host.start = () =>
      new Promise((resolve) => {
        resolveSecond = resolve;
      });
    fireEvent.click(screen.getByRole("button", { name: "从场景入口开始" }));
    await waitFor(() => expect(host.stopCalls).toEqual(["7"]));

    // Unmount supersedes the in-flight start; its late reply must be ignored.
    view.unmount();
    await act(async () => {
      resolveSecond?.(started(dialogueUpdate("5"), "8"));
      await Promise.resolve();
    });
    expect(host.canvasProps?.update?.snapshot.revision ?? null).not.toBe("5");
  });

  it("stops the session created by a START that was superseded while pending", async () => {
    let resolveStart: ((value: unknown) => void) | null = null;
    const view = renderPreview();
    host.start = () =>
      new Promise((resolve) => {
        resolveStart = resolve;
      });
    fireEvent.click(screen.getByRole("button", { name: "从场景入口开始" }));
    await waitFor(() => expect(host.startRequests).toHaveLength(1));
    view.unmount();
    await act(async () => {
      resolveStart?.(started(dialogueUpdate("1"), "42"));
      await Promise.resolve();
    });
    // The abandoned start installed a backend session; it must be stopped with
    // that exact token or it leaks.
    expect(host.stopCalls).toContain("42");
    expect(host.canvasProps?.update ?? null).toBeNull();
  });

  it("permits stop during a pending startup and frees the busy flag", async () => {
    let resolveStart: ((value: unknown) => void) | null = null;
    renderPreview();
    host.start = () =>
      new Promise((resolve) => {
        resolveStart = resolve;
      });
    fireEvent.click(screen.getByRole("button", { name: "从场景入口开始" }));
    const stop = screen.getByRole("button", { name: "停止" });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    expect(screen.getByText("已停止")).toBeInTheDocument();
    await act(async () => {
      resolveStart?.(started(dialogueUpdate("1"), "5"));
      await Promise.resolve();
    });
    expect(host.stopCalls).toContain("5");
    // The panel is not stuck busy: a fresh start works.
    host.start = () => Promise.resolve(started(dialogueUpdate("2"), "6"));
    fireEvent.click(screen.getByRole("button", { name: "从场景入口开始" }));
    await waitFor(() =>
      expect(host.canvasProps?.update?.snapshot.revision).toBe("2"),
    );
  });

  it("cancels the presentation on restart and on unmount", async () => {
    const view = renderPreview();
    await startScene();
    const before = host.cancels;
    host.start = () => Promise.resolve(started(dialogueUpdate("2"), "8"));
    fireEvent.click(screen.getByRole("button", { name: "从场景入口开始" }));
    await waitFor(() => expect(host.cancels).toBeGreaterThan(before));
    const atRestart = host.cancels;
    view.unmount();
    expect(host.cancels).toBeGreaterThan(atRestart);
  });

  it("remounts the dialogue surface when a new session starts at the same node", async () => {
    await startScene(dialogueUpdate("1"));
    const first = document.querySelector(".dialogue-box");
    expect(first).not.toBeNull();
    host.start = () => Promise.resolve(started(dialogueUpdate("1"), "9"));
    fireEvent.click(screen.getByRole("button", { name: "从场景入口开始" }));
    await waitFor(() =>
      expect(document.querySelector(".dialogue-box")).not.toBe(first),
    );
  });

  it("acknowledges a settlement while a command is still in flight", async () => {
    await startScene(dialogueUpdate("1", false));
    const ackCalls: unknown[] = [];
    host.ack = (request) => {
      ackCalls.push(request);
      return Promise.resolve(dialogueUpdate("2", false));
    };
    let resolveAdvance: ((value: unknown) => void) | null = null;
    host.advance = () =>
      new Promise((resolve) => {
        resolveAdvance = resolve;
      });
    // First click completes the reveal; second issues the (pending) advance.
    fireEvent.click(screen.getByRole("button", { name: "推进 / 完成打字" }));
    fireEvent.click(screen.getByRole("button", { name: "推进 / 完成打字" }));
    // A settlement that arrives now must not be dropped because busy is set.
    act(() => {
      host.canvasProps?.onSettled(dialogueUpdate("1", true), "completed");
    });
    await waitFor(() => expect(ackCalls).toHaveLength(1));
    act(() => {
      resolveAdvance?.(dialogueUpdate("2", false));
    });
  });

  it("de-duplicates a settlement and ignores a callback from a restarted session", async () => {
    await startScene(dialogueUpdate("1", true));
    const ackCalls: unknown[] = [];
    host.ack = (request) => {
      ackCalls.push(request);
      return Promise.resolve(dialogueUpdate("2", false));
    };
    act(() => {
      host.canvasProps?.onSettled(dialogueUpdate("1", true), "completed");
    });
    await waitFor(() => expect(ackCalls).toHaveLength(1));
    const staleCallback = host.canvasProps?.onSettled;
    // Duplicate settlement for the same update is a no-op.
    act(() => {
      staleCallback?.(dialogueUpdate("1", true), "completed");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(ackCalls).toHaveLength(1);

    // Restart at the same node with a namespaced (fresh) update id.
    host.start = () =>
      Promise.resolve(
        started(withUpdateId(dialogueUpdate("1", true), "100"), "9"),
      );
    fireEvent.click(screen.getByRole("button", { name: "从场景入口开始" }));
    await waitFor(() =>
      expect(host.canvasProps?.update?.update_id).toBe("100"),
    );
    // The old session's callback settles an update the new session never had.
    act(() => {
      staleCallback?.(dialogueUpdate("1", true), "completed");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(ackCalls).toHaveLength(1);
  });

  it("never issues an advance while a presentation gate is pending", async () => {
    await startScene(dialogueUpdate("1", true));
    const advanceCalls: unknown[] = [];
    host.advance = (request) => {
      advanceCalls.push(request);
      return Promise.resolve(dialogueUpdate("2", false));
    };
    fireEvent.click(screen.getByRole("button", { name: "跳过表现" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(advanceCalls).toHaveLength(0);
    expect(host.skips).toBeGreaterThan(0);
  });

  it("auto-advances authored immediate-auto dialogue with the right source", async () => {
    const advanceCalls: unknown[] = [];
    host.advance = (request) => {
      advanceCalls.push(request);
      return Promise.resolve(dialogueUpdate("2", false));
    };
    await startScene(autoUpdate("normal", "这段话立刻前进[auto]"));
    await waitFor(() => expect(advanceCalls).toHaveLength(1));
    expect((advanceCalls[0] as { source: string }).source).toBe("auto");
  });

  it("auto-advances forced-auto dialogue with forced_auto source", async () => {
    const advanceCalls: unknown[] = [];
    host.advance = (request) => {
      advanceCalls.push(request);
      return Promise.resolve(dialogueUpdate("2", false));
    };
    await startScene(autoUpdate("forced", "强制自动[auto]"));
    await waitFor(() => expect(advanceCalls).toHaveLength(1));
    expect((advanceCalls[0] as { source: string }).source).toBe("forced_auto");
  });

  it.each(["needs_choice", "unreachable", "rejected"] as const)(
    "clears the old session/update/assets when a restart ends in %s",
    async (kind) => {
      const errors: string[] = [];
      render(
        <GameplayPreview
          importTokens={[]}
          nodeId="say"
          onError={(message) => errors.push(message)}
          project={project()}
          sceneId="main"
        />,
      );
      host.start = () =>
        Promise.resolve({
          status: "started" as const,
          session_id: "7",
          update: dialogueUpdate("1"),
          assets: [
            {
              id: "gui.dialogue_box",
              kind: "gui",
              absolute_path: "C:/project/game/gui/diag.png",
            },
          ],
        });
      fireEvent.click(screen.getByRole("button", { name: "从场景入口开始" }));
      await waitFor(() =>
        expect(host.canvasProps?.update?.snapshot.revision).toBe("1"),
      );
      expect(Object.keys(host.canvasProps?.assets ?? {})).toEqual([
        "gui.dialogue_box",
      ]);
      expect(document.querySelector(".dialogue-box")).not.toBeNull();

      // Restart from the previous playing state, ending in the given outcome.
      if (kind === "rejected") {
        host.start = () => Promise.reject(new Error("启动失败"));
      } else if (kind === "unreachable") {
        host.start = () =>
          Promise.resolve({
            status: "unreachable",
            message: "断开的节点",
            trace: [],
          });
      } else {
        host.start = () =>
          Promise.resolve({
            status: "needs_choice",
            location: { scene_id: "main", node_id: "route" },
            visit: 0,
            choices: [{ id: "left", label: "向左", enabled: true }],
            trace: [],
          });
      }
      fireEvent.click(screen.getByRole("button", { name: "从场景入口开始" }));

      // The old runtime is stopped and the old world is gone immediately: no
      // stale update, assets or dialogue reach the surface.
      await waitFor(() => expect(host.stopCalls).toContain("7"));
      await waitFor(() => expect(host.canvasProps?.assets ?? null).toEqual({}));
      await waitFor(() =>
        expect(document.querySelector(".dialogue-box")).toBeNull(),
      );
      expect(host.canvasProps?.update ?? null).toBeNull();

      if (kind === "needs_choice") {
        expect(
          await screen.findByRole("button", { name: "向左" }),
        ).toBeInTheDocument();
      } else if (kind === "unreachable") {
        expect(
          await screen.findByText(/无法从场景入口构造该节点的进入状态/),
        ).toBeInTheDocument();
      } else {
        await waitFor(() => expect(errors).toContain("启动失败"));
        expect(screen.getByText("未开始")).toBeInTheDocument();
      }

      // A subsequent successful start still works (no stale session/update).
      host.start = () => Promise.resolve(started(dialogueUpdate("2"), "11"));
      fireEvent.click(screen.getByRole("button", { name: "从场景入口开始" }));
      await waitFor(() =>
        expect(host.canvasProps?.update?.snapshot.revision).toBe("2"),
      );
      expect(document.querySelector(".dialogue-box")).not.toBeNull();
    },
  );

  it("auto-starts exactly once from the clicked node", async () => {
    host.start = () => Promise.resolve(started(dialogueUpdate()));
    render(
      <GameplayPreview
        autoStart="node"
        importTokens={[]}
        nodeId="say"
        onError={() => undefined}
        project={project()}
        sceneId="main"
      />,
    );
    await waitFor(() => expect(host.startRequests).toHaveLength(1));
    const request = host.startRequests[0] as {
      mode: string;
      node_id?: string;
    };
    expect(request.mode).toBe("node");
    expect(request.node_id).toBe("say");
    // A deferred tick must not be scheduled twice.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(host.startRequests).toHaveLength(1);
  });

  it("auto-starts once under StrictMode and stops only on the real unmount", async () => {
    host.start = () => Promise.resolve(started(dialogueUpdate()));
    const view = render(
      <StrictMode>
        <GameplayPreview
          autoStart="node"
          importTokens={[]}
          nodeId="say"
          onError={() => undefined}
          project={project()}
          sceneId="main"
        />
      </StrictMode>,
    );
    await waitFor(() => expect(host.startRequests).toHaveLength(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(host.startRequests).toHaveLength(1);
    // StrictMode's simulated unmount must not have created and orphaned a session.
    expect(host.stopCalls).toEqual([]);
    view.unmount();
    expect(host.stopCalls).toEqual(["7"]);
  });

  it("keeps the explicit start buttons when no autoStart is given", async () => {
    host.start = () => Promise.resolve(started(dialogueUpdate()));
    renderPreview();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(host.startRequests).toHaveLength(0);
    expect(screen.getByText("未开始")).toBeInTheDocument();
  });

  it("fits the design stage within the height left below the toolbar", async () => {
    const Original = globalThis.ResizeObserver;
    let notify: ResizeObserverCallback | undefined;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        notify = callback;
      }
      observe(): void {
        /* Driven by the test. */
      }
      unobserve(): void {
        /* Driven by the test. */
      }
      disconnect(): void {
        /* Driven by the test. */
      }
    };
    try {
      const view = renderPreview();
      await act(async () => {
        await Promise.resolve();
        notify?.(
          [
            {
              contentRect: { width: 1920, height: 360 },
            } as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      });
      const stage = view.container.querySelector<HTMLElement>(
        ".gameplay-preview-stage",
      );
      expect(stage?.style.width).toBe("640px");
      expect(stage?.style.height).toBe("360px");
      view.unmount();
    } finally {
      globalThis.ResizeObserver = Original;
    }
  });

  it("maps pointer coordinates over the scaled stage and clears on leave", async () => {
    await startScene();
    const stage = document.querySelector<HTMLElement>(
      ".gameplay-preview-stage",
    );
    if (stage === null) throw new Error("missing preview stage");
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      bottom: 540,
      height: 540,
      left: 0,
      right: 960,
      top: 0,
      width: 960,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    // 480/0.5 = 960, 270/0.5 = 540: the design-coordinate readout.
    fireEvent.pointerMove(stage, { clientX: 480, clientY: 270 });
    const readout = await screen.findByText(/X 960/);
    expect(readout.textContent).toContain("Y 540");

    // Below the actual scaled content (600/0.5 = 1200 > 1080): hidden.
    fireEvent.pointerMove(stage, { clientX: 480, clientY: 600 });
    await waitFor(() =>
      expect(document.querySelector(".gameplay-preview-coords")).toBeNull(),
    );

    fireEvent.pointerMove(stage, { clientX: 480, clientY: 270 });
    await screen.findByText(/X 960/);
    fireEvent.pointerLeave(stage);
    await waitFor(() =>
      expect(document.querySelector(".gameplay-preview-coords")).toBeNull(),
    );
  });

  it("never reports coordinates for a zero-sized stage", async () => {
    await startScene();
    const stage = document.querySelector<HTMLElement>(
      ".gameplay-preview-stage",
    );
    if (stage === null) throw new Error("missing preview stage");
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerMove(stage, { clientX: 10, clientY: 10 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector(".gameplay-preview-coords")).toBeNull();
  });

  it("registers the project gameplay font under the shared family", async () => {
    const env = installPreviewFontFace();
    host.start = () => Promise.resolve(started(dialogueUpdate()));
    render(
      <GameplayPreview
        importTokens={[]}
        nodeId="say"
        onError={() => undefined}
        project={projectWithFont()}
        sceneId="main"
      />,
    );
    await waitFor(() => expect(env.added).toHaveLength(1));
    expect(env.added[0]?.family).toBe("VECT Pixel");
    expect(env.added[0]?.source).toContain("pixel.ttf");
    await act(async () => {
      env.faces[0]?.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText(/游戏字体加载失败/)).not.toBeInTheDocument();
  });

  it("asks the host to run timers and plays their effects beside the story", async () => {
    const timers = {
      pulse: { target: "flash", remaining_ms: 100, interval_ms: 500 },
    };
    await startScene(
      withInteraction(dialogueUpdate("1"), {
        titles: { main: "VECTSPACE", secondary: "" },
        timers,
      }),
    );
    const effect = withInteraction(
      withUpdateId(dialogueUpdate("3"), "9"),
      {
        titles: { main: "VECTSPACE", secondary: "" },
        timers,
      },
      "effect",
      { effect_timer: "pulse" },
    );
    let delivered = false;
    host.tick = () => {
      const updates = delivered ? [] : [effect];
      delivered = true;
      return Promise.resolve({ updates, notes: [], diagnostics: [] });
    };
    // The story update keeps its identity; the effect arrives separately.
    await waitFor(() => expect(host.canvasProps?.effects).toHaveLength(1));
    expect(host.canvasProps?.update?.update_id).toBe("1");
    expect(host.canvasProps?.activeTimers).toEqual(["pulse"]);

    // A command is issued against the revision the effect bumped.
    const advanceCalls: unknown[] = [];
    host.advance = (request) => {
      advanceCalls.push(request);
      return Promise.resolve(dialogueUpdate("4"));
    };
    fireEvent.click(screen.getByRole("button", { name: "推进 / 完成打字" }));
    fireEvent.click(screen.getByRole("button", { name: "推进 / 完成打字" }));
    await waitFor(() => expect(advanceCalls.length).toBeGreaterThan(0));
    expect(
      (advanceCalls[0] as { expected_revision: string }).expected_revision,
    ).toBe("3");
  });

  it("stops asking the host once no timer is running", async () => {
    let calls = 0;
    host.tick = () => {
      calls += 1;
      return Promise.resolve({ updates: [], notes: [], diagnostics: [] });
    };
    await startScene(dialogueUpdate("1"));
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(calls).toBe(0);
  });

  it("never sends an advance while a script block is active and says why", async () => {
    await startScene(
      withInteraction(dialogueUpdate("1"), {
        titles: { main: "VECTSPACE", secondary: "" },
        blocks: [
          {
            id: "gate",
            source: "secondary",
            source_scene: "side",
            message: "先在副窗口里选一个答案",
          },
        ],
      }),
    );
    expect(
      await screen.findByText(/先在副窗口里选一个答案/),
    ).toBeInTheDocument();
    const advanceCalls: unknown[] = [];
    host.advance = (request) => {
      advanceCalls.push(request);
      return Promise.resolve(dialogueUpdate("2"));
    };
    fireEvent.click(screen.getByRole("button", { name: "推进 / 完成打字" }));
    fireEvent.click(screen.getByRole("button", { name: "推进 / 完成打字" }));
    fireEvent.keyDown(window, { key: " " });
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    expect(advanceCalls).toHaveLength(0);
  });

  it("shows what a single-window preview could not do", async () => {
    renderPreview();
    host.start = () =>
      Promise.resolve(
        started(dialogueUpdate("1"), "7", [
          "预览是单窗口：另一窗口的标题修改未应用，请在桌面双窗口运行验证",
        ]),
      );
    fireEvent.click(screen.getByRole("button", { name: "从场景入口开始" }));
    expect(await screen.findByText(/另一窗口的标题修改未应用/)).toBeVisible();
  });

  it("surfaces a non-fatal notice when the gameplay font fails", async () => {
    const env = installPreviewFontFace();
    render(
      <GameplayPreview
        importTokens={[]}
        nodeId="say"
        onError={() => undefined}
        project={projectWithFont()}
        sceneId="main"
      />,
    );
    await act(async () => {
      env.faces[0]?.reject(new Error("字体损坏"));
      await Promise.resolve();
    });
    expect(await screen.findByText(/游戏字体加载失败/)).toBeInTheDocument();
    // The fallback keeps the preview usable.
    expect(
      screen.getByRole("button", { name: "从所选节点开始" }),
    ).toBeEnabled();
  });
});
