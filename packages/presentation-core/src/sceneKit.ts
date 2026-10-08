/**
 * Renderer ports of the shared scene surface.
 *
 * The surface talks to Pixi through this small structural port so the same
 * object, texture and scheduling logic can be exercised in unit tests with the
 * in-memory kit (`sceneTestKit.ts`).  `pixiSceneKit()` is the only place that
 * knows about Pixi.
 */

import "pixi.js/unsafe-eval";

import {
  Application,
  Container,
  Graphics,
  ImageSource,
  Rectangle,
  Particle,
  ParticleContainer,
  Sprite,
  Texture,
  VideoSource,
  type TextureSource,
} from "pixi.js";

import { PARTICLE_STRIDE } from "./particles";
import {
  createPixiShaderHost,
  type SceneRect,
  type SceneShaderHostLike,
} from "./sceneShaders";
import type { SceneTextureLike } from "./sceneTextures";
import type { TextBlockRasterizer } from "./textBlock";

export interface ScenePointLike {
  x: number;
  y: number;
  set(x: number, y?: number): void;
}

export interface SceneDestroyOptions {
  children?: boolean;
  texture?: boolean;
  textureSource?: boolean;
  context?: boolean;
}

export interface SceneNodeLike {
  label: string;
  visible: boolean;
  zIndex: number;
  alpha: number;
  rotation: number;
  x: number;
  y: number;
  width: number;
  height: number;
  sortableChildren: boolean;
  /** Render mask; every host object supports it, the memory kit mirrors Pixi. */
  mask: SceneNodeLike | null;
  position: ScenePointLike;
  pivot: ScenePointLike;
  scale: ScenePointLike;
  addChild(child: SceneNodeLike): SceneNodeLike;
  removeChild(child: SceneNodeLike): void;
  removeChildren(): SceneNodeLike[];
  readonly children: readonly SceneNodeLike[];
  destroy(options?: boolean | SceneDestroyOptions): void;
}

export interface SceneSpriteLike extends SceneNodeLike {
  anchor: ScenePointLike;
  texture: SceneTextureLike;
}

export interface SceneGraphicsLike extends SceneNodeLike {
  rect(x: number, y: number, width: number, height: number): SceneGraphicsLike;
  fill(color: number): SceneGraphicsLike;
  /** Drops every accumulated shape so a mask can be rebuilt per frame. */
  clear(): SceneGraphicsLike;
}

export interface SceneVideoSourceLike {
  autoUpdate: boolean;
  load(): Promise<unknown>;
  update(): void;
  destroy(): void;
}

export interface SceneApplicationLike {
  init(options: SceneApplicationInit): Promise<void>;
  readonly stage: SceneNodeLike;
  readonly renderer: {
    readonly htmlText?: ConstructorParameters<typeof TextBlockRasterizer>[0];
    readonly extract: {
      canvas(
        target:
          | SceneNodeLike
          | { readonly target: SceneNodeLike; readonly frame?: unknown },
      ): unknown;
    };
  };
  render(): void;
  destroy(
    rendererOptions?: { removeView?: boolean },
    destroyOptions?: SceneDestroyOptions,
  ): void;
}

export interface SceneApplicationInit {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  resolution: number;
  autoDensity: boolean;
  antialias: boolean;
  backgroundColor: number;
  preference: string;
  powerPreference: string;
  preserveDrawingBuffer: boolean;
  autoStart: boolean;
}

export interface SceneParticleBatchLike {
  readonly node: SceneNodeLike;
  update(data: Float32Array, count: number): void;
  destroy(): void;
}

export interface SceneKit {
  application(): SceneApplicationLike;
  /**
   * Nearest-sampling copy of an already decoded texture, for particles only.
   *
   * It owns an isolated sampler (and GPU upload) over the same decoded pixels
   * at the same dimensions, so the shared texture that Sprites draw keeps its
   * own filtering.  Destroying it never destroys `base`.
   */
  particleTexture(base: SceneTextureLike): SceneTextureLike;
  particles(
    texture: SceneTextureLike,
    capacity: number,
    blend: "normal" | "add",
    bounds: SceneRect,
  ): SceneParticleBatchLike;
  container(): SceneNodeLike;
  sprite(texture: SceneTextureLike): SceneSpriteLike;
  graphics(): SceneGraphicsLike;
  textureFromImage(image: HTMLImageElement): SceneTextureLike;
  videoSource(element: HTMLVideoElement): SceneVideoSourceLike;
  videoSprite(source: SceneVideoSourceLike): SceneSpriteLike;
  /** Post-processing host for the shader screen effects of one container. */
  shaderHost(target: SceneNodeLike): SceneShaderHostLike;
}

/**
 * Nearest-sampling texture over its own `ImageSource`.
 *
 * The source is exclusively owned, so destroying the texture always destroys
 * it (after `unbind` ran) and never touches the shared texture it was copied
 * from.
 */
class ParticleTexture extends Texture {
  readonly #unbind: (source: TextureSource) => void;

