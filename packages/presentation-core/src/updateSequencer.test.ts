import { describe, expect, it, vi } from "vitest";

import {
  UpdateSequencer,
  type UpdateBatch,
  type UpdateSequencerPorts,
} from "./updateSequencer";
import type { RuntimeUpdate } from "./types";

function update(
  seq: string | undefined,
  options: { session?: string; id?: string } = {},
): RuntimeUpdate {
  return {
    session_id: options.session ?? "7",
    ...(seq === undefined ? {} : { seq }),
    update_id: options.id ?? `u${seq ?? "x"}`,
    requires_ack: false,
    cues: [],
    snapshot: {} as RuntimeUpdate["snapshot"],
  };
}

interface Harness {
  sequencer: UpdateSequencer;
  applied: string[];
  fetches: { session: string; after: string }[];
  resolveFetch(batch: UpdateBatch | Error): void;
  newerSessions: string[];
  errors: unknown[];
}

function harness(options: Partial<UpdateSequencerPorts> = {}): Harness {
  const applied: string[] = [];
  const fetches: { session: string; after: string }[] = [];
  const waiting: ((value: UpdateBatch | Error) => void)[] = [];
  const newerSessions: string[] = [];
  const errors: unknown[] = [];
  const sequencer = new UpdateSequencer({
    fetchSince: (session, after) => {
      fetches.push({ session, after });
      return new Promise<UpdateBatch>((resolve, reject) => {
        waiting.push((value) =>
          value instanceof Error ? reject(value) : resolve(value),
        );
      });
    },
    apply: (next) => applied.push(next.update_id),
    onNewerSession: (session) => newerSessions.push(session),
    onError: (error) => errors.push(error),
    ...options,
  });
  return {
    sequencer,
    applied,
    fetches,
    resolveFetch: (batch) => waiting.shift()?.(batch),
    newerSessions,
    errors,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("UpdateSequencer", () => {
  it("applies in order, once, and compares wire u64 as BigInt", () => {
    const { sequencer, applied } = harness();
    // 2^53 + 1 and 2^53 are the same Number: they must still be told apart.
    sequencer.adopt("7", "9007199254740992");
    expect(sequencer.offer(update("9007199254740993"))).toBe("applied");
    expect(sequencer.offer(update("9007199254740993"))).toBe("duplicate");
    expect(sequencer.offer(update("9007199254740992"))).toBe("duplicate");
    expect(sequencer.offer(update("9007199254740994"))).toBe("applied");
    expect(applied).toEqual(["u9007199254740993", "u9007199254740994"]);
    expect(sequencer.lastSeq).toBe(9007199254740994n);
  });

  it("never applies an update of another session", () => {
    const { sequencer, applied } = harness();
    sequencer.adopt("7", "0");
    expect(sequencer.offer(update("1", { session: "6" }))).toBe("foreign");
    expect(applied).toEqual([]);
  });

  it("applies updates without a sequence number in arrival order", () => {
    const { sequencer, applied } = harness();
    sequencer.adopt("7", undefined);
    sequencer.offer(update(undefined, { id: "a" }));
    sequencer.offer(update(undefined, { id: "b" }));
    expect(applied).toEqual(["a", "b"]);
  });

  it("parks a response that overtook an event and applies both in order", async () => {
    const { sequencer, applied, fetches, resolveFetch } = harness();
    sequencer.adopt("7", "1");
    // The command response (seq 3) is here before the update at seq 2.
    expect(sequencer.offer(update("3"))).toBe("deferred");
    expect(applied).toEqual([]);
    expect(fetches).toEqual([{ session: "7", after: "1" }]);
    resolveFetch({
      session_id: "7",
      latest_seq: "3",
      updates: [update("2"), update("3")],
    });
    await flush();
    expect(applied).toEqual(["u2", "u3"]);
    expect(sequencer.lastSeq).toBe(3n);
    // The same response seen again (event + response) is a duplicate.
    expect(sequencer.offer(update("3"))).toBe("duplicate");
  });

  it("fetches what a notification announced, one sync at a time", async () => {
    const { sequencer, applied, fetches, resolveFetch } = harness();
    sequencer.adopt("7", "0");
    sequencer.notify("7", "2");
    sequencer.notify("7", "3");
    expect(fetches).toHaveLength(1);
    resolveFetch({
      session_id: "7",
      latest_seq: "3",
      updates: [update("1"), update("2"), update("3")],
    });
    await flush();
    expect(applied).toEqual(["u1", "u2", "u3"]);
    // Everything was covered by the first fetch; no redundant second one.
    expect(fetches).toHaveLength(1);
  });

  it("remembers a notification that precedes the bootstrap", async () => {
    const { sequencer, applied, fetches, resolveFetch } = harness();
    // Listener first, bootstrap second: the event can land in between.
    sequencer.notify("7", "5");
    expect(fetches).toHaveLength(0);
    sequencer.adopt("7", "3");
    expect(fetches).toEqual([{ session: "7", after: "3" }]);
    resolveFetch({
      session_id: "7",
      latest_seq: "5",
      updates: [update("4"), update("5")],
    });
    await flush();
    expect(applied).toEqual(["u4", "u5"]);
  });

  it("ignores a stale notification covered by the bootstrap position", () => {
    const { sequencer, fetches } = harness();
    sequencer.notify("7", "3");
    sequencer.adopt("7", "3");
    expect(fetches).toHaveLength(0);
  });

  it("drops a sync batch that belongs to a replaced session", async () => {
    const { sequencer, applied, resolveFetch } = harness();
    sequencer.adopt("7", "0");
    sequencer.notify("7", "2");
    // The session is replaced while the old sync is still in flight.
    sequencer.adopt("8", "0");
    resolveFetch({
      session_id: "7",
      latest_seq: "2",
      updates: [update("1"), update("2")],
    });
    await flush();
    expect(applied).toEqual([]);
    expect(sequencer.session).toBe("8");
    // The replacement session still syncs normally afterwards.
    expect(sequencer.offer(update("1", { session: "8", id: "n1" }))).toBe(
      "applied",
    );
    expect(applied).toEqual(["n1"]);
  });

  it("reports a newer session instead of applying it", () => {
    const { sequencer, applied, newerSessions } = harness();
    sequencer.adopt("7", "0");
    sequencer.notify("8", "1");
    sequencer.notify("6", "9");
    expect(newerSessions).toEqual(["8"]);
    expect(applied).toEqual([]);
  });

  it("treats a gap response as a resynchronisation", async () => {
    const { sequencer, applied, resolveFetch } = harness();
    sequencer.adopt("7", "1");
    sequencer.notify("7", "40");
    resolveFetch({
      session_id: "7",
      latest_seq: "40",
      gap: true,
      // The unacknowledged story update, then the newest state.
      updates: [update("2", { id: "pending" }), update("40", { id: "state" })],
    });
    await flush();
    expect(applied).toEqual(["pending", "state"]);
    expect(sequencer.lastSeq).toBe(40n);
    expect(sequencer.offer(update("41"))).toBe("applied");
  });

  it("reports a failed sync and retries on the next notification", async () => {
    const { sequencer, applied, errors, fetches, resolveFetch } = harness();
    sequencer.adopt("7", "0");
    sequencer.notify("7", "1");
    resolveFetch(new Error("offline"));
    await flush();
    expect(errors).toHaveLength(1);
    expect(fetches).toHaveLength(1);
    sequencer.notify("7", "1");
    expect(fetches).toHaveLength(2);
    resolveFetch({ session_id: "7", latest_seq: "1", updates: [update("1")] });
    await flush();
    expect(applied).toEqual(["u1"]);
  });

  it("does not loop when the host returns nothing new", async () => {
    const { sequencer, fetches, resolveFetch } = harness();
    sequencer.adopt("7", "0");
    sequencer.notify("7", "2");
    resolveFetch({ session_id: "7", latest_seq: "2", updates: [] });
    await flush();
    expect(fetches).toHaveLength(1);
  });

  it("resyncs on request and stops once the host has nothing newer", async () => {
    const { sequencer, applied, fetches, resolveFetch } = harness();
    sequencer.adopt("7", "4");
    sequencer.resync();
    expect(fetches).toEqual([{ session: "7", after: "4" }]);
    resolveFetch({ session_id: "7", latest_seq: "4", updates: [] });
    await flush();
    expect(applied).toEqual([]);
    // A later event for seq 5 is a normal in-order update again.
    expect(sequencer.offer(update("5"))).toBe("applied");
    expect(fetches).toHaveLength(1);
  });

  it("survives an apply callback that throws", () => {
    const apply = vi.fn((next: RuntimeUpdate) => {
      if (next.update_id === "u1") throw new Error("boom");
    });
    const { sequencer, errors } = harness({ apply });
    sequencer.adopt("7", "0");
    sequencer.offer(update("1"));
    sequencer.offer(update("2"));
    expect(apply).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    expect(sequencer.lastSeq).toBe(2n);
  });
});
