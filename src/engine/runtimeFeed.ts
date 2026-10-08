import { listen } from "@tauri-apps/api/event";

import type { RuntimeUpdate } from "@vectspace/presentation-core/types";
import {
  UpdateSequencer,
  type UpdateBatch,
} from "@vectspace/presentation-core/update-sequencer";
import type { WireU64 } from "../../shared/generated/WireU64";
import { engineApi } from "./api";

/**
 * Host notification that a window has committed updates it has not seen.  It
 * carries no data - the update itself is fetched with the sync command - so a
 * lost or reordered event can only delay an update, never corrupt state.
 */
const RUNTIME_UPDATED_EVENT = "vectspace://runtime-updated";

export type FeedChannel = "main" | "secondary";

export interface RuntimeFeedHooks {
  /** Applies one in-order update to the window. */
  apply(update: RuntimeUpdate): void;
  /** A newer session than the adopted one exists (secondary: re-bootstrap). */
  onNewerSession?(sessionId: WireU64): void;
  onError(reason: unknown): void;
}

/**
 * The receive path shared by the main and the secondary game window: one
 * ordered {@link UpdateSequencer} fed by the host's notification event, the
 * incremental sync command and the window's own command responses.
 *
 * Usage contract (both windows): create it, `await subscribe()`, *then*
 * bootstrap and `sequencer.adopt()` the bootstrap position - the listener comes
 * first so an update committed while the window is still starting is announced
 * to a registered listener and remembered by the sequencer.
 */
export class RuntimeFeed {
  readonly sequencer: UpdateSequencer;
  /** Also the window label the host emits this window's notices to. */
  readonly #channel: FeedChannel;
  #unlisten: (() => void) | null = null;
  #disposed = false;

  constructor(channel: FeedChannel, hooks: RuntimeFeedHooks) {
    this.#channel = channel;
    const fetchSince = (
      session: WireU64,
      after: WireU64,
    ): Promise<UpdateBatch> =>
      channel === "main"
        ? engineApi.syncUpdates(session, after)
        : engineApi.secondarySyncUpdates(session, after);
    this.sequencer = new UpdateSequencer({
      fetchSince,
      apply: (update) => hooks.apply(update),
      ...(hooks.onNewerSession === undefined
        ? {}
        : { onNewerSession: hooks.onNewerSession }),
      onError: hooks.onError,
    });
  }

  /** Registers the notification listener.  Never rejects: a window without it
   * still receives every update through its command responses. */
  async subscribe(): Promise<void> {
    if (this.#unlisten !== null || this.#disposed) return;
    try {
      // The host addresses each notice to one window label. A plain `listen`
      // would also hear the other window's notices, whose session id lives in
      // a different numbering space and would look like a newer session.
      const stop = await listen<unknown>(
        RUNTIME_UPDATED_EVENT,
        (event) => {
          const note = parseNotification(event.payload);
          if (note !== null) this.sequencer.notify(note.session, note.latest);
        },
        { target: this.#channel },
      );
      if (this.#disposed) {
        stop();
        return;
      }
      this.#unlisten = stop;
    } catch (reason: unknown) {
      console.error("运行时更新事件订阅失败", reason);
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#unlisten?.();
    this.#unlisten = null;
    this.sequencer.dispose();
  }
}

function parseNotification(
  payload: unknown,
): { session: WireU64; latest: WireU64 } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { session_id: session, latest_seq: latest } = payload as Record<
    string,
    unknown
  >;
  if (!isWireU64(session) || !isWireU64(latest)) return null;
  return { session, latest };
}

function isWireU64(value: unknown): value is WireU64 {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}
