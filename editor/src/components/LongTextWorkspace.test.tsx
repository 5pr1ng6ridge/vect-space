// @vitest-environment jsdom
/**
 * LongTextWorkspace preview host boundary.
 *
 * The workspace is the editor's long-text layout host: it reconstructs the real
 * retained document through Rust, keeps the layout gizmo / inspector / step
 * textareas, and renders the *shared* `LongTextPanel` for paper, measurement,
 * pagination, reveal and scroll.  These tests pin exactly that boundary:
 *
 * - a workspace-local duplicate of the paper/text layer must not come back;
 * - the panel must receive the authored document (content, layout, pagination,
 *   colour, font identity) and the editor's playhead/scrub state;
 * - the controls must drive the panel's public API (`complete()`, a new reveal
 *   instance for replay) instead of a private copy of the reveal clock.
 *
 * `LongTextPanel` is wrapped (not replaced) so the props handed to it can be
 * asserted while the DOM under test remains the shipping shared component.
 */
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import type {
  LongTextPageSnapshot,
  LongTextPrompt,
  RuntimeSnapshot,
  RuntimeUpdate,
} from "@vectspace/presentation-core/types";
import type {
  BuildNodePreviewResult,
  EditorAsset,
  EditorProject,
  LongTextNode,
} from "../types";
import { LongTextWorkspace } from "./LongTextWorkspace";

type ReadyPreview = Extract<BuildNodePreviewResult, { status: "ready" }>;

/** Props the workspace handed to the shared panel on its latest render. */
interface PanelProps {
  page: LongTextPageSnapshot;
  prompt: LongTextPrompt | null;
  fontKey: string;
  fontReady: boolean;
  designScale: number;
  disabled: boolean;
  suspended: boolean;
  sessionKey: string | undefined;
  revealAnimation: string;
  revealImmediately: boolean;
  visible: boolean;
  initialCps: number;
  defaultCps: number;
  fastForward: boolean;
  paperSource: { animation?: unknown } | null | undefined;
}

const panelHost = vi.hoisted(() => ({
  props: [] as Record<string, unknown>[],
}));

