/**
 * Pixels of a scene surface: the reference-counted texture stores, the text
 * block rasterizer and the resolution of logical asset ids to decoded frames.
 *
 * A `PreparedAsset` is decoded off-stage.  Whoever `claim`s it (a view, an
 * emitter, the curtain) takes over its texture references and must hand them
 * back through `releaseRefs`.
 */

import type { Texture } from "pixi.js";

import { errorMessage } from "./errorMessage";
import {
  imageAssetSourceVersion,
  resolveImageAsset,
  type AnimationMap,
  type ImageAssetSource,
} from "./imageAnimation";
import { DEFAULT_SPRITE_HEIGHT, DEFAULT_SPRITE_WIDTH } from "./sceneFrame";
import type { SceneKit } from "./sceneKit";
import { SceneTextureStore, type SceneTextureLike } from "./sceneTextures";
import {
  TextBlockRasterizer,
  textBlockVersion,
  type TextBlockMap,
  type TextBlockSource,
} from "./textBlock";
import type { AssetUrlMap } from "./types";
import { textBlockId } from "./visual";

/** Texture budget floor for a host that declares no animations at all. */
const MIN_SESSION_TEXTURES = 512;
/** Headroom for backgrounds, sprites, GUI art and buttons beside the frames. */
const TEXTURE_BUDGET_HEADROOM = 128;
const IMAGE_LOAD_TIMEOUT_MS = 8_000;
/** Key prefix of rasterized text block textures in `textStore`. */
const TEXT_TEXTURE_PREFIX = "text-texture:";

export interface PreparedAsset {
  asset: string;
  label: string;
  /** Full source revision: changes when frames, durations or geometry change
   * even though the logical asset id (and therefore the label) stays the same. */
  version: string;
  source: ImageAssetSource;
  urls: string[];
  textures: SceneTextureLike[];
  /**
   * True once a view took ownership of `urls`.  A preparation may be shared by
   * several views (two sprites showing the same asset), so only the first
   * ownership transfer is free; later ones retain the resident textures.
   */
  claimed?: boolean;
}

export interface SceneAssetsOptions {
  kit: SceneKit;
  diagnostic: (message: string) => void;
  animations: AnimationMap;
  textBlocks: TextBlockMap;
  /** Test seam for image decoding. */
  textureLoader?: ((url: string) => Promise<SceneTextureLike>) | undefined;
  textureBudget?: number | undefined;
}

export class SceneAssets {
  readonly store: SceneTextureStore;
  readonly textStore: SceneTextureStore;
  animations: AnimationMap;
  textBlocks: TextBlockMap;
  /** Url map of the last committed world; sizes sprites whose pixels are not resident. */
  urls: AssetUrlMap = {};
  readonly #kit: SceneKit;
  readonly #diagnostic: (message: string) => void;
  readonly #textSources = new Map<string, TextBlockSource>();
  #rasterizer: TextBlockRasterizer | null = null;

