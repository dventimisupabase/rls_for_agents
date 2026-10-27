import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { claims, parseScript, PendingStates } from "./dev_agent_core.ts";

const tok = (p: object) => `x.${btoa(JSON.stringify(p)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.y`;

Deno.test("parseScript: /call lines become tool calls, other lines are ignored", () => {
  assertEquals(parseScript('/call get_invoice {"invoice_number":"BWS-1"}\nhello\n/call list_overdue_invoices {"min_days_overdue":30}'), [
    { name: "get_invoice", args: { invoice_number: "BWS-1" } },
    { name: "list_overdue_invoices", args: { min_days_overdue: 30 } },
  ]);
  assertEquals(parseScript("/call whoami"), [{ name: "whoami", args: {} }]);
  assertThrows(() => parseScript("/call get_invoice {not json"));
});

Deno.test("claims decodes a JWT payload", () => {
  assertEquals(claims(tok({ sub: "u1", client_id: "c1" })), { sub: "u1", client_id: "c1" });
});

Deno.test("PendingStates: single use, bound to the starting user, expires", () => {
  let now = 1_000;
  const p = new PendingStates(() => now, 600_000);
  const s = p.create("alice", "verifier-1");
  assertEquals(s.length >= 32, true);
  assertEquals(p.take(s), { sub: "alice", verifier: "verifier-1" });
  assertEquals(p.take(s), null);  // single use
  const s2 = p.create("bob", "v2");
  now += 600_001;
  assertEquals(p.take(s2), null);  // expired
  assertEquals(p.take("guess"), null);
});
