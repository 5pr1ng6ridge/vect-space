/**
 * Ordered, session-aware intake of one window's committed runtime updates.
 *
 * A window hears about updates through three paths that race each other: the
 * response of its own command, the host's "updated" notification and the
 * incremental sync that fetches what the notification announced.  This class
 * is the single receiver all three go through, for both game windows:
 *
 * - every update carries a wire-u64 session id and commit sequence number,
 *   compared as BigInt (never as Number);
 * - an update is applied exactly once and in sequence order: duplicates are
 *   dropped, an update that arrives ahead of a missing one is parked until the
 *   missing ones were synced, so a late command response can never overwrite
 *   newer state and a "latest snapshot only" fetch can never swallow cues;
 * - updates of another session are never applied;
 * - a notification that arrives before the session is known (the listener is
 *   registered before the bootstrap) is remembered and honoured on adoption;
 * - one sync runs at a time; a replacement session invalidates it.
 *
 * Hosts or fixtures that send no sequence numbers keep working: such updates
 * are simply applied in arrival order.
 */

import type { WireU64 } from "../../../shared/generated/WireU64";
import type { RuntimeUpdate } from "./types";

/** What the host's incremental sync command returns. */
export interface UpdateBatch {
  session_id: WireU64;
  latest_seq: WireU64;
  updates: RuntimeUpdate[];
  /**
   * The requested position predates the host's bounded buffer.  `updates` then
   * holds the still-unacknowledged story update (if any) followed by the newest
   * state, which together are enough to resynchronise.
   */
  gap?: boolean;
}

export interface UpdateSequencerPorts {
  fetchSince(sessionId: WireU64, afterSeq: WireU64): Promise<UpdateBatch>;
  /** Applies one update; called in sequence order, at most once per update. */
  apply(update: RuntimeUpdate): void;
  /**
   * A notification announced a session newer than the adopted one.  A window
   * that owns its session boundaries (main) leaves this unset; the secondary
   * window re-bootstraps.
   */
  onNewerSession?(sessionId: WireU64): void;
  onError?(error: unknown): void;
}

/** Bounds the parking lot if a sync keeps failing while updates keep coming. */
const MAX_PARKED_UPDATES = 64;

export type OfferResult = "applied" | "duplicate" | "deferred" | "foreign";

export class UpdateSequencer {
  readonly #ports: UpdateSequencerPorts;
  #session: WireU64 | null = null;
  #last: bigint | null = null;
  #wanted = 0n;
  readonly #ahead = new Map<bigint, RuntimeUpdate>();
  #stash: { session: WireU64; latest: bigint } | null = null;
  #generation = 0;
  #syncing = false;
  #again = false;
  #disposed = false;

  constructor(ports: UpdateSequencerPorts) {
    this.#ports = ports;
  }

  get session(): WireU64 | null {
    return this.#session;
  }

  /** Last applied sequence number, or null when the session has none yet. */
  get lastSeq(): bigint | null {
    return this.#last;
  }

