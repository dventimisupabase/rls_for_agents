import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { handleMcp, TOOLS } from "./core.ts";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Record<string, unknown>) {
  const calls: Call[] = [];
  const fn = (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const rpc = url.split("/rpc/")[1];
    const body = rpc in responses ? responses[rpc] : { ok: true, data: null };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  };
  return { fn: fn as typeof fetch, calls };
}

const cfg = (f: typeof fetch) => ({ supabaseUrl: "http://db.test", apiKey: "publishable-key", fetch: f });
const rpcReq = (method: string, params: unknown = {}, bearer: string | null = "agent-token", session = "sess-1") =>
  new Request("http://mcp.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(session ? { "x-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
  });

Deno.test("tools/list exposes exactly the contract tools, none taking tenant_id", async () => {
  const { fn } = fakeFetch({});
  const res = await handleMcp(rpcReq("tools/list"), cfg(fn));
  const body = await res.json();
  const names = body.result.tools.map((t: { name: string }) => t.name).sort();
  assertEquals(names, [
    "draft_dunning_email", "get_customer", "get_invoice", "list_customer_contacts", "list_overdue_invoices",
    "mark_invoice_paid", "propose_payment_match", "search_payments", "send_dunning_email",
  ]);
  for (const t of body.result.tools) assertFalse("tenant_id" in t.inputSchema.properties, `${t.name} takes tenant_id`);
});

Deno.test("tools/call forwards to the RPC with the caller's bearer, session header and publishable key", async () => {
  const { fn, calls } = fakeFetch({ get_invoice: { ok: true, data: { invoice_number: "BWS-2026-0042" } } });
  const res = await handleMcp(rpcReq("tools/call", { name: "get_invoice", arguments: { invoice_number: "BWS-2026-0042" } }), cfg(fn));
  const body = await res.json();
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "http://db.test/rest/v1/rpc/get_invoice");
  const h = new Headers(calls[0].init.headers);
  assertEquals(h.get("authorization"), "Bearer agent-token");
  assertEquals(h.get("apikey"), "publishable-key");
  assertEquals(h.get("x-session-id"), "sess-1");
  assertEquals(JSON.parse(String(calls[0].init.body)), { invoice_number: "BWS-2026-0042" });
  assertEquals(body.result.structuredContent, { ok: true, data: { invoice_number: "BWS-2026-0042" } });
  assertFalse(body.result.isError);
});

Deno.test("denials are returned as data, not MCP errors", async () => {
  const denied = { ok: false, denied: true, reason: "agent_not_permitted", proposal_id: null };
  const { fn } = fakeFetch({ mark_invoice_paid: denied });
  const res = await handleMcp(rpcReq("tools/call", { name: "mark_invoice_paid", arguments: { invoice_number: "X" } }), cfg(fn));
  const body = await res.json();
  assertEquals(body.result.structuredContent, denied);
  assertFalse(body.result.isError);
});

Deno.test("a missing bearer token is rejected before any database call", async () => {
  const { fn, calls } = fakeFetch({});
  const res = await handleMcp(rpcReq("tools/call", { name: "get_invoice", arguments: {} }, null), cfg(fn));
  assertEquals(res.status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("unknown tools and extra tenant_id arguments are refused", async () => {
  const { fn, calls } = fakeFetch({});
  let body = await (await handleMcp(rpcReq("tools/call", { name: "run_sql", arguments: { q: "select 1" } }), cfg(fn))).json();
  assertEquals(body.error.code, -32602);
  body = await (await handleMcp(rpcReq("tools/call", { name: "get_invoice", arguments: { invoice_number: "A", tenant_id: "x" } }), cfg(fn))).json();
  assertEquals(body.result.structuredContent, { ok: false, error: "invalid_input" });
  assertEquals(calls.length, 0);
});

Deno.test("a canary in a tool result is reported as a separate audit row", async () => {
  const { fn, calls } = fakeFetch({ get_customer: { ok: true, data: { notes: "Account code FLAG{kst-amber-otter}" } } });
  await handleMcp(rpcReq("tools/call", { name: "get_customer", arguments: { customer_id: "c" } }), cfg(fn));
  assertEquals(calls.map((c) => c.url.split("/rpc/")[1]), ["get_customer", "report_canary_hit"]);
  assertEquals(JSON.parse(String(calls[1].init.body)), { tool: "get_customer" });
  assertEquals(new Headers(calls[1].init.headers).get("authorization"), "Bearer agent-token");
});

Deno.test("initialize advertises tools; every tool has a description", async () => {
  const { fn } = fakeFetch({});
  const body = await (await handleMcp(rpcReq("initialize", { protocolVersion: "2025-06-18" }), cfg(fn))).json();
  assertEquals(body.result.protocolVersion, "2025-06-18");
  assert(body.result.capabilities.tools);
  for (const t of TOOLS) assert(t.description.length > 10);
});
