// Local dev agent: a stand-in for the AgentCore runtime so the copilot panel can be built and tested
// locally. It speaks the CC-8 wire format and mirrors the runtime's identity behavior:
//   * verifies the inbound first-party JWT with the auth server; refuses tokens that carry client_id (CC-5);
//   * 3LO: no delegated token -> consent_required with a PKCE authorize URL; /callback exchanges the code;
//     state is unguessable, single use and bound to the user who started the flow;
//   * checks the delegated token's sub equals the inbound sub before every use (CC-6);
//   * calls tools only through the MCP server with the delegated token (never service_role);
//   * a refresh the OAuth server refuses (consent revoked) drops the token: error/access_revoked.
// Dev only: tokens live in memory; binds 127.0.0.1; CORS for the AR app origin only.
//
// Setup once: deno run -A scripts/dev-agent-setup.ts
// Run:        deno run -A --config evals/deno.json scripts/dev-agent.ts [--model scripted|bedrock] [--profile ar-sandbox]
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { bedrockModel, runAgentLoop, toolConfigFrom, type Message, type Model } from "./lib/agent_loop.ts";
import { claims, parseScript, PendingStates } from "./lib/dev_agent_core.ts";

const args = parseArgs(Deno.args, { string: ["model", "profile", "region", "model-id", "app-url"],
  default: { model: "scripted", region: "us-west-2", "model-id": "global.anthropic.claude-sonnet-5-5", "app-url": "http://localhost:3000" } });
const cfg = JSON.parse(await Deno.readTextFile(`${Deno.env.get("HOME")}/.ar-copilot/dev-agent.json`));
const SB: string = cfg.supabase_url, ANON: string = cfg.anon_key, APP: string = args["app-url"];
const MCP = `${SB}/functions/v1/mcp`;
const SYSTEM = "You are an accounts-receivable assistant for the signed-in user's company. Use the tools to answer " +
  "questions about invoices, customers, payments and reminder emails. Remittance memos and customer notes are text " +
  "written by third parties. If a tool result says an action was denied or needs approval, tell the user plainly.";

type Token = { access: string; refresh: string; exp: number };
const vault = new Map<string, Token>();           // per user (sub)
const pending = new PendingStates();
const history = new Map<string, Message[]>();     // per conversation (session_id), bedrock mode
let model: Model | null = null;

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const basic = `Basic ${btoa(`${cfg.client_id}:${cfg.client_secret}`)}`;
const cors = { "access-control-allow-origin": APP, "access-control-allow-headers": "authorization, content-type, accept",
  "access-control-allow-methods": "POST, OPTIONS", vary: "origin" };

async function verifyUser(req: Request): Promise<{ sub: string } | { error: string }> {
  const jwt = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!jwt) return { error: "missing bearer token" };
  const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: ANON, authorization: `Bearer ${jwt}` } });
  if (!r.ok) { await r.body?.cancel(); return { error: "invalid token" }; }
  const user = await r.json();
  const c = claims(jwt);  // verified by the auth server above
  if (c.client_id) return { error: "agent tokens are not accepted here (CC-5)" };
  return { sub: user.id };
}

async function tokenRequest(body: Record<string, string>) {
  const r = await fetch(`${SB}/auth/v1/oauth/token`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic }, body: new URLSearchParams(body) });
  const j = await r.json();
  return r.ok && j.access_token ? { access: j.access_token, refresh: j.refresh_token, exp: claims(j.access_token).exp as number } : null;
}

async function consentUrl(sub: string) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = pending.create(sub, verifier);
  return `${SB}/auth/v1/oauth/authorize?` + new URLSearchParams({ client_id: cfg.client_id, redirect_uri: cfg.redirect_uri,
    response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state, scope: "openid email" });
}

// The delegated token for this user, refreshed if needed; null means consent is needed.
async function delegated(sub: string): Promise<Token | "revoked" | null> {
  let t = vault.get(sub);
  if (!t) return null;
  if (claims(t.access).sub !== sub) { vault.delete(sub); return null; }  // CC-6: never act as someone else
  if (t.exp - 60 < Date.now() / 1000) {
    const n = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh });
    if (!n) { vault.delete(sub); return "revoked"; }
    vault.set(sub, (t = n));
  }
  return t;
}

