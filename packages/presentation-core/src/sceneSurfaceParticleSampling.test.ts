// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Application, Particle, ParticleContainer, Sprite, Texture } from "pixi.js";
import { SceneSurface, pixiSceneKit, type SceneKit } from "./sceneSurface";
import { createFramePump, createMemoryKit, MemorySprite } from "./sceneTestKit";
import { spritePreset } from "./visual";
import { EMITTER_FIXTURE, PARTICLE_FIXTURE } from "./visualTestKit";

const CAMERA = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
const ASSETS = { dot: "/dot.png" };
const BOUNDS = { x: -50, y: -50, width: 100, height: 100 };

/** A decoded-looking bitmap: real HTMLImageElement with a native 16x16 size. */
function bitmap(size = 16): HTMLImageElement {
  const image = document.createElement("img");
  image.width = size;
  image.height = size;
  return image;
}

afterEach(() => vi.unstubAllGlobals());

describe("pixiSceneKit particle texture", () => {
  it("samples particles nearest from their own source while the shared texture stays linear", () => {
    const image = bitmap();
    const shared = Texture.from(image);
    const kit = pixiSceneKit();
    const copy = kit.particleTexture(shared) as Texture;
    try {
      // The shared texture is what Sprites draw: Pixi's default filtering is linear.
      expect(shared.source.style.scaleMode).toBe("linear");
      expect(copy.source.style).toMatchObject({ magFilter: "nearest", minFilter: "nearest", mipmapFilter: "nearest" });
      // Same decoded bitmap, native size, no resampling or mipmap generation.
      expect(copy.source.resource).toBe(image);
      expect([copy.width, copy.height]).toEqual([16, 16]);
      expect([copy.source.pixelWidth, copy.source.pixelHeight]).toEqual([16, 16]);
      expect(copy.source.resolution).toBe(shared.source.resolution);
      expect(copy.source.autoGenerateMipmaps).toBe(false);
      expect(copy.source).not.toBe(shared.source);
      expect(new Sprite(shared).texture.source.style.scaleMode).toBe("linear");
    } finally {
      copy.destroy();
      shared.destroy(true);
    }
  });

  it("refuses a texture that is not a decoded bitmap instead of falling back to linear", () => {
    // Texture.WHITE is backed by a raw pixel buffer, not a decoded bitmap.
    expect(() => pixiSceneKit().particleTexture(Texture.WHITE)).toThrow("位图");
  });

  it("draws the batch from the copy and leaves the shared texture alive when either is released", () => {
    const shared = Texture.from(bitmap());
    const kit = pixiSceneKit();
    const copy = kit.particleTexture(shared) as Texture;
    const batch = kit.particles(copy, 3, "normal", BOUNDS);
    const container = batch.node as unknown as ParticleContainer;
    expect(container.texture).toBe(copy);
    batch.update(new Float32Array(15), 3);
    expect(container.particleChildren).toHaveLength(3);
    expect((container.particleChildren[0] as Particle).texture).toBe(copy);
    batch.destroy();
    // The batch never owns the shared copy: only its release destroys the source.
    expect(copy.destroyed).toBe(false);
    expect(copy.source.destroyed).toBe(false);
    const source = copy.source;
    copy.destroy();
    expect(copy.destroyed).toBe(true);
    expect(source.destroyed).toBe(true);
    expect(shared.destroyed).toBe(false);
    expect(shared.source.destroyed).toBe(false);
    expect(shared.source.resource).toBeInstanceOf(HTMLImageElement);
    shared.destroy(true);
  });

  it("detaches the shared particle shader from a copy that is about to be destroyed", () => {
    const shared = Texture.from(bitmap());
    const kit = pixiSceneKit();
    const resources: Record<string, unknown> = {};
    const renderer = { renderPipes: { particle: { defaultShader: { resources } } } };
    // The kit reads the renderer of the application it created, which needs a GPU to init.
    Object.defineProperty(Application.prototype, "renderer", { configurable: true, get: () => renderer });
    try {
      kit.application();
      const bound = kit.particleTexture(shared) as Texture;
      resources.uTexture = bound.source;
      bound.destroy();
      expect(resources.uTexture).toBe(Texture.WHITE.source);
      // A source some other copy still uses must not be unbound.
      const other = kit.particleTexture(shared) as Texture;
      const live = kit.particleTexture(shared) as Texture;
      resources.uTexture = live.source;
      other.destroy();
      expect(resources.uTexture).toBe(live.source);
      live.destroy();
      expect(resources.uTexture).toBe(Texture.WHITE.source);
    } finally {
      delete (Application.prototype as { renderer?: unknown }).renderer;
      shared.destroy(true);
    }
  });
});

describe("SceneSurface particle sampling over the real decode path", () => {
  function realTextureKit(): { kit: SceneKit; memory: ReturnType<typeof createMemoryKit>; images: HTMLImageElement[] } {
    const images: HTMLImageElement[] = [];
    // The surface decodes through `new Image()`; hand it real elements that "load" at once.
    vi.stubGlobal("Image", function Image() {
      const image = bitmap();
      Object.defineProperty(image, "src", { configurable: true, set() { queueMicrotask(() => image.onload?.(new Event("load"))); } });
      images.push(image);
      return image;
    });
    const memory = createMemoryKit();
    const real = pixiSceneKit();
    // Scene graph in memory, textures and particle copies through the real Pixi classes.
    const kit: SceneKit = { ...memory.kit, textureFromImage: real.textureFromImage, particleTexture: real.particleTexture };
    return { kit, memory, images };
  }

  it("keeps the PNG at its native size and gives only the particle batch a nearest copy", async () => {
    const { kit, memory, images } = realTextureKit();
    const pump = createFramePump();
    const surface = new SceneSurface({ canvas: document.createElement("canvas"), kit, requestFrame: pump.request,
      cancelFrame: pump.cancel, particles: { snow: { ...PARTICLE_FIXTURE, image: "dot" } } });
    await surface.init();
    const sprite = spritePreset("item", { type: "image", asset: "dot" });
    surface.applyWorld(await surface.prepare({
      world: { sprites: { dot: sprite }, camera: CAMERA, emitters: { snow: EMITTER_FIXTURE } }, assets: ASSETS }));
    expect(images).toHaveLength(1);
    const view = memory.applications[0]?.stage.children[0]?.children.find((node) => node instanceof MemorySprite) as MemorySprite;
    const shared = view.texture as Texture;
    const copy = memory.particleBatches[0]?.texture as Texture;
    expect([shared.width, shared.height]).toEqual([16, 16]);
    expect([copy.width, copy.height]).toEqual([16, 16]);
    expect(shared.source.resolution).toBe(1);
    expect(shared.source.style.scaleMode).toBe("linear");
    expect(copy.source.style.scaleMode).toBe("nearest");
    expect(copy.source.resource).toBe(shared.source.resource);
    expect(copy.source).not.toBe(shared.source);
    // Dropping the emitter releases the copy and leaves the Sprite's texture as it was.
    surface.applyWorld(await surface.prepare({ world: { sprites: { dot: sprite }, camera: CAMERA }, assets: ASSETS }));
    expect(copy.destroyed).toBe(true);
    expect(shared.destroyed).toBe(false);
    expect(shared.source.destroyed).toBe(false);
    expect(shared.source.style.scaleMode).toBe("linear");
    expect(surface.particleTextures).toEqual({ resident: 0, refs: 0 });
    surface.dispose();
    expect(shared.destroyed).toBe(true);
  });
});
