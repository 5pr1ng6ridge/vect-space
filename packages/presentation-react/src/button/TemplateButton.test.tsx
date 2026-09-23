import { StrictMode, type ReactElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FrameSequencePlayer } from "@vectspace/presentation-core/image-animation";
import type { ButtonSnapshot } from "@vectspace/presentation-core/types";

import { TemplateButton } from "./TemplateButton";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
    opacity: 1,
    z: 2,
    visible: true,
    enabled: true,
    action: { sets: [], next: null },
    ...overrides,
  };
}

describe("TemplateButton", () => {
  it("balances window listeners and frame players under Strict Mode", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const disposeSpy = vi.spyOn(FrameSequencePlayer.prototype, "dispose");
    const subscribeSpy = vi.spyOn(FrameSequencePlayer.prototype, "subscribe");
    const animation = {
      id: "anim.hover",
      width: 200,
      height: 80,
      total_duration_ms: 400,
      frames: [
        { asset: "hover_a", duration_ms: 200, url: "hover_a.png" },
        { asset: "hover_b", duration_ms: 200, url: "hover_b.png" },
      ],
    };
    const { unmount } = render(
      <StrictMode>
        <TemplateButton
          animations={{ hover: animation }}
          assets={{ normal: "normal.png", hover: "hover_a.png" }}
          button={button({ normal: "normal", hover: "hover" })}
          className="scene-button"
          onActivate={() => undefined}
          sessionKey="session"
        />
      </StrictMode>,
    );
    expect(screen.getByRole("button", { name: "confirm" })).toBeInTheDocument();
    unmount();
    const windowEvents = (calls: unknown[][]): number =>
      calls.filter(([type]) => type === "blur" || type === "pointercancel")
        .length;
    // The two Strict Mode effect passes each install/remove the pair; the
    // committed static artwork has one player in each pass as well.
    expect(windowEvents(addSpy.mock.calls)).toBe(4);
    expect(windowEvents(removeSpy.mock.calls)).toBe(4);
    expect(disposeSpy.mock.calls.length).toBe(2);
    expect(subscribeSpy.mock.results.length).toBe(2);
  });

  it("releases its animation frame loop under Strict Mode", () => {
    const cancelSpy = vi.spyOn(globalThis, "cancelAnimationFrame");
    const animation = {
      id: "anim.hover",
      width: 200,
      height: 80,
      total_duration_ms: 400,
      frames: [
        { asset: "hover_a", duration_ms: 200, url: "hover_a.png" },
        { asset: "hover_b", duration_ms: 200, url: "hover_b.png" },
      ],
    };
    const { unmount } = render(
      <StrictMode>
        <TemplateButton
          animations={{ hover: animation }}
          assets={{ hover: "hover_a.png" }}
          button={button({ hover: "hover" })}
          className="scene-button"
          onActivate={() => undefined}
          sessionKey="session"
        />
      </StrictMode>,
    );
    fireEvent.pointerEnter(screen.getByRole("button", { name: "confirm" }));
    unmount();
    // The pending state-reset frames and the running hover animation loop
    // must be released by the Strict Mode probe's cleanup.
    expect(cancelSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it("activates manually on an inside release and cancels an outside one", () => {
    const onActivate = vi.fn();
    render(
      <TemplateButton
        assets={{}}
        button={button()}
        className="scene-button"
        onActivate={onActivate}
        sessionKey="session"
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
    expect(onActivate).not.toHaveBeenCalled();

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
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(element).toHaveClass("scene-button-hover");
  });

  it("lets the native activation mode activate on click and keyboard", () => {
    const onActivate = vi.fn();
    render(
      <TemplateButton
        activation="native"
        assets={{}}
        button={button()}
        className="choice-button"
        onActivate={onActivate}
        sessionKey="session"
      />,
    );
    const element = screen.getByRole("button", { name: "confirm" });
    expect(element).toHaveClass("choice-button", "choice-button-normal");
    fireEvent.click(element);
    expect(onActivate).toHaveBeenCalledTimes(1);
    act(() => {
      element.focus();
    });
    expect(document.activeElement).toBe(element);
    expect(element).toHaveClass("is-focused");
    act(() => {
      fireEvent.blur(element);
    });
    expect(element).not.toHaveClass("is-focused");
  });

  it("ignores a captured click whose press was released outside", () => {
    const onActivate = vi.fn();
    render(
      <TemplateButton
        activation="native"
        assets={{}}
        button={button()}
        className="choice-button"
        onActivate={onActivate}
        sessionKey="session"
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
    fireEvent.pointerDown(element, {
      button: 0,
      clientX: 40,
      clientY: 50,
      pointerId: 7,
    });
    fireEvent.pointerMove(element, {
      clientX: 900,
      clientY: 900,
      pointerId: 7,
    });
    fireEvent.pointerUp(element, {
      clientX: 900,
      clientY: 900,
      pointerId: 7,
    });
    // The pointer capture retargets the browser click to the button.
    fireEvent.click(element);
    expect(onActivate).not.toHaveBeenCalled();
    expect(element).toHaveClass("choice-button-normal");

    // The next in-box gesture activates normally again.
    fireEvent.pointerDown(element, {
      button: 0,
      clientX: 40,
      clientY: 50,
      pointerId: 8,
    });
    fireEvent.pointerUp(element, {
      clientX: 40,
      clientY: 50,
      pointerId: 8,
    });
    fireEvent.click(element);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("never activates a disabled template button", () => {
    const onActivate = vi.fn();
    render(
      <TemplateButton
        activation="native"
        assets={{}}
        button={button({ enabled: false })}
        className="choice-button"
        onActivate={onActivate}
        sessionKey="session"
      />,
    );
    const element = screen.getByRole("button", { name: "confirm" });
    expect(element).toBeDisabled();
    fireEvent.click(element);
    fireEvent.pointerDown(element, {
      button: 0,
      clientX: 40,
      clientY: 50,
      pointerId: 4,
    });
    fireEvent.pointerUp(element, {
      clientX: 40,
      clientY: 50,
      pointerId: 4,
    });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("resets pointer and focus state across a hide-show round trip", () => {
    const onActivate = vi.fn();
    const { rerender } = render(
      <TemplateButton
        activation="native"
        assets={{}}
        button={button()}
        className="scene-button"
        onActivate={onActivate}
        sessionKey="session"
      />,
    );
    const element = screen.getByRole("button", { name: "confirm" });
    fireEvent.pointerEnter(element);
    fireEvent.pointerDown(element, {
      button: 0,
      clientX: 40,
      clientY: 50,
      pointerId: 12,
    });
    fireEvent.focus(element);
    expect(element).toHaveClass("scene-button-pressed", "is-focused");

    rerender(
      <TemplateButton
        activation="native"
        assets={{}}
        button={button({ visible: false })}
        className="scene-button"
        onActivate={onActivate}
        sessionKey="session"
      />,
    );
    expect(screen.queryByRole("button", { name: "confirm" })).toBeNull();
    rerender(
      <TemplateButton
        activation="native"
        assets={{}}
        button={button()}
        className="scene-button"
        onActivate={onActivate}
        sessionKey="session"
      />,
    );
    const shown = screen.getByRole("button", { name: "confirm" });
    expect(shown).toHaveClass("scene-button-normal");
    expect(shown).not.toHaveClass("scene-button-pressed", "is-focused");
  });

  it("falls back without disabling a separate button when its resolved artwork fails", () => {
    const onActivate = vi.fn();
    render(
      <TemplateButton
        activation="native"
        assets={{ normal: "normal.png" }}
        button={button({ normal: "normal" })}
        className="choice-button"
        fallbackClassName="choice-button-fallback"
        onActivate={onActivate}
        sessionKey="session"
      />,
    );
    const element = screen.getByRole("button", { name: "confirm" });
    const image = element.querySelector(".choice-button-image");
    expect(image).toHaveAttribute("src", "normal.png");
    act(() => {
      image?.dispatchEvent(new Event("error"));
    });
    expect(element.querySelector(".choice-button-image")).toBeNull();
    expect(element).toHaveClass("choice-button-fallback");
    expect(element).not.toBeDisabled();
    fireEvent.click(element);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("removes both layers and keeps an overlay button enabled after artwork failure", () => {
    const onActivate = vi.fn();
    render(
      <TemplateButton
        activation="native"
        assets={{ normal: "normal.png", hover: "hover.png" }}
        button={button({
          asset_mode: "overlay",
          normal: "normal",
          hover: "hover",
        })}
        className="choice-button"
        fallbackClassName="choice-button-fallback"
        onActivate={onActivate}
        sessionKey="session"
      />,
    );
    const element = screen.getByRole("button", { name: "confirm" });
    fireEvent.pointerEnter(element);
    expect(element.querySelectorAll(".choice-button-image")).toHaveLength(2);
    act(() => {
      element
        .querySelector(".choice-button-image")
        ?.dispatchEvent(new Event("error"));
    });
    expect(element.querySelectorAll(".choice-button-image")).toHaveLength(0);
    expect(element).toHaveClass("choice-button-fallback");
    expect(element).not.toBeDisabled();
    fireEvent.click(element);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("hides an invisible button and restarts a state loop only on identity change", () => {
    const onActivate = vi.fn();
    const { rerender } = render(
      <TemplateButton
        assets={{}}
        button={button()}
        className="scene-button"
        onActivate={onActivate}
        sessionKey="session"
      />,
    );
    expect(screen.getByRole("button", { name: "confirm" })).toBeInTheDocument();
    rerender(
      <TemplateButton
        assets={{}}
        button={button({ visible: false })}
        className="scene-button"
        onActivate={onActivate}
        sessionKey="session"
      />,
    );
    expect(
      screen.queryByRole("button", { name: "confirm" }),
    ).not.toBeInTheDocument();
    const renderButton = (): ReactElement => (
      <TemplateButton
        assets={{}}
        button={button()}
        className="scene-button"
        onActivate={onActivate}
        sessionKey="session"
      />
    );
    rerender(renderButton());
    expect(screen.getByRole("button", { name: "confirm" })).toBeInTheDocument();
  });

  it("renders a forced state for authoring previews regardless of the pointer", () => {
    const onActivate = vi.fn();
    render(
      <TemplateButton
        assets={{ normal: "normal.png", hover: "hover.png" }}
        button={button({
          asset_mode: "overlay",
          normal: "normal",
          hover: "hover",
        })}
        className="scene-button"
        disabled
        onActivate={onActivate}
        sessionKey="session"
        state="hover"
      />,
    );
    const element = screen.getByRole("button", { name: "confirm" });
    // The authored state (not the pointer state) selects the class, the
    // overlay composition and the disabled/inert presentation.
    expect(element).toHaveClass("scene-button-hover");
    expect(element).toBeDisabled();
    expect(element.querySelectorAll(".scene-button-image")).toHaveLength(2);
    fireEvent.pointerEnter(element);
    fireEvent.pointerDown(element, { button: 0, pointerId: 1 });
    expect(element).toHaveClass("scene-button-hover");
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("keeps the pointer state machine when no state is forced", () => {
    const onActivate = vi.fn();
    render(
      <TemplateButton
        assets={{ normal: "normal.png", hover: "hover.png" }}
        button={button({
          asset_mode: "overlay",
          normal: "normal",
          hover: "hover",
        })}
        className="scene-button"
        onActivate={onActivate}
        sessionKey="session"
      />,
    );
    const element = screen.getByRole("button", { name: "confirm" });
    expect(element).toHaveClass("scene-button-normal");
    fireEvent.pointerEnter(element);
    expect(element).toHaveClass("scene-button-hover");
  });
});
