// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import {
  SESSION_CURTAIN_FRAME_TIMEOUT_MS,
  SESSION_CURTAIN_MS,
} from "./sceneSessionCurtain";
import {
  createSurface,
  flushMicrotasks,
  type Harness,
} from "./sceneSurfaceHarness";

const alphaOf = (h: Harness): number | undefined => h.sessionLayer()[0]?.alpha;

describe("host session curtain", () => {
  it("covers with fixed black and reveals on its own layer", async () => {
    const h = await createSurface();
    const cover = h.surface.coverSession(100);
    expect(h.surface.sessionCovered).toBe(false);
    h.run(50);
    expect(alphaOf(h)).toBeGreaterThan(0);
    await h.runAsync(120);
    await cover;
    expect(h.surface.sessionCovered).toBe(true);
    expect(alphaOf(h)).toBe(1);
    expect(h.sessionLayer()[0]?.fills).toEqual([0x000000]);

    const reveal = h.surface.revealSession(100);
    await h.runAsync(300);
    await reveal;
    expect(h.surface.sessionCovered).toBe(false);
    expect(h.sessionLayer()).toHaveLength(0);
    h.surface.dispose();
  });

  it("coalesces duplicate covers and reveals (React Strict Mode)", async () => {
    const h = await createSurface();
    const first = h.surface.coverSession(100);
    const second = h.surface.coverSession(100);
    expect(second).toBe(first);
    await h.runAsync(200);
    await Promise.all([first, second]);
    // One cover animation, one fill node; covering a covered canvas is a no-op.
    expect(h.sessionLayer()).toHaveLength(1);
    expect(h.surface.sessionCovered).toBe(true);
    await h.surface.coverSession(100);
    expect(h.sessionLayer()).toHaveLength(1);
    const reveal = h.surface.revealSession(100);
    const duplicate = h.surface.revealSession(100);
    expect(duplicate).toBe(reveal);
    await h.runAsync(300);
    await Promise.all([reveal, duplicate]);
    expect(h.sessionLayer()).toHaveLength(0);
    h.surface.dispose();
  });

  it("reveals only after the replacement has been drawn once", async () => {
    const h = await createSurface();
    await h.surface.coverSession(0);
    expect(h.surface.sessionCovered).toBe(true);
    let revealed = false;
    const reveal = h.surface.revealSession(50).then(() => {
      revealed = true;
    });
    await flushMicrotasks();
    // No frame was pumped yet: the cover must still fully hide the world.
    expect(revealed).toBe(false);
    expect(alphaOf(h)).toBe(1);
    await h.runAsync(200);
    await reveal;
    expect(revealed).toBe(true);
    expect(h.sessionLayer()).toHaveLength(0);
    h.surface.dispose();
  });

  it("clears the curtain on reset and dispose, and a later cover is a fresh transition", async () => {
    const h = await createSurface();
    const aborted = h.surface.coverSession(1000);
    h.run(64);
    expect(h.sessionLayer().length).toBeGreaterThan(0);
    expect(h.surface.sessionCovered).toBe(false);

    h.surface.reset();
    expect(h.sessionLayer()).toHaveLength(0);
    // The reset clears the operation state synchronously, so a host that
    // covers again immediately gets a new transition instead of the aborted
    // promise of the curtain the reset just destroyed.
    const next = h.surface.coverSession(1000);
    expect(next).not.toBe(aborted);
    await h.runAsync(1500);
    await next;
    expect(h.surface.sessionCovered).toBe(true);
    expect(alphaOf(h)).toBe(1);
    await aborted;
    h.surface.dispose();
    expect(h.sessionLayer()).toHaveLength(0);
  });

  it("continues a cover from the current reveal alpha instead of snapping transparent", async () => {
    const h = await createSurface();
    await h.surface.coverSession(0);
    const reveal = h.surface.revealSession(200);
    await h.runAsync(112);
    const before = alphaOf(h) ?? -1;
    expect(before).toBeGreaterThan(0.2);
    expect(before).toBeLessThan(1);

    // Covering mid-reveal must continue from the alpha on screen, not fade in
    // from transparent (which would flash the world back in).
    const cover = h.surface.coverSession(200);
    h.pump.step(0);
    await flushMicrotasks();
    expect(alphaOf(h)).toBeCloseTo(before, 5);
    h.pump.step(16);
    await flushMicrotasks();
    const after = alphaOf(h) ?? -1;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(1);

    await h.runAsync(400);
    await cover;
    expect(h.surface.sessionCovered).toBe(true);
    expect(alphaOf(h)).toBe(1);
    await reveal;
    h.surface.dispose();
  });

  it("does not lose a reveal requested while a cover is in flight", async () => {
    const h = await createSurface();
    const cover = h.surface.coverSession(300);
    await h.runAsync(64);
    expect(h.surface.sessionCovered).toBe(false);
    expect(h.sessionLayer().length).toBeGreaterThan(0);

    const reveal = h.surface.revealSession(100);
    await h.runAsync(1000);
    await Promise.all([cover, reveal]);
    // The reveal waited for the cover, then ran instead of being dropped.
    expect(h.surface.sessionCovered).toBe(false);
    expect(h.sessionLayer()).toHaveLength(0);
    h.surface.dispose();
  });

  it("supersedes a reveal parked behind its stable frame with a newer cover", async () => {
    const h = await createSurface();
    await h.surface.coverSession(0);
    // The reveal parks waiting for the replacement frame to be drawn once.
    const reveal = h.surface.revealSession(200);
    await flushMicrotasks();
    expect(alphaOf(h)).toBe(1);

    // A cover issued while the reveal is parked is the newest request and
    // owns the curtain; it must not be swallowed as "already covered" and
    // must stop the parked reveal from lowering it later.
    const cover = h.surface.coverSession(200);
    expect(cover).not.toBe(reveal);
    await h.runAsync(600);
    await Promise.all([reveal, cover]);
    expect(h.surface.sessionCovered).toBe(true);
    expect(alphaOf(h)).toBe(1);
    h.surface.dispose();
  });

  it("observes the newest cover when a reveal follows a superseded parked reveal", async () => {
    const h = await createSurface();
    await h.surface.coverSession(0);
    const parked = h.surface.revealSession(200);
    await flushMicrotasks();
    expect(alphaOf(h)).toBe(1);

    // A newer cover supersedes the parked reveal, and the next reveal request
    // arrives before that parked reveal notices.  The newer request must
    // observe the newest cover (wait for it, then reveal) instead of reusing
    // the parked promise, which is a doomed no-op.
    const cover = h.surface.coverSession(200);
    const reveal = h.surface.revealSession(200);
    expect(reveal).not.toBe(parked);

    await h.runAsync(1200);
    await Promise.all([parked, cover, reveal]);
    expect(h.surface.sessionCovered).toBe(false);
    expect(h.sessionLayer()).toHaveLength(0);
    h.surface.dispose();
  });

  it("invalidates a reveal parked behind its stable frame on reset", async () => {
    const h = await createSurface();
    await h.surface.coverSession(0);
    const reveal = h.surface.revealSession(200);
    await flushMicrotasks();

    // The reset is a session boundary: the parked reveal must stop instead of
    // surviving it and later lowering a cover started after the reset.
    h.surface.reset();
    const cover = h.surface.coverSession(0);
    await h.runAsync(300);
    await Promise.all([reveal, cover]);
    expect(h.surface.sessionCovered).toBe(true);
    expect(alphaOf(h)).toBe(1);
    h.surface.dispose();
  });

  it("finishes a bounded cover and reveal when the host suspends rendering", async () => {
    const h = await createSurface();
    // A hidden/suspended host never draws another frame, so a real fade must
    // be ended by the watchdog instead of holding the host busy forever.
    vi.useFakeTimers();
    try {
      const cover = h.surface.coverSession(1000);
      await vi.advanceTimersByTimeAsync(
        SESSION_CURTAIN_FRAME_TIMEOUT_MS + 1001,
      );
      await cover;
      expect(h.surface.sessionCovered).toBe(true);
      expect(alphaOf(h)).toBe(1);

      const renders = h.kit.renderCount();
      const reveal = h.surface.revealSession(1000);
      // The reveal first waits a bounded time for a drawn frame and renders
      // once best-effort, then its own fade watchdog finishes the fade.
      await vi.advanceTimersByTimeAsync(
        2 * (SESSION_CURTAIN_FRAME_TIMEOUT_MS + 1001),
      );
      await reveal;
      expect(h.kit.renderCount()).toBeGreaterThan(renders);
      expect(h.surface.sessionCovered).toBe(false);
      expect(h.sessionLayer()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
    h.surface.dispose();
  });

  it("uses the 250ms default for both the cover and the reveal", async () => {
    expect(SESSION_CURTAIN_MS).toBe(250);
    const h = await createSurface();
    // Cover: 240ms of virtual time is not enough, 250ms completes it.
    const coverStart = h.pump.now();
    const cover = h.surface.coverSession();
    h.pump.step(0);
    await flushMicrotasks();
    h.run(240);
    await flushMicrotasks();
    expect(h.pump.now() - coverStart).toBe(240);
    expect(h.surface.sessionCovered).toBe(false);
    expect(alphaOf(h)).toBeCloseTo(240 / SESSION_CURTAIN_MS, 6);
    h.run(10);
    await flushMicrotasks();
    await cover;
    expect(h.pump.now() - coverStart).toBe(SESSION_CURTAIN_MS);
    expect(h.surface.sessionCovered).toBe(true);
    expect(alphaOf(h)).toBe(1);

    // Reveal: the same 250ms default, measured from the fade's time origin.
    const reveal = h.surface.revealSession();
    h.pump.step(0);
    await flushMicrotasks();
    const revealStart = h.pump.now();
    h.pump.step(0);
    await flushMicrotasks();
    h.pump.step(240);
    await flushMicrotasks();
    expect(h.pump.now() - revealStart).toBe(240);
    expect(h.sessionLayer()).toHaveLength(1);
    expect(alphaOf(h)).toBeCloseTo(1 - 240 / SESSION_CURTAIN_MS, 6);
    h.pump.step(10);
    await flushMicrotasks();
    await reveal;
    expect(h.pump.now() - revealStart).toBe(SESSION_CURTAIN_MS);
    expect(h.surface.sessionCovered).toBe(false);
    expect(h.sessionLayer()).toHaveLength(0);
    h.surface.dispose();
  });

  it("never touches the story curtain layer or a snapshot curtain", async () => {
    const h = await createSurface();
    await h.commit({
      background: "base",
      curtain: { covered: true, fill: { color: "#112233" } },
    });
    expect(h.curtainLayer().length).toBeGreaterThanOrEqual(1);
    await h.surface.coverSession(0);
    // The host cover lives on its own layer; the story curtain state and fill
    // are untouched (they are part of the world, the host cover is not).
    expect(h.curtainLayer().length).toBeGreaterThanOrEqual(1);
    expect((h.curtainLayer()[0] as { fills: number[] }).fills).toEqual([
      0x112233,
    ]);
    const reveal = h.surface.revealSession(0);
    await h.runAsync(32);
    await reveal;
    expect(h.curtainLayer().length).toBeGreaterThanOrEqual(1);
    expect(h.sessionLayer()).toHaveLength(0);
    h.surface.dispose();
  });
});
