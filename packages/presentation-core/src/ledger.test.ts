import { describe, expect, it } from "vitest";
import { BoundedLedger } from "./ledger";

describe("BoundedLedger", () => {
  it("evicts the oldest entry at capacity and supports rewind deletion", () => {
    const ledger = new BoundedLedger<string>(2);

    expect(ledger.consume("a")).toBe(true);
    expect(ledger.consume("b")).toBe(true);
    expect(ledger.consume("a")).toBe(false);
    expect(ledger.consume("c")).toBe(true);
    expect(ledger.has("a")).toBe(false);
    expect(ledger.has("b")).toBe(true);
    expect(ledger.has("c")).toBe(true);

    ledger.delete("b");
    expect(ledger.has("b")).toBe(false);
    expect(ledger.consume("b")).toBe(true);
  });
});
