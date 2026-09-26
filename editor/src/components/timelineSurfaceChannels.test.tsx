// @vitest-environment jsdom
/**
 * The shared timeline surface has one channel picker for every track head.  A
 * channel selected on one track (for example sprite `z`) must never be written
 * into a track that does not allow it (a camera track).  The per-track head
 * normalizes to an allowed channel and "＋关键帧" uses that normalized channel.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  TimelineSurface,
  type TimelineSurfaceDocument,
  type TimelineSurfaceTrack,
} from "./TimelineSurface";

afterEach(cleanup);

interface TrackData {
  kind: "sprite" | "camera";
}

function initialDocument(): TimelineSurfaceDocument<TrackData> {
  const sprite: TimelineSurfaceTrack<TrackData> = {
    id: "sprite:a",
    label: "sprite a",
    channels: {},
    allowedChannels: ["x", "y", "scale", "z"],
    defaults: { x: 0, y: 0, scale: 1, z: 0 },
    data: { kind: "sprite" },
  };
  const camera: TimelineSurfaceTrack<TrackData> = {
    id: "camera",
    label: "camera",
    channels: {},
    allowedChannels: ["x", "y", "zoom", "rotation_deg"],
    defaults: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
    data: { kind: "camera" },
  };
  return { duration_ms: 1000, tracks: [sprite, camera], events: [] };
}

function Harness(): ReactElement {
  const [document, setDocument] = useState(initialDocument);
  const [channelName, setChannelName] = useState("z");
  return (
    <>
      <TimelineSurface<TrackData>
        channelName={channelName}
        document={document}
        onChange={setDocument}
        onChannelNameChange={setChannelName}
        onPlayheadChange={() => undefined}
        playhead={0}
        showTransport
      />
      <output data-testid="doc">{JSON.stringify(document.tracks)}</output>
    </>
  );
}

function trackChannels(): { channels: Record<string, unknown> }[] {
  return JSON.parse(screen.getByTestId("doc").textContent ?? "[]") as {
    channels: Record<string, unknown>;
  }[];
}

describe("TimelineSurface channel guard", () => {
  it("normalizes a shared channel selection per track", () => {
    render(<Harness />);
    const selectors = screen.getAllByLabelText("关键帧通道");
    // The sprite track allows `z`; the camera track falls back to its first
    // allowed channel instead of rendering an invalid selection.
    expect(selectors[0]).toHaveValue("z");
    expect(selectors[1]).toHaveValue("x");
  });

  it("removes the channel after deleting its last keyframe", () => {
    render(<Harness />);
    fireEvent.click(screen.getAllByRole("button", { name: "＋关键帧" })[0]);
    expect(trackChannels()[0]?.channels).toHaveProperty("z");
    fireEvent.pointerDown(screen.getByRole("button", { name: "z 0ms" }));
    fireEvent.click(screen.getByRole("button", { name: "删除关键帧" }));
    expect(trackChannels()[0]?.channels).not.toHaveProperty("z");
  });

  it("never adds an unsupported channel to a track", () => {
    render(<Harness />);
    // The shared selection is `z` (valid on the sprite track).  Adding a
    // keyframe on the camera track must use the camera's normalised channel.
    fireEvent.click(screen.getAllByRole("button", { name: "＋关键帧" })[1]);

    const tracks = trackChannels();
    const spriteChannels = Object.keys(tracks[0]?.channels ?? {});
    const cameraChannels = Object.keys(tracks[1]?.channels ?? {});
    expect(spriteChannels).toEqual([]);
    expect(cameraChannels).toEqual(["x"]);
    expect(cameraChannels).not.toContain("z");
  });
});
