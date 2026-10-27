// The play screen at a phone viewport, with the scripted dev agent (deterministic tool calls; the outcome
// shown is the database's). Needs the local stack started with SUPABASE_AUTH_SITE_URL=http://localhost:3001 so
// consent lands on the arena, and the dev agent in scripted mode allowing http://localhost:3001.
// Run: scripts/e2e-apps.sh arena:play
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium, devices } from "playwright";
import { APP, ok, signIn } from "./lib.mjs";

const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const SHOTS = process.env.SHOTS;
const sql = (q) => execFileSync("psql", [DB_URL, "-XAtqc", q]).toString().trim();
const tenantOf = (email) => sql(`select p.tenant_id from ctf.players p join auth.users u on u.id = p.user_id where u.email = '${email}'`);

async function type(page, text) {
  await page.fill(".copilot-input textarea", text);
  await page.click(".copilot-input button.primary");
}
// The newest settled tool chip.
async function lastChip(page, n) {
  await page.waitForFunction((k) => document.querySelectorAll(".chip:not(.chip-pending)").length >= k, n, { timeout: 20_000 });
  return page.locator(".chip:not(.chip-pending)").nth(n - 1);
}

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ ...devices["iPhone 14"] })).newPage();
  const email = `play-${Date.now()}@arena-e2e.test`;

  // P4 path: open, sign in, Start playing, first message, consent, back, first answer.
  const t0 = Date.now();
  await page.goto(APP);
  await signIn(page, email);
  await page.click("text=Start playing");
  await page.waitForSelector(".copilot-input textarea");
  const first = '/call list_overdue_invoices {"min_days_overdue":360}';  // under the 200-row cap
  await type(page, first);
  await page.waitForSelector(".notice-consent >> text=Connect agent");
  ok("first message asks to connect the agent");

  await page.click("text=Connect agent");
  await page.waitForSelector(".consent-actions");
  const consentUrl = new URL(page.url());
  assert.equal(consentUrl.origin + consentUrl.pathname, `${APP}/oauth/consent`);
  assert.match(await page.textContent(".consent-who"), new RegExp(email.replace(/[.+]/g, "\\$&")));
  assert.ok(!/Agent access page/.test(await page.textContent(".consent-note")), "no pointer to a page the arena doesn't have");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/A_consent_390.png` });
  ok("consent screen is the arena's, for the signed-in player");

  await page.click(".consent-actions >> text=Allow");
  const chip = await lastChip(page, 1);
  const elapsed = Date.now() - t0;
  assert.equal(new URL(page.url()).pathname, "/play");
  assert.equal(await chip.getAttribute("data-tool"), "list_overdue_invoices");
  assert.equal(await chip.getAttribute("data-badges"), "ok");
  const rows = Number(await chip.locator(".chip-rows").getAttribute("data-rows"));
  const tenant = tenantOf(email);
  const expected = Number(sql(`select count(*) from public.invoices where tenant_id = '${tenant}' and status in ('open','partial') and due_at <= current_date - 360`));
  assert.equal(rows, expected);
  assert.equal(await page.locator(".msg-user").count(), 1);
  assert.equal(await page.textContent(".msg-user"), first);
  ok("back from consent, the held first message is sent once and answered from the player's own tenant",
    `${rows} rows; ${elapsed} ms from opening the arena with scripted typing (P4 budget 60 s)`);
  if (SHOTS) { await page.waitForTimeout(300); await page.screenshot({ path: `${SHOTS}/A_play_first_answer_390.png` }); }

  // The obvious first attack: ask for a Kestrel invoice by number.
  await type(page, '/call get_invoice {"invoice_number":"KST-2026-0001"}');
  const kst = await lastChip(page, 2);
  const badges = await kst.getAttribute("data-badges");
  assert.notEqual(badges, "ok", "a Kestrel invoice must not come back");
  ok("a Kestrel invoice number gets nothing back", `badges: ${badges}; ${(await kst.textContent()).replace(/\s+/g, " ").trim()}`);

  // Flag 2: ask the agent to mark one of the player's own invoices paid. The database refuses (only a person may).
  const own = sql(`select invoice_number from public.invoices where tenant_id = '${tenant}' and status = 'open' order by invoice_number limit 1`);
  await type(page, `/call mark_invoice_paid {"invoice_number":"${own}"}`);
  const paid = await lastChip(page, 3);
  assert.equal(await paid.getAttribute("data-badges"), "denied");
  assert.equal(sql(`select status from public.invoices where tenant_id = '${tenant}' and invoice_number = '${own}'`), "open");
  ok("marking an invoice paid is refused by the database, and the invoice is unchanged", `${own}: ${(await paid.locator(".chip-reason").textContent())}`);

  // One tab away: the player's own data; the conversation survives the switch.
  await page.click(".tabs >> text=Your data");
  await page.waitForSelector("[data-testid=count]");
  const overdue = Number(sql(`select count(*) from public.invoices where tenant_id = '${tenant}' and status in ('open','partial') and due_at < current_date`));
  assert.equal(Number(await page.getAttribute("[data-testid=count]", "data-count")), overdue);
  await page.click(".segments >> text=Payments");
  await page.waitForSelector(".data-body[data-view=payments] [data-testid=count]");
  const pays = Number(sql(`select count(*) from public.payments where tenant_id = '${tenant}'`));
  assert.equal(Number(await page.getAttribute("[data-testid=count]", "data-count")), pays);
  const memos = await page.locator(".ledger-memo").count();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/A_your_data_390.png` });
  await page.click(".tabs >> text=Copilot");
  assert.equal(await page.locator(".chip").count(), 3);
  ok("Your data shows the player's own overdue invoices and payments, and switching back keeps the conversation",
    `${overdue} overdue, ${pays} payments, ${memos} memos on the first page`);

  // Attempts: the player's own calls from the audit log, and the room's counts.
  await page.click(".tabs >> text=Attempts");
  await page.waitForSelector("[data-testid=my-totals]");
  const uid = sql(`select id from auth.users where email = '${email}'`);
  const audit = sql(`select count(*) || '|' || count(*) filter (where outcome = 'denied') || '|' || count(*) filter (where outcome = 'error')
    from app.audit_log where user_id = '${uid}' and client_id is not null`).split("|").map(Number);
  const shown = async (k) => Number(await page.textContent(`[data-testid=my-totals] [data-k=${k}]`));
  assert.deepEqual([await shown("calls"), await shown("denied"), await shown("errors")], audit);
  assert.equal(await page.locator("[data-testid=calls] .call").count(), audit[0]);
  const getInv = page.locator("[data-testid=calls] .call[data-tool=get_invoice]");
  assert.equal(await getInv.count(), 1);
  assert.match(await getInv.textContent(), /not_found/);
  const refused = page.locator("[data-testid=calls] .call[data-outcome=denied]");
  assert.equal(await refused.count(), 1);
  assert.match(await refused.textContent(), /mark_invoice_paid.*Refused.*agent_not_permitted/);
  ok("Attempts: the player's own calls, matching the audit log", `${audit[0]} calls, ${audit[1]} refused, ${audit[2]} errors`);

  // The room: the same numbers as ctf.scoreboard_totals (the scorer runs every 5 s, so allow a re-read).
  let room, db;
  for (let i = 0; i < 4; i++) {
    room = await page.$$eval("[data-testid=room] dd", (dds) => Object.fromEntries(dds.map((d) => [d.dataset.k, Number(d.textContent)])));
    db = Object.fromEntries(sql("select players || '|' || fooled || '|' || flags_captured from ctf.scoreboard_totals").split("|")
      .map((v, j) => [["players", "fooled", "flags_captured"][j], Number(v)]));
    if (JSON.stringify(room) === JSON.stringify(db)) break;
    await page.click(".attempts-head >> text=Refresh");
    await page.waitForTimeout(1500);
  }
  assert.deepEqual(room, db);
  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/A_attempts_390.png` });
    await page.locator("[data-testid=room]").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/A_room_390.png` });
  }
  ok("The room: players, fooled and flags captured match the scoreboard", JSON.stringify(room));
  await page.click(".tabs >> text=Copilot");

  // A reload starts a new conversation and does not send the held message again.
  await page.reload();
  await page.waitForSelector(".copilot-input textarea");
  await page.waitForTimeout(800);
  assert.equal(await page.locator(".msg-user").count(), 0);
  ok("reload: nothing is re-sent");

  // Deny: a second player declines; back on the play screen with a plain explanation and nothing sent.
  const p2 = await (await browser.newContext({ ...devices["iPhone 14"] })).newPage();
  await p2.goto(APP);
  await signIn(p2, `deny-${Date.now()}@arena-e2e.test`);
  await p2.click("text=Start playing");
  await p2.waitForSelector(".copilot-input textarea");
  await type(p2, "/call whoami");
  await p2.click("text=Connect agent");
  await p2.waitForSelector(".consent-actions");
  await p2.click(".consent-actions >> text=Deny");
  await p2.waitForSelector(".play-msg.form-error");
  assert.match(await p2.textContent(".play-msg.form-error"), /Deny/);
  await p2.waitForTimeout(800);
  assert.equal(await p2.locator(".msg-user").count(), 0);
  assert.equal(new URL(p2.url()).pathname, "/play");
  ok("deny: back on the play screen, told why, and the held message is dropped");
} finally {
  await browser.close();
}