  constructor(options: SceneAssetsOptions) {
    this.#kit = options.kit;
    this.#diagnostic = options.diagnostic;
    this.animations = options.animations;
    this.textBlocks = options.textBlocks;
    this.store = new SceneTextureStore({
      load: options.textureLoader ?? ((url) => this.#loadTexture(url)),
      budget:
        options.textureBudget ??
        textureBudgetFor(MIN_SESSION_TEXTURES, this.animations),
    });
    this.textStore = new SceneTextureStore<SceneTextureLike>({
      budget: 64,
      load: async (key) => {
        const source = this.#textSources.get(key);
        if (source === undefined || this.#rasterizer === null)
          throw new Error("文本纹理生成器未初始化");
        return this.#rasterizer.create(source);
      },
      release: (texture) => this.#rasterizer?.release(texture as Texture),
    });
  }

  /** Distinct textures resident in both stores. */
  get textureCount(): number {
    return this.store.size + this.textStore.size;
  }

  attachRasterizer(
    htmlText: ConstructorParameters<typeof TextBlockRasterizer>[0],
  ): void {
    this.#rasterizer = new TextBlockRasterizer(htmlText);
  }

  setAnimations(animations: AnimationMap): void {
    this.animations = animations;
    this.store.setBudget(textureBudgetFor(MIN_SESSION_TEXTURES, animations));
  }

  /**
   * Decodes every frame of an asset, replacing a broken frame with the nearest
   * usable one so a single bad file can never block a story gate.  Only an
   * asset with no usable frame at all fails.
   */
  async prepare(
    asset: string,
    assets: AssetUrlMap,
  ): Promise<PreparedAsset | null> {
    const textId = textBlockId(asset);
    if (textId !== undefined) {
      const source = this.textBlocks[textId];
      if (source === undefined) throw new Error(`固定文本块不存在: ${textId}`);
      const version = textBlockVersion(source);
      const key = `${TEXT_TEXTURE_PREFIX}${version}`;
      this.#textSources.set(key, source);
      let texture: SceneTextureLike;
      try {
        texture = await this.textStore.acquire(key);
      } catch (error) {
        if (!this.textStore.has(key)) this.#textSources.delete(key);
        throw error;
      }
      return {
        asset,
        label: key,
        version,
        urls: [key],
        textures: [texture],
        source: {
          asset,
          url: key,
          width: source.definition.width,
          height: source.definition.height,
        },
      };
    }
    const source = resolveImageAsset(asset, assets, this.animations);
    if (source === undefined) {
      throw new Error(`素材尚未解析: ${asset}`);
    }
    const urls = animationUrls(source);
    // A ping-pong animation repeats frame urls by design.  Each distinct url is
    // decoded and referenced once, so the references the store holds equal the
    // references a view later releases; the displayed frame list still keeps
    // every occurrence in authored order.
    const distinct = [...new Set(urls)];
    const decoded = new Map<string, SceneTextureLike>();
    for (const url of distinct) {
      try {
        decoded.set(url, await this.store.acquire(url));
      } catch (error) {
        const frames = source.animation?.frames ?? [];
        for (const [index, candidate] of urls.entries()) {
          if (candidate !== url) continue;
          this.#diagnostic(
            `图片动画 ${source.animation?.id ?? source.asset} 第 ${index + 1} 帧（素材 ${frames[index]?.asset ?? asset}）加载失败：${errorMessage(error)}`,
          );
        }
      }
    }
    const loaded: (SceneTextureLike | null)[] = urls.map(
      (url) => decoded.get(url) ?? null,
    );
    const successful: number[] = [];
    for (const [index, texture] of loaded.entries()) {
      if (texture !== null) successful.push(index);
    }
    const first = successful[0];
    if (first === undefined) {
      throw new Error(
        `图片动画 ${source.animation?.id ?? source.asset} 没有可用帧`,
      );
    }
    for (let index = 0; index < loaded.length; index += 1) {
      if (loaded[index] !== null) continue;
      let nearest = first;
      for (const candidate of successful) {
        if (Math.abs(candidate - index) < Math.abs(nearest - index)) {
          nearest = candidate;
        }
      }
      loaded[index] = loaded[nearest] ?? null;
    }
    const textures: SceneTextureLike[] = [];
    for (const texture of loaded) {
      if (texture !== null) textures.push(texture);
    }
    return {
      asset,
      label: assetLabel(source),
      version: imageAssetSourceVersion(source),
      source,
      // Only urls whose pixels were actually acquired.  A failed frame is
      // rendered from its nearest usable neighbour through `textures`, but no
      // reference is held for it: releasing this preparation must never drop
      // the reference of a later, successful retry of the same url.
      urls: distinct.filter((url) => decoded.has(url)),
      textures,
    };
  }

  /** Acquires one asset's pixels for an immediate cue (not a world commit). */
  async acquire(asset: string, assets: AssetUrlMap): Promise<PreparedAsset> {
    const prepared = await this.prepare(asset, assets);
    if (prepared === null) throw new Error(`素材尚未解析: ${asset}`);
    return prepared;
  }

  releasePrepared(prepared: PreparedAsset): void {
    if (prepared.claimed ?? false) return;
    prepared.claimed = true;
    this.releaseRefs(prepared.urls);
  }

  /**
   * Transfers the preparation's texture references to one owner.
   *
   * The first owner reuses the references the preparation acquired; further
   * owners retain the already resident textures so every owner releases
   * exactly the references it holds.
   */
  claim(prepared: PreparedAsset): string[] {
    if (!(prepared.claimed ?? false)) {
      prepared.claimed = true;
      return prepared.urls;
    }
    return prepared.urls.filter((url) => this.#resourceStore(url).retain(url));
  }

  releaseRefs(refs: readonly string[]): void {
    for (const key of new Set(refs)) {
      const store = this.#resourceStore(key);
      store.release(key);
      if (store === this.textStore && !store.has(key))
        this.#textSources.delete(key);
    }
  }

  /** Identity of the pixels an asset resolves to, comparable with a view's `label`. */
  labelOf(asset: string, assets: AssetUrlMap): string {
    const textId = textBlockId(asset);
    const text = textId === undefined ? undefined : this.textBlocks[textId];
    if (text !== undefined)
      return `${TEXT_TEXTURE_PREFIX}${textBlockVersion(text)}`;
    const source = resolveImageAsset(asset, assets, this.animations);
    if (source !== undefined) return assetLabel(source);
    return assets[asset] ?? asset;
  }

  /**
   * True when a view already shows exactly what an asset resolves to.
   *
   * The whole source revision is compared, not only the logical label, so an
   * edited animation (new frames, durations or measured geometry) under the
   * same asset id replaces the view instead of silently keeping its old
   * pixels.  Assets that do not resolve keep the label identity, so a missing
   * asset never forces a rebuild of a view that already shows it.
   */
  showsRevision(
    view: { readonly version: string; readonly label: string },
    asset: string,
    assets: AssetUrlMap,
  ): boolean {
    const textId = textBlockId(asset);
    const text = textId === undefined ? undefined : this.textBlocks[textId];
    if (text !== undefined) return view.version === textBlockVersion(text);
    const source = resolveImageAsset(asset, assets, this.animations);
    if (source === undefined) {
      return view.label === (assets[asset] ?? asset);
    }
    return view.version === imageAssetSourceVersion(source);
  }

  spriteSize(asset: string): { width: number; height: number } {
    const textId = textBlockId(asset);
    const text = textId === undefined ? undefined : this.textBlocks[textId];
    if (text !== undefined)
      return { width: text.definition.width, height: text.definition.height };
    const source = resolveImageAsset(asset, this.urls, this.animations);
    if (source === undefined) {
      return { width: DEFAULT_SPRITE_WIDTH, height: DEFAULT_SPRITE_HEIGHT };
    }
    if (source.animation !== undefined) {
      // An animated asset keeps one layout size for the whole loop, so the
      // declared animation size is used instead of the current frame's.
      return { width: source.width, height: source.height };
    }
    const texture = this.store.texture(source.url);
    if (texture !== undefined) {
      return { width: texture.width, height: texture.height };
    }
    return { width: DEFAULT_SPRITE_WIDTH, height: DEFAULT_SPRITE_HEIGHT };
  }

  destroy(): void {
    this.store.destroy();
    this.textStore.destroy();
    this.#rasterizer?.destroy();
    this.#textSources.clear();
  }

  #resourceStore(key: string): SceneTextureStore {
    return key.startsWith(TEXT_TEXTURE_PREFIX) ? this.textStore : this.store;
  }

  #loadTexture(url: string): Promise<SceneTextureLike> {
    return new Promise<SceneTextureLike>((resolve, reject) => {
      let settled = false;
      const image = new Image();
      const cleanup = (): void => {
        image.onload = null;
        image.onerror = null;
        window.clearTimeout(timer);
      };
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        // Abandon the in-flight decode.  A late `onload` must not create a
        // texture no store entry references, so the handler is removed and the
        // source dropped before the caller is told the load timed out.
        image.src = "";
        reject(new Error(`图像加载超时: ${url}`));
      }, IMAGE_LOAD_TIMEOUT_MS);
      image.crossOrigin = "anonymous";
      image.decoding = "async";
      image.onload = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(this.#kit.textureFromImage(image));
      };
      image.onerror = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`图像解码失败: ${url}`));
      };
      image.src = url;
    });
  }
}

function textureBudgetFor(minimum: number, animations: AnimationMap): number {
  const urls = new Set<string>();
  for (const animation of Object.values(animations)) {
    for (const frame of animation.frames) urls.add(frame.url);
  }
  return Math.max(minimum, urls.size + TEXTURE_BUDGET_HEADROOM);
}

function animationUrls(source: ImageAssetSource): string[] {
  const animation = source.animation;
  if (animation === undefined) return [source.url];
  return animation.frames.map((frame) => frame.url);
}

/**
 * Identity of the pixels a view currently shows.
 *
 * Static assets use their url.  Animated assets use their logical id, so
 * switching between an animation and one of its frame images (which can share
 * a url) is still recognised as a real change.
 */
function assetLabel(source: ImageAssetSource): string {
  return source.animation === undefined ? source.url : `anim:${source.asset}`;
}
