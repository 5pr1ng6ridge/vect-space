/**
 * Shared fixture of the scene surface test suites: one `SceneSurface` on the
 * in-memory kit, a deterministic frame pump and builders for the visual cues.
 */

import type { AnimationMap } from "./imageAnimation";
import { evaluateSceneFrame, type SceneFrame } from "./sceneFrame";
import { SceneSurface } from "./sceneSurface";
import type { SceneVisualCue } from "./sceneSurfaceTypes";
import {
  MemoryGraphics,
  MemorySprite,
  createFramePump,
  createMemoryKit,
  createMemoryTextureLoader,
  type FramePump,
  type MemoryKit,
  type MemoryNode,
  type MemoryTexture,
} from "./sceneTestKit";
import type {
  AssetUrlMap,
  BackgroundTransitionSpec,
  CurtainFill,
  CurtainTransitionSpec,
  Easing,
  ScreenEffectSpec,
  SpriteSnapshot,
  TimelineTrack,
} from "./types";
import { LEGACY_BACKGROUND_ID, spriteResourceId } from "./visual";

export const URLS: AssetUrlMap = {
  base: "/assets/base.png",
  next: "/assets/next.png",
  other: "/assets/other.png",
  walk: "/assets/walk.png",
};
export const BASE_TEXTURE = "/assets/base.png";
export const NEXT_TEXTURE = "/assets/next.png";
export const OTHER_TEXTURE = "/assets/other.png";

export const ANIMATIONS: AnimationMap = {
  walk: {
    id: "walk",
    width: 100,
    height: 50,
    total_duration_ms: 400,
    frames: [
      { asset: "walk_a", url: "/assets/walk/a.png", duration_ms: 100 },
      { asset: "walk_b", url: "/assets/walk/b.png", duration_ms: 100 },
      { asset: "walk_c", url: "/assets/walk/c.png", duration_ms: 100 },
      { asset: "walk_d", url: "/assets/walk/d.png", duration_ms: 100 },
    ],
  },
  // A ping-pong animation repeats frame urls by design; the store must decode
  // and reference each distinct url once while the frame order is preserved.
  pingpong: {
    id: "pingpong",
    width: 120,
    height: 60,
    total_duration_ms: 400,
    frames: [
      { asset: "pp_a", url: "/assets/pp/a.png", duration_ms: 100 },
      { asset: "pp_b", url: "/assets/pp/b.png", duration_ms: 100 },
      { asset: "pp_a", url: "/assets/pp/a.png", duration_ms: 100 },
      { asset: "pp_b", url: "/assets/pp/b.png", duration_ms: 100 },
    ],
  },
};

export const CAMERA = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };

/** Sizes that give the three stills a non-square aspect (cover layout visible). */
export const WIDE_SIZES = {
  [BASE_TEXTURE]: { width: 100, height: 50 },
  [NEXT_TEXTURE]: { width: 100, height: 50 },
  [OTHER_TEXTURE]: { width: 100, height: 50 },
} as const;

export function sprite(
  asset: string,
  overrides: Partial<SpriteSnapshot> = {},
): SpriteSnapshot {
  return {
    asset,
    x: 960,
    y: 1080,
    scale: 1,
    scale_x: 1,
    scale_y: 1,
    rotation_deg: 0,
    opacity: 1,
    z: 0,
    ...overrides,
  };
}

export interface WorldInput {
  background?: string | null;
  sprites?: Record<string, SpriteSnapshot>;
  curtain?: { covered: boolean; fill: CurtainFill | null };
}

