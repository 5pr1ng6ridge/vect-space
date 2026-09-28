import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReactElement } from "react";

import type {
  ButtonSnapshot,
  RuntimeSnapshot,
} from "@vectspace/presentation-core/types";
import { ButtonLayer } from "./ButtonLayer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function snapshot(buttons: Record<string, ButtonSnapshot>): RuntimeSnapshot {
  return {
    revision: "1",
    location: { scene_id: "scene", node_id: "node" },
    variables: {},
    world: {
      background: null,
      sprites: {},
      buttons,
      camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
      dialogue_ui_visible: true,
      ui_motion_bindings: {},
      persistent_effects: [],
    },
    audio: { bgm: null },
    playback: { auto: "normal", ctrl_fast_forward: "allow" },
    prompt: { kind: "none" },
  };
}

function button(overrides: Partial<ButtonSnapshot> = {}): ButtonSnapshot {
  return {
    id: "confirm",
    template: "demo.transparent",
    asset_mode: "separate",
    fit: "stretch",
    normal: null,
    hover: null,
    pressed: null,
    animations: {},
    x: 20,
    y: 30,
    width: 200,
    height: 80,
    rotation_deg: 0,
    scale_x: 1,
    scale_y: 1,
    opacity: 0,
    z: 2,
    visible: true,
    enabled: true,
    action: { sets: [], next: null },
    ...overrides,
  };
}

describe("ButtonLayer", () => {
  it("keeps transparent hit areas active and cancels an outside release", () => {
    const onClick = vi.fn();
    render(
      <ButtonLayer
        assets={{}}
        onClick={onClick}
        snapshot={snapshot({ confirm: button() })}
      />,
    );
    const element = screen.getByRole("button", { name: "confirm" });
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      bottom: 110,
      height: 80,
      left: 20,
      right: 220,
      top: 30,
      width: 200,
      x: 20,
      y: 30,
      toJSON: () => ({}),
    });
    expect(element).toHaveStyle("opacity: 0");

    fireEvent.pointerDown(element, {
      button: 0,
      clientX: 40,
      clientY: 50,
      pointerId: 1,
    });
    fireEvent.pointerMove(element, {
      clientX: 400,
      clientY: 500,
      pointerId: 1,
    });
    fireEvent.pointerUp(element, {
      clientX: 400,
      clientY: 500,
      pointerId: 1,
    });
    expect(onClick).not.toHaveBeenCalled();

    fireEvent.pointerDown(element, {
      button: 0,
      clientX: 40,
      clientY: 50,
      pointerId: 2,
    });
    fireEvent.pointerUp(element, {
      clientX: 40,
      clientY: 50,
      pointerId: 2,
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(element).toHaveClass("scene-button-hover");

    fireEvent.pointerDown(element, {
      button: 0,
      clientX: 40,
      clientY: 50,
      pointerId: 3,
    });
    fireEvent.blur(window);
    fireEvent.pointerUp(element, {
      clientX: 40,
      clientY: 50,
      pointerId: 3,
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("uses fallback artwork for separate states and a single overlay", () => {
    const separate = button({
      id: "separate",
      normal: "normal",
      hover: null,
      pressed: "pressed",
    });
    const overlay = button({
      id: "overlay",
      asset_mode: "overlay",
      normal: "normal",
      hover: "hover",
      pressed: "pressed",
      x: 300,
    });
    render(
      <ButtonLayer
        assets={{
          normal: "normal.png",
          hover: "hover.png",
          pressed: "pressed.png",
        }}
        onClick={() => undefined}
        snapshot={snapshot({ separate, overlay })}
      />,
    );
    const buttons = screen.getAllByRole("button");
    const separateElement = buttons.find(
      (candidate) => candidate.getAttribute("aria-label") === "separate",
    );
    const overlayElement = buttons.find(
      (candidate) => candidate.getAttribute("aria-label") === "overlay",
    );
    if (separateElement === undefined || overlayElement === undefined)
      throw new Error("button fixture was not rendered");
    expect(separateElement?.querySelectorAll("img")).toHaveLength(1);
    expect(overlayElement?.querySelectorAll("img")).toHaveLength(1);

    fireEvent.pointerEnter(separateElement);
    expect(separateElement?.querySelector("img")).toHaveAttribute(
      "src",
      "normal.png",
    );
    fireEvent.pointerEnter(overlayElement);
    expect(overlayElement?.querySelectorAll("img")).toHaveLength(2);
  });

  it("starts a state animation on its first frame and never restarts it", () => {
    vi.useFakeTimers();
    const hoverAnimation = {
      id: "anim.hover",
      width: 200,
      height: 80,
      total_duration_ms: 400,
      frames: [
        { asset: "hover_a", duration_ms: 200, url: "hover_a.png" },
        { asset: "hover_b", duration_ms: 200, url: "hover_b.png" },
      ],
    };
    const animated = button({
      id: "animated",
      normal: "normal",
      hover: "hover",
      asset_mode: "separate",
      x: 300,
    });
    const renderButton = (): ReactElement => (
      <ButtonLayer
        animations={{ hover: hoverAnimation }}
        assets={{ normal: "normal.png", hover: "hover_a.png" }}
        onClick={() => undefined}
        snapshot={snapshot({ animated })}
      />
    );
    const { rerender } = render(renderButton());
    // The mount effect drops stale pointer state on the next frame; flush it
    // so the hover below is not immediately undone by that deferred reset.
    act(() => {
      vi.advanceTimersByTime(16);
    });
    const element = screen.getByRole("button", { name: "animated" });
    expect(element.querySelector("img")).toHaveAttribute("src", "normal.png");

    fireEvent.pointerEnter(element);
    expect(element.querySelector("img")).toHaveAttribute("src", "hover_a.png");

    // Advance into a later frame so a restart becomes observable at all.
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(element.querySelector("img")).toHaveAttribute("src", "hover_b.png");

    // A re-render inside the same state keeps the loop going rather than
    // snapping back to the first frame.
    rerender(renderButton());
    expect(element.querySelector("img")).toHaveAttribute("src", "hover_b.png");

    // Leaving and re-entering is a state change, so the loop does restart.
    fireEvent.pointerLeave(element);
    expect(element.querySelector("img")).toHaveAttribute("src", "normal.png");
    fireEvent.pointerEnter(element);
    expect(element.querySelector("img")).toHaveAttribute("src", "hover_a.png");
  });
});
