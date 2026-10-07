// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ParticleGizmo } from "./ParticleGizmo";

afterEach(cleanup);

const AREA = { width: 400, height: 100 };

function measure(): void {
  screen.getByRole("group", { name: "粒子生成点" }).getBoundingClientRect = () => ({
    width: 960,
    height: 540,
    left: 100,
    top: 50,
    right: 1060,
    bottom: 590,
    x: 100,
    y: 50,
    toJSON: () => ({}),
  });
}

describe("ParticleGizmo", () => {
  it("maps client pixels through the measured layer, not 1:1", () => {
    // The layer is shown at half size: 100 client pixels are 200 design pixels.
    const onAreaResize = vi.fn();
    render(
      <ParticleGizmo
        area={AREA}
        markerAriaLabel="中心"
        markerLabel="中心"
        onAreaResize={onAreaResize}
        point={{ x: 960, y: 540 }}
      />,
    );
    measure();
    const east = screen.getByLabelText("调整生成区域右边");
    // The east handle is at design (1160, 540) = client (680, 320).
    fireEvent.pointerDown(east, { button: 0, clientX: 680, clientY: 320 });
    fireEvent.pointerMove(east, { clientX: 730, clientY: 320 });
    fireEvent.pointerUp(east, { clientX: 730, clientY: 320 });
    expect(onAreaResize).toHaveBeenCalledTimes(1);
    // 50 client pixels = 100 design pixels, doubled for the symmetric area.
    expect(onAreaResize).toHaveBeenCalledWith({ width: 600, height: 100 });
  });

  it("ignores non-primary buttons and a second press during a gesture", () => {
    const onAreaResize = vi.fn();
    render(
      <ParticleGizmo
        area={AREA}
        markerAriaLabel="中心"
        markerLabel="中心"
        onAreaResize={onAreaResize}
        point={{ x: 960, y: 540 }}
      />,
    );
    measure();
    const east = screen.getByLabelText("调整生成区域右边");
    const south = screen.getByLabelText("调整生成区域下边");

    fireEvent.pointerDown(east, { button: 2, clientX: 680, clientY: 320 });
    fireEvent.pointerMove(east, { clientX: 780, clientY: 320 });
    fireEvent.pointerUp(east, { clientX: 780, clientY: 320 });
    expect(onAreaResize).not.toHaveBeenCalled();

    fireEvent.pointerDown(east, { button: 0, clientX: 680, clientY: 320 });
    // A second handle cannot start while the first gesture owns the pointer.
    fireEvent.pointerDown(south, { button: 0, clientX: 580, clientY: 345 });
    fireEvent.pointerMove(east, { clientX: 730, clientY: 320 });
    fireEvent.pointerUp(east, { clientX: 730, clientY: 320 });
    expect(onAreaResize).toHaveBeenCalledTimes(1);
    expect(onAreaResize).toHaveBeenCalledWith({ width: 600, height: 100 });
  });

  it("commits through the newest callback when the owner re-rendered mid-drag", () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const props = {
      area: AREA,
      markerAriaLabel: "中心",
      markerLabel: "中心",
      point: { x: 960, y: 540 },
    };
    const view = render(<ParticleGizmo {...props} onAreaResize={stale} />);
    measure();
    const east = screen.getByLabelText("调整生成区域右边");
    fireEvent.pointerDown(east, { button: 0, clientX: 680, clientY: 320 });
    fireEvent.pointerMove(east, { clientX: 730, clientY: 320 });
    view.rerender(<ParticleGizmo {...props} onAreaResize={fresh} />);
    fireEvent.pointerUp(east, { clientX: 730, clientY: 320 });
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("drops the gesture when it unmounts mid-drag: no commit, no leaked listeners", () => {
    const onAreaResize = vi.fn();
    const onMarkerDrop = vi.fn(() => true);
    const view = render(
      <ParticleGizmo
        area={AREA}
        markerAriaLabel="中心"
        markerLabel="中心"
        onAreaResize={onAreaResize}
        onMarkerDrop={onMarkerDrop}
        point={{ x: 960, y: 540 }}
      />,
    );
    measure();
    const east = screen.getByLabelText("调整生成区域右边");
    fireEvent.pointerDown(east, { button: 0, clientX: 680, clientY: 320 });
    fireEvent.pointerMove(east, { clientX: 730, clientY: 320 });
    view.unmount();
    fireEvent.pointerMove(window, { clientX: 800, clientY: 320 });
    fireEvent.pointerUp(window, { clientX: 800, clientY: 320 });
    expect(onAreaResize).not.toHaveBeenCalled();
    expect(onMarkerDrop).not.toHaveBeenCalled();
  });

  it("keeps a committed marker where it was dropped until the host moves the point", () => {
    const props = {
      markerAriaLabel: "中心",
      markerLabel: "中心",
      onMarkerDrop: () => true,
    };
    const view = render(<ParticleGizmo {...props} point={{ x: 960, y: 540 }} />);
    measure();
    const marker = screen.getByLabelText("中心");
    fireEvent.pointerDown(marker, { button: 0, clientX: 580, clientY: 320 });
    fireEvent.pointerMove(marker, { clientX: 630, clientY: 320 });
    fireEvent.pointerUp(marker, { clientX: 630, clientY: 320 });
    // 50 client pixels are 100 design pixels: the marker stays at 1060 while
    // the host has not refetched, instead of snapping back to 960.
    expect(marker.style.left).toBe(`${(1060 / 1920) * 100}%`);

    // The refetched world reports the new point; the offset is not applied twice.
    view.rerender(<ParticleGizmo {...props} point={{ x: 1060, y: 540 }} />);
    expect(marker.style.left).toBe(`${(1060 / 1920) * 100}%`);
  });

  it("does not draw a marker without a point and is not draggable without a drop owner", () => {
    const view = render(
      <ParticleGizmo markerAriaLabel="中心" markerLabel="中心" point={null} />,
    );
    expect(screen.queryByLabelText("中心")).toBeNull();
    view.rerender(
      <ParticleGizmo
        markerAriaLabel="中心"
        markerLabel="中心"
        point={{ x: 10, y: 10 }}
      />,
    );
    expect(screen.getByLabelText("中心").style.pointerEvents).toBe("none");
  });
});

describe("ParticleGizmo kept drops", () => {
  const base = {
    markerAriaLabel: "中心",
    markerLabel: "中心",
    onMarkerDrop: () => true,
  };

  function dragMarker(marker: HTMLElement): void {
    // 50 client pixels are 100 design pixels (the layer is shown at half size).
    fireEvent.pointerDown(marker, { button: 0, clientX: 580, clientY: 320 });
    fireEvent.pointerMove(marker, { clientX: 630, clientY: 320 });
    fireEvent.pointerUp(marker, { clientX: 630, clientY: 320 });
  }

  it("releases a kept drop when the host answers again with the very same point", () => {
    // A drop that was undone before its refetch arrived: the refetch reports
    // the original point again, so only the revision can tell it is obsolete.
    const view = render(
      <ParticleGizmo {...base} point={{ x: 960, y: 540 }} revision={1} />,
    );
    measure();
    const marker = screen.getByLabelText("中心");
    dragMarker(marker);
    expect(marker.style.left).toBe(`${(1060 / 1920) * 100}%`);

    // An unrelated host re-render keeps the pending drop on screen.
    view.rerender(
      <ParticleGizmo {...base} point={{ x: 960, y: 540 }} revision={1} />,
    );
    expect(marker.style.left).toBe(`${(1060 / 1920) * 100}%`);

    view.rerender(
      <ParticleGizmo {...base} point={{ x: 960, y: 540 }} revision={2} />,
    );
    expect(marker.style.left).toBe(`${(960 / 1920) * 100}%`);
  });

  it("continues from the shown position when a kept drop is grabbed again", () => {
    const onMarkerDrop = vi.fn(() => true);
    const props = {
      markerAriaLabel: "中心",
      markerLabel: "中心",
      onMarkerDrop,
      point: { x: 960, y: 540 },
      revision: 1,
    };
    render(<ParticleGizmo {...props} />);
    measure();
    const marker = screen.getByLabelText("中心");
    dragMarker(marker);
    expect(onMarkerDrop).toHaveBeenLastCalledWith({
      pointerDown: { x: 960, y: 540 },
      pointerNow: { x: 1060, y: 540 },
    });

    // The marker is shown at 1060 (client 630); the host still knows 960.
    fireEvent.pointerDown(marker, { button: 0, clientX: 630, clientY: 320 });
    fireEvent.pointerMove(marker, { clientX: 655, clientY: 320 });
    // No jump back to the host's point while dragging again.
    expect(marker.style.left).toBe(`${(1110 / 1920) * 100}%`);
    fireEvent.pointerUp(marker, { clientX: 655, clientY: 320 });
    // The drop is cumulative against the point the host still reports.
    expect(onMarkerDrop).toHaveBeenLastCalledWith({
      pointerDown: { x: 960, y: 540 },
      pointerNow: { x: 1110, y: 540 },
    });
    expect(marker.style.left).toBe(`${(1110 / 1920) * 100}%`);
  });

  it("keeps a kept drop on screen when a second grab is cancelled", () => {
    const props = { ...base, point: { x: 960, y: 540 }, revision: 1 };
    render(<ParticleGizmo {...props} />);
    measure();
    const marker = screen.getByLabelText("中心");
    dragMarker(marker);
    fireEvent.pointerDown(marker, { button: 0, clientX: 630, clientY: 320 });
    fireEvent.pointerMove(marker, { clientX: 700, clientY: 320 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(marker.style.left).toBe(`${(1060 / 1920) * 100}%`);
  });
});
