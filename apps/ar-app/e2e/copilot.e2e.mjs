// Stage-beat rehearsal in stage mode with the local dev agent in scripted mode (deterministic, no model):
// connect (3LO through the real consent page), ok / denied / proposal chips, the live inbox, revoke (both
// halves) and the next call denied, then a fresh consent screen. Also measures the P2 badges.
// Needs: local stack, functions serve, the AR app on :3000, scripts/dev-agent.ts --model scripted.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const PASSWORD = process.env.SEED_PASSWORD ?? "local-only-password";
const SHOTS = process.env.SHOTS;
const sql = (q) => execFileSync("psql", [DB_URL, "-XAtqc", q]).toString().trim();
const ok = (name, detail = "") => console.log(`ok   ${name}${detail ? `  (${detail})` : ""}`);

// WCAG relative luminance contrast of two computed rgb() colors
const lum = (rgb) => {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => v / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const ping = await fetch("http://127.0.0.1:8787/invocations", { method: "OPTIONS" }).catch(() => null);
assert.ok(ping, "dev agent is not running on :8787");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
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

try {
  await page.goto("http://localhost:3000/agent?stage=1");
  await page.waitForSelector("input[type=email]");
  await page.fill("input[type=email]", "alice@brightwater.example");
  await page.fill("input[type=password]", PASSWORD);
  await page.click("button.primary");
  await page.waitForSelector(".shell-stage .stage-copilot .copilot");
  ok("stage mode: copilot left, product right");

  await page.waitForSelector("h2:has-text('Status')");
  await page.waitForFunction(() => document.querySelector("[data-status]"));
  if (await page.locator("[data-status=active]", { hasText: "(local dev)" }).count()) {   // a previous run left a grant
    await page.locator("[data-status=active]", { hasText: "(local dev)" }).locator("text=Revoke agent access").click();
    await page.waitForSelector("[data-testid=revoke-result]");
  }

  // Beat 1: connect (3LO through the consent page)
  const t0 = Date.now();
  await page.click("text=Connect agent");
  await page.waitForSelector(".consent-actions");
  await page.click(".consent-actions >> text=Allow");
  await page.waitForSelector(".banner-ok:has-text('Agent connected')");
  await page.waitForSelector("[data-status=active]:has-text('(local dev)')");
  ok("beat 1: connect agent via consent screen", `${Date.now() - t0} ms click to connected`);

  // Beat 2: an allowed read, then a forbidden act
  const inv = sql(`select i.invoice_number from invoices i join tenants t on t.id = i.tenant_id
                   where t.kind = 'stage' and i.status = 'open' and i.due_at < current_date order by i.invoice_number limit 1`);
  let chip = await say(`/call get_invoice {"invoice_number":"${inv}"}`);
  assert.equal(await chip.getAttribute("data-badges"), "ok");
  ok("allowed read: OK badge");
  chip = await say(`/call mark_invoice_paid {"invoice_number":"${inv}"}`);
  assert.equal(await chip.getAttribute("data-badges"), "denied");
  assert.match(await chip.textContent(), /agent_not_permitted/);
  ok("beat 2: mark_invoice_paid is DENIED by the database");

  // P2 measurements on the denied badge
  const m = await chip.locator(".badge-denied").evaluate((el) => {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return { fontSize: cs.fontSize, color: cs.color, bg: cs.backgroundColor, h: r.height, w: r.width };
  });
  const c = contrast(m.color, m.bg);
  assert.ok(parseFloat(m.fontSize) >= 52 && c >= 4.5);
  ok("P2 denied badge", `font ${m.fontSize}, box ${Math.round(m.w)}x${Math.round(m.h)} px at 1920x1080, contrast ${c.toFixed(1)}:1`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/P2_stage_denied_1920.png` });

  // Beat 3: a denied send becomes a proposal; it arrives in the inbox live
  await page.click("nav >> text=Approvals");
  await page.waitForSelector(".live-on");
  chip = await say(`/call draft_dunning_email {"invoice_number":"${inv}","tone":"firm"}`);
  assert.equal(await chip.getAttribute("data-badges"), "ok");
  const email = sql(`select d.id from dunning_emails d join invoices i on i.id = d.invoice_id
                     where i.invoice_number = '${inv}' and d.status = 'draft' order by d.created_at desc limit 1`);
  chip = await say(`/call send_dunning_email {"email_id":"${email}"}`);
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
  ok("beat 3: denied send -> PROPOSAL CREATED chip and a live inbox card",
     `proposal badge font ${p.fontSize}, ${p.border} border, contrast ${cp.toFixed(1)}:1`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/P2_stage_proposal_1920.png` });

  // Beat 4: Alice approves; it executes as Alice
  const card = page.locator(".card.proposal", { hasText: "Send dunning email" }).first();
  await card.locator("button.primary").click();
  await card.locator(".outcome-ok").waitFor();
  assert.equal(sql(`select status || '|' || (sent_by_client is null) from dunning_emails where id = '${email}'`), "sent|true");
  ok("beat 4: Alice approves; the email is sent as Alice");

  // Beat 5: revoke, and the agent's very next call is refused at the database
  await page.click("nav >> text=Agent access");
  await page.locator("[data-status=active]", { hasText: "(local dev)" }).locator("text=Revoke agent access").click();
  await page.waitForSelector("[data-testid=revoke-result]");
  const rr = await page.textContent("[data-testid=revoke-result]");
  assert.match(rr, /Database grant: revoked/);
  assert.match(rr, /OAuth consent: revoked/);
  await page.waitForFunction(() => ![...document.querySelectorAll("[data-status=active]")].some((e) => e.textContent.includes("(local dev)")));
  chip = await say(`/call get_invoice {"invoice_number":"${inv}"}`);
  assert.equal(await chip.getAttribute("data-badges"), "denied");
  assert.match(await chip.textContent(), /agent_grant_revoked/);
  ok("beat 5: revoke (both halves); the next call is DENIED agent_grant_revoked");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/P2_stage_revoked_1920.png` });

  // Reconnecting asks for consent again (the OAuth half was revoked too)
  await page.click("text=Connect agent");
  await page.waitForSelector(".consent-actions");
  ok("after revoke, Connect shows a fresh consent screen");
  await page.click(".consent-actions >> text=Deny");
  await page.waitForSelector(".banner-error:has-text('declined')");
  ok("deny returns to the app with a clear message");
} finally {
  await browser.close();
  // End like a rehearsal (the stage reset). Then drop the dev agent's grant again, since the reset re-activates
  // grants of live clients and the next run should start disconnected.
  execFileSync("psql", [DB_URL, "-Xq", "--single-transaction", "-v", "ON_ERROR_STOP=1", "-f", "supabase/stage/reset_stage.sql"],
    { stdio: ["ignore", "ignore", "pipe"] });
  sql(`update app.agent_grants set revoked_at = now() where revoked_at is null and client_id in
       (select id from auth.oauth_clients where client_name = 'ar-copilot-agent (local dev)')`);
}
