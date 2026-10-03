import { describe, expect, it } from "vitest";

import {
  EMPTY_LIVE_STATE,
  MAX_PENDING_EFFECTS,
  advanceBlockMessages,
  deepEqual,
  isAdvanceBlocked,
  promptOccurrence,
  reduceLiveState,
  type LiveState,
} from "./liveUpdate";
import type {
  InteractionSnapshot,
  RuntimeSnapshot,
  RuntimeUpdate,
  RuntimeUpdateKind,
} from "./types";

function snapshot(
  revision: string,
  options: {
    text?: string;
    choices?: string[];
    interaction?: InteractionSnapshot;
    variables?: Record<string, bigint | string>;
  } = {},
): RuntimeSnapshot {
  const prompt =
    options.choices === undefined
      ? {
          kind: "dialogue" as const,
          prompt_id: "s/n",
          speaker_id: null,
          speaker: null,
          text: options.text ?? "hello",
          is_read: false,
        }
      : {
          kind: "choice" as const,
          prompt_id: "s/c",
          layout: {} as never,
          diagnostics: [],
          choices: options.choices.map((id) => ({ id, label: id })) as never,
        };
  return {
    session_id: "1",
    revision,
    location: { scene_id: "s", node_id: "n" },
    variables: options.variables ?? {},
    world: { buttons: {} } as never,
    audio: { bgm: null },
    playback: { auto: "normal", ctrl_fast_forward: "allow" },
    interaction: options.interaction ?? { prompt_instance: "10" },
    prompt,
  } as RuntimeSnapshot;
}

function update(
  kind: RuntimeUpdateKind | undefined,
  id: string,
  snap: RuntimeSnapshot,
  extra: Partial<RuntimeUpdate> = {},
): RuntimeUpdate {
  return {
    session_id: "1",
    ...(kind === undefined ? {} : { kind }),
    update_id: id,
    requires_ack: false,
    cues: [],
    snapshot: snap,
    ...extra,
  };
}

function story(id: string, snap = snapshot("1"), extra = {}): RuntimeUpdate {
  return update("story", id, snap, extra);
}

