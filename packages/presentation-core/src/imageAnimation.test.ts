import { describe, expect, it, vi } from "vitest";

import {
  DecorativeFrameClock,
  FrameLoopRegistry,
  FrameSequencePlayer,
  frameIndexAt,
  resolveImageAsset,
  type AnimationMap,
  type ImageAssetSource,
} from "./imageAnimation";

function animation(frames: [string, number][]) {
  return {
    id: "anim.test",
    width: 64,
    height: 48,
    total_duration_ms: frames.reduce((sum, [, duration]) => sum + duration, 0),
    frames: frames.map(([asset, duration_ms]) => ({
      asset,
      duration_ms,
      url: `/assets/${asset}.png`,
    })),
  };
}

function source(frames: [string, number][]): ImageAssetSource {
  const resolved = animation(frames);
  return {
    asset: "gui.blinking",
    url: resolved.frames[0].url,
    width: resolved.width,
    height: resolved.height,
    animation: resolved,
  };
}

describe("frameIndexAt", () => {
  const frames = [
    { duration_ms: 100 },
    { duration_ms: 250 },
    { duration_ms: 30 },
  ];

  it("honours uneven frame durations at their exact boundaries", () => {
    expect(frameIndexAt(0, frames)).toBe(0);
    expect(frameIndexAt(99.9, frames)).toBe(0);
    expect(frameIndexAt(100, frames)).toBe(1);
    expect(frameIndexAt(349.9, frames)).toBe(1);
    expect(frameIndexAt(350, frames)).toBe(2);
    expect(frameIndexAt(379.999, frames)).toBe(2);
  });

  it("loops at the total duration and wraps negative time", () => {
    expect(frameIndexAt(380, frames)).toBe(0);
    expect(frameIndexAt(380 * 5 + 120, frames)).toBe(1);
    expect(frameIndexAt(-10, frames)).toBe(2);
  });

  it("is independent of the sampling step", () => {
    const frameAt60Fps = frameIndexAt(16.6667 * 30, frames);
    const frameAt144Fps = frameIndexAt(6.9444 * 72, frames);
    // Both clocks land inside the long second frame; neither depends on how
    // many times it was advanced.
    expect(frameAt60Fps).toBe(1);
    expect(frameAt144Fps).toBe(1);
  });

  it("degrades safely for empty and zero-duration lists", () => {
    expect(frameIndexAt(500, [])).toBe(-1);
    expect(frameIndexAt(500, [{ duration_ms: 0 }])).toBe(0);
  });
});

describe("DecorativeFrameClock", () => {
  it("ignores time while paused and does not repay it on resume", () => {
    const clock = new DecorativeFrameClock();
    clock.advance(100);
    expect(clock.elapsedMs()).toBe(100);
    clock.setPaused(true);
    clock.advance(5_000);
    expect(clock.elapsedMs()).toBe(100);
    clock.setPaused(false);
    clock.advance(20);
    expect(clock.elapsedMs()).toBe(120);
  });

  it("ignores non-positive and non-finite deltas", () => {
    const clock = new DecorativeFrameClock();
    clock.advance(0);
    clock.advance(-50);
    clock.advance(Number.NaN);
    clock.advance(Number.POSITIVE_INFINITY);
    expect(clock.elapsedMs()).toBe(0);
  });

  it("can be positioned deterministically and restarted", () => {
    const clock = DecorativeFrameClock.startAt(1_234);
    expect(clock.elapsedMs()).toBe(1_234);
    clock.seek(-10);
    expect(clock.elapsedMs()).toBe(0);
    clock.seek(90);
    clock.restart();
    expect(clock.elapsedMs()).toBe(0);
  });
});