  /**
   * Starts following a session from `seq` (the bootstrap payload's position, or
   * `"0"` for a freshly created session).  Anything earlier is never applied.
   */
  adopt(sessionId: WireU64, seq: WireU64 | null | undefined): void {
    this.#generation += 1;
    this.#syncing = false;
    this.#again = false;
    this.#session = sessionId;
    this.#last = parseSeq(seq);
    this.#wanted = this.#last ?? 0n;
    this.#ahead.clear();
    const stash = this.#stash;
    this.#stash = null;
    if (stash !== null && stash.session === sessionId) {
      this.#wanted = max(this.#wanted, stash.latest);
      this.#startSync();
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#generation += 1;
    this.#ahead.clear();
  }

  /** Intake for a command response (or any update already in hand). */
  offer(update: RuntimeUpdate): OfferResult {
    if (this.#disposed) return "duplicate";
    if (
      this.#session !== null &&
      update.session_id !== undefined &&
      update.session_id !== this.#session
    ) {
      return "foreign";
    }
    const seq = parseSeq(update.seq);
    if (seq === null) {
      this.#apply(update);
      return "applied";
    }
    if (this.#last === null) {
      this.#last = seq;
      this.#wanted = max(this.#wanted, seq);
      this.#apply(update);
      return "applied";
    }
    if (seq <= this.#last) return "duplicate";
    if (seq === this.#last + 1n) {
      this.#last = seq;
      this.#apply(update);
      this.#drainAhead();
      return "applied";
    }
    // Updates before this one are still missing: park it and fetch them.  The
    // parked update is applied in order once the gap has been filled.
    this.#ahead.set(seq, update);
    if (this.#ahead.size > MAX_PARKED_UPDATES) {
      const oldest = [...this.#ahead.keys()].sort(compare)[0];
      if (oldest !== undefined) this.#ahead.delete(oldest);
    }
    this.#wanted = max(this.#wanted, seq);
    this.#startSync();
    return "deferred";
  }

  /** The host announced that `sessionId` has updates up to `latestSeq`. */
  notify(sessionId: WireU64, latestSeq: WireU64): void {
    const latest = parseSeq(latestSeq);
    if (this.#disposed || latest === null) return;
    if (this.#session === null) {
      this.#remember(sessionId, latest);
      return;
    }
    if (sessionId !== this.#session) {
      const known = parseSeq(this.#session);
      const announced = parseSeq(sessionId);
      if (known !== null && announced !== null && announced > known) {
        this.#remember(sessionId, latest);
        this.#ports.onNewerSession?.(sessionId);
      }
      return;
    }
    this.#wanted = max(this.#wanted, latest);
    this.#startSync();
  }

  /**
   * Asks the host for anything newer than what was applied.  A window calls it
   * after a command was rejected as out of date, so its view is refreshed from
   * the host rather than trusted to a notification that may have been lost.
   */
  resync(): void {
    if (this.#disposed || this.#session === null || this.#last === null) return;
    this.#wanted = max(this.#wanted, this.#last + 1n);
    this.#startSync();
  }

  #remember(session: WireU64, latest: bigint): void {
    if (
      this.#stash === null ||
      this.#stash.session !== session ||
      this.#stash.latest < latest
    ) {
      this.#stash = { session, latest };
    }
  }

  #apply(update: RuntimeUpdate): void {
    try {
      this.#ports.apply(update);
    } catch (error) {
      this.#ports.onError?.(error);
    }
  }

  #drainAhead(): void {
    for (const seq of [...this.#ahead.keys()].sort(compare)) {
      const update = this.#ahead.get(seq);
      if (update === undefined) continue;
      if (this.#last !== null && seq <= this.#last) {
        this.#ahead.delete(seq);
      } else if (this.#last !== null && seq === this.#last + 1n) {
        this.#ahead.delete(seq);
        this.#last = seq;
        this.#apply(update);
      } else {
        break;
      }
    }
  }

  #startSync(): void {
    if (this.#syncing) {
      this.#again = true;
      return;
    }
    void this.#sync();
  }

  async #sync(): Promise<void> {
    const generation = this.#generation;
    this.#syncing = true;
    try {
      let progressed = true;
      while (progressed) {
        this.#again = false;
        const session = this.#session;
        const after = this.#last;
        if (session === null || after === null || this.#wanted <= after) return;
        let batch: UpdateBatch;
        try {
          batch = await this.#ports.fetchSince(session, String(after));
        } catch (error) {
          if (generation === this.#generation) this.#ports.onError?.(error);
          return;
        }
        // A replaced session (or a disposed window) must not see this batch.
        if (generation !== this.#generation) return;
        if (batch.session_id !== session) {
          this.#ports.onNewerSession?.(batch.session_id);
          return;
        }
        const before = this.#last;
        for (const update of [...batch.updates].sort(bySeq)) {
          const seq = parseSeq(update.seq);
          if (seq === null) {
            this.#apply(update);
            continue;
          }
          if (this.#last !== null && seq <= this.#last) continue;
          this.#ahead.delete(seq);
          this.#last = seq;
          this.#apply(update);
        }
        const latest = parseSeq(batch.latest_seq) ?? this.#wanted;
        // A gap response is a resynchronisation: the host vouches that it now
        // describes everything up to `latest_seq`.
        if (batch.gap === true && this.#last !== null && this.#last < latest) {
          this.#last = latest;
        }
        // Nothing newer than what was applied exists on the host: stop wanting.
        this.#wanted =
          this.#last !== null && latest <= this.#last
            ? this.#last
            : max(this.#wanted, latest);
        this.#drainAhead();
        progressed = this.#last !== before || this.#again;
      }
    } finally {
      if (generation === this.#generation) this.#syncing = false;
    }
  }
}

function max(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function compare(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bySeq(left: RuntimeUpdate, right: RuntimeUpdate): number {
  const a = parseSeq(left.seq);
  const b = parseSeq(right.seq);
  return a === null || b === null ? 0 : compare(a, b);
}

/** Wire u64 as BigInt; anything that is not a canonical decimal is "absent". */
function parseSeq(value: WireU64 | null | undefined): bigint | null {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)
    ? BigInt(value)
    : null;
}