  constructor(source: ImageSource, unbind: (source: TextureSource) => void) {
    super({ source, label: "particle-nearest" });
    this.#unbind = unbind;
  }

  override destroy(): void {
    this.#unbind(this.source);
    super.destroy(true);
  }
}

/** Default kit backed by the real Pixi renderer. */
export function pixiSceneKit(): SceneKit {
  let owner: Application | undefined;
  // Pixi's shared particle shader keeps the last drawn source bound; restore
  // its default before that source goes away so nothing destroyed stays bound.
  const unbindParticleSource = (source: TextureSource): void => {
    const pipes = owner?.renderer as unknown as
      | {
          renderPipes?: {
            particle?: {
              defaultShader?: { resources?: Record<string, unknown> };
            };
          };
        }
      | undefined;
    const resources = pipes?.renderPipes?.particle?.defaultShader?.resources;
    if (resources !== undefined && resources.uTexture === source)
      resources.uTexture = Texture.WHITE.source;
  };
  return {
    application: () => {
      const application = new Application();
      owner = application;
      return {
        get stage(): SceneNodeLike {
          return application.stage as unknown as SceneNodeLike;
        },
        get renderer(): SceneApplicationLike["renderer"] {
          return application.renderer as unknown as SceneApplicationLike["renderer"];
        },
        init: (options) =>
          application.init({
            canvas: options.canvas,
            width: options.width,
            height: options.height,
            resolution: options.resolution,
            autoDensity: options.autoDensity,
            antialias: options.antialias,
            backgroundColor: options.backgroundColor,
            preference: options.preference as "webgl",
            powerPreference: options.powerPreference as "high-performance",
            preserveDrawingBuffer: options.preserveDrawingBuffer,
            autoStart: options.autoStart,
          }),
        render: () => application.render(),
        destroy: (rendererOptions, destroyOptions) =>
          application.destroy(rendererOptions ?? {}, destroyOptions ?? {}),
      } satisfies SceneApplicationLike;
    },
    particleTexture: (base) => {
      const shared = (base as Texture).source;
      const resource: unknown = shared.resource;
      if (!ImageSource.test(resource))
        throw new Error("粒子纹理需要已解码的位图");
      // Same decoded bitmap, own sampler: the style lives on the source, so a
      // second source is the only way to sample particles differently without
      // changing how Sprites draw the cached shared texture.
      const texture = new ParticleTexture(
        new ImageSource({
          resource,
          resolution: shared.resolution,
          alphaMode: shared.alphaMode,
          scaleMode: "nearest",
          label: "particle-nearest",
        }),
        unbindParticleSource,
      );
      if (texture.width !== base.width || texture.height !== base.height) {
        texture.destroy();
        throw new Error("粒子纹理尺寸与原图不一致");
      }
      return texture;
    },
    particles: (texture, capacity, blend, bounds) => {
      const container = new ParticleContainer({
        texture: texture as Texture,
        blendMode: blend,
        dynamicProperties: {
          position: true,
          rotation: true,
          vertex: true,
          color: true,
          uvs: false,
        },
        boundsArea: new Rectangle(
          bounds.x,
          bounds.y,
          bounds.width,
          bounds.height,
        ),
      });
      const pool = Array.from(
        { length: capacity },
        () =>
          new Particle({
            texture: texture as Texture,
            anchorX: 0.5,
            anchorY: 0.5,
          }),
      );
      return {
        node: container as unknown as SceneNodeLike,
        update: (data, count) => {
          const previousCount = container.particleChildren.length;
          container.particleChildren.length = count;
          for (let index = 0; index < count; index += 1) {
            const particle = pool[index]!;
            const offset = index * PARTICLE_STRIDE;
            particle.x = data[offset]!;
            particle.y = data[offset + 1]!;
            particle.scaleX = particle.scaleY = data[offset + 2]!;
            particle.rotation = data[offset + 3]!;
            particle.alpha = data[offset + 4]!;
            container.particleChildren[index] = particle;
          }
          if (previousCount !== count) container.update();
        },
        // The texture is shared by every emitter of the image and released by
        // the surface, so the batch never owns it.
        destroy: () =>
          container.destroy({ texture: false, textureSource: false }),
      };
    },
    container: () => new Container() as unknown as SceneNodeLike,
    sprite: (texture) =>
      new Sprite(texture as unknown as Texture) as unknown as SceneSpriteLike,
    graphics: () => new Graphics() as unknown as SceneGraphicsLike,
    textureFromImage: (image) => Texture.from(image) as SceneTextureLike,
    videoSource: (element) =>
      new VideoSource({
        resource: element,
        autoLoad: false,
        autoPlay: false,
        updateFPS: 0,
      }) as unknown as SceneVideoSourceLike,
    videoSprite: (source) =>
      new Sprite(
        new Texture({ source: source as unknown as VideoSource }),
      ) as unknown as SceneSpriteLike,
    shaderHost: (target) =>
      createPixiShaderHost(target as unknown as Container),
  };
}
