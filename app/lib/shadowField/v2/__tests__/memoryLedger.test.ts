import { describe, expect, it } from "vitest";
import { MemoryLedger } from "../memoryLedger";

describe("numeric memory ledger", () => {
  it("accounts exact reservations and fails a budget without evicting evidence", () => {
    const ledger = new MemoryLedger(10);
    expect(ledger.reserve("page:a", 6, "page")).toBe(true);
    expect(ledger.reserve("page:b", 5, "page")).toBe(false);
    expect(ledger.snapshot()).toMatchObject({ resident: 6, peak: 6, byKind: { page: 6 } });
    expect(ledger.release("page:a")).toBe(6);
  });
});
