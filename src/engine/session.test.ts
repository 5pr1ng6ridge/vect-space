import { describe, expect, it } from "vitest";
import { requireSessionId, SessionTransitionController } from "./session";

describe("SessionTransitionController", () => {
  it("only keeps the newest token current", () => {
    const controller = new SessionTransitionController();
    const first = controller.begin(1, "7");
    const second = controller.begin(2, "8");

    expect(controller.isCurrent(first, 1, "7")).toBe(false);
    expect(controller.isCurrent(second, 2, "8")).toBe(true);
    expect(controller.isCurrentGeneration(second, 2)).toBe(true);
    expect(controller.isCurrentGeneration(second, 1)).toBe(false);

    controller.invalidate();
    expect(controller.isCurrent(second, 2, "8")).toBe(false);
  });

  it("accepts only canonical non-negative session IDs", () => {
    expect(requireSessionId("0")).toBe("0");
    expect(requireSessionId("18446744073709551615")).toBe(
      "18446744073709551615",
    );
    expect(() => requireSessionId(undefined)).toThrow();
    expect(() => requireSessionId("01")).toThrow();
    expect(() => requireSessionId("-1")).toThrow();
    expect(() => requireSessionId("18446744073709551616")).toThrow();
  });
});