describe("FrameSequencePlayer", () => {
  it("selects frames, loops, and reports frame changes once", () => {
    const player = new FrameSequencePlayer(
      source([
        ["img.idle", 200],
        ["img.blink", 60],
      ]),
    );
    const listener = vi.fn();
    player.subscribe(listener);

    expect(player.url()).toBe("/assets/img.idle.png");
    expect(player.advance(199)).toBe(false);
    expect(player.url()).toBe("/assets/img.idle.png");
    expect(player.advance(1)).toBe(true);
    expect(player.url()).toBe("/assets/img.blink.png");
    expect(player.advance(60)).toBe(true);
    expect(player.url()).toBe("/assets/img.idle.png");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps independent positions for instances sharing one source", () => {
    const shared = source([
      ["img.a", 100],
      ["img.b", 100],
    ]);
    const first = new FrameSequencePlayer(shared);
    const second = new FrameSequencePlayer(shared);
    first.advance(150);
    expect(first.url()).toBe("/assets/img.b.png");
    expect(second.url()).toBe("/assets/img.a.png");
    // The decoded frame list really is shared, only the clock is not.
    expect(first.source.animation).toBe(second.source.animation);
  });

  it("is idempotent: re-positioning to the same time repeats no work", () => {
    const player = new FrameSequencePlayer(
      source([
        ["img.a", 100],
        ["img.b", 100],
      ]),
    );
    const listener = vi.fn();
    player.subscribe(listener);
    player.seek(150);
    expect(listener).toHaveBeenCalledTimes(1);
    // Applying the same snapshot again must not restart or re-notify.
    player.seek(150);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(player.frame()?.asset).toBe("img.b");
  });

  it("does not reset the loop when the instance merely moves", () => {
    const player = new FrameSequencePlayer(
      source([
        ["img.a", 100],
        ["img.b", 100],
      ]),
    );
    player.advance(150);
    // Moving or scaling is not a player operation: the host keeps the same
    // player, so the frame position is untouched.
    expect(player.frame()?.asset).toBe("img.b");
    expect(player.clock.elapsedMs()).toBe(150);
  });

  it("resets to the first frame on restart", () => {
    const player = new FrameSequencePlayer(
      source([
        ["img.a", 100],
        ["img.b", 100],
      ]),
    );
    player.advance(150);
    expect(player.url()).toBe("/assets/img.b.png");
    expect(player.resetToFirstFrame()).toBe(true);
    expect(player.url()).toBe("/assets/img.a.png");
    expect(player.clock.elapsedMs()).toBe(0);
    // Restarting while already on the first frame still rewinds the clock;
    // the return value only reports whether the visible frame changed.
    player.advance(20);
    expect(player.resetToFirstFrame()).toBe(false);
    expect(player.clock.elapsedMs()).toBe(0);
  });

  it("stops notifying listeners after dispose", () => {
    const player = new FrameSequencePlayer(
      source([
        ["img.a", 100],
        ["img.b", 100],
      ]),
    );
    const listener = vi.fn();
    player.subscribe(listener);
    player.dispose();
    player.advance(150);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("resolveImageAsset", () => {
  const urls = { "sprite.omo": "/assets/omo.png" };
  const animations: AnimationMap = {
    "gui.blinking": animation([
      ["img.idle", 300],
      ["img.blink", 90],
    ]),
  };

  it("resolves static assets exactly as before", () => {
    expect(resolveImageAsset("sprite.omo", urls, animations)).toEqual({
      asset: "sprite.omo",
      url: "/assets/omo.png",
      width: 0,
      height: 0,
    });
  });

  it("resolves animated assets with their layout size and first frame", () => {
    const resolved = resolveImageAsset("gui.blinking", urls, animations);
    expect(resolved?.width).toBe(64);
    expect(resolved?.height).toBe(48);
    expect(resolved?.url).toBe("/assets/img.idle.png");
    expect(resolved?.animation?.frames).toHaveLength(2);
  });

  it("falls back to the first frame when only the animation is known", () => {
    const resolved = resolveImageAsset("gui.blinking", {}, animations);
    expect(resolved?.url).toBe("/assets/img.idle.png");
  });

  it("returns undefined for unknown ids", () => {
    expect(resolveImageAsset("gui.missing", urls, animations)).toBeUndefined();
  });
});

describe("FrameLoopRegistry", () => {
  const walk = (): ImageAssetSource => ({
    asset: "walk",
    url: "/assets/walk/a.png",
    width: 100,
    height: 50,
    animation: animation([
      ["a", 100],
      ["b", 100],
      ["c", 100],
      ["d", 100],
    ]),
  });

  it("shares nothing but the frame list: each instance keeps its own phase", () => {
    const registry = new FrameLoopRegistry();
    const first = registry.ensure("hero", walk());
    const second = registry.ensure("friend", walk());
    expect(first).not.toBe(second);
    expect(registry.size()).toBe(2);
    first.advance(250);
    expect(first.frameIndex()).toBe(2);
    expect(second.frameIndex()).toBe(0);
  });

  it("keeps a phase for an unchanged asset and restarts for a new one", () => {
    const registry = new FrameLoopRegistry();
    const player = registry.ensure("hero", walk());
    player.advance(250);
    expect(registry.ensure("hero", walk())).toBe(player);
    expect(registry.ensure("hero", walk()).frameIndex()).toBe(2);
    const replacement = registry.ensure("hero", {
      asset: "walk",
      url: "/assets/walk/b.png",
      width: 100,
      height: 50,
      animation: animation([
        ["b", 100],
        ["c", 100],
      ]),
    });
    expect(replacement).not.toBe(player);
    expect(replacement.frameIndex()).toBe(0);
  });

  it("freezes while paused and never accrues debt", () => {
    const registry = new FrameLoopRegistry();
    const player = registry.ensure("hero", walk());
    registry.setPaused(true);
    expect(registry.advance(500)).toEqual([]);
    expect(player.frameIndex()).toBe(0);
    registry.setPaused(false);
    expect(registry.advance(150)).toEqual(["hero"]);
    expect(player.frameIndex()).toBe(1);
  });

  it("positions every loop from a playhead for deterministic scrubbing", () => {
    const registry = new FrameLoopRegistry();
    const player = registry.ensure("hero", walk());
    expect(registry.seek(250)).toEqual(["hero"]);
    expect(player.frameIndex()).toBe(2);
    // The same position is a no-op and never advances twice.
    expect(registry.seek(250)).toEqual([]);
    expect(registry.restart()).toEqual(["hero"]);
    expect(player.frameIndex()).toBe(0);
  });

  it("releases instances, including every one that is no longer wanted", () => {
    const registry = new FrameLoopRegistry();
    registry.ensure("hero", walk());
    registry.ensure("friend", walk());
    expect(registry.releaseMissing(new Set(["hero"]))).toEqual(["friend"]);
    expect(registry.ids()).toEqual(["hero"]);
    expect(registry.release("hero")).toBe(true);
    expect(registry.release("hero")).toBe(false);
    expect(registry.size()).toBe(0);
  });

  it("detaches a loop for a cross-fade without stopping it", () => {
    const registry = new FrameLoopRegistry();
    const player = registry.ensure("hero", walk());
    player.advance(250);
    const detached = registry.forget("hero");
    expect(detached).toBe(player);
    expect(registry.has("hero")).toBe(false);
    // The detached loop keeps running until its owner disposes it.
    player.advance(100);
    expect(player.frameIndex()).toBe(3);
    detached?.dispose();
  });

  it("stops notifying a detached loop after dispose", () => {
    const registry = new FrameLoopRegistry();
    const listener = vi.fn();
    const player = registry.ensure("hero", walk());
    player.subscribe(listener);
    registry.release("hero");
    player.advance(100);
    expect(listener).not.toHaveBeenCalled();
  });
});
