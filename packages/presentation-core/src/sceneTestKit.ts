/**
 * In-memory render kit for `SceneSurface` tests.
 *
 * The surface talks to Pixi through structural ports, so this kit implements
 * the same ports without WebGL: objects record their transform, textures record
 * their lifetime and the application counts renders.  It lets the shared
 * object/texture/scheduler logic be tested in jsdom, while the real renderer
 * stays covered by the browser parity entry.
 */

import type {
  SceneApplicationInit,
  SceneApplicationLike,
  SceneFrameCancel,
  SceneFrameRequest,
  SceneGraphicsLike,
  SceneKit,
  SceneNodeLike,
  ScenePointLike,
  SceneSpriteLike,
  SceneVideoSourceLike,
} from "./sceneSurface";
import type { SceneTextureLike } from "./sceneTextures";

export class MemoryPoint implements ScenePointLike {
  x = 0;
  y = 0;

  set(x: number, y: number = this.y): void {
    this.x = x;
    this.y = y;
  }
}

export class MemoryNode implements SceneNodeLike {
  label = "";
  visible = true;
  zIndex = 0;
  alpha = 1;
  rotation = 0;
  width = 0;
  height = 0;
  sortableChildren = false;
  mask: SceneNodeLike | null = null;
  readonly position = new MemoryPoint();
  readonly pivot = new MemoryPoint();
  readonly scale = new MemoryPoint();
  parent: MemoryNode | null = null;
  children: MemoryNode[] = [];
  destroyed = false;
  destroyCount = 0;

  constructor() {
    this.scale.set(1, 1);
  }

  // Pixi exposes `x`/`y` as views onto `position`; mirror that so a transform
  // written through one accessor is visible through the other.
  get x(): number {
    return this.position.x;
  }

  set x(value: number) {
    this.position.x = value;
  }

  get y(): number {
    return this.position.y;
  }

  set y(value: number) {
    this.position.y = value;
  }

  addChild(child: SceneNodeLike): SceneNodeLike {
    const node = child as MemoryNode;
    node.parent?.removeChild(node);
    this.children.push(node);
    node.parent = this;
    return child;
  }

  removeChild(child: SceneNodeLike): void {
    const node = child as MemoryNode;
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    if (node.parent === this) node.parent = null;
  }

  removeChildren(): SceneNodeLike[] {
    const removed = [...this.children];
    this.children.length = 0;
    for (const child of removed) child.parent = null;
    return removed;
  }

  destroy(): void {
    this.destroyed = true;
    this.destroyCount += 1;
    this.removeChildren();
    this.parent?.removeChild(this);
  }
}

export interface MemoryTexture extends SceneTextureLike {
  readonly url: string;
  destroyed: boolean;
  width: number;
  height: number;
}

export class MemorySprite extends MemoryNode implements SceneSpriteLike {
  anchor = new MemoryPoint();
  /** Every texture this sprite displayed, in order. */
  readonly textures: SceneTextureLike[] = [];
  #texture: SceneTextureLike;

  constructor(texture: SceneTextureLike) {
    super();
    this.#texture = texture;
    this.textures.push(texture);
  }

  get texture(): SceneTextureLike {
    return this.#texture;
  }

  set texture(texture: SceneTextureLike) {
    // Only a real change is recorded, so the history reads as the frames the
    // instance actually displayed.
    if (this.#texture === texture) return;
    this.#texture = texture;
    this.textures.push(texture);
  }
}

export class MemoryGraphics extends MemoryNode implements SceneGraphicsLike {
  fills: number[] = [];
  rects: number[][] = [];

  rect(x: number, y: number, width: number, height: number): SceneGraphicsLike {
    this.rects.push([x, y, width, height]);
    return this;
  }

  fill(color: number): SceneGraphicsLike {
    this.fills.push(color);
    return this;
  }

  clear(): SceneGraphicsLike {
    this.fills = [];
    this.rects = [];
    return this;
  }
}

export class MemoryApplication implements SceneApplicationLike {
  readonly stage = new MemoryNode();
  renders = 0;
  destroyed = false;
  readonly renderer = {
    extract: { canvas: () => ({ width: 1920, height: 1080 }) },
  };

  init(_options: SceneApplicationInit): Promise<void> {
    void _options;
    return Promise.resolve();
  }

  render(): void {
    this.renders += 1;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

export interface MemoryKit {
  kit: SceneKit;
  readonly applications: MemoryApplication[];
  renderCount(): number;
}

export function createMemoryTextureLoader(
  sizes: Readonly<Record<string, { width: number; height: number }>> = {},
  failures: ReadonlySet<string> = new Set<string>(),
): {
  load: (url: string) => Promise<SceneTextureLike>;
  loaded: MemoryTexture[];
  destroyed: MemoryTexture[];
} {
  const loaded: MemoryTexture[] = [];
  const destroyed: MemoryTexture[] = [];
  return {
    loaded,
    destroyed,
    load: (url) => {
      if (failures.has(url)) {
        return Promise.reject(new Error(`测试失败: ${url}`));
      }
      const size = sizes[url] ?? { width: 64, height: 64 };
      const texture: MemoryTexture = {
        url,
        width: size.width,
        height: size.height,
        destroyed: false,
        destroy: () => {
          if (texture.destroyed) return;
          texture.destroyed = true;
          destroyed.push(texture);
        },
      };
      loaded.push(texture);
      return Promise.resolve(texture);
    },
  };
}

export function createMemoryKit(): MemoryKit {
  const applications: MemoryApplication[] = [];
  const kit: SceneKit = {
    application: () => {
      const application = new MemoryApplication();
      applications.push(application);
      return application;
    },
    container: () => new MemoryNode(),
    sprite: (texture) => new MemorySprite(texture),
    graphics: () => new MemoryGraphics(),
    textureFromImage: (image) => ({
      width: image.width,
      height: image.height,
      destroy: () => undefined,
    }),
    videoSource: (): SceneVideoSourceLike => ({
      autoUpdate: true,
      load: () => Promise.resolve(),
      update: () => undefined,
      destroy: () => undefined,
    }),
    videoSprite: () =>
      new MemorySprite({ width: 1920, height: 1080, destroy: () => undefined }),
  };
  return {
    kit,
    applications,
    renderCount: () =>
      applications.reduce(
        (total, application) => total + application.renders,
        0,
      ),
  };
}

/** Deterministic frame pump used for scheduling and cue animations. */
export interface FramePump {
  request: SceneFrameRequest;
  cancel: SceneFrameCancel;
  step(deltaMs?: number): void;
  pending(): number;
  now(): number;
}

export function createFramePump(): FramePump {
  let handle = 0;
  let nowMs = 0;
  const callbacks = new Map<number, (nowMs: number) => void>();
  return {
    request: (callback) => {
      handle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel: (finished) => {
      callbacks.delete(finished);
    },
    step: (deltaMs = 16) => {
      nowMs += deltaMs;
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(nowMs);
    },
    pending: () => callbacks.size,
    now: () => nowMs,
  };
}
