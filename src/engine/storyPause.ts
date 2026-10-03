import type { StoryPauseReason } from "./api";

/**
 * Keeps the host's story-clock pause reasons in step with this window.
 *
 * The host owns the timers and decides what a pause means for the pair of
 * windows; the window only reports *why* it would pause (`panel`, `hidden`).
 * Reports are serialised and de-duplicated: the latest wish always wins, a
 * report is only sent when it differs from what the host last heard, and an
 * unchanged window sends nothing at all.
 */
export class StoryPauseSync {
  readonly #send: (
    reason: StoryPauseReason,
    active: boolean,
  ) => Promise<unknown>;
  readonly #desired: Record<StoryPauseReason, boolean> = {
    panel: false,
    hidden: false,
  };
  readonly #sent: Record<StoryPauseReason, boolean> = {
    panel: false,
    hidden: false,
  };
  #flushing = false;

  constructor(
    send: (reason: StoryPauseReason, active: boolean) => Promise<unknown>,
  ) {
    this.#send = send;
  }

  set(reason: StoryPauseReason, active: boolean): void {
    if (this.#desired[reason] === active) return;
    this.#desired[reason] = active;
    void this.#flush();
  }

  /**
   * The host cleared this window's reasons (a bootstrap or a session switch):
   * whatever is still wanted has to be reported again.
   */
  reset(): void {
    this.#sent.panel = false;
    this.#sent.hidden = false;
    void this.#flush();
  }

  async #flush(): Promise<void> {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      for (const reason of ["panel", "hidden"] as const) {
        // `desired` can change while a report is in flight, so re-check.
        while (this.#desired[reason] !== this.#sent[reason]) {
          const wanted = this.#desired[reason];
          try {
            await this.#send(reason, wanted);
            this.#sent[reason] = wanted;
          } catch (error) {
            // The host forgets reasons on its own at every session switch, so
            // a rejected report (stale session) is not worth retrying in a
            // loop; the next change or session adoption reports again.
            console.warn("暂停状态同步失败", error);
            this.#sent[reason] = false;
            break;
          }
        }
      }
    } finally {
      this.#flushing = false;
    }
  }
}
