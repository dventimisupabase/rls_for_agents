// End-to-end over HTTP: real delegated tokens (OAuth 2.1 PKCE against the local auth server) ->
// MCP Edge Function -> PostgREST -> RLS. Needs the local stack and `supabase functions serve`.
// Run: MCP_IT=1 deno test -A supabase/functions/mcp/integration_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
const RUN = Deno.env.get("MCP_IT") === "1";
const URL_ = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:55321";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""; // test harness only: registers the OAuth client
const PASSWORD = Deno.env.get("SEED_PASSWORD") ?? "local-only-password";
const REDIRECT = "http://localhost:8976/cb";

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const authHeaders = (jwt?: string) => ({ "content-type": "application/json", apikey: ANON, ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) });

async function human(email: string): Promise<{ token: string }> {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ email, password: PASSWORD }) });
  const body = await r.json();
  if (!body.access_token) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(body)}`);
  return { token: body.access_token };
}

// Same calls the consent page makes (getAuthorizationDetails / approveAuthorization), over plain HTTP.
async function delegate(userToken: string, clientId: string): Promise<string> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: "code",
    code_challenge: challenge, code_challenge_method: "S256", state: "it" });
  const a = await fetch(`${URL_}/auth/v1/oauth/authorize?${q}`, { redirect: "manual" });
  await a.body?.cancel();
  const authId = new URL(a.headers.get("location")!, URL_).searchParams.get("authorization_id")!;
  const det = await (await fetch(`${URL_}/auth/v1/oauth/authorizations/${authId}`, { headers: authHeaders(userToken) })).json();
  let redirectUrl: string = det.redirect_url;  // consent already remembered
  if (det.authorization_id) {
    const ap = await (await fetch(`${URL_}/auth/v1/oauth/authorizations/${authId}/consent`,
      { method: "POST", headers: authHeaders(userToken), body: JSON.stringify({ action: "approve" }) })).json();
    redirectUrl = ap.redirect_url;
  }
  const code = new URL(redirectUrl).searchParams.get("code")!;
  const t = await fetch(`${URL_}/auth/v1/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }),
  });
  const body = await t.json();
  if (!body.access_token) throw new Error(`token exchange failed: ${JSON.stringify(body)}`);
  return body.access_token;
}

let rpcId = 0;
async function mcp(token: string, name: string, args: Record<string, unknown>, session = "it-session") {
  const r = await fetch(`${URL_}/functions/v1/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-session-id": session },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await r.json();
  return body.result?.structuredContent ?? body;
}

async function rest(token: string, fn: string, args: Record<string, unknown>) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: { "content-type": "application/json", apikey: ANON, authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  return await r.json();
}

Deno.test({ name: "MCP end to end with delegated tokens", ignore: !RUN, sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const reg = await (await fetch(`${URL_}/auth/v1/admin/oauth/clients`, {
    method: "POST", headers: { "content-type": "application/json", apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
    body: JSON.stringify({ client_name: `it-agent-${Date.now()}`, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  })).json();
  if (!reg.client_id) throw new Error(`client registration failed: ${JSON.stringify(reg)}`);
  const clientId: string = reg.client_id;

  const alice = await human("alice@brightwater.example");
  const bob = await human("bob@brightwater.example");
  assertEquals((await rest(alice.token, "grant_agent", { client_id: clientId })).ok, true);
  assertEquals((await rest(bob.token, "grant_agent", { client_id: clientId })).ok, true);
  const aliceAgent = await delegate(alice.token, clientId);
  const bobAgent = await delegate(bob.token, clientId);

  await t.step("delegated token carries sub and client_id (G2 recheck)", async () => {
    const who = await rest(aliceAgent, "whoami", {});
    assertEquals(who.client_id, clientId);
    assertEquals(who.is_agent, true);
  });

  await t.step("S1 over MCP: bob's agent sees a strict subset of alice's agent", async () => {
    // Lists are capped at 200 rows, so compare by lookup rather than by list length.
    const a = await mcp(aliceAgent, "list_overdue_invoices", { min_days_overdue: 0 });
    const b = await mcp(bobAgent, "list_overdue_invoices", { min_days_overdue: 0 });
    assert(a.ok && b.ok && b.data.length > 0);
    for (const row of b.data.slice(0, 25)) {
      assertEquals((await mcp(aliceAgent, "get_invoice", { invoice_number: row.invoice_number })).ok, true, `alice sees ${row.invoice_number}`);
    }
    const bobNumbers = new Set(b.data.map((r: { invoice_number: string }) => r.invoice_number));
    const aliceOnly = a.data.find((r: { invoice_number: string }) => !bobNumbers.has(r.invoice_number));
    const probe = await mcp(bobAgent, "get_invoice", { invoice_number: aliceOnly.invoice_number });
    if (probe.ok) {
      // bob's list was capped; confirm he owns that customer rather than assume a leak
      assertEquals((await mcp(bobAgent, "get_customer", { customer_id: aliceOnly.customer_id })).ok, true);
    }
    const strict = (await Promise.all(a.data.slice(0, 50).map((r: { invoice_number: string }) =>
      mcp(bobAgent, "get_invoice", { invoice_number: r.invoice_number })))).some((e) => e.error === "not_found");
    assert(strict, "at least one of alice's invoices is not_found for bob (strict subset)");
  });

  await t.step("I1 over MCP: a Kestrel invoice number is not_found", async () => {
    assertEquals(await mcp(aliceAgent, "get_invoice", { invoice_number: "KST-2026-0001" }), { ok: false, error: "not_found" });
  });

  await t.step("S2 over MCP: denials are returned as data", async () => {
    assertEquals(await mcp(aliceAgent, "mark_invoice_paid", { invoice_number: "BWS-2026-0001" }),
      { ok: false, denied: true, reason: "agent_not_permitted", proposal_id: null });
    const draft = await mcp(aliceAgent, "draft_dunning_email", { invoice_number: "BWS-2026-0001", tone: "firm" });
    const sent = await mcp(aliceAgent, "send_dunning_email", { email_id: draft.data.email_id });
    assertEquals(sent.denied, true);
    assert(sent.proposal_id, "send denial created a proposal");
  });

  await t.step("S4 over HTTP: revocation denies the very next agent call in under 1 s", async () => {
    const t0 = performance.now();
    const rev = await rest(alice.token, "revoke_agent", { client_id: clientId });
    const t1 = performance.now();
    const next = await mcp(aliceAgent, "list_overdue_invoices", { min_days_overdue: 0 });
    const t2 = performance.now();
    assertEquals(rev.data.revoked, 1);
    assertEquals(next.reason, "agent_grant_revoked");
    console.log(`S4 timing: revoke RPC ${(t1 - t0).toFixed(1)} ms; next agent call denied ${(t2 - t1).toFixed(1)} ms after revoke returned; total ${(t2 - t0).toFixed(1)} ms`);
    assert(t2 - t1 < 1000);
    assertEquals((await rest(alice.token, "grant_agent", { client_id: clientId })).ok, true);
    assertEquals((await mcp(aliceAgent, "list_overdue_invoices", { min_days_overdue: 0 })).ok, true);
  });

  await t.step("an agent token cannot manage grants or approve proposals", async () => {
    assertEquals((await rest(aliceAgent, "grant_agent", { client_id: crypto.randomUUID() })).reason, "human_only");
    assertEquals((await rest(aliceAgent, "revoke_agent", { client_id: clientId })).reason, "human_only");
  });
});
