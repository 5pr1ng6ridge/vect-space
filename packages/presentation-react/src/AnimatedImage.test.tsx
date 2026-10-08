import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FrameSequencePlayer } from "@vectspace/presentation-core/image-animation";

import { AnimatedImage } from "./AnimatedImage";
import { staticImageSource } from "./useAnimatedImage";
import type { ImageAssetSource } from "@vectspace/presentation-core/image-animation";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
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

function animated(
  asset: string,
  frames: [string, number][],
  width = 1920,
  height = 407,
  animationId = `anim.${asset}`,
): ImageAssetSource {
  const [first] = frames;
  return {
    asset,
    url: `/assets/${first?.[0] ?? ""}.png`,
    width,
    height,
    animation: {
      id: animationId,
      width,
      height,
      total_duration_ms: frames.reduce((sum, [, d]) => sum + d, 0),
      frames: frames.map(([name, duration_ms]) => ({
        asset: name,
        duration_ms,
        url: `/assets/${name}.png`,
      })),
    },
  };
}

describe("AnimatedImage frames", () => {
  it("renders a static asset exactly like a plain image", () => {
    render(
      <AnimatedImage
        height={407}
        paused={false}
        source={staticImageSource("dialogue.png")}
        width={1920}
      />,
    );
    const image = screen.getByRole("presentation", { hidden: true });
    expect(image.getAttribute("src")).toBe("dialogue.png");
    expect(image.getAttribute("width")).toBe("1920");
    expect(image.getAttribute("height")).toBe("407");
  });

  it("starts an animated asset on its first frame", () => {
    render(
      <AnimatedImage
        height={407}
        paused={false}
        source={animated("gui.frame", [
          ["idle", 1000],
          ["lit", 1000],
        ])}
        width={1920}
      />,
    );
    expect(
      screen.getByRole("presentation", { hidden: true }).getAttribute("src"),
    ).toBe("/assets/idle.png");
  });

  it("keeps the declared layout box while frames change", () => {
    const source = animated("gui.frame", [
      ["idle", 500],
      ["lit", 500],
    ]);
    const { rerender } = render(
      <AnimatedImage height={407} paused source={source} width={1920} />,
    );
    const image = screen.getByRole("presentation", { hidden: true });
    expect(image.getAttribute("width")).toBe("1920");
    expect(image.getAttribute("height")).toBe("407");
    rerender(
      <AnimatedImage height={407} paused source={source} width={1920} />,
    );
    // A React re-render with the same source must not restart the loop.
    expect(
      screen.getByRole("presentation", { hidden: true }).getAttribute("src"),
    ).toBe("/assets/idle.png");
  });

  it("restarts from the first frame when the asset changes", () => {
    const first = animated("gui.a", [
      ["a0", 100],
      ["a1", 100],
    ]);
    const second = animated("gui.b", [
      ["b0", 100],
      ["b1", 100],
    ]);
    const { rerender } = render(
      <AnimatedImage height={100} paused source={first} width={100} />,
    );
    expect(
      screen.getByRole("presentation", { hidden: true }).getAttribute("src"),
    ).toBe("/assets/a0.png");
    rerender(<AnimatedImage height={100} paused source={second} width={100} />);
    expect(
      screen.getByRole("presentation", { hidden: true }).getAttribute("src"),
    ).toBe("/assets/b0.png");
  });

  it("restarts when the asset changes even if two assets share one document", () => {
    vi.useFakeTimers();
    // Two logical assets may reference the same animation document.  The host
    // switches the displayed *asset*, and the Pixi surface resets on that same
    // identity, so both renderers must agree on this case.
    const shared: [string, number][] = [
      ["one", 1000],
      ["two", 1000],
    ];
    const first = animated("gui.one", shared, 100, 100, "anim.shared");
    const second = animated("gui.two", shared, 100, 100, "anim.shared");
    const { rerender } = render(
      <AnimatedImage height={100} paused={false} source={first} width={100} />,
    );
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(
      screen.getByRole("presentation", { hidden: true }).getAttribute("src"),
    ).toBe("/assets/two.png");
    rerender(
      <AnimatedImage height={100} paused={false} source={second} width={100} />,
    );
    expect(
      screen.getByRole("presentation", { hidden: true }).getAttribute("src"),
    ).toBe("/assets/one.png");
  });

  it("advances frames on the animation frame clock", () => {
    vi.useFakeTimers();
    render(
      <AnimatedImage
        height={100}
        paused={false}
        source={animated("gui.tick", [
          ["one", 1000],
          ["two", 1000],
        ])}
        width={100}
      />,
    );
    expect(
      screen.getByRole("presentation", { hidden: true }).getAttribute("src"),
    ).toBe("/assets/one.png");
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(
      screen.getByRole("presentation", { hidden: true }).getAttribute("src"),
    ).toBe("/assets/two.png");
  });

  it("freezes while paused instead of catching up on resume", () => {
    vi.useFakeTimers();
    const source = animated("gui.frozen", [
      ["one", 1000],
      ["two", 1000],
    ]);
    const { rerender } = render(
      <AnimatedImage height={100} paused={false} source={source} width={100} />,
    );
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(
      screen.getByRole("presentation", { hidden: true }).getAttribute("src"),
    ).toBe("/assets/two.png");
    rerender(<AnimatedImage height={100} paused source={source} width={100} />);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    // The loop is frozen on the same frame and time does not accumulate.
    expect(
      screen.getByRole("presentation", { hidden: true }).getAttribute("src"),
    ).toBe("/assets/two.png");
    rerender(
      <AnimatedImage height={100} paused={false} source={source} width={100} />,
    );
    expect(
      screen.getByRole("presentation", { hidden: true }).getAttribute("src"),
    ).toBe("/assets/two.png");
  });
});
