import { describe, expect, it } from "vitest";

import {
  TextRevealSession,
  createRevealPlan,
  type RevealSessionState,
} from "./reveal";
import { parseMarkup } from "./markup";

function stateAt(
  session: TextRevealSession,
  deltaMs: number,
): RevealSessionState {
  return session.advance(deltaMs).state;
}

describe("TextRevealSession", () => {
  it("keeps text after a pause hidden until the pause ends", () => {
    const session = new TextRevealSession({
      units: parseMarkup("A[pause=500ms]BC"),
      initialCps: 20,
      defaultCps: 20,
    });
    expect(stateAt(session, 49).revealedCount).toBe(0);
    const paused = session.advance(50);
    expect(paused.state.status).toBe("waiting");
    expect(paused.state.revealedCount).toBe(1);
    expect(paused.advance(499).state.revealedCount).toBe(1);
    const pauseBoundary = paused.advance(550);
    expect(pauseBoundary.state.revealedCount).toBe(1);
    expect(pauseBoundary.advance(50).state.revealedCount).toBe(2);
  });

  it("allows inline math to animate concurrently but waits for display math", () => {
    const inline = new TextRevealSession({
      units: parseMarkup("A$x$B"),
      initialCps: 20,
      defaultCps: 20,
      mathRevealDurations: new Map([[1, 400]]),
      animation: "drop_fade",
      waitForInlineMath: false,
    });
    expect(inline.advance(150).state.revealedCount).toBe(3);
    expect(inline.state.completionMs).toBeGreaterThan(150);

    const block = new TextRevealSession({
      units: parseMarkup("A$$x$$B"),
      initialCps: 20,
      defaultCps: 20,
      mathRevealDurations: new Map([[1, 400]]),
      animation: "drop_fade",
      waitForInlineMath: false,
    });
    expect(block.advance(150).state.revealedCount).toBe(2);
  });

  it("does not leak a post-pause character while a drop-fade formula settles", () => {
    const session = new TextRevealSession({
      units: parseMarkup("A$x$[pause=100ms]B"),
      initialCps: 20,
      defaultCps: 20,
      mathRevealDurations: new Map([[1, 240]]),
      animation: "drop_fade",
      waitForInlineMath: false,
    });

    // The pause begins only after the inline formula's concurrent animation.
    // A large frame is still bounded at the pause start/end, so B cannot be
    // exposed in the same frame as the pause completion.
    const waiting = session.advance(340);
    expect(waiting.state).toMatchObject({
      status: "waiting",
      revealedCount: 2,
    });
    const pauseEnd = waiting.advance(1_000);
    expect(pauseEnd.state.revealedCount).toBe(2);
    expect(pauseEnd.advance(50).state.revealedCount).toBe(3);
  });

  it("separates completion from restoring a saved presentation", () => {
    const session = new TextRevealSession({
      units: parseMarkup("完整"),
      initialCps: 20,
      defaultCps: 20,
    });
    expect(session.completeReveal().state.restored).toBe(false);
    expect(session.restorePresentation().state.restored).toBe(true);
    expect(session.cancel().state.status).toBe("cancelled");
  });

  it("supports explicit pause and resume without changing virtual time", () => {
    const session = new TextRevealSession({
      units: parseMarkup("ABC"),
      initialCps: 20,
      defaultCps: 20,
    }).advance(50);
    const frozen = session.pause();
    expect(frozen.advance(100).state.elapsedMs).toBe(50);
    expect(frozen.resume().advance(50).state.revealedCount).toBe(2);
  });

  it("creates a plan with source-aware pause metadata", () => {
    const plan = createRevealPlan({
      units: parseMarkup("A[pause=100ms]B"),
      initialCps: 10,
      defaultCps: 10,
    });
    expect(plan.pauses[0]).toMatchObject({ startMs: 100, endMs: 200 });
    expect(plan.events.map((event) => event.atMs)).toEqual([100, 300]);
  });

  it.each([
    "[pause=0ms]AB",
    "A[pause=0ms]B",
    "A[pause=0ms][pause=0ms]B",
    "AB[pause=0ms]",
  ])("treats a zero-length pause as a no-op (%s)", (source) => {
    const session = new TextRevealSession({
      units: parseMarkup(source),
      initialCps: 20,
      defaultCps: 20,
    });

    expect(session.plan.pauses).toHaveLength(0);
    expect(session.plan.completionMs).toBe(100);
    expect(session.advance(1_000).state).toMatchObject({
      status: "completed",
      elapsedMs: 100,
      revealedCount: 2,
      activePause: null,
    });
  });
});

