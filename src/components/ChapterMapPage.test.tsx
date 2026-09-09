import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChapterMapSnapshot } from "../engine/types";
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
      x: 500,
      y: 100,
      width: 300,
      height: 180,
      z: 10,
      asset: null,
      completed: false,
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
    expect(artworkHotspot).toHaveClass("is-selected");
    fireEvent.click(screen.getByRole("button", { name: "重演" }));
    expect(onReplay).toHaveBeenCalledWith("scene_b");
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

  it("keeps a hotspot gesture out of room panning and still selects it", () => {
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

    expect(
      screen.getByRole("dialog", { name: "章节 B章节操作" }),
    ).toBeVisible();
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it("clears the old hotspot selection when map artwork is refreshed", () => {
    const { rerender } = render(
      <ChapterMapPage
        assets={{ "gui.chapter_b": "chapter-b.png" }}
        map={MAP}
        onClose={() => undefined}
        onReplay={() => undefined}
      />,
    );
    const hotspot = screen.getByRole("button", { name: "章节 B，可重演" });
    fireEvent.click(hotspot);
    expect(screen.getByRole("dialog")).toBeVisible();

    rerender(
      <ChapterMapPage
        assets={{ "gui.chapter_b": "chapter-b-replaced.png" }}
        map={MAP}
        onClose={() => undefined}
        onReplay={() => undefined}
      />,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "章节 B，可重演" }),
    ).not.toHaveClass("is-selected");
  });
});
