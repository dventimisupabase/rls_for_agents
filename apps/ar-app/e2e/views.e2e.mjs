// Browser check of the AR views and the approvals inbox against the local stack and the dev server.
// The agent side is simulated the way the realtime test does it: an HS256 token signed with the
// LOCAL JWT secret carrying sub + client_id, calling the same PostgREST RPCs the MCP server calls.
// Run: scripts/e2e-apps.sh
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:55321";
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const PASSWORD = process.env.SEED_PASSWORD ?? "local-only-password";
const SHOTS = process.env.SHOTS;
const admin = { apikey: SVC, authorization: `Bearer ${SVC}` };
const sql = (q) => execFileSync("psql", [DB_URL, "-XAtqc", q]).toString().trim();
const ok = (name, detail = "") => console.log(`ok   ${name}${detail ? `  (${detail})` : ""}`);

const b64 = (s) => Buffer.from(s).toString("base64url");
function agentJwt(sub, clientId) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64(JSON.stringify({ sub, client_id: clientId, role: "authenticated", aud: "authenticated", iat: now, exp: now + 600 }));
  return `${h}.${p}.${crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url")}`;
}
async function agentRpc(token, fn, args) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: "POST",
    headers: { apikey: ANON, authorization: `Bearer ${token}`, "content-type": "application/json", "x-session-id": "e2e-views" },
    body: JSON.stringify(args) });
  return r.json();
}

const client = await (await fetch(`${URL_}/auth/v1/admin/oauth/clients`, { method: "POST",
  headers: { ...admin, "content-type": "application/json" },
  body: JSON.stringify({ client_name: "ar-copilot-agent (e2e)", redirect_uris: ["http://localhost:8976/cb"], token_endpoint_auth_method: "client_secret_basic" }) })).json();
assert.ok(client.client_id, JSON.stringify(client));
const alice = sql(`select id from auth.users where email = 'alice@brightwater.example'`);
sql(`insert into app.agent_grants (user_id, client_id) values ('${alice}', '${client.client_id}')`);
const agent = agentJwt(alice, client.client_id);

const browser = await chromium.launch();
let pays = [];
async function signedIn(email, path = "/") {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://localhost:3000${path}`);
  await page.waitForSelector("input[type=email]");
  await page.fill("input[type=email]", email);
  await page.fill("input[type=password]", PASSWORD);
  await page.click("button.primary");
  await page.waitForSelector(".topbar");
  return page;
}
const kpi = async (page, label) => {
  const el = page.locator(".kpi", { hasText: label }).locator(".kpi-value");
  await page.waitForFunction((l) => [...document.querySelectorAll(".kpi")].some((k) => k.textContent.includes(l) && !k.textContent.includes("…")), label);
  return (await el.textContent()).trim();
};

