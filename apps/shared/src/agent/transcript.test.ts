import { describe, expect, it } from "vitest";
import { badgesFor, reduce, type Transcript } from "./transcript.ts";

describe("badgesFor (from the section 4.4 envelope only)", () => {
  it("ok", () => expect(badgesFor("get_invoice", { ok: true, data: {} })).toEqual(["ok"]));
  it("a successful proposal tool is a proposal", () =>
    expect(badgesFor("propose_payment_match", { ok: true, data: { proposal_id: "p1" } })).toEqual(["proposal"]));
  it("denied", () => expect(badgesFor("mark_invoice_paid", { ok: false, denied: true, reason: "agent_not_permitted" })).toEqual(["denied"]));
  it("denied with an auto-created proposal shows both", () =>
    expect(badgesFor("send_dunning_email", { ok: false, denied: true, reason: "agent_not_permitted", proposal_id: "p2" }))
      .toEqual(["denied", "proposal"]));
  it("error", () => expect(badgesFor("get_invoice", { ok: false, error: "not_found" })).toEqual(["error"]));
});

describe("reduce", () => {
  it("builds turns: user text, assistant text, tool chips matched by id", () => {
    let t: Transcript = [];
    t = reduce(t, { type: "user", text: "pay it" });
    t = reduce(t, { type: "text", text: "Trying." });
    t = reduce(t, { type: "tool_call", id: "1", name: "mark_invoice_paid", args: { invoice_number: "X" } });
    t = reduce(t, { type: "tool_result", id: "1", name: "mark_invoice_paid", envelope: { ok: false, denied: true, reason: "agent_not_permitted" } });
    t = reduce(t, { type: "text", text: "Denied." });
    t = reduce(t, { type: "done" });
    expect(t.map((x) => x.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    const tool = t[2] as Extract<Transcript[number], { kind: "tool" }>;
    expect(tool.badges).toEqual(["denied"]);
    expect(tool.reason).toBe("agent_not_permitted");
    expect(tool.pending).toBe(false);
  });
  it("a read that returns a list records how many rows came back (beat 1: same question, different answers)", () => {
    let t = reduce([], { type: "tool_call", id: "1", name: "list_overdue_invoices", args: {} });
    t = reduce(t, { type: "tool_result", id: "1", name: "list_overdue_invoices", envelope: { ok: true, data: [{}, {}, {}] } });
    expect(t[0]).toMatchObject({ rows: 3 });
    t = reduce(t, { type: "tool_call", id: "2", name: "get_invoice", args: {} });
    t = reduce(t, { type: "tool_result", id: "2", name: "get_invoice", envelope: { ok: true, data: { id: "x" } } });
    expect((t[1] as { rows?: number }).rows).toBeUndefined();
  });
  it("a tool call without a result yet is pending", () => {
    const t = reduce([], { type: "tool_call", id: "1", name: "get_invoice", args: {} });
    expect(t[0]).toMatchObject({ kind: "tool", pending: true, badges: [] });
  });
  it("consent and errors become notices", () => {
    expect(reduce([], { type: "consent_required", url: "https://x" })[0]).toMatchObject({ kind: "notice", tone: "consent", url: "https://x" });
    expect(reduce([], { type: "error", code: "access_revoked", message: "m" })[0]).toMatchObject({ kind: "notice", tone: "error", code: "access_revoked" });
  });
  it("errors that pass on their own (paused, a limit, unreachable) offer to send the message again", () => {
    for (const code of ["paused", "limit_reached", "unreachable"])
      expect(reduce([], { type: "error", code, message: "m" })[0]).toMatchObject({ kind: "notice", retry: true });
    for (const code of ["access_revoked", "unauthorized", "not_configured", "internal"])
      expect(reduce([], { type: "error", code, message: "m" })[0]).not.toHaveProperty("retry");
  });
});
