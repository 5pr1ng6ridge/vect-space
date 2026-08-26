import "pixi.js/unsafe-eval";

import { Application, Container, Graphics, Sprite, Texture } from "pixi.js";

import { AudioManager } from "./audio";
import type {
  AssetUrlMap,
  CameraSnapshot,
  Easing,
  PresentationCue,
  RuntimeSnapshot,
  RuntimeUpdate,
  Settings,
  SpriteSnapshot,
} from "./types";
import { advanceVirtualElapsed } from "./virtualClock";

const WIDTH = 1920;
const HEIGHT = 1080;
const oneShotLedger = new Set<string>();
const texturePromises = new Map<string, Promise<Texture>>();

export class PresentationController {
  readonly #application = new Application();
  readonly #world = new Container();
  readonly #backgrounds = new Container();
  readonly #sprites = new Container();
  readonly #effects = new Container();
  readonly #spriteViews = new Map<string, Sprite>();
  readonly #audio: AudioManager;
  readonly #canvas: HTMLCanvasElement;
  readonly #diagnostic: (message: string) => void;
  #background: Sprite | null = null;
  #camera: CameraSnapshot = { x: 0, y: 0, zoom: 1 };
  #generation = 0;
  #abort = new AbortController();
  #currentUpdateId: number | null = null;
  #currentPromise: Promise<void> | null = null;
  #playbackRate = 1;
  #suppressOneShots = false;

  constructor(
    canvas: HTMLCanvasElement,
    settings: Settings,
    diagnostic: (message: string) => void,
  ) {
    this.#canvas = canvas;
    this.#audio = new AudioManager(settings);
    this.#diagnostic = diagnostic;
  }

  async init(): Promise<void> {
    await this.#application.init({
      canvas: this.#canvas,
      width: WIDTH,
      height: HEIGHT,
      resolution: 1,
      autoDensity: false,
      antialias: true,
      backgroundColor: 0x05070c,
      preference: "webgl",
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
    this.#sprites.sortableChildren = true;
    this.#world.addChild(this.#backgrounds, this.#sprites);
    this.#application.stage.addChild(this.#world, this.#effects);
    this.#applyCamera();
    this.#application.render();
  }

  unlockAudio(): Promise<void> {
    return this.#audio.unlock();
  }

  applySettings(settings: Settings): void {
    this.#audio.applySettings(settings);
  }

  setTypingSfx(active: boolean, assets: AssetUrlMap): Promise<void> {
    return this.#audio.setTypingSfx(active, assets);
  }

  setPlaybackMode(rate: number, suppressOneShots: boolean): void {
    this.#playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    this.#suppressOneShots = suppressOneShots;
    this.#audio.setPlaybackRate(this.#playbackRate);
  }

