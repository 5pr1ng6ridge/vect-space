// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  DEFAULT_SPRITE_HEIGHT,
  DEFAULT_SPRITE_WIDTH,
  EMPTY_SCENE_OVERRIDES,
  composeWorldTransform,
  entryTweenPose,
  evaluateSceneFrame,
  flashAlpha,
  hitTestSceneFrame,
  isEmptySceneOverrides,
  mergeSceneOverrides,
  shakeOffset,
  spriteBox,
  stagePointToWorld,
  worldPointToStage,
  type SceneFrame,
  type SceneOverrides,
  type SceneSpriteGeometry,
} from "./sceneFrame";
import type { TimelineTrack } from "./types";

const GEOMETRY: SceneSpriteGeometry = {
  spriteSize: () => ({ width: 100, height: 200 }),
};

const CAMERA = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };

function frame(): SceneFrame {
  return evaluateSceneFrame(
    {
      duration_ms: 1_000,
      tracks: [],
      sprites: {
        hero: {
          asset: "hero",
          x: 100,
          y: 200,
          scale: 1,
          scale_x: 1,
          scale_y: 1,
          rotation_deg: 0,
          opacity: 1,
          z: 0,
        },
      },
      camera: CAMERA,
      bgm_volume: 1,
    },
    0,
    GEOMETRY,
  );
}

describe("evaluateSceneFrame", () => {
  it("derives sprite geometry from the asset size and evaluated scale", () => {
    const scene = frame();
    const hero = scene.objects.find((object) => object.id === "hero");
    expect(hero?.width).toBe(100);
    expect(hero?.height).toBe(200);
    expect(hero?.anchor_y).toBe(1);
  });

  it("evaluates tracks, camera and buttons with the shared evaluator", () => {
    const tracks: TimelineTrack[] = [
      {
        type: "sprite",
        sprite_id: "hero",
        asset: null,
        remove_at_end: false,
        channels: {
          x: [
            { at_ms: 0, value: "inherit", easing: "linear" },
            { at_ms: 1_000, value: 600, easing: "linear" },
          ],
          flip_x_scaled: [],
        },
      },
      {
        type: "camera",
        channels: {
          x: [
            { at_ms: 0, value: 0, easing: "linear" },
            { at_ms: 1_000, value: 100, easing: "linear" },
          ],
        },
      },
      {
        type: "button",
        instance_id: "start",
        channels: {
          x: [
            { at_ms: 0, value: 0, easing: "linear" },
            { at_ms: 1_000, value: 50, easing: "linear" },
          ],
        },
      },
      {
        type: "video",
        asset: "clip",
        channels: {
          width: [
            { at_ms: 0, value: 100, easing: "linear" },
            { at_ms: 1_000, value: 200, easing: "linear" },
          ],
        },
      },
    ];
    const scene = evaluateSceneFrame(
      {
        duration_ms: 1_000,
        tracks,
        sprites: {
          hero: {
            asset: "hero",
            x: 100,
            y: 200,
            scale: 2,
            scale_x: 1,
            scale_y: 1,
            rotation_deg: 0,
            opacity: 1,
            z: 0,
          },
        },
        camera: CAMERA,
        bgm_volume: 0.5,
      },
      500,
      GEOMETRY,
    );
    const hero = scene.objects.find((object) => object.id === "hero");
    expect(hero?.x).toBeCloseTo(350);
    expect(scene.camera.x).toBeCloseTo(50);
    expect(
      scene.objects.find((object) => object.id === "start")?.x,
    ).toBeCloseTo(25);
    const video = scene.objects.find((object) => object.kind === "video");
    expect(video?.width).toBeCloseTo(150);
    expect(video?.volume).toBe(1);
    expect(scene.bgm_volume).toBeCloseTo(0.5);
  });

  it("falls back to a default sprite box for an unresolved asset", () => {
    expect(
      spriteBox({ spriteSize: () => undefined as never }, "", 1, 1, 1),
    ).toEqual({
      width: DEFAULT_SPRITE_WIDTH,
      height: DEFAULT_SPRITE_HEIGHT,
    });
  });

  it("keeps the horizontal flip sign out of the layout box", () => {
    const box = spriteBox(GEOMETRY, "hero", 1, -2, 1);
    expect(box.width).toBe(200);
    expect(box.height).toBe(200);
  });
});

describe("scene overrides", () => {
  it("merges patches and recomputes sprite boxes", () => {
    const merged = mergeSceneOverrides(
      frame(),
      {
        objects: new Map([["hero", { x: 400, scale: 2 }]]),
        camera: { zoom: 1.5 },
      },
      GEOMETRY,
    );
    const hero = merged.objects.find((object) => object.id === "hero");
    expect(hero?.x).toBe(400);
    expect(hero?.width).toBe(200);
    expect(merged.camera.zoom).toBe(1.5);
    // The original frame is untouched.
    expect(frame().objects.find((object) => object.id === "hero")?.x).toBe(100);
  });

  it("returns the evaluated frame when there is nothing to merge", () => {
    const evaluated = frame();
    expect(isEmptySceneOverrides(EMPTY_SCENE_OVERRIDES)).toBe(true);
    expect(mergeSceneOverrides(evaluated, EMPTY_SCENE_OVERRIDES)).toBe(
      evaluated,
    );
  });

  it("does not recompute button boxes from scale channels", () => {
    const withButton: SceneFrame = {
      ...frame(),
      objects: [
        {
          id: "start",
          kind: "button",
          x: 10,
          y: 20,
          width: 200,
          height: 80,
          scale: 1,
          scale_x: 2,
          scale_y: 2,
          rotation_deg: 0,
          opacity: 1,
          z: 0,
          asset: "",
          anchor_x: 0,
          anchor_y: 0,
          flip_x: false,
        },
      ],
    };
    const merged = mergeSceneOverrides(
      withButton,
      { objects: new Map([["start", { scale_x: 3 }]]), camera: {} },
      GEOMETRY,
    );
    expect(merged.objects[0]?.width).toBe(200);
    expect(merged.objects[0]?.scale_x).toBe(3);
  });
});

