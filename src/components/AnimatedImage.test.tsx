import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnimatedImage } from "./AnimatedImage";
import { staticImageSource } from "./useAnimatedImage";
import type { ImageAssetSource } from "@vectspace/presentation-core/image-animation";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

describe("AnimatedImage", () => {
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
