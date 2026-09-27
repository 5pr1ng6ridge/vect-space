import { describe, expect, it } from "vitest";

import { stagePointToWorld } from "@vectspace/presentation-core/scene-frame";

import {
  authoredSpritePosition,
  DRAG_THRESHOLD_PX,
  dragWorldPosition,
  movedEnough,
  spriteDragTarget,
  spritePositionOffset,
  stagePointFromClientPoint,
} from "./stageEdit";
import type { ContentManifest, SceneNode } from "./types";

type SpriteNode = Extract<SceneNode, { type: "sprite" }>;

function spriteNode(overrides: Partial<SpriteNode> = {}): SpriteNode {
  return {
    type: "sprite",
    sprite_id: "lumi",
    action: "show",
    asset: "sprite.lumi",
    x: 960,
    y: 1080,
    scale: null,
    opacity: null,
    z: null,
    easing: "ease_in_out",
    duration_ms: 0,
    await: false,
    next: "end",
    ...overrides,
  };
}

function manifest(characters: ContentManifest["characters"]): ContentManifest {
  return {
    schema_version: 2,
    content_version: "test",
    entry_scene: "main",
    default_locale: "zh-CN",
    variables: {},
    characters,
    assets: {},
    scenes: ["scenes/main.yaml"],
    ui_motions: [],
    ui_motion_defaults: {},
  };
}

describe("stage pointer geometry", () => {
  it("maps a client point through the canvas box into design pixels", () => {
    const rect = { left: 10, top: 20, width: 480, height: 270 };
    expect(stagePointFromClientPoint(rect, 10, 20)).toEqual({ x: 0, y: 0 });
    expect(stagePointFromClientPoint(rect, 250, 155)).toEqual({
      x: 960,
      y: 540,
    });
    expect(stagePointFromClientPoint(rect, 490, 290)).toEqual({
      x: 1920,
      y: 1080,
    });
  });

  it("never divides by an unmeasured canvas", () => {
    expect(
      stagePointFromClientPoint(
        { left: 0, top: 0, width: 0, height: 0 },
        12,
        34,
      ),
    ).toEqual({ x: 12, y: 34 });
  });
  it("treats only movements above the threshold as a drag", () => {
    expect(movedEnough({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(false);
    expect(
      movedEnough({ x: 10, y: 10 }, { x: 10 + DRAG_THRESHOLD_PX / 2, y: 10 }),
    ).toBe(false);
    expect(movedEnough({ x: 10, y: 10 }, { x: 14, y: 10 })).toBe(true);
  });
});

describe("drag world position", () => {
  const identityCamera = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };

  it("moves the sprite by the pointer's world displacement", () => {
    expect(
      dragWorldPosition({
        origin: { x: 960, y: 1080 },
        pointerDown: { x: 960, y: 540 },
        pointerNow: { x: 1230, y: 700 },
        camera: identityCamera,
      }),
    ).toEqual({ x: 1230, y: 1240 });
  });

  it("inverts a zoomed camera instead of using raw design pixels", () => {
    // At 2x zoom one design pixel is half a world pixel, and the camera offset
    // shifts the world origin.
    const camera = { x: 100, y: -50, zoom: 2, rotation_deg: 0 };
    const origin = { x: 960, y: 1080 };
    const down = stagePointToWorld({ x: 960, y: 540 }, camera);
    const now = stagePointToWorld({ x: 1060, y: 540 }, camera);
    const moved = dragWorldPosition({
      origin,
      pointerDown: { x: 960, y: 540 },
      pointerNow: { x: 1060, y: 540 },
      camera,
    });
    expect(moved.x - origin.x).toBeCloseTo(now.x - down.x, 6);
    expect(moved.y - origin.y).toBeCloseTo(now.y - down.y, 6);
    // 100 design pixels is 50 world pixels at 2x zoom.
    expect(moved.x - origin.x).toBeCloseTo(50, 6);
  });

  it("keeps the world displacement identical under camera rotation", () => {
    const camera = { x: 0, y: 0, zoom: 1, rotation_deg: 90 };
    const origin = { x: 500, y: 500 };
    const moved = dragWorldPosition({
      origin,
      pointerDown: { x: 960, y: 540 },
      pointerNow: { x: 1060, y: 540 },
      camera,
    });
    // A 90° rotation turns +x into -y in world space.
    expect(moved.x - origin.x).toBeCloseTo(0, 6);
    expect(moved.y - origin.y).toBeCloseTo(-100, 6);
  });
});

describe("authored sprite position", () => {
  const characters = {
    lumi: {
      display_name: "露米",
      default_expression: "smile",
      expressions: {
        smile: { asset: "sprite.lumi.smile", offset_x: 40, offset_y: -20 },
        angry: { asset: "sprite.lumi.angry" },
      },
    },
  };

  it("has no offset without a character binding", () => {
    expect(spritePositionOffset(spriteNode(), manifest(characters))).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("uses the character's default expression offset", () => {
    expect(
      spritePositionOffset(
        spriteNode({ character: "lumi" }),
        manifest(characters),
      ),
    ).toEqual({ x: 40, y: -20 });
  });

  it("prefers the node's own expression and treats a missing offset as 0", () => {
    expect(
      spritePositionOffset(
        spriteNode({ character: "lumi", expression: "smile" }),
        manifest(characters),
      ),
    ).toEqual({ x: 40, y: -20 });
    expect(
      spritePositionOffset(
        spriteNode({ character: "lumi", expression: "angry" }),
        manifest(characters),
      ),
    ).toEqual({ x: 0, y: 0 });
  });

  it("resolves unknown ids to no offset instead of guessing", () => {
    expect(
      spritePositionOffset(
        spriteNode({ character: "ghost" }),
        manifest(characters),
      ),
    ).toEqual({ x: 0, y: 0 });
    expect(
      spritePositionOffset(
        spriteNode({ character: "lumi", expression: "missing" }),
        manifest(characters),
      ),
    ).toEqual({ x: 0, y: 0 });
    expect(
      spritePositionOffset(spriteNode({ character: "lumi" }), undefined),
    ).toEqual({ x: 0, y: 0 });
  });

  it("removes the expression offset before writing x/y back", () => {
    expect(
      authoredSpritePosition(
        spriteNode({ character: "lumi", x: 960, y: 1080 }),
        manifest(characters),
        { x: 1200, y: 600 },
      ),
    ).toEqual({ x: 1160, y: 620 });
  });

  it("rounds to whole design pixels", () => {
    expect(
      authoredSpritePosition(spriteNode(), undefined, {
        x: 960.4,
        y: 1080.6,
      }),
    ).toEqual({ x: 960, y: 1081 });
  });
});

describe("sprite drag target", () => {
  it("offers the instance for show and move and nothing for hide", () => {
    expect(spriteDragTarget(spriteNode({ action: "show" }))).toBe("lumi");
    expect(spriteDragTarget(spriteNode({ action: "move" }))).toBe("lumi");
    expect(spriteDragTarget(spriteNode({ action: "hide" }))).toBeNull();
  });
});
