import { describe, expect, it } from "vitest";

import { advanceVirtualElapsed } from "@vectspace/presentation-core/virtual-clock";

describe("dynamic presentation clock", () => {
  it("changes the speed of the remaining virtual time without jumping state", () => {
    let elapsed = advanceVirtualElapsed(0, 100, 1, 1_000);
    expect(elapsed).toBe(100);
    elapsed = advanceVirtualElapsed(elapsed, 50, 8, 1_000);
    expect(elapsed).toBe(500);
    elapsed = advanceVirtualElapsed(elapsed, 100, 1, 1_000);
    expect(elapsed).toBe(600);
  });

  it("clamps completion and rejects invalid rates", () => {
    expect(advanceVirtualElapsed(900, 100, 8, 1_000)).toBe(1_000);
    expect(advanceVirtualElapsed(100, 50, 0, 1_000)).toBe(150);
  });
});