const previewApi = vi.hoisted(() => ({
  handler: null as null | ((request: unknown) => Promise<ReadyPreview>),
  requests: [] as unknown[],
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
  const { forwardRef } = await import("react");
  const LongTextPanel = forwardRef<unknown, Record<string, unknown>>(
    function LongTextPanelSpy(props, ref) {
      panelHost.props.push(props);
      return (
        <actual.LongTextPanel
          {...(props as unknown as React.ComponentProps<
            typeof actual.LongTextPanel
          >)}
          ref={
            ref as React.Ref<
              import("@vectspace/presentation-react/gameplay").LongTextPanelHandle
            >
          }
        />
      );
    },
  );
  return { ...actual, LongTextPanel };
});

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
const NODE_ID = "doc";
const FONT_ID = "font.fusion_pixel";
const OWN_STEP_ID = "own-1";
const OWN_STEP_TEXT = "当前节点的第一段正文";
const PREFIX_TEXT = "保留文稿的前序段落";

const ASSETS: EditorAsset[] = [
  {
    id: FONT_ID,
    kind: "font",
    path: "font/fusion.ttf",
    absolute_path: "C:/game/font/fusion.ttf",
  },
  {
    id: "bg.room",
    kind: "background",
    path: "bg/room.png",
    absolute_path: "C:/game/bg/room.png",
  },
  {
    id: "gui.paper",
    kind: "gui",
    path: "gui/paper.png",
    absolute_path: "C:/game/gui/paper.png",
  },
];

function longTextNode(overrides: Partial<LongTextNode> = {}): LongTextNode {
  return {
    type: "long_text",
    mode: "start",
    document: null,
    paper: null,
    pagination: "auto",
    font_size: 32,
    text_color: "#212533",
    layout: {
      x: 340,
      y: 180,
      width: 1240,
      height: 720,
      padding_x: 118,
      padding_y: 112,
      page_height: 1340,
      page_gap: 92,
    },
    steps: [{ id: OWN_STEP_ID, text: OWN_STEP_TEXT, page_break_before: false }],
    speed_cps: 24,
    reveal_animation: "typewriter",
    next: "end",
    ...overrides,
  };
}

function makeProject(node: LongTextNode): EditorProject {
  return {
    root: "C:/game",
    manifest: {
      schema_version: 2,
      content_version: "test",
      entry_scene: SCENE_ID,
      default_locale: "zh-CN",
      default_font: FONT_ID,
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
          nodes: { [NODE_ID]: node },
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

/**
 * The retained prefix Rust reports for the target node.  The node's own step is
 * deliberately *not* part of it, so the workspace appends it from the editable
 * draft - which is the path an edited paragraph travels.
 */
function retainedPage(
  overrides: Partial<LongTextPageSnapshot> = {},
): LongTextPageSnapshot {
  return {
    document_id: NODE_ID,
    visible: true,
    paper: null,
    pagination: "auto",
    font_size: 32,
    text_color: "#212533",
    layout: {
      x: 340,
      y: 180,
      width: 1240,
      height: 720,
      padding_x: 118,
      padding_y: 112,
      page_height: 1340,
      page_gap: 92,
    },
    steps: [
      { step_id: "prefix-1", text: PREFIX_TEXT, page_break_before: false },
    ],
    active_step_index: 0,
    ...overrides,
  };
}

function snapshotWith(page: LongTextPageSnapshot): RuntimeSnapshot {
  return {
    session_id: "1",
    mode: "story",
    revision: "1",
    location: { scene_id: SCENE_ID, node_id: NODE_ID },
    variables: {},
    world: {
      background: "bg.room",
      sprites: {},
      buttons: {},
      camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
      dialogue_ui_visible: true,
      ui_motion_bindings: {},
      persistent_effects: [],
    },
    audio: { bgm: null },
    playback: { auto: "normal", ctrl_fast_forward: "allow" },
    prompt: { kind: "none" },
    long_text_page: page,
  };
}

function readyPreview(
  page: LongTextPageSnapshot = retainedPage(),
): ReadyPreview {
  const start = snapshotWith(page);
  const update: RuntimeUpdate = {
    session_id: "1",
    mode: "story",
    update_id: "update",
    snapshot: start,
    requires_ack: false,
    cues: [],
  };
  return {
    status: "ready",
    start_snapshot: start,
    update,
    trace: [{ scene_id: SCENE_ID, node_id: NODE_ID }],
    resolved_texts: {},
  };
}

type NodeChangeSpy = Mock<(next: LongTextNode) => void>;

/** The stage wrapper owns every region gesture; it must exist. */
function stageWrap(container: HTMLElement): HTMLElement {
  const element = container.querySelector(".long-text-workspace-stage-wrap");
  if (element === null) throw new Error("缺少舞台容器");
  return element as HTMLElement;
}

interface WorkspaceOptions {
  page?: LongTextPageSnapshot;
  node?: LongTextNode;
}

async function renderWorkspace(options: WorkspaceOptions = {}): Promise<{
  view: ReturnType<typeof render>;
  onChange: NodeChangeSpy;
}> {
  const node = options.node ?? longTextNode();
  const page = options.page ?? retainedPage();
  previewApi.handler = () => Promise.resolve(readyPreview(page));
  const onChange: NodeChangeSpy = vi.fn();
  const view = render(
    <LongTextWorkspace
      animationMap={{}}
      assets={ASSETS}
      dirty
      importTokens={[]}
      node={node}
      nodeId={NODE_ID}
      onBack={() => undefined}
      onChange={onChange}
      onPreviewSettingsChange={() => undefined}
      onRedo={() => undefined}
      onSave={() => undefined}
      onSplitLongText={() => undefined}
      onUndo={() => undefined}
      project={makeProject(node)}
      redoAvailable={false}
      sceneId={SCENE_ID}
      undoAvailable={false}
    />,
  );
  await waitFor(() => {
    expect(view.container.querySelector(".long-text-panel")).not.toBeNull();
  });
  return { view, onChange };
}

function latestPanelProps(): PanelProps {
  const props = panelHost.props[panelHost.props.length - 1];
  if (props === undefined) throw new Error("共享长文本面板没有渲染");
  return props as unknown as PanelProps;
}

function panelElement(container: HTMLElement = document.body): HTMLElement {
  const panel = container.querySelector(".long-text-panel");
  if (panel === null) throw new Error("缺少共享长文本面板");
  return panel as HTMLElement;
}

function panelVar(
  name: string,
  container: HTMLElement = document.body,
): string {
  return panelElement(container).style.getPropertyValue(name);
}

function renderedText(): string {
  return document.querySelector(".long-text-text-stack")?.textContent ?? "";
}

beforeEach(() => {
  panelHost.props = [];
  previewApi.requests = [];
  previewApi.handler = null;
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
  // jsdom measures every element as 0x0.  The workspace's design surface and
  // stage are the two boxes it really needs (preview scale + region gestures),
  // so they are given the geometry a host WebView would report.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element): DOMRect {
      if (this.classList.contains("long-text-workspace-stage-wrap")) {
        return rect(960, 540);
      }
      if (this.classList.contains("long-text-workspace-design")) {
        return rect(1920, 1080);
      }
      return rect(0, 0);
    },
  );
});

function rect(width: number, height: number): DOMRect {
  return {
    width,
    height,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
}

afterEach(() => {
  cleanup();
  fontEnv?.restore();
  fontEnv = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LongTextWorkspace shared panel", () => {
  it("renders the shared LongTextPanel for the Rust document and drops the workspace copy", async () => {
    const { view } = await renderWorkspace();

    // The real shared surface: paper, measurement root, viewport and indicator.
    expect(
      view.container.querySelector(".long-text-measure-root"),
    ).not.toBeNull();
    expect(view.container.querySelector(".long-text-viewport")).not.toBeNull();
    expect(view.container.querySelector(".long-text-indicator")).not.toBeNull();
    expect(
      view.container.querySelectorAll(".long-text-paper").length,
    ).toBeGreaterThan(0);

    // Nothing of the former hand-built paper/text layer may come back.
    for (const legacy of [
      ".long-text-workspace-window",
      ".long-text-workspace-surface",
      ".long-text-workspace-measure-root",
      ".long-text-workspace-text-clip",
      ".long-text-workspace-paper",
      ".long-text-workspace-paper-background",
      ".long-text-workspace-step-fragment",
      ".long-text-workspace-step",
    ]) {
      expect(view.container.querySelector(legacy)).toBeNull();
    }

    // The authored document (retained prefix + the node's own paragraph) is
    // inside the shared text surface.
    const text = renderedText();
    expect(text).toContain(PREFIX_TEXT);
    expect(text).toContain(OWN_STEP_TEXT);

    // Layout, pagination geometry, font size and colour reach the component as
    // the same design-space variables the game publishes.
    expect(panelVar("--long-text-x")).toBe("340px");
    expect(panelVar("--long-text-y")).toBe("180px");
    expect(panelVar("--long-text-width")).toBe("1240px");
    expect(panelVar("--long-text-height")).toBe("720px");
    expect(panelVar("--long-text-padding-y")).toBe("112px");
    expect(panelVar("--long-text-page-height")).toBe("1340px");
    expect(panelVar("--long-text-page-gap")).toBe("92px");
    expect(panelVar("--long-text-font-size")).toBe("32px");
    expect(panelVar("--long-text-color")).toBe("#212533");

    const props = latestPanelProps();
    expect(props.page.document_id).toBe(NODE_ID);
    expect(props.page.pagination).toBe("auto");
    expect(props.page.steps.map((step) => step.step_id)).toEqual([
      "prefix-1",
      OWN_STEP_ID,
    ]);
    expect(props.page.active_step_index).toBe(0);
    expect(props.prompt?.step_id).toBe("prefix-1");
    expect(props.prompt?.text).toBe(PREFIX_TEXT);
    expect(props.initialCps).toBe(24);
    expect(props.defaultCps).toBe(24);
    expect(props.revealAnimation).toBe("typewriter");
    expect(props.revealImmediately).toBe(false);
    expect(props.designScale).toBe(0.5);
    expect(props.fastForward).toBe(false);
    expect(props.visible).toBe(true);
    expect(props.paperSource).toBeUndefined();
    // jsdom has no FontFace API: the shared facility reports ready so text is
    // never gated behind an API the host cannot provide.
    expect(props.fontReady).toBe(true);
    expect(screen.queryByText(/预览字体加载失败/)).toBeNull();
  });

  it("renders the panel only after Rust proved the retained path", async () => {
    previewApi.handler = () => Promise.resolve(readyPreview());
    const view = render(
      <LongTextWorkspace
        animationMap={{}}
        assets={ASSETS}
        dirty={false}
        importTokens={[]}
        node={longTextNode()}
        nodeId={NODE_ID}
        onBack={() => undefined}
        onChange={() => undefined}
        onPreviewSettingsChange={() => undefined}
        onRedo={() => undefined}
        onSave={() => undefined}
        onSplitLongText={() => undefined}
        onUndo={() => undefined}
        project={makeProject(longTextNode())}
        redoAvailable={false}
        sceneId={SCENE_ID}
        undoAvailable={false}
      />,
    );

    // Before the context resolves the canvas stays empty: no panel, and the
    // editor says why instead of rendering raw YAML.
    expect(view.container.querySelector(".long-text-panel")).toBeNull();
    expect(
      view.container.querySelector(".long-text-workspace-preview-unavailable"),
    ).not.toBeNull();
    expect(
      view.container.querySelector(".long-text-workspace-gizmo"),
    ).not.toBeNull();

    await waitFor(() => {
      expect(view.container.querySelector(".long-text-panel")).not.toBeNull();
    });
    expect(
      view.container.querySelector(".long-text-workspace-preview-unavailable"),
    ).toBeNull();
  });

  it("feeds an edited paragraph into the shared panel", async () => {
    await renderWorkspace();
    expect(renderedText()).toContain(OWN_STEP_TEXT);

    const textarea = screen.getByDisplayValue(OWN_STEP_TEXT);
    fireEvent.change(textarea, { target: { value: "改动后的正文段落" } });
    fireEvent.blur(textarea);

    await waitFor(() => {
      expect(renderedText()).toContain("改动后的正文段落");
    });
    expect(renderedText()).not.toContain(OWN_STEP_TEXT);
    // The edited text is a normal document step, not an unrelated sample.
    expect(
      latestPanelProps().page.steps.some(
        (step) => step.text === "改动后的正文段落",
      ),
    ).toBe(true);
  });

  it("keeps inspector edits and the layout gizmo driving the panel geometry", async () => {
    const { view, onChange } = await renderWorkspace();

    fireEvent.change(screen.getByLabelText("字号"), {
      target: { value: "48" },
    });
    await waitFor(() => {
      expect(panelVar("--long-text-font-size")).toBe("48px");
    });
    expect(latestPanelProps().page.font_size).toBe(48);

    fireEvent.change(screen.getByLabelText("分页方式"), {
      target: { value: "continuous" },
    });
    await waitFor(() => {
      expect(latestPanelProps().page.pagination).toBe("continuous");
    });

    // Resizing the layout box updates the rendered geometry live, and commits
    // exactly one authored edit on release.
    const commitsBeforeGesture = onChange.mock.calls.length;
    const resize = view.container.querySelector(".long-text-workspace-resize");
    if (resize === null) throw new Error("缺少缩放手柄");
    fireEvent.pointerDown(resize, {
      button: 0,
      pointerId: 7,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(stageWrap(view.container), {
      pointerId: 7,
      clientX: 40,
      clientY: 80,
    });
    await waitFor(() => {
      expect(panelVar("--long-text-width")).toBe("1280px");
    });
    expect(panelVar("--long-text-height")).toBe("800px");
    expect(onChange).toHaveBeenCalledTimes(commitsBeforeGesture);

    fireEvent.pointerUp(resize, { pointerId: 7, clientX: 40, clientY: 80 });
    expect(onChange).toHaveBeenCalledTimes(commitsBeforeGesture + 1);
    expect(onChange.mock.calls[commitsBeforeGesture]?.[0].layout).toMatchObject(
      {
        x: 340,
        y: 180,
        width: 1280,
        height: 800,
      },
    );
  });

  it("moves the layout box from the gizmo drag handle", async () => {
    const { view, onChange } = await renderWorkspace();

    const handle = view.container.querySelector(
      ".long-text-workspace-drag-handle",
    );
    if (handle === null) throw new Error("缺少拖动手柄");
    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 3,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(stageWrap(view.container), {
      pointerId: 3,
      clientX: 50,
      clientY: 30,
    });
    await waitFor(() => {
      expect(panelVar("--long-text-x")).toBe("390px");
    });
    expect(panelVar("--long-text-y")).toBe("210px");

    fireEvent.pointerUp(handle, { pointerId: 3, clientX: 50, clientY: 30 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0].layout).toMatchObject({
      x: 390,
      y: 210,
    });
  });

  it("passes the authored paper through to the shared panel", async () => {
    await renderWorkspace({
      node: longTextNode({ paper: "gui.paper" }),
    });
    const props = latestPanelProps();
    expect(props.page.paper).toBe("gui.paper");
    expect(props.paperSource).not.toBeNull();
    expect(props.paperSource).not.toBeUndefined();
  });

  it("distinguishes an unresolvable paper from no paper at all", async () => {
    await renderWorkspace({
      node: longTextNode({ paper: "gui.missing" }),
    });
    const props = latestPanelProps();
    expect(props.page.paper).toBe("gui.missing");
    expect(props.paperSource).toBeNull();
  });
});

describe("LongTextWorkspace preview controls", () => {
  it("maps play/pause, complete, next step and replay onto the shared panel", async () => {
    await renderWorkspace();

    // Paused by default: the shared reveal clock is suspended, not restarted.
    expect(latestPanelProps().suspended).toBe(true);
    const firstSessionKey = latestPanelProps().sessionKey;

    fireEvent.click(screen.getByRole("button", { name: "播放预览" }));
    await waitFor(() => {
      expect(latestPanelProps().suspended).toBe(false);
    });
    const playButton = screen.getByRole("button", { name: "暂停预览" });

    fireEvent.click(playButton);
    await waitFor(() => {
      expect(latestPanelProps().suspended).toBe(true);
    });

    // 补全 completes through the panel's imperative handle, which is the only
    // owner of the reveal clock.
    fireEvent.click(screen.getByRole("button", { name: "补全" }));
    await waitFor(
      () => {
        expect(
          panelElement().querySelector(".long-text-indicator")?.className,
        ).toContain("is-ready");
      },
      { timeout: 4000 },
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "下一分段" }),
      ).not.toBeDisabled();
    });
    expect(screen.getByRole("button", { name: "补全" })).toBeDisabled();

    // 下一分段 moves the playhead and keeps the authored pause semantics.
    fireEvent.click(screen.getByRole("button", { name: "下一分段" }));
    await waitFor(() => {
      expect(screen.getByText("2 / 2")).toBeInTheDocument();
    });
    expect(latestPanelProps().page.active_step_index).toBe(1);
    expect(latestPanelProps().prompt?.step_id).toBe(OWN_STEP_ID);
    expect(latestPanelProps().suspended).toBe(true);
    // The last step cannot advance further: the button completes the current
    // reveal, it never overflows the document.
    fireEvent.click(screen.getByRole("button", { name: "下一分段" }));
    expect(screen.getByText("2 / 2")).toBeInTheDocument();

    // 从头重播 returns to the first step with a fresh reveal instance.
    fireEvent.click(screen.getByRole("button", { name: "从头重播" }));
    await waitFor(() => {
      expect(screen.getByText("1 / 2")).toBeInTheDocument();
    });
    expect(latestPanelProps().page.active_step_index).toBe(0);
    expect(latestPanelProps().sessionKey).not.toBe(firstSessionKey);
    expect(
      screen.getByRole("button", { name: "播放预览" }),
    ).toBeInTheDocument();
  });
});

interface FontFaceStub {
  family: string;
  source: string;
  load(): Promise<void>;
  resolve(): void;
  reject(reason: unknown): void;
}

interface FontEnv {
  faces: FontFaceStub[];
  added: FontFaceStub[];
  restore(): void;
}

let fontEnv: FontEnv | null = null;

/** Install a controllable `FontFace` + `document.fonts` into jsdom. */
function installFontFace(): FontEnv {
  const faces: FontFaceStub[] = [];
  const added: FontFaceStub[] = [];
  const fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");

  class StubFontFace implements FontFaceStub {
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
      add: (face: FontFaceStub) => added.push(face),
      delete: () => undefined,
      ready: Promise.resolve(),
    },
  });

  return {
    faces,
    added,
    restore(): void {
      delete (globalThis as { FontFace?: unknown }).FontFace;
      if (fontsDescriptor === undefined) {
        delete (document as { fonts?: unknown }).fonts;
      } else {
        Object.defineProperty(document, "fonts", fontsDescriptor);
      }
    },
  };
}