export interface Harness {
  surface: SceneSurface;
  kit: MemoryKit;
  pump: FramePump;
  loaded: MemoryTexture[];
  destroyed: MemoryTexture[];
  /** Diagnostics the surface reported. */
  messages: string[];
  /** Advances the frame pump by `ms` of virtual time in 16 ms frames. */
  run(ms?: number): void;
  /** Like `run`, draining promise continuations between frames. */
  runAsync(ms: number): Promise<void>;
  /** Prepares a world (an empty one with `world` laid over it) without committing. */
  prepare(
    world?: WorldInput,
    assets?: AssetUrlMap,
  ): ReturnType<SceneSurface["prepare"]>;
  /** Prepares and commits a world. */
  commit(world?: WorldInput, assets?: AssetUrlMap): Promise<void>;
  cue(cue: SceneVisualCue, signal?: AbortSignal): Promise<void>;
  /** Sprites at the character z-range. */
  characters(): MemorySprite[];
  /** Background sprites (the reserved z-range, feather strips excluded). */
  backgrounds(): MemorySprite[];
  featherStrips(): MemorySprite[];
  cameraLayer(): MemoryNode;
  effects(): MemoryGraphics[];
  transitionLayer(): MemoryGraphics[];
  curtainLayer(): (MemorySprite | MemoryGraphics)[];
  sessionLayer(): MemoryGraphics[];
}

export interface HarnessOptions {
  sizes?: Readonly<Record<string, { width: number; height: number }>>;
  failures?: ReadonlySet<string>;
  animations?: AnimationMap;
}

const BACKGROUND_Z = -10000;

