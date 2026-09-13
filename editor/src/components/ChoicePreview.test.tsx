// @vitest-environment jsdom
/**
 * Choice inspector preview tests.
 *
 * The preview must render the *runtime-resolved* prompt, so these tests drive
 * the real component against a mocked host boundary: `buildNodePreview`
 * returns a canonical `PromptSnapshot`, and the assertions read the shared
 * ChoiceLayer DOM (rects, skins, icons, disabled state, labels) plus the
 * resolved-option legend.
 */
import "@testing-library/jest-dom/vitest";
import { StrictMode, type ReactElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import type {
  ChoicePrompt,
  RuntimeSnapshot,
  RuntimeUpdate,
} from "@vectspace/presentation-core/types";
import type { BuildNodePreviewResult, EditorProject } from "../types";
import { ChoicePreview } from "./ChoicePreview";

type ReadyPreview = Extract<BuildNodePreviewResult, { status: "ready" }>;

const previewApi = vi.hoisted(() => ({
  handler: null as
    null | ((request: unknown) => Promise<BuildNodePreviewResult>),
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
    assetUrl: (path: string) => `asset://${path}`,
    editorApi: {
      ...actual.editorApi,
      buildNodePreview: (request: unknown): Promise<BuildNodePreviewResult> => {
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

afterEach(() => {
  cleanup();
  previewApi.handler = null;
  previewApi.requests = [];
});

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
        id: "skinned",
        label: "勾股定理 $a^2+b^2=c^2$",
        enabled: true,
        icon: "gui.icon",
        template: {
          kind: "button",
          button: {
            id: "skinned",
            template: "choice.primary",
            asset_mode: "separate",
            fit: "stretch",
            normal: "gui.skin",
            hover: null,
            pressed: null,
            animations: {},
            x: 800,
            y: 382,
            width: 320,
            height: 88,
            rotation_deg: 0,
            scale_x: 1,
            scale_y: 1,
            opacity: 1,
            z: 0,
            visible: true,
            enabled: true,
            action: { sets: [], next: null },
          },
        },
        x: 800,
        y: 382,
        width: 320,
        height: 88,
      },
      {
        id: "plain",
        label: "回退皮肤",
        enabled: true,
        icon: null,
        template: { kind: "fallback" },
        x: 470,
        y: 494,
        width: 980,
        height: 92,
      },
      {
        id: "locked",
        label: "禁用选项",
        enabled: false,
        icon: null,
        template: { kind: "fallback" },
        x: 470,
        y: 606,
        width: 980,
        height: 92,
      },
    ],
  };
}

function snapshot(prompt: ChoicePrompt): RuntimeSnapshot {
  return {
    revision: "1",
    location: { scene_id: "main", node_id: "route" },
    variables: {},
    world: {
      background: null,
      sprites: {},
      camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
      dialogue_ui_visible: true,
      ui_motion_bindings: {},
      persistent_effects: [],
    },
    audio: { bgm: null },
    playback: { auto: "normal", ctrl_fast_forward: "allow" },
    prompt,
  };
}

function readyPreview(prompt: ChoicePrompt): ReadyPreview {
  const update: RuntimeUpdate = {
    update_id: "1",
    snapshot: snapshot(prompt),
    cues: [],
    requires_ack: false,
  };
  return {
    status: "ready",
    start_snapshot: update.snapshot,
    update,
    trace: [],
    resolved_texts: {},
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
      assets: {
        "gui.icon": { kind: "gui", path: "gui/icon.png" },
        "gui.skin": { kind: "gui", path: "gui/skin.png" },
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
          entry: "route",
          nodes: { route: { type: "choice", choices: [] } },
        },
      },
    ],
    ui_motions: [],
    layout: { version: 1, scenes: {} },
    assets: [
      {
        id: "gui.icon",
        kind: "gui",
        path: "gui/icon.png",
        absolute_path: "C:/project/game/gui/icon.png",
      },
      {
        id: "gui.skin",
        kind: "gui",
        path: "gui/skin.png",
        absolute_path: "C:/project/game/gui/skin.png",
      },
    ],
    diagnostics: [],
  };
}