function useFontFace(): FontEnv {
  fontEnv = installFontFace();
  return fontEnv;
}

describe("LongTextWorkspace font readiness", () => {
  it("registers the project font under the shared family and gates on readiness", async () => {
    const env = useFontFace();
    await renderWorkspace();
    const pending = latestPanelProps();
    expect(pending.fontKey).toBe(FONT_ID);
    expect(pending.fontReady).toBe(false);
    expect(env.faces[0]?.family).toBe("VECT Pixel");
    expect(env.faces[0]?.source).toContain("font/fusion.ttf");

    env.faces[0]?.resolve();
    await waitFor(() => {
      expect(latestPanelProps().fontReady).toBe(true);
    });
    expect(latestPanelProps().fontKey).toBe(FONT_ID);
    expect(screen.queryByText(/预览字体加载失败/)).toBeNull();
  });

  it("reports a failed font load without blocking the preview", async () => {
    const env = useFontFace();
    await renderWorkspace();
    env.faces[0]?.reject(new Error("字体文件缺失"));
    await waitFor(() => {
      expect(screen.getByText(/预览字体加载失败/)).toBeInTheDocument();
    });
    // The fallback geometry still measures and reveals.
    expect(latestPanelProps().fontReady).toBe(true);
    expect(panelElement()).not.toBeNull();
  });
});
