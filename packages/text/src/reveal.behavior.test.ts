import { describe, expect, it } from "vitest";

import { TextRevealSession } from "./reveal";
import { parseMarkup } from "./markup";

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

  it("distinguishes completing a live reveal from restoring a saved presentation", () => {
    const session = new TextRevealSession({
      units: parseMarkup("恢复"),
      initialCps: 30,
      defaultCps: 30,
    });
    expect(session.completeReveal().state.restored).toBe(false);
    expect(session.restorePresentation().state.restored).toBe(true);
  });
});
