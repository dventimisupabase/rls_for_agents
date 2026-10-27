// Arena sign-in at a phone viewport against the local stack and the arena dev server on :3001.
// The code is read from the local mail catcher (Mailpit), as a player would read it from their inbox.
// Run: scripts/e2e-apps.sh arena:signin
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright";

const APP = "http://localhost:3001";
const MAIL = process.env.MAILPIT_URL ?? "http://127.0.0.1:55324";
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const SHOTS = process.env.SHOTS;
const sql = (q) => execFileSync("psql", [DB_URL, "-XAtqc", q]).toString().trim();
const ok = (name, detail = "") => console.log(`ok   ${name}${detail ? `  (${detail})` : ""}`);

// The newest message to this address that arrived after `since`.
async function codeFor(email, since) {
  for (let i = 0; i < 100; i++) {
    const r = await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    const m = r.messages?.find((x) => Date.parse(x.Created) >= since - 1000);
    if (m) {
      const full = await (await fetch(`${MAIL}/api/v1/message/${m.ID}`)).json();
      return { subject: full.Subject, text: full.Text, code: full.Text.match(/\b\d{6,10}\b/)?.[0] };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no email for ${email}`);
}

const email = `player-${Date.now()}@arena-e2e.test`;
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ ...devices["iPhone 14"] });
  const page = await ctx.newPage();

  // New player: QR code opens the arena, sign in with a code, provisioned.
  const t0 = Date.now();
  await page.goto(APP);
  await page.waitForSelector("input[type=email]");
  assert.match(new URL(page.url()).pathname, /^\/sign-in$/);
  assert.match(await page.textContent("[data-testid=consent]"), /^\[LEGAL PLACEHOLDER\]/);
  ok("signed out: sign-in page with the marked consent placeholder");

  const sizes = await page.$$eval("input", (els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
  assert.ok(sizes.every((s) => s >= 16), `input font sizes ${sizes}`);
  assert.equal(await page.getAttribute("input[type=email]", "autocomplete"), "email");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/A_signin_email_390.png` });

  await page.fill("input[type=email]", email);
  const sent = Date.now();
  await page.click("button.primary");
  await page.waitForSelector("input.code");
  const mail1 = await codeFor(email, sent);
  assert.match(mail1.subject, /arena code/);
  assert.ok(!/verify\?|https?:\/\//.test(mail1.text), "the email carries no link");
  assert.equal(mail1.code.length, 8);
  ok("new email: the code arrives by email, with no link", `${Date.now() - sent} ms`);
  assert.equal(await page.getAttribute("input.code", "autocomplete"), "one-time-code");
  assert.equal(await page.getAttribute("input.code", "inputmode"), "numeric");

  await page.fill("input.code", "00000000");
  await page.click("button.primary");
  await page.waitForSelector(".form-error");
  assert.ok(await page.isVisible("input.code"));
  ok("a wrong code is refused and the player stays on the code step");

  // Pasted with a space, as people do.
  await page.fill("input.code", `${mail1.code.slice(0, 4)} ${mail1.code.slice(4)}`);
  assert.equal(await page.inputValue("input.code"), mail1.code);
  await page.click("button.primary");
  await page.waitForSelector("[data-testid=handle]");
  const handle = await page.textContent("[data-testid=handle]");
  const elapsed = Date.now() - t0;
  assert.equal(await page.textContent("[data-testid=tenant]"), `Player ${handle}`);
  ok("signed in and provisioned: handle and company shown", `${handle}, ${elapsed} ms from opening the page, typing by script`);
  if (SHOTS) { await page.waitForTimeout(600); await page.screenshot({ path: `${SHOTS}/A_player_tag_390.png` }); }  // after the tag settles

  const row = sql(`select p.handle || '|' || t.name || '|' || (select count(*) from public.invoices i where i.tenant_id = p.tenant_id)
    from ctf.players p join public.tenants t on t.id = p.tenant_id join auth.users u on u.id = p.user_id where u.email = '${email}'`);
  const [dbHandle, dbTenant, invoices] = row.split("|");
  assert.equal(dbHandle, handle);
  assert.equal(dbTenant, `Player ${handle}`);
  assert.ok(Number(invoices) > 0);
  ok("the database agrees: one player row, its own tenant, cloned invoices", `${invoices} invoices`);

  await page.reload();
  await page.waitForSelector("[data-testid=handle]");
  assert.equal(await page.textContent("[data-testid=handle]"), handle);
  assert.equal(sql(`select count(*) from ctf.players p join auth.users u on u.id = p.user_id where u.email = '${email}'`), "1");
  ok("reload: same handle, still one player row (provisioning is idempotent)");

  // Returning player: sign out, a new code (magic link template), same handle.
  await page.click("text=Sign out");
  await page.waitForSelector("input[type=email]");
  await page.fill("input[type=email]", email);
  const sent2 = Date.now();
  await page.click("button.primary");
  await page.waitForSelector("input.code");
  const mail2 = await codeFor(email, sent2);
  assert.notEqual(mail2.code, mail1.code);
  await page.fill("input.code", mail2.code);
  await page.click("button.primary");
  await page.waitForSelector("[data-testid=handle]");
  assert.equal(await page.textContent("[data-testid=handle]"), handle);
  ok("returning player: new code, same handle and company");

  // A sign-in link carrying ?next= only ever lands inside the arena.
  await page.click("text=Sign out");
  await page.waitForSelector("input[type=email]");
  await page.goto(`${APP}/sign-in?next=//evil.example/x`);
  await page.fill("input[type=email]", email);
  await new Promise((r) => setTimeout(r, 5000));  // local max_frequency is 5 s per address
  const sent3 = Date.now();
  await page.click("button.primary");
  await page.waitForSelector("input.code");
  await page.fill("input.code", (await codeFor(email, sent3)).code);
  await page.click("button.primary");
  await page.waitForSelector("[data-testid=handle]");
  assert.equal(new URL(page.url()).origin, APP);
  ok("?next= pointing off-site lands on the arena instead");

  // The legal guard: a production build refuses while the placeholder ships; a stage build does not.
  const out = mkdtempSync(join(tmpdir(), "arena-guard-"));
  const build = (args) => { try { execFileSync("npx", ["vite", "build", ...args, "--outDir", out, "--emptyOutDir"], { cwd: "apps/arena", stdio: "pipe" }); return 0; } catch (e) { return e.status ?? 1; } };
  assert.notEqual(build([]), 0);
  assert.equal(build(["--mode", "stage"]), 0);
  rmSync(out, { recursive: true, force: true });
  ok("production build refuses while the consent text is a placeholder; stage build passes");
} finally {
  await browser.close();
}