describe("camera helpers", () => {
  it("round-trips a point through the camera projection", () => {
    const camera = { x: 30, y: -40, zoom: 1.4, rotation_deg: 12 };
    const stage = worldPointToStage({ x: 500, y: 300 }, camera);
    const world = stagePointToWorld(stage, camera);
    expect(world.x).toBeCloseTo(500);
    expect(world.y).toBeCloseTo(300);
  });

  it("combines the base camera and shake once", () => {
    const transform = composeWorldTransform(
      { x: 10, y: 20, zoom: 2, rotation_deg: 90 },
      { x: 5, y: -5 },
    );
    expect(transform.positionX).toBe(DESIGN_WIDTH / 2 + 5);
    expect(transform.positionY).toBe(DESIGN_HEIGHT / 2 - 5);
    expect(transform.pivotX).toBe(DESIGN_WIDTH / 2 + 10);
    expect(transform.pivotY).toBe(DESIGN_HEIGHT / 2 + 20);
    expect(transform.scale).toBe(2);
    expect(transform.rotation).toBeCloseTo(Math.PI / 2);
  });
});

describe("screen effects", () => {
  it("fades a flash with the shipped ease-out curve and peak", () => {
    const flash = { startMs: 0, durationMs: 400 };
    expect(flashAlpha(0, flash)).toBeCloseTo(0.88);
    expect(flashAlpha(200, flash)).toBeLessThan(0.88);
    expect(flashAlpha(400, flash)).toBeCloseTo(0);
    expect(flashAlpha(100, null)).toBe(0);
  });

  it("offsets the camera while a shake is active", () => {
    const shake = { startMs: 100, durationMs: 400 };
    expect(shakeOffset(0, shake)).toEqual({ x: 0, y: 0 });
    const active = shakeOffset(200, shake);
    expect(Math.abs(active.x) + Math.abs(active.y)).toBeGreaterThan(0);
  });

  it("keeps flash and shake independent", () => {
    const flash = { startMs: 0, durationMs: 100 };
    const shake = { startMs: 0, durationMs: 100 };
    expect(flashAlpha(50, flash)).toBeGreaterThan(0);
    expect(shakeOffset(50, shake).x).not.toBe(0);
  });
});

describe("hitTestSceneFrame", () => {
  it("returns the topmost object and ignores empty space", () => {
    const scene = frame();
    scene.objects.push({
      ...scene.objects[0]!,
      id: "front",
      z: 10,
    });
    expect(hitTestSceneFrame(scene, { x: 100, y: 150 })?.id).toBe("front");
    expect(hitTestSceneFrame(scene, { x: 900, y: 10 })).toBeNull();
  });

  it("respects the anchor when testing a sprite box", () => {
    const scene = frame();
    const hero = scene.objects.find((object) => object.id === "hero");
    if (hero === undefined) throw new Error("缺少测试对象");
    hero.anchor_x = 0;
    hero.anchor_y = 0;
    // The box now starts at the object position.
    expect(hitTestSceneFrame(scene, { x: 110, y: 210 })?.id).toBe("hero");
    expect(hitTestSceneFrame(scene, { x: 90, y: 150 })).toBeNull();
  });

  it("uses the inverse camera transform", () => {
    const scene = frame();
    scene.camera = { x: 0, y: 0, zoom: 2, rotation_deg: 0 };
    const projected = worldPointToStage({ x: 100, y: 150 }, scene.camera);
    expect(hitTestSceneFrame(scene, projected)?.id).toBe("hero");
    expect(hitTestSceneFrame(scene, { x: 100, y: 150 })).toBeNull();
  });
});

describe("entry pose", () => {
  it("mirrors the shipped entrance offset", () => {
    const pose = entryTweenPose({
      asset: "hero",
      x: 0,
      y: 0,
      scale: 1,
      scale_x: 1,
      scale_y: 1,
      rotation_deg: 0,
      opacity: 1,
      z: 0,
    });
    expect(pose.y).toBe(48);
    expect(pose.scale).toBeCloseTo(0.96);
  });
});

describe("override bookkeeping", () => {
  it("reports whether an override set is empty", () => {
    const overrides: SceneOverrides = { objects: new Map(), camera: {} };
    expect(isEmptySceneOverrides(overrides)).toBe(true);
    expect(
      isEmptySceneOverrides({
        objects: new Map([["a", { x: 1 }]]),
        camera: {},
      }),
    ).toBe(false);
  });
});
