import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChapterMapSnapshot } from "@vectspace/presentation-core/types";
import { ChapterMapPage } from "./ChapterMapPage";

const MAP: ChapterMapSnapshot = {
  width: 4000,
  height: 2160,
  view_x: 960,
  view_y: 540,
  background: null,
  decorations: [
    {
      id: "backdrop",
      asset: "gui.backdrop",
      x: 0,
      y: 0,
      width: 500,
      height: 300,
      z: 20,
    },
  ],
  hotspots: [
    {
      id: "a",
      scene_id: "scene_a",
      title: "章节 A",
      hover_text: "章节 A 说明",
      x: 100,
      y: 100,
      width: 300,
      height: 180,
      z: 10,
      asset: null,
      completed: true,
    },
    {
      id: "b",
      scene_id: "scene_b",
      title: "章节 B",
      hover_text: "章节 B 说明",
      x: 100,
      y: 100,
      width: 300,
      height: 180,
      z: 10,
      asset: "gui.chapter_b",
      completed: true,
    },
    {
      id: "locked",
      scene_id: "locked_scene",
      title: "未完成章节",
      hover_text: null,
      x: 500,
      y: 100,
      width: 300,
      height: 180,
      z: 10,
      asset: null,
      completed: false,
    },
    {
      // Author opened this chapter on purpose before the story reaches it.
      id: "open_early",
      scene_id: "early_scene",
      title: "提前开放的章节",
      hover_text: null,
      x: 900,
      y: 100,
      width: 300,
      height: 180,
      z: 10,
      asset: null,
      completed: false,
      replayable: true,
    },
  ],
};

afterEach(cleanup);

describe("ChapterMapPage", () => {
  it("keeps decorations non-interactive and only replays completed hotspots", () => {
    const onReplay = vi.fn();
    render(
      <ChapterMapPage
        assets={{
          "gui.backdrop": "backdrop.png",
          "gui.chapter_b": "chapter-b.png",
        }}
        map={MAP}
        onClose={() => undefined}
        onReplay={onReplay}
      />,
    );

    // The shared z/id ordering leaves b on top of a for an equal-z overlap;
    // the DOM order mirrors that rule and never exposes a decoration target.
    const hotspotButtons = screen.getAllByRole("button", {
      name: /章节 [AB]，可重演/,
    });
    expect(
      hotspotButtons.map((button) => button.getAttribute("aria-label")),
    ).toEqual(["章节 A，可重演", "章节 B，可重演"]);
    expect(
      screen.getByRole("button", { name: "未完成章节，尚未完成" }),
    ).toBeDisabled();
    // A chapter the author marked as always replayable is enterable and is
    // never labelled as unreached.
    const openEarly = screen.getByRole("button", {
      name: "提前开放的章节，尚未到达但可直接进入",
    });
    expect(openEarly).toBeEnabled();
    expect(openEarly).not.toHaveClass("is-locked");
    fireEvent.click(openEarly);
    expect(onReplay).toHaveBeenCalledWith("early_scene");
    expect(document.querySelector(".chapter-map-decoration")).toHaveAttribute(
      "draggable",
      "false",
    );
    const artworkHotspot = screen.getByRole("button", {
      name: "章节 B，可重演",
    });
    expect(artworkHotspot).toHaveClass("has-artwork");
    expect(artworkHotspot).toBeEmptyDOMElement();

    fireEvent.click(artworkHotspot);
    expect(onReplay).toHaveBeenCalledWith("scene_b");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(artworkHotspot).not.toHaveClass("is-selected");
  });

  it("pans from the room background and reports a clamped session center", () => {
    const onViewChange = vi.fn();
    render(
      <ChapterMapPage
        assets={{ "gui.backdrop": "backdrop.png" }}
        map={MAP}
        onClose={() => undefined}
        onReplay={() => undefined}
        onViewChange={onViewChange}
      />,
    );
    const viewport = screen.getByRole("application");
    Object.defineProperty(viewport, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 1920, height: 1080 }),
    });

    fireEvent.pointerDown(viewport, {
      button: 0,
      clientX: 400,
      clientY: 400,
      pointerId: 1,
    });
    fireEvent.pointerMove(viewport, {
      clientX: -2000,
      clientY: -2000,
      pointerId: 1,
    });
    fireEvent.pointerUp(viewport, { pointerId: 1 });

    expect(onViewChange).toHaveBeenLastCalledWith({ x: 3040, y: 1620 });
  });

  it("keeps a hotspot gesture out of room panning and replays it on click", () => {
    const onViewChange = vi.fn();
    const onReplay = vi.fn();
    render(
      <ChapterMapPage
        assets={{ "gui.backdrop": "backdrop.png" }}
        map={MAP}
        onClose={() => undefined}
        onReplay={onReplay}
        onViewChange={onViewChange}
      />,
    );
    const viewport = screen.getByRole("application");
    const hotspot = screen.getByRole("button", { name: "章节 B，可重演" });
    Object.defineProperty(viewport, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 1920, height: 1080 }),
    });

    fireEvent.pointerDown(hotspot, {
      button: 0,
      clientX: 200,
      clientY: 200,
      pointerId: 7,
    });
    fireEvent.pointerMove(viewport, {
      clientX: 260,
      clientY: 200,
      pointerId: 7,
    });
    fireEvent.pointerUp(viewport, { pointerId: 7 });
    fireEvent.click(hotspot);

    expect(onReplay).toHaveBeenCalledWith("scene_b");
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it("shows custom hover text and clears it when map artwork is refreshed", () => {
    const { rerender } = render(
      <ChapterMapPage
        assets={{ "gui.chapter_b": "chapter-b.png" }}
        map={MAP}
        onClose={() => undefined}
        onReplay={() => undefined}
      />,
    );
    const hotspot = screen.getByRole("button", { name: "章节 B，可重演" });
    fireEvent.pointerEnter(hotspot);
    expect(screen.getByRole("tooltip")).toHaveTextContent("章节 B 说明");

    rerender(
      <ChapterMapPage
        assets={{ "gui.chapter_b": "chapter-b-replaced.png" }}
        map={MAP}
        onClose={() => undefined}
        onReplay={() => undefined}
      />,
    );

    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("falls back to the title and hides an explicitly empty hover card", () => {
    const map = {
      ...MAP,
      hotspots: MAP.hotspots.map((hotspot) =>
        hotspot.id === "a"
          ? { ...hotspot, hover_text: null }
          : hotspot.id === "b"
            ? { ...hotspot, hover_text: "" }
            : hotspot,
      ),
    };
    render(
      <ChapterMapPage
        assets={{ "gui.chapter_b": "chapter-b.png" }}
        map={map}
        onClose={() => undefined}
        onReplay={() => undefined}
      />,
    );
    const titleFallback = screen.getByRole("button", {
      name: "章节 A，可重演",
    });
    fireEvent.pointerEnter(titleFallback);
    expect(screen.getByRole("tooltip")).toHaveTextContent("章节 A");
    fireEvent.pointerLeave(titleFallback);
    const hiddenCard = screen.getByRole("button", { name: "章节 B，可重演" });
    fireEvent.pointerEnter(hiddenCard);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
