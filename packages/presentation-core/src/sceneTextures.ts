/**
 * Reference-counted texture store shared by the game and the editor surface.
 *
 * A decoded image is loaded once, shared by every view that needs it, and
 * destroyed exactly when the last referencing view goes away; the number of
 * distinct resident urls is bounded by a budget.
 */

export interface SceneTextureLike {
  readonly width: number;
  readonly height: number;
  destroy(destroySource?: boolean): void;
}

export interface SceneTextureStoreOptions<T extends SceneTextureLike> {
  load(url: string): Promise<T>;
  /** Pool-owned resources return to their pool instead of destroying the source. */
  release?: (texture: T) => void;
  /** Maximum number of distinct urls that may be resident at once. */
  budget: number;
}

interface Entry<T extends SceneTextureLike> {
  promise: Promise<T>;
  texture: T | null;
  refs: number;
}

export class SceneTextureStore<T extends SceneTextureLike = SceneTextureLike> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #load: (url: string) => Promise<T>;
  readonly #release: (texture: T) => void;
  #budget: number;
  #disposed = false;

  constructor(options: SceneTextureStoreOptions<T>) {
    this.#load = options.load;
    this.#release = options.release ?? ((texture) => texture.destroy(true));
    this.#budget = Math.max(1, Math.floor(options.budget));
  }

  /** Number of resident or in-flight textures; the budget compares against it. */
  get size(): number {
    return this.#entries.size;
  }

  get budget(): number {
    return this.#budget;
  }

  setBudget(budget: number): void {
    this.#budget = Math.max(1, Math.floor(budget));
  }

  has(url: string): boolean {
    return this.#entries.has(url);
  }

  refCount(url: string): number {
    return this.#entries.get(url)?.refs ?? 0;
  }

  /** Resolved texture, or `undefined` while it is still decoding. */
  texture(url: string): T | undefined {
    return this.#entries.get(url)?.texture ?? undefined;
  }

  /**
   * Acquires one reference to a decoded texture.
   *
   * Concurrent acquirers share one decode.  A failure releases the reference
   * immediately and removes the entry, so a broken image never occupies a
   * budget slot and a later retry can load it again.
   */
  acquire(url: string): Promise<T> {
    if (this.#disposed) {
      return Promise.reject(new Error(`纹理缓存已释放: ${url}`));
    }
    const existing = this.#entries.get(url);
    if (existing !== undefined) {
      existing.refs += 1;
      return existing.promise;
    }
    if (this.#entries.size >= this.#budget) {
      return Promise.reject(
        new Error(`单次会话纹理数量超过 ${this.#budget} 个`),
      );
    }
    const entry: Entry<T> = {
      promise: Promise.resolve(undefined as unknown as T),
      texture: null,
      refs: 1,
    };
    entry.promise = this.#load(url).then(
      (texture) => {
        if (this.#disposed || this.#entries.get(url) !== entry) {
          // The reference was released (or the store destroyed) while the
          // image was still decoding; the pixels must not outlive it.
          this.#release(texture);
          return texture;
        }
        entry.texture = texture;
        return texture;
      },
      (reason: unknown) => {
        // Every acquirer shared this one decode: drop the entry and its
        // references so the failed image frees its budget slot and a later
        // acquire retries instead of receiving the rejected promise.  A newer
        // entry for the same url (this one was released and re-acquired while
        // decoding) is left untouched.
        if (this.#entries.get(url) === entry) {
          entry.refs = 0;
          this.#entries.delete(url);
        }
        throw reason instanceof Error ? reason : new Error(String(reason));
      },
    );
    this.#entries.set(url, entry);
    return entry.promise;
  }

  /**
   * Adds one reference to an already resident texture.
   *
   * Returns `false` when the url is unknown or still decoding, so a caller can
   * never claim pixels that are not there yet.
   */
  retain(url: string): boolean {
    const entry = this.#entries.get(url);
    if (entry === undefined || entry.texture === null) return false;
    entry.refs += 1;
    return true;
  }

  /** Drops one reference; the last one destroys the decoded texture. */
  release(url: string): void {
    const entry = this.#entries.get(url);
    if (entry === undefined) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.#entries.delete(url);
    if (entry.texture !== null) {
      this.#release(entry.texture);
    }
  }

  releaseAll(urls: readonly string[]): void {
    const unique = new Set(urls);
    for (const url of unique) this.release(url);
  }

  /** Releases every reference and destroys every resident texture. */
  destroy(): void {
    this.#disposed = true;
    for (const entry of this.#entries.values()) {
      if (entry.texture !== null) this.#release(entry.texture);
    }
    this.#entries.clear();
  }
}
