import { describe, expect, it } from "vitest";
import { aboutInvoice, invoiceBalance } from "./invoice.ts";

describe("invoiceBalance", () => {
  it("subtracts matched payments and credit notes from the amount", () => {
    expect(invoiceBalance(
      { amount: "1200.00", currency: "USD" },
      [{ amount: "300.00", currency: "USD" }, { amount: 100, currency: "USD" }],
      [{ amount: "50.50", currency: "USD" }],
    )).toEqual({ paid: 400, credited: 50.5, balance: 749.5, otherCurrency: 0 });
  });
  it("counts other-currency items separately instead of mixing them in", () => {
    expect(invoiceBalance({ amount: 100, currency: "EUR" }, [{ amount: 40, currency: "USD" }], []))
      .toEqual({ paid: 0, credited: 0, balance: 100, otherCurrency: 1 });
  });
  it("handles nothing matched", () => {
    expect(invoiceBalance({ amount: 10, currency: "GBP" }, [], [])).toEqual({ paid: 0, credited: 0, balance: 10, otherCurrency: 0 });
  });
});

describe("aboutInvoice", () => {
  const a = (id: string, summary: Record<string, unknown> | null) => ({ id, summary });
  it("keeps the actions whose summary names the invoice id", () => {
    const actions = [
      a("1", { invoice_id: "inv-1", invoice_number: "X-1" }),
      a("2", { invoice_id: "inv-2" }),
      a("3", null),
      a("4", { invoice_id: "inv-1" }),
    ];
    expect(aboutInvoice(actions, "inv-1").map((x) => x.id)).toEqual(["1", "4"]);
  });
});
