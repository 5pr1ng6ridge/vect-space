// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AssetMetadata,
  ContentManifest,
  EditorAsset,
  EditorProject,
} from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { ImageAnimationPanel } from "./ImageAnimationPanel";
import { NodeInspector } from "./NodeInspector";
import { editorApi } from "../api";
import { projectRequest } from "../story";
import type { SceneDefinition } from "../types";

function metadata(width: number, height: number): AssetMetadata {
  return {
    format: "png",
    width,
    height,
    duration_ms: null,
    channels: null,
    sample_rate: null,
    font_family: null,
    font_style: null,
  };
}

const ASSETS: EditorAsset[] = [
  {
    id: "img.blink2",
    kind: "sprite",
    path: "sprite/blink2.png",
    absolute_path: "C:/assets/blink2.png",
    metadata: metadata(64, 64),
  },
  {
    id: "img.blink10",
    kind: "sprite",
    path: "sprite/blink10.png",
    absolute_path: "C:/assets/blink10.png",
    metadata: metadata(64, 64),
  },
  {
    id: "img.odd",
    kind: "sprite",
    path: "sprite/odd.png",
    absolute_path: "C:/assets/odd.png",
    metadata: metadata(128, 64),
  },
  {
    id: "anim.existing",
    kind: "sprite",
    animation: "existing",
    absolute_path: "C:/assets/blink2.png",
    metadata: metadata(64, 64),
  },
  {
    id: "bgm.theme",
    kind: "bgm",
    path: "audio/theme.ogg",
    absolute_path: "C:/assets/theme.ogg",
  },
];

function renderPanel(onCreate = vi.fn(() => true)) {
  const result = render(
    <ImageAnimationPanel
      assets={ASSETS}
      existingAnimationIds={new Set(["existing"])}
      existingAnimationPaths={new Set(["animations/existing.yaml"])}
      existingAssetIds={
        new Set([...ASSETS.map((asset) => asset.id), "existing"])
      }
      onClose={() => undefined}
      onCreate={onCreate}
    />,
  );
  const list = (): string[] =>
    Array.from(
      result.container.querySelectorAll(".animation-candidate-list button"),
    ).map((button) => button.textContent ?? "");
  const frameOrder = (): string[] =>
    Array.from(
      result.container.querySelectorAll(
        ".animation-frame-list .animation-frame-name strong",
      ),
    ).map((element) => element.textContent ?? "");
  return { ...result, frameOrder, list };
}

