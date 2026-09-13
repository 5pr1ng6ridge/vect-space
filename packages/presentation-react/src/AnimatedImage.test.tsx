import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FrameSequencePlayer } from "@vectspace/presentation-core/image-animation";

import { AnimatedImage } from "./AnimatedImage";
import type { ImageAssetSource } from "@vectspace/presentation-core/image-animation";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const animation = {
  id: "anim.scan",
  width: 64,
  height: 64,
  total_duration_ms: 400,
  frames: [
    { asset: "scan_a", duration_ms: 200, url: "scan_a.png" },
    { asset: "scan_b", duration_ms: 200, url: "scan_b.png" },
  ],
};

function animatedSource(): ImageAssetSource {
  return {
    asset: "bg.scan",
    url: "scan_a.png",
    width: 64,
    height: 64,
    animation,
  };
}

describe("AnimatedImage", () => {
  it("subscribes once per player and disposes every player on unmount", () => {
    const subscribeSpy = vi.spyOn(FrameSequencePlayer.prototype, "subscribe");
    const disposeSpy = vi.spyOn(FrameSequencePlayer.prototype, "dispose");
    const { container, unmount } = render(
      <StrictMode>
        <AnimatedImage paused={false} source={animatedSource()} />
      </StrictMode>,
    );
    expect(container.querySelector("img")).toHaveAttribute("src", "scan_a.png");
    const subscriptions = subscribeSpy.mock.results.length;
    // Strict Mode performs one probe cleanup and one committed subscription.
    expect(subscriptions).toBe(2);
    unmount();
    expect(disposeSpy.mock.calls.length).toBe(2);
  });

  it("cancels its animation frame loop when it unmounts", () => {
    vi.useFakeTimers();
    const cancelSpy = vi.spyOn(globalThis, "cancelAnimationFrame");
    const { unmount } = render(
      <AnimatedImage paused={false} source={animatedSource()} />,
    );
    unmount();
    expect(cancelSpy.mock.calls.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("keeps the same player while the logical asset is unchanged", () => {
    const disposeSpy = vi.spyOn(FrameSequencePlayer.prototype, "dispose");
    const { rerender } = render(
      <AnimatedImage paused={false} source={animatedSource()} />,
    );
    expect(disposeSpy).not.toHaveBeenCalled();
    // Equivalent source object, same identity key: a harmless re-render.
    rerender(<AnimatedImage paused={false} source={animatedSource()} />);
    expect(disposeSpy).not.toHaveBeenCalled();
    // A different asset id is a new lifecycle and releases the old player.
    rerender(
      <AnimatedImage
        paused={false}
        source={{ ...animatedSource(), asset: "bg.other" }}
      />,
    );
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("renders nothing for an unresolved source", () => {
    const { container } = render(
      <AnimatedImage paused={false} source={undefined} />,
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("falls back to the next usable url when a frame fails to load", () => {
    const { container } = render(
      <AnimatedImage
        fallbackUrl="fallback.png"
        paused={false}
        source={{ asset: "bg.broken", url: "broken.png", width: 0, height: 0 }}
      />,
    );
    const element = container.querySelector("img");
    expect(element).toHaveAttribute("src", "broken.png");
    act(() => {
      element?.dispatchEvent(new Event("error"));
    });
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "fallback.png",
    );
  });

  it("does not report an animation failure until every frame URL is exhausted", () => {
    const onError = vi.fn();
    const source: ImageAssetSource = {
      asset: "bg.loop",
      url: "loop_bad.png",
      width: 64,
      height: 64,
      animation: {
        ...animation,
        id: "anim.loop",
        frames: [
          { asset: "loop_bad", duration_ms: 200, url: "loop_bad.png" },
          { asset: "loop_good", duration_ms: 200, url: "loop_good.png" },
        ],
      },
    };
    const { container } = render(
      <AnimatedImage onError={onError} paused source={source} />,
    );
    const first = container.querySelector("img");
    expect(first).toHaveAttribute("src", "loop_bad.png");
    act(() => {
      first?.dispatchEvent(new Event("error"));
    });
    expect(onError).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "loop_good.png",
    );
    act(() => {
      container.querySelector("img")?.dispatchEvent(new Event("error"));
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(container.querySelector("img")).toBeNull();
  });

  it("reports a load failure so the host can fall back to text", () => {
    const onError = vi.fn();
    const { container } = render(
      <AnimatedImage
        onError={onError}
        paused={false}
        source={undefined}
        fallbackUrl="broken.png"
      />,
    );
    const element = container.querySelector("img");
    act(() => {
      element?.dispatchEvent(new Event("error"));
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});