/** Lets the surface's asynchronous work settle. */
export async function flushMicrotasks(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

export async function createSurface(
  options: HarnessOptions = {},
): Promise<Harness> {
  const kit = createMemoryKit();
  const loader = createMemoryTextureLoader(
    options.sizes ?? {},
    options.failures ?? new Set<string>(),
  );
  const pump = createFramePump();
  const messages: string[] = [];
  const surface = new SceneSurface({
    canvas: document.createElement("canvas"),
    kit: kit.kit,
    animations: options.animations ?? ANIMATIONS,
    textureLoader: loader.load,
    requestFrame: pump.request,
    cancelFrame: pump.cancel,
    diagnostic: (message) => messages.push(message),
  });
  await surface.init();
  // The loop starts with no elapsed time yet, exactly like a browser's first
  // animation frame; prime it so a later step advances real time.
  pump.step(0);
  const layer = (index: number): MemoryNode[] =>
    kit.applications[0]?.stage.children[index]?.children ?? [];
  const sprites = (): MemorySprite[] =>
    layer(0).filter(
      (node): node is MemorySprite =>
        node instanceof MemorySprite && !node.label.endsWith("#feather"),
    );
  const run = (ms = 16): void => {
    let remaining = ms;
    while (remaining > 0) {
      const slice = Math.min(16, remaining);
      pump.step(slice);
      remaining -= slice;
    }
  };
  return {
    surface,
    kit,
    pump,
    loaded: loader.loaded,
    destroyed: loader.destroyed,
    messages,
    run,
    runAsync: async (ms) => {
      let remaining = ms;
      while (remaining > 0) {
        const slice = Math.min(16, remaining);
        run(slice);
        remaining -= slice;
        await flushMicrotasks(2);
      }
    },
    prepare: (world = {}, assets = URLS) =>
      surface.prepare({
        world: { background: null, sprites: {}, camera: CAMERA, ...world },
        assets,
      }),
    commit: async (world = {}, assets = URLS) => {
      surface.applyWorld(
        await surface.prepare({
          world: { background: null, sprites: {}, camera: CAMERA, ...world },
          assets,
        }),
      );
    },
    cue: (cue, signal = new AbortController().signal) =>
      surface.runCue(cue, { assets: URLS, signal, getRate: () => 1 }),
    characters: () => sprites().filter((node) => node.zIndex !== BACKGROUND_Z),
    backgrounds: () => sprites().filter((node) => node.zIndex === BACKGROUND_Z),
    featherStrips: () =>
      layer(0).filter(
        (node): node is MemorySprite =>
          node instanceof MemorySprite && node.label.endsWith("#feather"),
      ),
    cameraLayer: () => {
      const camera = kit.applications[0]?.stage.children[0];
      if (camera === undefined) throw new Error("surface has no camera layer");
      return camera;
    },
    effects: () => layer(1) as MemoryGraphics[],
    transitionLayer: () =>
      (kit.applications[0]?.stage.children[2]?.children ??
        []) as MemoryGraphics[],
    curtainLayer: () =>
      (kit.applications[0]?.stage.children[3]?.children ?? []) as (
        MemorySprite | MemoryGraphics
      )[],
    sessionLayer: () =>
      (kit.applications[0]?.stage.children[4]?.children ??
        []) as MemoryGraphics[],
  };
}

/** `asset id` of every non-background sprite the surface currently shows. */
export function shownAssets(harness: Harness): Record<string, string> {
  return Object.fromEntries(
    Object.entries(harness.surface.captureBases().sprites)
      .filter(([id]) => id !== LEGACY_BACKGROUND_ID)
      .map(([id, state]) => [id, spriteResourceId(state)]),
  );
}

/** Texture urls in destruction order (sorted when the order is not the point). */
export function urlsOf(
  textures: readonly MemoryTexture[],
  sorted = false,
): string[] {
  const urls = textures.map((texture) => texture.url);
  return sorted ? urls.sort() : urls;
}

/** An evaluated frame of `sprites` with the given (default empty) tracks. */
export function frameAt(
  harness: Pick<Harness, "surface">,
  sprites: Record<string, SpriteSnapshot>,
  elapsedMs: number,
  tracks: TimelineTrack[] = [],
  durationMs = 1_000,
): SceneFrame {
  return evaluateSceneFrame(
    { duration_ms: durationMs, tracks, sprites, camera: CAMERA, bgm_volume: 1 },
    elapsedMs,
    harness.surface.geometry,
  );
}

let cueSerial = 0;
const cueBase = (): { cue_id: string; gate: "runtime" } => ({
  cue_id: String((cueSerial += 1)),
  gate: "runtime",
});

/** Builders for the visual cues, with the defaults the suites share. */
export const cues = {
  background(
    background: string | null,
    transition: BackgroundTransitionSpec = { type: "cross_fade" },
    durationMs = 200,
    easing: Easing = "linear",
  ): SceneVisualCue {
    return {
      ...cueBase(),
      type: "background_transition",
      background,
      transition,
      duration_ms: durationMs,
      easing,
    };
  },
  tween(
    spriteId: string,
    to: SpriteSnapshot | null,
    durationMs = 0,
    extra: { crossfade_ms?: number | null; easing?: Easing } = {},
  ): SceneVisualCue {
    return {
      ...cueBase(),
      type: "sprite_tween",
      sprite_id: spriteId,
      from: null,
      to,
      duration_ms: durationMs,
      easing: extra.easing ?? "linear",
      crossfade_ms: extra.crossfade_ms ?? null,
    };
  },
  effect(effect: ScreenEffectSpec, durationMs: number): SceneVisualCue {
    return {
      ...cueBase(),
      type: "screen_effect",
      effect,
      duration_ms: durationMs,
    };
  },
  curtain(
    action: "cover" | "reveal",
    fill: CurtainFill | null,
    transition: CurtainTransitionSpec = { type: "fade" },
    durationMs = 100,
  ): SceneVisualCue {
    return {
      ...cueBase(),
      type: "curtain_transition",
      action,
      fill,
      transition,
      duration_ms: durationMs,
      easing: "linear",
    };
  },
};

export const SHAKE: Extract<ScreenEffectSpec, { type: "shake" }> = {
  type: "shake",
  amplitude_x: 16,
  amplitude_y: 9.6,
  frequency_hz: 18,
  decay: 1,
  seed: 0,
};

export const FLASH: Extract<ScreenEffectSpec, { type: "flash" }> = {
  type: "flash",
  color: "#FFFFFF",
  peak_alpha: 0.88,
};
