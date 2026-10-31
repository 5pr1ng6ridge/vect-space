// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { DESIGN_HEIGHT } from "./sceneFrame";
import { URLS, WIDE_SIZES, createSurface, cues } from "./sceneSurfaceHarness";
import {
  MemoryGraphics,
  MemorySprite,
  type MemoryTexture,
} from "./sceneTestKit";

const CURTAIN_ASSETS = { ...URLS, "gui.curtain": "/assets/curtain.png" };
const world = (fill: { color: string } | { asset: string }) => ({
  background: "base",
  curtain: { covered: true, fill },
});

describe("curtain cue", () => {
  it("covers with a colour and reveals again", async () => {
    const h = await createSurface();
    const cover = h.cue(cues.curtain("cover", { color: "#000000" }));
    h.run(120);
    await cover;
    expect(h.curtainLayer().length).toBeGreaterThanOrEqual(1);
    expect(h.curtainLayer()[0]?.alpha).toBe(1);
    expect(h.curtainLayer()[0]?.visible).toBe(true);

    const reveal = h.cue(cues.curtain("reveal", null));
    h.run(120);
    await reveal;
    expect(h.curtainLayer()).toHaveLength(0);
    h.surface.dispose();
  });

  it("splits the curtain horizontally on cover", async () => {
    const h = await createSurface();
    const cover = h.cue(
      cues.curtain(
        "cover",
        { color: "#111111" },
        { type: "split_horizontal" },
        50,
      ),
    );
    h.run(70);
    await cover;
    const mask = h
      .curtainLayer()
      .filter((child) => child instanceof MemoryGraphics)
      .at(-1) as MemoryGraphics | undefined;
    // Two halves that meet in the middle (the first Graphics is the fill).
    expect(mask?.rects).toHaveLength(2);
    expect(mask?.rects[0]?.[3]).toBeCloseTo(DESIGN_HEIGHT / 2);
    h.surface.dispose();
  });

  it("treats an omitted curtain fill as no new fill", async () => {
    const h = await createSurface();
    await h.commit(world({ color: "#000000" }));
    // The runtime skips `fill` when serialising a reveal cue, so the wire
    // payload can arrive without the key.
    const reveal = h.cue({
      ...cues.curtain("reveal", null),
      fill: undefined as unknown as null,
    } as never);
    h.run(120);
    await reveal;
    expect(h.curtainLayer()).toHaveLength(0);
    h.surface.dispose();
  });

  it("reports a diagnostic before falling back to black when the asset has no pixels", async () => {
    const h = await createSurface();
    await h.cue(
      cues.curtain("cover", { asset: "gui.missing" }, { type: "fade" }, 0),
    );
    // The world must stay covered, and the silent black fallback must be
    // discoverable instead of hiding a broken asset.
    const fill = h.curtainLayer()[0] as MemoryGraphics;
    expect(fill).toBeInstanceOf(MemoryGraphics);
    expect(fill.fills).toEqual([0x000000]);
    expect(fill.alpha).toBe(1);
    expect(
      h.messages.some(
        (m) => m.includes("已回退为纯色幕布") && m.includes("gui.missing"),
      ),
    ).toBe(true);
    h.surface.dispose();
  });
});

describe("snapshot curtain", () => {
  it("restores a covered curtain without replaying a cue, and drops it when hidden or reset", async () => {
    const h = await createSurface();
    await h.commit(world({ color: "#000000" }));
    expect(h.curtainLayer().length).toBeGreaterThanOrEqual(1);
    expect(h.curtainLayer()[0]?.alpha).toBe(1);

    await h.commit({
      background: "base",
      curtain: { covered: false, fill: null },
    });
    expect(h.curtainLayer()).toHaveLength(0);

    await h.commit(world({ color: "#000000" }));
    expect(h.curtainLayer().length).toBeGreaterThan(0);
    h.surface.reset();
    expect(h.curtainLayer()).toHaveLength(0);
    h.surface.dispose();
  });

  it("shows a prepared gui asset as the cover fill and follows a new revision of the same id", async () => {
    const h = await createSurface({ sizes: WIDE_SIZES });
    await h.commit(world({ asset: "gui.curtain" }), CURTAIN_ASSETS);
    const first = h.curtainLayer()[0] as MemorySprite;
    expect(first).toBeInstanceOf(MemorySprite);
    expect(first.alpha).toBe(1);
    expect((first.texture as unknown as MemoryTexture).url).toBe(
      "/assets/curtain.png",
    );

    await h.commit(world({ asset: "gui.curtain" }), {
      ...URLS,
      "gui.curtain": "/assets/curtain-b.png",
    });
    const second = h.curtainLayer()[0] as MemorySprite;
    expect(second).not.toBe(first);
    expect((second.texture as unknown as MemoryTexture).url).toBe(
      "/assets/curtain-b.png",
    );
    h.surface.dispose();
  });

  it("keeps the alpha of a curtain colour fill", async () => {
    const h = await createSurface();
    await h.commit(world({ color: "#000000AA" }));
    expect(h.curtainLayer()[0]?.alpha).toBeCloseTo(170 / 255, 5);
    h.surface.dispose();
  });
});
