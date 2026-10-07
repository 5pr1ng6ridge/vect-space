import { describe, expect, it } from "vitest";
import { normalizeVisualWorld, spritePreset, spriteResourceId, spriteTrackState, spriteFit, LEGACY_BACKGROUND_ID } from "./visual";
import { evaluateSceneFrame, hitTestSceneFrame, worldPointToStage } from "./sceneFrame";

const CAMERA = { x: 200, y: 100, zoom: 2, rotation_deg: 0 };
const GEOMETRY = { spriteSize: () => ({ width: 200, height: 100 }) };

describe("shared Sprite sources and layout", () => {
  it("normalizes legacy input into only canonical Sprites and diagnoses the reserved background collision", () => {
    const legacy = { ...spritePreset("character", { type: "image", asset: "hero" }), asset: "hero" };
    delete legacy.source;
    const world = normalizeVisualWorld({ background: "room", sprites: { hero: legacy } });
    expect(world).not.toHaveProperty("background");
    expect(world.sprites.hero).not.toHaveProperty("asset");
    expect(world.sprites.hero?.source).toEqual({ type: "image", asset: "hero" });
    expect(world.sprites[LEGACY_BACKGROUND_ID]).toEqual(spritePreset("background", { type: "image", asset: "room" }));
    expect(() => normalizeVisualWorld({ background: "room", sprites: { [LEGACY_BACKGROUND_ID]: legacy } })).toThrow("冲突");
    expect(spriteResourceId(spritePreset("text", { type: "text", text_block: "label" }))).toBe("text-block:label");
  });

  it("applies category defaults only to creation and keeps coordinate space independent", () => {
    expect(spritePreset("character", { type: "image", asset: "hero" }).anchor_y).toBe(1);
    expect(spritePreset("item", { type: "image", asset: "hero" }).anchor_y).toBe(0.5);
    expect(spritePreset("ui", { type: "image", asset: "hero" }).space).toBe("screen");
    const authored = { ...spritePreset("ui", { type: "image", asset: "hero" }), space: "world" as const, x: 100, y: 200 };
    expect(normalizeVisualWorld({ sprites: { authored } }).sprites.authored).toEqual(authored);
  });

  it("uses canonical track sources with creation-only presets and preserves authored pose on updates", () => {
    const source = { type: "text" as const, text_block: "label" };
    const frame = evaluateSceneFrame({ sprites: {}, tracks: [{ type: "sprite", sprite_id: "label", source, sprite_kind: "ui", remove_at_end: false,
      channels: { x: [{ at_ms: 0, value: 100, easing: "linear" }] } }], camera: CAMERA, duration_ms: 100, bgm_volume: 1 }, 0, GEOMETRY);
    expect(frame.objects[0]).toMatchObject({ source, sprite_kind: "ui", space: "screen", x: 100, y: 540, anchor_y: 0.5 });
    const base = { ...spritePreset("item", { type: "image", asset: "hero" }), x: 400, y: 300, space: "world" as const };
    expect(spriteTrackState(base, { source, sprite_kind: "ui" })).toMatchObject({ x: 400, y: 300, space: "world", source, sprite_kind: "ui" });
    expect(() => spriteTrackState(base, { source, asset: "hero" })).toThrow("冲突");
    expect(() => spriteTrackState(undefined, {})).toThrow("来源");
  });

  it("uses the same contain/cover/stretch ratios and hit boxes for every source/category", () => {
    expect(spriteFit(200, 100, { width: 100, height: 100, fit: "contain" })).toEqual({ x: 0.5, y: 0.5 });
    expect(spriteFit(200, 100, { width: 100, height: 100, fit: "cover" })).toEqual({ x: 1, y: 1 });
    expect(spriteFit(200, 100, { width: 100, height: 100, fit: "stretch" })).toEqual({ x: 0.5, y: 1 });
    for (const kind of ["background", "character", "item", "ui", "text"] as const) {
      const state = { ...spritePreset(kind, kind === "text" ? { type: "text" as const, text_block: "label" } : { type: "image" as const, asset: "hero" }), layout: { width: 100, height: 100, fit: "cover" as const }, scale: 2, x: 500, y: 500, anchor_y: 0.5 };
      const frame = evaluateSceneFrame({ sprites: { object: state }, tracks: [], camera: CAMERA, duration_ms: 100, bgm_volume: 1 }, 0, GEOMETRY);
      expect(frame.objects[0]?.width).toBe(200);
      expect(frame.objects[0]?.height).toBe(200);
      const center = state.space === "screen" ? { x: 500, y: 500 } : worldPointToStage({ x: 500, y: 500 }, CAMERA);
      expect(hitTestSceneFrame(frame, center)?.id).toBe("object");
    }
  });

  it("orders screen above world even at a lower z and handles rotated geometry", () => {
    const image = { type: "image" as const, asset: "hero" };
    const sprites = {
      world: { ...spritePreset("item", image), x: 500, y: 500, z: 999 },
      screen: { ...spritePreset("ui", image), x: 500, y: 500, z: -999, rotation_deg: 90 },
    };
    const frame = evaluateSceneFrame({ sprites, tracks: [], camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 }, duration_ms: 100, bgm_volume: 1 }, 0, GEOMETRY);
    expect(hitTestSceneFrame(frame, { x: 500, y: 580 })?.id).toBe("screen");
    expect(hitTestSceneFrame(frame, { x: 580, y: 500 })?.id).toBe("world");
  });
});
