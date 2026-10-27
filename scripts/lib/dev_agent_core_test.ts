import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { appOrigin, claims, corsHeaders, parseScript, PendingStates, simulated } from "./dev_agent_core.ts";

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
  const s = p.create("alice", "verifier-1", "http://localhost:3001");
  assertEquals(s.length >= 32, true);
  assertEquals(p.take(s), { sub: "alice", verifier: "verifier-1", origin: "http://localhost:3001" });
  assertEquals(p.take(s), null);  // single use
  const s2 = p.create("bob", "v2", "http://localhost:3000");
  now += 600_001;
  assertEquals(p.take(s2), null);  // expired
  assertEquals(p.take("guess"), null);
});

const APPS = ["http://localhost:3000", "http://localhost:3001"];

Deno.test("appOrigin: an allowed origin is kept; anything else falls back to the first app", () => {
  assertEquals(appOrigin("http://localhost:3001", APPS), "http://localhost:3001");
  assertEquals(appOrigin("http://localhost:3000", APPS), "http://localhost:3000");
  // never an open redirect: the callback only ever returns to an app on the list
  assertEquals(appOrigin("https://evil.example", APPS), "http://localhost:3000");
  assertEquals(appOrigin("http://localhost:3001.evil.example", APPS), "http://localhost:3000");
  assertEquals(appOrigin(null, APPS), "http://localhost:3000");
});

Deno.test("corsHeaders: echoes only an allowed origin", () => {
  assertEquals(corsHeaders("http://localhost:3001", APPS)["access-control-allow-origin"], "http://localhost:3001");
  assertEquals(corsHeaders("https://evil.example", APPS)["access-control-allow-origin"], undefined);
  assertEquals(corsHeaders(null, APPS)["access-control-allow-origin"], undefined);
  assertEquals(corsHeaders("https://evil.example", APPS).vary, "origin");
});

Deno.test("simulated: scripted mode can stand in for the runtime's kill switch and limits", () => {
  assertEquals(simulated("/simulate paused"), "paused");
  assertEquals(simulated("  /simulate limit_reached\n"), "limit_reached");
  assertEquals(simulated("/simulate internal"), "internal");  // a turn that fails inside the runtime
  assertEquals(simulated("/simulate access_revoked"), null);  // nothing identity-related
  assertEquals(simulated("/call whoami"), null);
  assertEquals(simulated("hello"), null);
});
