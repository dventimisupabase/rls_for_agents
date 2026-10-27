import { describe, expect, it } from "vitest";
import { MEMO_MAX, parseAmount, sendKestrelPayment } from "./kestrel.ts";

describe("parseAmount", () => {
  it("takes what people type: 120, 120.5, $1,250.00", () => {
    expect(parseAmount("120")).toBe(120);
    expect(parseAmount(" 120.5 ")).toBe(120.5);
    expect(parseAmount("$1,250.00")).toBe(1250);
  });
  it("refuses anything the bank feed would refuse (the database checks again)", () => {
    for (const s of ["", "0", "-5", "abc", "10.001", "50000.01", "1e3"]) expect(parseAmount(s)).toBeNull();
    expect(parseAmount("50000")).toBe(50000);
  });
});

describe("sendKestrelPayment", () => {
  const rpc = (data: unknown, error: { message: string } | null = null, calls: unknown[] = []) =>
    ({ rpc: async (fn: string, args: unknown) => { calls.push([fn, args]); return { data, error }; } });

  it("sends amount and memo and reports how many sends are left in the window", async () => {
    const calls: unknown[] = [];
    const r = await sendKestrelPayment(rpc({ ok: true, data: { payment_id: "p1", sent_in_window: 2, limit: 5 } }, null, calls), 120.5, "hello");
    expect(calls).toEqual([["send_kestrel_payment", { amount: 120.5, memo: "hello" }]]);
    expect(r).toEqual({ ok: true, left: 3 });
  });

  it("says plainly why a send was refused", async () => {
    expect(await sendKestrelPayment(rpc({ ok: false, denied: true, reason: "rate_limited" }), 1, "m"))
      .toEqual({ ok: false, message: "That's 5 payments in 10 minutes. Wait a few minutes before sending another." });
    expect((await sendKestrelPayment(rpc({ ok: false, error: "invalid_input" }), 1, "m")).ok).toBe(false);
    expect(await sendKestrelPayment(rpc(null, { message: "network down" }), 1, "m")).toEqual({ ok: false, message: "network down" });
  });

  it("caps the memo where the database does", () => {
    expect(MEMO_MAX).toBe(280);
  });
});
