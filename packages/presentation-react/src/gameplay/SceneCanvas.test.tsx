import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UiMotionHost } from "@vectspace/presentation-core/ui-motion";
import type {
  PresentationOutcome,
  RuntimeUpdate,
  Settings,
} from "@vectspace/presentation-core/types";

import { SceneCanvas } from "./SceneCanvas";

interface Deferred {
  resolve(outcome: PresentationOutcome): void;
}

const fake = vi.hoisted(() => {
  interface Call {
    updateId: string;
  }
  const state = {
    presents: [] as Call[],
    effects: [] as Call[],
    cancelled: [] as string[],
    presentGates: [] as ((outcome: PresentationOutcome) => void)[],
    effectGates: [] as ((outcome: PresentationOutcome) => void)[],
    current: null as string | null,
  };
  class FakeController {
    init(): Promise<void> {
      return Promise.resolve();
    }
    destroy(): void {}
    applySettings(): void {}
    setPlaybackMode(): void {}
    setPaused(): void {}
    setAnimationAssets(): void {}
    setTypingSfx(): Promise<void> {
      return Promise.resolve();
    }
    isPresentationCurrent(updateId: string): boolean {
      return state.current === updateId;
    }
    present(update: RuntimeUpdate): Promise<PresentationOutcome> {
      state.presents.push({ updateId: update.update_id });
      state.current = update.update_id;
      return new Promise((resolve) => state.presentGates.push(resolve));
    }
    runEffect(update: RuntimeUpdate): Promise<PresentationOutcome> {
      state.effects.push({ updateId: update.update_id });
      return new Promise((resolve) => state.effectGates.push(resolve));
    }
    cancelEffectsOf(owner: string): void {
      state.cancelled.push(owner);
    }
  }
  return { state, FakeController };
});

vi.mock("@vectspace/presentation-core/gameplay-host", () => ({
  PresentationController: fake.FakeController,
}));

const SETTINGS: Settings = {
  master_volume: 1,
  bgm_volume: 1,
  sfx_volume: 1,
  video_volume: 1,
  ambience_volume: 1,
  text_speed_cps: 30,
  text_reveal_animation: "typewriter",
  skip_mode: "disabled",
};

function update(
  id: string,
  options: {
    kind?: RuntimeUpdate["kind"];
    revision?: string;
    ack?: boolean;
    timer?: string;
    repeating?: boolean;
  } = {},
): RuntimeUpdate {
  return {
    session_id: "1",
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.timer === undefined ? {} : { effect_timer: options.timer }),
    update_id: id,
    requires_ack: options.ack ?? false,
    cues: [],
    snapshot: {
      revision: options.revision ?? id,
      interaction:
        options.timer !== undefined && options.repeating === true
          ? {
              timers: {
                [options.timer]: {
                  target: "x",
                  remaining_ms: 100,
                  interval_ms: 100,
                },
              },
            }
          : {},
    },
  } as unknown as RuntimeUpdate;
}

interface Harness {
  rerender(props: Partial<ViewProps>): void;
  onSettled: ReturnType<typeof vi.fn>;
}

interface ViewProps {
  update: RuntimeUpdate | null;
  effects: readonly RuntimeUpdate[];
  activeTimers: readonly string[] | null;
}

const uiMotionHost = new UiMotionHost();

function mount(initial: ViewProps): Harness {
  const onSettled = vi.fn();
  const view = (props: ViewProps) => (
    <SceneCanvas
      activeTimers={props.activeTimers}
      animations={{}}
      assets={{}}
      effects={props.effects}
      onDiagnostic={() => undefined}
      onSettled={onSettled}
      paused={false}
      playbackRate={1}
      settings={SETTINGS}
      suppressOneShots={false}
      typingSfxActive={false}
      typingSfxCps={30}
      uiMotionHost={uiMotionHost}
      update={props.update}
      visible
    />
  );
  const { rerender } = render(view(initial));
  let current = initial;
  return {
    onSettled,
    rerender: (next) => {
      current = { ...current, ...next };
      rerender(view(current));
    },
  };
}

beforeEach(() => {
  fake.state.presents = [];
  fake.state.effects = [];
  fake.state.cancelled = [];
  fake.state.presentGates = [];
  fake.state.effectGates = [];
  fake.state.current = null;
});

afterEach(cleanup);

