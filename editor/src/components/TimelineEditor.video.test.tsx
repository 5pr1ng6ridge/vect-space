// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditorAsset, TimelineNode, TimelineTrack } from "../types";
import { TimelineEditor } from "./TimelineEditor";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
}));

afterEach(cleanup);

const VIDEO_ASSET: EditorAsset = {
  id: "clip",
  kind: "video",
  path: "video/clip.mp4",
  absolute_path: "C:/game/video/clip.mp4",
};

type VideoTrack = Extract<TimelineTrack, { type: "video" }>;

function nodeWithVideo(track: Partial<VideoTrack>): TimelineNode {
  return {
    type: "timeline",
    duration_ms: 10_000,
    await: true,
    skippable: true,
    tracks: [
      {
        type: "video",
        asset: "clip",
        clip_start_ms: 0,
        clip_end_ms: null,
        loop: false,
        fit: "contain",
        audio_enabled: true,
        channels: {},
        ...track,
      },
    ],
    events: [],
    next: "end",
  };
}

/**
 * The standalone stage reads a real `HTMLVideoElement`; jsdom neither loads the
 * source nor reports a duration, so the test pins `duration` on the element and
 * drives the playhead through the component's override prop.
 */
function renderStage(track: Partial<VideoTrack>, mediaDurationSeconds: number) {
  const node = nodeWithVideo(track);
  const view = render(
    <TimelineEditor
      assets={[VIDEO_ASSET]}
      node={node}
      onChange={() => undefined}
      playheadOverride={0}
    />,
  );
  const video = view.container.querySelector("video.timeline-video-preview");
  if (!(video instanceof HTMLVideoElement)) throw new Error("missing video");
  Object.defineProperty(video, "duration", {
    configurable: true,
    value: mediaDurationSeconds,
  });
  const seekTo = (playhead: number): void => {
    view.rerender(
      <TimelineEditor
        assets={[VIDEO_ASSET]}
        node={node}
        onChange={() => undefined}
        playheadOverride={playhead}
      />,
    );
  };
  return { video, seekTo };
}

describe("standalone timeline preview video window", () => {
  it("clamps a non-loop playhead at the authored clip end", () => {
    const { video, seekTo } = renderStage({ clip_end_ms: 2_000 }, 10);
    seekTo(3_000);
    expect(video.currentTime).toBeCloseTo(2, 5);
  });

  it("wraps a looping playhead inside the authored bounds", () => {
    const { video, seekTo } = renderStage(
      { clip_start_ms: 1_000, clip_end_ms: 3_000, loop: true },
      10,
    );
    seekTo(3_500);
    expect(video.currentTime).toBeCloseTo(2.5, 5);
  });

  it("falls back to the media duration when no clip end is authored", () => {
    const { video, seekTo } = renderStage({}, 4);
    seekTo(5_000);
    expect(video.currentTime).toBeCloseTo(4, 5);
  });

  it("offsets an open window by the clip start", () => {
    const { video, seekTo } = renderStage({ clip_start_ms: 1_000 }, 10);
    seekTo(500);
    expect(video.currentTime).toBeCloseTo(1.5, 5);
  });

  it("syncs a fixed playhead when metadata loads after mount", () => {
    // A paused workspace transport renders once with a fixed playhead and
    // never moves it again; the length only arrives with `loadedmetadata`.
    const node = nodeWithVideo({ clip_end_ms: 2_000 });
    const view = render(
      <TimelineEditor
        assets={[VIDEO_ASSET]}
        node={node}
        onChange={() => undefined}
        playheadOverride={5_000}
      />,
    );
    const video = view.container.querySelector("video.timeline-video-preview");
    if (!(video instanceof HTMLVideoElement)) throw new Error("missing video");
    expect(video.currentTime).toBe(0);
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: 10,
    });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBeCloseTo(2, 5);
  });
});