  present(update: RuntimeUpdate, assets: AssetUrlMap): Promise<void> {
    if (
      this.#currentUpdateId === update.update_id &&
      this.#currentPromise !== null
    ) {
      return this.#currentPromise;
    }
    this.#abort.abort();
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    const generation = ++this.#generation;
    this.#currentUpdateId = update.update_id;
    const operation = (async () => {
      if (update.cues.length === 0) {
        await this.#reconcile(update.snapshot, assets, signal);
        return;
      }
      const results = await Promise.allSettled(
        update.cues.map((cue) =>
          withTimeout(
            this.#executeCue(update.update_id, cue, assets, signal),
            15_000,
            `Cue ${update.update_id}:${cue.cue_id} 超时`,
          ),
        ),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          console.error(
            "Presentation cue failed; reconciling to snapshot",
            result.reason,
          );
          this.#diagnostic(`表现 Cue 失败：${errorMessage(result.reason)}`);
        }
      }
      if (generation === this.#generation && !signal.aborted) {
        await this.#reconcile(update.snapshot, assets, signal);
      }
    })();
    this.#currentPromise = withTimeout(
      operation,
      30_000,
      `RuntimeUpdate ${update.update_id} 表现同步超时`,
    );
    return this.#currentPromise;
  }

  async applySnapshotImmediately(
    snapshot: RuntimeSnapshot,
    assets: AssetUrlMap,
  ): Promise<void> {
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#generation += 1;
    this.#currentUpdateId = null;
    this.#currentPromise = null;
    await this.#reconcile(snapshot, assets, this.#abort.signal);
  }

  captureThumbnail(): string | null {
    try {
      const thumbnail = document.createElement("canvas");
      thumbnail.width = 320;
      thumbnail.height = 180;
      const context = thumbnail.getContext("2d");
      if (context === null) {
        return null;
      }
      context.drawImage(this.#canvas, 0, 0, 320, 180);
      return thumbnail.toDataURL("image/png", 0.86);
    } catch (error) {
      console.error("Could not capture save thumbnail", error);
      return null;
    }
  }

  destroy(): void {
    this.#abort.abort();
    this.#audio.destroy();
    this.#application.destroy({ removeView: false }, { children: true });
  }

  async #executeCue(
    updateId: number,
    cue: PresentationCue,
    assets: AssetUrlMap,
    signal: AbortSignal,
  ): Promise<void> {
    const key = `${updateId}:${cue.cue_id}`;
    switch (cue.type) {
      case "background_transition":
        await this.#transitionBackground(
          cue.background,
          cue.transition,
          cue.duration_ms,
          assets,
          signal,
        );
        break;
      case "sprite_tween":
        await this.#tweenSprite(
          cue.sprite_id,
          cue.to,
          cue.duration_ms,
          cue.easing,
          assets,
          signal,
        );
        break;
      case "camera_tween":
        await this.#tweenCamera(cue.to, cue.duration_ms, cue.easing, signal);
        break;
      case "screen_effect":
        await this.#screenEffect(cue.effect, cue.duration_ms, signal);
        break;
      case "play_sfx":
        if (!oneShotLedger.has(key)) {
          oneShotLedger.add(key);
          trimLedger();
          if (!this.#suppressOneShots) {
            await this.#audio.playSfx(cue.asset, cue.volume, assets);
          }
        }
        break;
      case "bgm_transition":
        if (!oneShotLedger.has(key)) {
          oneShotLedger.add(key);
          trimLedger();
          await this.#audio.transitionBgm(
            cue.to,
            cue.duration_ms,
            assets,
            signal,
          );
        }
        break;
      case "delay":
        await animate(
          cue.duration_ms,
          "linear",
          () => undefined,
          signal,
          () => this.#playbackRate,
        );
        break;
      case "dialogue_reveal":
      case "dialogue_ui_transition":
        break;
      default:
        cue satisfies never;
    }
  }

  async #transitionBackground(
    asset: string | null,
    transition: "cut" | "cross_fade",
    durationMs: number,
    assets: AssetUrlMap,
    signal: AbortSignal,
  ): Promise<void> {
    if (asset === null) {
      this.#clearBackgrounds();
      return;
    }
    const next = await this.#makeBackground(asset, assets);
    if (signal.aborted) {
      next.destroy();
      return;
    }
    const previous = this.#background;
    next.alpha = transition === "cut" ? 1 : 0;
    this.#backgrounds.addChild(next);
    this.#background = next;
    if (transition !== "cut") {
      await this.#animate(
        durationMs,
        "ease_in_out",
        (progress) => {
          next.alpha = progress;
          if (previous !== null) {
            previous.alpha = 1 - progress;
          }
        },
        signal,
      );
    }
    if (!signal.aborted) {
      for (const child of this.#backgrounds.removeChildren()) {
        if (child !== next) {
          child.destroy();
        }
      }
      this.#backgrounds.addChild(next);
      next.alpha = 1;
    }
  }

  async #tweenSprite(
    id: string,
    target: SpriteSnapshot | null,
    durationMs: number,
    easing: Easing,
    assets: AssetUrlMap,
    signal: AbortSignal,
  ): Promise<void> {
    let view = this.#spriteViews.get(id);
    if (target === null) {
      if (view === undefined) {
        return;
      }
      const initialAlpha = view.alpha;
      await this.#animate(
        durationMs,
        easing,
        (progress) => {
          if (view !== undefined) {
            view.alpha = initialAlpha * (1 - progress);
          }
        },
        signal,
      );
      if (!signal.aborted && view !== undefined) {
        this.#spriteViews.delete(id);
        view.destroy();
      }
      return;
    }

    const targetUrl = requireAssetUrl(assets, target.asset);
    if (view === undefined || view.label !== targetUrl) {
      view?.destroy();
      view = await this.#makeSprite(target, assets);
      view.label = targetUrl;
      view.x = target.x;
      view.y = target.y + 48;
      view.scale.set(target.scale * 0.96);
      view.alpha = 0;
      this.#sprites.addChild(view);
      this.#spriteViews.set(id, view);
    }
    if (signal.aborted) {
      return;
    }
    const start = readSprite(view);
    await this.#animate(
      durationMs,
      easing,
      (progress) => {
        if (view === undefined) {
          return;
        }
        view.x = mix(start.x, target.x, progress);
        view.y = mix(start.y, target.y, progress);
        view.scale.set(mix(start.scale, target.scale, progress));
        view.alpha = mix(start.opacity, target.opacity, progress);
        view.zIndex = progress < 1 ? start.z : target.z;
      },
      signal,
    );
  }

  async #tweenCamera(
    target: CameraSnapshot,
    durationMs: number,
    easing: Easing,
    signal: AbortSignal,
  ): Promise<void> {
    const start = { ...this.#camera };
    await this.#animate(
      durationMs,
      easing,
      (progress) => {
        this.#camera = {
          x: mix(start.x, target.x, progress),
          y: mix(start.y, target.y, progress),
          zoom: mix(start.zoom, target.zoom, progress),
        };
        this.#applyCamera();
      },
      signal,
    );
  }

  async #screenEffect(
    effect: "shake" | "flash",
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (effect === "flash") {
      const flash = new Graphics().rect(0, 0, WIDTH, HEIGHT).fill(0xffffff);
      flash.alpha = 0.88;
      this.#effects.addChild(flash);
      await this.#animate(
        durationMs,
        "ease_out",
        (progress) => {
          flash.alpha = 0.88 * (1 - progress);
        },
        signal,
      );
      flash.destroy();
      return;
    }
    await this.#animate(
      durationMs,
      "linear",
      (progress) => {
        const strength = (1 - progress) * 16;
        this.#world.position.set(
          WIDTH / 2 + Math.sin(progress * Math.PI * 18) * strength,
          HEIGHT / 2 + Math.cos(progress * Math.PI * 22) * strength * 0.6,
        );
      },
      signal,
    );
    this.#applyCamera();
  }

  async #reconcile(
    snapshot: RuntimeSnapshot,
    assets: AssetUrlMap,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#setBackground(snapshot.world.background, assets, signal);
    if (signal.aborted) {
      return;
    }
    const wanted = new Set(Object.keys(snapshot.world.sprites));
    for (const [id, view] of this.#spriteViews) {
      if (!wanted.has(id)) {
        view.destroy();
        this.#spriteViews.delete(id);
      }
    }
    for (const [id, state] of Object.entries(snapshot.world.sprites)) {
      let view = this.#spriteViews.get(id);
      const url = requireAssetUrl(assets, state.asset);
      if (view === undefined || view.label !== url) {
        view?.destroy();
        view = await this.#makeSprite(state, assets);
        if (signal.aborted) {
          view.destroy();
          return;
        }
        view.label = url;
        this.#sprites.addChild(view);
        this.#spriteViews.set(id, view);
      }
      applySprite(view, state);
    }
    this.#camera = { ...snapshot.world.camera };
    this.#applyCamera();
    this.#application.render();
    await this.#audio.reconcile(snapshot.audio, assets);
  }

  async #setBackground(
    asset: string | null,
    assets: AssetUrlMap,
    signal: AbortSignal,
  ): Promise<void> {
    if (asset === null) {
      this.#clearBackgrounds();
      return;
    }
    const url = requireAssetUrl(assets, asset);
    if (this.#background?.label === url) {
      this.#background.alpha = 1;
      return;
    }
    const background = await this.#makeBackground(asset, assets);
    if (signal.aborted) {
      background.destroy();
      return;
    }
    background.label = url;
    this.#clearBackgrounds();
    this.#background = background;
    this.#backgrounds.addChild(background);
  }

  async #makeBackground(asset: string, assets: AssetUrlMap): Promise<Sprite> {
    const url = requireAssetUrl(assets, asset);
    const texture = await loadTexture(url);
    const sprite = new Sprite(texture);
    sprite.label = url;
    const scale = Math.max(WIDTH / texture.width, HEIGHT / texture.height);
    sprite.scale.set(scale);
    sprite.position.set(
      (WIDTH - texture.width * scale) / 2,
      (HEIGHT - texture.height * scale) / 2,
    );
    return sprite;
  }

  async #makeSprite(
    state: SpriteSnapshot,
    assets: AssetUrlMap,
  ): Promise<Sprite> {
    const url = requireAssetUrl(assets, state.asset);
    const texture = await loadTexture(url);
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5, 1);
    sprite.label = url;
    return sprite;
  }

  #clearBackgrounds(): void {
    for (const child of this.#backgrounds.removeChildren()) {
      child.destroy();
    }
    this.#background = null;
  }

  #applyCamera(): void {
    this.#world.position.set(WIDTH / 2, HEIGHT / 2);
    this.#world.pivot.set(
      WIDTH / 2 + this.#camera.x,
      HEIGHT / 2 + this.#camera.y,
    );
    this.#world.scale.set(this.#camera.zoom);
  }

  #animate(
    durationMs: number,
    easing: Easing,
    apply: (progress: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return animate(
      durationMs,
      easing,
      (progress) => {
        apply(progress);
        this.#application.render();
      },
      signal,
      () => this.#playbackRate,
    );
  }
}