describe("SceneCanvas live updates", () => {
  it("keeps the running presentation and its settle across a refresh", async () => {
    const story = update("5", { ack: true, revision: "5" });
    const harness = mount({ update: story, effects: [], activeTimers: null });
    await waitFor(() => expect(fake.state.presents).toHaveLength(1));

    // A refresh replaces the object (new snapshot) but not the story identity.
    harness.rerender({
      update: { ...story, snapshot: update("5", { revision: "6" }).snapshot },
    });
    harness.rerender({
      update: { ...story, snapshot: update("5", { revision: "7" }).snapshot },
    });
    expect(fake.state.presents).toHaveLength(1);

    const gate: Deferred = { resolve: fake.state.presentGates[0] as never };
    await act(async () => {
      gate.resolve("completed");
      await Promise.resolve();
    });
    // The settle that was already attached reports once, with the newest
    // snapshot of the same story update, and nothing was orphaned.
    await waitFor(() => expect(harness.onSettled).toHaveBeenCalledTimes(1));
    const [settled, outcome] = harness.onSettled.mock.calls[0] as [
      RuntimeUpdate,
      string,
    ];
    expect(settled.update_id).toBe("5");
    expect((settled.snapshot as { revision: string }).revision).toBe("7");
    expect(outcome).toBe("completed");
  });

  it("presents again for a new story update", async () => {
    const harness = mount({
      update: update("5"),
      effects: [],
      activeTimers: null,
    });
    await waitFor(() => expect(fake.state.presents).toHaveLength(1));
    harness.rerender({ update: update("6") });
    await waitFor(() => expect(fake.state.presents).toHaveLength(2));
    expect(fake.state.presents.map((call) => call.updateId)).toEqual([
      "5",
      "6",
    ]);
  });

  it("runs every effect once, in order, beside the story", async () => {
    const story = update("5");
    const harness = mount({ update: story, effects: [], activeTimers: null });
    await waitFor(() => expect(fake.state.presents).toHaveLength(1));

    const first = update("6", { kind: "effect" });
    const second = update("7", { kind: "effect" });
    harness.rerender({ effects: [first, second] });
    await waitFor(() => expect(fake.state.effects).toHaveLength(2));
    expect(fake.state.effects.map((call) => call.updateId)).toEqual(["6", "7"]);

    // Re-rendering the same queue never re-runs an effect...
    harness.rerender({ effects: [first, second] });
    harness.rerender({
      update: { ...story, snapshot: update("5", { revision: "9" }).snapshot },
    });
    expect(fake.state.effects).toHaveLength(2);
    // ...and a longer queue only runs its new tail.
    harness.rerender({
      effects: [first, second, update("8", { kind: "effect" })],
    });
    await waitFor(() => expect(fake.state.effects).toHaveLength(3));
    expect(fake.state.effects[2]?.updateId).toBe("8");
    // The story presentation was never restarted by any of it.
    expect(fake.state.presents).toHaveLength(1);
    expect(harness.onSettled).not.toHaveBeenCalled();
  });

  it("settles an effect only when the host asked for an acknowledgement", async () => {
    const harness = mount({
      update: update("5"),
      effects: [],
      activeTimers: null,
    });
    await waitFor(() => expect(fake.state.presents).toHaveLength(1));
    const plain = update("6", { kind: "effect" });
    const gated = update("7", { kind: "effect", ack: true });
    harness.rerender({ effects: [plain, gated] });
    await waitFor(() => expect(fake.state.effects).toHaveLength(2));
    await act(async () => {
      (fake.state.effectGates[0] as (o: PresentationOutcome) => void)(
        "completed",
      );
      (fake.state.effectGates[1] as (o: PresentationOutcome) => void)(
        "completed",
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(harness.onSettled).toHaveBeenCalledTimes(1));
    expect(
      (harness.onSettled.mock.calls[0]?.[0] as RuntimeUpdate).update_id,
    ).toBe("7");
  });

  it("cancels only the effects of a repeating timer that was stopped", async () => {
    const harness = mount({
      update: update("5"),
      effects: [],
      activeTimers: ["pulse", "once"],
    });
    await waitFor(() => expect(fake.state.presents).toHaveLength(1));
    harness.rerender({
      effects: [
        update("6", { kind: "effect", timer: "pulse", repeating: true }),
        // A one-shot timer was already removed when it fired.
        update("7", { kind: "effect", timer: "once", repeating: false }),
      ],
      activeTimers: ["pulse"],
    });
    await waitFor(() => expect(fake.state.effects).toHaveLength(2));
    expect(fake.state.cancelled).toEqual([]);

    // The live state no longer lists the repeating timer: it was stopped.
    harness.rerender({ activeTimers: [] });
    await waitFor(() => expect(fake.state.cancelled).toEqual(["pulse"]));
    // The one-shot's animation runs to completion; it is never cancelled.
    harness.rerender({ activeTimers: [] });
    expect(fake.state.cancelled).toEqual(["pulse"]);
  });

  it("does not start another cycle for a repeating timer already shown as stopped", async () => {
    const harness = mount({
      update: update("5"),
      effects: [],
      activeTimers: [],
    });
    await waitFor(() => expect(fake.state.presents).toHaveLength(1));
    harness.rerender({
      effects: [
        update("6", { kind: "effect", timer: "pulse", repeating: true }),
      ],
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fake.state.effects).toHaveLength(0);
  });
});