describe("ImageAnimationPanel", () => {
  afterEach(cleanup);

  it("orders frame candidates naturally and marks animated assets", () => {
    const panel = renderPanel();
    const labels = panel.list();
    expect(labels[0]).toContain("blink2.png");
    expect(labels[1]).toContain("blink10.png");
    expect(labels[2]).toContain("odd.png");
    // Animated assets and non-image assets are never offered as frames.
    expect(labels.some((label) => label.includes("anim.existing"))).toBe(false);
    expect(labels.some((label) => label.includes("theme.ogg"))).toBe(false);
  });

  it("sorts picked frames naturally and reorders with the move buttons", () => {
    const panel = renderPanel();
    fireEvent.click(panel.getByRole("button", { name: /blink10\.png/ }));
    fireEvent.click(panel.getByRole("button", { name: /blink2\.png/ }));
    expect(panel.frameOrder()).toEqual(["blink10.png", "blink2.png"]);

    fireEvent.click(panel.getByRole("button", { name: "按文件名自然排序" }));
    expect(panel.frameOrder()).toEqual(["blink2.png", "blink10.png"]);

    fireEvent.click(panel.getByLabelText("第 2 帧上移"));
    expect(panel.frameOrder()).toEqual(["blink10.png", "blink2.png"]);
  });

  it("applies the unified duration and keeps per-frame overrides", () => {
    const panel = renderPanel();
    fireEvent.click(panel.getByRole("button", { name: /blink2\.png/ }));
    fireEvent.click(panel.getByRole("button", { name: /blink10\.png/ }));

    fireEvent.change(panel.getByLabelText("统一帧时长"), {
      target: { value: "250" },
    });
    expect(
      (panel.getByLabelText("第 1 帧时长") as HTMLInputElement).value,
    ).toBe("250");
    expect(
      (panel.getByLabelText("第 2 帧时长") as HTMLInputElement).value,
    ).toBe("250");

    fireEvent.change(panel.getByLabelText("第 1 帧时长"), {
      target: { value: "500" },
    });
    expect(
      (panel.getByLabelText("第 1 帧时长") as HTMLInputElement).value,
    ).toBe("500");
    expect(
      (panel.getByLabelText("第 2 帧时长") as HTMLInputElement).value,
    ).toBe("250");
    expect(
      panel.container.querySelectorAll(".animation-frame-list li")[0],
    ).toHaveTextContent("覆盖");
  });

  it("reports a mismatched frame size before saving", () => {
    const panel = renderPanel();
    fireEvent.click(panel.getByRole("button", { name: /blink2\.png/ }));
    fireEvent.click(panel.getByRole("button", { name: /odd\.png/ }));

    expect(panel.getByRole("alert")).toHaveTextContent(
      "第 2 帧尺寸 128×64 与第 1 帧 64×64 不一致",
    );
    expect(panel.getByRole("button", { name: "创建动画素材" })).toBeDisabled();
  });

  it("reports an animation id that collides with an asset id", () => {
    const panel = renderPanel();
    fireEvent.click(panel.getByRole("button", { name: /blink2\.png/ }));
    fireEvent.change(panel.getByLabelText("动画 ID"), {
      target: { value: "img.blink2" },
    });
    expect(panel.getByRole("alert")).toHaveTextContent(
      "动画 ID img.blink2 与素材 ID 冲突",
    );
  });

  it("creates a draft from the ordered frames and default ids", () => {
    const onCreate = vi.fn(() => true);
    const panel = renderPanel(onCreate);
    fireEvent.click(panel.getByRole("button", { name: /blink10\.png/ }));
    fireEvent.click(panel.getByRole("button", { name: /blink2\.png/ }));
    fireEvent.click(panel.getByRole("button", { name: "按文件名自然排序" }));
    fireEvent.change(panel.getByLabelText("统一帧时长"), {
      target: { value: "120" },
    });
    fireEvent.change(panel.getByLabelText("素材类型"), {
      target: { value: "background" },
    });

    expect((panel.getByLabelText("动画 ID") as HTMLInputElement).value).toBe(
      "blink2",
    );
    expect((panel.getByLabelText("素材 ID") as HTMLInputElement).value).toBe(
      "anim.blink2",
    );
    fireEvent.click(panel.getByRole("button", { name: "创建动画素材" }));

    expect(onCreate).toHaveBeenCalledWith({
      id: "blink2",
      assetId: "anim.blink2",
      kind: "background",
      frames: [
        { asset: "img.blink2", duration_ms: 120 },
        { asset: "img.blink10", duration_ms: 120 },
      ],
    });
  });
});

describe("inspector asset selector", () => {
  afterEach(cleanup);

  const manifest: ContentManifest = {
    schema_version: 2,
    content_version: "test",
    entry_scene: "scene-a",
    default_locale: "zh-CN",
    variables: {},
    characters: {},
    assets: {
      "bg.plain": { kind: "background", path: "backgrounds/plain.png" },
      "bg.blink": { kind: "background", animation: "blink" },
    },
    scenes: [],
    ui_motions: [],
    animations: ["animations/blink.yaml"],
    ui_motion_defaults: {},
  };
  const scene: SceneDefinition = {
    schema_version: 2,
    id: "scene-a",
    entry: "start",
    nodes: {
      start: {
        type: "background",
        background: "bg.blink",
        transition: { type: "cut" },
        easing: "linear",
        duration_ms: 0,
        await: false,
        next: "start",
      },
    },
  };

  const assets: EditorAsset[] = [
    {
      id: "bg.plain",
      kind: "background",
      path: "backgrounds/plain.png",
      absolute_path: "C:/assets/plain.png",
      metadata: metadata(1920, 1080),
    },
    {
      id: "bg.blink",
      kind: "background",
      animation: "blink",
      absolute_path: "C:/assets/plain.png",
      metadata: metadata(1920, 1080),
    },
  ];

  it("marks an animated asset and plays it in the selector preview", () => {
    const { container, getByText } = render(
      <NodeInspector
        animations={[
          {
            path: "animations/blink.yaml",
            definition: {
              schema_version: 1,
              id: "blink",
              frames: [
                { asset: "bg.plain", duration_ms: 100 },
                { asset: "bg.plain", duration_ms: 100 },
              ],
            },
          },
        ]}
        assets={assets}
        buttons={[]}
        manifest={manifest}
        nodeId="start"
        onChange={() => undefined}
        onConvertToTimeline={() => undefined}
        onDelete={() => undefined}
        onDuplicate={() => undefined}
        onOpenLongTextWorkspace={() => undefined}
        onRename={() => undefined}
        onSetEntry={() => undefined}
        onSplitDialogue={() => undefined}
        onSplitLongText={() => undefined}
        scene={scene}
        scenes={[scene]}
        uiMotions={[]}
      />,
    );
    expect(getByText("bg.blink（动画）")).toBeInTheDocument();
    expect(container.querySelector(".frame-sequence-preview")).not.toBeNull();
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
  });
});