function applySprite(view: Sprite, state: SpriteSnapshot): void {
  view.position.set(state.x, state.y);
  view.scale.set(state.scale);
  view.alpha = state.opacity;
  view.zIndex = state.z;
}

function readSprite(view: Sprite): Omit<SpriteSnapshot, "asset"> {
  return {
    x: view.x,
    y: view.y,
    scale: view.scale.x,
    opacity: view.alpha,
    z: view.zIndex,
  };
}

function requireAssetUrl(assets: AssetUrlMap, id: string): string {
  const url = assets[id];
  if (url === undefined) {
    throw new Error(`素材尚未解析: ${id}`);
  }
  return url;
}

function animate(
  durationMs: number,
  easing: Easing,
  apply: (progress: number) => void,
  signal: AbortSignal,
  getRate: () => number = () => 1,
): Promise<void> {
  if (durationMs <= 0 || signal.aborted) {
    if (!signal.aborted) {
      apply(1);
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let previous = performance.now();
    let virtualElapsed = 0;
    let frame = 0;
    const abort = (): void => {
      cancelAnimationFrame(frame);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
    const tick = (now: number): void => {
      if (signal.aborted) {
        return;
      }
      virtualElapsed = advanceVirtualElapsed(
        virtualElapsed,
        now - previous,
        getRate(),
        durationMs,
      );
      previous = now;
      const raw = Math.min(1, virtualElapsed / durationMs);
      apply(ease(raw, easing));
      if (raw >= 1) {
        signal.removeEventListener("abort", abort);
        resolve();
      } else {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
  });
}

function ease(value: number, easing: Easing): number {
  switch (easing) {
    case "linear":
      return value;
    case "ease_in":
      return value * value;
    case "ease_out":
      return 1 - (1 - value) * (1 - value);
    case "ease_in_out":
      return value < 0.5 ? 2 * value * value : 1 - (-2 * value + 2) ** 2 / 2;
  }
}

function mix(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function trimLedger(): void {
  if (oneShotLedger.size <= 10_000) {
    return;
  }
  for (const key of oneShotLedger) {
    oneShotLedger.delete(key);
    if (oneShotLedger.size <= 5_000) {
      break;
    }
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function loadTexture(url: string): Promise<Texture> {
  const existing = texturePromises.get(url);
  if (existing !== undefined) {
    return existing;
  }
  const loading = withTimeout(
    new Promise<Texture>((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.decoding = "async";
      image.onload = () => resolve(Texture.from(image));
      image.onerror = () => reject(new Error(`图像解码失败: ${url}`));
      image.src = url;
    }),
    8_000,
    `图像加载超时: ${url}`,
  );
  texturePromises.set(url, loading);
  loading.catch(() => texturePromises.delete(url));
  return loading;
}

function withTimeout<T>(
  promise: Promise<T>,
  durationMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(message)),
      durationMs,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        window.clearTimeout(timer);
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      },
    );
  });
}