try {
  // ---- Alice (admin): the whole tenant
  const a = await signedIn("alice@brightwater.example");
  await a.waitForSelector(".brand:has-text('Brightwater Supply')");
  await a.waitForSelector(".aging tbody tr[data-bucket='90+']");
  const aliceOverdue = Number(await kpi(a, "Overdue invoices"));
  const aliceUnmatched = Number(await kpi(a, "Unmatched payments"));
  assert.ok(aliceOverdue > 50 && aliceUnmatched > 0);
  ok("alice: overview with aging buckets and KPIs", `${aliceOverdue} overdue, ${aliceUnmatched} unmatched`);
  if (SHOTS) await a.screenshot({ path: `${SHOTS}/P_overview_alice_local.png` });

  await a.click("nav >> text=Invoices");
  await a.waitForSelector(".pager");
  assert.match(await a.textContent(".pager"), new RegExp(`of ${aliceOverdue}`));
  ok("alice: overdue invoices paged server-side", (await a.textContent(".pager")).trim());

  const firstNumber = (await a.textContent("table tbody tr:first-child td:first-child a")).trim();
  await a.click("table tbody tr:first-child td:first-child a");
  await a.waitForSelector("[data-testid=invoice-kpis]");
  assert.equal((await a.textContent(".page-header h1")).trim(), `Invoice ${firstNumber}`);
  for (const s of ["approvals", "payments", "credits", "dunning"]) await a.waitForSelector(`[data-testid=invoice-${s}]`);
  ok("alice: invoice number opens the invoice page", firstNumber);
  await a.goBack();

  await a.click("table tbody tr:first-child td:nth-child(2) a");
  await a.waitForSelector("h2:has-text('Contacts')");
  ok("alice: customer detail with contacts and invoices", (await a.textContent(".page-header h1")).trim());

  await a.click("nav >> text=Payments");
  await a.waitForSelector("td.memo");
  ok("alice: unmatched payments show remittance memos");
  if (SHOTS) await a.screenshot({ path: `${SHOTS}/P_payments_alice_local.png` });

  // Projector mode without touching the URL: the top bar button, a reload (kept for the tab), the shortcut
  const isStage = () => a.evaluate(() => document.documentElement.classList.contains("stage"));
  await a.click("[data-testid=stage-toggle]");
  await a.waitForSelector(".shell-stage .stage-copilot .copilot");
  await a.reload();
  await a.waitForSelector(".shell-stage .stage-copilot .copilot");
  assert.equal(await a.textContent("[data-testid=stage-toggle]"), "Exit projector mode");
  await a.keyboard.press("Alt+Shift+KeyP");
  await a.waitForSelector(".shell:not(.shell-stage)");
  assert.equal(await isStage(), false);
  await a.keyboard.press("Alt+Shift+KeyP");
  await a.waitForSelector(".shell-stage");
  await a.click("[data-testid=stage-toggle]");
  await a.waitForSelector(".shell:not(.shell-stage)");
  assert.equal(await isStage(), false);
  ok("alice: projector mode toggles from the top bar and Alt+Shift+P, survives a reload");

  // ---- Bob (rep): only his customers; unmatched payments are admin-only
  const b = await signedIn("bob@brightwater.example");
  const bobOverdue = Number(await kpi(b, "Overdue invoices"));
  const bobUnmatched = Number(await kpi(b, "Unmatched payments"));
  assert.ok(bobOverdue > 0 && bobOverdue < aliceOverdue);
  assert.equal(bobUnmatched, 0);
  ok("bob: sees only his customers' invoices and no unmatched payments", `${bobOverdue} overdue, ${bobUnmatched} unmatched`);

  // ---- P3: agent proposals reach Alice's inbox live
  await a.click("nav >> text=Approvals");
  await a.waitForSelector(".live-on");
  await b.click("nav >> text=Approvals");
  await b.waitForSelector(".live-on");
  pays = sql(`select string_agg(id::text, ',') from (select p.id from payments p join tenants t on t.id = p.tenant_id
                    where t.kind = 'stage' and p.matched_invoice_id is null order by p.received_at desc limit 5) x`).split(",");
  const invs = sql(`select string_agg(invoice_number, ',') from (select invoice_number from invoices i join tenants t on t.id = i.tenant_id
                    where t.kind = 'stage' and i.status = 'open' order by invoice_number limit 5) x`).split(",");
  const latencies = [];
  let lastProposal = null;
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const env = await agentRpc(agent, "propose_payment_match", { payment_id: pays[i], invoice_number: invs[i] });
    assert.equal(env.ok, true, JSON.stringify(env));
    const id = env.data.proposal_id;
    await a.waitForSelector(`[data-action-id='${id}']`, { timeout: 5000 });
    latencies.push(Date.now() - t0);
    lastProposal = id;
  }
  assert.ok(Math.max(...latencies) < 2000);
  ok("P3: proposals appear in alice's inbox live", `ms: ${latencies.join(", ")}; max ${Math.max(...latencies)}`);

  const card = a.locator(`[data-action-id='${lastProposal}']`);
  assert.match(await card.textContent(), /alice@brightwater\.example via ar-copilot-agent \(e2e\)/);
  ok("card shows who requested it: user + agent");
  const inv4 = sql(`select i.id from invoices i join tenants t on t.id = i.tenant_id where t.kind = 'stage' and i.invoice_number = '${invs[4]}'`);
  assert.equal(await card.locator(`a[href='/invoices/${inv4}']`).textContent(), invs[4]);
  ok("card links its invoice to the invoice page");

  // Denied send auto-creates a proposal (beat 3)
  const draft = await agentRpc(agent, "draft_dunning_email", { invoice_number: invs[0], tone: "firm" });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const t1 = Date.now();
  const send = await agentRpc(agent, "send_dunning_email", { email_id: draft.data.email_id });
  assert.equal(send.denied, true);
  await a.waitForSelector(`[data-action-id='${send.proposal_id}']`);
  ok("agent send is denied and its proposal appears", `${Date.now() - t1} ms, reason ${send.reason}`);
  if (SHOTS) await a.screenshot({ path: `${SHOTS}/P_approvals_alice_local.png` });

  // ---- P5: Bob sees the Approve button too; the database refuses him
  await b.waitForSelector(`[data-action-id='${lastProposal}']`);
  await b.locator(`[data-action-id='${lastProposal}'] button.primary`).click();
  await b.waitForSelector(`[data-action-id='${lastProposal}'] .outcome-denied`);
  assert.match(await b.textContent(`[data-action-id='${lastProposal}'] .outcome-denied`), /DENIED\s*not_permitted/);
  ok("bob's approve is refused by the database, not hidden by the app");

  // ---- Alice approves: executes as the human
  await card.locator("button.primary").click();
  await a.waitForSelector(`[data-action-id='${lastProposal}'] .outcome-ok`);
  const row = sql(`select status || '|' || coalesce(decided_by::text, '') || '|' || coalesce(decided_by_client::text, 'null')
                   from app.pending_actions where id = '${lastProposal}'`);
  assert.equal(row, `executed|${alice}|null`);
  assert.equal(sql(`select count(*) from payments where id = '${pays[4]}' and matched_invoice_id is not null`), "1");
  ok("alice approves: executed as alice (decided_by_client null), payment matched");

  await a.locator(`[data-action-id='${send.proposal_id}'] button.primary`).click();
  await a.waitForSelector(`[data-action-id='${send.proposal_id}'] .outcome-ok`);
  assert.equal(sql(`select status || '|' || (sent_by_client is null) from dunning_emails where id = '${draft.data.email_id}'`), "sent|true");
  ok("approved send goes out as the human (sent_by_client null)");

  await a.click("[role=tab]:has-text('Decided')");
  await a.waitForSelector("td:has-text('executed')");
  ok("decided view lists the outcome and who decided");

  // ---- The invoice page: what happened to the invoice, including the approvals about it
  const payer4 = sql(`select payer_name from payments where id = '${pays[4]}'`);
  await a.goto(`http://localhost:3000/invoices/${inv4}`);
  await a.waitForSelector(`[data-testid=invoice-approvals] [data-action-id='${lastProposal}']:has-text('executed')`);
  await a.waitForSelector(`[data-testid=invoice-payments] td:has-text(${JSON.stringify(payer4)})`);
  ok("invoice page: the approved match shows under approvals and payments", invs[4]);
  const inv0 = sql(`select i.id from invoices i join tenants t on t.id = i.tenant_id where t.kind = 'stage' and i.invoice_number = '${invs[0]}'`);
  await a.goto(`http://localhost:3000/invoices/${inv0}`);
  await a.waitForSelector(`[data-testid=invoice-approvals] [data-action-id='${send.proposal_id}']:has-text('executed')`);
  await a.waitForSelector(`[data-testid=invoice-dunning] tr:has-text('sent'):has-text('person')`);
  ok("invoice page: the approved dunning send shows under approvals, and as sent by a person", invs[0]);

  // A pending proposal shows live on the invoice page, with a way to review it
  const live = await agentRpc(agent, "propose_payment_match", { payment_id: pays[1], invoice_number: invs[0] });
  assert.equal(live.ok, true, JSON.stringify(live));
  await a.waitForSelector(`[data-testid=invoice-approvals] [data-action-id='${live.data.proposal_id}']:has-text('pending') a[href='/approvals']`, { timeout: 5000 });
  ok("invoice page: a new proposal about it appears live as pending");

  // RLS, not the app, decides: Bob opens his own invoice, and gets "not found" for one outside his customers
  const bob = sql(`select id from auth.users where email = 'bob@brightwater.example'`);
  const [bobInv, otherInv] = ["=", "<>"].map((op) => sql(`select i.id from invoices i join customers c on c.id = i.customer_id
    join tenants t on t.id = i.tenant_id where t.kind = 'stage' and c.owner_user_id ${op} '${bob}' order by i.invoice_number limit 1`));
  await b.goto(`http://localhost:3000/invoices/${bobInv}`);
  await b.waitForSelector("[data-testid=invoice-kpis]");
  await b.goto(`http://localhost:3000/invoices/${otherInv}`);
  await b.waitForSelector("[data-testid=invoice-not-found]");
  ok("bob: opens his own invoice; another rep's invoice is not found");

  // Revocation (I6): the same token is now denied at the database
  sql(`update app.agent_grants set revoked_at = now() where user_id = '${alice}' and client_id = '${client.client_id}'`);
  const after = await agentRpc(agent, "propose_payment_match", { payment_id: pays[0], invoice_number: invs[0] });
  assert.equal(after.reason, "agent_grant_revoked");
  ok("after revocation the agent's next call is denied", after.reason);
} finally {
  await browser.close();
  // End like a rehearsal: the stage reset (the exact file run on stage) undoes this run's proposals,
  // matches and emails, so the local stage tenant is back at its baseline for the pgTAP suite.
  execFileSync("psql", [DB_URL, "-Xq", "--single-transaction", "-v", "ON_ERROR_STOP=1", "-f", "supabase/stage/reset_stage.sql"],
    { stdio: ["ignore", "ignore", "pipe"] });
  // After the reset (which re-activates stage members' grants): this run's client is gone, so is its grant.
  sql(`update app.agent_grants set revoked_at = now() where client_id = '${client.client_id}' and revoked_at is null`);

  await fetch(`${URL_}/auth/v1/admin/oauth/clients/${client.client_id}`, { method: "DELETE", headers: admin });
}
