import type { SpriteSnapshot } from "./types";

export type SpriteKind = "background" | "character" | "item" | "ui" | "text";
export type CoordinateSpace = "world" | "screen";
export type ImageFit = "contain" | "cover" | "stretch";
export type SpriteSource =
  | { type: "image"; asset: string }
  | { type: "text"; text_block: string };
export interface SpriteLayout { width: number; height: number; fit: ImageFit }
export const LEGACY_BACKGROUND_ID = "__background__";
const TEXT_PREFIX = "text-block:";

/** Resource identity, never a filesystem path or an author-facing image asset. */
export function spriteResourceId(sprite: { source?: SpriteSource; asset?: string }): string {
  if (sprite.source?.type === "text") return `${TEXT_PREFIX}${sprite.source.text_block}`;
  const asset = sprite.source?.asset ?? sprite.asset;
  if (asset === undefined) throw new Error("Sprite 缺少来源");
  return asset;
}

export function textBlockId(resource: string): string | undefined {
  return resource.startsWith(TEXT_PREFIX) ? resource.slice(TEXT_PREFIX.length) : undefined;
}

export function spritePreset(kind: SpriteKind, source: SpriteSource): SpriteSnapshot {
  return {
    source, sprite_kind: kind, space: kind === "ui" ? "screen" : "world",
    x: 960, y: kind === "character" ? 1080 : 540,
    scale: 1, scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1,
    z: kind === "background" ? -10000 : 0,
    anchor_x: 0.5, anchor_y: kind === "character" ? 1 : 0.5,
    ...(kind === "background" ? { layout: { width: 1920, height: 1080, fit: "cover" } as const } : {}),
  };
}

export interface SpriteTrackSource {
  asset?: string | null;
  source?: SpriteSource;
  sprite_kind?: SpriteKind;
  space?: CoordinateSpace;
  layout?: SpriteLayout;
}

/** Creation defaults only apply when a track introduces a new instance. */
export function spriteTrackState(base: SpriteSnapshot | undefined, track: SpriteTrackSource): SpriteSnapshot {
  if (track.source !== undefined && track.asset != null) throw new Error("Sprite 轨道来源冲突");
  const source = track.source ?? (track.asset == null ? base?.source ?? (base?.asset === undefined ? undefined : { type: "image" as const, asset: base.asset }) : { type: "image" as const, asset: track.asset });
  if (source === undefined) throw new Error("Sprite 轨道没有可继承的来源");
  const kind = track.sprite_kind ?? (source.type === "text" ? "text" : "character");
  const { asset: _legacy, ...state } = base ?? spritePreset(kind, source);
  return {
    ...state, source,
    ...(track.sprite_kind === undefined ? {} : { sprite_kind: track.sprite_kind }),
    ...(track.space === undefined ? {} : { space: track.space }),
    ...(track.layout === undefined ? {} : { layout: track.layout }),
  };
}

/** Compatibility decoding lives here; committed scenes have only Sprite instances. */
export function normalizeVisualWorld<T extends {
  background?: string | null; sprites: Record<string, SpriteSnapshot>;
}>(world: T): Omit<T, "background"> {
  const { background, ...rest } = world;
  const sprites: Record<string, SpriteSnapshot> = Object.fromEntries(Object.entries(world.sprites).map(([id, sprite]) => {
    const { asset, ...state } = sprite;
    const source = sprite.source ?? { type: "image" as const, asset: spriteResourceId(sprite) };
    if (asset !== undefined && sprite.source !== undefined && (source.type !== "image" || source.asset !== asset)) {
      throw new Error(`Sprite ${id} 来源冲突`);
    }
    const kind = sprite.sprite_kind ?? "character";
    const normalized = { ...spritePreset(kind, source), ...state, source };
    validateSprite(normalized);
    return [id, normalized];
  }));
  if (background != null) {
    if (sprites[LEGACY_BACKGROUND_ID] !== undefined) throw new Error("旧 background 与 Sprite __background__ 冲突");
    sprites[LEGACY_BACKGROUND_ID] = spritePreset("background", { type: "image", asset: background });
  }
  return { ...rest, sprites };
}

export function validateSprite(sprite: SpriteSnapshot): void {
  if (![sprite.x, sprite.y, sprite.scale, sprite.scale_x, sprite.scale_y, sprite.rotation_deg, sprite.opacity, sprite.z].every(Number.isFinite)
    || sprite.scale <= 0 || sprite.scale_x === 0 || sprite.scale_y === 0
    || sprite.opacity < 0 || sprite.opacity > 1
    || (sprite.space !== undefined && !["world", "screen"].includes(sprite.space))
    || (sprite.sprite_kind !== undefined && !["background", "character", "item", "ui", "text"].includes(sprite.sprite_kind))
    || [sprite.anchor_x, sprite.anchor_y].some((value) => value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1))) {
    throw new Error("Sprite 变换无效");
  }
  if (spriteResourceId(sprite).length === 0) throw new Error("Sprite 来源为空");
  if (sprite.layout != null) spriteFit(1, 1, sprite.layout);
}

/** Shared by Pixi geometry, hit testing and DOM image skins. */
export function spriteFit(width: number, height: number, layout?: SpriteLayout | null): { x: number; y: number } {
  if (layout == null) return { x: 1, y: 1 };
  if (![width, height, layout.width, layout.height].every((value) => Number.isFinite(value) && value > 0)
    || layout.width > 16384 || layout.height > 16384 || !["contain", "cover", "stretch"].includes(layout.fit)) {
    throw new Error("Sprite 布局框无效");
  }
  const x = layout.width / width, y = layout.height / height;
  if (layout.fit === "stretch") return { x, y };
  const scale = layout.fit === "cover" ? Math.max(x, y) : Math.min(x, y);
  return { x: scale, y: scale };
}
