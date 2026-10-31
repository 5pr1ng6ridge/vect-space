// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  EditorAsset,
  EditorLayout,
  TimelineNode,
  TimelineTrack,
} from "../types";
import { AssetLayoutProvider } from "./AssetChooser";
import { TimelineEditor } from "./TimelineEditor";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
}));

afterEach(cleanup);

const SPRITE: EditorAsset = {
  id: "sprite.hero",
  kind: "sprite",
  path: "sprites/hero.png",
  absolute_path: "C:/game/sprites/hero.png",
};
const VIDEO: EditorAsset = {
  id: "video.clip",
  kind: "video",
  path: "video/clip.mp4",
  absolute_path: "C:/game/video/clip.mp4",
};
const SFX: EditorAsset = {
  id: "sfx.hit",
  kind: "sfx",
  path: "audio/hit.ogg",
  absolute_path: "C:/game/audio/hit.ogg",
};

function baseNode(): TimelineNode {
  return {
    type: "timeline",
    duration_ms: 1_000,
    await: true,
    skippable: true,
    tracks: [{ type: "camera", channels: {} }],
    events: [],
    next: "end",
  };
}

function allHiddenLayout(): EditorLayout {
  return {
    version: 1,
    scenes: {},
    asset_metadata: {
      "video.clip": { hidden: true },
      "sfx.hit": { hidden: true },
      "sprite.hero": { hidden: true },
    },
  };
}

function renderEditor(
  assets: readonly EditorAsset[],
  onChange: (node: TimelineNode) => void,
  layout?: EditorLayout,
) {
  const editor = (
    <TimelineEditor
      assets={[...assets]}
      node={baseNode()}
      onChange={onChange}
    />
  );
  return render(
    layout === undefined ? (
      editor
    ) : (
      <AssetLayoutProvider layout={layout}>{editor}</AssetLayoutProvider>
    ),
  );
}

// A sprite track may inherit the entry asset (`asset: null`), but video tracks
// and SFX events need a registered, visible asset: otherwise the control is
// disabled and nothing is written (Rust rejects `asset: ""`).
describe("timeline creation without a visible asset", () => {
  it("disables video/SFX controls and never writes an empty asset", () => {
    const onChange = vi.fn<(node: TimelineNode) => void>();
    renderEditor([], onChange);

    const sfx = screen.getByRole("button", { name: "＋SFX 事件" });
    expect(sfx).toBeDisabled();
    expect(sfx).toHaveAttribute("title", expect.stringContaining("音效"));
    fireEvent.click(sfx);

    fireEvent.change(screen.getByLabelText("新建轨道类型"), {
      target: { value: "video" },
    });
    const addTrack = screen.getByRole("button", { name: "＋轨道" });
    expect(addTrack).toBeDisabled();
    fireEvent.click(addTrack);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("treats a fully hidden asset list the same as an empty one", () => {
    renderEditor([SPRITE, VIDEO, SFX], vi.fn(), allHiddenLayout());
    expect(screen.getByRole("button", { name: "＋SFX 事件" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("新建轨道类型"), {
      target: { value: "video" },
    });
    expect(screen.getByRole("button", { name: "＋轨道" })).toBeDisabled();
  });

  it("still creates a sprite track that inherits the entry asset (null)", () => {
    const onChange = vi.fn<(node: TimelineNode) => void>();
    renderEditor([], onChange);
    fireEvent.click(screen.getByRole("button", { name: "＋轨道" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    const sprite = next.tracks.find(
      (track): track is Extract<TimelineTrack, { type: "sprite" }> =>
        track.type === "sprite",
    );
    expect(sprite?.asset).toBeNull();
  });

  it("uses the real asset id when one is visible", () => {
    const onChange = vi.fn<(node: TimelineNode) => void>();
    renderEditor([SPRITE, VIDEO, SFX], onChange);

    fireEvent.change(screen.getByLabelText("新建轨道类型"), {
      target: { value: "video" },
    });
    const addTrack = screen.getByRole("button", { name: "＋轨道" });
    expect(addTrack).toBeEnabled();
    fireEvent.click(addTrack);
    let next = onChange.mock.calls.at(-1)?.[0] as TimelineNode;
    const video = next.tracks.find(
      (track): track is Extract<TimelineTrack, { type: "video" }> =>
        track.type === "video",
    );
    expect(video?.asset).toBe("video.clip");

    const sfx = screen.getByRole("button", { name: "＋SFX 事件" });
    expect(sfx).toBeEnabled();
    fireEvent.click(sfx);
    next = onChange.mock.calls.at(-1)?.[0] as TimelineNode;
    const event = next.events.find((candidate) => candidate.type === "sfx");
    expect(event).toMatchObject({ asset: "sfx.hit" });
  });
});

const AMBIENCE_NODE: TimelineNode = {
  type: "timeline",
  duration_ms: 1_000,
  await: true,
  skippable: true,
  tracks: [
    { type: "ambience", slot: "slot_2", channels: {} },
    { type: "camera", channels: {} },
  ],
  events: [],
  next: "end",
};

function AmbienceHarness(): ReactElement {
  const [node, setNode] = useState(AMBIENCE_NODE);
  return (
    <>
      <TimelineEditor
        assets={[] as EditorAsset[]}
        hidePreview
        node={node}
        onChange={setNode}
      />
      <output data-testid="node-json">{JSON.stringify(node)}</output>
    </>
  );
}

/** Track headers of the ambience tracks, in display order. */
function ambienceTrackTitles(): string[] {
  return Array.from(document.querySelectorAll(".timeline-track-head strong"))
    .map((title) => title.textContent ?? "")
    .filter((title) => title.startsWith("环境声"));
}

describe("ambience timeline authoring", () => {
  it("assigns unused fixed slots, exposes volume automation, and caps at four tracks", () => {
    render(<AmbienceHarness />);
    const trackType = screen.getAllByRole("combobox")[0];
    if (trackType === undefined) throw new Error("missing track type selector");
    fireEvent.change(trackType, { target: { value: "ambience" } });

    for (let index = 0; index < 4; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "＋轨道" }));
    }

    expect(ambienceTrackTitles()).toEqual([
      "环境声 2",
      "环境声 1",
      "环境声 3",
      "环境声 4",
    ]);

    // The shared toolbar channel switches to the only ambience channel.
    const comboboxes = screen.getAllByRole<HTMLSelectElement>("combobox");
    expect(comboboxes.some((field) => field.value === "volume")).toBe(true);
    const keyframeButton = screen.getAllByRole("button", {
      name: "＋关键帧",
    })[0];
    if (keyframeButton === undefined)
      throw new Error("missing ambience keyframe button");
    fireEvent.click(keyframeButton);
    expect(screen.getByTestId("node-json").textContent).toContain(
      '"volume":[{"at_ms":0,"value":1,"easing":"linear"}]',
    );

    // The fifth add is ignored rather than creating a duplicate slot or an
    // unaddressable fifth ambience lane.
    fireEvent.click(screen.getByRole("button", { name: "＋轨道" }));
    expect(ambienceTrackTitles()).toHaveLength(4);
  });
});
