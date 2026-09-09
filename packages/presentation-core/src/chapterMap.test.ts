import { describe, expect, it } from "vitest";
import {
  clampMapCenter,
  compareStableId,
  containMapRect,
  hitTestMapHotspots,
  mapDragExceededThreshold,
  resolveChapterMapHoverText,
  snapMap,
  sortMapObjects,
} from "./chapterMap";

describe("chapter-map geometry", () => {
  it("compares IDs by deterministic UTF-16 order", () => {
    expect(compareStableId("z", "ä")).toBe(-1);
    expect(compareStableId("ä", "z")).toBe(1);
    expect(compareStableId("same", "same")).toBe(0);
  });

  it("sorts mixed layers by z and stable id", () => {
    const result = sortMapObjects([
      { kind: "hotspot" as const, item: { id: "z", z: 2 } },
      { kind: "decoration" as const, item: { id: "b", z: 1 } },
      { kind: "hotspot" as const, item: { id: "a", z: 1 } },
    ]);
    expect(result.map(({ item }) => item.id)).toEqual(["a", "b", "z"]);
  });

  it("keeps a viewport center inside a room", () => {
    expect(clampMapCenter(-20, 4000, 1920)).toBe(960);
    expect(clampMapCenter(3990, 4000, 1920)).toBe(3040);
    expect(clampMapCenter(400, 1000, 1920)).toBe(500);
  });

  it("snaps only finite values and detects real drags", () => {
    expect(snapMap(49)).toBe(40);
    expect(snapMap(51)).toBe(60);
    expect(snapMap(Number.NaN)).toBeNaN();
    expect(mapDragExceededThreshold({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(true);
    expect(mapDragExceededThreshold({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe(
      false,
    );
  });

  it("rejects overflowing/out-of-room rectangles", () => {
    expect(
      containMapRect({ x: 20, y: 20, width: 100, height: 100 }, 1920, 1080),
    ).toBe(true);
    expect(
      containMapRect(
        { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 20 },
        1920,
        1080,
      ),
    ).toBe(false);
  });

  it("hits the topmost hotspot with stable tie-breaking", () => {
    const point = { x: 50, y: 50 };
    expect(
      hitTestMapHotspots(
        [
          { id: "a", z: 3, x: 0, y: 0, width: 100, height: 100 },
          { id: "b", z: 3, x: 0, y: 0, width: 100, height: 100 },
          { id: "c", z: 1, x: 0, y: 0, width: 100, height: 100 },
        ],
        point,
      )?.id,
    ).toBe("b");
  });

  it("resolves legacy, custom, and explicitly hidden hover text", () => {
    expect(resolveChapterMapHoverText("章节标题", undefined)).toBe("章节标题");
    expect(resolveChapterMapHoverText("章节标题", null)).toBe("章节标题");
    expect(resolveChapterMapHoverText("章节标题", "自定义说明")).toBe(
      "自定义说明",
    );
    expect(resolveChapterMapHoverText("章节标题", " \n\t ")).toBeNull();
  });
});
