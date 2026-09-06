/** A small insertion-ordered ledger for Strict Mode and duplicate callback safety. */
export class BoundedLedger<Key> {
  readonly #values = new Set<Key>();

  constructor(readonly capacity = 256) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("Ledger capacity must be a positive safe integer");
    }
  }

  consume(key: Key): boolean {
    if (this.#values.has(key)) return false;
    this.#values.add(key);
    while (this.#values.size > this.capacity) {
      const oldest = this.#values.values().next().value as Key | undefined;
      if (oldest === undefined) break;
      this.#values.delete(oldest);
    }
    return true;
  }

  has(key: Key): boolean {
    return this.#values.has(key);
  }

  /** Remove one consumed entry when a playhead is rewound past it. */
  delete(key: Key): void {
    this.#values.delete(key);
  }

  clear(): void {
    this.#values.clear();
  }

  get size(): number {
    return this.#values.size;
  }
}
