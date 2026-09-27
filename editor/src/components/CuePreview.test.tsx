// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryKit,
  createMemoryTextureLoader,
  MemoryNode,
  MemorySprite,
  type MemoryKit,
} from "@vectspace/presentation-core/scene-test-kit";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";

import { CuePreview } from "./CuePreview";
import {
  buildBackgroundPreviewRequest,
  buildWorldPreviewRequest,
} from "../presentationPreview";
import type { BackgroundNode, EditorAsset } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));

afterEach(cleanup);

const ASSETS: EditorAsset[] = [
  {
    id: "bg.a",
    kind: "background",
    path: "backgrounds/a.png",
    absolute_path: "C:/a.png",
  },
  {
    id: "bg.b",
    kind: "background",
    path: "backgrounds/b.png",
    absolute_path: "C:/b.png",
  },
];

const LOOP_URLS = ["C:/loop/0.png", "C:/loop/1.png"] as const;

/** A two-frame loop on the logical asset the static world shows. */
const ANIMATIONS: AnimationMap = {
  "sprite.loop": {
    id: "loop",
    width: 128,
    height: 128,
    total_duration_ms: 20,
    frames: [
      { asset: "sprite.loop", url: LOOP_URLS[0], duration_ms: 10 },
      { asset: "sprite.loop", url: LOOP_URLS[1], duration_ms: 10 },
    ],
  },
};