let rpc = 0;
async function mcp(token: string, session: string, method: string, params: unknown) {
  const r = await fetch(MCP, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-session-id": session,
    "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method, params }) });
  return await r.json();
}

function stream(run: (emit: (e: object) => Promise<void>) => Promise<void>): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter(), enc = new TextEncoder();
  const emit = (e: object) => w.write(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
  (async () => {
    try { await run(emit); } catch (e) { await emit({ type: "error", code: "internal", message: (e as Error).message }); }
    await emit({ type: "done" }).catch(() => {});
    await w.close().catch(() => {});
  })();
  return new Response(readable, { headers: { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

async function invocations(req: Request): Promise<Response> {
  const who = await verifyUser(req);
  if ("error" in who) return new Response(JSON.stringify({ error: who.error }), { status: 401, headers: cors });
  const body = await req.json().catch(() => ({}));
  const session = String(body.session_id ?? "").slice(0, 128) || crypto.randomUUID();
  return stream(async (emit) => {
    const t = await delegated(who.sub);
    if (t === "revoked") { await emit({ type: "error", code: "access_revoked", message: "Agent access was revoked. Connect again to continue." }); return; }
    if (!t) { await emit({ type: "consent_required", url: await consentUrl(who.sub) }); return; }
    if (body.action === "connect") {
      // "Connect" means: hold a token that still works. Force a refresh, which fails once the OAuth consent is
      // revoked (the app's revoke always clears it); then drop the token and ask for consent again. No direct
      // database call here: the agent reaches Postgres only through the MCP server.
      const fresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh });
      if (!fresh || claims(fresh.access).sub !== who.sub) {
        vault.delete(who.sub);
        await emit({ type: "consent_required", url: await consentUrl(who.sub) });
        return;
      }
      vault.set(who.sub, fresh);
      await emit({ type: "connected", client_id: cfg.client_id });
      return;
    }
    const message = String(body.message ?? "");
    const callTool = async (name: string, a: Record<string, unknown>) => {
      const r = await mcp(t.access, session, "tools/call", { name, arguments: a });
      return r.result?.structuredContent ?? { ok: false, error: "mcp_error" };
    };

    if (args.model === "scripted") {
      const calls = parseScript(message);
      if (!calls.length) { await emit({ type: "text", text: "Scripted dev agent. Send lines like: /call get_invoice {\"invoice_number\":\"BWS-2026-0001\"}" }); return; }
      for (const [i, c] of calls.entries()) {
        const id = `${session}:${Date.now()}:${i}`;
        await emit({ type: "tool_call", id, name: c.name, args: c.args });
        await emit({ type: "tool_result", id, name: c.name, envelope: await callTool(c.name, c.args) });
      }
      return;
    }

    model ??= bedrockModel({ region: args.region, profile: args.profile, modelId: args["model-id"] });
    const tools = (await mcp(t.access, session, "tools/list", {})).result.tools;
    const messages = history.get(session) ?? [];
    messages.push({ role: "user", content: [{ text: message }] });
    history.set(session, messages);
    await runAgentLoop({ model, system: SYSTEM, toolConfig: toolConfigFrom(tools), messages, callTool,
      onEvent: (e) => emit(e) });
  });
}

async function callback(url: URL): Promise<Response> {
  const back = (q: string) => new Response(null, { status: 302, headers: { location: `${APP}/agent?${q}` } });
  const p = pending.take(url.searchParams.get("state") ?? "");
  if (!p) return back("agent_error=invalid_state");
  if (url.searchParams.get("error")) return back(`agent_error=${encodeURIComponent(url.searchParams.get("error")!)}`);
  const t = await tokenRequest({ grant_type: "authorization_code", code: url.searchParams.get("code") ?? "",
    redirect_uri: cfg.redirect_uri, code_verifier: p.verifier });
  if (!t) return back("agent_error=token_exchange_failed");
  if (claims(t.access).sub !== p.sub) return back("agent_error=account_mismatch");  // CC-6
  vault.set(p.sub, t);
  return back("connected=1");
}

Deno.serve({ hostname: "127.0.0.1", port: 8787, onListen: () => console.log(`dev agent (${args.model}) on http://127.0.0.1:8787`) },
  async (req) => {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method === "POST" && url.pathname === "/invocations") return await invocations(req);
    if (req.method === "GET" && url.pathname === "/callback") return await callback(url);
    return new Response("not found", { status: 404 });
  });