describe("animation round trip", () => {
  const projectPayload = {
    root: "C:/project",
    manifest: {
      schema_version: 2,
      content_version: "test",
      entry_scene: "scene-a",
      default_locale: "zh-CN",
      variables: {},
      characters: {},
      assets: {
        "img.blink2": { kind: "sprite", path: "sprite/blink2.png" },
        "anim.blink": { kind: "sprite", animation: "blink" },
      },
      scenes: ["scenes/scene-a.yaml"],
      ui_motions: [],
      buttons: [],
      animations: ["animations/blink.yaml"],
      ui_motion_defaults: {},
      chapter_map: null,
    },
    scenes: [],
    ui_motions: [],
    buttons: [],
    animations: [
      {
        path: "animations/blink.yaml",
        definition: {
          schema_version: 1,
          id: "blink",
          frames: [{ asset: "img.blink2", duration_ms: 120 }],
        },
      },
    ],
    chapter_map: null,
    layout: { version: 1, scenes: {} },
    assets: [
      {
        id: "anim.blink",
        kind: "sprite",
        animation: "blink",
        absolute_path: "C:/project/assets/sprite/blink2.png",
        size_bytes: "1024",
        metadata: metadata(64, 64),
      },
    ],
    diagnostics: [],
    fingerprint: "fingerprint",
  };

  it("keeps animations and the asset animation field on open and save", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(projectPayload);
    const project = await editorApi.openProject("C:/project");
    expect(project.animations).toEqual([
      {
        path: "animations/blink.yaml",
        definition: {
          schema_version: 1,
          id: "blink",
          frames: [{ asset: "img.blink2", duration_ms: 120 }],
        },
      },
    ]);
    expect(project.assets[0]).toMatchObject({
      id: "anim.blink",
      animation: "blink",
      size_bytes: "1024",
      metadata: { width: 64, height: 64 },
    });
    expect(project.manifest.animations).toEqual(["animations/blink.yaml"]);

    vi.mocked(invoke).mockResolvedValueOnce({
      project: projectPayload,
      changed_paths: [],
      deleted_paths: [],
      warnings: [],
      transaction_id: null,
    });
    await editorApi.saveProject(projectRequest(project));
    const [, args] = vi.mocked(invoke).mock.calls.at(-1) ?? [];
    const request = (args as { request: Record<string, unknown> }).request;
    expect(request.animations).toEqual(project.animations);
    expect((request.manifest as { animations: unknown }).animations).toEqual([
      "animations/blink.yaml",
    ]);
  });
});

describe("save request", () => {
  it("carries the animation documents through projectRequest", () => {
    const manifest: ContentManifest = {
      schema_version: 2,
      content_version: "test",
      entry_scene: "scene-a",
      default_locale: "zh-CN",
      variables: {},
      characters: {},
      assets: {
        "img.blink2": { kind: "sprite", path: "sprite/blink2.png" },
        "anim.blink": { kind: "sprite", animation: "blink" },
      },
      scenes: [],
      ui_motions: [],
      animations: ["animations/blink.yaml"],
      ui_motion_defaults: {},
    };
    const project: EditorProject = {
      root: "C:/project",
      manifest,
      scenes: [],
      ui_motions: [],
      buttons: [],
      animations: [
        {
          path: "animations/blink.yaml",
          definition: {
            schema_version: 1,
            id: "blink",
            frames: [{ asset: "img.blink2", duration_ms: 120 }],
          },
        },
      ],
      layout: { version: 1, scenes: {} },
      assets: [
        {
          id: "anim.blink",
          kind: "sprite",
          animation: "blink",
          absolute_path: "C:/assets/blink2.png",
        },
      ],
      diagnostics: [],
      fingerprint: "fingerprint",
    };
    const request = projectRequest(project);
    expect(request.animations).toEqual(project.animations);
    expect(request.manifest.animations).toEqual(["animations/blink.yaml"]);
  });
});