function previewElement(): ReactElement {
  return (
    <ChoicePreview
      assets={project().assets}
      nodeId="route"
      project={project()}
      sceneId="main"
    />
  );
}

describe("ChoicePreview", () => {
  it("renders the runtime-resolved prompt through the shared ChoiceLayer", async () => {
    previewApi.handler = () => Promise.resolve(readyPreview(choicePrompt()));
    render(previewElement());
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(3));

    const skinned = screen.getByRole("button", {
      name: "勾股定理 a^2+b^2=c^2",
    });
    expect(skinned).toHaveAttribute("data-choice-id", "skinned");
    expect(skinned).toHaveStyle({ left: "800px", top: "382px" });
    expect(skinned.querySelector(".choice-button-image")).toHaveAttribute(
      "src",
      "asset://C:/project/game/gui/skin.png",
    );
    expect(skinned.querySelector(".choice-button-icon")).toHaveAttribute(
      "src",
      "asset://C:/project/game/gui/icon.png",
    );

    const plain = screen.getByRole("button", { name: "回退皮肤" });
    expect(plain).toHaveClass("choice-button-fallback");
    expect(plain).toHaveStyle({ left: "470px", top: "494px" });

    const locked = screen.getByRole("button", { name: "禁用选项" });
    expect(locked).toBeDisabled();

    // Resolved layout + per-option facts stay visible to the author.
    const summary = screen.getByText(/锚点 960, 540/);
    expect(summary).toBeInTheDocument();
    expect(screen.getByText("模板 choice.primary")).toBeInTheDocument();
    expect(screen.getAllByText("内置 CSS 按钮")).toHaveLength(2);
    expect(screen.getByText("图标 gui.icon")).toBeInTheDocument();
    expect(screen.getAllByText("可选")).toHaveLength(2);
    expect(screen.getByText("禁用")).toBeInTheDocument();
  });

  it("reports the Rust-filtered prompt for first-enable anchoring", async () => {
    const onResolvedPrompt = vi.fn<(prompt: ChoicePrompt | null) => void>();
    previewApi.handler = () => Promise.resolve(readyPreview(choicePrompt()));
    render(
      <ChoicePreview
        assets={project().assets}
        nodeId="route"
        onResolvedPrompt={onResolvedPrompt}
        project={project()}
        sceneId="main"
      />,
    );
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(3));
    const resolvedPrompt = onResolvedPrompt.mock.lastCall?.[0];
    expect(resolvedPrompt?.kind).toBe("choice");
    expect(resolvedPrompt?.layout).toMatchObject({
      anchor_x: 960,
      anchor_y: 540,
      direction: "vertical",
    });
  });

  it("advances an animated choice frame from the project's animation map", async () => {
    vi.useFakeTimers();
    try {
      const animations: AnimationMap = {
        "gui.skin": {
          id: "anim.choice_skin",
          width: 320,
          height: 88,
          total_duration_ms: 400,
          frames: [
            { asset: "gui.skin_a", duration_ms: 200, url: "skin_a.png" },
            { asset: "gui.skin_b", duration_ms: 200, url: "skin_b.png" },
          ],
        },
      };
      previewApi.handler = () => Promise.resolve(readyPreview(choicePrompt()));
      render(
        <ChoicePreview
          animations={animations}
          assets={project().assets}
          nodeId="route"
          project={project()}
          sceneId="main"
        />,
      );
      await act(async () => {
        vi.advanceTimersByTime(200);
        await Promise.resolve();
      });
      const image = screen
        .getByRole("button", { name: "勾股定理 a^2+b^2=c^2" })
        .querySelector(".choice-button-image");
      expect(image).toHaveAttribute("src", "skin_a.png");
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(image).toHaveAttribute("src", "skin_b.png");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the target, saved path decisions and overrides to the Rust preview", async () => {
    previewApi.handler = () => Promise.resolve(readyPreview(choicePrompt()));
    render(
      <ChoicePreview
        assets={project().assets}
        choices={[
          { scene_id: "main", node_id: "earlier", visit: 0, choice_id: "left" },
          {
            scene_id: "other",
            node_id: "earlier",
            visit: 0,
            choice_id: "nope",
          },
        ]}
        nodeId="route"
        project={project()}
        sceneId="main"
        variableOverrides={{ score: 2 }}
      />,
    );
    await waitFor(() => expect(previewApi.requests).toHaveLength(1));
    const request = previewApi.requests[0] as {
      target: unknown;
      choices: unknown[];
      variable_overrides: unknown;
    };
    expect(request.target).toEqual({ scene_id: "main", node_id: "route" });
    expect(request.variable_overrides).toEqual({ score: 2 });
    expect(request.choices).toEqual([
      { scene_id: "main", node_id: "earlier", visit: 0, choice_id: "left" },
    ]);
  });

  it("does not re-fire the host request on a harmless re-render", async () => {
    const fixture = project();
    previewApi.handler = () => Promise.resolve(readyPreview(choicePrompt()));
    const view = (): ReactElement => (
      <ChoicePreview
        assets={fixture.assets}
        choices={[]}
        importTokens={[]}
        nodeId="route"
        project={fixture}
        sceneId="main"
        variableOverrides={{}}
      />
    );
    const { rerender } = render(view());
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(3));
    const calls = previewApi.requests.length;
    // Fresh array/object identities for the derived inputs, identical values:
    // this is what an unrelated parent re-render looks like.
    rerender(view());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(previewApi.requests.length).toBe(calls);
  });

  it("is Strict Mode safe: one committed render, no duplicated options", async () => {
    previewApi.handler = () => Promise.resolve(readyPreview(choicePrompt()));
    render(<StrictMode>{previewElement()}</StrictMode>);
    await waitFor(() => expect(screen.getAllByRole("button")).toHaveLength(3));
    // Strict Mode probes effects twice; a superseded probe must never commit.
    expect(previewApi.requests).toHaveLength(1);
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("drops a late response after unmount instead of writing state", async () => {
    let resolvePreview: ((value: BuildNodePreviewResult) => void) | null = null;
    previewApi.handler = () =>
      new Promise<BuildNodePreviewResult>((resolve) => {
        resolvePreview = resolve;
      });
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { unmount } = render(previewElement());
    await waitFor(() => expect(previewApi.requests).toHaveLength(1));
    unmount();
    await act(async () => {
      resolvePreview?.(readyPreview(choicePrompt()));
      await Promise.resolve();
    });
    expect(document.querySelector(".choice-preview")).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("stays read-only: activating an option never mutates the project", async () => {
    previewApi.handler = () => Promise.resolve(readyPreview(choicePrompt()));
    render(previewElement());
    const plain = await screen.findByRole("button", { name: "回退皮肤" });
    fireEvent.click(plain);
    // No story command exists in the mocked boundary; a mutation attempt would
    // reject with "not a function" and surface as an unhandled error.
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "回退皮肤" })).toBe(plain);
  });

  it("reports unreachable, needs-choice and non-choice results", async () => {
    previewApi.handler = () =>
      Promise.resolve({
        status: "unreachable",
        message: "断开的节点",
        trace: [],
      });
    const { unmount } = render(previewElement());
    expect(await screen.findByText(/无法从场景入口到达/)).toBeInTheDocument();
    unmount();

    previewApi.handler = () =>
      Promise.resolve({
        status: "needs_choice",
        location: { scene_id: "main", node_id: "earlier" },
        visit: 0,
        choices: [],
        trace: [],
      });
    const second = render(previewElement());
    expect(await screen.findByText(/main\/earlier/)).toBeInTheDocument();
    second.unmount();

    previewApi.handler = () => Promise.resolve(readyPreview(choicePrompt()));
    const third = render(previewElement());
    expect(await screen.findAllByRole("button")).toHaveLength(3);
    third.unmount();

    previewApi.handler = () => {
      const preview = readyPreview(choicePrompt());
      return Promise.resolve({
        ...preview,
        update: {
          ...preview.update,
          snapshot: {
            ...preview.update.snapshot,
            prompt: { kind: "none" as const },
          },
        },
      });
    };
    render(previewElement());
    expect(await screen.findByText(/不是 choice 提示/)).toBeInTheDocument();
  });
});
