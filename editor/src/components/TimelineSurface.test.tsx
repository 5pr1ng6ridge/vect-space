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

function EventHarness(): ReactElement {
  const [document, setDocument] = useState<TimelineSurfaceDocument<TrackData>>(
    () => ({
      ...initialDocument(),
      events: [{ id: "flash_1", type: "screen_effect", at_ms: 400 } as never],
    }),
  );
  return (
    <>
      <TimelineSurface<TrackData>
        channelName="x"
        document={document}
        onChange={setDocument}
        onChannelNameChange={() => undefined}
        onPlayheadChange={() => undefined}
        playhead={0}
        showEvents
      />
      <output data-testid="events">{document.events.length}</output>
    </>
  );
}

describe("TimelineSurface events", () => {
  it("never deletes an event on double-click; select + Delete removes it", () => {
    render(<EventHarness />);
    const marker = screen.getByRole("button", { name: "flash_1 400ms" });
    fireEvent.doubleClick(marker);
    expect(screen.getByTestId("events")).toHaveTextContent("1");
    fireEvent.click(marker);
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(screen.getByTestId("events")).toHaveTextContent("0");
  });
});

function ShortTimelineHarness(): ReactElement {
  const [document, setDocument] = useState<TimelineSurfaceDocument<TrackData>>({
    duration_ms: 500,
    tracks: [
      {
        id: "short",
        label: "short",
        channels: {
          x: [
            { at_ms: 0, value: 0, easing: "linear" },
            { at_ms: 500, value: 1, easing: "linear" },
          ],
        },
        allowedChannels: ["x"],
        defaults: { x: 0 },
        data: { kind: "sprite" },
      },
    ],
    events: [],
  });
  const [playhead, setPlayhead] = useState(0);
  return (
    <>
      <TimelineSurface<TrackData>
        channelName="x"
        document={document}
        onChange={setDocument}
        onChannelNameChange={() => undefined}
        onPlayheadChange={setPlayhead}
        playbackStart={100}
        playhead={playhead}
        snap={50}
      />
      <output data-testid="short-doc">{JSON.stringify(document)}</output>
      <output data-testid="short-playhead">{playhead}</output>
    </>
  );
}

describe("TimelineSurface short duration endpoints", () => {
  it("keeps a 500ms terminal marker on the exact endpoint and draggable", () => {
    render(<ShortTimelineHarness />);
    const marker = screen.getByRole("button", { name: "x 500ms" });
    expect(marker).toHaveStyle({ left: "100%" });
    expect(screen.getByText("0.50s")).toHaveStyle({ left: "100%" });
    expect(document.querySelector(".timeline-playback-start")).toHaveStyle({
      left: "20%",
    });

    const ruler = document.querySelector(".timeline-ruler");
    expect(ruler).not.toBeNull();
    Object.defineProperty(ruler, "clientWidth", {
      configurable: true,
      value: 500,
    });
    fireEvent.pointerDown(marker, { button: 0, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 450 });
    fireEvent.pointerUp(window);

    const doc = JSON.parse(
      screen.getByTestId("short-doc").textContent ?? "{}",
    ) as TimelineSurfaceDocument<TrackData>;
    expect(doc.tracks[0]?.channels.x?.map((frame) => frame.at_ms)).toEqual([
      0, 450,
    ]);
  });

  it("snaps a double-click near 500ms using the playback-start grid", () => {
    render(<ShortTimelineHarness />);
    const lane = document.querySelector(".timeline-channel > div");
    expect(lane).not.toBeNull();
    Object.defineProperty(lane, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        right: 500,
        top: 0,
        bottom: 20,
        width: 500,
        height: 20,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    fireEvent.doubleClick(lane as HTMLElement, { clientX: 500 });
    expect(screen.getByTestId("short-playhead")).toHaveTextContent("500");
    const doc = JSON.parse(
      screen.getByTestId("short-doc").textContent ?? "{}",
    ) as TimelineSurfaceDocument<TrackData>;
    expect(doc.tracks[0]?.channels.x?.map((frame) => frame.at_ms)).toEqual([
      0, 500,
    ]);
  });
});
