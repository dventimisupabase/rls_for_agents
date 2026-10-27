import { describe, expect, it } from "vitest";
import { argSummary, bySession } from "./activity.ts";

describe("argSummary", () => {
  it("lists set arguments as key: value, skipping nulls", () => {
    expect(argSummary({ invoice_number: "BWS-1", tone: "firm", customer_id: null })).toBe("invoice_number: BWS-1, tone: firm");
  });
  it("shortens long values", () => {
    expect(argSummary({ memo: "x".repeat(100) })).toBe(`memo: ${"x".repeat(47)}...`);
  });
  it("shows non-string values as JSON and handles no arguments", () => {
    expect(argSummary({ min_days_overdue: 360, flags: [1, 2] })).toBe("min_days_overdue: 360, flags: [1,2]");
    expect(argSummary({})).toBe("");
  });
});

describe("bySession", () => {
  const c = (session_id: string | null, n: number) => ({ session_id, n });
  it("groups consecutive calls of one conversation, keeping order", () => {
    expect(bySession([c("a", 1), c("a", 2), c("b", 3), c("a", 4), c(null, 5)])).toEqual([
      { session_id: "a", calls: [c("a", 1), c("a", 2)] },
      { session_id: "b", calls: [c("b", 3)] },
      { session_id: "a", calls: [c("a", 4)] },
      { session_id: null, calls: [c(null, 5)] },
    ]);
  });
});