describe("TextRevealSession timing boundaries", () => {
  it("keeps every unit after a pause hidden and includes a trailing pause", () => {
    const session = new TextRevealSession({
      units: parseMarkup("A[pause=100ms]B[pause=250ms]"),
      initialCps: 20,
      defaultCps: 20,
    });
    const duringFirstPause = session.advance(1_000);
    expect(duringFirstPause.state.status).toBe("waiting");
    expect(duringFirstPause.state.revealedCount).toBe(1);
    expect(duringFirstPause.state.activePause).toMatchObject({
      startMs: 50,
      endMs: 150,
    });
    const firstPauseEnded = duringFirstPause.advance(1_000);
    expect(firstPauseEnded.state.revealedCount).toBe(1);
    const duringTrailingPause = firstPauseEnded.advance(1_000);
    expect(duringTrailingPause.state.status).toBe("waiting");
    expect(duringTrailingPause.state.revealedCount).toBe(2);
    expect(duringTrailingPause.state.activePause).toMatchObject({
      startMs: 200,
      endMs: 450,
    });
    expect(duringTrailingPause.state.completionMs).toBe(450);
    expect(duringTrailingPause.advance(1_000).state.status).toBe("completed");
  });

  it("does not expose a unit after adjacent pauses when one frame has a large delta", () => {
    const session = new TextRevealSession({
      units: parseMarkup("A[pause=100ms][pause=200ms]B"),
      initialCps: 20,
      defaultCps: 20,
    });
    const firstPause = session.advance(10_000);
    expect(firstPause.state.revealedCount).toBe(1);
    const secondPause = firstPause.advance(10_000);
    expect(secondPause.state.revealedCount).toBe(1);
    expect(secondPause.state.activePause).toMatchObject({
      startMs: 150,
      endMs: 350,
    });
    const boundary = secondPause.advance(10_000);
    expect(boundary.state.revealedCount).toBe(1);
    expect(boundary.state.status).toBe("revealing");
    expect(boundary.advance(10_000).state.revealedCount).toBe(2);
  });

  it("starts a drop-fade inline formula pause after its animation settles", () => {
    const session = new TextRevealSession({
      units: parseMarkup("A$x$[pause=100ms]B"),
      initialCps: 20,
      defaultCps: 20,
      animation: "drop_fade",
      mathRevealDurations: new Map([[1, 320]]),
      waitForInlineMath: false,
    });
    const pause = session.plan.pauses[0];
    expect(pause?.startMs).toBe(420);
    expect(pause?.endMs).toBe(520);
    expect(session.plan.events[2]?.atMs).toBe(570);
    const atPause = session.advance(10_000);
    expect(atPause.state.revealedCount).toBe(2);
    expect(atPause.state.status).toBe("waiting");
    const pauseEnded = atPause.advance(10_000);
    expect(pauseEnded.state.revealedCount).toBe(2);
    expect(pauseEnded.advance(10_000).state.status).toBe("completed");
  });

  it("lets inline formula animation overlap while waiting for its final frame", () => {
    const session = new TextRevealSession({
      units: parseMarkup("A$x$B"),
      initialCps: 20,
      defaultCps: 20,
      animation: "drop_fade",
      mathRevealDurations: new Map([[1, 320]]),
      waitForInlineMath: false,
    });
    expect(session.plan.events.map((event) => event.atMs)).toEqual([
      50, 100, 150,
    ]);
    expect(session.plan.completionMs).toBe(420);
    expect(session.advance(150).state.revealedCount).toBe(3);
    expect(session.advance(150).state.status).toBe("revealing");
    expect(session.advance(420).state.status).toBe("completed");
  });

  it("keeps display formulas blocking even when inline formulas are concurrent", () => {
    const session = new TextRevealSession({
      units: parseMarkup("$$x$$B"),
      initialCps: 20,
      defaultCps: 20,
      animation: "drop_fade",
      mathRevealDurations: new Map([[0, 240]]),
      waitForInlineMath: false,
    });
    expect(session.plan.events[1]?.atMs).toBe(388);
    expect(session.advance(100).state.revealedCount).toBe(1);
    expect(session.advance(388).state.revealedCount).toBe(2);
  });

  it("does not mutate an old session when completing or cancelling a new one", () => {
    const session = new TextRevealSession({
      units: parseMarkup("ABC"),
      initialCps: 30,
      defaultCps: 30,
    });
    const completed = session.completeReveal();
    const cancelled = session.cancel();
    expect(session.state.status).toBe("preparing");
    expect(session.state.restored).toBe(false);
    expect(completed.state.status).toBe("completed");
    expect(completed.state.restored).toBe(false);
    expect(completed.state.revealedCount).toBe(3);
    expect(cancelled.state.status).toBe("cancelled");
  });

  describe("rebased", () => {
    const options = (text: string) => ({
      units: parseMarkup(text),
      initialCps: 20,
      defaultCps: 20,
    });

    it("keeps the revealed count when the text grows mid-reveal", () => {
      const running = new TextRevealSession(options("ABCD")).advance(120);
      expect(running.state.revealedCount).toBe(2);
      const rebased = running.rebased(options("ABCDEFGH"));
      expect(rebased.state.status).toBe("revealing");
      expect(rebased.state.revealedCount).toBe(2);
      // It then continues with the new, longer plan instead of restarting.
      expect(rebased.advance(50).state.revealedCount).toBe(3);
      expect(rebased.plan.events).toHaveLength(8);
    });

    it("clamps progress to shorter content", () => {
      const running = new TextRevealSession(options("ABCDEF")).advance(220);
      expect(running.state.revealedCount).toBe(4);
      const rebased = running.rebased(options("AB"));
      expect(rebased.state.status).toBe("completed");
      expect(rebased.state.revealedCount).toBe(2);
    });

    it("never replays a completed reveal", () => {
      const done = new TextRevealSession(options("ABC")).completeReveal();
      const rebased = done.rebased(options("ABCXYZ"));
      expect(rebased.state.status).toBe("completed");
      expect(rebased.state.revealedCount).toBe(6);
    });

    it("stays paused, and a restored presentation stays restored", () => {
      const paused = new TextRevealSession(options("ABCD"))
        .advance(120)
        .pause();
      expect(paused.rebased(options("ABCDE")).state.status).toBe("paused");
      const restored = new TextRevealSession(
        options("AB"),
      ).restorePresentation();
      expect(restored.rebased(options("ABC")).state.restored).toBe(true);
    });

    it("leaves a reveal that has not started untouched", () => {
      const fresh = new TextRevealSession(options("AB"));
      const rebased = fresh.rebased(options("XYZ"));
      expect(rebased.state.status).toBe("preparing");
      expect(rebased.state.revealedCount).toBe(0);
    });
  });
});
