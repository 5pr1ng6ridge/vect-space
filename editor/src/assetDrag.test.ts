import { describe, expect, it } from "vitest";

import {
  ASSET_DRAG_TYPE,
  ASSET_MULTI_DRAG_TYPE,
  draggedAssetId,
  isAssetDrag,
  resolveBackgroundDrop,
} from "./assetDrag";
import type { EditorAsset, EditorLayout } from "./types";

const ASSETS: EditorAsset[] = [
  {
    id: "bg.a",
    kind: "background",
    path: "backgrounds/a.png",
    absolute_path: "C:/bg/a.png",
  },
  {
    id: "bg.b",
    kind: "background",
    path: "backgrounds/b.png",
    absolute_path: "C:/bg/b.png",
  },
  {
    id: "sprite.lumi",
    kind: "sprite",
    path: "sprites/lumi.png",
    absolute_path: "C:/sprites/lumi.png",
  },
];

function layout(metadata: EditorLayout["asset_metadata"]): EditorLayout {
  return { version: 1, scenes: {}, asset_metadata: metadata };
}

/** Minimal `DataTransfer` stand-in: only the members the helpers read. */
function transfer(
  entries: Record<string, string>,
  types?: readonly string[],
): { getData(type: string): string; types: readonly string[] } {
  return {
    getData: (type) => entries[type] ?? "",
    types: types ?? Object.keys(entries),
  };
}

describe("internal asset drags", () => {
  it("resolves a registered id of an accepted kind", () => {
    expect(
      draggedAssetId(transfer({ [ASSET_DRAG_TYPE]: "bg.b" }), ASSETS, [
        "background",
      ]),
    ).toBe("bg.b");
  });

  it("rejects unknown ids and wrong kinds", () => {
    expect(
      draggedAssetId(transfer({ [ASSET_DRAG_TYPE]: "ghost" }), ASSETS, [
        "background",
      ]),
    ).toBeNull();
    expect(
      draggedAssetId(transfer({ [ASSET_DRAG_TYPE]: "sprite.lumi" }), ASSETS, [
        "background",
      ]),
    ).toBeNull();
  });

  it("recognizes exactly the internal single-asset drag", () => {
    expect(isAssetDrag(transfer({ [ASSET_DRAG_TYPE]: "bg.b" }))).toBe(true);
    expect(
      isAssetDrag(
        transfer({
          [ASSET_DRAG_TYPE]: "bg.b",
          [ASSET_MULTI_DRAG_TYPE]: '["bg.b","bg.a"]',
        }),
      ),
    ).toBe(false);
    expect(isAssetDrag(transfer({ Files: "a.png" }, ["Files"]))).toBe(false);
    expect(isAssetDrag(transfer({ "text/plain": "hi" }))).toBe(false);
    expect(isAssetDrag(null)).toBe(false);
  });
});

describe("background stage drops", () => {
  it("resolves one registered background asset", () => {
    expect(
      resolveBackgroundDrop(
        transfer({ [ASSET_DRAG_TYPE]: "bg.b" }),
        ASSETS,
        null,
      ),
    ).toBe("bg.b");
  });

  it("refuses OS file drags and multi-selection payloads", () => {
    expect(
      resolveBackgroundDrop(
        transfer({ Files: "C:/pictures/photo.png" }, ["Files"]),
        ASSETS,
        null,
      ),
    ).toBeNull();
    expect(
      resolveBackgroundDrop(
        transfer(
          {
            [ASSET_DRAG_TYPE]: "bg.b",
            [ASSET_MULTI_DRAG_TYPE]: '["bg.b","bg.a"]',
          },
          [ASSET_DRAG_TYPE, ASSET_MULTI_DRAG_TYPE],
        ),
        ASSETS,
        null,
      ),
    ).toBeNull();
  });

  it("refuses invalid or wrong-kind ids", () => {
    expect(
      resolveBackgroundDrop(
        transfer({ [ASSET_DRAG_TYPE]: "ghost" }),
        ASSETS,
        null,
      ),
    ).toBeNull();
    expect(
      resolveBackgroundDrop(
        transfer({ [ASSET_DRAG_TYPE]: "sprite.lumi" }),
        ASSETS,
        null,
      ),
    ).toBeNull();
    expect(
      resolveBackgroundDrop(transfer({ [ASSET_DRAG_TYPE]: "" }), ASSETS, null),
    ).toBeNull();
  });

  it("keeps hidden assets out of new assignments", () => {
    const hidden = layout({ "bg.b": { hidden: true } });
    expect(
      resolveBackgroundDrop(
        transfer({ [ASSET_DRAG_TYPE]: "bg.b" }),
        ASSETS,
        hidden,
      ),
    ).toBeNull();
    // A visible sibling is still accepted.
    expect(
      resolveBackgroundDrop(
        transfer({ [ASSET_DRAG_TYPE]: "bg.a" }),
        ASSETS,
        hidden,
      ),
    ).toBe("bg.a");
  });
});
