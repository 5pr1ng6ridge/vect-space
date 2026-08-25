import type {
  AssetUrlMap,
  AudioSnapshot,
  LoopingAudioSnapshot,
  Settings,
} from "./types";

interface PlayingBgm {
  asset: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

interface PlayingTypingSfx {
  url: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export class AudioManager {
  readonly #buffers = new Map<string, Promise<AudioBuffer>>();
  #context: AudioContext | null = null;
  #master: GainNode | null = null;
  #bgmBus: GainNode | null = null;
  #sfxBus: GainNode | null = null;
  #currentBgm: PlayingBgm | null = null;
  #typingSfx: PlayingTypingSfx | null = null;
  #typingGeneration = 0;
  #settings: Settings;

  constructor(settings: Settings) {
    this.#settings = settings;
  }

  async unlock(): Promise<void> {
    const context = this.#ensureContext();
    if (context.state === "suspended") {
      await context.resume();
    }
  }

  applySettings(settings: Settings): void {
    this.#settings = settings;
    if (this.#context === null) {
      return;
    }
    const now = this.#context.currentTime;
    this.#master?.gain.setValueAtTime(settings.master_volume, now);
    this.#bgmBus?.gain.setValueAtTime(settings.bgm_volume, now);
    this.#sfxBus?.gain.setValueAtTime(settings.sfx_volume, now);
  }

  async playSfx(
    asset: string,
    volume: number,
    assets: AssetUrlMap,
  ): Promise<void> {
    const url = requireAssetUrl(assets, asset);
    const context = this.#ensureContext();
    const buffer = await this.#load(url);
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.value = volume;
    source.connect(gain).connect(this.#sfxBus as GainNode);
    source.start();
  }

  async setTypingSfx(active: boolean, assets: AssetUrlMap): Promise<void> {
    const generation = ++this.#typingGeneration;
    if (!active) {
      this.#stopTypingSfx();
      return;
    }

    const url = requireAssetUrl(assets, "sfx.typing");
    if (this.#typingSfx?.url === url) {
      return;
    }
    this.#stopTypingSfx();

    const context = this.#ensureContext();
    const buffer = await this.#load(url);
    if (generation !== this.#typingGeneration) {
      return;
    }

    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.loop = true;
    gain.gain.value = 0.25;
    source.connect(gain).connect(this.#sfxBus as GainNode);
    this.#typingSfx = { url, source, gain };
    source.start();
  }

  async transitionBgm(
    target: LoopingAudioSnapshot | null,
    durationMs: number,
    assets: AssetUrlMap,
  ): Promise<void> {
    if (target === null && this.#currentBgm === null) {
      return;
    }
    const context = this.#ensureContext();
    const duration = Math.max(0, durationMs) / 1000;
    const now = context.currentTime;
    const previous = this.#currentBgm;

    if (target !== null && previous?.asset === target.asset) {
      previous.gain.gain.cancelScheduledValues(now);
      previous.gain.gain.setValueAtTime(previous.gain.gain.value, now);
      previous.gain.gain.linearRampToValueAtTime(target.volume, now + duration);
      await wait(durationMs);
      return;
    }

    let next: PlayingBgm | null = null;
    if (target !== null) {
      const url = requireAssetUrl(assets, target.asset);
      const buffer = await this.#load(url);
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      source.loop = true;
      gain.gain.setValueAtTime(duration > 0 ? 0 : target.volume, now);
      source.connect(gain).connect(this.#bgmBus as GainNode);
      source.start();
      if (duration > 0) {
        gain.gain.linearRampToValueAtTime(target.volume, now + duration);
      }
      next = { asset: target.asset, source, gain };
    }

    this.#currentBgm = next;
    if (previous !== null) {
      previous.gain.gain.cancelScheduledValues(now);
      previous.gain.gain.setValueAtTime(previous.gain.gain.value, now);
      previous.gain.gain.linearRampToValueAtTime(0, now + duration);
    }
    await wait(durationMs);
    if (previous !== null) {
      safelyStop(previous.source);
    }
  }

  async reconcile(snapshot: AudioSnapshot, assets: AssetUrlMap): Promise<void> {
    await this.transitionBgm(snapshot.bgm, 0, assets);
  }

  destroy(): void {
    this.#typingGeneration += 1;
    this.#stopTypingSfx();
    if (this.#currentBgm !== null) {
      safelyStop(this.#currentBgm.source);
      this.#currentBgm = null;
    }
    if (this.#context !== null) {
      void this.#context.close();
      this.#context = null;
    }
    this.#buffers.clear();
  }

  #ensureContext(): AudioContext {
    if (this.#context !== null) {
      return this.#context;
    }
    const context = new AudioContext({ latencyHint: "interactive" });
    const master = context.createGain();
    const bgm = context.createGain();
    const sfx = context.createGain();
    bgm.connect(master);
    sfx.connect(master);
    master.connect(context.destination);
    this.#context = context;
    this.#master = master;
    this.#bgmBus = bgm;
    this.#sfxBus = sfx;
    this.applySettings(this.#settings);
    return context;
  }

  #stopTypingSfx(): void {
    if (this.#typingSfx === null) {
      return;
    }
    safelyStop(this.#typingSfx.source);
    this.#typingSfx.gain.disconnect();
    this.#typingSfx = null;
  }

  #load(url: string): Promise<AudioBuffer> {
    const cached = this.#buffers.get(url);
    if (cached !== undefined) {
      return cached;
    }
    const context = this.#ensureContext();
    const loading = fetch(url)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`音频读取失败 (${response.status}): ${url}`);
        }
        return response.arrayBuffer();
      })
      .then((data) => context.decodeAudioData(data));
    this.#buffers.set(url, loading);
    loading.catch(() => this.#buffers.delete(url));
    return loading;
  }
}

function requireAssetUrl(assets: AssetUrlMap, id: string): string {
  const url = assets[id];
  if (url === undefined) {
    throw new Error(`表现层找不到素材 URL: ${id}`);
  }
  return url;
}

function safelyStop(source: AudioBufferSourceNode): void {
  try {
    source.stop();
  } catch {
    // A source can only be stopped once. Reconciliation is intentionally idempotent.
  }
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) =>
    window.setTimeout(resolve, Math.max(0, durationMs)),
  );
}
