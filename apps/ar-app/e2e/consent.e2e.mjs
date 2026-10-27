// Browser check of the consent page against the local stack and the dev server on :3000.
// Run: scripts/e2e-apps.sh (registers a throwaway OAuth client with the service key, test harness only).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { chromium } from "playwright";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PASSWORD = process.env.SEED_PASSWORD ?? "local-only-password";
const SHOTS = process.env.SHOTS;  // optional screenshot directory
const REDIRECT = "http://localhost:8976/cb";
const admin = { apikey: SVC, authorization: `Bearer ${SVC}` };

const client = await (await fetch(`${URL_}/auth/v1/admin/oauth/clients`, {
  method: "POST", headers: { ...admin, "content-type": "application/json" },
  body: JSON.stringify({ client_name: "ar-copilot-agent (e2e)", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" }),
})).json();
assert.ok(client.client_id, `client registration failed: ${JSON.stringify(client)}`);

// What AgentCore Identity does: start an authorize request with PKCE.
const authorizeUrl = () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return `${URL_}/auth/v1/oauth/authorize?` + new URLSearchParams({ client_id: client.client_id, redirect_uri: REDIRECT,
    response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "e2e", scope: "openid email" });
};

const browser = await chromium.launch();
async function tab() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const hit = { url: null };
  await page.route("http://localhost:8976/**", (r) => { hit.url = r.request().url(); r.fulfill({ body: "agent callback" }); });
  const callback = async () => { for (let i = 0; i < 100 && !hit.url; i++) await page.waitForTimeout(50); return hit.url; };
  return { page, hit, callback };
}
async function signIn(page, email) {
  await page.waitForSelector("input[type=email]");
  await page.fill("input[type=email]", email);
  await page.fill("input[type=password]", PASSWORD);
  await page.click("button.primary");
}
const ok = (name, detail = "") => console.log(`ok   ${name}${detail ? `  (${detail})` : ""}`);

try {
  // Alice: no session -> sign in -> consent -> Allow -> callback with a code.
  const a = await tab();
  const t0 = Date.now();
  await a.page.goto(authorizeUrl());
  await a.page.waitForSelector("input[type=email]");
  const next = new URL(a.page.url()).searchParams.get("next");
  assert.match(next, /^\/oauth\/consent\?authorization_id=/);
  ok("no session: sign-in keeps the consent request in ?next=");

  await signIn(a.page, "alice@brightwater.example");
  await a.page.waitForSelector(".consent-actions");
  assert.match(await a.page.textContent(".consent-who"), /alice@brightwater\.example/);
  ok("consent screen names the signed-in user");
  if (SHOTS) await a.page.screenshot({ path: `${SHOTS}/P_consent_screen_local.png` });

  await a.page.click("text=Allow");
  const code = new URL(await a.callback()).searchParams.get("code");
  assert.ok(code);
  ok("allow: redirected to the agent callback with a code", `${Date.now() - t0} ms from authorize`);

  // Remembered consent: straight to the callback, no screen.
  a.hit.url = null;
  await a.page.goto(authorizeUrl());
  assert.ok(new URL(await a.callback()).searchParams.get("code"));
  ok("remembered consent: no screen, code issued");

  // Bob opens a request, signs out ("Not you?"), Alice signs in on it: the server bound it to Bob.
  const b = await tab();
  await b.page.goto(authorizeUrl());
  await signIn(b.page, "bob@brightwater.example");
  await b.page.waitForSelector(".consent-actions");
  await b.page.click("text=Not you? Sign out");
  await b.page.waitForSelector("input[type=email]");
  assert.match(new URL(b.page.url()).searchParams.get("next"), /^\/oauth\/consent/);
  ok("not you? sign out: back to sign-in with the request kept");
  await signIn(b.page, "alice@brightwater.example");
  await b.page.waitForSelector(".consent-error");
  assert.match(await b.page.textContent(".consent-error"), /different account/);
  assert.equal(b.hit.url, null);
  ok("another user cannot complete a request opened by someone else");

  // Deny.
  const c = await tab();
  await c.page.goto(authorizeUrl());
  await signIn(c.page, "bob@brightwater.example");
  await c.page.waitForSelector(".consent-actions");
  await c.page.click("text=Deny");
  assert.equal(new URL(await c.callback()).searchParams.get("error"), "access_denied");
  ok("deny: callback gets error=access_denied");
} finally {
  await browser.close();
  await fetch(`${URL_}/auth/v1/admin/oauth/clients/${client.client_id}`, { method: "DELETE", headers: admin });
}
