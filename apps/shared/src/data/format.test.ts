import { describe, expect, it } from "vitest";
import { daysOverdue, money, totalsByCurrency } from "./format.ts";

describe("money", () => {
  it("formats per currency", () => {
    expect(money(1200, "USD")).toBe("$1,200.00");
    expect(money("300.5", "EUR")).toBe("€300.50");
    expect(money(10, "GBP")).toBe("£10.00");
  });
});

describe("daysOverdue", () => {
  const today = new Date("2026-10-27T15:00:00Z");
  it("counts whole days past the due date", () => {
    expect(daysOverdue("2026-10-17", today)).toBe(10);
    expect(daysOverdue("2026-10-27", today)).toBe(0);
    expect(daysOverdue("2026-11-01", today)).toBe(-5);
  });
});

describe("totalsByCurrency", () => {
  it("sums rows per currency, largest first", () => {
    expect(totalsByCurrency([
      { currency: "EUR", amount: "10" }, { currency: "USD", amount: "100" }, { currency: "EUR", amount: "5.5" },
    ])).toEqual([{ currency: "USD", amount: 100 }, { currency: "EUR", amount: 15.5 }]);
  });
});