describe("reduceLiveState", () => {
  it("adopts story updates, with or without a kind", () => {
    let state = reduceLiveState(EMPTY_LIVE_STATE, story("1"));
    expect(state.update?.update_id).toBe("1");
    state = reduceLiveState(state, update(undefined, "2", snapshot("2")));
    expect(state.update?.update_id).toBe("2");
  });

  it("keeps the story identity, cues and acknowledgement across a refresh", () => {
    const gate = story("5", snapshot("5"), {
      requires_ack: true,
      cues: [{ cue_id: "1", gate: "runtime", type: "delay", duration_ms: 500 }],
    });
    const state = reduceLiveState(EMPTY_LIVE_STATE, gate);
    const refreshed = reduceLiveState(
      state,
      update("state_refresh", "6", snapshot("6", { text: "changed" })),
    );
    // Same story update: the gate, its cues and its update_id survive...
    expect(refreshed.update?.update_id).toBe("5");
    expect(refreshed.update?.requires_ack).toBe(true);
    expect(refreshed.update?.cues).toBe(gate.cues);
    // ...while the live snapshot (and so the command revision) is the newest.
    expect(refreshed.update?.snapshot.revision).toBe("6");
    expect(refreshed.update?.snapshot.prompt).toMatchObject({
      text: "changed",
    });
  });

  it("shows a choice that appeared in another window without a new story update", () => {
    const first = reduceLiveState(
      EMPTY_LIVE_STATE,
      story("1", snapshot("1", { choices: ["a"] })),
    );
    const next = reduceLiveState(
      first,
      update("state_refresh", "2", snapshot("2", { choices: ["a", "b"] })),
    );
    expect(next.update?.update_id).toBe("1");
    const prompt = next.update?.snapshot.prompt;
    expect(
      prompt?.kind === "choice" && prompt.choices.map((c) => c.id),
    ).toEqual(["a", "b"]);
  });

  it("reuses unchanged snapshot parts so memoised text plans stay valid", () => {
    const first = reduceLiveState(EMPTY_LIVE_STATE, story("1"));
    const second = reduceLiveState(
      first,
      update("state_refresh", "2", snapshot("2", { variables: { gold: 3n } })),
    );
    expect(second.update?.snapshot.prompt).toBe(first.update?.snapshot.prompt);
    expect(second.update?.snapshot.world).toBe(first.update?.snapshot.world);
    expect(second.update?.snapshot.variables).toEqual({ gold: 3n });
  });

  it("treats a refresh of another prompt as a resync, not a silent patch", () => {
    const state = reduceLiveState(EMPTY_LIVE_STATE, story("1"));
    const resynced = reduceLiveState(
      state,
      update(
        "state_refresh",
        "9",
        snapshot("9", { interaction: { prompt_instance: "30" } }),
      ),
    );
    expect(resynced.update?.update_id).toBe("9");
    expect(resynced.update?.kind).toBe("story");
    expect(resynced.effects).toEqual([]);
  });

  it("does not re-present a story update the host re-sent after a gap", () => {
    const state = reduceLiveState(
      EMPTY_LIVE_STATE,
      story("5", snapshot("5"), { seq: "9" }),
    );
    expect(
      reduceLiveState(state, story("5", snapshot("0"), { seq: "10" })),
    ).toBe(state);
    // Without sequence numbers an equal update_id proves nothing.
    const legacy = reduceLiveState(EMPTY_LIVE_STATE, story("5"));
    expect(reduceLiveState(legacy, story("5", snapshot("2")))).not.toBe(legacy);
  });

  it("queues effects in order beside the story and clears them on the next story", () => {
    let state: LiveState = reduceLiveState(EMPTY_LIVE_STATE, story("1"));
    state = reduceLiveState(state, update("effect", "2", snapshot("2")));
    state = reduceLiveState(state, update("effect", "3", snapshot("3")));
    expect(state.update?.update_id).toBe("1");
    expect(state.effects.map((effect) => effect.update_id)).toEqual(["2", "3"]);
    expect(state.update?.snapshot.revision).toBe("3");
    state = reduceLiveState(state, story("4", snapshot("4")));
    expect(state.effects).toEqual([]);
  });

  it("bounds a stalled effect queue", () => {
    let state: LiveState = reduceLiveState(EMPTY_LIVE_STATE, story("1"));
    for (let index = 0; index < MAX_PENDING_EFFECTS + 10; index += 1) {
      state = reduceLiveState(
        state,
        update("effect", `e${index}`, snapshot(String(index + 2))),
      );
    }
    expect(state.effects).toHaveLength(MAX_PENDING_EFFECTS);
    expect(state.effects.at(-1)?.update_id).toBe(`e${MAX_PENDING_EFFECTS + 9}`);
  });

  it("never mixes sessions", () => {
    const state = reduceLiveState(EMPTY_LIVE_STATE, story("1"));
    const next = reduceLiveState(
      state,
      update("effect", "2", snapshot("2"), { session_id: "2" }),
    );
    expect(next.update?.session_id).toBe("2");
    expect(next.effects).toEqual([]);
  });
});

describe("prompt helpers", () => {
  it("derives the occurrence from prompt_instance, falling back to update_id", () => {
    expect(promptOccurrence(story("7", snapshot("1")))).toBe("10");
    expect(
      promptOccurrence(story("7", snapshot("1", { interaction: {} }))),
    ).toBe("7");
  });

  it("reads advance blocks and their visible hints", () => {
    const blocked = snapshot("1", {
      interaction: {
        blocks: [
          { id: "a", source: "main", source_scene: "s", message: "稍等" },
          { id: "b", source: "secondary", source_scene: "t", message: "稍等" },
          { id: "c", source: "main", source_scene: "s", message: "" },
        ],
      },
    });
    expect(isAdvanceBlocked(blocked)).toBe(true);
    expect(advanceBlockMessages(blocked)).toEqual(["稍等"]);
    expect(isAdvanceBlocked(snapshot("1"))).toBe(false);
  });

  it("compares structurally, including bigint scalars", () => {
    expect(deepEqual({ a: [1n, "x"] }, { a: [1n, "x"] })).toBe(true);
    expect(deepEqual({ a: 1n }, { a: 2n })).toBe(false);
    expect(deepEqual([1], [1, 2])).toBe(false);
    expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
  });
});
