// The consent flow against the real local auth server and Postgres, with the same supabase-js
// calls the browser makes. Needs the local stack; run via scripts/test-apps.sh (sets APPS_IT=1).
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveConsent, denyConsent, loadConsent, type ConsentClient } from "./flow.ts";

const RUN = process.env.APPS_IT === "1";
const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""; // test harness only: registers the OAuth client
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const PASSWORD = process.env.SEED_PASSWORD ?? "local-only-password";
const REDIRECT = "http://localhost:8976/cb";

const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(new Uint8Array(b)).toString("base64url");

async function signIn(email: string): Promise<SupabaseClient> {
  const sb = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await sb.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return sb;
}

// What the agent side (AgentCore Identity) does: start an authorize request with PKCE.
async function authorize(clientId: string) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: "code",
    code_challenge: challenge, code_challenge_method: "S256", state: "it" });
  const r = await fetch(`${URL_}/auth/v1/oauth/authorize?${q}`, { redirect: "manual" });
  await r.body?.cancel();
  const loc = new URL(r.headers.get("location")!, URL_);
  return { verifier, location: loc, authorizationId: loc.searchParams.get("authorization_id") };
}

async function exchange(clientId: string, secret: string, redirectUrl: string, verifier: string) {
  const code = new URL(redirectUrl).searchParams.get("code")!;
  const r = await fetch(`${URL_}/auth/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa(`${clientId}:${secret}`)}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier }),
  });
  const body = await r.json();
  if (!body.access_token) throw new Error(`token exchange failed: ${JSON.stringify(body)}`);
  return body.access_token as string;
}

const asAgent = (token: string) =>
  createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { authorization: `Bearer ${token}` } } });

const activeGrants = (email: string, clientId: string) =>
  Number(execFileSync("psql", [DB_URL, "-XAtc",
    `select count(*) from app.agent_grants g join auth.users u on u.id = g.user_id
     where u.email = '${email}' and g.client_id = '${clientId}' and g.revoked_at is null`]).toString().trim());

describe.skipIf(!RUN)("consent page flow (local stack)", () => {
  let clientId = "";
  let secret = "";

  beforeAll(async () => {
    const r = await fetch(`${URL_}/auth/v1/admin/oauth/clients`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
      body: JSON.stringify({ client_name: "consent-it", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" }),
    });
    const c = await r.json();
    if (!c.client_id) throw new Error(`client registration failed: ${JSON.stringify(c)}`);
    clientId = c.client_id;
    secret = c.client_secret;
  });

  afterAll(async () => {
    if (!clientId) return;
    await fetch(`${URL_}/auth/v1/admin/oauth/clients/${clientId}`,
      { method: "DELETE", headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` } });
  });

  it("the authorize redirect lands on Site URL + /oauth/consent", async () => {
    const a = await authorize(clientId);
    expect(a.location.pathname).toBe("/oauth/consent");
    expect(a.authorizationId).toBeTruthy();
  });

  it("without a session the page asks the user to sign in", async () => {
    const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
    const a = await authorize(clientId);
    expect(await loadConsent(anon as unknown as ConsentClient, a.authorizationId)).toEqual({ kind: "needs_sign_in" });
  });

  it("concurrent loads of one authorization both see the consent screen", async () => {
    const bob = await signIn("bob@brightwater.example");
    const a = await authorize(clientId);
    const views = await Promise.all([1, 2, 3].map(() => loadConsent(bob as unknown as ConsentClient, a.authorizationId)));
    expect(views.map((v) => v.kind)).toEqual(["ask", "ask", "ask"]);
  });

  it("fresh approval writes the grant and yields a working delegated token", async () => {
    const alice = await signIn("alice@brightwater.example");
    const a = await authorize(clientId);
    const view = await loadConsent(alice as unknown as ConsentClient, a.authorizationId);
    expect(view).toMatchObject({ kind: "ask", clientId, clientName: "consent-it", userEmail: "alice@brightwater.example" });
    if (view.kind !== "ask") throw new Error("expected ask");

    const done = await approveConsent(alice as unknown as ConsentClient, view);
    expect(done.kind).toBe("redirect");
    if (done.kind !== "redirect") throw new Error("expected redirect");
    expect(done.url.startsWith(REDIRECT)).toBe(true);
    expect(activeGrants("alice@brightwater.example", clientId)).toBe(1);

    const token = await exchange(clientId, secret, done.url, a.verifier);
    const { data } = await asAgent(token).rpc("whoami");
    expect(data).toMatchObject({ client_id: clientId, is_agent: true, agent_grant_active: true });
  });

  it("remembered consent redirects without a screen and writes no grant", async () => {
    const alice = await signIn("alice@brightwater.example");
    const a = await authorize(clientId);
    const view = await loadConsent(alice as unknown as ConsentClient, a.authorizationId);
    expect(view.kind).toBe("redirect");
    expect(activeGrants("alice@brightwater.example", clientId)).toBe(1);
  });

  it("an agent token cannot write a grant", async () => {
    const alice = await signIn("alice@brightwater.example");
    const a = await authorize(clientId);
    const view = await loadConsent(alice as unknown as ConsentClient, a.authorizationId);
    if (view.kind !== "redirect") throw new Error("expected remembered consent");
    const token = await exchange(clientId, secret, view.url, a.verifier);
    const { data } = await asAgent(token).rpc("grant_agent", { client_id: clientId });
    expect(data).toMatchObject({ ok: false, denied: true, reason: "human_only" });
  });

  it("after full revocation the user sees a fresh consent screen", async () => {
    const alice = await signIn("alice@brightwater.example");
    const { data: rv } = await alice.rpc("revoke_agent", { client_id: clientId });
    expect(rv).toMatchObject({ ok: true });
    const { error } = await alice.auth.oauth.revokeGrant({ clientId });
    expect(error).toBeNull();
    expect(activeGrants("alice@brightwater.example", clientId)).toBe(0);

    const a = await authorize(clientId);
    expect((await loadConsent(alice as unknown as ConsentClient, a.authorizationId)).kind).toBe("ask");
  });

  it("deny redirects with access_denied and writes no grant", async () => {
    const bob = await signIn("bob@brightwater.example");
    const a = await authorize(clientId);
    const view = await loadConsent(bob as unknown as ConsentClient, a.authorizationId);
    if (view.kind !== "ask") throw new Error("expected ask");
    const done = await denyConsent(bob as unknown as ConsentClient, view.authorizationId);
    expect(done.kind).toBe("redirect");
    if (done.kind !== "redirect") throw new Error("expected redirect");
    expect(new URL(done.url).searchParams.get("error")).toBe("access_denied");
    expect(activeGrants("bob@brightwater.example", clientId)).toBe(0);
  });
});