/** The runtime world a `sprite` node resolves to, with no cue on top. */
function staticWorldRequest() {
  return buildWorldPreviewRequest({
    background: "bg.a",
    sprites: {
      lumi: {
        asset: "sprite.loop",
        x: 960,
        y: 1080,
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
  });
}

/** How many distinct frame textures the stage's sprite has displayed. */
function spriteFrameTextures(kit: MemoryKit): number {
  let frames = 0;
  const walk = (node: MemoryNode): void => {
    if (node instanceof MemorySprite)
      frames = Math.max(frames, node.textures.length);
    for (const child of node.children) walk(child);
  };
  const application = kit.applications[0];
  if (application !== undefined) walk(application.stage);
  return frames;
}

function backgroundRequest(durationMs = 40) {
  const node: BackgroundNode = {
    type: "background",
    background: "bg.b",
    transition: { type: "cross_fade" },
    duration_ms: durationMs,
    easing: "ease_in_out",
    await: false,
    next: "end",
  };
  return buildBackgroundPreviewRequest(node, {
    background: "bg.a",
    curtain: { covered: false, fill: null },
  });
}

describe("CuePreview", () => {
  it("reuses one initialized surface under Strict Mode and plays the cue", async () => {
    const kit = createMemoryKit();
    const loader = createMemoryTextureLoader({
      "C:/a.png": { width: 1920, height: 1080 },
      "C:/b.png": { width: 1920, height: 1080 },
    });
    render(
      <StrictMode>
        <CuePreview
          assets={ASSETS}
          environment={{ kit: kit.kit, textureLoader: loader.load }}
          label="背景转场预览"
          request={backgroundRequest()}
        />
      </StrictMode>,
    );
    expect(screen.getByLabelText("背景转场预览")).toBeDefined();

    const play = await screen.findByRole("button", { name: /播放/ });
    await waitFor(() => expect(play).toBeEnabled());
    fireEvent.click(play);
    // The cue plays to completion through the shared surface and clock.
    await waitFor(() => expect(screen.getByText("40 / 40 ms")).toBeDefined(), {
      timeout: 5000,
    });
    // Strict Mode's setup/cleanup/setup probe reclaimed the same WebGL
    // application instead of creating and destroying a second one.
    expect(kit.applications).toHaveLength(1);
    expect(kit.applications[0]?.destroyed).toBe(false);
  });

  it("keeps a static world's animated sprite looping without a transport", async () => {
    const kit = createMemoryKit();
    const loader = createMemoryTextureLoader({
      "C:/a.png": { width: 1920, height: 1080 },
      "C:/b.png": { width: 1920, height: 1080 },
      [LOOP_URLS[0]]: { width: 128, height: 128 },
      [LOOP_URLS[1]]: { width: 128, height: 128 },
    });
    render(
      <CuePreview
        animations={ANIMATIONS}
        assets={ASSETS}
        environment={{ kit: kit.kit, textureLoader: loader.load }}
        label="立绘预览"
        request={staticWorldRequest()}
      />,
    );

    await screen.findByLabelText("立绘预览");
    // A static world preview has no cue, so it has no transport at all.
    expect(screen.queryByRole("button", { name: /播放/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "转场后" })).toBeNull();

    // The decoration loop is driven by the shared clock, so the sprite moves
    // past its first frame even though no timeline is involved; a paused clock
    // would leave it with exactly one texture forever.
    await waitFor(() => expect(spriteFrameTextures(kit)).toBeGreaterThan(1), {
      timeout: 3000,
    });
  });

  it("rebuilds deterministically when the authored request changes", async () => {
    const kit = createMemoryKit();
    const loader = createMemoryTextureLoader({
      "C:/a.png": { width: 1920, height: 1080 },
      "C:/b.png": { width: 1920, height: 1080 },
    });
    const view = render(
      <CuePreview
        assets={ASSETS}
        environment={{ kit: kit.kit, textureLoader: loader.load }}
        label="背景转场预览"
        request={backgroundRequest(120)}
      />,
    );
    await screen.findByRole("button", { name: /播放/ });
    const seek = screen.getByRole("button", { name: "转场后" });
    await waitFor(() => expect(seek).toBeEnabled());
    fireEvent.click(seek);
    await waitFor(
      () => expect(screen.getByText("120 / 120 ms")).toBeDefined(),
      {
        timeout: 5000,
      },
    );

    // A shorter authored duration rebuilds the same before-world from scratch
    // and resets the playhead instead of inheriting the previous run's frame.
    view.rerender(
      <CuePreview
        assets={ASSETS}
        environment={{ kit: kit.kit, textureLoader: loader.load }}
        label="背景转场预览"
        request={backgroundRequest(80)}
      />,
    );
    await waitFor(() => expect(screen.getByText("0 / 80 ms")).toBeDefined(), {
      timeout: 5000,
    });
    expect(kit.applications).toHaveLength(1);
  });

  it("leaves a failed build retryable and recovers when the asset resolves", async () => {
    const kit = createMemoryKit();
    const loader = createMemoryTextureLoader({
      "C:/a.png": { width: 1920, height: 1080 },
      "C:/b.png": { width: 1920, height: 1080 },
    });
    const environment = { kit: kit.kit, textureLoader: loader.load };
    const request = backgroundRequest();
    const onError = vi.fn();
    const view = render(
      <CuePreview
        assets={[]}
        environment={environment}
        label="背景转场预览"
        onError={onError}
        request={request}
      />,
    );

    // The before-state asset is not registered: the build fails, but the
    // transport stays usable and offers a retry instead of loading forever.
    const retry = await screen.findByRole("button", { name: "重试" });
    expect(retry).toBeEnabled();
    expect(screen.getByRole("button", { name: /播放/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "转场前" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "转场后" })).toBeEnabled();
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("预览构建失败"),
    );

    // Registering the missing asset is the normal authored change path; it
    // rebuilds and the seek transport works again.
    view.rerender(
      <CuePreview
        assets={ASSETS}
        environment={environment}
        label="背景转场预览"
        onError={onError}
        request={request}
      />,
    );
    await waitFor(() => expect(screen.getByText("0 / 40 ms")).toBeDefined(), {
      timeout: 5000,
    });
    fireEvent.click(screen.getByRole("button", { name: "转场后" }));
    await waitFor(() => expect(screen.getByText("40 / 40 ms")).toBeDefined(), {
      timeout: 5000,
    });
    expect(kit.applications).toHaveLength(1);
  });

  it("rebuilds from the retry control when a transient decode failure clears", async () => {
    const kit = createMemoryKit();
    const loader = createMemoryTextureLoader({
      "C:/a.png": { width: 1920, height: 1080 },
      "C:/b.png": { width: 1920, height: 1080 },
    });
    let failing = true;
    const environment = {
      kit: kit.kit,
      textureLoader: (url: string) =>
        failing ? Promise.reject(new Error("测试解码失败")) : loader.load(url),
    };
    render(
      <CuePreview
        assets={ASSETS}
        environment={environment}
        label="背景转场预览"
        request={backgroundRequest()}
      />,
    );

    const retry = await screen.findByRole("button", { name: "重试" });
    failing = false;
    fireEvent.click(retry);

    // The same request and assets now build, so the retry control recovered
    // the preview without any authored change.
    await waitFor(() => expect(screen.getByText("0 / 40 ms")).toBeDefined(), {
      timeout: 5000,
    });
    fireEvent.click(screen.getByRole("button", { name: /播放/ }));
    await waitFor(() => expect(screen.getByText("40 / 40 ms")).toBeDefined(), {
      timeout: 5000,
    });
    expect(kit.applications).toHaveLength(1);
  });
});
