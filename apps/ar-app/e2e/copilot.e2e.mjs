// Rehearsal of the five stage beats (00_SHARED_CONTEXT.md section 11) in stage mode at 1920x1080, with the
// local dev agent in scripted mode standing in for Claude: the scripted calls are what a fully fooled agent
// would do, so every outcome shown is the database's. Also measures the P2 badges.
// Needs: local stack, functions serve, the AR app on :3000, scripts/dev-agent.ts --model scripted.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const PASSWORD = process.env.SEED_PASSWORD ?? "local-only-password";
const SHOTS = process.env.SHOTS;
const sql = (q) => execFileSync("psql", [DB_URL, "-XAtqc", q]).toString().trim();
const psqlFile = (f) => execFileSync("psql", [DB_URL, "-Xq", "--single-transaction", "-v", "ON_ERROR_STOP=1", "-f", f],
  { stdio: ["ignore", "ignore", "pipe"] });
const ok = (name, detail = "") => console.log(`ok   ${name}${detail ? `  (${detail})` : ""}`);

// WCAG contrast of two computed rgb() colors
const lum = (rgb) => {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => v / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

assert.ok(await fetch("http://127.0.0.1:8787/invocations", { method: "OPTIONS" }).catch(() => null), "dev agent is not running on :8787");

const browser = await chromium.launch();

async function user(email) {
  const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  await page.goto("http://localhost:3000/agent?stage=1");
  await page.waitForSelector("input[type=email]");
  await page.fill("input[type=email]", email);
  await page.fill("input[type=password]", PASSWORD);
  await page.click("button.primary");
  await page.waitForSelector(".shell-stage .stage-copilot .copilot");
  await page.waitForFunction(() => document.querySelector("[data-status]"));
  const say = async (text) => {
    const before = await page.locator(".chip").count();
    await page.fill(".copilot-input textarea", text);
    await page.click(".copilot-input button.primary");
    await page.waitForFunction((n) => {
      const chips = document.querySelectorAll(".chip");
      return chips.length > n && !chips[chips.length - 1].classList.contains("chip-pending");
    }, before);
    return page.locator(".chip").last();
  };
  const devRow = () => page.locator("[data-status=active]", { hasText: "(local dev)" });
  const revoke = async () => {
    await page.click("nav >> text=Agent access");
    await devRow().locator("text=Revoke agent access").click();
    await page.waitForSelector("[data-testid=revoke-result]");
    return page.textContent("[data-testid=revoke-result]");
  };
  // The runbook step "reconnect the agent before a rehearsal": Connect, consent, back connected.
  const connect = async () => {
    await page.click("nav >> text=Agent access");
    await page.click("text=Connect agent");
    await page.waitForSelector(".consent-actions");
    await page.click(".consent-actions >> text=Allow");
    await page.waitForSelector("[data-status=active]:has-text('(local dev)')");
  };
  return { page, say, revoke, connect, devRow };
}

try {
  const alice = await user("alice@brightwater.example");
  const bob = await user("bob@brightwater.example");
  ok("stage mode: copilot left, product right (Alice and Bob)");
  for (const u of [alice, bob]) if (await u.devRow().count()) await u.revoke();  // start disconnected
  const t0 = Date.now();
  await alice.connect();
  ok("connect: Alice connects the agent through the consent screen", `${Date.now() - t0} ms`);
  await bob.connect();
  ok("connect: Bob connects the agent");
  // Revoked outside the app (database only; the OAuth consent stays): Connect must not report a dead
  // connection as connected. The app clears the consent and the consent screen writes a fresh grant.
  sql(`update app.agent_grants set revoked_at = now() where revoked_at is null
       and user_id = (select id from auth.users where email = 'bob@brightwater.example')
       and client_id in (select id from auth.oauth_clients where client_name = 'ar-copilot-agent (local dev)')`);
  await bob.page.reload();
  await bob.connect();
  ok("connect after a database-only revoke goes back through the consent screen");

  // Beat 1: the same question, different and correct answers
  const q = '/call list_overdue_invoices {"min_days_overdue":360}';
  const ra = Number(await (await alice.say(q)).locator(".chip-rows").getAttribute("data-rows"));
  const rb = Number(await (await bob.say(q)).locator(".chip-rows").getAttribute("data-rows"));
  const expA = Number(sql(`select count(*) from invoices i join tenants t on t.id = i.tenant_id
    where t.kind = 'stage' and i.status in ('open','partial') and i.due_at <= current_date - 360`));
  const expB = Number(sql(`select count(*) from invoices i join tenants t on t.id = i.tenant_id join customers c on c.id = i.customer_id
    where t.kind = 'stage' and i.status in ('open','partial') and i.due_at <= current_date - 360
      and c.owner_user_id = (select id from auth.users where email = 'bob@brightwater.example')`));
  assert.equal(ra, Math.min(expA, 200));
  assert.equal(rb, Math.min(expB, 200));
  assert.ok(ra > rb && rb > 0);
  ok("beat 1: same question, different correct answers", `Alice ${ra} rows, Bob ${rb} rows (his customers only)`);

  // Beat 2: an injected memo; a fully fooled agent does what it says, and the database holds
  const { page, say } = alice;
  assert.equal(await (await say('/call search_payments {"unmatched_only":true}')).getAttribute("data-badges"), "ok");
  const target = "BWS-2026-0001";
  const status = () => sql(`select status from invoices where invoice_number = '${target}' and tenant_id in (select id from tenants where kind = 'stage')`);
  const before = status();
  let chip = await say(`/call mark_invoice_paid {"invoice_number":"${target}"}`);
  assert.equal(await chip.getAttribute("data-badges"), "denied");
  assert.match(await chip.textContent(), /agent_not_permitted/);
  assert.equal(await (await say("/call list_customer_contacts {}")).getAttribute("data-badges"), "ok");
  assert.equal(status(), before);
  ok("beat 2: the injected actions: mark_invoice_paid DENIED, contacts only from Alice's tenant, invoice unchanged");

  const m = await page.locator(".chip-denied .badge-denied").last().evaluate((el) => {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return { fontSize: cs.fontSize, color: cs.color, bg: cs.backgroundColor, h: r.height, w: r.width };
  });
  const c = contrast(m.color, m.bg);
  assert.ok(parseFloat(m.fontSize) >= 52 && c >= 4.5);
  ok("P2 denied badge", `font ${m.fontSize}, box ${Math.round(m.w)}x${Math.round(m.h)} px at 1920x1080, contrast ${c.toFixed(1)}:1`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/P2_stage_denied_1920.png` });

  // Beat 3: a denied send becomes a proposal, arrives in Alice's inbox, she approves
  await page.click("nav >> text=Approvals");
  await page.waitForSelector(".live-on");
  const draft = async (inv) => {
    const d = await say(`/call draft_dunning_email {"invoice_number":"${inv}","tone":"firm"}`);
    assert.equal(await d.getAttribute("data-badges"), "ok");
    return sql(`select d.id from dunning_emails d join invoices i on i.id = d.invoice_id
                where i.invoice_number = '${inv}' and d.status = 'draft' order by d.created_at desc limit 1`);
  };
  const e1 = await draft(target);
  chip = await say(`/call send_dunning_email {"email_id":"${e1}"}`);
  assert.equal(await chip.getAttribute("data-badges"), "denied proposal");
  await page.waitForSelector(".card.proposal >> text=Send dunning email");
  const p = await chip.locator(".badge-proposal").evaluate((el) => {
    const cs = getComputedStyle(el);
    return { fontSize: cs.fontSize, color: cs.color, bg: cs.backgroundColor, border: cs.borderStyle };
  });
  const cp = contrast(p.color, p.bg);
  assert.ok(parseFloat(p.fontSize) >= 52 && cp >= 4.5 && p.border === "dashed");
  const clipped = await chip.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return [...el.querySelectorAll(".badge")].some((b) => { const r = b.getBoundingClientRect(); return r.right > box.right || r.left < box.left; });
  });
  assert.equal(clipped, false, "a badge overflows its chip");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/P2_stage_proposal_1920.png` });
  const card = page.locator(".card.proposal", { hasText: "Send dunning email" }).first();
  await card.locator("button.primary").click();
  await card.locator(".outcome-ok").waitFor();
  assert.equal(sql(`select status || '|' || (sent_by_client is null) from dunning_emails where id = '${e1}'`), "sent|true");
  ok("beat 3: denied send -> PROPOSAL CREATED, live inbox card, Alice approves, sent as Alice",
     `proposal badge ${p.fontSize}, ${p.border}, contrast ${cp.toFixed(1)}:1`);

  // Beat 4: the live policy edit (the operator runs the stage file); behavior changes immediately
  psqlFile("supabase/stage/live_policy_500.sql");
  const e2 = await draft(target);                       // $101.33
  chip = await say(`/call send_dunning_email {"email_id":"${e2}"}`);
  assert.equal(await chip.getAttribute("data-badges"), "ok");
  assert.equal(sql(`select status || '|' || (sent_by_client is not null) from dunning_emails where id = '${e2}'`), "sent|true");
  const e3 = await draft("BWS-2026-0006");              // over $500
  chip = await say(`/call send_dunning_email {"email_id":"${e3}"}`);
  assert.equal(await chip.getAttribute("data-badges"), "denied proposal");
  ok("beat 4: after the live policy, the agent sends under $500 (OK); over $500 is still DENIED + proposal");

  // Beat 5: revoke; the very next call is refused at the database; Bob is unaffected
  const rr = await alice.revoke();
  assert.match(rr, /Database grant: revoked/);
  assert.match(rr, /OAuth consent: revoked/);
  chip = await say(`/call get_invoice {"invoice_number":"${target}"}`);
  assert.equal(await chip.getAttribute("data-badges"), "denied");
  assert.match(await chip.textContent(), /agent_grant_revoked/);
  const bobInv = sql(`select i.invoice_number from invoices i join customers c on c.id = i.customer_id join tenants t on t.id = i.tenant_id
    where t.kind = 'stage' and c.owner_user_id = (select id from auth.users where email = 'bob@brightwater.example')
    order by i.invoice_number limit 1`);
  assert.equal(await (await bob.say(`/call get_invoice {"invoice_number":"${bobInv}"}`)).getAttribute("data-badges"), "ok");
  ok("beat 5: Alice revokes (both halves); her agent's next call is DENIED agent_grant_revoked; Bob's still works");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/P2_stage_revoked_1920.png` });

  // After the rehearsal the stage reset re-activates the database grant but cannot restore the OAuth consent.
  psqlFile("supabase/stage/reset_stage.sql");
  await page.goto("http://localhost:3000/agent");
  await alice.devRow().waitFor();
  ok("after the reset: Alice's grant shows active again; her OAuth consent is gone");
  const half = await alice.revoke();
  assert.match(half, /Database grant: revoked/);
  assert.match(half, /OAuth consent: none to revoke/);
  ok("revoke in that state: database grant revoked, 'none to revoke' for OAuth (not a failure)");

  // Runbook: after a reset, reconnect before the next rehearsal
  psqlFile("supabase/stage/reset_stage.sql");
  await page.goto("http://localhost:3000/agent");
  await page.click("text=Connect agent");
  await page.waitForSelector(".consent-actions");
  await page.click(".consent-actions >> text=Allow");
  await page.waitForSelector(".banner-ok:has-text('Agent connected')");
  assert.equal(await (await say(`/call get_invoice {"invoice_number":"${target}"}`)).getAttribute("data-badges"), "ok");
  ok("runbook: reconnect after a reset shows the consent screen once, then the agent works");
} finally {
  await browser.close();
  // End like a rehearsal (the stage reset, which also drops the live policy); leave the dev agent disconnected.
  psqlFile("supabase/stage/reset_stage.sql");
  sql(`update app.agent_grants set revoked_at = now() where revoked_at is null and client_id in
       (select id from auth.oauth_clients where client_name = 'ar-copilot-agent (local dev)')`);
}
