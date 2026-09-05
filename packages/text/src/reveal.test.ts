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
});
