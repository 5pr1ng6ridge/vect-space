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
} from "@vectspace/presentation-core/scene-test-kit";

import { CuePreview } from "./CuePreview";
import { buildBackgroundPreviewRequest } from "../presentationPreview";
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
